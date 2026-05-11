-- ============================================================================
-- Migration: Broadcast Hardening (Item 1)
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. IDEMPOTENCY KEYS (Prevent duplicate broadcasts)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    key         TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    result_id   UUID,              -- The opportunity_id that was created
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
    ON public.idempotency_keys (expires_at);

COMMENT ON TABLE public.idempotency_keys IS
    'Deduplication for broadcast-opportunity. Keys expire after 10 minutes.';

-- Cleanup function (called by pg_cron or on each insert)
CREATE OR REPLACE FUNCTION public.cleanup_expired_idempotency_keys()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    DELETE FROM public.idempotency_keys WHERE expires_at < now();
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. CONSUMED TOKENS (Prevent JWT claim token replay)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.consumed_tokens (
    jti         TEXT PRIMARY KEY,
    opp_id      UUID NOT NULL,
    consumed_by UUID REFERENCES auth.users(id),
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumed_tokens_opp
    ON public.consumed_tokens (opp_id);

COMMENT ON TABLE public.consumed_tokens IS
    'One-time-use JWT claim tokens (jti). Prevents replay attacks on claim links.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. OUTBOX MESSAGES (Transactional outbox for WhatsApp sends)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.outbox_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         TEXT NOT NULL DEFAULT 'whatsapp',
    destination     TEXT NOT NULL,          -- group JID or phone number
    payload         JSONB NOT NULL,         -- { instance, text, ... }
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','DLQ')),
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    correlation_id  UUID,                   -- Links to opportunity_id
    tenant_id       TEXT,
    actor_id        UUID,                   -- Who triggered this
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON public.outbox_messages (status, next_retry_at)
    WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_outbox_correlation
    ON public.outbox_messages (correlation_id);

COMMENT ON TABLE public.outbox_messages IS
    'Transactional outbox for reliable message delivery. Worker polls PENDING items.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. OPPORTUNITIES — Add claimed_by, claimed_at columns
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'opportunities' AND column_name = 'claimed_by'
    ) THEN
        ALTER TABLE public.opportunities
            ADD COLUMN claimed_by UUID REFERENCES auth.users(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'opportunities' AND column_name = 'claimed_at'
    ) THEN
        ALTER TABLE public.opportunities
            ADD COLUMN claimed_at TIMESTAMPTZ;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_opportunities_claimed_by
    ON public.opportunities (claimed_by)
    WHERE claimed_by IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. BROADCAST RATE LIMITS
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.broadcast_rate_limits (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT NOT NULL,
    actor_id    UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_tenant_time
    ON public.broadcast_rate_limits (tenant_id, created_at DESC);

COMMENT ON TABLE public.broadcast_rate_limits IS
    'Tracks broadcast frequency per tenant. Check count in last N minutes.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6. RPC: claim_opportunity — Atomic, race-condition-free
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_opportunity(
    p_opp_id    UUID,
    p_teacher_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_opp RECORD;
    v_result JSONB;
BEGIN
    -- Atomic UPDATE with WHERE status='OPEN' — only one teacher can win
    UPDATE public.opportunities
    SET
        status = 'CLAIMED',
        claimed_by = p_teacher_id,
        claimed_at = now(),
        winner_teacher_id = p_teacher_id
    WHERE id = p_opp_id
      AND status = 'OPEN'
    RETURNING * INTO v_opp;

    -- If no rows updated, the opportunity was already claimed or doesn't exist
    IF v_opp IS NULL THEN
        -- Check if it exists at all
        PERFORM 1 FROM public.opportunities WHERE id = p_opp_id;
        IF NOT FOUND THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'OPPORTUNITY_NOT_FOUND',
                'message', 'Esta oportunidade não existe.'
            );
        ELSE
            RETURN jsonb_build_object(
                'success', false,
                'error', 'ALREADY_CLAIMED',
                'message', 'Esta vaga já foi preenchida por outro professor.'
            );
        END IF;
    END IF;

    -- Success
    RETURN jsonb_build_object(
        'success', true,
        'opportunity_id', v_opp.id,
        'student_name', v_opp.student_name,
        'student_phone', v_opp.student_phone,
        'claimed_by', p_teacher_id,
        'claimed_at', v_opp.claimed_at
    );
END;
$$;

COMMENT ON FUNCTION public.claim_opportunity IS
    'Atomically claims an OPEN opportunity. Returns error if already claimed (409 logic).';

-- ────────────────────────────────────────────────────────────────────────────
-- 7. RPC: create_broadcast — Insert opportunity + outbox atomically
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_broadcast(
    p_student_name    TEXT,
    p_student_phone   TEXT,
    p_date            TEXT,
    p_time            TEXT,
    p_interests       TEXT,
    p_preferred_slots JSONB,
    p_tenant_id       TEXT,
    p_actor_id        UUID,
    p_idempotency_key TEXT,
    p_message_text    TEXT,
    p_destination     TEXT,
    p_instance        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing_key RECORD;
    v_opp_id UUID;
    v_rate_count INTEGER;
    v_slot JSONB;
    v_day_of_week INTEGER;
BEGIN
    -- 1. IDEMPOTENCY CHECK
    IF p_idempotency_key IS NOT NULL THEN
        -- Cleanup old keys first
        PERFORM public.cleanup_expired_idempotency_keys();

        SELECT * INTO v_existing_key
        FROM public.idempotency_keys
        WHERE key = p_idempotency_key;

        IF v_existing_key IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', true,
                'deduplicated', true,
                'opportunity_id', v_existing_key.result_id
            );
        END IF;
    END IF;

    -- 2. RATE LIMIT CHECK (max 10 broadcasts per minute per tenant)
    SELECT COUNT(*) INTO v_rate_count
    FROM public.broadcast_rate_limits
    WHERE tenant_id = p_tenant_id
      AND created_at > now() - INTERVAL '1 minute';

    IF v_rate_count >= 10 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'RATE_LIMITED',
            'message', 'Limite de disparos atingido. Aguarde 1 minuto.'
        );
    END IF;

    -- 3. INSERT OPPORTUNITY
    v_day_of_week := EXTRACT(DOW FROM (p_date || 'T' || p_time || ':00')::timestamp);

    v_slot := jsonb_build_object(
        'day', v_day_of_week,
        'time', p_time,
        'date', p_date
    );

    INSERT INTO public.opportunities (
        student_name, student_phone, slots_proposed, status,
        tenant_id, interests, user_id, preferred_slots
    ) VALUES (
        p_student_name, p_student_phone, jsonb_build_array(v_slot), 'OPEN',
        p_tenant_id, p_interests, p_actor_id, p_preferred_slots
    )
    RETURNING id INTO v_opp_id;

    -- 4. INSERT OUTBOX MESSAGE (same transaction!)
    INSERT INTO public.outbox_messages (
        channel, destination, payload, status, correlation_id, tenant_id, actor_id
    ) VALUES (
        'whatsapp',
        p_destination,
        jsonb_build_object(
            'instance', p_instance,
            'text', p_message_text,
            'opportunity_id', v_opp_id
        ),
        'PENDING',
        v_opp_id,
        p_tenant_id,
        p_actor_id
    );

    -- 5. SAVE IDEMPOTENCY KEY
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO public.idempotency_keys (key, tenant_id, result_id)
        VALUES (p_idempotency_key, p_tenant_id, v_opp_id)
        ON CONFLICT (key) DO NOTHING;
    END IF;

    -- 6. TRACK RATE LIMIT
    INSERT INTO public.broadcast_rate_limits (tenant_id, actor_id)
    VALUES (p_tenant_id, p_actor_id);

    RETURN jsonb_build_object(
        'success', true,
        'opportunity_id', v_opp_id,
        'deduplicated', false
    );
