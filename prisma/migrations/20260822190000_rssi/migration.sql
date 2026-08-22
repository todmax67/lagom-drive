-- La potenza del segnale BLE del dongle, in dBm. Serve a distinguere le due
-- firme di una caduta: segnale che affonda (schermatura, distanza) contro
-- segnale pieno che cade lo stesso (contesa di banda a 2,4 GHz).
ALTER TABLE "ObdSample" ADD COLUMN "rssi" INTEGER;
