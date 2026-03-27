-- Create student_insights table
CREATE TABLE IF NOT EXISTS public.student_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    analyzed_logs_count INTEGER DEFAULT 0
);

-- Enable RLS
ALTER TABLE public.student_insights ENABLE ROW LEVEL SECURITY;

-- Policies
-- Students can view their own insights
CREATE POLICY "Users can view their own insights" ON public.student_insights
    FOR SELECT
    USING (auth.uid() = student_id);

-- Teachers/Admins can view/create (Simplified for now - admins/teachers usually have broad access or via service role)
-- Assuming service role for the Edge Function will bypass RLS for insertion.
-- But for viewing in frontend:

CREATE POLICY "Admins and Teachers can view all insights" ON public.student_insights
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE id = auth.uid()
            AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'TEACHER')
        )
    );
