-- Add display_name and avatar_url columns to the users table.
-- These are populated from the Spotify /v1/me response on auth/re-auth.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url   TEXT;
