# Design Document: Core Polling Engine

## Overview

The Core Polling Engine is a background service that runs inside the existing Node.js/Express process. It starts at server boot, loads all active users from Supabase, and launches a `setInterval`-based polling loop per user. On every tick it calls two Spotify endpoints in parallel, reconciles the results into `listen_events` rows, evaluates skip patterns, and optionally removes tracks from the user's playlist.

The engine is intentionally single-process and in-memory for v1. There is no job queue; concurrency control is achieved by a per-user "running" flag that skips the tick if the previous cycle hasn't finished (Req 1 AC9). Stagger offsets (0–5 s, Req 1 AC10) spread poll starts across time.

### Key Design Goals

- **No missed tracks** — Hybrid strategy combines live progress tracking with recently-played reconciliation so tracks played entirely between two polls are still captured.
- **Accurate skip classification** — `max_progress_ms` accumulated across polls gives a reliable `listened_pct` for the current track; the `source` field (`live` / `recent` / `delta`) signals confidence level.
- **Safe token handling** — All token reads decrypt via `crypto.js`; all writes encrypt before DB insertion; plaintext never touches Supabase.
- **Graceful degradation** — Every failure mode (429, timeout, revocation, DB error) is logged and skipped without crashing sibling users' loops.

---

## Architecture

```
src/index.js
  └── startPollingEngine()          ← called once at app startup
        │
        ▼
src/lib/poller.js                   ← orchestrates per-user poll cycles
  ├── startPollingEngine()          public entry point
  ├── registerUser(userId)          starts an interval for one user
  ├── deregisterUser(userId)        clears the interval for one user
  └── runPollCycle(userId)          one full cycle (token → fetch → reconcile → evaluate → commit)
        │
        ├── src/lib/spotify.js      ← all Spotify HTTP calls + token refresh
        │     ├── refreshTokenIfNeeded(user)
        │     ├── getCurrentlyPlaying(accessToken, userId)
        │     ├── getRecentlyPlayed(accessToken, userId)
        │     └── removeTrackFromPlaylist(accessToken, playlistId, trackUri)
        │
        └── internal pipeline (all inside poller.js, not separate files)
              ├── reconcileRecentlyPlayed(...)    → listen event array
              ├── processLiveTrack(...)           → optional listen event
              ├── writeListenEvent(...)           → dedup + insert
              ├── detectSkip(...)                 → removal trigger
              └── removeTrack(...)                → Spotify DELETE + removal_log insert

src/middleware/auth.js              ← JWT cookie guard for protected HTTP routes
src/routes/api.js                   ← REST endpoints (removals, settings, poll control)
```

The pipeline inside `runPollCycle` runs sequentially per user. The two Spotify fetches at the top are parallelised with `Promise.all`. Everything else is sequential to keep state management simple.

---

## Components and Interfaces

### 2.1 `src/lib/poller.js`

Central orchestrator. Owns all in-memory state.

#### In-Memory State

```js
// Map<userId, { intervalId, isRunning, consecutive204s, reducedMode, liveTrack }>
const userState = new Map()

// liveTrack shape:
// {
//   trackId: string,
//   durationMs: number,
//   maxProgressMs: number,
//   playlistId: string,
//   pausedSince: number | null   // Date.now() when is_playing became false
// }
```

#### Exported Functions

```js
/**
 * Load all users with a non-null refresh_token from Supabase and
 * start a polling interval for each. Called once from src/index.js.
 */
export async function startPollingEngine()

/**
 * Start a polling interval for a single user.
 * Applies a random Stagger_Offset (0–5 s) before the first tick.
 * Idempotent: calling again for an already-registered user is a no-op.
 * @param {string} userId - Supabase user UUID
 */
export function registerUser(userId)

/**
 * Clear the polling interval and remove in-memory state for a user.
 * @param {string} userId
 */
export function deregisterUser(userId)
```

#### Core Private Function

```js
/**
 * One full poll cycle for a user.
 * Guards against re-entrant execution via isRunning flag.
 * Records cycleStart before any API call (Req 8 AC2).
 * Updates last_poll_at unconditionally at the end (Req 8 AC1/3).
 */
async function runPollCycle(userId)
```

