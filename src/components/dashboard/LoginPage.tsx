'use client';

import { signIn } from 'next-auth/react';
import Image from 'next/image';
import { LogIn, ExternalLink } from 'lucide-react';
import { nativo } from '@/lib/canale-nativo';

// Nel guscio il login diretto non passa: Volvo ID rifiuta i browser
// incorporati (errore 14, visto sul campo). La strada è il ponte: login nel
// browser di sistema, rientro col codice monouso via deep link.
const apriPonte = async () => {
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url: 'https://lagom-drive.vercel.app/ponte/avvia' });
};

export default function LoginPage({ notice }: { notice?: string }) {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <Image
            src="/logo.svg"
            alt=""
            width={96}
            height={96}
            priority
            className="mx-auto mb-5"
          />
          <h1 className="text-4xl font-light text-white tracking-tight mb-2">
            Lagom Drive
          </h1>
          <p className="text-gray-400 text-sm">
            Dashboard per la tua Volvo elettrica
          </p>
        </div>

        <div className="rounded-2xl border border-gray-700/50 bg-gray-800/50 p-8 flex flex-col gap-6">
          {notice && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
              {notice}
            </p>
          )}

          <div>
            <h2 className="text-xl font-medium text-white mb-1">Accedi</h2>
            <p className="text-sm text-gray-400">
              Connetti il tuo Volvo ID per sincronizzare i dati del veicolo in tempo reale.
            </p>
          </div>

          {nativo() ? (
            <>
              <button
                onClick={apriPonte}
                className="flex items-center justify-center gap-3 w-full p-4 rounded-xl font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-all duration-200 hover:scale-[1.02] shadow-lg shadow-blue-500/20"
              >
                <ExternalLink size={18} />
                Accedi col browser sicuro
              </button>
              <p className="text-xs text-gray-500">
                Volvo ID non accetta il login dentro l&apos;app: si apre il
                browser, fai il login lì, e un tocco ti riporta qui con la
                sessione.
              </p>
            </>
          ) : (
            <button
              onClick={() => signIn('volvo')}
              className="flex items-center justify-center gap-3 w-full p-4 rounded-xl font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-all duration-200 hover:scale-[1.02] shadow-lg shadow-blue-500/20"
            >
              <LogIn size={18} />
              Login con Volvo ID
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
