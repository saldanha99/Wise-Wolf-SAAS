-- P0 multitenant hardening for the self-hosted Supabase stack.
-- This migration intentionally keeps the shared pedagogical materials bucket
-- publicly readable, but removes every anonymous write path.

-- Future objects must be explicitly exposed. RLS and explicit grants are the
-- authorization boundary, not the broad Supabase bootstrap defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Credentials are moved out of the exposed public schema before their legacy
-- columns are cleared. The private copy remains available for controlled
-- server-side migrations and is excluded from PostgREST's exposed schemas.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
CREATE TABLE IF NOT EXISTS private.tenant_integration_secrets (
  tenant_id text PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  whatsapp_api_key text,
  asaas_api_key text,
  migrated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.profile_integration_secrets (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  whatsapp_token text,
  migrated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE private.tenant_integration_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.profile_integration_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE private.tenant_integration_secrets TO service_role;
GRANT ALL ON TABLE private.profile_integration_secrets TO service_role;
INSERT INTO private.tenant_integration_secrets (
  tenant_id, whatsapp_api_key, asaas_api_key
)
SELECT id, whatsapp_api_key, asaas_api_key_encrypted
FROM public.tenants
WHERE nullif(whatsapp_api_key, '') IS NOT NULL
   OR nullif(asaas_api_key_encrypted, '') IS NOT NULL
ON CONFLICT (tenant_id) DO UPDATE
SET whatsapp_api_key = COALESCE(
      EXCLUDED.whatsapp_api_key,
      private.tenant_integration_secrets.whatsapp_api_key
    ),
    asaas_api_key = COALESCE(
      EXCLUDED.asaas_api_key,
      private.tenant_integration_secrets.asaas_api_key
    ),
    migrated_at = now();
INSERT INTO private.profile_integration_secrets (profile_id, whatsapp_token)
SELECT id, whatsapp_token
FROM public.profiles
WHERE nullif(whatsapp_token, '') IS NOT NULL
ON CONFLICT (profile_id) DO UPDATE
SET whatsapp_token = COALESCE(
      EXCLUDED.whatsapp_token,
      private.profile_integration_secrets.whatsapp_token
    ),
    migrated_at = now();
UPDATE public.tenants
SET whatsapp_api_key = NULL,
    asaas_api_key_encrypted = NULL
WHERE whatsapp_api_key IS NOT NULL OR asaas_api_key_encrypted IS NOT NULL;
UPDATE public.profiles
SET whatsapp_token = NULL
WHERE whatsapp_token IS NOT NULL;

-- Internal/backup tables are never client APIs. Enabling RLS without policies
-- gives them a deny-by-default boundary in addition to revoked privileges.
DO $block$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    '_hr_drain_state',
    'class_logs_audit_dup_backup_20260705',
    'financial_transactions_backup_20260703',
    'placeholder_students_backup_20260707',
    'wa_inbound_seen'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END
$block$;

-- Public referrals are accepted only through the validated Edge Function.
-- Direct anonymous inserts could manufacture arbitrary records and trigger
-- messaging abuse.
DROP POLICY IF EXISTS public_insert_referral_invite ON public.referral_invites;
REVOKE INSERT, UPDATE, DELETE ON public.referral_invites FROM anon;
CREATE TABLE IF NOT EXISTS public.referral_submission_limits (
  rate_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.referral_submission_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.referral_submission_limits FROM anon, authenticated;
GRANT ALL ON TABLE public.referral_submission_limits TO service_role;

-- High-risk SECURITY DEFINER helpers are internal-only.
REVOKE ALL ON FUNCTION public.central_instance_for_tenant(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.central_instance_for_tenant(text) TO service_role;
REVOKE ALL ON FUNCTION public.get_user_id_by_email(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(text) TO service_role;

-- Public white-label lookup. Only the fields required before login are
-- returned; tenant credentials and ownership data never cross the API.
CREATE OR REPLACE FUNCTION public.resolve_public_tenant(p_hostname text)
RETURNS TABLE (
  id text,
  name text,
  slug text,
  custom_domain text,
  custom_domain_verified boolean,
  branding jsonb,
  school_info jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH normalized AS (
    SELECT lower(trim(trailing '.' FROM trim(p_hostname))) AS hostname
  )
  SELECT
    tenant.id,
    tenant.name,
    tenant.slug,
    tenant.custom_domain,
    tenant.custom_domain_verified,
    tenant.branding,
    tenant.school_info
  FROM public.tenants AS tenant
  CROSS JOIN normalized
  WHERE normalized.hostname <> ''
    AND (
      (
        normalized.hostname LIKE '%.wisewolflanguage.com.br'
        AND tenant.slug = split_part(normalized.hostname, '.', 1)
      )
      OR (
        tenant.custom_domain_verified IS TRUE
        AND lower(trim(trailing '.' FROM tenant.custom_domain)) = normalized.hostname
      )
    )
  ORDER BY tenant.custom_domain_verified DESC
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.resolve_public_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_public_tenant(text) TO anon, authenticated;

-- Authenticated users receive a deliberately small tenant configuration.
-- Direct access to tenants is reserved for school/super administrators.
CREATE OR REPLACE FUNCTION public.get_my_tenant_config()
RETURNS TABLE (
  id text,
  name text,
  domain text,
  branding jsonb,
  student_limit integer,
  teacher_limit integer,
  whatsapp_enabled boolean,
  school_info jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    tenant.id,
    tenant.name,
    tenant.domain,
    tenant.branding,
    tenant.student_limit,
    tenant.teacher_limit,
    tenant.whatsapp_enabled,
    tenant.school_info
  FROM public.profiles AS caller
  JOIN public.tenants AS tenant ON tenant.id = caller.tenant_id
  WHERE caller.id = (SELECT auth.uid())
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.get_my_tenant_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_tenant_config() TO authenticated;

DROP POLICY IF EXISTS tenants_select_self ON public.tenants;
CREATE POLICY tenants_admin_select
ON public.tenants FOR SELECT TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
);

-- Profile rows contain personal, banking and contractual data. Students and
-- non-student Hub users can read only themselves; tenant staff retain the
-- operational directory they need, and superadmin retains global oversight.
DROP POLICY IF EXISTS "Profiles: Tenant isolation" ON public.profiles;
DROP POLICY IF EXISTS profiles_self_or_tenant_read ON public.profiles;
DROP POLICY IF EXISTS "Usuarios leem proprio profile" ON public.profiles;
CREATE POLICY profiles_scoped_read_p0
ON public.profiles FOR SELECT TO authenticated
USING (
  id = (SELECT auth.uid())
  OR public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN')
  )
);

-- Student-facing directory/leaderboard RPCs expose only the few display
-- fields required by the UI, without opening full profile rows.
CREATE OR REPLACE FUNCTION public.get_my_teacher_directory()
RETURNS TABLE (
  id uuid,
  full_name text,
  phone text,
  avatar_url text,
  meeting_link text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH caller AS (
    SELECT profile.id, profile.tenant_id, profile.professor_id, profile.professor_id2
    FROM public.profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND profile.role = 'STUDENT'
  ), teacher_ids AS (
    SELECT professor_id AS teacher_id FROM caller WHERE professor_id IS NOT NULL
    UNION
    SELECT professor_id2 FROM caller WHERE professor_id2 IS NOT NULL
    UNION
    SELECT booking.teacher_id
    FROM public.bookings AS booking
    JOIN caller ON caller.id = booking.student_id
  )
  SELECT teacher.id, teacher.full_name, teacher.phone, teacher.avatar_url, teacher.meeting_link
  FROM public.profiles AS teacher
  JOIN teacher_ids ON teacher_ids.teacher_id = teacher.id
  JOIN caller ON caller.tenant_id = teacher.tenant_id
  WHERE teacher.role = 'TEACHER';
$function$;
REVOKE ALL ON FUNCTION public.get_my_teacher_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_teacher_directory() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_tenant_leaderboard(p_limit integer DEFAULT 5)
RETURNS TABLE (full_name text, xp integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    COALESCE(NULLIF(student.league_display_name, ''), split_part(student.full_name, ' ', 1)) AS full_name,
    COALESCE(student.xp, 0) AS xp
  FROM public.profiles AS caller
  JOIN public.profiles AS student
    ON student.tenant_id = caller.tenant_id
   AND student.role = 'STUDENT'
  WHERE caller.id = (SELECT auth.uid())
    AND caller.role = 'STUDENT'
  ORDER BY COALESCE(student.xp, 0) DESC, student.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20);
$function$;
REVOKE ALL ON FUNCTION public.get_my_tenant_leaderboard(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_tenant_leaderboard(integer) TO authenticated;

-- RLS decides which profile row can be updated. This trigger also protects
-- high-value columns inside an otherwise legitimate row update.
CREATE OR REPLACE FUNCTION public.enforce_profile_authorization_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  actor_role text;
  privileged_runtime boolean := current_user IN ('postgres', 'service_role', 'supabase_admin');
BEGIN
  IF privileged_runtime THEN RETURN NEW; END IF;

  SELECT profile.role INTO actor_role
  FROM public.profiles AS profile
  WHERE profile.id = actor_id;
  IF actor_role = 'SUPER_ADMIN' THEN RETURN NEW; END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.whatsapp_instance IS DISTINCT FROM OLD.whatsapp_instance
     OR NEW.whatsapp_instance_id IS DISTINCT FROM OLD.whatsapp_instance_id
     OR NEW.whatsapp_instance_name IS DISTINCT FROM OLD.whatsapp_instance_name
     OR NEW.whatsapp_token IS DISTINCT FROM OLD.whatsapp_token THEN
    RAISE EXCEPTION 'authorization-managed profile fields cannot be changed by this role'
      USING ERRCODE = '42501';
  END IF;

  IF actor_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN') THEN
    IF NEW.monthly_fee IS DISTINCT FROM OLD.monthly_fee
       OR NEW.monthly_tuition IS DISTINCT FROM OLD.monthly_tuition
       OR NEW.due_day IS DISTINCT FROM OLD.due_day
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.asaas_customer_id IS DISTINCT FROM OLD.asaas_customer_id
       OR NEW.status_financial IS DISTINCT FROM OLD.status_financial
       OR NEW.enrollment_fee IS DISTINCT FROM OLD.enrollment_fee
       OR NEW.enrollment_fee_paid IS DISTINCT FROM OLD.enrollment_fee_paid
       OR NEW.enrollment_payment_id IS DISTINCT FROM OLD.enrollment_payment_id
       OR NEW.paid_through IS DISTINCT FROM OLD.paid_through
       OR NEW.prepaid_months IS DISTINCT FROM OLD.prepaid_months
       OR NEW.hourly_rate IS DISTINCT FROM OLD.hourly_rate
       OR NEW.commission_rate IS DISTINCT FROM OLD.commission_rate THEN
      RAISE EXCEPTION 'financial profile fields cannot be changed by this role'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF actor_role = 'TEACHER' AND OLD.id <> actor_id THEN
    IF NEW.email IS DISTINCT FROM OLD.email
       OR NEW.phone IS DISTINCT FROM OLD.phone
       OR NEW.cpf IS DISTINCT FROM OLD.cpf
       OR NEW.rg IS DISTINCT FROM OLD.rg
       OR NEW.birth_date IS DISTINCT FROM OLD.birth_date
       OR NEW.address IS DISTINCT FROM OLD.address
       OR NEW.address_number IS DISTINCT FROM OLD.address_number
       OR NEW.postal_code IS DISTINCT FROM OLD.postal_code
       OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
       OR NEW.agency IS DISTINCT FROM OLD.agency
       OR NEW.account_number IS DISTINCT FROM OLD.account_number
       OR NEW.pix_key IS DISTINCT FROM OLD.pix_key
       OR NEW.guardian_cpf IS DISTINCT FROM OLD.guardian_cpf
       OR NEW.guardian_email IS DISTINCT FROM OLD.guardian_email
       OR NEW.private_notes IS DISTINCT FROM OLD.private_notes THEN
      RAISE EXCEPTION 'private profile fields cannot be changed by a teacher'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Finance must be scoped by the row tenant. Permissive policies are ORed, so
-- all historical unscoped policies have to be removed.
DROP POLICY IF EXISTS "Admins manage transactions" ON public.financial_transactions;
DROP POLICY IF EXISTS "Admins view all transactions" ON public.financial_transactions;
DROP POLICY IF EXISTS "Admins can view transactions from their tenant" ON public.financial_transactions;
DROP POLICY IF EXISTS "Super Admins can view all transactions" ON public.financial_transactions;
DROP POLICY IF EXISTS ft_admin_only ON public.financial_transactions;
CREATE POLICY financial_transactions_tenant_admin
ON public.financial_transactions
FOR ALL
TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() = 'SCHOOL_ADMIN'
  )
)
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() = 'SCHOOL_ADMIN'
  )
);

DROP POLICY IF EXISTS "Admins manage issues" ON public.reconciliation_issues;
DROP POLICY IF EXISTS "Admins view issues" ON public.reconciliation_issues;
CREATE POLICY reconciliation_issues_tenant_admin
ON public.reconciliation_issues
FOR ALL
TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
)
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
);

DROP POLICY IF EXISTS "Admins manage contracts" ON public.teacher_contracts;
CREATE POLICY teacher_contracts_tenant_admin
ON public.teacher_contracts
FOR ALL
TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
)
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
);

