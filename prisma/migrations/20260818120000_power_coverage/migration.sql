-- La copertura della serie di potenza, distinta da quella globale: un viaggio
-- pieno di campioni GPS senza V*I avrebbe copertura piena e integrale vuoto.
-- Il livello 1 della cascata si regge su questa.
ALTER TABLE "TripEnrichment" ADD COLUMN "powerCoverage" DOUBLE PRECISION;
