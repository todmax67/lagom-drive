'use client';

import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Euro, Zap, Home, MapPin, ChevronDown, ChevronUp } from 'lucide-react';

interface MonthData {
  key: string;
  month: string;
  year: number;
  monthNum: number;
  totalCost: number;
  totalKwh: number;
  sessions: number;
  homeSessions: number;
  publicSessions: number;
  homeCost: number;
  publicCost: number;
}

export default function MonthlyHistory() {
  const [data, setData] = useState<MonthData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch('/api/charging/monthly')
      .then(r => r.json())
      .then(setData)
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

  if (data.length === 0) {
    return null;
  }

  // Dati per il grafico — ultimi 12 mesi in ordine cronologico
  const chartData = [...data]
    .slice(0, 12)
    .reverse()
    .map(d => ({
      name: new Date(d.year, d.monthNum - 1).toLocaleDateString('it-IT', { month: 'short' }),
      Casa: parseFloat(d.homeCost.toFixed(2)),
      Colonnina: parseFloat(d.publicCost.toFixed(2)),
      kWh: parseFloat(d.totalKwh.toFixed(1)),
    }));

  const visibleMonths = showAll ? data : data.slice(0, 6);

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-6">
      <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
        Storico Mensile
      </span>

      {/* Grafico */}
      {chartData.length > 1 && (
        <div>
          <p className="text-xs text-gray-500 mb-3">Costo mensile (€)</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 11 }} />
              <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={v => `€${v}`} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
                labelStyle={{ color: '#9ca3af' }}
                formatter={(value: unknown) => [`€${value}`, '']}
              />
              <Legend wrapperStyle={{ fontSize: '11px', color: '#9ca3af' }} />
              <Bar dataKey="Casa" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Colonnina" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Lista mesi */}
      <div className="flex flex-col gap-2">
        {visibleMonths.map(d => (
          <div key={d.key} className="rounded-xl bg-gray-900/60 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-white capitalize">{d.month}</span>
              <span className="text-sm font-medium text-emerald-400">
                €{d.totalCost.toFixed(2)}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex items-center gap-1.5">
                <Zap size={12} className="text-blue-400" />
                <span className="text-xs text-gray-400">
                  {d.totalKwh.toFixed(1)} kWh
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Home size={12} className="text-blue-400" />
                <span className="text-xs text-gray-400">
                  {d.homeSessions} casa
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <MapPin size={12} className="text-amber-400" />
                <span className="text-xs text-gray-400">
                  {d.publicSessions} colonnina
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Mostra tutto / meno */}
      {data.length > 6 && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="flex items-center justify-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          {showAll ? (
            <><ChevronUp size={16} /> Mostra meno</>
          ) : (
            <><ChevronDown size={16} /> Mostra tutti i {data.length} mesi</>
          )}
        </button>
      )}
    </div>
  );
}
