-- FIX ORPHANED PROFILES & SETUP TRIGGERS
-- Manual rescue of admin profiles and restoring the auto-create trigger.

-- 1. Inserir perfil do DIRETOR
-- Note: Mapped 'DIRECTOR' to 'SCHOOL_ADMIN' to match existing CHECK constraint on profiles table.
INSERT INTO public.profiles (id, email, full_name, role, tenant_id, status_financial)
SELECT id, email, 'Diretor Wise Wolf', 'SCHOOL_ADMIN', 'school-wise-wolf', 'ACTIVE'
FROM auth.users
WHERE email = 'wisewolflanguague@gmail.com'
ON CONFLICT (id) DO UPDATE
SET role = 'SCHOOL_ADMIN',
    full_name = 'Diretor Wise Wolf',
    tenant_id = 'school-wise-wolf',
    status_financial = 'ACTIVE';

-- 2. Inserir perfil do SUPER ADMIN
INSERT INTO public.profiles (id, email, full_name, role, tenant_id, status_financial)
SELECT id, email, 'Super Admin', 'SUPER_ADMIN', 'school-wise-wolf', 'ACTIVE'
FROM auth.users
WHERE email = 'saldanha372@gmail.com'
ON CONFLICT (id) DO UPDATE
SET role = 'SUPER_ADMIN',
    full_name = 'Super Admin',
    tenant_id = 'school-wise-wolf',
    status_financial = 'ACTIVE';

-- 3. Prevenção Futura (Trigger)
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
      'STUDENT', -- Default Role
      'school-wise-wolf', -- Default Tenant
      'ACTIVE'
  );
  RETURN new;
END;
$$;

-- Ativar a trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
