import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? 'unknown';

  const sessions = await prisma.chargingSession.findMany({
    where: { userId, isComplete: true },
    orderBy: { startedAt: 'asc' },
  });

  // Raggruppa per mese
  const monthlyMap = new Map<string, {
    month: string;
    year: number;
    monthNum: number;
    totalCost: number;
    totalKwh: number;
    sessions: number;
    homeSessions: number;
    publicSessions: number;
    homeCost: number;
    publicCost: number;
  }>();

  for (const s of sessions) {
    const date = new Date(s.startedAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!monthlyMap.has(key)) {
      monthlyMap.set(key, {
        month: date.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }),
        year: date.getFullYear(),
        monthNum: date.getMonth() + 1,
        totalCost: 0,
        totalKwh: 0,
        sessions: 0,
        homeSessions: 0,
        publicSessions: 0,
        homeCost: 0,
        publicCost: 0,
      });
    }

    const entry = monthlyMap.get(key)!;
    entry.totalCost += s.totalCost ?? 0;
    entry.totalKwh += s.energyAdded ?? 0;
    entry.sessions += 1;

    if (s.chargingType === 'AC') {
      entry.homeSessions += 1;
      entry.homeCost += s.totalCost ?? 0;
    } else {
      entry.publicSessions += 1;
      entry.publicCost += s.totalCost ?? 0;
    }
  }

  const result = Array.from(monthlyMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0])) // più recente prima
    .map(([key, value]) => ({ key, ...value }));

  return NextResponse.json(result);
}