-- Reaplicado depois do dump final, pois o schema hospedado ainda contém o token legado.
CREATE OR REPLACE FUNCTION public.trigger_oral_test_scan()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  request_id bigint;
  service_key text;
BEGIN
  SELECT decrypted_secret
    INTO service_key
    FROM vault.decrypted_secrets
   WHERE name = 'wisewolf_service_role_key'
   LIMIT 1;

  IF service_key IS NULL OR service_key = '' THEN
    RAISE WARNING 'service key ausente';
    RETURN -1;
  END IF;

  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/oral-test-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO request_id;

  RETURN request_id;
END;
$function$;

-- Links públicos são resolvidos apenas pela edge function usando token aleatório.
DROP POLICY IF EXISTS el_read_token ON public.enrollment_links;

-- appointments.professor_id é uma entidade de perfil, inclusive para professores
-- migrados sem login antigo. A FK hospedada apontava incorretamente para auth.users.
ALTER TABLE public.appointments DROP CONSTRAINT IF EXISTS appointments_professor_id_fkey;
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_professor_id_fkey
  FOREIGN KEY (professor_id) REFERENCES public.profiles(id);

-- Entrega os dados jurídicos junto da oferta sem liberar SELECT público em tenants.
CREATE OR REPLACE FUNCTION public.get_offer_public(p_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o offers%ROWTYPE;
  school_info jsonb;
BEGIN
  SELECT * INTO o FROM offers WHERE id = p_offer_id AND kind = 'ENROLLMENT';
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'OFFER_NOT_FOUND'); END IF;
  IF o.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'OFFER_CONSUMED'); END IF;
  IF o.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'OFFER_REVOKED'); END IF;
  IF o.expires_at <= now() THEN RETURN jsonb_build_object('error', 'OFFER_EXPIRED'); END IF;

  SELECT t.school_info INTO school_info FROM tenants t WHERE t.id = o.tenant_id;
  RETURN COALESCE(o.payload, '{}'::jsonb) || jsonb_build_object(
    '_offerId', o.id,
    '_schoolInfo', school_info
  );
END;
$function$;

-- O dump hospedado ainda usa app.settings e um domínio desativado. O trigger
-- enfileira somente a transição de aceite; a Edge faz o claim atômico e também
-- bloqueia fixtures de teste.
CREATE OR REPLACE FUNCTION public.handle_contract_signed_hook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'pg_temp'
AS $function$
DECLARE
  service_key text;
BEGIN
  IF NEW.contract_accepted IS TRUE
     AND COALESCE(OLD.contract_accepted, FALSE) IS FALSE
     AND COALESCE(NEW.wa_welcome_sent, FALSE) IS FALSE
     AND COALESCE(NEW.is_test_account, FALSE) IS FALSE THEN
    BEGIN
      SELECT decrypted_secret
        INTO service_key
        FROM vault.decrypted_secrets
       WHERE name = 'wisewolf_service_role_key'
       LIMIT 1;

      IF service_key IS NULL OR service_key = '' THEN
        RAISE EXCEPTION 'service key ausente';
      END IF;

      IF NEW.phone IS NOT NULL THEN
        INSERT INTO whatsapp_messages_log (student_id, phone, message_type, status)
        VALUES (NEW.id, NEW.phone, 'WELCOME_ENROLLMENT', 'QUEUED');

        PERFORM net.http_post(
          url := 'http://kong:8000/functions/v1/whatsapp-notificacao-matricula',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
          ),
          body := jsonb_build_object('student_id', NEW.id),
          timeout_milliseconds := 60000
        );
      ELSE
        RAISE WARNING 'handle_contract_signed_hook: profile % sem phone', NEW.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'handle_contract_signed_hook: falha para %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$function$;

-- A oferta de matricula passa a ser vinculada ao usuario autenticado. Isso
-- permite que cobranca, duracao e agenda sejam relidas do registro criado pela
-- escola, em vez de confiar no corpo enviado pelo navegador.
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS consumed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS offers_consumed_by_kind_idx
  ON public.offers (consumed_by, kind, consumed_at DESC);

-- Cadastro publico nunca pode escolher papel privilegiado pelo metadata do
-- signUp. Convites de professor/comercial continuam promovendo o perfil via
-- service role nas edge functions especificas.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, tenant_id, status_financial)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''), 'Novo Usuario'),
    'STUDENT',
    'school-wise-wolf',
    'PENDING'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

-- Um aluno pode editar seus dados pessoais, mas nao pode promover o proprio
-- papel nem alterar valores contratuais/financeiros. A RPC de claim usa uma
-- flag local apenas durante a transacao autorizada.
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
      NEW.tenant_id := 'school-wise-wolf';
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

-- Somente funcionarios podem criar ofertas e, fora do superadmin, apenas para
-- o proprio tenant. Nao emitimos mais fallback base64 adulteravel.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'STUDENT', 'TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN',
    'COORDINATOR', 'COMMERCIAL', 'SALESPERSON', 'NON_STUDENT'
  ));