Internal execution order inside `runPollCycle`:

```
1.  Guard: if isRunning → return immediately (Req 1 AC9)
2.  Set isRunning = true
3.  Record cycleStart = new Date()
4.  Load user row from Supabase (access_token, refresh_token, token_expires_at, last_poll_at)
5.  refreshTokenIfNeeded(user)  — may update DB + local user object
6.  [parallel] getCurrentlyPlaying(accessToken)  +  getRecentlyPlayed(accessToken)
7.  processLiveTrack(userId, currentlyPlayingResult)
8.  reconcileRecentlyPlayed(userId, recentlyPlayedResult, user.last_poll_at)
9.  For each emitted listen event → writeListenEvent(event)
10. For each successfully inserted event → detectSkip(event)  → maybe removeTrack(event)
11. UPDATE users SET last_poll_at = cycleStart WHERE id = userId
12. Set isRunning = false
```

---

### 2.2 `src/lib/spotify.js`

Handles all HTTP communication with the Spotify Web API. Uses `axios` with a 10-second timeout. All functions receive the decrypted `accessToken` as a parameter — token management lives in `poller.js`.

```js
/**
 * Check token_expires_at; if within 60 s of expiry, call the Spotify
 * token endpoint to get a fresh access_token. Encrypt and persist
 * both tokens to Supabase. Return updated { accessToken, refreshToken }.
 *
 * Throws on network error or 400/401 from Spotify token endpoint.
 * Calling code in runPollCycle catches and handles revocation logic.
 *
 * @param {{ id, refresh_token_encrypted, token_expires_at }} user
 * @returns {Promise<{ accessToken: string }>}
 */
export async function refreshTokenIfNeeded(user)

/**
 * GET /me/player/currently-playing
 * Returns the parsed body on 200, null on 204 (nothing playing),
 * or throws on error (non-200/204/429).
 * 429 handling (Retry-After, 3 retries) is internal to this function.
 *
 * @param {string} accessToken
 * @param {string} userId  — for logging only
 * @returns {Promise<object|null>}
 */
export async function getCurrentlyPlaying(accessToken, userId)

/**
 * GET /me/player/recently-played?limit=50
 * Returns the items array on success, throws on error.
 * 429 handling internal.
 *
 * @param {string} accessToken
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function getRecentlyPlayed(accessToken, userId)

/**
 * DELETE /playlists/{playlistId}/tracks
 * Removes a single track URI from a playlist.
 * Returns true on 200/201, throws on error.
 * Caller handles 403 (Spotify-owned playlist) separately.
 *
 * @param {string} accessToken
 * @param {string} playlistId
 * @param {string} trackUri   e.g. "spotify:track:4uLU6hMCjMI75M1A2tKUQC"
 * @returns {Promise<void>}
 */
export async function removeTrackFromPlaylist(accessToken, playlistId, trackUri)
```

#### Rate Limit Algorithm (inside each fetch helper)

```
attempt = 0
while attempt < 3:
  response = await axios.get(url, { timeout: 10_000 })
  if response.status == 429:
    retryAfter = min(parseInt(response.headers['retry-after'] ?? '30'), 60)
    await sleep(retryAfter * 1000)
    attempt++
    continue
  return response
throw new Error('Rate limit retries exhausted')
```

---

### 2.3 `src/middleware/auth.js`

Reusable Express middleware that verifies the `session` JWT cookie and attaches `req.user` for downstream handlers.

```js
/**
 * Express middleware. Verifies the httpOnly `session` JWT cookie.
 * On success: attaches { userId, spotifyId } to req.user and calls next().
 * On failure: responds 401.
 */
export default function requireAuth(req, res, next)
```

---

### 2.4 `src/routes/api.js`

REST endpoints for the frontend. All routes use `requireAuth`.

```
GET  /api/removals          → list removal_log rows for req.user
DELETE /api/removals/:id    → undo a removal (re-add track to playlist + delete removal_log row)
GET  /api/events            → list recent listen_events for req.user
GET  /api/status            → current polling state for req.user (isRunning, consecutive204s, etc.)
```

