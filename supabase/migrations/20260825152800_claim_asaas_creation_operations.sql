-- Exactly-once submission guard for provider-side Asaas creations.
--
-- Asaas externalReference is a reconciliation hint, not an idempotency key.
-- Every logical creation is therefore claimed durably before the Edge Function
-- may POST. Once submission starts, an ambiguous outcome can only be recovered
-- through provider reads; the same logical operation is never submitted twice.

create table if not exists public.asaas_provider_creation_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  operation text not null check (
    operation in ('CUSTOMER_CREATE', 'PAYMENT_CREATE', 'SUBSCRIPTION_CREATE')
  ),
  logical_key text not null,
  external_reference text not null,
  request_fingerprint text not null,
  request_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'CLAIMED' check (
    status in (
      'CLAIMED', 'RETRY', 'SUBMITTING', 'UNKNOWN',
      'SUCCEEDED', 'FAILED', 'BLOCKED'
    )
  ),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  next_attempt_at timestamptz not null default now(),
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  reconciliation_count integer not null default 0 check (
    reconciliation_count >= 0
  ),
  provider_entity_id text,
  provider_status text,
  last_http_status integer,
  last_error text,
  provider_response jsonb,
  submitted_at timestamptz,
  reconciled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asaas_creation_logical_key_length check (
    length(logical_key) between 1 and 240
  ),
  constraint asaas_creation_external_reference_length check (
    length(external_reference) between 1 and 240
  ),
  constraint asaas_creation_fingerprint_format check (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  unique (tenant_id, operation, logical_key)
);

-- Older installations may already have received the first revision of this
-- migration. Keep the immutable request snapshot additive and idempotent.
alter table public.asaas_provider_creation_attempts
  add column if not exists request_snapshot jsonb not null default '{}'::jsonb;

alter table public.asaas_provider_creation_attempts
  drop constraint if exists asaas_creation_request_snapshot_object;
alter table public.asaas_provider_creation_attempts
  add constraint asaas_creation_request_snapshot_object check (
    jsonb_typeof(request_snapshot) = 'object'
    and octet_length(request_snapshot::text) <= 4096
  );

create unique index if not exists asaas_creation_provider_entity_uidx
  on public.asaas_provider_creation_attempts (
    tenant_id, operation, provider_entity_id
  )
  where provider_entity_id is not null;

create index if not exists asaas_creation_attention_idx
  on public.asaas_provider_creation_attempts (
    status, next_attempt_at, updated_at
  )
  where status in ('RETRY', 'SUBMITTING', 'UNKNOWN', 'FAILED', 'BLOCKED');

comment on table public.asaas_provider_creation_attempts is
  'Persistent single-submit guard. external_reference supports recovery but never authorizes a second provider POST.';
comment on column public.asaas_provider_creation_attempts.provider_response is
  'PII-free response summary only; never store credentials, card data, CPF, or complete provider payloads.';

alter table public.asaas_provider_creation_attempts owner to postgres;
alter table public.asaas_provider_creation_attempts enable row level security;
revoke all on table public.asaas_provider_creation_attempts
  from public, anon, authenticated, service_role;
grant select on table public.asaas_provider_creation_attempts to service_role;

