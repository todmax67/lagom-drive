import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { prisma } from '@/lib/prisma';

/**
 * Il ponte di sessione, lato guscio: la webview naviga qui con codice e
 * verificatore ricevuti via deep link, e ne esce con il cookie di sessione
 * NextAuth — lo stesso JWT (stessi claim, stesso salt) che il login diretto
 * avrebbe prodotto. Da qui in poi il guscio è una sessione come le altre:
 * il jwt callback la rinnova via VIN come sempre.
 *
 * Monouso e a vita breve per costruzione: il codice si brucia PRIMA di
 * verificare e coniare — un tentativo con verificatore sbagliato consuma il
 * codice (chi ha intercettato il deep link può al massimo costringere a
 * rifare il login, mai rubare la sessione). La verifica PKCE confronta
 * l'impronta SHA-256 del verificatore con la sfida fotografata alla nascita
 * del codice.
 */

const NOME_COOKIE = '__Secure-authjs.session-token';
const MAX_AGE_S = 90 * 24 * 60 * 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const codice = searchParams.get('codice') ?? '';
  const verificatore = searchParams.get('verificatore') ?? '';

  const riga = codice
    ? await prisma.ponteSessione.findUnique({ where: { codice } }).catch(() => null)
    : null;

  if (!riga || riga.scade < new Date()) {
    return NextResponse.redirect(new URL('/ponte?esito=scaduto', request.url));
  }

  // Monouso: si brucia prima di verificare. Se due riscatti corrono, il
  // deleteMany ne premia uno solo; un tentativo fallito consuma il codice.
  const bruciato = await prisma.ponteSessione.deleteMany({ where: { codice } });
  if (bruciato.count === 0) {
    return NextResponse.redirect(new URL('/ponte?esito=scaduto', request.url));
  }

  const { __sfida, ...token } = riga.claims as Record<string, unknown>;
  const impronta = createHash('sha256').update(verificatore).digest('base64url');
  if (typeof __sfida !== 'string' || impronta !== __sfida) {
    return NextResponse.redirect(new URL('/ponte?esito=scaduto', request.url));
  }

  const jwt = await encode({
    token,
    secret: process.env.AUTH_SECRET!,
    salt: NOME_COOKIE,
    maxAge: MAX_AGE_S,
  });

  const risposta = NextResponse.redirect(new URL('/', request.url));
  risposta.cookies.set(NOME_COOKIE, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_S,
  });
  return risposta;
}
