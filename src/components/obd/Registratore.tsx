'use client';

import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Play, Square, KeyRound, Upload } from 'lucide-react';
import { PID_SUPPORTATI, leggiCampione, type Campione } from '@/lib/obd-pids';
import { leggiDidVolvo, preparaBECM, ripristinaStandard, leggiVI } from '@/lib/volvo-uds';
import { sottoscriviToken, leggiToken, scriviToken } from '@/lib/token-dispositivo';
import { sottoscriviOccupazione, leggiOccupazione, occupaCanale } from '@/lib/occupazione-canale';
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

type Conteggi = { inviati: number; duplicati: number; scartati: number; letti: number };

export default function Registratore({ canale }: { canale: Canale | null }) {
  const token = useSyncExternalStore(sottoscriviToken, leggiToken, () => '');
  const occupazione = useSyncExternalStore(sottoscriviOccupazione, leggiOccupazione, () => null);
  const [attivo, setAttivo] = useState(false);
  const [ultimo, setUltimo] = useState<Campione | null>(null);
  const [conteggi, setConteggi] = useState<Conteggi>({ inviati: 0, duplicati: 0, scartati: 0, letti: 0 });
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
  // Il contesto si promuove e basta: nato 'libero', diventa 'viaggio' alla
  // prima marcia e non torna indietro (il server applica la stessa regola)
  const contestoRef = useRef<'libero' | 'viaggio'>('libero');
  const ultimoMotoRef = useRef(0);
  const sessioneRef = useRef(0);
  const [regime, setRegime] = useState<'sosta' | 'viaggio'>('sosta');
  const [gpsStato, setGpsStato] = useState<'ok' | 'negato' | 'assente' | null>(null);

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
      setConteggi(c => ({
        ...c,
        inviati: c.inviati + (d.accepted ?? 0),
        duplicati: c.duplicati + (d.duplicates ?? 0),
        scartati: c.scartati + (d.rejected ?? 0),
      }));
    } catch (err) {
      // Rete assente (galleria, parcheggio interrato): la fetta torna in coda
      // e riparte al giro dopo. Il tetto evita l'accumulo infinito; il dedupe
      // lato server rende innocuo qualunque rinvio.
      rimettiInCoda();
      setMessaggio('Invio fallito, campioni in coda: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, [token]);

  const avviaGps = () => {
    if (!navigator.geolocation) { setGpsStato('assente'); return; }
    gpsWatchRef.current = navigator.geolocation.watchPosition(
      pos => {
        setGpsStato('ok');
        // Il tempo del fix, non quello del callback: su Android possono
        // divergere di secondi, e il dt sbagliato inventa velocità.
        const t = pos.timestamp;
        // Un fix impreciso non è una misura: il jitter da fermo con 30 m di
        // errore produce chilometri orari fantasma.
        if (pos.coords.accuracy != null && pos.coords.accuracy > 25) return;
        let kmh: number | null = pos.coords.speed !== null ? pos.coords.speed * 3.6 : null;
        if (kmh === null && posPrecRef.current) {
          const dt = (t - posPrecRef.current.t) / 1000;
          if (dt > 0.5) {
            const dLat = (pos.coords.latitude - posPrecRef.current.lat) * 111_320;
            const dLon = (pos.coords.longitude - posPrecRef.current.lon) * 111_320 *
              Math.cos((pos.coords.latitude * Math.PI) / 180);
            kmh = (Math.hypot(dLat, dLon) / dt) * 3.6;
          }
        }
        posPrecRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude, t };
        if (kmh === null || !Number.isFinite(kmh) || kmh > 250) return;
        // Sotto i 3 km/h il GPS da fermo produce rumore, non velocità
        if (kmh < 3) kmh = 0;
        gpsRef.current = { kmh, quando: Date.now() };
        if (kmh >= SOGLIA_VIAGGIO_KMH) ultimoMotoRef.current = Date.now();
      },
      () => setGpsStato('negato'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
    );
  };

  const fermaGps = () => {
    if (gpsWatchRef.current !== null) {
      navigator.geolocation?.clearWatch(gpsWatchRef.current);
      gpsWatchRef.current = null;
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
    const mioId = ++sessioneRef.current;
    idSessioneRef.current = crypto.randomUUID();
    contestoRef.current = 'libero';
    setAttivo(true);
    attivoRef.current = true;
    occupaCanale('registratore');
    avviaGps();

    // Senza schermo acceso il browser sospende il ciclo e la registrazione si ferma
    try {
      wakeLockRef.current = await navigator.wakeLock?.request('screen');
    } catch { /* non disponibile: si continua lo stesso */ }

    let giro = 0;
    let giroViaggio = 0;
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
          if (bufferRef.current.length >= CAMPIONI_PER_INVIO) await svuota();

          const trascorso = Date.now() - inizio;
          await new Promise(r => setTimeout(r, Math.max(0, INTERVALLO_VIAGGIO_MS - trascorso)));
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
        if (lento) await giroCompleto(campione, errori);

        registra(campione, errori);
        if (bufferRef.current.length >= CAMPIONI_PER_INVIO) await svuota();

        const trascorso = Date.now() - inizio;
        await new Promise(r => setTimeout(r, Math.max(0, INTERVALLO_MS - trascorso)));
      }

      // Uscita dal ciclo: mai lasciare l'header sul BECM
      if (headerSuBECM) {
        await ripristinaStandard(canale.invia).catch(() => {});
      }
    };
    ciclo();
  };

  // ferma() non tocca mai il canale: spegne il ciclo, il GPS e il wake lock,
  // e svuota il buffer via rete. Può — e deve — funzionare anche a canale
  // sparito: senza, un Disconnetti a registrazione attiva lascerebbe una
  // sessione inarrestabile che spedisce campioni solo-GPS.
  const ferma = useCallback(async () => {
    attivoRef.current = false;
    sessioneRef.current++;
    setAttivo(false);
    setRegime('sosta');
    occupaCanale(null);
    fermaGps();
    await svuota();
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svuota]);

  // Il canale può sparire mentre si registra (bottone Disconnetti del
  // genitore): il loop girerebbe su un canale morto inghiottendo gli errori,
  // spedendo campioni solo-GPS che accreditano copertura senza potenza.
  useEffect(() => {
    if (!canale && attivoRef.current) ferma();
  }, [canale, ferma]);

  useEffect(() => () => {
    attivoRef.current = false;
    sessioneRef.current++;
    fermaGps();
    wakeLockRef.current?.release().catch(() => {});
    occupaCanale(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                : 'text-gray-500 bg-gray-700/40'
            }`}>
              {regime === 'viaggio' ? 'viaggio · V×I a 1 Hz' : 'sosta'}
            </span>
          )}
        </span>
        {conteggi.letti > 0 && (
          <span className="text-xs text-gray-500">
            {conteggi.letti} letti · {conteggi.inviati} salvati
            {conteggi.duplicati > 0 && ` · ${conteggi.duplicati} già presenti`}
            {conteggi.scartati > 0 && ` · ${conteggi.scartati} scartati`}
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
        onClick={attivo ? ferma : avvia}
        disabled={(!attivo && (!canale || !token)) || (occupazione !== null && occupazione !== 'registratore')}
        className={`flex items-center justify-center gap-2 w-full p-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 ${
          attivo ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
        } text-white`}
      >
        {attivo ? <Square size={16} /> : <Play size={16} />}
        {attivo ? 'Ferma registrazione' : 'Avvia registrazione'}
      </button>

      {attivo && (gpsStato === 'negato' || gpsStato === 'assente') && (
        <p className="text-xs text-gray-600">
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
                <p className="text-xs text-gray-500 mb-1">{pid.etichetta}</p>
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

      <p className="text-xs text-gray-600">
        Lo schermo resta acceso durante la registrazione: una PWA non mantiene la
        connessione Bluetooth in secondo piano, quindi l&apos;app deve restare in primo piano.
      </p>
    </div>
  );
}
