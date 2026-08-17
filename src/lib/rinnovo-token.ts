/**
 * L'UNICO posto dove il refresh token Volvo viene speso.
 *
 * Gli attori che arrivano alla scadenza sono almeno tre — il cron (due
 * scheduler), la PWA sul telefono, il browser sul PC — e Volvo ruota il
 * refresh token a ogni uso: due rinnovi concorrenti bruciano il token, e al
 * riuso l'IdP può revocare l'intero grant. È successo tre volte, ogni volta
 * da una coppia diversa di attori. Le pezze per-attore non bastano: serve un
 * solo rinnovatore alla volta, e la riga UserSession è l'unico posto che
 * tutti vedono.
 *
 * La pretesa è un compare-and-swap: updateMany dove expiresAt vale ancora il
 * valore letto, spostandolo di un secondo. Chi aggiorna una riga ha vinto e
 * rinnova; chi ne aggiorna zero ha perso, aspetta e adotta i token freschi.
 * Se il vincitore muore a metà, il +1 resta e la pretesa si può rivincere al
 * giro dopo: nessun lucchetto da ripulire.
 */

import { prisma } from '@/lib/prisma';

const ANTICIPO_MS = 60_000;

export type EsitoRinnovo =
  | { ok: true; accessToken: string; refreshToken: string; expiresAt: number }
  | { ok: false; permanente: boolean };

export async function accessTokenValido(userId: string): Promise<EsitoRinnovo> {
  const riga = await prisma.userSession.findUnique({ where: { userId } }).catch(() => null);
  if (!riga) return { ok: false, permanente: true };

  if (Date.now() < riga.expiresAt * 1000 - ANTICIPO_MS) {
    return {
      ok: true,
      accessToken: riga.accessToken,
      refreshToken: riga.refreshToken,
      expiresAt: riga.expiresAt,
    };
  }

  // La pretesa: vince chi sposta expiresAt per primo
  const pretesa = await prisma.userSession
    .updateMany({
      where: { userId, expiresAt: riga.expiresAt },
      data: { expiresAt: riga.expiresAt + 1 },
    })
    .catch(() => ({ count: 0 }));

  if (pretesa.count === 0) {
    // Un altro attore sta rinnovando in questo istante: breve attesa e
    // adozione dei suoi token. Perdere la corsa non è un errore.
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const dopo = await prisma.userSession.findUnique({ where: { userId } }).catch(() => null);
      if (dopo && Date.now() < dopo.expiresAt * 1000 - ANTICIPO_MS) {
        return {
          ok: true,
          accessToken: dopo.accessToken,
          refreshToken: dopo.refreshToken,
          expiresAt: dopo.expiresAt,
        };
      }
    }
    // Il vincitore non ha ancora scritto: transitorio, si ritenta al giro dopo
    return { ok: false, permanente: false };
  }

  let response: Response;
  try {
    response = await fetch('https://volvoid.eu.volvocars.com/as/token.oauth2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(
          `${process.env.VOLVO_CLIENT_ID}:${process.env.VOLVO_CLIENT_SECRET}`
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: riga.refreshToken,
      }),
    });
  } catch (err) {
    console.error(`Rinnovo token: errore di rete per ${userId}:`, err);
    return { ok: false, permanente: false };
  }

  if (!response.ok) {
    // Con la pretesa vinta nessun altro sta parlando con Volvo: un 4xx qui è
    // un grant davvero morto, non una corsa persa. Si cura solo col login.
    const permanente = response.status >= 400 && response.status < 500;
    const detail = await response.text().catch(() => '');
    console.error(
      `Rinnovo token fallito per ${userId}: HTTP ${response.status} (permanente=${permanente}) ${detail.slice(0, 300)}`
    );
    return { ok: false, permanente };
  }

  const tokens = await response.json();
  const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 1800);
  await prisma.userSession.update({
    where: { userId },
    data: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? riga.refreshToken,
      expiresAt,
      lastSeen: new Date(),
    },
  });

  return {
    ok: true,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? riga.refreshToken,
    expiresAt,
  };
}
