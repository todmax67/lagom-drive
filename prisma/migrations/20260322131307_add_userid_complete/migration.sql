-- AlterTable
ALTER TABLE "BatterySnapshot" ALTER COLUMN "userId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ChargingSession" ALTER COLUMN "userId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Settings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "userId" DROP DEFAULT;
