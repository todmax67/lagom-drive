import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const sessions = await prisma.chargingSession.findMany({
    orderBy: { startedAt: 'desc' },
    take: 50, // ultime 50 sessioni
  });

  return NextResponse.json(sessions);
}