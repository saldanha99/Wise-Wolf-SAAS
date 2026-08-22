-- Convites de equipe sao capacidades de uso unico. O tenant e as condicoes
-- comerciais sempre sao derivados da oferta persistida pelo tenant ativo.

DO $guard$
BEGIN
  IF to_regclass('public.offers') IS NULL
    OR to_regclass('public.profiles') IS NULL
    OR to_regclass('public.tenant_memberships') IS NULL
    OR to_regprocedure('private.active_tenant_id(uuid)') IS NULL
    OR to_regprocedure('private.active_tenant_role(uuid)') IS NULL
    OR to_regprocedure('private.tenant_is_operational(text)') IS NULL
    OR to_regprocedure('public.create_enrollment_offer(jsonb)') IS NULL
    OR to_regprocedure('public.begin_enrollment_offer(uuid,jsonb)') IS NULL
    OR to_regprocedure('public.get_enrollment_progress(uuid)') IS NULL
    OR to_regprocedure('public.complete_enrollment_offer(uuid,uuid)') IS NULL
  THEN
    RAISE EXCEPTION 'invite_security_foundation_is_required';
  END IF;
END
$guard$;

ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_kind_check;
ALTER TABLE public.offers
  ADD CONSTRAINT offers_kind_check
  CHECK (kind IN (
    'ENROLLMENT',
    'TEACHER_INVITE',
    'VENDOR_INVITE',
    'COMMERCIAL_INVITE'
  ));

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS invite_claim_token uuid,
  ADD COLUMN IF NOT EXISTS invite_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS invite_security_version smallint NOT NULL DEFAULT 0;

UPDATE public.offers
SET invite_security_version = 0
WHERE invite_security_version IS NULL;
UPDATE public.offers
SET invite_claim_token = NULL,
    invite_claimed_at = NULL
WHERE (invite_claim_token IS NULL) IS DISTINCT FROM (invite_claimed_at IS NULL);
ALTER TABLE public.offers
  ALTER COLUMN invite_security_version SET DEFAULT 0,
  ALTER COLUMN invite_security_version SET NOT NULL;

DO $claim_pair_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.offers'::regclass
      AND constraint_record.conname = 'offers_invite_claim_pair_check'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_invite_claim_pair_check
      CHECK (
        (invite_claim_token IS NULL) = (invite_claimed_at IS NULL)
      );
  END IF;
END
$claim_pair_constraint$;

CREATE INDEX IF NOT EXISTS offers_open_invite_claim_idx
  ON public.offers (kind, invite_claimed_at)
  WHERE kind IN ('TEACHER_INVITE', 'VENDOR_INVITE')
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

-- Ofertas legadas podiam ter tenant/comissao/hora-aula/identidade juridica
-- adulterados no navegador. Elas sao revogadas e precisam ser reemitidas.
UPDATE public.offers
SET revoked_at = now(),
    invite_claim_token = NULL,
    invite_claimed_at = NULL,
    invite_security_version = 1
