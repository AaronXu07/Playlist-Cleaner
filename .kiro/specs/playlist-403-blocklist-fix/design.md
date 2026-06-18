# Playlist 403 Blocklist Fix — Bugfix Design

## Overview

The background poller auto-removes consistently-skipped tracks by calling Spotify's
`DELETE /playlists/{id}/tracks`. When that call returns HTTP 403, two compounding defects cause
editable, user-owned playlists to silently and permanently stop being cleaned:

1. **403 misclassification** (`removeTrackFromPlaylist` in `src/lib/spotify.js`): the only 403
   mapped to `MISSING_SCOPE` is one whose body message matches `/insufficient client scope/i`.
   In production Spotify returns a generic `"Forbidden"` body when the stored access token lacks
   `playlist-modify-public` / `playlist-modify-private` scope (a token minted before those scopes
   were added, combined with `show_dialog: 'false'` so re-consent was never forced). Because
   `"Forbidden"` does not match the regex, the error is classified as `FORBIDDEN_PLAYLIST`.

2. **Over-sticky blocklist** (`removeTrack` in `src/lib/poller.js`): a `FORBIDDEN_PLAYLIST` result
   permanently adds the playlist to the in-memory `forbiddenPlaylists` `Set` with no recovery path.
   The only remediation today is restarting the process.

The fix has three parts that map directly to the expected behavior:

- **Disambiguate the 403** by checking whether the authenticated user can actually edit the
  playlist (ownership / collaborative). A 403 on an *editable* playlist cannot be a read-only
  playlist; it must be a missing scope, so it is classified `MISSING_SCOPE`. A 403 on a
  *non-editable* playlist remains a genuine `FORBIDDEN_PLAYLIST`.
- **Signal re-authentication** for `MISSING_SCOPE` instead of blocklisting, so the user can be
  prompted to re-consent and obtain a token with write scope.
- **Add a TTL/recovery mechanism** to the blocklist so genuine `FORBIDDEN_PLAYLIST` entries expire
  and are eventually retried, and so re-authentication clears stale state.

The change is targeted and minimal: it does not alter the success path, the non-403 error path, the
existing `insufficient client scope` path, or skip-detection logic.

## Glossary

- **Bug_Condition (C)**: A `DELETE /playlists/{id}/tracks` call returns HTTP 403 whose body message
  does **not** match `/insufficient client scope/i`, **and** the authenticated user can actually
  edit the playlist (they own it or it is collaborative). This is the case currently misclassified
  as `FORBIDDEN_PLAYLIST` and permanently blocklisted.
- **Property (P)**: For an input satisfying C, the system classifies the error as `MISSING_SCOPE`,
  does **not** add the playlist to the blocklist, and signals that the user must re-authenticate.
- **Preservation**: All inputs where C does **not** hold (success, non-403 errors, genuine
  read-only/Spotify-owned 403, `insufficient client scope` 403, already-blocklisted playlists)
  behave exactly as before.
- **removeTrackFromPlaylist**: function in `src/lib/spotify.js` that issues the DELETE and maps the
  HTTP result to a return value (`true`) or a coded error (`MISSING_SCOPE` / `FORBIDDEN_PLAYLIST` /
  raw error).
- **removeTrack**: internal function in `src/lib/poller.js` that calls `removeTrackFromPlaylist`,
  reacts to the coded error, and writes `removal_log` on success.
- **forbiddenPlaylists**: in-memory structure in `src/lib/poller.js` recording playlists to skip.
  Currently a `Set<playlistId>`; this design changes it to a TTL-bearing structure.
- **Editable playlist**: a playlist whose `owner.id` equals the authenticated user's Spotify ID, or
  whose `collaborative` flag is `true`.
- **Re-auth signal**: a durable marker indicating a specific user needs to re-authenticate to grant
  playlist-modify scope (cleared when they successfully re-authenticate).
- **MISSING_SCOPE / FORBIDDEN_PLAYLIST**: the two `err.code` values produced by
  `removeTrackFromPlaylist` for a 403.

## Bug Details

### Bug Condition

