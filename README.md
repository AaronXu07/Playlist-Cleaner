# Spotify Playlist Cleaner

Spotify Playlist Cleaner connects to a Spotify account, watches playlist listening behavior in the background, and removes tracks from the playlist when they are repeatedly skipped or barely played.

The app is split into a Next.js frontend and an Express backend. The backend owns Spotify OAuth, encrypted token storage, polling, skip detection, playlist edits, and removal history.

## Features

- Spotify OAuth sign-in with an httpOnly session cookie.
- Background polling for currently playing and recently played tracks.
- Skip detection based on listen percentage per track and playlist.
- Automatic removal from editable Spotify playlists after repeated skips.
- Dashboard toggle to start or stop cleaning.
- Removal history with track metadata, playlist metadata, album art, and undo.
- Shared Spotify API rate-limit backoff using `Retry-After`.
- Supabase-backed persistence for users, listen events, and removal logs.

## Repository Layout

```text
.
├── spotify-cleaner-backend/   # Express API, Spotify integration, Supabase, poller
├── spotify-cleaner-frontend/  # Next.js app, landing page, dashboard
└── plan.md                    # Original build plan and architecture notes
```

## Tech Stack

- Frontend: Next.js 14, React, TypeScript, Tailwind CSS, SWR, Framer Motion
- Backend: Node.js, Express, Axios, JWT, cookie-parser
- Database: Supabase Postgres
- Auth provider: Spotify OAuth 2.0 authorization code flow
- Tests: Vitest, Testing Library, Playwright

## How It Works

1. The user signs in through `/auth/spotify`.
2. Spotify redirects to the backend callback at `/auth/callback`.
3. The backend exchanges the code for Spotify tokens, encrypts them, stores them in Supabase, and issues an httpOnly session cookie.
4. The polling engine runs every 15 seconds for users with cleaning enabled.
5. Each cycle reads the current playback state, and every fourth cycle also checks recently played tracks to catch songs missed between live polls.
6. The backend writes listen events with a calculated `listened_pct`.
7. If the same track in the same playlist is skipped in the latest 2 relevant events, the backend removes the track from that playlist and logs the removal.
8. The dashboard reads removal history from Supabase without calling Spotify for each row.

## Spotify Developer Restrictions and Performance Notes

Spotify's developer-mode restrictions are the biggest performance and rollout constraint for this project.

- Development-mode apps can only be used by up to 5 authenticated Spotify users.
- Each user must be manually added to the app allowlist in the Spotify Developer Dashboard before they can use the app.
- Users may complete sign-in without being allowlisted, but their Spotify API calls can fail with `403`.
- Development-mode apps have a lower Spotify Web API rate limit than extended quota apps.
- Spotify calculates rate limits over a rolling 30-second window and responds with `429` plus `Retry-After` when the app is over limit.

Those restrictions affect perceived performance because cleaning requires repeated polling. With several active users, the app can hit Spotify limits even if the local server and database are fast. When that happens, polling pauses behind Spotify's `Retry-After` window, removals may be delayed, and dashboard actions that call Spotify, such as undoing a removal, may feel slow.

The backend mitigates this by:

- polling `/me/player/currently-playing` every 15 seconds instead of more aggressively;
- fetching `/me/player/recently-played` only every fourth cycle;
- applying a module-wide shared backoff after Spotify `429` responses;
- storing display metadata in `removal_log` so dashboard loads do not fan out into Spotify track lookups;
- using playlist blocklisting for known read-only playlists.

For broader usage, the Spotify app needs extended quota mode. Spotify documents extended quota as removing the development-mode allowlist and providing a higher rate limit.

References:

- [Spotify quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
- [Spotify rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)

## Prerequisites

- Node.js 20 or newer
- npm
- A Spotify Developer app
- A Supabase project
- A 32-byte encryption key for Spotify token encryption

## Spotify App Setup

Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), then configure:

- Redirect URI for local development: `http://127.0.0.1:3000/auth/callback`
- Development-mode users: add each tester in the app's Users Management tab

The backend requests these scopes:

