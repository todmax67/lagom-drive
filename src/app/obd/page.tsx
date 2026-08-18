'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Bluetooth, Send, Trash2, ArrowLeft, AlertTriangle, Radar } from 'lucide-react';
import { collega, ricollega, supportato, INIT, type Canale, type ServizioScoperto } from '@/lib/elm327';
import { collegaNativo, nativo } from '@/lib/canale-nativo';
import Registratore from '@/components/obd/Registratore';
import Sonda from '@/components/obd/Sonda';
import Buongiorno from '@/components/obd/Buongiorno';

type Riga = { tipo: 'inviato' | 'ricevuto' | 'errore' | 'info'; testo: string };

// Tentativi di riaggancio del presidio prima di arrendersi
const TENTATIVI_MAX = 10;

export default function ObdPage() {
  const [canale, setCanale] = useState<Canale | null>(null);
  // Lo specchio per i closure di lunga vita (backoff, listener): il loop di
  // riaggancio deve vedere il canale VERO, non quello del render in cui è nato
  const canaleRef = useRef<Canale | null>(null);
  const pubblicaCanale = (c: Canale | null) => {
    canaleRef.current = c;
    setCanale(c);
  };
  const [servizi, setServizi] = useState<ServizioScoperto[]>([]);
  const [righe, setRighe] = useState<Riga[]>([]);
  const [comando, setComando] = useState('0100');
  const [occupato, setOccupato] = useState(false);
  // Il presidio (bussola §5.6): l'app si aggancia da sola al dongle, registra
  // da sola, si riaggancia da sola. Persistito: Tasker apre la pagina e basta.
  const [presidio, setPresidio] = useState(false);
  const presidioRef = useRef(false);
  // Distingue la disconnessione VOLUTA (bottone, auto-stop) dalla caduta BLE:
  // solo la caduta merita il riaggancio
  const volutoRef = useRef(false);
  const riaggancioRef = useRef(false);
  const fondo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fondo.current?.scrollIntoView({ behavior: 'smooth' });
  }, [righe]);

  const log = useCallback((tipo: Riga['tipo'], testo: string) =>
    setRighe(r => [...r, { tipo, testo }]), []);

  // Apertura di un canale appena nato: log, sequenza INIT, aggancio del
  // riaggancio. Usata sia dal bottone che dal presidio.
  const apri = useCallback(async (esito: { canale: Canale; servizi: ServizioScoperto[] }) => {
    const { canale: c, servizi: s } = esito;
    setServizi(s);
    log('info', `Collegato a ${c.nome ?? 'dispositivo senza nome'}`);
    log('info', `Servizio usato: ${c.servizioUsato}`);

    for (const passo of INIT) {
      const risposta = await c.invia(passo.comando);
      log('inviato', `${passo.comando}   — ${passo.nota}`);
      log('ricevuto', risposta || '(vuoto)');
    }

    c.suDisconnessione(() => {
      pubblicaCanale(null);
      if (volutoRef.current) {
        volutoRef.current = false;
        return;
      }
      log('errore', 'Canale BLE caduto');
      if (presidioRef.current) tentaAggancio();
    });

    // Il canale si pubblica DOPO l'INIT riuscito: un canale a metà
    // inizializzazione non deve finire in mano al Registratore
    pubblicaCanale(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log]);

  // Il riaggancio del presidio: senza picker e senza gesti — BLE nativo nel
  // guscio, getDevices() sul web. Backoff crescente, poi ci si arrende fino
  // alla prossima apertura della pagina.
  const tentaAggancio = useCallback(async () => {
    if (riaggancioRef.current || !presidioRef.current) return;
    riaggancioRef.current = true;
    try {
      for (let i = 0; i < TENTATIVI_MAX && presidioRef.current; i++) {
        // Un canale già vivo (collegato a mano durante l'attesa di backoff)
        // ferma tutto: un secondo protocollo sullo stesso filo — con l'ATZ
        // dell'INIT in mezzo a un giro di lettura — è la trappola 5.3.1
        if (canaleRef.current) return;
        let esito: Awaited<ReturnType<typeof ricollega>> = null;
        try {
          esito = nativo() ? await collegaNativo(true) : await ricollega();
        } catch {
          esito = null; // il tentativo nativo può lanciare: è un giro a vuoto
        }
        if (esito) {
          // Ricontrollo DOPO l'attesa: se nel frattempo il presidio è stato
          // spento o un canale manuale esiste, questo si richiude subito
          if (!presidioRef.current || canaleRef.current) {
            esito.canale.disconnetti();
            return;
          }
          try {
            await apri(esito);
            return;
          } catch {
            // INIT fallito su un canale appena aperto: si chiude e si riprova
            esito.canale.disconnetti();
          }
        }
        await new Promise(r => setTimeout(r, Math.min(30_000, 3_000 * (i + 1))));
      }
      if (presidioRef.current && !canaleRef.current) {
        log('info', 'Presidio: dongle non raggiungibile. Riproverò alla prossima apertura.');
      }
    } finally {
      riaggancioRef.current = false;
    }
  }, [apri, log]);

  // All'apertura: ?presidio=1 accende (e persiste), altrimenti vale il salvato
  useEffect(() => {
    const daUrl = new URLSearchParams(window.location.search).get('presidio') === '1';
    if (daUrl) localStorage.setItem('obd-presidio', '1');
    const attivo = daUrl || localStorage.getItem('obd-presidio') === '1';
    setPresidio(attivo);
    presidioRef.current = attivo;
    if (attivo) tentaAggancio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePresidio = () => {
    const nuovo = !presidio;
    setPresidio(nuovo);
    presidioRef.current = nuovo;
    localStorage.setItem('obd-presidio', nuovo ? '1' : '0');
    if (nuovo && !canale) tentaAggancio();
  };

  const handleCollega = async () => {
    setOccupato(true);
    let esito: Awaited<ReturnType<typeof ricollega>> = null;
    try {
      esito = nativo() ? await collegaNativo(false) : await collega();
      if (esito) await apri(esito);
    } catch (err) {
      // Un INIT fallito non deve lasciare un GATT zombie senza bottone
      // Disconnetti: il canale mai pubblicato si chiude qui
      esito?.canale.disconnetti();
      log('errore', err instanceof Error ? err.message : String(err));
    } finally {
      setOccupato(false);
    }
  };

  // L'auto-stop del presidio: bus muto da minuti, la guida è finita. Il
  // dongle si rilascia (il pairing debole del Vgate resta un motivo per non
  // tenerlo occupato, §5.4) e il presidio resta armato per la prossima volta.
  const autoStop = () => {
    volutoRef.current = true;
    canaleRef.current?.disconnetti();
    pubblicaCanale(null);
    log('info', 'Presidio: bus muto, sessione chiusa e dongle rilasciato.');
  };

  const handleInvia = async () => {
    if (!canale || !comando.trim()) return;
    setOccupato(true);
    const cmd = comando.trim().toUpperCase();
    try {
      log('inviato', cmd);
      const risposta = await canale.invia(cmd);
      log('ricevuto', risposta || '(vuoto)');
    } catch (err) {
      log('errore', err instanceof Error ? err.message : String(err));
    } finally {
      setOccupato(false);
    }
  };

  const colore = (tipo: Riga['tipo']) =>
    tipo === 'inviato' ? 'text-blue-400'
      : tipo === 'ricevuto' ? 'text-emerald-300'
        : tipo === 'errore' ? 'text-red-400'
          : 'text-gray-400';

  const bluetoothDisponibile = supportato() || nativo();

  return (
    <div className="bg-gray-950 min-h-screen text-white font-sans">
      <div className="max-w-3xl mx-auto p-4 md:p-6 flex flex-col gap-5">
        <header className="flex items-center gap-3">
          <Link href="/" className="p-2 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-light tracking-tight">Console OBD</h1>
            <p className="text-gray-400 text-sm">Collegamento diretto al dongle via Bluetooth</p>
          </div>
          <Link
            href="/obd/analisi"
            className="ml-auto text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded-xl px-3 py-2"
          >
            Confronto
          </Link>
        </header>

        {!bluetoothDisponibile && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-900/20 p-4 flex gap-3">
            <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-200">
              <p className="font-medium mb-1">Web Bluetooth non disponibile su questo browser.</p>
              <p className="text-amber-200/80">
                Serve Chrome su Android o desktop. Su Safari iOS l&apos;API non esiste
                e non è prevista, quindi da iPhone questa pagina non può funzionare.
              </p>
            </div>
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleCollega}
            disabled={occupato || !bluetoothDisponibile}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 font-medium text-sm transition-all disabled:opacity-40"
          >
            <Bluetooth size={16} />
            {canale ? 'Ricollega' : 'Collega dongle'}
          </button>
          {canale && (
            <button
              onClick={() => {
                volutoRef.current = true;
                canale.disconnetti();
                pubblicaCanale(null);
                log('info', 'Disconnesso');
              }}
              className="px-4 py-2.5 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white text-sm"
            >
              Disconnetti
            </button>
          )}
          <button
            onClick={togglePresidio}
            disabled={!bluetoothDisponibile}
            title="Aggancio, registrazione e riaggancio automatici"
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm transition-all disabled:opacity-40 ${
              presidio
                ? 'bg-teal-500/15 border-teal-400/40 text-teal-300'
                : 'bg-gray-800/80 border-gray-700/50 text-gray-400 hover:text-white'
            }`}
          >
            <Radar size={16} />
            Presidio {presidio ? 'attivo' : 'spento'}
          </button>
          <button
            onClick={() => setRighe([])}
            className="ml-auto p-2.5 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white"
            title="Pulisci"
          >
            <Trash2 size={16} />
          </button>
        </div>

        {presidio && (
          <p className="text-xs text-teal-300/70">
            Presidio attivo: la pagina si aggancia da sola al dongle conosciuto,
            avvia la registrazione, si riaggancia se il canale cade e chiude
            quando il bus tace. Basta aprirla — o farla aprire a Tasker.
          </p>
        )}

        <Buongiorno canale={canale} />

        <Registratore canale={canale} presidio={presidio} onAutoStop={autoStop} />

        <Sonda canale={canale} />

        {servizi.length > 0 && (
          <details className="rounded-xl border border-gray-700/50 bg-gray-800/50 p-4">
            <summary className="text-sm text-gray-300 cursor-pointer">
              Servizi GATT scoperti ({servizi.length})
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {servizi.map(s => (
                <div key={s.uuid} className="text-xs font-mono">
                  <p className="text-blue-300">{s.uuid}</p>
                  {s.caratteristiche.map(c => (
                    <p key={c.uuid} className="text-gray-400 pl-4">
                      {c.uuid} — {c.proprieta.join(', ')}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="rounded-xl border border-gray-700/50 bg-black/40 p-4 h-96 overflow-y-auto font-mono text-xs flex flex-col gap-1">
          {righe.length === 0 && (
            <p className="text-gray-500">
              Collega il dongle per iniziare. Poi prova <span className="text-gray-400">0100</span> (PID
              supportati), <span className="text-gray-400">ATDP</span> (protocollo attivo),
              oppure <span className="text-gray-400">0902</span> (VIN).
            </p>
          )}
          {righe.map((r, i) => (
            <pre key={i} className={`whitespace-pre-wrap break-all ${colore(r.tipo)}`}>
              {r.tipo === 'inviato' ? '> ' : r.tipo === 'errore' ? '! ' : '  '}{r.testo}
            </pre>
          ))}
          <div ref={fondo} />
        </div>

        <div className="flex gap-2">
          <input
            value={comando}
            onChange={e => setComando(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleInvia(); }}
            placeholder="Comando ELM327, es. 0100"
            disabled={!canale || occupato}
            className="flex-1 bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm font-mono focus:outline-none focus:border-blue-500 disabled:opacity-40"
          />
          <button
            onClick={handleInvia}
            disabled={!canale || occupato}
            className="px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 transition-all disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </div>

        <p className="text-xs text-gray-500">
          Le definizioni PID della piattaforma CMA non sono pubbliche: né OBDb né il
          repository di ABRP coprono Volvo. Questa console serve a scoprirle
          interrogando direttamente le centraline.
        </p>
      </div>
    </div>
  );
}
