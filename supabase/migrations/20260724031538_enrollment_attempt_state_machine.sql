begin;

-- A oferta passa a ser a raiz de idempotência da matrícula. Os IDs externos
-- continuam em profiles/offers.metadata; aqui fica somente o estado operacional,
-- o protocolo visível ao suporte e o erro seguro da última tentativa.
alter table public.offers
  add column if not exists processing_state text not null default 'NOT_STARTED',
  add column if not exists processing_by uuid,
  add column if not exists processing_correlation_id uuid not null default gen_random_uuid(),
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_updated_at timestamptz,
  add column if not exists processing_completed_at timestamptz,
  add column if not exists processing_attempts integer not null default 0,
  add column if not exists processing_error_code text,
  add column if not exists processing_error_message text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.offers'::regclass
       and conname = 'offers_processing_by_fkey'
  ) then
    alter table public.offers
      add constraint offers_processing_by_fkey
      foreign key (processing_by) references auth.users(id) on delete set null;
  end if;
end
$$;

alter table public.offers
  drop constraint if exists offers_processing_state_check;

alter table public.offers
  add constraint offers_processing_state_check
  check (
    processing_state in (
      'NOT_STARTED',
      'PROFILE_READY',
      'CUSTOMER_READY',
      'BILLING_READY',
      'AWAITING_PAYMENT',
      'FAILED_RETRYABLE',
      'COMPLETED'
    )
  );

alter table public.enrollment_links
  drop constraint if exists enrollment_links_status_check;

alter table public.enrollment_links
  add constraint enrollment_links_status_check
  check (status in ('PENDING', 'PROCESSING', 'USED', 'EXPIRED'));

drop index if exists public.enrollment_links_one_pending_opportunity_idx;
create unique index enrollment_links_one_open_opportunity_idx
  on public.enrollment_links (opportunity_id)
  where opportunity_id is not null
    and status in ('PENDING', 'PROCESSING');

create index if not exists offers_processing_by_open_idx
  on public.offers (processing_by, processing_updated_at desc)
  where kind = 'ENROLLMENT'
    and processing_state not in ('NOT_STARTED', 'COMPLETED');

create index if not exists offers_processing_stale_idx
  on public.offers (processing_updated_at)
  where kind = 'ENROLLMENT'
    and processing_state in ('PROFILE_READY', 'CUSTOMER_READY', 'BILLING_READY', 'AWAITING_PAYMENT', 'FAILED_RETRYABLE');

