-- ============================================================================
-- Migration: Affiliate / Referral System (Item 4)
-- "Indique e Ganhe" — Idempotent, reversible.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. TENANT REFERRAL SETTINGS (per-school config)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_referral_settings (
    tenant_id           TEXT PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
    enabled             BOOLEAN NOT NULL DEFAULT false,
    teacher_reward_brl  NUMERIC(10,2) NOT NULL DEFAULT 50.00,
    student_reward_brl  NUMERIC(10,2) NOT NULL DEFAULT 30.00,
    monthly_cap         INTEGER NOT NULL DEFAULT 10,       -- Max rewards per referrer per month
    min_payments        INTEGER NOT NULL DEFAULT 1,         -- Payments the referred must make before reward
    self_referral_block BOOLEAN NOT NULL DEFAULT true,
    cooldown_days       INTEGER NOT NULL DEFAULT 30,        -- Min days between rewards for same referrer
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          UUID REFERENCES auth.users(id)
);

ALTER TABLE public.tenant_referral_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage referral settings" ON public.tenant_referral_settings;
CREATE POLICY "Admins manage referral settings" ON public.tenant_referral_settings
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = tenant_referral_settings.tenant_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = tenant_referral_settings.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.tenant_referral_settings;
CREATE POLICY "Service role full access" ON public.tenant_referral_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. AFFILIATE CODES (Opaque, short codes for referral links)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,                       -- 8-char base32 (e.g. "WW2K7X3Q")
    owner_id    UUID NOT NULL REFERENCES auth.users(id),
    owner_type  TEXT NOT NULL CHECK (owner_type IN ('TEACHER', 'STUDENT')),
    tenant_id   TEXT NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT true,
    total_clicks    INTEGER NOT NULL DEFAULT 0,
    total_conversions INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_code ON public.affiliate_codes(code);
