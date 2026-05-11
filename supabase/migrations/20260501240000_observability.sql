-- ============================================================================
-- Migration: Observability & Security Views (Item 5)
-- Idempotent, reversible.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. SECURITY EVENTS LOG (centralized audit for all security-relevant events)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.security_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,                   -- e.g. 'WEBHOOK_INVALID_TOKEN', 'LEGACY_LINK_USED', 'FRAUD_DETECTED'
    severity        TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('DEBUG', 'INFO', 'WARN', 'CRITICAL')),
    source          TEXT NOT NULL,                   -- e.g. 'asaas-webhook', 'resolve-offer', 'broadcast-opportunity'
    tenant_id       TEXT,
    actor_id        UUID,
    ip_hash         TEXT,
    details         JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_type ON public.security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_severity ON public.security_events(severity, created_at DESC)
    WHERE severity IN ('WARN', 'CRITICAL');
CREATE INDEX IF NOT EXISTS idx_security_events_tenant ON public.security_events(tenant_id, created_at DESC);

ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON public.security_events;
CREATE POLICY "Service role only" ON public.security_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Admins read own tenant events" ON public.security_events;
CREATE POLICY "Admins read own tenant events" ON public.security_events
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = security_events.tenant_id
        )
    );

COMMENT ON TABLE public.security_events IS
    'Centralized security audit log. All security-relevant events across Edge Functions and RPCs.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. WEBHOOK DELIVERY LOG (track all webhook invocations)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_delivery_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL,                   -- 'asaas', 'evolution', etc.
    event_type      TEXT NOT NULL,                   -- 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', etc.
    payload_hash    TEXT,                            -- SHA256 of payload (dedup)
    student_id      UUID,
    payment_id      TEXT,
    status          TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'FAILED', 'DUPLICATE')),
    error_message   TEXT,
    processing_ms   INTEGER,                         -- Execution time in milliseconds
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_source ON public.webhook_delivery_log(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_log_status ON public.webhook_delivery_log(status)
    WHERE status IN ('FAILED', 'DUPLICATE');
CREATE INDEX IF NOT EXISTS idx_webhook_log_dedup ON public.webhook_delivery_log(payload_hash)
    WHERE payload_hash IS NOT NULL;

ALTER TABLE public.webhook_delivery_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON public.webhook_delivery_log;
CREATE POLICY "Service role only" ON public.webhook_delivery_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. OBSERVABILITY VIEWS — Dashboards for admins
-- ────────────────────────────────────────────────────────────────────────────

-- 3a. Broadcast Pipeline Health
CREATE OR REPLACE VIEW public.v_broadcast_health AS
SELECT
    DATE_TRUNC('hour', created_at) AS hour,
    status,
    COUNT(*) AS count,
    AVG(attempt_count) AS avg_retries
FROM public.outbox_messages
WHERE created_at > now() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC;

-- 3b. Offer Usage Summary
CREATE OR REPLACE VIEW public.v_offer_stats AS
SELECT
    kind,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE consumed_at IS NOT NULL) AS consumed,
    COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked,
    COUNT(*) FILTER (WHERE expires_at < now() AND consumed_at IS NULL AND revoked_at IS NULL) AS expired,
    COUNT(*) FILTER (WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at >= now()) AS active,
    ROUND(AVG(usage_count), 1) AS avg_views
FROM public.offers
GROUP BY kind;

-- 3c. Legacy Link Migration Progress
CREATE OR REPLACE VIEW public.v_legacy_migration AS
SELECT
    route,
    raw_param,
    DATE_TRUNC('day', created_at) AS day,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE decoded_ok) AS success,
    COUNT(*) FILTER (WHERE NOT decoded_ok) AS failures
FROM public.legacy_offer_usage
WHERE created_at > now() - INTERVAL '30 days'
GROUP BY 1, 2, 3
ORDER BY 3 DESC;

