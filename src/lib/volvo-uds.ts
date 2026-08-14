/**
 * Interrogazione delle centraline Volvo tramite il servizio UDS 22.
 *
 * I DID della piattaforma CMA non sono pubblici. Indirizzi e comandi qui sotto
 * sono stati ricavati dal log di Car Scanner, che li conosce: nel suo registro
 * i comandi al dongle compaiono in chiaro.
 *
 * Volvo NON usa l'indirizzamento standard 18DA<target>F1. Servono cinque
 * impostazioni prima di ogni interrogazione, e la priorità va poi rimessa a
 * 0x18 o anche i PID standard smettono di rispondere.
 */

// La priorità di default. Volvo usa 0x1D per le sue richieste diagnostiche.
export const PRIORITA_STANDARD = '18';
export const PRIORITA_VOLVO = '1D';

/**
 * Il filtro di ricezione si ricava dall'indirizzo della centralina: si
 * raddoppiano i sedici bit bassi, si somma 0xC000 e si incastona fra 0x1E000000
 * e 0xE80. Verificato su tutte e 28 le centraline viste nel log, quindi si
 * calcola invece di tenere una tabella che andrebbe mantenuta a mano.
 */
export function filtroRicezione(ecu: string): string {
  const suffisso = parseInt(ecu, 16) & 0xffff;
  const x = ((suffisso * 2 + 0xc000) & 0xffff) >>> 0;
  return ((0x10000000 | (x << 12) | 0xe80) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export type Centralina = { ecu: string; nome: string; did: string[] };

export const CENTRALINE: Centralina[] = [
  {
    ecu: 'D01635',
    nome: 'Batteria di trazione (BECM)',
    did: [
      '224028', '224802', '224803', '224804', '224857', '224858', '224859',
      '22489C', '22489E', '22496D', '22497C', '22498B', '224990', '224A58',
      '224A88', '22F186', '22F442',
    ],
  },
  {
    ecu: 'D01630',
    nome: 'Gestione alta tensione',
    did: ['22EE30', '22EE36', '22EE37', '22EE38', '22EE46', '22EE47', '22EE48', '22EE62', '22EE6F'],
  },
  {
    ecu: 'D01602',
    nome: 'Termica e climatizzazione',
    did: ['220303', '220329', '22032B', '22032F', '220331', '22EEA6', '22EEA7', '22EEB3'],
  },
  {
    ecu: 'D01A01',
    nome: 'Batteria 12V (CEM)',
    did: ['224028', '2240CD', '224025', '224090'],
  },
];

/** Comandi di preparazione, nell'ordine in cui Car Scanner li invia. */
export function sequenzaPreparazione(ecu: string): string[] {
  return [
    `ATCP${PRIORITA_VOLVO}`,
    `ATSH${ecu}`,
    `ATCRA${filtroRicezione(ecu)}`,
    `ATFCSH1D${ecu}`,
    'ATFCSD300000',
    'ATFCSM1',
  ];
}

/**
 * Da rieseguire sempre a fine interrogazione: lasciando lo stato Volvo attivo,
 * i PID standard rispondono NO DATA. È già successo due volte.
 *
 * La seconda è costata i PID di due viaggi interi. Il ripristino rimetteva
 * priorità e ricezione ma NON l'header di trasmissione: l'init non lo imposta
 * mai (dopo ATZ vale il default del protocollo 7, 18DB33F1), quindi il primo
 * ATSH D01635 restava attivo per sempre e ogni 015B successivo era indirizzato
 * alla centralina della batteria, che il servizio 01 lo ignora. ATSHDB33F1 è
 * esattamente ciò che Car Scanner manda nel suo log per tornare allo standard.
 */
export const SEQUENZA_RIPRISTINO = [
  'ATFCSM0',
  'ATAR',
  `ATCP${PRIORITA_STANDARD}`,
  'ATSHDB33F1',
];

/**
 * Estrae i byte dati da una risposta positiva. Il servizio 22 risponde con 62
 * seguito dal DID richiesto: verificarlo evita di attribuire a un DID la
 * risposta di un altro, che è il modo in cui nascono i numeri plausibili e falsi.
 */
export function estraiPayload(risposta: string, did: string): number[] | null {
  const pulita = risposta.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const atteso = '62' + did.slice(2);
  const i = pulita.indexOf(atteso);
  if (i < 0) return null;
  const hex = pulita.slice(i + atteso.length);
  const byte: number[] = [];
  for (let k = 0; k + 2 <= hex.length; k += 2) byte.push(parseInt(hex.slice(k, k + 2), 16));
  return byte.length ? byte : null;
}

/** Risposta negativa: 7F <servizio> <codice>. Dice che il DID non esiste. */
export function codiceNegativo(risposta: string): number | null {
  const p = risposta.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const i = p.indexOf('7F22');
  return i < 0 ? null : parseInt(p.slice(i + 4, i + 6), 16);
}

export type Lettura = {
  did: string;
  grezza: string;
  payload: number[] | null;
  negativo: number | null;
  letture: { formula: string; valore: number }[];
};

/**
 * Interpretazioni plausibili dei primi byte. Non è una decodifica: serve a
 * riconoscere una grandezza dal suo ordine di grandezza, confrontandola con
 * ciò che si sa da altre fonti. La formula vera va confermata, non dedotta.
 */
function interpreta(b: number[]): { formula: string; valore: number }[] {
  const out: { formula: string; valore: number }[] = [];
  if (b.length >= 1) out.push({ formula: 'A', valore: b[0] }, { formula: 'A−40', valore: b[0] - 40 });
  if (b.length >= 2) {
    const u = b[0] * 256 + b[1];
    const s = u > 0x7fff ? u - 0x10000 : u;
    out.push(
      { formula: 'AB', valore: u },
      { formula: 'AB/10', valore: u / 10 },
      { formula: 'AB/100', valore: u / 100 },
      { formula: 'AB con segno', valore: s }
    );
  }
  return out;
}

/**
 * Interroga un DID ritentando una volta se la risposta non si lascia estrarre.
 *
 * Serve soprattutto al primo DID dopo la preparazione: su due viaggi registrati
 * il primo della lista è fallito 208 volte su 208, il secondo ~1 su 5, dal
 * settimo in poi mai — il canale ha bisogno di un colpo per assestarsi dopo i
 * sei comandi AT, e senza retry quel colpo se lo prende sempre lo stesso DID.
 */
async function leggiDid(
  invia: (comando: string) => Promise<string>,
  did: string
): Promise<string> {
  const prima = await invia(did).catch(e => `ERRORE ${e instanceof Error ? e.message : e}`);
  if (estraiPayload(prima, did) || codiceNegativo(prima) !== null) return prima;
  return invia(did).catch(e => `ERRORE ${e instanceof Error ? e.message : e}`);
}

export async function sondaCentralina(
  invia: (comando: string) => Promise<string>,
  centralina: Centralina,
  onPasso?: (testo: string) => void
): Promise<Lettura[]> {
  for (const cmd of sequenzaPreparazione(centralina.ecu)) {
    const r = await invia(cmd);
    onPasso?.(`${cmd} → ${r || 'nessuna risposta'}`);
  }

  const letture: Lettura[] = [];
  try {
    for (const did of centralina.did) {
      const grezza = await leggiDid(invia, did);
      const payload = estraiPayload(grezza, did);
      letture.push({
        did,
        grezza,
        payload,
        negativo: payload ? null : codiceNegativo(grezza),
        letture: payload ? interpreta(payload) : [],
      });
      onPasso?.(`${did} → ${grezza}`);
    }
  } finally {
    // Anche se qualcosa fallisce a metà, la priorità va rimessa: altrimenti
    // resta rotto tutto il resto della sessione.
    for (const cmd of SEQUENZA_RIPRISTINO) await invia(cmd).catch(() => {});
  }

  return letture;
}

/**
 * I DID da registrare a ogni sessione, sulla batteria di trazione.
 *
 * `campo` è valorizzato solo dove la formula è CONFERMATA da un riscontro
 * indipendente. Dove manca, il payload finisce grezzo in didRaw.
 *
 * Sulla tensione di pacco c'è voluta una seconda misura. Ad auto sveglia
 * 224857, 224858, 224803 e 22497C dicevano tutti la stessa cosa — 392.3, 392.6,
 * 392 e 391.9 V — e sembravano intercambiabili. Ad auto ferma da una notte i
 * primi due sono crollati a 2.0 e 1.9 V mentre gli altri due tenevano 387 e
 * 387.00: 224857 e 224858 misurano il bus a valle dei contattori, che aperti
 * non ha più tensione. La tensione vera del pacco è 22497C.
 *
 * La differenza conta perché la tensione a riposo, letta a carica nota, è il
 * modo più pulito che abbiamo di seguire il decadimento senza integrare la
 * corrente — ed è proprio la lettura che 224857 non sa dare.
 *
 * 224857 resta comunque registrato: valendo zero a contattori aperti dice
 * gratis se l'auto è viva, cosa che nessun altro dato qui distingue.
 */
export const DID_DA_REGISTRARE: {
  did: string;
  etichetta: string;
  campo?: 'packVoltage' | 'coolantInletC' | 'coolantOutletC' | 'batt12vVoltage';
  converti?: (b: number[]) => number | null;
}[] = [
  {
    did: '22497C',
    etichetta: 'Tensione pacco',
    campo: 'packVoltage',
    // I valori osservati sono sempre multipli di 10: la scala è /100 ma la
    // risoluzione effettiva resta 0.1 V
    converti: b => (b.length >= 2 ? (b[0] * 256 + b[1]) / 100 : null),
  },
  {
    did: '224804',
    etichetta: 'Liquido ingresso',
    campo: 'coolantInletC',
    converti: b => (b.length >= 2 ? (b[0] * 256 + b[1]) / 10 : null),
  },
  {
    did: '224990',
    etichetta: 'Liquido uscita',
    campo: 'coolantOutletC',
    converti: b => (b.length >= 2 ? (b[0] * 256 + b[1]) / 10 : null),
  },
  {
    did: '22F442',
    etichetta: 'Batteria 12V',
    campo: 'batt12vVoltage',
    converti: b => (b.length >= 2 ? (b[0] * 256 + b[1]) / 1000 : null),
  },
  // Da qui in poi solo grezzi: la scala non è confermata
  //
  // 22489E letto come joule dà, ad auto riposata, un valore che due mattine di
  // fila combacia con carica × ~70 kWh. Ma il test del viaggio l'ha bocciato
  // come contachilometri dell'energia: su due tratte da ~50 km è sceso di 1.0
  // e 2.3 kWh contro i 4 e 10 stimati dal cloud — un fattore ~4 — e nelle due
  // ore di sosta fra i viaggi è RISALITO di 0.44. Scende con continuità in
  // marcia e si ricalibra verso l'alto a riposo: si comporta da stima lenta
  // del BMS, non da contatore. Se vale qualcosa, vale da fermo ad auto
  // riposata; il verdetto è la lettura a riposo a una carica molto diversa.
  { did: '22489E', etichetta: 'Candidato energia residua' },
  { did: '224857', etichetta: 'Tensione bus HV, zero a contattori aperti' },
  { did: '224803', etichetta: 'Tensione pacco in volt interi, riscontro di 22497C' },
  { did: '22496D', etichetta: 'Candidato SoH' },
  // Payload di tre byte, l'ultimo sempre 03. I primi due valgono 62-71 ad auto
  // sveglia e zero esatto dopo una notte ferma: si comporta come una corrente,
  // ma la scala non è ancora fissata e 0.1 A resta un'ipotesi.
  { did: '224802', etichetta: 'Candidato corrente' },
  { did: '224858', etichetta: 'Secondo bus HV' },
  { did: '224A58', etichetta: 'Piccolo valore con segno' },
];

export const CENTRALINA_BATTERIA = CENTRALINE[0];

/** Legge i DID Volvo e riporta sia i campi confermati sia i payload grezzi. */
export async function leggiDidVolvo(invia: (c: string) => Promise<string>): Promise<{
  campi: Record<string, number>;
  grezzi: Record<string, string>;
}> {
  const campi: Record<string, number> = {};
  const grezzi: Record<string, string> = {};

  for (const cmd of sequenzaPreparazione(CENTRALINA_BATTERIA.ecu)) {
    await invia(cmd).catch(() => {});
  }

  try {
    for (const v of DID_DA_REGISTRARE) {
      const risposta = await leggiDid(invia, v.did).catch(() => '');
      const payload = estraiPayload(risposta, v.did);
      if (!payload) continue;
      grezzi[v.did] = payload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      if (v.campo && v.converti) {
        const valore = v.converti(payload);
        if (valore !== null && Number.isFinite(valore)) campi[v.campo] = valore;
      }
    }
  } finally {
    for (const cmd of SEQUENZA_RIPRISTINO) await invia(cmd).catch(() => {});
  }

  return { campi, grezzi };
}
