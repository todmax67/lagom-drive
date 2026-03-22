import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';

// Funzione che chiama Volvo per ottenere un nuovo access token
async function refreshAccessToken(refreshToken: string) {
  try {
    const response = await fetch('https://volvoid.eu.volvocars.com/as/token.oauth2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.VOLVO_CLIENT_ID!,
        client_secret: process.env.VOLVO_CLIENT_SECRET!,
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

  callbacks: {
    async jwt({ token, account }) {
      // Primo login — salviamo i token
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          error: null,
          sub: token.sub,
        };
      }

      // Token ancora valido — lo restituiamo così com'è
      // Aggiungiamo 60 secondi di margine per evitare race condition
      if (Date.now() < (token.expiresAt as number) * 1000 - 60_000) {
        return token;
      }

      // Token scaduto — lo aggiorniamo
      console.log('Token scaduto, refreshing...');
      const refreshed = await refreshAccessToken(token.refreshToken as string);

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
      (session as any).userId = token.sub; // ← usa sub dal JWT, sempre stabile
      if (token.error) {
        (session as any).error = token.error;
      }
      return session;
    },
  },
};

export const { handlers, signIn, signOut, auth } = NextAuth(config);