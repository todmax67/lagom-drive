-- Allinea ObdSample ai sensori realmente esposti dalla XC40 MY2023.
-- La tabella è vuota: nessun dato da migrare.

-- Le temperature delle singole celle non sono esposte: il BECM offre solo
-- il liquido di raffreddamento in ingresso e uscita.
ALTER TABLE "ObdSample" DROP COLUMN "cellTempMin",
                        DROP COLUMN "cellTempMax";

-- La sorgente HVCH-CCM riporta i Watt: si conserva l'unità della centralina
-- invece di convertire, così una svista di scala non passa inosservata.
ALTER TABLE "ObdSample" DROP COLUMN "hvacPowerKw";

ALTER TABLE "ObdSample" ADD COLUMN "packPowerKw"    DOUBLE PRECISION,
                        ADD COLUMN "cellVoltageSum" DOUBLE PRECISION,
                        ADD COLUMN "coolantInletC"  DOUBLE PRECISION,
                        ADD COLUMN "coolantOutletC" DOUBLE PRECISION,
                        ADD COLUMN "hvacPowerW"     DOUBLE PRECISION,
                        ADD COLUMN "interiorC"      DOUBLE PRECISION,
                        ADD COLUMN "ambientC"       DOUBLE PRECISION,
                        ADD COLUMN "batt12vSoc"     DOUBLE PRECISION,
                        ADD COLUMN "batt12vVoltage" DOUBLE PRECISION,
                        ADD COLUMN "parasiticMa"    DOUBLE PRECISION;
