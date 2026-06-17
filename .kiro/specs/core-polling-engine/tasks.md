# Implementation Plan: Core Polling Engine

## Overview

Implement the server-side polling engine that continuously monitors Spotify playback for every authenticated user, writes listen events to Supabase, detects skip patterns, and automatically removes consistently-skipped tracks from playlists. The implementation follows the architecture defined in the design document: `spotify.js` (HTTP client) → `poller.js` (orchestrator) → `middleware/auth.js` + `routes/api.js` (REST layer), wired together in `src/index.js`.

All code uses ES Module syntax (`import`/`export`), JavaScript (no TypeScript), and builds on the existing `getSupabase()` singleton and `encrypt()`/`decrypt()` helpers.

---

## Tasks

- [ ] 1. Run database migrations in Supabase
  - Execute the `listen_events` DDL: `id UUID PK`, `user_id UUID FK → users`, `track_id TEXT`, `playlist_id TEXT`, `listened_pct NUMERIC(5,4)`, `was_skipped BOOLEAN`, `source TEXT CHECK IN ('live','recent','delta')`, `listened_at TIMESTAMPTZ`, `UNIQUE(user_id, track_id, listened_at)`
  - Create the supporting index: `CREATE INDEX ON listen_events (user_id, track_id, playlist_id, listened_at DESC)`
  - Execute the `removal_log` DDL: `id UUID PK`, `user_id UUID FK → users`, `track_id TEXT`, `playlist_id TEXT`, `track_name TEXT`, `removed_at TIMESTAMPTZ DEFAULT NOW()`, `reason TEXT`
  - Create the supporting index: `CREATE INDEX ON removal_log (user_id, track_id, playlist_id, removed_at DESC)`
  - Add `last_poll_at TIMESTAMPTZ` column to `users` table if it does not already exist: `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_poll_at TIMESTAMPTZ`
  - _Requirements: 3.1, 5.1, 6.1, 7.2, 8.1_


- [ ] 2. Install test dependencies
  - Add `vitest` and `fast-check` as devDependencies in `spotify-cleaner-backend/package.json`
  - Add a `"test"` script: `"test": "vitest --run"` to `package.json`
  - Run `npm install` in `spotify-cleaner-backend/` to install the new packages
  - _Requirements: (test infrastructure prerequisite for all test sub-tasks)_

- [ ] 3. Create `src/lib/spotify.js` — Spotify HTTP client
  - [ ] 3.1 Implement `refreshTokenIfNeeded(user)`
    - Decrypt `user.access_token` and `user.refresh_token` via `decrypt()` from `src/lib/crypto.js`
    - Compare `user.token_expires_at` against `Date.now() + 60_000`; skip refresh if not yet due
    - POST to `https://accounts.spotify.com/api/token` with `grant_type: refresh_token`, using `axios` with a 10 s timeout
    - On 200: encrypt new `access_token` (and `refresh_token` if present in response) via `encrypt()` and `UPDATE users SET ...` via `getSupabase()`
    - On 400/401 `invalid_grant`: re-throw with a recognisable `{ code: 'REVOKED' }` property so `poller.js` can handle it (Req 12)
    - On any other error: re-throw as-is
    - Return `{ accessToken }` (plaintext) on success
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [ ] 3.2 Implement `getCurrentlyPlaying(accessToken, userId)` with rate-limit retry loop
    - Use `axios.get('https://api.spotify.com/v1/me/player/currently-playing', { timeout: 10_000 })`
    - Implement the retry loop: up to 3 attempts; on 429 read `Retry-After` header (default 30 s, cap at 60 s), `await sleep(retryAfter * 1000)`, increment attempt counter
    - Return parsed response body on 200; return `null` on 204; throw on any other status or on retries exhausted
    - _Requirements: 1.3, 1.8, 10.1, 10.2, 10.3, 10.4_

  - [ ] 3.3 Implement `getRecentlyPlayed(accessToken, userId)` with rate-limit retry loop
    - Use `axios.get('https://api.spotify.com/v1/me/player/recently-played?limit=50', { timeout: 10_000 })`
    - Apply same 429 retry loop pattern as `getCurrentlyPlaying`
    - Return `response.data.items` array on success; throw on error
    - _Requirements: 1.3, 10.1, 10.2, 10.3, 10.4_

  - [ ] 3.4 Implement `removeTrackFromPlaylist(accessToken, playlistId, trackUri)`
    - Use `axios.delete('https://api.spotify.com/v1/playlists/{playlistId}/tracks', { data: { tracks: [{ uri: trackUri }] }, timeout: 10_000 })`
    - Return `true` on 200/201; throw with `{ code: 'FORBIDDEN_PLAYLIST' }` on 403; throw on all other non-success codes
    - _Requirements: 7.1, 9.6_


