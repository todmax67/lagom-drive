import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Le sonde del buongiorno degli ultimi giorni: per ogni mattina, il PRIMO
 * campione con la 12V — perché la lettura sveglia il paziente, e ogni campione
 * successivo è già sostenuto dalle centraline accese (bussola §4.4).
 *
 * Non importa come il campione sia nato (rituale guidato, registrazione,
 * sonda manuale con salvataggio): conta che sia il primo della finestra
 * mattutina. Così anche le mattine pre-rituale entrano nella serie.
 */

const GIORNI = 14;
// La finestra "mattina": prima delle 4 è la sera prima, dopo le 14 non è più
// una lettura a riposo notturno.
const ORA_MIN = 4;
const ORA_MAX = 14;
const FUSO = 'Europe/Rome';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }
  const userId = (session as { userId?: string }).userId ?? 'unknown';

  const [settings, campioni] = await Promise.all([
    prisma.settings.findUnique({ where: { userId } }),
    // Anche i campioni senza 12V: la carica arriva dal giro veloce del
    // Registratore, che è un campione diverso da quello dei DID — servono
    // entrambi, uno fa da àncora e l'altro completa.
    prisma.obdSample.findMany({
      where: {
        userId,
        OR: [{ batt12vVoltage: { not: null } }, { socDisplay: { not: null } }],
        recordedAt: { gte: new Date(Date.now() - GIORNI * 24 * 3600 * 1000) },
      },
      orderBy: { recordedAt: 'asc' },
      select: {
        recordedAt: true,
        batt12vVoltage: true,
        packVoltage: true,
        socDisplay: true,
        speedKmh: true,
        didRaw: true,
      },
    }),
  ]);

  const grezzo = (c: (typeof campioni)[number], did: string): string | null =>
    c.didRaw && typeof c.didRaw === 'object' && !Array.isArray(c.didRaw)
      ? ((c.didRaw as Record<string, string>)[did] ?? null)
      : null;

  // Riposo testimoniato: il bus HV (224857) a contattori aperti legge ~2 V.
  // Un'àncora con il bus alimentato è un avviamento o una guida, non una
  // mattina a riposo — è già successo che la "mattina" fosse la 12V a 11.9 V
  // durante l'accensione, spacciata per lettura notturna. Il bus assente
  // (campione senza DID) non condanna: si accetta, perché lo storico
  // pre-decodifica non può testimoniare.
  const aRiposo = (c: (typeof campioni)[number]): boolean => {
    const bus = grezzo(c, '224857');
    return bus === null || parseInt(bus, 16) < 1000; // sotto 100.0 V
  };

  // Raggruppa per giorno locale. L'àncora è il PRIMO campione a riposo con la
  // 12V; carica, pacco e SoH possono vivere in campioni vicini (il giro lento
  // e quello veloce del Registratore distano secondi), quindi si completano
  // dai campioni entro una finestra breve dopo l'àncora.
  const FINESTRA_COMPLETAMENTO_MS = 90_000;
  type Mattina = {
    ancora: (typeof campioni)[number];
    socDisplay: number | null;
    packVoltage: number | null;
    sohGrezzo: string | null;
  };
  // Il taglio della query è un istante qualunque: il giorno più vecchio può
  // essere entrato a metà, e la sua "prima" lettura sarebbe falsa. Si scarta.
  const primoGiorno = new Date(Date.now() - (GIORNI - 1) * 24 * 3600 * 1000)
    .toLocaleDateString('sv-SE', { timeZone: FUSO });

  const perGiorno = new Map<string, Mattina>();
  const respinte = new Set<string>();

  for (const c of campioni) {
    const oraLocale = parseInt(
      c.recordedAt.toLocaleTimeString('en-GB', { timeZone: FUSO, hour: '2-digit', hour12: false }),
      10
    );
    if (oraLocale < ORA_MIN || oraLocale >= ORA_MAX) continue;
    const giorno = c.recordedAt.toLocaleDateString('sv-SE', { timeZone: FUSO });
    if (giorno < primoGiorno) continue;

    const mattina = perGiorno.get(giorno);
    if (!mattina) {
      // L'àncora è la lettura della 12V, e deve essere a riposo: un campione
      // col solo SoC non àncora niente, completa soltanto. Un campione in
      // marcia o col bus alimentato non è una mattina — ma il giorno si
      // registra come "respinto", così la card può dirlo invece di fingere
      // che il rituale non sia stato fatto.
      if (c.batt12vVoltage === null) continue;
      // La verità è quella dell'istante: bus a terra e velocità zero. Un
      // controtestimone sul futuro ("è partito poco dopo") è stato provato e
      // tolto: puniva la sonda fatta in auto un attimo prima di partire, che
      // è l'uso normale del rituale. Il riposo si misura, non si indovina.
      const candidatoValido = (c.speedKmh ?? 0) === 0 && aRiposo(c);
      if (!candidatoValido) {
        respinte.add(giorno);
        continue;
      }
      perGiorno.set(giorno, {
        ancora: c,
        socDisplay: c.socDisplay,
        packVoltage: c.packVoltage,
        sohGrezzo: grezzo(c, '22496D'),
      });
      continue;
    }
    // Completamento dai campioni immediatamente successivi all'àncora
    const dt = c.recordedAt.getTime() - mattina.ancora.recordedAt.getTime();
    if (dt > FINESTRA_COMPLETAMENTO_MS) continue;
    mattina.socDisplay ??= c.socDisplay;
    // La tensione di completamento dev'essere a riposo come l'ancora: un
    // campione del regime viaggio a 1 Hz porterebbe una tensione sotto carico
    // spacciata per riposo mattutino.
    if ((c.speedKmh ?? 0) === 0) mattina.packVoltage ??= c.packVoltage;
    mattina.sohGrezzo ??= grezzo(c, '22496D');
  }

  // Ad auto addormentata i PID standard tacciono mentre i DID svegliano la
  // centralina: il SoC del rituale può mancare. Il cloud campiona tutta la
  // notte: lo snapshot più vicino all'ancora presta il livello (passo 1%),
  // con la fonte dichiarata — il registro fra due mattine torna a calcolarsi.
  const ancore = [...perGiorno.values()].filter(m => m.socDisplay === null);
  const livelliCloud = new Map<string, number>();
  if (ancore.length) {
    for (const m of ancore) {
      const vicino = await prisma.batterySnapshot.findFirst({
        where: {
          userId,
          createdAt: {
            gte: new Date(m.ancora.recordedAt.getTime() - 3600_000),
            lte: new Date(m.ancora.recordedAt.getTime() + 3600_000),
          },
        },
        orderBy: { createdAt: 'desc' },
        select: { level: true },
      }).catch(() => null);
      if (vicino) livelliCloud.set(m.ancora.recordedAt.toISOString(), vicino.level);
    }
  }

  const mattine = [...perGiorno.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([giorno, m]) => {
      const cloud = m.socDisplay === null
        ? (livelliCloud.get(m.ancora.recordedAt.toISOString()) ?? null)
        : null;
      return {
        giorno,
        ora: m.ancora.recordedAt.toISOString(),
        batt12v: m.ancora.batt12vVoltage,
        packVoltage: m.packVoltage,
        socDisplay: m.socDisplay ?? cloud,
        socDaCloud: m.socDisplay === null && cloud !== null,
        sohGrezzo: m.sohGrezzo,
      };
    });

  const oggi = new Date().toLocaleDateString('sv-SE', { timeZone: FUSO });

  return NextResponse.json({
    mattine,
    fattaOggi: perGiorno.has(oggi),
    // Letture di oggi con la 12V ma non a riposo: il rituale è stato tentato,
    // e la card deve poterlo dire invece di mostrare "da fare".
    oggiNonARiposo: !perGiorno.has(oggi) && respinte.has(oggi),
    capacita: settings?.batteryCapacity ?? 67,
  });
}
