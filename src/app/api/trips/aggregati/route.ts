import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { marchiaGuide } from '@/lib/viaggi-fusione';

/**
 * I viaggi aggregati per settimana, mese e anno (calendario Europe/Rome).
 *
 * L'energia aggregata è quella del rilevatore cloud — DEDOTTA, ΔSoC ×
 * capacità — e la UI lo dichiara: sommare i pochi integrali misurati coi
 * molti dedotti produrrebbe un numero senza fonte. Il consumo di periodo
 * divide l'energia per i km dei SOLI viaggi che l'energia ce l'hanno,
 * o un viaggio senza stima diluirebbe il rapporto.
 */

const FUSO = 'Europe/Rome';
const MAX_SETTIMANE = 10;
const MAX_MESI = 12;

const MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

// Data locale Rome in forma YYYY-MM-DD
const giornoLocale = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: FUSO });

// Il lunedì della settimana di un giorno YYYY-MM-DD, come data pura UTC
function lunediDi(giorno: string): Date {
  const d = new Date(`${giorno}T12:00:00Z`);
  const scarto = (d.getUTCDay() + 6) % 7; // lun=0 … dom=6
  d.setUTCDate(d.getUTCDate() - scarto);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function etichettaSettimana(lunedi: Date): string {
  const domenica = new Date(lunedi.getTime() + 6 * 24 * 3600 * 1000);
  const gL = lunedi.getUTCDate();
  const gD = domenica.getUTCDate();
  const mL = MESI_BREVI[lunedi.getUTCMonth()];
  const mD = MESI_BREVI[domenica.getUTCMonth()];
  return mL === mD ? `${gL}–${gD} ${mL}` : `${gL} ${mL} – ${gD} ${mD}`;
}

type Secchio = {
  viaggi: number;
  km: number;
  kwh: number;
  // Quanti viaggi hanno una stima di energia: "somma = 0" con stime presenti
  // è un dato vero (tratte corte sotto il passo del SoC), non un'assenza
  stime: number;
  // km dei soli viaggi con energia: il denominatore onesto del consumo
  kmConEnergia: number;
};

function nuovoSecchio(): Secchio {
  return { viaggi: 0, km: 0, kwh: 0, stime: 0, kmConEnergia: 0 };
}

// Le soglie del consumo sono quelle del rilevatore (e della card fusa):
// almeno 10 km di base e almeno 1.3 kWh di energia — sotto, il numero è
// costruito da un singolo passo di quantizzazione del SoC intero.
const KM_MIN_CONSUMO = 10;
const KWH_MIN_CONSUMO = 1.3;

function riga(chiave: string, label: string, s: Secchio) {
  return {
    chiave,
    label,
    viaggi: s.viaggi,
    km: s.km,
    kwh: s.stime > 0 ? s.kwh : null,
    consumo:
      s.kmConEnergia >= KM_MIN_CONSUMO && s.kwh >= KWH_MIN_CONSUMO
        ? (s.kwh / s.kmConEnergia) * 100
        : null,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }
  const userId = (session as { userId?: string }).userId ?? 'unknown';

  const viaggi = await prisma.trip.findMany({
    where: { userId, isComplete: true },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      startOdometer: true,
      endOdometer: true,
      distanceKm: true,
      energyUsedKwh: true,
    },
  });

  // L'unità di conto è la GUIDA, non il ritaglio: stesso giudizio della lista
  // viaggi (viaggi-fusione). E la guida entra INTERA nel secchio del suo primo
  // ritaglio — conteggio, km ed energia insieme: attribuire il conteggio a un
  // secchio e i chilometri a un altro darebbe righe con "0 viaggi · 18 km"
  // ogni volta che una guida attraversa la mezzanotte di domenica.
  const arricchimenti = await prisma.tripEnrichment
    .findMany({
      where: { tripId: { in: viaggi.map(v => v.id) } },
      select: { tripId: true, sessionId: true },
    })
    .catch(() => [] as { tripId: string; sessionId: string | null }[]);
  const sessionePer = new Map(arricchimenti.map(a => [a.tripId, a.sessionId]));
  const marchio = await marchiaGuide(
    userId,
    viaggi.map(v => ({
      id: v.id,
      startedAt: v.startedAt,
      endedAt: v.endedAt,
      startOdometer: v.startOdometer,
      endOdometer: v.endOdometer,
      sessionId: sessionePer.get(v.id) ?? null,
    }))
  ).catch(() => new Map<string, string>());

  // I ritagli si fondono in guide prima di entrare nei secchi
  type Guida = { inizio: Date; km: number; kwh: number; stime: number; kmConEnergia: number };
  const guide = new Map<string, Guida>();
  for (const v of viaggi) {
    const chiave = marchio.get(v.id) ?? v.id;
    const g = guide.get(chiave) ?? {
      inizio: v.startedAt,
      km: 0,
      kwh: 0,
      stime: 0,
      kmConEnergia: 0,
    };
    if (v.distanceKm != null) g.km += v.distanceKm;
    if (v.energyUsedKwh != null) {
      g.kwh += v.energyUsedKwh;
      g.stime += 1;
      if (v.distanceKm != null) g.kmConEnergia += v.distanceKm;
    }
    guide.set(chiave, g);
  }

  const settimane = new Map<string, Secchio>();
  const mesi = new Map<string, Secchio>();
  const anni = new Map<string, Secchio>();

  for (const g of guide.values()) {
    // La guida sceglie i suoi secchi una volta sola, dal proprio inizio: così
    // conteggio e chilometri restano nella stessa riga anche quando la strada
    // attraversa la mezzanotte
    const giorno = giornoLocale(g.inizio);
    const chiavi: [Map<string, Secchio>, string][] = [
      [settimane, giornoLocale(lunediDi(giorno))],
      [mesi, giorno.slice(0, 7)],
      [anni, giorno.slice(0, 4)],
    ];
    for (const [mappa, chiave] of chiavi) {
      const s = mappa.get(chiave) ?? nuovoSecchio();
      s.viaggi += 1;
      s.km += g.km;
      s.kwh += g.kwh;
      s.stime += g.stime;
      s.kmConEnergia += g.kmConEnergia;
      mappa.set(chiave, s);
    }
  }

  const ordina = <T>(m: Map<string, Secchio>, f: (chiave: string, s: Secchio) => T) =>
    [...m.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([c, s]) => f(c, s));

  return NextResponse.json({
    settimane: ordina(settimane, (c, s) =>
      riga(c, etichettaSettimana(new Date(`${c}T00:00:00Z`)), s)
    ).slice(0, MAX_SETTIMANE),
    mesi: ordina(mesi, (c, s) => {
      const [anno, mese] = c.split('-');
      return riga(c, `${MESI_BREVI[Number(mese) - 1]} ${anno}`, s);
    }).slice(0, MAX_MESI),
    anni: ordina(anni, (c, s) => riga(c, c, s)),
  });
}
