import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getRechargeStatus, getEngineStatus, getStatistics, getOdometer } from '@/lib/volvo-api';
import { processSnapshot } from '@/lib/charging-detector';
import { processTrip } from '@/lib/trip-detector';
import { arricchisciViaggiRecenti } from '@/lib/accoppiatore';
import { accessTokenValido } from '@/lib/rinnovo-token';

/**
 * Il rinnovo passa dall'unico rinnovatore (src/lib/rinnovo-token.ts): la
 * pretesa atomica sulla riga fa sì che cron, telefono e PC non spendano mai
 * lo stesso refresh token in due. Qui resta solo la traduzione dell'esito.
 */
async function rinnovaToken(session: { userId: string }): Promise<string | null> {
  const esito = await accessTokenValido(session.userId);
  return esito.ok ? esito.accessToken : null;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  try {
  // Sveglia Neon con retry progressivo. Sta dentro il try: anche un $connect
  // che lancia deve uscire come 200 in allarme, non come 500 di Vercel.
  await prisma.$connect();
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
      // Un intoppo del database non deve spegnere lo scheduler: qui c'era un
      // 503, ed è lo stesso meccanismo dei due blackout — cron-job.org legge i
      // 5xx come "endpoint rotto" e si disabilita da solo. Il guasto viaggia
      // nel corpo come tutti gli altri, e ad allarmare pensano il workflow
      // GitHub e la dashboard.
      console.error('Cron: Neon non raggiungibile dopo 3 tentativi');
      return NextResponse.json({
        healthy: false,
        alert: 'db_irraggiungibile',
        processed: 0,
        failed: 0,
        lastDataMinutesAgo: null,
        results: [],
        timestamp: new Date().toISOString(),
      });
    }
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
      // Adaptive polling: decide se saltare in base allo stato precedente.
      // Solo campioni del cron: quelli della dashboard li scrive chi sta
      // guardando, e azzererebbero quest'orologio — con la PWA aperta il cron
      // salterebbe ogni giro, e un guasto al refresh resterebbe invisibile
      // proprio mentre qualcuno è lì a poterlo vedere. È successo: due ore e
      // mezza di refresh falliti mascherate da "skipped" a ogni apertura.
      const last2 = await prisma.batterySnapshot.findMany({
        where: { userId: session.userId, odometer: { not: null }, source: 'cron' },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      const lastSnap = last2[0];
      let minAge = 0;
      let mode: keyof typeof MIN_AGE_MS = 'idleRecent';
      let ageMs = Number.POSITIVE_INFINITY;
      if (lastSnap) {
        ageMs = Date.now() - lastSnap.createdAt.getTime();
        const prevOdo = last2[1]?.odometer ?? null;
        const wasMoving =
          prevOdo !== null &&
          lastSnap.odometer !== null &&
          lastSnap.odometer - prevOdo >= MIN_MOVE_KM;

        minAge = MIN_AGE_MS.idleRecent;
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

      }

      // Il token si rinnova attraverso rinnovaToken, che conosce la corsa fra
      // i due scheduler. null significa refresh davvero fallito.
      const accessToken = await rinnovaToken(session);
      if (accessToken === null) {
        results.push({ userId: session.userId, status: 'refresh_failed' });
        continue;
      }

      // LA SONDA LEGGERA. Dove prima si saltava a scatola chiusa, ora si spende
      // UNA sola chiamata per chiedere se è cambiato qualcosa.
      //
      // Il salto cieco costava caro proprio quando serviva precisione: ad auto
      // ferma il timer va a quindici minuti, quindi l'INIZIO di qualunque cosa
      // — una partenza, una spina inserita, una ricarica — veniva scoperto con
      // un quarto d'ora di ritardo. Il 27 agosto è costato l'avvio di una DC:
      // alle 17:02 l'auto era ferma al 37%, il giro dopo è arrivato alle 17:12
      // e l'ha trovata già al 48% e in carica. Undici punti persi, su una
      // ricarica che in tutto ne ha fatti 42.
      //
      // Lo stato di ricarica è una chiamata sola e porta i tre segnali che
      // contano (livello, in carica, spina). Se non è cambiato niente si esce
      // come prima; se è cambiato si prosegue col giro pieno SENZA aspettare
      // il timer, e la lettura appena fatta viene riusata invece di rifarla.
      let sonda: Awaited<ReturnType<typeof getRechargeStatus>> | null = null;
      if (lastSnap && ageMs < minAge) {
        sonda = await getRechargeStatus(accessToken, session.userId);
        const cambiato =
          sonda.level !== lastSnap.level ||
          sonda.isCharging !== lastSnap.isCharging ||
          sonda.isConnected !== lastSnap.isConnected;
        if (!cambiato) {
          console.log(`Sonda userId ${session.userId}: nulla di nuovo (mode=${mode}, ageMs=${ageMs})`);
          results.push({ userId: session.userId, status: 'sonda', mode });
          continue;
        }
        console.log(
          `Sonda userId ${session.userId}: CAMBIATO (${lastSnap.level}%→${sonda.level}%, ` +
            `carica ${lastSnap.isCharging}→${sonda.isCharging}, spina ${lastSnap.isConnected}→${sonda.isConnected}) — giro pieno subito`
        );
      }

      // Recupera tutti i dati in parallelo. L'odometro fallisce a null, non a 0:
      // uno 0 finirebbe in DB indistinguibile da una lettura vera e il trip
      // detector lo leggerebbe come un salto di decine di migliaia di km.
      const [battery, isDriving, stats, odometer] = await Promise.all([
        sonda ?? getRechargeStatus(accessToken, session.userId),
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

      // Se processTrip ha appena chiuso un viaggio, i campioni OBD della guida
      // sono in tabella da prima che il viaggio esistesse: l'aggancio parte da
      // qui. Fa qualcosa solo per i viaggi recenti senza arricchimento.
      await arricchisciViaggiRecenti(session.userId).catch(err =>
        console.error('Accoppiatore su cron:', err)
      );

      results.push({ userId: session.userId, status: 'ok' });
    } catch (error) {
      console.error(`Errore cron per userId ${session.userId}:`, error);
      results.push({ userId: session.userId, status: 'error' });
    }
  }

  // Lo stato HTTP dice se la richiesta è stata gestita, NON se i dati sono sani.
  // Confondere le due cose ha ucciso lo scheduler due volte.
  //
  // La seconda è istruttiva: il refresh del token Volvo è fallito, la raccolta
  // era ferma da 97 minuti, questo endpoint ha risposto 503 — e cron-job.org,
  // che legge 503 come "endpoint rotto", ha disabilitato il job. Un intoppo di
  // autenticazione che si sarebbe risolto da solo al login successivo è
  // diventato un blackout di diciassette ore. La prima volta avevo alzato la
  // soglia; non serviva a niente, perché il problema non era quando segnalare
  // ma a chi, e attraverso cosa.
  //
  // Da qui in poi la risposta è sempre 200 se la richiesta è autenticata e
  // gestita. La salute viaggia nel corpo, in `healthy` e `alert`, e ad allarmare
  // pensa chi può farlo senza spegnersi: il workflow GitHub, che fallisce il
  // passo e manda una email ma resta pianificato, e l'avviso in dashboard.
  const failed = results.filter(r => r.status === 'error' || r.status === 'refresh_failed');

  // Solo i campioni scritti dal cron: quelli con source 'dashboard' li produce
  // chi sta guardando, e contarli qui maschererebbe proprio il guasto da
  // segnalare — con la PWA aperta su un tab, l'allarme non partirebbe mai.
  // Stessa scelta, e stessa ragione, di RaccoltaFerma.tsx.
  const ultimoSnapshot = await prisma.batterySnapshot.findFirst({
    where: { source: 'cron' },
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
  const allarme = nessunaSessione
    ? 'nessuna_sessione'
    : guastoPersistente
      ? 'raccolta_ferma'
      : null;

  if (failed.length > 0) {
    console.error(
      `Cron: ${failed.length} sessioni fallite su ${results.length}, ` +
        `ultimo dato ${fermoDaMin} min fa, allarme=${allarme ?? 'no'}`
    );
  }

  // Sempre 200: vedi sopra. Chi legge questo corpo sa cosa fare dell'allarme,
  // uno scheduler che vede un 5xx sa solo smettere di chiamare.
  return NextResponse.json({
    healthy: allarme === null,
    alert: allarme,
    processed: results.length,
    failed: failed.length,
    lastDataMinutesAgo: fermoDaMin === Infinity ? null : fermoDaMin,
    results,
    timestamp: new Date().toISOString(),
  });
  } catch (error) {
    // Senza questo catch un errore Prisma a metà handler uscirebbe come 500 di
    // Vercel: per lo scheduler è indistinguibile dal 503 che lo faceva
    // disabilitare. Autenticato e gestito significa 200, sempre.
    console.error('Cron: errore non gestito:', error);
    return NextResponse.json({
      healthy: false,
      alert: 'errore_interno',
      processed: 0,
      failed: 0,
      lastDataMinutesAgo: null,
      results: [],
      timestamp: new Date().toISOString(),
    });
  } finally {
    await prisma.$disconnect();
  }
}