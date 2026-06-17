# Requirements Document

## Introduction

The Core Polling Engine is the background service responsible for continuously monitoring Spotify playback activity for authenticated users and automatically removing tracks from playlists when those tracks are consistently skipped. It runs server-side on every active user's account, calling two Spotify API endpoints on each cycle, reconciling the results into listen events, detecting skip patterns, and issuing removal commands — all without requiring the user to have a browser open.

The engine sits at the heart of the Spotify Playlist Cleaner. Phase 1 already handles authentication, token storage, and the Supabase database. This phase wires the background loop, the listen-event pipeline, the skip-detection query, and the removal action together into a working system.

> **Skip threshold (v1):** A track is removed when its 2 most-recent listen events for a given `(user_id, track_id, playlist_id)` triple are all skips (`listened_pct < 0.10`). The lookback window is fixed at 2 events for v1; the plan document references "last 3 listens" as a future user-configurable default, but the implemented v1 threshold is 2/2.

### Scope Boundaries

The following are explicitly out of scope for v1:

- **Multi-device conflict resolution**: the Spotify API returns the most-recently-active device; the engine tracks whatever `currently-playing` returns without attempting device disambiguation.
- **Spotify Group Session / Jam sessions**: playback controlled by other users in a jam is not distinguishable via the API; the engine tracks the playback stream as-is.
- **Per-playlist or per-user skip thresholds**: the threshold (10%, 2 listens) is global for v1.
- **Event severity weighting**: a 0% listen and a 9% listen are both treated as skips equally.
- **Crossfade handling**: the engine uses `track_id` changes as the song-change signal; crossfade creates a small window of ambiguity that is accepted.
- **Backwards scrubbing**: `max_progress_ms` only monotonically increases, so scrubbing back has no effect on the recorded `listened_pct`.
- **Songs under 30 seconds**: tracks shorter than 30 seconds may not appear in recently-played; however, the Live_Track_Tracker's delta-tracking path (see Requirement 4) captures these as `source = "delta"` events, so they are no longer a blind spot for skip detection.
- **Shuffle mode**: skip events on shuffled playlists are treated identically to linear listening.
- **Duplicate tracks in a playlist**: removing a track by URI removes all occurrences; this is Spotify's API behavior and is accepted.
- **Scalability beyond ~100 concurrent users**: the `setInterval`-per-user model is adequate for personal/small-scale use; BullMQ migration is a future enhancement.
- **Thundering herd mitigation beyond staggering**: poll intervals are staggered by a Stagger_Offset (0–5 s random delay per user at engine startup); no further coordination is needed for v1. See Requirement 1, AC 10.
- **Encryption key rotation**: out of scope for v1; requires a migration script not part of this phase.
- **User-configurable skip threshold / lookback window**: the threshold is global and fixed at `listened_pct < 0.10` / 2-of-2 events for v1. Settings UI is a future phase.
- **Health/keepalive endpoint**: an HTTP `/health` ping route to prevent Render/Railway free-tier sleep is outside the scope of the polling engine itself (handled at the Express layer).

---

## Glossary

