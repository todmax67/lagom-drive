'use client';

import { useState, useEffect } from 'react';
import { PlusCircle, X, Check } from 'lucide-react';

interface Props {
  onAdded: () => void;
}

export default function AddChargingSession({ onAdded }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Stessa capacità che userà il server nel salvataggio, così il preview non mente
  const [capacity, setCapacity] = useState<number | null>(null);
  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0],
    startTime: '20:00',
    endTime: '22:00',
    startLevel: '',
    endLevel: '',
    chargingType: 'AC',
    costPerKwh: '0.25',
    location: 'Casa',
  });

  useEffect(() => {
    if (!open || capacity !== null) return;
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => setCapacity(s.batteryCapacity))
      .catch(() => {});
  }, [open, capacity]);

  const handleSave = async () => {
    if (!form.startLevel || !form.endLevel) return;
    setSaving(true);
    try {
      const startedAt = new Date(`${form.date}T${form.startTime}:00`);
      const endedAt = new Date(`${form.date}T${form.endTime}:00`);

      await fetch('/api/charging/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          startLevel: parseInt(form.startLevel),
          endLevel: parseInt(form.endLevel),
          chargingType: form.chargingType,
          costPerKwh: parseFloat(form.costPerKwh),
          location: form.location,
        }),
      });

      setOpen(false);
      onAdded();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 text-sm font-medium text-blue-400 hover:text-blue-300 border border-blue-500/30 hover:border-blue-400/50 rounded-xl px-4 py-2.5 transition-all duration-200"
      >
        <PlusCircle size={16} />
        Aggiungi ricarica manuale
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white">Nuova ricarica manuale</span>
        <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-white">
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Data</label>
          <input
            type="date"
            value={form.date}
            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Tipo</label>
          <select
            value={form.chargingType}
            onChange={e => setForm(f => ({ ...f, chargingType: e.target.value }))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="AC">Casa (AC)</option>
            <option value="DC">Colonnina (DC)</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Ora inizio</label>
          <input
            type="time"
            value={form.startTime}
            onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Ora fine</label>
          <input
            type="time"
            value={form.endTime}
            onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Livello inizio (%)</label>
          <input
            type="number"
            min="0" max="100"
            value={form.startLevel}
            onChange={e => setForm(f => ({ ...f, startLevel: e.target.value }))}
            placeholder="es. 85"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Livello fine (%)</label>
          <input
            type="number"
            min="0" max="100"
            value={form.endLevel}
            onChange={e => setForm(f => ({ ...f, endLevel: e.target.value }))}
            placeholder="es. 90"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Tariffa (€/kWh)</label>
          <input
            type="number"
            step="0.01"
            value={form.costPerKwh}
            onChange={e => setForm(f => ({ ...f, costPerKwh: e.target.value }))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Luogo</label>
          <input
            type="text"
            value={form.location}
            onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
            placeholder="es. Casa, Esselunga..."
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {form.startLevel && form.endLevel && capacity !== null && (
        <div className="rounded-lg bg-gray-900/60 p-3 text-xs text-gray-400">
          Energia stimata: <span className="text-white">
            {(((parseInt(form.endLevel) - parseInt(form.startLevel)) / 100) * capacity).toFixed(1)} kWh
          </span>
          {' · '}Costo: <span className="text-emerald-400">
            €{(((parseInt(form.endLevel) - parseInt(form.startLevel)) / 100) * capacity * parseFloat(form.costPerKwh || '0')).toFixed(2)}
          </span>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving || !form.startLevel || !form.endLevel}
        className="flex items-center justify-center gap-2 w-full p-3 rounded-xl font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-all disabled:opacity-50"
      >
        <Check size={16} />
        {saving ? 'Salvo...' : 'Salva ricarica'}
      </button>
    </div>
  );
}