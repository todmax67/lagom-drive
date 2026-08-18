'use client';

import { useState, useEffect } from 'react';

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

// Il profilo di potenza servito da /api/obd/profilo: secchi uniformi sulla
// finestra del viaggio, buchi dichiarati, temperatura media di contorno.
interface Profilo {
  secchi: { pos: number; neg: number; dati: boolean }[];
  ambientC: number | null;
  gapSec: number | null;
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
function consumoConFonte(trip: Trip): { valore: number; misurato: boolean } | null {
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
    return { valore: (nettoKwh / km) * 100, misurato: true };
  }
  if (trip.avgConsumption !== null && trip.avgConsumption > 0) {
    return { valore: trip.avgConsumption, misurato: false };
  }
  return null;
}

// Sotto questo salto di SoC la capacità implicita è rumore di quantizzazione:
// il display si muove a passi di 0.784%, e su un delta piccolo l'errore agli
// estremi domina il numero. A 8 punti l'incertezza è già ~±10%.
const DELTA_SOC_MIN_CAPACITA = 8;

// Numeri all'italiana: virgola, non punto
const it = (n: number, decimali = 1) =>
  n.toLocaleString('it-IT', {
    minimumFractionDigits: decimali,
    maximumFractionDigits: decimali,
  });

// "gio 14 ago", con l'iniziale maiuscola del mock
function dataGiorno(dateStr: string) {
  const s = new Date(dateStr).toLocaleDateString('it-IT', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ora = (dateStr: string) =>
  new Date(dateStr).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

function formatDuration(start: string, end: string | null) {
  if (!end) return 'n/d';
  const diff = new Date(end).getTime() - new Date(start).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

/**
 * Il profilo del viaggio: trazione sopra la linea (corallo), recupero sotto
 * (verde-acqua), e i buchi come bande grigie — mai come zeri inventati. La
 * linea di base si sposta in proporzione ai due massimi, così un viaggio di
 * discesa dà al recupero lo spazio che si è guadagnato.
 */
function GraficoPotenza({ profilo }: { profilo: Profilo }) {
  const { secchi } = profilo;
  if (secchi.length < 2) return null;

  const W = 600;
  const H = 110;
  const n = secchi.length;
  const maxPos = Math.max(...secchi.map(s => s.pos), 0.5);
  const maxNeg = Math.max(...secchi.map(s => -s.neg), 0.5);
  const quotaPos = Math.min(0.85, Math.max(0.5, maxPos / (maxPos + maxNeg)));
  const base = Math.round(H * quotaPos);
  const yPos = (v: number) => base - (v / maxPos) * (base - 4);
  const yNeg = (v: number) => base + ((-v) / maxNeg) * (H - base - 4);

  // A gradini, non a pendii: ogni secchio è un blocco a livello costante con
  // fronti verticali fra un secchio e l'altro — i passaggi trazione/recupero
  // restano netti invece di sciogliersi in triangoli. Il passo è il bordo del
  // secchio, così anche le bande grigie combaciano coi blocchi.
  const passo = W / n;
  const gradini = (livello: (s: { pos: number; neg: number; dati: boolean }) => number) =>
    secchi
      .map((s, i) => {
        const y = (s.dati ? livello(s) : base).toFixed(1);
        return `L${(i * passo).toFixed(1)},${y} L${((i + 1) * passo).toFixed(1)},${y}`;
      })
      .join(' ');
  const puntiPos = gradini(s => yPos(s.pos));
  const puntiNeg = gradini(s => yNeg(s.neg));

  // Le bande grigie: sequenze di secchi senza dati
  const bande: { da: number; a: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (secchi[i].dati) continue;
    if (bande.length && bande[bande.length - 1].a === i - 1) bande[bande.length - 1].a = i;
    else bande.push({ da: i, a: i });
  }

  // Sotto i 45 s il "senza dati" è residuo di bordo, non un buco da legenda;
  // sopra, si dichiara al minuto col segno di approssimazione — mai troncando
  // in silenzio fino a mezzo minuto di buco
  const gapSec = profilo.gapSec ?? 0;
  const gapEtichetta =
    gapSec >= 45 ? `≈${Math.max(1, Math.round(gapSec / 60))} min senza dati` : null;

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-24"
        role="img"
        aria-label="Profilo di potenza del viaggio"
      >
        <path
          d={`M0,${base} ${puntiPos} L${W},${base} Z`}
          fill="rgb(251 146 60 / 0.55)"
        />
        <path
          d={`M0,${base} ${puntiNeg} L${W},${base} Z`}
          fill="rgb(45 212 191 / 0.6)"
        />
        {bande.map((b, i) => (
          <rect
            key={i}
            x={(b.da * passo).toFixed(1)}
            y={0}
            width={((b.a - b.da + 1) * passo).toFixed(1)}
            height={H}
            fill="rgb(107 114 128 / 0.25)"
          />
        ))}
        <line x1={0} y1={base} x2={W} y2={base} stroke="rgb(75 85 99 / 0.6)" strokeWidth={1} />
      </svg>
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-orange-400/80" />
          potenza spesa
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-teal-400/80" />
          recupero
        </span>
        {gapEtichetta && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-gray-500/40" />
            {gapEtichetta}
          </span>
        )}
      </div>
    </div>
  );
}

// Una riga del bilancio energetico: etichetta, barra in scala, valore
function BarraEnergia({
  etichetta,
  kwh,
  massimo,
  classe,
  negativo,
}: {
  etichetta: string;
  kwh: number;
  massimo: number;
  classe: string;
  negativo?: boolean;
}) {
  const larghezza = Math.max(4, Math.min(100, (Math.abs(kwh) / massimo) * 100));
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-400 w-24 shrink-0">{etichetta}</span>
      <div className="flex-1">
        <div
          className={`h-2 rounded-full ${classe}`}
          style={{ width: `${larghezza}%` }}
        />
      </div>
      <span className="text-sm text-white font-light w-14 text-right tabular-nums">
        {negativo ? '−' : ''}{it(Math.abs(kwh), 2)}
      </span>
    </div>
  );
}