- **Polling_Engine**: The Node.js background service that drives the per-user polling loop using `setInterval` or equivalent.
- **Poll_Cycle**: One complete execution of the polling logic for a single user: fetch → reconcile → evaluate → update.
- **Spotify_Client**: The module responsible for making authenticated HTTP requests to the Spotify Web API, including token refresh.
- **Token_Refresher**: The sub-component of Spotify_Client that checks `token_expires_at` before each cycle and exchanges the refresh token for a new access token when necessary.
- **Currently_Playing_Fetcher**: The component that calls `GET /me/player/currently-playing` and returns live track + progress data.
- **Recently_Played_Fetcher**: The component that calls `GET /me/player/recently-played?limit=50` and returns the last 50 played tracks with timestamps.
- **Live_Track_Tracker**: The stateful component that tracks `max_progress_ms` for the currently-playing track across consecutive polls and closes the live event when the track changes.
- **Reconciler**: The component that filters recently-played results against `last_poll_at` and produces a list of missed tracks to insert.
- **Listen_Event_Writer**: The component that inserts rows into the `listen_events` table, enforcing deduplication before insert.
- **Skip_Detector**: The component that queries the last 2 `listen_events` for a `(user_id, track_id, playlist_id)` triple and evaluates the skip threshold.
- **Track_Remover**: The component that calls the Spotify DELETE endpoint and writes a row to `removal_log`.
- **listen_events**: Supabase table storing individual listen events with fields: `id`, `user_id`, `track_id`, `playlist_id`, `listened_pct`, `was_skipped`, `source`, `listened_at`.
- **removal_log**: Supabase table recording removed tracks with fields: `id`, `user_id`, `track_id`, `playlist_id`, `track_name`, `removed_at`, `reason`.
- **users**: Supabase table with fields: `id`, `spotify_id`, `access_token` (encrypted), `refresh_token` (encrypted), `token_expires_at`, `last_poll_at`, `created_at`.
- **listened_pct**: A float from 0.0 to 1.0 representing the fraction of a track's duration that was listened to.
- **was_skipped**: Boolean; `true` when `listened_pct < 0.10`.
- **source**: One of three values: `"live"` (derived from real-time `progress_ms` tracked across polls), `"recent"` (estimated from timestamp gaps in recently-played), or `"delta"` (inferred from a playback position discontinuity — the track changed or vanished before accumulating enough progress to appear in recently-played).
- **last_poll_at**: The timestamp stored on the `users` row indicating when the most recent Poll_Cycle completed; used as the cutoff for reconciling recently-played data.
- **playlist context**: A Spotify `context.uri` that begins with `spotify:playlist:`. Events from non-playlist contexts (albums, artists, liked songs) are ignored.
- **Reduced_Interval_Mode**: A per-user state in which the Polling_Engine uses a 60-second poll interval instead of the normal 10–20 second interval, activated after 5 consecutive 204 responses from `currently-playing`.
- **Stagger_Offset**: A small random delay (0–5 seconds) applied when starting each user's polling interval at engine startup, used to spread API calls across time and avoid simultaneous bursts.

---

## Requirements

### Requirement 1: Polling Loop

**User Story:** As a backend service, I want to call both Spotify playback endpoints on a fixed interval, so that no listening activity is missed between cycles.

#### Acceptance Criteria

1. THE Polling_Engine SHALL call both `GET /me/player/currently-playing` and `GET /me/player/recently-played?limit=50` on every Poll_Cycle for each active user.
2. THE Polling_Engine SHALL execute each Poll_Cycle on an interval between 10 and 20 seconds for every user with a non-null `refresh_token` in the `users` table.
3. THE Polling_Engine SHALL execute the two Spotify API calls for a given user in parallel within the same Poll_Cycle.
4. WHEN the Polling_Engine starts, THE Polling_Engine SHALL begin a polling interval for every user that has a non-null `refresh_token` stored in the `users` table.
5. IF a Poll_Cycle throws an unhandled exception for a given user, THEN THE Polling_Engine SHALL log the error and continue polling that user on the next scheduled interval without terminating other users' loops.
6. WHEN a new user authenticates (i.e., their `refresh_token` transitions from null to non-null in the `users` table after the engine has already started), THE Polling_Engine SHALL begin a polling interval for that user without requiring a restart.
7. WHEN a user's `refresh_token` is cleared or set to null in the `users` table, THE Polling_Engine SHALL stop the polling interval for that user.
8. IF a Spotify API call does not return a response within 10 seconds, THEN THE Spotify_Client SHALL treat it as a failed request, log a timeout error, and skip the remainder of the Poll_Cycle for that user without retrying immediately — waiting for the next scheduled interval instead.
9. IF a Poll_Cycle for a given user is still executing when the next interval fires, THEN THE Polling_Engine SHALL skip that interval for that user and wait for the next one. Only one Poll_Cycle per user SHALL execute at a time.
10. WHEN starting a polling interval for a user (at engine startup or on new-user authentication), THE Polling_Engine SHALL delay the first tick by a Stagger_Offset: a uniformly random value in the range [0, 5] seconds, so that poll cycles for different users are spread out over time rather than firing simultaneously.

---

### Requirement 2: Token Refresh

**User Story:** As a backend service, I want to automatically refresh expired Spotify access tokens before each poll, so that API calls never fail due to token expiry.

#### Acceptance Criteria

