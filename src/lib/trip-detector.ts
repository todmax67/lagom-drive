import { prisma } from '@/lib/prisma';

interface VehicleData {
  battery: number;
  odometer: number;
  avgConsumption: number;
  volvoTripMeterAuto: number | null;
}

const MIN_MOVE_KM = 0.2;
const MIN_TRIP_KM = 0.5;
const MAX_PLAUSIBLE_DELTA_KM = 500;

// Quanto indietro cercare la partenza. Con il polling adattivo la cadenza varia,
// quindi il limite vero è temporale; il take serve solo a non caricare tutto.
const MAX_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const LOOKBACK_SNAPSHOTS = 250;

// Durata di un tratto a batteria identica oltre la quale si assume veicolo fermo.
// Va misurata in minuti e non in numero di snapshot: con il polling adattivo tre
// campioni valgono 6 minuti o 45 a seconda del regime. In marcia un punto
// percentuale se ne va in pochi minuti, quindi un plateau così lungo è una sosta.
const SOSTA_MS = 20 * 60 * 1000;

// Intervallo massimo fra due snapshot perché la finestra sia considerata
// continua. Oltre, qualcosa può essere accaduto senza lasciare traccia.
const MAX_INTERVALLO_OSSERVABILE_MS = 25 * 60 * 1000;

// Distanza fra i due snapshot che delimitano il salto. Con il polling adattivo
// non si superano i 15 minuti: oltre questa soglia c'è stato un buco nella
// raccolta e i km accumulati non appartengono a un singolo viaggio.
const MAX_GAP_MS = 60 * 60 * 1000;

// Sotto queste soglie la risoluzione dell'1% del SOC domina il risultato:
// su 1 km un solo punto percentuale vale 67 kWh/100km.
const MIN_KM_PER_CONSUMO = 10;
const MIN_SOC_PER_CONSUMO = 2;

type Snap = {
  createdAt: Date;
  level: number;
  odometer: number | null;
  isCharging: boolean;
};

/**
 * L'endpoint odometro di Volvo non si aggiorna durante la marcia: riporta il
 * nuovo valore solo a veicolo parcheggiato. Il livello batteria invece è live.
 *
 * Ne consegue che un salto dell'odometro segnala un viaggio GIÀ CONCLUSO, non
 * uno in corso: il viaggio va scritto tutto in una volta, ricostruendo la
 * finestra all'indietro sulla batteria. Trattare il salto come "sto partendo"
 * produceva viaggi di 3-4 minuti (il ritardo di aggiornamento) con consumo
 * nullo, perché start e end battery finivano entrambi dopo la marcia.
 */
function trovaPartenza(snaps: Snap[], jumpIdx: number): number {
  const end = snaps[jumpIdx];
  const odoPrima = snaps[jumpIdx - 1].odometer;

  // Finestra cieca: gli snapshot che condividono l'odometro pre-salto, cioè
  // tutto il tempo in cui l'auto ha guidato senza che l'odometro lo dicesse.
  let inizio = jumpIdx - 1;
  while (
    inizio > 0 &&
    snaps[inizio - 1].odometer === odoPrima &&
    !snaps[inizio - 1].isCharging &&
    end.createdAt.getTime() - snaps[inizio - 1].createdAt.getTime() <= MAX_LOOKBACK_MS
  ) {
    inizio--;
  }

  // Nella finestra la batteria cala guidando e resta piatta da fermi: la
  // partenza è la fine dell'ULTIMA sosta. Vanno quindi scorsi tutti i tratti
  // piatti, non solo i primi: fermarsi al primo plateau corto lascerebbe dentro
  // al viaggio le soste successive, e con l'auto parcheggiata di notte la
  // batteria cala a scatti irregolari, alternando tratti brevi e lunghi.
  let partenza = inizio;
  let i = inizio;
  while (i < jumpIdx) {
    let j = i;
    while (j + 1 < jumpIdx && snaps[j + 1].level === snaps[i].level) j++;
    const durataMs = snaps[j].createdAt.getTime() - snaps[i].createdAt.getTime();
    if (durataMs >= SOSTA_MS) partenza = j;
    i = j + 1;
  }

  return partenza;
}

