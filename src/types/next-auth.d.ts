import 'next-auth';

declare module 'next-auth' {
  interface Session {
    accessToken: string;
    error?: string;
  }
}

// Campi opzionali com'è la realtà: il token appena nato (prima del giro nel
// jwt callback) non li ha ancora. Quest'augmentation era dormiente finché
// nessuno importava 'next-auth/jwt'; il ponte di sessione l'ha svegliata.
declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    vin?: string | null;
    error?: string | null;
  }
}
