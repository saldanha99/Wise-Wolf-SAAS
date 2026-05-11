-- ============================================================================
-- PR1 Part A: Prospects, Signatures, Credits (Bloco 3 Foundation)
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. PROSPECTS (Progressive profiling: pre-student before enrollment)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prospects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    referrer_code   TEXT,                            -- affiliate_codes.code
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT NOT NULL,                   -- E.164 normalized
    birth_date      DATE,
    status          TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
                    CHECK (status IN (
                        'PENDING_VERIFICATION',
                        'VERIFIED',
                        'TRIAL_SCHEDULED',
                        'TRIAL_DONE',
                        'ENROLLED',
                        'EXPIRED',
                        'CANCELLED'
                    )),
    verified_at     TIMESTAMPTZ,
    promoted_at     TIMESTAMPTZ,                     -- When converted to profile
    promoted_to_id  UUID,                            -- profile.id after promotion
    guardian_id     UUID,                             -- For minors: guardian profile
    guardian_name   TEXT,
    guardian_cpf_hash TEXT,
    guardian_cpf_encrypted BYTEA,
    guardian_email  TEXT,
    guardian_phone  TEXT,
    guardian_verified_at TIMESTAMPTZ,
    ip_hash         TEXT,
    user_agent_hash TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_email_tenant
    ON public.prospects (email, tenant_id)
    WHERE status NOT IN ('EXPIRED', 'CANCELLED');

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_phone_tenant
    ON public.prospects (phone, tenant_id)
    WHERE status NOT IN ('EXPIRED', 'CANCELLED');

CREATE INDEX IF NOT EXISTS idx_prospects_tenant
    ON public.prospects (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospects_referrer
    ON public.prospects (referrer_code)
    WHERE referrer_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prospects_status
    ON public.prospects (status);

ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.prospects;
CREATE POLICY "Service role full access" ON public.prospects
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Admins manage prospects" ON public.prospects;
CREATE POLICY "Admins manage prospects" ON public.prospects
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
              AND tenant_id = prospects.tenant_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
              AND tenant_id = prospects.tenant_id
        )
    );

-- Anon can insert (for public signup form)
DROP POLICY IF EXISTS "Anon insert prospects" ON public.prospects;
CREATE POLICY "Anon insert prospects" ON public.prospects
    FOR INSERT TO anon
    WITH CHECK (true);

COMMENT ON TABLE public.prospects IS
    'Pre-students in referral funnel. Progressive profiling: minimal data at signup, CPF only at enrollment.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. OTP TOKENS (for prospect verification + signature OTP)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.otp_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type     TEXT NOT NULL CHECK (target_type IN ('PROSPECT_VERIFY', 'SIGNATURE', 'GUARDIAN_VERIFY')),
    target_id       UUID NOT NULL,                   -- prospect_id or enrollment_signature_id
    channel         TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'both')),
    destination     TEXT NOT NULL,                   -- email address or phone E.164
    code_hash       TEXT NOT NULL,                   -- SHA-256 of 6-digit code
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    verified_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '10 minutes'),
    ip_hash         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_target
    ON public.otp_tokens (target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_otp_rate_limit
    ON public.otp_tokens (ip_hash, created_at DESC)
    WHERE ip_hash IS NOT NULL;

ALTER TABLE public.otp_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON public.otp_tokens;
CREATE POLICY "Service role only" ON public.otp_tokens
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.otp_tokens IS
    'One-time passwords for prospect verification and signature confirmation. Append-only.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. OPPORTUNITIES — Add prospect_id and referrer_code columns
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'opportunities' AND column_name = 'prospect_id'
    ) THEN
        ALTER TABLE public.opportunities
            ADD COLUMN prospect_id UUID REFERENCES public.prospects(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'opportunities' AND column_name = 'referrer_code'
    ) THEN
        ALTER TABLE public.opportunities
            ADD COLUMN referrer_code TEXT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_opportunities_prospect
    ON public.opportunities (prospect_id)
    WHERE prospect_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. TENTATIVE ENROLLMENTS (draft before real enrollment)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tentative_enrollments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           TEXT NOT NULL,
    prospect_id         UUID NOT NULL REFERENCES public.prospects(id),
    opportunity_id      UUID REFERENCES public.opportunities(id),
    teacher_id          UUID REFERENCES public.profiles(id),
    monthly_fee         NUMERIC(10,2),
    plan_duration       INTEGER,                     -- 0=avulso, 1, 6, 12
    classes_per_week    INTEGER,
    due_day             INTEGER CHECK (due_day BETWEEN 1 AND 28),
    schedule            JSONB,
    start_date          DATE,
    enrollment_fee      NUMERIC(10,2) DEFAULT 0,
    charge_enrollment   BOOLEAN DEFAULT false,
    status              TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'SIGNATURE_PENDING', 'SIGNED', 'PAYMENT_PENDING', 'ENROLLED', 'EXPIRED', 'CANCELLED')),
    converted_to_enrollment_id UUID,                 -- points to actual enrollment
    created_by          UUID REFERENCES auth.users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tentative_enrollment_prospect
    ON public.tentative_enrollments (prospect_id);

