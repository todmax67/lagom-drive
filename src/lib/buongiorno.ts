/**
 * La sonda del buongiorno (docs/progetto-obd.md §5.1): una lettura mattutina
 * unica, ad auto riposata, in meno di un minuto. Chiude il registro del giorno
 * prima e alimenta la card in Oggi e la futura pagina Salute.
 *
 * L'ordine è parte della misura. La lettura sveglia il paziente: le centraline
 * si accendono e il DC-DC comincia a sostenere la 12V, quindi il valore buono
 * della 12V è il PRIMO dopo il risveglio. La bussola dice "prima il CEM", ma
 * il DID confermato della 12V (22F442) vive sul BECM: lo spirito della regola
 * si rispetta mettendo 22F442 in testa alla lista del BECM, e il CEM — che
 * oggi porta solo candidati grezzi — viene dopo.
 *
 * A differenza della Sonda esplorativa, il buongiorno SALVA: il campione parte
 * verso /api/obd/ingest come quelli del Registratore, ed è quello che la card
 * in Oggi andrà a leggere. Una sonda che non salva è un rituale sprecato.
 */

import { leggiCampione, type Campione } from '@/lib/obd-pids';
import {
  CENTRALINE,
  leggiDidVolvo,
  leggiDid,
  sequenzaPreparazione,
  SEQUENZA_RIPRISTINO,
  estraiPayload,
} from '@/lib/volvo-uds';

const CENTRALINA_CEM = CENTRALINE[3];

export type EsitoBuongiorno = {
  campione: Campione;
  /** Sintesi per la UI del rituale */
  batt12v: number | null;
  packVoltage: number | null;
  socDisplay: number | null;
  sohGrezzo: string | null;
  errori: string[];
};

export async function eseguiBuongiorno(
  invia: (comando: string) => Promise<string>,
  onPasso?: (testo: string) => void
): Promise<EsitoBuongiorno> {
  const errori: string[] = [];

  // 1. BECM per primo, con la 12V in testa alla lista: il primo valore dopo
  //    il risveglio è quello buono, e ogni comando successivo lo sporca.
  onPasso?.('Batteria di trazione…');
  let campi: Record<string, number> = {};
  let grezzi: Record<string, string> = {};
  try {
    ({ campi, grezzi } = await leggiDidVolvo(invia));
  } catch (err) {
    errori.push(`BECM: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Il SOC dal PID standard, dopo il ripristino dell'header fatto da
  //    leggiDidVolvo. Il primo comando dopo il ripristino può andare a vuoto
  //    come il primo DID dopo la preparazione: qui la lettura è una sola,
  //    quindi il retry se lo merita anche lo standard.
  onPasso?.('Stato di carica…');
  let { campione: standard, errori: erroriStandard } = await leggiCampione(invia, false);
  if (standard.socDisplay === undefined) {
    ({ campione: standard, errori: erroriStandard } = await leggiCampione(invia, false));
  }
  errori.push(...erroriStandard);

  // 3. Il CEM: quattro candidati ancora grezzi (fra cui il probabile SoC della
  //    12V). Le chiavi si prefissano con l'indirizzo della centralina, perché
  //    224028 esiste sia sul BECM che sul CEM e sono due grandezze diverse.
  onPasso?.('Batteria 12V (CEM)…');
  try {
    for (const cmd of sequenzaPreparazione(CENTRALINA_CEM.ecu)) {
      await invia(cmd).catch(() => {});
    }
    for (const did of CENTRALINA_CEM.did) {
      // Stesso retry del BECM: il primo DID dopo la preparazione fallisce
      // quasi sempre (trappola 5.3.2), e qui la lettura e' una sola.
      const risposta = await leggiDid(invia, did).catch(() => '');
      const payload = estraiPayload(risposta, did);
      if (payload) {
        grezzi[`${CENTRALINA_CEM.ecu}${did}`] = payload
          .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
          .join('');
      }
    }
  } catch (err) {
    errori.push(`CEM: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const cmd of SEQUENZA_RIPRISTINO) await invia(cmd).catch(() => {});
  }

  const campione: Campione = {
    ...standard,
    ...campi,
    recordedAt: new Date().toISOString(),
  };
  if (Object.keys(grezzi).length) campione.didRaw = grezzi;

  // I catch a monte incassano tutto: i buchi si dichiarano qui, per campo,
  // o il rituale mostrerebbe tessere n/d senza dire perche'.
  if (campi.batt12vVoltage === undefined) errori.push('12V non letta');
  if (campi.packVoltage === undefined) errori.push('tensione di pacco non letta');
  if (standard.socDisplay === undefined) errori.push('carica non letta');

  return {
    campione,
    batt12v: campi.batt12vVoltage ?? null,
    packVoltage: campi.packVoltage ?? null,
    socDisplay: standard.socDisplay ?? null,
    sohGrezzo: grezzi['22496D'] ?? null,
    errori,
  };
}
