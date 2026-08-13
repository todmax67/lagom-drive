-- Traccia chi ha scritto il campione. Senza, capire perché un viaggio non è
-- stato rilevato costringe a dedurlo dagli intervalli fra gli snapshot.
-- Le righe esistenti vengono dal cron o dalla dashboard indistintamente:
-- il default le attribuisce al cron, che è l'origine largamente prevalente.
ALTER TABLE "BatterySnapshot" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'cron';
