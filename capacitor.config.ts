import type { CapacitorConfig } from '@capacitor/cli';

// Il guscio (bussola §5.6): RI-OSPITA l'app di produzione — la webview carica
// il deploy Vercel e il bridge nativo (BLE, foreground service) viene
// iniettato lì. Niente doppia build: l'app è una, il guscio è un ponte.
const config: CapacitorConfig = {
  appId: 'it.bluspose.lagomdrive',
  appName: 'Lagom Drive',
  // Solo fallback offline: il contenuto vero arriva da server.url
  webDir: 'guscio/www',
  server: {
    url: 'https://lagom-drive.vercel.app',
    cleartext: false,
  },
  android: {
    // Volvo ID rifiuta i browser incorporati riconoscendoli dal token "wv"
    // nello user-agent (visto sul campo: "errore 14" al login). Il guscio si
    // presenta come il Chrome che il WebView di fatto e'.
    overrideUserAgent:
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  },
};

export default config;
