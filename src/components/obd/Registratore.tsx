'use client';

import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Play, Square, KeyRound, Upload } from 'lucide-react';
import { PID_SUPPORTATI, leggiCampione, type Campione } from '@/lib/obd-pids';
import { leggiDidVolvo, preparaBECM, ripristinaStandard, leggiVI } from '@/lib/volvo-uds';
import { sottoscriviToken, leggiToken, scriviToken } from '@/lib/token-dispositivo';
import { sottoscriviOccupazione, leggiOccupazione, occupaCanale } from '@/lib/occupazione-canale';
import { presidioNativoAvvia, presidioNativoFerma, suBattitoNativo, nativo } from '@/lib/canale-nativo';
import type { Canale } from '@/lib/elm327';

const INTERVALLO_MS = 2000;
const CAMPIONI_PER_INVIO = 15;

// Ogni quanti giri leggere anche i PID lenti e i DID Volvo. La preparazione
// dell'header Volvo costa sei comandi: pagarla a ogni giro toglierebbe tempo
// alle due grandezze che cambiano di continuo, carica e velocità.
const GIRI_PER_LETTURA_LENTA = 15;

// Il regime viaggio (bussola §5.1): quando il GPS dice che l'auto si muove,
// il loop cambia natura — header fermo sul BECM e coppia corrente/tensione a
// ~1 Hz, la potenza come prodotto V*I. La velocità arriva dal GPS del
// telefono: gratis, fuori dal bus, e il budget del dongle si spende tutto
// sulle due grandezze che solo il bus conosce.
const INTERVALLO_VIAGGIO_MS = 1000;
const SOGLIA_VIAGGIO_KMH = 4;
const GPS_FRESCO_MS = 10_000;
// Sotto soglia per questo tempo prima di tornare in sosta: il semaforo non è
// la fine del viaggio, e l'energia del clima da fermo appartiene al viaggio
const ISTERESI_SOSTA_MS = 120_000;
// Ogni quanti giri veloci fare il giro completo (DID di tutte le centraline,
// PID standard): ~45 s a 1 Hz, come il "clima ogni 30-60 s" della bussola
const GIRI_VIAGGIO_PER_LENTO = 45;

// Il bus muto del presidio: giri di sosta consecutivi senza alcun valore
// (l'auto dorme) prima di chiudere da soli — 150 giri a 2 s sono 5 minuti
const GIRI_MUTI_PER_STOP = 150;

type Conteggi = {
  inviati: number;
  duplicati: number;
  scartati: number;
  letti: number;
  // Il perché degli scarti, così dal pannello si legge il rimedio e non solo
  // il sintomo. Le chiavi vengono dall'ingest.
  motivi: { malformati: number; orologio: number; senzaLetture: number };
  // La salute del GPS, che è la materia prima della distanza: il 20 agosto un
  // giro ha avuto il 4% di campioni con velocità contro il 92% degli altri, e
  // 2008 secondi sono rimasti fuori dall'integrale senza che nulla lo dicesse.
  gps: { usati: number; imprecisi: number };
};
const CONTEGGI_VUOTI: Conteggi = {
  inviati: 0,
  duplicati: 0,
  scartati: 0,
  letti: 0,
  motivi: { malformati: 0, orologio: 0, senzaLetture: 0 },
  gps: { usati: 0, imprecisi: 0 },
};

