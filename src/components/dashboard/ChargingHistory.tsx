'use client';

import { useState } from 'react';
import { Activity, Euro, Home, MapPin, Pencil, Check, X } from 'lucide-react';
import CurvaRicarica from './CurvaRicarica';

interface ChargingSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startLevel: number;
  endLevel: number | null;
  energyAdded: number | null;
  chargingType: string;
  totalCost: number | null;
  costPerKwh: number | null;
  wallKwh: number | null;
  location: string | null;
  isComplete: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: string, end: string | null) {
  if (!end) return 'In corso';
  const diff = new Date(end).getTime() - new Date(start).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

function SessionCard({
  session,
  onUpdate,
}: {
  session: ChargingSession;
  onUpdate: (id: string, data: Partial<ChargingSession>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [costPerKwh, setCostPerKwh] = useState(session.costPerKwh?.toString() ?? '');
  const [location, setLocation] = useState(session.location ?? '');
  const [wallKwh, setWallKwh] = useState(session.wallKwh?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  // La finestra della curva si fissa al click: per le cariche in corso il
  // bordo destro è l'istante dell'apertura, non un "adesso" che scorre
  const [finestraCurva, setFinestraCurva] = useState<{ da: string; a: string } | null>(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      const newCostPerKwh = parseFloat(costPerKwh) || 0;
      const newWallKwh = parseFloat(wallKwh);
      const wall = Number.isFinite(newWallKwh) && newWallKwh > 0 ? newWallKwh : null;
      // La correzione della base di costo (bussola §4.3): la tariffa si paga
      // lato MURO, non lato pacco. Col contatore si fattura il pagato; senza,
      // resta il vecchio calcolo lato pacco, ottimista delle perdite AC.
      const newTotalCost = wall
        ? wall * newCostPerKwh
        : session.energyAdded
          ? session.energyAdded * newCostPerKwh
          : 0;

      const res = await fetch(`/api/charging/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          costPerKwh: newCostPerKwh,
          totalCost: newTotalCost,
          location,
          wallKwh: wall,
        }),
      });

      if (res.ok) {
        onUpdate(session.id, {
          costPerKwh: newCostPerKwh,
          totalCost: newTotalCost,
          location,
          wallKwh: wall,
        });
        setEditing(false);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`rounded-xl p-4 flex flex-col gap-3 ${
        session.isComplete
          ? 'bg-gray-900/60'
          : 'bg-emerald-500/5 border border-emerald-500/20'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {session.chargingType === 'DC'
            ? <MapPin size={14} className="text-amber-400" />
            : <Home size={14} className="text-blue-400" />
          }
          <span className="text-sm font-medium text-white">
            {session.location ?? (session.chargingType === 'DC' ? 'Colonnina' : 'Casa')}
          </span>
          {!session.isComplete && (
            <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">
              In corso
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {formatDate(session.startedAt)}
          </span>
          <button
            onClick={() =>
              setFinestraCurva(f =>
                f
                  ? null
                  : { da: session.startedAt, a: session.endedAt ?? new Date().toISOString() }
              )
            }
            className={`p-1.5 rounded-lg transition-all ${
              finestraCurva
                ? 'text-amber-400 bg-amber-400/10'
                : 'text-gray-400 hover:text-amber-400 hover:bg-amber-400/10'
            }`}
            title="Curva di ricarica"
          >
            <Activity size={13} />
          </button>
          {session.isComplete && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-400 hover:bg-blue-400/10 transition-all"
              title="Modifica prezzo"
            >
              <Pencil size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Dati */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-gray-800/60 p-2.5">
          <p className="text-xs text-gray-400 mb-1">Livello</p>
          <p className="text-sm text-white font-light">
            {session.startLevel}% → {session.endLevel ?? '...'}%
          </p>
        </div>
        <div className="rounded-lg bg-gray-800/60 p-2.5">
          <p className="text-xs text-gray-400 mb-1">
            Energia{session.wallKwh != null && ' · muro'}
          </p>
          <p className="text-sm text-white font-light">
            {session.wallKwh != null
              ? `${session.wallKwh.toFixed(1)} kWh`
              : session.energyAdded != null
                ? `${session.energyAdded.toFixed(1)} kWh`
                : '...'}
          </p>
          {/* Efficienza = entrati/pagati. Dedotto su misurato: la barra
              d'errore vera arriverà con la capacità calibrata. */}
          {session.wallKwh != null && session.energyAdded != null && (
            <p className="text-xs text-gray-400 mt-0.5">
              pacco {session.energyAdded.toFixed(1)} · η {Math.round((session.energyAdded / session.wallKwh) * 100)}%
            </p>
          )}
        </div>
        <div className="rounded-lg bg-gray-800/60 p-2.5">
          <p className="text-xs text-gray-400 mb-1">Durata</p>
          <p className="text-sm text-white font-light">
            {formatDuration(session.startedAt, session.endedAt)}
          </p>
        </div>
      </div>

      {finestraCurva && <CurvaRicarica da={finestraCurva.da} a={finestraCurva.a} />}

      {/* Form modifica */}
      {editing && (
        <div className="border-t border-gray-700/50 pt-3 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Tariffa (€/kWh)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={costPerKwh}
                onChange={e => setCostPerKwh(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder="es. 0.45"
              />
              {(parseFloat(wallKwh) > 0 || session.energyAdded) && costPerKwh && (
                <p className="text-xs text-gray-400">
                  Totale: €{((parseFloat(wallKwh) > 0 ? parseFloat(wallKwh) : session.energyAdded ?? 0) * parseFloat(costPerKwh || '0')).toFixed(2)}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Contatore a muro (kWh)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={wallKwh}
                onChange={e => setWallKwh(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder="Δ letto dal contatore, es. 19.31"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Luogo</label>
              <input
                type="text"
                value={location}
                onChange={e => setLocation(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder="es. Colonnina Esselunga"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setEditing(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-700/50 transition-all"
            >
              <X size={12} /> Annulla
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-all disabled:opacity-50"
            >
              <Check size={12} /> {saving ? 'Salvo...' : 'Salva'}
            </button>
          </div>
        </div>
      )}

      {/* Costo */}
      {session.totalCost != null && !editing && (
        <div className="flex items-center justify-between border-t border-gray-700/50 pt-3">
          <span className="text-xs text-gray-400 flex items-center gap-1">
            <Euro size={11} />
            {session.costPerKwh
              ? `€${session.costPerKwh.toFixed(2)}/kWh`
              : 'Costo sessione'}
          </span>
          <span className="text-sm font-medium text-emerald-400">
            €{session.totalCost.toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}

export default function ChargingHistory({
  sessions: initialSessions,
}: {
  sessions: ChargingSession[];
}) {
  const [sessions, setSessions] = useState(initialSessions);

  const handleUpdate = (id: string, data: Partial<ChargingSession>) => {
    setSessions(prev =>
      prev.map(s => (s.id === id ? { ...s, ...data } : s))
    );
  };

  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <p className="text-gray-400 text-sm text-center">
          Nessuna sessione di ricarica registrata ancora.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
        Storico Ricariche
      </span>
      <div className="flex flex-col gap-3">
        {sessions.map(s => (
          <SessionCard key={s.id} session={s} onUpdate={handleUpdate} />
        ))}
      </div>
    </div>
  );
}