import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';

// Funzione che chiama Volvo per ottenere un nuovo access token.
// Volvo ID vuole le credenziali in Basic auth, non nel body: è lo stesso
// schema usato da /api/volvo-token e dal cron di polling.
async function refreshAccessToken(refreshToken: string) {
  try {
    const basicAuth = Buffer.from(
      `${process.env.VOLVO_CLIENT_ID}:${process.env.VOLVO_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch('https://volvoid.eu.volvocars.com/as/token.oauth2', {
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

    const tokens = await response.json();

    if (!response.ok) throw tokens;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
      error: null,
    };
  } catch (error) {
    console.error('Errore refresh token:', error);
    return {
      accessToken: null,
      refreshToken: null,
      expiresAt: 0,
      error: 'RefreshTokenError',
    };
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
  let vin: string | null = null;
  try {
    const vinResponse = await fetch('https://api.volvocars.com/connected-vehicle/v2/vehicles', {
      headers: {
        'Authorization': `Bearer ${account.access_token}`,
        'vcc-api-key': process.env.VOLVO_API_KEY!,
      },
    });
    const vinData = await vinResponse.json();
    vin = vinData?.data?.[0]?.vin ?? null;
  } catch {
    console.error('Errore recupero VIN durante login');
  }

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

      // Propaghiamo i token nuovi al cron, altrimenti resterebbe con quelli vecchi
      if (!refreshed.error && vin) {
        await prisma.userSession.update({
          where: { userId: vin },
          data: {
            accessToken: refreshed.accessToken!,
            refreshToken: refreshed.refreshToken!,
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
        error: refreshed.error,
      };
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