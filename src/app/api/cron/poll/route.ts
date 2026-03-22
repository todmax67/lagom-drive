import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getRechargeStatus, getEngineStatus, getStatistics, getLocation } from '@/lib/volvo-api';
import { processSnapshot } from '@/lib/charging-detector';

export async function GET(request: Request) {
  // Verifica il token segreto per sicurezza
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  // Recupera tutti gli utenti attivi
  const sessions = await prisma.userSession.findMany();
  
  const results = [];

  for (const session of sessions) {
    try {
      // Controlla se il token è scaduto e aggiornalo
      let accessToken = session.accessToken;
      
      if (Date.now() > session.expiresAt * 1000 - 60_000) {
        // Refresh del token
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

        // Aggiorna i token nel database
        await prisma.userSession.update({
          where: { userId: session.userId },
          data: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? session.refreshToken,
            expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
          },
        });
      }

      // Recupera dati batteria e processa snapshot
      const battery = await getRechargeStatus(accessToken, session.userId);
      await processSnapshot(battery, session.userId);

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
}