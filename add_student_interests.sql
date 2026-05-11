ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS interests text[] DEFAULT ARRAY[]::text[];