---

## Data Models

### 3.1 Database Schema

#### `users`

```sql
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spotify_id       TEXT UNIQUE NOT NULL,
  access_token     TEXT NOT NULL,          -- AES-256-GCM ciphertext
  refresh_token    TEXT,                   -- AES-256-GCM ciphertext; NULL = revoked/no auth
  token_expires_at TIMESTAMPTZ NOT NULL,
  last_poll_at     TIMESTAMPTZ,            -- NULL on first ever poll
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
```

#### `listen_events`

```sql
CREATE TABLE listen_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id     TEXT NOT NULL,              -- Spotify track ID (no "spotify:track:" prefix)
  playlist_id  TEXT NOT NULL,             -- Spotify playlist ID
  listened_pct NUMERIC(5,4) NOT NULL,     -- 0.0000 – 1.0000
  was_skipped  BOOLEAN NOT NULL,          -- listened_pct < 0.25
  source       TEXT NOT NULL              -- "live" | "recent" | "delta"
                 CHECK (source IN ('live','recent','delta')),
  listened_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, track_id, listened_at) -- deduplication key
);

CREATE INDEX ON listen_events (user_id, track_id, playlist_id, listened_at DESC);
```

#### `removal_log`

```sql
CREATE TABLE removal_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  track_name  TEXT NOT NULL,
  removed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason      TEXT NOT NULL               -- e.g. "skipped 2/2 recent listens"
);

CREATE INDEX ON removal_log (user_id, track_id, playlist_id, removed_at DESC);
```

### 3.2 In-Memory State Shape

```js
// userState: Map<userId: string, UserPollState>
//
// UserPollState = {
//   intervalId:    ReturnType<setInterval>,
//   isRunning:     boolean,           // skip-if-running guard
//   consecutive204s: number,          // resets on any non-204 currently-playing
//   reducedMode:   boolean,           // true = 60 s interval
//   liveTrack:     LiveTrackState | null
// }
//
// LiveTrackState = {
//   trackId:       string,            // Spotify track ID
//   durationMs:    number,
//   maxProgressMs: number,            // highest progress_ms seen across polls
//   playlistId:    string,            // extracted from context.uri
//   pausedSince:   number | null      // Date.now() when paused; null if playing
// }
```

---

## Data Flow

### 4.1 Full Poll Cycle Sequence

```
runPollCycle(userId)
  │
  ├─ [DB read] SELECT * FROM users WHERE id = userId
  │
  ├─ refreshTokenIfNeeded(user)
  │     ├─ decrypt(user.access_token)   → plaintext accessToken
  │     ├─ if token_expires_at <= now + 60s:
  │     │     POST https://accounts.spotify.com/api/token  { grant_type: refresh_token }
  │     │     encrypt(new access_token) → store in DB
  │     │     encrypt(new refresh_token) if present → store in DB
  │     └─ return { accessToken }
  │
  ├─ Promise.all([
  │     getCurrentlyPlaying(accessToken)    → cpResult
  │     getRecentlyPlayed(accessToken)      → rpItems
  │   ])
  │
  ├─ processLiveTrack(userId, cpResult)
  │     ├─ if cpResult.status == 204 → close open liveTrack if any → emit listen event
  │     ├─ if context not playlist → close open liveTrack if any → discard cp track
  │     ├─ if trackId changed from liveTrack.trackId → close old → open new liveTrack
  │     ├─ if same trackId → update maxProgressMs if progress_ms > current max
  │     ├─ if is_playing == false → set pausedSince; if paused > 30 min → close event
  │     └─ returns optional { listenEvent } for closed tracks
  │
  ├─ reconcileRecentlyPlayed(userId, rpItems, user.last_poll_at)
  │     ├─ filter: played_at > last_poll_at (epoch 0 if null)
  │     ├─ filter: context.uri starts with "spotify:playlist:"
  │     ├─ deduplicate by (user_id, played_at)
  │     ├─ for each item[i]: gap_ms = items[i-1].played_at - items[i].played_at
  │     │                              (or duration_ms for last item)
  │     │                    listened_pct = min(gap_ms / duration_ms, 1.0)
  │     └─ returns array of { trackId, playlistId, listenedPct, listenedAt, source:"recent" }
  │
  ├─ for each listen event (live + recent combined):
  │     writeListenEvent(event)
  │       ├─ validate listened_pct in [0.0, 1.0]
  │       ├─ check UNIQUE(user_id, track_id, listened_at) — skip if exists
  │       ├─ set was_skipped = (listened_pct < 0.25)
  │       ├─ apply source = "delta" override if listened_pct < 0.50 and source was "live"
  │       └─ INSERT INTO listen_events
  │
  ├─ for each successfully inserted event:
  │     detectSkip(userId, trackId, playlistId)
  │       ├─ [DB read] SELECT last removal_log row for (user_id, track_id, playlist_id)
  │       ├─ [DB read] SELECT 2 most-recent listen_events WHERE listened_at > cutoff
  │       ├─ if 2 rows and both was_skipped = true → emit removal signal
  │       └─ removeTrack(userId, trackId, playlistId, trackUri, accessToken)
  │             ├─ DELETE /playlists/{playlistId}/tracks  { uri: trackUri }
  │             ├─ if 403 → log + skip removal_log + blocklist playlist
  │             └─ INSERT INTO removal_log
  │
  └─ UPDATE users SET last_poll_at = cycleStart WHERE id = userId
```