export async function processTrip(data: VehicleData, userId: string) {
  const settings = await prisma.settings.upsert({
    where: { userId },
    update: {},
    create: { id: userId, userId },
  });

  const capacity = settings.batteryCapacity;

  // I salti sono rari, qualche volta al giorno: il caso comune deve restare a
  // due righe, e la finestra di lookback si carica solo quando serve davvero.
  const ultimi2 = await prisma.batterySnapshot.findMany({
    where: { userId, odometer: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { createdAt: true, level: true, odometer: true, isCharging: true },
  });

  if (ultimi2.length < 2) {
    console.log('Trip detector — non abbastanza snapshot, skip');
    return;
  }

  const fine = ultimi2[0] as Snap;
  const precedente = ultimi2[1] as Snap;
  const distanceKm = (fine.odometer ?? 0) - (precedente.odometer ?? 0);

  if (distanceKm < MIN_MOVE_KM) return;

  if (distanceKm > MAX_PLAUSIBLE_DELTA_KM) {
    console.error(`Trip detector — salto odometrico implausibile (${distanceKm} km), ignorato`);
    return;
  }

  if (distanceKm < MIN_TRIP_KM) return;

  // Un buco nella raccolta accumula i km di più viaggi in un solo salto: con
  // il cron fermo per giorni si otterrebbero "viaggi" di 288 km in 6 giorni,
  // con la batteria magari più carica alla fine perché nel mezzo si è ricaricato.
  const gapMs = fine.createdAt.getTime() - precedente.createdAt.getTime();
  if (gapMs > MAX_GAP_MS) {
    console.error(
      `Trip detector — buco di ${Math.round(gapMs / 60000)} min fra gli snapshot, ` +
        `i ${distanceKm} km non sono attribuibili a un singolo viaggio`
    );
    return;
  }

  // Il salto viene osservato una volta sola, ma un poll ripetuto sugli stessi
  // snapshot creerebbe un duplicato: l'odometro di arrivo lo identifica.
  const giaRegistrato = await prisma.trip.findFirst({
    where: { userId, endOdometer: fine.odometer },
  });
  if (giaRegistrato) return;

  const finestra = await prisma.batterySnapshot.findMany({
    where: {
      userId,
      odometer: { not: null },
      createdAt: {
        gte: new Date(fine.createdAt.getTime() - MAX_LOOKBACK_MS),
        lte: fine.createdAt,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: LOOKBACK_SNAPSHOTS,
    select: { createdAt: true, level: true, odometer: true, isCharging: true },
  });

  const snaps = finestra.reverse() as Snap[];
  const jumpIdx = snaps.length - 1;

  // Serve almeno lo snapshot pre-salto per ricostruire: senza, si ripiega su
  // quello che si ha invece di sollevare un errore che il cron inghiottirebbe.
  const partenzaIdx = jumpIdx >= 1 ? trovaPartenza(snaps, jumpIdx) : -1;
  const partenza = partenzaIdx >= 0 ? snaps[partenzaIdx] : precedente;

  const batteryDrop = partenza.level - fine.level;

  // Lo stato della spina va riletto senza il filtro sull'odometro: uno snapshot
  // con odometro nullo è escluso dalla ricostruzione ma porta comunque la prova
  // di una ricarica, e scartarlo significherebbe cercare quella prova proprio
  // dove è stata cancellata.
  const finestraStato = await prisma.batterySnapshot.findMany({
    where: { userId, createdAt: { gte: partenza.createdAt, lte: fine.createdAt } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true, isCharging: true },
  });

  const ricaricaOsservata = finestraStato.some(s => s.isCharging);

  // Una ricarica dentro un buco della raccolta non lascia tracce, e la batteria
  // più carica all'arrivo verrebbe scambiata per rigenerazione. Non si può
  // dedurre l'assenza di ricarica dall'assenza di prove: serve che la finestra
  // sia continua, cioè che una ricarica sarebbe stata osservabile.
  let intervalloMax = 0;
  for (let k = 1; k < finestraStato.length; k++) {
    intervalloMax = Math.max(
      intervalloMax,
      finestraStato[k].createdAt.getTime() - finestraStato[k - 1].createdAt.getTime()
    );
  }
  const finestraContinua =
    finestraStato.length >= 2 && intervalloMax <= MAX_INTERVALLO_OSSERVABILE_MS;

  // Il salto odometrico è un fatto: quei km sono stati percorsi, e il viaggio va
  // registrato comunque. La lettura della batteria è invece un'inferenza, che
  // una ricarica in finestra o un buco nella raccolta possono contaminare.
  // Quando non è attendibile si salvano distanza e orari e si lasciano nulli i
  // campi energetici, invece di scartare il viaggio o di inventarne i numeri.
  const batteriaAttendibile = finestraContinua && !ricaricaOsservata && !fine.isCharging;

  if (!batteriaAttendibile) {
    console.log(
      `Trip detector — ${distanceKm} km registrati senza dati energetici ` +
        `(ricaricaOsservata=${ricaricaOsservata}, finestraContinua=${finestraContinua}, ` +
        `inCaricaAllArrivo=${fine.isCharging})`
    );
  } else if (batteryDrop < 0) {
    console.log(
      `Trip detector — rigenerazione netta di ${-batteryDrop}% su ${distanceKm} km`
    );
  }

  // Derivati dalla capacità impostata: non utilizzabili per stimare la capacità.
  const energyUsedKwh = batteriaAttendibile
    ? Math.max(0, (batteryDrop / 100) * capacity)
    : null;

  // Su tratte brevi o con ΔSOC minimo il consumo è dominato dall'arrotondamento
  // dell'1%: meglio nessun valore che un valore inventato. La UI lo omette.
  const consumoAffidabile =
    batteriaAttendibile &&
    distanceKm >= MIN_KM_PER_CONSUMO &&
    batteryDrop >= MIN_SOC_PER_CONSUMO;
  const avgConsumption = consumoAffidabile
    ? ((batteryDrop / 100) * capacity * 100) / distanceKm
    : null;

  // Indipendente dalla capacità impostata e dalla spina: viene da Volvo.
  const energyFromVolvoKwh = (distanceKm / 100) * data.avgConsumption;

  // Rigenerazione realmente misurata: i kWh guadagnati dalla batteria. Dal solo
  // SOC è osservabile unicamente a saldo positivo, cioè in discesa; altrimenti
  // il recupero c'è ma resta nascosto dentro il consumo netto.
  const energyRegenKwh =
    batteriaAttendibile && batteryDrop < 0 ? (-batteryDrop / 100) * capacity : null;

  const MIN_CALIB_KM = 15;
  const MIN_CALIB_SOC = 10;
  const eligible =
    batteriaAttendibile &&
    distanceKm >= MIN_CALIB_KM &&
    batteryDrop >= MIN_CALIB_SOC &&
    data.avgConsumption > 0;
  const rawCapacity = eligible ? (data.avgConsumption * distanceKm) / batteryDrop : null;
  const capacityEstimateKwh =
    rawCapacity !== null && rawCapacity >= 30 && rawCapacity <= 120 ? rawCapacity : null;

  console.log(
    `Trip detector — viaggio di ${distanceKm} km ricostruito: ` +
      `${partenza.createdAt.toISOString()} -> ${fine.createdAt.toISOString()}, ` +
      `batteria ${partenza.level}% -> ${fine.level}%`
  );

  await prisma.trip.create({
    data: {
      userId,
      startedAt: partenza.createdAt,
      endedAt: fine.createdAt,
      startBattery: partenza.level,
      endBattery: batteriaAttendibile ? fine.level : null,
      startOdometer: precedente.odometer,
      endOdometer: fine.odometer,
      distanceKm,
      energyUsedKwh,
      energyRegenKwh,
      avgConsumption,
      energyFromVolvoKwh,
      capacityEstimateKwh,
      volvoAvgConsumption: data.avgConsumption,
      volvoTripMeterEnd: data.volvoTripMeterAuto,
      isComplete: true,
    },
  });
}