WHERE kind IN ('TEACHER_INVITE', 'VENDOR_INVITE', 'ENROLLMENT')
  AND invite_security_version = 0
  AND consumed_at IS NULL
  AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION private.valid_cnpj(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  digits text := regexp_replace(coalesce(p_value, ''), '\D', '', 'g');
  first_weights integer[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2];
  second_weights integer[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
  total integer := 0;
  remainder integer;
  expected_digit integer;
  position_index integer;
BEGIN
  IF length(digits) <> 14
    OR digits = repeat(substring(digits FROM 1 FOR 1), 14)
  THEN
    RETURN false;
  END IF;

  FOR position_index IN 1..12 LOOP
    total := total
      + substring(digits FROM position_index FOR 1)::integer
        * first_weights[position_index];
  END LOOP;
  remainder := total % 11;
  expected_digit := CASE WHEN remainder < 2 THEN 0 ELSE 11 - remainder END;
  IF expected_digit <> substring(digits FROM 13 FOR 1)::integer THEN
    RETURN false;
  END IF;

  total := 0;
  FOR position_index IN 1..13 LOOP
    total := total
      + substring(digits FROM position_index FOR 1)::integer
        * second_weights[position_index];
  END LOOP;
  remainder := total % 11;
  expected_digit := CASE WHEN remainder < 2 THEN 0 ELSE 11 - remainder END;
  RETURN expected_digit = substring(digits FROM 14 FOR 1)::integer;
END;
$function$;
REVOKE ALL ON FUNCTION private.valid_cnpj(text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.contract_school_info(p_tenant_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  source_info jsonb;
  canonical_info jsonb;
  signature_url text;
  signature_prefix text := regexp_replace(
    rtrim(
      coalesce(
        nullif(current_setting('app.settings.api_external_url', true), ''),
        'https://api.wisewolflanguage.com.br'
      ),
      '/'
    ),
    '/auth/v1$',
    ''
  ) || '/storage/v1/object/public/tenant-branding/'
    || p_tenant_id || '/signature/';
BEGIN
  SELECT tenant.school_info
  INTO source_info
  FROM public.tenants AS tenant
  WHERE tenant.id = p_tenant_id;

  IF source_info IS NULL OR jsonb_typeof(source_info) <> 'object' THEN
    RAISE EXCEPTION 'tenant_legal_identity_incomplete' USING ERRCODE = '22023';
  END IF;

  canonical_info := jsonb_build_object(
    'legalName', coalesce(
      nullif(trim(source_info ->> 'legalName'), ''),
      nullif(trim(source_info ->> 'name'), '')
    ),
    'cnpj', nullif(trim(source_info ->> 'cnpj'), ''),
    'address', nullif(trim(source_info ->> 'address'), ''),
    'email', nullif(trim(source_info ->> 'email'), ''),
    'phone', nullif(trim(source_info ->> 'phone'), ''),
    'city', nullif(trim(source_info ->> 'city'), ''),
    'state', upper(nullif(trim(source_info ->> 'state'), '')),
    'legalRepresentativeName', coalesce(
      nullif(trim(source_info ->> 'legalRepresentativeName'), ''),
      nullif(trim(source_info ->> 'directorName'), '')
    ),
    'legalRepresentativeSignatureUrl', coalesce(
      nullif(trim(source_info ->> 'legalRepresentativeSignatureUrl'), ''),
      nullif(trim(source_info ->> 'directorSignatureUrl'), ''),
      nullif(trim(source_info ->> 'signatureUrl'), '')
    )
  );
  signature_url := canonical_info ->> 'legalRepresentativeSignatureUrl';

  IF length(coalesce(canonical_info ->> 'legalName', '')) < 2
    OR NOT private.valid_cnpj(canonical_info ->> 'cnpj')
    OR length(coalesce(canonical_info ->> 'address', '')) < 5
    OR position('@' IN coalesce(canonical_info ->> 'email', '')) < 2
    OR length(regexp_replace(coalesce(canonical_info ->> 'phone', ''), '\D', '', 'g')) < 10
    OR length(coalesce(canonical_info ->> 'city', '')) < 2
    OR coalesce(canonical_info ->> 'state', '') !~ '^[A-Z]{2}$'
    OR length(coalesce(canonical_info ->> 'legalRepresentativeName', '')) < 2
    OR left(coalesce(signature_url, ''), length(signature_prefix)) <> signature_prefix
    OR substring(coalesce(signature_url, '') FROM length(signature_prefix) + 1)
      !~ '^[0-9a-fA-F-]{36}\.(png|jpg|jpeg|webp)$'
  THEN
    RAISE EXCEPTION 'tenant_legal_identity_incomplete' USING ERRCODE = '22023';
  END IF;

  RETURN canonical_info;
END;
$function$;
REVOKE ALL ON FUNCTION private.contract_school_info(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.contract_school_info(text)
  TO postgres;

CREATE TABLE IF NOT EXISTS public.tenant_contract_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_kind text NOT NULL CHECK (contract_kind IN ('TEACHER', 'STUDENT')),
  party_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(party_snapshot) = 'object'
    AND pg_column_size(party_snapshot) <= 16384
  ),
  legal_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(legal_snapshot) = 'object'
    AND pg_column_size(legal_snapshot) <= 16384
  ),
  commercial_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(commercial_snapshot) = 'object'
    AND pg_column_size(commercial_snapshot) <= 16384
  ),
  signed_document_path text,
  accepted_at timestamptz NOT NULL,
  accepted_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, contract_kind)
);
ALTER TABLE public.tenant_contract_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_contract_records
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_contract_records
  TO service_role;
