import { signIn } from 'next-auth/react';
import { LogIn } from 'lucide-react';

export default function LoginPage({ notice }: { notice?: string }) {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-light text-white tracking-tight mb-2">
            Lagom Drive
          </h1>
          <p className="text-gray-500 text-sm">
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

          <button
            onClick={() => signIn('volvo')}
            className="flex items-center justify-center gap-3 w-full p-4 rounded-xl font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-all duration-200 hover:scale-[1.02] shadow-lg shadow-blue-500/20"
          >
            <LogIn size={18} />
            Login con Volvo ID
          </button>
        </div>
      </div>
    </div>
  );
}