```text
user-read-playback-state
user-read-recently-played
user-read-private
playlist-modify-public
playlist-modify-private
```

## Supabase Setup

Create the base `users` table if it does not already exist:

```sql
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  spotify_id text unique not null,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now()
);
```

Then run the project migrations in order from `spotify-cleaner-backend/migrations/`:

```text
001_core_polling_engine.sql
002_polling_enabled.sql
003_user_profile.sql
004_removal_metadata.sql
```

The migrations add:

- `listen_events`
- `removal_log`
- `users.last_poll_at`
- `users.polling_enabled`
- `users.display_name`
- `users.avatar_url`
- removal display metadata columns

## Environment Variables

Generate local secrets before creating the backend `.env` file:

```bash
node -e "const crypto=require('crypto'); console.log('JWT_SECRET='+crypto.randomBytes(32).toString('hex')); console.log('ENCRYPTION_KEY='+crypto.randomBytes(24).toString('base64url'));"
```

`JWT_SECRET` can be any long random string. `ENCRYPTION_KEY` must be exactly 32 UTF-8 bytes because the backend uses it as the AES-256-GCM key for encrypted Spotify tokens.

Create `spotify-cleaner-backend/.env`:

```bash
PORT=3000
FRONTEND_URL=http://127.0.0.1:5173

SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/auth/callback

SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

JWT_SECRET=generated_by_the_node_script_above
ENCRYPTION_KEY=generated_by_the_node_script_above
```

Create `spotify-cleaner-frontend/.env.local`:

```bash
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3000
```

For deployment, the frontend can also use `RENDER_BACKEND_URL` so Next.js rewrites `/auth`, `/api`, and `/health` to the hosted backend.

## Local Development

Install dependencies:

```bash
cd spotify-cleaner-backend
npm install
```

```bash
cd spotify-cleaner-frontend
npm install
```

Start the backend:

```bash
cd spotify-cleaner-backend
npm run dev
```

Start the frontend in a second terminal:

```bash
cd spotify-cleaner-frontend
npm run dev
```

Open `http://127.0.0.1:5173`.

## Backend API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `GET` | `/auth/spotify` | Redirect to Spotify login |
| `GET` | `/auth/callback` | Complete Spotify OAuth |
| `GET` | `/auth/me` | Return the current session user |
| `POST` | `/auth/logout` | Clear the session and stop polling for that user |
| `GET` | `/api/status` | Return durable cleaning state and poller diagnostics |
| `POST` | `/api/polling/start` | Enable cleaning and register the user with the poller |
| `POST` | `/api/polling/stop` | Disable cleaning and deregister the user |
| `GET` | `/api/removals` | Return the 50 most recent removals |
| `DELETE` | `/api/removals/:id` | Re-add a removed track and delete its removal record |
| `GET` | `/api/events` | Return the 100 most recent listen events |

## Testing

Backend:

```bash
cd spotify-cleaner-backend
npm test
```

Frontend unit tests:

```bash
cd spotify-cleaner-frontend
npm test
```

Frontend end-to-end tests:

```bash
cd spotify-cleaner-frontend
npm run test:e2e
```

## Deployment Notes

- The backend should run on a persistent Node host because the poller uses long-running intervals.
- Serverless functions are not a good fit for the polling engine.
- In production, set the session cookie `secure` option to `true` in `spotify-cleaner-backend/src/routes/auth.js`.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, `SPOTIFY_CLIENT_SECRET`, `JWT_SECRET`, and `ENCRYPTION_KEY` only on the backend.
- Configure the production Spotify redirect URI to point at the backend callback, for example `https://your-backend.example.com/auth/callback`.
- Move to Spotify extended quota mode before attempting real public usage.

## Known Limitations

- Spotify does not expose full historical playback percentages, so the app estimates some listen events from timestamps.
- Very fast skips may never appear in recently played data and can be missed.
- Only playlist-context plays are actionable; album, artist, queue, and liked-songs contexts are ignored.
- Tracks can only be removed from playlists the authenticated user can edit.
- Development-mode Spotify limits make this best suited for personal use or a very small allowlisted beta.
