import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';

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

  const samples = (body as { samples?: unknown })?.samples;
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
    let didRaw: Record<string, string> | undefined;
    const grezzi = s.didRaw;
    if (grezzi && typeof grezzi === 'object' && !Array.isArray(grezzi)) {
      const voci = Object.entries(grezzi as Record<string, unknown>)
        .filter(([k, v]) =>
          /^[0-9A-Fa-f]{4,8}$/.test(k) && typeof v === 'string' && /^[0-9A-Fa-f]{2,64}$/.test(v))
        .slice(0, 40);
      if (voci.length) didRaw = Object.fromEntries(voci) as Record<string, string>;
    }

    rows.push({ userId: device.userId, deviceId: device.id, recordedAt, ...metrics, didRaw });
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

  // I tre numeri vanno distinti: un campione già presente non è un errore, ma
  // se "duplicati" resta alto significa che il dongle sta rinviando in continuo.
  return NextResponse.json({
    accepted: inseriti,
    duplicates: rows.length - inseriti,
    rejected,
  });
}
