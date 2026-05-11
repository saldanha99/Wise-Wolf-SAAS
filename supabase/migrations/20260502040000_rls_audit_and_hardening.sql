-- ============================================================================
-- Migration: RLS Hardening & Audit (PR Isolado)
-- ============================================================================

BEGIN;

-- Helper to safely compare tenant_id whether it is TEXT or UUID
-- Most tables use TEXT for tenant_id (e.g., 'school-wise-wolf').

-- 1. PROSPECTS
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon insert prospects" ON public.prospects;
DROP POLICY IF EXISTS "Admins manage prospects" ON public.prospects;
DROP POLICY IF EXISTS "Service role full access" ON public.prospects;

-- Prospects: anon read ONLY via Edge Function (revoke SELECT from anon).
REVOKE SELECT ON public.prospects FROM anon;

CREATE POLICY "Service role full access prospects" ON public.prospects FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Admins full access to their tenant prospects
CREATE POLICY "Admins manage prospects" ON public.prospects
    FOR ALL TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
        )
    )
    WITH CHECK (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
        )
    );

-- 2. ENROLLMENT_SIGNATURES
ALTER TABLE public.enrollment_signatures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read own tenant signatures" ON public.enrollment_signatures;
DROP POLICY IF EXISTS "Service role full access" ON public.enrollment_signatures;

CREATE POLICY "Service role full access enrollment_signatures" ON public.enrollment_signatures FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Admins full access to their tenant's signatures
CREATE POLICY "Admins read own tenant signatures" ON public.enrollment_signatures
    FOR SELECT TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        )
    );

-- Protect signer_cpf_encrypted from direct SELECT
REVOKE SELECT (signer_cpf_encrypted) ON public.enrollment_signatures FROM authenticated, anon;

-- 3. SIGNATURE_AUDIT_LOG
ALTER TABLE public.signature_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.signature_audit_log;
CREATE POLICY "Service role full access signature_audit_log" ON public.signature_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Append only: revoke UPDATE and DELETE
REVOKE UPDATE, DELETE ON public.signature_audit_log FROM authenticated, anon, public;

-- 4. STUDENT_CREDITS
ALTER TABLE public.student_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access" ON public.student_credits;
DROP POLICY IF EXISTS "Students read own credits" ON public.student_credits;
DROP POLICY IF EXISTS "Admins read tenant credits" ON public.student_credits;

CREATE POLICY "Service role full access student_credits" ON public.student_credits FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Students read own credits" ON public.student_credits FOR SELECT TO authenticated USING (student_id = auth.uid());
CREATE POLICY "Admins manage tenant credits" ON public.student_credits
    FOR ALL TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    )
    WITH CHECK (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    );

-- 5. AFFILIATE_CODES
ALTER TABLE public.affiliate_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access affiliate_codes" ON public.affiliate_codes;
DROP POLICY IF EXISTS "Owner read affiliate_codes" ON public.affiliate_codes;
DROP POLICY IF EXISTS "Admins manage affiliate_codes" ON public.affiliate_codes;

CREATE POLICY "Service role full access affiliate_codes" ON public.affiliate_codes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Owner read affiliate_codes" ON public.affiliate_codes FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY "Admins manage affiliate_codes" ON public.affiliate_codes
    FOR ALL TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    )
    WITH CHECK (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    );

-- 6. AFFILIATE_CLICKS
ALTER TABLE public.affiliate_clicks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access affiliate_clicks" ON public.affiliate_clicks;
DROP POLICY IF EXISTS "Anon insert affiliate_clicks" ON public.affiliate_clicks;
DROP POLICY IF EXISTS "Owner read affiliate_clicks" ON public.affiliate_clicks;

CREATE POLICY "Service role full access affiliate_clicks" ON public.affiliate_clicks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Anon can INSERT but cannot SELECT
CREATE POLICY "Anon insert affiliate_clicks" ON public.affiliate_clicks FOR INSERT TO anon WITH CHECK (true);
REVOKE SELECT ON public.affiliate_clicks FROM anon;

CREATE POLICY "Owner read affiliate_clicks" ON public.affiliate_clicks
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.affiliate_codes
            WHERE affiliate_codes.code = affiliate_clicks.affiliate_code
              AND affiliate_codes.owner_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id::text = (auth.jwt() ->> 'tenant_id')
        )
    );

