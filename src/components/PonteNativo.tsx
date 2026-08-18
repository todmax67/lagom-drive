'use client';

import { useEffect } from 'react';
import { nativo } from '@/lib/canale-nativo';

/**
 * L'orecchio del guscio: ascolta il deep link lagomdrive://ponte?codice=…
 * che arriva dal browser di sistema a login compiuto, e porta la webview al
 * riscatto del codice — da cui esce col cookie di sessione. Sul web puro non
 * monta niente.
 */
export default function PonteNativo() {
  useEffect(() => {
    if (!nativo()) return;
    let rimuovi: (() => void) | null = null;
    import('@capacitor/app').then(({ App }) => {
      App.addListener('appUrlOpen', ({ url }) => {
        const m = url.match(/codice=([\w-]+)/);
        if (m) {
          // Il verificatore non ha mai lasciato il guscio: solo la coppia
          // codice+verificatore riscatta la sessione (PKCE)
          const verificatore = localStorage.getItem('ponte-verificatore') ?? '';
          window.location.href =
            `/api/ponte/riscatta?codice=${m[1]}&verificatore=${encodeURIComponent(verificatore)}`;
        }
      }).then(h => {
        rimuovi = () => h.remove();
      });
    });
    return () => {
      rimuovi?.();
    };
  }, []);

  return null;
}