DROP POLICY IF EXISTS "Admins manage closings" ON public.teacher_closings;
DROP POLICY IF EXISTS "Admins manage all closings" ON public.teacher_closings;
DROP POLICY IF EXISTS "Admins can manage all closings in their tenant" ON public.teacher_closings;
CREATE POLICY teacher_closings_tenant_admin
ON public.teacher_closings
FOR ALL
TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
)
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
);

-- Class logs: students see/update their own row; teachers only manage rows in
-- their tenant; school admins stay inside their tenant; superadmin is global.
DO $block$
DECLARE policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'class_logs'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.class_logs', policy_row.policyname);
  END LOOP;
END
$block$;
CREATE POLICY class_logs_select_scoped
ON public.class_logs FOR SELECT TO authenticated
USING (
  student_id = (SELECT auth.uid())
  OR teacher_id = (SELECT auth.uid())
  OR public._my_role() = 'SUPER_ADMIN'
  OR (tenant_id = public._my_tenant_id() AND public._my_role() = 'SCHOOL_ADMIN')
);
CREATE POLICY class_logs_staff_insert
ON public.class_logs FOR INSERT TO authenticated
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND (
      public._my_role() = 'SCHOOL_ADMIN'
      OR (public._my_role() = 'TEACHER' AND teacher_id = (SELECT auth.uid()))
    )
  )
);
CREATE POLICY class_logs_update_scoped
ON public.class_logs FOR UPDATE TO authenticated
USING (
  student_id = (SELECT auth.uid())
  OR public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND (
      public._my_role() = 'SCHOOL_ADMIN'
      OR (public._my_role() = 'TEACHER' AND teacher_id = (SELECT auth.uid()))
    )
  )
)
WITH CHECK (
  student_id = (SELECT auth.uid())
  OR public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND (
      public._my_role() = 'SCHOOL_ADMIN'
      OR (public._my_role() = 'TEACHER' AND teacher_id = (SELECT auth.uid()))
    )
  )
);
CREATE POLICY class_logs_staff_delete
ON public.class_logs FOR DELETE TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND (
      public._my_role() = 'SCHOOL_ADMIN'
      OR (public._my_role() = 'TEACHER' AND teacher_id = (SELECT auth.uid()))
    )
  )
);

