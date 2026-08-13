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

  // Sveglia Neon con retry progressivo
    let connected = false;
    for (let i = 0; i < 3; i++) {
      try {
        await prisma.$executeRaw`SELECT 1`;
        connected = true;
        break;
      } catch {
        console.log(`Neon ping tentativo ${i + 1} fallito, attendo...`);
        await new Promise(resolve => setTimeout(resolve, 3000 * (i + 1)));
      }
    }

    if (!connected) {
      return NextResponse.json({ error: 'Database non raggiungibile' }, { status: 503 });
    }

  try {
  const sessions = await prisma.userSession.findMany();
  const results = [];

  // Soglie di età minima dell'ultimo snapshot prima di ripollare Volvo.
  // Il cron esterno gira ogni 2min: qui decidiamo se onorare il poll o saltarlo.
  const MIN_AGE_MS = {
    charging: 2 * 60 * 1000,   // ricarica in corso: precisione curva
    moving: 2 * 60 * 1000,     // guida: precisione trip
    plugged: 5 * 60 * 1000,    // spina inserita, non carica: aspetta start
    idleRecent: 5 * 60 * 1000, // fermo da poco
    idleLong: 15 * 60 * 1000,  // fermo da >30min
  };
  const IDLE_LONG_MS = 30 * 60 * 1000;
  const MIN_MOVE_KM = 0.2;

  for (const session of sessions) {
    try {
      // Adaptive polling: decide se saltare in base allo stato precedente
      const last2 = await prisma.batterySnapshot.findMany({
        where: { userId: session.userId, odometer: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      const lastSnap = last2[0];
      if (lastSnap) {
        const ageMs = Date.now() - lastSnap.createdAt.getTime();
        const prevOdo = last2[1]?.odometer ?? null;
        const wasMoving =
          prevOdo !== null &&
          lastSnap.odometer !== null &&
          lastSnap.odometer - prevOdo >= MIN_MOVE_KM;

        let minAge = MIN_AGE_MS.idleRecent;
        let mode: keyof typeof MIN_AGE_MS = 'idleRecent';
        if (lastSnap.isCharging) { minAge = MIN_AGE_MS.charging; mode = 'charging'; }
        else if (wasMoving) { minAge = MIN_AGE_MS.moving; mode = 'moving'; }
        else if (lastSnap.isConnected) { minAge = MIN_AGE_MS.plugged; mode = 'plugged'; }
        else if (lastSnap.odometer !== null) {
          // Quanto è ferma l'auto va misurato sull'odometro, non sull'età
          // dell'ultimo snapshot: quella resta sempre sotto idleRecent perché
          // è il polling stesso a tenerla bassa, e idleLong non scatterebbe mai.
          const lastMove = await prisma.batterySnapshot.findFirst({
            where: {
              userId: session.userId,
              odometer: { not: null, lt: lastSnap.odometer },
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });
          const stationaryMs = lastMove
            ? Date.now() - lastMove.createdAt.getTime()
            : Number.POSITIVE_INFINITY;
          if (stationaryMs > IDLE_LONG_MS) { minAge = MIN_AGE_MS.idleLong; mode = 'idleLong'; }
        }

        if (ageMs < minAge) {
          console.log(`Skip poll userId ${session.userId}: mode=${mode}, ageMs=${ageMs}, minAge=${minAge}`);
          results.push({ userId: session.userId, status: 'skipped', mode });
          continue;
        }
      }

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
          // Senza il dettaglio non si distingue un refresh token revocato da
          // credenziali client sbagliate, e senza la riga in results il
          // fallimento sparirebbe dalla response.
          const detail = await response.text().catch(() => '');
          console.error(
            `Refresh fallito per userId ${session.userId}: HTTP ${response.status} ${detail.slice(0, 300)}`
          );
          results.push({ userId: session.userId, status: 'refresh_failed' });
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

      // Recupera tutti i dati in parallelo. L'odometro fallisce a null, non a 0:
      // uno 0 finirebbe in DB indistinguibile da una lettura vera e il trip
      // detector lo leggerebbe come un salto di decine di migliaia di km.
      const [battery, isDriving, stats, odometer] = await Promise.all([
        getRechargeStatus(accessToken, session.userId),
        getEngineStatus(accessToken, session.userId).catch(() => false),
        getStatistics(accessToken, session.userId).catch(() => null),
        getOdometer(accessToken, session.userId).catch(() => null),
      ]);
      console.log(`userId: ${session.userId}, isDriving: ${isDriving}, odometer: ${odometer}, battery: ${battery.level}`);

      // Processa snapshot ricarica
      await processSnapshot(battery, session.userId, odometer ?? undefined, 'cron');

      // Senza odometro non si può calcolare nessun delta: saltare è l'unica
      // opzione corretta, il ciclo successivo riprende con un dato valido.
      if (odometer === null) {
        console.log(`Odometro non disponibile per userId ${session.userId}: processTrip saltato`);
        results.push({ userId: session.userId, status: 'ok', odometer: 'unavailable' });
        continue;
      }

      // Processa viaggio. Se le statistiche mancano si passa null: i campi che
      // ne dipendono restano vuoti invece di poggiare su un valore inventato.
      await processTrip({
        battery: battery.level,
        odometer,
        avgConsumption: stats?.avgConsumptionKwh ?? null,
        volvoTripMeterAuto: stats?.tripMeter2Km ?? null,
      }, session.userId).catch(err => console.error('Errore processTrip:', err));

      results.push({ userId: session.userId, status: 'ok' });
    } catch (error) {
      console.error(`Errore cron per userId ${session.userId}:`, error);
      results.push({ userId: session.userId, status: 'error' });
    }
  }

  // Lo scheduler esterno vede solo lo status HTTP, e va avvisato quando la
  // raccolta si ferma: senza, può restare rotta per mesi senza che nessuno se
  // ne accorga. Ma va avvisato con parsimonia, perché dopo qualche fallimento
  // consecutivo disabilita il job da solo: rispondere 503 a ogni intoppo
  // transitorio dell'API Volvo trasforma il monitoraggio nella causa del
  // guasto. È già successo.
  //
  // Il segnale giusto non è "questo poll è fallito" ma "non si raccolgono più
  // dati da troppo tempo": un errore isolato passa, un guasto persistente no.
  const failed = results.filter(r => r.status === 'error' || r.status === 'refresh_failed');

  const ultimoSnapshot = await prisma.batterySnapshot.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const fermoDaMin = ultimoSnapshot
    ? Math.round((Date.now() - ultimoSnapshot.createdAt.getTime()) / 60000)
    : Infinity;

  // La soglia deve stare sopra l'intervallo più lungo del polling adattivo,
  // altrimenti un'auto ferma da giorni verrebbe scambiata per un guasto.
  const RACCOLTA_FERMA_MIN = 45;

  // Nessuna sessione da processare è un problema di configurazione, non un
  // intoppo: lì l'allarme è immediato, perché non si risolve da sé.
  const nessunaSessione = results.length === 0;
  const guastoPersistente = failed.length > 0 && fermoDaMin > RACCOLTA_FERMA_MIN;
  const daSegnalare = nessunaSessione || guastoPersistente;

  if (failed.length > 0) {
    console.error(
      `Cron: ${failed.length} sessioni fallite su ${results.length}, ` +
        `ultimo dato ${fermoDaMin} min fa, allarme=${daSegnalare}`
    );
  }

  return NextResponse.json({
    processed: results.length,
    failed: failed.length,
    lastDataMinutesAgo: fermoDaMin === Infinity ? null : fermoDaMin,
    results,
    timestamp: new Date().toISOString(),
  }, { status: daSegnalare ? 503 : 200 });
  } finally {
    await prisma.$disconnect();
  }
}