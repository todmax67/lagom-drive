import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? session.user?.email ?? 'unknown';

  const sessions = await prisma.chargingSession.findMany({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    take: 50,
  });

  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? 'unknown';
  const body = await request.json();

  const {
    startedAt,
    endedAt,
    startLevel,
    endLevel,
    chargingType,
    costPerKwh,
    location,
    notes,
  } = body;

  // La capacità è quella impostata dall'utente, non un default hardcoded né un
  // valore preso dal body: così preview e salvataggio non possono divergere.
  const settings = await prisma.settings.upsert({
    where: { userId },
    update: {},
    create: { id: userId, userId },
  });

  const energyAdded = ((endLevel - startLevel) / 100) * settings.batteryCapacity;
  const totalCost = energyAdded * (costPerKwh ?? 0);

  const newSession = await prisma.chargingSession.create({
    data: {
      userId,
      startedAt: new Date(startedAt),
      endedAt: new Date(endedAt),
      startLevel,
      endLevel,
      energyAdded: Math.max(0, energyAdded),
      chargingType,
      costPerKwh,
      totalCost: Math.max(0, totalCost),
      location,
      notes,
      isComplete: true,
    },
  });

  return NextResponse.json(newSession);
}