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