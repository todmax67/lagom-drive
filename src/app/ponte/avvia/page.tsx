'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

/**
 * L'imbocco del ponte: il guscio apre QUESTA pagina nel browser di sistema,
 * portando la sfida PKCE. Qui si parte subito verso Volvo ID (che nel
 * browser vero funziona), con ritorno su /ponte — sfida compresa — dove
 * nasce il codice per rientrare nel guscio. Chi è già loggato nel browser
 * passa il giro di OAuth senza attriti.
 */
function Avvio() {
  const sfida = useSearchParams().get('sfida') ?? '';

  useEffect(() => {
    signIn('volvo', { callbackUrl: `/ponte?sfida=${encodeURIComponent(sfida)}` });
  }, [sfida]);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <p className="text-sm text-gray-400">Ti porto al login Volvo ID…</p>
    </div>
  );
}

export default function AvviaPonte() {
  return (
    <Suspense fallback={null}>
      <Avvio />
    </Suspense>
  );
}
