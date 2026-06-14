-- VAZAMENTO CROSS-TENANT (LGPD / isolamento multi-tenant).
-- profiles e student_payments tinham policies SELECT USING(true) que deixavam
-- QUALQUER usuario logado (de qualquer escola) ler TODOS os perfis de TODOS os
-- tenants (cpf, pix_key, hourly_rate, commission_rate, endereco, phone) e TODAS
-- as mensalidades. As policies tenant-scoped corretas JA EXISTEM:
--   profiles:          profiles_self_or_tenant_read (self OR tenant OR SUPER_ADMIN),
--                      "Profiles: Tenant isolation" (tenant_id = get_auth_tenant_id())
--   student_payments:  sp_select_tenant (tenant OR proprio), "Students view own payments"
-- Logo, basta REMOVER as permissivas. Validado em dry-run (ROLLBACK) com JWT real:
--   - STUDENT school-wise-wolf: 73 -> 68 perfis (so o proprio tenant), 0 cross-tenant.
--   - SUPER_ADMIN: 73 perfis / 4 tenants (SaaS dashboard intacto).
--
-- NOTA (fase 2, nao incluida aqui): dentro do tenant, um STUDENT ainda enxerga
-- hourly_rate/pix de professores e mensalidades de outros alunos. Restringir por
-- coluna/papel exige mudanca coordenada no frontend (App.tsx faz select('*') em
-- profiles de professores) e deve ser feita com teste de UI.

DROP POLICY IF EXISTS "Public Read" ON public.profiles;
DROP POLICY IF EXISTS "Allow authenticated read" ON public.profiles;
DROP POLICY IF EXISTS "Public read for students" ON public.profiles;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.student_payments;
