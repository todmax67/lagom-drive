import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * I testimoni della salute batteria (bussola §4.4), come serie temporali:
 *
 * - testimone A: il registro SoH del BECM, una lettura per giorno — in
 *   validazione finché non sarà visto muoversi;
 * - testimone B: le coppie muro delle ricariche — kWh pagati / Δ livello,
 *   con l'efficienza DENTRO il numero (è capacità ÷ η, e si dichiara);
 * - testimone C: i viaggi misurati — netto ∫V×I / ΔSoC, solo con copertura
 *   della potenza ≥ 95% e un salto di SoC sopra la soglia anti-quantizzazione.
 *
 * La pagina si costruisce da sola man mano che i punti si depositano: qui
 * non si promuove niente — la capacità di lavoro resta quella delle
 * impostazioni finché la promozione non sarà un atto deliberato.
 */

// Stessa soglia della card viaggi: sotto, il passo di 0.784% del display
// domina il numero (~±10% già a 8 punti)
const DELTA_SOC_MIN_VIAGGI = 8;
// Le coppie muro usano i livelli cloud (interi): serve un salto più largo
const DELTA_LIVELLO_MIN_MURO = 15;
// Stessa soglia del badge "misurato" della card
const COPERTURA_MIN = 0.95;
const FUSO = 'Europe/Rome';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }
  const userId = (session as { userId?: string }).userId ?? 'unknown';

  const [settings, letture, arricchimenti, cariche] = await Promise.all([
    prisma.settings.findUnique({ where: { userId } }),
    prisma.obdSample.findMany({
      where: { userId, soh: { not: null } },
      orderBy: { recordedAt: 'asc' },
      select: { recordedAt: true, soh: true },
    }),
    prisma.tripEnrichment.findMany({
      where: {
        userId,
        powerCoverage: { gte: COPERTURA_MIN },
        socStartObd: { not: null },
        socEndObd: { not: null },
        energyGrossKwh: { not: null },
        energyRegenGrossKwh: { not: null },
      },
      select: {
        tripId: true,
        socStartObd: true,
        socEndObd: true,
        energyGrossKwh: true,
        energyRegenGrossKwh: true,
      },
    }).catch(() => []),
    prisma.chargingSession.findMany({
      where: { userId, endLevel: { not: null } },
      orderBy: { startedAt: 'asc' },
      select: {
        startedAt: true,
        endedAt: true,
        wallKwh: true,
        startLevel: true,
        endLevel: true,
        chargingType: true,
      },
    }),
  ]);

  // Testimone A: una lettura per giorno (la prima: di solito è la sonda del
  // buongiorno, a riposo). Le altre dello stesso giorno confermano soltanto.
  const perGiorno = new Map<string, { t: Date; v: number }>();
  for (const l of letture) {
    const giorno = l.recordedAt.toLocaleDateString('sv-SE', { timeZone: FUSO });
    if (!perGiorno.has(giorno)) perGiorno.set(giorno, { t: l.recordedAt, v: l.soh! });
  }
  const sohSerie = [...perGiorno.values()].map(p => ({ t: p.t.toISOString(), v: p.v }));
  const valoriDistinti = new Set(letture.map(l => l.soh!.toFixed(2))).size;

  // Testimone C: la data del punto è quella del viaggio, non dell'arricchimento
  const viaggiDate = new Map(
    (
      await prisma.trip.findMany({
        where: { id: { in: arricchimenti.map(a => a.tripId) } },
        select: { id: true, startedAt: true },
      })
    ).map(t => [t.id, t.startedAt])
  );
  const viaggi = arricchimenti
    .map(a => {
      const deltaSoc = a.socStartObd! - a.socEndObd!;
      const netto = a.energyGrossKwh! - a.energyRegenGrossKwh!;
      const t = viaggiDate.get(a.tripId);
      if (!t || deltaSoc < DELTA_SOC_MIN_VIAGGI || netto <= 0) return null;
      return { t: t.toISOString(), kwh: (netto / deltaSoc) * 100 };
    })
    .filter((x): x is { t: string; kwh: number } => x !== null)
    .sort((a, b) => a.t.localeCompare(b.t));

  // Testimone B: capacità ÷ η, dichiarato tale.
  //
  // Gli spezzoni si ricompongono, come i ritagli dei viaggi: una colonnina
  // fermata a metà (è successo il 15 ago, stop manuale per accendere forno e
  // induzione) produce due sessioni del rilevatore che sono UNA ricarica. La
  // firma è la continuità di livello: fine di una == inizio della successiva,
  // nessuna guida in mezzo, ripresa entro le 12 ore. Il contatore del gruppo
  // è la somma dei wallKwh inseriti — vale sia col totale scritto una volta
  // sola, sia coi contatori per-spezzone.
  const GAP_MAX_MS = 12 * 3600 * 1000;
  const gruppi: (typeof cariche)[] = [];
  for (const c of cariche) {
    const gruppo = gruppi[gruppi.length - 1];
    const prec = gruppo?.[gruppo.length - 1];
    if (
      prec &&
      prec.endLevel === c.startLevel &&
      prec.chargingType === c.chargingType &&
      prec.endedAt &&
      c.startedAt.getTime() >= prec.endedAt.getTime() &&
      c.startedAt.getTime() - prec.endedAt.getTime() <= GAP_MAX_MS
    ) {
      gruppo.push(c);
    } else {
      gruppi.push([c]);
    }
  }
  const muro = gruppi
    .map(g => {
      const delta = g[g.length - 1].endLevel! - g[0].startLevel;
      const contatori = g.filter(c => c.wallKwh != null);
      if (contatori.length === 0 || delta < DELTA_LIVELLO_MIN_MURO) return null;
      const wall = contatori.reduce((s, c) => s + c.wallKwh!, 0);
      return { t: g[0].startedAt.toISOString(), kwh: (wall / delta) * 100 };
    })
    .filter((x): x is { t: string; kwh: number } => x !== null);

  return NextResponse.json({
    capacitaLavoro: settings?.batteryCapacity ?? 67,
    soh: {
      serie: sohSerie,
      ultimo: letture.length ? letture[letture.length - 1].soh : null,
      letture: letture.length,
      dal: letture.length ? letture[0].recordedAt.toISOString() : null,
      valoriDistinti,
    },
    viaggi,
    muro,
  });
}
