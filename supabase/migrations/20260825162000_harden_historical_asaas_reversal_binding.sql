-- Historical Asaas reversals are corrections to an existing local fact. They
-- may update only the cumulative refund/event state of a payment whose local
-- tenant, student, provider payment, and provider customer were already bound.

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preconditions$
begin
  if to_regclass('public.student_payments') is null
    or to_regclass('public.profiles') is null
    or to_regclass('private.tenant_integration_connections') is null
  then
    raise exception 'historical Asaas reversal binding prerequisites are missing';
  end if;
end
$preconditions$;

alter table public.student_payments
  add column if not exists provider_customer_id text;

-- Backfill only evidence already stored with the payment. The current profile
-- customer is deliberately not used: it may have rotated since the charge and
-- must never rewrite historical ownership.
update public.student_payments as payment
   set provider_customer_id = pg_catalog.btrim(
         payment.raw_payload #>> '{payment,customer}'
       )
 where payment.provider_customer_id is null
   and payment.asaas_payment_id is not null
   and pg_catalog.btrim(payment.raw_payload #>> '{payment,id}') =
         pg_catalog.btrim(payment.asaas_payment_id)
   and nullif(
         pg_catalog.btrim(payment.raw_payload #>> '{payment,customer}'),
         ''
       ) is not null
   and pg_catalog.length(
         pg_catalog.btrim(payment.raw_payload #>> '{payment,customer}')
       ) <= 240;

do $constraint$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint as constraint_definition
     where constraint_definition.conrelid =
             'public.student_payments'::pg_catalog.regclass
       and constraint_definition.conname =
             'student_payments_provider_customer_shape'
  ) then
    alter table public.student_payments
      add constraint student_payments_provider_customer_shape
      check (
        provider_customer_id is null
        or (
          provider_customer_id = pg_catalog.btrim(provider_customer_id)
          and pg_catalog.length(provider_customer_id) between 1 and 240
        )
      ) not valid;
  end if;
end
$constraint$;

alter table public.student_payments
  validate constraint student_payments_provider_customer_shape;

create index if not exists ix_student_payments_tenant_provider_customer
  on public.student_payments (tenant_id, provider_customer_id)
  where provider_customer_id is not null;

comment on column public.student_payments.provider_customer_id is
  'Immutable Asaas customer snapshot captured when the provider payment is first bound. Historical events validate this value instead of the mutable current profile customer.';

create or replace function private.capture_student_payment_provider_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate text;
  raw_candidate text;
  raw_payment_id text;
begin
  raw_payment_id := nullif(
    pg_catalog.btrim(new.raw_payload #>> '{payment,id}'),
    ''
  );
  raw_candidate := nullif(
    pg_catalog.btrim(new.raw_payload #>> '{payment,customer}'),
    ''
  );
  if raw_candidate is not null
    and raw_payment_id is distinct from pg_catalog.btrim(new.asaas_payment_id)
  then
    raise exception using
      errcode = '23514',
      message = 'student_payment_raw_provider_id_mismatch';
  end if;

  if tg_op = 'UPDATE' and old.provider_customer_id is not null then
    if new.provider_customer_id is distinct from old.provider_customer_id then
      raise exception using
        errcode = '23514',
        message = 'student_payment_provider_customer_immutable';
    end if;
    if new.raw_payload is distinct from old.raw_payload
      and raw_candidate is not null
      and raw_candidate is distinct from old.provider_customer_id
    then
      raise exception using
        errcode = '23514',
        message = 'student_payment_raw_customer_mismatch';
    end if;
    return new;
  end if;

  candidate := nullif(pg_catalog.btrim(new.provider_customer_id), '');
  if candidate is not null
    and raw_candidate is not null
    and candidate is distinct from raw_candidate
  then
    raise exception using
      errcode = '23514',
      message = 'student_payment_raw_customer_mismatch';
  elsif candidate is null then
    candidate := raw_candidate;
  end if;

  -- A new provider payment may be created before its first webhook. Capture
  -- the exact profile binding at insert time only; never derive it later on an
  -- UPDATE, when the profile customer might already have rotated.
  if candidate is null
     and tg_op = 'INSERT'
     and new.asaas_payment_id is not null
     and new.student_id is not null
     and new.tenant_id is not null
  then
    select nullif(pg_catalog.btrim(profile.asaas_customer_id), '')
      into candidate
      from public.profiles as profile
     where profile.id = new.student_id
       and profile.tenant_id = new.tenant_id
       and profile.role = 'STUDENT';
  end if;

  if candidate is not null and pg_catalog.length(candidate) > 240 then
    raise exception using
      errcode = '22001',
      message = 'student_payment_provider_customer_too_long';
  end if;

  new.provider_customer_id := candidate;
  return new;
end;
$function$;

alter function private.capture_student_payment_provider_customer()
  owner to postgres;
revoke all on function private.capture_student_payment_provider_customer()
  from public, anon, authenticated, service_role;
grant execute on function private.capture_student_payment_provider_customer()
  to postgres, supabase_admin;

drop trigger if exists trg_capture_student_payment_provider_customer
  on public.student_payments;
create trigger trg_capture_student_payment_provider_customer
  before insert or update of
    provider_customer_id,
    raw_payload,
    asaas_payment_id,
    student_id,
    tenant_id
  on public.student_payments
  for each row execute function private.capture_student_payment_provider_customer();

create or replace function public.apply_historical_asaas_payment_reversal(
  p_provider_payment_id text,
  p_expected_local_payment_id uuid,
  p_expected_student_id uuid,
  p_expected_tenant_id text,
  p_expected_provider_customer_id text,
  p_event_id text,
  p_event_name text,
  p_event_created_at timestamptz,
  p_event_rank integer,
  p_provider_status text,
  p_refunded_amount numeric,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  payment_record public.student_payments%rowtype;
  expected_rank integer;
  incoming_customer text;
  incoming_payment_id text;
  incoming_event_id text;
  incoming_event_name text;
  payload_value_text text;
  payload_value numeric;
  provider_refunded_value numeric := 0;
  completed_refunds_value numeric := 0;
  refund_item jsonb;
  refund_item_value numeric;
  next_status text;
begin
  if nullif(pg_catalog.btrim(p_provider_payment_id), '') is null
    or pg_catalog.length(pg_catalog.btrim(p_provider_payment_id)) > 240
    or p_expected_local_payment_id is null
    or p_expected_student_id is null
    or nullif(pg_catalog.btrim(p_expected_tenant_id), '') is null
    or p_expected_tenant_id <> 'school-wise-wolf'
    or nullif(pg_catalog.btrim(p_expected_provider_customer_id), '') is null
    or pg_catalog.length(
         pg_catalog.btrim(p_expected_provider_customer_id)
       ) > 240
    or nullif(pg_catalog.btrim(p_event_id), '') is null
    or pg_catalog.length(pg_catalog.btrim(p_event_id)) > 240
    or p_event_created_at is null
    or nullif(pg_catalog.btrim(p_provider_status), '') is null
    or pg_catalog.length(pg_catalog.btrim(p_provider_status)) > 120
    or p_payload is null
    or pg_catalog.jsonb_typeof(p_payload) <> 'object'
  then
    raise exception using
      errcode = '22023',
      message = 'historical_reversal_arguments_invalid';
  end if;

  expected_rank := case p_event_name
    when 'PAYMENT_REFUNDED' then 100
    when 'PAYMENT_RECEIVED_IN_CASH_UNDONE' then 100
    when 'PAYMENT_PARTIALLY_REFUNDED' then 90
    when 'PAYMENT_UPDATED' then 30
    else null
  end;
  if expected_rank is null or p_event_rank is distinct from expected_rank then
    raise exception using
      errcode = '22023',
      message = 'historical_reversal_event_invalid';
  end if;

  if p_refunded_amount is null
    or p_refunded_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_refunded_amount <= 0
  then
    raise exception using
      errcode = '22023',
      message = 'historical_reversal_amount_invalid';
  end if;

  incoming_payment_id := nullif(
    pg_catalog.btrim(p_payload #>> '{payment,id}'),
    ''
  );
  incoming_customer := nullif(
    pg_catalog.btrim(p_payload #>> '{payment,customer}'),
    ''
  );
  incoming_event_id := nullif(pg_catalog.btrim(p_payload ->> 'id'), '');
  incoming_event_name := nullif(pg_catalog.btrim(p_payload ->> 'event'), '');
  if incoming_payment_id is distinct from pg_catalog.btrim(p_provider_payment_id)
    or incoming_customer is distinct from
         pg_catalog.btrim(p_expected_provider_customer_id)
    or incoming_event_id is distinct from pg_catalog.btrim(p_event_id)
    or incoming_event_name is distinct from p_event_name
  then
    raise exception using
      errcode = '23514',
      message = 'historical_reversal_payload_identity_mismatch';
  end if;

  select payment.*
   into payment_record
    from public.student_payments as payment
   where payment.id = p_expected_local_payment_id
     and payment.asaas_payment_id = pg_catalog.btrim(p_provider_payment_id)
   for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'payment_not_found'
    );
  end if;

  if payment_record.student_id is distinct from p_expected_student_id
    or payment_record.tenant_id is distinct from
         pg_catalog.btrim(p_expected_tenant_id)
    or payment_record.provider_customer_id is null
    or payment_record.provider_customer_id is distinct from
         pg_catalog.btrim(p_expected_provider_customer_id)
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'local_binding_mismatch'
    );
  end if;

  if payment_record.value is null
    or payment_record.value::text in ('NaN', 'Infinity', '-Infinity')
    or payment_record.value <= 0
    or p_refunded_amount > payment_record.value
    or p_refunded_amount < coalesce(payment_record.refunded_amount, 0)
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'refund_amount_mismatch'
    );
  end if;

  if p_event_name in (
       'PAYMENT_REFUNDED',
       'PAYMENT_RECEIVED_IN_CASH_UNDONE'
     )
     and round(p_refunded_amount, 2) <> round(payment_record.value, 2)
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'full_refund_amount_mismatch'
    );
  end if;

  -- PAYMENT_UPDATED has no reversal semantics by name. It is accepted only
  -- when its own snapshot proves a completed cumulative refund. Explicit
  -- reversal events are checked too so callers cannot inflate a partial
  -- refund beyond the provider evidence present in the signed payload.
  if p_payload #>> '{payment,refundedValue}' is not null then
    begin
      provider_refunded_value :=
        (p_payload #>> '{payment,refundedValue}')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using
          errcode = '23514',
          message = 'historical_reversal_refunded_value_invalid';
    end;
    if provider_refunded_value::text in ('NaN', 'Infinity', '-Infinity')
      or provider_refunded_value < 0
    then
      raise exception using
        errcode = '23514',
        message = 'historical_reversal_refunded_value_invalid';
    end if;
  end if;

  if coalesce(
       pg_catalog.jsonb_typeof(p_payload #> '{payment,refunds}'),
       'null'
     ) not in ('null', 'array')
  then
    raise exception using
      errcode = '23514',
      message = 'historical_reversal_refunds_invalid';
  elsif pg_catalog.jsonb_typeof(p_payload #> '{payment,refunds}') = 'array'
  then
    for refund_item in
      select item.value
        from pg_catalog.jsonb_array_elements(
          p_payload #> '{payment,refunds}'
        ) as item(value)
    loop
      if pg_catalog.upper(coalesce(refund_item ->> 'status', '')) = 'DONE' then
        begin
          refund_item_value := (refund_item ->> 'value')::numeric;
        exception
          when invalid_text_representation or numeric_value_out_of_range then
            raise exception using
              errcode = '23514',
              message = 'historical_reversal_refund_item_invalid';
        end;
        if refund_item_value is null
          or refund_item_value::text in ('NaN', 'Infinity', '-Infinity')
          or refund_item_value <= 0
        then
          raise exception using
            errcode = '23514',
            message = 'historical_reversal_refund_item_invalid';
        end if;
        completed_refunds_value := completed_refunds_value + refund_item_value;
      end if;
    end loop;
  end if;

  if p_event_name not in (
       'PAYMENT_REFUNDED',
       'PAYMENT_RECEIVED_IN_CASH_UNDONE'
     )
     and round(
       greatest(provider_refunded_value, completed_refunds_value),
       2
     ) < round(p_refunded_amount, 2)
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'refund_evidence_mismatch'
    );
  end if;

  -- A reversal payload may repeat value, but it may never alter the locally
  -- bound gross amount. If present, validate it to cents and discard it.
  payload_value_text := p_payload #>> '{payment,value}';
  if payload_value_text is not null then
    begin
      payload_value := payload_value_text::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using
          errcode = '23514',
          message = 'historical_reversal_payload_value_invalid';
    end;
    if payload_value::text in ('NaN', 'Infinity', '-Infinity')
      or round(payload_value, 2) <> round(payment_record.value, 2)
    then
      raise exception using
        errcode = '23514',
        message = 'historical_reversal_payload_value_mismatch';
    end if;
  end if;

  if payment_record.last_provider_event_at is not null
    and (
      p_event_created_at < payment_record.last_provider_event_at
      or (
        p_event_created_at = payment_record.last_provider_event_at
        and p_event_rank < coalesce(payment_record.last_provider_event_rank, 0)
      )
    )
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'IGNORED',
      'id', payment_record.id,
      'due_date', payment_record.due_date,
      'status', payment_record.status
    );
  end if;

  next_status := case
    when payment_record.status = 'NAO_RECEITA' then 'NAO_RECEITA'
    when p_event_name in (
      'PAYMENT_REFUNDED',
      'PAYMENT_RECEIVED_IN_CASH_UNDONE'
    ) or round(p_refunded_amount, 2) >= round(payment_record.value, 2)
      then 'REFUNDED'
    when payment_record.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'PAGO')
      then payment_record.status
    else pg_catalog.btrim(p_provider_status)
  end;

  update public.student_payments as payment
     set status = next_status,
         provider_status = pg_catalog.btrim(p_provider_status),
         refunded_amount = round(p_refunded_amount, 2),
         last_provider_event_id = pg_catalog.btrim(p_event_id),
         last_provider_event_at = p_event_created_at,
         last_provider_event_rank = p_event_rank,
         updated_at = pg_catalog.clock_timestamp()
   where payment.id = payment_record.id
  returning payment.* into payment_record;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'UPDATED',
    'id', payment_record.id,
    'due_date', payment_record.due_date,
    'status', payment_record.status
  );
end;
$function$;

alter function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz, integer, text, numeric, jsonb
) owner to postgres;
revoke all on function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz, integer, text, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz, integer, text, numeric, jsonb
) to service_role;

