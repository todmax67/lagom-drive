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

  // Cerca gli ultimi 2 snapshot con odometro valido
const lastSnapshots = await prisma.batterySnapshot.findMany({
  where: { 
    userId,
    odometer: { not: null },
  },
  orderBy: { createdAt: 'desc' },
  take: 2,
});

// Il primo è quello appena creato, il secondo è quello precedente
if (lastSnapshots.length < 2) {
  console.log('Trip detector — non abbastanza snapshot, skip');
  return;
}

const currentOdometer = (lastSnapshots[0] as any).odometer;
const lastOdometer = (lastSnapshots[1] as any).odometer;
const odometerDelta = currentOdometer - lastOdometer;
const isMoving = odometerDelta > 0;

console.log(`Trip detector — odometer: ${currentOdometer}, lastOdometer: ${lastOdometer}, delta: ${odometerDelta}, isMoving: ${isMoving}`);

  if (isMoving) {
    if (!openTrip) {
      // Inizia nuovo viaggio
      await prisma.trip.create({
        data: {
          userId,
          startedAt: new Date(),
          startBattery: data.battery,
          startOdometer: data.odometer - odometerDelta,
        },
      });
    }
    return;
  }

  if (isMoving) {
  if (!openTrip) {
    await prisma.trip.create({
      data: {
        userId,
        startedAt: new Date(),
        startBattery: data.battery,
        startOdometer: lastOdometer,
      },
    });
  }
  return;
}

if (openTrip) {
  const distanceKm = currentOdometer - (openTrip.startOdometer ?? currentOdometer);
  
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
      endedAt: new Date(),
      endBattery: data.battery,
      endOdometer: currentOdometer,
      distanceKm: Math.max(0, distanceKm),
      energyUsedKwh,
      energyRegenKwh,
      avgConsumption,
      isComplete: true,
    },
  });
}
}