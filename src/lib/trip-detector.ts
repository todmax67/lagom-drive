import { prisma } from '@/lib/prisma';

interface VehicleData {
  battery: number;
  odometer: number;
  avgConsumption: number;
  volvoTripMeterAuto: number | null;
}

const MIN_MOVE_KM = 0.2;
const MIN_TRIP_KM = 0.5;
const MAX_PLAUSIBLE_DELTA_KM = 500;

// Quanto indietro cercare la partenza. Con il polling adattivo la cadenza varia,
// quindi il limite vero è temporale; il take serve solo a non caricare tutto.
const MAX_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const LOOKBACK_SNAPSHOTS = 250;

// Snapshot consecutivi a batteria identica oltre i quali si assume veicolo fermo.
// Sotto questa soglia il tratto piatto è solo la risoluzione dell'1% del SOC.
const FLAT_RUN_PARKED = 3;

type Snap = {
  createdAt: Date;
  level: number;
  odometer: number | null;
  isCharging: boolean;
};

/**
 * L'endpoint odometro di Volvo non si aggiorna durante la marcia: riporta il
 * nuovo valore solo a veicolo parcheggiato. Il livello batteria invece è live.
 *
 * Ne consegue che un salto dell'odometro segnala un viaggio GIÀ CONCLUSO, non
 * uno in corso: il viaggio va scritto tutto in una volta, ricostruendo la
 * finestra all'indietro sulla batteria. Trattare il salto come "sto partendo"
 * produceva viaggi di 3-4 minuti (il ritardo di aggiornamento) con consumo
 * nullo, perché start e end battery finivano entrambi dopo la marcia.
 */
function trovaPartenza(snaps: Snap[], jumpIdx: number): number {
  const end = snaps[jumpIdx];
  const odoPrima = snaps[jumpIdx - 1].odometer;

  // Finestra cieca: gli snapshot che condividono l'odometro pre-salto, cioè
  // tutto il tempo in cui l'auto ha guidato senza che l'odometro lo dicesse.
  let inizio = jumpIdx - 1;
  while (
    inizio > 0 &&
    snaps[inizio - 1].odometer === odoPrima &&
    !snaps[inizio - 1].isCharging &&
    end.createdAt.getTime() - snaps[inizio - 1].createdAt.getTime() <= MAX_LOOKBACK_MS
  ) {
    inizio--;
  }

  // Nella finestra la batteria cala guidando e resta piatta da fermi: la
  // partenza è dove inizia il calo, quindi si scartano i tratti piatti iniziali
  // abbastanza lunghi da indicare una sosta.
  let partenza = inizio;
  while (partenza < jumpIdx - 1) {
    let run = 1;
    while (
      partenza + run < jumpIdx &&
      snaps[partenza + run].level === snaps[partenza].level
    ) {
      run++;
    }
    if (run >= FLAT_RUN_PARKED) partenza += run - 1;
    else break;
  }

  return partenza;
}

export async function processTrip(data: VehicleData, userId: string) {
  const settings = await prisma.settings.upsert({
    where: { userId },
    update: {},
    create: { id: userId, userId },
  });

  const capacity = settings.batteryCapacity;

  // I salti sono rari, qualche volta al giorno: il caso comune deve restare a
  // due righe, e la finestra di lookback si carica solo quando serve davvero.
  const ultimi2 = await prisma.batterySnapshot.findMany({
    where: { userId, odometer: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { createdAt: true, level: true, odometer: true, isCharging: true },
  });

  if (ultimi2.length < 2) {
    console.log('Trip detector — non abbastanza snapshot, skip');
    return;
  }

  const fine = ultimi2[0] as Snap;
  const precedente = ultimi2[1] as Snap;
  const distanceKm = (fine.odometer ?? 0) - (precedente.odometer ?? 0);

  if (distanceKm < MIN_MOVE_KM) return;

  if (distanceKm > MAX_PLAUSIBLE_DELTA_KM) {
    console.error(`Trip detector — salto odometrico implausibile (${distanceKm} km), ignorato`);
    return;
  }

  if (distanceKm < MIN_TRIP_KM) return;

  // Il salto viene osservato una volta sola, ma un poll ripetuto sugli stessi
  // snapshot creerebbe un duplicato: l'odometro di arrivo lo identifica.
  const giaRegistrato = await prisma.trip.findFirst({
    where: { userId, endOdometer: fine.odometer },
  });
  if (giaRegistrato) return;

  const finestra = await prisma.batterySnapshot.findMany({
    where: {
      userId,
      odometer: { not: null },
      createdAt: {
        gte: new Date(fine.createdAt.getTime() - MAX_LOOKBACK_MS),
        lte: fine.createdAt,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: LOOKBACK_SNAPSHOTS,
    select: { createdAt: true, level: true, odometer: true, isCharging: true },
  });

  const snaps = finestra.reverse() as Snap[];
  const jumpIdx = snaps.length - 1;

  // Serve almeno lo snapshot pre-salto per ricostruire: senza, si ripiega su
  // quello che si ha invece di sollevare un errore che il cron inghiottirebbe.
  const partenza = jumpIdx >= 1 ? snaps[trovaPartenza(snaps, jumpIdx)] : precedente;

  const batteryDrop = partenza.level - fine.level;

  // Derivati dalla capacità impostata: non utilizzabili per stimare la capacità.
  const energyUsedKwh = Math.max(0, (batteryDrop / 100) * capacity);
  const avgConsumption = distanceKm > 0 ? (energyUsedKwh / distanceKm) * 100 : 0;

  // Indipendente dalla capacità impostata: viene dal consumo medio di Volvo.
  const energyFromVolvoKwh = (distanceKm / 100) * data.avgConsumption;

  // Non è regen misurato, è lo scarto fra le due stime.
  const energyRegenKwh = Math.max(0, energyFromVolvoKwh - energyUsedKwh);

  const MIN_CALIB_KM = 15;
  const MIN_CALIB_SOC = 10;
  const eligible =
    distanceKm >= MIN_CALIB_KM && batteryDrop >= MIN_CALIB_SOC && data.avgConsumption > 0;
  const rawCapacity = eligible ? (data.avgConsumption * distanceKm) / batteryDrop : null;
  const capacityEstimateKwh =
    rawCapacity !== null && rawCapacity >= 30 && rawCapacity <= 120 ? rawCapacity : null;

  console.log(
    `Trip detector — viaggio di ${distanceKm} km ricostruito: ` +
      `${partenza.createdAt.toISOString()} -> ${fine.createdAt.toISOString()}, ` +
      `batteria ${partenza.level}% -> ${fine.level}%`
  );

  await prisma.trip.create({
    data: {
      userId,
      startedAt: partenza.createdAt,
      endedAt: fine.createdAt,
      startBattery: partenza.level,
      endBattery: fine.level,
      startOdometer: precedente.odometer,
      endOdometer: fine.odometer,
      distanceKm,
      energyUsedKwh,
      energyRegenKwh,
      avgConsumption,
      energyFromVolvoKwh,
      capacityEstimateKwh,
      volvoAvgConsumption: data.avgConsumption,
      volvoTripMeterEnd: data.volvoTripMeterAuto,
      isComplete: true,
    },
  });
}
