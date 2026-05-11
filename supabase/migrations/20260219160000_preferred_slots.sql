-- Migration: Add preferred_slots column to opportunities
-- Description: Allows storing weekly schedule preferences for a lead
-- Format: [{"weekday": "monday", "time": "19:00"}, ...]

ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS preferred_slots JSONB DEFAULT NULL;
