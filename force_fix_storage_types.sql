-- FORCE FIX STORAGE TYPES
-- The user ID "wise-wolf-school" is not a UUID, but storage.objects.owner expects a UUID.
-- We must relax this constraint to allow text IDs.

BEGIN;

-- 1. Alter 'owner' column to TEXT
ALTER TABLE storage.objects ALTER COLUMN owner TYPE text;

-- 2. Alter 'owner_id' column to TEXT (if it exists and is used)
-- Note: triggers might still try to cast it, but let's fix the table definition first.
ALTER TABLE storage.objects ALTER COLUMN owner_id TYPE text;

COMMIT;
