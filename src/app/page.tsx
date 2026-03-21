'use client';

import { useEffect, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { Car, TrendingUp, MapPin, LogOut, RefreshCw } from 'lucide-react';

import LoginPage from '@/components/dashboard/LoginPage';
import BatteryCard from '@/components/dashboard/BatteryCard';
import StatsCard from '@/components/dashboard/StatsCard';
import LocationCard from '@/components/dashboard/LocationCard';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import ErrorCard from '@/components/ui/ErrorCard';
import NavButton from '@/components/ui/NavButton';
import { useVehicleData } from '@/hooks/useVehicleData';

type Page = 'dashboard' | 'stats' | 'location';

function Dashboard() {
  const [page, setPage] = useState<Page>('dashboard');
  const { data: session } = useSession();
  useEffect(() => {
  if ((session as any)?.error === 'RefreshTokenError') {
    signOut();
  }
}, [session]);
  const { status, stats, location, isLoading, error, refresh } = useVehicleData();

  const renderContent = () => {
    if (isLoading) return <LoadingSpinner />;
    if (error) return <ErrorCard message={error} />;

    if (page === 'dashboard' && status) {
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div className="md:col-span-2 xl:col-span-1">
            <BatteryCard battery={status.battery} />
          </div>
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

    if (page === 'stats' && stats) {
      return (
        <div className="max-w-lg">
          <StatsCard stats={stats} />
        </div>
      );
    }

    if (page === 'location' && location) {
      return (
        <div className="max-w-lg">
          <LocationCard location={location} />
        </div>
      );
    }

    return (
      <ErrorCard message="Nessun dato disponibile. Riprova tra qualche secondo." />
    );
  };

  return (
    <div className="bg-gray-950 min-h-screen text-white font-sans">
      <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8">

        {/* Header */}
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
          <div>
            <h1 className="text-2xl font-light text-white tracking-tight">
              Lagom Drive
            </h1>
            <p className="text-gray-500 text-sm mt-0.5">
              {session?.user?.email}
              {status?.isDriving && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  In guida
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Nav */}
            <nav className="bg-gray-800/80 border border-gray-700/50 p-1.5 rounded-xl flex items-center gap-1">
              <NavButton
                icon={<Car size={18} />}
                label="Dashboard"
                isActive={page === 'dashboard'}
                onClick={() => setPage('dashboard')}
              />
              <NavButton
                icon={<TrendingUp size={18} />}
                label="Statistiche"
                isActive={page === 'stats'}
                onClick={() => setPage('stats')}
              />
              <NavButton
                icon={<MapPin size={18} />}
                label="Posizione"
                isActive={page === 'location'}
                onClick={() => setPage('location')}
              />
            </nav>

            {/* Refresh */}
            <button
              onClick={refresh}
              disabled={isLoading}
              title="Aggiorna dati"
              className="p-3 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-white hover:bg-gray-700/50 transition-all duration-200 disabled:opacity-40"
            >
              <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
            </button>

            {/* Logout */}
            <button
              onClick={() => signOut()}
              title="Logout"
              className="p-3 rounded-xl bg-gray-800/80 border border-gray-700/50 text-gray-400 hover:text-red-400 hover:bg-red-900/20 hover:border-red-500/30 transition-all duration-200"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {/* Contenuto */}
        {renderContent()}

      </div>
    </div>
  );
}

export default function Home() {
  const { status } = useSession();

  if (status === 'loading') return <LoadingSpinner fullScreen />;
  if (status === 'unauthenticated') return <LoginPage />;
  return <Dashboard />;
}