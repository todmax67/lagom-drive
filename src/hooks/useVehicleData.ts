import { useState, useEffect, useCallback } from 'react';
import type { VehicleStatus, VehicleStats, VehicleLocation } from '@/types/volvo';

interface VehicleData {
  status: VehicleStatus | null;
  stats: VehicleStats | null;
  location: VehicleLocation | null;
}

interface UseVehicleDataReturn extends VehicleData {
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Errore ${res.status} su ${url}`);
  return res.json();
}

export function useVehicleData(): UseVehicleDataReturn {
  const [data, setData] = useState<VehicleData>({
    status: null,
    stats: null,
    location: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      const [status, stats, location] = await Promise.allSettled([
        fetchJson<VehicleStatus>('/api/vehicle/status'),
        fetchJson<VehicleStats>('/api/vehicle/stats'),
        fetchJson<VehicleLocation>('/api/vehicle/location'),
      ]);

      setData({
        status: status.status === 'fulfilled' ? status.value : null,
        stats: stats.status === 'fulfilled' ? stats.value : null,
        location: location.status === 'fulfilled' ? location.value : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore sconosciuto');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    // Aggiorna ogni 60 secondi
    const interval = setInterval(fetchAll, 600_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  return {
    ...data,
    isLoading,
    error,
    refresh: fetchAll,
  };
}