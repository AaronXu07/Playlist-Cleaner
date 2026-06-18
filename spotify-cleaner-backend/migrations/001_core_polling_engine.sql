-- =============================================================================
-- Migration: 001_core_polling_engine
-- Description: Creates listen_events and removal_log tables, and adds
--              last_poll_at to the users table.
--
-- HOW TO RUN:
--   1. Open your Supabase project dashboard.
--   2. Navigate to the SQL Editor (left sidebar).
--   3. Click "New query", paste the entire contents of this file, and click Run.
--   4. All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS),
--      so re-running is safe.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. listen_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listen_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id     TEXT        NOT NULL,          -- Spotify track ID (no "spotify:track:" prefix)
  playlist_id  TEXT        NOT NULL,          -- Spotify playlist ID
  listened_pct NUMERIC(5,4) NOT NULL,         -- 0.0000 – 1.0000
  was_skipped  BOOLEAN     NOT NULL,          -- true iff listened_pct < 0.25
  source       TEXT        NOT NULL           -- 'live' | 'recent' | 'delta'
                 CHECK (source IN ('live', 'recent', 'delta')),
  listened_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, track_id, listened_at)     -- deduplication key
);

CREATE INDEX IF NOT EXISTS listen_events_user_track_playlist_idx
  ON listen_events (user_id, track_id, playlist_id, listened_at DESC);


-- ---------------------------------------------------------------------------
-- 2. removal_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS removal_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    TEXT        NOT NULL,
  playlist_id TEXT        NOT NULL,
  track_name  TEXT        NOT NULL,
  removed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason      TEXT        NOT NULL            -- e.g. "skipped 2/2 recent listens"
);

CREATE INDEX IF NOT EXISTS removal_log_user_track_playlist_idx
  ON removal_log (user_id, track_id, playlist_id, removed_at DESC);


-- ---------------------------------------------------------------------------
-- 3. users — add last_poll_at if it doesn't already exist
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_poll_at TIMESTAMPTZ;


-- ---------------------------------------------------------------------------
-- 4. listen_events.source — repair the check constraint for existing tables
--
-- `CREATE TABLE IF NOT EXISTS` above is a no-op on a table that already
-- exists, so tables created before the 'delta' source value was introduced
-- still carry the old CHECK (source IN ('live','recent')) constraint and will
-- reject 'delta' inserts. Drop and recreate the constraint so re-running this
-- migration repairs those tables. Safe on fresh tables too (idempotent).
-- ---------------------------------------------------------------------------
ALTER TABLE listen_events
  DROP CONSTRAINT IF EXISTS listen_events_source_check;

ALTER TABLE listen_events
  ADD CONSTRAINT listen_events_source_check
  CHECK (source IN ('live', 'recent', 'delta'));