CREATE INDEX IF NOT EXISTS idx_tentative_enrollment_tenant
    ON public.tentative_enrollments (tenant_id, status);

ALTER TABLE public.tentative_enrollments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.tentative_enrollments;
CREATE POLICY "Service role full access" ON public.tentative_enrollments
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Admins manage tentative enrollments" ON public.tentative_enrollments;
CREATE POLICY "Admins manage tentative enrollments" ON public.tentative_enrollments
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
              AND tenant_id = tentative_enrollments.tenant_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
              AND tenant_id = tentative_enrollments.tenant_id
        )
    );

-- ────────────────────────────────────────────────────────────────────────────
-- 5. ENROLLMENT SIGNATURES (DIY electronic signature with evidence)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enrollment_signatures (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL,
    prospect_id             UUID NOT NULL REFERENCES public.prospects(id),
    tentative_enrollment_id UUID NOT NULL REFERENCES public.tentative_enrollments(id),
    contract_text           TEXT NOT NULL,
    contract_hash           TEXT NOT NULL,            -- SHA-256 of contract text + values
    signer_full_name        TEXT NOT NULL,
    signer_cpf_hash         TEXT NOT NULL,            -- SHA-256 for lookups/dedup
    signer_cpf_encrypted    BYTEA NOT NULL,           -- pgcrypto encrypted
    signer_email            TEXT NOT NULL,
    signer_phone            TEXT NOT NULL,
    signer_ip               INET NOT NULL,
    signer_user_agent       TEXT NOT NULL,
    signer_geo              JSONB,                   -- {country, region, city}
    otp_method              TEXT NOT NULL CHECK (otp_method IN ('email', 'whatsapp', 'both')),
    otp_verified_at         TIMESTAMPTZ NOT NULL,
    acceptance_text         TEXT NOT NULL,            -- Explicit consent text
    visual_signature_data   TEXT,                     -- Canvas drawing or typed name
    evidence_payload        JSONB NOT NULL,           -- Full snapshot of all evidence
    evidence_hmac           TEXT NOT NULL,            -- HMAC-SHA256 of evidence_payload
    signed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    status                  TEXT NOT NULL DEFAULT 'SIGNED'
                            CHECK (status IN ('SIGNED', 'PDF_GENERATED', 'VERIFIED', 'DISPUTED', 'REVOKED')),
    pdf_url                 TEXT,
    pdf_hash                TEXT,                    -- SHA-256 of generated PDF
    is_guardian_signature   BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enrollment_sig_tenant
    ON public.enrollment_signatures (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_enrollment_sig_prospect
    ON public.enrollment_signatures (prospect_id);

CREATE INDEX IF NOT EXISTS idx_enrollment_sig_cpf_hash
    ON public.enrollment_signatures (signer_cpf_hash);

ALTER TABLE public.enrollment_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.enrollment_signatures;
CREATE POLICY "Service role full access" ON public.enrollment_signatures
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Admins read own tenant signatures" ON public.enrollment_signatures;
CREATE POLICY "Admins read own tenant signatures" ON public.enrollment_signatures
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id::uuid = enrollment_signatures.tenant_id
        )
    );

-- Public verification endpoint needs anon read (limited fields via RPC)
COMMENT ON TABLE public.enrollment_signatures IS
    'DIY electronic signatures per Lei 14.063/2020. Evidence payload is HMAC-protected. Append-only for signed_at.';

-- ────────────────────────────────────────────────────────────────────────────
-- 6. SIGNATURE AUDIT LOG (APPEND-ONLY)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.signature_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    signature_id    UUID REFERENCES public.enrollment_signatures(id),
    event           TEXT NOT NULL,                   -- OTP_REQUESTED, OTP_SENT, OTP_VERIFIED, SIGNATURE_CONFIRMED, PDF_GENERATED, etc.
    payload         JSONB NOT NULL,
    actor_id        UUID,
    ip_hash         TEXT,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sig_audit_signature
    ON public.signature_audit_log (signature_id, ts DESC);