comment on function public.apply_historical_asaas_payment_reversal(
  text, uuid, uuid, text, text, text, text, timestamptz, integer, text, numeric, jsonb
) is
  'Atomic update-only application of a proven historical Asaas reversal. It preserves gross value, tenant/student/provider identity, provider customer, original raw snapshot, and all financial dates.';

do $postchecks$
declare
  definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.apply_historical_asaas_payment_reversal(text,uuid,uuid,text,text,text,text,timestamp with time zone,integer,text,numeric,jsonb)'::pg_catalog.regprocedure
  ) into definition;

  if pg_catalog.strpos(pg_catalog.lower(definition), 'for update') = 0
    or pg_catalog.strpos(
         pg_catalog.lower(definition),
         'insert into public.student_payments'
       ) > 0
    or not exists (
      select 1
        from pg_catalog.pg_trigger as trigger_definition
       where trigger_definition.tgrelid =
               'public.student_payments'::pg_catalog.regclass
         and trigger_definition.tgname =
               'trg_capture_student_payment_provider_customer'
         and not trigger_definition.tgisinternal
    )
    or pg_catalog.has_function_privilege(
      'anon',
      'public.apply_historical_asaas_payment_reversal(text,uuid,uuid,text,text,text,text,timestamp with time zone,integer,text,numeric,jsonb)',
      'EXECUTE'
    )
    or pg_catalog.has_function_privilege(
      'authenticated',
      'public.apply_historical_asaas_payment_reversal(text,uuid,uuid,text,text,text,text,timestamp with time zone,integer,text,numeric,jsonb)',
      'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role',
      'public.apply_historical_asaas_payment_reversal(text,uuid,uuid,text,text,text,text,timestamp with time zone,integer,text,numeric,jsonb)',
      'EXECUTE'
    )
  then
    raise exception 'historical Asaas reversal binding hardening failed';
  end if;
end
$postchecks$;
