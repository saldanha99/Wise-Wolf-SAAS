-- Central segura de configuracoes por tenant.
-- O navegador nunca grava em tenants nem acessa segredos diretamente.

DO $guard$
BEGIN
  IF to_regclass('public.tenants') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR to_regclass('public.tenant_memberships') IS NULL
    OR to_regclass('public.tenant_user_contexts') IS NULL
    OR to_regprocedure('private.active_tenant_id(uuid)') IS NULL
    OR to_regprocedure('private.active_tenant_role(uuid)') IS NULL
  THEN
    RAISE EXCEPTION 'tenant_membership_foundation_is_required';
  END IF;

  IF to_regclass('public.whatsapp_instances') IS NULL THEN
    RAISE EXCEPTION 'whatsapp_instances_is_required';
  END IF;

  IF to_regprocedure('vault.create_secret(text,text,text,uuid)') IS NULL
    OR to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') IS NULL
  THEN
    RAISE EXCEPTION 'supabase_vault_is_required';
  END IF;
END
$guard$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS teachers_group_id text,
  ADD COLUMN IF NOT EXISTS hr_group_id text,
  ADD COLUMN IF NOT EXISTS directors_group_id text;

UPDATE public.profiles
SET lifecycle_status = 'active'
WHERE lifecycle_status IS NULL;
ALTER TABLE public.profiles
  ALTER COLUMN lifecycle_status SET DEFAULT 'active',
  ALTER COLUMN lifecycle_status SET NOT NULL;

-- A associacao ACTIVE e a unica fonte de tenant. profiles.tenant_id permanece
-- apenas como compatibilidade de dados, nunca como fallback de autorizacao.
CREATE OR REPLACE FUNCTION private.active_tenant_id(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.id = p_user_id
        AND lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
    ) THEN coalesce(
      (
        SELECT context.tenant_id
        FROM public.tenant_user_contexts AS context
        JOIN public.tenant_memberships AS membership
          ON membership.user_id = context.user_id
         AND membership.tenant_id = context.tenant_id
         AND membership.status = 'ACTIVE'
        WHERE context.user_id = p_user_id
        LIMIT 1
      ),
      (
        SELECT membership.tenant_id
        FROM public.tenant_memberships AS membership
        WHERE membership.user_id = p_user_id
          AND membership.status = 'ACTIVE'
        ORDER BY
          membership.is_primary DESC,
          membership.created_at,
          membership.id
        LIMIT 1
      )
    )
    ELSE NULL
  END;
