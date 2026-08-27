import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? session.user?.email ?? 'unknown';

  const settings = await prisma.settings.upsert({
    where: { userId },
    update: {},
    create: { id: userId, userId },
  });

  return NextResponse.json(settings);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? session.user?.email ?? 'unknown';
  const body = await request.json();

  const settings = await prisma.settings.upsert({
    where: { userId },
    update: {
      homeTariff: body.homeTariff,
      publicTariff: body.publicTariff,
      batteryCapacity: body.batteryCapacity,
      ...(typeof body.batteryCapacityNominal === 'number' && {
        batteryCapacityNominal: body.batteryCapacityNominal,
      }),
    },
    create: {
      id: userId,
      userId,
      homeTariff: body.homeTariff,
      publicTariff: body.publicTariff,
      batteryCapacity: body.batteryCapacity,
      ...(typeof body.batteryCapacityNominal === 'number' && {
        batteryCapacityNominal: body.batteryCapacityNominal,
      }),
    },
  });

  return NextResponse.json(settings);
}