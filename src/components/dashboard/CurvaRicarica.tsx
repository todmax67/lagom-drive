'use client';

import { useState, useEffect, useId } from 'react';

/**
 * La curva di ricarica di una sessione: due fonti, mai mescolate.
 *
 * - dedotta (cloud): gradini ΔSoC × capacità / Δt dagli snapshot — c'è per
 *   ogni ricarica che il cron ha visto, DC comprese;
 * - misurata (OBD): la potenza V×I a 1 Hz da /api/obd/profilo, quando il
 *   telefono ha registrato durante la carica (in carica il segno è negativo:
 *   qui si mostra il modulo, è energia che entra).
 *
 * Le regole della casa valgono anche qui: i buchi della misurata NON si
 * scavalcano (la linea si spezza dove i secchi non hanno dati), i punti del
 * margine non invadono gli assi (clip sull'area dati), e il guasto di una
 * fonte si dichiara — mai travestito da assenza di campioni.
 */

interface Curva {
  dedotta: { t: string; kw: number }[];
  soc: { t: string; v: number }[];
  capacita: number;
}

interface Profilo {
  secchi: { pos: number; neg: number; dati: boolean }[];
  ambientC: number | null;
  gapSec: number | null;
}

export default function CurvaRicarica({ da, a }: { da: string; a: string }) {
  const [curva, setCurva] = useState<Curva | null>(null);
  const [profilo, setProfilo] = useState<Profilo | null>(null);
  // 'finestra' = rifiuto di validazione (sessione oltre le 24h): non è un
  // guasto, e va raccontato per quello che è
  const [erroreCurva, setErroreCurva] = useState<'rete' | 'finestra' | null>(null);
  const [erroreProfilo, setErroreProfilo] = useState(false);
  const clipId = useId();

  useEffect(() => {
    const qs = new URLSearchParams({ da, a });
    fetch(`/api/charging/curva?${qs}`)
      .then(r => {
        if (r.ok) return r.json().then(setCurva);
        setErroreCurva(r.status === 400 ? 'finestra' : 'rete');
      })
      .catch(() => setErroreCurva('rete'));
    fetch(`/api/obd/profilo?${qs}`)
      .then(r => {
        if (!r.ok) { setErroreProfilo(true); return; }
        return r.json().then(d => {
          if (d && Array.isArray(d.secchi)) setProfilo(d);
          else setErroreProfilo(true);
        });
      })
      .catch(() => setErroreProfilo(true));
  }, [da, a]);

  if (erroreCurva === 'finestra') {
    return (
      <p className="text-xs text-gray-400 pt-2">
        Finestra oltre le 24 ore: la curva non si calcola su questa sessione.
      </p>
    );
  }
  if (erroreCurva === 'rete') {
    return <p className="text-xs text-gray-400 pt-2">Curva non leggibile ora: la fonte non ha risposto.</p>;
  }
  if (!curva) {
    return <p className="text-xs text-gray-400 pt-2">…</p>;
  }

  const t0 = Date.parse(da);
  const t1 = Date.parse(a);
  const spanMs = t1 - t0;

  // La serie misurata a TRATTE: un secchio senza dati (o senza potenza di
  // carica) spezza la linea — i buchi non si scavalcano mai con un segmento.
  // Ogni punto porta anche il suo pallino, così una registrazione breve
  // (una tratta da un punto solo) resta visibile invece di sparire.
  const tratteMisurata: { t: number; kw: number }[][] = [];
  if (profilo && profilo.secchi.length >= 2) {
    const lungMs = spanMs / profilo.secchi.length;
    let corrente: { t: number; kw: number }[] = [];
    for (let i = 0; i < profilo.secchi.length; i++) {
      const s = profilo.secchi[i];
      if (s.dati && s.neg < 0) {
        corrente.push({ t: t0 + (i + 0.5) * lungMs, kw: -s.neg });
      } else if (corrente.length) {
        tratteMisurata.push(corrente);
        corrente = [];
      }
    }
    if (corrente.length) tratteMisurata.push(corrente);
  }
  const puntiMisurati = tratteMisurata.flat();

  if (curva.dedotta.length === 0 && puntiMisurati.length === 0) {
    return (
      <p className="text-xs text-gray-400 pt-2">
        {erroreProfilo
          ? 'Nessuno snapshot cloud in questa finestra, e la serie misurata non è leggibile ora: la fonte OBD non ha risposto.'
          : "Nessun campione in questa finestra: la curva si accende dalle prossime ricariche (il cron campiona ogni 1-2 minuti, l'OBD se registra in carica)."}
      </p>
    );
  }

  const W = 600;
  const H = 180;
  const SX = 38;
  const DX = 38;
  const ALTO = 10;
  const BASSO = 22;

  const kwMax = Math.max(
    10,
    Math.ceil(
      Math.max(...curva.dedotta.map(p => p.kw), ...puntiMisurati.map(p => p.kw), 0) * 1.15
    )
  );
  const px = (t: number) => SX + ((t - t0) / spanMs) * (W - SX - DX);
  const pyKw = (v: number) => ALTO + (1 - v / kwMax) * (H - ALTO - BASSO);
  const pySoc = (v: number) => ALTO + (1 - v / 100) * (H - ALTO - BASSO);

  const passiDedotta = curva.dedotta
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(Date.parse(p.t)).toFixed(1)},${pyKw(p.kw).toFixed(1)}`)
    .join(' ');
  const lineaSoc = curva.soc
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(Date.parse(p.t)).toFixed(1)},${pySoc(p.v).toFixed(1)}`)
    .join(' ');

  const oraBreve = (t: number) =>
    new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const grigliaKw = [0.25, 0.5, 0.75, 1].map(f => Math.round(kwMax * f));

  return (
    <div className="border-t border-gray-700/50 pt-3 flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Curva di ricarica">
        {/* L'area dati: gli snapshot del margine ±5 min non devono invadere
            le colonne delle etichette */}
        <defs>
          <clipPath id={clipId}>
            <rect x={SX} y={0} width={W - SX - DX} height={H} />
          </clipPath>
        </defs>
        {grigliaKw.map(v => (
          <g key={v}>
            <line x1={SX} y1={pyKw(v)} x2={W - DX} y2={pyKw(v)} stroke="rgb(75 85 99 / 0.2)" strokeDasharray="3 4" />
            <text x={SX - 5} y={pyKw(v) + 3} textAnchor="end" fontSize="10" fill="rgb(209 213 219)">{v}</text>
          </g>
        ))}
        <text x={SX - 5} y={ALTO - 1} textAnchor="end" fontSize="9" fill="rgb(156 163 175)">kW</text>
        {[0, 50, 100].map(v => (
          <text key={v} x={W - DX + 5} y={pySoc(v) + 3} textAnchor="start" fontSize="10" fill="rgb(209 213 219)">{v}%</text>
        ))}
        {[t0, t0 + spanMs / 2, t1].map(t => (
          <text key={t} x={px(t)} y={H - 6} textAnchor="middle" fontSize="10" fill="rgb(156 163 175)">{oraBreve(t)}</text>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {curva.soc.length >= 2 && (
            <path d={lineaSoc} fill="none" stroke="rgb(156 163 175 / 0.6)" strokeWidth="1" strokeDasharray="2 3" />
          )}
          {curva.dedotta.length >= 2 && (
            <path d={passiDedotta} fill="none" stroke="rgb(251 191 36 / 0.9)" strokeWidth="1.5" />
          )}
          {curva.dedotta.map((p, i) => (
            <circle key={i} cx={px(Date.parse(p.t))} cy={pyKw(p.kw)} r="2.5" fill="rgb(251 191 36)" />
          ))}
          {tratteMisurata.map((tratta, i) => (
            <g key={i}>
              {tratta.length >= 2 && (
                <path
                  d={tratta
                    .map((p, j) => `${j === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${pyKw(p.kw).toFixed(1)}`)
                    .join(' ')}
                  fill="none"
                  stroke="rgb(45 212 191)"
                  strokeWidth="1.5"
                />
              )}
              {tratta.map((p, j) => (
                <circle key={j} cx={px(p.t)} cy={pyKw(p.kw)} r="2" fill="rgb(45 212 191)" />
              ))}
            </g>
          ))}
        </g>
      </svg>
      <div className="flex items-center gap-4 text-xs text-gray-400 flex-wrap">
        {curva.dedotta.length >= 1 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            dedotta · ΔSoC × capacità
          </span>
        )}
        {puntiMisurati.length >= 1 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-teal-400" />
            misurata · V×I (OBD){tratteMisurata.length > 1 && ' · a tratte, i buchi non si scavalcano'}
          </span>
        )}
        {erroreProfilo && (
          <span className="text-gray-500">serie misurata non leggibile ora</span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="w-3 border-t border-dashed border-gray-400" />
          SoC
        </span>
      </div>
    </div>
  );
}
