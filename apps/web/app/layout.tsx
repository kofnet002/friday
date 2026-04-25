import './globals.css';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Friday',
  description: 'Friday — Parakeet-style local assistant',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <div className="app-titlebar" aria-hidden />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