- [ ] 4. Checkpoint — Spotify client complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Create `src/lib/poller.js` — polling engine orchestrator
  - [ ] 5.1 Set up module-level in-memory state and helpers
    - Declare `const userState = new Map()` for `Map<userId, { intervalId, isRunning, consecutive204s, reducedMode, liveTrack }>`
    - Define `liveTrack` shape: `{ trackId, durationMs, maxProgressMs, playlistId, pausedSince }`
    - Implement a small `sleep(ms)` helper using `new Promise(resolve => setTimeout(resolve, ms))`
    - _Requirements: 1.9, 4.1, 13.3_

  - [ ] 5.2 Implement `startPollingEngine()`
    - Query Supabase: `SELECT id FROM users WHERE refresh_token IS NOT NULL`
    - Call `registerUser(user.id)` for every row returned
    - Export the function; it will be called once from `src/index.js`
    - _Requirements: 1.4_

  - [ ] 5.3 Implement `registerUser(userId)` and `deregisterUser(userId)`
    - `registerUser`: no-op if `userState.has(userId)` already; compute a stagger offset `Math.floor(Math.random() * 5001)` ms; call `setTimeout(() => { ... setInterval(runPollCycle, interval) }, staggerMs)` where `interval` is drawn from [10 000, 20 000] ms; store `{ intervalId, isRunning: false, consecutive204s: 0, reducedMode: false, liveTrack: null }` in `userState`
    - `deregisterUser`: call `clearInterval` on the stored `intervalId` and `userState.delete(userId)`
    - Export both functions
    - _Requirements: 1.2, 1.4, 1.6, 1.7, 1.10, 12.3, 12.4, 13.4_

  - [ ] 5.4 Implement `runPollCycle(userId)` — guard, token refresh, and parallel fetch
    - Skip-if-running guard: `if (state.isRunning) return`; set `state.isRunning = true`; capture `const cycleStart = new Date()`
    - Wrap entire body in `try/catch/finally`; `finally` clears `state.isRunning = false`
    - Load user row from Supabase: `SELECT access_token, refresh_token, token_expires_at, last_poll_at FROM users WHERE id = userId`
    - Call `refreshTokenIfNeeded(user)`; catch `{ code: 'REVOKED' }` → set `refresh_token = null` in DB, call `deregisterUser`, log, return
    - `const [cpResult, rpItems] = await Promise.all([getCurrentlyPlaying(...), getRecentlyPlayed(...)])`
    - _Requirements: 1.1, 1.3, 1.5, 1.8, 1.9, 2.1, 8.2, 12.2, 12.3, 12.4, 12.5_

  - [ ] 5.5 Implement `processLiveTrack(userId, cpResult, state)` — Live_Track_Tracker
    - On `cpResult === null` (204): if `state.liveTrack` is set, compute `listened_pct` and emit a listen event; clear `state.liveTrack`; increment `state.consecutive204s`; if `consecutive204s >= 5` activate Reduced_Interval_Mode (reschedule interval to 60 000 ms)
    - On 200 with non-playlist context: close any open live event, discard new track (Req 9.3, 9.5)
    - On 200 with playlist context and different `track_id` from `state.liveTrack`: close old event → emit listen event; open new `liveTrack`; reset `consecutive204s = 0`; if `reducedMode` restore normal interval
    - On 200 with same `track_id`: update `state.liveTrack.maxProgressMs = Math.max(maxProgressMs, progress_ms)`; handle `is_playing = false` (set `pausedSince`; if paused > 30 min → close event)
    - Apply `source = "delta"` override: if `listened_pct < 0.50`, emit with `source = "delta"`, else `source = "live"` (Req 4.8)
    - Return array of emitted listen events (may be empty)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 9.2, 9.3, 9.4, 9.5, 13.1, 13.2, 13.3_

  - [ ] 5.6 Implement `reconcileRecentlyPlayed(userId, rpItems, lastPollAt)` — Reconciler
    - Filter: `item.played_at > lastPollAt` (treat `null` as `new Date(0)`)
    - Filter: `item.context?.uri?.startsWith('spotify:playlist:')` only
    - Deduplicate: keep first occurrence per `played_at` timestamp
    - For each surviving item `i`: `gap_ms = items[i-1].played_at - items[i].played_at`; if `i` is the last item use `item.track.duration_ms` as gap; discard if `duration_ms <= 0`; `listened_pct = Math.min(gap_ms / duration_ms, 1.0)`
    - Return array of `{ trackId, playlistId, listenedPct, listenedAt, source: 'recent' }`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 9.1, 9.4_


  - [ ] 5.7 Implement `writeListenEvent(event)` — Listen_Event_Writer
    - Validate `listened_pct` is a number in `[0.0, 1.0]`; log and discard if not (Req 5.4)
    - Check dedup: query `SELECT id FROM listen_events WHERE user_id = $1 AND track_id = $2 AND listened_at = $3`; if exists → return without inserting (Req 5.1, 5.2)
    - Set `was_skipped = listened_pct < 0.10`
    - Apply `source = "delta"` override if `listened_pct < 0.50` and source was `"live"` (Req 4.8)
    - `INSERT INTO listen_events (user_id, track_id, playlist_id, listened_pct, was_skipped, source, listened_at)`; on DB error: log `(user_id, track_id, listened_at)`, do not retry (Req 5.5)
    - Return `true` if inserted, `false` if skipped
    - _Requirements: 4.8, 4.9, 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ] 5.8 Implement `detectSkip(userId, trackId, playlistId)` — Skip_Detector + Track_Remover
    - Query most-recent `removal_log` row for the triple to get cutoff timestamp (Req 11.1, 11.2)
    - Query 2 most-recent `listen_events` for `(user_id, track_id, playlist_id)` with `listened_at > cutoff` (null cutoff = no filter)
    - If fewer than 2 rows or not all `was_skipped = true` → return (Req 6.3, 6.4, 11.3)
    - If all 2 have `was_skipped = true`: call `removeTrack(userId, trackId, playlistId, accessToken)`
    - `removeTrack`: call `removeTrackFromPlaylist(accessToken, playlistId, trackUri)`; on 403 `FORBIDDEN_PLAYLIST` → log, skip `removal_log`, in-memory blocklist that `playlistId`; on success → `INSERT INTO removal_log` with `reason = "skipped 2/2 recent listens"`; on `removal_log` insert failure → log inconsistency warning (Req 7.4)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 9.6, 11.1, 11.2, 11.3, 11.4_

  - [ ] 5.9 Wire pipeline steps together inside `runPollCycle` and update `last_poll_at`
    - After parallel fetch: call `processLiveTrack` → `reconcileRecentlyPlayed` → combine event arrays
    - For each combined event: `await writeListenEvent(event)`; if inserted → `await detectSkip(...)`
    - In `finally` block: `UPDATE users SET last_poll_at = cycleStart WHERE id = userId` (runs even after partial failures, Req 8.3)
    - _Requirements: 1.5, 8.1, 8.2, 8.3_

