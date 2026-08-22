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
  rssi: number | null;
};

// Sotto questa soglia il segnale e' debole abbastanza da spiegare da solo una
// caduta: sopra, una caduta va cercata altrove (contesa di banda, non
// distanza). Il valore non e' una legge di natura ma una linea di lettura —
// per questo la UI mostra sempre anche il numero.
const RSSI_DEBOLE = -85;

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

  // Il segnale attorno ai buchi: e' la domanda per cui l'RSSI e' stato messo
  // in tabella. Per ogni interruzione, l'ultima potenza misurata PRIMA che si
  // aprisse — se il segnale stava affondando la causa e' fisica (distanza,
  // schermatura), se era pieno la causa e' altrove.
  const conRssi = campioni.filter(c => c.rssi !== null);
  const rssiOrdinati = conRssi.map(c => c.rssi!).sort((a, b) => a - b);
  const cadute: { quando: string; rssi: number | null; durataSec: number }[] = [];
  for (let i = 1; i < campioni.length; i++) {
    const dtMs = campioni[i].recordedAt.getTime() - campioni[i - 1].recordedAt.getTime();
    if (dtMs <= MAX_INTERVALLO_INTEGRABILE_MS) continue;
    // L'ultimo segnale misurato prima dell'interruzione, non il piu' vicino in
    // assoluto: dopo il buco il valore appartiene gia' al ricollegamento.
    const prima = conRssi.filter(c => c.recordedAt <= campioni[i - 1].recordedAt).pop();
    cadute.push({
      quando: campioni[i - 1].recordedAt.toISOString(),
      rssi: prima?.rssi ?? null,
      durataSec: Math.round(dtMs / 1000),
    });
  }

  return {
    distanzaKm,
    socIniziale,
    socFinale,
    energiaKwh,
    rssiMediana: rssiOrdinati.length
      ? rssiOrdinati[Math.floor(rssiOrdinati.length / 2)]
      : null,
    rssiMin: rssiOrdinati.length ? rssiOrdinati[0] : null,
    rssiCampioni: rssiOrdinati.length,
    // Il verdetto si dà solo con abbastanza cadute misurate: una sola non è
    // una firma, è un aneddoto.
    firmaCadute:
      cadute.filter(c => c.rssi !== null).length >= 2
        ? cadute.filter(c => c.rssi !== null).every(c => c.rssi! <= RSSI_DEBOLE)
          ? 'segnale debole'
          : cadute.filter(c => c.rssi !== null).every(c => c.rssi! > RSSI_DEBOLE)
            ? 'segnale pieno'
            : 'mista'
        : null,
    cadute: cadute.slice(0, 20),
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
    select: { recordedAt: true, socDisplay: true, speedKmh: true, rssi: true },
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