### 4.2 Token Refresh Decision Tree

```
token_expires_at <= now + 60s ?
  NO  → use existing decrypted accessToken
  YES →
    POST /api/token (refresh_token grant)
    200 OK?
      YES → response has new refresh_token?
              YES → encrypt + save both
              NO  → encrypt + save access_token only
            return new accessToken
      400 / 401 (invalid_grant) →
            SET users.refresh_token = NULL
            deregisterUser(userId)
            log "permissions revoked"
            throw (abort cycle)
      Other error → log + throw (abort cycle, isRunning cleared)
```

### 4.3 Live Track State Machine

```
State: NO_TRACK
  on cp=200, playlist context, new trackId
    → open liveTrack { trackId, maxProgressMs=progress_ms, pausedSince=null }
    → state: TRACKING

State: TRACKING
  on cp=200, same trackId, is_playing=true
    → maxProgressMs = max(maxProgressMs, progress_ms)
  on cp=200, same trackId, is_playing=false
    → set pausedSince = now (if not already set)
    → if now - pausedSince > 30 min → close event → state: NO_TRACK
  on cp=200, different trackId or non-playlist context
    → close event for previous track → emit listen event
    → if new track is playlist → open new liveTrack → state: TRACKING
    → else → state: NO_TRACK
  on cp=204
    → close event → emit listen event → state: NO_TRACK
```

---

## Correctness Properties


*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

---

### Property 1: Only users with a non-null refresh_token receive polling intervals

*For any* set of user records loaded from the database, the polling engine SHALL register an interval for every user whose `refresh_token` is non-null, and SHALL NOT register an interval for any user whose `refresh_token` is null.

**Validates: Requirements 1.4**

---

### Property 2: Skip-if-running guard is concurrent-safe

*For any* user whose `isRunning` flag is `true` (i.e., a cycle is in progress), a concurrent call to `runPollCycle` for that user SHALL return immediately without executing any cycle logic or modifying any state.

**Validates: Requirements 1.9**

---

### Property 3: Stagger offset is always within [0, 5000] ms

*For any* user registered by the polling engine (whether at startup or via `registerUser`), the initial tick delay SHALL be a value drawn uniformly from the range [0, 5000] milliseconds (inclusive).

**Validates: Requirements 1.10**

---

### Property 4: Token refresh is triggered exactly when needed

*For any* user record with a `token_expires_at` timestamp, `refreshTokenIfNeeded` SHALL initiate a token exchange if and only if `(token_expires_at - now) <= 60 seconds`. If the deadline has not been reached, no exchange SHALL be made.

**Validates: Requirements 2.2**

---

### Property 5: Token storage is always encrypted; token usage is always decrypted

