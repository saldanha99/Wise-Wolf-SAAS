-- SECURITY DEFINER authorization hardening.
--
-- Static audit (2026-08-25) found two related failure modes:
--   * `IF role NOT IN (...)` does not reject NULL. In PL/pgSQL, `IF NULL`
--     does not enter the branch, so callers without a profile crossed the
--     authorization check.
--   * `IF NOT (tenant = _my_tenant_id() AND _my_role() = ANY (...))` has the
--     same three-valued-logic problem when either helper returns NULL.
--
-- The affected implementations are retained as owner-only implementation
-- details so their business calculations do not get duplicated here. Every
-- public entry point is rebuilt as a fail-closed facade with a fixed, empty
-- search_path. The implementation functions cannot be called by API roles.
--
-- The ACL convergence at the end is deliberately catalog-driven: PostgreSQL
-- grants EXECUTE to PUBLIC by default and API roles inherit that grant. We
-- preserve only grants recorded directly for authenticated/service_role in
-- pg_proc.proacl, remove PUBLIC/anon from every SECURITY DEFINER function, and
-- then regrant only the reviewed anonymous bearer-link/public-intake endpoints
-- by exact signature. Effective privileges cannot be used for this snapshot:
-- has_function_privilege() would mistake PUBLIC inheritance for an explicit
-- authenticated grant and make that accidental access permanent.

DO $foundation_guard$
BEGIN
  IF to_regclass('public.profiles') IS NULL
    OR to_regclass('public.tenant_memberships') IS NULL
    OR to_regprocedure('private.active_tenant_id(uuid)') IS NULL
    OR to_regprocedure('private.active_tenant_role(uuid)') IS NULL
    OR to_regprocedure('private.tenant_is_operational(text)') IS NULL
  THEN
    RAISE EXCEPTION 'security_definer_hardening_requires_tenant_foundation';
  END IF;
END
$foundation_guard$;

