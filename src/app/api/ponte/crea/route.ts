import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Il ponte di sessione, lato browser: chi è già loggato (nel Chrome di
 * sistema, dove Volvo ID funziona) chiede un codice monouso a vita breve.
 * I claim della sessione si fotografano ORA e viaggiano col codice: il
 * riscatto nel guscio conia lo stesso JWT che NextAuth avrebbe emesso.
 */

const VITA_MS = 2 * 60 * 1000;

export async function POST() {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }
  const s = session as {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    userId?: string;
    user?: { name?: string | null; email?: string | null };
  };
  const userId = s.userId ?? 'unknown';

  const riga = await prisma.ponteSessione.create({
    data: {
      userId,
      claims: {
        sub: userId,
        name: s.user?.name ?? null,
        email: s.user?.email ?? null,
        accessToken: s.accessToken,
        refreshToken: s.refreshToken ?? null,
        expiresAt: s.expiresAt ?? 0,
        vin: userId,
        error: null,
      },
      scade: new Date(Date.now() + VITA_MS),
    },
  });

  // Pulizia dei codici scaduti: il ponte non accumula spazzatura
  await prisma.ponteSessione
    .deleteMany({ where: { scade: { lt: new Date() } } })
    .catch(() => {});

  return NextResponse.json({ codice: riga.codice });
}
