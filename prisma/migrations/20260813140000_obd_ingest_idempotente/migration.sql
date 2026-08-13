-- Rende idempotente l'ingest: un dongle che va in timeout rispedisce il batch,
-- e senza vincolo ogni ritentativo duplicherebbe tutti i campioni.
-- La tabella è vuota, quindi non servono deduplicazioni preliminari.

-- L'indice non-unico è ridondante: quello unico serve entrambe le finalità.
DROP INDEX IF EXISTS "ObdSample_deviceId_recordedAt_idx";

CREATE UNIQUE INDEX "ObdSample_deviceId_recordedAt_key"
  ON "ObdSample" ("deviceId", "recordedAt");
