import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getRechargeStatus, getEngineStatus, getStatistics, getOdometer } from '@/lib/volvo-api';
import { processSnapshot } from '@/lib/charging-detector';
import { processTrip } from '@/lib/trip-detector';

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  await prisma.$connect();

  try {
  const sessions = await prisma.userSession.findMany();
  const results = [];

  for (const session of sessions) {
    try {
      let accessToken = session.accessToken;

      if (Date.now() > session.expiresAt * 1000 - 60_000) {
        const response = await fetch('https://volvoid.eu.volvocars.com/as/token.oauth2', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${process.env.VOLVO_CLIENT_ID}:${process.env.VOLVO_CLIENT_SECRET}`).toString('base64')}`,
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
          }),
        });

        if (!response.ok) {
          console.error(`Refresh fallito per userId ${session.userId}`);
          continue;
        }

        const tokens = await response.json();
        accessToken = tokens.access_token;

        await prisma.userSession.update({
          where: { userId: session.userId },
          data: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? session.refreshToken,
            expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
          },
        });
      }

      // Recupera tutti i dati in parallelo
      const [battery, isDriving, stats, odometer] = await Promise.all([
        getRechargeStatus(accessToken, session.userId),
        getEngineStatus(accessToken, session.userId).catch(() => false),
        getStatistics(accessToken, session.userId).catch(() => null),
        getOdometer(accessToken, session.userId).catch(() => 0),
      ]);
      console.log(`userId: ${session.userId}, isDriving: ${isDriving}, odometer: ${odometer}, battery: ${battery.level}`);

      // Processa snapshot ricarica
      await processSnapshot(battery, session.userId, odometer);

      // Processa viaggio — usa consumo medio da stats o default 18 kWh/100km
      await processTrip({
        battery: battery.level,
        odometer,
        avgConsumption: stats?.avgConsumptionKwh ?? 18,
        batteryCapacity: 69,
      }, session.userId).catch(err => console.error('Errore processTrip:', err));

      results.push({ userId: session.userId, status: 'ok' });
    } catch (error) {
      console.error(`Errore cron per userId ${session.userId}:`, error);
      results.push({ userId: session.userId, status: 'error' });
    }
  }

  return NextResponse.json({
    processed: results.length,
    results,
    timestamp: new Date().toISOString(),
  });
  } finally {
    await prisma.$disconnect();
  }
}