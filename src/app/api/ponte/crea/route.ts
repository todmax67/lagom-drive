import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * Il ponte di sessione, lato browser: chi è già loggato (nel Chrome di
 * sistema, dove Volvo ID funziona) chiede un codice monouso a vita breve.
 * I claim della sessione si fotografano ORA e viaggiano col codice: il
 * riscatto nel guscio conia lo stesso JWT che NextAuth avrebbe emesso.
 *
 * Due difese, entrambe necessarie:
 * - il codice sono 256 bit di crypto.randomBytes — il cuid di default è
 *   indovinabile (timestamp + contatore) e il riscatto è un endpoint aperto;
 * - il codice è legato alla SFIDA del guscio (PKCE): l'impronta SHA-256 di
 *   un verificatore che non lascia mai l'app. Lo scheme lagomdrive:// non ha
 *   verifica di proprietà: un'app coinstallata può intercettare il deep
 *   link, ma senza verificatore il codice non riscatta niente.
 */

const VITA_MS = 2 * 60 * 1000;
// L'impronta SHA-256 in base64url: 43 caratteri, sempre
const FORMA_SFIDA = /^[A-Za-z0-9_-]{43}$/;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  let sfida = '';
  try {
    const body = await request.json();
    if (typeof body?.sfida === 'string') sfida = body.sfida;
  } catch { /* body assente o malformato: respinto sotto */ }
  if (!FORMA_SFIDA.test(sfida)) {
    return NextResponse.json({ message: 'Sfida mancante o malformata' }, { status: 400 });
  }

  const s = session as {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    userId?: string;
    vin?: string | null;
    sub?: string | null;
    user?: { name?: string | null; email?: string | null };
  };

  const riga = await prisma.ponteSessione.create({
    data: {
      codice: randomBytes(32).toString('base64url'),
      userId: s.userId ?? 'unknown',
      claims: {
        // sub e vin SEPARATI, col vin che può essere null: un vin=sub
        // (truthy ma falso) non passerebbe mai dall'auto-guarigione di
        // auth.ts e resterebbe chiavato sul sub per novanta giorni
        sub: s.sub ?? s.userId ?? 'unknown',
        name: s.user?.name ?? null,
        email: s.user?.email ?? null,
        accessToken: s.accessToken,
        refreshToken: s.refreshToken ?? null,
        expiresAt: s.expiresAt ?? 0,
        vin: s.vin ?? null,
        error: null,
        __sfida: sfida,
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
