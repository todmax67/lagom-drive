import { prisma } from '@/lib/prisma';

/**
 * Il giudizio "è la stessa guida", condiviso fra la lista viaggi e gli
 * aggregati: due superfici, un metro solo.
 *
 * Il rilevatore ricostruisce i viaggi dai PLATEAU dell'odometro: regge sulla
 * XC40 (CMA), che l'odometro lo aggiorna solo all'arrivo, ma si sbriciola
 * sulla EX30 (SEA) che lo aggiorna a ogni poll — una guida di 35 km arrivata
 * in undici ritagli contigui, ognuno troppo corto per meritare un consumo.
 *
 * ATTENZIONE alla trappola, pagata una volta: la contiguità dei numeri NON è
 * una prova. Il rilevatore scrive `startOdometer = odometro del campione
 * prima del salto`, che è per costruzione l'`endOdometer` del viaggio
 * precedente, e retrodata `startedAt` allo snapshot su cui il viaggio
 * precedente ha chiuso. Quindi "odometri che combaciano" e "stacco di zero
 * secondi" sono VERI PER OGNI COPPIA CONSECUTIVA, guide distinte comprese:
 * fondere su quelli incollava insieme una spesa e il ritorno a casa, e
 * perfino due guide separate da una ricarica.
 *
 * La prova vera è una misura: quanto è durato il PLATEAU dell'odometro alla
 * giunzione, cioè quanto l'auto è stata davvero ferma fra un ritaglio e
 * l'altro. Pochi minuti sono un semaforo; mezz'ora è un'altra partenza.
 */

// Oltre questa sosta alla giunzione i due ritagli sono due guide. Sotto, si
// può ancora essere in coda a un semaforo: a passo d'uomo un chilometro di
// odometro può non scattare per qualche minuto.
const SOSTA_MAX_MS = 5 * 60 * 1000;

// La sessione OBD porta i suoi tempi veri (non retrodatati): lì lo stacco
// misura qualcosa, ed è la stessa soglia della ricomposizione dei ritagli.
const STACCO_SESSIONE_MS = 3 * 60 * 1000;

export type ViaggioFondibile = {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  startOdometer: number | null;
  endOdometer: number | null;
  sessionId: string | null;
};

/**
 * Marchia ogni viaggio con l'id della GUIDA cui appartiene: i ritagli di una
 * stessa strada condividono il marchio (che è l'id del loro primo ritaglio).
 *
 * `viaggi` va passata in ordine CRESCENTE di partenza.
 */
export async function marchiaGuide(
  userId: string,
  viaggi: ViaggioFondibile[]
): Promise<Map<string, string>> {
  const marchio = new Map<string, string>();
  if (viaggi.length === 0) return marchio;

  // Le giunzioni candidate: coppie consecutive con l'odometro che si tiene.
  // Un buco nell'odometro significa una strada che nessuno ha registrato, e
  // due guide separate da un viaggio mancante non sono la stessa guida.
  const giunzioni: number[] = [];
  for (let i = 1; i < viaggi.length; i++) {
    const prec = viaggi[i - 1];
    const nuovo = viaggi[i];
    if (
      prec.endOdometer !== null &&
      nuovo.startOdometer !== null &&
      prec.endOdometer === nuovo.startOdometer
    ) {
      giunzioni.push(prec.endOdometer);
    }
  }

  // Quanto è rimasto fermo l'odometro su ciascun valore di giunzione: una
  // sola interrogazione per tutte. L'odometro cresce e basta, quindi un
  // valore non si ripresenta mai e il plateau non è ambiguo.
  const soste = new Map<number, number>();
  if (giunzioni.length > 0) {
    const plateau = await prisma.batterySnapshot
      .groupBy({
        by: ['odometer'],
        where: { userId, odometer: { in: [...new Set(giunzioni)] } },
        _min: { createdAt: true },
        _max: { createdAt: true },
      })
      .catch(() => []);
    for (const p of plateau) {
      if (p.odometer === null || !p._min.createdAt || !p._max.createdAt) continue;
      soste.set(p.odometer, p._max.createdAt.getTime() - p._min.createdAt.getTime());
    }
  }

  let guidaId = viaggi[0].id;
  // Le sessioni OBD viste finora nella guida: il divieto fra sessioni diverse
  // deve valere sull'INTERA catena, non sulla sola coppia adiacente — un
  // ritaglio senza sessione in mezzo non deve fare da ponte fra due guide
  // registrate separatamente.
  let sessioniGuida = new Set<string>();
  if (viaggi[0].sessionId) sessioniGuida.add(viaggi[0].sessionId);
  marchio.set(viaggi[0].id, guidaId);

  for (let i = 1; i < viaggi.length; i++) {
    const prec = viaggi[i - 1];
    const nuovo = viaggi[i];
    let unisci = false;

    if (nuovo.sessionId !== null && sessioniGuida.size > 0) {
      // Prova forte: la sessione OBD. Vale in entrambi i versi — stessa
      // sessione unisce, sessione diversa separa, e non c'è appello.
      unisci =
        sessioniGuida.has(nuovo.sessionId) &&
        prec.endedAt !== null &&
        Math.abs(nuovo.startedAt.getTime() - prec.endedAt.getTime()) < STACCO_SESSIONE_MS;
    } else if (
      prec.endOdometer !== null &&
      nuovo.startOdometer !== null &&
      prec.endOdometer === nuovo.startOdometer
    ) {
      // Senza sessioni da confrontare: la sosta misurata alla giunzione
      const sosta = soste.get(prec.endOdometer);
      unisci = sosta !== undefined && sosta < SOSTA_MAX_MS;
    }

    if (!unisci) {
      guidaId = nuovo.id;
      sessioniGuida = new Set();
    }
    if (nuovo.sessionId) sessioniGuida.add(nuovo.sessionId);
    marchio.set(nuovo.id, guidaId);
  }

  return marchio;
}
