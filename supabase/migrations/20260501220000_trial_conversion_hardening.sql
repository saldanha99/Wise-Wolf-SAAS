-- ============================================================================
-- Migration: Trial Conversion Hardening (Item 3)
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. EXPAND TRIAL_STATUS + CONVERSION_STATUS CONSTRAINTS
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    -- Drop old trial_status CHECK
    ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_trial_status_check;

    -- Add expanded trial_status (includes RESCHEDULED)
    ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_trial_status_check
        CHECK (trial_status IN ('SCHEDULED', 'DONE', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'RESCHEDULED', 'CANCELLED'));

    -- Drop old conversion_status CHECK
    ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_conversion_status_check;

    -- Add expanded conversion_status (includes PENDING_FEEDBACK, ENROLLED)
    ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_conversion_status_check
        CHECK (conversion_status IN ('OPEN', 'PENDING_FEEDBACK', 'WON', 'LOST', 'ENROLLED'));
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CHECK constraints already updated or column does not exist: %', SQLERRM;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. TRIAL FEEDBACK AUDIT TABLE
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trial_feedback_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  UUID NOT NULL,
    actor_id        UUID NOT NULL REFERENCES auth.users(id),
    action          TEXT NOT NULL CHECK (action IN ('FEEDBACK_CREATED', 'FEEDBACK_UPDATED', 'STATUS_CHANGE', 'LINK_GENERATED', 'MARKED_LOST', 'MARKED_WON')),
    before_state    JSONB,
    after_state     JSONB,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trial_audit_opp ON public.trial_feedback_audit(opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_audit_actor ON public.trial_feedback_audit(actor_id);

ALTER TABLE public.trial_feedback_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.trial_feedback_audit;
CREATE POLICY "Service role full access" ON public.trial_feedback_audit
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read own tenant" ON public.trial_feedback_audit;
CREATE POLICY "Authenticated read own tenant" ON public.trial_feedback_audit
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.opportunities o
            JOIN public.profiles p ON p.tenant_id = o.tenant_id
            WHERE o.id = trial_feedback_audit.opportunity_id
              AND p.id = auth.uid()
        )
    );

