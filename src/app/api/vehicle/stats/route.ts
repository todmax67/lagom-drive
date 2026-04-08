import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getVin, getStatistics } from '@/lib/volvo-api';

export async function GET() {
  const session = await auth();

  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  try {
    const vin = await getVin(session.accessToken);
    const stats = await getStatistics(session.accessToken, vin);

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Errore /api/vehicle/stats:', error);
    return NextResponse.json(
      { message: 'Errore nel recupero delle statistiche' },
      { status: 500 }
    );
  }
}