- [ ] 6. Checkpoint — Core poller logic complete
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 7. Create `src/middleware/auth.js` — JWT cookie guard
  - [ ] 7.1 Implement `requireAuth(req, res, next)` middleware
    - Read `req.cookies?.session`; if absent → `res.status(401).json({ error: 'Not authenticated' })`
    - Verify the JWT with `jwt.verify(token, process.env.JWT_SECRET)`; attach `req.user = { userId, spotifyId }` and call `next()` on success
    - On `JsonWebTokenError` or `TokenExpiredError` → `res.status(401).json({ error: 'Invalid or expired session' })`
    - Export as default
    - _Requirements: (auth guard prerequisite for api.js routes)_

- [ ] 8. Create `src/routes/api.js` — REST API endpoints
  - [ ] 8.1 Implement `GET /api/removals` — list removal log for authenticated user
    - Apply `requireAuth` middleware
    - Query `SELECT * FROM removal_log WHERE user_id = $req.user.userId ORDER BY removed_at DESC LIMIT 50`
    - Return JSON array; handle DB errors with 500
    - _Requirements: 7.2_

  - [ ] 8.2 Implement `DELETE /api/removals/:id` — undo a removal
    - Apply `requireAuth` middleware
    - Fetch the `removal_log` row by `id` and `user_id` (ownership check)
    - Re-add the track: call `removeTrackFromPlaylist` in reverse by calling `POST /playlists/{playlistId}/tracks` with the track URI (note: this is a different Spotify endpoint; add `addTrackToPlaylist(accessToken, playlistId, trackUri)` to `spotify.js`)
    - Delete the `removal_log` row on success; return 204
    - Return 404 if row not found, 500 on error
    - _Requirements: 7.2_

  - [ ] 8.3 Implement `GET /api/events` — list recent listen events for authenticated user
    - Apply `requireAuth` middleware
    - Query `SELECT * FROM listen_events WHERE user_id = $req.user.userId ORDER BY listened_at DESC LIMIT 100`
    - Return JSON array; handle DB errors with 500
    - _Requirements: 5.1_

  - [ ] 8.4 Implement `GET /api/status` — current polling state for authenticated user
    - Apply `requireAuth` middleware
    - Read `userState.get(req.user.userId)` from the imported `userState` map (or export a `getStatus(userId)` helper from `poller.js`)
    - Return `{ isRunning, consecutive204s, reducedMode, hasLiveTrack: !!liveTrack }` or `{ registered: false }` if not found
    - _Requirements: 1.9, 13.1_

  - Mount the router at `/api` by exporting from `routes/api.js`


