import { prisma } from '@/lib/prisma';

interface VehicleData {
  battery: number;
  odometer: number;
  avgConsumption: number;
  batteryCapacity: number;
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
  const endedAt = s1.createdAt;
  const distanceKm = endOdometer - (openTrip.startOdometer ?? endOdometer);

  if (distanceKm < 0.5) {
    await prisma.trip.delete({ where: { id: openTrip.id } });
    return;
  }

  const batteryDrop = openTrip.startBattery - data.battery;
  const energyUsedKwh = Math.max(0, (batteryDrop / 100) * capacity);
  const theoreticalKwh = (distanceKm / 100) * data.avgConsumption;
  const energyRegenKwh = Math.max(0, theoreticalKwh - energyUsedKwh);
  const avgConsumption = distanceKm > 0 ? (energyUsedKwh / distanceKm) * 100 : 0;

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
      isComplete: true,
    },
  });
}