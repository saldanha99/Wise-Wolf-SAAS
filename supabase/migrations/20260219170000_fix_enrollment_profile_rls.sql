-- =====================================================
-- FIX: Profile creation and update during enrollment
-- 1. Recreate handle_new_user trigger to read metadata
-- 2. Add RLS policies for INSERT/UPDATE on own profile
-- =====================================================

-- 1. Improved trigger that reads user metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, tenant_id, status_financial)
  VALUES (
      new.id, 
      new.email, 
      COALESCE(new.raw_user_meta_data ->> 'full_name', 'Novo Usuário'), 
      COALESCE(new.raw_user_meta_data ->> 'role', 'STUDENT'),
      COALESCE(new.raw_user_meta_data ->> 'tenant_id', 'school-wise-wolf'),
      'PENDING'
  )
  ON CONFLICT (id) DO NOTHING; -- Don't overwrite if profile already exists
  RETURN new;
END;
$$;

-- Re-create trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 2. RLS Policies for profiles: Allow users to manage their own profile
-- Users can UPDATE their own profile row
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile"
ON public.profiles FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- Users can INSERT their own profile (for upsert to work)
DROP POLICY IF EXISTS "Users insert own profile" ON public.profiles;
CREATE POLICY "Users insert own profile"
ON public.profiles FOR INSERT
TO authenticated
WITH CHECK (id = auth.uid());
