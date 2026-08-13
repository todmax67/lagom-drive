/**
 * PID standard OBD-II effettivamente supportati dalla XC40 MY2023.
 *
 * Ricavati interrogando l'auto: 0100 -> 0120 -> 0140 restituiscono le maschere
 * dei PID disponibili, e di tutta la specifica questa vettura ne risponde dieci.
 * Le formule sono quelle standard, verificate contro valori noti da altre fonti:
 * il SOC coincide con quello dell'API Volvo e la temperatura ambiente con
 * quella letta da Car Scanner.
 *
 * Restano fuori SoH, tensione e corrente di pacco: stanno dietro il servizio
 * UDS 22 sulle centraline BECM e IEM, con DID proprietari non pubblici.
 */

export type CampoObd =
  | 'socDisplay'
  | 'speedKmh'
  | 'batt12vVoltage'
  | 'ambientC';

export type DefinizionePid = {
  comando: string;
  campo: CampoObd;
  etichetta: string;
  unita: string;
  /** Riceve i soli byte dati, senza header, PCI, service e PID */
  converti: (dati: number[]) => number | null;
};

export const PID_SUPPORTATI: DefinizionePid[] = [
  {
    comando: '015B',
    campo: 'socDisplay',
    etichetta: 'Carica',
    unita: '%',
    // Un solo byte su 255: risoluzione 0.39%, contro l'1% dell'API Volvo
    converti: d => (d.length >= 1 ? (d[0] * 100) / 255 : null),
  },
  {
    comando: '010D',
    campo: 'speedKmh',
    etichetta: 'Velocità',
    unita: 'km/h',
    converti: d => (d.length >= 1 ? d[0] : null),
  },
  {
    comando: '0142',
    campo: 'batt12vVoltage',
    etichetta: 'Batteria 12V',
    unita: 'V',
    converti: d => (d.length >= 2 ? (d[0] * 256 + d[1]) / 1000 : null),
  },
  {
    comando: '0146',
    campo: 'ambientC',
    etichetta: 'Ambiente',
    unita: '°C',
    converti: d => (d.length >= 1 ? d[0] - 40 : null),
  },
];

/**
 * Estrae i byte dati da una risposta dell'ELM327 con le intestazioni attive.
 *
 * Formato: 8 caratteri di header a 29 bit, poi il byte PCI con la lunghezza,
 * poi i byte utili. Si verifica che service e PID corrispondano alla richiesta,
 * altrimenti una risposta arrivata fuori ordine verrebbe attribuita al comando
 * sbagliato — e un numero plausibile ma di un'altra grandezza è peggio di
 * nessun numero.
 */
export function estraiDati(risposta: string, comando: string): number[] | null {
  const pulita = risposta.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();

  // header (8) + PCI (2) + service (2) + pid (2)
  if (pulita.length < 14) return null;

  const lunghezza = parseInt(pulita.slice(8, 10), 16);
  // Oltre 7 non è un frame singolo: i PID qui usati stanno tutti in un frame
  if (!Number.isFinite(lunghezza) || lunghezza < 3 || lunghezza > 7) return null;
  if (pulita.length < 10 + lunghezza * 2) return null;

  const byte: number[] = [];
  for (let i = 0; i < lunghezza; i++) {
    byte.push(parseInt(pulita.slice(10 + i * 2, 12 + i * 2), 16));
  }

  const servizioAtteso = parseInt(comando.slice(0, 2), 16) + 0x40;
  const pidAtteso = parseInt(comando.slice(2, 4), 16);
  if (byte[0] !== servizioAtteso || byte[1] !== pidAtteso) return null;

  return byte.slice(2);
}

export type Campione = Partial<Record<CampoObd, number>> & { recordedAt: string };

/** Legge in sequenza tutti i PID: l'ELM327 non accetta richieste sovrapposte. */
export async function leggiCampione(
  invia: (comando: string) => Promise<string>
): Promise<{ campione: Campione; errori: string[] }> {
  const campione: Campione = { recordedAt: new Date().toISOString() };
  const errori: string[] = [];

  for (const pid of PID_SUPPORTATI) {
    try {
      const risposta = await invia(pid.comando);
      const dati = estraiDati(risposta, pid.comando);
      if (!dati) {
        errori.push(`${pid.comando}: risposta non interpretabile (${risposta.slice(0, 40)})`);
        continue;
      }
      const valore = pid.converti(dati);
      if (valore !== null && Number.isFinite(valore)) {
        campione[pid.campo] = valore;
      }
    } catch (err) {
      errori.push(`${pid.comando}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { campione, errori };
}