-- Assignments have no tenant column, so tenant scope is inherited from the
-- referenced student profile and writes are limited to staff.
DO $block$
DECLARE policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'student_assignments'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.student_assignments', policy_row.policyname);
  END LOOP;
END
$block$;
CREATE POLICY student_assignments_select_scoped
ON public.student_assignments FOR SELECT TO authenticated
USING (
  student_id = (SELECT auth.uid())
  OR assigned_by = (SELECT auth.uid())
  OR public._my_role() = 'SUPER_ADMIN'
  OR (
    public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    AND EXISTS (
      SELECT 1 FROM public.profiles AS student
      WHERE student.id = student_assignments.student_id
        AND student.tenant_id = public._my_tenant_id()
    )
  )
);
CREATE POLICY student_assignments_staff_insert
ON public.student_assignments FOR INSERT TO authenticated
WITH CHECK (
  assigned_by = (SELECT auth.uid())
  AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (
    public._my_role() = 'SUPER_ADMIN'
    OR EXISTS (
      SELECT 1 FROM public.profiles AS student
      WHERE student.id = student_assignments.student_id
        AND student.tenant_id = public._my_tenant_id()
    )
  )
);
CREATE POLICY student_assignments_staff_update
ON public.student_assignments FOR UPDATE TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    AND EXISTS (
      SELECT 1 FROM public.profiles AS student
      WHERE student.id = student_assignments.student_id
        AND student.tenant_id = public._my_tenant_id()
    )
  )
)
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    AND EXISTS (
      SELECT 1 FROM public.profiles AS student
      WHERE student.id = student_assignments.student_id
        AND student.tenant_id = public._my_tenant_id()
    )
  )
);
CREATE POLICY student_assignments_staff_delete
ON public.student_assignments FOR DELETE TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN')
    AND EXISTS (
      SELECT 1 FROM public.profiles AS student
      WHERE student.id = student_assignments.student_id
        AND student.tenant_id = public._my_tenant_id()
    )
  )
);

