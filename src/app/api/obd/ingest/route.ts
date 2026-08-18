import { NextResponse, after } from 'next/server';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { arricchisciViaggiNellaFinestra } from '@/lib/accoppiatore';

const MAX_BATCH = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = 60 * 60 * 1000;

// I limiti servono a scartare le letture assurde prima che entrino in tabella:
// un sensore non supportato dalla centralina non risponde con un errore ma con
// un valore fuori scala — molto spesso zero — ed è da lì che nasce la spazzatura.
//
// Per questo, dove la grandezza fisica NON può valere zero mentre il sensore
// funziona, lo zero è escluso dal range: è già successo che un odometro caduto
// a zero venisse salvato come lettura vera e producesse viaggi fantasma da
// decine di migliaia di km. Dove invece lo zero è legittimo — auto ferma,
// corrente a riposo, 0 °C — il range lo ammette.
const RANGES: Record<string, [number, number]> = {
  socDisplay: [0, 100],
  socReal: [0, 100],
  // Sotto il 20% di salute la vettura non sarebbe marciante; sopra il 100 può
  // stare un pacco nuovo che si dichiara oltre il nominale
  soh: [20, 110],
  // Un pacco a 400 V che legge zero significa contattori aperti o nessun dato
  packVoltage: [100, 1000],
  cellVoltageSum: [100, 1000],
  // Negativa in rigenerazione e in ricarica, positiva in scarica: lo zero a
  // riposo è una lettura legittima
  packCurrent: [-1000, 1000],
  packPowerKw: [-300, 300],
  coolantInletC: [-40, 90],
  coolantOutletC: [-40, 90],
  // Zero escluso: è il valore con cui un odometro non disponibile si presenta
  odometer: [1, 2_000_000],
  speedKmh: [0, 400],
  // In Watt, come la sorgente HVCH-CCM: convertire qui aprirebbe la porta a
  // errori di scala silenziosi
  hvacPowerW: [-20_000, 20_000],
  interiorC: [-40, 90],
  ambientC: [-50, 70],
  batt12vSoc: [0, 100],
  // Una 12V che legge zero non è scarica, è un sensore che non risponde
  batt12vVoltage: [6, 20],
  parasiticMa: [-100_000, 100_000],
};