-- ────────────────────────────────────────────────────────────────────────────
-- 3. ENROLLMENT INTENTS TABLE (links trial → enrollment)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enrollment_intents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  UUID NOT NULL REFERENCES public.opportunities(id),
    tenant_id       TEXT NOT NULL,
    offer_id        UUID REFERENCES public.offers(id),       -- Signed offer link
    link_url        TEXT NOT NULL,
    plan_duration   INTEGER,
    classes_per_week INTEGER,
    monthly_fee     NUMERIC(10,2),
    due_day         INTEGER,
    professor_id    UUID REFERENCES public.profiles(id),
    student_name    TEXT,
    student_phone   TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'OPENED', 'USED', 'EXPIRED')),
    created_by      UUID NOT NULL REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at         TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_enrollment_intents_opp ON public.enrollment_intents(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_intents_tenant ON public.enrollment_intents(tenant_id);

ALTER TABLE public.enrollment_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant admins manage intents" ON public.enrollment_intents;
CREATE POLICY "Tenant admins manage intents" ON public.enrollment_intents
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
              AND tenant_id = enrollment_intents.tenant_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL')
              AND tenant_id = enrollment_intents.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.enrollment_intents;
CREATE POLICY "Service role full access" ON public.enrollment_intents
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RPC: record_trial_feedback — Atomic feedback + status transition
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_trial_feedback(
    p_opportunity_id UUID,
    p_teacher_id UUID,
    p_recommended_level TEXT,
    p_recommended_plan TEXT,
    p_interest_score INTEGER,
    p_notes TEXT DEFAULT NULL,
    p_trial_status TEXT DEFAULT 'DONE',
    p_tenant_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_opp RECORD;
    v_existing_feedback RECORD;
    v_feedback_id UUID;
BEGIN
    -- 1. Lock and fetch opportunity
    SELECT * INTO v_opp FROM public.opportunities
    WHERE id = p_opportunity_id FOR UPDATE;

    IF v_opp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'OPPORTUNITY_NOT_FOUND');
    END IF;

    -- 2. Validate teacher owns this opportunity
    IF v_opp.winner_teacher_id IS NOT NULL AND v_opp.winner_teacher_id != p_teacher_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'NOT_ASSIGNED_TEACHER');
    END IF;

    -- 3. Validate trial_status transition
    IF v_opp.trial_status = 'DONE' AND p_trial_status != 'DONE' THEN
        RETURN jsonb_build_object('success', false, 'error', 'INVALID_TRANSITION',
            'message', 'Cannot change status from DONE');
    END IF;

    -- 4. Upsert feedback (one per opportunity)
    SELECT * INTO v_existing_feedback FROM public.trial_feedback
    WHERE opportunity_id = p_opportunity_id;

    IF v_existing_feedback IS NOT NULL THEN
        UPDATE public.trial_feedback SET
            recommended_level = p_recommended_level,
            recommended_plan = p_recommended_plan,
            interest_score = p_interest_score,
            notes = COALESCE(p_notes, notes)
        WHERE opportunity_id = p_opportunity_id
        RETURNING id INTO v_feedback_id;
    ELSE
        INSERT INTO public.trial_feedback (
            tenant_id, opportunity_id, teacher_id,
            recommended_level, recommended_plan, interest_score, notes
        ) VALUES (
            COALESCE(p_tenant_id, v_opp.tenant_id), p_opportunity_id, p_teacher_id,
            p_recommended_level, p_recommended_plan, p_interest_score, p_notes
        )
        RETURNING id INTO v_feedback_id;
    END IF;

    -- 5. Update opportunity status
    UPDATE public.opportunities SET
        trial_status = p_trial_status,
        conversion_status = CASE
            WHEN p_trial_status IN ('NO_SHOW_STUDENT', 'CANCELLED') THEN 'LOST'
            WHEN p_trial_status = 'DONE' AND conversion_status = 'OPEN' THEN 'PENDING_FEEDBACK'
            ELSE conversion_status
        END,
        lost_reason = CASE
            WHEN p_trial_status = 'NO_SHOW_STUDENT' THEN 'Aluno não compareceu à aula experimental'
            WHEN p_trial_status = 'CANCELLED' THEN 'Aula experimental cancelada'
            ELSE lost_reason
        END
    WHERE id = p_opportunity_id;

    -- 6. Audit trail
    INSERT INTO public.trial_feedback_audit (
        opportunity_id, actor_id, action, before_state, after_state
    ) VALUES (
        p_opportunity_id, p_teacher_id,
        CASE WHEN v_existing_feedback IS NOT NULL THEN 'FEEDBACK_UPDATED' ELSE 'FEEDBACK_CREATED' END,
        CASE WHEN v_existing_feedback IS NOT NULL THEN
            jsonb_build_object(
                'level', v_existing_feedback.recommended_level,
                'plan', v_existing_feedback.recommended_plan,
                'score', v_existing_feedback.interest_score
            )
        ELSE NULL END,
        jsonb_build_object(
            'level', p_recommended_level,
            'plan', p_recommended_plan,
            'score', p_interest_score,
            'trial_status', p_trial_status
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'feedback_id', v_feedback_id,
        'trial_status', p_trial_status
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. RPC: mark_opportunity_lost — Atomic loss with audit trail
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_opportunity_lost(
    p_opportunity_id UUID,
    p_actor_id UUID,
    p_reason TEXT DEFAULT 'Não especificado'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_opp RECORD;
BEGIN
    UPDATE public.opportunities SET
        conversion_status = 'LOST',
        lost_reason = p_reason
    WHERE id = p_opportunity_id
      AND conversion_status NOT IN ('WON', 'ENROLLED')
    RETURNING * INTO v_opp;

    IF v_opp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'CANNOT_MARK_LOST',
            'message', 'Oportunidade já convertida ou não encontrada.');
    END IF;

    -- Audit
    INSERT INTO public.trial_feedback_audit (
        opportunity_id, actor_id, action, after_state
    ) VALUES (
        p_opportunity_id, p_actor_id, 'MARKED_LOST',
        jsonb_build_object('reason', p_reason)
    );

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. RPC: mark_opportunity_won — Atomic win with audit trail
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_opportunity_won(
    p_opportunity_id UUID,
    p_student_id UUID,
    p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_opp RECORD;
BEGIN
    UPDATE public.opportunities SET
        conversion_status = 'WON',
        student_id = p_student_id
    WHERE id = p_opportunity_id
      AND conversion_status NOT IN ('WON', 'ENROLLED')
    RETURNING * INTO v_opp;

    IF v_opp IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'CANNOT_MARK_WON',
            'message', 'Oportunidade já convertida ou não encontrada.');
    END IF;

    -- Audit
    INSERT INTO public.trial_feedback_audit (
        opportunity_id, actor_id, action, after_state
    ) VALUES (
        p_opportunity_id, p_actor_id, 'MARKED_WON',
        jsonb_build_object('student_id', p_student_id)
    );

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT ALL ON public.trial_feedback_audit TO service_role;
GRANT ALL ON public.enrollment_intents TO service_role;
GRANT EXECUTE ON FUNCTION public.record_trial_feedback TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_opportunity_lost TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_opportunity_won TO authenticated, service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.mark_opportunity_won CASCADE;
-- DROP FUNCTION IF EXISTS public.mark_opportunity_lost CASCADE;
-- DROP FUNCTION IF EXISTS public.record_trial_feedback CASCADE;
-- DROP TABLE IF EXISTS public.enrollment_intents CASCADE;
-- DROP TABLE IF EXISTS public.trial_feedback_audit CASCADE;