1. WHILE executing a Poll_Cycle, THE Token_Refresher SHALL check `token_expires_at` for the user before making any Spotify API call.
2. WHEN `token_expires_at` is within 60 seconds of the current time or has already passed, THE Token_Refresher SHALL exchange the stored `refresh_token` for a new `access_token` using the Spotify token endpoint.
3. WHEN a token refresh succeeds and the Spotify response includes a new `refresh_token`, THE Token_Refresher SHALL update both `access_token` and `refresh_token` along with `token_expires_at` in the `users` table before proceeding with the Poll_Cycle.
4. WHEN a token refresh succeeds and the Spotify response does not include a new `refresh_token`, THE Token_Refresher SHALL update only `access_token` and `token_expires_at` in the `users` table, leaving `refresh_token` unchanged.
5. IF the token refresh request fails, THEN THE Token_Refresher SHALL write an error log entry containing the user identifier and the error reason, make no Spotify API calls for that user in the current cycle, and leave the `users` table unmodified.
6. IF a user's `refresh_token` is null, THEN THE Token_Refresher SHALL skip the Poll_Cycle for that user and write an error log entry indicating no refresh token is available.
7. WHEN reading `access_token` or `refresh_token` from the `users` table, THE Token_Refresher SHALL decrypt the value using AES-256-GCM (via the shared `crypto.js` module) before using it in any Spotify API request or token exchange call. The raw ciphertext value stored in the database SHALL never be sent to Spotify.
8. WHEN writing a new `access_token` or `refresh_token` to the `users` table, THE Token_Refresher SHALL encrypt the plaintext value using AES-256-GCM before the database write. Plaintext tokens SHALL never be stored in the database.

---

### Requirement 3: Reconcile Recently-Played Tracks

**User Story:** As a backend service, I want to reconcile the recently-played list against `last_poll_at`, so that tracks played entirely between two poll cycles are captured as listen events.

#### Acceptance Criteria

1. WHEN processing recently-played results, THE Reconciler SHALL filter to only tracks whose `played_at` timestamp is strictly greater than the user's `last_poll_at`. IF `last_poll_at` is null for a user, THEN THE Reconciler SHALL treat it as epoch 0 (i.e., capture all returned tracks).
2. WHEN a recently-played track has a playlist context (i.e., `context.uri` starts with `spotify:playlist:`), THE Reconciler SHALL include it for listen event creation.
3. IF a recently-played track has a non-playlist context or a null context, THEN THE Reconciler SHALL silently discard the track and take no action.
4. WHEN estimating `listened_pct` for a missed track, THE Reconciler SHALL compute `gap_ms / track.duration_ms` where `gap_ms` is the difference between the subsequent track's `played_at` and this track's `played_at`, cap the result at 1.0, and discard the track if `track.duration_ms` is 0 or negative.
5. WHEN the missed track is the most-recent entry in the recently-played list (i.e., no subsequent track exists to compute a gap), THE Reconciler SHALL use the track's `duration_ms` as the gap, capping `listened_pct` at 1.0.
6. THE Listen_Event_Writer SHALL store Reconciler-produced events with `source = "recent"`.
7. IF the recently-played list contains multiple entries with the same `(user_id, played_at)` pair, THEN THE Reconciler SHALL process only the first occurrence and silently discard subsequent duplicates.
8. IF the `GET /me/player/recently-played` call returns an error response (non-2xx, non-429), THEN THE Reconciler SHALL log the error including the user identifier and HTTP status, skip recently-played reconciliation for the current cycle, and allow the Poll_Cycle to continue with the currently-playing result only.

---

### Requirement 4: Live Track Progress Tracking

**User Story:** As a backend service, I want to track the maximum playback progress seen for the currently-playing track across polls, so that I can record an accurate `listened_pct` when the track changes.

#### Acceptance Criteria

