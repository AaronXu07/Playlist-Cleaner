-- Add polling_enabled flag to users table.
-- Defaults to true so existing users keep polling after the migration.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS polling_enabled boolean NOT NULL DEFAULT true;
