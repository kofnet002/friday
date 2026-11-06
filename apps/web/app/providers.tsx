'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { InWindowTooltips } from '@/components/in-window-tooltips';
import { ThemeProvider } from '@/lib/theme';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        {children}
        <InWindowTooltips />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
