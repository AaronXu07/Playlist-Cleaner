'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
const SPOTIFY_REDIRECT_URI = 'https://playlist-cleaner-sooty.vercel.app/auth/callback';
const CLIENT_ID_STORAGE_KEY = 'spotify-cleaner.spotify-client-id';
const SPOTIFY_CLIENT_ID_PATTERN = /^[A-Za-z0-9]{16,128}$/;

function readSavedClientId() {
  try {
    return window.localStorage?.getItem(CLIENT_ID_STORAGE_KEY)?.trim() ?? null;
  } catch {
    return null;
  }
}

function saveClientId(clientId: string) {
  try {
    window.localStorage?.setItem(CLIENT_ID_STORAGE_KEY, clientId);
  } catch {
    // Remembering the public Client ID is a convenience only.
  }
}

function getErrorMessage(error: string | null) {
  switch (error) {
    case 'invalid_client_id':
      return 'That Client ID does not look right. Paste only the Client ID from Spotify, with no spaces.';
    case 'auth_expired':
      return 'The Spotify connection attempt expired. Please start again from this page.';
    case 'auth_failed':
      return 'Spotify could not complete the connection. Check the redirect URI and try again.';
    case 'client_id_required':
      return 'Paste your Spotify Client ID to start sign in with your own Spotify app.';
    case 'access_denied':
      return 'Spotify access was not approved. You can try again when you are ready.';
    default:
      return null;
  }
}

function SetupErrorNotice() {
  const searchParams = useSearchParams();
  const message = getErrorMessage(searchParams.get('error'));

  if (!message) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-card border border-danger bg-bg-surface px-4 py-3 text-sm text-primary"
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
      <p className="m-0 leading-relaxed">{message}</p>
    </div>
  );
}

