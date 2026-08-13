'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Route, Cloud, Cpu, AlertTriangle } from 'lucide-react';

type Cloud = {
  distanceKm: number | null;
  startBattery: number;
  endBattery: number | null;
  energyUsedKwh: number | null;
  avgConsumption: number | null;
  durataMin: number | null;
};

type Sessione = {
  inizio: string;
  fine: string;
  durataMin: number;
  campioni: number;
  distanzaKm: number;
  socIniziale: number | null;
  socFinale: number | null;
  energiaKwh: number | null;
  consumo: number | null;
  velocitaMax: number | null;
  livelliSoc: number;
  intervalloMaxSec: number;
  secondiNonIntegrati: number;
  cloud: Cloud[];
};

const num = (v: number | null | undefined, dec = 1, unita = '') =>
  v === null || v === undefined ? 'n/d' : `${v.toFixed(dec)}${unita}`;

function Riga({ etichetta, obd, cloud }: { etichetta: string; obd: string; cloud: string }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 border-t border-gray-700/40 text-sm">
      <span className="text-gray-500 text-xs self-center">{etichetta}</span>
      <span className="text-white font-light">{obd}</span>
      <span className="text-gray-400 font-light">{cloud}</span>
    </div>
  );
}

export default function AnalisiPage() {
  const [sessioni, setSessioni] = useState<Sessione[] | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/obd/sessioni')
      .then(async r => {
        if (!r.ok) throw new Error(r.status === 401 ? 'Serve accedere all\'app' : `Errore ${r.status}`);
        return r.json();
      })
      .then(d => setSessioni(d.sessioni))
      .catch(e => setErrore(e.message));
  }, []);

  return (
    <div className="bg-gray-950 min-h-screen text-white font-sans">
      <div className="max-w-3xl mx-auto p-4 md:p-6 flex flex-col gap-5">
        <header className="flex items-center gap-3">
          <Link href="/obd" className="p-2 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-light tracking-tight">Confronto OBD e cloud</h1>
            <p className="text-gray-500 text-sm">Lo stesso tragitto misurato per due vie</p>
          </div>
        </header>

        {errore && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-900/20 p-4 text-sm text-amber-200">
            {errore}
          </div>
        )}

        {!sessioni && !errore && (
          <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
            <div className="w-6 h-6 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin mx-auto" />
          </div>
        )}

        {sessioni?.length === 0 && (
          <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6">
            <p className="text-gray-500 text-sm text-center">
              Nessuna registrazione OBD negli ultimi giorni.
            </p>
          </div>
        )}

        {sessioni?.map(s => (
          <div key={s.inizio} className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white flex items-center gap-2">
                <Route size={14} className="text-blue-400" />
                {new Date(s.inizio).toLocaleString('it-IT', {
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </span>
              <span className="text-xs text-gray-500">
                {s.durataMin} min · {s.campioni} campioni
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <span />
              <span className="text-blue-300 flex items-center gap-1"><Cpu size={11} /> OBD</span>
              <span className="text-gray-500 flex items-center gap-1"><Cloud size={11} /> API Volvo</span>
            </div>

            {(() => {
              const c = s.cloud[0];
              return (
                <>
                  <Riga
                    etichetta="Distanza"
                    obd={num(s.distanzaKm, 2, ' km')}
                    cloud={c ? num(c.distanceKm, 1, ' km') : 'nessun viaggio'}
                  />
                  <Riga
                    etichetta="Carica"
                    obd={`${num(s.socIniziale, 2)}% → ${num(s.socFinale, 2)}%`}
                    cloud={c ? `${c.startBattery}% → ${c.endBattery ?? 'n/d'}%` : '—'}
                  />
                  <Riga
                    etichetta="Energia"
                    obd={num(s.energiaKwh, 2, ' kWh')}
                    cloud={c ? num(c.energyUsedKwh, 1, ' kWh') : '—'}
                  />
                  <Riga
                    etichetta="Consumo"
                    obd={num(s.consumo, 1, ' kWh/100km')}
                    cloud={c ? num(c.avgConsumption, 1, ' kWh/100km') : '—'}
                  />
                  <Riga
                    etichetta="Durata"
                    obd={`${s.durataMin} min`}
                    cloud={c?.durataMin != null ? `${c.durataMin} min` : '—'}
                  />
                </>
              );
            })()}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 pt-2 border-t border-gray-700/40">
              <span>velocità max {num(s.velocitaMax, 0, ' km/h')}</span>
              <span>{s.livelliSoc} livelli di carica distinti</span>
              <span>intervallo max {s.intervalloMaxSec}s</span>
            </div>

            {(s.intervalloMaxSec > 30 || s.secondiNonIntegrati > 0) && (
              <p className="text-xs text-amber-300/80 flex items-start gap-2">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                {s.secondiNonIntegrati > 0
                  ? `${s.secondiNonIntegrati}s non integrati nella distanza: intervalli troppo lunghi fra i campioni, la strada percorsa in quei tratti non è ricostruibile.`
                  : `Un intervallo di ${s.intervalloMaxSec}s fra due campioni: la registrazione si è interrotta, probabilmente l'app è andata in secondo piano.`}
              </p>
            )}
          </div>
        ))}

        <p className="text-xs text-gray-600">
          La distanza OBD è integrata dalla velocità: non esiste un PID odometro,
          ma con un campione ogni due secondi la somma regge. Quella cloud viene
          dal salto odometrico, che Volvo aggiorna solo a veicolo fermo.
        </p>
      </div>
    </div>
  );
}
