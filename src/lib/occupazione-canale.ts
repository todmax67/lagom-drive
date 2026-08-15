/**
 * Chi sta usando il canale ELM327. Il canale serializza i singoli comandi, ma
 * lo stato AT del dongle (header, priorità, filtro) è globale: due sessioni
 * interlacciate si calpestano gli header e producono numeri plausibili e
 * falsi — un 22F442 in broadcast può raccogliere la risposta di chiunque.
 * L'esclusione è una regola delle sessioni, non del canale: vive qui e la
 * rispettano i componenti che le sessioni avviano.
 */

export type Occupante = null | 'registratore' | 'buongiorno' | 'sonda';

let occupante: Occupante = null;
const ascoltatori = new Set<() => void>();

export const sottoscriviOccupazione = (fn: () => void) => {
  ascoltatori.add(fn);
  return () => { ascoltatori.delete(fn); };
};

export const leggiOccupazione = (): Occupante => occupante;

export const occupaCanale = (chi: Occupante) => {
  occupante = chi;
  ascoltatori.forEach(fn => fn());
};
