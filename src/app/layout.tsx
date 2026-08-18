import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Providers from '@/components/providers';
import PonteNativo from '@/components/PonteNativo';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Lagom Drive',
  description: 'Dashboard per la tua Volvo elettrica',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Lagom Drive',
  },
};

export const viewport: Viewport = {
  themeColor: '#0f172a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      {/* favicon e apple-touch-icon vengono da app/icon.svg e app/apple-icon.png */}
      <body className={`${inter.className} bg-gray-900 text-white`}>
        <Providers>
          {/* Solo nel guscio: ascolta il deep link del ponte di sessione */}
          <PonteNativo />
          {children}
        </Providers>
      </body>
    </html>
  );
}