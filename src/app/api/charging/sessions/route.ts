import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? session.user?.email ?? 'unknown';
console.log("SESSION USER:", JSON.stringify(session.user));
console.log("SESSION ANY:", JSON.stringify((session as any).userId));
console.log("FINAL userId:", userId);

  const sessions = await prisma.chargingSession.findMany({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    take: 50,
  });

  console.log("SESSIONS:", sessions.length, "userId:", userId); // ← aggiungi

  return NextResponse.json(sessions);
}