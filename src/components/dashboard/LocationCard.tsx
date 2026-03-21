import React from 'react';
import type { VehicleLocation } from '@/types/volvo';
import { MapPin, Navigation } from 'lucide-react';


export default function LocationCard({ location }: { location: VehicleLocation }) {
  const mapsUrl = `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;

  return (
    <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-widest text-gray-400 uppercase">
          Posizione
        </span>
        <Navigation
          size={14}
          className="text-blue-400"
          style={{ transform: `rotate(${location.heading}deg)` }}
        />
      </div>

      <div className="rounded-xl bg-gray-900/60 p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-gray-300 text-sm">
          <MapPin size={14} className="text-blue-400 shrink-0" />
          <span className="tabular-nums">
            {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
          </span>
        </div>
        <p className="text-xs text-gray-500 pl-5">
          Direzione: {location.heading}°
        </p>
      </div>

      
        <button
        onClick={() => window.open(mapsUrl, '_blank')}
        className="text-center text-sm font-medium text-blue-400 hover:text-blue-300 border border-blue-500/30 hover:border-blue-400/50 rounded-xl py-2.5 transition-all duration-200 w-full"
      >
        Apri in Google Maps →
      </button>

      <p className="text-xs text-gray-600 text-right">
        Aggiornato: {new Date(location.lastUpdated).toLocaleTimeString('it-IT')}
      </p>
    </div>
  );
}