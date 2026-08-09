-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "volvoAvgConsumption" DOUBLE PRECISION,
                   ADD COLUMN "volvoTripMeterStart" DOUBLE PRECISION,
                   ADD COLUMN "volvoTripMeterEnd" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Settings" ALTER COLUMN "batteryCapacity" SET DEFAULT 67.0;

-- Backfill: aggiorna righe esistenti che avevano il vecchio default
UPDATE "Settings" SET "batteryCapacity" = 67.0 WHERE "batteryCapacity" = 69.0;
