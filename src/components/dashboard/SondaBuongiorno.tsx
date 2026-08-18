'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Sunrise, ChevronRight } from 'lucide-react';

/**
 * La card della sonda del buongiorno (bussola §4.1): stato del rituale,
 * le misure a riposo del mattino, il delta dal giorno prima, e il registro
 * giornaliero — l'energia netta fra due mattine, dedotta dal ΔSoC e
 * dichiarata come tale. Ogni numero porta la sua fonte e la sua età.
 */

type Mattina = {
  giorno: string;
  ora: string;
  batt12v: number | null;
  packVoltage: number | null;
  socDisplay: number | null;
  sohGrezzo: string | null;
  socDaCloud?: boolean;
};

type Risposta = { mattine: Mattina[]; fattaOggi: boolean; oggiNonARiposo?: boolean; capacita: number };

export default function SondaBuongiorno() {
  const [dati, setDati] = useState<Risposta | null>(null);

  useEffect(() => {
    fetch('/api/obd/buongiorno')
      .then(r => r.json())
      .then(d => { if (d && Array.isArray(d.mattine)) setDati(d); })
      .catch(() => {});
  }, []);

  // In caricamento o senza nessuna mattina in archivio: la card non insiste.
  // Il rituale si scopre dal Lab, non da un invito su una dashboard vuota.
  if (!dati || dati.mattine.length === 0) return null;

  const ultima = dati.mattine[dati.mattine.length - 1];
  const precedente = dati.mattine.length >= 2 ? dati.mattine[dati.mattine.length - 2] : null;

  const delta12v =
    precedente?.batt12v != null && ultima.batt12v != null
      ? ultima.batt12v - precedente.batt12v
      : null;

  // Le mattine possono non essere consecutive: "da ieri" quando ieri non c'è
  // sarebbe una bugia di cortesia. Il confronto dichiara la sua data vera.
  const notti = precedente
    ? Math.round((Date.parse(ultima.giorno) - Date.parse(precedente.giorno)) / 86_400_000)
    : null;
  const etichettaConfronto =
    notti === 1
      ? 'da ieri'
      : precedente
        ? `dal ${new Date(precedente.giorno).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}`
        : '';

  // Il registro giornaliero (bussola §4.3): ΔSoC fra due mattine × capacità di
  // lavoro. Negativo = il giorno ha consumato più di quanto ha caricato.
  // È un dedotto, e lo dice.
  const registroKwh =
    precedente?.socDisplay != null && ultima.socDisplay != null
      ? ((ultima.socDisplay - precedente.socDisplay) / 100) * dati.capacita
      : null;

  const dataUltima = new Date(ultima.ora).toLocaleDateString('it-IT', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  });

  return (
    <div className="md:col-span-2 xl:col-span-1 rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase flex items-center gap-2">
          <Sunrise size={13} className="text-amber-300" />
          Sonda del buongiorno
        </span>
        {/* Tre stati, non due: una lettura fatta ad auto sveglia non è una
            mattina a riposo, ma dire "da fare" a chi l'ha fatta è peggio. */}
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          dati.fattaOggi
            ? 'text-emerald-300 bg-emerald-400/10'
            : dati.oggiNonARiposo
              ? 'text-amber-300 bg-amber-400/10'
              : 'text-gray-400 bg-gray-700/40'
        }`}>
          {dati.fattaOggi ? 'fatta' : dati.oggiNonARiposo ? 'fatta, non a riposo' : 'da fare'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-gray-900/60 p-2.5">
          <p className="text-xs text-gray-400 mb-1">Batteria 12V</p>
          <p className="text-sm text-white font-light">
            {ultima.batt12v != null ? `${ultima.batt12v.toFixed(2)} V` : 'n/d'}
            {delta12v != null && (
              <span className={`text-xs ml-1.5 ${
                delta12v < -0.15 ? 'text-amber-300' : 'text-gray-400'
              }`}>
                {delta12v >= 0 ? '+' : ''}{delta12v.toFixed(2)} {etichettaConfronto}
              </span>
            )}
          </p>
        </div>

        <div className="rounded-lg bg-gray-900/60 p-2.5">
          <p className="text-xs text-gray-400 mb-1">Pacco a riposo</p>
          <p className="text-sm text-white font-light">
            {ultima.packVoltage != null ? `${ultima.packVoltage.toFixed(1)} V` : 'n/d'}
          </p>
        </div>

        <div className="rounded-lg bg-gray-900/60 p-2.5">
          <p className="text-xs text-gray-400 mb-1">Carica · {ultima.socDaCloud ? "cloud" : "OBD"}</p>
          <p className="text-sm text-white font-light">
            {ultima.socDisplay != null ? `${ultima.socDisplay.toFixed(1)} %` : 'n/d'}
          </p>
        </div>

        <div className="rounded-lg bg-gray-900/60 p-2.5">
          <p className="text-xs text-gray-400 mb-1">SoH · in validazione</p>
          {/* Grezzo di proposito: finché il registro non si muove nel tempo,
              interpretarlo come percentuale dichiarerebbe più del misurato. */}
          <p className="text-xs text-white font-mono pt-1">{ultima.sohGrezzo ?? 'n/d'}</p>
        </div>
      </div>

      {registroKwh != null && (
        <div className="flex items-center justify-between border-t border-gray-700/50 pt-3">
          <span className="text-xs text-gray-400">
            Registro {etichettaConfronto === 'da ieri' ? 'da ieri' : etichettaConfronto}
            <span className="text-gray-500"> · dedotto · ΔSoC × capacità</span>
          </span>
          <span className={`text-sm font-light ${registroKwh < 0 ? 'text-rose-300' : 'text-teal-300'}`}>
            {registroKwh >= 0 ? '+' : ''}{registroKwh.toFixed(1)} kWh
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">ultima: {dataUltima}</span>
        <Link href="/obd" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-0.5">
          rituale <ChevronRight size={12} />
        </Link>
      </div>
    </div>
  );
}