$function$;
REVOKE ALL ON FUNCTION private.active_tenant_id(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.active_tenant_id(uuid)
  TO postgres, supabase_admin, service_role;

CREATE OR REPLACE FUNCTION private.active_tenant_role(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN profile.role = 'SUPER_ADMIN' THEN 'SUPER_ADMIN'
    ELSE coalesce(
      (
        SELECT membership.role
        FROM public.tenant_memberships AS membership
        WHERE membership.user_id = p_user_id
          AND membership.tenant_id = private.active_tenant_id(p_user_id)
          AND membership.status = 'ACTIVE'
        LIMIT 1
      ),
      CASE
        WHEN profile.role = 'NON_STUDENT' AND profile.tenant_id IS NULL
        THEN 'NON_STUDENT'
        ELSE NULL
      END
    )
  END
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id
    AND lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active';
$function$;
REVOKE ALL ON FUNCTION private.active_tenant_role(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.active_tenant_role(uuid)
  TO postgres, supabase_admin, service_role;

CREATE OR REPLACE FUNCTION private.tenant_is_operational(p_tenant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenants AS tenant
    WHERE tenant.id = p_tenant_id
      AND lower(trim(coalesce(tenant.saas_status, ''))) IN (
        'active', 'trial', 'trialing'
      )
  );
$function$;
REVOKE ALL ON FUNCTION private.tenant_is_operational(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.tenant_is_operational(text)
  TO postgres, supabase_admin, service_role;

CREATE OR REPLACE FUNCTION public._my_tenant_is_operational()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT private.tenant_is_operational(
    private.active_tenant_id((SELECT auth.uid()))
  );
$function$;
REVOKE ALL ON FUNCTION public._my_tenant_is_operational() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._my_tenant_is_operational()
  TO authenticated, service_role;

CREATE TABLE public.tenant_admin_settings (
  tenant_id text PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  locale text NOT NULL DEFAULT 'pt-BR'
    CHECK (locale ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo'
    CHECK (length(timezone) BETWEEN 3 AND 64),
  currency text NOT NULL DEFAULT 'BRL'
    CHECK (currency ~ '^[A-Z]{3}$'),
  week_starts_on smallint NOT NULL DEFAULT 1
    CHECK (week_starts_on BETWEEN 0 AND 6),
  default_lesson_duration_minutes smallint NOT NULL DEFAULT 60
    CHECK (default_lesson_duration_minutes BETWEEN 15 AND 240),
  student_notifications_enabled boolean NOT NULL DEFAULT true,
  teacher_notifications_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

INSERT INTO public.tenant_admin_settings (tenant_id)
SELECT tenant.id
FROM public.tenants AS tenant
ON CONFLICT (tenant_id) DO NOTHING;

ALTER TABLE public.tenant_admin_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_admin_settings
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tenant_admin_settings TO service_role;

DROP POLICY IF EXISTS tenant_admin_settings_defense_in_depth_read
  ON public.tenant_admin_settings;
CREATE POLICY tenant_admin_settings_defense_in_depth_read
ON public.tenant_admin_settings
FOR SELECT TO authenticated
USING (
  tenant_id = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

CREATE TABLE public.tenant_configuration_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role text NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 3 AND 120),
  section text NOT NULL CHECK (length(section) BETWEEN 2 AND 80),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(changes) = 'object' AND pg_column_size(changes) <= 16384),
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_configuration_audit_tenant_created_idx
  ON public.tenant_configuration_audit (tenant_id, created_at DESC);

ALTER TABLE public.tenant_configuration_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_configuration_audit
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tenant_configuration_audit TO authenticated;
GRANT ALL ON TABLE public.tenant_configuration_audit TO service_role;

DROP POLICY IF EXISTS tenant_configuration_audit_admin_read
  ON public.tenant_configuration_audit;
CREATE POLICY tenant_configuration_audit_admin_read
ON public.tenant_configuration_audit
FOR SELECT TO authenticated
USING (
  tenant_id = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

CREATE TABLE private.tenant_secret_registry (
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('asaas', 'evolution', 'openai', 'openrouter')),
  vault_secret_id uuid NOT NULL UNIQUE,
  environment text NOT NULL DEFAULT 'production'
    CHECK (
      (provider = 'asaas' AND environment IN ('sandbox', 'production'))
      OR (provider = 'evolution' AND environment = 'platform')
      OR (provider IN ('openai', 'openrouter') AND environment = 'production')
    ),
  status text NOT NULL DEFAULT 'configured'
    CHECK (status IN ('configured', 'healthy', 'error', 'disabled')),
  secret_last_four text NOT NULL CHECK (length(secret_last_four) BETWEEN 1 AND 4),
  account_label text CHECK (account_label IS NULL OR length(account_label) <= 120),
  last_validated_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);
REVOKE ALL ON TABLE private.tenant_secret_registry
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE private.tenant_secret_registry TO service_role;

CREATE TABLE private.tenant_configuration_rate_limits (
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  action_key text NOT NULL CHECK (length(action_key) BETWEEN 2 AND 80),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  PRIMARY KEY (tenant_id, action_key)
);
REVOKE ALL ON TABLE private.tenant_configuration_rate_limits
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE private.tenant_configuration_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION private.create_tenant_admin_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.tenant_admin_settings (tenant_id)
  VALUES (NEW.id)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.create_tenant_admin_settings()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tenants_create_admin_settings ON public.tenants;
CREATE TRIGGER tenants_create_admin_settings
AFTER INSERT ON public.tenants
FOR EACH ROW EXECUTE FUNCTION private.create_tenant_admin_settings();

CREATE OR REPLACE FUNCTION public.consume_tenant_settings_rate_limit(
  p_tenant_id text,
  p_action_key text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_count integer;
BEGIN
  IF p_tenant_id IS NULL
    OR p_action_key IS NULL
    OR length(p_action_key) NOT BETWEEN 2 AND 80
    OR p_limit NOT BETWEEN 1 AND 1000
    OR p_window_seconds NOT BETWEEN 10 AND 86400
  THEN
    RAISE EXCEPTION 'invalid_rate_limit_parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.tenant_configuration_rate_limits AS rate_limit (
    tenant_id,
    action_key,
    window_started_at,
    request_count
  )
  VALUES (p_tenant_id, p_action_key, clock_timestamp(), 1)
  ON CONFLICT (tenant_id, action_key) DO UPDATE
  SET window_started_at = CASE
        WHEN rate_limit.window_started_at
          <= clock_timestamp() - make_interval(secs => p_window_seconds)
        THEN clock_timestamp()
        ELSE rate_limit.window_started_at
      END,
      request_count = CASE
        WHEN rate_limit.window_started_at
          <= clock_timestamp() - make_interval(secs => p_window_seconds)
        THEN 1
        ELSE rate_limit.request_count + 1
      END
  RETURNING request_count INTO current_count;

  RETURN current_count <= p_limit;
END;
$function$;
REVOKE ALL ON FUNCTION public.consume_tenant_settings_rate_limit(text,text,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_tenant_settings_rate_limit(text,text,integer,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_tenant_secret_status(p_tenant_id text)
RETURNS TABLE (
  provider text,
  environment text,
  status text,
  secret_last_four text,
  account_label text,
  last_validated_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    secret.provider,
    secret.environment,
    secret.status,
    secret.secret_last_four,
    secret.account_label,
    secret.last_validated_at,
    secret.updated_at
  FROM private.tenant_secret_registry AS secret
  WHERE secret.tenant_id = p_tenant_id
    AND private.tenant_is_operational(p_tenant_id)
  ORDER BY secret.provider;
$function$;
REVOKE ALL ON FUNCTION public.get_tenant_secret_status(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_secret_status(text) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_tenant_integration_secret(
  p_tenant_id text,
  p_provider text,
  p_secret text,
  p_environment text,
  p_actor_id uuid,
  p_account_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  existing_secret_id uuid;
  stored_secret_id uuid;
  secret_name text;
  actor_role text;
  normalized_label text := nullif(left(trim(coalesce(p_account_label, '')), 120), '');
BEGIN
  IF p_provider NOT IN ('asaas', 'evolution', 'openai', 'openrouter')
    OR p_environment IS NULL
    OR (p_provider = 'asaas' AND p_environment NOT IN ('sandbox', 'production'))
    OR (p_provider = 'evolution' AND p_environment <> 'platform')
    OR (p_provider IN ('openai', 'openrouter') AND p_environment <> 'production')
    OR p_secret IS NULL
    OR length(p_secret) NOT BETWEEN 8 AND 4096
    OR NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id)
  THEN
    RAISE EXCEPTION 'invalid_tenant_secret' USING ERRCODE = '22023';
  END IF;

  -- NULL actor is reserved for the one-time legacy migration below. Interactive
  -- callers always carry an actor and must belong to an operational tenant.
  IF p_actor_id IS NOT NULL
    AND NOT private.tenant_is_operational(p_tenant_id)
  THEN
    RAISE EXCEPTION 'tenant_not_operational' USING ERRCODE = '55000';
  END IF;

  IF p_actor_id IS NULL THEN
    actor_role := 'SYSTEM';
  ELSE
    actor_role := private.active_tenant_role(p_actor_id);
    IF actor_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
      OR private.active_tenant_id(p_actor_id) IS DISTINCT FROM p_tenant_id
    THEN
      RAISE EXCEPTION 'cross_tenant_access_denied' USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id || ':' || p_provider, 0)
  );

  secret_name := 'tenant-integration:' || p_tenant_id || ':' || p_provider;

  SELECT registry.vault_secret_id
  INTO existing_secret_id
  FROM private.tenant_secret_registry AS registry
  WHERE registry.tenant_id = p_tenant_id
    AND registry.provider = p_provider
  FOR UPDATE;

  IF existing_secret_id IS NULL THEN
    SELECT vault.create_secret(
      p_secret,
      secret_name,
      'Tenant-managed integration credential',
      NULL
    )
    INTO stored_secret_id;
  ELSE
    PERFORM vault.update_secret(
      existing_secret_id,
      p_secret,
      secret_name,
      'Tenant-managed integration credential',
      NULL
    );
    stored_secret_id := existing_secret_id;
  END IF;

  INSERT INTO private.tenant_secret_registry (
    tenant_id,
    provider,
    vault_secret_id,
    environment,
    status,
    secret_last_four,
    account_label,
    last_validated_at,
    created_by,
    updated_by,
    updated_at
  )
  VALUES (
    p_tenant_id,
    p_provider,
    stored_secret_id,
    p_environment,
    'healthy',
    right(p_secret, 4),
    normalized_label,
    now(),
    p_actor_id,
    p_actor_id,
    now()
  )
  ON CONFLICT (tenant_id, provider) DO UPDATE
  SET vault_secret_id = EXCLUDED.vault_secret_id,
      environment = EXCLUDED.environment,
      status = 'healthy',
      secret_last_four = EXCLUDED.secret_last_four,
      account_label = EXCLUDED.account_label,
      last_validated_at = now(),
      updated_by = EXCLUDED.updated_by,
      updated_at = now();

  INSERT INTO public.tenant_configuration_audit (
    tenant_id,
    actor_id,
    actor_role,
    action,
    section,
    changes
  )
  VALUES (
    p_tenant_id,
    p_actor_id,
    actor_role,
    CASE WHEN existing_secret_id IS NULL THEN 'credential_configured' ELSE 'credential_rotated' END,
    'integrations',
    jsonb_build_object(
      'provider', p_provider,
      'environment', p_environment,
      'configured', true
    )
  );

  RETURN jsonb_build_object(
    'provider', p_provider,
    'environment', p_environment,
    'status', 'healthy',
    'secretLastFour', right(p_secret, 4),
    'accountLabel', normalized_label,
    'lastValidatedAt', now()
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.upsert_tenant_integration_secret(text,text,text,text,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_tenant_integration_secret(text,text,text,text,uuid,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.delete_tenant_integration_secret(
  p_tenant_id text,
  p_provider text,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  stored_secret_id uuid;
  actor_role text;
BEGIN
  IF p_provider NOT IN ('asaas', 'evolution', 'openai', 'openrouter') THEN
    RAISE EXCEPTION 'invalid_provider' USING ERRCODE = '22023';
  END IF;

  IF NOT private.tenant_is_operational(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant_not_operational' USING ERRCODE = '55000';
  END IF;

  actor_role := private.active_tenant_role(p_actor_id);
  IF p_actor_id IS NULL
    OR actor_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    OR private.active_tenant_id(p_actor_id) IS DISTINCT FROM p_tenant_id
  THEN
    RAISE EXCEPTION 'cross_tenant_access_denied' USING ERRCODE = '42501';
  END IF;

  DELETE FROM private.tenant_secret_registry AS registry
  WHERE registry.tenant_id = p_tenant_id
    AND registry.provider = p_provider
  RETURNING registry.vault_secret_id INTO stored_secret_id;

  IF stored_secret_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM vault.secrets WHERE id = stored_secret_id;

  INSERT INTO public.tenant_configuration_audit (
    tenant_id,
    actor_id,
    actor_role,
    action,
    section,
    changes
  )
  VALUES (
    p_tenant_id,
    p_actor_id,
    actor_role,
    'credential_removed',
    'integrations',
    jsonb_build_object('provider', p_provider, 'configured', false)
  );

  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.delete_tenant_integration_secret(text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_tenant_integration_secret(text,text,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.apply_tenant_admin_settings(
  p_tenant_id text,
  p_actor_id uuid,
  p_expected_version bigint,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_version bigint;
  next_version bigint;
  normalized_name text;
  normalized_slug text;
  normalized_branding jsonb;
  normalized_school_info jsonb;
  actor_role text;
BEGIN
  IF NOT private.tenant_is_operational(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant_not_operational' USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(p_settings) <> 'object'
    OR NOT p_settings ?& ARRAY[
      'name',
      'slug',
      'branding',
      'schoolInfo',
      'whatsappEnabled',
      'financialCutoffDay',
      'locale',
      'timezone',
      'currency',
      'weekStartsOn',
      'defaultLessonDurationMinutes',
      'studentNotificationsEnabled',
      'teacherNotificationsEnabled'
    ]
    OR EXISTS (
      SELECT 1
      FROM jsonb_object_keys(p_settings) AS supplied(key)
      WHERE supplied.key NOT IN (
        'name',
        'slug',
        'branding',
        'schoolInfo',
        'whatsappEnabled',
        'financialCutoffDay',
        'locale',
        'timezone',
        'currency',
        'weekStartsOn',
        'defaultLessonDurationMinutes',
        'studentNotificationsEnabled',
        'teacherNotificationsEnabled'
      )
    )
  THEN
    RAISE EXCEPTION 'invalid_settings_payload' USING ERRCODE = '22023';
  END IF;

  actor_role := private.active_tenant_role(p_actor_id);
  IF p_actor_id IS NULL
    OR actor_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    OR private.active_tenant_id(p_actor_id) IS DISTINCT FROM p_tenant_id
  THEN
    RAISE EXCEPTION 'cross_tenant_access_denied' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.tenant_admin_settings (tenant_id)
  VALUES (p_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT settings.version
  INTO current_version
  FROM public.tenant_admin_settings AS settings
  WHERE settings.tenant_id = p_tenant_id
  FOR UPDATE;

  IF current_version IS NULL THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_version IS DISTINCT FROM current_version THEN
    RAISE EXCEPTION 'settings_version_conflict' USING ERRCODE = '40001';
  END IF;

  normalized_name := trim(p_settings ->> 'name');
  normalized_slug := lower(trim(p_settings ->> 'slug'));
  normalized_branding := p_settings -> 'branding';
  normalized_school_info := p_settings -> 'schoolInfo';

  IF coalesce(length(normalized_name), 0) NOT BETWEEN 2 AND 120
    OR coalesce(length(normalized_slug), 0) NOT BETWEEN 3 AND 40
    OR coalesce(normalized_slug !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$', true)
    OR jsonb_typeof(normalized_branding) <> 'object'
    OR NOT normalized_branding ?& ARRAY[
      'primaryColor',
      'secondaryColor',
      'logoPath',
      'faviconPath',
      'logoUrl',
      'faviconUrl'
    ]
    OR coalesce(
      normalized_branding ->> 'primaryColor' !~ '^#[0-9A-Fa-f]{6}$',
      true
    )
    OR coalesce(
      normalized_branding ->> 'secondaryColor' !~ '^#[0-9A-Fa-f]{6}$',
      true
    )
    OR pg_column_size(normalized_branding) > 16384
    OR (
      normalized_school_info IS DISTINCT FROM 'null'::jsonb
      AND (
        jsonb_typeof(normalized_school_info) <> 'object'
        OR pg_column_size(normalized_school_info) > 16384
      )
    )
    OR (p_settings ->> 'financialCutoffDay')::integer NOT BETWEEN 1 AND 28
    OR p_settings ->> 'locale' !~ '^[a-z]{2}(?:-[A-Z]{2})?$'
    OR length(p_settings ->> 'timezone') NOT BETWEEN 3 AND 64
    OR p_settings ->> 'currency' !~ '^[A-Z]{3}$'
    OR (p_settings ->> 'weekStartsOn')::integer NOT BETWEEN 0 AND 6
    OR (p_settings ->> 'defaultLessonDurationMinutes')::integer NOT BETWEEN 15 AND 240
  THEN
    RAISE EXCEPTION 'invalid_settings_values' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tenants AS tenant
  SET name = normalized_name,
      slug = normalized_slug,
      domain = normalized_slug || '.wisewolflanguage.com.br',
      branding = normalized_branding,
      school_info = CASE
        WHEN normalized_school_info = 'null'::jsonb THEN NULL
        ELSE normalized_school_info
      END,
      whatsapp_enabled = (p_settings ->> 'whatsappEnabled')::boolean,
      financial_cutoff_day = (p_settings ->> 'financialCutoffDay')::integer
  WHERE tenant.id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;

  next_version := current_version + 1;
  UPDATE public.tenant_admin_settings AS settings
  SET version = next_version,
      locale = p_settings ->> 'locale',
      timezone = p_settings ->> 'timezone',
      currency = p_settings ->> 'currency',
      week_starts_on = (p_settings ->> 'weekStartsOn')::smallint,
      default_lesson_duration_minutes =
        (p_settings ->> 'defaultLessonDurationMinutes')::smallint,
      student_notifications_enabled =
        (p_settings ->> 'studentNotificationsEnabled')::boolean,
      teacher_notifications_enabled =
        (p_settings ->> 'teacherNotificationsEnabled')::boolean,
      updated_at = now(),
      updated_by = p_actor_id
  WHERE settings.tenant_id = p_tenant_id;

  INSERT INTO public.tenant_configuration_audit (
    tenant_id,
    actor_id,
    actor_role,
    action,
    section,
    changes
  )
  VALUES (
    p_tenant_id,
    p_actor_id,
    actor_role,
    'settings_published',
    'school',
    jsonb_build_object(
      'version', next_version,
      'sections', jsonb_build_array(
        'identity', 'branding', 'operations', 'communications'
      )
    )
  );

  RETURN jsonb_build_object('ok', true, 'version', next_version);
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_tenant_admin_settings(text,uuid,bigint,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_tenant_admin_settings(text,uuid,bigint,jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.request_tenant_custom_domain_server(
  p_tenant_id text,
  p_actor_id uuid,
  p_domain text,
  p_dns_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_role text := private.active_tenant_role(p_actor_id);
  normalized_domain text := lower(trim(trailing '.' FROM trim(p_domain)));
BEGIN
  IF NOT private.tenant_is_operational(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant_not_operational' USING ERRCODE = '55000';
  END IF;

  IF p_actor_id IS NULL
    OR actor_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    OR private.active_tenant_id(p_actor_id) IS DISTINCT FROM p_tenant_id
  THEN
    RAISE EXCEPTION 'cross_tenant_access_denied' USING ERRCODE = '42501';
  END IF;
  IF length(normalized_domain) NOT BETWEEN 4 AND 253
    OR normalized_domain !~
      '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    OR normalized_domain = 'wisewolflanguage.com.br'
    OR normalized_domain LIKE '%.wisewolflanguage.com.br'
    OR p_dns_token !~ '^wwv-[0-9a-f]{32}$'
  THEN
    RAISE EXCEPTION 'invalid_custom_domain' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.tenants AS other_tenant
    WHERE lower(trim(trailing '.' FROM other_tenant.custom_domain)) = normalized_domain
      AND other_tenant.id <> p_tenant_id
  ) THEN
    RAISE EXCEPTION 'custom_domain_in_use' USING ERRCODE = '23505';
  END IF;

  UPDATE public.tenants
  SET custom_domain = normalized_domain,
      custom_domain_verified = false,
      custom_domain_dns_token = p_dns_token,
      custom_domain_verified_at = NULL
  WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.tenant_configuration_audit (
    tenant_id,
    actor_id,
    actor_role,
    action,
    section,
    changes
  )
  VALUES (
    p_tenant_id,
    p_actor_id,
    actor_role,
    'custom_domain_requested',
    'domains',
    jsonb_build_object('domain', normalized_domain, 'verified', false)
  );

  RETURN jsonb_build_object('ok', true, 'domain', normalized_domain);
END;
$function$;
REVOKE ALL ON FUNCTION public.request_tenant_custom_domain_server(text,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_tenant_custom_domain_server(text,uuid,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.verify_tenant_custom_domain_server(
  p_tenant_id text,
  p_actor_id uuid,
  p_expected_dns_token text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_role text := private.active_tenant_role(p_actor_id);
  verified_domain text;
  verified_at timestamptz := now();
BEGIN
  IF NOT private.tenant_is_operational(p_tenant_id) THEN
    RAISE EXCEPTION 'tenant_not_operational' USING ERRCODE = '55000';
  END IF;

  IF p_actor_id IS NULL
    OR actor_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    OR private.active_tenant_id(p_actor_id) IS DISTINCT FROM p_tenant_id
  THEN
    RAISE EXCEPTION 'cross_tenant_access_denied' USING ERRCODE = '42501';
  END IF;

  UPDATE public.tenants
  SET custom_domain_verified = true,
      custom_domain_verified_at = verified_at
  WHERE id = p_tenant_id
    AND custom_domain IS NOT NULL
    AND custom_domain_dns_token = p_expected_dns_token
  RETURNING custom_domain INTO verified_domain;
  IF verified_domain IS NULL THEN
    RAISE EXCEPTION 'domain_verification_state_changed' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.tenant_configuration_audit (
    tenant_id,
    actor_id,
    actor_role,
    action,
    section,
    changes
  )
  VALUES (
    p_tenant_id,
    p_actor_id,
    actor_role,
    'custom_domain_verified',
    'domains',
    jsonb_build_object('domain', verified_domain, 'verified', true)
  );

  RETURN verified_at;
END;
$function$;
REVOKE ALL ON FUNCTION public.verify_tenant_custom_domain_server(text,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_tenant_custom_domain_server(text,uuid,text)
  TO service_role;

-- Move os segredos legados em texto puro para o Vault antes de remover as
-- colunas privadas antigas. Nenhum valor e impresso ou exposto por RPC.
DO $migrate_legacy_secrets$
DECLARE
  legacy_secret record;
  has_whatsapp_secret boolean;
  has_asaas_secret boolean;
BEGIN
  IF to_regclass('private.tenant_integration_secrets') IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'private'
      AND table_name = 'tenant_integration_secrets'
      AND column_name = 'whatsapp_api_key'
  ) INTO has_whatsapp_secret;
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'private'
      AND table_name = 'tenant_integration_secrets'
      AND column_name = 'asaas_api_key'
  ) INTO has_asaas_secret;

  IF NOT has_whatsapp_secret AND NOT has_asaas_secret THEN
    RETURN;
  END IF;

  IF has_whatsapp_secret THEN
    FOR legacy_secret IN EXECUTE
      'SELECT tenant_id, whatsapp_api_key AS secret '
      'FROM private.tenant_integration_secrets'
    LOOP
      IF nullif(legacy_secret.secret, '') IS NULL THEN
        CONTINUE;
      END IF;
      PERFORM public.upsert_tenant_integration_secret(
        legacy_secret.tenant_id,
        'evolution',
        legacy_secret.secret,
        'platform',
        NULL,
        'Migrated credential'
      );
    END LOOP;
    ALTER TABLE private.tenant_integration_secrets
      DROP COLUMN IF EXISTS whatsapp_api_key;
  END IF;

  IF has_asaas_secret THEN
    FOR legacy_secret IN EXECUTE
      'SELECT tenant_id, asaas_api_key AS secret '
      'FROM private.tenant_integration_secrets'
    LOOP
      IF nullif(legacy_secret.secret, '') IS NULL THEN
        CONTINUE;
      END IF;
      PERFORM public.upsert_tenant_integration_secret(
        legacy_secret.tenant_id,
        'asaas',
        legacy_secret.secret,
        'production',
        NULL,
        'Migrated credential'
      );
    END LOOP;
    ALTER TABLE private.tenant_integration_secrets
      DROP COLUMN IF EXISTS asaas_api_key;
  END IF;
END
$migrate_legacy_secrets$;

-- Impede que colunas legadas do schema publico voltem a receber segredo.
UPDATE public.tenants
SET whatsapp_api_key = NULL,
    asaas_api_key_encrypted = NULL
WHERE whatsapp_api_key IS NOT NULL
   OR asaas_api_key_encrypted IS NOT NULL;
ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_no_plaintext_integration_secrets;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_no_plaintext_integration_secrets
  CHECK (whatsapp_api_key IS NULL AND asaas_api_key_encrypted IS NULL);

-- Branding continua servido por URL publica do bucket. A policy SELECT abaixo
-- existe apenas para administracao/listagem e nao e necessaria para o CDN.
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'tenant-branding',
  'tenant-branding',
  true,
  2097152,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/x-icon']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    updated_at = now();

DROP POLICY IF EXISTS tenant_branding_public_read ON storage.objects;
DROP POLICY IF EXISTS tenant_branding_admin_read ON storage.objects;
CREATE POLICY tenant_branding_admin_read
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'tenant-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_branding_admin_insert ON storage.objects;
CREATE POLICY tenant_branding_admin_insert
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'tenant-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_branding_admin_update ON storage.objects;
CREATE POLICY tenant_branding_admin_update
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'tenant-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
)
WITH CHECK (
  bucket_id = 'tenant-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

DROP POLICY IF EXISTS tenant_branding_admin_delete ON storage.objects;
CREATE POLICY tenant_branding_admin_delete
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'tenant-branding'
  AND (storage.foldername(name))[1] = (SELECT public._my_tenant_id())
  AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  AND (SELECT public._my_tenant_is_operational())
);

-- O resolver anonimo recebe apenas identidade visual publica.
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
    jsonb_strip_nulls(jsonb_build_object(
      'primaryColor', tenant.branding -> 'primaryColor',
      'secondaryColor', tenant.branding -> 'secondaryColor',
      'logoUrl', tenant.branding -> 'logoUrl',
      'faviconUrl', tenant.branding -> 'faviconUrl'
    )),
    NULL::jsonb
  FROM public.tenants AS tenant
  CROSS JOIN normalized
  WHERE normalized.hostname <> ''
    AND private.tenant_is_operational(tenant.id)
    AND (
      (
        normalized.hostname LIKE '%.wisewolflanguage.com.br'
        AND split_part(normalized.hostname, '.', 2) = 'wisewolflanguage'
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

-- A verificacao de DNS antiga apenas marcava o dominio como verificado.
-- O endpoint novo consulta TXT + CNAME antes de atualizar a linha.
DO $domain_functions$
BEGIN
  IF to_regprocedure('public.request_custom_domain(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.request_custom_domain(text)
      FROM PUBLIC, anon, authenticated;
  END IF;
  IF to_regprocedure('public.verify_custom_domain()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.verify_custom_domain()
      FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END
$domain_functions$;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_casefold_unique_idx
  ON public.tenants (lower(slug))
  WHERE nullif(trim(slug), '') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_custom_domain_casefold_unique_idx
  ON public.tenants (lower(trim(trailing '.' FROM custom_domain)))
  WHERE nullif(trim(custom_domain), '') IS NOT NULL;

-- Corrige IDOR: diretor so conclui offboarding no tenant ativo.
CREATE OR REPLACE FUNCTION public.complete_teacher_offboarding(p_teacher_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  caller_tenant text;
  caller_role text;
  remaining_count integer;
  active_membership_count integer;
BEGIN
  caller_tenant := private.active_tenant_id(caller_id);
  caller_role := private.active_tenant_role(caller_id);

  IF caller_id IS NULL
    OR caller_tenant IS NULL
    OR caller_role NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.user_id = p_teacher_id
      AND membership.tenant_id = caller_tenant
      AND membership.role = 'TEACHER'
      AND membership.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'teacher_scope_denied' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
  INTO remaining_count
  FROM public.bookings AS booking
  WHERE booking.teacher_id = p_teacher_id
    AND booking.tenant_id = caller_tenant
    AND booking.status IS DISTINCT FROM 'CANCELLED';

  IF remaining_count > 0 THEN
    RETURN jsonb_build_object(
      'status', 'PENDING_REASSIGN',
      'remaining', remaining_count,
      'message', 'Ainda ha aulas ativas para reatribuir.'
    );
  END IF;

  UPDATE public.tenant_memberships
  SET status = 'REVOKED',
      is_primary = false,
      updated_at = now()
  WHERE user_id = p_teacher_id
    AND tenant_id = caller_tenant
    AND role = 'TEACHER'
    AND status = 'ACTIVE';

  SELECT count(*)
  INTO active_membership_count
  FROM public.tenant_memberships AS membership
  WHERE membership.user_id = p_teacher_id
    AND membership.status = 'ACTIVE';

  IF active_membership_count = 0 THEN
    DELETE FROM public.tenant_user_contexts
    WHERE user_id = p_teacher_id;

    UPDATE public.profiles
    SET status = 'Inativo',
        offboarding_status = 'COMPLETED',
        offboarding_completed_at = now(),
        date_automation_enabled = false
    WHERE id = p_teacher_id;
  ELSIF EXISTS (
    SELECT 1
    FROM public.tenant_user_contexts AS context
    WHERE context.user_id = p_teacher_id
      AND context.tenant_id = caller_tenant
  ) THEN
    UPDATE public.tenant_user_contexts AS context
    SET tenant_id = replacement.tenant_id,
        updated_at = now()
    FROM (
      SELECT membership.tenant_id
      FROM public.tenant_memberships AS membership
      WHERE membership.user_id = p_teacher_id
        AND membership.status = 'ACTIVE'
      ORDER BY membership.is_primary DESC, membership.created_at, membership.id
      LIMIT 1
    ) AS replacement
    WHERE context.user_id = p_teacher_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'COMPLETED',
    'remainingActiveMemberships', active_membership_count
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_teacher_offboarding(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_teacher_offboarding(uuid)
  TO authenticated;

DO $whatsapp_rpc$
BEGIN
  IF to_regprocedure('public.get_tenant_whatsapp_instance(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_tenant_whatsapp_instance(uuid)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_tenant_whatsapp_instance(uuid)
      TO service_role;
  END IF;
END
$whatsapp_rpc$;

-- Vincula instancia WhatsApp ao tenant e impede colisao global de roteamento.
ALTER TABLE public.whatsapp_instances
  ADD COLUMN IF NOT EXISTS tenant_id text;
WITH unique_membership AS (
  SELECT
    membership.user_id,
    min(membership.tenant_id) AS tenant_id
  FROM public.tenant_memberships AS membership
  WHERE membership.status = 'ACTIVE'
  GROUP BY membership.user_id
  HAVING count(*) = 1
), resolved AS (
  SELECT
    instance.id,
    coalesce(context_membership.tenant_id, unique_membership.tenant_id) AS tenant_id
  FROM public.whatsapp_instances AS instance
  LEFT JOIN public.tenant_user_contexts AS context
    ON context.user_id = instance.user_id
  LEFT JOIN public.tenant_memberships AS context_membership
    ON context_membership.user_id = instance.user_id
   AND context_membership.tenant_id = context.tenant_id
   AND context_membership.status = 'ACTIVE'
  LEFT JOIN unique_membership
    ON unique_membership.user_id = instance.user_id
  WHERE instance.tenant_id IS NULL
)
UPDATE public.whatsapp_instances AS instance
SET tenant_id = resolved.tenant_id
FROM resolved
WHERE resolved.id = instance.id
  AND resolved.tenant_id IS NOT NULL;

DO $whatsapp_preflight$
DECLARE
  unresolved_count bigint;
  duplicate_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count
  FROM public.whatsapp_instances
  WHERE tenant_id IS NULL;
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'whatsapp_instance_tenant_backfill_unresolved:%', unresolved_count;
  END IF;

  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT lower(instance_name)
    FROM public.whatsapp_instances
    GROUP BY lower(instance_name)
    HAVING count(*) > 1
  ) AS duplicate_names;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'whatsapp_instance_names_are_not_globally_unique:%', duplicate_count;
  END IF;
END
$whatsapp_preflight$;
ALTER TABLE public.whatsapp_instances
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.whatsapp_instances
  DROP CONSTRAINT IF EXISTS whatsapp_instances_tenant_id_fkey;
ALTER TABLE public.whatsapp_instances
  ADD CONSTRAINT whatsapp_instances_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE public.whatsapp_instances
  VALIDATE CONSTRAINT whatsapp_instances_tenant_id_fkey;
CREATE INDEX IF NOT EXISTS whatsapp_instances_tenant_id_idx
  ON public.whatsapp_instances (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_instances_name_casefold_unique_idx
  ON public.whatsapp_instances (lower(instance_name));

DROP POLICY IF EXISTS whatsapp_instances_scoped_read
  ON public.whatsapp_instances;
CREATE POLICY whatsapp_instances_scoped_read
ON public.whatsapp_instances
FOR SELECT TO authenticated
USING (
  tenant_id = (SELECT public._my_tenant_id())
  AND (
    user_id = (SELECT auth.uid())
    OR (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  )
);

UPDATE public.whatsapp_instances
SET api_key = NULL
WHERE api_key IS NOT NULL;
ALTER TABLE public.whatsapp_instances
  DROP CONSTRAINT IF EXISTS whatsapp_instances_no_plaintext_api_key;
ALTER TABLE public.whatsapp_instances
  ADD CONSTRAINT whatsapp_instances_no_plaintext_api_key
  CHECK (api_key IS NULL);

CREATE OR REPLACE FUNCTION private.scope_whatsapp_instance_to_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  active_tenant text;
BEGIN
  active_tenant := private.active_tenant_id(NEW.user_id);
  IF active_tenant IS NULL THEN
    RAISE EXCEPTION 'active_tenant_membership_required' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := active_tenant;
  ELSIF NEW.tenant_id IS DISTINCT FROM active_tenant THEN
    RAISE EXCEPTION 'cross_tenant_whatsapp_instance' USING ERRCODE = '42501';
  END IF;
  NEW.api_key := NULL;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.scope_whatsapp_instance_to_tenant()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_instances_scope_tenant
  ON public.whatsapp_instances;
CREATE TRIGGER whatsapp_instances_scope_tenant
BEFORE INSERT OR UPDATE OF user_id, tenant_id, api_key
ON public.whatsapp_instances
FOR EACH ROW EXECUTE FUNCTION private.scope_whatsapp_instance_to_tenant();

-- Reaplica os grants dos helpers porque migrations legadas os devolveram ao anon.
REVOKE ALL ON FUNCTION public._my_tenant_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._my_tenant_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._my_role() TO authenticated, service_role;
