'use client';

import { useEffect } from 'react';
import { signIn } from 'next-auth/react';

/**
 * L'imbocco del ponte: il guscio apre QUESTA pagina nel browser di sistema.
 * Qui si parte subito verso Volvo ID (che nel browser vero funziona), con
 * ritorno su /ponte dove nasce il codice per rientrare nel guscio. Chi è già
 * loggato nel browser passa il giro di OAuth senza attriti.
 */
export default function AvviaPonte() {
  useEffect(() => {
    signIn('volvo', { callbackUrl: '/ponte' });
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <p className="text-sm text-gray-400">Ti porto al login Volvo ID…</p>
    </div>
  );
}