The bug manifests when a track removal against an **editable** playlist returns HTTP 403 with the
generic `"Forbidden"` body that Spotify emits when the access token is missing
`playlist-modify-public` / `playlist-modify-private` scope. `removeTrackFromPlaylist` classifies
this as `FORBIDDEN_PLAYLIST` (because the message does not match `/insufficient client scope/i`),
and `removeTrack` then permanently blocklists the playlist.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type {
           httpStatus:     number,
           bodyMessage:    string,             // err.response.data.error.message
           playlistOwnerId:string,             // owner.id of the target playlist
           collaborative:  boolean,            // playlist.collaborative
           authUserId:     string              // authenticated user's Spotify ID
         }
  OUTPUT: boolean

  isEditable := (input.playlistOwnerId == input.authUserId) OR (input.collaborative == true)

  RETURN input.httpStatus == 403
         AND NOT matches(input.bodyMessage, /insufficient client scope/i)
         AND isEditable
END FUNCTION
```

Notes:
- When `isEditable` is `false` the 403 is a genuine `FORBIDDEN_PLAYLIST` (Spotify-owned, editorial,
  or another user's non-collaborative playlist) and is **not** a bug condition.
- When `bodyMessage` matches `/insufficient client scope/i` the existing code already classifies it
  as `MISSING_SCOPE`; that is **not** a bug condition (it is preserved behavior 3.1).

### Examples

- **Bug**: User owns public playlist `44mvOQyxuqicfjBpwIQYcb`. DELETE returns
  `403 { error: { status: 403, message: "Forbidden" } }` because the token predates the
  playlist-modify scopes. Expected: `MISSING_SCOPE` + re-auth signal, no blocklist. Actual:
  `FORBIDDEN_PLAYLIST` + permanent blocklist.
- **Bug**: User is a collaborator on a private collaborative playlist. DELETE returns generic
  `403 "Forbidden"` due to missing scope. Expected: `MISSING_SCOPE`. Actual: `FORBIDDEN_PLAYLIST`.
- **Not a bug (genuine forbidden)**: Track is being removed from a Spotify editorial playlist the
  user does not own and that is not collaborative. DELETE returns `403 "Forbidden"`. Expected and
  actual: `FORBIDDEN_PLAYLIST` (now subject to TTL recovery rather than permanent).
- **Not a bug (preserved)**: DELETE returns `403 { message: "Insufficient client scope" }`.
  Expected and actual: `MISSING_SCOPE`.
- **Edge case**: Playlist ownership cannot be determined (the lookup itself errors or the playlist
  is not found). The fix must fail safe — see Fix Implementation for the chosen default.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- A 403 whose body message matches `/insufficient client scope/i` continues to be classified as
  `MISSING_SCOPE` (Req 3.1).
- A successful (2xx) removal continues to write a `removal_log` row and never blocklists the
  playlist (Req 3.2).
- A non-403 error (404, 429 after retries exhausted, 5xx, network/timeout) continues to be logged
  and skipped without blocklisting (Req 3.3).
- A genuinely forbidden playlist (Spotify-owned / read-only / not editable) continues to be
  treated as `FORBIDDEN_PLAYLIST` and is not repeatedly retried while its blocklist entry is active
  (Req 3.4).
- A playlist already present in the blocklist (with an active, non-expired entry) continues to have
  its Spotify removal call skipped (Req 3.5).

**Scope:**
All inputs that do NOT satisfy the bug condition must be completely unaffected by this fix. This
includes:
- Successful removals (2xx).
- Non-403 errors of every kind.
- 403 responses with the `insufficient client scope` message.
- 403 responses on non-editable playlists (genuine `FORBIDDEN_PLAYLIST`).
- Skip-detection, listen-event writing, token refresh, and poll-cycle scheduling logic.

**Note:** the desired *correct* behavior for the bug condition is defined in the Correctness
Properties section (Property 1). This section enumerates what must NOT change.

## Hypothesized Root Cause

1. **Message-only classification of 403**: `removeTrackFromPlaylist` decides `MISSING_SCOPE` vs
   `FORBIDDEN_PLAYLIST` purely from the response body message. Spotify returns the same generic
   `"Forbidden"` message for both a read-only playlist and a missing-scope token, so message text
   alone is insufficient to disambiguate. This is the primary cause of the misclassification.

2. **No write-capability / ownership check**: the function never consults whether the user can
   actually edit the playlist, which is the only reliable signal that distinguishes "token can't
   write anywhere" (scope) from "this specific playlist is read-only" (forbidden).

3. **Stale token scope from auth flow**: `src/routes/auth.js` requests the correct scopes today,
   but `show_dialog: 'false'` means users who authorized before the playlist-modify scopes were
   added are never forced to re-consent, so their stored tokens silently lack write scope. The fix
   must therefore surface a re-auth signal rather than assume the token is fine.

4. **Permanent, process-lifetime blocklist**: `forbiddenPlaylists` is a `Set` with add-only
   semantics and no expiry, so even a correctly-identified `FORBIDDEN_PLAYLIST` (or a stale entry
   from before a re-auth) is never reconsidered.

## Correctness Properties

Property 1: Bug Condition — Editable-playlist 403 is treated as missing scope, not blocklisted

_For any_ input where the bug condition holds (`isBugCondition` returns true: a 403 whose message is
not `insufficient client scope` on a playlist the authenticated user can edit), the fixed code SHALL
classify the error as `MISSING_SCOPE`, SHALL NOT add the playlist to the blocklist, and SHALL record
a durable re-auth signal for the affected user.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — Non-bug 403s and all other outcomes are unchanged

_For any_ input where the bug condition does NOT hold (successful removals, non-403 errors,
`insufficient client scope` 403s, genuine non-editable `FORBIDDEN_PLAYLIST` 403s, and
already-blocklisted playlists with an active entry), the fixed code SHALL produce the same
observable outcome as the original code — same classification, same `removal_log` write behavior,
same skip of the Spotify call for active blocklist entries — preserving all existing behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

Property 3: Recovery — Blocklist entries are not permanent

_For any_ playlist added to the blocklist as a genuine `FORBIDDEN_PLAYLIST`, the fixed code SHALL
provide a recovery path: the entry SHALL be skipped only while it is active (within its TTL) and
SHALL become eligible for retry once it expires, and a successful user re-authentication SHALL clear
both the re-auth signal and any blocklist state for that user's playlists.

**Validates: Requirements 2.4**

## Fix Implementation

### Changes Required

Assuming the root cause analysis is correct, the fix spans three files.

**File**: `src/lib/spotify.js`

**Function**: `removeTrackFromPlaylist(accessToken, playlistId, trackUri, authUserId)`

1. **Add an `authUserId` parameter**: the authenticated user's Spotify ID, threaded down from the
   poll cycle, used to decide editability. (Keep it optional/last so existing call shapes degrade
   gracefully; when absent, fall back to the fail-safe default below.)

2. **Preserve the `insufficient client scope` short-circuit**: if the 403 body message matches
   `/insufficient client scope/i`, throw `MISSING_SCOPE` exactly as today (Req 3.1) — no playlist
   lookup needed.

3. **Add a write-capability probe for generic 403s**: when a 403 has a non-matching message, issue
   `GET /playlists/{playlistId}?fields=owner(id),collaborative` (reusing the existing
   rate-limit-aware GET helper) and compute
   `isEditable = (owner.id === authUserId) || (collaborative === true)`.
   - If `isEditable` is `true` → throw `MISSING_SCOPE` (the playlist is writable, so a 403 means the
     token lacks scope).
   - If `isEditable` is `false` → throw `FORBIDDEN_PLAYLIST` (genuine read-only / not owned).

4. **Fail safe on probe failure (edge case)**: if the editability lookup itself fails (network,
   404, or `authUserId` unavailable), default to `MISSING_SCOPE` rather than `FORBIDDEN_PLAYLIST`.
   Rationale: `MISSING_SCOPE` is non-destructive (it does not permanently disable cleaning and is
   self-correcting via re-auth), whereas a wrong `FORBIDDEN_PLAYLIST` is exactly the defect we are
   fixing. Log the probe failure for observability.

**File**: `src/lib/poller.js`

5. **Convert `forbiddenPlaylists` to a TTL map**: replace the `Set<playlistId>` with a
   `Map<playlistId, expiresAtEpochMs>` (exported), plus small helpers:
   - `isPlaylistBlocked(playlistId)`: returns `true` only if an entry exists and
     `Date.now() < expiresAt`; if the entry exists but is expired, delete it and return `false`
     (lazy eviction → recovery path, Req 2.4).
   - `blockPlaylist(playlistId)`: sets `expiresAt = Date.now() + BLOCKLIST_TTL_MS`
     (proposed default: 6 hours).
   The exported name stays `forbiddenPlaylists` so other modules/tests can introspect it; the value
   type changes from `Set` to `Map`.

6. **Add a re-auth signal store**: add an exported `usersNeedingReauth` `Set<userId>` (in-memory,
   consistent with the existing in-memory poller state). On `MISSING_SCOPE`, `removeTrack` adds the
   user to this set and logs that they must re-authenticate (Req 2.3). This is the durable signal an
   API/UI layer can read to prompt re-consent. (A DB column is a viable alternative but would
   require a migration; in-memory matches current architecture and the existing
   `userState`/`forbiddenPlaylists` pattern.)

7. **Update `removeTrack` 403 handling**:
   - Thread `authUserId` into `removeTrackFromPlaylist` (see runPollCycle change).
   - Replace the blocklist check `forbiddenPlaylists.has(playlistId)` with `isPlaylistBlocked(...)`.
   - On `FORBIDDEN_PLAYLIST`: call `blockPlaylist(playlistId)` (now TTL-bearing) and log — genuine
     read-only handling preserved (Req 3.4, 3.5) but now recoverable (Req 2.4).
   - On `MISSING_SCOPE`: do **not** blocklist; add `userId` to `usersNeedingReauth` and log the
     re-auth requirement (Req 2.2, 2.3). (This branch already exists for the
     `insufficient client scope` case; it now also receives editable-playlist 403s.)
   - Non-403 errors and the success path remain untouched (Req 3.2, 3.3).

8. **Thread `authUserId` through the call chain**: `runPollCycle` already loads the user row; add
   `spotify_id` to its `select(...)` and pass it down through `detectSkip → removeTrack →
   removeTrackFromPlaylist`. On a successful re-auth, `registerUser` (called from the auth callback)
   SHALL clear the user from `usersNeedingReauth` and drop their blocklist entries, completing the
   recovery path (Req 2.4).

**File**: `src/routes/auth.js`

9. **Force re-consent when needed**: keep the requested `SCOPES` as-is (already correct). Document
   that `show_dialog` must be set to `'true'` for the re-auth flow (or that re-auth is triggered for
   users present in `usersNeedingReauth`) so a user with a stale, scope-less token is actually
   re-prompted and a new token with write scope is minted. No scope list change is required — the
   defect is stale tokens, not a missing scope in the auth request.

## Testing Strategy

### Validation Approach

Two phases: first surface counterexamples that demonstrate the bug on the unfixed code (confirming
the root cause — message-only classification plus permanent blocklist), then verify the fix
classifies editable-playlist 403s as `MISSING_SCOPE`, signals re-auth, and preserves every non-bug
outcome. Tests follow the existing Vitest + fast-check + `vi.mock('axios')` patterns already used in
`spotify.test.js` and `poller.test.js`.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix, and confirm
or refute the root-cause hypotheses (message-only 403 classification; permanent blocklist). If
refuted, re-hypothesize.

**Test Plan**: Mock `axios.delete` to reject with a `403 { error: { message: "Forbidden" } }` and
mock the playlist lookup so the playlist is owned by the authenticated user. Run against the UNFIXED
`removeTrackFromPlaylist` and assert the thrown `err.code`. Separately, drive `removeTrack` with a
`FORBIDDEN_PLAYLIST` error and assert the playlist is added to the blocklist with no expiry.

**Test Cases**:
1. **Generic-Forbidden on owned playlist** — DELETE → `403 "Forbidden"`, playlist `owner.id ==
   authUserId`. Assert `err.code === 'MISSING_SCOPE'` (will fail on unfixed code: it is
   `FORBIDDEN_PLAYLIST`).
2. **Generic-Forbidden on collaborative playlist** — DELETE → `403 "Forbidden"`,
   `collaborative === true`, different owner. Assert `MISSING_SCOPE` (will fail on unfixed code).
3. **Permanent blocklist has no recovery** — add a playlist via a `FORBIDDEN_PLAYLIST` result, then
   assert there is no mechanism for the entry to expire (will fail/again-block on unfixed code:
   `Set` is add-only).
4. **No re-auth signal** — after a missing-scope 403, assert the user is recorded as needing re-auth
   (will fail on unfixed code: no such signal exists).

**Expected Counterexamples**:
- `removeTrackFromPlaylist` returns `FORBIDDEN_PLAYLIST` for an owned/collaborative playlist.
- `forbiddenPlaylists` retains the playlist permanently with no TTL and no re-auth signal.
- Confirms root causes #1 (message-only classification) and #4 (permanent blocklist).

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the
expected behavior (classify `MISSING_SCOPE`, no blocklist, re-auth signal recorded).

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := removeTrackFromPlaylist_fixed(input)        // throws MISSING_SCOPE
  ASSERT result.code == 'MISSING_SCOPE'
  ASSERT NOT isPlaylistBlocked(input.playlistId)
  ASSERT usersNeedingReauth.has(input.authUserId)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function
produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT removeTrackFromPlaylist_original(input) == removeTrackFromPlaylist_fixed(input)
  // and, in the poller, blocklist/removal_log side effects are identical
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation because it generates
many inputs across the domain (HTTP statuses, message strings, ownership/collaborative combinations,
blocklist states) and catches edge cases manual tests miss. Generators should cover: success (2xx),
non-403 errors (404/429/5xx/network), 403 with `insufficient client scope`, and 403 on
non-editable playlists.

**Test Plan**: Observe behavior on UNFIXED code for these non-bug inputs first, then write
property-based tests asserting identical classification and side effects after the fix.

**Test Cases**:
1. **Insufficient-client-scope 403** — observe `MISSING_SCOPE` on unfixed code; assert unchanged
   after fix (Req 3.1).
2. **Successful removal** — observe `removal_log` insert and no blocklist on unfixed code; assert
   unchanged after fix (Req 3.2).
3. **Non-403 errors (404/429-exhausted/5xx/network)** — observe log + skip + no blocklist; assert
   unchanged after fix (Req 3.3).
4. **Genuine forbidden (non-editable) 403** — observe `FORBIDDEN_PLAYLIST` + blocklisted; assert
   still `FORBIDDEN_PLAYLIST` and skipped while the entry is active after fix (Req 3.4, 3.5).

### Unit Tests

- `removeTrackFromPlaylist`: 403 generic message + owned playlist → `MISSING_SCOPE`; 403 generic +
  collaborative → `MISSING_SCOPE`; 403 generic + non-editable → `FORBIDDEN_PLAYLIST`; 403
  `insufficient client scope` → `MISSING_SCOPE`; editability probe failure → fail-safe
  `MISSING_SCOPE`.
- `removeTrack`: `MISSING_SCOPE` → no blocklist, user added to `usersNeedingReauth`, no
  `removal_log`; `FORBIDDEN_PLAYLIST` → blocklisted with a future `expiresAt`, no `removal_log`.
- Blocklist helpers: `isPlaylistBlocked` returns `false` for expired entries and evicts them;
  `blockPlaylist` sets `expiresAt = now + TTL`.

### Property-Based Tests

- **Property 1 (fix)**: generate 403s on editable playlists (varied owner/collaborative combos and
  arbitrary non-`insufficient client scope` messages) → always `MISSING_SCOPE`, never blocklisted,
  re-auth signal set.
- **Property 2 (preservation)**: generate the full space of non-bug inputs → classification and
  side effects identical to the original implementation.
- **Property 3 (recovery)**: generate blocklist entries with varied insertion times → an entry is
  reported blocked iff `now < expiresAt`, and is evicted/retryable once expired; re-auth clears the
  user's blocklist + re-auth state.

### Integration Tests

- Full poll cycle for a user with a stale (scope-less) token whose owned playlist returns generic
  `403 "Forbidden"`: assert the playlist is NOT blocklisted, the user is flagged for re-auth, and
  cleaning resumes after a simulated re-auth (`registerUser`) clears the signal.
- Poll cycle against a genuine Spotify-owned playlist: assert it is blocklisted, skipped while the
  entry is active, and retried after the TTL elapses.
- Re-auth flow via `auth.js` callback → `registerUser` clears `usersNeedingReauth` and the user's
  blocklist entries.