-- Trial bookings gain an explicit tenant boundary. The trigger derives the
-- tenant from the selected teacher and rejects mismatched client input.
ALTER TABLE public.trial_bookings ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE public.trial_bookings AS booking
SET tenant_id = teacher.tenant_id
FROM public.profiles AS teacher
WHERE teacher.id = booking.teacher_id
  AND booking.tenant_id IS NULL;
ALTER TABLE public.trial_bookings
  ADD CONSTRAINT trial_bookings_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) NOT VALID;
CREATE INDEX IF NOT EXISTS trial_bookings_tenant_id_idx
  ON public.trial_bookings (tenant_id);

CREATE OR REPLACE FUNCTION public.set_trial_booking_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE teacher_tenant text;
BEGIN
  SELECT profile.tenant_id INTO teacher_tenant
  FROM public.profiles AS profile
  WHERE profile.id = NEW.teacher_id;

  IF teacher_tenant IS NULL THEN
    RAISE EXCEPTION 'trial booking teacher has no tenant' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id <> teacher_tenant THEN
    RAISE EXCEPTION 'trial booking tenant mismatch' USING ERRCODE = '42501';
  END IF;
  NEW.tenant_id := teacher_tenant;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_trial_booking_tenant() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS derive_trial_booking_tenant ON public.trial_bookings;
