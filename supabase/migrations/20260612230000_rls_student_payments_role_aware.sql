-- FASE 2 RLS — student_payments por papel (dentro do tenant).
-- Antes: "Admins view all payments" usava is_school_admin() SEM filtro de tenant
-- (admin de uma escola via pagamentos de OUTRA) e sp_select_tenant dava leitura
-- tenant-wide a QUALQUER authenticated (um aluno via a mensalidade dos colegas).
-- Agora: aluno só os próprios; SCHOOL_ADMIN/COORDINATOR só do seu tenant;
-- SUPER_ADMIN todos. Escrita segue por sp_write_admin (tenant+admin).
-- Validado em dry-run: ALUNO 169->6 (0 de outros alunos), ADMIN 169 (0 cross-tenant).

DROP POLICY IF EXISTS "Admins view all payments" ON public.student_payments;
DROP POLICY IF EXISTS sp_select_tenant ON public.student_payments;
DROP POLICY IF EXISTS "Students view own payments" ON public.student_payments;

CREATE POLICY sp_select_scoped ON public.student_payments FOR SELECT TO authenticated
USING (
  student_id = (SELECT auth.uid())
  OR _my_role() = 'SUPER_ADMIN'
  OR (_my_role() IN ('SCHOOL_ADMIN','COORDINATOR') AND tenant_id = _my_tenant_id())
);
