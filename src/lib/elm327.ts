/**
 * Collegamento al dongle OBD-II — il canale della bussola (§5.6).
 *
 * Il PROTOCOLLO DI LINEA (comandi ASCII terminati da CR, risposte fino al
 * prompt '>', generazioni contro le risposte tardive, coda half-duplex) è
 * separato dal TRASPORTO: qui vive il connettore Web Bluetooth (Chrome
 * Android/desktop), in canale-nativo.ts quello BLE del guscio Capacitor.
 * Entrambi producono lo stesso `Canale`: tutto ciò che sta a valle — PID,
 * UDS Volvo, regimi — non sa e non deve sapere da dove passa il filo.
 */

// I dongle ELM327 BLE non usano un servizio standard: ognuno espone il proprio.
// Web Bluetooth obbliga a dichiarare in anticipo i servizi a cui si vuole
// accedere, quindi si elencano i candidati noti e si scopre quale risponde.
export const SERVIZI_CANDIDATI = [
  0xfff0, // Vgate iCar Pro / vLinker e molti altri
  0xffe0, // moduli tipo HM-10
  0xffe5,
  0x18f0, // alcuni cloni
  0xfd00,
];

const PROMPT = '>';
const TIMEOUT_MS = 5000;
// L'identità dell'ultimo dongle usato: permette il riaggancio senza picker
const CHIAVE_DISPOSITIVO = 'obd-web-device-id';

export type Canale = {
  nome: string | null;
  invia: (comando: string) => Promise<string>;
  servizioUsato: string;
  disconnetti: () => void;
  // Il presidio ha bisogno di saperlo: la riconnessione parte da qui
  suDisconnessione: (cb: () => void) => void;
  // Il battito nativo chiama qui: fa spirare i comandi scaduti quando i
  // timer della pagina sono congelati (schermo spento)
  battito: () => void;
};

export type ServizioScoperto = {
  uuid: string;
  caratteristiche: { uuid: string; proprieta: string[] }[];
};

export function supportato(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/**
 * Il protocollo di linea, indipendente dal trasporto. `scrivi` porta i byte al
 * dongle; `consegna` riceve i pezzi di risposta man mano che arrivano.
 */
export function creaProtocollo(scrivi: (dati: Uint8Array) => Promise<void>) {
  let buffer = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Il numero di generazione distingue l'attesa corrente da quelle scadute: una
  // risposta arrivata in ritardo porta dati del comando precedente, e senza
  // questo controllo risolverebbe la promessa del comando successivo. Con una
  // sonda che manda diciassette richieste in fila, un solo timeout basterebbe
  // a disallineare tutto il resto e ad attribuire ogni valore al DID sbagliato.
  let generazione = 0;
  let attesa: {
    gen: number;
    comando: string;
    scadeA: number;
    risolvi: (testo: string) => void;
    rifiuta: (errore: Error) => void;
  } | null = null;

  // Il giudizio di scadenza sta sull'OROLOGIO, non sul timer: a schermo
  // spento Chromium congela i setTimeout della pagina nascosta, e un comando
  // senza risposta bloccherebbe la coda half-duplex per sempre. spira() è
  // idempotente e viene chiamata sia dal timer (quando vive) sia dal battito
  // nativo del presidio (quando il timer è congelato).
  const spira = () => {
    if (!attesa || Date.now() < attesa.scadeA) return;
    const corrente = attesa;
    attesa = null;
    buffer = '';
    corrente.rifiuta(
      new Error(`Nessuna risposta a "${corrente.comando}" entro ${TIMEOUT_MS} ms`)
    );
  };

  const consegna = (dati: AllowSharedBufferSource) => {
    // La risposta è completa quando arriva il prompt, non dopo un tempo fisso:
    // le letture lente arrivano spezzate in più notifiche.
    buffer += decoder.decode(dati);
    if (buffer.includes(PROMPT) && attesa) {
      const testo = buffer.slice(0, buffer.indexOf(PROMPT));
      buffer = '';
      const corrente = attesa;
      attesa = null;
      corrente.risolvi(testo.trim());
    }
  };

  const inviaOra = (comando: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const gen = ++generazione;
      buffer = '';

      attesa = {
        gen,
        comando,
        scadeA: Date.now() + TIMEOUT_MS,
        risolvi: resolve,
        rifiuta: reject,
      };

      // Il timer resta come guardiano quando i timer vivono; spira() giudica
      // sull'orologio, quindi un doppio richiamo è innocuo
      setTimeout(spira, TIMEOUT_MS + 50);

      scrivi(encoder.encode(comando + '\r')).catch(err => {
        if (attesa?.gen === gen) attesa = null;
        reject(err);
      });
    });

  // L'ELM327 è half-duplex: due richieste sovrapposte condividerebbero il
  // buffer. La catena serializza, e il ramo di errore la mantiene viva.
  let inCoda: Promise<unknown> = Promise.resolve();
  const invia = (comando: string): Promise<string> => {
    const esito = inCoda.then(
      () => inviaOra(comando),
      () => inviaOra(comando)
    );
    inCoda = esito.catch(() => {});
    return esito;
  };

  return { invia, consegna, spira };
}

