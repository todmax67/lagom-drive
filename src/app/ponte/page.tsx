'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { ArrowRight, AlertTriangle } from 'lucide-react';

/**
 * L'approdo del ponte, nel browser di sistema: il login Volvo ID è appena
 * riuscito QUI (dove funziona), e questa pagina chiede il codice monouso e
 * offre il salto verso il guscio via deep link lagomdrive://.
 */

function Ponte() {
  const params = useSearchParams();
  const esito = params.get('esito');
  // La sfida PKCE del guscio: senza, il codice non nasce — un codice non
  // legato a un verificatore sarebbe rubabile via deep link intercettato
  const sfida = params.get('sfida');
  const [codice, setCodice] = useState<string | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  // La sfida assente non è uno stato: si giudica a render (sotto)
  useEffect(() => {
    if (esito === 'scaduto' || !sfida) return;
    fetch('/api/ponte/crea', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sfida }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(d => setCodice(d.codice))
      .catch(e =>
        setErrore(
          e.message === '401'
            ? 'Qui non risulti loggato: fai prima il login in questo browser.'
            : 'Il codice non è arrivato: riprova.'
        )
      );
  }, [esito, sfida]);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center flex flex-col gap-6 items-center">
        <Image src="/logo.svg" alt="" width={72} height={72} priority />
        <h1 className="text-2xl font-light text-white">Il ponte verso il guscio</h1>

        {esito === 'scaduto' && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-900/20 px-4 py-3 text-sm text-amber-200 flex items-start gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            Codice scaduto o già usato: i codici vivono due minuti. Rifai il
            passaggio dal guscio.
          </p>
        )}

        {(errore ?? (!sfida && esito !== 'scaduto'
          ? 'Manca la sfida del guscio: rifai il passaggio dall’app.'
          : null)) && (
          <p className="text-sm text-amber-200">
            {errore ?? 'Manca la sfida del guscio: rifai il passaggio dall’app.'}
          </p>
        )}

        {codice && (
          <>
            <p className="text-sm text-gray-400">
              Login riuscito. Tocca per portare la sessione dentro l&apos;app —
              il codice vale due minuti e si consuma al primo uso.
            </p>
            <a
              href={`lagomdrive://ponte?codice=${codice}`}
              className="flex items-center justify-center gap-3 w-full p-4 rounded-xl font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-all"
            >
              Torna a Lagom Drive
              <ArrowRight size={18} />
            </a>
          </>
        )}
        {!codice && !errore && sfida && esito !== 'scaduto' && (
          <p className="text-sm text-gray-500">Preparo il codice…</p>
        )}
      </div>
    </div>
  );
}

export default function PaginaPonte() {
  return (
    <Suspense fallback={null}>
      <Ponte />
    </Suspense>
  );
}
