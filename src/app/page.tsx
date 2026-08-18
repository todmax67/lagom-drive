'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { Car, LogOut, RefreshCw, Settings, BarChart2, Route, HeartPulse, FlaskConical } from 'lucide-react';
import AddChargingSession from '@/components/dashboard/AddChargingSession';
import LoginPage from '@/components/dashboard/LoginPage';
import BatteryCard from '@/components/dashboard/BatteryCard';
import StatsCard from '@/components/dashboard/StatsCard';
import LocationCard from '@/components/dashboard/LocationCard';
import ChargingHistory from '@/components/dashboard/ChargingHistory';
import BatteryChart from '@/components/dashboard/BatteryChart';
import MonthlyStats from '@/components/dashboard/MonthlyStats';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import ErrorCard from '@/components/ui/ErrorCard';
import NavButton from '@/components/ui/NavButton';
import { useVehicleData } from '@/hooks/useVehicleData';
import SettingsPage from '@/components/dashboard/SettingsPage';
import MonthlyHistory from '@/components/dashboard/MonthlyHistory';
import TripHistory from '@/components/dashboard/TripHistory';
import RaccoltaFerma from '@/components/dashboard/RaccoltaFerma';
import SondaBuongiorno from '@/components/dashboard/SondaBuongiorno';
import SalutePage from '@/components/dashboard/SalutePage';

// La navigazione della bussola (§4.1): cinque voci più Impostazioni.
// Statistiche e Posizione sono riassorbite in Oggi.
type Page = 'dashboard' | 'charging' | 'trips' | 'salute' | 'settings';

