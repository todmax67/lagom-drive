import { NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? session.user?.email ?? 'unknown';
  const devices = await prisma.obdDevice.findMany({
    where: { userId },
    select: { id: true, name: true, createdAt: true, lastSeen: true },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(devices);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? session.user?.email ?? 'unknown';
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Dongle OBD';

  const token = randomBytes(32).toString('base64url');
  const device = await prisma.obdDevice.create({
    data: {
      userId,
      name,
      tokenHash: createHash('sha256').update(token).digest('hex'),
    },
    select: { id: true, name: true, createdAt: true },
  });

  // Il token in chiaro esiste solo qui: in DB c'è solo l'hash
  return NextResponse.json({ ...device, token }, { status: 201 });
}
