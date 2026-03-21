import { Euro, Zap, Home, MapPin, Clock } from 'lucide-react';

interface ChargingSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startLevel: number;
  endLevel: number | null;
  energyAdded: number | null;
  chargingType: string;
  totalCost: number | null;
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

export default function ChargingHistory({ sessions }: { sessions: ChargingSession[] }) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <p className="text-gray-500 text-sm text-center">
          Nessuna sessione di ricarica registrata ancora.
          I dati appariranno automaticamente alla prossima ricarica.
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
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`rounded-xl p-4 flex flex-col gap-3 ${
              s.isComplete ? 'bg-gray-900/60' : 'bg-emerald-500/5 border border-emerald-500/20'
            }`}
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {s.chargingType === 'DC'
                  ? <MapPin size={14} className="text-amber-400" />
                  : <Home size={14} className="text-blue-400" />
                }
                <span className="text-sm font-medium text-white">
                  {s.location ?? (s.chargingType === 'DC' ? 'Colonnina' : 'Casa')}
                </span>
                {!s.isComplete && (
                  <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">
                    In corso
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-500">
                {formatDate(s.startedAt)}
              </span>
            </div>

            {/* Dati */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-gray-800/60 p-2.5">
                <p className="text-xs text-gray-500 mb-1">Livello</p>
                <p className="text-sm text-white font-light">
                  {s.startLevel}% → {s.endLevel ?? '...'}%
                </p>
              </div>

              <div className="rounded-lg bg-gray-800/60 p-2.5">
                <p className="text-xs text-gray-500 mb-1">Energia</p>
                <p className="text-sm text-white font-light">
                  {s.energyAdded != null
                    ? `${s.energyAdded.toFixed(1)} kWh`
                    : '...'
                  }
                </p>
              </div>

              <div className="rounded-lg bg-gray-800/60 p-2.5">
                <p className="text-xs text-gray-500 mb-1">Durata</p>
                <p className="text-sm text-white font-light">
                  {formatDuration(s.startedAt, s.endedAt)}
                </p>
              </div>
            </div>

            {/* Costo */}
            {s.totalCost != null && (
              <div className="flex items-center justify-between border-t border-gray-700/50 pt-3">
                <span className="text-xs text-gray-500 flex items-center gap-1">
                  <Euro size={11} />
                  Costo sessione
                </span>
                <span className="text-sm font-medium text-emerald-400">
                  €{s.totalCost.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}