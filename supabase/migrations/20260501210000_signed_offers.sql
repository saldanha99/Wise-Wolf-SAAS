-- ============================================================================
-- Migration: Signed Offers (Item 2)
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. OFFERS TABLE — Server-side store for all link payloads
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.offers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            TEXT NOT NULL CHECK (kind IN ('ENROLLMENT', 'TEACHER_INVITE', 'COMMERCIAL_INVITE')),
    tenant_id       TEXT NOT NULL,
    payload         JSONB NOT NULL,                 -- The actual offer data (price, plan, etc.)
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,                     -- When the offer was used
    revoked_at      TIMESTAMPTZ,                     -- If manually revoked by admin
    revoked_by      UUID REFERENCES auth.users(id),
    created_by      UUID NOT NULL REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    usage_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at    TIMESTAMPTZ,
    prefill_token   TEXT,                            -- Optional tokenized PII
    metadata        JSONB DEFAULT '{}'::jsonb        -- Extra audit info
);

CREATE INDEX IF NOT EXISTS idx_offers_tenant ON public.offers (tenant_id);
CREATE INDEX IF NOT EXISTS idx_offers_kind ON public.offers (kind);
CREATE INDEX IF NOT EXISTS idx_offers_created_by ON public.offers (created_by);
CREATE INDEX IF NOT EXISTS idx_offers_expires ON public.offers (expires_at)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE public.offers IS
    'Server-side store for signed offer links. Payload stays here, only offer_id travels in URL via JWT.';

-- RLS
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

-- Admins and creators can read their own offers
DROP POLICY IF EXISTS "Creators read own offers" ON public.offers;
CREATE POLICY "Creators read own offers" ON public.offers
    FOR SELECT TO authenticated
    USING (created_by = auth.uid());

-- Service role can do everything (for Edge Functions)
DROP POLICY IF EXISTS "Service role full access" ON public.offers;
CREATE POLICY "Service role full access" ON public.offers
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. LEGACY OFFER USAGE TRACKING
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.legacy_offer_usage (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route       TEXT NOT NULL,           -- /matricula, /teacher-onboarding, etc.
    raw_param   TEXT NOT NULL,           -- The base64 param name (data, offer)
    decoded_ok  BOOLEAN NOT NULL,
    tenant_id   TEXT,
    ip_hash     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legacy_usage_route ON public.legacy_offer_usage (route, created_at DESC);

COMMENT ON TABLE public.legacy_offer_usage IS
    'Tracks legacy (Base64) link usage during migration window. Alerts when old links are still in circulation.';

ALTER TABLE public.legacy_offer_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON public.legacy_offer_usage;
CREATE POLICY "Service role only" ON public.legacy_offer_usage
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RPC: validate_offer — Validates JWT-derived offer_id
-- ────────────────────────────────────────────────────────────────────────────
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
        'consumed_at', v_offer.consumed_at
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RPC: consume_offer — Marks an offer as consumed (one-time use)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.consume_offer(p_offer_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_offer RECORD;
BEGIN
    UPDATE public.offers
    SET consumed_at = now()
    WHERE id = p_offer_id
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    RETURNING * INTO v_offer;

    IF v_offer IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'OFFER_UNAVAILABLE');
    END IF;

    RETURN jsonb_build_object('success', true, 'offer_id', v_offer.id);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT ALL ON public.offers TO service_role;
GRANT ALL ON public.legacy_offer_usage TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_offer TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.consume_offer TO authenticated, service_role, anon;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.consume_offer CASCADE;
-- DROP FUNCTION IF EXISTS public.validate_offer CASCADE;
-- DROP TABLE IF EXISTS public.legacy_offer_usage CASCADE;
-- DROP TABLE IF EXISTS public.offers CASCADE;
