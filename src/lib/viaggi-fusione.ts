/**
 * Il giudizio "è la stessa guida", condiviso fra la lista dei viaggi e gli
 * aggregati: due superfici, un solo metro.
 *
 * Il rilevatore ricostruisce i viaggi dai PLATEAU dell'odometro: parte da un
 * salto e guarda indietro fino alla sosta. Regge finché l'auto tace mentre
 * cammina — la XC40 (CMA) aggiorna l'odometro solo all'arrivo — ma si sbriciola
 * quando la telemetria è viva: la EX30 (SEA) lo aggiorna a ogni poll, quindi
 * ogni intervallo di raccolta sembra un viaggio intero. Una guida di 35 km è
 * arrivata in undici pezzi contigui.
 *
 * Due prove di continuità, in ordine di forza:
 * - la SESSIONE OBD: due ritagli con la stessa sessione sono la stessa guida,
 *   punto (par. 5.2). E due sessioni DIVERSE sono due guide diverse, per
 *   quanto vicine nel tempo;
 * - l'ODOMETRO: senza dongle resta il chilometraggio, che non mente. Se il
 *   viaggio successivo parte esattamente dove il precedente è finito, e in
 *   mezzo non c'è che una pausa da semaforo, la strada è stata una sola.
 *
 * Il rilevatore non si tocca: i ritagli restano in tabella, è la lettura che
 * li ricompone.
 */

export type ViaggioFondibile = {
  inizioMs: number;
  fineMs: number | null;
  startOdometer: number | null;
  endOdometer: number | null;
  sessionId: string | null;
};

// Oltre questo stacco fra la fine di un ritaglio e l'inizio del successivo
// non è più una pausa: è un'altra partenza
export const STACCO_MAX_MS = 3 * 60 * 1000;

/**
 * `nuovo` segue `prec` nel tempo. Restituisce la prova che li unisce, o null
 * se sono due guide distinte.
 */
export function stessaGuida(
  nuovo: ViaggioFondibile,
  prec: ViaggioFondibile
): 'sessione' | 'odometro' | null {
  if (prec.fineMs === null) return null;
  const stacco = Math.abs(nuovo.inizioMs - prec.fineMs);
  if (stacco >= STACCO_MAX_MS) return null;

  // Due sessioni OBD diverse sono due guide diverse: la prova più forte vale
  // anche al contrario, e vince sulla continuità dell'odometro. Quando invece
  // uno solo dei due ritagli è stato registrato (dongle agganciato a metà
  // strada), decide l'odometro.
  if (nuovo.sessionId !== null && prec.sessionId !== null) {
    return nuovo.sessionId === prec.sessionId ? 'sessione' : null;
  }

  // Zero km percorsi non è una prova di continuità: sarebbe vera per due
  // soste qualunque. Serve che l'odometro esista e combaci.
  if (
    prec.endOdometer !== null &&
    nuovo.startOdometer !== null &&
    nuovo.startOdometer === prec.endOdometer
  ) {
    return 'odometro';
  }

  return null;
}
