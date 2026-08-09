'use client';

import { useState, useEffect } from 'react';
import { Route, Zap, Battery, TrendingDown, Leaf } from 'lucide-react';

interface Trip {
  id: string;
  startedAt: string;
  endedAt: string;
  distanceKm: number;
  startBattery: number;
  endBattery: number;
  energyUsedKwh: number;
  energyRegenKwh: number;
  // Assente sui viaggi troppo brevi, dove l'arrotondamento dell'1% del SOC
  // renderebbe il valore privo di significato.
  avgConsumption: number | null;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: string, end: string) {
  const diff = new Date(end).getTime() - new Date(start).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

export default function TripHistory() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/api/trips')
      .then(r => r.json())
      .then(setTrips)
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, []);

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <div className="w-6 h-6 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin mx-auto" />
      </div>
    );
  }

  if (trips.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <p className="text-gray-500 text-sm text-center">
          Nessun viaggio registrato ancora. I viaggi appariranno automaticamente quando guidi.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
        Storico Viaggi
      </span>

      <div className="flex flex-col gap-3">
        {trips.map(trip => (
          <div key={trip.id} className="rounded-xl bg-gray-900/60 p-4 flex flex-col gap-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Route size={14} className="text-blue-400" />
                <span className="text-sm font-medium text-white">
                  {trip.distanceKm.toFixed(1)} km
                </span>
              </div>
              <span className="text-xs text-gray-500">
                {formatDate(trip.startedAt)}
              </span>
            </div>

            {/* Dati */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-gray-800/60 p-2.5">
                <p className="text-xs text-gray-500 mb-1">Batteria</p>
                <p className="text-sm text-white font-light">
                  {trip.startBattery}% → {trip.endBattery}%
                </p>
              </div>

              <div className="rounded-lg bg-gray-800/60 p-2.5">
                <p className="text-xs text-gray-500 mb-1">Durata</p>
                <p className="text-sm text-white font-light">
                  {formatDuration(trip.startedAt, trip.endedAt)}
                </p>
              </div>

              <div className="rounded-lg bg-gray-800/60 p-2.5 flex items-start gap-2">
                <TrendingDown size={12} className="text-red-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-gray-500 mb-1">Consumato</p>
                  <p className="text-sm text-white font-light">
                    {trip.energyUsedKwh.toFixed(1)} kWh
                  </p>
                </div>
              </div>

              <div className="rounded-lg bg-gray-800/60 p-2.5 flex items-start gap-2">
                <Leaf size={12} className="text-emerald-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-gray-500 mb-1">Rigenerato</p>
                  <p className="text-sm text-white font-light">
                    {trip.energyRegenKwh.toFixed(1)} kWh
                  </p>
                </div>
              </div>
            </div>

            {/* Consumo medio */}
            {trip.avgConsumption !== null && trip.avgConsumption > 0 && (
              <div className="flex items-center justify-between border-t border-gray-700/50 pt-3">
                <span className="text-xs text-gray-500 flex items-center gap-1">
                  <Zap size={11} />
                  Consumo medio
                </span>
                <span className="text-sm text-white font-light">
                  {trip.avgConsumption.toFixed(1)} kWh/100km
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}