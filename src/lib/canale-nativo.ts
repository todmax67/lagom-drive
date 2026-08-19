/**
 * Il connettore BLE del guscio nativo (bussola §5.6): stesso `Canale` del
 * connettore Web Bluetooth, trasporto diverso. Il guscio Capacitor carica
 * l'app di produzione nella sua webview e vi inietta il bridge: quando il
 * bridge c'è, questo modulo parla col plugin bluetooth-le nativo — che non
 * ha bisogno di gesti utente, sopravvive allo schermo spento (col foreground
 * service) e sa riconnettersi da solo.
 *
 * Il plugin arriva per import dinamico: sul web puro questo chunk non si
 * carica mai.
 */

import { creaProtocollo, SERVIZI_CANDIDATI, type Canale, type ServizioScoperto } from './elm327';

const CHIAVE_DISPOSITIVO = 'obd-ble-device-id';
const CHIAVE_NOME = 'obd-ble-device-nome';

type FinestraCapacitor = {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: Record<string, Record<string, (opts?: unknown) => Promise<unknown>> | undefined>;
  };
};

/** true dentro il guscio Capacitor, false nel browser */
export function nativo(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as FinestraCapacitor).Capacitor?.isNativePlatform?.()
  );
}

/**
 * Il foreground service del guscio: tiene vivi webview e BLE a schermo
 * spento. Il plugin "Presidio" esiste solo nella build nativa: sul web ogni
 * chiamata è un no-op silenzioso.
 */
export type EsitoPresidio =
  | { stato: 'attivo'; notifiche: boolean }
  | { stato: 'assente' } // sul web puro: non c'è servizio da avviare
  | { stato: 'fallito'; motivo: string };

/**
 * Avvia il servizio e DICE com'è andata. La prima versione inghiottiva ogni
 * errore: il servizio non partiva, la registrazione moriva a schermo spento e
 * l'app non aveva niente da dire — 24 minuti persi sul campo il 19 agosto.
 */
export async function presidioNativoAvvia(): Promise<EsitoPresidio> {
  const plugin = (window as unknown as FinestraCapacitor).Capacitor?.Plugins?.Presidio;
  if (!plugin?.avvia) return { stato: 'assente' };
  try {
    // Il permesso notifiche prima: senza, la notifica del servizio non si vede
    // e non c'è modo di sapere se la raccolta è viva
    if (plugin.chiediPermessi) await plugin.chiediPermessi({});
    const r = (await plugin.avvia({})) as unknown as {
      attivo?: boolean;
      notifiche?: boolean;
    };
    return r?.attivo
      ? { stato: 'attivo', notifiche: r.notifiche !== false }
      : { stato: 'fallito', motivo: 'il servizio non risulta in esecuzione' };
  } catch (err) {
    return {
      stato: 'fallito',
      motivo: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function presidioNativoFerma(): Promise<void> {
  try {
    const plugin = (window as unknown as FinestraCapacitor).Capacitor?.Plugins?.Presidio;
    if (plugin?.ferma) await plugin.ferma({});
  } catch { /* idem */ }
}

/**
 * Collegamento via BLE nativo. Con `soloRiaggancio` non apre mai il picker:
 * o il dongle salvato risponde, o null — è la modalità del presidio.
 */
export async function collegaNativo(
  soloRiaggancio = false
): Promise<{ canale: Canale; servizi: ServizioScoperto[] } | null> {
  if (!nativo()) return null;

  const { BleClient, numberToUUID } = await import('@capacitor-community/bluetooth-le');
  await BleClient.initialize({ androidNeverForLocation: true });

  let deviceId = localStorage.getItem(CHIAVE_DISPOSITIVO);
  let nome = localStorage.getItem(CHIAVE_NOME);
  const ascoltatori = new Set<() => void>();
  const connetti = (id: string) =>
    BleClient.connect(id, () => ascoltatori.forEach(cb => cb()));

  if (deviceId) {
    try {
      await connetti(deviceId);
    } catch (err) {
      if (soloRiaggancio) return null;
      // Il dongle salvato non risponde (sostituito? MAC cambiato?): la
      // chiave non deve murare il picker per sempre
      localStorage.removeItem(CHIAVE_DISPOSITIVO);
      localStorage.removeItem(CHIAVE_NOME);
      deviceId = null;
      nome = null;
    }
  }
  if (!deviceId) {
    if (soloRiaggancio) return null;
    const dispositivo = await BleClient.requestDevice({
      optionalServices: SERVIZI_CANDIDATI.map(numberToUUID),
    });
    deviceId = dispositivo.deviceId;
    nome = dispositivo.name ?? null;
    await connetti(deviceId);
  }

  // Stessa regola del connettore web: scrittura e lettura si riconoscono
  // dalle proprietà, non dall'UUID
  const serviziGatt = await BleClient.getServices(deviceId);
  const servizi: ServizioScoperto[] = serviziGatt.map(s => ({
    uuid: s.uuid,
    caratteristiche: s.characteristics.map(c => ({
      uuid: c.uuid,
      proprieta: Object.entries(c.properties)
        .filter(([, attiva]) => attiva)
        .map(([nomeProp]) => nomeProp),
    })),
  }));

  let servizioUsato = '';
  let uuidScrittura = '';
  let uuidLettura = '';
  let senzaRisposta = false;
  for (const s of serviziGatt) {
    const scrittura = s.characteristics.find(
      c => c.properties.write || c.properties.writeWithoutResponse
    );
    const lettura = s.characteristics.find(
      c => c.properties.notify || c.properties.indicate
    );
    if (scrittura && lettura) {
      servizioUsato = s.uuid;
      uuidScrittura = scrittura.uuid;
      uuidLettura = lettura.uuid;
      senzaRisposta = !!scrittura.properties.writeWithoutResponse;
      break;
    }
  }
  if (!servizioUsato) {
    await BleClient.disconnect(deviceId).catch(() => {});
    throw new Error(
      'Nessun servizio con una caratteristica scrivibile e una in notifica: ' +
        'il dispositivo scelto non sembra un dongle ELM327.'
    );
  }

  // L'identità si salva solo ORA, a dongle verificato: una scelta sbagliata
  // al picker (le cuffie) non deve avvelenare la chiave del riaggancio
  localStorage.setItem(CHIAVE_DISPOSITIVO, deviceId);
  if (nome) localStorage.setItem(CHIAVE_NOME, nome);

  const protocollo = creaProtocollo(async dati => {
    const vista = new DataView(dati.buffer, dati.byteOffset, dati.byteLength);
    if (senzaRisposta) {
      await BleClient.writeWithoutResponse(deviceId!, servizioUsato, uuidScrittura, vista);
    } else {
      await BleClient.write(deviceId!, servizioUsato, uuidScrittura, vista);
    }
  });

  await BleClient.startNotifications(deviceId, servizioUsato, uuidLettura, valore =>
    protocollo.consegna(valore)
  );

  return {
    canale: {
      nome,
      invia: protocollo.invia,
      servizioUsato,
      disconnetti: () => { BleClient.disconnect(deviceId!).catch(() => {}); },
      suDisconnessione: cb => ascoltatori.add(cb),
    },
    servizi,
  };
}
