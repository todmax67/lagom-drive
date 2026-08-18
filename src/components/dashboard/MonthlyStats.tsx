import { Euro, Zap, Home, MapPin, TrendingDown } from 'lucide-react';

interface ChargingSession {
  id: string;
  startedAt: string;
  endLevel: number | null;
  startLevel: number;
  energyAdded: number | null;
  chargingType: string;
  totalCost: number | null;
  isComplete: boolean;
}

interface VehicleStats {
  tripMeter1Km: number;
  avgConsumptionKwh: number;
}

export default function MonthlyStats({
  sessions,
  stats,
}: {
  sessions: ChargingSession[];
  stats: VehicleStats | null;
}) {
  const now = new Date();
  const thisMonth = sessions.filter((s) => {
    const d = new Date(s.startedAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const totalCost = thisMonth.reduce((sum, s) => sum + (s.totalCost ?? 0), 0);
  const totalKwh = thisMonth.reduce((sum, s) => sum + (s.energyAdded ?? 0), 0);
  const homeSessions = thisMonth.filter((s) => s.chargingType === 'AC');
  const publicSessions = thisMonth.filter((s) => s.chargingType === 'DC');
  const homeCost = homeSessions.reduce((sum, s) => sum + (s.totalCost ?? 0), 0);
  const publicCost = publicSessions.reduce((sum, s) => sum + (s.totalCost ?? 0), 0);

  const costPerKm = stats && stats.tripMeter1Km > 0 && totalCost > 0
    ? (totalCost / stats.tripMeter1Km * 100).toFixed(2)
    : null;

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
        Riepilogo Mese Corrente
      </span>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Euro size={14} className="text-emerald-400" />
            <span className="text-xs text-gray-400">Costo totale</span>
          </div>
          <p className="text-2xl font-light text-white">
            €{totalCost.toFixed(2)}
          </p>
        </div>

        <div className="rounded-xl bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap size={14} className="text-blue-400" />
            <span className="text-xs text-gray-400">kWh ricaricati</span>
          </div>
          <p className="text-2xl font-light text-white">
            {totalKwh.toFixed(1)}
          </p>
        </div>

        <div className="rounded-xl bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Home size={14} className="text-blue-400" />
            <span className="text-xs text-gray-400">Casa</span>
          </div>
          <p className="text-lg font-light text-white">
            €{homeCost.toFixed(2)}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {homeSessions.length} sessioni
          </p>
        </div>

        <div className="rounded-xl bg-gray-900/60 p-4">
          <div className="flex items-center gap-2 mb-2">
            <MapPin size={14} className="text-amber-400" />
            <span className="text-xs text-gray-400">Colonnina</span>
          </div>
          <p className="text-lg font-light text-white">
            €{publicCost.toFixed(2)}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {publicSessions.length} sessioni
          </p>
        </div>
      </div>

      {costPerKm && (
        <div className="flex items-center justify-between border-t border-gray-700/50 pt-4">
          <div className="flex items-center gap-2">
            <TrendingDown size={14} className="text-purple-400" />
            <span className="text-sm text-gray-400">Costo per 100 km</span>
          </div>
          <span className="text-white font-light">€{costPerKm}</span>
        </div>
      )}
    </div>
  );
}