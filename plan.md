# Spotify Playlist Cleaner — Build Plan

## Overview

A web app that connects to a user's Spotify account, monitors listening behaviour in the background, and automatically removes songs from a playlist when those songs are consistently skipped or barely played (less than 10% listened across the last 3 listens).

---

## The Core Problem & Spotify API Constraints

Before choosing a stack, it's important to understand the key Spotify API limitation:

> **Spotify does not provide historical playback data (listen %, skip events) via any free API tier.**

What Spotify *does* expose via the **Web API**:
- Currently playing track + live playback position (`/me/player/currently-playing`)
- Recently played tracks — last 50 only, with start timestamps but no duration/skip data (`/me/player/recently-played`)
- Playlist contents + the ability to remove tracks

**The workaround:** Your backend must **poll both endpoints on every cycle** (every 15–30 seconds) and combine them. `currently-playing` gives you live progress for the song playing right now. `recently-played` lets you catch any songs that started and ended entirely between two poll cycles — which is the common case when a user skips rapidly. You store per-song listen events and compute skip/completion logic on your side.

---

## Architecture Decision

### Recommended Stack (all free tiers)

| Layer | Technology | Why |
|---|---|---|
| **Frontend** | React (Vite) | Fast, lightweight, great auth flow handling |
| **Backend** | Node.js + Express | JavaScript end-to-end, easy Spotify SDK use |
| **Database** | PostgreSQL via Supabase (free tier) | Stores listen events, user tokens, rules |
| **Auth** | Spotify OAuth 2.0 (PKCE flow) | Required by Spotify; tokens stored in backend |
| **Hosting – Frontend** | Vercel (free) | Deploys from GitHub, handles env vars |
| **Hosting – Backend** | Railway or Render (free tier) | Always-on Node server for polling |
| **Polling / Background Jobs** | Node `setInterval` or BullMQ + Redis | Polls Spotify every 15–30 sec per active user |
| **Redis (optional)** | Upstash Redis (free tier) | Queue for background polling jobs |

> **Why not serverless (e.g., Vercel functions) for the backend?**
> Serverless functions are stateless and cold-start frequently — they cannot maintain continuous polling loops. You need a **persistent process** running for the polling logic. Railway/Render free tiers provide this.

---

## Data Model

### `users`
```
id                  UUID (PK)
spotify_id          TEXT UNIQUE
access_token        TEXT         -- encrypted
refresh_token       TEXT         -- encrypted
token_expires_at    TIMESTAMPTZ
last_poll_at        TIMESTAMPTZ  -- used to deduplicate recently-played on next cycle
created_at          TIMESTAMPTZ
```

### `listen_events`
```
id              UUID (PK)
user_id         UUID (FK → users)
track_id        TEXT         -- Spotify track URI
playlist_id     TEXT         -- Spotify playlist ID
listened_pct    FLOAT        -- 0.0–1.0 (e.g. 0.08 = 8%)
was_skipped     BOOLEAN      -- true if listened_pct < 0.10
source          TEXT         -- "live" (precise) or "recent" (timestamp-estimated)
listened_at     TIMESTAMPTZ
```

### `removal_log`
```
id              UUID (PK)
user_id         UUID (FK → users)
track_id        TEXT
playlist_id     TEXT
track_name      TEXT         -- snapshot for display
removed_at      TIMESTAMPTZ
reason          TEXT         -- e.g. "skipped 3/3 recent listens"
```

---

## How the Listen Tracking Works

### Why a single poll endpoint isn't enough

If you only call `/me/player/currently-playing` every 15 seconds, you will miss songs entirely. A user skipping rapidly through a playlist can play and discard 3–4 songs between two poll cycles — none of which would be recorded. The fix is a **hybrid approach**: call both endpoints every cycle and reconcile the results.

### Hybrid polling logic (every 15–30 seconds)

```
1. User is authenticated and polling is active.
2. On each poll cycle, call BOTH endpoints in parallel:
   a. GET /me/player/currently-playing  → live track + progress_ms + duration_ms
   b. GET /me/player/recently-played    → last 50 tracks with played_at timestamps

3. Reconcile recently-played against your DB:
   - Filter to tracks with played_at > last_poll_timestamp
   - These are songs that started AND ended between this poll and the last one
   - For each "missed" track, estimate listened_pct from the timestamp gap:
       gap_ms = next_track.played_at - this_track.played_at
       listened_pct = gap_ms / track.duration_ms
   - Insert a listen_event with source = "recent" and the estimated pct

4. Handle the currently-playing track:
   - Track max progress_ms seen across polls for this play session
   - When track_id changes (song ended or user skipped):
       listened_pct = max_progress_seen / duration_ms
       Insert a listen_event with source = "live" and the precise pct

5. After every insert, query the last 3 listen_events for that track+playlist+user.
6. If all 3 have was_skipped = true → call DELETE /playlists/{id}/tracks
7. Log the removal to removal_log.
8. Update last_poll_timestamp.
```