- [ ] 9. Wire polling engine into `src/index.js`
  - [ ] 9.1 Import and call `startPollingEngine()` at server startup
    - Add `import { startPollingEngine } from './lib/poller.js'` to `src/index.js`
    - After `app.listen(...)` resolves (inside the callback), call `startPollingEngine()` and `await` it (convert the callback to `async` if needed)
    - Add `import apiRoutes from './routes/api.js'` and mount: `app.use('/api', apiRoutes)`
    - _Requirements: 1.4_

  - [ ] 9.2 Expose `registerUser` / `deregisterUser` to the auth callback for new users
    - Import `registerUser` in `src/routes/auth.js`
    - After the successful upsert in `GET /auth/callback`, call `registerUser(user.id)` so new logins are picked up without a restart (Req 1.6)
    - _Requirements: 1.6_

- [ ] 10. Checkpoint — Full pipeline wired, manual smoke-test ready
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 11. Write property-based tests for `src/lib/crypto.js`
  - [ ]* 11.1 Write property test for token encrypt/decrypt round-trip (Property 5)
    - File: `src/__tests__/crypto.test.js`
    - Use `fc.string({ minLength: 1, maxLength: 256 })` to generate arbitrary plaintext tokens
    - Assert `decrypt(encrypt(t)) === t` for all inputs (100 runs)
    - Assert `encrypt(t) !== t` (ciphertext is never the plaintext)
    - Set `process.env.ENCRYPTION_KEY` to a fixed 32-byte string in the test setup
    - Tag: `// Feature: core-polling-engine, Property 5: Token storage is always encrypted; token usage is always decrypted`
    - **Property 5: Token encrypt/decrypt round-trip**
    - **Validates: Requirements 2.7, 2.8**

