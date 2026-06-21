'use client';

import { SWRConfig } from 'swr';
import { ReactNode } from 'react';

const fetcher = (url: string) =>
  fetch(url, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  });

export function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ fetcher, shouldRetryOnError: false }}>
      {children}
    </SWRConfig>
  );
}
