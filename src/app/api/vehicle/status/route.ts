import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { processSnapshot } from '@/lib/charging-detector';
import { processTrip } from '@/lib/trip-detector';
import { getVin, getRechargeStatus, getEngineStatus, getOdometer } from '@/lib/volvo-api';
import { arricchisciViaggiRecenti } from '@/lib/accoppiatore';

export async function GET() {
  const session = await auth();

  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  const userId = (session as any).userId ?? 'unknown';

  try {
    const vin = await getVin(session.accessToken);
    const [battery, isDriving, odometer] = await Promise.all([
      getRechargeStatus(session.accessToken, vin).catch(() => null),
      getEngineStatus(session.accessToken, vin).catch(() => false),
      getOdometer(session.accessToken, vin).catch(() => null),
    ]);

    if (battery) {
      // odometer null va salvato come assente, non come 0: il trip detector
      // filtra i null, mentre uno 0 lo tratterebbe come lettura reale.
      await processSnapshot(battery, userId, odometer ?? undefined, 'dashboard').catch(err =>
        console.error('Errore processSnapshot:', err)
      );

      // Chi scrive uno snapshot deve anche elaborare i viaggi. Questa rotta
      // scriveva soltanto, e quello snapshot azzerava il contatore di età su
      // cui si regola il polling adattivo: il cron poi saltava il giro, e il
      // salto odometrico non veniva elaborato da nessuno. Un viaggio da 9 km
      // è andato perso esattamente così, mentre la dashboard era aperta.
      //
      // avgConsumption resta null: le statistiche Volvo arrivano da un'altra
      // rotta e chiamarle qui costerebbe una richiesta in più a ogni apertura.
      if (odometer !== null && odometer !== undefined) {
        await processTrip(
          { battery: battery.level, odometer, avgConsumption: null, volvoTripMeterAuto: null },
          userId
        ).catch(err => console.error('Errore processTrip:', err));

        // Stessa regola del cron: chi può aver chiuso un viaggio aggancia i
        // campioni OBD già in tabella. No-op se non c'è niente di nuovo.
        await arricchisciViaggiRecenti(userId).catch(err =>
          console.error('Accoppiatore su status:', err)
        );
      }
    }

    // Qui c'era un upsert che ricopiava i token del JWT in UserSession "così il
    // cron ha sempre token freschi". Faceva il contrario: il JWT è una copia,
    // e UserSession la fonte di verità che il cron rinnova per conto suo. Volvo
    // ruota il refresh token a ogni rinnovo, quindi ricopiare la copia sopra
    // l'originale può sovrascrivere un token vivo con uno già consumato — e al
    // giro dopo il cron fallisce il refresh finché non si rifà il login. È la
    // catena del blackout del 13 agosto: Sonda OBD aperta in dashboard, upsert
    // col JWT stantio, refresh_failed, 503, scheduler disabilitato, 17 ore di
    // buco. La sincronizzazione vera la fa già il callback jwt in auth.ts, che
    // scrive solo quando produce token nuovi.

    return NextResponse.json({
      vin,
      battery,
      isDriving,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Errore /api/vehicle/status:', error);
    return NextResponse.json(
      { message: 'Errore nel recupero dello stato del veicolo' },
      { status: 500 }
    );
  }
}