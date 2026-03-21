import { prisma } from '@/lib/prisma';
import type { VehicleStatus } from '@/types/volvo';

export async function processSnapshot(battery: VehicleStatus['battery']) {
  // 1. Salva snapshot corrente
  await prisma.batterySnapshot.create({
    data: {
      level: battery.level,
      range: battery.range,
      isCharging: battery.isCharging,
      isConnected: battery.isConnected,
      chargingType: battery.chargingType ?? null,
    },
  });

  // 2. Ottieni impostazioni tariffe
  const settings = await prisma.settings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });

  // 3. Cerca sessione di ricarica aperta
  const openSession = await prisma.chargingSession.findFirst({
    where: { isComplete: false },
    orderBy: { startedAt: 'desc' },
  });

  // 4. Sta caricando ora
  if (battery.isCharging) {
    if (!openSession) {
      // Inizia nuova sessione
      await prisma.chargingSession.create({
        data: {
          startedAt: new Date(),
          startLevel: battery.level,
          chargingType: battery.chargingType ?? 'AC',
          costPerKwh: battery.chargingType === 'DC'
            ? settings.publicTariff
            : settings.homeTariff,
          location: battery.chargingType === 'DC' ? 'Colonnina' : 'Casa',
        },
      });
      console.log(`Nuova sessione di ricarica iniziata: ${battery.level}%`);
    }
    return;
  }

  // 5. Non sta caricando — chiudi sessione aperta se esiste
  if (openSession && !battery.isCharging) {
    const endLevel = battery.level;
    const startLevel = openSession.startLevel;
    const levelDiff = endLevel - startLevel;

    // Calcoliamo i kWh aggiunti dalla differenza di percentuale
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
    console.log(`Sessione di ricarica completata: ${startLevel}% → ${endLevel}%, ${energyAdded.toFixed(1)} kWh`);
  }
}