### Timestamp-gap estimation illustrated

```
recently-played returns (newest first):
  Song C  played_at: 12:00:45  duration: 3:20
  Song B  played_at: 12:00:22  duration: 3:10
  Song A  played_at: 12:00:00  duration: 3:45

last_poll_timestamp: 11:59:58 → all three are new

Song A gap = 12:00:22 - 12:00:00 = 22 sec → 22 / 225 sec = ~10%  (borderline)
Song B gap = 12:00:45 - 12:00:22 = 23 sec → 23 / 190 sec = ~12%  (not a skip)
Song C is now playing live → track via progress_ms instead
```

### Known blind spot: ultra-fast skips

`recently-played` only registers a track after ~30 seconds of listening on Spotify's side. A song skipped in the first 2–3 seconds will not appear there at all and cannot be caught. This is a hard Spotify platform limitation. In practice it's acceptable — a 2-second accidental tap is not the same signal as a deliberate skip, and missing it avoids false positives.

### Edge cases to handle

- **User pauses mid-song** — don't close the live event until `track_id` actually changes; a paused track still returns from `/currently-playing`
- **User replays the same song** — treat each `played_at` occurrence as a new independent event
- **Duplicate events** — deduplicate `recently-played` entries by `(track_id, played_at)` before inserting to avoid double-counting on overlapping polls
- **Playlist context** — only remove from the playlist it was played from; `context.uri` on `/currently-playing` gives you this; `recently-played` also returns context
- **Non-playlist context** (liked songs, album, artist radio) — ignore the event entirely, take no action
- **source field** — store whether the event came from `"live"` (precise) or `"recent"` (estimated) so you can weight or audit them differently later

---

## Spotify OAuth Flow

```
1. User clicks "Connect Spotify" on frontend.
2. Frontend redirects to Spotify authorization URL:
   - scope: user-read-playback-state user-modify-playback-state playlist-modify-public playlist-modify-private
3. Spotify redirects back to your callback URL with ?code=...
4. Backend exchanges code for access_token + refresh_token.
5. Tokens stored encrypted in DB against the user record.
6. Backend starts polling loop for this user.
7. Access tokens expire every 60 min — backend auto-refreshes using refresh_token.
```

---

## API Endpoints (Backend)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/spotify` | Redirect user to Spotify login |
| `GET` | `/auth/callback` | Handle OAuth code exchange |
| `GET` | `/auth/me` | Return current user info |
| `POST` | `/auth/logout` | Revoke session |
| `GET` | `/api/removals` | Fetch removal history for current user |
| `GET` | `/api/settings` | Get user's cleaner settings |
| `PUT` | `/api/settings` | Update settings (threshold %, lookback count) |
| `POST` | `/api/poll/start` | Manually trigger polling start |
| `POST` | `/api/poll/stop` | Pause cleaning |

---

## Frontend Pages

### 1. Landing Page (`/`)
- Hero explaining what the app does
- "Connect with Spotify" button
- How it works — 3 simple steps

### 2. Dashboard (`/dashboard`)
- Connected account info + active status indicator
- Toggle to pause/resume cleaning
- Settings panel:
  - Skip threshold (default: <10%)
  - Lookback window (default: last 3 listens)
  - Opt-in playlists (optionally restrict to specific playlists)
- Currently playing widget (live poll)

### 3. Removal History (`/history`)
- Table of removed songs: name, playlist, date, reason
- Option to undo a removal (re-add track to playlist)

---

## Build Order (Step-by-Step)

### Phase 1 — Foundation
- [ ] Register app on Spotify Developer Dashboard, get `client_id` / `client_secret`
- [ ] Set up Supabase project, create DB tables
- [ ] Scaffold backend (Node + Express), implement `/auth/spotify` and `/auth/callback`
- [ ] Store and encrypt tokens in Supabase

### Phase 2 — Core Polling Engine
- [ ] Implement polling loop: call both `/currently-playing` and `/recently-played` every 15–30 sec
- [ ] Reconcile recently-played against `last_poll_at` to find missed tracks
- [ ] Estimate `listened_pct` for missed tracks using timestamp gaps; store with `source = "recent"`
- [ ] Track max `progress_ms` for live currently-playing track across polls; store with `source = "live"` on track change
- [ ] Deduplicate recently-played events by `(track_id, played_at)` before inserting
- [ ] Implement skip-detection query (last 3 events for track + user + playlist)
- [ ] Call Spotify DELETE endpoint to remove track when threshold hit
- [ ] Write to `removal_log`
- [ ] Update `last_poll_at` on users table after each cycle