export default function SpotifySetupPage() {
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hasSavedClientId, setHasSavedClientId] = useState(false);

  useEffect(() => {
    const savedClientId = readSavedClientId();
    if (savedClientId && SPOTIFY_CLIENT_ID_PATTERN.test(savedClientId)) {
      setClientId(savedClientId);
      setHasSavedClientId(true);
    }
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedClientId = clientId.trim();

    if (!SPOTIFY_CLIENT_ID_PATTERN.test(trimmedClientId)) {
      setError('Paste the Spotify Client ID exactly as it appears in your Spotify app settings.');
      return;
    }

    setError(null);
    saveClientId(trimmedClientId);
    setHasSavedClientId(true);
    window.location.assign(
      `${apiBase}/auth/spotify?client_id=${encodeURIComponent(trimmedClientId)}`
    );
  }

  return (
    <main className="min-h-screen bg-bg-base px-4 py-8 text-primary sm:px-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-col items-center gap-3 border-b border-white/10 pb-6 text-center">
          <a href="/" className="w-fit text-sm font-semibold text-brand">
            Spotify Playlist Cleaner
          </a>
          <div className="mx-auto max-w-3xl">
            <h1 className="m-0 text-3xl font-bold leading-tight sm:text-4xl">
              Connect with your own Spotify app
            </h1>
            <p className="mx-auto mt-3 max-w-2xl text-base leading-7 text-muted">
              Spotify limits development apps to a small allowlist. Creating your
              own app gives your account its own Spotify connection, and you only
              need to paste one public value here: the Client ID.
            </p>
          </div>
        </header>

        <Suspense fallback={null}>
          <SetupErrorNotice />
        </Suspense>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section
            aria-labelledby="setup-steps-title"
            className="rounded-card border border-white/10 bg-bg-surface p-5 shadow-elevated sm:p-6"
          >
            <div className="flex items-start gap-3">
              <KeyRound aria-hidden="true" className="mt-1 h-6 w-6 shrink-0 text-brand" />
              <div>
                <h2 id="setup-steps-title" className="m-0 text-xl font-bold">
                  First, create the Spotify app
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted">
                  A Spotify app is just a permission doorway. You do not need to
                  write code, publish anything, or share your password.
                </p>
              </div>
            </div>

            <ol className="mt-6 grid gap-5">
              <li className="grid gap-2 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-sm font-bold text-primary">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-sm text-bg-base">
                    1
                  </span>
                  Create a Spotify Developer account
                </div>
                <p className="m-0 text-sm leading-6 text-muted">
                  Go to Spotify for Developers and log in with your regular
                  Spotify account. Accept the Developer Terms of Service if
                  Spotify asks.
                </p>
                <a
                  href="https://developer.spotify.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-brand"
                >
                  Open Spotify for Developers
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                </a>
              </li>

              <li className="grid gap-2 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-sm font-bold text-primary">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-sm text-bg-base">
                    2
                  </span>
                  Create a new app
                </div>
                <p className="m-0 text-sm leading-6 text-muted">
                  Click Dashboard in the top navigation, then Create app. These
                  values are fine:
                </p>
                <dl className="grid gap-2 text-sm leading-6 text-muted">
                  <div>
                    <dt className="font-semibold text-primary">App name</dt>
                    <dd className="m-0">
                      Spotify Playlist Cleaner, or any name you recognize.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-primary">App description</dt>
                    <dd className="m-0">
                      Automatically removes skipped songs from playlists.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-primary">Redirect URI</dt>
                    <dd className="m-0">
                      Use the exact callback URL shown in the next step.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-primary">API or SDK</dt>
                    <dd className="m-0">Choose Web API.</dd>
                  </div>
                </dl>
                <p className="m-0 text-sm leading-6 text-muted">
                  Agree to Spotify&apos;s terms, then save the app.
                </p>
              </li>

              <li className="grid gap-2 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-sm font-bold text-primary">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-sm text-bg-base">
                    3
                  </span>
                  Paste this redirect URI into Spotify
                </div>
                <p className="m-0 text-sm leading-6 text-muted">
                  This tells Spotify where to send you after approving access.
                  It must match exactly.
                </p>
                <div className="flex flex-col gap-2 rounded-card border border-white/10 bg-bg-base p-3 sm:flex-row sm:items-center sm:justify-between">
                  <code className="break-all text-sm text-primary">{SPOTIFY_REDIRECT_URI}</code>
                  <button
                    type="button"
                    aria-label="Copy redirect URI"
                    className="inline-flex h-9 w-fit items-center gap-2 rounded-card border border-white/10 px-3 text-sm font-semibold text-primary hover:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
                    onClick={() => navigator.clipboard?.writeText(SPOTIFY_REDIRECT_URI)}
                  >
                    <Copy aria-hidden="true" className="h-4 w-4" />
                    Copy
                  </button>
                </div>
              </li>

              <li className="grid gap-2 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-sm font-bold text-primary">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-sm text-bg-base">
                    4
                  </span>
                  Add yourself as a user
                </div>
                <p className="m-0 text-sm leading-6 text-muted">
                  In the Spotify app settings, open Users Management and add the
                  Spotify account you will use with Playlist Cleaner. This step is
                  required while the app is in development mode; Spotify will
                  return 403 if your account is not added.
                </p>
              </li>

              <li className="grid gap-2 border-t border-white/10 pt-5">
                <div className="flex items-center gap-2 text-sm font-bold text-primary">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-sm text-bg-base">
                    5
                  </span>
                  Copy the Client ID
                </div>
                <p className="m-0 text-sm leading-6 text-muted">
                  Open your new app, click Settings, then copy Client ID and
                  paste it into the box on this page.
                </p>
                <div className="flex items-start gap-3 text-sm leading-6 text-muted">
                  <LockKeyhole aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
                  <p className="m-0">
                    You may also see View client secret in Spotify. Keep that
                    private. Playlist Cleaner does not need it for this setup.
                  </p>
                </div>
              </li>
            </ol>
          </section>

          <section
            aria-labelledby="client-id-title"
            className="rounded-card border border-white/10 bg-bg-surface p-5 shadow-elevated sm:p-6"
          >
            <h2 id="client-id-title" className="m-0 text-xl font-bold">
              Then connect Spotify
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Playlist Cleaner uses the Client ID to send you to Spotify. The
              Client Secret stays private because this connection uses PKCE.
            </p>
            {hasSavedClientId && (
              <p className="mt-3 rounded-card border border-white/10 bg-bg-base px-3 py-2 text-sm leading-6 text-muted">
                Your Client ID is saved on this device, so you can continue
                without finding it again.
              </p>
            )}

            <form className="mt-6 grid gap-4" onSubmit={handleSubmit}>
              <label className="grid gap-2 text-sm font-semibold" htmlFor="spotify-client-id">
                Spotify Client ID
                <input
                  id="spotify-client-id"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste Client ID from Spotify"
                  className="h-12 rounded-card border border-white/10 bg-bg-base px-3 font-mono text-sm text-primary outline-none transition focus:border-brand focus:ring-2 focus:ring-brand"
                />
              </label>

              {error && <p className="m-0 text-sm leading-6 text-danger">{error}</p>}

              <button
                type="submit"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-pill bg-brand px-5 text-sm font-bold text-bg-base transition hover:bg-brand focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 focus:ring-offset-bg-base"
              >
                {hasSavedClientId ? 'Continue with saved Client ID' : 'Continue to Spotify'}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </button>
            </form>

            <div className="mt-6 grid gap-4 border-t border-white/10 pt-5">
              <div className="flex items-start gap-3">
                <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
                <p className="m-0 text-sm leading-6 text-muted">
                  Your Spotify password is never shared with Playlist Cleaner.
                  Spotify asks you to approve access, then sends this app a token.
                </p>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
                <p className="m-0 text-sm leading-6 text-muted">
                  The Users Management step is mandatory for development-mode
                  Spotify apps. Complete it before continuing to Spotify.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
