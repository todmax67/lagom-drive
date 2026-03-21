// ============================================================
//  RISPOSTE API VOLVO — Tipi TypeScript
// ============================================================

// --- Struttura generica delle risposte Volvo ---
export interface VolvoApiResponse<T> {
  data: T;
  status: number;
}

// --- Veicoli ---
export interface Vehicle {
  vin: string;
  descriptions: {
    model: string;
    modelYear: number;
    color: string;
    upholstery: string;
    steering: string;
  };
  images: {
    exteriorDefaultUrl: string;
    internalDefaultUrl: string;
  };
}

export type VehicleListResponse = VolvoApiResponse<Vehicle[]>;

// --- Stato Batteria / Ricarica ---
export interface RechargeStatus {
  batteryChargeLevel: {
    value: number;         // 0–100 (percentuale)
    unit: string;          // "%"
    timestamp: string;
  };
  distanceToEmpty: {
    value: number;         // km
    unit: string;          // "km"
    timestamp: string;
  };
  chargingSystemStatus: {
    value: 'CHARGING_SYSTEM_IDLE' | 'CHARGING_SYSTEM_CHARGING' | 'CHARGING_SYSTEM_FAULT' | 'CHARGING_SYSTEM_UNSPECIFIED';
    timestamp: string;
  };
  chargingConnectionStatus: {
    value: 'CONNECTION_STATUS_CONNECTED_AC' | 'CONNECTION_STATUS_CONNECTED_DC' | 'CONNECTION_STATUS_DISCONNECTED' | 'CONNECTION_STATUS_FAULT' | 'CONNECTION_STATUS_UNSPECIFIED';
    timestamp: string;
  };
  estimatedChargingTime: {
    value: number;         // minuti
    unit: string;          // "minutes"
    timestamp: string;
  };
  chargingCurrentAmps: {
    value: number;
    unit: string;          // "A"
    timestamp: string;
  };
  chargingVoltageVolts: {
    value: number;
    unit: string;          // "V"
    timestamp: string;
  };
}

export type RechargeStatusResponse = VolvoApiResponse<RechargeStatus>;

// --- Statistiche / Consumi ---
// --- Stato Batteria / Ricarica (Energy API v2) ---
export interface RechargeStatusV2 {
  batteryChargeLevel: { status: string; value: number; unit: string; updatedAt: string; };
  electricRange: { status: string; value: number; unit: string; updatedAt: string; };
  chargerConnectionStatus: { status: string; value: string; updatedAt: string; };
  chargingStatus: { status: string; value: string; updatedAt: string; };
  chargingType: { status: string; value: string; updatedAt: string; };
  estimatedChargingTimeToTargetBatteryChargeLevel: { status: string; value: number; unit: string; updatedAt: string; };
  chargingCurrentLimit: { status: string; value: number; unit: string; updatedAt: string; };
}

// --- Statistiche di guida ---
export interface Statistics {
  averageEnergyConsumption: { value: number; unit: string; timestamp: string; };
  averageSpeed: { value: number; unit: string; timestamp: string; };
  averageSpeedAutomatic: { value: number; unit: string; timestamp: string; };
  tripMeterManual: { value: number; unit: string; timestamp: string; };
  tripMeterAutomatic: { value: number; unit: string; timestamp: string; };
  distanceToEmptyBattery: { value: number; unit: string; timestamp: string; };
}

export type StatisticsResponse = VolvoApiResponse<Statistics>;

// --- Posizione ---
export interface Location {
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  properties: {
    heading: number;       // gradi (0–360)
    timestamp: string;
  };
  type: 'Feature';
}

export type LocationResponse = VolvoApiResponse<Location>;

// --- Stato Motore / Guida ---
export interface EngineStatus {
  engineStatus: {
    value: 'ENGINE_STATUS_RUNNING' | 'ENGINE_STATUS_STOPPED' | 'ENGINE_STATUS_UNSPECIFIED';
    timestamp: string;
  };
}

export type EngineStatusResponse = VolvoApiResponse<EngineStatus>;

// ============================================================
//  TIPI INTERNI ALL'APP (non direttamente dall'API)
// ============================================================

// Oggetto unificato che il nostro /api/vehicle/* ritorna al frontend
export interface VehicleStatus {
  vin: string;
  model: string;
  imageUrl: string;
  battery: {
    level: number;
    range: number;
    isCharging: boolean;
    isConnected: boolean;
    chargingType: 'AC' | 'DC' | null;
    estimatedMinutes: number | null;
    currentAmps: number | null;
    voltageVolts: number | null;
  };
  isDriving: boolean;
  lastUpdated: string;
}

export interface VehicleStats {
  avgSpeedKmh: number;
  avgConsumptionKwh: number;
  tripMeter1Km: number;
  tripMeter2Km: number;
  lastUpdated: string;
}

export interface VehicleLocation {
  latitude: number;
  longitude: number;
  heading: number;
  lastUpdated: string;
}