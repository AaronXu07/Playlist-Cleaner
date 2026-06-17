# Product: Spotify Playlist Cleaner

A web app that connects to a user's Spotify account, monitors listening behaviour in the background, and automatically removes songs from a playlist when those songs are consistently skipped or barely played.

## Core Behaviour
- Poll Spotify every 10–20 seconds per active user (server-side, persistent process)
- Use a hybrid polling strategy: combine `/me/player/currently-playing` (live progress) and `/me/player/recently-played` (catch missed/skipped tracks)
- A track is considered skipped if `listened_pct < 0.10` (less than 10% listened)
- Auto-remove a track from its playlist when the last 2 listen events for that track+user+playlist are all skips
- Log every removal; allow the user to undo removals

## Key Constraints
- Spotify does not provide historical playback data — all listen tracking must be computed by the backend from polling
- Ultra-fast skips (<30 seconds) will not appear in `recently-played` — this is an accepted platform limitation
- Only act on tracks played within a playlist context (`context.uri`); ignore liked songs, albums, and radio

## User-Configurable Settings
- Skip threshold percentage (default: <10%)
- Lookback window (default: last 3 listens)
- Optional: restrict cleaning to specific playlists
