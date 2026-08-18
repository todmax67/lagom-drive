/**
 * L'accoppiatore: aggancia i campioni OBD ai viaggi del rilevatore cloud
 * (docs/progetto-obd.md §4.2). Il rilevatore NON si tocca: questo strato
 * legge i suoi viaggi e vi appoggia accanto una riga di TripEnrichment,
 * interamente ricalcolabile — l'upsert è l'idempotenza.
 *
 * Due punti di innesco, con ruoli diversi:
 * - l'ingest, quando arriva un lotto: ricalcola i viaggi che si sovrappongono
 *   al lotto, anche se già arricchiti (i lotti tardivi rifanno il conto);
 * - il polling, quando un viaggio è appena nato: arricchisce i viaggi recenti
 *   che una riga non ce l'hanno ancora (i campioni erano già in tabella).
 */

import { prisma } from '@/lib/prisma';
import { calcolaArricchimento } from '@/lib/accoppiatore-calcolo';

// I tempi dei viaggi sono ricostruiti a posteriori dai plateau dell'odometro:
// la finestra di aggancio deve perdonare quello scarto. Venti minuti per lato,
// poi i campioni con velocità > 0 rifiniscono.
const MARGINE_MS = 20 * 60 * 1000;

// Quanto indietro guardare per i viaggi appena nati senza arricchimento
const FINESTRA_RECENTI_MS = 48 * 60 * 60 * 1000;

async function arricchisci(viaggio: {
  id: string;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
}): Promise<void> {
  if (!viaggio.endedAt) return;

  // La finestra parte larga ma non invade i viaggi confinanti: con lo schema
  // tipico andata-sosta-ritorno, i margini dei due viaggi si sovrappongono e
  // ognuno si prenderebbe campioni dell'altro. Il confine col vicino vince
  // sul margine.
  const [precedente, successivo] = await Promise.all([
    prisma.trip.findFirst({
      where: { userId: viaggio.userId, isComplete: true, endedAt: { lte: viaggio.startedAt }, id: { not: viaggio.id } },
      orderBy: { endedAt: 'desc' },
      select: { endedAt: true },
    }),
    prisma.trip.findFirst({
      where: { userId: viaggio.userId, isComplete: true, startedAt: { gte: viaggio.endedAt }, id: { not: viaggio.id } },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true },
    }),
  ]);

  const inizioFinestra = new Date(
    Math.max(
      viaggio.startedAt.getTime() - MARGINE_MS,
      precedente?.endedAt?.getTime() ?? 0
    )
  );
  const fineFinestra = new Date(
    Math.min(
      viaggio.endedAt.getTime() + MARGINE_MS,
      successivo?.startedAt.getTime() ?? Infinity
    )
  );

  const campioni = await prisma.obdSample.findMany({
    where: {
      userId: viaggio.userId,
      recordedAt: { gte: inizioFinestra, lte: fineFinestra },
    },
    orderBy: { recordedAt: 'asc' },
    select: { recordedAt: true, speedKmh: true, socDisplay: true, packPowerKw: true, sessionId: true },
  });

  const esito = calcolaArricchimento(
    { startedAt: viaggio.startedAt, endedAt: viaggio.endedAt },
    campioni
  );

  // Nessun campione utile: nessuna riga. Un viaggio senza OBD è il caso
  // normale, non un arricchimento vuoto da conservare.
  if (!esito) return;

  // La sessione dominante fra i campioni agganciati: se i campioni di questa
  // finestra vengono quasi tutti dalla stessa sessione, il viaggio e' un
  // ritaglio di quella guida — e la UI puo' ricomporre i ritagli contigui.
  const conteggi = new Map<string, number>();
  for (const c of campioni) {
    if (c.sessionId) conteggi.set(c.sessionId, (conteggi.get(c.sessionId) ?? 0) + 1);
  }
  let sessioneDominante: string | null = null;
  let massimo = 0;
  for (const [id, n] of conteggi) {
    if (n > massimo) { massimo = n; sessioneDominante = id; }
  }
  // Dominante davvero: piu' della meta' dei campioni agganciati
  if (massimo <= campioni.length / 2) sessioneDominante = null;

  const dati = {
    userId: viaggio.userId,
    sessionId: sessioneDominante,
    sampleCount: esito.sampleCount,
    coverage: esito.coverage,
    gaps: esito.gaps,
    movingStart: esito.movingStart,
    movingEnd: esito.movingEnd,
    distanceObdKm: esito.distanceObdKm,
    maxSpeedKmh: esito.maxSpeedKmh,
    socStartObd: esito.socStartObd,
    socEndObd: esito.socEndObd,
    energyGrossKwh: esito.energyGrossKwh,
    energyRegenGrossKwh: esito.energyRegenGrossKwh,
    powerCoverage: esito.powerCoverage,
  };

  await prisma.tripEnrichment.upsert({
    where: { tripId: viaggio.id },
    update: dati,
    create: { tripId: viaggio.id, ...dati },
  });
}

