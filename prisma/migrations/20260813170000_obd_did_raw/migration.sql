-- Conserva le letture grezze dei DID Volvo. Le formule non ancora confermate
-- non vanno indovinate: si salva il payload e si interpreta più avanti, quando
-- il modo in cui il valore si muove nel tempo avrà rivelato la scala.
ALTER TABLE "ObdSample" ADD COLUMN "didRaw" JSONB;
