import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getVin, getRechargeStatus, getEngineStatus } from '@/lib/volvo-api';

export async function GET() {
  const session = await auth();

  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  try {
    const vin = await getVin(session.accessToken);
    const [battery, isDriving] = await Promise.all([
      getRechargeStatus(session.accessToken, vin),
      getEngineStatus(session.accessToken, vin),
    ]);

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
