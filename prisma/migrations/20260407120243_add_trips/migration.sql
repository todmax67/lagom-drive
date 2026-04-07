-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startOdometer" INTEGER,
    "endOdometer" INTEGER,
    "distanceKm" DOUBLE PRECISION,
    "startBattery" INTEGER NOT NULL,
    "endBattery" INTEGER,
    "energyUsedKwh" DOUBLE PRECISION,
    "energyRegenKwh" DOUBLE PRECISION,
    "avgConsumption" DOUBLE PRECISION,
    "isComplete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trip_userId_startedAt_idx" ON "Trip"("userId", "startedAt");
