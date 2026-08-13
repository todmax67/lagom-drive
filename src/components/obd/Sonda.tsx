'use client';

import { useState } from 'react';
import { Radar, AlertTriangle } from 'lucide-react';
import { CENTRALINE, sondaCentralina, type Lettura, type Centralina } from '@/lib/volvo-uds';
import type { Canale } from '@/lib/elm327';

export default function Sonda({ canale }: { canale: Canale | null }) {
  const [inCorso, setInCorso] = useState<string | null>(null);
  const [risultati, setRisultati] = useState<{ centralina: Centralina; letture: Lettura[] } | null>(null);
  const [passo, setPasso] = useState<string>('');

  const avvia = async (c: Centralina) => {
    if (!canale) return;
    setInCorso(c.ecu);
    setRisultati(null);
    try {
      const letture = await sondaCentralina(canale.invia, c, setPasso);
      setRisultati({ centralina: c, letture });
    } catch (err) {
      setPasso(`Errore: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInCorso(null);
    }
  };

  const conRisposta = risultati?.letture.filter(l => l.payload) ?? [];
  const senzaRisposta = risultati?.letture.filter(l => !l.payload) ?? [];

  return (
    <div className="rounded-xl border border-gray-700/50 bg-gray-800/50 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Radar size={14} className="text-purple-400" />
        <span className="text-sm font-medium text-white">Sonda centraline Volvo</span>
      </div>

      <p className="text-xs text-gray-500">
        Imposta priorità, header, filtro di ricezione e flow control, interroga
        tutti i DID noti e rimette la priorità standard alla fine.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {CENTRALINE.map(c => (
          <button
            key={c.ecu}
            onClick={() => avvia(c)}
            disabled={!canale || inCorso !== null}
            className="text-left rounded-lg bg-gray-900/60 border border-gray-700/50 p-2.5 hover:border-purple-500/40 transition-all disabled:opacity-40"
          >
            <p className="text-xs text-white font-medium">{c.nome}</p>
            <p className="text-xs text-gray-500 font-mono mt-0.5">
              {c.ecu} · {c.did.length} DID
            </p>
          </button>
        ))}
      </div>

      {inCorso && (
        <p className="text-xs text-purple-300 font-mono break-all">{passo || 'avvio…'}</p>
      )}

      {risultati && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-gray-400">
            {risultati.centralina.nome}: {conRisposta.length} risposte su {risultati.letture.length}
          </p>

          {conRisposta.length === 0 && (
            <p className="text-xs text-amber-300/90 flex items-start gap-2">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              Nessuna risposta. Se la centralina è dell&apos;alta tensione, con l&apos;auto
              parcheggiata è spenta: riprova a quadro acceso.
            </p>
          )}

          {conRisposta.map(l => (
            <div key={l.did} className="rounded-lg bg-gray-900/60 p-2.5">
              <p className="text-xs font-mono text-emerald-300">
                {l.did} → {l.payload!.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('')}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {l.letture.map(x => `${x.formula}=${x.valore}`).join('  ')}
              </p>
            </div>
          ))}

          {senzaRisposta.length > 0 && (
            <details className="text-xs text-gray-600">
              <summary className="cursor-pointer">
                {senzaRisposta.length} senza risposta valida
              </summary>
              {senzaRisposta.map(l => (
                <p key={l.did} className="font-mono mt-1 break-all">
                  {l.did}: {l.negativo !== null ? `rifiutato (codice ${l.negativo.toString(16)})` : l.grezza.slice(0, 40)}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
