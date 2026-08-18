'use client';

import { useState, useEffect } from 'react';
import { HeartPulse } from 'lucide-react';

/**
 * La pagina Salute (bussola §4.4): il processo ai tre testimoni, reso come
 * serie temporale che si costruisce da sola man mano che i punti si depositano.
 *
 * Rispetto al mock di studio, tre assenze deliberate:
 * - "in linea con la flotta": non esiste una fonte dati di flotta — un
 *   confronto inventato sarebbe il contrario del progetto;
 * - la tendenza %/anno: si disegna solo quando la serie la regge (≥ 8 punti
 *   di capacità su ≥ 4 mesi), non prima;
 * - "misurata: NN — promuovi?": la promozione della capacità è una questione
 *   parcheggiata per decisione dell'utente, e resta un atto deliberato.
 * Il "parassita NN mA" manca perché nessun DID lo misura ancora.
 */

interface Salute {
  capacitaLavoro: number;
  soh: {
    serie: { t: string; v: number }[];
    ultimo: number | null;
    letture: number;
    dal: string | null;
    valoriDistinti: number;
  };
  viaggi: { t: string; kwh: number }[];
  muro: { t: string; kwh: number }[];
}

interface Mattina {
  giorno: string;
  ora: string;
  batt12v: number | null;
}

const it = (n: number, decimali = 1) =>
  n.toLocaleString('it-IT', {
    minimumFractionDigits: decimali,
    maximumFractionDigits: decimali,
  });

const dataBreve = (iso: string) =>
  new Date(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });

// La tendenza si disegna solo quando la serie la regge
const PUNTI_MIN_TENDENZA = 8;
const GIORNI_MIN_TENDENZA = 120;

/**
 * Il grafico dei testimoni: capacità (kWh, asse sinistro) dai viaggi e dalle
 * coppie muro, SoH (%, asse destro) dal registro BECM. Ogni punto è una
 * deposizione; la retta di tendenza arriverà quando i punti basteranno.
 */