- [ ] 12. Write property-based tests for `src/lib/spotify.js`
  - [ ]* 12.1 Write property test for token refresh threshold (Property 4)
    - File: `src/__tests__/spotify.test.js`
    - Use `fc.integer({ min: -120000, max: 120000 })` as `offsetMs` (offset from now)
    - Mock the Spotify token endpoint via `vi.fn()` / `vi.mock('axios')`
    - For each generated `offsetMs`: set `token_expires_at = new Date(Date.now() + offsetMs).toISOString()`
    - Assert: token exchange is called iff `offsetMs <= 60000`; not called if `offsetMs > 60000`
    - Tag: `// Feature: core-polling-engine, Property 4: Token refresh is triggered exactly when needed`
    - **Property 4: Token refresh threshold**
    - **Validates: Requirements 2.2**

  - [ ]* 12.2 Write property test for Retry-After capping (Property 16)
    - File: `src/__tests__/spotify.test.js`
    - Use `fc.integer({ min: 0, max: 120 })` to generate arbitrary `Retry-After` header values
    - Mock `axios` to return 429 with the generated header on the first call, then 200 on the second
    - Assert the sleep duration equals `Math.min(retryAfter, 60) * 1000` milliseconds
    - For the absent-header case: assert sleep defaults to 30 000 ms
    - Tag: `// Feature: core-polling-engine, Property 16: Retry-After wait is capped at 60 seconds and applied up to 3 times`
    - **Property 16: Retry-After capping**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**


- [ ] 13. Write property-based tests for `src/lib/poller.js` — polling loop properties
  - [ ]* 13.1 Write property test: only users with non-null refresh_token get intervals (Property 1)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.array(fc.record({ id: fc.uuid(), refresh_token: fc.option(fc.string()) }))` 
    - Mock `getSupabase()` to return the generated user list; mock `setInterval`
    - Assert `registerUser` called for every user where `refresh_token !== null`; never called for null users
    - Tag: `// Feature: core-polling-engine, Property 1: Only users with a non-null refresh_token receive polling intervals`
    - **Property 1: Active users get intervals**
    - **Validates: Requirements 1.4**

  - [ ]* 13.2 Write property test: skip-if-running guard is concurrent-safe (Property 2)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.uuid()` as `userId`; seed state with `isRunning: true` in `userState`
    - Call `runPollCycle(userId)` and assert no Supabase or Spotify calls are made
    - Tag: `// Feature: core-polling-engine, Property 2: Skip-if-running guard is concurrent-safe`
    - **Property 2: Skip-if-running guard**
    - **Validates: Requirements 1.9**

  - [ ]* 13.3 Write property test: stagger offset is always within [0, 5000] ms (Property 3)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.uuid()` as `userId`; spy on `setTimeout` to capture the delay argument
    - Call `registerUser(userId)` 100 times (each call deregisters first)
    - Assert every captured delay `d` satisfies `0 <= d && d <= 5000`
    - Tag: `// Feature: core-polling-engine, Property 3: Stagger offset is always within [0, 5000] ms`
    - **Property 3: Stagger offset range**
    - **Validates: Requirements 1.10**

