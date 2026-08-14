'use client';

import { useState, useEffect } from 'react';
import { Route, Zap, TrendingDown, Leaf, Gauge } from 'lucide-react';

// I nullable rispecchiano lo schema Prisma: i campi energetici mancano sui
// viaggi ricostruiti dallo storico e su quelli troppo brevi per una stima
// onesta, il resto può mancare sui viaggi incompleti.
interface Trip {
  id: string;
  startedAt: string;
  endedAt: string | null;
  distanceKm: number | null;
  startBattery: number;
  endBattery: number | null;
  energyUsedKwh: number | null;
  energyRegenKwh: number | null;
  avgConsumption: number | null;
  volvoAvgConsumption: number | null;
  obd: {
    coverage: number;
    sampleCount: number;
    distanceObdKm: number | null;
    maxSpeedKmh: number | null;
    socStartObd: number | null;
    socEndObd: number | null;
    movingStart: string | null;
    movingEnd: string | null;
  } | null;
}

// La cascata di provenienza (docs/progetto-obd.md §3): si mostra il migliore
// disponibile, col badge della fonte. Il livello 1 (integrato dai campioni)
// arriverà con la potenza confermata.
//
// Il livello 2 oggi è VUOTO, e non per svista: volvoAvgConsumption sembra il
// consumo dichiarato del viaggio ma è la media dall'ultimo azzeramento MANUALE
// del contachilometri — sullo storico vale 16.1-16.6 fisso mentre il dedotto
// dei singoli viaggi balla da 8.2 a 26.8. Mostrarla come consumo del viaggio
// ha prodotto una card con "4.0 kWh consumati" e "16.1 kWh/100km" fianco a
// fianco. Un livello 2 vero esisterà quando avremo un dichiarato per-viaggio;
// fino ad allora il titolo è il dedotto, che almeno parla di QUESTO viaggio.
function consumoConFonte(trip: Trip): { valore: number; fonte: string } | null {
  if (trip.avgConsumption !== null && trip.avgConsumption > 0) {
    return { valore: trip.avgConsumption, fonte: 'dedotto · ΔSoC × capacità' };
  }
  return null;
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
  if (!end) return 'n/d';
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
                  {trip.distanceKm !== null ? `${trip.distanceKm.toFixed(1)} km` : 'distanza n/d'}
                </span>
              </div>
              <span className="text-xs text-gray-500">
                {formatDate(trip.startedAt)}
              </span>
            </div>

            {/* Dati */}
            <div className="grid grid-cols-2 gap-2">
              {/* Attacca e rifinisce (§4.2): quando l'OBD ha misurato, la card
                  mostra la misura col suo marcatore. Una cifra decimale sul
                  SOC: il passo osservato è 0.784%, due decimali dichiarerebbero
                  una precisione che non c'è. */}
              <div className="rounded-lg bg-gray-800/60 p-2.5">
                <p className="text-xs text-gray-500 mb-1">
                  Batteria{trip.obd?.socStartObd != null && trip.obd?.socEndObd != null && ' · OBD'}
                </p>
                <p className="text-sm text-white font-light">
                  {trip.obd?.socStartObd != null && trip.obd?.socEndObd != null
                    ? `${trip.obd.socStartObd.toFixed(1)}% → ${trip.obd.socEndObd.toFixed(1)}%`
                    : `${trip.startBattery}% → ${trip.endBattery ?? '—'}%`}
                </p>
              </div>

              <div className="rounded-lg bg-gray-800/60 p-2.5">
                <p className="text-xs text-gray-500 mb-1">
                  Durata{trip.obd?.movingStart && trip.obd?.movingEnd && ' · OBD'}
                </p>
                <p className="text-sm text-white font-light">
                  {trip.obd?.movingStart && trip.obd?.movingEnd
                    ? formatDuration(trip.obd.movingStart, trip.obd.movingEnd)
                    : formatDuration(trip.startedAt, trip.endedAt)}
                </p>
              </div>

              <div className="rounded-lg bg-gray-800/60 p-2.5 flex items-start gap-2">
                <TrendingDown size={12} className="text-red-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-gray-500 mb-1">Consumato</p>
                  <p className="text-sm text-white font-light">
                    {trip.energyUsedKwh !== null ? `${trip.energyUsedKwh.toFixed(1)} kWh` : 'n/d'}
                  </p>
                </div>
              </div>

              {/* Manca sui viaggi ricostruiti dallo storico: dipende dal consumo
                  medio Volvo del momento, che negli snapshot non è conservato.
                  "Recupero netto" e non "rigenerato": dal solo SOC il recupero
                  è osservabile unicamente a saldo positivo (discesa), il lordo
                  arriverà dall'integrale di potenza (progetto-obd §4.2). */}
              {trip.energyRegenKwh !== null && (
                <div className="rounded-lg bg-gray-800/60 p-2.5 flex items-start gap-2">
                  <Leaf size={12} className="text-emerald-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Recupero netto</p>
                    <p className="text-sm text-white font-light">
                      {trip.energyRegenKwh.toFixed(1)} kWh
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Consumo medio, col badge della fonte: mai un numero senza sapere
                da dove viene. */}
            {(() => {
              const consumo = consumoConFonte(trip);
              return consumo && (
                <div className="flex items-center justify-between border-t border-gray-700/50 pt-3">
                  <span className="text-xs text-gray-500 flex items-center gap-1">
                    <Zap size={11} />
                    Consumo medio
                    <span className="text-gray-600">· {consumo.fonte}</span>
                  </span>
                  <span className="text-sm text-white font-light">
                    {consumo.valore.toFixed(1)} kWh/100km
                  </span>
                </div>
              );
            })()}

            {/* La riga OBD: misure, non stime. Compare solo quando l'accoppiatore
                ha agganciato campioni, e dichiara sempre la copertura. */}
            {trip.obd && (
              <div className="flex items-center justify-between border-t border-gray-700/50 pt-3">
                <span className="text-xs text-gray-500 flex items-center gap-1">
                  <Gauge size={11} className="text-blue-400" />
                  {/* floor, non round: "100%" solo a copertura piena — mai
                      dichiarare più di quanto misurato */}
                  OBD · copertura {Math.floor(trip.obd.coverage * 100)}%
                </span>
                <span className="text-xs text-gray-400 font-light">
                  {trip.obd.distanceObdKm !== null && trip.obd.distanceObdKm > 0 &&
                    `${trip.obd.distanceObdKm.toFixed(1)} km misurati`}
                  {trip.obd.distanceObdKm !== null && trip.obd.distanceObdKm > 0 &&
                    trip.obd.maxSpeedKmh !== null && ' · '}
                  {trip.obd.maxSpeedKmh !== null && `max ${Math.round(trip.obd.maxSpeedKmh)} km/h`}
                  {trip.obd.distanceObdKm === null && trip.obd.maxSpeedKmh === null &&
                    `${trip.obd.sampleCount} campioni senza canale veloce`}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}