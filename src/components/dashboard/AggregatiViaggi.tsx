'use client';

import { useState, useEffect } from 'react';
import { CalendarRange } from 'lucide-react';

/**
 * I viaggi aggregati per settimana, mese e anno. L'energia è quella del
 * rilevatore cloud — dedotta, e dichiarata tale in calce: i pochi integrali
 * misurati non si sommano ai molti dedotti.
 */

interface Riga {
  chiave: string;
  label: string;
  viaggi: number;
  km: number;
  kwh: number | null;
  consumo: number | null;
}

interface Aggregati {
  settimane: Riga[];
  mesi: Riga[];
  anni: Riga[];
}

type Periodo = 'settimane' | 'mesi' | 'anni';

const it = (n: number, decimali = 1) =>
  n.toLocaleString('it-IT', {
    minimumFractionDigits: decimali,
    maximumFractionDigits: decimali,
  });

const TAB: { chiave: Periodo; label: string }[] = [
  { chiave: 'settimane', label: 'Settimana' },
  { chiave: 'mesi', label: 'Mese' },
  { chiave: 'anni', label: 'Anno' },
];

export default function AggregatiViaggi() {
  const [dati, setDati] = useState<Aggregati | null>(null);
  const [errore, setErrore] = useState(false);
  const [periodo, setPeriodo] = useState<Periodo>('settimane');

  useEffect(() => {
    fetch('/api/trips/aggregati')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setDati)
      .catch(() => setErrore(true));
  }, []);

  // Il guasto non si traveste da assenza di viaggi
  if (errore) {
    return (
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <p className="text-sm text-gray-400">Aggregati non leggibili ora: la fonte non ha risposto.</p>
      </div>
    );
  }
  if (!dati) return null;

  const righe = dati[periodo];

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase flex items-center gap-2">
          <CalendarRange size={13} className="text-blue-400" />
          Viaggi aggregati
        </span>
        <div className="bg-gray-900/60 p-1 rounded-lg flex items-center gap-1">
          {TAB.map(t => (
            <button
              key={t.chiave}
              onClick={() => setPeriodo(t.chiave)}
              className={`px-2.5 py-1 rounded-md text-xs transition-all ${
                periodo === t.chiave
                  ? 'bg-gray-700/80 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {righe.length === 0 ? (
        <p className="text-sm text-gray-400">Nessun viaggio in archivio per questo periodo.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 text-left">
                <th className="font-normal pb-2">Periodo</th>
                <th className="font-normal pb-2 text-right">Viaggi</th>
                <th className="font-normal pb-2 text-right">km</th>
                <th className="font-normal pb-2 text-right">kWh</th>
                <th className="font-normal pb-2 text-right">kWh/100 km</th>
              </tr>
            </thead>
            <tbody>
              {righe.map(r => (
                <tr key={r.chiave} className="border-t border-gray-700/40">
                  <td className="py-2 text-gray-300">{r.label}</td>
                  <td className="py-2 text-right text-white font-light tabular-nums">{r.viaggi}</td>
                  <td className="py-2 text-right text-white font-light tabular-nums">{it(r.km, 0)}</td>
                  <td className="py-2 text-right text-white font-light tabular-nums">
                    {r.kwh != null ? it(r.kwh, 1) : '—'}
                  </td>
                  <td className="py-2 text-right text-white font-light tabular-nums">
                    {r.consumo != null ? it(r.consumo, 1) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-500">
        Energia dedotta · ΔSoC × capacità. Il consumo divide per i km dei soli
        viaggi con stima di energia.
      </p>
    </div>
  );
}
