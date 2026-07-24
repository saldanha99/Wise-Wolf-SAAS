BEGIN;

-- Matrículas emitidas a partir de uma experimental precisam de vínculos
-- relacionais reais. Não usamos mais IDs escondidos dentro de JSON/URL.
ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS created_by_vendor_id uuid;
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS consumed_by uuid,
  ADD COLUMN IF NOT EXISTS opportunity_id uuid,
  ADD COLUMN IF NOT EXISTS vendor_id uuid;
ALTER TABLE public.enrollment_links
  ADD COLUMN IF NOT EXISTS offer_id uuid;
ALTER TABLE public.vendor_commissions
  ADD COLUMN IF NOT EXISTS offer_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.opportunities'::regclass
       AND conname = 'opportunities_created_by_vendor_id_fkey'
  ) THEN
    ALTER TABLE public.opportunities
      ADD CONSTRAINT opportunities_created_by_vendor_id_fkey
      FOREIGN KEY (created_by_vendor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.offers'::regclass
       AND conname = 'offers_consumed_by_fkey'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_consumed_by_fkey
      FOREIGN KEY (consumed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.offers'::regclass
       AND conname = 'offers_opportunity_id_fkey'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_opportunity_id_fkey
      FOREIGN KEY (opportunity_id) REFERENCES public.opportunities(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.offers'::regclass
       AND conname = 'offers_vendor_id_fkey'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_vendor_id_fkey
      FOREIGN KEY (vendor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.enrollment_links'::regclass
       AND conname = 'enrollment_links_offer_id_fkey'
  ) THEN
    ALTER TABLE public.enrollment_links
      ADD CONSTRAINT enrollment_links_offer_id_fkey
      FOREIGN KEY (offer_id) REFERENCES public.offers(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.vendor_commissions'::regclass
       AND conname = 'vendor_commissions_offer_id_fkey'
  ) THEN
    ALTER TABLE public.vendor_commissions
      ADD CONSTRAINT vendor_commissions_offer_id_fkey
      FOREIGN KEY (offer_id) REFERENCES public.offers(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS opportunities_created_by_vendor_idx
  ON public.opportunities (created_by_vendor_id);
CREATE INDEX IF NOT EXISTS offers_consumed_by_kind_idx
  ON public.offers (consumed_by, kind, consumed_at DESC);
CREATE INDEX IF NOT EXISTS offers_opportunity_idx
  ON public.offers (opportunity_id);
CREATE INDEX IF NOT EXISTS offers_vendor_idx
  ON public.offers (vendor_id);
CREATE INDEX IF NOT EXISTS enrollment_links_offer_idx
  ON public.enrollment_links (offer_id);
CREATE INDEX IF NOT EXISTS vendor_commissions_offer_idx
  ON public.vendor_commissions (offer_id);

-- Vocabulário produzido pelo cadastro e pelas Edge Functions.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'STUDENT', 'TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN',
    'COORDINATOR', 'COMMERCIAL', 'SALESPERSON', 'NON_STUDENT'
  ));

-- Um signUp público ainda não pertence a nenhuma escola. O tenant só é
-- atribuído quando uma oferta/convite autorizado é reivindicado.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (
    id, email, full_name, role, tenant_id, status_financial
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''), 'Novo Usuario'),
    'STUDENT',
    NULL,
    'PENDING'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

-- Mantém o auto-cadastro em quarentena mesmo se houver INSERT direto no perfil.
CREATE OR REPLACE FUNCTION public.protect_student_sensitive_profile_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() = NEW.id
       AND COALESCE(current_setting('app.enrollment_claim', true), '') <> '1' THEN
      NEW.role := 'STUDENT';
      NEW.tenant_id := NULL;
      NEW.monthly_fee := NULL;
      NEW.due_day := NULL;
      NEW.subscription_id := NULL;
      NEW.status_financial := 'PENDING';
      NEW.contract_accepted := false;
      NEW.accepted_at := NULL;
      NEW.class_frequency := NULL;
      NEW.professor_id := NULL;
      NEW.professor_id2 := NULL;
      NEW.enrollment_fee := 0;
      NEW.enrollment_fee_paid := true;
      NEW.enrollment_payment_id := NULL;
      NEW.asaas_customer_id := NULL;
      NEW.referrer_teacher_id := NULL;
      NEW.referrer_student_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF auth.uid() = OLD.id
     AND OLD.role = 'STUDENT'
     AND COALESCE(current_setting('app.enrollment_claim', true), '') <> '1'
     AND ROW(
       NEW.role,
       NEW.tenant_id,
       NEW.monthly_fee,
       NEW.due_day,
       NEW.subscription_id,
       NEW.status_financial,
       NEW.contract_accepted,
       NEW.accepted_at,
       NEW.class_frequency,
       NEW.professor_id,
       NEW.professor_id2,
       NEW.enrollment_fee,
       NEW.enrollment_fee_paid,
       NEW.enrollment_payment_id,
       NEW.asaas_customer_id,
       NEW.referrer_teacher_id,
       NEW.referrer_student_id
     ) IS DISTINCT FROM ROW(
       OLD.role,
       OLD.tenant_id,
       OLD.monthly_fee,
       OLD.due_day,
       OLD.subscription_id,
       OLD.status_financial,
       OLD.contract_accepted,
       OLD.accepted_at,
       OLD.class_frequency,
       OLD.professor_id,
       OLD.professor_id2,
       OLD.enrollment_fee,
       OLD.enrollment_fee_paid,
       OLD.enrollment_payment_id,
       OLD.asaas_customer_id,
       OLD.referrer_teacher_id,
       OLD.referrer_student_id
     ) THEN
    RAISE EXCEPTION 'forbidden: campos contratuais exigem fluxo autorizado';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_student_sensitive_profile_fields ON public.profiles;
CREATE TRIGGER trg_protect_student_sensitive_profile_fields
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.protect_student_sensitive_profile_fields();

-- Normaliza vínculos das ofertas já existentes quando o JSON contém UUID válido.
UPDATE public.offers o
   SET opportunity_id = op.id
  FROM public.opportunities op
 WHERE o.kind = 'ENROLLMENT'
   AND o.opportunity_id IS NULL
   AND COALESCE(o.payload ->> 'opportunityId', '') ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND op.id = (o.payload ->> 'opportunityId')::uuid
   AND op.tenant_id = o.tenant_id;

UPDATE public.offers o
   SET vendor_id = p.id
  FROM public.profiles p
 WHERE o.kind = 'ENROLLMENT'
   AND o.vendor_id IS NULL
   AND COALESCE(o.payload ->> 'vendorId', '') ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND p.id = (o.payload ->> 'vendorId')::uuid
   AND p.role = 'SALESPERSON'
   AND p.tenant_id = o.tenant_id;

UPDATE public.enrollment_links el
   SET offer_id = o.id
  FROM public.offers o
 WHERE el.offer_id IS NULL
   AND el.link_token = 'offer_' || o.id::text;

-- Ofertas antigas expiradas não devem bloquear a chave de reemissão.
UPDATE public.offers
   SET revoked_at = COALESCE(revoked_at, expires_at)
 WHERE kind = 'ENROLLMENT'
   AND opportunity_id IS NOT NULL
   AND consumed_at IS NULL
   AND revoked_at IS NULL
   AND expires_at <= now();

-- Links base64 antigos não voltam a ser enviados por automações.
UPDATE public.enrollment_links
   SET status = 'EXPIRED'
 WHERE status = 'PENDING'
   AND link_url LIKE '%/matricula?data=%'
   AND created_at <= now() - interval '30 days';

-- Converte automaticamente apenas links base64 ainda dentro da validade. Os
-- valores financeiros das colunas prevalecem; agenda e pré-preenchimento são
-- preservados do snapshot legado.
DO $$
DECLARE
  l record;
  v_legacy jsonb;
  v_payload jsonb;
  v_offer_id uuid;
  v_created_by uuid;
  v_vendor_id uuid;
  v_fee numeric;
  v_requires boolean;
BEGIN
  FOR l IN
    SELECT el.*, op.winner_teacher_id, op.claimed_by
      FROM public.enrollment_links el
      LEFT JOIN public.opportunities op ON op.id = el.opportunity_id
     WHERE el.status = 'PENDING'
       AND el.link_url LIKE '%/matricula?data=%'
       AND el.created_at > now() - interval '30 days'
     ORDER BY el.created_at
     FOR UPDATE OF el
  LOOP
    BEGIN
      v_legacy := convert_from(
        decode(split_part(split_part(l.link_url, '?data=', 2), '&', 1), 'base64'),
        'UTF8'
      )::jsonb;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.enrollment_links
         SET status = 'EXPIRED'
       WHERE id = l.id;
      CONTINUE;
    END;

    SELECT u.id
      INTO v_created_by
      FROM auth.users u
     WHERE u.id IN (l.claimed_by, l.winner_teacher_id, l.professor_id)
     ORDER BY CASE
       WHEN u.id = l.claimed_by THEN 1
       WHEN u.id = l.winner_teacher_id THEN 2
       ELSE 3
     END
     LIMIT 1;

    IF v_created_by IS NULL THEN
      SELECT p.id
        INTO v_created_by
        FROM public.profiles p
        JOIN auth.users u ON u.id = p.id
       WHERE p.tenant_id = l.tenant_id
         AND p.role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
       ORDER BY CASE WHEN p.role = 'SCHOOL_ADMIN' THEN 1 ELSE 2 END, p.created_at
       LIMIT 1;
    END IF;

    IF v_created_by IS NULL THEN
      UPDATE public.enrollment_links SET status = 'EXPIRED' WHERE id = l.id;
      CONTINUE;
    END IF;

    v_vendor_id := NULL;
    SELECT p.id
      INTO v_vendor_id
      FROM public.profiles p
     WHERE p.id = l.created_by_vendor_id
       AND p.role = 'SALESPERSON'
       AND p.tenant_id = l.tenant_id;

    v_requires := COALESCE(l.plan_duration, 1) <> 0;
    v_fee := CASE
      WHEN NOT v_requires THEN 0
      ELSE GREATEST(
        COALESCE(NULLIF(v_legacy ->> 'enrollmentFee', '')::numeric, l.enrollment_fee, 0),
        0
      )
    END;

    v_payload := COALESCE(v_legacy, '{}'::jsonb)
      || jsonb_build_object(
        'unitId', l.tenant_id,
        'value', l.monthly_fee,
        'planDuration', COALESCE(l.plan_duration, 1),
        'classesPerWeek', l.classes_per_week,
        'dueDay', l.due_day,
        'professorId', l.professor_id,
        'professorId2', l.professor_id2,
        'opportunityId', l.opportunity_id,
        'studentName', l.student_name,
        'studentPhone', l.student_phone,
        'requiresEnrollment', v_requires,
        'enrollmentFee', v_fee,
        'vendorId', v_vendor_id
      );

    INSERT INTO public.offers (
      kind, tenant_id, payload, expires_at, created_by, created_at,
      requires_enrollment, enrollment_fee, opportunity_id, vendor_id
    )
    VALUES (
      'ENROLLMENT',
      l.tenant_id,
      v_payload,
      l.created_at + interval '30 days',
      v_created_by,
      l.created_at,
      v_requires,
      v_fee,
      l.opportunity_id,
      v_vendor_id
    )
    RETURNING id INTO v_offer_id;

    UPDATE public.enrollment_links
       SET offer_id = v_offer_id,
           link_token = 'offer_' || v_offer_id::text,
           link_url = split_part(l.link_url, '?', 1) || '?offer=' || v_offer_id::text
     WHERE id = l.id;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS offers_one_active_trial_offer_idx
  ON public.offers (opportunity_id)
  WHERE kind = 'ENROLLMENT'
    AND opportunity_id IS NOT NULL
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS enrollment_links_one_pending_opportunity_idx
  ON public.enrollment_links (opportunity_id)
  WHERE opportunity_id IS NOT NULL
    AND status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS enrollment_links_offer_unique_idx
  ON public.enrollment_links (offer_id)
  WHERE offer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS vendor_commissions_offer_unique_idx
  ON public.vendor_commissions (offer_id)
  WHERE offer_id IS NOT NULL;

-- A emissão valida papel/tenant, normaliza preço/taxa, valida vínculos e, para
-- uma experimental, revoga e substitui a proposta anterior atomicamente.
CREATE OR REPLACE FUNCTION public.create_enrollment_offer(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_role text := public._my_role();
  v_caller_tenant text := public._my_tenant_id();
  v_tenant text;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_value numeric;
  v_due_day integer;
  v_duration integer;
  v_frequency integer;
  v_requires boolean;
  v_fee numeric;
  v_start_date date;
  v_opportunity_id uuid;
  v_vendor_id uuid;
  v_professor_id uuid;
  v_professor_id2 uuid;
  v_guardian_id uuid;
  v_vendor_role text;
  v_vendor_tenant text;
  v_link_origin text;
  v_id uuid;
  v_opp public.opportunities%ROWTYPE;
  v_guardian public.profiles%ROWTYPE;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload invalido';
  END IF;

  IF v_role IS NULL OR v_role NOT IN (
    'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR', 'TEACHER', 'SALESPERSON'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_tenant := COALESCE(NULLIF(v_payload ->> 'unitId', ''), v_caller_tenant);
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'tenant invalido'; END IF;
  IF v_role <> 'SUPER_ADMIN' AND v_tenant IS DISTINCT FROM v_caller_tenant THEN
    RAISE EXCEPTION 'forbidden: tenant invalido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_tenant) THEN
    RAISE EXCEPTION 'tenant invalido';
  END IF;

  BEGIN
    v_value := NULLIF(v_payload ->> 'value', '')::numeric;
    v_due_day := NULLIF(v_payload ->> 'dueDay', '')::integer;
    v_duration := COALESCE(NULLIF(v_payload ->> 'planDuration', '')::integer, 1);
    v_frequency := COALESCE(NULLIF(v_payload ->> 'classesPerWeek', '')::integer, 1);
    v_start_date := NULLIF(v_payload ->> 'startDate', '')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'dados comerciais invalidos';
  END;

  IF v_value IS NULL OR v_value <= 0 THEN RAISE EXCEPTION 'valor mensal invalido'; END IF;
  IF v_due_day IS NULL OR v_due_day < 1 OR v_due_day > 31 THEN RAISE EXCEPTION 'vencimento invalido'; END IF;
  IF v_duration NOT IN (0, 1, 6, 12) THEN RAISE EXCEPTION 'duracao invalida'; END IF;
  IF v_frequency < 1 OR v_frequency > 7 THEN RAISE EXCEPTION 'frequencia invalida'; END IF;

  v_requires := v_duration <> 0;
  BEGIN
    v_fee := CASE
      WHEN NOT v_requires THEN 0
      ELSE GREATEST(COALESCE(NULLIF(v_payload ->> 'enrollmentFee', '')::numeric, 0), 0)
    END;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'taxa de matricula invalida';
  END;

  IF NULLIF(v_payload ->> 'opportunityId', '') IS NOT NULL THEN
    BEGIN
      v_opportunity_id := (v_payload ->> 'opportunityId')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'oportunidade invalida';
    END;

    SELECT * INTO v_opp
      FROM public.opportunities
     WHERE id = v_opportunity_id
       AND tenant_id = v_tenant
     FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'oportunidade invalida'; END IF;
    IF v_opp.conversion_status IN ('WON', 'LOST') THEN
      RAISE EXCEPTION 'oportunidade ja encerrada';
    END IF;
    IF v_opp.trial_status IS DISTINCT FROM 'DONE' THEN
      RAISE EXCEPTION 'aula experimental ainda nao concluida';
    END IF;
  END IF;

  IF v_role = 'SALESPERSON' THEN
    v_vendor_id := auth.uid();
  ELSIF NULLIF(v_payload ->> 'vendorId', '') IS NOT NULL THEN
    BEGIN
      v_vendor_id := (v_payload ->> 'vendorId')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'vendedor invalido';
    END;
  ELSIF v_opportunity_id IS NOT NULL THEN
    v_vendor_id := v_opp.created_by_vendor_id;
  END IF;

  IF v_vendor_id IS NOT NULL THEN
    SELECT p.role, p.tenant_id
      INTO v_vendor_role, v_vendor_tenant
      FROM public.profiles p
     WHERE p.id = v_vendor_id;
    IF v_vendor_role IS DISTINCT FROM 'SALESPERSON'
       OR v_vendor_tenant IS DISTINCT FROM v_tenant THEN
      RAISE EXCEPTION 'vendedor invalido';
    END IF;
  END IF;

  IF NULLIF(v_payload ->> 'professorId', '') IS NOT NULL THEN
    BEGIN
      v_professor_id := (v_payload ->> 'professorId')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'professor invalido';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = v_professor_id
         AND p.tenant_id = v_tenant
         AND p.role = 'TEACHER'
    ) THEN
      RAISE EXCEPTION 'professor invalido';
    END IF;
  END IF;

  IF NULLIF(v_payload ->> 'professorId2', '') IS NOT NULL THEN
    BEGIN
      v_professor_id2 := (v_payload ->> 'professorId2')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'segundo professor invalido';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = v_professor_id2
         AND p.tenant_id = v_tenant
         AND p.role = 'TEACHER'
    ) THEN
      RAISE EXCEPTION 'segundo professor invalido';
    END IF;
  END IF;

  IF COALESCE((v_payload ->> 'isDependent')::boolean, false) THEN
    BEGIN
      v_guardian_id := NULLIF(v_payload ->> 'guardianId', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'responsavel invalido';
    END;
    SELECT * INTO v_guardian
      FROM public.profiles p
     WHERE p.id = v_guardian_id
       AND p.tenant_id = v_tenant
       AND NULLIF(p.cpf, '') IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'responsavel invalido'; END IF;

    v_payload := v_payload || jsonb_build_object(
      'guardianId', v_guardian.id,
      'guardianCpf', v_guardian.cpf,
      'guardianName', v_guardian.full_name,
      'guardianEmail', v_guardian.email,
      'guardianPhone', v_guardian.phone,
      'guardianPostalCode', v_guardian.postal_code,
      'guardianAddress', v_guardian.address,
      'guardianAddressNumber', v_guardian.address_number
    );
  END IF;

  v_link_origin := NULLIF(v_payload ->> '_linkOrigin', '');
  IF v_link_origin NOT IN (
    'https://app.wisewolflanguage.com.br',
    'https://system.wisewolflanguage.com.br'
  ) THEN
    v_link_origin := 'https://system.wisewolflanguage.com.br';
  END IF;

  v_payload := (v_payload - '_linkOrigin')
    || jsonb_build_object(
      'unitId', v_tenant,
      'value', v_value,
      'dueDay', v_due_day,
      'planDuration', v_duration,
      'classesPerWeek', v_frequency,
      'requiresEnrollment', v_requires,
      'enrollmentFee', v_fee,
      'opportunityId', v_opportunity_id,
      'vendorId', v_vendor_id,
      'professorId', v_professor_id,
      'professorId2', v_professor_id2
    );

  IF v_opportunity_id IS NOT NULL THEN
    UPDATE public.offers
       SET revoked_at = now(),
           revoked_by = auth.uid()
     WHERE kind = 'ENROLLMENT'
       AND opportunity_id = v_opportunity_id
       AND consumed_at IS NULL
       AND revoked_at IS NULL;

    UPDATE public.enrollment_links
       SET status = 'EXPIRED'
     WHERE opportunity_id = v_opportunity_id
       AND status = 'PENDING';
  END IF;

  INSERT INTO public.offers (
    kind, tenant_id, payload, expires_at, created_by,
    requires_enrollment, enrollment_fee, opportunity_id, vendor_id
  )
  VALUES (
    'ENROLLMENT', v_tenant, v_payload, now() + interval '30 days', auth.uid(),
    v_requires, v_fee, v_opportunity_id, v_vendor_id
  )
  RETURNING id INTO v_id;

  IF v_opportunity_id IS NOT NULL THEN
    INSERT INTO public.enrollment_links (
      tenant_id, opportunity_id, offer_id, link_token, link_url,
      student_name, student_phone, professor_id, professor_id2,
      plan_duration, classes_per_week, monthly_fee, due_day,
      enrollment_fee, start_date, status, created_by_vendor_id
    )
    VALUES (
      v_tenant,
      v_opportunity_id,
      v_id,
      'offer_' || v_id::text,
      v_link_origin || '/matricula?offer=' || v_id::text,
      NULLIF(v_payload ->> 'studentName', ''),
      NULLIF(v_payload ->> 'studentPhone', ''),
      v_professor_id,
      v_professor_id2,
      v_duration,
      v_frequency,
      v_value,
      v_due_day,
      v_fee,
      v_start_date,
      'PENDING',
      v_vendor_id
    );
  END IF;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_enrollment_offer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_enrollment_offer(jsonb) TO authenticated;

-- Leitura pública contém somente dados normalizados da oferta. Uma
-- oportunidade já ganha nunca reabre para outra identidade.
CREATE OR REPLACE FUNCTION public.get_offer_public(p_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.offers%ROWTYPE;
  school_info jsonb;
BEGIN
  SELECT * INTO o
    FROM public.offers
   WHERE id = p_offer_id
     AND kind = 'ENROLLMENT';

  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'OFFER_NOT_FOUND'); END IF;
  IF o.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'OFFER_REVOKED'); END IF;
  IF o.consumed_at IS NOT NULL AND o.consumed_by IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('error', 'OFFER_CONSUMED');
  END IF;
  IF o.consumed_at IS NULL AND o.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'OFFER_EXPIRED');
  END IF;
  IF o.opportunity_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.opportunities op
     WHERE op.id = o.opportunity_id
       AND op.conversion_status = 'WON'
       AND (op.student_id IS NULL OR op.student_id IS DISTINCT FROM auth.uid())
  ) THEN
    RETURN jsonb_build_object('error', 'OPPORTUNITY_CONVERTED');
  END IF;

  SELECT t.school_info INTO school_info
    FROM public.tenants t
   WHERE t.id = o.tenant_id;

  RETURN COALESCE(o.payload, '{}'::jsonb) || jsonb_build_object(
    '_offerId', o.id,
    '_schoolInfo', school_info,
    'unitId', o.tenant_id,
    'requiresEnrollment', o.requires_enrollment,
    'enrollmentFee', o.enrollment_fee,
    'opportunityId', o.opportunity_id,
    'vendorId', o.vendor_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_offer_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_offer_public(uuid) TO anon, authenticated;

-- Claim atômico: identidade, contrato, funil, link, indicação e comissão são
-- persistidos juntos. Nenhum write privilegiado fica a cargo do navegador.
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
    module, contract_accepted, documentation_status, accepted_at,
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
    'General',
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
    module = EXCLUDED.module,
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

  RETURN jsonb_build_object(
    'success', true,
    'offer_id', o.id,
    'payload', v_payload || jsonb_build_object('_offerId', o.id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_enrollment_offer(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_enrollment_offer(uuid, jsonb) TO authenticated;

-- RLS não se aplica a TRUNCATE. Mantemos somente as operações realmente usadas
-- pelo navegador; os writes de claim são feitos pelas funções SECURITY DEFINER.
REVOKE ALL ON TABLE public.offers FROM anon, authenticated;
GRANT SELECT ON TABLE public.offers TO authenticated;

REVOKE ALL ON TABLE public.enrollment_links FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.enrollment_links TO authenticated;

REVOKE ALL ON TABLE public.vendor_commissions FROM anon, authenticated;
GRANT SELECT ON TABLE public.vendor_commissions TO authenticated;

REVOKE ALL ON TABLE public.referral_invites FROM anon, authenticated;
GRANT INSERT ON TABLE public.referral_invites TO anon;
GRANT SELECT, INSERT ON TABLE public.referral_invites TO authenticated;

REVOKE TRUNCATE ON TABLE public.opportunities, public.profiles FROM anon, authenticated;

-- Consumo anônimo legado permanece fechado.
REVOKE ALL ON FUNCTION public.consume_offer(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