CREATE OR REPLACE FUNCTION private.can_execute_legacy_role_rpc(
  p_allowed_roles text[]
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant_id text;
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
BEGIN
  -- Service workers and direct database maintenance remain explicit trusted
  -- callers. A JWT claim always wins, so SET ROLE authenticated in SQL tests
  -- cannot inherit the postgres session user's authority.
  IF jwt_role = 'service_role'
    OR (
      jwt_role = ''
      AND session_user IN ('postgres', 'supabase_admin')
    )
  THEN
    RETURN true;
  END IF;

  IF jwt_role <> 'authenticated'
    OR actor_id IS NULL
    OR p_allowed_roles IS NULL
    OR pg_catalog.cardinality(p_allowed_roles) = 0
  THEN
    RETURN false;
  END IF;

  actor_tenant_id := private.active_tenant_id(actor_id);
  actor_role := private.active_tenant_role(actor_id);

  IF actor_tenant_id IS NULL
    OR actor_role IS NULL
    OR NOT (actor_role = ANY (p_allowed_roles))
    OR NOT private.tenant_is_operational(actor_tenant_id)
  THEN
    RETURN false;
  END IF;

  -- Legacy bodies still read role/tenant from profiles. Refuse ambiguous
  -- multi-tenant context instead of letting the body write to the primary
  -- profile tenant while the UI is operating in another tenant.
  RETURN EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = actor_id
      AND pg_catalog.lower(
        pg_catalog.btrim(coalesce(profile.lifecycle_status, 'active'))
      ) = 'active'
      AND (
        (
          actor_role = 'SUPER_ADMIN'
          AND profile.role = 'SUPER_ADMIN'
        )
        OR (
          profile.role = actor_role
          AND profile.tenant_id = actor_tenant_id
          AND EXISTS (
            SELECT 1
            FROM public.tenant_memberships AS membership
            WHERE membership.user_id = actor_id
              AND membership.tenant_id = actor_tenant_id
              AND membership.role = actor_role
              AND membership.status = 'ACTIVE'
          )
        )
      )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.legacy_role_rpc_target_allowed(
  p_target_tenant_id text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  actor_tenant_id text;
  jwt_role text := coalesce(auth.jwt() ->> 'role', '');
BEGIN
  IF jwt_role = 'service_role'
    OR (
      jwt_role = ''
      AND session_user IN ('postgres', 'supabase_admin')
    )
  THEN
    RETURN true;
  END IF;

  IF jwt_role <> 'authenticated'
    OR actor_id IS NULL
    OR p_target_tenant_id IS NULL
    OR NOT private.tenant_is_operational(p_target_tenant_id)
  THEN
    RETURN false;
  END IF;

  actor_tenant_id := private.active_tenant_id(actor_id);
  actor_role := private.active_tenant_role(actor_id);

  RETURN actor_role = 'SUPER_ADMIN'
    OR (
      actor_tenant_id IS NOT NULL
      AND actor_tenant_id = p_target_tenant_id
    );
END;
$function$;

ALTER FUNCTION private.can_execute_legacy_role_rpc(text[]) OWNER TO postgres;
ALTER FUNCTION private.legacy_role_rpc_target_allowed(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.can_execute_legacy_role_rpc(text[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.legacy_role_rpc_target_allowed(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.can_execute_legacy_role_rpc(text[])
  TO postgres, supabase_admin;
GRANT EXECUTE ON FUNCTION private.legacy_role_rpc_target_allowed(text)
  TO postgres, supabase_admin;

-- Preserve the audited business implementations under owner-only names. This
-- follows the same facade pattern already used by the teacher-finance domain.
DO $rename_unsafe_implementations$
DECLARE
  target record;
  source_oid regprocedure;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('public.upsert_niche(text)',
       'public.upsert_niche_unchecked(text)', 'upsert_niche_unchecked'),
      ('public.update_material(uuid,jsonb)',
       'public.update_material_unchecked(uuid,jsonb)', 'update_material_unchecked'),
      ('public.upsert_collection(uuid,text,text,text,text)',
       'public.upsert_collection_unchecked(uuid,text,text,text,text)', 'upsert_collection_unchecked'),
      ('public.delete_collection(uuid)',
       'public.delete_collection_unchecked(uuid)', 'delete_collection_unchecked'),
      ('public.set_material_collection(uuid,uuid,integer)',
       'public.set_material_collection_unchecked(uuid,uuid,integer)', 'set_material_collection_unchecked'),
      ('public.rename_niche(text,text)',
       'public.rename_niche_unchecked(text,text)', 'rename_niche_unchecked'),
      ('public.delete_niche(text)',
       'public.delete_niche_unchecked(text)', 'delete_niche_unchecked'),
      ('public.list_pending_trial_sessions()',
       'public.list_pending_trial_sessions_unchecked()', 'list_pending_trial_sessions_unchecked'),
      ('public.settle_trial_session(uuid,boolean)',
       'public.settle_trial_session_unchecked(uuid,boolean)', 'settle_trial_session_unchecked'),
      ('public.director_pending_counts()',
       'public.director_pending_counts_unchecked()', 'director_pending_counts_unchecked'),
      ('public.set_student_status(uuid,text)',
       'public.set_student_status_unchecked(uuid,text)', 'set_student_status_unchecked'),
      ('public.get_cashflow(text)',
       'public.get_cashflow_unchecked(text)', 'get_cashflow_unchecked'),
      ('public.get_teacher_overview(uuid)',
       'public.get_teacher_overview_unchecked(uuid)', 'get_teacher_overview_unchecked'),
      ('public.list_teachers_overview()',
       'public.list_teachers_overview_unchecked()', 'list_teachers_overview_unchecked'),
      ('public.create_student_plan_change(uuid,text,numeric,boolean)',
       'public.create_student_plan_change_unchecked(uuid,text,numeric,boolean)', 'create_student_plan_change_unchecked')
    ) AS audited(source_signature, implementation_signature, implementation_name)
  LOOP
    IF to_regprocedure(target.implementation_signature) IS NULL THEN
      source_oid := to_regprocedure(target.source_signature);
      IF source_oid IS NULL THEN
        RAISE EXCEPTION 'required_security_definer_rpc_missing: %',
          target.source_signature;
      END IF;
      EXECUTE pg_catalog.format(
        'ALTER FUNCTION %s RENAME TO %I',
        source_oid,
        target.implementation_name
      );
    END IF;
  END LOOP;
END
$rename_unsafe_implementations$;

DO $lock_unsafe_implementations$
DECLARE
  implementation_signature text;
  implementation_oid regprocedure;
BEGIN
  FOREACH implementation_signature IN ARRAY ARRAY[
    'public.upsert_niche_unchecked(text)',
    'public.update_material_unchecked(uuid,jsonb)',
    'public.upsert_collection_unchecked(uuid,text,text,text,text)',
    'public.delete_collection_unchecked(uuid)',
    'public.set_material_collection_unchecked(uuid,uuid,integer)',
    'public.rename_niche_unchecked(text,text)',
    'public.delete_niche_unchecked(text)',
    'public.list_pending_trial_sessions_unchecked()',
    'public.settle_trial_session_unchecked(uuid,boolean)',
    'public.director_pending_counts_unchecked()',
    'public.set_student_status_unchecked(uuid,text)',
    'public.get_cashflow_unchecked(text)',
    'public.get_teacher_overview_unchecked(uuid)',
    'public.list_teachers_overview_unchecked()',
    'public.create_student_plan_change_unchecked(uuid,text,numeric,boolean)'
  ]
  LOOP
    implementation_oid := to_regprocedure(implementation_signature);
    IF implementation_oid IS NULL THEN
      RAISE EXCEPTION 'security_definer_implementation_missing: %',
        implementation_signature;
    END IF;
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s OWNER TO postgres', implementation_oid
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      implementation_oid
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO postgres, supabase_admin',
      implementation_oid
    );
  END LOOP;
END
$lock_unsafe_implementations$;

CREATE OR REPLACE FUNCTION public.upsert_niche(p_label text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.upsert_niche_unchecked(p_label);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_material(p_id uuid, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  SELECT material.tenant_id
  INTO target_tenant_id
  FROM public.pedagogical_materials AS material
  WHERE material.id = p_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'nao_encontrado'
    );
  END IF;
  IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.update_material_unchecked(p_id, p);
END;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_collection(
  p_id uuid,
  p_title text,
  p_niche text,
  p_level text,
  p_cover text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT collection.tenant_id
    INTO target_tenant_id
    FROM public.pedagogical_collections AS collection
    WHERE collection.id = p_id;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'nao_encontrado'
      );
    END IF;
    IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'error', 'sem_permissao'
      );
    END IF;
  END IF;
  RETURN public.upsert_collection_unchecked(
    p_id, p_title, p_niche, p_level, p_cover
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_collection(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  SELECT collection.tenant_id
  INTO target_tenant_id
  FROM public.pedagogical_collections AS collection
  WHERE collection.id = p_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'nao_encontrado'
    );
  END IF;
  IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.delete_collection_unchecked(p_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_material_collection(
  p_material_id uuid,
  p_collection_id uuid,
  p_part_number integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  SELECT material.tenant_id
  INTO target_tenant_id
  FROM public.pedagogical_materials AS material
  WHERE material.id = p_material_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'material_nao_encontrado'
    );
  END IF;
  IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.set_material_collection_unchecked(
    p_material_id, p_collection_id, p_part_number
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rename_niche(p_key text, p_label text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.rename_niche_unchecked(p_key, p_label);
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_niche(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.delete_niche_unchecked(p_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_pending_trial_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN public.list_pending_trial_sessions_unchecked();
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_trial_session(
  p_appointment_id uuid,
  p_attended boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  SELECT appointment.tenant_id
  INTO target_tenant_id
  FROM public.appointments AS appointment
  WHERE appointment.id = p_appointment_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'nao_encontrado'
    );
  END IF;
  IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.settle_trial_session_unchecked(
    p_appointment_id, p_attended
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.director_pending_counts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN public.director_pending_counts_unchecked();
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_student_status(
  p_student_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  SELECT student.tenant_id
  INTO target_tenant_id
  FROM public.profiles AS student
  WHERE student.id = p_student_id
    AND student.role = 'STUDENT';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'nao_encontrado'
    );
  END IF;
  IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'sem_permissao'
    );
  END IF;
  RETURN public.set_student_status_unchecked(p_student_id, p_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cashflow(
  p_month text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object('error', 'sem_permissao');
  END IF;
  RETURN public.get_cashflow_unchecked(p_month);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_teacher_overview(p_teacher_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object('error', 'sem_permissao');
  END IF;
  SELECT teacher.tenant_id
  INTO target_tenant_id
  FROM public.profiles AS teacher
  WHERE teacher.id = p_teacher_id
    AND teacher.role = 'TEACHER';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('error', 'nao_encontrado');
  END IF;
  IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
    RETURN pg_catalog.jsonb_build_object('error', 'sem_permissao');
  END IF;
  RETURN public.get_teacher_overview_unchecked(p_teacher_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_teachers_overview()
RETURNS TABLE(
  teacher_id uuid,
  full_name text,
  avatar_url text,
  status text,
  hourly_rate numeric,
  commission_rate numeric,
  specializations text[],
  active_students integer,
  classes_30 integer,
  teacher_absence_30 integer,
  absence_rate integer,
  conflicts_open integer,
  avg_rating numeric,
  rating_count integer,
  earnings_est numeric,
  nf_pending boolean,
  pix_ok boolean,
  contract_ok boolean,
  alert_level text,
  alert_score integer,
  alert_reasons text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT implementation.*
  FROM public.list_teachers_overview_unchecked() AS implementation;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_student_plan_change(
  p_student_id uuid,
  p_to_frequency text,
  p_to_fee numeric,
  p_update_pending_payments boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF NOT private.can_execute_legacy_role_rpc(
    ARRAY['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN']::text[]
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'Sem permissão'
    );
  END IF;
  SELECT student.tenant_id
  INTO target_tenant_id
  FROM public.profiles AS student
  WHERE student.id = p_student_id
    AND student.role = 'STUDENT';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'Aluno não encontrado'
    );
  END IF;
  IF NOT private.legacy_role_rpc_target_allowed(target_tenant_id) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'Sem permissão'
    );
  END IF;
  RETURN public.create_student_plan_change_unchecked(
    p_student_id,
    p_to_frequency,
    p_to_fee,
    p_update_pending_payments
  );
END;
$function$;

DO $secure_facade_owners_and_acls$
DECLARE
  facade_signature text;
  facade_oid regprocedure;
BEGIN
  FOREACH facade_signature IN ARRAY ARRAY[
    'public.upsert_niche(text)',
    'public.update_material(uuid,jsonb)',
    'public.upsert_collection(uuid,text,text,text,text)',
    'public.delete_collection(uuid)',
    'public.set_material_collection(uuid,uuid,integer)',
    'public.rename_niche(text,text)',
    'public.delete_niche(text)',
    'public.list_pending_trial_sessions()',
    'public.settle_trial_session(uuid,boolean)',
    'public.director_pending_counts()',
    'public.set_student_status(uuid,text)',
    'public.get_cashflow(text)',
    'public.get_teacher_overview(uuid)',
    'public.list_teachers_overview()',
    'public.create_student_plan_change(uuid,text,numeric,boolean)'
  ]
  LOOP
    facade_oid := to_regprocedure(facade_signature);
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO postgres', facade_oid);
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      facade_oid
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role',
      facade_oid
    );
  END LOOP;
END
$secure_facade_owners_and_acls$;

-- New functions are private until a migration grants an explicit API role.
-- PostgreSQL's built-in PUBLIC EXECUTE default is global to the owner: a
-- per-schema REVOKE cannot subtract it. Set the owner-wide defaults used by
-- Supabase migrations; explicit grants on existing/public routes are intact.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Remove inherited anonymous execution from the entire privileged surface.
-- Preserve only direct authenticated/service grants already present in proacl.
-- In particular, never snapshot has_function_privilege() here: before PUBLIC
-- is revoked it reports inherited execution as if it were role-specific.
DO $converge_security_definer_acls$
DECLARE
  privileged_function record;
BEGIN
  FOR privileged_function IN
    SELECT
      procedure.oid,
      procedure.oid::regprocedure AS signature,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(procedure.proacl) AS privilege
        JOIN pg_catalog.pg_roles AS grantee_role
          ON grantee_role.oid = privilege.grantee
        WHERE grantee_role.rolname = 'authenticated'
          AND privilege.privilege_type = 'EXECUTE'
      ) AS authenticated_had_direct_execute,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(procedure.proacl) AS privilege
        JOIN pg_catalog.pg_roles AS grantee_role
          ON grantee_role.oid = privilege.grantee
        WHERE grantee_role.rolname = 'service_role'
          AND privilege.privilege_type = 'EXECUTE'
      ) AS service_role_had_direct_execute
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname IN ('public', 'private')
      AND procedure.prosecdef
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon',
      privileged_function.signature
    );
    IF privileged_function.authenticated_had_direct_execute THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION %s TO authenticated',
        privileged_function.signature
      );
    END IF;
    IF privileged_function.service_role_had_direct_execute THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION %s TO service_role',
        privileged_function.signature
      );
    END IF;
  END LOOP;
END
$converge_security_definer_acls$;

-- Trigger bodies and cron/drain entry points are never client RPCs. Several
-- historical objects received broad direct grants, so preserving direct ACLs
-- alone is not sufficient for this reviewed internal surface. Keep owner and
-- service execution intact while making authenticated/anonymous calls fail.
DO $deny_internal_automation_execution$
DECLARE
  internal_function record;
BEGIN
  FOR internal_function IN
    SELECT
      procedure.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname IN ('public', 'private')
      AND procedure.prosecdef
      AND (
        procedure.prorettype IN (
          'pg_catalog.trigger'::regtype,
          'pg_catalog.event_trigger'::regtype
        )
        OR procedure.proname = ANY (ARRAY[
          'trigger_dre_report',
          'trigger_oral_test_scan',
          'trigger_sdr_followups',
          'trigger_hr_backfill_drain',
          'enqueue_nf_reminders'
        ]::name[])
      )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      internal_function.signature
    );
  END LOOP;
END
$deny_internal_automation_execution$;

-- Reviewed anonymous surface. Each endpoint is either read-only public tenant
-- identity, public intake, or a high-entropy bearer-link workflow. Offer and
-- contract readers are intentionally absent: they are service-role-only behind
-- tenant-legal-assets.
DO $grant_reviewed_anonymous_functions$
DECLARE
  reviewed record;
  public_function regprocedure;
BEGIN
  FOR reviewed IN
    SELECT *
    FROM (VALUES
      ('public.apply_student_response(text,text)', 'apply_student_response'),
      ('public.apply_teacher_candidate(text,text,text)', 'apply_teacher_candidate'),
      ('public.get_confirmation_public(text)', 'get_confirmation_public'),
      ('public.get_plan_change_public(text)', 'get_plan_change_public'),
      ('public.get_referrer_name(uuid)', 'get_referrer_name'),
      ('public.get_transfer_public(text)', 'get_transfer_public'),
      ('public.hub_get_public_settings()', 'hub_get_public_settings'),
      ('public.rate_attendance(text,integer)', 'rate_attendance'),
      ('public.resolve_public_tenant(text)', 'resolve_public_tenant'),
      ('public.respond_teacher_transfer(text,boolean,text)', 'respond_teacher_transfer'),
      ('public.sign_student_plan_change(text,text)', 'sign_student_plan_change')
    ) AS reviewed_public(signature, function_name)
  LOOP
    public_function := to_regprocedure(reviewed.signature);

    -- Some reviewed routes are production objects that pre-date source
    -- control. They are optional on a clean rebuild, but an overload drift in
    -- an existing SECURITY DEFINER route must stop the migration instead of
    -- silently removing anonymous access from a live workflow.
    IF public_function IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = reviewed.function_name
          AND procedure.prosecdef
      ) THEN
        RAISE EXCEPTION 'reviewed_public_function_signature_changed: %',
          reviewed.signature;
      END IF;
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid = public_function
        AND procedure.prosecdef
    ) THEN
      RAISE EXCEPTION 'reviewed_public_function_not_security_definer: %',
        reviewed.signature;
    END IF;

    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO anon, authenticated',
      public_function
    );
  END LOOP;
END
$grant_reviewed_anonymous_functions$;