*For any* plaintext token string `t`: `encrypt(t)` SHALL differ from `t` (ciphertext is never plaintext), and `decrypt(encrypt(t))` SHALL equal `t` (round-trip fidelity). No plaintext token value SHALL ever appear in a Supabase write, and no ciphertext value SHALL ever be passed to a Spotify API call.

**Validates: Requirements 2.7, 2.8**

---

### Property 6: Reconciler output contains only items newer than last_poll_at

*For any* array of recently-played items with arbitrary `played_at` timestamps and any `last_poll_at` value (treating null as epoch 0), every item in the reconciled output SHALL have `played_at` strictly greater than `last_poll_at`. No item with `played_at <= last_poll_at` SHALL appear in the output.

**Validates: Requirements 3.1**

---

### Property 7: Reconciler output contains only playlist-context items with unique played_at timestamps

*For any* array of recently-played items with arbitrary `context.uri` values and arbitrary `played_at` timestamps (including duplicates), every item in the reconciled output SHALL have a `context.uri` that starts with `"spotify:playlist:"`, and the output SHALL contain at most one item per `played_at` timestamp (first occurrence wins).

**Validates: Requirements 3.2, 3.3, 3.7, 9.1, 9.4**

---

### Property 8: listened_pct is always min(gap_or_progress / duration_ms, 1.0)

*For any* `numerator_ms >= 0` and `duration_ms > 0`, the computed `listened_pct` SHALL equal `Math.min(numerator_ms / duration_ms, 1.0)`. This holds for both recently-played gap estimation (`numerator_ms = gap_ms`) and live-track progress computation (`numerator_ms = max_progress_ms`). Events with `duration_ms <= 0` SHALL be discarded without producing a `listened_pct`.

**Validates: Requirements 3.4, 3.5, 4.2, 4.6**

---

### Property 9: max_progress_ms is the running maximum of all observed progress_ms values

*For any* sequence of `progress_ms` values reported by `currently-playing` for the same `(user_id, track_id)` pair while the track remains active, `liveTrack.maxProgressMs` at any point SHALL equal the maximum of all `progress_ms` values observed so far for that track. It SHALL never decrease.

**Validates: Requirements 4.1**

---

### Property 10: Live-event source is "delta" iff listened_pct < 0.50

*For any* live listen event emitted by the Live_Track_Tracker upon a track change or 204 response, the stored `source` field SHALL be `"delta"` if and only if `listened_pct < 0.50`. Events with `listened_pct >= 0.50` SHALL be stored with `source = "live"`.

**Validates: Requirements 4.3, 4.8**

---

### Property 11: Listen event writes are idempotent on (user_id, track_id, listened_at)

*For any* listen event with a given `(user_id, track_id, listened_at)` triple, calling `writeListenEvent` any number of times (once or more) SHALL result in exactly one row in `listen_events` for that triple. Subsequent calls for the same triple SHALL be silently discarded without error or modification to the existing row.

**Validates: Requirements 5.1, 5.2**

---

### Property 12: was_skipped = (listened_pct < 0.25) for all inserted listen events

*For any* listen event with `listened_pct` in `[0.0, 1.0]`, the value of `was_skipped` stored in `listen_events` SHALL be `true` if and only if `listened_pct < 0.25`, and `false` if `listened_pct >= 0.25`.

**Validates: Requirements 5.3**

---

### Property 13: Skip detection triggers removal iff exactly 2 most-recent events are all skips

*For any* `(user_id, track_id, playlist_id)` triple with a given set of `listen_events` rows (after applying re-add history cutoff), skip detection SHALL emit a removal signal if and only if the 2 most-recent rows (by `listened_at` descending) both have `was_skipped = true`. Any other combination (0 rows, 1 row, 1 skip + 1 non-skip, 2 non-skips) SHALL produce no removal signal.

**Validates: Requirements 6.2, 6.3, 6.4**

---

### Property 14: Re-add history cutoff excludes pre-removal listen events from skip detection

*For any* `(user_id, track_id, playlist_id)` triple where a `removal_log` row exists, skip detection SHALL only consider `listen_events` rows whose `listened_at` is strictly greater than the most-recent `removal_log.removed_at` for that triple. Events at or before the cutoff SHALL be excluded from the 2-row evaluation window.

