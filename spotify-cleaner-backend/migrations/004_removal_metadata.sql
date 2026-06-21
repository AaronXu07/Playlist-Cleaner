-- Store display metadata at removal time so GET /api/removals does not need
-- to call Spotify for every row on dashboard load.

ALTER TABLE removal_log
  ADD COLUMN IF NOT EXISTS artist_name TEXT;

ALTER TABLE removal_log
  ADD COLUMN IF NOT EXISTS album_art TEXT;

ALTER TABLE removal_log
  ADD COLUMN IF NOT EXISTS playlist_name TEXT;