1. WHEN `currently-playing` returns a track in a playlist context, THE Live_Track_Tracker SHALL update its in-memory record of `max_progress_ms` for that `(user_id, track_id)` pair if the returned `progress_ms` is greater than the currently stored value.
2. WHEN the `track_id` returned by `currently-playing` differs from the `track_id` recorded in the previous poll for that user, THE Live_Track_Tracker SHALL compute `listened_pct = min(max_progress_ms / duration_ms, 1.0)` using the previous track's `duration_ms`, extract `playlist_id` from the previous track's `context.uri`, and emit a listen event for the previous track. This applies regardless of how small `max_progress_ms` is — a value of 0 ms SHALL still produce a listen event with `listened_pct = 0.0`.
3. THE Listen_Event_Writer SHALL store Live_Track_Tracker-produced events with `source = "live"` unless overridden by AC8 below, which reclassifies fast-skip events as `source = "delta"`.
4. WHEN `currently-playing` returns a 204 No Content response and a track was previously being tracked for that user, THE Live_Track_Tracker SHALL compute `listened_pct = min(max_progress_ms / duration_ms, 1.0)` and emit a listen event, then clear the in-memory state for that user. This applies regardless of how small `max_progress_ms` is — a value of 0 ms SHALL still produce a listen event with `listened_pct = 0.0`.
5. WHEN `currently-playing` returns a track with `is_playing = false` (playback paused), THE Live_Track_Tracker SHALL retain the current `max_progress_ms` without closing the event, as the user may resume the same track.
6. IF `duration_ms` for the previously tracked track is 0 or negative, THEN THE Live_Track_Tracker SHALL discard the live event without inserting a listen event and clear the in-memory state for that user.
7. IF a live event has been open with `is_playing = false` for more than 30 consecutive minutes (i.e., the Live_Track_Tracker has seen only paused responses for that user for 30+ consecutive minutes), THEN THE Live_Track_Tracker SHALL close the live event using the last-recorded `max_progress_ms`, emit a listen event, and clear the in-memory state for that user.
8. WHEN THE Live_Track_Tracker emits a listen event because a track change or 204 response was detected and the previous track's `listened_pct` is less than 0.50 (i.e., less than half the track was observed via live polling — indicating the poll-derived progress is likely incomplete), THE Listen_Event_Writer SHALL store that event with `source = "delta"` instead of `source = "live"`, to flag it as an inferred fast-skip event. Events with `listened_pct >= 0.50` are stored as `source = "live"` because the polling captured enough progress to be considered a reliable measurement.
9. WHEN THE Live_Track_Tracker emits a `source = "delta"` listen event and a `source = "live"` or `source = "recent"` event already exists in `listen_events` for the same `(user_id, track_id, listened_at)`, THE Listen_Event_Writer SHALL treat the existing event as authoritative, skip the delta insert, and raise no error.
10. IF the `GET /me/player/currently-playing` call returns a non-200, non-204 error response (and is not a 429 handled by Requirement 10), THEN THE Live_Track_Tracker SHALL log the error including the user identifier and HTTP status, leave the in-memory `max_progress_ms` state unchanged, and allow the Poll_Cycle to continue with the recently-played reconciliation result only.

---

### Requirement 5: Listen Event Deduplication

**User Story:** As a backend service, I want to deduplicate recently-played entries before inserting them, so that overlapping poll windows do not produce duplicate listen events.

#### Acceptance Criteria

1. WHEN THE Listen_Event_Writer is about to insert a recently-played-derived (`source = "recent"`) or delta-inferred (`source = "delta"`) listen event, it SHALL check whether a row with the exact same `(user_id, track_id, listened_at)` — using timestamp equality with no tolerance window — already exists in the `listen_events` table, regardless of the existing row's `source` value.
2. IF a matching row already exists (regardless of its `source`), THEN THE Listen_Event_Writer SHALL write no row to `listen_events` and raise no error. A `source = "live"` or `source = "recent"` event is always treated as authoritative over a `source = "delta"` event for the same `(user_id, track_id, listened_at)`.
3. WHEN a listen event is inserted, THE Listen_Event_Writer SHALL set `was_skipped = true` if `listened_pct < 0.10`, and `was_skipped = false` if `listened_pct >= 0.10`.
4. IF `listened_pct` is null or outside the range [0.0, 1.0] at the time of insert, THEN THE Listen_Event_Writer SHALL discard the event, write no row to `listen_events`, and log an error.
5. IF the database INSERT for a listen event fails, THEN THE Listen_Event_Writer SHALL log the error including the `(user_id, track_id, listened_at)` and take no further action for that event. THE Polling_Engine SHALL NOT retry the insert to avoid double-counting on the next cycle.

---

### Requirement 6: Skip Detection

**User Story:** As a backend service, I want to query the last 2 listen events for a track after every new insert, so that I can detect when a track has been consistently skipped.

#### Acceptance Criteria

