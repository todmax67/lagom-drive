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

  // Cerca l'ultimo snapshot per confrontare l'odometro
  const lastSnapshot = await prisma.batterySnapshot.findFirst({
    where: { 
      userId,
      odometer: { not: null },
      createdAt: { lt: new Date(Date.now() - 60_000) } // almeno 1 minuto fa
    },
    orderBy: { createdAt: 'desc' },
  });

  const lastOdometer = (lastSnapshot as any)?.odometer ?? null;

  // Se non abbiamo un odometro precedente non possiamo calcolare il delta
  if (lastOdometer === null) {
    console.log('Trip detector — nessun odometro precedente disponibile, skip');
    return;
  }

  const odometerDelta = data.odometer - lastOdometer;
  const isMoving = odometerDelta > 0;

  console.log(`Trip detector — odometer: ${data.odometer}, lastOdometer: ${lastOdometer}, delta: ${odometerDelta}, isMoving: ${isMoving}`);

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

  // Auto ferma — chiudi viaggio aperto se esiste
  if (openTrip) {
    const distanceKm = data.odometer - (openTrip.startOdometer ?? data.odometer);
    
    // Solo se ha percorso almeno 0.5 km
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
        endOdometer: data.odometer,
        distanceKm: Math.max(0, distanceKm),
        energyUsedKwh,
        energyRegenKwh,
        avgConsumption,
        isComplete: true,
      },
    });
  }
}