CREATE TRIGGER derive_trial_booking_tenant
BEFORE INSERT OR UPDATE OF teacher_id, tenant_id ON public.trial_bookings
FOR EACH ROW EXECUTE FUNCTION public.set_trial_booking_tenant();

DROP POLICY IF EXISTS "Trial bookings are viewable by authenticated users" ON public.trial_bookings;
DROP POLICY IF EXISTS trial_bookings_admin_update ON public.trial_bookings;
DROP POLICY IF EXISTS trial_bookings_admin_write ON public.trial_bookings;
CREATE POLICY trial_bookings_tenant_select
ON public.trial_bookings FOR SELECT TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR teacher_id = (SELECT auth.uid())
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() IN ('SCHOOL_ADMIN', 'SALESPERSON', 'COMMERCIAL')
  )
);
CREATE POLICY trial_bookings_tenant_insert
ON public.trial_bookings FOR INSERT TO authenticated
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'SALESPERSON', 'COMMERCIAL')
  )
);
CREATE POLICY trial_bookings_tenant_update
ON public.trial_bookings FOR UPDATE TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR teacher_id = (SELECT auth.uid())
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() IN ('SCHOOL_ADMIN', 'SALESPERSON', 'COMMERCIAL')
  )
)
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'SALESPERSON', 'COMMERCIAL')
  )
);

-- Storage least privilege. Existing objects have no owner metadata, therefore
-- invoices/contracts are scoped using the established UUID-based paths.
DROP POLICY IF EXISTS "Full Access Materials b9j0vg_0" ON storage.objects;
DROP POLICY IF EXISTS "Full Access Materials b9j0vg_1" ON storage.objects;
DROP POLICY IF EXISTS "Full Access Materials b9j0vg_2" ON storage.objects;
DROP POLICY IF EXISTS "Full Access Materials b9j0vg_3" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Upload to Materials" ON storage.objects;
DROP POLICY IF EXISTS "Public Access to Materials" ON storage.objects;
DROP POLICY IF EXISTS "Give public access to materials" ON storage.objects;
DROP POLICY IF EXISTS materials_admin_write ON storage.objects;
DROP POLICY IF EXISTS materials_tenant_select ON storage.objects;
CREATE POLICY materials_public_read
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'materials');
CREATE POLICY materials_staff_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'materials'
  AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
);
CREATE POLICY materials_staff_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'materials'
  AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
)
WITH CHECK (
  bucket_id = 'materials'
  AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
);
CREATE POLICY materials_staff_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'materials'
  AND public._my_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
);

