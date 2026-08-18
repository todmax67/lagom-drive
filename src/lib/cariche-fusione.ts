/**
 * La fusione degli spezzoni di ricarica: una colonnina fermata a metà (stop
 * manuale, stacco di rete) produce più sessioni del rilevatore che sono UNA
 * ricarica. La firma è la continuità: la fine di uno spezzone è l'inizio del
 * successivo (stesso livello, stesso tipo), la ripresa avviene entro le 12
 * ore, e NESSUNA guida sta nel mezzo — quest'ultima si verifica contro la
 * tabella dei viaggi, non si presume dai livelli interi che possono
 * combaciare per caso.
 *
 * La logica vive qui, condivisa fra /api/salute (le coppie muro del
 * testimone B) e /api/charging/sessions (la ricomposizione delle card):
 * due superfici, un solo giudizio — non possono divergere.
 */

export type CaricaFondibile = {
  startedAt: Date;
  endedAt: Date | null;
  startLevel: number;
  endLevel: number | null;
  chargingType: string;
};

const GAP_MAX_MS = 12 * 3600 * 1000;

export function fondiCariche<T extends CaricaFondibile>(
  cariche: T[], // ordinate per startedAt crescente
  viaggi: { startedAt: Date }[]
): T[][] {
  const guidaFra = (da: Date, a: Date) =>
    viaggi.some(t => t.startedAt >= da && t.startedAt <= a);

  const gruppi: T[][] = [];
  for (const c of cariche) {
    const gruppo = gruppi[gruppi.length - 1];
    const prec = gruppo?.[gruppo.length - 1];
    if (
      prec &&
      prec.endLevel != null &&
      prec.endLevel === c.startLevel &&
      prec.chargingType === c.chargingType &&
      prec.endedAt &&
      c.startedAt.getTime() >= prec.endedAt.getTime() &&
      c.startedAt.getTime() - prec.endedAt.getTime() <= GAP_MAX_MS &&
      !guidaFra(prec.endedAt, c.startedAt)
    ) {
      gruppo.push(c);
    } else {
      gruppi.push([c]);
    }
  }
  return gruppi;
}