**Validates: Requirements 11.1, 11.2, 11.3, 11.4**

---

### Property 15: last_poll_at is always updated to the cycle-start timestamp at cycle end

*For any* poll cycle that begins execution (regardless of whether individual steps succeed or fail), the `last_poll_at` field on the user's row in Supabase SHALL be updated to the timestamp captured at the start of that cycle before any Spotify API calls were made. It SHALL not reflect the time the cycle ended, and it SHALL be written even if non-fatal errors occurred during the cycle.

**Validates: Requirements 8.1, 8.2, 8.3**

---

### Property 16: Retry-After wait is capped at 60 seconds and applied up to 3 times

*For any* `Retry-After` header value `r` returned in a 429 response, the Spotify client SHALL wait exactly `Math.min(r, 60)` seconds before the next attempt. If no `Retry-After` header is present, it SHALL wait 30 seconds. The client SHALL make at most 3 retry attempts total; if all 3 are exhausted without success, the Poll_Cycle SHALL be aborted for that user.

**Validates: Requirements 10.1, 10.2, 10.3, 10.4**

---

### Property 17: Reduced_Interval_Mode activates after exactly 5 consecutive 204s, exits on any active track

*For any* user, Reduced_Interval_Mode SHALL be activated when the user's `consecutive204s` counter reaches exactly 5 (not before). The counter SHALL reset to 0 on any non-204 response from `currently-playing`. When a user in Reduced_Interval_Mode receives a 200 response with an active track, the polling interval SHALL be restored to the normal range (10–20 s) and `reducedMode` SHALL be set to `false`.

**Validates: Requirements 13.1, 13.2, 13.3**

---

## Error Handling

### Error Categories and Responses

| Error | Component | Response |
|---|---|---|
| Spotify 429 | `spotify.js` | Retry-After wait, up to 3 retries, then skip cycle |
| Spotify 401 (invalid token) | `spotify.js` | Trigger token refresh via `refreshTokenIfNeeded` |
| Token refresh 400/401 `invalid_grant` | `poller.js` | Null refresh_token in DB, deregister user, log |
| Token refresh other failure | `poller.js` | Log error, skip cycle (isRunning cleared) |
| Spotify 403 on DELETE | `poller.js` | Log, skip removal_log, blocklist playlist ID in memory |
| Spotify API timeout (>10 s) | `spotify.js` | Throw immediately, skip remainder of cycle |
| Non-2xx from recently-played | `poller.js` | Log, continue with cp result only |
| Non-200/204 from currently-playing | `poller.js` | Log, continue with recent result only |
| `listen_events` INSERT failure | `poller.js` | Log (user_id, track_id, listened_at), do not retry |
| `listen_events` query failure (skip detection) | `poller.js` | Log triple, no removal action |
| `removal_log` INSERT failure after Spotify DELETE | `poller.js` | Log inconsistency warning |
| Unhandled exception in `runPollCycle` | `poller.js` | Catch at top, log, clear `isRunning`, continue next interval |
| `listened_pct` out of range | `poller.js` | Discard event, log, continue |
| `duration_ms <= 0` | `poller.js` | Discard event, log, continue |

### Error Isolation Guarantee

Each user's poll cycle runs in an independently-caught `try/catch`. A fatal error in one user's cycle does not affect any other user's interval. The outermost catch always clears `isRunning` to prevent the user's loop from getting permanently stuck.

```js
async function runPollCycle(userId) {
  const state = userState.get(userId)
  if (!state || state.isRunning) return
  state.isRunning = true
  const cycleStart = new Date()
  try {
    // ... pipeline ...
  } catch (err) {
    console.error(`[poller] cycle error for user ${userId}:`, err.message)
  } finally {
    // last_poll_at update is attempted inside the try/finally so it runs
    // even after partial failures (Req 8 AC3)
    state.isRunning = false
  }
}
```

---

## Testing Strategy

