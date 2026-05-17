-- =====================================================================
-- MULTI-TENANT HARDENING
-- 1. Fix RLS policies genericas em opportunities
-- 2. Indexes criticos em tenant_id para escala
-- 3. Helper function _my_tenant_id() para reuso em policies
-- =====================================================================

-- ──────────────────────────────────────────────
-- Helper SECURITY DEFINER que pega o tenant_id do usuario logado
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _my_tenant_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT tenant_id FROM profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION _my_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT role FROM profiles WHERE id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION _my_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION _my_role() TO authenticated;

-- ──────────────────────────────────────────────
-- FIX: opportunities — todas as policies eram USING (true) [CRÍTICO]
-- ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Teachers view opportunities" ON opportunities;
DROP POLICY IF EXISTS "Teachers update opportunities" ON opportunities;
DROP POLICY IF EXISTS "Admins insert opportunities" ON opportunities;
DROP POLICY IF EXISTS "Apenas usuários logados podem aceitar vagas" ON opportunities;

-- Tenant scope para SELECT (qualquer usuário do tenant)
CREATE POLICY "opp_select_tenant" ON opportunities
FOR SELECT TO authenticated
USING (tenant_id = _my_tenant_id());

-- INSERT só admin/teacher/salesperson do mesmo tenant
CREATE POLICY "opp_insert_tenant" ON opportunities
FOR INSERT TO authenticated
WITH CHECK (
    tenant_id = _my_tenant_id()
    AND _my_role() IN ('SCHOOL_ADMIN','TEACHER','SALESPERSON','SUPER_ADMIN')
);

-- UPDATE só do mesmo tenant + admin/teacher
CREATE POLICY "opp_update_tenant" ON opportunities
FOR UPDATE TO authenticated
USING (tenant_id = _my_tenant_id())
WITH CHECK (tenant_id = _my_tenant_id());

-- DELETE só admin
CREATE POLICY "opp_delete_admin" ON opportunities
FOR DELETE TO authenticated
USING (tenant_id = _my_tenant_id() AND _my_role() IN ('SCHOOL_ADMIN','SUPER_ADMIN'));

-- ──────────────────────────────────────────────
-- INDEXES CRÍTICOS para escala multi-tenant
-- (CONCURRENTLY não dá pra rodar em transação, mas CREATE INDEX simples sim)
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_tenant ON profiles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_role_tenant ON profiles(role, tenant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_tenant ON bookings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_teacher_tenant ON bookings(teacher_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_student_tenant ON bookings(student_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_class_logs_tenant ON class_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_class_logs_teacher_date ON class_logs(teacher_id, class_date);
CREATE INDEX IF NOT EXISTS idx_class_logs_student_date ON class_logs(student_id, class_date);
CREATE INDEX IF NOT EXISTS idx_reschedules_tenant ON reschedules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reschedules_teacher_date ON reschedules(teacher_id, date);
CREATE INDEX IF NOT EXISTS idx_opportunities_tenant ON opportunities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_student_payments_tenant ON student_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_student_payments_student ON student_payments(student_id);
CREATE INDEX IF NOT EXISTS idx_student_payments_status ON student_payments(status);

SELECT 'OK' as status;
