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
      where: { userId, wallKwh: { not: null }, endLevel: { not: null } },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true, wallKwh: true, startLevel: true, endLevel: true },
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

  // Testimone B: capacità ÷ η, dichiarato tale. La prima coppia storica
  // (19.31 kWh per 51→80 del 15 ago) NON è riversabile: il rilevatore ha
  // registrato 57→80, e abbinare il contatore a un delta che non è il suo
  // fabbricherebbe un punto. La serie parte dalle ricariche col dato inserito.
  const muro = cariche
    .map(c => {
      const delta = c.endLevel! - c.startLevel;
      if (delta < DELTA_LIVELLO_MIN_MURO) return null;
      return { t: c.startedAt.toISOString(), kwh: (c.wallKwh! / delta) * 100 };
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
