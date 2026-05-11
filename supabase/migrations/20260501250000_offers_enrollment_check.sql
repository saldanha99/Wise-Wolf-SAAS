-- ============================================================================
-- Migration: Offers Enrollment Check (Invariant E.8 & E.9)
-- Add explicit columns to offers table for enrollment fee enforcement
-- ============================================================================

BEGIN;

-- 1. Add columns with defaults (using 0 and false as default initially to avoid errors with existing rows)
ALTER TABLE public.offers
ADD COLUMN IF NOT EXISTS requires_enrollment BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS enrollment_fee NUMERIC(10,2) NOT NULL DEFAULT 0;

-- 2. Populate columns for existing data based on payload
UPDATE public.offers
SET
    -- requires_enrollment is true if planDuration is NOT 0 (0 = avulso)
    requires_enrollment = COALESCE((payload->>'planDuration')::INTEGER, 1) <> 0,
    -- enrollment_fee is directly taken from payload.enrollmentFee (0 if false)
    enrollment_fee = COALESCE((payload->>'enrollmentFee')::NUMERIC, 0)
WHERE kind = 'ENROLLMENT';

-- 3. Apply the CHECK constraint ensuring the invariant holds:
-- (requires_enrollment = false AND enrollment_fee = 0) OR (requires_enrollment = true)
ALTER TABLE public.offers
ADD CONSTRAINT offers_enrollment_check
CHECK (
    (requires_enrollment = false AND enrollment_fee = 0) OR
    (requires_enrollment = true)
);

-- 4. Update the validate_offer RPC to return the new fields
CREATE OR REPLACE FUNCTION public.validate_offer(p_offer_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_offer RECORD;
BEGIN
    SELECT * INTO v_offer FROM public.offers WHERE id = p_offer_id;

    IF v_offer IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'OFFER_NOT_FOUND');
    END IF;

    IF v_offer.revoked_at IS NOT NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'OFFER_REVOKED');
    END IF;

    IF v_offer.expires_at < now() THEN
        RETURN jsonb_build_object('valid', false, 'error', 'OFFER_EXPIRED');
    END IF;

    -- Track usage
    UPDATE public.offers
    SET usage_count = usage_count + 1, last_used_at = now()
    WHERE id = p_offer_id;

    RETURN jsonb_build_object(
        'valid', true,
        'offer_id', v_offer.id,
        'kind', v_offer.kind,
        'payload', v_offer.payload,
        'tenant_id', v_offer.tenant_id,
        'requires_enrollment', v_offer.requires_enrollment,
        'enrollment_fee', v_offer.enrollment_fee,
        'consumed_at', v_offer.consumed_at
    );
END;
$$;

COMMIT;
