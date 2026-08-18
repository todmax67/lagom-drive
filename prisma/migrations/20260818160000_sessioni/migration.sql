-- Le sessioni di raccolta (bussola par. 5.2): id dal client, contesto
-- dichiarato, versione dell'app. L'unita' di verita' sulla continuita' della
-- guida, che l'odometro intero del cloud non sa dare.
CREATE TABLE "ObdSession" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "deviceId"   TEXT NOT NULL,
  "context"    TEXT NOT NULL,
  "startedAt"  TIMESTAMP(3) NOT NULL,
  "endedAt"    TIMESTAMP(3),
  "appVersion" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ObdSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ObdSession_userId_startedAt_idx" ON "ObdSession"("userId", "startedAt");

ALTER TABLE "ObdSample" ADD COLUMN "sessionId" TEXT;
CREATE INDEX "ObdSample_sessionId_idx" ON "ObdSample"("sessionId");

ALTER TABLE "TripEnrichment" ADD COLUMN "sessionId" TEXT;