- [ ] 14. Write property-based tests for `src/lib/poller.js` — reconciler and listen event properties
  - [ ]* 14.1 Write property test: reconciler output newer than last_poll_at (Property 6)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.array(fc.record({ played_at: fc.date(), context: fc.constant({ uri: 'spotify:playlist:abc' }), track: fc.record({ id: fc.string(), duration_ms: fc.integer({ min: 1, max: 300000 }) }) }))` and `fc.option(fc.date())`
    - Call the exported/extracted `reconcileRecentlyPlayed` with generated data
    - Assert every item in output has `listenedAt > lastPollAt` (treating null as epoch 0)
    - Tag: `// Feature: core-polling-engine, Property 6: Reconciler output contains only items newer than last_poll_at`
    - **Property 6: Reconciler timestamp filter**
    - **Validates: Requirements 3.1**

  - [ ]* 14.2 Write property test: reconciler playlist-context filter and dedup (Property 7)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.array(fc.record({ context: fc.option(fc.record({ uri: fc.string() })), played_at: fc.date(), track: fc.record({ id: fc.string(), duration_ms: fc.integer({ min: 1 }) }) }))`
    - Assert all output items have `context.uri` starting with `"spotify:playlist:"`
    - Assert no two output items share the same `played_at` timestamp
    - Tag: `// Feature: core-polling-engine, Property 7: Reconciler output contains only playlist-context items with unique played_at timestamps`
    - **Property 7: Reconciler context filter + dedup**
    - **Validates: Requirements 3.2, 3.3, 3.7, 9.1, 9.4**

  - [ ]* 14.3 Write property test: listened_pct formula (Property 8)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.integer({ min: 0 })` for numerator and `fc.integer({ min: 1 })` for duration
    - Assert `computeListenedPct(numerator, duration) === Math.min(numerator / duration, 1.0)` for all inputs
    - Assert events with `duration <= 0` are discarded (return `null`)
    - Tag: `// Feature: core-polling-engine, Property 8: listened_pct is always min(gap_or_progress / duration_ms, 1.0)`
    - **Property 8: listened_pct formula**
    - **Validates: Requirements 3.4, 3.5, 4.2, 4.6**


- [ ] 15. Write property-based tests for `src/lib/poller.js` — live track and event write properties
  - [ ]* 15.1 Write property test: max_progress_ms is running maximum (Property 9)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.array(fc.integer({ min: 0, max: 600000 }), { minLength: 1 })` for a sequence of `progress_ms` values
    - Feed each value through `processLiveTrack` for the same `(userId, trackId)` pair (mock cp responses)
    - Assert `state.liveTrack.maxProgressMs === Math.max(...sequence)` after all updates
    - Tag: `// Feature: core-polling-engine, Property 9: max_progress_ms is the running maximum of all observed progress_ms values`
    - **Property 9: maxProgressMs is running max**
    - **Validates: Requirements 4.1**

  - [ ]* 15.2 Write property test: live event source is "delta" iff listened_pct < 0.50 (Property 10)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.float({ min: 0, max: 1 })` for `listened_pct`
    - Simulate a track-change event with the given `listened_pct`; capture emitted event's `source`
    - Assert `source === 'delta'` iff `listened_pct < 0.50`; else `source === 'live'`
    - Tag: `// Feature: core-polling-engine, Property 10: Live-event source is "delta" iff listened_pct < 0.50`
    - **Property 10: Delta source classification**
    - **Validates: Requirements 4.3, 4.8**

  - [ ]* 15.3 Write property test: listen event writes are idempotent (Property 11)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.record({ user_id: fc.uuid(), track_id: fc.string(), listened_at: fc.date(), listened_pct: fc.float({ min: 0, max: 1 }) })`
    - Call `writeListenEvent(event)` N times (N drawn from `fc.integer({ min: 1, max: 5 })`) with the same triple
    - Mock Supabase insert to count calls; assert exactly 1 insert issued, all subsequent calls are no-ops
    - Tag: `// Feature: core-polling-engine, Property 11: Listen event writes are idempotent on (user_id, track_id, listened_at)`
    - **Property 11: Idempotent listen event writes**
    - **Validates: Requirements 5.1, 5.2**

  - [ ]* 15.4 Write property test: was_skipped = (listened_pct < 0.10) (Property 12)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.float({ min: 0, max: 1 })` for `listened_pct`
    - Call `writeListenEvent` and capture the row passed to the Supabase insert
    - Assert `was_skipped === (listened_pct < 0.10)` for all inputs
    - Tag: `// Feature: core-polling-engine, Property 12: was_skipped = (listened_pct < 0.10) for all inserted listen events`
    - **Property 12: was_skipped flag**
    - **Validates: Requirements 5.3**