function readMetric(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const [min, max] = RANGES[field];
  return raw >= min && raw <= max ? raw : null;
}

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const device = await prisma.obdDevice.findUnique({ where: { tokenHash } });
  if (!device) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'JSON non valido' }, { status: 400 });
  }

  const corpo = body as {
    samples?: unknown;
    sessionId?: unknown;
    context?: unknown;
    appVersion?: unknown;
  };
  const samples = corpo?.samples;

  // La sessione dichiarata (bussola par. 5.2): id dal client, contesto da una
  // lista chiusa, versione dell'app. Tutto opzionale — i client vecchi e gli
  // script non dichiarano niente — ma se arriva, arriva ben formato.
  const sessionDeclared = typeof corpo.sessionId === 'string' && corpo.sessionId.length > 0;
  let sessionId =
    sessionDeclared && /^[0-9a-fA-F-]{8,64}$/.test(corpo.sessionId as string)
      ? (corpo.sessionId as string)
      : null;
  const CONTESTI = ['buongiorno', 'viaggio', 'carica', 'libero'];
  const context =
    typeof corpo.context === 'string' && CONTESTI.includes(corpo.context)
      ? corpo.context
      : 'libero';
  const appVersion =
    typeof corpo.appVersion === 'string' && /^[\w.-]{1,40}$/.test(corpo.appVersion)
      ? corpo.appVersion
      : null;
  // La sessione appartiene a chi l'ha creata: un id indovinato da un altro
  // dispositivo degrada a null invece di scrivere su una sessione altrui.
  // I campioni passano comunque — la sessione e' metadato.
  if (sessionId) {
    const esistente = await prisma.obdSession
      .findUnique({ where: { id: sessionId }, select: { userId: true, deviceId: true } })
      .catch(() => null);
    if (esistente && (esistente.userId !== device.userId || esistente.deviceId !== device.id)) {
      console.error(`Ingest: sessione ${sessionId} di altro proprietario, degradata`);
      sessionId = null;
    }
  }

  if (!Array.isArray(samples)) {
    return NextResponse.json({ message: 'Campo samples mancante' }, { status: 400 });
  }
  if (samples.length > MAX_BATCH) {
    return NextResponse.json({ message: `Massimo ${MAX_BATCH} campioni per batch` }, { status: 413 });
  }

  const now = Date.now();
  const rows = [];
  let rejected = 0;

  for (const sample of samples) {
    if (typeof sample !== 'object' || sample === null) {
      rejected++;
      continue;
    }
    const s = sample as Record<string, unknown>;

    const recordedAt = new Date(String(s.recordedAt));
    const ts = recordedAt.getTime();
    if (Number.isNaN(ts) || ts < now - MAX_AGE_MS || ts > now + MAX_SKEW_MS) {
      rejected++;
      continue;
    }

    const metrics = Object.fromEntries(
      Object.keys(RANGES).map(field => [field, readMetric(s[field], field)])
    );

    if (Object.values(metrics).every(v => v === null) && !s.didRaw) {
      rejected++;
      continue;
    }

    // I payload grezzi dei DID Volvo: mappa DID -> esadecimale. Si accettano
    // solo chiavi e valori esadecimali di lunghezza ragionevole, così un client
    // difettoso non può riempire la colonna di testo arbitrario.
    //
    // La chiave può essere il solo DID (BECM, per continuità con lo storico) o
    // ECU+DID concatenati (es. D01A01224028): 224028 esiste su due centraline
    // e sono grandezze diverse — senza il prefisso una schiaccerebbe l'altra.
    let didRaw: Record<string, string> | undefined;
    const grezzi = s.didRaw;
    if (grezzi && typeof grezzi === 'object' && !Array.isArray(grezzi)) {
      const voci = Object.entries(grezzi as Record<string, unknown>)
        .filter(([k, v]) =>
          /^[0-9A-Fa-f]{4,14}$/.test(k) && typeof v === 'string' && /^[0-9A-Fa-f]{2,64}$/.test(v))
        .slice(0, 40);
      if (voci.length) didRaw = Object.fromEntries(voci) as Record<string, string>;
    }

    rows.push({ userId: device.userId, deviceId: device.id, recordedAt, sessionId, ...metrics, didRaw });
  }

  // skipDuplicates rende il rinvio innocuo: un dongle che va in timeout dopo
  // aver scritto rispedisce lo stesso batch, e senza questo lo duplicherebbe.
  let inseriti = 0;
  if (rows.length > 0) {
    const esito = await prisma.obdSample.createMany({ data: rows, skipDuplicates: true });
    inseriti = esito.count;
  }

  await prisma.obdDevice.update({
    where: { id: device.id },
    data: { lastSeen: new Date() },
  });

  // La riga della sessione: nasce col primo lotto, si allunga con gli altri.
  // startedAt puo' solo arretrare e endedAt solo avanzare: un lotto in ritardo
  // (la coda della galleria) non deve accorciare una sessione gia' scritta.
  if (sessionId && rows.length > 0) {
    const tempi = rows.map(r => r.recordedAt.getTime());
    const inizio = new Date(Math.min(...tempi));
    const fine = new Date(Math.max(...tempi));
    try {
      await prisma.obdSession.upsert({
        where: { id: sessionId },
        create: {
          id: sessionId,
          userId: device.userId,
          deviceId: device.id,
          context,
          startedAt: inizio,
          endedAt: fine,
          appVersion,
        },
        update: {},
      });
      // Il contesto si puo' solo promuovere: una sessione nata 'libero' che
      // poi dichiara 'viaggio' o 'carica' viene aggiornata, mai il contrario.
      if (context !== 'libero') {
        await prisma.obdSession.updateMany({
          where: { id: sessionId, context: 'libero' },
          data: { context },
        });
      }
      await prisma.obdSession.updateMany({
        where: { id: sessionId, userId: device.userId, startedAt: { gt: inizio } },
        data: { startedAt: inizio },
      });
      await prisma.obdSession.updateMany({
        where: {
          id: sessionId,
          userId: device.userId,
          OR: [{ endedAt: null }, { endedAt: { lt: fine } }],
        },
        data: { endedAt: fine },
      });
    } catch (err) {
      // La sessione e' metadato: un suo intoppo non deve respingere i campioni
      console.error('Ingest: errore sulla sessione', sessionId, err);
    }
  }

  // Un lotto nuovo può riempire buchi di viaggi già arricchiti: si ricalcolano
  // i viaggi che si sovrappongono all'intervallo del lotto. Con `after` il
  // lavoro parte a risposta già inviata: chi manda il lotto è un telefono in
  // auto su rete mobile, e ogni millisecondo di attesa in più è rischio di
  // timeout su dati che sono già al sicuro in tabella.
  //
  // Il gate è su rows e non su inseriti: un rinvio tutto-duplicati è proprio
  // il retry del caso in cui il primo tentativo è morto fra la scrittura e
  // l'arricchimento, e il ricalcolo idempotente in più non costa niente.
  if (rows.length > 0) {
    const tempi = rows.map(r => r.recordedAt.getTime());
    after(() =>
      arricchisciViaggiNellaFinestra(
        device.userId,
        new Date(Math.min(...tempi)),
        new Date(Math.max(...tempi))
      ).catch(err => console.error('Accoppiatore su ingest:', err))
    );
  }

  // I tre numeri vanno distinti: un campione già presente non è un errore, ma
  // se "duplicati" resta alto significa che il dongle sta rinviando in continuo.
  return NextResponse.json({
    accepted: inseriti,
    duplicates: rows.length - inseriti,
    rejected,
    // Dichiarata ma scartata (malformata o di altro proprietario): il client
    // deve poterlo vedere invece di credere i campioni agganciati.
    sessionDropped: sessionDeclared && sessionId === null,
  });
}
