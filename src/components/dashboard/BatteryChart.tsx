'use client';

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface Snapshot {
  createdAt: string;
  level: number;
  isCharging: boolean;
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function BatteryChart({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length < 2) {
    return (
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <p className="text-gray-500 text-sm text-center">
          Il grafico apparirà dopo aver raccolto alcuni dati.
        </p>
      </div>
    );
  }

  const data = snapshots.map((s) => ({
    time: formatTime(s.createdAt),
    level: s.level,
    charging: s.isCharging ? s.level : null,
  }));

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
        Andamento Batteria (ultime 24h)
      </span>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: -20 }}>
          <defs>
            <linearGradient id="batteryGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis
            dataKey="time"
            tick={{ fill: '#6b7280', fontSize: 11 }}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            tickFormatter={(v) => `${v}%`}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
            labelStyle={{ color: '#9ca3af' }}
            itemStyle={{ color: '#fff' }}
            formatter={(value: unknown) => [`${value}%`, 'Batteria']}
          />
          <Area
            type="monotone"
            dataKey="level"
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#batteryGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
