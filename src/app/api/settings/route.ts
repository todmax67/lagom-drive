import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const settings = await prisma.settings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });

  return NextResponse.json(settings);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const body = await request.json();

  const settings = await prisma.settings.upsert({
    where: { id: 'singleton' },
    update: {
      homeTariff: body.homeTariff,
      publicTariff: body.publicTariff,
      batteryCapacity: body.batteryCapacity,
    },
    create: {
      id: 'singleton',
      homeTariff: body.homeTariff,
      publicTariff: body.publicTariff,
      batteryCapacity: body.batteryCapacity,
    },
  });

  return NextResponse.json(settings);
}