-- 7. AFFILIATE_CONVERSIONS
ALTER TABLE public.affiliate_conversions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access affiliate_conversions" ON public.affiliate_conversions;
DROP POLICY IF EXISTS "Owner read affiliate_conversions" ON public.affiliate_conversions;

CREATE POLICY "Service role full access affiliate_conversions" ON public.affiliate_conversions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Owner read affiliate_conversions" ON public.affiliate_conversions
    FOR SELECT TO authenticated
    USING (
        referrer_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id::text = (auth.jwt() ->> 'tenant_id')
        )
    );

-- 8. OFFERS
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access offers" ON public.offers;
DROP POLICY IF EXISTS "Admins manage offers" ON public.offers;

CREATE POLICY "Service role full access offers" ON public.offers FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Admins manage offers" ON public.offers
    FOR ALL TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL'))
    )
    WITH CHECK (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL'))
    );

-- 9. CONSUMED_TOKENS
ALTER TABLE public.consumed_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access consumed_tokens" ON public.consumed_tokens;
CREATE POLICY "Service role full access consumed_tokens" ON public.consumed_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Revoke all access from authenticated/anon (used only by RPC/service_role)
REVOKE ALL ON public.consumed_tokens FROM authenticated, anon, public;

-- 10. OUTBOX_MESSAGES
ALTER TABLE public.outbox_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access outbox_messages" ON public.outbox_messages;
CREATE POLICY "Service role full access outbox_messages" ON public.outbox_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Revoke all access from authenticated/anon (used only by RPC/service_role)
REVOKE ALL ON public.outbox_messages FROM authenticated, anon, public;

-- 11. TENTATIVE_ENROLLMENTS
ALTER TABLE public.tentative_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins manage tentative enrollments" ON public.tentative_enrollments;
DROP POLICY IF EXISTS "Service role full access" ON public.tentative_enrollments;
CREATE POLICY "Service role full access tentative_enrollments" ON public.tentative_enrollments FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Admins manage tentative enrollments" ON public.tentative_enrollments
    FOR ALL TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL'))
    )
    WITH CHECK (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL'))
    );

-- 12. ENROLLMENT_INTENTS
ALTER TABLE public.enrollment_intents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins manage intents" ON public.enrollment_intents;
DROP POLICY IF EXISTS "Service role full access intents" ON public.enrollment_intents;
CREATE POLICY "Service role full access intents" ON public.enrollment_intents FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Admins manage intents" ON public.enrollment_intents
    FOR ALL TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL'))
    )
    WITH CHECK (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL'))
    );

-- 13. TRIAL_FEEDBACK_AUDIT
ALTER TABLE public.trial_feedback_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access trial_feedback_audit" ON public.trial_feedback_audit;
CREATE POLICY "Service role full access trial_feedback_audit" ON public.trial_feedback_audit FOR ALL TO service_role USING (true) WITH CHECK (true);
-- Read-only for admins
CREATE POLICY "Admins read trial_feedback_audit" ON public.trial_feedback_audit
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id::text = (auth.jwt() ->> 'tenant_id')
        )
    );
REVOKE UPDATE, DELETE, INSERT ON public.trial_feedback_audit FROM authenticated, anon, public;

-- 14. TENANT_REFERRAL_SETTINGS
ALTER TABLE public.tenant_referral_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access tenant_referral_settings" ON public.tenant_referral_settings;
CREATE POLICY "Service role full access tenant_referral_settings" ON public.tenant_referral_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Admins manage tenant_referral_settings" ON public.tenant_referral_settings
    FOR ALL TO authenticated
    USING (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    )
    WITH CHECK (
        tenant_id::text = (auth.jwt() ->> 'tenant_id')
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    );

-- 15. XP_EVENTS
-- Assuming this is from gamification schema. If it doesn't exist yet, this will safely skip or be applied when it exists.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename  = 'xp_events') THEN
        ALTER TABLE public.xp_events ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "Service role full access xp_events" ON public.xp_events;
        CREATE POLICY "Service role full access xp_events" ON public.xp_events FOR ALL TO service_role USING (true) WITH CHECK (true);
        -- Append only: revoke UPDATE and DELETE
        REVOKE UPDATE, DELETE ON public.xp_events FROM authenticated, anon, public;
        
        DROP POLICY IF EXISTS "Users read own xp_events" ON public.xp_events;
        CREATE POLICY "Users read own xp_events" ON public.xp_events
            FOR SELECT TO authenticated
            USING (student_id = auth.uid());
    END IF;
END $$;

COMMIT;
