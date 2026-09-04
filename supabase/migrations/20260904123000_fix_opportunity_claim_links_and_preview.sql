-- Migration: 20260904123000_fix_opportunity_claim_links_and_preview.sql
-- Fixes:
-- 1. Sets tenant domain for school-wise-wolf to system.wisewolflanguage.com.br
-- 2. Hardens private.secure_trial_portal_origin so wisewolf/system slugs map to system.wisewolflanguage.com.br
-- 3. Enables staff preview in get_teacher_opportunity_preview_secure so administrators and coordinators
--    can preview broadcasted opportunity links without receiving a confusing 'forbidden' error.

UPDATE public.tenants
   SET domain = 'system.wisewolflanguage.com.br'
 WHERE id = 'school-wise-wolf'
   AND (domain IS NULL OR domain = 'wisewolf');

CREATE OR REPLACE FUNCTION private.secure_trial_portal_origin(
  p_tenant_id text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT coalesce(
    CASE
      WHEN tenant.custom_domain_verified IS true
       AND lower(trim(coalesce(tenant.custom_domain, ''))) ~
         '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
      THEN 'https://' || lower(trim(tenant.custom_domain))
    END,
    CASE
      WHEN lower(trim(coalesce(tenant.domain, ''))) ~
         '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'
      THEN 'https://' || lower(trim(tenant.domain))
    END,
    CASE
      WHEN lower(trim(coalesce(tenant.slug, ''))) IN ('wisewolf', 'system')
        OR tenant.id = 'school-wise-wolf'
      THEN 'https://system.wisewolflanguage.com.br'
      WHEN lower(trim(coalesce(tenant.slug, ''))) ~
         '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$'
      THEN 'https://' || lower(trim(tenant.slug)) ||
           '.wisewolflanguage.com.br'
    END,
    'https://system.wisewolflanguage.com.br'
  )
  FROM public.tenants AS tenant
  WHERE tenant.id = p_tenant_id;
$function$;

ALTER FUNCTION private.secure_trial_portal_origin(text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.secure_trial_portal_origin(text)
  FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.secure_trial_portal_origin(text)
  TO postgres;

CREATE OR REPLACE FUNCTION public.get_teacher_opportunity_preview_secure(
  p_opportunity_id uuid,
  p_claim_generation integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid;
  v_tenant_id text;
  v_actor_role text;
  v_opportunity public.opportunities%rowtype;
  v_request private.vendor_trial_teacher_requests%rowtype;
BEGIN
  IF p_opportunity_id IS NULL
     OR p_claim_generation IS NULL
     OR p_claim_generation < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;

  SELECT actor.actor_id, actor.tenant_id, actor.actor_role
    INTO v_actor_id, v_tenant_id, v_actor_role
    FROM private.secure_trial_actor_context() AS actor;

  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_actor_role <> 'TEACHER' AND v_actor_role NOT IN ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF NOT private.tenant_is_operational(v_tenant_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'tenant_not_operational');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles AS profile
     WHERE profile.id = v_actor_id
       AND lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  SELECT opportunity.*
    INTO v_opportunity
    FROM public.opportunities AS opportunity
   WHERE opportunity.id = p_opportunity_id
     AND opportunity.tenant_id = v_tenant_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  END IF;
  IF v_opportunity.claim_generation IS DISTINCT FROM p_claim_generation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'claim_link_expired');
  END IF;

  SELECT request.*
    INTO v_request
    FROM private.vendor_trial_teacher_requests AS request
   WHERE request.opportunity_id = v_opportunity.id;

  IF FOUND AND v_actor_role = 'TEACHER' AND (
    v_request.target_teacher_id <> v_actor_id
    OR v_request.status NOT IN ('AWAITING_TEACHER', 'ACCEPTED')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'opportunity_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_opportunity.id,
    'student_name', v_opportunity.student_name,
    'slots_proposed', v_opportunity.slots_proposed,
    'status', v_opportunity.status,
    'kind', coalesce(v_opportunity.kind, 'TRIAL'),
    'interests', v_opportunity.interests,
    'winner_teacher_id', v_opportunity.winner_teacher_id,
    'trial_appointment_id', v_opportunity.trial_appointment_id,
    'claim_generation', v_opportunity.claim_generation,
    'is_staff_preview', (v_actor_role <> 'TEACHER'),
    'actor_role', v_actor_role
  );
END;
$function$;

ALTER FUNCTION public.get_teacher_opportunity_preview_secure(uuid, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_teacher_opportunity_preview_secure(uuid, integer)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_teacher_opportunity_preview_secure(uuid, integer)
  TO authenticated, service_role;