CREATE OR REPLACE FUNCTION public.create_enrollment_offer(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := public._my_role();
  v_caller_tenant text := public._my_tenant_id();
  v_tenant text := COALESCE(NULLIF(p_payload ->> 'unitId', ''), v_caller_tenant);
  v_value numeric;
  v_due_day integer;
  v_duration integer;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_id uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN (
    'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR', 'TEACHER', 'SALESPERSON'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_role <> 'SUPER_ADMIN' AND v_tenant IS DISTINCT FROM v_caller_tenant THEN
    RAISE EXCEPTION 'forbidden: tenant invalido';
  END IF;

  IF v_role = 'SALESPERSON' THEN
    v_payload := jsonb_set(v_payload, '{vendorId}', to_jsonb(auth.uid()::text), true);
  END IF;

  v_value := NULLIF(v_payload ->> 'value', '')::numeric;
  v_due_day := NULLIF(v_payload ->> 'dueDay', '')::integer;
  v_duration := COALESCE(NULLIF(v_payload ->> 'planDuration', '')::integer, 1);

  IF v_value IS NULL OR v_value <= 0 THEN RAISE EXCEPTION 'valor mensal invalido'; END IF;
  IF v_due_day IS NULL OR v_due_day < 1 OR v_due_day > 31 THEN RAISE EXCEPTION 'vencimento invalido'; END IF;
  IF v_duration NOT IN (0, 1, 6, 12) THEN RAISE EXCEPTION 'duracao invalida'; END IF;

  INSERT INTO public.offers (
    kind, tenant_id, payload, expires_at, created_by,
    requires_enrollment, enrollment_fee
  ) VALUES (
    'ENROLLMENT', v_tenant, v_payload, now() + interval '30 days', auth.uid(),
    v_duration <> 0,
    CASE WHEN v_duration = 0 THEN 0 ELSE GREATEST(COALESCE(NULLIF(v_payload ->> 'enrollmentFee', '')::numeric, 0), 0) END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_enrollment_offer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_enrollment_offer(jsonb) TO authenticated;

-- Leitura publica limitada ao payload da oferta. Depois do claim, apenas o
-- proprio aluno ainda consegue reabrir a oferta para concluir uma tentativa.
CREATE OR REPLACE FUNCTION public.get_offer_public(p_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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

  SELECT t.school_info INTO school_info
    FROM public.tenants t
   WHERE t.id = o.tenant_id;

  RETURN COALESCE(o.payload, '{}'::jsonb) || jsonb_build_object(
    '_offerId', o.id,
    '_schoolInfo', school_info
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_offer_public(uuid) TO anon, authenticated;

-- Claim atomico: valida uso unico, vincula a oferta ao auth.uid() e grava o
-- contrato usando somente os campos pessoais permitidos do formulario. Todos
-- os valores comerciais continuam vindo de offers.payload.
CREATE OR REPLACE FUNCTION public.claim_enrollment_offer(p_offer_id uuid, p_profile jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  o public.offers%ROWTYPE;
  v_payload jsonb;
  v_dependent boolean;
  v_fee numeric;
  v_phone text;
  v_cpf text;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
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

  SELECT email INTO v_email FROM auth.users WHERE id = v_user;
  IF v_email IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND'); END IF;

  v_payload := COALESCE(o.payload, '{}'::jsonb);
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

  PERFORM set_config('app.enrollment_claim', '1', true);

  UPDATE public.offers
     SET consumed_at = COALESCE(consumed_at, now()),
         consumed_by = COALESCE(consumed_by, v_user),
         usage_count = COALESCE(usage_count, 0) + CASE WHEN consumed_at IS NULL THEN 1 ELSE 0 END,
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
  ) VALUES (
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
    NULLIF(p_profile ->> 'referrer_teacher_id', '')::uuid,
    NULLIF(p_profile ->> 'referrer_student_id', '')::uuid
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

  RETURN jsonb_build_object(
    'success', true,
    'offer_id', o.id,
    'payload', v_payload || jsonb_build_object('_offerId', o.id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_enrollment_offer(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_enrollment_offer(uuid, jsonb) TO authenticated;

-- O endpoint anonimo antigo nao pode mais consumir uma oferta antes de existir
-- um usuario autenticado ao qual ela seja vinculada.
REVOKE ALL ON FUNCTION public.consume_offer(uuid) FROM PUBLIC, anon, authenticated;

-- Mantém o endurecimento pós-restore alinhado com o fluxo de matrícula atual.
-- \ir resolve os caminhos a partir deste próprio arquivo, independentemente do
-- diretório em que o psql for executado.
\ir ../../supabase/migrations/20260723224400_fix_enrollment_link_flow.sql
\ir ../../supabase/migrations/20260723234500_reconcile_enrollment_history.sql
