import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getVin, getRechargeStatus, getEngineStatus } from '@/lib/volvo-api';
import { processSnapshot } from '@/lib/charging-detector';

export async function GET() {
  const session = await auth();

  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  try {
    const vin = await getVin(session.accessToken);
    const [battery, isDriving] = await Promise.all([
      getRechargeStatus(session.accessToken, vin).catch(() => null),
      getEngineStatus(session.accessToken, vin).catch(() => false),
    ]);

    // Processa snapshot e rileva ricariche solo se abbiamo dati validi
    if (battery) {
      await processSnapshot(battery).catch(err =>
        console.error('Errore processSnapshot:', err)
      );
    }

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