-- 3d. Affiliate Program Dashboard
CREATE OR REPLACE VIEW public.v_affiliate_dashboard AS
SELECT
    ac.tenant_id,
    ac.code,
    ac.owner_type,
    p.full_name AS owner_name,
    ac.total_clicks,
    ac.total_conversions,
    COALESCE(SUM(acv.reward_amount_brl) FILTER (WHERE acv.status = 'REWARD_RELEASED'), 0) AS total_rewards_brl,
    COUNT(acv.id) FILTER (WHERE acv.status = 'BLOCKED_FRAUD') AS blocked_fraud,
    ac.created_at
FROM public.affiliate_codes ac
LEFT JOIN public.profiles p ON p.id = ac.owner_id
LEFT JOIN public.affiliate_conversions acv ON acv.affiliate_code_id = ac.id
GROUP BY ac.id, ac.tenant_id, ac.code, ac.owner_type, p.full_name, ac.total_clicks, ac.total_conversions, ac.created_at;

-- 3e. Trial Conversion Funnel
CREATE OR REPLACE VIEW public.v_trial_funnel AS
SELECT
    tenant_id,
    DATE_TRUNC('week', created_at) AS week,
    COUNT(*) AS total_opportunities,
    COUNT(*) FILTER (WHERE trial_status = 'DONE') AS trials_done,
    COUNT(*) FILTER (WHERE trial_status = 'NO_SHOW_STUDENT') AS no_shows,
    COUNT(*) FILTER (WHERE conversion_status = 'WON') AS won,
    COUNT(*) FILTER (WHERE conversion_status = 'LOST') AS lost,
    COUNT(*) FILTER (WHERE conversion_status = 'OPEN') AS open,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE conversion_status = 'WON')
        / NULLIF(COUNT(*) FILTER (WHERE trial_status = 'DONE'), 0),
        1
    ) AS conversion_rate_pct
FROM public.opportunities
WHERE created_at > now() - INTERVAL '90 days'
GROUP BY 1, 2
ORDER BY 2 DESC;

-- 3f. Security Alert Summary (last 24h)
CREATE OR REPLACE VIEW public.v_security_alerts AS
SELECT
    event_type,
    severity,
    source,
    COUNT(*) AS count,
    MAX(created_at) AS last_seen
FROM public.security_events
WHERE created_at > now() - INTERVAL '24 hours'
GROUP BY 1, 2, 3
ORDER BY
    CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARN' THEN 1 WHEN 'INFO' THEN 2 ELSE 3 END,
    count DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RPC: log_security_event — Called by Edge Functions
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_security_event(
    p_event_type TEXT,
    p_severity TEXT DEFAULT 'INFO',
    p_source TEXT DEFAULT 'unknown',
    p_tenant_id TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL,
    p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO public.security_events (event_type, severity, source, tenant_id, actor_id, details)
    VALUES (p_event_type, p_severity, p_source, p_tenant_id, p_actor_id, p_details)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT ALL ON public.security_events TO service_role;
GRANT ALL ON public.webhook_delivery_log TO service_role;
GRANT SELECT ON public.v_broadcast_health TO authenticated, service_role;
GRANT SELECT ON public.v_offer_stats TO authenticated, service_role;
GRANT SELECT ON public.v_legacy_migration TO authenticated, service_role;
GRANT SELECT ON public.v_affiliate_dashboard TO authenticated, service_role;
GRANT SELECT ON public.v_trial_funnel TO authenticated, service_role;
GRANT SELECT ON public.v_security_alerts TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.log_security_event(TEXT, TEXT, TEXT, TEXT, UUID, JSONB) TO service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.log_security_event CASCADE;
-- DROP VIEW IF EXISTS public.v_security_alerts CASCADE;
-- DROP VIEW IF EXISTS public.v_trial_funnel CASCADE;
-- DROP VIEW IF EXISTS public.v_affiliate_dashboard CASCADE;
-- DROP VIEW IF EXISTS public.v_legacy_migration CASCADE;
-- DROP VIEW IF EXISTS public.v_offer_stats CASCADE;
-- DROP VIEW IF EXISTS public.v_broadcast_health CASCADE;
-- DROP TABLE IF EXISTS public.webhook_delivery_log CASCADE;
-- DROP TABLE IF EXISTS public.security_events CASCADE;
