-- Add granular pedagogical controls to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS current_book_part TEXT DEFAULT 'A1-1',
ADD COLUMN IF NOT EXISTS evaluation_unlocked BOOLEAN DEFAULT false;

-- Create table to store student evaluation results
CREATE TABLE IF NOT EXISTS public.student_evaluations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID NOT NULL REFERENCES public.profiles(id),
    teacher_id UUID REFERENCES public.profiles(id),
    book_part TEXT NOT NULL,
    score INTEGER NOT NULL,
    total_questions INTEGER DEFAULT 10,
    answers JSONB,
    completed_at TIMESTAMPTZ DEFAULT now(),
    tenant_id TEXT NOT NULL
);

-- RLS for student_evaluations
ALTER TABLE public.student_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own evaluations"
    ON public.student_evaluations FOR SELECT
    USING (student_id = auth.uid() OR tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Students can insert their own evaluations"
    ON public.student_evaluations FOR INSERT
    WITH CHECK (student_id = auth.uid());
