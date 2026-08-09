-- CreateTable
CREATE TABLE "ObdDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3),

    CONSTRAINT "ObdDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObdSample" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "socDisplay" DOUBLE PRECISION,
    "socReal" DOUBLE PRECISION,
    "soh" DOUBLE PRECISION,
    "packVoltage" DOUBLE PRECISION,
    "packCurrent" DOUBLE PRECISION,
    "cellTempMin" DOUBLE PRECISION,
    "cellTempMax" DOUBLE PRECISION,
    "hvacPowerKw" DOUBLE PRECISION,
    "odometer" DOUBLE PRECISION,
    "speedKmh" DOUBLE PRECISION,

    CONSTRAINT "ObdSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ObdDevice_tokenHash_key" ON "ObdDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "ObdDevice_userId_idx" ON "ObdDevice"("userId");

-- CreateIndex
CREATE INDEX "ObdSample_userId_recordedAt_idx" ON "ObdSample"("userId", "recordedAt");

-- CreateIndex
CREATE INDEX "ObdSample_deviceId_recordedAt_idx" ON "ObdSample"("deviceId", "recordedAt");