create or replace function public.claim_asaas_provider_creation(
  p_tenant_id text,
  p_operation text,
  p_logical_key text,
  p_external_reference text,
  p_request_fingerprint text,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_provider_creation_attempts%rowtype;
  normalized_tenant text := nullif(trim(coalesce(p_tenant_id, '')), '');
  normalized_operation text := upper(trim(coalesce(p_operation, '')));
  normalized_key text := nullif(trim(coalesce(p_logical_key, '')), '');
  normalized_reference text := nullif(
    trim(coalesce(p_external_reference, '')),
    ''
  );
  normalized_fingerprint text := lower(trim(coalesce(
    p_request_fingerprint,
    ''
  )));
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
  retry_after integer;
begin
  if normalized_tenant is null
     or normalized_operation not in (
       'CUSTOMER_CREATE', 'PAYMENT_CREATE', 'SUBSCRIPTION_CREATE'
     )
     or normalized_key is null
     or length(normalized_key) > 240
     or normalized_reference is null
     or length(normalized_reference) > 240
     or normalized_fingerprint !~ '^[a-f0-9]{64}$'
     or p_claim_token is null
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_asaas_creation_claim';
  end if;

  if not exists (
    select 1 from public.tenants as tenant
     where tenant.id = normalized_tenant
  ) then
    raise exception using errcode = '23503', message = 'tenant_not_found';
  end if;

  -- The unique key is the durable concurrency primitive. The row lock is held
  -- only for this short database transaction; no provider call occurs here.
  insert into public.asaas_provider_creation_attempts (
    tenant_id,
    operation,
    logical_key,
    external_reference,
    request_fingerprint,
    claim_token,
    lease_expires_at
  ) values (
    normalized_tenant,
    normalized_operation,
    normalized_key,
    normalized_reference,
    normalized_fingerprint,
    p_claim_token,
    now() + make_interval(secs => safe_lease)
  )
  on conflict (tenant_id, operation, logical_key) do nothing;

  select attempt.*
    into attempt_row
    from public.asaas_provider_creation_attempts as attempt
   where attempt.tenant_id = normalized_tenant
     and attempt.operation = normalized_operation
     and attempt.logical_key = normalized_key
   for update;

  if attempt_row.external_reference is distinct from normalized_reference
     or attempt_row.request_fingerprint is distinct from normalized_fingerprint
  then
    if attempt_row.status <> 'SUCCEEDED' then
      update public.asaas_provider_creation_attempts
         set status = 'BLOCKED',
             lease_expires_at = now(),
             last_error = 'logical_creation_input_mismatch',
             updated_at = now()
       where id = attempt_row.id;
    end if;

    insert into public.asaas_reconciliation_issues (
      tenant_id,
      source,
      kind,
      severity,
      local_entity_id,
      fingerprint,
      details
    ) values (
      attempt_row.tenant_id,
      'CREATION_GUARD',
      'ASAAS_CREATION_INPUT_MISMATCH',
      'CRITICAL',
      attempt_row.id::text,
      'asaas-creation:' || attempt_row.id::text,
      jsonb_build_object(
        'operation', attempt_row.operation,
        'logicalKey', attempt_row.logical_key
      )
    ) on conflict do nothing;

    return jsonb_build_object(
      'ok', false,
      'reason', 'creation_input_mismatch',
      'attempt_id', attempt_row.id,
      'action', 'REVIEW_REQUIRED'
    );
  end if;

  if attempt_row.status = 'SUCCEEDED' then
    return jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_SUCCEEDED',
      'attempt_id', attempt_row.id,
      'provider_entity_id', attempt_row.provider_entity_id,
      'provider_status', attempt_row.provider_status,
      'status', attempt_row.status
    );
  end if;

  if attempt_row.status in ('FAILED', 'BLOCKED') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'creation_requires_manual_review',
      'action', 'REVIEW_REQUIRED',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status
    );
  end if;

  if attempt_row.status = 'SUBMITTING'
     and attempt_row.lease_expires_at <= now()
  then
    update public.asaas_provider_creation_attempts
       set status = 'UNKNOWN',
           claim_token = p_claim_token,
           lease_expires_at = now() + make_interval(secs => safe_lease),
           next_attempt_at = now(),
           last_error = 'provider_submit_outcome_unknown_after_lease_expiry',
           updated_at = now()
     where id = attempt_row.id
     returning * into attempt_row;
  end if;

  if attempt_row.status = 'CLAIMED'
     and attempt_row.claim_token <> p_claim_token
     and attempt_row.lease_expires_at > now()
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (attempt_row.lease_expires_at - now())))::integer
    );
    return jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status,
      'retry_after_seconds', retry_after
    );
  end if;

  if attempt_row.status = 'SUBMITTING'
     and attempt_row.lease_expires_at > now()
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (attempt_row.lease_expires_at - now())))::integer
    );
    return jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status,
      'retry_after_seconds', retry_after
    );
  end if;

  if attempt_row.status in ('RETRY', 'UNKNOWN')
     and attempt_row.next_attempt_at > now()
  then
    retry_after := greatest(
      1,
      ceil(extract(epoch from (attempt_row.next_attempt_at - now())))::integer
    );
    return jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status,
      'retry_after_seconds', retry_after
    );
  end if;

  if attempt_row.status = 'UNKNOWN' then
    update public.asaas_provider_creation_attempts
       set claim_token = p_claim_token,
           lease_expires_at = now() + make_interval(secs => safe_lease),
           updated_at = now()
     where id = attempt_row.id
     returning * into attempt_row;

    return jsonb_build_object(
      'ok', true,
      'action', 'RECONCILE_REQUIRED',
      'attempt_id', attempt_row.id,
      'external_reference', attempt_row.external_reference,
      'claim_token', attempt_row.claim_token,
      'status', attempt_row.status
    );
  end if;

  if attempt_row.submit_attempt_count > 0 then
    update public.asaas_provider_creation_attempts
       set status = 'UNKNOWN',
           claim_token = p_claim_token,
           lease_expires_at = now() + make_interval(secs => safe_lease),
           next_attempt_at = now(),
           last_error = 'submit_already_started_reconciliation_required',
           updated_at = now()
     where id = attempt_row.id
     returning * into attempt_row;

    return jsonb_build_object(
      'ok', true,
      'action', 'RECONCILE_REQUIRED',
      'attempt_id', attempt_row.id,
      'external_reference', attempt_row.external_reference,
      'claim_token', attempt_row.claim_token,
      'status', attempt_row.status
    );
  end if;

  -- CLAIMED with an expired lease or RETRY before any POST is safe to reclaim.
  update public.asaas_provider_creation_attempts
     set status = 'CLAIMED',
         claim_token = p_claim_token,
         lease_expires_at = now() + make_interval(secs => safe_lease),
         next_attempt_at = now(),
         last_error = null,
         updated_at = now()
   where id = attempt_row.id
   returning * into attempt_row;

  return jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', attempt_row.id,
    'external_reference', attempt_row.external_reference,
    'claim_token', attempt_row.claim_token,
    'status', attempt_row.status
  );