/**
 * Per l'ingest: ricalcola i viaggi che si sovrappongono all'intervallo del
 * lotto appena scritto. Anche quelli già arricchiti: il lotto potrebbe aver
 * riempito un buco, e un derivato è solo l'ultima versione del grezzo.
 */
export async function arricchisciViaggiNellaFinestra(
  userId: string,
  da: Date,
  a: Date
): Promise<void> {
  const viaggi = await prisma.trip.findMany({
    where: {
      userId,
      isComplete: true,
      endedAt: { not: null, gte: new Date(da.getTime() - MARGINE_MS) },
      startedAt: { lte: new Date(a.getTime() + MARGINE_MS) },
    },
    select: { id: true, userId: true, startedAt: true, endedAt: true },
  });
  for (const v of viaggi) {
    await arricchisci(v).catch(err =>
      console.error(`Accoppiatore: errore sul viaggio ${v.id}:`, err)
    );
  }
}

/**
 * Per il polling: i viaggi recenti che non hanno ancora una riga. Il viaggio
 * nasce minuti dopo l'arrivo dei campioni (il rilevatore è retrospettivo),
 * quindi l'ingest non può averlo visto.
 */
export async function arricchisciViaggiRecenti(userId: string): Promise<void> {
  const viaggi = await prisma.trip.findMany({
    where: {
      userId,
      isComplete: true,
      endedAt: { not: null, gte: new Date(Date.now() - FINESTRA_RECENTI_MS) },
    },
    select: { id: true, userId: true, startedAt: true, endedAt: true },
  });
  if (viaggi.length === 0) return;

  const esistenti = await prisma.tripEnrichment.findMany({
    where: { tripId: { in: viaggi.map(v => v.id) } },
    select: { tripId: true },
  });
  const gia = new Set(esistenti.map(e => e.tripId));
  const daArricchire = viaggi.filter(x => !gia.has(x.id));
  if (daArricchire.length === 0) return;

  // Il caso normale è il viaggio solo-cloud, senza dongle: non produce mai una
  // riga, e senza questa sonda verrebbe riesaminato a ogni poll per 48 ore.
  // Una sola query sull'inviluppo dei candidati: vuota implica vuoto per tutti,
  // perché ogni finestra per-viaggio è contenuta nell'inviluppo.
  const tempi = daArricchire.flatMap(v => [v.startedAt.getTime(), v.endedAt!.getTime()]);
  const unCampione = await prisma.obdSample.findFirst({
    where: {
      userId,
      recordedAt: {
        gte: new Date(Math.min(...tempi) - MARGINE_MS),
        lte: new Date(Math.max(...tempi) + MARGINE_MS),
      },
    },
    select: { id: true },
  });
  if (!unCampione) return;

  for (const v of daArricchire) {
    await arricchisci(v).catch(err =>
      console.error(`Accoppiatore: errore sul viaggio ${v.id}:`, err)
    );

    // Il vicino precedente era stato arricchito quando questo viaggio non
    // esisteva ancora: il rilevatore è retrospettivo, e la sua finestra si è
    // presa i primi minuti di QUESTA guida senza un confine a fermarla. Ora
    // che il confine esiste, il ricalcolo glieli restituisce — l'idempotenza
    // dell'upsert rende il ritocco gratuito.
    const precedente = await prisma.trip.findFirst({
      where: {
        userId,
        isComplete: true,
        endedAt: { lte: v.startedAt },
        id: { not: v.id },
      },
      orderBy: { endedAt: 'desc' },
      select: { id: true, userId: true, startedAt: true, endedAt: true },
    });
    if (precedente) {
      await arricchisci(precedente).catch(err =>
        console.error(`Accoppiatore: errore sul vicino ${precedente.id}:`, err)
      );
    }
  }
}
