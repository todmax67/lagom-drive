/**
 * Collegamento diretto al dongle OBD-II via Web Bluetooth.
 *
 * Funziona su Chrome Android (e desktop): la PWA installata usa lo stesso
 * motore, e il contesto è sicuro perché il sito è in HTTPS. Su Safari iOS
 * l'API non esiste e non è prevista, quindi da iPhone questa strada è chiusa.
 *
 * Il dongle si comporta come un terminale seriale: si scrivono comandi ASCII
 * terminati da CR e si leggono le risposte fino al prompt '>'.
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

export type Canale = {
  device: BluetoothDevice;
  invia: (comando: string) => Promise<string>;
  servizioUsato: string;
  disconnetti: () => void;
};

export type ServizioScoperto = {
  uuid: string;
  caratteristiche: { uuid: string; proprieta: string[] }[];
};

export function supportato(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
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

  const server = await device.gatt!.connect();
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

  let buffer = '';
  const decoder = new TextDecoder();

  // Il numero di generazione distingue l'attesa corrente da quelle scadute: una
  // risposta arrivata in ritardo porta dati del comando precedente, e senza
  // questo controllo risolverebbe la promessa del comando successivo. Con una
  // sonda che manda diciassette richieste in fila, un solo timeout basterebbe
  // a disallineare tutto il resto e ad attribuire ogni valore al DID sbagliato.
  let generazione = 0;
  let attesa: { gen: number; risolvi: (testo: string) => void } | null = null;

  lettura.addEventListener('characteristicvaluechanged', (evento: Event) => {
    const target = evento.target as BluetoothRemoteGATTCharacteristic;
    buffer += decoder.decode(target.value!);
    // La risposta è completa quando arriva il prompt, non dopo un tempo fisso:
    // le letture lente arrivano spezzate in più notifiche.
    if (buffer.includes(PROMPT) && attesa) {
      const testo = buffer.slice(0, buffer.indexOf(PROMPT));
      buffer = '';
      const corrente = attesa;
      attesa = null;
      corrente.risolvi(testo.trim());
    }
  });

  const encoder = new TextEncoder();

  const inviaOra = (comando: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const gen = ++generazione;
      buffer = '';

      const scadenza = setTimeout(() => {
        // Si abbandona l'attesa E si svuota il buffer: quel che arriverà dopo
        // appartiene a un comando che nessuno sta più aspettando.
        if (attesa?.gen === gen) attesa = null;
        buffer = '';
        reject(new Error(`Nessuna risposta a "${comando}" entro ${TIMEOUT_MS} ms`));
      }, TIMEOUT_MS);

      attesa = {
        gen,
        risolvi: testo => {
          clearTimeout(scadenza);
          resolve(testo);
        },
      };

      const dati = encoder.encode(comando + '\r');
      const scrivi = scrittura!.properties.writeWithoutResponse
        ? scrittura!.writeValueWithoutResponse(dati)
        : scrittura!.writeValue(dati);
      scrivi.catch(err => {
        clearTimeout(scadenza);
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

  return {
    canale: {
      device,
      invia,
      servizioUsato,
      disconnetti: () => device.gatt?.disconnect(),
    },
    servizi,
  };
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
