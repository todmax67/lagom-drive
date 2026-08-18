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
    energyGrossKwh: number | null;
    energyRegenGrossKwh: number | null;
    powerCoverage: number | null;
    sessionId: string | null;
  } | null;
  // Quanti ritagli cloud compone questa card (1 = viaggio normale)
  ritagli?: number;
}

/**
 * La ricomposizione (bussola par. 5.2): l'odometro intero frammenta una guida
 * nei ritagli dei semafori, ma la sessione OBD sa che era una. Viaggi contigui
 * (meno di 3 minuti fra fine e inizio) con la STESSA sessione si fondono in
 * una card sola: km sommati, batteria dal primo all'ultimo, integrali sommati
 * — le finestre di aggancio si spartiscono i campioni, quindi la somma non
 * conta niente due volte. Il rilevatore non viene toccato: i ritagli restano
 * in tabella, è la presentazione che li ricompone.
 */
function ricomponi(viaggi: Trip[], codaTronca: boolean): Trip[] {
  const out: Trip[] = [];
  let gruppo: Trip[] = [];

  const stessaGuida = (nuovo: Trip, prec: Trip) =>
    nuovo.obd?.sessionId != null &&
    nuovo.obd.sessionId === prec.obd?.sessionId &&
    prec.endedAt !== null &&
    Math.abs(Date.parse(nuovo.startedAt) - Date.parse(prec.endedAt)) < 3 * 60 * 1000;

  const chiudi = () => {
    if (!gruppo.length) return;
    if (gruppo.length === 1) { out.push(gruppo[0]); gruppo = []; return; }
    // la lista arriva dal piu' recente: il primo del gruppo e' l'ultimo ritaglio
    const vecchio = gruppo[gruppo.length - 1];
    const nuovo = gruppo[0];
    const somma = (f: (t: Trip) => number | null | undefined) => {
      let s = 0;
      for (const v of gruppo) { const x = f(v); if (x == null) return null; s += x; }
      return s;
    };
    // Coperture pesate sulla durata dei ritagli, non il minimo: un ritaglio
    // da 30 secondi non deve dettare la statistica di una guida da 30 minuti
    const durataMs = (v: Trip) => {
      const a = v.obd?.movingStart ?? v.startedAt;
      const b = v.obd?.movingEnd ?? v.endedAt ?? v.startedAt;
      return Math.max(0, Date.parse(b) - Date.parse(a));
    };
    const durataTot = gruppo.reduce((s, v) => s + durataMs(v), 0);
    const pesata = (f: (v: Trip) => number | null | undefined): number | null => {
      if (durataTot === 0) return null;
      let s = 0;
      for (const v of gruppo) {
        const x = f(v);
        if (x == null) return null;
        s += x * durataMs(v);
      }
      return s / durataTot;
    };
    const potPesata = pesata(v => v.obd?.powerCoverage);
    // Il dedotto della guida intera, con le stesse soglie di onesta' del
    // rilevatore: sotto, meglio nessun valore che uno inventato
    const kmFusi = somma(v => v.distanceKm);
    const energiaFusa = somma(v => v.energyUsedKwh);
    const dedottoFuso =
      kmFusi != null && kmFusi >= 10 && energiaFusa != null && energiaFusa >= 1.3
        ? (energiaFusa / kmFusi) * 100
        : null;
    out.push({
      id: gruppo.map(v => v.id).join('+'),
      startedAt: vecchio.startedAt,
      endedAt: nuovo.endedAt,
      distanceKm: kmFusi,
      startBattery: vecchio.startBattery,
      endBattery: nuovo.endBattery,
      energyUsedKwh: energiaFusa,
      energyRegenKwh: somma(v => v.energyRegenKwh),
      avgConsumption: dedottoFuso,
      volvoAvgConsumption: null,
      ritagli: gruppo.length,
      obd: {
        coverage: pesata(v => v.obd?.coverage) ?? Math.min(...gruppo.map(v => v.obd!.coverage)),
        sampleCount: gruppo.reduce((s, v) => s + (v.obd?.sampleCount ?? 0), 0),
        distanceObdKm: somma(v => v.obd?.distanceObdKm),
        maxSpeedKmh: gruppo.some(v => v.obd?.maxSpeedKmh != null)
          ? Math.max(...gruppo.map(v => v.obd?.maxSpeedKmh ?? 0))
          : null,
        socStartObd: vecchio.obd?.socStartObd ?? null,
        socEndObd: nuovo.obd?.socEndObd ?? null,
        movingStart: vecchio.obd?.movingStart ?? null,
        movingEnd: nuovo.obd?.movingEnd ?? null,
        energyGrossKwh: somma(v => v.obd?.energyGrossKwh),
        energyRegenGrossKwh: somma(v => v.obd?.energyRegenGrossKwh),
        powerCoverage: potPesata,
        sessionId: nuovo.obd?.sessionId ?? null,
      },
    });
    gruppo = [];
  };

  for (const v of viaggi) {
    // La lista è dal più recente: v è più vecchio dell'ultimo del gruppo.
    if (gruppo.length && stessaGuida(gruppo[gruppo.length - 1], v)) {
      gruppo.push(v);
      continue;
    }
    chiudi();
    gruppo = [v];
  }
  // L'ultimo gruppo puo' essere tagliato dal limite di pagina della API: un
  // ritaglio fuori lista darebbe una card "ricomposta" con somme parziali.
  // In coda tronca, l'ultimo gruppo resta in ritagli singoli.
  if (codaTronca && gruppo.length > 1) {
    for (const v of gruppo) out.push(v);
    gruppo = [];
  }
  chiudi();
  return out;
}

