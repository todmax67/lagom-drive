'use client';

import { useState, useRef, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Play, Square, KeyRound, Upload } from 'lucide-react';
import { PID_SUPPORTATI, leggiCampione, type Campione } from '@/lib/obd-pids';
import { leggiDidVolvo } from '@/lib/volvo-uds';
import type { Canale } from '@/lib/elm327';

const CHIAVE_TOKEN = 'lagom-obd-token';
const INTERVALLO_MS = 2000;
const CAMPIONI_PER_INVIO = 15;

// Ogni quanti giri leggere anche i PID lenti e i DID Volvo. La preparazione
// dell'header Volvo costa sei comandi: pagarla a ogni giro toglierebbe tempo
// alle due grandezze che cambiano di continuo, carica e velocità.
const GIRI_PER_LETTURA_LENTA = 15;

// Il token vive in localStorage e non in React: useSyncExternalStore è il modo
// previsto per leggerlo senza disallineare l'idratazione, e senza impostare
// stato dentro un effetto.
const ascoltatori = new Set<() => void>();
const sottoscrivi = (fn: () => void) => {
  ascoltatori.add(fn);
  return () => { ascoltatori.delete(fn); };
};
const leggiToken = () => localStorage.getItem(CHIAVE_TOKEN) ?? '';
const scriviToken = (valore: string) => {
  localStorage.setItem(CHIAVE_TOKEN, valore);
  ascoltatori.forEach(fn => fn());
};

type Conteggi = { inviati: number; duplicati: number; scartati: number; letti: number };

export default function Registratore({ canale }: { canale: Canale | null }) {
  const token = useSyncExternalStore(sottoscrivi, leggiToken, () => '');
  const [attivo, setAttivo] = useState(false);
  const [ultimo, setUltimo] = useState<Campione | null>(null);
  const [conteggi, setConteggi] = useState<Conteggi>({ inviati: 0, duplicati: 0, scartati: 0, letti: 0 });
  const [messaggio, setMessaggio] = useState<string | null>(null);

  // I ref evitano le chiusure obsolete: il ciclo di lettura sopravvive ai render
  const attivoRef = useRef(false);
  const bufferRef = useRef<Campione[]>([]);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

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
    const daInviare = bufferRef.current;
    if (daInviare.length === 0 || !token) return;
    bufferRef.current = [];

    try {
      const r = await fetch('/api/obd/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ samples: daInviare }),
      });
      const d = await r.json();
      if (!r.ok) {
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
      // I campioni sono già usciti dal buffer: si perdono. Meglio che accumularli
      // all'infinito su una connessione che non torna.
      setMessaggio('Invio fallito: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, [token]);

  const avvia = async () => {
    if (!canale) return;
    setAttivo(true);
    attivoRef.current = true;

    // Senza schermo acceso il browser sospende il ciclo e la registrazione si ferma
    try {
      wakeLockRef.current = await navigator.wakeLock?.request('screen');
    } catch { /* non disponibile: si continua lo stesso */ }

    let giro = 0;
    const ciclo = async () => {
      while (attivoRef.current) {
        const inizio = Date.now();
        const lento = giro % GIRI_PER_LETTURA_LENTA === 0;
        giro++;

        const { campione, errori } = await leggiCampione(canale.invia, lento);

        if (lento) {
          try {
            const { campi, grezzi } = await leggiDidVolvo(canale.invia);
            Object.assign(campione, campi);
            if (Object.keys(grezzi).length) campione.didRaw = grezzi;
          } catch (err) {
            errori.push(`DID Volvo: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const conValori = Object.keys(campione).length > 1;
        if (conValori) {
          setUltimo(campione);
          bufferRef.current.push(campione);
          setConteggi(c => ({ ...c, letti: c.letti + 1 }));
        }
        if (errori.length) setMessaggio(errori[0]);

        if (bufferRef.current.length >= CAMPIONI_PER_INVIO) await svuota();

        const trascorso = Date.now() - inizio;
        await new Promise(r => setTimeout(r, Math.max(0, INTERVALLO_MS - trascorso)));
      }
    };
    ciclo();
  };

  const ferma = async () => {
    attivoRef.current = false;
    setAttivo(false);
    await svuota();
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  };

  useEffect(() => () => { attivoRef.current = false; }, []);

  return (
    <div className="rounded-xl border border-gray-700/50 bg-gray-800/50 p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">Registrazione</span>
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
        disabled={!canale || !token}
        className={`flex items-center justify-center gap-2 w-full p-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-40 ${
          attivo ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
        } text-white`}
      >
        {attivo ? <Square size={16} /> : <Play size={16} />}
        {attivo ? 'Ferma registrazione' : 'Avvia registrazione'}
      </button>

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
