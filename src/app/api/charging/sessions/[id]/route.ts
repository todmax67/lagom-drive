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
  const body = await request.json();
  const { costPerKwh, totalCost, location, notes } = body;

  const updated = await prisma.chargingSession.update({
    where: { id },
    data: {
      ...(costPerKwh !== undefined && { costPerKwh }),
      ...(totalCost !== undefined && { totalCost }),
      ...(location !== undefined && { location }),
      ...(notes !== undefined && { notes }),
    },
  });

  return NextResponse.json(updated);
}