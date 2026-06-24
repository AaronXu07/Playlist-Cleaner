import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React, { Suspense } from 'react';

const mockUseSearchParams = vi.fn().mockReturnValue(new URLSearchParams());

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockUseSearchParams(),
}));

import SpotifySetupPage from '../app/spotify-setup/page';

async function renderSetupPage() {
  let result!: ReturnType<typeof render>;

  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <SpotifySetupPage />
      </Suspense>
    );
  });

  await act(async () => {});
  return result;
}

beforeEach(() => {
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  const storage = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
      clear: vi.fn(() => {
        storage.clear();
      }),
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Spotify setup page', () => {
  test('explains the Spotify app setup flow in beginner-friendly language', async () => {
    await renderSetupPage();

    expect(
      screen.getByRole('heading', { name: 'Connect with your own Spotify app' })
    ).toBeVisible();
    expect(screen.getByText('Create a Spotify Developer account')).toBeVisible();
    expect(screen.getByText('Open Spotify for Developers')).toBeVisible();
    expect(screen.getByText('Create a new app')).toBeVisible();
    expect(screen.getByText('Dashboard', { exact: false })).toBeVisible();
    expect(screen.getByText('Choose Web API.')).toBeVisible();
    expect(screen.getByText('Paste this redirect URI into Spotify')).toBeVisible();
    expect(
      screen.getByText('https://playlist-cleaner-sooty.vercel.app/auth/callback')
    ).toBeVisible();
    expect(screen.getByText('Add yourself as a user')).toBeVisible();
    expect(screen.getByText(/Spotify will return 403/i)).toBeVisible();
    expect(screen.getByText('Copy the Client ID')).toBeVisible();
    expect(screen.getByText(/View client secret/i)).toBeVisible();
    expect(screen.getByText(/Playlist Cleaner does not need it/i)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Spotify Client ID' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue to Spotify' })).toBeVisible();
  });

  test('shows auth errors returned from the backend', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('error=auth_expired'));

    await renderSetupPage();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The Spotify connection attempt expired'
    );
  });

  test('prefills a previously saved Spotify Client ID on the same device', async () => {
    window.localStorage.setItem(
      'spotify-cleaner.spotify-client-id',
      'a'.repeat(32)
    );

    await renderSetupPage();

    expect(screen.getByRole('textbox', { name: 'Spotify Client ID' })).toHaveValue(
      'a'.repeat(32)
    );
    expect(screen.getByText(/Your Client ID is saved on this device/i)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Continue with saved Client ID' })
    ).toBeVisible();
  });
});
