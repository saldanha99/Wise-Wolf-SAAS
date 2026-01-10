-- Create class_logs table for recording lesson history
CREATE TABLE IF NOT EXISTS public.class_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    teacher_id UUID NOT NULL REFERENCES public.profiles(id),
    student_id UUID NOT NULL REFERENCES public.profiles(id),
    booking_id TEXT, -- Optional, links to a specific booking
    reschedule_id TEXT, -- Optional, links to a specific makeup class
    presence TEXT NOT NULL, -- PRESENÇA, FALTA, FALTA_JUSTIFICADA
    subtype TEXT, -- For justified absences
    content TEXT, -- Content applied in class
    observations TEXT, -- General notes
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.class_logs ENABLE ROW LEVEL SECURITY;

-- Create Policies
CREATE POLICY "Users can view logs from their tenant" 
    ON public.class_logs FOR SELECT 
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Teachers can insert logs for their students" 
    ON public.class_logs FOR INSERT 
    WITH CHECK (auth.uid() = teacher_id);

CREATE POLICY "Admins can manage all logs in their tenant"
    ON public.class_logs FOR ALL
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