/**
 * La card di un viaggio misurato: il consumo integrato in grande, il profilo
 * di potenza, il bilancio del pacco, e in calce la copertura e il punto di
 * capacità implicita quando il salto di SoC lo regge.
 *
 * "Di cui clima" del mock resta fuori di proposito: hvacPowerW si legge solo
 * nelle sonde da fermo, il regime viaggio non lo campiona — la riga comparirà
 * quando sarà una misura, non prima.
 */
function CardMisurata({
  trip,
  confronto,
  onSalute,
}: {
  trip: Trip;
  confronto: { delta: number; base: number } | null;
  onSalute?: () => void;
}) {
  const [profilo, setProfilo] = useState<Profilo | null>(null);
  const obd = trip.obd!;

  const inizio = obd.movingStart ?? trip.startedAt;
  const fine = obd.movingEnd ?? trip.endedAt;

  useEffect(() => {
    if (!fine) return;
    const qs = new URLSearchParams({ da: inizio, a: fine });
    fetch(`/api/obd/profilo?${qs}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && Array.isArray(d.secchi)) setProfilo(d); })
      .catch(() => {});
  }, [inizio, fine]);

  // Stessa cascata di consumoConFonte (OBD prima del cloud): il numero grande
  // e il confronto con la mediana devono dividere per gli STESSI km
  const km = obd.distanceObdKm ?? trip.distanceKm;
  const lordo = obd.energyGrossKwh!;
  const recupero = obd.energyRegenGrossKwh!;
  const netto = lordo - recupero;
  const consumo = km && km >= 1 ? (netto / km) * 100 : null;

  // Il punto per Salute: capacità implicita = netto / ΔSoC. Solo quando il
  // salto di SoC supera la soglia anti-quantizzazione, e senza decimali: con
  // ~±10% di incertezza, i decimali dichiarerebbero una precisione che non c'è.
  const deltaSoc =
    obd.socStartObd != null && obd.socEndObd != null
      ? obd.socStartObd - obd.socEndObd
      : null;
  const capacitaImplicita =
    deltaSoc != null && deltaSoc >= DELTA_SOC_MIN_CAPACITA && netto > 0
      ? (netto / deltaSoc) * 100
      : null;

  return (
    <div className="rounded-xl bg-gray-900/60 p-4 flex flex-col gap-3">
      {/* Header: giorno, orari rifiniti, riga dei fatti */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-white">
            {dataGiorno(trip.startedAt)} · {ora(inizio)} {fine && <>→ {ora(fine)}</>}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {km != null && `${it(km, 1)} km`}
            {fine && ` · ${formatDuration(inizio, fine)}`}
            {profilo?.ambientC != null && ` · ${Math.round(profilo.ambientC)} °C`}
            {obd.socStartObd != null && obd.socEndObd != null &&
              ` · SoC ${it(obd.socStartObd, 1)} → ${it(obd.socEndObd, 1)}%`}
          </p>
          {trip.ritagli != null && trip.ritagli > 1 && (
            <p className="text-xs text-teal-300/80 mt-0.5">
              {trip.ritagli} ritagli ricomposti · sessione OBD
            </p>
          )}
        </div>
        <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full shrink-0">
          misurato OBD
        </span>
      </div>

      {/* Il numero grande: kWh/100 km netti dall'integrale */}
      {consumo != null && (
        <div className="flex items-end justify-between gap-2">
          <p className="text-white">
            <span className="text-3xl font-light tabular-nums">{it(consumo, 1)}</span>
            <span className="text-sm text-gray-400 ml-1.5">kWh/100 km netti</span>
          </p>
          {confronto && (
            <span className="text-xs text-gray-400 mb-1">
              {confronto.delta >= 0 ? '+' : '−'}{Math.abs(Math.round(confronto.delta))}%{' '}
              vs la tua mediana ({confronto.base} misurati)
            </span>
          )}
        </div>
      )}

      {profilo && profilo.secchi.length >= 2 && <GraficoPotenza profilo={profilo} />}

      {/* Il bilancio del pacco: i due popoli e il saldo */}
      <div className="flex flex-col gap-2">
        <BarraEnergia etichetta="Trazione" kwh={lordo} massimo={Math.max(lordo, 0.1)} classe="bg-orange-500/90" />
        <BarraEnergia etichetta="Recupero" kwh={recupero} massimo={Math.max(lordo, 0.1)} classe="bg-teal-400/90" negativo />
      </div>
      <div className="flex items-center justify-between border-t border-gray-700/50 pt-2.5">
        <span className="text-sm font-medium text-white">Netto dal pacco</span>
        <span className="text-sm font-medium text-white tabular-nums">{it(netto, 2)} kWh</span>
      </div>

      {/* Calce: la copertura dichiara, il punto di capacità deposita */}
      <div className="flex items-center justify-between gap-2 border-t border-gray-700/50 pt-2.5 flex-wrap">
        <span className="text-xs text-gray-500">
          {/* floor, non round: "100%" solo a copertura piena */}
          Copertura {Math.floor((obd.powerCoverage ?? 0) * 100)}%
          {obd.movingStart && obd.movingEnd && ' · tempi rifiniti dai campioni'}
          {obd.maxSpeedKmh != null && ` · max ${Math.round(obd.maxSpeedKmh)} km/h`}
        </span>
        {capacitaImplicita != null && (
          <button
            onClick={onSalute}
            className="text-xs text-indigo-300 bg-indigo-400/10 hover:bg-indigo-400/20 px-2 py-0.5 rounded-full transition-colors"
            title="Punto per il testimone C: netto misurato diviso salto di SoC. La capacità di lavoro resta 67 finché la promozione non è deliberata (bussola §4.4)."
          >
            capacità ~{Math.round(capacitaImplicita)} kWh → Salute
          </button>
        )}
      </div>
    </div>
  );
}

// La card compatta dei viaggi senza integrale: due righe, il dedotto a destra.
// Il badge dice "dedotto" e mai "trip meter Volvo": il per-viaggio dichiarato
// non esiste nell'API (livello 2 vuoto, vedi consumoConFonte).
function CardCompatta({ trip }: { trip: Trip }) {
  const consumo = consumoConFonte(trip);
  // La coppia SoC da UNA fonte sola: OBD se completa, altrimenti cloud. Una
  // freccia con inizio cloud e fine OBD (possibile sulle card ricomposte)
  // mescolerebbe due metri diversi senza dichiararlo.
  const socObd = trip.obd?.socStartObd != null && trip.obd?.socEndObd != null;
  const socInizio = socObd ? trip.obd!.socStartObd! : trip.startBattery;
  const socFine = socObd ? trip.obd!.socEndObd : trip.endBattery;
  // Attacca e rifinisce (§4.2) vale anche qui: i tempi testimoniati dai
  // campioni, quando ci sono entrambi, battono la ricostruzione cloud
  const rifinito = trip.obd?.movingStart != null && trip.obd?.movingEnd != null;
  const obdParziale = trip.obd != null;

  return (
    <div className="rounded-xl bg-gray-900/60 p-4 flex items-start justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-white">
          {dataGiorno(trip.startedAt)} · {ora(rifinito ? trip.obd!.movingStart! : trip.startedAt)}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">
          {trip.distanceKm != null ? `${it(trip.distanceKm, 1)} km` : 'distanza n/d'}
          {` · ${rifinito
            ? formatDuration(trip.obd!.movingStart!, trip.obd!.movingEnd!)
            : formatDuration(trip.startedAt, trip.endedAt)}`}
          {socFine != null &&
            ` · ${Math.round(socInizio)} → ${Math.round(socFine)}%`}
        </p>
        {obdParziale && (
          <p className="text-xs text-gray-600 mt-0.5">
            OBD parziale · copertura {Math.floor((trip.obd!.coverage ?? 0) * 100)}%
          </p>
        )}
      </div>
      {consumo && (
        <div className="text-right shrink-0">
          <p className="text-sm text-white font-light tabular-nums">
            {it(consumo.valore, 1)} <span className="text-gray-500 text-xs">kWh/100 km</span>
          </p>
          <span className="inline-block mt-1 text-xs text-gray-400 bg-gray-700/40 px-2 py-0.5 rounded-full">
            dedotto · ΔSoC × capacità
          </span>
        </div>
      )}
    </div>
  );
}

export default function TripHistory({ onSalute }: { onSalute?: () => void }) {
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

  const ricomposti = ricomponi(trips, trips.length >= 50);

  // Il confronto del numero grande: la mediana degli ALTRI viaggi misurati in
  // lista. Mediana e non media: con pochi punti, un'andata in salita non deve
  // spostare il metro. Sotto tre termini di paragone, niente confronto.
  const misurati = ricomposti
    .map(t => ({ id: t.id, c: consumoConFonte(t) }))
    .filter(x => x.c?.misurato)
    .map(x => ({ id: x.id, valore: x.c!.valore }));
  const confrontoPer = (id: string): { delta: number; base: number } | null => {
    const altri = misurati.filter(m => m.id !== id).map(m => m.valore);
    if (altri.length < 3) return null;
    const ordinati = [...altri].sort((a, b) => a - b);
    const mediana =
      ordinati.length % 2
        ? ordinati[(ordinati.length - 1) / 2]
        : (ordinati[ordinati.length / 2 - 1] + ordinati[ordinati.length / 2]) / 2;
    const proprio = misurati.find(m => m.id === id)!.valore;
    if (mediana <= 0) return null;
    return { delta: ((proprio - mediana) / mediana) * 100, base: altri.length };
  };

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
        Storico Viaggi
      </span>

      <div className="flex flex-col gap-3">
        {ricomposti.map(trip =>
          consumoConFonte(trip)?.misurato ? (
            <CardMisurata
              key={trip.id}
              trip={trip}
              confronto={confrontoPer(trip.id)}
              onSalute={onSalute}
            />
          ) : (
            <CardCompatta key={trip.id} trip={trip} />
          )
        )}
      </div>
    </div>
  );
}
