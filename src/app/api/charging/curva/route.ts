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
// Fra due scatti troppo vicini il ΔSoC intero è tutto rumore; oltre i 45
// minuti (una Schuko da 2.3 kW impiega ~18 min a livello) l'intervallo non è
// più una media credibile ma un buco di raccolta
const DT_MIN_MS = 30 * 1000;
const DT_MAX_MS = 45 * 60 * 1000;

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

  // La potenza si deduce fra gli SCATTI di livello, non fra snapshot
  // consecutivi: il livello è intero, e su una AC lenta (20 A: un punto ogni
  // ~9 min) il cron a 1-2 min vede quasi sempre Δ=0 e ogni tanto lo scatto
  // intero — una sega 0/20 kW che non è la carica. Il tempo fra un +1 e il
  // successivo è invece la misura pulita: 0.67 kWh / 9 min ≈ 4.5 kW. In DC,
  // dove gli scatti sono più fitti del cron, ΔLivello ≥ 1 per intervallo fa
  // lo stesso conto con meno rumore.
  //
  // Solo capi in carica (i tratti a cavallo di attacco/stacco diluirebbero la
  // carica su tempo dichiarato fermo); un livello che SCENDE in mezzo alla
  // finestra è una guida, e riparte il conteggio.
  const inCarica = snapshot.filter(s => s.isCharging);
  const scatti: { t: number; level: number }[] = [];
  for (const s of inCarica) {
    const ultimo = scatti[scatti.length - 1];
    if (!ultimo || s.level > ultimo.level) {
      scatti.push({ t: s.createdAt.getTime(), level: s.level });
    } else if (s.level < ultimo.level) {
      scatti.length = 0;
      scatti.push({ t: s.createdAt.getTime(), level: s.level });
    }
  }
  const dedotta: { t: string; kw: number }[] = [];
  for (let i = 1; i < scatti.length; i++) {
    const dt = scatti[i].t - scatti[i - 1].t;
    if (dt < DT_MIN_MS || dt > DT_MAX_MS) continue;
    const kw = (((scatti[i].level - scatti[i - 1].level) / 100) * capacita) / (dt / 3_600_000);
    dedotta.push({
      t: new Date((scatti[i - 1].t + scatti[i].t) / 2).toISOString(),
      kw,
    });
  }

  return NextResponse.json({
    dedotta,
    soc: snapshot.map(s => ({ t: s.createdAt.toISOString(), v: s.level })),
    capacita,
  });
}
