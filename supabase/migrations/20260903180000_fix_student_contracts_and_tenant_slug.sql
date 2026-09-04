-- Migration: 20260903180000_fix_student_contracts_and_tenant_slug.sql
-- Description:
-- 1. Redefine vw_student_contracts with security_barrier = true and security_invoker = false (owned by postgres)
--    with strict tenant isolation and role verification in WHERE clause so SCHOOL_ADMIN and SUPER_ADMIN
--    can audit student contracts without being blocked by column-level PII restrictions.
-- 2. Backfill valid slugs on public.tenants for any legacy tenant with null or empty slug.
-- 3. Update apply_tenant_admin_settings procedure to safely preserve current tenant slug if not provided/empty.

-- Part 1: Redefine vw_student_contracts
DROP VIEW IF EXISTS public.vw_student_contracts;

CREATE VIEW public.vw_student_contracts
WITH (security_invoker = false, security_barrier = true) AS
SELECT 
    p.id AS user_id,
    p.full_name AS student_name,
    p.cpf AS student_cpf,
    p.email AS student_email,
    p.phone AS student_phone,
    
    -- Address Details
    p.postal_code AS student_postal_code,
    p.address AS student_address,
    p.address_number AS student_address_number,
    
    -- Financial Details
    COALESCE(
        NULLIF(p.monthly_fee, 0),
        (
          SELECT sp.value 
          FROM public.student_payments sp 
          WHERE sp.student_id = p.id 
            AND sp.status != 'CANCELLED' 
          ORDER BY sp.due_date DESC 
          LIMIT 1
        ),
        0
    ) AS plan_value,
    p.due_day,
    p.class_frequency,
    
    -- Contract Details
    p.contract_accepted,
    p.accepted_at,
    p.signature_ip,
    p.typed_signature,
    p.signature_hash,
    p.student_signature_url,
    p.signed_document_url,
    p.wise_wolf_signature_token,
    p.documentation_status,
    p.audit_status,
    p.rejection_reason,
    p.tenant_id
FROM public.profiles p
WHERE p.role = 'STUDENT'
  AND (
    (SELECT public._my_role()) = 'SUPER_ADMIN'
    OR (
      p.tenant_id = (SELECT public._my_tenant_id())
      AND (SELECT public._my_role()) IN ('SCHOOL_ADMIN', 'ADMIN')
    )
  );

ALTER VIEW public.vw_student_contracts OWNER TO postgres;
REVOKE ALL ON public.vw_student_contracts FROM anon, public;
GRANT SELECT ON public.vw_student_contracts TO authenticated, service_role;

-- Part 2: Backfill slugs on public.tenants for any records missing a valid slug
UPDATE public.tenants
SET slug = sub.clean_slug
FROM (
  SELECT id,
    CASE
      WHEN length(cleaned) >= 3 THEN substring(cleaned from 1 for 40)
      ELSE substring(cleaned || '-escola' from 1 for 40)
    END AS clean_slug
  FROM (
    SELECT id,
      regexp_replace(
        regexp_replace(
          lower(coalesce(nullif(trim(domain), ''), nullif(trim(id), ''), nullif(trim(name), ''), 'escola')),
          '[^a-z0-9]+', '-', 'g'
        ),
        '^-+|-+$', '', 'g'
      ) AS cleaned
    FROM public.tenants
  ) raw
) sub
WHERE public.tenants.id = sub.id
  AND (
    public.tenants.slug IS NULL
    OR trim(public.tenants.slug) = ''
    OR public.tenants.slug !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$'
    OR length(public.tenants.slug) < 3
    OR length(public.tenants.slug) > 40
  );

-- Part 3: Update apply_tenant_admin_settings to handle optional/empty slug gracefully
CREATE OR REPLACE FUNCTION public.apply_tenant_admin_settings(
  p_tenant_id text,
  p_actor_id uuid,
  p_expected_version integer,
  p_settings jsonb
)
RETURNS TABLE (
  version integer,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_version integer;
  next_version integer;
  current_slug text;
  current_domain text;
  current_name text;
  normalized_name text;
  normalized_slug text;
  normalized_branding jsonb;
  normalized_school_info jsonb;
  actor_role text;
  changes_payload jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_settings IS NULL THEN
    RAISE EXCEPTION 'invalid_parameters' USING ERRCODE = '22023';
  END IF;

  actor_role := private.active_tenant_role(p_actor_id);
  IF actor_role NOT IN ('SCHOOL_ADMIN', 'ADMIN', 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  PERFORM private.assert_operational_tenant(p_tenant_id);

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

  -- Look up existing tenant attributes for safe fallback
  SELECT tenant.slug, tenant.domain, tenant.name
  INTO current_slug, current_domain, current_name
  FROM public.tenants AS tenant
  WHERE tenant.id = p_tenant_id;

  normalized_name := trim(p_settings ->> 'name');
  normalized_slug := lower(trim(coalesce(p_settings ->> 'slug', '')));

  -- Safe fallback to current tenant slug if not provided or empty
  IF normalized_slug = '' THEN
    normalized_slug := lower(trim(coalesce(current_slug, '')));
  END IF;
  -- If still empty, derive a clean valid slug from domain, name, or tenant_id
  IF normalized_slug = '' THEN
    normalized_slug := lower(regexp_replace(regexp_replace(coalesce(current_domain, current_name, p_tenant_id, 'escola'), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'));
    IF length(normalized_slug) < 3 THEN
      normalized_slug := substring(normalized_slug || '-escola' from 1 for 40);
    ELSE
      normalized_slug := substring(normalized_slug from 1 for 40);
    END IF;
  END IF;

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
    'save',
    'settings',
    jsonb_build_object(
      'version', next_version,
      'name', normalized_name,
      'slug', normalized_slug,
      'brandingUpdated', true,
      'schoolInfoUpdated', normalized_school_info IS NOT NULL,
      'whatsappEnabled', (p_settings ->> 'whatsappEnabled')::boolean,
      'financialCutoffDay', (p_settings ->> 'financialCutoffDay')::integer
    )
  );

  RETURN QUERY
  SELECT next_version, now();
END;
$function$;

ALTER FUNCTION public.apply_tenant_admin_settings(text, uuid, integer, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_tenant_admin_settings(text, uuid, integer, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.apply_tenant_admin_settings(text, uuid, integer, jsonb) TO authenticated, service_role;