This feature contains substantial business logic (reconciliation arithmetic, skip detection, state machine transitions, token refresh decisions) that is well-suited for property-based testing. Infrastructure wiring (Supabase queries, Spotify API calls) is handled through integration tests with mocks.

### Property-Based Testing

**Library:** [`fast-check`](https://github.com/dubzzz/fast-check) (JavaScript, zero external runtime dependencies)

**Configuration:** Minimum 100 runs per property (`{ numRuns: 100 }`).

**Tag format:** `// Feature: core-polling-engine, Property N: <property text>`

Properties to implement as PBT:

| Property | Test File | fast-check Arbitraries |
|---|---|---|
| 1 — Active users get intervals | `poller.test.js` | `fc.array(fc.record({ id: fc.uuid(), refresh_token: fc.option(fc.string()) }))` |
| 2 — Skip-if-running guard | `poller.test.js` | `fc.uuid()` (userId) |
| 3 — Stagger offset in [0, 5000] ms | `poller.test.js` | `fc.uuid()` |
| 4 — Token refresh threshold | `spotify.test.js` | `fc.integer({ min: -120000, max: 120000 })` (offset from now in ms) |
| 5 — Token encrypt/decrypt round-trip | `crypto.test.js` | `fc.string({ minLength: 1, maxLength: 256 })` |
| 6 — Reconciler output newer than last_poll_at | `poller.test.js` | `fc.array(fc.record({ played_at: fc.date() }))`, `fc.option(fc.date())` |
| 7 — Playlist context filter + dedup | `poller.test.js` | `fc.array(fc.record({ context: fc.option(fc.record({ uri: fc.string() })), played_at: fc.date() }))` |
| 8 — listened_pct formula | `poller.test.js` | `fc.integer({ min: 0 })`, `fc.integer({ min: 1 })` |
| 9 — maxProgressMs is running max | `poller.test.js` | `fc.array(fc.integer({ min: 0, max: 600000 }), { minLength: 1 })` |
| 10 — Delta source iff listened_pct < 0.50 | `poller.test.js` | `fc.float({ min: 0, max: 1 })` |
| 11 — Idempotent listen event writes | `poller.test.js` | `fc.record({ user_id: fc.uuid(), track_id: fc.string(), listened_at: fc.date(), listened_pct: fc.float({ min: 0, max: 1 }) })` |
| 12 — was_skipped = listened_pct < 0.25 | `poller.test.js` | `fc.float({ min: 0, max: 1 })` |
| 13 — Skip detection trigger condition | `poller.test.js` | `fc.array(fc.record({ was_skipped: fc.boolean() }), { minLength: 0, maxLength: 5 })` |
| 14 — Re-add history cutoff | `poller.test.js` | `fc.array(fc.record({ listened_at: fc.date(), was_skipped: fc.boolean() }))`, `fc.date()` |
| 15 — last_poll_at = cycleStart | `poller.test.js` | `fc.uuid()`, random cycle outcomes |
| 16 — Retry-After capping | `spotify.test.js` | `fc.integer({ min: 0, max: 120 })` |
| 17 — Reduced_Interval_Mode transitions | `poller.test.js` | `fc.integer({ min: 1, max: 20 })` (consecutive 204 count) |

### Unit / Example-Based Tests

- Token refresh: two examples (with and without new refresh_token in response)
- Token refresh failure: 500 response → no API calls
- 204 response → live event emitted and state cleared
- is_playing=false → state retained
- Track switch from playlist to non-playlist context → live event closed
- Revoked permissions (invalid_grant) → refresh_token nulled, user deregistered
- 403 on Spotify DELETE → no removal_log written
- Non-2xx recently-played → cycle continues with cp only

### Integration Tests

- Full cycle with mocked Spotify client: verify both endpoints called, listen_events written, last_poll_at updated
- Skip detection → removal: verify removal_log row written with correct fields
- New user `registerUser` call post-startup: verify interval created

### Test File Layout

```
spotify-cleaner-backend/
└── src/
    └── __tests__/
        ├── poller.test.js      ← poller logic (most properties live here)
        ├── spotify.test.js     ← rate limit handling, token refresh threshold
        └── crypto.test.js      ← encrypt/decrypt round-trip property
```