- [ ] 16. Write property-based tests for `src/lib/poller.js` — skip detection and engine-level properties
  - [ ]* 16.1 Write property test: skip detection trigger condition (Property 13)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.array(fc.record({ was_skipped: fc.boolean() }), { minLength: 0, maxLength: 5 })` for mock `listen_events` rows
    - Mock Supabase to return the generated rows from the skip-detection query
    - Assert removal is triggered iff the 2 most-recent rows both have `was_skipped = true`
    - Assert no removal for: 0 rows, 1 row, 1 skip + 1 non-skip, 2 non-skips
    - Tag: `// Feature: core-polling-engine, Property 13: Skip detection triggers removal iff exactly 2 most-recent events are all skips`
    - **Property 13: Skip detection trigger**
    - **Validates: Requirements 6.2, 6.3, 6.4**

  - [ ]* 16.2 Write property test: re-add history cutoff (Property 14)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.array(fc.record({ listened_at: fc.date(), was_skipped: fc.boolean() }))` and `fc.date()` for `removed_at`
    - Mock Supabase to return a `removal_log` row with the generated `removed_at`
    - Assert only `listen_events` rows with `listened_at > removed_at` are considered in skip evaluation
    - Assert rows at or before the cutoff are excluded from the 2-row window
    - Tag: `// Feature: core-polling-engine, Property 14: Re-add history cutoff excludes pre-removal listen events from skip detection`
    - **Property 14: Re-add history cutoff**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4**

  - [ ]* 16.3 Write property test: last_poll_at always updated to cycleStart (Property 15)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.uuid()` for `userId`; simulate random cycle outcomes (success, partial error, full error) via mocked Spotify responses
    - Spy on the Supabase `UPDATE users SET last_poll_at` call
    - Assert the updated timestamp equals `cycleStart` captured at the start of the cycle, not the end
    - Assert the update is made even when non-fatal errors occur mid-cycle
    - Tag: `// Feature: core-polling-engine, Property 15: last_poll_at is always updated to the cycle-start timestamp at cycle end`
    - **Property 15: last_poll_at = cycleStart**
    - **Validates: Requirements 8.1, 8.2, 8.3**

  - [ ]* 16.4 Write property test: Reduced_Interval_Mode transitions (Property 17)
    - File: `src/__tests__/poller.test.js`
    - Use `fc.integer({ min: 1, max: 20 })` for the number of consecutive 204 responses to feed
    - Mock `currently-playing` to return 204 N times, then 200 with an active track
    - Assert `reducedMode` is set to `true` only when `consecutive204s` reaches exactly 5
    - Assert `reducedMode` returns to `false` and interval is restored on the first active-track 200
    - Tag: `// Feature: core-polling-engine, Property 17: Reduced_Interval_Mode activates after exactly 5 consecutive 204s, exits on any active track`
    - **Property 17: Reduced_Interval_Mode transitions**
    - **Validates: Requirements 13.1, 13.2, 13.3**

- [ ] 17. Checkpoint — All property tests written
  - Ensure all tests pass, ask the user if questions arise.