DROP POLICY IF EXISTS "Public Read Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Update Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Upload Invoices" ON storage.objects;
DROP POLICY IF EXISTS "Owner Delete Invoices" ON storage.objects;
DROP POLICY IF EXISTS invoices_owner_insert ON storage.objects;
DROP POLICY IF EXISTS invoices_owner_select ON storage.objects;
CREATE POLICY invoices_scoped_select
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'invoices'
  AND (
    (storage.foldername(name))[1] = 'user_' || replace((SELECT auth.uid())::text, '-', '')
    OR public._my_role() = 'SUPER_ADMIN'
    OR (
      public._my_role() = 'SCHOOL_ADMIN'
      AND EXISTS (
        SELECT 1 FROM public.profiles AS profile
        WHERE 'user_' || replace(profile.id::text, '-', '') = (storage.foldername(name))[1]
          AND profile.tenant_id = public._my_tenant_id()
      )
    )
  )
);
CREATE POLICY invoices_scoped_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'invoices'
  AND (
    (storage.foldername(name))[1] = 'user_' || replace((SELECT auth.uid())::text, '-', '')
    OR public._my_role() = 'SUPER_ADMIN'
    OR (
      public._my_role() = 'SCHOOL_ADMIN'
      AND EXISTS (
        SELECT 1 FROM public.profiles AS profile
        WHERE 'user_' || replace(profile.id::text, '-', '') = (storage.foldername(name))[1]
          AND profile.tenant_id = public._my_tenant_id()
      )
    )
  )
);
CREATE POLICY invoices_scoped_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'invoices'
  AND (
    (storage.foldername(name))[1] = 'user_' || replace((SELECT auth.uid())::text, '-', '')
    OR public._my_role() = 'SUPER_ADMIN'
  )
)
WITH CHECK (
  bucket_id = 'invoices'
  AND (
    (storage.foldername(name))[1] = 'user_' || replace((SELECT auth.uid())::text, '-', '')
    OR public._my_role() = 'SUPER_ADMIN'
  )
);
CREATE POLICY invoices_scoped_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'invoices'
  AND (
    (storage.foldername(name))[1] = 'user_' || replace((SELECT auth.uid())::text, '-', '')
    OR public._my_role() = 'SUPER_ADMIN'
  )
);

DROP POLICY IF EXISTS "Authenticated users can view contract files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update contract files" ON storage.objects;
DROP POLICY IF EXISTS "Students can upload contract files" ON storage.objects;
DROP POLICY IF EXISTS "Admins read contracts" ON storage.objects;
CREATE POLICY contracts_scoped_select
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'contracts'
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR public._my_role() = 'SUPER_ADMIN'
    OR (
      public._my_role() = 'SCHOOL_ADMIN'
      AND EXISTS (
        SELECT 1 FROM public.profiles AS profile
        WHERE profile.id::text = (storage.foldername(name))[2]
          AND profile.tenant_id = public._my_tenant_id()
      )
    )
  )
);
CREATE POLICY contracts_scoped_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'contracts'
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR public._my_role() = 'SUPER_ADMIN'
    OR (
      public._my_role() = 'SCHOOL_ADMIN'
      AND EXISTS (
        SELECT 1 FROM public.profiles AS profile
        WHERE profile.id::text = (storage.foldername(name))[2]
          AND profile.tenant_id = public._my_tenant_id()
      )
    )
  )
);
CREATE POLICY contracts_scoped_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'contracts'
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR public._my_role() = 'SUPER_ADMIN'
  )
)
WITH CHECK (
  bucket_id = 'contracts'
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR public._my_role() = 'SUPER_ADMIN'
  )
);

-- Remove globally authenticated write access from staff training content.
DROP POLICY IF EXISTS "Anyone can view training materials" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete training materials" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update training materials" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload training materials" ON storage.objects;
DROP POLICY IF EXISTS training_materials_admin_select ON storage.objects;
DROP POLICY IF EXISTS training_materials_admin_write ON storage.objects;
CREATE POLICY training_materials_staff_select
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'training_materials'
  AND public._my_role() IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
);
CREATE POLICY training_materials_admin_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'training_materials'
  AND public._my_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
);
CREATE POLICY training_materials_admin_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'training_materials'
  AND public._my_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
)
WITH CHECK (
  bucket_id = 'training_materials'
  AND public._my_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
);
CREATE POLICY training_materials_admin_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'training_materials'
  AND public._my_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
);

-- Supporting indexes keep tenant predicates and assignment checks from turning
-- into sequential scans as each customer grows.
CREATE INDEX IF NOT EXISTS financial_transactions_tenant_id_idx
  ON public.financial_transactions (tenant_id);
CREATE INDEX IF NOT EXISTS reconciliation_issues_tenant_id_idx
  ON public.reconciliation_issues (tenant_id);
CREATE INDEX IF NOT EXISTS teacher_contracts_tenant_id_idx
  ON public.teacher_contracts (tenant_id);
CREATE INDEX IF NOT EXISTS teacher_closings_tenant_id_idx
  ON public.teacher_closings (tenant_id);
CREATE INDEX IF NOT EXISTS student_assignments_student_id_idx
  ON public.student_assignments (student_id);
CREATE INDEX IF NOT EXISTS student_assignments_assigned_by_idx
  ON public.student_assignments (assigned_by);
