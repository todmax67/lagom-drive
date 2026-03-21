import { AlertTriangle } from 'lucide-react';
import React from 'react';

export default function ErrorCard({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 flex items-start gap-4">
      <AlertTriangle className="text-red-400 mt-0.5 shrink-0" size={20} />
      <div>
        <p className="text-sm font-semibold text-red-300">Errore</p>
        <p className="text-sm text-gray-400 mt-1">{message}</p>
      </div>
    </div>
  );
}