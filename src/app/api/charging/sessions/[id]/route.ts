import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const { id } = await params;
  const userId = (session as { userId?: string }).userId ?? 'unknown';
  const body = await request.json();
  const { costPerKwh, totalCost, location, notes, wallKwh } = body;

  // I kWh dal contatore a muro: numero positivo e plausibile, o niente.
  // null esplicito cancella (una lettura sbagliata si deve poter togliere).
  const wallValido =
    wallKwh === null ||
    (typeof wallKwh === 'number' && Number.isFinite(wallKwh) && wallKwh > 0 && wallKwh < 200);

  const updated = await prisma.chargingSession.update({
    // updateMany non serve: l'id è unico, ma il filtro su userId impedisce di
    // modificare sessioni altrui indovinando l'id.
    where: { id, userId },
    data: {
      ...(costPerKwh !== undefined && { costPerKwh }),
      ...(totalCost !== undefined && { totalCost }),
      ...(location !== undefined && { location }),
      ...(notes !== undefined && { notes }),
      ...(wallKwh !== undefined && wallValido && { wallKwh }),
    },
  });

  return NextResponse.json(updated);
}