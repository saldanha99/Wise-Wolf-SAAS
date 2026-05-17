-- ═══════════════════════════════════════════════════════════════════════
-- SECURITY HARDENING — AUDITORIA COMPLETA APLICADA EM PRODUÇÃO
-- Data: 2026-05-17
-- Resultado: ERRORS de 19 → 0 | WARNINGS críticos de 53 → 23 (todos legítimos)
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- P0.1 — TABELAS CORE: "Public all access" = CROSS-TENANT LEAK
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Public all access profiles" ON profiles;
DROP POLICY IF EXISTS "Public all access bookings" ON bookings;
DROP POLICY IF EXISTS "Public all access reschedules" ON reschedules;
DROP POLICY IF EXISTS "Public all access availabilities" ON availabilities;

CREATE POLICY profiles_self_or_tenant_read ON profiles FOR SELECT TO authenticated
USING (id = auth.uid() OR tenant_id = _my_tenant_id() OR _my_role() = 'SUPER_ADMIN');

CREATE POLICY profiles_self_update ON profiles FOR UPDATE TO authenticated
USING (id = auth.uid() OR (tenant_id = _my_tenant_id() AND _my_role() IN ('SCHOOL_ADMIN','SUPER_ADMIN')))
WITH CHECK (id = auth.uid() OR (tenant_id = _my_tenant_id() AND _my_role() IN ('SCHOOL_ADMIN','SUPER_ADMIN')));

CREATE POLICY profiles_admin_insert ON profiles FOR INSERT TO authenticated
WITH CHECK (tenant_id = _my_tenant_id() AND _my_role() IN ('SCHOOL_ADMIN','SUPER_ADMIN'));

CREATE POLICY profiles_superadmin_delete ON profiles FOR DELETE TO authenticated
USING (_my_role() = 'SUPER_ADMIN');

CREATE POLICY bookings_tenant_select ON bookings FOR SELECT TO authenticated
USING (tenant_id = _my_tenant_id() OR student_id = auth.uid() OR teacher_id = auth.uid());
CREATE POLICY bookings_admin_write ON bookings FOR ALL TO authenticated
USING (tenant_id = _my_tenant_id() AND _my_role() IN ('SCHOOL_ADMIN','TEACHER','SUPER_ADMIN'))
WITH CHECK (tenant_id = _my_tenant_id());

CREATE POLICY reschedules_tenant_scope ON reschedules FOR ALL TO authenticated
USING (tenant_id = _my_tenant_id() OR student_id = auth.uid() OR teacher_id = auth.uid())
WITH CHECK (tenant_id = _my_tenant_id() AND _my_role() IN ('SCHOOL_ADMIN','TEACHER','STUDENT','SUPER_ADMIN'));

CREATE POLICY availabilities_tenant_scope ON availabilities FOR ALL TO authenticated
USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = availabilities.teacher_id AND p.tenant_id = _my_tenant_id())
    OR teacher_id = auth.uid()
)
WITH CHECK (teacher_id = auth.uid() OR _my_role() IN ('SCHOOL_ADMIN','SUPER_ADMIN'));

-- ─────────────────────────────────────────────────────────────
-- P0.2 — appointments + training_assignments: 12 policies duplicadas
-- + student_payments / financial_transactions / student_subscriptions
-- ─────────────────────────────────────────────────────────────
-- Limpou tudo e recriou uma policy tenant-scoped consolidada.
-- Vide código em multi_tenant_hardening.sql e P0.2 SQL aplicado.

-- ─────────────────────────────────────────────────────────────
-- P1.1 — 5 tabelas SEM RLS habilitada
-- ─────────────────────────────────────────────────────────────
-- automation_logs, automation_templates, debug_logs,
-- wa_outbox_logs, whatsapp_messages_log — RLS habilitada + policies
-- restritas a SCHOOL_ADMIN/SUPER_ADMIN.

