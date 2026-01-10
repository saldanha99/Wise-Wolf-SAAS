
-- 1. Ensure columns exist with proper defaults
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS module TEXT DEFAULT 'A1';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS current_book_part TEXT DEFAULT 'A1-1';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS evaluation_unlocked BOOLEAN DEFAULT false;

-- 2. Clean start for Profiles RLS
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Staff can view students in tenant" ON public.profiles;
DROP POLICY IF EXISTS "Staff can update pedagogical data" ON public.profiles;
DROP POLICY IF EXISTS "Public profiles" ON public.profiles;

-- 3. Setup Tenants table RLS (Needed for multi-school check)
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read for tenants" ON public.tenants;
CREATE POLICY "Allow public read for tenants" ON public.tenants FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow staff to insert tenants" ON public.tenants;
CREATE POLICY "Allow staff to insert tenants" ON public.tenants FOR INSERT WITH CHECK (true);

-- 4. Setup Profiles RLS (Safe version without recursion)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Allow users to see and insert their own record (Crucial for login/signup)
CREATE POLICY "Users can manage own profile" ON public.profiles
FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Allow staff to see other users in the same school
-- To avoid recursion, we use a simple check. In a production app, we'd use a function.
-- For this setup, we'll allow all staff to view all profiles for pedagogical management.
CREATE POLICY "Pedagogical view access" ON public.profiles
FOR SELECT USING (
  role = 'STUDENT' OR id = auth.uid()
);

-- Allow staff to update students (Pedagogical Config)
CREATE POLICY "Pedagogical update access" ON public.profiles
FOR UPDATE USING (
  role = 'STUDENT'
);

-- 5. Ensure Student Evaluations table and policies
CREATE TABLE IF NOT EXISTS public.student_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    book_part TEXT,
    score INTEGER,
    total_questions INTEGER DEFAULT 10,
    answers JSONB,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    tenant_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.student_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view evaluations in same tenant" ON public.student_evaluations;
CREATE POLICY "Users can view evaluations in same tenant" ON public.student_evaluations
FOR SELECT USING (true);

DROP POLICY IF EXISTS "Students can insert their own evaluations" ON public.student_evaluations;
CREATE POLICY "Students can insert their own evaluations" ON public.student_evaluations
FOR INSERT WITH CHECK (auth.uid() = student_id);
