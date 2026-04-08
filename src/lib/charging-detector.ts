import { prisma } from '@/lib/prisma';
import type { VehicleStatus } from '@/types/volvo';

export async function processSnapshot(
  battery: VehicleStatus['battery'],
  userId: string,
  odometer?: number
) {
  await prisma.batterySnapshot.create({
    data: {
      userId,
      level: battery.level,
      range: battery.range,
      isCharging: battery.isCharging,
      isConnected: battery.isConnected,
      chargingType: battery.chargingType ?? null,
      odometer: odometer ?? null, 
    },
  });

  const settings = await prisma.settings.upsert({
    where: { userId },
    update: {},
    create: { id: userId, userId },
  });

  const openSession = await prisma.chargingSession.findFirst({
    where: { userId, isComplete: false },
    orderBy: { startedAt: 'desc' },
  });

  if (battery.isCharging) {
    if (!openSession) {
      await prisma.chargingSession.create({
        data: {
          userId,
          startedAt: new Date(),
          startLevel: battery.level,
          chargingType: battery.chargingType ?? 'AC',
          costPerKwh: battery.chargingType === 'DC'
            ? settings.publicTariff
            : settings.homeTariff,
          location: battery.chargingType === 'DC' ? 'Colonnina' : 'Casa',
        },
      });
    }
    return;
  }

  if (openSession && !battery.isCharging) {
    const endLevel = battery.level;
    const levelDiff = endLevel - openSession.startLevel;
    const energyAdded = (levelDiff / 100) * settings.batteryCapacity;
    const totalCost = energyAdded * (openSession.costPerKwh ?? settings.homeTariff);

    await prisma.chargingSession.update({
      where: { id: openSession.id },
      data: {
        endedAt: new Date(),
        endLevel,
        energyAdded: Math.max(0, energyAdded),
        totalCost: Math.max(0, totalCost),
        isComplete: true,
      },
    });
  }
}