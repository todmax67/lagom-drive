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
 * Nemmeno il PLATEAU dell'odometro serve, e la seconda versione è caduta su
 * questo: sulla CMA l'odometro resta fermo per tutta la marcia, quindi il
 * plateau alla giunzione dura sosta PIÙ il viaggio successivo — misurava la
 * durata della tratta seguente, non la fermata (il minimo del plateau
 * coincideva con l'orario di chiusura del viaggio prima in 75 casi su 75).
 *
 * Quel che si può misurare davvero è la RIPARTENZA: la sosta finisce al primo
 * segno di movimento dopo la chiusura del ritaglio, quale che sia il testimone
 * che lo tradisce per primo —
 * - la CARICA che scende: l'auto ha ricominciato a consumare. È il testimone
 *   che parla sulla CMA, dove l'odometro tace per tutta la marcia;
 * - l'ODOMETRO che avanza: sulla SEA scatta a ogni poll, e dice "non mi sono
 *   mai fermato" quando la carica intera è troppo grossolana per accorgersene
 *   (su tre chilometri il punto percentuale può non muoversi per sei minuti).
 *
 * Serve tenerli entrambi: da solo, il primo perde le guide della EX30, il
 * secondo non vede niente sulla XC40. E se in mezzo c'è una ricarica nessuno
 * dei due parla — la carica sale, l'odometro tace — quindi i due ritagli
 * restano due guide, che è la risposta giusta.
 */

// Oltre questa sosta i due ritagli sono due guide
const SOSTA_MAX_MS = 5 * 60 * 1000;
// Oltre questo, cercare la ripartenza non ha senso: è comunque un'altra guida
const RICERCA_MAX_MS = 60 * 60 * 1000;

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

  // Una sola lettura dei campioni sull'arco dei viaggi: la ripartenza si
  // cerca in memoria, non con una interrogazione per giunzione.
  const daMs = viaggi[0].startedAt.getTime();
  const aMs = Math.max(
    ...viaggi.map(v => (v.endedAt ?? v.startedAt).getTime())
  );
  const campioni = await prisma.batterySnapshot
    .findMany({
      where: {
        userId,
        createdAt: { gte: new Date(daMs), lte: new Date(aMs + RICERCA_MAX_MS) },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, level: true, odometer: true },
    })
    .catch(() => [] as { createdAt: Date; level: number; odometer: number | null }[]);

  /**
   * Quanto è durata la sosta fra la chiusura di un ritaglio e la ripartenza:
   * il primo campione, dopo la chiusura, che porta un segno di movimento —
   * carica più bassa OPPURE odometro più avanti. null quando la ripartenza
   * non si osserva (auto in carica, campioni assenti): nel dubbio i due
   * ritagli restano due guide.
   *
   * La risoluzione è quella del polling (1-2 minuti in guida, di più da
   * fermi): la soglia dei cinque minuti va letta con quella grana.
   */
  const sostaAllaGiunzione = (
    chiusura: Date,
    odoGiunzione: number,
    limite: Date
  ): number | null => {
    const t0 = chiusura.getTime();
    const fine = limite.getTime() + RICERCA_MAX_MS;
    let livelloArrivo: number | null = null;
    for (const c of campioni) {
      const t = c.createdAt.getTime();
      if (t <= t0) {
        livelloArrivo = c.level; // l'ultimo fino alla chiusura, compresa
        continue;
      }
      if (t > fine) break;
      const consuma = livelloArrivo !== null && c.level < livelloArrivo;
      const avanza = c.odometer !== null && c.odometer > odoGiunzione;
      if (consuma || avanza) return t - t0;
    }
    return null;
  };

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
      prec.endOdometer === nuovo.startOdometer &&
      prec.endedAt !== null
    ) {
      // Senza sessioni da confrontare: la sosta letta dalla carica. La
      // continuità dell'odometro resta solo come guardia — da sola non prova
      // niente, perché il rilevatore la produce per costruzione.
      const sosta = sostaAllaGiunzione(
        prec.endedAt,
        prec.endOdometer,
        nuovo.endedAt ?? prec.endedAt
      );
      unisci = sosta !== null && sosta < SOSTA_MAX_MS;
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
