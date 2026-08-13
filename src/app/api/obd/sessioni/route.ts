import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// Oltre questo intervallo fra due campioni la registrazione è stata interrotta:
// sono due sessioni distinte, non una con un buco.
const STACCO_MS = 10 * 60 * 1000;

// Un intervallo troppo lungo fra due campioni non è integrabile: l'auto può
// aver fatto qualsiasi cosa nel mezzo, e sommare a trapezio inventerebbe strada.
const MAX_INTERVALLO_INTEGRABILE_MS = 30 * 1000;

const GIORNI = 14;

type Campione = {
  recordedAt: Date;
  socDisplay: number | null;
  speedKmh: number | null;
};

function metriche(campioni: Campione[], capacita: number) {
  const conSoc = campioni.filter(c => c.socDisplay !== null);
  const conVel = campioni.filter(c => c.speedKmh !== null);

  // Distanza per integrazione a trapezio: non esiste un PID odometro, ma con un
  // campione ogni due secondi la somma è affidabile. Gli intervalli troppo
  // lunghi vengono saltati e contati a parte, così il buco resta visibile.
  let distanzaKm = 0;
  let sMancante = 0;
  for (let i = 1; i < conVel.length; i++) {
    const dtMs = conVel[i].recordedAt.getTime() - conVel[i - 1].recordedAt.getTime();
    if (dtMs > MAX_INTERVALLO_INTEGRABILE_MS) {
      sMancante += dtMs / 1000;
      continue;
    }
    distanzaKm += ((conVel[i].speedKmh! + conVel[i - 1].speedKmh!) / 2) * (dtMs / 3600000);
  }

  const socIniziale = conSoc.length ? conSoc[0].socDisplay! : null;
  const socFinale = conSoc.length ? conSoc[conSoc.length - 1].socDisplay! : null;
  const deltaSoc = socIniziale !== null && socFinale !== null ? socIniziale - socFinale : null;
  const energiaKwh = deltaSoc !== null ? (deltaSoc / 100) * capacita : null;

  let intervalloMax = 0;
  for (let i = 1; i < campioni.length; i++) {
    intervalloMax = Math.max(
      intervalloMax,
      campioni[i].recordedAt.getTime() - campioni[i - 1].recordedAt.getTime()
    );
  }

  return {
    distanzaKm,
    socIniziale,
    socFinale,
    energiaKwh,
    // Sotto il chilometro il rapporto è dominato dal rumore, come per i viaggi
    consumo: distanzaKm >= 1 && energiaKwh !== null ? (energiaKwh / distanzaKm) * 100 : null,
    velocitaMax: conVel.length ? Math.max(...conVel.map(c => c.speedKmh!)) : null,
    livelliSoc: new Set(conSoc.map(c => c.socDisplay!.toFixed(3))).size,
    intervalloMaxSec: Math.round(intervalloMax / 1000),
    secondiNonIntegrati: Math.round(sMancante),
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as { userId?: string }).userId ?? 'unknown';
  const da = new Date(Date.now() - GIORNI * 24 * 60 * 60 * 1000);

  const settings = await prisma.settings.findUnique({ where: { userId } });
  const capacita = settings?.batteryCapacity ?? 67;

  const campioni = await prisma.obdSample.findMany({
    where: { userId, recordedAt: { gte: da } },
    orderBy: { recordedAt: 'asc' },
    select: { recordedAt: true, socDisplay: true, speedKmh: true },
  });

  // Raggruppa in sessioni contigue
  const gruppi: Campione[][] = [];
  for (const c of campioni) {
    const ultimo = gruppi[gruppi.length - 1];
    if (
      !ultimo ||
      c.recordedAt.getTime() - ultimo[ultimo.length - 1].recordedAt.getTime() > STACCO_MS
    ) {
      gruppi.push([c]);
    } else {
      ultimo.push(c);
    }
  }

  const viaggi = await prisma.trip.findMany({
    where: { userId, isComplete: true, startedAt: { gte: da } },
    orderBy: { startedAt: 'asc' },
  });

  const sessioni = gruppi
    .filter(g => g.length >= 2)
    .map(g => {
      const inizio = g[0].recordedAt;
      const fine = g[g.length - 1].recordedAt;

      // Il percorso cloud misura lo stesso tragitto per altra via: si accostano
      // i viaggi che si sovrappongono a questa finestra temporale.
      const sovrapposti = viaggi.filter(
        t => t.endedAt && t.startedAt <= fine && t.endedAt >= inizio
      );

      return {
        inizio,
        fine,
        durataMin: Math.round((fine.getTime() - inizio.getTime()) / 60000),
        campioni: g.length,
        ...metriche(g, capacita),
        cloud: sovrapposti.map(t => ({
          distanceKm: t.distanceKm,
          startBattery: t.startBattery,
          endBattery: t.endBattery,
          energyUsedKwh: t.energyUsedKwh,
          avgConsumption: t.avgConsumption,
          durataMin: t.endedAt
            ? Math.round((t.endedAt.getTime() - t.startedAt.getTime()) / 60000)
            : null,
        })),
      };
    })
    .reverse();

  return NextResponse.json({ capacita, sessioni });
}