export default function Registratore({
  canale,
  presidio = false,
  onAutoStop,
}: {
  canale: Canale | null;
  presidio?: boolean;
  onAutoStop?: () => void;
}) {
  const token = useSyncExternalStore(sottoscriviToken, leggiToken, () => '');
  const occupazione = useSyncExternalStore(sottoscriviOccupazione, leggiOccupazione, () => null);
  const [attivo, setAttivo] = useState(false);
  const [ultimo, setUltimo] = useState<Campione | null>(null);
  const [conteggi, setConteggi] = useState<Conteggi>(CONTEGGI_VUOTI);
  const [messaggio, setMessaggio] = useState<string | null>(null);

  // I ref evitano le chiusure obsolete: il ciclo di lettura sopravvive ai render
  const attivoRef = useRef(false);
  // Ogni campione porta la SUA sessione dal momento dell'accodamento: i resti
  // in coda di una sessione non devono uscire con l'etichetta della successiva
  const bufferRef = useRef<{ sid: string; contesto: string; c: Campione }[]>([]);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // L'ultima velocità dal GPS: {kmh, quando}. speed può mancare (dipende dal
  // dispositivo): si ricava dalle coordinate successive quando serve.
  const gpsRef = useRef<{ kmh: number; quando: number } | null>(null);
  const gpsWatchRef = useRef<number | null>(null);
  const posPrecRef = useRef<{ lat: number; lon: number; t: number } | null>(null);
  const busRef = useRef<{ kmh: number; quando: number } | null>(null);
  // L'identità della sessione (bussola par. 5.2): generata all'avvio, viaggia
  // con ogni lotto. È lei che permette di ricomporre i ritagli del cloud.
  const idSessioneRef = useRef<string | null>(null);
  // La memoria del presidio: una caduta BLE breve riparte nella STESSA
  // sessione, così la ricomposizione vede una guida sola e non due ritagli
  // con identità diverse che non si fondono più
  const ultimaSessioneRef = useRef<{ sid: string; quando: number } | null>(null);
  // Il contesto si promuove e basta: nato 'libero', diventa 'viaggio' alla
  // prima marcia e non torna indietro (il server applica la stessa regola)
  const contestoRef = useRef<'libero' | 'viaggio'>('libero');
  const ultimoMotoRef = useRef(0);
  const sessioneRef = useRef(0);
  // Il valore VIVO del presidio per il ciclo (che è una closure di lunga
  // vita: il prop vi resterebbe congelato al valore dell'avvio) e la memoria
  // dell'auto-avvio già consumato per questo canale
  const presidioVivoRef = useRef(presidio);
  const autoAvviatoRef = useRef(false);
  // true mentre il corpo del ciclo gira: il mutex del canale si rilascia
  // all'uscita VERA del ciclo, non in ferma() — il giro in corso può avere
  // ancora 15-25 s di comandi sul filo (trappola 5.3.1)
  const cicloVivoRef = useRef(false);
  // Guardia anti-sovrapposizione per gli invii sparati senza attesa
  const invioInCorsoRef = useRef(false);
  // Il metronomo del ciclo: a schermo spento Chromium congela i setTimeout
  // della pagina nascosta (visto sul campo: 24 minuti persi il 19 agosto,
  // buchi da 10 minuti la sera stessa CON servizio in primo piano attivo).
  // Il battito nativo del presidio risolve l'attesa in corso e fa spirare i
  // comandi scaduti: il ciclo cammina anche coi timer morti.
  const attesaRef = useRef<{ risolvi: () => void; scadeA: number } | null>(null);
  const fermaBattitoRef = useRef<(() => void) | null>(null);
  // Il canale DEL CICLO in volo, non quello del prop: dopo una caduta il prop
  // è già null (o è il canale nuovo) mentre il vecchio giro ha ancora un
  // comando da far spirare — il battito deve raggiungere QUEL protocollo
  const canaleDelCicloRef = useRef<Canale | null>(null);
  const gpsPluginIdRef = useRef<string | null>(null);
  // La generazione del GPS: l'id del watch nativo arriva da una Promise, e un
  // fermaGps nel varco deve poter uccidere il watch appena nato
  const gpsGenerazioneRef = useRef(0);
  const [regime, setRegime] = useState<'sosta' | 'viaggio'>('sosta');
  const [gpsStato, setGpsStato] = useState<'ok' | 'negato' | 'assente' | null>(null);
  // Il guasto del servizio nativo, quando c'è: non deve restare muto
  const [presidioNativo, setPresidioNativo] = useState<string | null>(null);

  const creaDispositivo = async () => {
    setMessaggio(null);
    try {
      const r = await fetch('/api/obd/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Vgate iCar Pro 2S' }),
      });
      if (r.status === 401) {
        setMessaggio('Serve essere loggati nell\'app per creare un dispositivo.');
        return;
      }
      const d = await r.json();
      if (d.token) {
        scriviToken(d.token);
        setMessaggio('Dispositivo creato. Il token è salvato su questo telefono e non è più recuperabile altrove.');
      } else {
        setMessaggio('Risposta senza token: ' + JSON.stringify(d).slice(0, 120));
      }
    } catch (err) {
      setMessaggio(err instanceof Error ? err.message : String(err));
    }
  };

  const svuota = useCallback(async () => {
    if (bufferRef.current.length === 0 || !token) return;
    // Una fetta per volta, tutta della stessa sessione e sotto il limite del
    // server (500): la coda dopo una galleria puo' superare il lotto massimo,
    // e un 413 butterebbe proprio i campioni che la coda doveva salvare.
    const sid = bufferRef.current[0].sid;
    const contesto = bufferRef.current[0].contesto;
    let n = 0;
    while (n < bufferRef.current.length && n < 450 && bufferRef.current[n].sid === sid) n++;
    const fetta = bufferRef.current.slice(0, n);
    bufferRef.current = bufferRef.current.slice(n);

    const rimettiInCoda = () => {
      bufferRef.current = [...fetta, ...bufferRef.current].slice(-600);
    };

    try {
      const r = await fetch('/api/obd/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          samples: fetta.map(x => x.c),
          sessionId: sid,
          context: contesto,
          appVersion: process.env.NEXT_PUBLIC_APP_SHA,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        // 5xx e 413 sono transitori: la fetta torna in coda. Un 4xx
        // deterministico (400/401) no, o un lotto avvelenato girerebbe per
        // sempre.
        if (r.status >= 500 || r.status === 413) rimettiInCoda();
        setMessaggio(`Invio rifiutato (${r.status}): ${d.message ?? ''}`);
        return;
      }
      const m = (d.rejectedReasons ?? {}) as Partial<Conteggi['motivi']>;
      setConteggi(c => ({
        ...c,
        inviati: c.inviati + (d.accepted ?? 0),
        duplicati: c.duplicati + (d.duplicates ?? 0),
        scartati: c.scartati + (d.rejected ?? 0),
        motivi: {
          malformati: c.motivi.malformati + (m.malformati ?? 0),
          orologio: c.motivi.orologio + (m.orologio ?? 0),
          senzaLetture: c.motivi.senzaLetture + (m.senzaLetture ?? 0),
        },
      }));
    } catch (err) {
      // Rete assente (galleria, parcheggio interrato): la fetta torna in coda
      // e riparte al giro dopo. Il tetto evita l'accumulo infinito; il dedupe
      // lato server rende innocuo qualunque rinvio.
      rimettiInCoda();
      setMessaggio('Invio fallito, campioni in coda: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, [token]);

  // L'invio dal ciclo si spara e si prosegue: in galleria una fetch appesa
  // sui ritardi TCP farebbe crollare la cadenza V×I da 1 Hz al timeout di
  // rete — e la copertura del livello 1 morirebbe proprio dove serve di più.
  // La guardia evita invii sovrapposti (il dedupe server rende innocuo il resto).
  const svuotaSenzaAttesa = useCallback(() => {
    if (invioInCorsoRef.current) return;
    invioInCorsoRef.current = true;
    svuota().finally(() => {
      invioInCorsoRef.current = false;
    });
  }, [svuota]);

  // Tutto il buffer, non una fetta sola: alla fermata nessuno richiamerebbe
  // l'invio e i resti morirebbero in RAM. La guardia sul progresso evita il
  // giro infinito a rete giù (la fetta fallita torna in coda com'era).
  const svuotaTutto = useCallback(async () => {
    while (bufferRef.current.length > 0) {
      const prima = bufferRef.current.length;
      await svuota();
      if (bufferRef.current.length >= prima) break;
    }
  }, [svuota]);
  const svuotaTuttoRef = useRef(svuotaTutto);
  useEffect(() => {
    svuotaTuttoRef.current = svuotaTutto;
  }, [svuotaTutto]);

  // L'attesa che regge anche coi timer congelati: si arma sul battito nativo
  // e tiene il setTimeout come via veloce quando i timer vivono
  const dormi = (ms: number) =>
    new Promise<void>(risolvi => {
      const io = { risolvi, scadeA: Date.now() + ms };
      attesaRef.current = io;
      setTimeout(() => {
        if (attesaRef.current === io) {
          attesaRef.current = null;
          risolvi();
        }
      }, ms);
    });

  // Un colpo del battito nativo: sveglia l'attesa matura e fa spirare i
  // comandi rimasti senza risposta (o la coda half-duplex resterebbe muta)
  const colpoDiBattito = useCallback(() => {
    canaleDelCicloRef.current?.battito();
    const a = attesaRef.current;
    if (a && Date.now() >= a.scadeA) {
      attesaRef.current = null;
      a.risolvi();
    }
  }, []);

  // Il lavoro sul fix, comune ai due trasporti (pagina e plugin nativo)
  const lavoraPosizione = (pos: {
    timestamp: number;
    coords: {
      latitude: number;
      longitude: number;
      accuracy: number | null;
      speed: number | null;
    };
  }) => {
    // Il tempo del fix, non quello del callback: su Android possono
    // divergere di secondi, e il dt sbagliato inventa velocità.
    const t = pos.timestamp;
    // Un fix impreciso non è una misura QUANDO la velocità va dedotta dalle
    // posizioni: lì il jitter da fermo con 30 m di errore produce chilometri
    // orari fantasma, ed è per quello che la soglia esiste.
    //
    // Ma `coords.speed` non si deduce dalle posizioni: su Android viene dal
    // Doppler della portante, ed è buona anche quando la precisione
    // ORIZZONTALE è scadente — sono due grandezze diverse. Sbarrarle insieme
    // buttava via la misura buona per un difetto che non la riguarda: il 20
    // agosto un giro in autostrada è sceso al 4% di campioni con velocità
    // contro il 92% degli altri, e la distanza è collassata a 0,21 km su 19.
    const preciso = pos.coords.accuracy == null || pos.coords.accuracy <= 25;
    let kmh: number | null = pos.coords.speed !== null ? pos.coords.speed * 3.6 : null;
    if (kmh === null && preciso && posPrecRef.current) {
      const dt = (t - posPrecRef.current.t) / 1000;
      if (dt > 0.5) {
        const dLat = (pos.coords.latitude - posPrecRef.current.lat) * 111_320;
        const dLon = (pos.coords.longitude - posPrecRef.current.lon) * 111_320 *
          Math.cos((pos.coords.latitude * Math.PI) / 180);
        kmh = (Math.hypot(dLat, dLon) / dt) * 3.6;
      }
    }
    // Il riferimento della deduzione resta ai soli fix precisi: un fix
    // impreciso non deve diventare l'origine da cui si misura il prossimo.
    if (preciso) posPrecRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude, t };
    if (!preciso && kmh === null) {
      setConteggi(c => ({ ...c, gps: { ...c.gps, imprecisi: c.gps.imprecisi + 1 } }));
      return;
    }
    if (kmh === null || !Number.isFinite(kmh) || kmh > 250) return;
    // Sotto i 3 km/h il GPS da fermo produce rumore, non velocità
    if (kmh < 3) kmh = 0;
    gpsRef.current = { kmh, quando: Date.now() };
    setConteggi(c => ({ ...c, gps: { ...c.gps, usati: c.gps.usati + 1 } }));
    if (kmh >= SOGLIA_VIAGGIO_KMH) ultimoMotoRef.current = Date.now();
  };

  const avviaGps = () => {
    if (nativo()) {
      // La geolocation della pagina va in pausa quando la pagina è nascosta
      // (schermo spento): è documentato e visto sul campo — nell'andata persa
      // il GPS non ha mai superato i 5 km/h. Il plugin nativo consegna i fix
      // via bridge, che vive anche a pagina nascosta; il servizio in primo
      // piano ha il tipo location proprio per questo.
      const gen = gpsGenerazioneRef.current;
      import('@capacitor/geolocation')
        .then(async ({ Geolocation }) => {
          const id = await Geolocation.watchPosition(
            { enableHighAccuracy: true, timeout: 8000 },
            (pos, err) => {
              if (err || !pos) { setGpsStato('negato'); return; }
              setGpsStato('ok');
              lavoraPosizione(pos);
            }
          );
          if (gpsGenerazioneRef.current !== gen) {
            // fermaGps è passato nel varco della Promise: il watch appena
            // nato non ha più un padrone e muore subito
            Geolocation.clearWatch({ id }).catch(() => {});
            return;
          }
          gpsPluginIdRef.current = id;
        })
        .catch(() => setGpsStato('negato'));
      return;
    }
    if (!navigator.geolocation) { setGpsStato('assente'); return; }
    gpsWatchRef.current = navigator.geolocation.watchPosition(
      pos => {
        setGpsStato('ok');
        lavoraPosizione(pos);
      },
      () => setGpsStato('negato'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
    );
  };

  const fermaGps = () => {
    gpsGenerazioneRef.current++;
    if (gpsWatchRef.current !== null) {
      navigator.geolocation?.clearWatch(gpsWatchRef.current);
      gpsWatchRef.current = null;
    }
    if (gpsPluginIdRef.current !== null) {
      const id = gpsPluginIdRef.current;
      gpsPluginIdRef.current = null;
      import('@capacitor/geolocation')
        .then(({ Geolocation }) => Geolocation.clearWatch({ id }))
        .catch(() => {});
    }
    gpsRef.current = null;
    posPrecRef.current = null;
  };

  // La velocità più fresca fra GPS (10 s) e bus (60 s: arriva dai giri di
  // servizio). Senza GPS il regime viaggio vive lo stesso, sul bus.
  const velocitaCorrente = (): number | null => {
    const ora = Date.now();
    const gps = gpsRef.current;
    if (gps && ora - gps.quando < GPS_FRESCO_MS) return gps.kmh;
    const bus = busRef.current;
    if (bus && ora - bus.quando < 60_000) return bus.kmh;
    return null;
  };

  // Isteresi: si entra in viaggio con velocità vera, se ne esce solo dopo due
  // minuti sotto soglia. Al semaforo il regime NON cambia: la coppia V/I
  // continua a misurare, e l'energia del clima da fermo resta dentro
  // l'integrale del viaggio — dal saldo SOC non si vedeva, qui sì.
  const inMovimento = () => {
    const v = velocitaCorrente();
    if (v !== null && v >= SOGLIA_VIAGGIO_KMH) return true;
    return ultimoMotoRef.current > 0 && Date.now() - ultimoMotoRef.current < ISTERESI_SOSTA_MS;
  };

  const avvia = async () => {
    // La guardia di rientro e il token di sessione: ferma() non attende il
    // ciclo, e un Ferma+Avvia rapido lascerebbe il vecchio while vivo — con
    // due loop sullo stesso canale gli header si calpestano (trappola 5.3.1).
    // Ogni avvio invalida i cicli precedenti; il vecchio, al risveglio, trova
    // il token cambiato, esce e passa dal suo ripristino.
    if (!canale || attivoRef.current) return;
    if (cicloVivoRef.current) {
      // Il ciclo precedente sta ancora chiudendo il suo ultimo giro (fino a
      // 25 s di giro lento): partire ora metterebbe due scrittori sul filo.
      // L'auto-avvio non si consuma: quando il finally del vecchio ciclo
      // libererà il mutex, il cambio di occupazione farà riprovare.
      autoAvviatoRef.current = false;
      setMessaggio('Attendo la chiusura del giro precedente…');
      return;
    }
    const mioId = ++sessioneRef.current;
    const ripresa =
      presidio &&
      ultimaSessioneRef.current &&
      Date.now() - ultimaSessioneRef.current.quando < 10 * 60_000
        ? ultimaSessioneRef.current.sid
        : null;
    idSessioneRef.current = ripresa ?? crypto.randomUUID();
    // I contatori valgono per la SESSIONE, non per la vita della pagina. Senza
    // questo azzeramento restavano su dal primo avvio: col guscio in USB la
    // pagina resta aperta tutto il giorno e il presidio apre e chiude una
    // sessione per viaggio, quindi il pannello sommava giri diversi e un
    // numero grosso non diceva più a quale strada appartenesse.
    // Sul RIAGGANCIO no: lì la sessione prosegue, e azzerare perderebbe il
    // conto dei campioni già mandati per quella stessa guida.
    if (!ripresa) setConteggi(CONTEGGI_VUOTI);
    canaleDelCicloRef.current = canale;
    contestoRef.current = 'libero';
    setAttivo(true);
    attivoRef.current = true;
    occupaCanale('registratore');
    avviaGps();
    // Nel guscio: foreground service, senza il quale a schermo spento Android
    // congela la webview e la registrazione muore in silenzio. L'esito si
    // DICHIARA: il 19 agosto sono andati persi 24 minuti di viaggio perché il
    // servizio non era partito e nessuno aveva modo di saperlo.
    // Il battito prima del servizio: appena il servizio parte, i colpi
    // arrivano e il ciclo ha il suo metronomo anche a schermo spento
    if (nativo() && !fermaBattitoRef.current) {
      suBattitoNativo(colpoDiBattito).then(stop => {
        if (!stop) return;
        // Il remover arriva da una Promise: se nel varco la registrazione è
        // già morta, il listener appena nato si stacca subito
        if (!attivoRef.current && !cicloVivoRef.current) {
          stop();
          return;
        }
        fermaBattitoRef.current = stop;
      });
    }
    presidioNativoAvvia().then(e => {
      if (e.stato === 'fallito') {
        setPresidioNativo(`servizio in primo piano NON attivo: ${e.motivo}`);
      } else if (e.stato === 'attivo') {
        setPresidioNativo(
          e.notifiche
            ? null
            : 'servizio attivo ma senza permesso notifiche: concedilo, o Android può fermarlo'
        );
      } else {
        setPresidioNativo(null);
      }
    });

    // Senza schermo acceso il browser sospende il ciclo e la registrazione si ferma
    try {
      wakeLockRef.current = await navigator.wakeLock?.request('screen');
    } catch { /* non disponibile: si continua lo stesso */ }

    let giro = 0;
    let giroViaggio = 0;
    let giriMuti = 0;
    // true quando l'header del dongle è fermo sul BECM (regime viaggio):
    // uscendo dal loop VA ripristinato, o i PID standard muoiono (trappola 5.3.1)
    let headerSuBECM = false;

    const giroCompleto = async (campione: Campione, errori: string[]) => {
      try {
        const { campi, grezzi } = await leggiDidVolvo(canale.invia);
        Object.assign(campione, campi);
        if (Object.keys(grezzi).length) campione.didRaw = grezzi;
      } catch (err) {
        errori.push(`DID Volvo: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const registra = (campione: Campione, errori: string[]) => {
      // La velocità dal bus alimenta anche il regime, quando il GPS manca
      if (campione.speedKmh !== undefined) {
        busRef.current = { kmh: campione.speedKmh, quando: Date.now() };
        if (campione.speedKmh >= SOGLIA_VIAGGIO_KMH) ultimoMotoRef.current = Date.now();
      }
      const conValori = Object.keys(campione).length > 1;
      if (conValori) {
        setUltimo(campione);
        bufferRef.current.push({
          sid: idSessioneRef.current ?? '',
          contesto: contestoRef.current,
          c: campione,
        });
        setConteggi(c => ({ ...c, letti: c.letti + 1 }));
      }
      if (errori.length) setMessaggio(errori[0]);
    };

    const vivo = () => attivoRef.current && sessioneRef.current === mioId;

    const ciclo = async () => {
      try {
        while (vivo()) {
        const inizio = Date.now();
        const viaggio = inMovimento();
        if (viaggio) contestoRef.current = 'viaggio';
        setRegime(viaggio ? 'viaggio' : 'sosta');

        if (viaggio) {
          // REGIME VIAGGIO: header fermo sul BECM, coppia V/I a ~1 Hz.
          if (!headerSuBECM) {
            await preparaBECM(canale.invia);
            headerSuBECM = true;
            giroViaggio = 0;
          }

          const errori: string[] = [];
          const campione: Campione = { recordedAt: new Date().toISOString() };
          const vi = await leggiVI(canale.invia);
          if (vi.packCurrent !== undefined) campione.packCurrent = vi.packCurrent;
          if (vi.packVoltage !== undefined) campione.packVoltage = vi.packVoltage;
          // La potenza è un prodotto, non un DID: kW con segno, negativa in recupero
          if (vi.packCurrent !== undefined && vi.packVoltage !== undefined) {
            campione.packPowerKw = (vi.packCurrent * vi.packVoltage) / 1000;
          }
          const gps = gpsRef.current;
          if (gps && Date.now() - gps.quando < GPS_FRESCO_MS) {
            campione.speedKmh = Math.round(gps.kmh);
          }
          giroViaggio++;

          // Il giro di servizio: LEGGERO di proposito. Un giro completo (50
          // comandi, 15-25 s) scaverebbe nella serie di potenza buchi oltre la
          // soglia di copertura, e il livello 1 diventerebbe irraggiungibile
          // per costruzione. Qui solo i PID standard (~3-4 s, sotto soglia):
          // carica e ambiente. I DID delle altre centraline restano al regime
          // sosta e alla sonda del buongiorno.
          if (giroViaggio % GIRI_VIAGGIO_PER_LENTO === 0) {
            await ripristinaStandard(canale.invia);
            headerSuBECM = false;
            const { campione: std, errori: erroriStd } = await leggiCampione(canale.invia, true);
            // Il 010D del bus può sovrascrivere la velocità GPS: va bene, il
            // bus è la fonte migliore quando c'è
            Object.assign(campione, { ...std, recordedAt: campione.recordedAt });
            errori.push(...erroriStd);
          }

          registra(campione, errori);
          if (bufferRef.current.length >= CAMPIONI_PER_INVIO) svuotaSenzaAttesa();

          const trascorso = Date.now() - inizio;
          await dormi(Math.max(0, INTERVALLO_VIAGGIO_MS - trascorso));
          continue;
        }

        // REGIME SOSTA: il ciclo di sempre, PID standard ogni 2 s e giro
        // lento ogni 15. Se si arriva dal viaggio, prima il ripristino.
        if (headerSuBECM) {
          await ripristinaStandard(canale.invia);
          headerSuBECM = false;
        }

        const lento = giro % GIRI_PER_LETTURA_LENTA === 0;
        giro++;

        const { campione, errori } = await leggiCampione(canale.invia, lento);
        // Il giudizio "bus muto" si dà sui SOLI PID standard, PRIMA del giro
        // completo: il BECM risponde alle UDS anche ad auto addormentata, e
        // il didRaw del giro lento azzererebbe il conteggio per sempre —
        // dongle mai rilasciato e centraline svegliate ogni minuto, il
        // contrario esatto del §5.4. E un'auto che tace ai PID non si sonda
        // oltre: niente giro completo quando il bus dorme.
        const muto = Object.keys(campione).length <= 1;
        if (lento && !muto) await giroCompleto(campione, errori);

        registra(campione, errori);
        if (bufferRef.current.length >= CAMPIONI_PER_INVIO) svuotaSenzaAttesa();

        // L'auto-stop del presidio: l'auto dorme, i PID non rispondono più.
        // Dopo cinque minuti di giri vuoti da fermo la guida è finita: la
        // sessione si chiude e il genitore rilascia il dongle (§5.4).
        if (muto && !inMovimento()) giriMuti++;
        else giriMuti = 0;
        // Il valore vivo, non quello congelato all'avvio: spegnere il toggle
        // a registrazione in corso disarma anche l'auto-stop
        if (presidioVivoRef.current && giriMuti >= GIRI_MUTI_PER_STOP) {
          ferma();
          onAutoStop?.();
          break;
        }

          const trascorso = Date.now() - inizio;
          await dormi(Math.max(0, INTERVALLO_MS - trascorso));
        }
      } finally {
        // Uscita dal ciclo — anche per eccezione: mai lasciare l'header sul
        // BECM, e il mutex si rilascia solo ORA che il filo è davvero libero.
        // ferma() è sincrona ma il giro in corso può avere ancora 15-25 s di
        // comandi in volo: il Buongiorno non deve potervisi infilare.
        if (headerSuBECM) {
          await ripristinaStandard(canale.invia).catch(() => {});
        }
        // Anche metronomo e servizio si spengono QUI, all'uscita vera: se li
        // strappasse ferma() a un ciclo in volo coi timer congelati, la dormi
        // pendente non avrebbe più nessuna via di risveglio — deadlock, mutex
        // mai rilasciato, riavvio impossibile (rilievo della revisione)
        canaleDelCicloRef.current = null;
        fermaBattitoRef.current?.();
        fermaBattitoRef.current = null;
        presidioNativoFerma();
        cicloVivoRef.current = false;
        occupaCanale(null);
      }
    };
    cicloVivoRef.current = true;
    ciclo().catch(() => {});
  };

  // ferma() non tocca mai il canale: spegne il ciclo, il GPS e il wake lock,
  // e svuota il buffer via rete. Può — e deve — funzionare anche a canale
  // sparito: senza, un Disconnetti a registrazione attiva lascerebbe una
  // sessione inarrestabile che spedisce campioni solo-GPS.
  const ferma = useCallback(async (perCaduta = false) => {
    attivoRef.current = false;
    sessioneRef.current++;
    setAttivo(false);
    setRegime('sosta');
    // La dormi pendente si sveglia SUBITO: il ciclo deve vedere vivo()==false
    // e uscire dal suo finally — coi timer congelati non c'è altra sveglia
    const attesa = attesaRef.current;
    attesaRef.current = null;
    attesa?.risolvi();
    // Mutex, metronomo e servizio li spegne l'uscita vera del ciclo (che può
    // avere ancora secondi di comandi in volo); qui solo se il ciclo non gira
    if (!cicloVivoRef.current) {
      occupaCanale(null);
      fermaBattitoRef.current?.();
      fermaBattitoRef.current = null;
      presidioNativoFerma();
    }
    fermaGps();
    // La memoria per la ripresa: SOLO sulla caduta del canale — è per lei che
    // esiste. Un auto-stop o un Ferma voluto chiudono la guida: la prossima
    // è un'altra, e cucirle sotto la stessa sessione fonderebbe due viaggi.
    if (perCaduta && idSessioneRef.current) {
      ultimaSessioneRef.current = { sid: idSessioneRef.current, quando: Date.now() };
    } else {
      ultimaSessioneRef.current = null;
    }
    await svuotaTutto();
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;

  }, [svuotaTutto]);

  // Il canale può sparire mentre si registra (bottone Disconnetti del
  // genitore): il loop girerebbe su un canale morto inghiottendo gli errori,
  // spedendo campioni solo-GPS che accreditano copertura senza potenza.
  useEffect(() => {
    // Il canale sparito sotto i piedi è la caduta per cui esiste la ripresa
    if (!canale && attivoRef.current) ferma(true);
  }, [canale, ferma]);

  useEffect(() => {
    presidioVivoRef.current = presidio;
  }, [presidio]);

  // L'avvio automatico del presidio: UNA volta per canale, consumato solo
  // quando l'avvio parte davvero. Così "Ferma registrazione" resta fermo
  // (il cambio di occupazione non fa ripartire nulla), Buongiorno e Sonda
  // possono prendere il canale, e un canale NUOVO — il riaggancio dopo una
  // caduta — riparte da solo. Se alla nascita del canale il Buongiorno lo
  // sta usando, l'avvio aspetta che l'occupazione si liberi.
  useEffect(() => {
    autoAvviatoRef.current = false;
  }, [canale]);
  useEffect(() => {
    if (
      presidio &&
      canale &&
      token &&
      !attivoRef.current &&
      !autoAvviatoRef.current &&
      (occupazione === null || occupazione === 'registratore')
    ) {
      autoAvviatoRef.current = true;
      avvia();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presidio, canale, token, occupazione]);

  useEffect(() => () => {
    attivoRef.current = false;
    sessioneRef.current++;
    fermaGps();
    wakeLockRef.current?.release().catch(() => {});
    occupaCanale(null);
    // Lo smontaggio è la gemella di ferma(): senza queste due, nel guscio il
    // foreground service resterebbe acceso (wake lock fino a 12 ore) e fino
    // a 14 campioni già contati come "letti" morirebbero in RAM
    fermaBattitoRef.current?.();
    fermaBattitoRef.current = null;
    presidioNativoFerma();
    void svuotaTuttoRef.current();

  }, []);

  return (
    <div className="rounded-xl border border-gray-700/50 bg-gray-800/50 p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white flex items-center gap-2">
          Registrazione
          {attivo && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              regime === 'viaggio'
                ? 'text-blue-300 bg-blue-400/10'
                : 'text-gray-400 bg-gray-700/40'
            }`}>
              {regime === 'viaggio' ? 'viaggio · V×I a 1 Hz' : 'sosta'}
            </span>
          )}
        </span>
        {conteggi.letti > 0 && (
          <span className="text-xs text-gray-400">
            {conteggi.letti} letti · {conteggi.inviati} salvati
            {conteggi.duplicati > 0 && ` · ${conteggi.duplicati} già presenti`}
            {conteggi.scartati > 0 &&
              ` · ${conteggi.scartati} scartati (${[
                conteggi.motivi.senzaLetture && `${conteggi.motivi.senzaLetture} senza letture`,
                conteggi.motivi.orologio && `${conteggi.motivi.orologio} fuori tempo`,
                conteggi.motivi.malformati && `${conteggi.motivi.malformati} malformati`,
              ]
                .filter(Boolean)
                .join(', ') || 'motivo non dichiarato'})`}
            {(conteggi.gps.usati > 0 || conteggi.gps.imprecisi > 0) &&
              ` · GPS ${conteggi.gps.usati} fix${
                conteggi.gps.imprecisi > 0 ? `, ${conteggi.gps.imprecisi} imprecisi` : ''
              }`}
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={token}
          onChange={e => scriviToken(e.target.value)}
          placeholder="Token del dispositivo"
          type="password"
          className="flex-1 bg-gray-900/60 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-xs font-mono focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={creaDispositivo}
          title="Crea un dispositivo e genera il token"
          className="px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700/50 text-gray-400 hover:text-white"
        >
          <KeyRound size={16} />
        </button>
      </div>

      <button
        onClick={() => (attivo ? ferma(false) : avvia())}
        disabled={(!attivo && (!canale || !token)) || (occupazione !== null && occupazione !== 'registratore')}
        className={`flex items-center justify-center gap-2 w-full p-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 ${
          attivo ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
        } text-white`}
      >
        {attivo ? <Square size={16} /> : <Play size={16} />}
        {attivo ? 'Ferma registrazione' : 'Avvia registrazione'}
      </button>

      {attivo && presidioNativo && (
        <p className="text-xs text-amber-300/90">
          {presidioNativo}. A schermo spento la raccolta si fermerà: tieni
          l&apos;app in primo piano finché non è risolto.
        </p>
      )}

      {attivo && (gpsStato === 'negato' || gpsStato === 'assente') && (
        <p className="text-xs text-gray-500">
          GPS non disponibile: il regime viaggio si regge sulla velocità del
          bus, letta ai giri di servizio.
        </p>
      )}

      {ultimo && (
        <div className="grid grid-cols-2 gap-2">
          {PID_SUPPORTATI.map(pid => {
            const v = ultimo[pid.campo];
            return (
              <div key={pid.comando} className="rounded-lg bg-gray-900/60 p-2.5">
                <p className="text-xs text-gray-400 mb-1">{pid.etichetta}</p>
                <p className="text-sm text-white font-light">
                  {v === undefined ? 'n/d' : `${v.toFixed(2)} ${pid.unita}`}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {messaggio && (
        <p className="text-xs text-amber-300/90 flex items-start gap-2">
          <Upload size={12} className="shrink-0 mt-0.5" />
          {messaggio}
        </p>
      )}

      <p className="text-xs text-gray-500">
        {nativo()
          ? 'Guscio nativo: la registrazione continua anche a schermo spento, tenuta viva dal servizio in primo piano.'
          : 'Lo schermo resta acceso durante la registrazione: una PWA non mantiene la connessione Bluetooth in secondo piano, quindi l’app deve restare in primo piano.'}
      </p>
    </div>
  );
}
