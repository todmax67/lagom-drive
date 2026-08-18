import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

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
  // km dei soli viaggi con energia: il denominatore onesto del consumo
  kmConEnergia: number;
};

function nuovoSecchio(): Secchio {
  return { viaggi: 0, km: 0, kwh: 0, kmConEnergia: 0 };
}

function riga(chiave: string, label: string, s: Secchio) {
  return {
    chiave,
    label,
    viaggi: s.viaggi,
    km: s.km,
    kwh: s.kwh > 0 ? s.kwh : null,
    // Sotto i 10 km di base il rapporto è rumore, come per il rilevatore
    consumo: s.kmConEnergia >= 10 && s.kwh > 0 ? (s.kwh / s.kmConEnergia) * 100 : null,
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
    select: { startedAt: true, distanceKm: true, energyUsedKwh: true },
  });

  const settimane = new Map<string, Secchio>();
  const mesi = new Map<string, Secchio>();
  const anni = new Map<string, Secchio>();

  for (const v of viaggi) {
    const giorno = giornoLocale(v.startedAt);
    const chiavi: [Map<string, Secchio>, string][] = [
      [settimane, giornoLocale(lunediDi(giorno))],
      [mesi, giorno.slice(0, 7)],
      [anni, giorno.slice(0, 4)],
    ];
    for (const [mappa, chiave] of chiavi) {
      const s = mappa.get(chiave) ?? nuovoSecchio();
      s.viaggi += 1;
      if (v.distanceKm != null) s.km += v.distanceKm;
      if (v.energyUsedKwh != null) {
        s.kwh += v.energyUsedKwh;
        if (v.distanceKm != null) s.kmConEnergia += v.distanceKm;
      }
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
