-- Force creation of student_insights table
-- Copy and run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.student_insights (
  id uuid default gen_random_uuid() primary key,
  student_id uuid references public.profiles(id) not null,
  content text not null, -- The AI generated content
  created_at timestamp with time zone default now(),
  valid_until timestamp with time zone,
  analyzed_logs_count INTEGER DEFAULT 0
);

-- Enable RLS
ALTER TABLE public.student_insights ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Alunos veem seus insights" ON public.student_insights;
CREATE POLICY "Alunos veem seus insights"
ON public.student_insights for select
using (auth.uid() = student_id);

DROP POLICY IF EXISTS "Admins e Professores veem todos insights" ON public.student_insights;
CREATE POLICY "Admins e Professores veem todos insights"
ON public.student_insights for select
using (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid()
        AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'TEACHER')
    )
);

-- Grant permissions to authenticated users and service_role
GRANT ALL ON public.student_insights TO authenticated;
GRANT ALL ON public.student_insights TO service_role;
