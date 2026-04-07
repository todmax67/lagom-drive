import type {
  VehicleListResponse,
  OdometerResponse,
  StatisticsResponse,
  LocationResponse,
  EngineStatusResponse,
  VehicleStatus,
  VehicleStats,
  VehicleLocation,
} from '@/types/volvo';

const VOLVO_API_BASE = 'https://api.volvocars.com';
const API_KEY = process.env.VOLVO_API_KEY!;

// ============================================================
//  HELPER — fetch autenticato verso le API Volvo
// ============================================================

async function volvoFetch<T>(
  endpoint: string,
  accessToken: string
): Promise<T> {
  const url = `${VOLVO_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'vcc-api-key': API_KEY,
      'Content-Type': 'application/json',
    },
    // Disabilita la cache di Next.js — vogliamo sempre dati freschi
    cache: 'no-store',
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Volvo API error: ${response.status} su ${endpoint}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================
//  FUNZIONI API
// ============================================================

// --- Ottieni il VIN del primo veicolo associato all'account ---
export async function getVin(accessToken: string): Promise<string> {
  const data = await volvoFetch<VehicleListResponse>(
    '/connected-vehicle/v2/vehicles',
    accessToken
  );

  if (!data.data || data.data.length === 0) {
    throw new Error('Nessun veicolo trovato per questo account.');
  }

  return data.data[0].vin;
}

// --- Stato batteria e ricarica ---
export async function getRechargeStatus(
  accessToken: string,
  vin: string
): Promise<VehicleStatus['battery']> {
  const data = await volvoFetch<any>(
    `/energy/v2/vehicles/${vin}/state`,
    accessToken
  );

  const d = data;
  const connectionValue = d.chargerConnectionStatus?.value ?? 'DISCONNECTED';
  const chargingValue = d.chargingStatus?.value ?? 'IDLE';

  const isConnected = connectionValue !== 'DISCONNECTED';
  const isCharging = chargingValue === 'CHARGING';

  const chargingType: 'AC' | 'DC' | null =
    d.chargingType?.value === 'DC' ? 'DC' :
    d.chargingType?.value === 'AC' ? 'AC' :
    null;

  return {
    level: d.batteryChargeLevel?.value ?? 0,
    range: d.electricRange?.value ?? 0,
    isCharging,
    isConnected,
    chargingType,
    estimatedMinutes: d.estimatedChargingTimeToTargetBatteryChargeLevel?.value ?? null,
    currentAmps: d.chargingCurrentLimit?.value ?? null,
    voltageVolts: null, // non disponibile in v2
  };
}

// --- Statistiche di guida ---
export async function getStatistics(
  accessToken: string,
  vin: string
): Promise<VehicleStats> {
  const [statsData, odometerData] = await Promise.all([
    volvoFetch<StatisticsResponse>(
      `/connected-vehicle/v2/vehicles/${vin}/statistics`,
      accessToken
    ),
    volvoFetch<OdometerResponse>(
      `/connected-vehicle/v2/vehicles/${vin}/odometer`,
      accessToken
    ).catch(() => null),
  ]);

  const d = statsData.data;

  return {
    avgSpeedKmh: d.averageSpeed?.value ?? 0,
    avgConsumptionKwh: d.averageEnergyConsumption?.value ?? 0,
    tripMeter1Km: d.tripMeterManual?.value ?? 0,
    tripMeter2Km: d.tripMeterAutomatic?.value ?? 0,
    odometerKm: odometerData?.data?.odometer?.value ?? 0,
    lastUpdated: d.averageSpeed?.timestamp ?? new Date().toISOString(),
  };
}

// --- Posizione GPS ---
export async function getLocation(
  accessToken: string,
  vin: string
): Promise<VehicleLocation> {
  const data = await volvoFetch<LocationResponse>(
    `/location/v1/vehicles/${vin}/location`,
    accessToken
  );

  const d = data.data;
  const [longitude, latitude] = d.geometry.coordinates;

  return {
    latitude,
    longitude,
    heading: d.properties.heading,
    lastUpdated: d.properties.timestamp,
  };
}

// --- Stato motore (per capire se l'auto è in moto) ---
export async function getEngineStatus(
  accessToken: string,
  vin: string
): Promise<boolean> {
  const data = await volvoFetch<EngineStatusResponse>(
    `/connected-vehicle/v2/vehicles/${vin}/engine-status`,
    accessToken
  );

  return data.data.engineStatus.value === 'ENGINE_STATUS_RUNNING';
}

// ============================================================
//  FUNZIONE AGGREGATA — recupera tutto in parallelo
// ============================================================

export async function getFullVehicleStatus(
  accessToken: string
): Promise<{ status: VehicleStatus; stats: VehicleStats; location: VehicleLocation }> {
  // Prima otteniamo il VIN
  const vin = await getVin(accessToken);

  // Poi chiamiamo tutti gli endpoint in parallelo
  const [battery, stats, location, isDriving] = await Promise.all([
    getRechargeStatus(accessToken, vin),
    getStatistics(accessToken, vin),
    getLocation(accessToken, vin),
    getEngineStatus(accessToken, vin),
  ]);

  const status: VehicleStatus = {
    vin,
    model: 'Volvo',      // verrà popolato con i dati reali nel passo successivo
    imageUrl: '',
    battery,
    isDriving,
    lastUpdated: new Date().toISOString(),
  };

  return { status, stats, location };
}

export async function getOdometer(
  accessToken: string,
  vin: string
): Promise<number> {
  const data = await volvoFetch<OdometerResponse>(
    `/connected-vehicle/v2/vehicles/${vin}/odometer`,
    accessToken
  );
  return data.data.odometer.value;
}