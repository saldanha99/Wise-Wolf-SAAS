-- A cobrança gerada pela assinatura da RENOVAÇÃO (`renewal:<oferta>:subscription`)
-- não era reconhecida como referência canônica por
-- `apply_active_student_payment_event`: todo evento dela caía em TRIAGE
-- ("active_payment_event_database_rejected" / reference_mismatch). Cópia
-- integral da função de 20260825194716 com um ramo a mais, provado pela oferta
-- em `private.student_course_renewal_offers` (aluno, escola e assinatura criada).
-- Re-executável: create or replace.

create or replace function public.apply_active_student_payment_event(
  p_provider_payment_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_expected_provider_subscription_id text,
  p_canonical_reference text,
  p_event_id text,
  p_event_name text,
  p_event_created_at timestamptz,
  p_event_rank integer,
  p_provider_status text,
  p_provider_value numeric,
  p_due_date date,
  p_payment_date date,
  p_billing_type text,
  p_invoice_url text,
  p_description text,
  p_payment_type text,
  p_credited_at timestamptz,
  p_estimated_credit_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  profile_row public.profiles%rowtype;
  payment_row public.student_payments%rowtype;
  normalized_payment_id text := nullif(pg_catalog.btrim(coalesce(p_provider_payment_id, '')), '');
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_expected_tenant_id, '')), '');
  normalized_customer text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_customer_id, '')), '');
  normalized_subscription text := nullif(pg_catalog.btrim(coalesce(p_expected_provider_subscription_id, '')), '');
  normalized_reference text := nullif(pg_catalog.btrim(coalesce(p_canonical_reference, '')), '');
  normalized_event_id text := nullif(pg_catalog.btrim(coalesce(p_event_id, '')), '');
  normalized_event text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_event_name, '')));
  normalized_provider_status text := nullif(pg_catalog.btrim(coalesce(p_provider_status, '')), '');
  normalized_billing_type text := nullif(pg_catalog.btrim(coalesce(p_billing_type, '')), '');
  normalized_invoice_url text := nullif(pg_catalog.btrim(coalesce(p_invoice_url, '')), '');
  normalized_description text := coalesce(nullif(pg_catalog.btrim(coalesce(p_description, '')), ''), 'Mensalidade');
  normalized_payment_type text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_payment_type, '')));
  payload_event_created_text text;
  payload_event_created_at timestamptz;
  payload_value numeric;
  expected_rank integer;
  membership_count integer := 0;
  active_membership_count integer := 0;
  reference_parts text[];
  reference_is_canonical boolean := false;
  reference_offer_id uuid;
  inserted_payment_id uuid;
  next_status text;
  previous_status text;
  was_already_paid boolean := false;
  local_payment_count integer := 0;
  lifecycle_is_active boolean := false;
  lifecycle_operation_active boolean := false;
  inactive_result jsonb;
