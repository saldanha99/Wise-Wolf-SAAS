-- ============================================================
-- Migration: enrollment_links
-- Links generated from experimental trials for student enrollment
-- ============================================================

CREATE TABLE IF NOT EXISTS public.enrollment_links (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT REFERENCES public.tenants(id),
    opportunity_id UUID REFERENCES public.opportunities(id),
    link_token TEXT UNIQUE NOT NULL,
    link_url TEXT NOT NULL,
    -- Pre-filled data snapshot
    student_name TEXT,
    student_phone TEXT,
    professor_id UUID REFERENCES public.profiles(id),
    plan_duration INTEGER,        -- 12, 6, 1
    classes_per_week INTEGER,     -- 2, 3, 4, 5
    monthly_fee NUMERIC(10,2),
    due_day INTEGER,
    -- Status tracking
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'USED', 'EXPIRED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    used_at TIMESTAMPTZ
);

-- Index for fast lookup by token (used by PublicRegistration)
CREATE INDEX IF NOT EXISTS idx_enrollment_links_token ON public.enrollment_links(link_token);

-- Index for listing by opportunity
CREATE INDEX IF NOT EXISTS idx_enrollment_links_opportunity ON public.enrollment_links(opportunity_id);

-- RLS
ALTER TABLE public.enrollment_links ENABLE ROW LEVEL SECURITY;

-- Directors can manage enrollment links for their tenant
DROP POLICY IF EXISTS "tenant_enrollment_links_policy" ON public.enrollment_links;
CREATE POLICY "tenant_enrollment_links_policy" ON public.enrollment_links
    FOR ALL USING (tenant_id IN (
        SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
    ));

-- Public read for token lookup (student clicking the link)
DROP POLICY IF EXISTS "public_read_enrollment_links" ON public.enrollment_links;
CREATE POLICY "public_read_enrollment_links" ON public.enrollment_links
    FOR SELECT USING (true);
