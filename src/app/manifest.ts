import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Lagom Drive',
    short_name: 'Lagom Drive',
    description: 'Dashboard per la tua Volvo elettrica',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    // Le icone hanno già la safe zone del 22% incorporata, quindi lo stesso
    // file va bene sia ritagliato che intero. Senza una voce 'any' alcuni
    // contesti non trovano un'icona utilizzabile.
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}