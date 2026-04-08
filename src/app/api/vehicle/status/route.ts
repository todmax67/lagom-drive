import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getVin, getRechargeStatus, getEngineStatus } from '@/lib/volvo-api';
import { processSnapshot } from '@/lib/charging-detector';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();

  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? 'unknown';

  try {
    const vin = await getVin(session.accessToken);
    const [battery, isDriving] = await Promise.all([
      getRechargeStatus(session.accessToken, vin).catch(() => null),
      getEngineStatus(session.accessToken, vin).catch(() => false),
    ]);

    if (battery) {
      await processSnapshot(battery, userId).catch(err =>
        console.error('Errore processSnapshot:', err)
      );
    }

    // Aggiorna i token nella UserSession ad ogni polling
    // così il cron job ha sempre token freschi
    await prisma.userSession.upsert({
      where: { userId },
      update: {
        accessToken: session.accessToken,
        refreshToken: (session as any).refreshToken ?? '',
        expiresAt: (session as any).expiresAt ?? 0,
        lastSeen: new Date(),
      },
      create: {
        userId,
        accessToken: session.accessToken,
        refreshToken: (session as any).refreshToken ?? '',
        expiresAt: (session as any).expiresAt ?? 0,
      },
    }).catch(err => console.error('Errore UserSession update:', err));

    return NextResponse.json({
      vin,
      battery,
      isDriving,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Errore /api/vehicle/status:', error);
    return NextResponse.json(
      { message: 'Errore nel recupero dello stato del veicolo' },
      { status: 500 }
    );
  }
}