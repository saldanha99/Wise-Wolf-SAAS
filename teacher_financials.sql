
-- Table for tracking teacher monthly financial closings
CREATE TABLE IF NOT EXISTS public.teacher_closings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    teacher_id UUID NOT NULL REFERENCES public.profiles(id),
    month_year TEXT NOT NULL, -- Format: YYYY-MM
    total_lessons INTEGER DEFAULT 0,
    total_amount DECIMAL(10,2) DEFAULT 0,
    status TEXT DEFAULT 'PENDENTE', -- PENDENTE, CONFIRMADO, CONTESTADO, PAGO
    teacher_notes TEXT,
    admin_notes TEXT,
    nf_link TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(teacher_id, month_year)
);

-- Enable RLS
ALTER TABLE public.teacher_closings ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Teachers can view their own closings"
    ON public.teacher_closings FOR SELECT
    USING (auth.uid() = teacher_id);

CREATE POLICY "Teachers can update (confirm/contest) their own closings"
    ON public.teacher_closings FOR UPDATE
    USING (auth.uid() = teacher_id);

CREATE POLICY "Admins can manage all closings in their tenant"
    ON public.teacher_closings FOR ALL
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));

-- Update function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_teacher_closings_updated_at
    BEFORE UPDATE ON public.teacher_closings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