function GraficoSalute({ dati, oggi }: { dati: Salute; oggi: number }) {
  const W = 700;
  const H = 240;
  const SX = 46; // margine sinistro: etichette kWh
  const DX = 46; // margine destro: etichette %
  const ALTO = 14;
  const BASSO = 26;

  const punti = [
    ...dati.viaggi.map(p => ({ ...p, serie: 'viaggi' as const })),
    ...dati.muro.map(p => ({ ...p, serie: 'muro' as const })),
  ];
  const tempi = [
    ...punti.map(p => Date.parse(p.t)),
    ...dati.soh.serie.map(p => Date.parse(p.t)),
  ];
  if (tempi.length === 0) return null;

  // Dominio X: dai primi punti a oggi, mai più stretto di 30 giorni — con
  // due giorni di dati il grafico deve già respirare come una serie
  const GIORNO_MS = 24 * 3600 * 1000;
  let x0 = Math.min(...tempi);
  const x1 = oggi + 2 * GIORNO_MS;
  if (x1 - x0 < 30 * GIORNO_MS) x0 = x1 - 30 * GIORNO_MS;
  x0 -= 2 * GIORNO_MS;

  // Dominio Y sinistro (kWh): fisso e largo finché i punti non chiedono altro
  const kwhValori = punti.map(p => p.kwh);
  const yMin = Math.min(58, ...kwhValori.map(v => Math.floor(v - 2)));
  const yMax = Math.max(70, ...kwhValori.map(v => Math.ceil(v + 2)));
  // Dominio Y destro (%): la banda del SoH
  const sohValori = dati.soh.serie.map(p => p.v);
  const sMin = Math.min(92, ...sohValori.map(v => Math.floor(v - 1)));
  const sMax = Math.max(96, ...sohValori.map(v => Math.ceil(v + 1)));

  const px = (t: number) => SX + ((t - x0) / (x1 - x0)) * (W - SX - DX);
  const pyKwh = (v: number) => ALTO + (1 - (v - yMin) / (yMax - yMin)) * (H - ALTO - BASSO);
  const pySoh = (v: number) => ALTO + (1 - (v - sMin) / (sMax - sMin)) * (H - ALTO - BASSO);

  // Tacche X: i primi del mese dentro il dominio (o il dominio stesso se corto)
  const tacche: { t: number; label: string }[] = [];
  const cursore = new Date(x0);
  cursore.setDate(1);
  cursore.setHours(0, 0, 0, 0);
  for (let i = 0; i < 24; i++) {
    cursore.setMonth(cursore.getMonth() + 1);
    const t = cursore.getTime();
    if (t > x1) break;
    if (t >= x0)
      tacche.push({
        t,
        label: cursore.toLocaleDateString('it-IT', { month: 'short' }),
      });
  }
  if (tacche.length === 0) {
    tacche.push({ t: x0 + (x1 - x0) / 2, label: dataBreve(new Date((x0 + x1) / 2).toISOString()) });
  }

  // Griglia Y sinistra: 4 livelli equidistanti arrotondati al kWh
  const griglia = [0, 1, 2, 3].map(i => Math.round(yMin + ((yMax - yMin) * i) / 3));

  // La tendenza solo quando la serie la regge: regressione sui soli punti dei
  // viaggi (il muro contiene η: è un metro diverso, non si mescola)
  const vt = dati.viaggi.map(p => ({ x: Date.parse(p.t), y: p.kwh }));
  const spanGiorni = vt.length ? (vt[vt.length - 1].x - vt[0].x) / GIORNO_MS : 0;
  let tendenza: { a: number; b: number } | null = null;
  if (vt.length >= PUNTI_MIN_TENDENZA && spanGiorni >= GIORNI_MIN_TENDENZA) {
    const mx = vt.reduce((s, p) => s + p.x, 0) / vt.length;
    const my = vt.reduce((s, p) => s + p.y, 0) / vt.length;
    const num = vt.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    const den = vt.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    if (den > 0) tendenza = { b: num / den, a: my - (num / den) * mx };
  }

  return (
    <div className="rounded-xl bg-gray-900/60 p-4 flex flex-col gap-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Serie dei testimoni della salute batteria">
        {griglia.map(v => (
          <g key={v}>
            <line x1={SX} y1={pyKwh(v)} x2={W - DX} y2={pyKwh(v)} stroke="rgb(75 85 99 / 0.25)" strokeDasharray="3 4" />
            <text x={SX - 6} y={pyKwh(v) + 3} textAnchor="end" fontSize="10" fill="rgb(156 163 175)">
              {v}
            </text>
          </g>
        ))}
        <text x={SX - 6} y={ALTO - 2} textAnchor="end" fontSize="9" fill="rgb(107 114 128)">kWh</text>
        {[sMin, sMax].map(v => (
          <text key={v} x={W - DX + 6} y={pySoh(v) + 3} textAnchor="start" fontSize="10" fill="rgb(156 163 175)">
            {v}%
          </text>
        ))}
        {tacche.map(m => (
          <text key={m.t} x={px(m.t)} y={H - 8} textAnchor="middle" fontSize="10" fill="rgb(107 114 128)">
            {m.label}
          </text>
        ))}

        {tendenza && (
          <line
            x1={px(vt[0].x)}
            y1={pyKwh(tendenza.a + tendenza.b * vt[0].x)}
            x2={px(oggi)}
            y2={pyKwh(tendenza.a + tendenza.b * oggi)}
            stroke="rgb(156 163 175 / 0.7)"
            strokeDasharray="5 5"
            strokeWidth="1.5"
          />
        )}

        {dati.soh.serie.map((p, i) => {
          const cx = px(Date.parse(p.t));
          const cy = pySoh(p.v);
          return (
            <rect
              key={`s${i}`}
              x={cx - 4}
              y={cy - 4}
              width={8}
              height={8}
              transform={`rotate(45 ${cx} ${cy})`}
              fill="rgb(167 139 250)"
            />
          );
        })}
        {punti.map((p, i) => (
          <circle
            key={`c${i}`}
            cx={px(Date.parse(p.t))}
            cy={pyKwh(p.kwh)}
            r={4.5}
            fill={p.serie === 'viaggi' ? 'rgb(209 213 219)' : 'rgb(52 211 153)'}
          />
        ))}

        {punti.length === 0 && (
          <text x={SX + (W - SX - DX) / 2} y={H / 2} textAnchor="middle" fontSize="11" fill="rgb(107 114 128)">
            I punti di capacità si depositano: viaggi con ΔSoC ≥ 8 e ricariche col contatore
          </text>
        )}
      </svg>

      <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-gray-300" />
          viaggi (∫V×I ÷ ΔSoC)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          ricariche (muro ÷ Δ, η inclusa)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rotate-45 bg-violet-400" />
          SoH BECM, in validazione
        </span>
        {tendenza && (
          <span className="flex items-center gap-1.5">
            <span className="w-3 border-t border-dashed border-gray-400" />
            tendenza
          </span>
        )}
      </div>
    </div>
  );
}

