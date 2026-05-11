-- =====================================================
-- MIGRATION: Trial-to-Contract Enrollment Flow
-- Date: 2026-02-19
-- Description:
--   1. ALTER opportunities (normalize status, add trial/conversion columns)
--   2. CREATE trial_feedback
--   3. CREATE student_contracts
-- =====================================================

-- =====================================================
-- 1. ALTER OPPORTUNITIES
-- =====================================================

-- 1a + 1b. Normalize statuses + Drop/Add CHECK constraint (atomic)
DO $$
BEGIN
    -- Drop existing check constraint
    ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_status_check;

    -- Normalize all existing statuses
    UPDATE public.opportunities SET status = 'CLAIMED' WHERE status IN ('TAKEN', 'FILLED');
    UPDATE public.opportunities SET status = 'OPEN' WHERE status IS NULL OR status NOT IN ('OPEN', 'CLAIMED', 'EXPIRED', 'CANCELED');

    -- Add new constraint (now safe)
    ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_status_check
        CHECK (status IN ('OPEN', 'CLAIMED', 'EXPIRED', 'CANCELED'));
END $$;

-- 1c. Add new columns
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'opportunities' AND column_name = 'trial_appointment_id') THEN
        ALTER TABLE public.opportunities ADD COLUMN trial_appointment_id UUID;
        -- Soft FK: references appointments(id), but appointments table may not have explicit migration DDL
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'opportunities' AND column_name = 'trial_status') THEN
        ALTER TABLE public.opportunities ADD COLUMN trial_status TEXT
            CHECK (trial_status IN ('SCHEDULED', 'DONE', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'opportunities' AND column_name = 'conversion_status') THEN
        ALTER TABLE public.opportunities ADD COLUMN conversion_status TEXT DEFAULT 'OPEN'
            CHECK (conversion_status IN ('OPEN', 'WON', 'LOST'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'opportunities' AND column_name = 'student_id') THEN
        ALTER TABLE public.opportunities ADD COLUMN student_id UUID REFERENCES public.profiles(id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'opportunities' AND column_name = 'lost_reason') THEN
        ALTER TABLE public.opportunities ADD COLUMN lost_reason TEXT;
    END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_opportunities_trial_status ON public.opportunities(trial_status);
CREATE INDEX IF NOT EXISTS idx_opportunities_conversion ON public.opportunities(conversion_status);

-- =====================================================
-- 2. CREATE TRIAL_FEEDBACK
-- =====================================================

CREATE TABLE IF NOT EXISTS public.trial_feedback (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT REFERENCES public.tenants(id) ON DELETE CASCADE,
    opportunity_id UUID REFERENCES public.opportunities(id) ON DELETE CASCADE,
    booking_id UUID, -- soft FK to appointments
    teacher_id UUID REFERENCES public.profiles(id),
    recommended_level TEXT CHECK (recommended_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
    recommended_plan TEXT,
    interest_score INTEGER CHECK (interest_score BETWEEN 1 AND 5),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (opportunity_id) -- One feedback per opportunity
);

-- RLS
ALTER TABLE public.trial_feedback ENABLE ROW LEVEL SECURITY;

-- Teachers: CRUD on own feedback
DROP POLICY IF EXISTS "Teachers manage own feedback" ON public.trial_feedback;
CREATE POLICY "Teachers manage own feedback"
ON public.trial_feedback FOR ALL
TO authenticated
USING (
    teacher_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        AND tenant_id = trial_feedback.tenant_id
    )
)
WITH CHECK (
    teacher_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        AND tenant_id = trial_feedback.tenant_id
    )
);

-- Index
CREATE INDEX IF NOT EXISTS idx_trial_feedback_opportunity ON public.trial_feedback(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_trial_feedback_teacher ON public.trial_feedback(teacher_id);

-- =====================================================
-- 3. CREATE STUDENT_CONTRACTS
-- =====================================================

CREATE TABLE IF NOT EXISTS public.student_contracts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT REFERENCES public.tenants(id) ON DELETE CASCADE,

    -- Identification
    student_id UUID REFERENCES public.profiles(id) NOT NULL,
    opportunity_id UUID REFERENCES public.opportunities(id),
    trial_appointment_id UUID, -- soft FK to appointments

    -- Pedagogical Relationship
    primary_teacher_id UUID REFERENCES public.profiles(id),

    -- Commercial
    billing_cycle TEXT DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'quarterly', 'semiannual', 'annual')),
    monthly_fee_cents INTEGER NOT NULL DEFAULT 0,
    due_day INTEGER CHECK (due_day BETWEEN 1 AND 28),
    currency TEXT DEFAULT 'BRL',
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    status TEXT DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'CANCELLED')),

    -- Asaas Integration
    asaas_customer_id TEXT,
    asaas_subscription_id TEXT,

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    cancelled_at TIMESTAMPTZ,
    cancel_reason TEXT
);

-- RLS
ALTER TABLE public.student_contracts ENABLE ROW LEVEL SECURITY;

-- Only SCHOOL_ADMIN / SUPER_ADMIN can manage contracts within their tenant
DROP POLICY IF EXISTS "Admins manage contracts" ON public.student_contracts;
CREATE POLICY "Admins manage contracts"
ON public.student_contracts FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        AND tenant_id = student_contracts.tenant_id
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        AND tenant_id = student_contracts.tenant_id
    )
);

-- Students can read their own contracts
DROP POLICY IF EXISTS "Students view own contracts" ON public.student_contracts;
CREATE POLICY "Students view own contracts"
ON public.student_contracts FOR SELECT
TO authenticated
USING (student_id = auth.uid());

-- Indexes
CREATE INDEX IF NOT EXISTS idx_student_contracts_student ON public.student_contracts(student_id);
CREATE INDEX IF NOT EXISTS idx_student_contracts_tenant ON public.student_contracts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_student_contracts_teacher ON public.student_contracts(primary_teacher_id);
CREATE INDEX IF NOT EXISTS idx_student_contracts_opportunity ON public.student_contracts(opportunity_id);
