-- 1. Create OPPORTUNITIES table (The Auction)
CREATE TABLE IF NOT EXISTS public.opportunities (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_name TEXT NOT NULL,
    student_phone TEXT,
    slots_proposed JSONB NOT NULL, -- Format: [{'day': 1, 'time': '19:00', 'teacher_id': '...'}]
    status TEXT CHECK (status IN ('OPEN', 'TAKEN', 'EXPIRED', 'CANCELED')) DEFAULT 'OPEN',
    winner_teacher_id UUID REFERENCES public.profiles(id),
    accepted_slot JSONB, -- The specific slot that was chosen
    tenant_id TEXT REFERENCES public.tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS for opportunities
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;

-- Policy: Teachers can view OPEN opportunities (or all for history)
DROP POLICY IF EXISTS "Teachers view opportunities" ON public.opportunities;
CREATE POLICY "Teachers view opportunities"
ON public.opportunities FOR SELECT
TO authenticated
USING (true);

-- Policy: Teachers can update opportunities (to accept them)
DROP POLICY IF EXISTS "Teachers update opportunities" ON public.opportunities;
CREATE POLICY "Teachers update opportunities"
ON public.opportunities FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- Policy: Anyone authenticated (Admins/System) can insert
DROP POLICY IF EXISTS "Admins insert opportunities" ON public.opportunities;
CREATE POLICY "Admins insert opportunities"
ON public.opportunities FOR INSERT
TO authenticated
WITH CHECK (true);


-- 2. Update BOOKINGS table (Acts as class_schedules)
DO $$
BEGIN
    -- Add 'type' if not exists ('REGULAR' or 'TRIAL')
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'type') THEN
        ALTER TABLE public.bookings ADD COLUMN type TEXT DEFAULT 'REGULAR';
    END IF;

    -- Add 'opportunity_id'
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'opportunity_id') THEN
        ALTER TABLE public.bookings ADD COLUMN opportunity_id UUID REFERENCES public.opportunities(id);
    END IF;

    -- Add 'status' (Confirmed missing previously)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'status') THEN
        ALTER TABLE public.bookings ADD COLUMN status TEXT DEFAULT 'SCHEDULED';
    END IF;

    -- Add 'date' for Single Occurrence (Trials)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'date') THEN
        ALTER TABLE public.bookings ADD COLUMN date DATE; 
    END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON public.opportunities(status);
CREATE INDEX IF NOT EXISTS idx_bookings_opportunity ON public.bookings(opportunity_id);
