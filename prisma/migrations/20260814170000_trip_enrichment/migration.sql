-- L'accoppiatore (docs/progetto-obd.md §4.2): i campioni OBD si agganciano ai
-- viaggi come strato separato, il rilevatore non si tocca. Una riga per
-- viaggio, interamente ricalcolabile dal grezzo: cancellarla non perde nulla.
CREATE TABLE "TripEnrichment" (
  "id"                  TEXT NOT NULL,
  "tripId"              TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  "sampleCount"         INTEGER NOT NULL,
  "coverage"            DOUBLE PRECISION NOT NULL,
  "gaps"                JSONB,
  "movingStart"         TIMESTAMP(3),
  "movingEnd"           TIMESTAMP(3),
  "distanceObdKm"       DOUBLE PRECISION,
  "maxSpeedKmh"         DOUBLE PRECISION,
  "socStartObd"         DOUBLE PRECISION,
  "socEndObd"           DOUBLE PRECISION,
  "energyGrossKwh"      DOUBLE PRECISION,
  "energyRegenGrossKwh" DOUBLE PRECISION,

  CONSTRAINT "TripEnrichment_pkey" PRIMARY KEY ("id")
);

-- Unico indice: ogni lettura passa da tripId. userId resta come dato di
-- appartenenza, non come chiave di ricerca.
CREATE UNIQUE INDEX "TripEnrichment_tripId_key" ON "TripEnrichment"("tripId");
