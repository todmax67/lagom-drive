import type { VehicleStats } from '@/types/volvo';
import { Gauge, Zap, Route } from 'lucide-react';
import React from 'react';

export default function StatsCard({ stats }: { stats: VehicleStats }) {
  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
        Statistiche di guida
      </span>

      <div className="grid grid-cols-1 gap-3">
        <div className="flex items-center justify-between p-3 rounded-xl bg-gray-900/60">
          <div className="flex items-center gap-3">
            <Gauge size={16} className="text-blue-400" />
            <span className="text-sm text-gray-300">Velocità media</span>
          </div>
          <span className="text-white font-light">
            {stats.avgSpeedKmh} <span className="text-gray-400 text-xs">km/h</span>
          </span>
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl bg-gray-900/60">
          <div className="flex items-center gap-3">
            <Zap size={16} className="text-amber-400" />
            <span className="text-sm text-gray-300">Consumo medio</span>
          </div>
          <span className="text-white font-light">
            {stats.avgConsumptionKwh} <span className="text-gray-400 text-xs">kWh/100km</span>
          </span>
        </div>

        {stats.odometerKm > 0 && (
          <div className="flex items-center justify-between p-3 rounded-xl bg-gray-900/60">
            <div className="flex items-center gap-3">
              <Route size={16} className="text-blue-400" />
              <span className="text-sm text-gray-300">Km totali</span>
            </div>
            <span className="text-white font-light">
              {stats.odometerKm.toLocaleString('it-IT')} <span className="text-gray-400 text-xs">km</span>
            </span>
          </div>
        )}

        <div className="flex items-center justify-between p-3 rounded-xl bg-gray-900/60">
          <div className="flex items-center gap-3">
            <Route size={16} className="text-emerald-400" />
            <span className="text-sm text-gray-300">Trip A</span>
          </div>
          <span className="text-white font-light">
            {stats.tripMeter1Km} <span className="text-gray-400 text-xs">km</span>
          </span>
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl bg-gray-900/60">
          <div className="flex items-center gap-3">
            <Route size={16} className="text-purple-400" />
            <span className="text-sm text-gray-300">Trip B</span>
          </div>
          <span className="text-white font-light">
            {stats.tripMeter2Km} <span className="text-gray-400 text-xs">km</span>
          </span>
        </div>
      </div>

      <p className="text-xs text-gray-600 text-right">
        Aggiornato: {new Date(stats.lastUpdated).toLocaleTimeString('it-IT')}
      </p>
    </div>
  );
}