/**
 * Le caratteristiche non hanno nomi standard: quella su cui scrivere e quella
 * da cui leggere si riconoscono dalle proprietà dichiarate, non dall'UUID.
 */
function scegliCaratteristiche(caratteristiche: BluetoothRemoteGATTCharacteristic[]) {
  const scrittura = caratteristiche.find(
    c => c.properties.write || c.properties.writeWithoutResponse
  );
  const lettura = caratteristiche.find(c => c.properties.notify || c.properties.indicate);
  return { scrittura, lettura };
}

// Chrome restituisce lo STESSO oggetto BluetoothDevice a ogni richiesta: il
// listener DOM di disconnessione si registra UNA volta per device, e a ogni
// apertura si sostituisce il set di callback — quelli dell'apertura
// precedente muoiono con lei, invece di accumularsi e consumare a vicenda i
// flag di "disconnessione voluta".
const ascoltatoriPerDevice = new WeakMap<BluetoothDevice, Set<() => void>>();
const dispositiviConListener = new WeakSet<BluetoothDevice>();

/**
 * Apertura di un device già scelto: GATT, scoperta servizi, protocollo.
 * `timeoutMs` serve al riaggancio del presidio: su un device fuori portata
 * gatt.connect() resta pendente per sempre, e senza un limite il ciclo di
 * backoff non avanzerebbe mai.
 */
