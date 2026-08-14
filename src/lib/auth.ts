import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';

// Funzione che chiama Volvo per ottenere un nuovo access token.
// Volvo ID vuole le credenziali in Basic auth, non nel body: è lo stesso
// schema usato da /api/volvo-token e dal cron di polling.
//
// Un fallimento del refresh non è una cosa sola. Un 4xx significa refresh
// token revocato o già consumato: permanente, si cura solo rifacendo il login.
// Un 5xx di Volvo ID, un timeout o una risposta non-JSON sono intoppi che
// passano da soli. Prima confluivano tutti nello stesso RefreshTokenError, e
// un blip di trenta secondi dell'IdP buttava fuori l'utente con una
// credenziale perfettamente valida in mano.
type RefreshEsito =
  | { ok: true; accessToken: string; refreshToken: string; expiresAt: number }
  | { ok: false; permanente: boolean };

async function refreshAccessToken(refreshToken: string): Promise<RefreshEsito> {
  const basicAuth = Buffer.from(
    `${process.env.VOLVO_CLIENT_ID}:${process.env.VOLVO_CLIENT_SECRET}`
  ).toString('base64');

  let response: Response;
  try {
    response = await fetch('https://volvoid.eu.volvocars.com/as/token.oauth2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
  } catch (error) {
    console.error('Refresh token: errore di rete (transitorio):', error);
    return { ok: false, permanente: false };
  }

  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    tokens = await response.json();
  } catch {
    console.error(`Refresh token: risposta non-JSON con status ${response.status}`);
    return { ok: false, permanente: false };
  }

  if (!response.ok || !tokens.access_token) {
    const permanente = response.status >= 400 && response.status < 500;
    console.error(`Refresh token fallito (${response.status}, permanente=${permanente}):`, tokens);
    return { ok: false, permanente };
  }

  return {
    ok: true,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 1800),
  };
}

// Il VIN identifica la riga UserSession che il cron usa per chiamare Volvo.
// Recuperarlo può fallire (l'API veicoli ha i suoi 5xx), e in quel caso si
// riproverà: mai memorizzare un fallimento come identità.
async function recuperaVin(accessToken: string): Promise<string | null> {
  try {
    const risposta = await fetch('https://api.volvocars.com/connected-vehicle/v2/vehicles', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'vcc-api-key': process.env.VOLVO_API_KEY!,
      },
    });
    const dati = await risposta.json();
    return dati?.data?.[0]?.vin ?? null;
  } catch {
    console.error('Errore recupero VIN');
    return null;
  }
}

export const config: NextAuthConfig = {
  providers: [
      {
      id: 'volvo',
      name: 'Volvo',
      type: 'oauth',
      issuer: 'https://volvoid.eu.volvocars.com',
      authorization: {
        url: 'https://volvoid.eu.volvocars.com/as/authorization.oauth2',
        params: {
          scope: 'openid conve:vehicle_relation conve:battery_charge_level conve:engine_status conve:fuel_status conve:odometer_status conve:trip_statistics location:read energy:state:read',
        },
      },
      token: `${process.env.AUTH_URL}/api/volvo-token`,
      userinfo: 'https://api.volvocars.com/customer/identityservice/v1/users/me',
      profile(profile) {
        return {
          id: profile.sub ?? 'unknown',
          name: profile.name ?? profile.given_name ?? 'Utente Volvo',
          email: profile.email ?? '',
        };
      },
      clientId: process.env.VOLVO_CLIENT_ID,
      clientSecret: process.env.VOLVO_CLIENT_SECRET,
    },
  ],

  secret: process.env.AUTH_SECRET,
  debug: false, // era true, ora false

  // PWA personale: sessione lunga e rolling, così non si rifà il login di continuo
  session: {
    strategy: 'jwt',
    maxAge: 90 * 24 * 60 * 60,
  },

  callbacks: {
    async jwt({ token, account }) {
      // Primo login — salviamo i token e recuperiamo il VIN
      if (account) {
        const vin = await recuperaVin(account.access_token as string);

  // Salva sessione nel database per il cron job
        if (vin) {
          const { prisma } = await import('@/lib/prisma');
          await prisma.userSession.upsert({
            where: { userId: vin },
            update: {
              accessToken: account.access_token as string,
              refreshToken: account.refresh_token as string,
              expiresAt: account.expires_at as number,
              lastSeen: new Date(),
            },
            create: {
              userId: vin,
              accessToken: account.access_token as string,
              refreshToken: account.refresh_token as string,
              expiresAt: account.expires_at as number,
            },
          });
        }

        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          error: null,
          sub: token.sub,
          vin,
        };
      }

      // Una sessione nata senza VIN (fetch fallito al login) resterebbe
      // chiavata sul sub OIDC per novanta giorni: il cron lo userebbe come VIN
      // negli URL Volvo e prenderebbe 404 a ogni giro. Il VIN non cambia mai,
      // quindi si ritenta a ogni richiesta finché non arriva.
      if (!token.vin && token.accessToken) {
        const vinRecuperato = await recuperaVin(token.accessToken as string);
        if (vinRecuperato) token.vin = vinRecuperato;
      }

      // Token ancora valido — lo restituiamo così com'è
      if (Date.now() < (token.expiresAt as number) * 1000 - 60_000) {
        return token;
      }

      // Token scaduto. Attenzione: il cron rinnova gli stessi token e Volvo può
      // ruotare il refresh_token invalidando il precedente. Se rinnovassimo con
      // quello dentro il JWT rischieremmo di usarne uno già consumato dal cron,
      // con conseguente logout. La riga UserSession è la fonte di verità.
      const vin = token.vin as string | null;
      const { prisma } = await import('@/lib/prisma');
      const stored = vin
        ? await prisma.userSession.findUnique({ where: { userId: vin } }).catch(() => null)
        : null;

      // Il cron ha già rinnovato di recente: adottiamo i suoi token senza richiamare Volvo
      if (stored && Date.now() < stored.expiresAt * 1000 - 60_000) {
        return {
          ...token,
          accessToken: stored.accessToken,
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt,
          error: null,
        };
      }

      console.log('Token scaduto, refreshing...');
      const refreshed = await refreshAccessToken(stored?.refreshToken ?? (token.refreshToken as string));

      if (refreshed.ok) {
        // Propaghiamo i token nuovi al cron, altrimenti resterebbe con quelli vecchi
        if (vin) {
          await prisma.userSession.update({
            where: { userId: vin },
            data: {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
              lastSeen: new Date(),
            },
          }).catch(err => console.error('Errore sync UserSession:', err));
        }

        return {
          ...token,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
          error: null,
        };
      }

      // Permanente: il refresh token è morto, serve il login. Solo qui si
      // aziona la schermata "connessione scaduta".
      if (refreshed.permanente) {
        return { ...token, error: 'RefreshTokenError' };
      }

      // Transitorio: si lascia tutto com'è e si ritenta alla prossima
      // richiesta. Il token è scaduto e le chiamate falliranno per qualche
      // minuto, ma l'utente resta dentro e la credenziale resta viva.
      return token;
    },

    async session({ session, token }) {
      session.accessToken = token.accessToken as string;
      (session as any).userId = (token as any).vin ?? token.sub;
      (session as any).refreshToken = token.refreshToken; // ← aggiungi
      (session as any).expiresAt = token.expiresAt;       // ← aggiungi
      if (token.error) {
        (session as any).error = token.error;
      }
      return session;
    },
  },
};

export const { handlers, signIn, signOut, auth } = NextAuth(config);