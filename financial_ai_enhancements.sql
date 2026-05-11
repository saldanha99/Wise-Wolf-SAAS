
-- 1. Update teacher_closings to include paid_at and teacher_confirmed status
ALTER TABLE public.teacher_closings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE public.teacher_closings ADD COLUMN IF NOT EXISTS teacher_confirmation_status TEXT DEFAULT 'PENDENTE'; -- PENDENTE, OK, CONTESTADO

-- 2. Add student confirmation to class_logs
ALTER TABLE public.class_logs ADD COLUMN IF NOT EXISTS student_confirmed BOOLEAN DEFAULT FALSE;

-- 3. Create Lesson Plans table for AI memory
CREATE TABLE IF NOT EXISTS public.lesson_plans (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    teacher_id UUID NOT NULL REFERENCES public.profiles(id),
    student_id UUID NOT NULL REFERENCES public.profiles(id),
    plan_date DATE DEFAULT CURRENT_DATE,
    objectives TEXT,
    content TEXT,
    materials TEXT,
    ai_memory TEXT, -- This stores the "smarter" context for future plans
    teacher_notes TEXT,
    custom_prompt TEXT,
    ai_suggestions TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.lesson_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Teachers can manage their lesson plans"
    ON public.lesson_plans FOR ALL
    USING (auth.uid() = teacher_id);

CREATE POLICY "Students can view their lesson plans"
    ON public.lesson_plans FOR SELECT
    USING (auth.uid() = student_id);
