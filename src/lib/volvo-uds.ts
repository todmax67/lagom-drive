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
    did: ['22EE30', '22EE36', '22EE37', '22EE38', '22EE40', '22EE41', '22EE46', '22EE47', '22EE48', '22EE62', '22EE6F'],
  },
  {
    ecu: 'D01602',
    nome: 'Termica e climatizzazione',
    did: ['220303', '220329', '22032B', '22032F', '220331', '224345', '22EEA6', '22EEA7', '22EEB3', '22EEB8'],
  },
  {
    ecu: 'D01A01',
    nome: 'Batteria 12V (CEM)',
    did: ['224028', '2240CD', '224025', '224090'],
  },
  // Dalla cattura del 16 ago 2026: quattro centraline mai viste prima, e la
  // formula del filtro di ricezione regge anche su di loro.
  {
    ecu: 'D01A11',
    nome: 'Potenza e 12V (A11)',
    // 22984F: potenza pacco, i valori /100 combaciano con la forbice del
    // grafico di Car Scanner (0.95-1.35 contro 0.76-1.37 kW)
    did: ['224345', '229843', '22984F'],
  },
  {
    ecu: 'D01692',
    nome: 'SoC reale (692)',
    // 22985C: 1566/20 = 78.3 contro 78.07 a schermo — scala /20 da confermare
    did: ['2249D4', '22985C', '22985E', '229861'],
  },
  {
    ecu: 'D01801',
    nome: 'Odometro (801)',
    // 2261BB: 0182F0 = 99056 km, identico allo schermo al chilometro
    did: ['2261BB', '22D903'],
  },
  { ecu: 'D01634', nome: 'Centralina 634', did: ['22EE8C', '22EE8D'] },
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
// I codici negativi UDS che significano "riprova", non "no":
// 0x21 busyRepeatRequest, 0x22 conditionsNotCorrect,
// 0x78 requestCorrectlyReceived-ResponsePending.
const NEGATIVI_TRANSITORI = new Set([0x21, 0x22, 0x78]);

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
export async function leggiDid(
  invia: (comando: string) => Promise<string>,
  did: string
): Promise<string> {
  const prima = await invia(did).catch(e => `ERRORE ${e instanceof Error ? e.message : e}`);
  if (estraiPayload(prima, did)) return prima;
  // Un codice negativo NON e' sempre l'ultima parola. Tre di questi dicono
  // "non ora", non "non esiste", e sono esattamente quelli che una centralina
  // appena svegliata restituisce: ritentare e' giusto. Gli altri (servizio non
  // supportato, DID fuori intervallo, accesso negato) sono verdetti definitivi
  // e ritentarli vorrebbe dire solo martellare il bus.
  //
  // Senza questa distinzione la sonda del buongiorno falliva il PRIMO
  // tentativo ogni singola mattina — 22F442 (la 12V, prima della lista) non
  // rispondeva mai, e con lei sparivano SoH e tensione di pacco. Quattro
  // mattine su quattro fra il 19 e il 22 agosto 2026, sempre identiche: sei
  // campi al primo giro, nove al secondo trenta secondi dopo.
  const codice = codiceNegativo(prima);
  if (codice !== null && !NEGATIVI_TRANSITORI.has(codice)) return prima;
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
  campo?: 'packVoltage' | 'coolantInletC' | 'coolantOutletC' | 'batt12vVoltage' | 'soh' | 'odometer' | 'packCurrent';
  converti?: (b: number[]) => number | null;
}[] = [
  {
    // Prima della lista di proposito: la lettura sveglia le centraline, che
    // caricano la 12V man mano che si accendono. Il primo valore dopo il
    // risveglio è quello buono (bussola §5.1), e il retry sul primo DID
    // protegge dal colpo a vuoto del canale appena preparato.
    did: '22F442',
    etichetta: 'Batteria 12V',
    campo: 'batt12vVoltage',
    converti: b => (b.length >= 2 ? (b[0] * 256 + b[1]) / 1000 : null),
  },
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
  // Da qui in poi solo grezzi: la scala non è confermata
  //
  // 22489E, BOCCIATO come energia residua (15 ago 2026). L'ipotesi "joule
  // rimanenti" reggeva al 74-75% (combaciava con carica × ~70 kWh) ma è morta
  // due volte: sul viaggio (cala di ~¼ del dovuto in marcia, risale a riposo)
  // e sulla lettura a riposo al 53%, dove doveva dire ~37 kWh e ha detto 48.95.
  // Su 21 punti di carica si muove di ~3: non è proporzionale a niente di
  // ovvio. Resta registrato perché si muove e perché le bocciature sono
  // conoscenza pagata — ma nessuna superficie deve interpretarlo.
  { did: '22489E', etichetta: 'Bocciato come energia residua, natura ignota' },
  { did: '224857', etichetta: 'Tensione bus HV, zero a contattori aperti' },
  { did: '224803', etichetta: 'Tensione pacco in volt interi, riscontro di 22497C' },
  {
    // PROMOSSO (16 ago 2026): Car Scanner mostrava "HV Battery SoH 94.36%"
    // mentre il grezzo diceva 000024DC = 9436 — la scala /100 è confermata
    // al centesimo da una fonte indipendente. Il testimone A ha un nome.
    did: '22496D',
    etichetta: 'SoH',
    campo: 'soh',
    converti: b => (b.length >= 2 ? ((b[b.length - 2] * 256 + b[b.length - 1]) / 100) : null),
  },
  {
    // PROMOSSO (18 ago 2026), ed era il "candidato corrente" del primo
    // giorno: nella cattura in guida i primi due byte con segno spaziano da
    // -1569 a +1779 su 1383 letture — -157 A in recupero, +178 in
    // accelerazione, zero a riposo, con la tensione che affonda a 381 V sotto
    // carico. La firma della corrente di pacco, /10. Il terzo byte (sempre
    // 03) resta non interpretato. Con V e I tipizzati, la potenza è V*I:
    // il DID della potenza non serve piu' cercarlo.
    did: '224802',
    etichetta: 'Corrente di pacco',
    campo: 'packCurrent',
    converti: b => {
      if (b.length < 2) return null;
      const u = b[0] * 256 + b[1];
      return (u > 0x7fff ? u - 0x10000 : u) / 10;
    },
  },
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
      let payload = estraiPayload(await leggiDid(invia, v.did).catch(() => ''), v.did);
      // Un payload che c'e' ma non converte e' TRONCATO, non assente: sul
      // canale freddo del mattino 22497C e 22496D tornavano di un byte solo,
      // e i campi tipizzati restavano vuoti mentre il grezzo risultava
      // presente — un guasto travestito da dato mancante. Vale un secondo
      // colpo, come il DID che non risponde affatto.
      if (payload && v.campo && v.converti) {
        const primo = v.converti(payload);
        if (primo === null || !Number.isFinite(primo)) {
          payload = estraiPayload(await leggiDid(invia, v.did).catch(() => ''), v.did) ?? payload;
        }
      }
      if (!payload) continue;
      grezzi[v.did] = payload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      if (v.campo && v.converti) {
        const valore = v.converti(payload);
        if (valore !== null && Number.isFinite(valore)) campi[v.campo] = valore;
      }
    }

    // I tre DID d'oro della cattura del 16 ago, su tre centraline diverse:
    // potenza (22984F), SoC reale (22985C), odometro (2261BB). Grezzi con
    // chiave prefissata finché il giro di prova non conferma le scale — la
    // prova regina è la potenza che balla insieme alla velocità.
    // Verdetti del giro di prova (17 ago): 2261BB PROMOSSO — odometro in km,
    // incrementa km per km e combacia col cloud al chilometro, due conferme
    // indipendenti. 22985C BOCCIATO come SoC reale: in marcia salta su e giù
    // (un SoC non risale), ed è la tensione di pacco ×4 — 1564/4 = 391.0 V,
    // identico a 22497C; la coincidenza con 78.07 a schermo era ambiguità
    // numerica a quel livello di carica. 22984F BOCCIATO come potenza di
    // trazione: rampa monotona, nessuna correlazione con la velocità, mai
    // negativo in frenata — probabile media ausiliaria. Entrambi restano
    // grezzi: bocciati non significa inutili, significa non interpretabili.
    for (const blocco of [
      { ecu: 'D01A11', dids: ['22984F'] },
      { ecu: 'D01692', dids: ['22985C'] },
    ]) {
      for (const cmd of sequenzaPreparazione(blocco.ecu)) await invia(cmd).catch(() => {});
      for (const did of blocco.dids) {
        const risposta = await leggiDid(invia, did).catch(() => '');
        const payload = estraiPayload(risposta, did);
        if (payload) {
          grezzi[`${blocco.ecu}${did}`] = payload
            .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
            .join('');
        }
      }
    }

    // L'odometro promosso: km interi, nessuna conversione
    for (const cmd of sequenzaPreparazione('D01801')) await invia(cmd).catch(() => {});
    const rispostaOdo = await leggiDid(invia, '2261BB').catch(() => '');
    const payloadOdo = estraiPayload(rispostaOdo, '2261BB');
    if (payloadOdo && payloadOdo.length >= 3) {
      grezzi['D018012261BB'] = payloadOdo
        .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
      const km = payloadOdo.reduce((a, b) => a * 256 + b, 0);
      if (km > 0 && km < 2_000_000) campi.odometer = km;
    }
  } finally {
    for (const cmd of SEQUENZA_RIPRISTINO) await invia(cmd).catch(() => {});
  }

  return { campi, grezzi };
}