END;
$$;

COMMENT ON FUNCTION public.create_broadcast IS
    'Atomically creates an opportunity + outbox message. Idempotent via key. Rate limited.';

-- ────────────────────────────────────────────────────────────────────────────
-- 8. RLS POLICIES
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumed_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_rate_limits ENABLE ROW LEVEL SECURITY;

-- Service role only for infrastructure tables
DROP POLICY IF EXISTS "Service role only" ON public.idempotency_keys;
CREATE POLICY "Service role only" ON public.idempotency_keys
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role only" ON public.consumed_tokens;
CREATE POLICY "Service role only" ON public.consumed_tokens
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role only" ON public.outbox_messages;
CREATE POLICY "Service role only" ON public.outbox_messages
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role only" ON public.broadcast_rate_limits;
CREATE POLICY "Service role only" ON public.broadcast_rate_limits
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.claim_opportunity TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_idempotency_keys TO service_role;

GRANT ALL ON public.idempotency_keys TO service_role;
GRANT ALL ON public.consumed_tokens TO service_role;
GRANT ALL ON public.outbox_messages TO service_role;
GRANT ALL ON public.broadcast_rate_limits TO service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- To rollback, run:
-- DROP FUNCTION IF EXISTS public.create_broadcast CASCADE;
-- DROP FUNCTION IF EXISTS public.claim_opportunity CASCADE;
-- DROP FUNCTION IF EXISTS public.cleanup_expired_idempotency_keys CASCADE;
-- DROP TABLE IF EXISTS public.broadcast_rate_limits CASCADE;
-- DROP TABLE IF EXISTS public.outbox_messages CASCADE;
-- DROP TABLE IF EXISTS public.consumed_tokens CASCADE;
-- DROP TABLE IF EXISTS public.idempotency_keys CASCADE;
-- ALTER TABLE public.opportunities DROP COLUMN IF EXISTS claimed_by;
-- ALTER TABLE public.opportunities DROP COLUMN IF EXISTS claimed_at;