function Dashboard() {
  const [page, setPage] = useState<Page>('dashboard');
  const { data: session } = useSession();
  const { status, stats, location, isLoading, error, refresh } = useVehicleData();

  const [sessions, setSessions] = useState<any[]>([]);
  // null = risposta non ancora arrivata. Un array vuoto invece È un dato — il
  // peggiore: nessun campione in tutta la finestra — e l'avviso di raccolta
  // ferma deve poterlo distinguere dal caricamento iniziale.
  const [snapshots, setSnapshots] = useState<any[] | null>(null);

  const fetchChargingData = useCallback(async () => {
  if (session?.accessToken) {
    fetch('/api/charging/sessions').then(r => r.json()).then(setSessions).catch(() => {});
    fetch('/api/charging/snapshots?hours=24')
      .then(r => r.json())
      // Un 401 o un errore restituiscono un oggetto, non un array: passarlo
      // avanti farebbe scattare avvisi su dati che non sono dati.
      .then(d => { if (Array.isArray(d)) setSnapshots(d); })
      .catch(() => {});
  }
}, [session]);

useEffect(() => {
  fetchChargingData();
  // Gli snapshot alimentano l'avviso di raccolta ferma: vanno riletti a tempo,
  // non solo quando cambia `status`. Se /api/vehicle/status fallisce, `status`
  // resta fermo e l'avviso misurerebbe per ore l'età di dati rimasti al mount:
  // si accenderebbe con il cron sano, e non si spegnerebbe alla ripresa.
  const id = setInterval(fetchChargingData, 5 * 60 * 1000);
  return () => clearInterval(id);
}, [fetchChargingData, status]);

  const renderContent = () => {
    if (isLoading) return <LoadingSpinner />;
    // Il guasto del cloud non deve far sparire ciò che il cloud non serve: la
    // sonda del buongiorno legge solo il database, e resta visibile.
    if (error) {
      return page === 'dashboard' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div className="md:col-span-2 xl:col-span-1">
            <ErrorCard message={error} />
          </div>
          <SondaBuongiorno />
        </div>
      ) : (
        <ErrorCard message={error} />
      );
    }

    if (page === 'dashboard' && status) {
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div className="md:col-span-2 xl:col-span-1">
            <BatteryCard battery={status.battery} lastUpdated={status.lastUpdated} />
          </div>
          {/* Si nasconde da sola finché non esiste almeno una mattina in
              archivio; le classi di griglia stanno sulla sua radice, così
              quando ritorna null non resta una cella vuota. */}
          <SondaBuongiorno />
          {stats && (
            <div className="xl:col-span-1">
              <StatsCard stats={stats} />
            </div>
          )}
          {location && (
            <div className="xl:col-span-1">
              <LocationCard location={location} />
            </div>
          )}
        </div>
      );
    }

    if (page === 'charging') {
      return (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <MonthlyStats sessions={sessions} stats={stats} />
          <BatteryChart snapshots={snapshots ?? []} />
          <div className="xl:col-span-2">
            <MonthlyHistory />
          </div>
          <div className="xl:col-span-2 flex flex-col gap-4">
            <AddChargingSession onAdded={fetchChargingData} />
            <ChargingHistory sessions={sessions} />
          </div>
        </div>
      );
    }

    // Salute (§4.4): il processo ai testimoni come serie temporale che si
    // costruisce da sola. I punti si depositano, la sentenza matura.
    if (page === 'salute') {
      return <SalutePage />;
    }

    if (page === 'trips') {
      return (
        <div className="max-w-2xl">
          {/* Il chip "capacità ~NN kWh" delle card misurate porta a Salute:
              è un punto del testimone C che si deposita, non una promozione */}
          <TripHistory onSalute={() => setPage('salute')} />
        </div>
      );
    }



    if (page === 'settings') {
      return <SettingsPage />;
    }

    return <ErrorCard message="Nessun dato disponibile. Riprova tra qualche secondo." />;
  };

  return (
    <div className="bg-gray-950 min-h-screen text-white font-sans">
      <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
          <div className="flex items-center gap-3">
            <Image src="/logo.svg" alt="" width={40} height={40} priority className="shrink-0" />
            <div>
              <h1 className="text-2xl font-light text-white tracking-tight">
                Lagom Drive
              </h1>
              <p className="text-gray-500 text-sm mt-0.5">
                {session?.user?.email}
                {/* Lo stato a tre posizioni della bussola (§4.1) */}
                {status?.battery?.isCharging ? (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-teal-300 bg-teal-400/10 px-2 py-0.5 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-teal-300 animate-pulse" />
                    In carica
                  </span>
                ) : status?.isDriving ? (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    In guida
                  </span>
                ) : status ? (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-700/40 px-2 py-0.5 rounded-full">
                    a riposo
                  </span>
                ) : null}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <nav className="bg-gray-800/80 border border-gray-700/50 p-1.5 rounded-xl flex items-center gap-1">
              <NavButton
                icon={<Car size={18} />}
                label="Oggi"
                isActive={page === 'dashboard'}
                onClick={() => setPage('dashboard')}
              />
              <NavButton
                icon={<Route size={18} />}
                label="Viaggi"
                isActive={page === 'trips'}
                onClick={() => setPage('trips')}
              />
              <NavButton
                icon={<BarChart2 size={18} />}
                label="Ricariche"
                isActive={page === 'charging'}
                onClick={() => setPage('charging')}
              />
              <NavButton
                icon={<HeartPulse size={18} />}
                label="Salute"
                isActive={page === 'salute'}
                onClick={() => setPage('salute')}
              />
              {/* Il Lab vive in /obd: console, sonde, rituale — la quinta voce
                  della bussola è un ponte, non una copia */}
              <Link
                href="/obd"
                className="p-2.5 sm:px-3 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/50 transition-all flex items-center gap-1.5 text-sm"
                title="Lab"
              >
                <FlaskConical size={18} />
                <span className="hidden lg:inline">Lab</span>
              </Link>
              <NavButton
                icon={<Settings size={18} />}
                label="Impostazioni"
                isActive={page === 'settings'}
                onClick={() => setPage('settings')}
              />
            </nav>

            <button
              onClick={refresh}
              disabled={isLoading}
              title="Aggiorna dati"
              className="p-3 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white hover:bg-gray-700/50 transition-all duration-200 disabled:opacity-40"
            >
              <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
            </button>

            <button
              onClick={() => signOut()}
              title="Logout"
              className="p-3 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-red-400 hover:bg-red-900/20 hover:border-red-500/30 transition-all duration-200"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {/* Sopra il contenuto e su ogni pagina: è un guasto che sta facendo
            perdere dati adesso, non una nota da cercare in un pannello */}
        <RaccoltaFerma snapshots={snapshots} />

        {renderContent()}
      </div>
    </div>
  );
}

export default function Home() {
  const { data: session, status } = useSession();

  if (status === 'loading') return <LoadingSpinner fullScreen />;
  if (status === 'unauthenticated') return <LoginPage />;

  // Sessione NextAuth ancora valida ma refresh Volvo fallito: senza questo ramo
  // la dashboard resterebbe visibile e vuota, senza modo di recuperare.
  if ((session as any)?.error === 'RefreshTokenError') {
    return <LoginPage notice="La connessione al tuo Volvo ID è scaduta. Accedi di nuovo per riprendere la sincronizzazione." />;
  }

  return <Dashboard />;
}