begin
  expected_rank := case
    when normalized_event in (
      'PAYMENT_REFUNDED', 'PAYMENT_DELETED',
      'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE'
    ) then 100
    when normalized_event = 'PAYMENT_REFUND_IN_PROGRESS' then 95
    when normalized_event = 'PAYMENT_PARTIALLY_REFUNDED' then 90
    when normalized_event in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH') then 80
    when normalized_event = 'PAYMENT_CONFIRMED' then 60
    when normalized_event = 'PAYMENT_OVERDUE' then 40
    when normalized_event = 'PAYMENT_UPDATED' then 30
    when normalized_event = 'PAYMENT_CREATED' then 20
    else 10
  end;

  if normalized_payment_id is null or pg_catalog.length(normalized_payment_id) > 240
     or p_expected_student_id is null
     or normalized_tenant is null or pg_catalog.length(normalized_tenant) > 240
     or normalized_customer is null or pg_catalog.length(normalized_customer) > 240
     or normalized_reference is null or pg_catalog.length(normalized_reference) > 500
     or normalized_event_id is null or pg_catalog.length(normalized_event_id) > 240
     or normalized_event = '' or pg_catalog.length(normalized_event) > 240
     or p_event_created_at is null or p_event_rank is distinct from expected_rank
     or normalized_provider_status is null or pg_catalog.length(normalized_provider_status) > 120
     or p_provider_value is null
     or p_provider_value::text in ('NaN', 'Infinity', '-Infinity')
     or p_provider_value <= 0 or p_due_date is null
     or normalized_payment_type not in ('ENROLLMENT', 'PRO_RATA', 'REFUND', 'SUBSCRIPTION')
     or jsonb_typeof(p_payload) <> 'object'
     or normalized_event in (
       'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED',
       'PAYMENT_RECEIVED_IN_CASH_UNDONE'
     )
  then
    raise exception using errcode = '22023', message = 'active_payment_event_input_invalid';
  end if;

  if nullif(pg_catalog.btrim(p_payload #>> '{payment,id}'), '')
       is distinct from normalized_payment_id
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,customer}'), '')
       is distinct from normalized_customer
     or nullif(pg_catalog.btrim(p_payload ->> 'id'), '')
       is distinct from normalized_event_id
     or pg_catalog.upper(pg_catalog.btrim(coalesce(p_payload ->> 'event', '')))
       is distinct from normalized_event
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,subscription}'), '')
       is distinct from normalized_subscription
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,dueDate}'), '')
       is distinct from p_due_date::text
     or nullif(pg_catalog.btrim(p_payload #>> '{payment,paymentDate}'), '')
       is distinct from (
         case when p_payment_date is null then null else p_payment_date::text end
       )
     or (
       nullif(pg_catalog.btrim(p_payload #>> '{payment,status}'), '') is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,status}'), '')
         is distinct from normalized_provider_status
     )
     or (
       normalized_billing_type is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,billingType}'), '')
         is distinct from normalized_billing_type
     )
     or (
       normalized_invoice_url is not null
       and coalesce(
         nullif(pg_catalog.btrim(p_payload #>> '{payment,bankSlipUrl}'), ''),
         nullif(pg_catalog.btrim(p_payload #>> '{payment,invoiceUrl}'), '')
       ) is distinct from normalized_invoice_url
     )
  then
    raise exception using errcode = '23514', message = 'active_payment_event_payload_identity_mismatch';
  end if;
  begin
    payload_value := (p_payload #>> '{payment,value}')::numeric;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '23514', message = 'active_payment_event_payload_value_invalid';
  end;
  if payload_value is null or payload_value::text in ('NaN', 'Infinity', '-Infinity')
     or pg_catalog.round(payload_value, 2) <> pg_catalog.round(p_provider_value, 2)
  then
    raise exception using errcode = '23514', message = 'active_payment_event_payload_value_mismatch';
  end if;
  payload_event_created_text := nullif(
    pg_catalog.btrim(coalesce(p_payload ->> 'dateCreated', '')),
    ''
  );
  begin
    payload_event_created_at := case
      when payload_event_created_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then (payload_event_created_text || ' 12:00:00+00')::timestamptz
      when payload_event_created_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
        then (payload_event_created_text || '+00')::timestamptz
      else payload_event_created_text::timestamptz
    end;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '23514', message = 'active_payment_event_payload_timestamp_invalid';
  end;
  if payload_event_created_at is null
     or payload_event_created_at is distinct from p_event_created_at
  then
    raise exception using errcode = '23514', message = 'active_payment_event_payload_timestamp_mismatch';
  end if;

  -- A subscription-created charge may omit its own reference, but the caller
  -- supplies the canonical reference obtained from the authoritative parent
  -- subscription GET. Direct one-time/manual charges must carry it themselves.
  if normalized_reference = p_expected_student_id::text then
    reference_is_canonical := true;
  elsif pg_catalog.lower(normalized_reference) ~ (
    '^student:' || p_expected_student_id::text || ':(one-time|pro-rata)$'
  ) then
    reference_is_canonical := normalized_subscription is null;
  elsif pg_catalog.lower(normalized_reference) ~ (
    '^manual-pix:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:student:'
    || p_expected_student_id::text || '$'
  ) then
    reference_is_canonical := normalized_subscription is null;
  elsif pg_catalog.lower(normalized_reference) ~ (
    '^renewal:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:subscription$'
  ) then
    -- Assinatura criada pela RENOVAÇÃO assinada (`student-renewal-billing`).
    -- A prova é a própria oferta: mesmo aluno, mesma escola, e a assinatura que
    -- ela criou é a assinatura-mãe desta cobrança. Sem este ramo, a primeira
    -- mensalidade da renovação (Bianca, 17/09/2026, paga em 30 minutos) caía em
    -- TRIAGE como "reference_mismatch" e a reativação do cadastro travava.
    reference_is_canonical := normalized_subscription is not null and exists (
      select 1
        from private.student_course_renewal_offers as renewal
       where renewal.id = pg_catalog.split_part(pg_catalog.lower(normalized_reference), ':', 2)::uuid
         and renewal.tenant_id = normalized_tenant
         and renewal.student_id = p_expected_student_id
         and renewal.provider_created_subscription_id = normalized_subscription
    );
  else
    reference_parts := pg_catalog.regexp_match(
      pg_catalog.lower(normalized_reference),
      '^enrollment:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(subscription|one-time|pro-rata|fee)$'
    );
    if reference_parts is not null
       and (
         (normalized_subscription is not null and reference_parts[2] = 'subscription')
         or (normalized_subscription is null and reference_parts[2] <> 'subscription')
       )
    then
      reference_offer_id := reference_parts[1]::uuid;
    end if;
  end if;
  if (not reference_is_canonical and reference_offer_id is null)
     or (
       normalized_subscription is null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,externalReference}'), '')
         is distinct from normalized_reference
     )
     or (
       normalized_subscription is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,externalReference}'), '') is not null
       and nullif(pg_catalog.btrim(p_payload #>> '{payment,externalReference}'), '')
         is distinct from normalized_reference
     )
  then
    raise exception using errcode = '23514', message = 'active_payment_event_reference_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || normalized_tenant || ':' || p_expected_student_id::text,
      0
    )
  );

  if exists (
    select 1
      from public.student_payments as payment
     where (
       nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
       or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id
     )
       and nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') is not null
       and nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') is not null
       and nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') <>
           nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_provider_alias_divergence');
  end if;
  select count(*) into local_payment_count
    from public.student_payments as payment
   where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
      or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id;
  if local_payment_count > 1 then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_binding_ambiguous');
  end if;
  if local_payment_count = 1 then
    select payment.* into payment_row
      from public.student_payments as payment
     where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
        or nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') = normalized_payment_id
     for update;
  end if;
  if payment_row.id is null and p_expected_local_payment_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'expected_local_payment_missing');
  end if;
  if payment_row.id is not null and (
    (p_expected_local_payment_id is not null and payment_row.id is distinct from p_expected_local_payment_id)
    or payment_row.student_id is distinct from p_expected_student_id
    or payment_row.tenant_id is distinct from normalized_tenant
    or nullif(pg_catalog.btrim(coalesce(payment_row.provider_customer_id, '')), '')
      is distinct from normalized_customer
    or payment_row.value is null
    or payment_row.value::text in ('NaN', 'Infinity', '-Infinity')
    or pg_catalog.round(payment_row.value, 2) <> pg_catalog.round(p_provider_value, 2)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'local_payment_binding_mismatch');
  end if;

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_expected_student_id
   for share;
  if not found
     or profile_row.tenant_id is distinct from normalized_tenant
     or profile_row.role is distinct from 'STUDENT'
     or nullif(pg_catalog.btrim(coalesce(profile_row.asaas_customer_id, '')), '')
       is distinct from normalized_customer
  then
    if normalized_event in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH')
       and payment_row.id is not null
       and p_expected_local_payment_id is not null
    then
      inactive_result := public.apply_inactive_student_payment_settlement(
        normalized_payment_id,
        p_expected_local_payment_id,
        p_expected_student_id,
        normalized_tenant,
        normalized_customer,
        normalized_event_id,
        normalized_event,
        p_event_created_at,
        p_event_rank,
        normalized_provider_status,
        p_provider_value,
        p_payment_date,
        p_credited_at,
        p_estimated_credit_at,
        p_payload
      );
      return inactive_result || jsonb_build_object('inactive_update_only', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'student_binding_changed');
  end if;

  select count(*), count(*) filter (
    where membership.tenant_id = normalized_tenant
      and membership.role = 'STUDENT'
      and membership.status = 'ACTIVE'
  )
    into membership_count, active_membership_count
    from (
      select current_membership.tenant_id,
             current_membership.role,
             current_membership.status
        from public.tenant_memberships as current_membership
       where current_membership.user_id = p_expected_student_id
       for share
    ) as membership;
  lifecycle_operation_active := exists (
    select 1 from public.student_offboarding_operations as operation
     where operation.tenant_id = normalized_tenant
       and operation.student_id = p_expected_student_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  ) or exists (
    select 1 from public.student_account_deletion_claims as deletion
     where deletion.tenant_id = normalized_tenant
       and deletion.student_id = p_expected_student_id
       and deletion.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
       )
  );
  lifecycle_is_active :=
    pg_catalog.lower(pg_catalog.btrim(coalesce(profile_row.lifecycle_status, ''))) = 'active'
    and membership_count = 1
    and active_membership_count = 1
    and not lifecycle_operation_active;

  if not lifecycle_is_active then
    if normalized_event in ('PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH')
       and payment_row.id is not null
       and p_expected_local_payment_id is not null
    then
      inactive_result := public.apply_inactive_student_payment_settlement(
        normalized_payment_id,
        p_expected_local_payment_id,
        p_expected_student_id,
        normalized_tenant,
        normalized_customer,
        normalized_event_id,
        normalized_event,
        p_event_created_at,
        p_event_rank,
        normalized_provider_status,
        p_provider_value,
        p_payment_date,
        p_credited_at,
        p_estimated_credit_at,
        p_payload
      );
      return inactive_result || jsonb_build_object('inactive_update_only', true);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'student_lifecycle_or_binding_changed');
  end if;

  if normalized_subscription is not null
     and nullif(pg_catalog.btrim(coalesce(profile_row.subscription_id, '')), '')
       is distinct from normalized_subscription
  then
    return jsonb_build_object('ok', false, 'reason', 'student_subscription_binding_changed');
  end if;

  if reference_offer_id is not null then
    perform 1
      from public.offers as offer
     where offer.id = reference_offer_id
       and offer.tenant_id = normalized_tenant
       and offer.kind = 'ENROLLMENT'
       and p_expected_student_id in (offer.processing_by, offer.consumed_by)
     for share;
    if not found then
      raise exception using errcode = '23514', message = 'active_payment_event_reference_mismatch';
    end if;
  end if;
  -- An exact inbox retry repairs idempotent downstream effects without
  -- rewriting the financial row (or firing its ledger triggers again). A
  -- different event with the same provider timestamp/rank is not equivalent:
  -- keep the already persisted identity as the deterministic winner.
  if payment_row.id is not null
     and nullif(pg_catalog.btrim(coalesce(payment_row.last_provider_event_id, '')), '')
       is not distinct from normalized_event_id
  then
    return jsonb_build_object(
      'ok', true,
      'action', 'REPLAY',
      'id', payment_row.id,
      'due_date', payment_row.due_date,
      'status', payment_row.status,
      'previous_status', payment_row.status,
      'was_already_paid', payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
        or payment_row.provider_status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
    );
  end if;
  if payment_row.id is not null and payment_row.last_provider_event_at is not null and (
    p_event_created_at < payment_row.last_provider_event_at
    or (
      p_event_created_at = payment_row.last_provider_event_at
      and p_event_rank <= coalesce(payment_row.last_provider_event_rank, 0)
    )
  ) then
    return jsonb_build_object(
      'ok', true,
      'action', 'IGNORED',
      'id', payment_row.id,
      'due_date', payment_row.due_date,
      'status', payment_row.status,
      'previous_status', payment_row.status,
      'was_already_paid', payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
        or payment_row.provider_status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
    );
  end if;

  if payment_row.id is null then
    insert into public.student_payments (
      asaas_payment_id, student_id, tenant_id, provider_customer_id,
      value, status, provider_status, due_date, payment_date, billing_type,
      invoice_url, description, payment_type, credited_at, paid_at,
      estimated_credit_at, raw_payload, last_provider_event_id,
      last_provider_event_at, last_provider_event_rank, updated_at
    ) values (
      normalized_payment_id, p_expected_student_id, normalized_tenant,
      normalized_customer, p_provider_value, normalized_provider_status,
      normalized_provider_status, p_due_date, p_payment_date,
      normalized_billing_type, normalized_invoice_url, normalized_description,
      normalized_payment_type, p_credited_at, p_credited_at,
      p_estimated_credit_at, p_payload, normalized_event_id,
      p_event_created_at, p_event_rank, pg_catalog.clock_timestamp()
    )
    on conflict (asaas_payment_id) where asaas_payment_id is not null do nothing
    returning id into inserted_payment_id;

    select payment.* into payment_row
      from public.student_payments as payment
     where nullif(pg_catalog.btrim(coalesce(payment.asaas_payment_id, '')), '') = normalized_payment_id
     for update;
    if not found
       or (inserted_payment_id is null and (
         payment_row.student_id is distinct from p_expected_student_id
         or payment_row.tenant_id is distinct from normalized_tenant
         or nullif(pg_catalog.btrim(coalesce(payment_row.provider_customer_id, '')), '')
           is distinct from normalized_customer
         or payment_row.value is null
         or pg_catalog.round(payment_row.value, 2) <> pg_catalog.round(p_provider_value, 2)
       ))
    then
      return jsonb_build_object('ok', false, 'reason', 'provider_payment_identity_collision');
    end if;
    if inserted_payment_id is not null then
      return jsonb_build_object(
        'ok', true,
        'action', 'INSERTED',
        'id', payment_row.id,
        'due_date', payment_row.due_date,
        'status', payment_row.status,
        'previous_status', null,
        'was_already_paid', false
      );
    end if;
  end if;

  previous_status := payment_row.status;
  was_already_paid := (
    payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
    or payment_row.provider_status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
  );
  next_status := case
    when payment_row.status = 'NAO_RECEITA' then 'NAO_RECEITA'
    when payment_row.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
      and normalized_event in (
        'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_CHARGEBACK_REQUESTED',
        'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
        'PAYMENT_DELETED'
      ) then payment_row.status
    else normalized_provider_status
  end;

  update public.student_payments as payment
     set status = next_status,
         provider_status = normalized_provider_status,
         due_date = p_due_date,
         payment_date = coalesce(p_payment_date, payment.payment_date),
         billing_type = coalesce(normalized_billing_type, payment.billing_type),
         invoice_url = coalesce(normalized_invoice_url, payment.invoice_url),
         description = normalized_description,
         payment_type = normalized_payment_type,
         credited_at = coalesce(p_credited_at, payment.credited_at),
         paid_at = coalesce(p_credited_at, payment.paid_at),
         estimated_credit_at = coalesce(p_estimated_credit_at, payment.estimated_credit_at),
         raw_payload = p_payload,
         last_provider_event_id = normalized_event_id,
         last_provider_event_at = p_event_created_at,
         last_provider_event_rank = p_event_rank,
         updated_at = pg_catalog.clock_timestamp()
   where payment.id = payment_row.id
   returning payment.* into payment_row;

  return jsonb_build_object(
    'ok', true,
    'action', 'UPDATED',
    'id', payment_row.id,
    'due_date', payment_row.due_date,
    'status', payment_row.status,
    'previous_status', previous_status,
    'was_already_paid', was_already_paid
  );
end;
$function$;

alter function public.apply_active_student_payment_event(text, uuid, uuid, text, text, text, text, text, text, timestamptz, integer, text, numeric, date, date, text, text, text, text, timestamptz, timestamptz, jsonb) owner to postgres;
revoke all on function public.apply_active_student_payment_event(text, uuid, uuid, text, text, text, text, text, text, timestamptz, integer, text, numeric, date, date, text, text, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.apply_active_student_payment_event(text, uuid, uuid, text, text, text, text, text, text, timestamptz, integer, text, numeric, date, date, text, text, text, text, timestamptz, timestamptz, jsonb) to service_role;
