import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * La curva di ricarica di una finestra temporale, dedotta dagli snapshot del
 * cloud: fra due snapshot consecutivi la potenza media è ΔSoC × capacità / Δt.
 *
 * È una deduzione a gradini — il livello cloud è intero, e a cadenza di 1-2
 * minuti un punto percentuale vale ~20 kW di risoluzione in DC — quindi la
 * UI la dichiara dedotta. La curva misurata (V×I a 1 Hz), quando il telefono
 * registra durante la carica, arriva da /api/obd/profilo sulla stessa
 * finestra: due fonti, due serie, mai mescolate.
 */

const SPAN_MAX_MS = 24 * 60 * 60 * 1000;
// Il margine attorno alla finestra: gli snapshot non cadono sui bordi esatti
const MARGINE_MS = 5 * 60 * 1000;
// Fra due snapshot troppo vicini il ΔSoC intero è tutto rumore; oltre i 20
// minuti il tratto non è più una media credibile ma un buco
const DT_MIN_MS = 30 * 1000;
const DT_MAX_MS = 20 * 60 * 1000;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }
  const userId = (session as { userId?: string }).userId ?? 'unknown';

  const { searchParams } = new URL(request.url);
  const da = new Date(searchParams.get('da') ?? '');
  const a = new Date(searchParams.get('a') ?? '');
  const spanMs = a.getTime() - da.getTime();
  if (Number.isNaN(da.getTime()) || Number.isNaN(a.getTime()) || spanMs <= 0 || spanMs > SPAN_MAX_MS) {
    return NextResponse.json({ message: 'Finestra non valida' }, { status: 400 });
  }

  const [settings, snapshot] = await Promise.all([
    prisma.settings.findUnique({ where: { userId } }),
    prisma.batterySnapshot.findMany({
      where: {
        userId,
        createdAt: {
          gte: new Date(da.getTime() - MARGINE_MS),
          lte: new Date(a.getTime() + MARGINE_MS),
        },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, level: true, isCharging: true },
    }),
  ]);
  const capacita = settings?.batteryCapacity ?? 67;

  // I gradini di potenza dedotta: solo sui tratti in carica (almeno un capo
  // dichiarato in carica) e con livello non decrescente — un calo di livello
  // in mezzo alla finestra è una guida, non una ricarica.
  const dedotta: { t: string; kw: number }[] = [];
  for (let i = 1; i < snapshot.length; i++) {
    const s0 = snapshot[i - 1];
    const s1 = snapshot[i];
    const dt = s1.createdAt.getTime() - s0.createdAt.getTime();
    if (dt < DT_MIN_MS || dt > DT_MAX_MS) continue;
    if (!s0.isCharging && !s1.isCharging) continue;
    const deltaLivello = s1.level - s0.level;
    if (deltaLivello < 0) continue;
    const kw = ((deltaLivello / 100) * capacita) / (dt / 3_600_000);
    dedotta.push({
      t: new Date((s0.createdAt.getTime() + s1.createdAt.getTime()) / 2).toISOString(),
      kw,
    });
  }

  return NextResponse.json({
    dedotta,
    soc: snapshot.map(s => ({ t: s.createdAt.toISOString(), v: s.level })),
    capacita,
  });
}
