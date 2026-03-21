-- CreateTable
CREATE TABLE "BatterySnapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" INTEGER NOT NULL,
    "range" INTEGER NOT NULL,
    "isCharging" BOOLEAN NOT NULL,
    "isConnected" BOOLEAN NOT NULL,
    "chargingType" TEXT,

    CONSTRAINT "BatterySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargingSession" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startLevel" INTEGER NOT NULL,
    "endLevel" INTEGER,
    "energyAdded" DOUBLE PRECISION,
    "chargingType" TEXT NOT NULL,
    "costPerKwh" DOUBLE PRECISION,
    "totalCost" DOUBLE PRECISION,
    "location" TEXT,
    "notes" TEXT,
    "isComplete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ChargingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "homeTariff" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "publicTariff" DOUBLE PRECISION NOT NULL DEFAULT 0.50,
    "batteryCapacity" DOUBLE PRECISION NOT NULL DEFAULT 69.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);