1. WHEN a listen event is successfully inserted, THE Skip_Detector SHALL query the 2 most-recent `listen_events` rows for that `(user_id, track_id, playlist_id)` triple, ordered by `listened_at` descending.
2. IF the query returns exactly 2 rows and all 2 have `was_skipped = true`, THEN THE Skip_Detector SHALL emit a track-removal event for that `(user_id, track_id, playlist_id)` triple.
3. IF the query returns fewer than 2 rows, THEN THE Skip_Detector SHALL take no removal action for that insert.
4. IF fewer than 2 of the returned rows have `was_skipped = true`, THEN THE Skip_Detector SHALL take no removal action.
5. IF the `listen_events` query fails, THEN THE Skip_Detector SHALL log an error containing the `(user_id, track_id, playlist_id)` triple and take no removal action.
6. IF emitting the track-removal event fails, THEN THE Skip_Detector SHALL log an error and leave all `listen_events` rows unchanged.

---

### Requirement 7: Track Removal

**User Story:** As a backend service, I want to remove a consistently-skipped track from its playlist and log the action, so that the user's playlist is cleaned automatically.

#### Acceptance Criteria

1. WHEN skip detection triggers removal, THE Track_Remover SHALL issue a removal request to Spotify for the specific track URI and playlist ID derived from the triggering listen event.
2. WHEN the Spotify removal call succeeds, THE Track_Remover SHALL write a log entry to `removal_log` recording the user, the removed track, the playlist, the track name, the UTC timestamp of removal, and a reason string referencing the skip threshold count (e.g., "skipped 2/2 recent listens").
3. IF the Spotify removal call returns a non-success response, THEN THE Track_Remover SHALL write an error record to the application log and skip writing to `removal_log`.
4. IF writing the `removal_log` entry fails after a successful Spotify removal, THEN THE Track_Remover SHALL write an error record to the application log noting the inconsistency.
5. IF the triggering listen event does not carry a valid `playlist_id`, THEN THE Track_Remover SHALL take no removal action and log an error.

---

### Requirement 8: Poll Cycle Completion

**User Story:** As a backend service, I want to update `last_poll_at` at the end of every cycle, so that the next cycle's reconciliation window is correctly bounded.

#### Acceptance Criteria

1. WHEN a Poll_Cycle completes all processing steps without any step raising an unhandled exception, THE Polling_Engine SHALL update `last_poll_at` on the `users` row to the cycle-start timestamp recorded at the beginning of the cycle.
2. THE Polling_Engine SHALL record the cycle-start timestamp before making any Spotify API calls so that `last_poll_at` reflects when the window opened, not when it closed.
3. IF any processing step within the Poll_Cycle raises an error after `last_poll_at` would have advanced (i.e., after at least one Spotify API call has completed), THEN THE Polling_Engine SHALL still update `last_poll_at` to the cycle-start timestamp before exiting the cycle. This prevents the recently-played window from growing unboundedly and re-processing the same events on the next cycle, accepting the tradeoff that some events in the current cycle may not be persisted.

---

### Requirement 9: Playlist Context Enforcement

**User Story:** As a backend service, I want to ignore events that did not originate from a Spotify playlist, so that only playlist tracks are subject to removal.

#### Acceptance Criteria

1. THE Reconciler SHALL only process recently-played tracks whose `context.uri` begins with the string `"spotify:playlist:"`.
2. WHEN `currently-playing` returns a track whose `context.uri` begins with `"spotify:playlist:"`, THE Live_Track_Tracker SHALL process that track normally.
3. IF `currently-playing` returns a track whose `context.uri` is null or does not begin with `"spotify:playlist:"`, THEN THE Live_Track_Tracker SHALL discard the track event and take no action.
4. IF a track's context is null or begins with a prefix other than `"spotify:playlist:"` (e.g., `"spotify:album:"`, `"spotify:artist:"`), THEN THE Reconciler and THE Live_Track_Tracker SHALL each discard the track event and take no further action.
5. WHEN a user switches from a playlist context to a non-playlist context mid-track while a live event is open, THE Live_Track_Tracker SHALL close the open live event using the last-recorded `max_progress_ms` and emit a listen event before discarding the new non-playlist track.
6. IF the playlist_id extracted from `context.uri` corresponds to a Spotify-owned playlist (detectable because the Spotify DELETE call returns a 403 Forbidden response), THEN THE Track_Remover SHALL log the error, skip writing to `removal_log`, and take no further action. THE Polling_Engine SHALL continue tracking listen events for that playlist but SHALL NOT attempt removal again for that `playlist_id`.

