-- I kWh dal contatore a muro (pagati), accanto a energyAdded (entrati nel
-- pacco, dedotti). Bussola §4.3: due popoli di kWh, l'efficienza come tasso
-- di cambio. Campo opzionale: il contatore si legge a mano, quando capita.
ALTER TABLE "ChargingSession" ADD COLUMN "wallKwh" DOUBLE PRECISION;
