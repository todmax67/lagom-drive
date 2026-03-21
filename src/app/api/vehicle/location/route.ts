import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getVin, getLocation } from '@/lib/volvo-api';

export async function GET() {
  const session = await auth();

  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Non autorizzato' }, { status: 401 });
  }

  try {
    const vin = await getVin(session.accessToken);
    const location = await getLocation(session.accessToken, vin);

    return NextResponse.json(location);
  } catch (error) {
    console.error('Errore /api/vehicle/location:', error);
    return NextResponse.json(
      { message: 'Errore nel recupero della posizione' },
      { status: 500 }
    );
  }
}