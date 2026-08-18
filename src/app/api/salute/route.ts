import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * I testimoni della salute batteria (bussola §4.4), come serie temporali:
 *
 * - testimone A: il registro SoH del BECM, una lettura per giorno — in
 *   validazione finché non sarà visto muoversi;
 * - testimone B: le coppie muro delle ricariche — kWh pagati / Δ livello,
 *   con l'efficienza DENTRO il numero (è capacità ÷ η, e si dichiara);
 * - testimone C: i viaggi misurati — netto ∫V×I / ΔSoC, solo con copertura
 *   della potenza ≥ 95% e un salto di SoC sopra la soglia anti-quantizzazione.
 *
 * La pagina si costruisce da sola man mano che i punti si depositano: qui
 * non si promuove niente — la capacità di lavoro resta quella delle
 * impostazioni finché la promozione non sarà un atto deliberato.
 */

// Stessa soglia della card viaggi: sotto, il passo di 0.784% del display
// domina il numero (~±10% già a 8 punti)
const DELTA_SOC_MIN_VIAGGI = 8;
// Le coppie muro usano i livelli cloud (interi): serve un salto più largo
const DELTA_LIVELLO_MIN_MURO = 15;
// Stessa soglia del badge "misurato" della card
const COPERTURA_MIN = 0.95;
const FUSO = 'Europe/Rome';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }
  const userId = (session as { userId?: string }).userId ?? 'unknown';

  const [settings, letture, arricchimenti, cariche] = await Promise.all([
    prisma.settings.findUnique({ where: { userId } }),
    prisma.obdSample.findMany({
      where: { userId, soh: { not: null } },
      orderBy: { recordedAt: 'asc' },
      select: { recordedAt: true, soh: true },
    }),
    // Niente filtro su copertura e SoC qui: la ricomposizione dei ritagli
    // (sotto) giudica la CATENA, non il singolo ritaglio — un ritaglio con
    // copertura 0.93 può appartenere a una guida che pesata fa 0.96, e i SoC
    // servono solo al primo e all'ultimo anello.
    prisma.tripEnrichment.findMany({
      where: {
        userId,
        energyGrossKwh: { not: null },
        energyRegenGrossKwh: { not: null },
      },
      select: {
        tripId: true,
        sessionId: true,
        socStartObd: true,
        socEndObd: true,
        energyGrossKwh: true,
        energyRegenGrossKwh: true,
        powerCoverage: true,
        movingStart: true,
        movingEnd: true,
      },
    }).catch(() => []),
    prisma.chargingSession.findMany({
      where: { userId, endLevel: { not: null } },
      orderBy: { startedAt: 'asc' },
      select: {
        startedAt: true,
        endedAt: true,
        wallKwh: true,
        startLevel: true,
        endLevel: true,
        chargingType: true,
      },
    }),
  ]);

  // Testimone A: una lettura per giorno (la prima: di solito è la sonda del
  // buongiorno, a riposo). Le altre dello stesso giorno confermano soltanto.
  const perGiorno = new Map<string, { t: Date; v: number }>();
  for (const l of letture) {
    const giorno = l.recordedAt.toLocaleDateString('sv-SE', { timeZone: FUSO });
    if (!perGiorno.has(giorno)) perGiorno.set(giorno, { t: l.recordedAt, v: l.soh! });
  }
  const sohSerie = [...perGiorno.values()].map(p => ({ t: p.t.toISOString(), v: p.v }));
  const valoriDistinti = new Set(letture.map(l => l.soh!.toFixed(2))).size;

  // Testimone C: i ritagli si ricompongono PRIMA di giudicare, con le stesse
  // regole della card viaggi (ricomponi in TripHistory): contigui entro 3
  // minuti con la stessa sessione OBD sono una guida sola. Senza questo, la
  // card fusa promette un punto che qui non esiste (ritagli da ΔSoC 5+6), o
  // la stessa guida pesa due volte nella serie (ritagli da 9+10). La copertura
  // si pesa sulla durata dei ritagli; il ΔSoC va dal primo all'ultimo anello.
  // TUTTI i viaggi, non solo quelli arricchiti: servono da testimoni di
  // contiguità — sia alla catena dei ritagli (l'anello successivo dev'essere
  // il viaggio IMMEDIATAMENTE successivo: un ritaglio di mezzo escluso dalla
  // query non va scavalcato, o il ΔSoC conterebbe un consumo che il netto non
  // vede) sia alla fusione delle ricariche (una guida fra due spezzoni smente
  // la continuità che i livelli interi possono fingere per caso).
  const tuttiViaggi = await prisma.trip.findMany({
    where: { userId, isComplete: true },
    orderBy: { startedAt: 'asc' },
    select: { id: true, startedAt: true, endedAt: true },
  });
  const infoViaggi = new Map(tuttiViaggi.map(t => [t.id, t]));
  const posizione = new Map(tuttiViaggi.map((t, i) => [t.id, i]));

  const righe = arricchimenti
    .flatMap(a => {
      const t = infoViaggi.get(a.tripId);
      return t ? [{ ...a, startedAt: t.startedAt, endedAt: t.endedAt }] : [];
    })
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  const catene: (typeof righe)[] = [];
  for (const r of righe) {
    const catena = catene[catene.length - 1];
    const prec = catena?.[catena.length - 1];
    if (
      prec &&
      r.sessionId != null &&
      r.sessionId === prec.sessionId &&
      prec.endedAt &&
      Math.abs(r.startedAt.getTime() - prec.endedAt.getTime()) < 3 * 60 * 1000 &&
      // L'anello dev'essere il viaggio subito successivo in tabella
      posizione.get(r.tripId) === (posizione.get(prec.tripId) ?? -2) + 1
    ) {
      catena.push(r);
    } else {
      catene.push([r]);
    }
  }

  const viaggi = catene
    .map(catena => {
      const primo = catena[0];
      const ultimo = catena[catena.length - 1];
      if (primo.socStartObd == null || ultimo.socEndObd == null) return null;
      const deltaSoc = primo.socStartObd - ultimo.socEndObd;
      let netto = 0;
      let pesoTot = 0;
      let coperturaPesata = 0;
      for (const r of catena) {
        if (r.powerCoverage == null) return null;
        netto += r.energyGrossKwh! - r.energyRegenGrossKwh!;
        const da = r.movingStart ?? r.startedAt;
        const a = r.movingEnd ?? r.endedAt ?? r.startedAt;
        const peso = Math.max(0, a.getTime() - da.getTime());
        pesoTot += peso;
        coperturaPesata += r.powerCoverage * peso;
      }
      const copertura =
        pesoTot > 0
          ? coperturaPesata / pesoTot
          : catena.length === 1
            ? catena[0].powerCoverage!
            : null;
      if (copertura == null || copertura < COPERTURA_MIN) return null;
      if (deltaSoc < DELTA_SOC_MIN_VIAGGI || netto <= 0) return null;
      return { t: primo.startedAt.toISOString(), kwh: (netto / deltaSoc) * 100 };
    })
    .filter((x): x is { t: string; kwh: number } => x !== null)
    .sort((a, b) => a.t.localeCompare(b.t));

  // Testimone B: capacità ÷ η, dichiarato tale.
  //
  // Gli spezzoni si ricompongono, come i ritagli dei viaggi: una colonnina
  // fermata a metà (è successo il 15 ago, stop manuale per accendere forno e
  // induzione) produce due sessioni del rilevatore che sono UNA ricarica. La
  // firma è la continuità di livello: fine di una == inizio della successiva,
  // nessuna guida in mezzo, ripresa entro le 12 ore. Il contatore del gruppo
  // è la somma dei wallKwh inseriti — vale sia col totale scritto una volta
  // sola, sia coi contatori per-spezzone.
  const GAP_MAX_MS = 12 * 3600 * 1000;
  // "Nessuna guida in mezzo" va verificato, non presunto: due ricariche
  // distinte possono combaciare per caso sui livelli interi
  const guidaFra = (da: Date, a: Date) =>
    tuttiViaggi.some(t => t.startedAt >= da && t.startedAt <= a);
  const gruppi: (typeof cariche)[] = [];
  for (const c of cariche) {
    const gruppo = gruppi[gruppi.length - 1];
    const prec = gruppo?.[gruppo.length - 1];
    if (
      prec &&
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
  const muro = gruppi
    .map(g => {
      const delta = g[g.length - 1].endLevel! - g[0].startLevel;
      const contatori = g.filter(c => c.wallKwh != null);
      if (contatori.length === 0 || delta < DELTA_LIVELLO_MIN_MURO) return null;
      // Sui gruppi spezzati la convenzione è UNA lettura del contatore per
      // l'intera ricarica, su uno spezzone qualunque. Più letture sono
      // ambigue — per-spezzone? totale duplicato su ogni card? — e
      // sommandole si fabbricherebbe un punto: meglio nessun punto.
      if (g.length > 1 && contatori.length > 1) return null;
      const wall = contatori.reduce((s, c) => s + c.wallKwh!, 0);
      return { t: g[0].startedAt.toISOString(), kwh: (wall / delta) * 100 };
    })
    .filter((x): x is { t: string; kwh: number } => x !== null);

  return NextResponse.json({
    capacitaLavoro: settings?.batteryCapacity ?? 67,
    soh: {
      serie: sohSerie,
      ultimo: letture.length ? letture[letture.length - 1].soh : null,
      letture: letture.length,
      dal: letture.length ? letture[0].recordedAt.toISOString() : null,
      valoriDistinti,
    },
    viaggi,
    muro,
  });
}
