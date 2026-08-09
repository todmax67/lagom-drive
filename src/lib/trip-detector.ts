import { prisma } from '@/lib/prisma';

interface VehicleData {
  battery: number;
  odometer: number;
  avgConsumption: number;
  volvoTripMeterAuto: number | null;
}

export async function processTrip(data: VehicleData, userId: string) {
  const settings = await prisma.settings.upsert({
    where: { userId },
    update: {},
    create: { id: userId, userId },
  });

  const capacity = settings.batteryCapacity;

  // Cerca viaggio aperto
  const openTrip = await prisma.trip.findFirst({
    where: { userId, isComplete: false },
    orderBy: { startedAt: 'desc' },
  });

  const MIN_MOVE_KM = 0.2;

  // Ultimi 3 snapshot con odometro: servono per confermare "fermo" su 2 intervalli consecutivi
  const lastSnapshots = await prisma.batterySnapshot.findMany({
    where: { userId, odometer: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });

  if (lastSnapshots.length < 2) {
    console.log('Trip detector — non abbastanza snapshot, skip');
    return;
  }

  const s0 = lastSnapshots[0] as any; // appena creato
  const s1 = lastSnapshots[1] as any; // precedente
  const s2 = lastSnapshots[2] as any | undefined; // before-previous (può mancare)

  const delta01 = s0.odometer - s1.odometer;
  const delta12 = s2 ? s1.odometer - s2.odometer : null;

  // L'odometro può solo crescere, e non di centinaia di km fra due poll.
  // Un delta fuori scala significa dato corrotto, non un viaggio: proseguire
  // creerebbe viaggi fantasma o, peggio, cancellerebbe quello vero più sotto.
  const MAX_PLAUSIBLE_DELTA_KM = 500;
  const implausible =
    delta01 < 0 ||
    delta01 > MAX_PLAUSIBLE_DELTA_KM ||
    (delta12 !== null && (delta12 < 0 || delta12 > MAX_PLAUSIBLE_DELTA_KM));

  if (implausible) {
    console.error(
      `Trip detector — delta odometrico implausibile (delta01: ${delta01}, delta12: ${delta12}), ciclo saltato`
    );
    return;
  }

  const isMoving = delta01 >= MIN_MOVE_KM;
  const wasMoving = delta12 !== null ? delta12 >= MIN_MOVE_KM : false;

  console.log(
    `Trip detector — odo: ${s0.odometer}, delta01: ${delta01}, delta12: ${delta12}, isMoving: ${isMoving}, wasMoving: ${wasMoving}`
  );

  if (isMoving) {
    if (!openTrip) {
      await prisma.trip.create({
        data: {
          userId,
          startedAt: s1.createdAt,
          startBattery: data.battery,
          startOdometer: s1.odometer,
          volvoTripMeterStart: data.volvoTripMeterAuto,
        },
      });
    }
    return;
  }

  // isMoving === false da qui in poi. Chiudi SOLO se anche l'intervallo precedente era fermo
  // (evita di chiudere al primo poll "fermo" — es. semaforo).
  if (!openTrip) return;

  if (wasMoving) {
    console.log('Trip detector — appena fermato, attendo conferma');
    return;
  }

  const endOdometer = s1.odometer;
  const endedAt = s2?.createdAt ?? s1.createdAt;
  const distanceKm = endOdometer - (openTrip.startOdometer ?? endOdometer);

  // Cancella solo i viaggi davvero troppo brevi. Una distanza negativa non è
  // un viaggio corto ma un odometro incoerente: in quel caso il viaggio resta
  // aperto e verrà chiuso al ciclo successivo con dati sani.
  if (distanceKm < 0 || !Number.isFinite(distanceKm)) {
    console.error(`Trip detector — distanza incoerente (${distanceKm}), viaggio lasciato aperto`);
    return;
  }

  if (distanceKm < 0.5) {
    await prisma.trip.delete({ where: { id: openTrip.id } });
    return;
  }

  const batteryDrop = openTrip.startBattery - data.battery;

  // Derivati dalla capacità impostata: utili da mostrare, ma NON utilizzabili per
  // stimare la capacità stessa (sarebbe circolare — uscirebbe sempre `capacity`).
  const energyUsedKwh = Math.max(0, (batteryDrop / 100) * capacity);
  const avgConsumption = distanceKm > 0 ? (energyUsedKwh / distanceKm) * 100 : 0;

  // Indipendente dalla capacità impostata: viene dal consumo medio di Volvo.
  const energyFromVolvoKwh = (distanceKm / 100) * data.avgConsumption;

  // NB: non è regen misurato, è lo scarto fra la stima Volvo e quella da SOC.
  // Il nome resta per compatibilità con la UI esistente.
  const energyRegenKwh = Math.max(0, energyFromVolvoKwh - energyUsedKwh);

  // Stima della capacità reale incrociando le due fonti:
  //   capacità = consumo_volvo × distanza ÷ ΔSOC
  // Su un singolo viaggio è rumorosa (il consumo Volvo è una media di lungo
  // periodo, non del viaggio), quindi va letta aggregata su molti viaggi.
  // Viaggi corti o con ΔSOC piccolo amplificano l'errore di arrotondamento
  // dell'1% del SOC, per questo sono esclusi.
  const MIN_CALIB_KM = 15;
  const MIN_CALIB_SOC = 10;
  const eligible =
    distanceKm >= MIN_CALIB_KM && batteryDrop >= MIN_CALIB_SOC && data.avgConsumption > 0;
  const rawCapacity = eligible ? (data.avgConsumption * distanceKm) / batteryDrop : null;
  const capacityEstimateKwh =
    rawCapacity !== null && rawCapacity >= 30 && rawCapacity <= 120 ? rawCapacity : null;

  await prisma.trip.update({
    where: { id: openTrip.id },
    data: {
      endedAt,
      endBattery: data.battery,
      endOdometer,
      distanceKm: Math.max(0, distanceKm),
      energyUsedKwh,
      energyRegenKwh,
      avgConsumption,
      volvoAvgConsumption: data.avgConsumption,
      volvoTripMeterEnd: data.volvoTripMeterAuto,
      energyFromVolvoKwh,
      capacityEstimateKwh,
      isComplete: true,
    },
  });
}