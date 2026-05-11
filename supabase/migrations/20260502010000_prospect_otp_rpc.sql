-- ============================================================================
-- Migration: Prospect OTP RPCs (PR7)
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- RPC: request_prospect_otp
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_prospect_otp(
    p_full_name TEXT,
    p_email TEXT,
    p_phone TEXT,
    p_tenant_id TEXT,
    p_referrer_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prospect_id UUID;
    v_otp_code TEXT;
    v_otp_hash TEXT;
BEGIN
    -- 1. Upsert Prospect
    INSERT INTO public.prospects (tenant_id, referrer_code, full_name, email, phone, status)
    VALUES (p_tenant_id, p_referrer_code, p_full_name, p_email, p_phone, 'PENDING_VERIFICATION')
    ON CONFLICT (phone, tenant_id) WHERE status NOT IN ('EXPIRED', 'CANCELLED')
    DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        referrer_code = COALESCE(EXCLUDED.referrer_code, prospects.referrer_code),
        updated_at = now()
    RETURNING id INTO v_prospect_id;

    -- 2. Generate 6-digit OTP
    v_otp_code := lpad(floor(random() * 1000000)::text, 6, '0');
    v_otp_hash := encode(digest(v_otp_code, 'sha256'), 'hex');

    -- 3. Insert OTP Token
    INSERT INTO public.otp_tokens (target_type, target_id, channel, destination, code_hash)
    VALUES ('PROSPECT_VERIFY', v_prospect_id, 'whatsapp', p_phone, v_otp_hash);

    -- 4. Insert into outbox_messages to trigger WhatsApp sender (via process-outbox edge function)
    INSERT INTO public.outbox_messages (event_type, payload)
    VALUES (
        'OTP_REQUESTED',
        jsonb_build_object(
            'phone', p_phone,
            'code', v_otp_code,
            'name', p_full_name,
            'tenant_id', p_tenant_id
        )
    );

    RETURN jsonb_build_object('success', true, 'prospect_id', v_prospect_id);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- RPC: verify_prospect_otp
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_prospect_otp(
    p_prospect_id UUID,
    p_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_token RECORD;
    v_code_hash TEXT;
BEGIN
    v_code_hash := encode(digest(p_code, 'sha256'), 'hex');

    SELECT * INTO v_token
    FROM public.otp_tokens
    WHERE target_id = p_prospect_id
      AND target_type = 'PROSPECT_VERIFY'
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_token IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'TOKEN_NOT_FOUND');
    END IF;

    IF v_token.verified_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'ALREADY_VERIFIED');
    END IF;

    IF v_token.expires_at < now() THEN
        RETURN jsonb_build_object('success', false, 'error', 'TOKEN_EXPIRED');
    END IF;

    IF v_token.attempts >= v_token.max_attempts THEN
        RETURN jsonb_build_object('success', false, 'error', 'MAX_ATTEMPTS_REACHED');
    END IF;

    IF v_token.code_hash != v_code_hash THEN
        UPDATE public.otp_tokens SET attempts = attempts + 1 WHERE id = v_token.id;
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_CODE');
    END IF;

    -- Success! Mark verified.
    UPDATE public.otp_tokens SET verified_at = now() WHERE id = v_token.id;
    UPDATE public.prospects SET verified_at = now(), status = 'VERIFIED' WHERE id = p_prospect_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

COMMIT;
