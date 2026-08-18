import React from 'react';
type StatCardProps = {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.ReactNode;
  sub?: string;
  accent?: 'blue' | 'green' | 'amber' | 'red';
};

const accentMap = {
  blue:  'border-blue-500/40 bg-blue-500/5',
  green: 'border-emerald-500/40 bg-emerald-500/5',
  amber: 'border-amber-500/40 bg-amber-500/5',
  red:   'border-red-500/40 bg-red-500/5',
};

const iconAccentMap = {
  blue:  'text-blue-400',
  green: 'text-emerald-400',
  amber: 'text-amber-400',
  red:   'text-red-400',
};

export default function StatCard({
  label,
  value,
  unit,
  icon,
  sub,
  accent = 'blue',
}: StatCardProps) {
  return (
    <div className={`rounded-2xl border p-5 flex flex-col gap-3 transition-all duration-300 hover:scale-[1.02] ${accentMap[accent]}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
          {label}
        </span>
        <span className={`${iconAccentMap[accent]}`}>{icon}</span>
      </div>
      <div className="flex items-end gap-1.5">
        <span className="text-4xl font-light text-white tabular-nums leading-none">
          {value}
        </span>
        {unit && (
          <span className="text-sm text-gray-400 mb-1">{unit}</span>
        )}
      </div>
      {sub && (
        <p className="text-xs text-gray-400">{sub}</p>
      )}
    </div>
  );
}