GRANT SELECT ON TABLE public.tenant_contract_records
  TO postgres;
CREATE INDEX IF NOT EXISTS tenant_contract_records_user_tenant_idx
  ON public.tenant_contract_records (user_id, tenant_id);

CREATE OR REPLACE FUNCTION public.create_invite_offer(
  p_kind text,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  actor_role text := private.active_tenant_role(actor_id);
  active_tenant_id text := private.active_tenant_id(actor_id);
  safe_payload jsonb;
  offer_id uuid;
BEGIN
  IF actor_id IS NULL
    OR active_tenant_id IS NULL
    OR coalesce(actor_role, '') NOT IN (
      'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'
    )
  THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  IF NOT private.tenant_is_operational(active_tenant_id) THEN
    RAISE EXCEPTION 'tenant_inactive' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL
    OR p_kind NOT IN ('TEACHER_INVITE', 'VENDOR_INVITE')
    OR p_payload IS NULL
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR pg_column_size(p_payload) > 32768
  THEN
    RAISE EXCEPTION 'invalid_invite_payload' USING ERRCODE = '22023';
  END IF;
  IF p_payload ? 'tenant_id'
    OR (
      p_payload ? 'tenantId'
      AND p_payload ->> 'tenantId' IS DISTINCT FROM active_tenant_id
    )
  THEN
    RAISE EXCEPTION 'cross_tenant_invite_denied' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'TEACHER_INVITE' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(p_payload) AS supplied(key)
      WHERE supplied.key NOT IN (
        'kind', 'tenantId', 'hourlyRate', 'subject'
      )
    )
      OR jsonb_typeof(p_payload -> 'hourlyRate') IS DISTINCT FROM 'number'
      OR (p_payload ->> 'hourlyRate')::numeric NOT BETWEEN 1 AND 10000
      OR jsonb_typeof(p_payload -> 'subject') IS DISTINCT FROM 'string'
      OR length(trim(p_payload ->> 'subject')) NOT BETWEEN 2 AND 120
    THEN
      RAISE EXCEPTION 'invalid_teacher_invite' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM jsonb_object_keys(p_payload) AS supplied(key)
      WHERE supplied.key NOT IN (
        'kind', 'tenantId', 'commissionRate', 'suggestedName'
      )
    )
      OR jsonb_typeof(p_payload -> 'commissionRate') IS DISTINCT FROM 'number'
      OR (p_payload ->> 'commissionRate')::numeric NOT BETWEEN 1 AND 10000000
      OR (p_payload ->> 'commissionRate')::numeric
        <> trunc((p_payload ->> 'commissionRate')::numeric)
      OR (
        p_payload ? 'suggestedName'
        AND p_payload -> 'suggestedName' IS DISTINCT FROM 'null'::jsonb
        AND (
          jsonb_typeof(p_payload -> 'suggestedName') IS DISTINCT FROM 'string'
          OR length(trim(p_payload ->> 'suggestedName')) > 120
        )
      )
    THEN
      RAISE EXCEPTION 'invalid_vendor_invite' USING ERRCODE = '22023';
    END IF;
  END IF;

  safe_payload := (p_payload - 'tenant_id' - 'tenantId' - 'kind')
    || jsonb_build_object(
      'kind', p_kind,
      'tenantId', active_tenant_id
    );
  IF p_kind = 'TEACHER_INVITE' THEN
    safe_payload := safe_payload || jsonb_build_object(
      'hourlyRate', (p_payload ->> 'hourlyRate')::numeric,
      'subject', trim(p_payload ->> 'subject'),
      'schoolInfo', private.contract_school_info(active_tenant_id)
    );
  END IF;

  INSERT INTO public.offers (
    kind,
    tenant_id,
    payload,
    expires_at,
    created_by,
    invite_security_version
  )
  VALUES (
    p_kind,
    active_tenant_id,
    safe_payload,
    now() + CASE
      WHEN p_kind = 'TEACHER_INVITE' THEN interval '48 hours'
      ELSE interval '7 days'
    END,
    actor_id,
    1
  )
  RETURNING id INTO offer_id;

  RETURN offer_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_invite_offer(text,jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invite_offer(text,jsonb)
  TO authenticated;

-- Mantem a implementacao comercial existente, mas coloca uma barreira
-- obrigatoria que substitui unitId pelo tenant ACTIVE antes de executa-la.
DO $enrollment_wrapper$
BEGIN
  IF to_regprocedure('public.create_enrollment_offer_authoritative_impl(jsonb)')
      IS NULL
  THEN
    ALTER FUNCTION public.create_enrollment_offer(jsonb)
      RENAME TO create_enrollment_offer_authoritative_impl;
  END IF;
END
$enrollment_wrapper$;
REVOKE ALL ON FUNCTION public.create_enrollment_offer_authoritative_impl(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_enrollment_offer(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := (SELECT auth.uid());
  actor_role text := private.active_tenant_role(actor_id);
  active_tenant_id text := private.active_tenant_id(actor_id);
  safe_payload jsonb;
  target_user_id uuid;
  enrollment_offer_id uuid;
  school_snapshot jsonb;
BEGIN
  IF actor_id IS NULL
    OR active_tenant_id IS NULL
    OR coalesce(actor_role, '') NOT IN (
      'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR', 'TEACHER', 'SALESPERSON'
    )
  THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  IF NOT private.tenant_is_operational(active_tenant_id) THEN
    RAISE EXCEPTION 'tenant_inactive' USING ERRCODE = '42501';
  END IF;
  IF p_payload IS NULL
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR pg_column_size(p_payload) > 65536
  THEN
    RAISE EXCEPTION 'invalid_enrollment_offer' USING ERRCODE = '22023';
  END IF;
  IF p_payload ? 'tenantId'
    OR (
      p_payload ? 'unitId'
      AND p_payload ->> 'unitId' IS DISTINCT FROM active_tenant_id
    )
  THEN
    RAISE EXCEPTION 'cross_tenant_enrollment_denied' USING ERRCODE = '42501';
  END IF;

  FOR target_user_id IN
    SELECT candidate.user_id
    FROM (
      VALUES
        (nullif(p_payload ->> 'professorId', ''), 'TEACHER'),
        (nullif(p_payload ->> 'professorId2', ''), 'TEACHER'),
        (nullif(p_payload ->> 'vendorId', ''), 'SALESPERSON')
    ) AS supplied(raw_user_id, required_role)
    CROSS JOIN LATERAL (
      SELECT supplied.raw_user_id::uuid AS user_id
    ) AS candidate
    WHERE supplied.raw_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.tenant_memberships AS membership
        WHERE membership.user_id = candidate.user_id
          AND membership.tenant_id = active_tenant_id
          AND membership.role = supplied.required_role
          AND membership.status = 'ACTIVE'
      )
  LOOP
    RAISE EXCEPTION 'inactive_enrollment_actor' USING ERRCODE = '42501';
  END LOOP;

  IF nullif(p_payload ->> 'guardianId', '') IS NOT NULL THEN
    BEGIN
      target_user_id := (p_payload ->> 'guardianId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_guardian' USING ERRCODE = '22023';
    END;
    IF NOT EXISTS (
      SELECT 1
      FROM public.tenant_memberships AS membership
      WHERE membership.user_id = target_user_id
        AND membership.tenant_id = active_tenant_id
        AND membership.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'inactive_guardian' USING ERRCODE = '42501';
    END IF;
  END IF;

  school_snapshot := private.contract_school_info(active_tenant_id);
  safe_payload := (
    p_payload - 'tenantId' - 'unitId' - '_schoolInfo' - 'schoolInfo'
  ) || jsonb_build_object(
    'unitId', active_tenant_id,
    '_schoolInfo', school_snapshot
  );
  enrollment_offer_id := public.create_enrollment_offer_authoritative_impl(
    safe_payload
  );
  UPDATE public.offers
  SET invite_security_version = 1
  WHERE id = enrollment_offer_id
    AND tenant_id = active_tenant_id
    AND kind = 'ENROLLMENT';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enrollment_offer_scope_mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN enrollment_offer_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_enrollment_offer(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_enrollment_offer(jsonb)
  TO authenticated;

-- A maquina de estados de matricula e mantida, mas tenants suspensos nao podem
-- abrir, iniciar nem concluir ofertas emitidas anteriormente.
DO $enrollment_begin_wrapper$
BEGIN
  IF to_regprocedure('public.begin_enrollment_offer_authoritative_impl(uuid,jsonb)')
      IS NULL
  THEN
    ALTER FUNCTION public.begin_enrollment_offer(uuid,jsonb)
      RENAME TO begin_enrollment_offer_authoritative_impl;
  END IF;
END
$enrollment_begin_wrapper$;
REVOKE ALL ON FUNCTION public.begin_enrollment_offer_authoritative_impl(uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_enrollment_offer(
  p_offer_id uuid,
  p_profile jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  offer_tenant_id text;
  offer_security_version smallint;
BEGIN
  SELECT offer.tenant_id, offer.invite_security_version
  INTO offer_tenant_id, offer_security_version
  FROM public.offers AS offer
  WHERE offer.id = p_offer_id
    AND offer.kind = 'ENROLLMENT';
  IF offer_tenant_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  END IF;
  IF offer_security_version < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_REVOKED');
  END IF;
  IF NOT private.tenant_is_operational(offer_tenant_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TENANT_UNAVAILABLE');
  END IF;
  RETURN public.begin_enrollment_offer_authoritative_impl(p_offer_id, p_profile);
END;
$function$;
REVOKE ALL ON FUNCTION public.begin_enrollment_offer(uuid,jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_enrollment_offer(uuid,jsonb)
  TO authenticated;

-- O progresso contem PII do cadastro em andamento. Ele continua visivel apenas
-- ao titular da tentativa, mas tambem fecha quando o tenant deixa de operar.
DO $enrollment_progress_wrapper$
BEGIN
  IF to_regprocedure('public.get_enrollment_progress_authoritative_impl(uuid)')
      IS NULL
  THEN
    ALTER FUNCTION public.get_enrollment_progress(uuid)
      RENAME TO get_enrollment_progress_authoritative_impl;
  END IF;
END
$enrollment_progress_wrapper$;
REVOKE ALL ON FUNCTION public.get_enrollment_progress_authoritative_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_enrollment_progress(p_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  enrollment_offer record;
BEGIN
  IF caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  SELECT
    offer.tenant_id,
    offer.invite_security_version,
    offer.revoked_at,
    offer.consumed_at,
    offer.expires_at
  INTO enrollment_offer
  FROM public.offers AS offer
  WHERE offer.id = p_offer_id
    AND offer.kind = 'ENROLLMENT'
    AND (
      offer.processing_by = caller_id
      OR offer.consumed_by = caller_id
    );

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'status', 'NOT_STARTED');
  END IF;
  IF enrollment_offer.invite_security_version < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_REVOKED');
  END IF;
  IF NOT private.tenant_is_operational(enrollment_offer.tenant_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TENANT_UNAVAILABLE');
  END IF;
  IF enrollment_offer.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_REVOKED');
  END IF;
  IF enrollment_offer.consumed_at IS NULL
    AND (
      enrollment_offer.expires_at IS NULL
      OR enrollment_offer.expires_at <= now()
    )
  THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED');
  END IF;

  RETURN public.get_enrollment_progress_authoritative_impl(p_offer_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_enrollment_progress(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_enrollment_progress(uuid)
  TO authenticated;

DO $enrollment_complete_wrapper$
BEGIN
  IF to_regprocedure('public.complete_enrollment_offer_authoritative_impl(uuid,uuid)')
      IS NULL
  THEN
    ALTER FUNCTION public.complete_enrollment_offer(uuid,uuid)
      RENAME TO complete_enrollment_offer_authoritative_impl;
  END IF;
END
$enrollment_complete_wrapper$;
REVOKE ALL ON FUNCTION public.complete_enrollment_offer_authoritative_impl(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_enrollment_offer(
  p_offer_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  offer_tenant_id text;
  offer_security_version smallint;
BEGIN
  SELECT offer.tenant_id, offer.invite_security_version
  INTO offer_tenant_id, offer_security_version
  FROM public.offers AS offer
  WHERE offer.id = p_offer_id
    AND offer.kind = 'ENROLLMENT';
  IF offer_tenant_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  END IF;
  IF offer_security_version < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_REVOKED');
  END IF;
  IF NOT private.tenant_is_operational(offer_tenant_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TENANT_UNAVAILABLE');
  END IF;
  RETURN public.complete_enrollment_offer_authoritative_impl(
    p_offer_id,
    p_user_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_enrollment_offer(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_enrollment_offer(uuid,uuid)
  TO service_role;

DO $legacy_claim$
BEGIN
  IF to_regprocedure('public.claim_enrollment_offer(uuid,jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.claim_enrollment_offer(uuid,jsonb)
      FROM PUBLIC, anon, authenticated;
  END IF;
END
$legacy_claim$;

CREATE OR REPLACE FUNCTION public.get_offer_public(p_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  enrollment_offer record;
  school_info jsonb;
BEGIN
  SELECT
    offer.id,
    offer.tenant_id,
    offer.payload,
    offer.revoked_at,
    offer.consumed_at,
    offer.consumed_by,
    offer.expires_at,
    offer.requires_enrollment,
    offer.enrollment_fee,
    offer.opportunity_id,
    offer.vendor_id,
    offer.invite_security_version
  INTO enrollment_offer
  FROM public.offers AS offer
  WHERE offer.id = p_offer_id
    AND offer.kind = 'ENROLLMENT';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'OFFER_NOT_FOUND');
  END IF;
  IF enrollment_offer.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'OFFER_REVOKED');
  END IF;
  IF enrollment_offer.invite_security_version < 1 THEN
    RETURN jsonb_build_object('error', 'OFFER_REVOKED');
  END IF;
  IF enrollment_offer.consumed_at IS NOT NULL
    AND enrollment_offer.consumed_by IS DISTINCT FROM (SELECT auth.uid())
  THEN
    RETURN jsonb_build_object('error', 'OFFER_CONSUMED');
  END IF;
  IF enrollment_offer.consumed_at IS NULL
    AND (
      enrollment_offer.expires_at IS NULL
      OR enrollment_offer.expires_at <= now()
    )
  THEN
    RETURN jsonb_build_object('error', 'OFFER_EXPIRED');
  END IF;
  IF NOT private.tenant_is_operational(enrollment_offer.tenant_id) THEN
    RETURN jsonb_build_object('error', 'TENANT_UNAVAILABLE');
  END IF;
  IF enrollment_offer.opportunity_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.opportunities AS opportunity
    WHERE opportunity.id = enrollment_offer.opportunity_id
      AND opportunity.tenant_id = enrollment_offer.tenant_id
      AND opportunity.conversion_status = 'WON'
      AND (
        opportunity.student_id IS NULL
        OR opportunity.student_id IS DISTINCT FROM (SELECT auth.uid())
      )
  ) THEN
    RETURN jsonb_build_object('error', 'OPPORTUNITY_CONVERTED');
  END IF;

  school_info := enrollment_offer.payload -> '_schoolInfo';
  IF jsonb_typeof(school_info) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('error', 'OFFER_LEGAL_SNAPSHOT_MISSING');
  END IF;
  RETURN coalesce(enrollment_offer.payload, '{}'::jsonb)
    || jsonb_build_object(
      '_offerId', enrollment_offer.id,
      '_schoolInfo', school_info,
      'unitId', enrollment_offer.tenant_id,
      'requiresEnrollment', enrollment_offer.requires_enrollment,
      'enrollmentFee', enrollment_offer.enrollment_fee,
      'opportunityId', enrollment_offer.opportunity_id,
      'vendorId', enrollment_offer.vendor_id
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_offer_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_offer_public(uuid)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_invite_offer_public(p_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  invite_offer record;
BEGIN
  SELECT
    offer.id,
    offer.kind,
    offer.tenant_id,
    offer.payload,
    offer.expires_at,
    offer.consumed_at,
    offer.revoked_at,
    offer.invite_security_version,
    offer.invite_claim_token,
    offer.invite_claimed_at
  INTO invite_offer
  FROM public.offers AS offer
  WHERE offer.id = p_offer_id
    AND offer.kind IN ('VENDOR_INVITE', 'TEACHER_INVITE');

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'OFFER_NOT_FOUND');
  END IF;
  IF invite_offer.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'OFFER_CONSUMED');
  END IF;
  IF invite_offer.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'OFFER_REVOKED');
  END IF;
  IF invite_offer.invite_security_version < 1 THEN
    RETURN jsonb_build_object('error', 'OFFER_REVOKED');
  END IF;
  IF invite_offer.expires_at IS NULL OR invite_offer.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'OFFER_EXPIRED');
  END IF;
  IF NOT private.tenant_is_operational(invite_offer.tenant_id) THEN
    RETURN jsonb_build_object('error', 'TENANT_UNAVAILABLE');
  END IF;
  IF invite_offer.invite_claim_token IS NOT NULL
    AND coalesce(invite_offer.invite_claimed_at, '-infinity'::timestamptz)
      > now() - interval '15 minutes'
  THEN
    RETURN jsonb_build_object('error', 'OFFER_PROCESSING');
  END IF;

  RETURN coalesce(invite_offer.payload, '{}'::jsonb)
    || jsonb_build_object(
      'kind', invite_offer.kind,
      'tenantId', invite_offer.tenant_id,
      '_offerId', invite_offer.id
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_invite_offer_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invite_offer_public(uuid)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_invite_offer_server(
  p_offer_id uuid,
  p_kind text,
  p_claim_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  claimed_offer record;
BEGIN
  IF p_kind IS NULL
    OR p_kind NOT IN ('TEACHER_INVITE', 'VENDOR_INVITE')
    OR p_claim_token IS NULL
  THEN
    RAISE EXCEPTION 'invalid_invite_claim' USING ERRCODE = '22023';
  END IF;

  UPDATE public.offers AS offer
  SET invite_claim_token = p_claim_token,
      invite_claimed_at = now()
  WHERE offer.id = p_offer_id
    AND offer.kind = p_kind
    AND offer.invite_security_version >= 1
    AND private.tenant_is_operational(offer.tenant_id)
    AND offer.consumed_at IS NULL
    AND offer.revoked_at IS NULL
    AND offer.expires_at > now()
    AND (
      offer.invite_claim_token IS NULL
      OR offer.invite_claimed_at IS NULL
      OR offer.invite_claimed_at <= now() - interval '15 minutes'
    )
  RETURNING offer.id, offer.kind, offer.tenant_id, offer.payload
  INTO claimed_offer;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite_unavailable' USING ERRCODE = 'P0002';
  END IF;
  IF claimed_offer.tenant_id IS NULL
    OR jsonb_typeof(claimed_offer.payload) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'invalid_persisted_invite' USING ERRCODE = '22023';
  END IF;

  RETURN claimed_offer.payload
    || jsonb_build_object(
      'kind', claimed_offer.kind,
      'tenantId', claimed_offer.tenant_id,
      '_offerId', claimed_offer.id
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_invite_offer_server(uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_invite_offer_server(uuid,text,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.release_invite_offer_claim_server(
  p_offer_id uuid,
  p_kind text,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH released AS (
    UPDATE public.offers AS offer
    SET invite_claim_token = NULL,
        invite_claimed_at = NULL
    WHERE offer.id = p_offer_id
      AND offer.kind = p_kind
      AND offer.invite_claim_token = p_claim_token
      AND offer.consumed_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM released);
$function$;
REVOKE ALL ON FUNCTION public.release_invite_offer_claim_server(uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_invite_offer_claim_server(uuid,text,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_invite_offer_server(
  p_offer_id uuid,
  p_kind text,
  p_claim_token uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  offer_tenant_id text;
  offer_payload jsonb;
  expected_role text;
BEGIN
  expected_role := CASE p_kind
    WHEN 'TEACHER_INVITE' THEN 'TEACHER'
    WHEN 'VENDOR_INVITE' THEN 'SALESPERSON'
    ELSE NULL
  END;
  IF expected_role IS NULL OR p_claim_token IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_invite_finalize' USING ERRCODE = '22023';
  END IF;

  SELECT offer.tenant_id, offer.payload
  INTO offer_tenant_id, offer_payload
  FROM public.offers AS offer
  WHERE offer.id = p_offer_id
    AND offer.kind = p_kind
    AND offer.invite_claim_token = p_claim_token
    AND offer.invite_security_version >= 1
    AND offer.consumed_at IS NULL
    AND offer.revoked_at IS NULL
    AND offer.expires_at > now()
    AND offer.invite_claimed_at > now() - interval '15 minutes'
  FOR UPDATE;

  IF offer_tenant_id IS NULL THEN
    RAISE EXCEPTION 'invite_claim_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT private.tenant_is_operational(offer_tenant_id) THEN
    RAISE EXCEPTION 'tenant_inactive' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.user_id = p_user_id
      AND membership.tenant_id = offer_tenant_id
      AND membership.role = expected_role
      AND membership.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'invite_profile_scope_mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_kind = 'TEACHER_INVITE' AND NOT EXISTS (
    SELECT 1
    FROM public.tenant_contract_records AS contract
    WHERE contract.tenant_id = offer_tenant_id
      AND contract.user_id = p_user_id
      AND contract.contract_kind = 'TEACHER'
      AND contract.legal_snapshot = offer_payload -> 'schoolInfo'
      AND contract.commercial_snapshot -> 'hourlyRate'
        = offer_payload -> 'hourlyRate'
      AND contract.commercial_snapshot ->> 'subject'
        = offer_payload ->> 'subject'
  ) THEN
    RAISE EXCEPTION 'invite_contract_snapshot_missing' USING ERRCODE = '42501';
  END IF;

  UPDATE public.offers
  SET consumed_at = now(),
      consumed_by = p_user_id,
      invite_claim_token = NULL,
      invite_claimed_at = NULL
  WHERE id = p_offer_id;

  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.finalize_invite_offer_server(uuid,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_invite_offer_server(uuid,text,uuid,uuid)
  TO service_role;

-- A consulta antiga por UUID puro lia PII global de profiles. Agora o documento
-- vem de um snapshot imutavel, vinculado ao tenant do contrato.
CREATE OR REPLACE FUNCTION public.get_contract_public(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  caller_tenant_id text := private.active_tenant_id(caller_id);
  caller_role text := private.active_tenant_role(caller_id);
  contract_record record;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
  END IF;

  IF caller_tenant_id IS NULL THEN
    RAISE EXCEPTION 'active_tenant_required' USING ERRCODE = '42501';
  END IF;
  IF caller_id IS DISTINCT FROM p_id
    AND coalesce(caller_role, '') NOT IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  THEN
    RAISE EXCEPTION 'cross_tenant_contract_denied' USING ERRCODE = '42501';
  END IF;

  SELECT
    contract.party_snapshot,
    contract.legal_snapshot,
    contract.commercial_snapshot,
    contract.accepted_at,
    contract.accepted_ip
  INTO contract_record
  FROM public.tenant_contract_records AS contract
  WHERE contract.user_id = p_id
    AND contract.tenant_id = caller_tenant_id
    AND contract.contract_kind = 'TEACHER';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'full_name', contract_record.party_snapshot ->> 'fullName',
    'rg', contract_record.party_snapshot ->> 'rg',
    'cpf', contract_record.party_snapshot ->> 'cpf',
    'address', contract_record.party_snapshot ->> 'address',
    'birth_date', contract_record.party_snapshot ->> 'birthDate',
    'hourly_rate', (contract_record.commercial_snapshot ->> 'hourlyRate')::numeric,
    'contract_accepted', true,
    'accepted_at', contract_record.accepted_at,
    'user_ip', contract_record.accepted_ip,
    'schoolInfo', contract_record.legal_snapshot
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_contract_public(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contract_public(uuid)
  TO authenticated, service_role;
