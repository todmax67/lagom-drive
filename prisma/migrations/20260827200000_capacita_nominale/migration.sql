-- La capacita' nominale (utile da nuova), distinta da quella di lavoro: e' il
-- riferimento del degrado e il denominatore implicito del SoH. Le promozioni
-- cambiano la capacita' di lavoro e lasciano questa dov'e'.
ALTER TABLE "Settings" ADD COLUMN "batteryCapacityNominal" DOUBLE PRECISION NOT NULL DEFAULT 67.0;
