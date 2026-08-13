'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Bluetooth, Send, Trash2, ArrowLeft, AlertTriangle } from 'lucide-react';
import { collega, supportato, INIT, type Canale, type ServizioScoperto } from '@/lib/elm327';
import Registratore from '@/components/obd/Registratore';
import Sonda from '@/components/obd/Sonda';

type Riga = { tipo: 'inviato' | 'ricevuto' | 'errore' | 'info'; testo: string };

export default function ObdPage() {
  const [canale, setCanale] = useState<Canale | null>(null);
  const [servizi, setServizi] = useState<ServizioScoperto[]>([]);
  const [righe, setRighe] = useState<Riga[]>([]);
  const [comando, setComando] = useState('0100');
  const [occupato, setOccupato] = useState(false);
  const fondo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fondo.current?.scrollIntoView({ behavior: 'smooth' });
  }, [righe]);

  const log = (tipo: Riga['tipo'], testo: string) =>
    setRighe(r => [...r, { tipo, testo }]);

  const handleCollega = async () => {
    setOccupato(true);
    try {
      const { canale: c, servizi: s } = await collega();
      setCanale(c);
      setServizi(s);
      log('info', `Collegato a ${c.device.name ?? 'dispositivo senza nome'}`);
      log('info', `Servizio usato: ${c.servizioUsato}`);

      for (const passo of INIT) {
        const risposta = await c.invia(passo.comando);
        log('inviato', `${passo.comando}   — ${passo.nota}`);
        log('ricevuto', risposta || '(vuoto)');
      }
    } catch (err) {
      log('errore', err instanceof Error ? err.message : String(err));
    } finally {
      setOccupato(false);
    }
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
          : 'text-gray-500';

  return (
    <div className="bg-gray-950 min-h-screen text-white font-sans">
      <div className="max-w-3xl mx-auto p-4 md:p-6 flex flex-col gap-5">
        <header className="flex items-center gap-3">
          <Link href="/" className="p-2 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-light tracking-tight">Console OBD</h1>
            <p className="text-gray-500 text-sm">Collegamento diretto al dongle via Bluetooth</p>
          </div>
          <Link
            href="/obd/analisi"
            className="ml-auto text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded-xl px-3 py-2"
          >
            Confronto
          </Link>
        </header>

        {!supportato() && (
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

        <div className="flex gap-2">
          <button
            onClick={handleCollega}
            disabled={occupato || !supportato()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 font-medium text-sm transition-all disabled:opacity-40"
          >
            <Bluetooth size={16} />
            {canale ? 'Ricollega' : 'Collega dongle'}
          </button>
          {canale && (
            <button
              onClick={() => { canale.disconnetti(); setCanale(null); log('info', 'Disconnesso'); }}
              className="px-4 py-2.5 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white text-sm"
            >
              Disconnetti
            </button>
          )}
          <button
            onClick={() => setRighe([])}
            className="ml-auto p-2.5 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white"
            title="Pulisci"
          >
            <Trash2 size={16} />
          </button>
        </div>

        <Registratore canale={canale} />

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
                    <p key={c.uuid} className="text-gray-500 pl-4">
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
            <p className="text-gray-600">
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

        <p className="text-xs text-gray-600">
          Le definizioni PID della piattaforma CMA non sono pubbliche: né OBDb né il
          repository di ABRP coprono Volvo. Questa console serve a scoprirle
          interrogando direttamente le centraline.
        </p>
      </div>
    </div>
  );
}
