'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { Sunrise, Check, Upload } from 'lucide-react';
import { eseguiBuongiorno, type EsitoBuongiorno } from '@/lib/buongiorno';
import { sottoscriviToken, leggiToken } from '@/lib/token-dispositivo';
import { sottoscriviOccupazione, leggiOccupazione, occupaCanale } from '@/lib/occupazione-canale';
import type { Campione } from '@/lib/obd-pids';
import type { Canale } from '@/lib/elm327';

/**
 * Il rituale guidato (bussola §4.1 e §5.1): un tasto, meno di un minuto, e il
 * campione è salvato — è quello che la card in Oggi va a leggere. La Sonda
 * esplorativa mostra e basta; il buongiorno misura e archivia.
 */
export default function Buongiorno({ canale }: { canale: Canale | null }) {
  const token = useSyncExternalStore(sottoscriviToken, leggiToken, () => '');
  const occupazione = useSyncExternalStore(sottoscriviOccupazione, leggiOccupazione, () => null);
  const [inCorso, setInCorso] = useState(false);
  const [daInviare, setDaInviare] = useState<Campione | null>(null);
  const idSessioneRef = useRef<string | null>(null);
  const [passo, setPasso] = useState<string | null>(null);
  const [esito, setEsito] = useState<EsitoBuongiorno | null>(null);
  const [salvataggio, setSalvataggio] = useState<string | null>(null);

  // Il salvataggio è separato dalla lettura: se la rete manca o il token è
  // stato revocato, il campione — che è costato un risveglio dell'auto — resta
  // in mano e si può ritentare senza rileggere niente.
  const salva = async (campione: Campione) => {
    setPasso('Salvataggio…');
    try {
      const r = await fetch('/api/obd/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          samples: [campione],
          sessionId: idSessioneRef.current,
          context: 'buongiorno',
          appVersion: process.env.NEXT_PUBLIC_APP_SHA,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setDaInviare(campione);
        setSalvataggio(`Salvataggio rifiutato (${r.status}): ${d.message ?? ''}`);
      } else if (d.accepted > 0) {
        setDaInviare(null);
        setSalvataggio('Salvata. La card in Oggi si aggiorna da sola.');
      } else if (d.duplicates > 0) {
        setDaInviare(null);
        setSalvataggio('Già presente in archivio.');
      } else {
        // Respinto: l'ingest risponde 200 anche quando scarta (campione senza
        // letture valide, orologio sballato). Dirlo "già presente" sarebbe
        // un check verde su una mattina buttata: è successo di peggio per meno.
        setDaInviare(null);
        setSalvataggio('Campione respinto: nessuna lettura valida. Controlla il collegamento e ripeti.');
      }
    } catch (err) {
      setDaInviare(campione);
      setSalvataggio('Invio fallito: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setPasso(null);
    }
  };

  const esegui = async () => {
    if (!canale) return;
    setInCorso(true);
    setEsito(null);
    setSalvataggio(null);
    occupaCanale('buongiorno');
    idSessioneRef.current = crypto.randomUUID();
    try {
      const risultato = await eseguiBuongiorno(canale.invia, setPasso);
      setEsito(risultato);
      await salva(risultato.campione);
    } catch (err) {
      setSalvataggio(err instanceof Error ? err.message : String(err));
    } finally {
      occupaCanale(null);
      setPasso(null);
      setInCorso(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-700/50 bg-gray-800/50 p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white flex items-center gap-2">
          <Sunrise size={15} className="text-amber-300" />
          Sonda del buongiorno
        </span>
        {passo && <span className="text-xs text-gray-500">{passo}</span>}
      </div>

      <p className="text-xs text-gray-500">
        Una lettura ad auto riposata, prima di partire: 12V, tensione di pacco,
        carica e i candidati in validazione. Meno di un minuto, e viene salvata.
      </p>

      <button
        onClick={esegui}
        disabled={!canale || !token || inCorso || (occupazione !== null && occupazione !== 'buongiorno')}
        className="flex items-center justify-center gap-2 w-full p-3 rounded-xl font-semibold text-sm bg-amber-600 hover:bg-amber-500 text-white transition-all disabled:opacity-40"
      >
        <Sunrise size={16} />
        {inCorso ? 'In corso…' : 'Esegui il buongiorno'}
      </button>
      {!token && (
        <p className="text-xs text-gray-600">
          Serve il token del dispositivo: si crea dal Registratore qui sotto.
        </p>
      )}
      {occupazione !== null && occupazione !== 'buongiorno' && (
        <p className="text-xs text-gray-600">
          Ferma prima la registrazione: il rituale vuole l&apos;auto a riposo e
          il canale tutto per sé.
        </p>
      )}

      {esito && (
        <div className="grid grid-cols-2 gap-2">
          <Tessera etichetta="Batteria 12V" valore={esito.batt12v !== null ? `${esito.batt12v.toFixed(2)} V` : 'n/d'} />
          <Tessera etichetta="Pacco a riposo" valore={esito.packVoltage !== null ? `${esito.packVoltage.toFixed(1)} V` : 'n/d'} />
          <Tessera etichetta="Carica" valore={esito.socDisplay !== null ? `${esito.socDisplay.toFixed(1)} %` : 'n/d'} />
          <Tessera etichetta="SoH (in validazione)" valore={esito.sohGrezzo ?? 'n/d'} mono />
        </div>
      )}

      {salvataggio && (
        <p className={`text-xs flex items-start gap-2 ${
          salvataggio.startsWith('Salvata') || salvataggio.startsWith('Già')
            ? 'text-emerald-300/90' : 'text-amber-300/90'
        }`}>
          {salvataggio.startsWith('Salvata') || salvataggio.startsWith('Già')
            ? <Check size={12} className="shrink-0 mt-0.5" />
            : <Upload size={12} className="shrink-0 mt-0.5" />}
          {salvataggio}
        </p>
      )}

      {daInviare && (
        <button
          onClick={() => salva(daInviare)}
          className="text-xs text-blue-400 hover:text-blue-300 self-start"
        >
          Riprova l&apos;invio (la lettura è già fatta)
        </button>
      )}

      {esito && esito.errori.length > 0 && (
        <p className="text-xs text-amber-300/80">{esito.errori[0]}</p>
      )}
    </div>
  );
}

function Tessera({ etichetta, valore, mono }: { etichetta: string; valore: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-gray-900/60 p-2.5">
      <p className="text-xs text-gray-500 mb-1">{etichetta}</p>
      <p className={`text-sm text-white font-light ${mono ? 'font-mono text-xs pt-1' : ''}`}>{valore}</p>
    </div>
  );
}
