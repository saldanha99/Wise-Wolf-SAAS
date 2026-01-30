-- SCRIPT DE CORREÇÃO: Cria tabela profiles (se não existir) e student_insights

-- 1. Garante que a tabela PROFILES existe (Depedência Crítica)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT,
    role TEXT CHECK (role IN ('STUDENT', 'TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')),
    tenant_id TEXT,
    email TEXT,
    phone TEXT,
    avatar_url TEXT,
    meeting_link TEXT, -- Fundamental para a task de hoje
    fixed_schedule TEXT,
    private_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilita RLS em profiles se criado agora
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policy básica de leitura (ajuste conforme necessidade real de segurança)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Public Read') THEN
        CREATE POLICY "Public Read" ON public.profiles FOR SELECT USING (true);
    END IF;
END $$;


-- 2. Agora cria a tabela de INSIGHTS (Task Original)
CREATE TABLE IF NOT EXISTS public.student_insights (
  id uuid default gen_random_uuid() primary key,
  student_id uuid references public.profiles(id) not null,
  content text not null,
  created_at timestamp with time zone default now(),
  valid_until timestamp with time zone,
  analyzed_logs_count INTEGER DEFAULT 0
);

-- 3. Habilita Segurança (RLS) para insights
ALTER TABLE public.student_insights ENABLE ROW LEVEL SECURITY;

-- 4. Cria Políticas de Acesso para insights
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

-- Grant privileges (just in case)
GRANT ALL ON public.student_insights TO authenticated;
GRANT ALL ON public.student_insights TO service_role;
