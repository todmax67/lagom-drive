/**
 * Il token del dispositivo OBD vive in localStorage, non in React: questo
 * modulo lo espone via useSyncExternalStore, il modo previsto per leggerlo
 * senza disallineare l'idratazione. Registratore e Sonda del buongiorno
 * scrivono entrambi su /api/obd/ingest con lo stesso token: la fonte deve
 * essere una sola.
 */

export const CHIAVE_TOKEN = 'lagom-obd-token';

const ascoltatori = new Set<() => void>();

export const sottoscriviToken = (fn: () => void) => {
  ascoltatori.add(fn);
  return () => { ascoltatori.delete(fn); };
};

export const leggiToken = () => localStorage.getItem(CHIAVE_TOKEN) ?? '';

export const scriviToken = (valore: string) => {
  localStorage.setItem(CHIAVE_TOKEN, valore);
  ascoltatori.forEach(fn => fn());
};