CREATE INDEX IF NOT EXISTS idx_affiliate_owner ON public.affiliate_codes(owner_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_tenant ON public.affiliate_codes(tenant_id);

ALTER TABLE public.affiliate_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners read own codes" ON public.affiliate_codes;
CREATE POLICY "Owners read own codes" ON public.affiliate_codes
    FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "Admins manage codes" ON public.affiliate_codes;
CREATE POLICY "Admins manage codes" ON public.affiliate_codes
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = affiliate_codes.tenant_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = affiliate_codes.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.affiliate_codes;
CREATE POLICY "Service role full access" ON public.affiliate_codes
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. AFFILIATE CLICKS (funnel tracking)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_clicks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_code  TEXT NOT NULL REFERENCES public.affiliate_codes(code),
    ip_hash         TEXT,                           -- SHA256 hash (NOT raw IP)
    user_agent_hash TEXT,
    referer_url     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aff_clicks_code ON public.affiliate_clicks(affiliate_code, created_at DESC);

ALTER TABLE public.affiliate_clicks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.affiliate_clicks;
CREATE POLICY "Service role full access" ON public.affiliate_clicks
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. AFFILIATE CONVERSIONS (completed referrals)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliate_conversions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_code_id   UUID NOT NULL REFERENCES public.affiliate_codes(id),
    referrer_id         UUID NOT NULL REFERENCES auth.users(id),
    referred_id         UUID NOT NULL REFERENCES auth.users(id),
    tenant_id           TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
                            CHECK (status IN ('PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'REWARD_RELEASED', 'REWARD_FAILED', 'BLOCKED_FRAUD')),
    reward_amount_brl   NUMERIC(10,2),
    payment_id          TEXT,                        -- Asaas payment ID that triggered reward
    reward_released_at  TIMESTAMPTZ,
    fraud_flags         JSONB DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Anti-fraud: same referred can't be counted twice
    UNIQUE (referred_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_aff_conv_referrer ON public.affiliate_conversions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_aff_conv_status ON public.affiliate_conversions(status);
CREATE INDEX IF NOT EXISTS idx_aff_conv_tenant ON public.affiliate_conversions(tenant_id);

ALTER TABLE public.affiliate_conversions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Referrers read own conversions" ON public.affiliate_conversions;
CREATE POLICY "Referrers read own conversions" ON public.affiliate_conversions
    FOR SELECT TO authenticated
    USING (referrer_id = auth.uid());

DROP POLICY IF EXISTS "Service role full access" ON public.affiliate_conversions;
CREATE POLICY "Service role full access" ON public.affiliate_conversions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. RPC: generate_affiliate_code — Creates a unique short code
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_affiliate_code(
    p_owner_id UUID,
    p_owner_type TEXT,
    p_tenant_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT;
    v_existing RECORD;
    v_attempts INTEGER := 0;
BEGIN
    -- Check if user already has an active code
    SELECT * INTO v_existing FROM public.affiliate_codes
    WHERE owner_id = p_owner_id AND tenant_id = p_tenant_id AND active = true;

    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'code', v_existing.code, 'existing', true);
    END IF;

    -- Generate unique 8-char code
    LOOP
        v_code := 'WW' || upper(substring(replace(encode(gen_random_bytes(6), 'base64'), '/', ''), 1, 6));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.affiliate_codes WHERE code = v_code);
        v_attempts := v_attempts + 1;
        IF v_attempts > 10 THEN
            RETURN jsonb_build_object('success', false, 'error', 'CODE_GENERATION_FAILED');
        END IF;
    END LOOP;

    INSERT INTO public.affiliate_codes (code, owner_id, owner_type, tenant_id)
    VALUES (v_code, p_owner_id, p_owner_type, p_tenant_id);

    RETURN jsonb_build_object('success', true, 'code', v_code, 'existing', false);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. RPC: release_affiliate_reward — Idempotent reward release
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_affiliate_reward(p_conversion_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conv RECORD;
    v_settings RECORD;
    v_referrer RECORD;
    v_monthly_count INTEGER;
    v_last_reward TIMESTAMPTZ;
    v_fraud_flags JSONB := '[]'::jsonb;
BEGIN
    -- 1. Lock and fetch conversion
    SELECT * INTO v_conv FROM public.affiliate_conversions
    WHERE id = p_conversion_id FOR UPDATE;

    IF v_conv IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'CONVERSION_NOT_FOUND');
    END IF;

    -- 2. Idempotency: already released
    IF v_conv.status = 'REWARD_RELEASED' THEN
        RETURN jsonb_build_object('success', true, 'already_released', true);
    END IF;

    -- 3. Only process confirmed payments
    IF v_conv.status != 'PAYMENT_CONFIRMED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'NOT_PAYMENT_CONFIRMED');
    END IF;

    -- 4. Fetch tenant settings
    SELECT * INTO v_settings FROM public.tenant_referral_settings
    WHERE tenant_id = v_conv.tenant_id;

    IF v_settings IS NULL OR NOT v_settings.enabled THEN
        RETURN jsonb_build_object('success', false, 'error', 'REFERRAL_DISABLED');
    END IF;

    -- 5. Anti-fraud: self-referral check
    IF v_settings.self_referral_block AND v_conv.referrer_id = v_conv.referred_id THEN
        UPDATE public.affiliate_conversions
        SET status = 'BLOCKED_FRAUD',
            fraud_flags = fraud_flags || '["SELF_REFERRAL"]'::jsonb
        WHERE id = p_conversion_id;
        RETURN jsonb_build_object('success', false, 'error', 'SELF_REFERRAL_BLOCKED');
    END IF;

    -- 6. Anti-fraud: monthly cap
    SELECT COUNT(*) INTO v_monthly_count
    FROM public.affiliate_conversions
    WHERE referrer_id = v_conv.referrer_id
      AND tenant_id = v_conv.tenant_id
      AND status = 'REWARD_RELEASED'
      AND reward_released_at >= date_trunc('month', now());

    IF v_monthly_count >= v_settings.monthly_cap THEN
        v_fraud_flags := v_fraud_flags || '["MONTHLY_CAP_EXCEEDED"]'::jsonb;
        UPDATE public.affiliate_conversions
        SET fraud_flags = v_fraud_flags
        WHERE id = p_conversion_id;
        RETURN jsonb_build_object('success', false, 'error', 'MONTHLY_CAP_EXCEEDED');
    END IF;

    -- 7. Anti-fraud: cooldown check
    SELECT MAX(reward_released_at) INTO v_last_reward
    FROM public.affiliate_conversions
    WHERE referrer_id = v_conv.referrer_id
      AND tenant_id = v_conv.tenant_id
      AND status = 'REWARD_RELEASED';

    IF v_last_reward IS NOT NULL AND
       v_last_reward > (now() - make_interval(days => v_settings.cooldown_days)) THEN
        v_fraud_flags := v_fraud_flags || '["COOLDOWN_ACTIVE"]'::jsonb;
        UPDATE public.affiliate_conversions SET fraud_flags = v_fraud_flags WHERE id = p_conversion_id;
        RETURN jsonb_build_object('success', false, 'error', 'COOLDOWN_ACTIVE');
    END IF;

    -- 8. Determine reward amount based on referrer type
    SELECT * INTO v_referrer FROM public.profiles WHERE id = v_conv.referrer_id;

    DECLARE
        v_reward NUMERIC(10,2);
    BEGIN
        IF v_referrer.role = 'TEACHER' THEN
            v_reward := v_settings.teacher_reward_brl;
        ELSE
            v_reward := v_settings.student_reward_brl;
        END IF;

        -- 9. Release reward
        UPDATE public.affiliate_conversions SET
            status = 'REWARD_RELEASED',
            reward_amount_brl = v_reward,
            reward_released_at = now(),
            fraud_flags = v_fraud_flags
        WHERE id = p_conversion_id;

        -- 10. Increment conversion counter
        UPDATE public.affiliate_codes
        SET total_conversions = total_conversions + 1
        WHERE id = v_conv.affiliate_code_id;

        RETURN jsonb_build_object(
            'success', true,
            'reward_amount', v_reward,
            'referrer_id', v_conv.referrer_id,
            'referrer_type', v_referrer.role
        );
    END;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT ALL ON public.tenant_referral_settings TO service_role;
GRANT ALL ON public.affiliate_codes TO service_role;
GRANT ALL ON public.affiliate_clicks TO service_role;
GRANT ALL ON public.affiliate_conversions TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_affiliate_code TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_affiliate_reward TO service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.release_affiliate_reward CASCADE;
-- DROP FUNCTION IF EXISTS public.generate_affiliate_code CASCADE;
-- DROP TABLE IF EXISTS public.affiliate_conversions CASCADE;
-- DROP TABLE IF EXISTS public.affiliate_clicks CASCADE;
-- DROP TABLE IF EXISTS public.affiliate_codes CASCADE;
-- DROP TABLE IF EXISTS public.tenant_referral_settings CASCADE;