export default function SalutePage() {
  const [dati, setDati] = useState<Salute | null>(null);
  const [mattine, setMattine] = useState<Mattina[] | null>(null);
  const [errore, setErrore] = useState(false);
  // "Oggi" fissato al mount: il render deve restare puro (react-hooks/purity)
  const [oggi] = useState(() => Date.now());

  useEffect(() => {
    fetch('/api/salute')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setDati)
      .catch(() => setErrore(true));
    fetch('/api/obd/buongiorno')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => { if (Array.isArray(d.mattine)) setMattine(d.mattine); })
      .catch(() => {});
  }, []);

  if (errore) {
    return (
      <div className="max-w-2xl rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <p className="text-sm text-gray-500">La pagina Salute non riesce a leggere l&apos;archivio. Riprova.</p>
      </div>
    );
  }

  if (!dati) {
    return (
      <div className="max-w-2xl rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
        <div className="w-6 h-6 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin mx-auto" />
      </div>
    );
  }

  const puntiCapacita = dati.viaggi.length + dati.muro.length;
  const ultimaMattina12v = mattine?.filter(m => m.batt12v != null).at(-1) ?? null;

  return (
    <div className="max-w-3xl rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      {/* Intestazione: lo stato del processo, senza sentenze premature */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase flex items-center gap-2">
          <HeartPulse size={13} className="text-rose-300" />
          Salute della batteria
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-amber-300/90 bg-amber-400/10 px-2 py-0.5 rounded-full">
            in raccolta · la sentenza matura
          </span>
          <span className="text-xs text-gray-500">
            {puntiCapacita} punt{puntiCapacita === 1 ? 'o' : 'i'} di capacità ·{' '}
            {dati.soh.serie.length} giorn{dati.soh.serie.length === 1 ? 'o' : 'i'} di SoH ·
            tendenza da {PUNTI_MIN_TENDENZA} punti su 4 mesi
          </span>
        </div>
      </div>

      <GraficoSalute dati={dati} oggi={oggi} />

      {/* Le tre tessere: ogni numero con la sua provenienza e il suo stato */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-gray-900/60 p-4">
          <p className="text-xs text-gray-500 mb-1">Capacità di lavoro</p>
          <p className="text-2xl text-white font-light">{it(dati.capacitaLavoro, 1)} kWh</p>
          <p className="text-xs text-gray-600 mt-1">
            misurata: in attesa di punti concordi — la promozione è un atto deliberato (§4.4)
          </p>
        </div>
        <div className="rounded-xl bg-gray-900/60 p-4">
          <p className="text-xs text-gray-500 mb-1">SoH dichiarato</p>
          <p className="text-2xl text-white font-light">
            {dati.soh.ultimo != null ? `${it(dati.soh.ultimo, 1)}%` : '—'}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            {dati.soh.ultimo == null
              ? 'nessuna lettura ancora'
              : dati.soh.valoriDistinti === 1
                ? `identico in ${dati.soh.letture} letture dal ${dataBreve(dati.soh.dal!)} — dev'essere visto muoversi`
                : `${dati.soh.valoriDistinti} valori in ${dati.soh.letture} letture dal ${dataBreve(dati.soh.dal!)}`}
          </p>
        </div>
        <div className="rounded-xl bg-gray-900/60 p-4">
          <p className="text-xs text-gray-500 mb-1">12V a riposo</p>
          <p className="text-2xl text-white font-light">
            {ultimaMattina12v ? `${it(ultimaMattina12v.batt12v!, 2)} V` : '—'}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            {ultimaMattina12v
              ? `sonda del ${dataBreve(ultimaMattina12v.ora)} · parassita: non ancora misurabile`
              : 'in attesa della sonda del buongiorno'}
          </p>
        </div>
      </div>

      <p className="text-xs text-gray-600">
        Alimentata da: sonda del buongiorno · coppie muro delle ricariche · viaggi con
        copertura ≥ 95% e ΔSoC ≥ 8 punti · prima sentenza piena attesa a febbraio 2027.
      </p>
    </div>
  );
}