-- Validação real de CPF no servidor. O navegador também valida para dar retorno
-- imediato, mas esta função é a barreira autoritativa.
create or replace function public.is_valid_cpf(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  v_cpf text := regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g');
  v_sum integer;
  v_digit integer;
  i integer;
begin
  if length(v_cpf) <> 11 or v_cpf ~ '^([0-9])\1{10}$' then
    return false;
  end if;

  v_sum := 0;
  for i in 1..9 loop
    v_sum := v_sum + substr(v_cpf, i, 1)::integer * (11 - i);
  end loop;
  v_digit := (v_sum * 10) % 11;
  if v_digit = 10 then v_digit := 0; end if;
  if v_digit <> substr(v_cpf, 10, 1)::integer then return false; end if;

  v_sum := 0;
  for i in 1..10 loop
    v_sum := v_sum + substr(v_cpf, i, 1)::integer * (12 - i);
  end loop;
  v_digit := (v_sum * 10) % 11;
  if v_digit = 10 then v_digit := 0; end if;
  return v_digit = substr(v_cpf, 11, 1)::integer;
end;
$function$;

revoke all on function public.is_valid_cpf(text) from public, anon, authenticated;

-- Inicia ou retoma a matrícula sem consumir a oferta e sem fechar o funil.
-- Perfil, aceite contratual e lease da oferta são gravados numa única transação.
create or replace function public.begin_enrollment_offer(
  p_offer_id uuid,
  p_profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $function$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_existing_role text;
  v_payload jsonb;
  v_dependent boolean;
  v_fee numeric;
  v_phone text;
  v_cpf text;
  v_signature text;
  v_expected_signer text;
  v_signature_normalized text;
  v_expected_normalized text;
  v_billing_type text;
  v_invite_id uuid;
  v_referrer_id uuid;
  v_referrer_role text;
  v_referrer_teacher_id uuid;
  v_referrer_student_id uuid;
  v_opportunity_id uuid;
  v_enrollment_link_id uuid;
  v_request_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );
  v_ip text;
  v_user_agent text;
  v_accepted_at timestamptz := clock_timestamp();
  o public.offers%rowtype;
  v_opp public.opportunities%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  end if;
  if jsonb_typeof(coalesce(p_profile, '{}'::jsonb)) is distinct from 'object' then
    return jsonb_build_object('success', false, 'error', 'INVALID_PROFILE');
  end if;

  select opportunity_id
    into v_opportunity_id
    from public.offers
   where id = p_offer_id
     and kind = 'ENROLLMENT';
  if not found then
    return jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  end if;

  -- Mesma ordem de locks usada na emissão/finalização: opportunity -> offer.
  if v_opportunity_id is not null then
    select *
      into v_opp
      from public.opportunities
     where id = v_opportunity_id
     for update;
  end if;

  select *
    into o
    from public.offers
   where id = p_offer_id
     and kind = 'ENROLLMENT'
   for update;

  if not found then return jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND'); end if;
  if o.revoked_at is not null then return jsonb_build_object('success', false, 'error', 'OFFER_REVOKED'); end if;
  if o.consumed_at is not null and o.consumed_by is distinct from v_user then
    return jsonb_build_object('success', false, 'error', 'OFFER_CONSUMED');
  end if;
  if o.consumed_at is null and o.expires_at <= now() then
    return jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED');
  end if;
  if o.processing_by is not null and o.processing_by is distinct from v_user
     and o.processing_state <> 'COMPLETED' then
    return jsonb_build_object('success', false, 'error', 'OFFER_IN_PROGRESS');
  end if;
  if o.processing_state = 'COMPLETED' or (
    o.consumed_at is not null and o.consumed_by = v_user
  ) then
    return jsonb_build_object(
      'success', true,
      'already_completed', true,
      'offer_id', o.id,
      'correlation_id', o.processing_correlation_id,
      'processing_state', 'COMPLETED',
      'payload', coalesce(o.payload, '{}'::jsonb) || jsonb_build_object('_offerId', o.id)
    );
  end if;

  if v_opportunity_id is not null then
    if v_opp.id is null or v_opp.tenant_id is distinct from o.tenant_id then
      return jsonb_build_object('success', false, 'error', 'OPPORTUNITY_INVALID');
    end if;
    if v_opp.conversion_status = 'LOST' then
      return jsonb_build_object('success', false, 'error', 'OPPORTUNITY_CLOSED');
    end if;
    if v_opp.conversion_status = 'WON'
       and (v_opp.student_id is null or v_opp.student_id is distinct from v_user) then
      return jsonb_build_object('success', false, 'error', 'OPPORTUNITY_CONVERTED');
    end if;
  end if;

  select p.role
    into v_existing_role
    from public.profiles p
   where p.id = v_user
   for update;
  if found and v_existing_role is distinct from 'STUDENT' then
    return jsonb_build_object('success', false, 'error', 'PROFILE_ROLE_NOT_ALLOWED');
  end if;

  select lower(trim(u.email))
    into v_email
    from auth.users u
   where u.id = v_user;
  if v_email is null then
    return jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  end if;

  v_payload := coalesce(o.payload, '{}'::jsonb) || jsonb_build_object(
    'unitId', o.tenant_id,
    'requiresEnrollment', o.requires_enrollment,
    'enrollmentFee', o.enrollment_fee,
    'opportunityId', o.opportunity_id,
    'vendorId', o.vendor_id
  );
  v_dependent := coalesce((v_payload ->> 'isDependent')::boolean, false);
  v_fee := greatest(coalesce(o.enrollment_fee, 0), 0);
  v_phone := regexp_replace(coalesce(p_profile ->> 'phone', ''), '[^0-9]', '', 'g');
  v_cpf := regexp_replace(coalesce(p_profile ->> 'cpf', ''), '[^0-9]', '', 'g');
  v_signature := btrim(coalesce(p_profile ->> 'typed_signature', ''));
  v_billing_type := upper(btrim(coalesce(p_profile ->> 'billing_type', '')));
  v_expected_signer := case
    when v_dependent then coalesce(v_payload ->> 'guardianName', '')
    else coalesce(p_profile ->> 'full_name', '')
  end;
  v_signature_normalized := lower(regexp_replace(v_signature, '\s+', ' ', 'g'));
  v_expected_normalized := lower(regexp_replace(btrim(v_expected_signer), '\s+', ' ', 'g'));

  if length(trim(coalesce(p_profile ->> 'full_name', ''))) < 3 then
    return jsonb_build_object('success', false, 'error', 'INVALID_NAME');
  end if;
  if length(v_phone) < 10 or length(v_phone) > 13 then
    return jsonb_build_object('success', false, 'error', 'INVALID_PHONE');
  end if;
  if not v_dependent and not public.is_valid_cpf(v_cpf) then
    return jsonb_build_object('success', false, 'error', 'INVALID_CPF');
  end if;
  if v_billing_type not in ('PIX', 'BOLETO', 'CREDIT_CARD') then
    return jsonb_build_object('success', false, 'error', 'INVALID_BILLING_TYPE');
  end if;
  if length(v_signature) < 3 or v_signature_normalized is distinct from v_expected_normalized then
    return jsonb_build_object('success', false, 'error', 'INVALID_SIGNATURE');
  end if;
  if not v_dependent and exists (
    select 1
      from public.profiles p
     where regexp_replace(coalesce(p.cpf, ''), '[^0-9]', '', 'g') = v_cpf
       and p.tenant_id = o.tenant_id
       and p.id <> v_user
  ) then
    return jsonb_build_object('success', false, 'error', 'CPF_ALREADY_REGISTERED');
  end if;

  v_ip := split_part(
    coalesce(
      nullif(v_request_headers ->> 'x-real-ip', ''),
      nullif(v_request_headers ->> 'cf-connecting-ip', ''),
      nullif(v_request_headers ->> 'x-forwarded-for', ''),
      ''
    ),
    ',',
    1
  );
  v_user_agent := left(coalesce(v_request_headers ->> 'user-agent', ''), 500);

  -- A indicação é derivada de e-mail/tenant e só será convertida na finalização.
  select ri.id, ri.referrer_id, rp.role
    into v_invite_id, v_referrer_id, v_referrer_role
    from public.referral_invites ri
    join public.profiles rp on rp.id = ri.referrer_id
   where lower(trim(ri.invitee_email)) = v_email
     and ri.status = 'PENDING'
     and ri.expires_at > now()
     and (ri.tenant_id is null or ri.tenant_id = o.tenant_id)
     and rp.tenant_id = o.tenant_id
     and ri.referrer_id <> v_user
   order by ri.created_at desc
   limit 1
   for update of ri;

  if v_invite_id is not null then
    if v_referrer_role in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR') then
      v_referrer_teacher_id := v_referrer_id;
    elsif v_referrer_role = 'STUDENT' then
      v_referrer_student_id := v_referrer_id;
    end if;
  end if;

  perform set_config('app.enrollment_claim', '1', true);

  insert into public.profiles (
    id, email, full_name, role, tenant_id, phone, cpf, postal_code,
    address, address_number, status_financial, monthly_fee, due_day,
    module, contract_accepted, documentation_status, accepted_at,
    class_frequency, signature_ip, user_ip, typed_signature, signature_hash,
    student_signature_url, signed_document_url, wise_wolf_signature_token,
    enrollment_fee, enrollment_fee_paid, professor_id, professor_id2,
    start_date, guardian_id, guardian_name, guardian_cpf, guardian_email,
    guardian_phone, attendance_phone, referrer_teacher_id, referrer_student_id
  )
  values (
    v_user,
    v_email,
    trim(p_profile ->> 'full_name'),
    'STUDENT',
    o.tenant_id,
    v_phone,
    case when v_dependent then null else v_cpf end,
    nullif(p_profile ->> 'postal_code', ''),
    nullif(p_profile ->> 'address', ''),
    nullif(p_profile ->> 'address_number', ''),
    'PENDING',
    (v_payload ->> 'value')::numeric,
    (v_payload ->> 'dueDay')::integer,
    'General',
    true,
    'APPROVED',
    v_accepted_at,
    coalesce(v_payload ->> 'classesPerWeek', '1') || 'x',
    nullif(v_ip, ''),
    nullif(v_ip, ''),
    v_signature,
    encode(digest(
      v_user::text || '|' || o.id::text || '|' || v_signature || '|' ||
      v_accepted_at::text || '|' || v_user_agent,
      'sha256'
    ), 'hex'),
    nullif(p_profile ->> 'student_signature_url', ''),
    nullif(p_profile ->> 'signed_document_url', ''),
    gen_random_uuid()::text,
    v_fee,
    v_fee <= 0,
    nullif(v_payload ->> 'professorId', '')::uuid,
    nullif(v_payload ->> 'professorId2', '')::uuid,
    nullif(v_payload ->> 'startDate', '')::date,
    case when v_dependent then nullif(v_payload ->> 'guardianId', '')::uuid else null end,
    case when v_dependent then nullif(v_payload ->> 'guardianName', '') else null end,
    case when v_dependent then regexp_replace(coalesce(v_payload ->> 'guardianCpf', ''), '[^0-9]', '', 'g') else null end,
    case when v_dependent then nullif(v_payload ->> 'guardianEmail', '') else null end,
    case when v_dependent then regexp_replace(coalesce(v_payload ->> 'guardianPhone', ''), '[^0-9]', '', 'g') else null end,
    case when v_dependent then regexp_replace(coalesce(v_payload ->> 'studentPhone', ''), '[^0-9]', '', 'g') else null end,
    v_referrer_teacher_id,
    v_referrer_student_id
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = excluded.full_name,
    role = 'STUDENT',
    tenant_id = excluded.tenant_id,
    phone = excluded.phone,
    cpf = excluded.cpf,
    postal_code = excluded.postal_code,
    address = excluded.address,
    address_number = excluded.address_number,
    -- Nunca rebaixa um perfil já sincronizado/ativo durante uma retomada.
    status_financial = coalesce(public.profiles.status_financial, excluded.status_financial),
    monthly_fee = excluded.monthly_fee,
    due_day = excluded.due_day,
    module = excluded.module,
    contract_accepted = true,
    documentation_status = excluded.documentation_status,
    accepted_at = coalesce(public.profiles.accepted_at, excluded.accepted_at),
    class_frequency = excluded.class_frequency,
    signature_ip = coalesce(public.profiles.signature_ip, excluded.signature_ip),
    user_ip = coalesce(public.profiles.user_ip, excluded.user_ip),
    typed_signature = coalesce(public.profiles.typed_signature, excluded.typed_signature),
    signature_hash = coalesce(public.profiles.signature_hash, excluded.signature_hash),
    student_signature_url = coalesce(excluded.student_signature_url, public.profiles.student_signature_url),
    signed_document_url = coalesce(excluded.signed_document_url, public.profiles.signed_document_url),
    wise_wolf_signature_token = coalesce(public.profiles.wise_wolf_signature_token, excluded.wise_wolf_signature_token),
    enrollment_fee = excluded.enrollment_fee,
    enrollment_fee_paid = case
      when excluded.enrollment_fee <= 0 then true
      else coalesce(public.profiles.enrollment_fee_paid, false)
    end,
    professor_id = excluded.professor_id,
    professor_id2 = excluded.professor_id2,
    start_date = excluded.start_date,
    guardian_id = excluded.guardian_id,
    guardian_name = excluded.guardian_name,
    guardian_cpf = excluded.guardian_cpf,
    guardian_email = excluded.guardian_email,
    guardian_phone = excluded.guardian_phone,
    attendance_phone = excluded.attendance_phone,
    referrer_teacher_id = coalesce(public.profiles.referrer_teacher_id, excluded.referrer_teacher_id),
    referrer_student_id = coalesce(public.profiles.referrer_student_id, excluded.referrer_student_id);

  select el.id
    into v_enrollment_link_id
    from public.enrollment_links el
   where el.offer_id = o.id
   limit 1
   for update;

  update public.enrollment_links
     set status = 'PROCESSING'
   where offer_id = o.id
     and status = 'PENDING';

  update public.offers
     set processing_by = v_user,
         processing_state = case
           when processing_state in ('CUSTOMER_READY', 'BILLING_READY', 'AWAITING_PAYMENT')
             then processing_state
           else 'PROFILE_READY'
         end,
         processing_started_at = coalesce(processing_started_at, now()),
         processing_updated_at = now(),
         processing_attempts = processing_attempts + 1,
         processing_error_code = null,
         processing_error_message = null,
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'billing_type', v_billing_type,
           'referral_invite_id', v_invite_id,
           'signature_user_agent', v_user_agent,
           'enrollment_link_id', v_enrollment_link_id
         )
   where id = o.id;

  select * into o from public.offers where id = o.id;

  return jsonb_build_object(
    'success', true,
    'offer_id', o.id,
    'correlation_id', o.processing_correlation_id,
    'processing_state', o.processing_state,
    'payload', v_payload || jsonb_build_object('_offerId', o.id)
  );
end;
$function$;

revoke all on function public.begin_enrollment_offer(uuid, jsonb) from public, anon;
grant execute on function public.begin_enrollment_offer(uuid, jsonb) to authenticated;

-- Retomada segura: devolve apenas o progresso e os dados do próprio usuário.
create or replace function public.get_enrollment_progress(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $function$
declare
  v_user uuid := auth.uid();
  o public.offers%rowtype;
  p public.profiles%rowtype;
begin
  if v_user is null then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  end if;

  select *
    into o
    from public.offers
   where id = p_offer_id
     and kind = 'ENROLLMENT'
     and (processing_by = v_user or consumed_by = v_user);
  if not found then
    return jsonb_build_object('success', true, 'status', 'NOT_STARTED');
  end if;

  select * into p from public.profiles where id = v_user;

  return jsonb_build_object(
    'success', true,
    'status', case
      when o.consumed_at is not null then 'COMPLETED'
      else o.processing_state
    end,
    'correlation_id', o.processing_correlation_id,
    'billing_type', o.metadata ->> 'billing_type',
    'error_code', o.processing_error_code,
    'error_message', o.processing_error_message,
    'profile', jsonb_strip_nulls(jsonb_build_object(
      'full_name', p.full_name,
      'email', p.email,
      'phone', p.phone,
      'cpf', p.cpf,
      'postal_code', p.postal_code,
      'address', p.address,
      'address_number', p.address_number,
      'typed_signature', p.typed_signature
    ))
  );
end;
$function$;

revoke all on function public.get_enrollment_progress(uuid) from public, anon;
grant execute on function public.get_enrollment_progress(uuid) to authenticated;

-- Finalização autoritativa. Somente Edge Functions com service_role podem chamar:
-- o navegador nunca escolhe quando a cobrança está pronta/paga.
create or replace function public.complete_enrollment_offer(
  p_offer_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $function$
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_opportunity_id uuid;
  v_enrollment_link_id uuid;
  v_invite_id uuid;
  v_duration integer;
  v_fee numeric;
  v_commission_rate integer;
  v_vendor_role text;
  v_vendor_tenant text;
  o public.offers%rowtype;
  p public.profiles%rowtype;
  v_opp public.opportunities%rowtype;
begin
  if v_role <> 'service_role' then
    return jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  end if;

  select opportunity_id
    into v_opportunity_id
    from public.offers
   where id = p_offer_id
     and kind = 'ENROLLMENT';
  if not found then
    return jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  end if;

  if v_opportunity_id is not null then
    select *
      into v_opp
      from public.opportunities
     where id = v_opportunity_id
     for update;
  end if;

  select *
    into o
    from public.offers
   where id = p_offer_id
     and kind = 'ENROLLMENT'
   for update;

  if not found then return jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND'); end if;
  if o.processing_by is distinct from p_user_id then
    return jsonb_build_object('success', false, 'error', 'ATTEMPT_OWNER_MISMATCH');
  end if;
  if o.processing_state = 'COMPLETED' and o.consumed_by = p_user_id then
    return jsonb_build_object(
      'success', true,
      'already_completed', true,
      'correlation_id', o.processing_correlation_id
    );
  end if;
  if o.revoked_at is not null then return jsonb_build_object('success', false, 'error', 'OFFER_REVOKED'); end if;

  select * into p from public.profiles where id = p_user_id for update;
  if not found or p.tenant_id is distinct from o.tenant_id or p.role is distinct from 'STUDENT' then
    return jsonb_build_object('success', false, 'error', 'PROFILE_INVALID');
  end if;

  v_duration := coalesce(nullif(o.payload ->> 'planDuration', '')::integer, 1);
  v_fee := greatest(coalesce(o.enrollment_fee, 0), 0);

  if nullif(p.asaas_customer_id, '') is null then
    return jsonb_build_object('success', false, 'error', 'CUSTOMER_PENDING');
  end if;
  if v_duration = 0 then
    if nullif(o.metadata ->> 'one_time_payment_id', '') is null
       or nullif(o.metadata ->> 'one_time_paid_at', '') is null then
      return jsonb_build_object('success', false, 'error', 'PAYMENT_PENDING');
    end if;
  elsif nullif(p.subscription_id, '') is null then
    return jsonb_build_object('success', false, 'error', 'SUBSCRIPTION_PENDING');
  end if;
  if v_fee > 0 and coalesce(p.enrollment_fee_paid, false) is false then
    return jsonb_build_object('success', false, 'error', 'ENROLLMENT_FEE_PENDING');
  end if;

  v_invite_id := nullif(o.metadata ->> 'referral_invite_id', '')::uuid;

  update public.offers
     set consumed_at = coalesce(consumed_at, now()),
         consumed_by = coalesce(consumed_by, p_user_id),
         usage_count = coalesce(usage_count, 0)
           + case when consumed_at is null then 1 else 0 end,
         last_used_at = now(),
         processing_state = 'COMPLETED',
         processing_updated_at = now(),
         processing_completed_at = coalesce(processing_completed_at, now()),
         processing_error_code = null,
         processing_error_message = null
   where id = o.id;

  if v_invite_id is not null then
    update public.referral_invites
       set status = 'CONVERTED',
           converted_at = coalesce(converted_at, now()),
           converted_student_id = p_user_id
     where id = v_invite_id
       and status = 'PENDING';
  end if;

  if o.opportunity_id is not null then
    update public.opportunities
       set conversion_status = 'WON',
           student_id = p_user_id
     where id = o.opportunity_id
       and (student_id is null or student_id = p_user_id);
  end if;

  select el.id
    into v_enrollment_link_id
    from public.enrollment_links el
   where el.offer_id = o.id
   limit 1;

  update public.enrollment_links
     set status = 'USED',
         used_at = coalesce(used_at, now())
   where offer_id = o.id
     and status in ('PENDING', 'PROCESSING');

  if o.vendor_id is not null then
    select pr.role, pr.tenant_id, coalesce(pr.commission_rate, 3000)
      into v_vendor_role, v_vendor_tenant, v_commission_rate
      from public.profiles pr
     where pr.id = o.vendor_id;

    if v_vendor_role = 'SALESPERSON'
       and v_vendor_tenant = o.tenant_id then
      insert into public.vendor_commissions (
        vendor_id, student_id, enrollment_link_id, offer_id,
        amount_brl, status, tenant_id
      )
      values (
        o.vendor_id, p_user_id, v_enrollment_link_id, o.id,
        v_commission_rate, 'PENDING', o.tenant_id
      )
      on conflict (offer_id) where offer_id is not null do nothing;
    end if;
  end if;

  return jsonb_build_object(
    'success', true,
    'processing_state', 'COMPLETED',
    'correlation_id', o.processing_correlation_id
  );
end;
$function$;

revoke all on function public.complete_enrollment_offer(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_enrollment_offer(uuid, uuid)
  to service_role;

commit;
