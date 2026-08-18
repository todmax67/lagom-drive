import React from 'react';
export default function LoadingSpinner({ fullScreen = false }: { fullScreen?: boolean }) {
  if (fullScreen) {
    return (
      <div className="bg-gray-950 min-h-screen flex flex-col items-center justify-center gap-4">
        <div className="w-12 h-12 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
        <p className="text-gray-400 text-sm tracking-widest uppercase">Caricamento</p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-12">
      <div className="w-8 h-8 rounded-full border-2 border-gray-700 border-t-blue-500 animate-spin" />
    </div>
  );
}