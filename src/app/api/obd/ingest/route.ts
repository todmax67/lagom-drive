import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';

const MAX_BATCH = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = 60 * 60 * 1000;

// I limiti servono a scartare le letture assurde prima che entrino in tabella:
// un sensore non supportato dalla centralina non risponde con un errore ma con
// un valore fuori scala, ed è da lì che nasce la spazzatura.
const RANGES: Record<string, [number, number]> = {
  socDisplay: [0, 100],
  socReal: [0, 100],
  soh: [0, 100],
  packVoltage: [0, 1000],
  // Negativa in rigenerazione e in ricarica, positiva in scarica
  packCurrent: [-1000, 1000],
  packPowerKw: [-300, 300],
  cellVoltageSum: [0, 1000],
  coolantInletC: [-40, 90],
  coolantOutletC: [-40, 90],
  odometer: [0, 2_000_000],
  speedKmh: [0, 400],
  // In Watt, come la sorgente HVCH-CCM: convertire qui aprirebbe la porta a
  // errori di scala silenziosi
  hvacPowerW: [-20_000, 20_000],
  interiorC: [-40, 90],
  ambientC: [-50, 70],
  batt12vSoc: [0, 100],
  batt12vVoltage: [0, 20],
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

    if (Object.values(metrics).every(v => v === null)) {
      rejected++;
      continue;
    }

    rows.push({ userId: device.userId, deviceId: device.id, recordedAt, ...metrics });
  }

  if (rows.length > 0) {
    await prisma.obdSample.createMany({ data: rows });
  }
  await prisma.obdDevice.update({
    where: { id: device.id },
    data: { lastSeen: new Date() },
  });

  return NextResponse.json({ accepted: rows.length, rejected });
}
