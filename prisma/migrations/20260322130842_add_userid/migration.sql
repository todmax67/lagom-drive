-- Aggiungi userId con valore default temporaneo
ALTER TABLE "BatterySnapshot" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "ChargingSession" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "Settings" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'legacy';

-- Aggiungi constraint unique su Settings.userId
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_userId_key" UNIQUE ("userId");

-- Aggiungi indici
CREATE INDEX "BatterySnapshot_userId_createdAt_idx" ON "BatterySnapshot"("userId", "createdAt");
CREATE INDEX "ChargingSession_userId_startedAt_idx" ON "ChargingSession"("userId", "startedAt");