// Sopra questa copertura il titolo del consumo diventa livello 1: integrato
// dai campioni, non dedotto. Soglia indicativa della bussola (§4.2), da tarare.
const COPERTURA_LIVELLO_1 = 0.95;

// La cascata di provenienza (docs/progetto-obd.md §3): si mostra il migliore
// disponibile, col badge della fonte.
//
// Livello 1 — misurato: ∫V×I sui campioni del regime viaggio, quando la
// copertura regge il badge. Il netto è trazione lorda meno recupero lordo.
//
// Il livello 2 resta VUOTO, e non per svista: volvoAvgConsumption è la media
// dall'ultimo azzeramento MANUALE del contachilometri (16.1-16.6 fisso sullo
// storico mentre i viaggi ballano da 8.2 a 26.8), non un dichiarato
// per-viaggio. Livello 3 — dedotto: ΔSoC × capacità, come sempre.
function consumoConFonte(trip: Trip): { valore: number; fonte: string } | null {
  const obd = trip.obd;
  const km = obd?.distanceObdKm ?? trip.distanceKm;
  if (
    obd &&
    // La copertura che conta è quella della POTENZA: quella globale la
    // gonfierebbero i campioni solo-GPS, che di energia non sanno nulla.
    obd.powerCoverage !== null &&
    obd.powerCoverage >= COPERTURA_LIVELLO_1 &&
    obd.energyGrossKwh !== null &&
    obd.energyRegenGrossKwh !== null &&
    km !== null &&
    km >= 1
  ) {
    const nettoKwh = obd.energyGrossKwh - obd.energyRegenGrossKwh;
    return { valore: (nettoKwh / km) * 100, fonte: 'misurato · ∫V×I' };
  }
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
        {ricomponi(trips, trips.length >= 50).map(trip => (
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
                {trip.ritagli != null && trip.ritagli > 1 && (
                  <span className="text-teal-300/80 mr-2">
                    {trip.ritagli} ritagli ricomposti · sessione OBD
                  </span>
                )}
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

              {/* Il recupero LORDO è metrica solo di livello 1 (§4.2): dal
                  saldo SOC si vede solo in discesa, dall'integrale si misura
                  sempre. Verde-acqua: energia che entra. */}
              {trip.obd?.energyRegenGrossKwh != null && trip.obd.energyRegenGrossKwh > 0.05 &&
                trip.obd.powerCoverage != null && trip.obd.powerCoverage >= COPERTURA_LIVELLO_1 && (
                <div className="rounded-lg bg-gray-800/60 p-2.5 flex items-start gap-2">
                  <Leaf size={12} className="text-teal-300 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Recupero lordo · OBD</p>
                    <p className="text-sm text-white font-light">
                      {trip.obd.energyRegenGrossKwh.toFixed(1)} kWh
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