-- ============================================================================
-- Migration: Fix Consumed Tokens Schema (PR3 Alignment)
-- Description: Renames columns and adds metadata to align with claim_with_token logic.
-- Date: 2026-05-11
-- ============================================================================

BEGIN;

-- 1. Rename jti to token_hash if it exists (broadcast_hardening used jti)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'consumed_tokens' AND column_name = 'jti'
    ) THEN
        ALTER TABLE public.consumed_tokens RENAME COLUMN jti TO token_hash;
    END IF;
END $$;

-- 2. Add metadata column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'consumed_tokens' AND column_name = 'metadata'
    ) THEN
        ALTER TABLE public.consumed_tokens ADD COLUMN metadata JSONB DEFAULT '{}'::jsonb;
    END IF;
END $$;

-- 3. Make opp_id optional (since pr3 uses metadata->'opportunity_id' or we might want to store both)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'consumed_tokens' AND column_name = 'opp_id'
    ) THEN
        ALTER TABLE public.consumed_tokens ALTER COLUMN opp_id DROP NOT NULL;
    END IF;
END $$;

-- 4. Re-grant permissions just in case
GRANT ALL ON public.consumed_tokens TO service_role;
GRANT ALL ON public.consumed_tokens TO authenticated;

COMMIT;
