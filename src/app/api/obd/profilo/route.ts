import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Il profilo di potenza di una finestra temporale: i campioni V×I del regime
 * viaggio ridotti a secchi uniformi per il grafico della card viaggio.
 *
 * Le regole sono quelle dell'accoppiatore (bussola §4.2): i buchi non si
 * interpolano mai — un secchio senza campioni si dichiara tale e la UI lo
 * disegna come banda grigia, non come zero inventato. Trazione e recupero
 * restano popoli separati anche dentro lo stesso secchio: la media firmata
 * li annullerebbe a vicenda proprio nei tratti misti.
 */

// Stessa soglia dell'accoppiatore: oltre, il tratto è un buco vero
const INTERVALLO_COPERTO_MS = 10_000;
// Oltre le 12 ore non è la finestra di un viaggio
const SPAN_MAX_MS = 12 * 60 * 60 * 1000;
const SECCHI_MAX = 140;
const SECCHI_MIN = 12;

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

  const campioni = await prisma.obdSample.findMany({
    where: {
      userId,
      recordedAt: { gte: da, lte: a },
      OR: [{ packPowerKw: { not: null } }, { ambientC: { not: null } }],
    },
    orderBy: { recordedAt: 'asc' },
    select: { recordedAt: true, packPowerKw: true, ambientC: true },
  });

  // La temperatura arriva dal giro leggero dei PID standard (~ogni 45 s in
  // viaggio): pochi punti, ma per una media di viaggio bastano.
  const temperature = campioni.filter(c => c.ambientC !== null);
  const ambientC = temperature.length
    ? temperature.reduce((s, c) => s + c.ambientC!, 0) / temperature.length
    : null;

  const potenza = campioni.filter(c => c.packPowerKw !== null);
  if (potenza.length < 2) {
    return NextResponse.json({ secchi: [], ambientC, gapMin: null });
  }

  const nSecchi = Math.max(SECCHI_MIN, Math.min(SECCHI_MAX, Math.floor(spanMs / 10_000)));
  const lungMs = spanMs / nSecchi;
  const t0 = da.getTime();

  const posKwMs = new Array<number>(nSecchi).fill(0);
  const posMs = new Array<number>(nSecchi).fill(0);
  const negKwMs = new Array<number>(nSecchi).fill(0);
  const negMs = new Array<number>(nSecchi).fill(0);
  const copertoMs = new Array<number>(nSecchi).fill(0);
  let copertoTotMs = 0;

  // Ogni segmento fra due campioni consecutivi entro soglia distribuisce il
  // suo tempo (e la sua potenza media) sui secchi che attraversa, in
  // proporzione alla sovrapposizione: il disegno conserva l'integrale.
  for (let i = 1; i < potenza.length; i++) {
    const s0 = potenza[i - 1].recordedAt.getTime();
    const s1 = potenza[i].recordedAt.getTime();
    const dt = s1 - s0;
    if (dt <= 0 || dt > INTERVALLO_COPERTO_MS) continue;
    const p = (potenza[i - 1].packPowerKw! + potenza[i].packPowerKw!) / 2;
    copertoTotMs += dt;

    const primo = Math.max(0, Math.min(nSecchi - 1, Math.floor((s0 - t0) / lungMs)));
    const ultimo = Math.max(0, Math.min(nSecchi - 1, Math.floor((s1 - t0) / lungMs)));
    for (let b = primo; b <= ultimo; b++) {
      const inizioSecchio = t0 + b * lungMs;
      const sovrapposizione =
        Math.min(s1, inizioSecchio + lungMs) - Math.max(s0, inizioSecchio);
      if (sovrapposizione <= 0) continue;
      copertoMs[b] += sovrapposizione;
      if (p >= 0) {
        posKwMs[b] += p * sovrapposizione;
        posMs[b] += sovrapposizione;
      } else {
        negKwMs[b] += p * sovrapposizione;
        negMs[b] += sovrapposizione;
      }
    }
  }

  const secchi = Array.from({ length: nSecchi }, (_, b) => ({
    // kW tipici del secchio, separati per segno: la trazione media quando si
    // trazionava, il recupero medio quando si recuperava
    pos: posMs[b] > 0 ? posKwMs[b] / posMs[b] : 0,
    neg: negMs[b] > 0 ? negKwMs[b] / negMs[b] : 0,
    dati: copertoMs[b] > 0,
  }));

  return NextResponse.json({
    secchi,
    ambientC,
    // I minuti senza dati della finestra: la legenda del grafico li dichiara
    gapMin: Math.max(0, Math.round((spanMs - copertoTotMs) / 60_000)),
  });
}
