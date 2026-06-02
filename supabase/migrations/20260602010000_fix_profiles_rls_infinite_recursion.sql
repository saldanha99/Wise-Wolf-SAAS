-- Corrige "infinite recursion detected in policy for relation profiles".
-- 4 policies de UPDATE faziam SELECT ... FROM profiles dentro da própria policy
-- (auto-referência → recursão infinita), estourando 500 em qualquer UPDATE/upsert
-- de perfil sob RLS (incluindo a matrícula pelo formulário público).
-- Substituídas por versões com os helpers SECURITY DEFINER já existentes
-- (_my_role() / _my_tenant_id()), que NÃO recursam. Comportamento preservado.

DROP POLICY IF EXISTS "Admins can update all profiles in tenant" ON public.profiles;
CREATE POLICY "Admins can update all profiles in tenant" ON public.profiles
  FOR UPDATE
  USING (_my_role() = 'SCHOOL_ADMIN' AND tenant_id = _my_tenant_id())
  WITH CHECK (_my_role() = 'SCHOOL_ADMIN' AND tenant_id = _my_tenant_id());

DROP POLICY IF EXISTS "Secure: Update Student Unlocks" ON public.profiles;
CREATE POLICY "Secure: Update Student Unlocks" ON public.profiles
  FOR UPDATE
  USING (tenant_id = _my_tenant_id() AND _my_role() = ANY (ARRAY['TEACHER','SCHOOL_ADMIN','SUPER_ADMIN']))
  WITH CHECK (tenant_id = _my_tenant_id());

DROP POLICY IF EXISTS "Teachers can update student modules" ON public.profiles;
CREATE POLICY "Teachers can update student modules" ON public.profiles
  FOR UPDATE
  USING (_my_role() = 'TEACHER' AND role = 'STUDENT' AND tenant_id = _my_tenant_id())
  WITH CHECK (_my_role() = 'TEACHER' AND role = 'STUDENT' AND tenant_id = _my_tenant_id());

DROP POLICY IF EXISTS "Teachers update unlocked_tests" ON public.profiles;
CREATE POLICY "Teachers update unlocked_tests" ON public.profiles
  FOR UPDATE
  USING (role = 'STUDENT')
  WITH CHECK (_my_role() = ANY (ARRAY['TEACHER','SCHOOL_ADMIN','SUPER_ADMIN']));
