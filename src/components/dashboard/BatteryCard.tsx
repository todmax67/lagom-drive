import type { VehicleStatus } from '@/types/volvo';
import { BatteryCharging, Zap } from 'lucide-react';
import React from 'react';

type Props = {
  battery: VehicleStatus['battery'];
};

function getBatteryColor(level: number) {
  if (level > 50) return 'bg-emerald-500';
  if (level > 20) return 'bg-amber-500';
  return 'bg-red-500';
}

function formatMinutes(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

export default function BatteryCard({ battery }: Props) {
  const barColor = getBatteryColor(battery.level);

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
          Batteria
        </span>
        {battery.isCharging && (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 bg-emerald-400/10 px-2.5 py-1 rounded-full">
            <Zap size={11} />
            {battery.chargingType ?? 'In ricarica'}
          </span>
        )}
        {battery.isConnected && !battery.isCharging && (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-blue-400 bg-blue-400/10 px-2.5 py-1 rounded-full">
            <BatteryCharging size={11} />
            Collegata
          </span>
        )}
      </div>

      {/* Percentuale */}
      <div className="flex items-end gap-2">
        <span className="text-6xl font-light text-white tabular-nums leading-none">
          {battery.level}
        </span>
        <span className="text-xl text-gray-400 mb-2">%</span>
      </div>

      {/* Barra */}
      <div className="h-2.5 rounded-full bg-gray-700 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: `${battery.level}%` }}
        />
      </div>

      {/* Info inferiori */}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <div className="rounded-xl bg-gray-900/60 p-3">
          <p className="text-xs text-gray-500 mb-1">Autonomia</p>
          <p className="text-lg font-light text-white">
            {battery.range} <span className="text-sm text-gray-400">km</span>
          </p>
        </div>

        {battery.isCharging && battery.estimatedMinutes != null ? (
          <div className="rounded-xl bg-gray-900/60 p-3">
            <p className="text-xs text-gray-500 mb-1">Completamento</p>
            <p className="text-lg font-light text-white">
              {formatMinutes(battery.estimatedMinutes)}
            </p>
          </div>
        ) : (
          <div className="rounded-xl bg-gray-900/60 p-3">
            <p className="text-xs text-gray-500 mb-1">Stato</p>
            <p className="text-lg font-light text-white">
              {battery.isConnected ? 'Connessa' : 'Disconnessa'}
            </p>
          </div>
        )}
      </div>

      {/* Dettagli ricarica */}
      {battery.isCharging && battery.currentAmps != null && battery.voltageVolts != null && (
        <div className="border-t border-gray-700/50 pt-4 flex items-center justify-between text-sm">
          <span className="text-gray-500">
            {battery.currentAmps} A · {battery.voltageVolts} V
          </span>
          <span className="text-emerald-400 font-medium">
            ~{((battery.currentAmps * battery.voltageVolts) / 1000).toFixed(1)} kW
          </span>
        </div>
      )}
    </div>
  );
}