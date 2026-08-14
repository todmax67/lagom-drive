import { AlertTriangle } from 'lucide-react';

/**
 * Avvisa quando lo scheduler esterno ha smesso di chiamare.
 *
 * Il segnale di salute vive dentro /api/cron/poll, che però parla solo se
 * qualcuno lo chiama: se a fermarsi è lo scheduler, tace anche lui. È già
 * successo due volte, e in entrambi i casi ce ne siamo accorti per caso giorni
 * dopo — la seconda ha lasciato un buco di quattordici ore.
 *
 * Qui il controllo non dipende da nessuna pianificazione: guarda l'età
 * dell'ultimo campione scritto dal cron ogni volta che la dashboard si apre.
 * Gli snapshot sono già in pagina per il grafico, quindi non costa una chiamata.
 *
 * Si contano solo i campioni con source 'cron': quelli della dashboard li scrive
 * chi sta guardando, e conteggiarli maschererebbe proprio il guasto da scoprire.
 */

// Come RACCOLTA_FERMA_MIN in /api/cron/poll: sopra i 45 minuti nemmeno la
// cadenza più lenta, quella da 15 minuti ad auto ferma, giustifica il silenzio.
const FERMA_DA_MIN = 45;

type Snapshot = { createdAt: string; source?: string };

export default function RaccoltaFerma({ snapshots }: { snapshots: Snapshot[] }) {
  // Nessun dato affatto significa "sto ancora caricando", non "è tutto rotto"
  if (!snapshots.length) return null;

  const ultimoCron = snapshots
    .filter(s => s.source === 'cron')
    .reduce<number | null>((max, s) => {
      const t = new Date(s.createdAt).getTime();
      return Number.isFinite(t) && (max === null || t > max) ? t : max;
    }, null);

  // Una finestra intera senza un solo campione del cron è il caso peggiore, non
  // il caso ignoto: va detto, non nascosto per mancanza di un numero da mostrare.
  if (ultimoCron === null) {
    return <Avviso testo="Nessuna raccolta automatica nelle ultime 24 ore." />;
  }

  const minuti = Math.round((Date.now() - ultimoCron) / 60000);
  if (minuti <= FERMA_DA_MIN) return null;

  const quanto =
    minuti < 120 ? `${minuti} minuti` : `${Math.round(minuti / 60)} ore`;
  return <Avviso testo={`Ultimo dato automatico ${quanto} fa.`} />;
}

function Avviso({ testo }: { testo: string }) {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3 mb-4">
      <AlertTriangle className="text-amber-400 mt-0.5 shrink-0" size={18} />
      <div>
        <p className="text-sm font-semibold text-amber-300">Raccolta ferma</p>
        <p className="text-sm text-gray-400 mt-1">
          {testo} L&apos;app risponde: a essersi fermato è lo scheduler esterno.
          Controlla che il job su cron-job.org sia ancora attivo.
        </p>
      </div>
    </div>
  );
}
