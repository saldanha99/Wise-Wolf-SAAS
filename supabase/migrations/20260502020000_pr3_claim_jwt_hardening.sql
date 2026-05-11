-- ============================================================================
-- PR3: Claim JWT Hardening + Security Event Logging
-- consumed_tokens enforcement, legacy link tracking, token-based claims
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. RPC: log_security_event — Generic security audit logging
--    Used to track legacy link usage, suspicious activity, etc.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_security_event(
    p_event_type    TEXT,
    p_entity_type   TEXT DEFAULT NULL,
    p_entity_id     TEXT DEFAULT NULL,
    p_metadata      JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.security_events (
        event_type,
        severity,
        source,
        tenant_id,
        actor_id,
        details
    ) VALUES (
        p_event_type,
        CASE
            WHEN p_event_type IN ('LEGACY_LINK_USED', 'TOKEN_CONSUMED') THEN 'LOW'
            WHEN p_event_type IN ('CLAIM_FAILED', 'TOKEN_REUSE') THEN 'MEDIUM'
            WHEN p_event_type IN ('TOKEN_FORGED', 'RLS_BYPASS_ATTEMPT') THEN 'HIGH'
            ELSE 'INFO'
        END,
        'SYSTEM',
        (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()),
        auth.uid(),
        p_metadata || jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_security_event(TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RPC: claim_with_token — Atomic claim that also consumes the JWT token
--    Wraps existing claim_opportunity with consumed_tokens check.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_with_token(
    p_opp_id        UUID,
    p_teacher_id    UUID,
    p_token_hash    TEXT DEFAULT NULL  -- SHA256 hash of the JWT token
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_claim_result JSONB;
    v_consumed BOOLEAN := false;
BEGIN
    -- 1. If token hash provided, check consumed_tokens
    IF p_token_hash IS NOT NULL THEN
        -- Check if this token was already used
        SELECT EXISTS (
            SELECT 1 FROM public.consumed_tokens
            WHERE token_hash = p_token_hash
        ) INTO v_consumed;

        IF v_consumed THEN
            -- Log token reuse attempt
            INSERT INTO public.security_events (
                event_type, severity, actor_id, source, details
            ) VALUES (
                'TOKEN_REUSE', 'MEDIUM', p_teacher_id, 'SYSTEM',
                jsonb_build_object('entity_type', 'opportunity', 'entity_id', p_opp_id::text, 'token_hash_prefix', left(p_token_hash, 8))
            );

            RETURN jsonb_build_object(
                'success', false,
                'error', 'TOKEN_ALREADY_CONSUMED',
                'message', 'Este link já foi utilizado.'
            );
        END IF;
    END IF;

    -- 2. Execute the atomic claim
    SELECT public.claim_opportunity(p_opp_id, p_teacher_id) INTO v_claim_result;

    -- 3. If claim succeeded and token hash provided, consume the token
    IF (v_claim_result->>'success')::boolean AND p_token_hash IS NOT NULL THEN
        INSERT INTO public.consumed_tokens (token_hash, consumed_by, metadata)
        VALUES (p_token_hash, p_teacher_id, jsonb_build_object(
            'opportunity_id', p_opp_id,
            'consumed_at', now()
        ))
        ON CONFLICT (token_hash) DO NOTHING;
    END IF;

    RETURN v_claim_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_with_token TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. LEGACY LINK DEPRECATION VIEW
--    Tracks how many legacy links are still being used.
--    Helps determine when to disable legacy support.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_legacy_link_usage AS
SELECT
    DATE(created_at) AS usage_date,
    COUNT(*) AS legacy_count,
    COUNT(*) FILTER (WHERE details->>'source' = 'claim-opportunity') AS claim_links,
    COUNT(*) FILTER (WHERE details->>'source' = 'enrollment') AS enrollment_links
FROM public.security_events
WHERE event_type = 'LEGACY_LINK_USED'
GROUP BY DATE(created_at)
ORDER BY usage_date DESC;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION
-- ============================================================================
-- DROP VIEW IF EXISTS public.v_legacy_link_usage;
-- DROP FUNCTION IF EXISTS public.claim_with_token CASCADE;
-- DROP FUNCTION IF EXISTS public.log_security_event CASCADE;
