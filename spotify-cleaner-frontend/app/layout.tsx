import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { SWRProvider } from '@/components/SWRProvider';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Spotify Playlist Cleaner',
  description: 'Automatically clean your Spotify playlists by removing skipped tracks',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-bg-base text-primary`}>
        <SWRProvider>
          {children}
        </SWRProvider>
      </body>
    </html>
  );
}