end;
$function$;

alter function public.claim_asaas_provider_creation(
  text, text, text, text, text, uuid, integer
) owner to postgres;
revoke all on function public.claim_asaas_provider_creation(
  text, text, text, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_asaas_provider_creation(
  text, text, text, text, text, uuid, integer
) to service_role;

create or replace function public.freeze_asaas_enrollment_payment_request(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_due_date date,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_provider_creation_attempts%rowtype;
  normalized_description text := nullif(trim(coalesce(p_description, '')), '');
  expected_snapshot jsonb;
  frozen_due_date date;
begin
  if p_attempt_id is null
     or p_due_date is null
     or normalized_description is null
     or length(normalized_description) > 500
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_enrollment_payment_request_snapshot';
  end if;

  select attempt.*
    into attempt_row
    from public.asaas_provider_creation_attempts as attempt
   where attempt.id = p_attempt_id
   for update;

  if not found
     or attempt_row.operation <> 'PAYMENT_CREATE'
     or attempt_row.logical_key not like 'enrollment-fee:%'
     or (
       attempt_row.status <> 'SUCCEEDED'
       and attempt_row.claim_token is distinct from p_claim_token
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if attempt_row.request_snapshot = '{}'::jsonb then
    expected_snapshot := jsonb_build_object(
      'kind', 'ENROLLMENT_PAYMENT',
      'version', 1,
      'dueDate', p_due_date::text,
      'description', normalized_description,
      'subscription', null
    );
    update public.asaas_provider_creation_attempts
       set request_snapshot = expected_snapshot,
           updated_at = now()
     where id = attempt_row.id;
  else
    expected_snapshot := attempt_row.request_snapshot;
  end if;

  begin
    frozen_due_date := (expected_snapshot ->> 'dueDate')::date;
  exception when others then
    return jsonb_build_object(
      'ok', false,
      'reason', 'request_snapshot_invalid'
    );
  end;

  if expected_snapshot ->> 'kind' is distinct from 'ENROLLMENT_PAYMENT'
     or expected_snapshot ->> 'version' is distinct from '1'
     or expected_snapshot ->> 'description' is distinct from normalized_description
     or not (expected_snapshot ? 'subscription')
     or jsonb_typeof(expected_snapshot -> 'subscription') is distinct from 'null'
     or frozen_due_date is null
  then
    return jsonb_build_object(
      'ok', false,
      'reason', 'request_snapshot_mismatch'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'request_snapshot', expected_snapshot,
    'due_date', frozen_due_date::text
  );
end;
$function$;

alter function public.freeze_asaas_enrollment_payment_request(
  uuid, uuid, date, text
) owner to postgres;
revoke all on function public.freeze_asaas_enrollment_payment_request(
  uuid, uuid, date, text
) from public, anon, authenticated;
grant execute on function public.freeze_asaas_enrollment_payment_request(
  uuid, uuid, date, text
) to service_role;

create or replace function public.mark_asaas_provider_creation_submitting(
  p_attempt_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_provider_creation_attempts%rowtype;
begin
  select attempt.*
    into attempt_row
    from public.asaas_provider_creation_attempts as attempt
   where attempt.id = p_attempt_id
   for update;

  if not found
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= now()
     or attempt_row.submit_attempt_count <> 0
  then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  update public.asaas_provider_creation_attempts
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         submitted_at = now(),
         lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where id = p_attempt_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'SUBMITTING',
    'attempt_id', p_attempt_id
  );
end;
$function$;

alter function public.mark_asaas_provider_creation_submitting(uuid, uuid)
  owner to postgres;
revoke all on function public.mark_asaas_provider_creation_submitting(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_asaas_provider_creation_submitting(uuid, uuid)
  to service_role;

create or replace function public.record_asaas_provider_creation_state(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_entity_id text default null,
  p_provider_status text default null,
  p_http_status integer default null,
  p_error text default null,
  p_provider_response jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.asaas_provider_creation_attempts%rowtype;
  normalized_status text := upper(trim(coalesce(p_status, '')));
  normalized_provider_id text := nullif(trim(coalesce(
    p_provider_entity_id,
    ''
  )), '');
  delay_seconds integer;
begin
  if normalized_status not in (
    'RETRY', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'BLOCKED'
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_asaas_creation_state';
  end if;

  select attempt.*
    into attempt_row
    from public.asaas_provider_creation_attempts as attempt
   where attempt.id = p_attempt_id
   for update;

  if not found or attempt_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if attempt_row.status = 'SUCCEEDED' then
    return jsonb_build_object(
      'ok', normalized_status = 'SUCCEEDED'
        and attempt_row.provider_entity_id is not distinct from normalized_provider_id,
      'status', attempt_row.status,
      'provider_entity_id', attempt_row.provider_entity_id,
      'ignored_regression', normalized_status <> 'SUCCEEDED'
    );
  end if;

  if normalized_status = 'SUCCEEDED' and normalized_provider_id is null then
    raise exception using
      errcode = '22023',
      message = 'provider_entity_id_required';
  end if;

  if normalized_status = 'RETRY'
     and (
       attempt_row.status <> 'CLAIMED'
       or attempt_row.submit_attempt_count <> 0
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'unsafe_retry_rejected');
  end if;

  if normalized_status in ('UNKNOWN', 'FAILED')
     and attempt_row.submit_attempt_count <> 1
  then
    return jsonb_build_object('ok', false, 'reason', 'submit_not_started');
  end if;

  if normalized_status = 'FAILED' and attempt_row.status <> 'SUBMITTING' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_state_transition');
  end if;

  delay_seconds := least(
    3600,
    greatest(
      15,
      (power(2, least(attempt_row.reconciliation_count + 1, 8)) * 15)::integer
    )
  );

  update public.asaas_provider_creation_attempts
     set status = normalized_status,
         provider_entity_id = case
           when normalized_status = 'SUCCEEDED' then normalized_provider_id
           else provider_entity_id
         end,
         provider_status = coalesce(
           nullif(trim(coalesce(p_provider_status, '')), ''),
           provider_status
         ),
         last_http_status = p_http_status,
         last_error = nullif(left(coalesce(p_error, ''), 500), ''),
         provider_response = coalesce(p_provider_response, provider_response),
         lease_expires_at = now(),
         next_attempt_at = case
           when normalized_status in ('RETRY', 'UNKNOWN')
             then now() + make_interval(secs => delay_seconds)
           else now()
         end,
         reconciliation_count = reconciliation_count + case
           when normalized_status = 'UNKNOWN' then 1 else 0
         end,
         reconciled_at = case
           when attempt_row.status = 'UNKNOWN'
             or normalized_status = 'UNKNOWN'
             or (
               normalized_status = 'SUCCEEDED'
               and attempt_row.status <> 'SUBMITTING'
             )
             then now()
           else reconciled_at
         end,
         completed_at = case
           when normalized_status = 'SUCCEEDED' then now()
           else completed_at
         end,
         updated_at = now()
   where id = p_attempt_id;

  if normalized_status in ('UNKNOWN', 'FAILED', 'BLOCKED') then
    insert into public.asaas_reconciliation_issues (
      tenant_id,
      source,
      kind,
      severity,
      provider_entity_id,
      local_entity_id,
      fingerprint,
      details
    ) values (
      attempt_row.tenant_id,
      'CREATION_GUARD',
      'ASAAS_CREATION_' || normalized_status,
      case
        when normalized_status in ('UNKNOWN', 'BLOCKED') then 'CRITICAL'
        else 'HIGH'
      end,
      normalized_provider_id,
      attempt_row.id::text,
      'asaas-creation:' || attempt_row.id::text,
      jsonb_build_object(
        'operation', attempt_row.operation,
        'logicalKey', attempt_row.logical_key,
        'httpStatus', p_http_status,
        'error', left(coalesce(p_error, 'unknown'), 500)
      )
    ) on conflict do nothing;
  elsif normalized_status = 'SUCCEEDED' then
    update public.asaas_reconciliation_issues
       set resolved_at = coalesce(resolved_at, now()),
           resolution_note = coalesce(
             resolution_note,
             'provider entity recovered by creation guard'
           )
     where source = 'CREATION_GUARD'
       and fingerprint = 'asaas-creation:' || attempt_row.id::text
       and resolved_at is null;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', normalized_status,
    'attempt_id', p_attempt_id,
    'provider_entity_id', normalized_provider_id,
    'retry_after_seconds', case
      when normalized_status in ('RETRY', 'UNKNOWN') then delay_seconds
      else null
    end
  );
end;
$function$;

alter function public.record_asaas_provider_creation_state(
  uuid, uuid, text, text, text, integer, text, jsonb
) owner to postgres;
revoke all on function public.record_asaas_provider_creation_state(
  uuid, uuid, text, text, text, integer, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_asaas_provider_creation_state(
  uuid, uuid, text, text, text, integer, text, jsonb
) to service_role;

create or replace function public.reopen_enrollment_offer_for_unsettled_payment(
  p_offer_id uuid,
  p_user_id uuid,
  p_provider_payment_id text,
  p_reason text default 'payment_refunded'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  offer_row public.offers%rowtype;
  profile_row public.profiles%rowtype;
  payment_id text := nullif(trim(coalesce(p_provider_payment_id, '')), '');
  enrollment_payment_id text;
  one_time_payment_id text;
  activation_payment_id text;
  payment_kind text;
  normalized_reason text := lower(trim(coalesce(p_reason, '')));
  was_completed boolean;
begin
  if p_offer_id is null
     or p_user_id is null
     or payment_id is null
     or normalized_reason not in ('payment_refunded', 'payment_not_settled')
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_enrollment_refund_reopen';
  end if;

  select offer.*
    into offer_row
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'ENROLLMENT'
   for update;
  if not found
     or (
       offer_row.processing_by is distinct from p_user_id
       and offer_row.consumed_by is distinct from p_user_id
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'offer_not_owned');
  end if;

  select profile.*
    into profile_row
    from public.profiles as profile
   where profile.id = p_user_id
     and profile.role = 'STUDENT'
     and profile.tenant_id = offer_row.tenant_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  end if;

  enrollment_payment_id := coalesce(
    nullif(trim(coalesce(profile_row.enrollment_payment_id, '')), ''),
    nullif(trim(coalesce(
      offer_row.metadata ->> 'enrollment_payment_id',
      ''
    )), '')
  );
  one_time_payment_id := nullif(trim(coalesce(
    offer_row.metadata ->> 'one_time_payment_id',
    ''
  )), '');
  activation_payment_id := coalesce(
    nullif(trim(coalesce(
      offer_row.metadata ->> 'subscription_activation_payment_id',
      ''
    )), ''),
    nullif(trim(coalesce(
      offer_row.metadata ->> 'activation_payment_id',
      ''
    )), '')
  );

  payment_kind := case
    when payment_id = enrollment_payment_id then 'ENROLLMENT_FEE'
    when payment_id = one_time_payment_id then 'ONE_TIME'
    when payment_id = activation_payment_id then 'ACTIVATION'
    else null
  end;
  if payment_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'payment_not_bound');
  end if;

  was_completed := offer_row.processing_state = 'COMPLETED';

  update public.profiles
     set enrollment_fee_paid = case
           when payment_kind = 'ENROLLMENT_FEE' then false
           else enrollment_fee_paid
         end,
         status_financial = 'PENDING',
         updated_at = now()
   where id = p_user_id;

  update public.offers
     set metadata = case
           when payment_kind = 'ENROLLMENT_FEE'
             then coalesce(metadata, '{}'::jsonb) - 'enrollment_fee_paid_at'
           when payment_kind = 'ONE_TIME'
             then coalesce(metadata, '{}'::jsonb) - 'one_time_paid_at'
           else coalesce(metadata, '{}'::jsonb)
             - 'subscription_activation_received_at'
         end,
         processing_state = 'AWAITING_PAYMENT',
         processing_updated_at = now(),
         processing_completed_at = null,
         processing_error_code = normalized_reason,
         processing_error_message = case
           when normalized_reason = 'payment_refunded'
             then 'Provider payment was fully refunded'
           else 'Provider payment is not settled'
         end
   where id = p_offer_id;

  if was_completed then
    insert into public.asaas_reconciliation_issues (
      tenant_id,
      source,
      kind,
      severity,
      provider_entity_id,
      local_entity_id,
      fingerprint,
      details
    ) values (
      offer_row.tenant_id,
      'ENROLLMENT',
      case
        when normalized_reason = 'payment_refunded'
          then 'ENROLLMENT_PAYMENT_REFUNDED_AFTER_COMPLETION'
        else 'ENROLLMENT_ACTIVATED_BEFORE_SETTLEMENT'
      end,
      case when normalized_reason = 'payment_refunded' then 'CRITICAL' else 'HIGH' end,
      payment_id,
      p_offer_id::text,
      'enrollment-unsettled:' || p_offer_id::text || ':' || payment_id,
      jsonb_build_object(
        'paymentKind', payment_kind,
        'reason', normalized_reason,
        'userId', p_user_id,
        'commercialSideEffectsPreserved', true
      )
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'ok', true,
    'processing_state', 'AWAITING_PAYMENT',
    'payment_kind', payment_kind,
    'reason', normalized_reason,
    'was_completed', was_completed
  );
end;
$function$;

alter function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) owner to postgres;
revoke all on function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.reopen_enrollment_offer_for_unsettled_payment(
  uuid, uuid, text, text
) to service_role;

-- The original SaaS billing state machine treated PAYMENT_CONFIRMED as cash
-- and could provision a tenant before the money reached the Asaas balance.
-- Keep its mature identity/reversal logic behind a settlement-only wrapper.
do $rename_saas_billing_impl$
begin
  if to_regprocedure(
       'public.apply_saas_checkout_billing_event_pre_settlement_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
     ) is null
  then
    if to_regprocedure(
         'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
       ) is null
    then
      raise exception 'apply_saas_checkout_billing_event foundation is missing';
    end if;

    alter function public.apply_saas_checkout_billing_event(
      uuid, text, text, numeric, text, text, text, text,
      timestamptz, date, text, text
    ) rename to apply_saas_checkout_billing_event_pre_settlement_impl;
  end if;
end;
$rename_saas_billing_impl$;

alter function public.apply_saas_checkout_billing_event_pre_settlement_impl(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) owner to postgres;
revoke all on function public.apply_saas_checkout_billing_event_pre_settlement_impl(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) from public, anon, authenticated, service_role;

create or replace function public.apply_saas_checkout_billing_event(
  p_checkout_id uuid,
  p_event_name text,
  p_payment_id text default null,
  p_payment_value numeric default null,
  p_billing_type text default null,
  p_customer_id text default null,
  p_subscription_id text default null,
  p_billing_cycle text default null,
  p_paid_at timestamptz default null,
  p_due_date date default null,
  p_invoice_url text default null,
  p_bank_slip_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_event text := upper(trim(coalesce(p_event_name, '')));
  effective_event text;
  result jsonb;
begin
  effective_event := case
    when normalized_event = 'PAYMENT_CONFIRMED' then 'PAYMENT_UPDATED'
    when normalized_event = 'PAYMENT_RECEIVED_IN_CASH' then 'PAYMENT_RECEIVED'
    else normalized_event
  end;

  result := public.apply_saas_checkout_billing_event_pre_settlement_impl(
    p_checkout_id,
    effective_event,
    p_payment_id,
    p_payment_value,
    p_billing_type,
    p_customer_id,
    p_subscription_id,
    p_billing_cycle,
    p_paid_at,
    p_due_date,
    p_invoice_url,
    p_bank_slip_url
  );

  if normalized_event = 'PAYMENT_CONFIRMED' then
    return coalesce(result, '{}'::jsonb) || jsonb_build_object(
      'action', 'AWAITING_SETTLEMENT',
      'provider_event', normalized_event
    );
  end if;
  return result;
end;
$function$;

alter function public.apply_saas_checkout_billing_event(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) owner to postgres;
revoke all on function public.apply_saas_checkout_billing_event(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) from public, anon, authenticated;
grant execute on function public.apply_saas_checkout_billing_event(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) to service_role;

do $postcheck$
begin
  if has_table_privilege(
       'anon',
       'public.asaas_provider_creation_attempts',
       'SELECT'
     )
     or has_table_privilege(
       'authenticated',
       'public.asaas_provider_creation_attempts',
       'SELECT'
     )
     or has_table_privilege(
       'service_role',
       'public.asaas_provider_creation_attempts',
       'INSERT'
     )
     or has_table_privilege(
       'service_role',
       'public.asaas_provider_creation_attempts',
       'UPDATE'
     )
  then
    raise exception 'Asaas creation attempts table privileges are unsafe';
  end if;

  if has_function_privilege(
       'anon',
       'public.claim_asaas_provider_creation(text,text,text,text,text,uuid,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.mark_asaas_provider_creation_submitting(uuid,uuid)',
       'EXECUTE'
     )
  then
    raise exception 'Asaas creation guard RPC leaked to public API roles';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.apply_saas_checkout_billing_event_pre_settlement_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)',
       'EXECUTE'
     )
  then
    raise exception 'SaaS settlement wrapper privileges are unsafe';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_proc as procedure
     where procedure.oid in (
       'public.claim_asaas_provider_creation(text,text,text,text,text,uuid,integer)'::regprocedure,
       'public.mark_asaas_provider_creation_submitting(uuid,uuid)'::regprocedure,
       'public.record_asaas_provider_creation_state(uuid,uuid,text,text,text,integer,text,jsonb)'::regprocedure,
       'public.reopen_enrollment_offer_for_unsettled_payment(uuid,uuid,text,text)'::regprocedure,
       'public.apply_saas_checkout_billing_event_pre_settlement_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'::regprocedure,
       'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'::regprocedure
     )
       and pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
  ) then
    raise exception 'Asaas creation or settlement function owner is unsafe';
  end if;
end;
$postcheck$;

notify pgrst, 'reload schema';
