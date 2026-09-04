-- ==============================================================================
-- Migration: 20260902213000_student_enrollment_pedagogical_level_placement.sql
-- Objetivo: Garantir que novos alunos matriculados via link recebam o nível
--           pedagógico correto (A1, A2, B1, etc.) e o livro inicial correspondente
--           (ex: A2-1, B1-1) a partir da oferta ou aula experimental, eliminando
--           o valor estático legado 'General' e a trava em 'A1-1'.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.claim_enrollment_offer(
  p_offer_id uuid,
  p_profile jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_existing_role text;
  v_opportunity_id uuid;
  v_payload jsonb;
  v_dependent boolean;
  v_fee numeric;
  v_phone text;
  v_cpf text;
  v_invite_id uuid;
  v_referrer_id uuid;
  v_referrer_role text;
  v_referrer_teacher_id uuid;
  v_referrer_student_id uuid;
  v_vendor_role text;
  v_vendor_tenant text;
  v_commission_rate integer;
  v_enrollment_link_id uuid;
  v_desired_module text;
  v_desired_book_part text;
  o public.offers%ROWTYPE;
  v_opp public.opportunities%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  SELECT opportunity_id
    INTO v_opportunity_id
    FROM public.offers
   WHERE id = p_offer_id
     AND kind = 'ENROLLMENT';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  END IF;

  -- Mesma ordem de locks da emissão: opportunity -> offer.
  IF v_opportunity_id IS NOT NULL THEN
    SELECT * INTO v_opp
      FROM public.opportunities
     WHERE id = v_opportunity_id
     FOR UPDATE;
  END IF;

  SELECT * INTO o
    FROM public.offers
   WHERE id = p_offer_id
     AND kind = 'ENROLLMENT'
   FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND'); END IF;
  IF o.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'OFFER_REVOKED'); END IF;
  IF o.consumed_at IS NOT NULL AND o.consumed_by IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_CONSUMED');
  END IF;
  IF o.consumed_at IS NULL AND o.expires_at <= now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED');
  END IF;

  IF v_opportunity_id IS NOT NULL THEN
    IF v_opp.id IS NULL OR v_opp.tenant_id IS DISTINCT FROM o.tenant_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'OPPORTUNITY_INVALID');
    END IF;
    IF v_opp.conversion_status = 'LOST' THEN
      RETURN jsonb_build_object('success', false, 'error', 'OPPORTUNITY_CLOSED');
    END IF;
    IF v_opp.conversion_status = 'WON'
       AND (v_opp.student_id IS NULL OR v_opp.student_id IS DISTINCT FROM v_user) THEN
      RETURN jsonb_build_object('success', false, 'error', 'OPPORTUNITY_CONVERTED');
    END IF;
  END IF;

  SELECT p.role
    INTO v_existing_role
    FROM public.profiles p
   WHERE p.id = v_user
   FOR UPDATE;
  IF FOUND AND v_existing_role IS DISTINCT FROM 'STUDENT' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROFILE_ROLE_NOT_ALLOWED');
  END IF;

  SELECT lower(trim(u.email))
    INTO v_email
    FROM auth.users u
   WHERE u.id = v_user;
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  v_payload := COALESCE(o.payload, '{}'::jsonb) || jsonb_build_object(
    'unitId', o.tenant_id,
    'requiresEnrollment', o.requires_enrollment,
    'enrollmentFee', o.enrollment_fee,
    'opportunityId', o.opportunity_id,
    'vendorId', o.vendor_id
  );
  v_dependent := COALESCE((v_payload ->> 'isDependent')::boolean, false);
  v_fee := GREATEST(COALESCE(o.enrollment_fee, 0), 0);
  v_phone := regexp_replace(COALESCE(p_profile ->> 'phone', ''), '[^0-9]', '', 'g');
  v_cpf := regexp_replace(COALESCE(p_profile ->> 'cpf', ''), '[^0-9]', '', 'g');

  IF length(trim(COALESCE(p_profile ->> 'full_name', ''))) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_NAME');
  END IF;
  IF length(v_phone) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PHONE');
  END IF;
  IF NOT v_dependent AND length(v_cpf) <> 11 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_CPF');
  END IF;

  -- --------------------------------------------------------------------------
  -- Determinação do Nível Pedagógico Inicial (CEFR) e Livro Inicial
  -- --------------------------------------------------------------------------
  v_desired_module := pg_catalog.upper(pg_catalog.btrim(coalesce(
    v_payload ->> 'module',
    v_payload ->> 'studentLevel',
    v_payload ->> 'level',
    ''
  )));

  -- Fallback 1: Buscar do feedback da aula experimental vinculada à oportunidade
  IF (v_desired_module IS NULL OR v_desired_module = '') AND o.opportunity_id IS NOT NULL THEN
    SELECT pg_catalog.upper(pg_catalog.btrim(tf.recommended_level))
      INTO v_desired_module
      FROM public.trial_feedback tf
     WHERE tf.opportunity_id = o.opportunity_id
       AND tf.recommended_level IS NOT NULL
       AND pg_catalog.btrim(tf.recommended_level) <> ''
     ORDER BY tf.created_at DESC
     LIMIT 1;
  END IF;

  -- Fallback 2: Buscar do cadastro do CRM (crm_leads) por e-mail ou telefone
  IF v_desired_module IS NULL OR v_desired_module = '' THEN
    SELECT CASE 
             WHEN pg_catalog.upper(cl.level) LIKE '%A2%' THEN 'A2'
             WHEN pg_catalog.upper(cl.level) LIKE '%B1%' THEN 'B1'
             WHEN pg_catalog.upper(cl.level) LIKE '%B2%' THEN 'B2'
             WHEN pg_catalog.upper(cl.level) LIKE '%C1%' THEN 'C1'
             WHEN pg_catalog.upper(cl.level) LIKE '%C2%' THEN 'C2'
             WHEN pg_catalog.upper(cl.level) LIKE '%A1%' THEN 'A1'
             ELSE NULL
           END
      INTO v_desired_module
      FROM public.crm_leads cl
     WHERE (cl.email IS NOT NULL AND lower(cl.email) = lower(v_email))
        OR (v_phone IS NOT NULL AND length(v_phone) >= 10 AND regexp_replace(coalesce(cl.phone, ''), '[^0-9]', '', 'g') = v_phone)
     ORDER BY cl.created_at DESC
     LIMIT 1;
  END IF;

  -- Normalização para níveis CEFR válidos (padrão de entrada seguro: A1)
  IF v_desired_module IS NULL OR v_desired_module NOT IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2') THEN
    v_desired_module := 'A1';
  END IF;

  -- Obtenção do primeiro marco ativo do catálogo pedagógico
  SELECT catalog.book_part
    INTO v_desired_book_part
    FROM public.pedagogical_evaluation_catalog as catalog
   WHERE catalog.module = v_desired_module
     AND catalog.active is true
   ORDER BY catalog.part ASC
   LIMIT 1;

  IF v_desired_book_part IS NULL THEN
    v_desired_book_part := v_desired_module || '-1';
  END IF;

  -- A indicação é derivada do convite por e-mail e tenant, nunca de UUID no URL.
  SELECT ri.id, ri.referrer_id, rp.role
    INTO v_invite_id, v_referrer_id, v_referrer_role
    FROM public.referral_invites ri
    JOIN public.profiles rp ON rp.id = ri.referrer_id
   WHERE lower(trim(ri.invitee_email)) = v_email
     AND ri.status = 'PENDING'
     AND ri.expires_at > now()
     AND (ri.tenant_id IS NULL OR ri.tenant_id = o.tenant_id)
     AND rp.tenant_id = o.tenant_id
     AND ri.referrer_id <> v_user
   ORDER BY ri.created_at DESC
   LIMIT 1
   FOR UPDATE OF ri;

  IF v_invite_id IS NOT NULL THEN
    IF v_referrer_role IN ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR') THEN
      v_referrer_teacher_id := v_referrer_id;
    ELSIF v_referrer_role = 'STUDENT' THEN
      v_referrer_student_id := v_referrer_id;
    END IF;
  END IF;

  PERFORM set_config('app.enrollment_claim', '1', true);

  UPDATE public.offers
     SET consumed_at = COALESCE(consumed_at, now()),
         consumed_by = COALESCE(consumed_by, v_user),
         usage_count = COALESCE(usage_count, 0)
           + CASE WHEN consumed_at IS NULL THEN 1 ELSE 0 END,
         last_used_at = now()
   WHERE id = o.id;

  INSERT INTO public.profiles (
    id, email, full_name, role, tenant_id, phone, cpf, postal_code,
    address, address_number, status_financial, monthly_fee, due_day,
    module, current_book_part, contract_accepted, documentation_status, accepted_at,
    class_frequency, signature_ip, student_signature_url,
    signed_document_url, wise_wolf_signature_token, enrollment_fee,
    enrollment_fee_paid, professor_id, professor_id2, start_date,
    guardian_id, guardian_name, guardian_cpf, guardian_email,
    guardian_phone, attendance_phone, referrer_teacher_id,
    referrer_student_id
  )
  VALUES (
    v_user,
    v_email,
    trim(p_profile ->> 'full_name'),
    'STUDENT',
    o.tenant_id,
    v_phone,
    CASE WHEN v_dependent THEN NULL ELSE v_cpf END,
    NULLIF(p_profile ->> 'postal_code', ''),
    NULLIF(p_profile ->> 'address', ''),
    NULLIF(p_profile ->> 'address_number', ''),
    'PENDING',
    (v_payload ->> 'value')::numeric,
    (v_payload ->> 'dueDay')::integer,
    v_desired_module,
    v_desired_book_part,
    true,
    'APPROVED',
    now(),
    COALESCE(v_payload ->> 'classesPerWeek', '1') || 'x',
    COALESCE(NULLIF(p_profile ->> 'signature_ip', ''), 'Via Web'),
    NULLIF(p_profile ->> 'student_signature_url', ''),
    NULLIF(p_profile ->> 'signed_document_url', ''),
    gen_random_uuid()::text,
    v_fee,
    v_fee <= 0,
    NULLIF(v_payload ->> 'professorId', '')::uuid,
    NULLIF(v_payload ->> 'professorId2', '')::uuid,
    NULLIF(v_payload ->> 'startDate', '')::date,
    CASE WHEN v_dependent THEN NULLIF(v_payload ->> 'guardianId', '')::uuid ELSE NULL END,
    CASE WHEN v_dependent THEN NULLIF(v_payload ->> 'guardianName', '') ELSE NULL END,
    CASE WHEN v_dependent THEN regexp_replace(COALESCE(v_payload ->> 'guardianCpf', ''), '[^0-9]', '', 'g') ELSE NULL END,
    CASE WHEN v_dependent THEN NULLIF(v_payload ->> 'guardianEmail', '') ELSE NULL END,
    CASE WHEN v_dependent THEN regexp_replace(COALESCE(v_payload ->> 'guardianPhone', ''), '[^0-9]', '', 'g') ELSE NULL END,
    CASE WHEN v_dependent THEN regexp_replace(COALESCE(v_payload ->> 'studentPhone', ''), '[^0-9]', '', 'g') ELSE NULL END,
    v_referrer_teacher_id,
    v_referrer_student_id
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    role = 'STUDENT',
    tenant_id = EXCLUDED.tenant_id,
    phone = EXCLUDED.phone,
    cpf = EXCLUDED.cpf,
    postal_code = EXCLUDED.postal_code,
    address = EXCLUDED.address,
    address_number = EXCLUDED.address_number,
    status_financial = 'PENDING',
    monthly_fee = EXCLUDED.monthly_fee,
    due_day = EXCLUDED.due_day,
    module = CASE
      WHEN public.profiles.module IS NULL OR public.profiles.module IN ('General', '') THEN EXCLUDED.module
      ELSE public.profiles.module
    END,
    current_book_part = CASE
      WHEN public.profiles.current_book_part IS NULL OR public.profiles.current_book_part = 'A1-1' THEN EXCLUDED.current_book_part
      ELSE public.profiles.current_book_part
    END,
    contract_accepted = true,
    documentation_status = EXCLUDED.documentation_status,
    accepted_at = COALESCE(public.profiles.accepted_at, EXCLUDED.accepted_at),
    class_frequency = EXCLUDED.class_frequency,
    signature_ip = EXCLUDED.signature_ip,
    student_signature_url = COALESCE(EXCLUDED.student_signature_url, public.profiles.student_signature_url),
    signed_document_url = COALESCE(EXCLUDED.signed_document_url, public.profiles.signed_document_url),
    wise_wolf_signature_token = COALESCE(public.profiles.wise_wolf_signature_token, EXCLUDED.wise_wolf_signature_token),
    enrollment_fee = EXCLUDED.enrollment_fee,
    enrollment_fee_paid = CASE
      WHEN EXCLUDED.enrollment_fee <= 0 THEN true
      ELSE COALESCE(public.profiles.enrollment_fee_paid, false)
    END,
    professor_id = EXCLUDED.professor_id,
    professor_id2 = EXCLUDED.professor_id2,
    start_date = EXCLUDED.start_date,
    guardian_id = EXCLUDED.guardian_id,
    guardian_name = EXCLUDED.guardian_name,
    guardian_cpf = EXCLUDED.guardian_cpf,
    guardian_email = EXCLUDED.guardian_email,
    guardian_phone = EXCLUDED.guardian_phone,
    attendance_phone = EXCLUDED.attendance_phone,
    referrer_teacher_id = COALESCE(public.profiles.referrer_teacher_id, EXCLUDED.referrer_teacher_id),
    referrer_student_id = COALESCE(public.profiles.referrer_student_id, EXCLUDED.referrer_student_id);

  IF v_invite_id IS NOT NULL
     AND (v_referrer_teacher_id IS NOT NULL OR v_referrer_student_id IS NOT NULL) THEN
    UPDATE public.referral_invites
       SET status = 'CONVERTED',
           converted_at = COALESCE(converted_at, now()),
           converted_student_id = v_user
     WHERE id = v_invite_id
       AND status = 'PENDING';
  END IF;

  IF o.opportunity_id IS NOT NULL THEN
    UPDATE public.opportunities
       SET conversion_status = 'WON',
           student_id = v_user
     WHERE id = o.opportunity_id;
  END IF;

  SELECT el.id
    INTO v_enrollment_link_id
    FROM public.enrollment_links el
   WHERE el.offer_id = o.id
   LIMIT 1;

  UPDATE public.enrollment_links
     SET status = 'USED',
         used_at = COALESCE(used_at, now())
   WHERE offer_id = o.id
     AND status = 'PENDING';

  IF o.vendor_id IS NOT NULL THEN
    SELECT p.role, p.tenant_id, COALESCE(p.commission_rate, 3000)
      INTO v_vendor_role, v_vendor_tenant, v_commission_rate
      FROM public.profiles p
     WHERE p.id = o.vendor_id;

    IF v_vendor_role = 'SALESPERSON'
       AND v_vendor_tenant = o.tenant_id THEN
      INSERT INTO public.vendor_commissions (
        vendor_id, student_id, enrollment_link_id, offer_id,
        amount_brl, status, tenant_id
      )
      VALUES (
        o.vendor_id, v_user, v_enrollment_link_id, o.id,
        v_commission_rate, 'PENDING', o.tenant_id
      )
      ON CONFLICT (offer_id) WHERE offer_id IS NOT NULL DO NOTHING;
    END IF;
  END IF;

  -- Registro de auditoria do posicionamento inicial
  IF to_regclass('public.pedagogical_placement_audit') IS NOT NULL THEN
    INSERT INTO public.pedagogical_placement_audit (
      tenant_id,
      student_id,
      actor_id,
      previous_module,
      previous_book_part,
      new_module,
      new_book_part,
      reason
    ) VALUES (
      o.tenant_id,
      v_user,
      v_user,
      NULL,
      NULL,
      v_desired_module,
      v_desired_book_part,
      'Posicionamento pedagógico inicial na matrícula autorizada'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'offer_id', o.id,
    'payload', v_payload || jsonb_build_object('_offerId', o.id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_enrollment_offer(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ==============================================================================
-- Sanitização dos dados legados: alunos que ainda estão com 'General' ou nulo
-- ==============================================================================
UPDATE public.profiles
   SET module = 'A1'
 WHERE role = 'STUDENT'
   AND (module = 'General' OR module IS NULL OR module = '')
   AND (current_book_part = 'A1-1' OR current_book_part IS NULL);
