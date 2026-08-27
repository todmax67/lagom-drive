'use client';

import { useState, useEffect } from 'react';
import { Save, Home, MapPin, Battery } from 'lucide-react';

interface Settings {
  homeTariff: number;
  publicTariff: number;
  batteryCapacity: number;
  batteryCapacityNominal: number;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    homeTariff: 0.25,
    publicTariff: 0.50,
    batteryCapacity: 67.0,
    batteryCapacityNominal: 67.0,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setSettings({
          homeTariff: data.homeTariff,
          publicTariff: data.publicTariff,
          batteryCapacity: data.batteryCapacity,
          batteryCapacityNominal: data.batteryCapacityNominal ?? 67.0,
        });
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSaved(false);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Errore salvataggio:', err);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="w-8 h-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-lg flex flex-col gap-4">

      {/* Tariffe */}
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-5">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
          Tariffe Energia
        </span>

        {/* Casa */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <Home size={14} className="text-blue-400" />
            Tariffa Casa (€/kWh)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              step="0.01"
              min="0"
              max="10"
              value={settings.homeTariff}
              onChange={e => setSettings(s => ({ ...s, homeTariff: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
            />
            <span className="text-gray-400 text-sm whitespace-nowrap">€/kWh</span>
          </div>
          <p className="text-xs text-gray-500">
            Costo energia dalla rete domestica. Controlla la tua bolletta.
          </p>
        </div>

        {/* Colonnina */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <MapPin size={14} className="text-amber-400" />
            Tariffa Colonnina Pubblica (€/kWh)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              step="0.01"
              min="0"
              max="10"
              value={settings.publicTariff}
              onChange={e => setSettings(s => ({ ...s, publicTariff: parseFloat(e.target.value) || 0 }))}
              className="w-full bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
            />
            <span className="text-gray-400 text-sm whitespace-nowrap">€/kWh</span>
          </div>
          <p className="text-xs text-gray-500">
            Tariffa media delle colonnine pubbliche che utilizzi.
          </p>
        </div>
      </div>

      {/* Veicolo */}
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-5">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
          Veicolo
        </span>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <Battery size={14} className="text-emerald-400" />
            Capacità Batteria (kWh)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              step="0.1"
              min="10"
              max="200"
              value={settings.batteryCapacity}
              onChange={e => setSettings(s => ({ ...s, batteryCapacity: parseFloat(e.target.value) || 67 }))}
              className="w-full bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
            />
            <span className="text-gray-400 text-sm whitespace-nowrap">kWh</span>
          </div>
          <p className="text-xs text-gray-500">
            La capacità <strong className="text-gray-400">di lavoro</strong>: quella con cui si
            deducono i kWh dal salto di carica, nei viaggi e nelle ricariche. Si
            promuove quando i testimoni concordano, non è un dato di targa.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <Battery size={14} className="text-gray-500" />
            Capacità nominale (kWh)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              step="0.1"
              min="10"
              max="200"
              value={settings.batteryCapacityNominal}
              onChange={e =>
                setSettings(s => ({
                  ...s,
                  batteryCapacityNominal: parseFloat(e.target.value) || 67,
                }))
              }
              className="w-full bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 transition-colors"
            />
            <span className="text-gray-400 text-sm whitespace-nowrap">kWh</span>
          </div>
          <p className="text-xs text-gray-500">
            L&apos;utile <strong className="text-gray-400">da nuova</strong>, che le promozioni non
            toccano: è il metro contro cui si legge il degrado, e il denominatore
            implicito del SoH — che è una percentuale dell&apos;originale, non di quella
            di lavoro. XC40 Recharge: 67 kWh utili (69 lordi) — EX30: 51 kWh.
            {settings.batteryCapacityNominal > 0 &&
              settings.batteryCapacity !== settings.batteryCapacityNominal && (
                <>
                  {' '}Oggi la di lavoro è il{' '}
                  {(
                    (settings.batteryCapacity / settings.batteryCapacityNominal) *
                    100
                  ).toFixed(1)}
                  % della nominale.
                </>
              )}
          </p>
        </div>
      </div>

      {/* Anteprima calcolo */}
      <div className="rounded-2xl border border-gray-700/30 bg-gray-900/40 p-4 flex flex-col gap-2">
        <p className="text-xs text-gray-400 font-medium">Anteprima calcolo — ricarica dal 20% al 80%</p>
        <div className="grid grid-cols-2 gap-3 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <Home size={10} /> Casa
            </span>
            <span className="text-xs text-white">
              €{((settings.batteryCapacity * 0.6) * settings.homeTariff).toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400 flex items-center gap-1">
              <MapPin size={10} /> Colonnina
            </span>
            <span className="text-xs text-white">
              €{((settings.batteryCapacity * 0.6) * settings.publicTariff).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Salva */}
      <button
        onClick={handleSave}
        disabled={isSaving}
        className={`flex items-center justify-center gap-2 w-full p-4 rounded-xl font-semibold transition-all duration-200 ${
          saved
            ? 'bg-emerald-600 text-white'
            : 'bg-blue-600 hover:bg-blue-500 text-white hover:scale-[1.02] shadow-lg shadow-blue-500/20'
        } disabled:opacity-50`}
      >
        <Save size={18} />
        {isSaving ? 'Salvataggio...' : saved ? 'Salvato!' : 'Salva Impostazioni'}
      </button>
    </div>
  );
}