/**
 * Il regime viaggio (bussola §5.1): corrente e tensione abitano sulla stessa
 * centralina, quindi l'header si prepara UNA volta e la coppia si legge in
 * loop a ~1 Hz senza ripagare i sei comandi. Chi usa questo blocco deve
 * ricordarsi il ripristino quando esce: la trappola 5.3.1 vale anche qui.
 */
export const DID_CORRENTE = '224802';
export const DID_TENSIONE = '22497C';

export async function preparaBECM(invia: (c: string) => Promise<string>): Promise<void> {
  for (const cmd of sequenzaPreparazione(CENTRALINA_BATTERIA.ecu)) {
    await invia(cmd).catch(() => {});
  }
}

export async function ripristinaStandard(invia: (c: string) => Promise<string>): Promise<void> {
  for (const cmd of SEQUENZA_RIPRISTINO) await invia(cmd).catch(() => {});
}

/** La coppia del regime viaggio: corrente con segno /10 e tensione /100. */
export async function leggiVI(
  invia: (c: string) => Promise<string>
): Promise<{ packCurrent?: number; packVoltage?: number }> {
  const out: { packCurrent?: number; packVoltage?: number } = {};

  const rc = await leggiDid(invia, DID_CORRENTE).catch(() => '');
  const pc = estraiPayload(rc, DID_CORRENTE);
  if (pc && pc.length >= 2) {
    const u = pc[0] * 256 + pc[1];
    out.packCurrent = (u > 0x7fff ? u - 0x10000 : u) / 10;
  }

  const rv = await leggiDid(invia, DID_TENSIONE).catch(() => '');
  const pv = estraiPayload(rv, DID_TENSIONE);
  if (pv && pv.length >= 2) {
    const v = (pv[0] * 256 + pv[1]) / 100;
    // Un pacco sotto i 100 V è il bus a contattori aperti o un errore di
    // lettura: meglio nessun valore che una potenza calcolata su 2 V.
    if (v >= 100) out.packVoltage = v;
  }

  return out;
}
