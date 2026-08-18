/**
 * Il calcolo dell'accoppiatore: dai campioni OBD di una finestra temporale
 * alle misure di un viaggio (docs/progetto-obd.md §4.2).
 *
 * Questo modulo è puro di proposito — niente Prisma, niente I/O — così il
 * conto si può rifare su qualunque insieme di campioni, in un test o in uno
 * script, e la persistenza resta un dettaglio di chi lo chiama.
 *
 * Le regole vengono dalla bussola:
 * - i buchi non si interpolano MAI: la distanza è integrata sui soli tratti
 *   campionati, e i buchi diventano copertura dichiarata e bande grigie;
 * - attacca e rifinisce: i campioni con velocità > 0 correggono anche i tempi
 *   del viaggio, che il cloud ricostruisce a posteriori dai plateau;
 * - un derivato è solo l'ultima versione del grezzo: tutto ricalcolabile.
 */

export type CampioneAccoppiabile = {
  recordedAt: Date;
  speedKmh: number | null;
  socDisplay: number | null;
  packPowerKw: number | null;
};

export type Arricchimento = {
  sampleCount: number;
  coverage: number;
  gaps: { da: string; a: string }[];
  movingStart: Date | null;
  movingEnd: Date | null;
  distanceObdKm: number | null;
  maxSpeedKmh: number | null;
  socStartObd: number | null;
  socEndObd: number | null;
  energyGrossKwh: number | null;
  energyRegenGrossKwh: number | null;
  // Copertura della SERIE DI POTENZA, distinta da quella globale: l'integrale
  // vive sui soli campioni con potenza, e un viaggio pieno di campioni GPS
  // senza V*I avrebbe copertura piena e integrale vuoto. Il badge "misurato"
  // si regge su questa, non sull'altra.
  powerCoverage: number | null;
};

// Oltre questo intervallo fra due campioni il tratto non è né coperto né
// integrabile: a cadenza nominale di 2 s, dieci secondi sono già un buco vero.
// È più severo del limite dei 30 s usato dalla pagina Analisi: qui il numero
// alimenta superfici consumer, e la severità è il prezzo del badge "misurato".
export const INTERVALLO_COPERTO_MS = 10_000;

// Sotto i due campioni utili non c'è niente da misurare
const MIN_CAMPIONI = 2;

// Le bande grigie della UI non hanno bisogno di mille voci: oltre questo tetto
// i buchi restano nel conteggio della copertura ma non nell'elenco.
const MAX_BUCHI_ELENCATI = 40;

