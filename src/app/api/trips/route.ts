import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? 'unknown';

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

  return NextResponse.json(
    trips.map(t => ({ ...t, obd: perViaggio.get(t.id) ?? null }))
  );
}