async function apriDispositivo(
  device: BluetoothDevice,
  timeoutMs?: number
): Promise<{ canale: Canale; servizi: ServizioScoperto[] }> {
  const connessione = device.gatt!.connect();
  const server = await (timeoutMs
    ? Promise.race([
        connessione,
        new Promise<never>((_, rifiuta) =>
          setTimeout(() => {
            // Il disconnect annulla il connect pendente: senza, risolverebbe
            // ore dopo aprendo un canale che nessuno aspetta più
            device.gatt?.disconnect();
            rifiuta(new Error('Dongle fuori portata'));
          }, timeoutMs)
        ),
      ])
    : connessione);
  const tuttiIServizi = await server.getPrimaryServices();

  const servizi: ServizioScoperto[] = [];
  let scrittura: BluetoothRemoteGATTCharacteristic | undefined;
  let lettura: BluetoothRemoteGATTCharacteristic | undefined;
  let servizioUsato = '';

  for (const servizio of tuttiIServizi) {
    const caratteristiche = await servizio.getCharacteristics().catch(() => []);
    servizi.push({
      uuid: servizio.uuid,
      caratteristiche: caratteristiche.map(c => ({
        uuid: c.uuid,
        proprieta: Object.entries(c.properties)
          .filter(([, attiva]) => attiva)
          .map(([nome]) => nome),
      })),
    });

    if (!scrittura || !lettura) {
      const scelte = scegliCaratteristiche(caratteristiche);
      if (scelte.scrittura && scelte.lettura) {
        scrittura = scelte.scrittura;
        lettura = scelte.lettura;
        servizioUsato = servizio.uuid;
      }
    }
  }

  if (!scrittura || !lettura) {
    device.gatt!.disconnect();
    throw new Error(
      'Nessun servizio con una caratteristica scrivibile e una in notifica: ' +
        'il dispositivo scelto non sembra un dongle ELM327.'
    );
  }

  await lettura.startNotifications();

  // Il cast placa la distinzione ArrayBufferLike/ArrayBuffer dei tipi DOM
  // recenti: i byte di TextEncoder non sono mai condivisi
  const protocollo = creaProtocollo(dati =>
    scrittura!.properties.writeWithoutResponse
      ? scrittura!.writeValueWithoutResponse(dati as unknown as BufferSource)
      : scrittura!.writeValue(dati as unknown as BufferSource)
  );

  lettura.addEventListener('characteristicvaluechanged', (evento: Event) => {
    const target = evento.target as BluetoothRemoteGATTCharacteristic;
    protocollo.consegna(target.value!);
  });

  const ascoltatori = new Set<() => void>();
  ascoltatoriPerDevice.set(device, ascoltatori);
  if (!dispositiviConListener.has(device)) {
    dispositiviConListener.add(device);
    device.addEventListener('gattserverdisconnected', () => {
      ascoltatoriPerDevice.get(device)?.forEach(cb => cb());
    });
  }

  // L'identità per il riaggancio del presidio: senza picker la prossima volta
  try {
    localStorage.setItem(CHIAVE_DISPOSITIVO, device.id);
  } catch { /* storage pieno o negato: si vivrà col picker */ }

  return {
    canale: {
      nome: device.name ?? null,
      invia: protocollo.invia,
      servizioUsato,
      disconnetti: () => device.gatt?.disconnect(),
      suDisconnessione: cb => ascoltatori.add(cb),
      battito: protocollo.spira,
    },
    servizi,
  };
}

export async function collega(): Promise<{ canale: Canale; servizi: ServizioScoperto[] }> {
  if (!supportato()) {
    throw new Error(
      'Web Bluetooth non disponibile. Serve Chrome su Android o desktop: su Safari iOS l\'API non esiste.'
    );
  }

  // acceptAllDevices invece dei filtri: i dongle si annunciano con nomi diversi
  // e un filtro sbagliato nasconderebbe il dispositivo dall'elenco.
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: SERVIZI_CANDIDATI,
  });

  return apriDispositivo(device);
}

/**
 * Il riaggancio del presidio: nessun picker, nessun gesto. getDevices() rende
 * i dispositivi già autorizzati; se il dongle salvato è in portata, si apre.
 * null quando la strada non c'è (API assente, permesso decaduto, dongle
 * spento): il chiamante decide se ripiegare sul picker.
 */
export async function ricollega(): Promise<{ canale: Canale; servizi: ServizioScoperto[] } | null> {
  if (!supportato()) return null;
  const bt = navigator.bluetooth as Bluetooth & {
    getDevices?: () => Promise<BluetoothDevice[]>;
  };
  if (typeof bt.getDevices !== 'function') return null;

  try {
    const dispositivi = await bt.getDevices();
    if (!dispositivi.length) return null;
    const salvato = localStorage.getItem(CHIAVE_DISPOSITIVO);
    const device = dispositivi.find(d => d.id === salvato) ?? dispositivi[0];
    return await apriDispositivo(device, 8_000);
  } catch {
    return null;
  }
}

/**
 * Sequenza di inizializzazione. Il protocollo 7 è quello che la XC40 ha
 * dichiarato: ISO 15765-4 CAN con ID a 29 bit e 500 kbaud. Le intestazioni
 * restano attive perché servono a capire quale centralina ha risposto.
 */
export const INIT = [
  { comando: 'ATZ', nota: 'reset del modulo' },
  { comando: 'ATE0', nota: 'niente eco dei comandi' },
  { comando: 'ATL0', nota: 'niente a capo' },
  { comando: 'ATS0', nota: 'niente spazi nelle risposte' },
  { comando: 'ATH1', nota: 'mostra le intestazioni: dice chi ha risposto' },
  { comando: 'ATSP7', nota: 'ISO 15765-4 CAN 29 bit 500 kbaud' },
];