export function calcolaArricchimento(
  viaggio: { startedAt: Date; endedAt: Date },
  campioni: CampioneAccoppiabile[]
): Arricchimento | null {
  if (campioni.length < MIN_CAMPIONI) return null;

  const ordinati = [...campioni].sort(
    (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime()
  );

  // Rifinitura dei tempi: primo e ultimo istante in cui l'auto si muoveva.
  //
  // Regola del fermo testimoniato: un confine rifinito vale solo se un campione
  // con velocità ZERO misurata (non null: misurata) sta entro la soglia di
  // copertura prima del primo moto, o dopo l'ultimo. È ciò che distingue
  // "l'auto ha iniziato a muoversi qui" da "la registrazione è partita qui ad
  // auto già in moto": senza il fermo a fare da testimone, la base collasserebbe
  // su ciò che è stato campionato e la copertura dichiarerebbe 100% su mezzo
  // viaggio — il denominatore deve poter essere più largo del numeratore.
  const inMovimento = ordinati.filter(c => (c.speedKmh ?? 0) > 0);
  const primoMoto = inMovimento.length ? inMovimento[0].recordedAt : null;
  const ultimoMoto = inMovimento.length
    ? inMovimento[inMovimento.length - 1].recordedAt
    : null;

  // Un solo campione in moto non è una rifinitura: base cloud, come per zero
  const rifinituraValida =
    primoMoto !== null &&
    ultimoMoto !== null &&
    ultimoMoto.getTime() > primoMoto.getTime();

  const fermoPrima =
    rifinituraValida &&
    ordinati.some(
      c =>
        c.speedKmh === 0 &&
        c.recordedAt < primoMoto &&
        primoMoto.getTime() - c.recordedAt.getTime() <= INTERVALLO_COPERTO_MS
    );
  const fermoDopo =
    rifinituraValida &&
    ordinati.some(
      c =>
        c.speedKmh === 0 &&
        c.recordedAt > ultimoMoto &&
        c.recordedAt.getTime() - ultimoMoto.getTime() <= INTERVALLO_COPERTO_MS
    );

  // La rifinitura si dichiara solo sul lato testimoniato: un movingStart senza
  // fermo davanti direbbe "il viaggio è iniziato qui" senza averlo misurato.
  const movingStart = fermoPrima ? primoMoto : null;
  const movingEnd = fermoDopo ? ultimoMoto : null;

  // La base della copertura: il confine testimoniato vale, quello non
  // testimoniato ricade sul tempo cloud — allargato però al moto osservato
  // fuori finestra, che è misura anche quando il cloud non lo sa.
  const baseInizio = rifinituraValida
    ? movingStart ??
      new Date(Math.min(viaggio.startedAt.getTime(), primoMoto.getTime()))
    : viaggio.startedAt;
  const baseFine = rifinituraValida
    ? movingEnd ??
      new Date(Math.max(viaggio.endedAt.getTime(), ultimoMoto.getTime()))
    : viaggio.endedAt;
  const durataBaseMs = baseFine.getTime() - baseInizio.getTime();
  if (durataBaseMs <= 0) return null;

  // Copertura e buchi si misurano dentro la base, estremi inclusi: un viaggio
  // campionato solo a metà deve dichiararlo anche se i campioni che ha sono
  // fitti. I confini della base contano come punti di appoggio.
  const dentroBase = ordinati.filter(
    c => c.recordedAt >= baseInizio && c.recordedAt <= baseFine
  );
  const appoggi = [
    baseInizio.getTime(),
    ...dentroBase.map(c => c.recordedAt.getTime()),
    baseFine.getTime(),
  ];

  let copertoMs = 0;
  const gaps: { da: string; a: string }[] = [];
  for (let i = 1; i < appoggi.length; i++) {
    const dt = appoggi[i] - appoggi[i - 1];
    // I confini delimitano i buchi ma non accreditano copertura: coperto è
    // solo il tempo fra due campioni veri. Un tratto fra il confine e il primo
    // campione non l'ha misurato nessuno, per corto che sia.
    const fraCampioni = i > 1 && i < appoggi.length - 1;
    if (dt <= INTERVALLO_COPERTO_MS) {
      if (fraCampioni) copertoMs += dt;
    } else if (gaps.length < MAX_BUCHI_ELENCATI) {
      gaps.push({
        da: new Date(appoggi[i - 1]).toISOString(),
        a: new Date(appoggi[i]).toISOString(),
      });
    }
  }
  const coverage = Math.min(1, copertoMs / durataBaseMs);

  // Distanza a trapezio sui soli tratti coperti: sommare attraverso un buco
  // inventerebbe strada, e la strada inventata è il contrario del progetto.
  const conVelocita = ordinati.filter(c => c.speedKmh !== null);
  let distanzaKm = 0;
  for (let i = 1; i < conVelocita.length; i++) {
    const dtMs =
      conVelocita[i].recordedAt.getTime() - conVelocita[i - 1].recordedAt.getTime();
    if (dtMs > INTERVALLO_COPERTO_MS) continue;
    distanzaKm +=
      ((conVelocita[i].speedKmh! + conVelocita[i - 1].speedKmh!) / 2) *
      (dtMs / 3_600_000);
  }

  // L'energia di livello 1: integrale a trapezio della potenza (V*I, kW con
  // segno) sui soli tratti coperti — stessa regola della distanza, i buchi
  // non si interpolano. Il segno separa i due popoli della bussola: positivo
  // e' trazione (lordo), negativo e' recupero (lordo), e il netto e' la
  // differenza. Dal solo saldo SOC il recupero era osservabile solo in
  // discesa; qui si misura sempre.
  const conPotenza = ordinati.filter(c => c.packPowerKw !== null);
  let lordoKwh = 0;
  let recuperoKwh = 0;
  for (let i = 1; i < conPotenza.length; i++) {
    const dtMs =
      conPotenza[i].recordedAt.getTime() - conPotenza[i - 1].recordedAt.getTime();
    if (dtMs > INTERVALLO_COPERTO_MS) continue;
    const kwhSegmento =
      ((conPotenza[i].packPowerKw! + conPotenza[i - 1].packPowerKw!) / 2) *
      (dtMs / 3_600_000);
    if (kwhSegmento >= 0) lordoKwh += kwhSegmento;
    else recuperoKwh += -kwhSegmento;
  }
  const conEnergia = conPotenza.length >= MIN_CAMPIONI;

  // Copertura della potenza: tempo fra campioni con potenza consecutivi
  // entro soglia, sulla stessa base temporale della copertura globale.
  let copertoPotenzaMs = 0;
  for (let i = 1; i < conPotenza.length; i++) {
    const dtMs =
      conPotenza[i].recordedAt.getTime() - conPotenza[i - 1].recordedAt.getTime();
    if (dtMs <= INTERVALLO_COPERTO_MS) copertoPotenzaMs += dtMs;
  }
  const powerCoverage = conEnergia
    ? Math.min(1, copertoPotenzaMs / durataBaseMs)
    : null;

  // Il SOC ai confini della base, mai dell'intera finestra di aggancio: il
  // margine ±20 minuti può contenere una ricarica o una sosta col clima
  // acceso, e i confini SOC devono restare dentro il viaggio.
  const conSoc = dentroBase.filter(c => c.socDisplay !== null);

  return {
    sampleCount: ordinati.length,
    coverage,
    gaps,
    movingStart,
    movingEnd,
    distanceObdKm: conVelocita.length >= MIN_CAMPIONI ? distanzaKm : null,
    maxSpeedKmh: conVelocita.length
      ? Math.max(...conVelocita.map(c => c.speedKmh!))
      : null,
    socStartObd: conSoc.length ? conSoc[0].socDisplay : null,
    socEndObd: conSoc.length ? conSoc[conSoc.length - 1].socDisplay : null,
    energyGrossKwh: conEnergia ? lordoKwh : null,
    energyRegenGrossKwh: conEnergia ? recuperoKwh : null,
    powerCoverage,
  };
}
