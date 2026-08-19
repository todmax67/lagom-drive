import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { marchiaGuide } from '@/lib/viaggi-fusione';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as { userId?: string }).userId ?? 'unknown';

  const trips = await prisma.trip.findMany({
    where: { userId, isComplete: true },
    orderBy: { startedAt: 'desc' },
    take: 50,
  });

  // L'arricchimento OBD è uno strato separato (docs/progetto-obd.md §4.2):
  // qui si accosta, non si fonde. Il campo `obd` assente significa "viaggio
  // senza campioni", che è il caso normale, non un errore. Il catch copre la
  // finestra in cui la tabella non esiste ancora: Preview e dev condividono il
  // database di produzione, e lì le migration arrivano solo col deploy — la
  // lista viaggi non deve cadere per uno strato che è, per progetto, opzionale.
  const arricchimenti = await prisma.tripEnrichment.findMany({
    where: { tripId: { in: trips.map(t => t.id) } },
  }).catch(() => []);
  const perViaggio = new Map(arricchimenti.map(a => [a.tripId, a]));

  // Il marchio di guida: i ritagli di una stessa strada lo condividono. Il
  // giudizio sta in viaggi-fusione, condiviso con gli aggregati, e misura la
  // sosta vera alla giunzione — la contiguità dei numeri, da sola, non prova
  // niente (il rilevatore la produce per costruzione).
  const marchio = await marchiaGuide(
    userId,
    [...trips].reverse().map(t => ({
      id: t.id,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      startOdometer: t.startOdometer,
      endOdometer: t.endOdometer,
      sessionId: perViaggio.get(t.id)?.sessionId ?? null,
    }))
  );

  // La capacità serve alla card fusa: il dedotto di una guida intera si
  // calcola sul suo ΔSoC complessivo, non sommando i ΔSoC dei ritagli — che
  // il rilevatore tronca a zero uno per uno, e la somma dei troncati
  // sovrastima sistematicamente.
  const settings = await prisma.settings.findUnique({ where: { userId } });

  return NextResponse.json({
    capacita: settings?.batteryCapacity ?? 67,
    viaggi: trips.map(t => ({
      ...t,
      obd: perViaggio.get(t.id) ?? null,
      guidaId: marchio.get(t.id) ?? t.id,
    })),
  });
}