### Phase 3 — Frontend
- [ ] Build React app with Vite
- [ ] Landing page + OAuth redirect
- [ ] Dashboard with live "now playing" state
- [ ] Settings form (threshold, lookback)
- [ ] Removal history table with undo button

### Phase 4 — Polish & Deploy
- [ ] Deploy frontend to Vercel
- [ ] Deploy backend to Railway or Render
- [ ] Set environment variables: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `DATABASE_URL`, `JWT_SECRET`
- [ ] Configure Spotify redirect URI in dashboard to match production URL
- [ ] Test full flow end-to-end
- [ ] Add token refresh handling edge cases
- [ ] Add error handling for Spotify rate limits (429 responses)

---

## Key Spotify API Calls Reference

```
# Get currently playing (live progress)
GET https://api.spotify.com/v1/me/player/currently-playing
Headers: Authorization: Bearer {access_token}
Returns: { item.id, item.duration_ms, progress_ms, context.uri (playlist) }

# Get recently played (catch missed/skipped tracks)
GET https://api.spotify.com/v1/me/player/recently-played?limit=50
Headers: Authorization: Bearer {access_token}
Returns: { items: [{ track.id, track.duration_ms, played_at, context.uri }] }
Note: only tracks listened to for ~30+ seconds appear here

# Remove track from playlist
DELETE https://api.spotify.com/v1/playlists/{playlist_id}/tracks
Body: { "tracks": [{ "uri": "spotify:track:{track_id}" }] }

# Refresh token
POST https://accounts.spotify.com/api/token
Body: grant_type=refresh_token&refresh_token={token}
Headers: Authorization: Basic {base64(client_id:client_secret)}
```

---

## Environment Variables

```env
# Backend
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=https://your-backend.railway.app/auth/callback
DATABASE_URL=postgresql://...
JWT_SECRET=
ENCRYPTION_KEY=         # for encrypting tokens at rest

# Frontend
VITE_API_BASE_URL=https://your-backend.railway.app
VITE_SPOTIFY_CLIENT_ID=
```

---

## Free Tier Limits to Watch

| Service | Free Limit | Risk |
|---|---|---|
| Supabase | 500 MB DB, 50,000 monthly active users | Fine for personal/small use |
| Railway | $5 free credit/month (~500 hrs) | Backend may sleep on inactivity — use Render instead if needed |
| Render | 750 hrs/month free | Free web services spin down after 15 min inactivity — use a cron ping to keep alive |
| Spotify API | No hard rate limit, but 429s if polling too aggressively | Keep polling at 15–30 sec intervals, respect `Retry-After` headers |
| Upstash Redis | 10,000 commands/day free | Optional — only needed if scaling to many users |

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Songs skipped faster than poll interval are missed by `/currently-playing` alone | Hybrid approach: reconcile `/recently-played` each cycle to catch all tracks played since last poll |
| Ultra-fast skips (<30 sec) don't appear in `/recently-played` | Accepted limitation — sub-30s skips are likely accidental taps, not genuine dislike signals |
| Duplicate listen events from overlapping poll windows | Deduplicate by `(track_id, played_at)` before inserting; use `last_poll_at` as the cutoff |
| User closes browser mid-song | Polling is server-side, not browser-side — unaffected |
| Token expiry causes polling to fail | Auto-refresh logic runs before each poll cycle |
| Free backend host sleeps (Render) | Add a cron job (cron-job.org, free) to ping `/health` every 10 min |
| User plays same song in multiple playlists | Track `playlist_id` in every listen_event; only remove from the playlist where it was played |
| Accidental removal of a song the user likes | Undo button in history; optionally add a "safe list" of protected tracks |

---

## Approximate Timeline

| Phase | Estimated Time |
|---|---|
| Phase 1 — Auth + DB | 4–6 hours |
| Phase 2 — Polling Engine | 6–8 hours |
| Phase 3 — Frontend | 5–7 hours |
| Phase 4 — Deploy + Polish | 2–4 hours |
| **Total** | **~20–25 hours** |

---

## Future Enhancements

- **Analytics dashboard** — show your skip rate per playlist over time
- **Smart suggestions** — "You've skipped this artist 10 times, remove all their songs?"
- **Allowlist** — mark songs as protected so they're never auto-removed
- **Notification** — email/push when a song is removed
- **Mobile app** — wrap the web app in Capacitor or build a React Native version
- **Multi-platform** — extend to Apple Music or YouTube Music using similar polling patterns