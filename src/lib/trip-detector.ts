import { prisma } from '@/lib/prisma';

interface VehicleData {
  battery: number;
  odometer: number;
  isDriving: boolean;
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

  // Auto in moto — inizia o continua viaggio
  if (data.isDriving) {
    if (!openTrip) {
      await prisma.trip.create({
        data: {
          userId,
          startedAt: new Date(),
          startBattery: data.battery,
          startOdometer: data.odometer,
        },
      });
    }
    return;
  }

  // Auto ferma — chiudi viaggio aperto se esiste
  if (openTrip) {
    const distanceKm = data.odometer - (openTrip.startOdometer ?? data.odometer);
    const batteryDrop = openTrip.startBattery - data.battery;
    const energyUsedKwh = Math.max(0, (batteryDrop / 100) * capacity);

    // Energia teorica consumata basata sul consumo medio
    const theoreticalKwh = (distanceKm / 100) * data.avgConsumption;

    // Energia rigenerata = teorica - reale (se positiva)
    const energyRegenKwh = Math.max(0, theoreticalKwh - energyUsedKwh);

    const avgConsumption = distanceKm > 0
      ? (energyUsedKwh / distanceKm) * 100
      : 0;

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