- [ ] 18. Write integration and unit tests
  - [ ]* 18.1 Write unit tests for token refresh scenarios
    - File: `src/__tests__/spotify.test.js`
    - Test: token refresh with new `refresh_token` in response → both tokens updated in DB
    - Test: token refresh without new `refresh_token` → only `access_token` updated; `refresh_token` unchanged
    - Test: token refresh returns 500 → no Spotify API calls issued for the cycle
    - Test: `invalid_grant` response → throws with `{ code: 'REVOKED' }`
    - _Requirements: 2.3, 2.4, 2.5, 12.2_

  - [ ]* 18.2 Write unit tests for Live_Track_Tracker state transitions
    - File: `src/__tests__/poller.test.js`
    - Test: 204 response → live event emitted and `liveTrack` cleared
    - Test: `is_playing = false` → state retained, no event emitted
    - Test: paused > 30 consecutive minutes → live event closed using last `maxProgressMs`
    - Test: track switch from playlist to non-playlist context → live event closed before discarding new track
    - _Requirements: 4.4, 4.5, 4.7, 9.5_

  - [ ]* 18.3 Write unit tests for revoked permissions flow
    - File: `src/__tests__/poller.test.js`
    - Test: token refresh returns `invalid_grant` → `refresh_token` set to null in DB via `getSupabase()`
    - Test: after revocation, `deregisterUser` called and no further Spotify calls are made
    - Test: log entry written indicating revoked permissions with user identifier
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [ ]* 18.4 Write unit tests for 403 Spotify-owned playlist handling
    - File: `src/__tests__/poller.test.js`
    - Test: `removeTrackFromPlaylist` returns 403 → `removal_log` is NOT written
    - Test: playlist ID is added to in-memory blocklist after 403
    - Test: subsequent removal attempts for the same `playlist_id` are skipped without calling Spotify
    - _Requirements: 9.6_

  - [ ]* 18.5 Write integration test: full poll cycle with mocked Spotify client
    - File: `src/__tests__/poller.test.js`
    - Mock both `getCurrentlyPlaying` and `getRecentlyPlayed` to return realistic payloads
    - Run one full `runPollCycle`; assert:
      - Both Spotify endpoints were called
      - `listen_events` rows were written with correct field values
      - `last_poll_at` was updated to the cycle-start timestamp
    - _Requirements: 1.1, 1.3, 5.1, 8.1_

  - [ ]* 18.6 Write integration test: skip detection → removal log written
    - File: `src/__tests__/poller.test.js`
    - Seed mock Supabase with 2 existing `was_skipped = true` events for the same triple
    - Run `detectSkip` → assert `removeTrackFromPlaylist` called and `removal_log` row inserted with `reason = "skipped 2/2 recent listens"`
    - _Requirements: 6.2, 7.2_

  - [ ]* 18.7 Write integration test: `registerUser` post-startup via auth callback
    - File: `src/__tests__/poller.test.js`
    - Call `registerUser(newUserId)` after engine is already running (simulating new OAuth login)
    - Assert `userState.has(newUserId) === true` and a new interval was created
    - _Requirements: 1.6_

- [ ] 19. Final checkpoint — All tests pass
  - Ensure all tests pass, ask the user if questions arise.


---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP build. All property and unit/integration test sub-tasks are optional.
- The implementation language is **JavaScript (ES Modules)** — all files use `import`/`export`, never `require()`.
- Vitest is the test runner (`vitest --run` for single-shot CI execution). fast-check provides property-based arbitraries.
- Tasks 3–9 have sequential data-flow dependencies: `spotify.js` must exist before `poller.js`, which must exist before `index.js` wiring.
- Task 1 (database migrations) is a prerequisite for all tasks that write to Supabase, but the DDL can be executed in the Supabase dashboard SQL editor independently of the code tasks.
- The `reconcileRecentlyPlayed` and `writeListenEvent` functions should be exported from `poller.js` (or extracted into their own helpers) to make them independently testable by the property-based test tasks.
- Each property test file must tag each test with: `// Feature: core-polling-engine, Property N: <text>` for traceability.
- The in-memory blocklist for Spotify-owned playlists (Req 9.6) is a `Set<playlistId>` stored at module level in `poller.js`; it resets on process restart (acceptable for v1).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["3.1", "3.2", "3.3", "3.4"] },
    { "id": 2, "tasks": ["5.1", "5.2", "5.3", "7.1", "12.1", "12.2"] },
    { "id": 3, "tasks": ["5.4", "5.5", "5.6", "8.1", "8.2", "8.3", "8.4", "11.1"] },
    { "id": 4, "tasks": ["5.7", "5.8", "13.1", "13.2", "13.3", "14.1", "14.2", "14.3"] },
    { "id": 5, "tasks": ["5.9", "15.1", "15.2", "15.3", "15.4"] },
    { "id": 6, "tasks": ["9.1", "9.2", "16.1", "16.2", "16.3", "16.4"] },
    { "id": 7, "tasks": ["18.1", "18.2", "18.3", "18.4"] },
    { "id": 8, "tasks": ["18.5", "18.6", "18.7"] }
  ]
}
```
