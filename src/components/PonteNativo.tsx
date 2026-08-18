'use client';

import { useEffect } from 'react';
import { nativo } from '@/lib/canale-nativo';

/**
 * L'orecchio del guscio: ascolta i deep link lagomdrive:// — sia da app già
 * aperta (appUrlOpen) sia da avvio a freddo (getLaunchUrl). Sul web puro non
 * monta niente.
 *
 * - lagomdrive://ponte?codice=… : il ritorno del ponte di sessione, a login
 *   compiuto nel browser di sistema — la webview va al riscatto del codice
 *   (con il verificatore PKCE che non ha mai lasciato il guscio);
 * - lagomdrive://obd : l'apertura da Tasker all'aggancio del BT dell'auto —
 *   dritti al Lab col presidio acceso, zero tocchi.
 */
export default function PonteNativo() {
  useEffect(() => {
    if (!nativo()) return;

    const gestisci = (url: string) => {
      const m = url.match(/codice=([\w-]+)/);
      if (m) {
        // Il verificatore non ha mai lasciato il guscio: solo la coppia
        // codice+verificatore riscatta la sessione (PKCE)
        const verificatore = localStorage.getItem('ponte-verificatore') ?? '';
        window.location.href =
          `/api/ponte/riscatta?codice=${m[1]}&verificatore=${encodeURIComponent(verificatore)}`;
        return;
      }
      if (/^lagomdrive:\/\/obd/i.test(url)) {
        window.location.href = '/obd?presidio=1';
      }
    };

    let rimuovi: (() => void) | null = null;
    import('@capacitor/app').then(({ App }) => {
      // Avvio a freddo da deep link: l'evento può essere già passato quando
      // questo componente monta — l'URL di lancio si va a prendere
      App.getLaunchUrl()
        .then(r => { if (r?.url) gestisci(r.url); })
        .catch(() => {});
      App.addListener('appUrlOpen', ({ url }) => gestisci(url)).then(h => {
        rimuovi = () => h.remove();
      });
    });
    return () => {
      rimuovi?.();
    };
  }, []);

  return null;
}