ALTER TABLE public.signature_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON public.signature_audit_log;
CREATE POLICY "Service role only" ON public.signature_audit_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- CRITICAL: Revoke UPDATE/DELETE for anon and authenticated (append-only)
REVOKE UPDATE, DELETE ON public.signature_audit_log FROM anon, authenticated;

COMMENT ON TABLE public.signature_audit_log IS
    'Immutable audit trail for enrollment signatures. UPDATE/DELETE revoked for non-service roles.';

-- ────────────────────────────────────────────────────────────────────────────
-- 7. STUDENT CREDITS (accumulated referral credits)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_credits (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id              UUID NOT NULL REFERENCES public.profiles(id),
    tenant_id               TEXT NOT NULL,
    amount                  NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    source                  TEXT NOT NULL,            -- 'REFERRAL', 'MANUAL', 'PROMO'
    source_ref              TEXT NOT NULL,            -- affiliate_conversion_id or other ref
    applied_to_invoice_id   TEXT,                     -- Asaas invoice ID when consumed
    applied_at              TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_ref)                      -- Idempotent credit insertion
);

CREATE INDEX IF NOT EXISTS idx_student_credits_student
    ON public.student_credits (student_id, created_at ASC)
    WHERE applied_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_credits_tenant
    ON public.student_credits (tenant_id);

ALTER TABLE public.student_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.student_credits;
CREATE POLICY "Service role full access" ON public.student_credits
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Students read own credits" ON public.student_credits;
CREATE POLICY "Students read own credits" ON public.student_credits
    FOR SELECT TO authenticated
    USING (student_id = auth.uid());

DROP POLICY IF EXISTS "Admins read tenant credits" ON public.student_credits;
CREATE POLICY "Admins read tenant credits" ON public.student_credits
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = student_credits.tenant_id
        )
    );

COMMENT ON TABLE public.student_credits IS
    'Accumulated referral credits. Applied as discount on next Asaas invoice. Idempotent via UNIQUE(source, source_ref).';

-- ────────────────────────────────────────────────────────────────────────────
-- 8. ALTER affiliate_codes — Add expires_at if missing
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'affiliate_codes' AND column_name = 'expires_at'
    ) THEN
        ALTER TABLE public.affiliate_codes
            ADD COLUMN expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '180 days');
    END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. ALTER tenant_referral_settings — Normalize to spec defaults
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    -- Add reward_amount_brl (unified) if schema uses separate teacher/student
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_referral_settings' AND column_name = 'reward_amount_brl'
    ) THEN
        ALTER TABLE public.tenant_referral_settings
            ADD COLUMN reward_amount_brl NUMERIC(10,2) NOT NULL DEFAULT 25.00;
    END IF;

    -- Add reward_expires_days
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_referral_settings' AND column_name = 'reward_expires_days'
    ) THEN
        ALTER TABLE public.tenant_referral_settings
            ADD COLUMN reward_expires_days INTEGER NOT NULL DEFAULT 365;
    END IF;

    -- Add trial_to_signup_window_days
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_referral_settings' AND column_name = 'trial_to_signup_window_days'
    ) THEN
        ALTER TABLE public.tenant_referral_settings
            ADD COLUMN trial_to_signup_window_days INTEGER NOT NULL DEFAULT 30;
    END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 10. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT ALL ON public.prospects TO service_role;
GRANT ALL ON public.otp_tokens TO service_role;
GRANT ALL ON public.tentative_enrollments TO service_role;
GRANT ALL ON public.enrollment_signatures TO service_role;
GRANT ALL ON public.signature_audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.signature_audit_log_id_seq TO service_role;
GRANT ALL ON public.student_credits TO service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP TABLE IF EXISTS public.student_credits CASCADE;
-- DROP TABLE IF EXISTS public.signature_audit_log CASCADE;
-- DROP TABLE IF EXISTS public.enrollment_signatures CASCADE;
-- DROP TABLE IF EXISTS public.tentative_enrollments CASCADE;
-- DROP TABLE IF EXISTS public.otp_tokens CASCADE;
-- DROP TABLE IF EXISTS public.prospects CASCADE;
-- ALTER TABLE public.opportunities DROP COLUMN IF EXISTS prospect_id;
-- ALTER TABLE public.opportunities DROP COLUMN IF EXISTS referrer_code;
-- ALTER TABLE public.affiliate_codes DROP COLUMN IF EXISTS expires_at;