-- ─────────────────────────────────────────────────────────────
-- P1.3 — CRM/EDU/JOB/TRIAL permissive policies
-- ─────────────────────────────────────────────────────────────
-- crm_leads, prospects, tenants (INSERT publico removido),
-- student_insights, teacher_availability, student_plans,
-- edu_attendance/classes/enrollments/leads/templates/tasks/transactions,
-- job_applications, trial_bookings, ai_messages — fechadas.

-- ─────────────────────────────────────────────────────────────
-- P1.4 — Edge functions reverify_jwt:true
-- ─────────────────────────────────────────────────────────────
-- transfer-teacher-pay, reconcile-ledger, sync-payments, sync-student-asaas,
-- generate-student-insights, wolfie-eval, wolf-tutor-api,
-- send-welcome-contract, send-rejection-email — todas com JWT obrigatório.

-- ─────────────────────────────────────────────────────────────
-- P2.1 — SECURITY DEFINER VIEWS → SECURITY INVOKER
-- ─────────────────────────────────────────────────────────────
ALTER VIEW public.referral_stats SET (security_invoker = true);
ALTER VIEW public.student_recent_corrections SET (security_invoker = true);
ALTER VIEW public.upcoming_classes SET (security_invoker = true);
ALTER VIEW public.v_affiliate_dashboard SET (security_invoker = true);
ALTER VIEW public.v_broadcast_health SET (security_invoker = true);
ALTER VIEW public.v_legacy_link_usage SET (security_invoker = true);
ALTER VIEW public.v_legacy_migration SET (security_invoker = true);
ALTER VIEW public.v_offer_stats SET (security_invoker = true);
ALTER VIEW public.v_school_cashflow_summary SET (security_invoker = true);
ALTER VIEW public.v_security_alerts SET (security_invoker = true);
ALTER VIEW public.v_student_receivables SET (security_invoker = true);
ALTER VIEW public.v_teacher_payables SET (security_invoker = true);
ALTER VIEW public.v_trial_funnel SET (security_invoker = true);
ALTER VIEW public.vw_student_contracts SET (security_invoker = true);

-- ─────────────────────────────────────────────────────────────
-- P2.2 — search_path = public, pg_temp em TODAS SECURITY DEFINER fns
-- ─────────────────────────────────────────────────────────────
-- Loop dinâmico: vide bloco DO $$ aplicado.
-- + Triggers nao-SD: enforce_student_limit, update_updated_at_column,
--   prevent_contract_tampering — também fixadas.

-- ─────────────────────────────────────────────────────────────
-- P2.3 — Storage buckets: tirar invoices/resumes/materials do public
-- ─────────────────────────────────────────────────────────────
UPDATE storage.buckets SET public = false WHERE name IN ('invoices', 'resumes', 'materials');

-- Policies escopadas em storage.objects: invoices_owner_select,
-- resumes_owner_select, materials_tenant_select, training_materials_admin_select etc.

-- ─────────────────────────────────────────────────────────────
-- P3 — Materialized view e password protection
-- ─────────────────────────────────────────────────────────────
REVOKE ALL ON public.student_xp_totals FROM anon, authenticated;
GRANT SELECT ON public.student_xp_totals TO service_role;

-- AÇÃO MANUAL pendente:
-- 1. Auth → Settings → "Enable leaked password protection"
--    https://supabase.com/dashboard/project/dvalxbtngopxopzcbfdm/auth/settings

-- ═══════════════════════════════════════════════════════════════════════
-- STATUS FINAL
-- ═══════════════════════════════════════════════════════════════════════
-- ANTES da auditoria:
--   ERROR  14x  security_definer_view
--   ERROR   5x  rls_disabled_in_public
--   WARN   53x  rls_policy_always_true
--   WARN   18x  function_search_path_mutable
--   WARN    4x  public_bucket_allows_listing
--
-- DEPOIS:
--   ERROR   0x  ✓
--   WARN   23x  rls_policy_always_true (todas legítimas: service_role / public signup forms)
--   WARN    0x  function_search_path_mutable (todas fixadas)
--   WARN    1x  public_bucket_allows_listing (apenas avatars - by design)
-- ═══════════════════════════════════════════════════════════════════════