---

### Requirement 10: Spotify API Rate Limit Handling

**User Story:** As a backend service, I want to respect Spotify's rate-limit responses, so that polling does not result in the user's API access being blocked.

#### Acceptance Criteria

1. WHEN a Spotify API call returns an HTTP 429 response, THE Spotify_Client SHALL read the `Retry-After` header value (in seconds).
2. WHEN a 429 response is received, THE Spotify_Client SHALL pause all API calls for that user for the number of seconds specified in `Retry-After` (capped at 60 seconds) before retrying, up to a maximum of 3 retry attempts.
3. IF the `Retry-After` header is absent on a 429 response, THEN THE Spotify_Client SHALL pause for 30 seconds before the next attempt.
4. IF all 3 retry attempts are exhausted without a successful response, THEN THE Spotify_Client SHALL log an error for that user and skip the remainder of the current Poll_Cycle.

---

### Requirement 11: Re-Added Song History Isolation

**User Story:** As a backend service, I want to treat a re-added track as starting fresh, so that old skip history doesn't immediately trigger removal of a song the user consciously put back.

#### Acceptance Criteria

1. WHEN THE Skip_Detector queries the last 2 `listen_events` for a `(user_id, track_id, playlist_id)` triple, THE Skip_Detector SHALL check whether a row exists in `removal_log` for that same `(user_id, track_id, playlist_id)` triple.
2. IF a `removal_log` row exists for that `(user_id, track_id, playlist_id)` triple, THEN THE Skip_Detector SHALL exclude any `listen_events` rows whose `listened_at` timestamp is earlier than or equal to the `removed_at` timestamp of the most-recent such `removal_log` row when selecting the 2 rows to evaluate. If multiple `removal_log` rows exist for the same triple (i.e., the track was removed and re-added more than once), the most-recent `removed_at` timestamp SHALL be used as the cutoff.
3. IF fewer than 2 `listen_events` rows remain after applying the `removal_log` cutoff filter, THEN THE Skip_Detector SHALL take no removal action for that insert.
4. IF no `removal_log` row exists for that `(user_id, track_id, playlist_id)` triple, THEN THE Skip_Detector SHALL apply no cutoff filter and evaluate the 2 most-recent `listen_events` rows as normal.

---

### Requirement 12: Revoked App Permissions Handling

**User Story:** As a backend service, I want to detect when a user has revoked my app's Spotify permissions, so that I stop polling them and don't log spurious errors.

#### Acceptance Criteria

1. WHEN a Spotify API call returns an HTTP 401 response with an error body indicating the token is invalid (e.g., `"No token provided"` or `"Invalid access token"`), THE Token_Refresher SHALL attempt to exchange the stored `refresh_token` for a new access token.
2. IF the token refresh call returns HTTP 401 or HTTP 400 with `error = "invalid_grant"`, THEN THE Polling_Engine SHALL treat this as a revoked-permissions signal.
3. WHEN a revoked-permissions signal is detected, THE Polling_Engine SHALL set the user's `refresh_token` to null in the `users` table.
4. WHEN a revoked-permissions signal is detected, THE Polling_Engine SHALL stop the polling interval for that user.
5. WHEN a revoked-permissions signal is detected, THE Polling_Engine SHALL write a log entry indicating that the user has revoked application permissions, including the user identifier.

---

### Requirement 13: Inactive User Polling Optimization

**User Story:** As a backend service, I want to reduce polling frequency for users who haven't been actively listening, so that I don't waste API calls on idle accounts.

#### Acceptance Criteria

1. WHEN a user's last 5 consecutive Poll_Cycles all return 204 No Content from `currently-playing`, THE Polling_Engine SHALL switch that user to Reduced_Interval_Mode with a polling interval of 60 seconds.
2. WHEN `currently-playing` returns an active track for a user currently in Reduced_Interval_Mode, THE Polling_Engine SHALL immediately restore the normal polling interval (10–20 seconds) for that user and exit Reduced_Interval_Mode.
3. THE Polling_Engine SHALL track the consecutive 204 count per user in memory and reset it to 0 whenever `currently-playing` returns a non-204 response for that user.
4. IF the Polling_Engine restarts, THE Polling_Engine SHALL initialise all users in normal interval mode regardless of prior Reduced_Interval_Mode state.
