# Bugfix Requirements Document

## Introduction

The background polling engine auto-removes consistently-skipped tracks from a user's playlists by calling Spotify's `DELETE /playlists/{id}/tracks` endpoint. When that call returns HTTP 403, the backend currently misinterprets the response and permanently blocklists the playlist in memory.

In production, a playlist that the user **owns** and that is **public** (and therefore fully editable) returns 403, and the backend logs:

```
[poller] removeTrack: 403 FORBIDDEN_PLAYLIST for playlist 44mvOQyxuqicfjBpwIQYcb — blocklisting
```

The playlist is then added to the in-memory `forbiddenPlaylists` Set and is never retried for the lifetime of the process.

This is effectively two related defects:

1. **403 misclassification** — Spotify returns a generic `"Forbidden"` message body when the stored access token lacks `playlist-modify-public` / `playlist-modify-private` scope (a token issued before those scopes were added, combined with `show_dialog: 'false'` so re-consent was never forced). `removeTrackFromPlaylist()` in `src/lib/spotify.js` only maps a 403 to `MISSING_SCOPE` when the message matches `/insufficient client scope/i`; every other 403 — including the generic `"Forbidden"` caused by a missing scope — is classified as `FORBIDDEN_PLAYLIST`.
2. **Over-sticky blocklist** — `removeTrack()` in `src/lib/poller.js` reacts to `FORBIDDEN_PLAYLIST` by permanently adding the playlist to the in-memory `forbiddenPlaylists` Set, with no recovery path. A scope-related 403 should trigger re-authentication, not a permanent blocklist, and even a genuinely read-only playlist is currently blocklisted forever with no way to clear it.

The impact: editable, user-owned playlists silently stop being cleaned, and the only remediation today is restarting the backend process.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a track-removal attempt returns HTTP 403 whose response body carries Spotify's generic `"Forbidden"` message (the message returned when the access token lacks `playlist-modify-public` / `playlist-modify-private` scope) THEN the system classifies the error as `FORBIDDEN_PLAYLIST` because the message does not match `/insufficient client scope/i`.

1.2 WHEN `removeTrack()` receives a `FORBIDDEN_PLAYLIST` error for a user-owned, editable playlist THEN the system permanently adds the playlist to the in-memory `forbiddenPlaylists` Set and skips all future removal attempts for it.

1.3 WHEN a 403 is actually caused by a missing playlist-modify scope THEN the system silently blocklists the playlist instead of signalling that the user needs to re-authenticate.

1.4 WHEN a playlist has been added to the `forbiddenPlaylists` Set THEN the system offers no recovery path — the playlist stays blocklisted for the lifetime of the process even after the underlying cause is resolved (e.g. the user re-authenticates and obtains a token with the correct scope).

### Expected Behavior (Correct)

2.1 WHEN a track-removal attempt returns HTTP 403 caused by the access token missing `playlist-modify-public` / `playlist-modify-private` scope THEN the system SHALL classify it as a missing-scope condition (`MISSING_SCOPE`), not as `FORBIDDEN_PLAYLIST`.

2.2 WHEN a track-removal attempt fails because of a missing-scope 403 THEN the system SHALL NOT add the playlist to the `forbiddenPlaylists` Set.

2.3 WHEN a missing-scope 403 occurs THEN the system SHALL signal that the affected user needs to re-authenticate to grant playlist write permissions, rather than permanently disabling cleaning for an editable playlist.

2.4 WHEN a playlist is added to the `forbiddenPlaylists` Set because of a genuinely forbidden (Spotify-owned / read-only) playlist THEN the system SHALL provide a recovery path so the blocklist entry does not persist indefinitely with no way to clear it.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a track-removal attempt returns a 403 whose response body message matches `/insufficient client scope/i` THEN the system SHALL CONTINUE TO classify it as `MISSING_SCOPE`.

3.2 WHEN a track-removal attempt succeeds (2xx) THEN the system SHALL CONTINUE TO record the removal in `removal_log` and SHALL NOT blocklist the playlist.

3.3 WHEN a track-removal attempt returns a non-403 error (e.g. 404, 429 after retries, 5xx, network/timeout) THEN the system SHALL CONTINUE TO log the failure and skip the removal without blocklisting the playlist.

3.4 WHEN a playlist is genuinely forbidden because it is Spotify-owned or read-only (true `FORBIDDEN_PLAYLIST`) THEN the system SHALL CONTINUE TO avoid repeatedly attempting removal against it.

3.5 WHEN a playlist is already present in the `forbiddenPlaylists` Set THEN the system SHALL CONTINUE TO skip the Spotify removal call for that playlist while the entry is active.
