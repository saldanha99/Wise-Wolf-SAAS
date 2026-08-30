-- Serialize every provider PUT that changes a student's Asaas subscription.
-- A timed-out mutation remains GET-only until reconciled, so an older worker
-- can never overwrite a newer plan or payment-limit decision.

create table if not exists public.asaas_subscription_mutation_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null,
  customer_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(customer_id)) between 1 and 200
  ),
  subscription_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(subscription_id)) between 1 and 200
  ),
  mutation_kind text not null check (
    mutation_kind in ('PLAN_VALUE', 'MAX_PAYMENTS')
  ),
  intent_key text not null check (
    pg_catalog.char_length(intent_key) between 1 and 240
  ),
  request_fingerprint text not null check (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  expected_state jsonb not null check (
    pg_catalog.jsonb_typeof(expected_state) = 'object'
  ),
  desired_state jsonb not null check (
    pg_catalog.jsonb_typeof(desired_state) = 'object'
  ),
  integration_snapshot jsonb not null check (
    pg_catalog.jsonb_typeof(integration_snapshot) = 'object'
  ),
  requested_by uuid,
  status text not null check (
    status in (
      'CLAIMED', 'SUBMITTING', 'UNKNOWN',
      'SUCCEEDED', 'FAILED', 'BLOCKED'
    )
  ),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  provider_http_status integer,
  observed_state jsonb,
  submitted_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, subscription_id, intent_key)
);

create unique index if not exists asaas_subscription_mutation_one_active_uidx
  on public.asaas_subscription_mutation_operations (
    tenant_id, subscription_id
  )
  where status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED');
create index if not exists asaas_subscription_mutation_attention_idx
  on public.asaas_subscription_mutation_operations (status, updated_at)
  where status in ('SUBMITTING', 'UNKNOWN', 'BLOCKED');

alter table public.asaas_subscription_mutation_operations owner to postgres;
alter table public.asaas_subscription_mutation_operations
  enable row level security;
alter table public.asaas_subscription_mutation_operations
  force row level security;
revoke all on table public.asaas_subscription_mutation_operations
  from public, anon, authenticated, service_role;
grant select on table public.asaas_subscription_mutation_operations
  to service_role;

create or replace function private.validate_subscription_mutation_state(
  p_kind text,
  p_expected jsonb,
  p_desired jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case p_kind
    when 'PLAN_VALUE' then
      pg_catalog.jsonb_typeof(p_expected -> 'valueCents') = 'number'
      and pg_catalog.jsonb_typeof(p_desired -> 'valueCents') = 'number'
      and (p_expected ->> 'valueCents')::bigint > 0
      and (p_desired ->> 'valueCents')::bigint > 0
      and p_expected = pg_catalog.jsonb_build_object(
        'valueCents', (p_expected ->> 'valueCents')::bigint
      )
      and p_desired = pg_catalog.jsonb_build_object(
        'valueCents', (p_desired ->> 'valueCents')::bigint
      )
    when 'MAX_PAYMENTS' then
      pg_catalog.jsonb_typeof(p_expected -> 'maxPayments') = 'number'
      and pg_catalog.jsonb_typeof(p_desired -> 'maxPayments') = 'number'
      and (p_expected ->> 'maxPayments')::integer between 1 and 120
      and (p_desired ->> 'maxPayments')::integer between 1 and 120
      and p_expected = pg_catalog.jsonb_build_object(
        'maxPayments', (p_expected ->> 'maxPayments')::integer
      )
      and p_desired = pg_catalog.jsonb_build_object(
        'maxPayments', (p_desired ->> 'maxPayments')::integer
      )
    else false
  end;
$function$;

create or replace function private.student_subscription_mutation_scope_valid(
  p_tenant_id text,
  p_student_id uuid,
  p_customer_id text,
  p_subscription_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.profiles as profile
     where profile.id = p_student_id
       and profile.tenant_id = p_tenant_id
       and profile.role = 'STUDENT'
       and pg_catalog.lower(pg_catalog.btrim(
             coalesce(profile.lifecycle_status, '')
           )) = 'active'
       and nullif(pg_catalog.btrim(profile.asaas_customer_id), '')
         is not distinct from p_customer_id
       and nullif(pg_catalog.btrim(profile.subscription_id), '')
         is not distinct from p_subscription_id
  )
  and (
    select pg_catalog.count(*)
      from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) = 1
  and exists (
    select 1
      from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = p_tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  )
  and not exists (
    select 1
      from public.student_offboarding_operations as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
         'UNKNOWN', 'BLOCKED'
       )
  )
  and not exists (
    select 1
      from public.student_account_deletion_claims as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and operation.status in (
         'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
         'UNKNOWN', 'BLOCKED'
       )
  )
  and not exists (
    select 1
      from public.student_billing_method_operations as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and operation.status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
  )
  and not exists (
    select 1
      from public.asaas_student_billing_period_claims as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
  )
  and not exists (
    select 1
      from public.asaas_provider_creation_attempts as operation
     where operation.tenant_id = p_tenant_id
       and operation.lifecycle_student_id = p_student_id
       and operation.lifecycle_released_at is null
       and operation.status in (
         'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED'
       )
  )
  and not exists (
    select 1
      from public.student_overdue_card_charge_claims as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and (
         operation.status in ('PROCESSING', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
         or (
           operation.status = 'SUCCEEDED'
           and not exists (
             select 1
               from public.student_payments as payment
              where payment.tenant_id = p_tenant_id
                and payment.student_id = p_student_id
                and nullif(pg_catalog.btrim(coalesce(
                      payment.asaas_payment_id, ''
                    )), '') = operation.asaas_payment_id
                and pg_catalog.upper(pg_catalog.btrim(coalesce(
                      payment.status, ''
                    ))) in ('RECEIVED', 'RECEIVED_IN_CASH')
           )
         )
       )
  )
  and not exists (
    select 1
      from public.asaas_outbound_message_attempts as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
  );
$function$;

create or replace function public.claim_asaas_subscription_mutation(
  p_tenant_id text,
  p_student_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_mutation_kind text,
  p_intent_key text,
  p_request_fingerprint text,
  p_expected_state jsonb,
  p_desired_state jsonb,
  p_integration_snapshot jsonb,
  p_requested_by uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant text := nullif(pg_catalog.btrim(p_tenant_id), '');
  v_customer text := nullif(pg_catalog.btrim(p_customer_id), '');
  v_subscription text := nullif(pg_catalog.btrim(p_subscription_id), '');
  v_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(
    p_mutation_kind, ''
  )));
  v_intent text := nullif(pg_catalog.btrim(p_intent_key), '');
  v_fingerprint text := pg_catalog.lower(pg_catalog.btrim(coalesce(
    p_request_fingerprint, ''
  )));
  v_lease integer := greatest(
    60,
    least(coalesce(p_lease_seconds, 300), 600)
  );
  v_operation public.asaas_subscription_mutation_operations%rowtype;
  v_retry_after integer;
begin
  if v_tenant is null or p_student_id is null or v_customer is null
     or v_subscription is null or v_kind not in ('PLAN_VALUE', 'MAX_PAYMENTS')
     or v_intent is null or pg_catalog.char_length(v_intent) > 240
     or v_fingerprint !~ '^[a-f0-9]{64}$'
     or p_claim_token is null
     or pg_catalog.jsonb_typeof(p_integration_snapshot) <> 'object'
     or p_integration_snapshot = '{}'::jsonb
     or not private.validate_subscription_mutation_state(
       v_kind, p_expected_state, p_desired_state
     )
  then
    raise exception 'invalid_subscription_mutation_claim'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || v_tenant || ':' || p_student_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'asaas-subscription-mutation:' || v_tenant || ':' || v_subscription,
      0
    )
  );

  if not private.student_subscription_mutation_scope_valid(
    v_tenant, p_student_id, v_customer, v_subscription
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED',
      'reason', 'student_subscription_scope_changed'
    );
  end if;

  update public.asaas_subscription_mutation_operations as operation
     set status = 'UNKNOWN',
         lease_expires_at = pg_catalog.now(),
         last_error = coalesce(
           operation.last_error,
           'submit_lease_expired_reconciliation_required'
         ),
         updated_at = pg_catalog.now()
   where operation.tenant_id = v_tenant
     and operation.subscription_id = v_subscription
     and operation.status = 'SUBMITTING'
     and operation.lease_expires_at <= pg_catalog.now();
  update public.asaas_subscription_mutation_operations as operation
     set status = 'FAILED',
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         last_error = coalesce(
           operation.last_error,
           'claim_expired_before_provider_submit'
         ),
         updated_at = pg_catalog.now()
   where operation.tenant_id = v_tenant
     and operation.subscription_id = v_subscription
     and operation.status = 'CLAIMED'
     and operation.submit_attempt_count = 0
     and operation.lease_expires_at <= pg_catalog.now();

  select operation.* into v_operation
    from public.asaas_subscription_mutation_operations as operation
   where operation.tenant_id = v_tenant
     and operation.subscription_id = v_subscription
     and operation.intent_key = v_intent
   for update;

  if found then
    if v_operation.student_id is distinct from p_student_id
       or v_operation.customer_id is distinct from v_customer
       or v_operation.mutation_kind is distinct from v_kind
       or v_operation.request_fingerprint is distinct from v_fingerprint
       or v_operation.desired_state is distinct from p_desired_state
       or v_operation.integration_snapshot is distinct from p_integration_snapshot
       or (
         v_operation.status in ('CLAIMED', 'FAILED')
         and v_operation.expected_state is distinct from p_expected_state
       )
    then
      update public.asaas_subscription_mutation_operations
         set status = 'BLOCKED',
             lease_expires_at = pg_catalog.now(),
             last_error = 'subscription_mutation_intent_mismatch',
             updated_at = pg_catalog.now()
       where id = v_operation.id and status <> 'SUCCEEDED';
      return pg_catalog.jsonb_build_object(
        'ok', false, 'action', 'REVIEW_REQUIRED',
        'reason', 'subscription_mutation_intent_mismatch',
        'operation_id', v_operation.id
      );
    end if;
    if v_operation.status = 'SUCCEEDED' then
      return pg_catalog.jsonb_build_object(
        'ok', true, 'action', 'ALREADY_SUCCEEDED',
        'operation_id', v_operation.id,
        'observed_state', v_operation.observed_state
      );
    end if;
    if v_operation.status in ('SUBMITTING', 'UNKNOWN') then
      update public.asaas_subscription_mutation_operations
         set claim_token = p_claim_token,
             lease_expires_at = pg_catalog.now()
               + pg_catalog.make_interval(secs => v_lease),
             updated_at = pg_catalog.now()
       where id = v_operation.id
       returning * into v_operation;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'action', 'RECONCILE_REQUIRED',
        'operation_id', v_operation.id,
        'claim_token', v_operation.claim_token,
        'status', v_operation.status
      );
    end if;
    if v_operation.status = 'BLOCKED' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'action', 'REVIEW_REQUIRED',
        'reason', coalesce(v_operation.last_error, 'mutation_requires_review'),
        'operation_id', v_operation.id
      );
    end if;
    if v_operation.status = 'FAILED' then
      update public.asaas_subscription_mutation_operations
         set status = 'CLAIMED',
             claim_token = p_claim_token,
             lease_expires_at = pg_catalog.now()
               + pg_catalog.make_interval(secs => v_lease),
             submit_attempt_count = 0,
             provider_http_status = null,
             observed_state = null,
             submitted_at = null,
             completed_at = null,
             last_error = null,
             updated_at = pg_catalog.now()
       where id = v_operation.id
       returning * into v_operation;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'action', 'SUBMIT_ONCE',
        'operation_id', v_operation.id,
        'claim_token', v_operation.claim_token
      );
    end if;
    if v_operation.claim_token is distinct from p_claim_token
       and v_operation.lease_expires_at > pg_catalog.now()
    then
      v_retry_after := greatest(
        1,
        pg_catalog.ceil(
          pg_catalog.date_part(
            'epoch',
            v_operation.lease_expires_at - pg_catalog.now()
          )
        )::integer
      );
      return pg_catalog.jsonb_build_object(
        'ok', true, 'action', 'IN_PROGRESS',
        'operation_id', v_operation.id,
        'retry_after_seconds', v_retry_after
      );
    end if;
    update public.asaas_subscription_mutation_operations
       set claim_token = p_claim_token,
           lease_expires_at = pg_catalog.now()
             + pg_catalog.make_interval(secs => v_lease),
           updated_at = pg_catalog.now()
     where id = v_operation.id
     returning * into v_operation;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'action', 'SUBMIT_ONCE',
      'operation_id', v_operation.id,
      'claim_token', v_operation.claim_token
    );
  end if;

  select operation.* into v_operation
    from public.asaas_subscription_mutation_operations as operation
   where operation.tenant_id = v_tenant
     and operation.subscription_id = v_subscription
     and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
   for update;
  if found then
    if v_operation.status in ('SUBMITTING', 'UNKNOWN')
       and v_operation.student_id is not distinct from p_student_id
       and v_operation.customer_id is not distinct from v_customer
       and v_operation.mutation_kind is not distinct from v_kind
       and v_operation.request_fingerprint is not distinct from v_fingerprint
       and v_operation.desired_state is not distinct from p_desired_state
       and v_operation.integration_snapshot is not distinct from p_integration_snapshot
    then
      update public.asaas_subscription_mutation_operations
         set claim_token = p_claim_token,
             lease_expires_at = pg_catalog.now()
               + pg_catalog.make_interval(secs => v_lease),
             updated_at = pg_catalog.now()
       where id = v_operation.id
       returning * into v_operation;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'action', 'RECONCILE_REQUIRED',
        'operation_id', v_operation.id,
        'claim_token', v_operation.claim_token,
        'status', v_operation.status
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', v_operation.status = 'CLAIMED',
      'action', case
        when v_operation.status = 'CLAIMED' then 'IN_PROGRESS'
        else 'REVIEW_REQUIRED'
      end,
      'reason', 'subscription_mutation_in_flight',
      'operation_id', v_operation.id
    );
  end if;

  insert into public.asaas_subscription_mutation_operations (
    tenant_id, student_id, customer_id, subscription_id, mutation_kind,
    intent_key, request_fingerprint, expected_state, desired_state,
    integration_snapshot, requested_by, status, claim_token, lease_expires_at
  ) values (
    v_tenant, p_student_id, v_customer, v_subscription, v_kind,
    v_intent, v_fingerprint, p_expected_state, p_desired_state,
    p_integration_snapshot, p_requested_by, 'CLAIMED', p_claim_token,
    pg_catalog.now() + pg_catalog.make_interval(secs => v_lease)
  ) returning * into v_operation;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'action', 'SUBMIT_ONCE',
    'operation_id', v_operation.id,
    'claim_token', v_operation.claim_token
  );
end;
$function$;

create or replace function public.mark_asaas_subscription_mutation_submitting(
  p_operation_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation public.asaas_subscription_mutation_operations%rowtype;
begin
  select operation.* into v_operation
    from public.asaas_subscription_mutation_operations as operation
   where operation.id = p_operation_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || v_operation.tenant_id || ':' ||
        v_operation.student_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'asaas-subscription-mutation:' || v_operation.tenant_id || ':' ||
        v_operation.subscription_id,
      0
    )
  );
  select operation.* into v_operation
    from public.asaas_subscription_mutation_operations as operation
   where operation.id = p_operation_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_operation.claim_token is distinct from p_claim_token
     or v_operation.status <> 'CLAIMED'
     or v_operation.lease_expires_at <= pg_catalog.now()
     or v_operation.submit_attempt_count <> 0
     or not private.student_subscription_mutation_scope_valid(
       v_operation.tenant_id,
       v_operation.student_id,
       v_operation.customer_id,
       v_operation.subscription_id
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'subscription_mutation_claim_lost'
    );
  end if;
  update public.asaas_subscription_mutation_operations
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         submitted_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now() + interval '10 minutes',
         updated_at = pg_catalog.now()
   where id = v_operation.id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'status', 'SUBMITTING', 'operation_id', v_operation.id
  );
end;
$function$;

create or replace function public.finish_asaas_subscription_mutation(
  p_operation_id uuid,
  p_claim_token uuid,
  p_status text,
  p_observed_state jsonb default null,
  p_provider_http_status integer default null,
  p_last_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation public.asaas_subscription_mutation_operations%rowtype;
  v_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_status, '')));
begin
  if v_status not in ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'BLOCKED') then
    raise exception 'invalid_subscription_mutation_outcome'
      using errcode = '22023';
  end if;
  select operation.* into v_operation
    from public.asaas_subscription_mutation_operations as operation
   where operation.id = p_operation_id
   for update;
  if not found or v_operation.claim_token is distinct from p_claim_token then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  if v_operation.status = 'SUCCEEDED' then
    return pg_catalog.jsonb_build_object(
      'ok', v_status = 'SUCCEEDED'
        and p_observed_state is not distinct from v_operation.desired_state,
      'status', 'SUCCEEDED',
      'ignored_regression', v_status <> 'SUCCEEDED'
    );
  end if;
  if v_status = 'SUCCEEDED' and (
    pg_catalog.jsonb_typeof(p_observed_state) <> 'object'
    or p_observed_state is distinct from v_operation.desired_state
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'provider_postcondition_unverified'
    );
  end if;
  if (v_status = 'FAILED' and v_operation.status <> 'SUBMITTING')
     or (v_status = 'UNKNOWN' and v_operation.status <> 'SUBMITTING')
     or (
       v_status = 'SUCCEEDED'
       and v_operation.status not in ('SUBMITTING', 'UNKNOWN')
       and not (
         v_operation.status = 'CLAIMED'
         and v_operation.expected_state = v_operation.desired_state
       )
     )
     or (
       v_status = 'BLOCKED'
       and v_operation.status not in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'reason', 'invalid_state_transition'
    );
  end if;
  update public.asaas_subscription_mutation_operations
     set status = v_status,
         observed_state = case
           when p_observed_state is null then observed_state
           else p_observed_state
         end,
         provider_http_status = p_provider_http_status,
         last_error = nullif(pg_catalog.left(coalesce(p_last_error, ''), 500), ''),
         completed_at = case
           when v_status in ('SUCCEEDED', 'FAILED', 'BLOCKED')
             then pg_catalog.now()
           else null
         end,
         lease_expires_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = v_operation.id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'status', v_status, 'operation_id', v_operation.id
  );
end;
$function$;

alter function private.validate_subscription_mutation_state(text,jsonb,jsonb)
  owner to postgres;
alter function private.student_subscription_mutation_scope_valid(text,uuid,text,text)
  owner to postgres;
alter function public.claim_asaas_subscription_mutation(text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb,uuid,uuid,integer)
  owner to postgres;
alter function public.mark_asaas_subscription_mutation_submitting(uuid,uuid)
  owner to postgres;
alter function public.finish_asaas_subscription_mutation(uuid,uuid,text,jsonb,integer,text)
  owner to postgres;
revoke all on function private.validate_subscription_mutation_state(text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.student_subscription_mutation_scope_valid(text,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_asaas_subscription_mutation(text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb,uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.mark_asaas_subscription_mutation_submitting(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.finish_asaas_subscription_mutation(uuid,uuid,text,jsonb,integer,text)
  from public, anon, authenticated;
grant execute on function public.claim_asaas_subscription_mutation(text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb,uuid,uuid,integer)
  to service_role;
grant execute on function public.mark_asaas_subscription_mutation_submitting(uuid,uuid)
  to service_role;
grant execute on function public.finish_asaas_subscription_mutation(uuid,uuid,text,jsonb,integer,text)
  to service_role;

-- Only the oldest pending signed change for a subscription may be leased.
-- An operation belonging to that same row may be reclaimed for GET-only
-- reconciliation; every other active mutation keeps the queue row untouched.
create or replace function public.claim_plan_changes_awaiting_billing(
  p_tenant_id text default null,
  p_limit integer default 50,
  p_lease_seconds integer default 900
)
returns table (
  id uuid,
  tenant_id text,
  student_id uuid,
  student_name text,
  asaas_subscription_id text,
  to_monthly_fee numeric,
  to_frequency text,
  update_pending_payments boolean,
  billing_attempts integer,
  billing_claim_token uuid,
  billing_lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(
    1,
    least(coalesce(p_limit, 50), 50)
  );
  v_lease_seconds integer := greatest(
    60,
    least(coalesce(p_lease_seconds, 900), 3600)
  );
  v_tenant_id text := nullif(pg_catalog.btrim(p_tenant_id), '');
begin
  if p_tenant_id is not null and v_tenant_id is null then
    raise exception using
      errcode = '22023',
      message = 'tenant_id_required_when_scoped';
  end if;

  return query
  with candidates as materialized (
    select queued.id
      from public.student_plan_changes as queued
     where queued.billing_sync_status = 'PENDING'
       and queued.status = 'SIGNED'
       and queued.asaas_subscription_id is not null
       and (v_tenant_id is null or queued.tenant_id = v_tenant_id)
       and (
         queued.billing_claim_token is null
         or queued.billing_lease_expires_at <= pg_catalog.clock_timestamp()
       )
       and (
         queued.billing_attempts < 6
         or queued.billing_claim_token is not null
       )
       and not exists (
         select 1
           from public.student_plan_changes as earlier
          where earlier.tenant_id = queued.tenant_id
            and earlier.asaas_subscription_id = queued.asaas_subscription_id
            and earlier.billing_sync_status = 'PENDING'
            and earlier.status = 'SIGNED'
            and (
              coalesce(earlier.signed_at, earlier.created_at),
              earlier.created_at,
              earlier.id
            ) < (
              coalesce(queued.signed_at, queued.created_at),
              queued.created_at,
              queued.id
            )
       )
       and not exists (
         select 1
           from public.asaas_subscription_mutation_operations as operation
          where operation.tenant_id = queued.tenant_id
            and operation.subscription_id = queued.asaas_subscription_id
            and operation.status in (
              'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
            )
            and operation.intent_key <> 'plan-change:' || queued.id::text
       )
     order by queued.signed_at nulls last, queued.created_at, queued.id
     limit v_limit
     for update of queued skip locked
  ), claimed as (
    update public.student_plan_changes as queued
       set billing_claim_token = pg_catalog.gen_random_uuid(),
           billing_lease_expires_at = pg_catalog.clock_timestamp()
             + pg_catalog.make_interval(secs => v_lease_seconds),
           billing_claimed_at = pg_catalog.clock_timestamp(),
           billing_attempts = least(
             queued.billing_attempts + 1,
             6
           )
      from candidates
     where queued.id = candidates.id
    returning
      queued.id,
      queued.tenant_id,
      queued.student_id,
      queued.asaas_subscription_id,
      queued.to_monthly_fee,
      queued.to_frequency,
      queued.update_pending_payments,
      queued.billing_attempts,
      queued.billing_claim_token,
      queued.billing_lease_expires_at
  )
  select
    claimed.id,
    claimed.tenant_id,
    claimed.student_id,
    student.full_name,
    claimed.asaas_subscription_id,
    claimed.to_monthly_fee,
    claimed.to_frequency,
    claimed.update_pending_payments,
    claimed.billing_attempts,
    claimed.billing_claim_token,
    claimed.billing_lease_expires_at
  from claimed
  join public.profiles as student
    on student.id = claimed.student_id
  order by claimed.id;
end;
$function$;

alter function public.claim_plan_changes_awaiting_billing(text,integer,integer)
  owner to postgres;
revoke all on function public.claim_plan_changes_awaiting_billing(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.claim_plan_changes_awaiting_billing(text,integer,integer)
  to service_role;

create or replace function public.defer_plan_change_billing_claim(
  p_id uuid,
  p_claim_token uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_plan_change public.student_plan_changes%rowtype;
begin
  if p_id is null or p_claim_token is null then
    raise exception 'plan_change_claim_arguments_required'
      using errcode = '22023';
  end if;
  select queued.* into v_plan_change
    from public.student_plan_changes as queued
   where queued.id = p_id
   for update;
  if not found
     or v_plan_change.billing_sync_status <> 'PENDING'
     or v_plan_change.billing_claim_token is distinct from p_claim_token
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  update public.student_plan_changes
     set billing_claim_token = null,
         billing_lease_expires_at = null,
         billing_claimed_at = null,
         billing_attempts = greatest(billing_attempts - 1, 0),
         billing_sync_error = nullif(
           pg_catalog.left(coalesce(p_reason, ''), 500),
           ''
         )
   where id = v_plan_change.id
     and billing_claim_token = p_claim_token;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'status', 'PENDING', 'deferred', true
  );
end;
$function$;

alter function public.defer_plan_change_billing_claim(uuid,uuid,text)
  owner to postgres;
revoke all on function public.defer_plan_change_billing_claim(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.defer_plan_change_billing_claim(uuid,uuid,text)
  to service_role;

create or replace function private.guard_student_lifecycle_against_subscription_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status not in (
    'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
    'MUTATING', 'UNKNOWN', 'BLOCKED'
  ) then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || new.tenant_id || ':' ||
        new.student_id::text,
      0
    )
  );
  if exists (
    select 1
      from public.asaas_subscription_mutation_operations as operation
     where operation.tenant_id = new.tenant_id
       and operation.student_id = new.student_id
       and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
  ) then
    raise exception 'student_subscription_mutation_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists guard_offboarding_subscription_mutation
  on public.student_offboarding_operations;
create trigger guard_offboarding_subscription_mutation
before insert or update of status on public.student_offboarding_operations
for each row execute function
  private.guard_student_lifecycle_against_subscription_mutation();

drop trigger if exists guard_deletion_subscription_mutation
  on public.student_account_deletion_claims;
create trigger guard_deletion_subscription_mutation
before insert or update of status on public.student_account_deletion_claims
for each row execute function
  private.guard_student_lifecycle_against_subscription_mutation();

drop trigger if exists guard_billing_method_subscription_mutation
  on public.student_billing_method_operations;
create trigger guard_billing_method_subscription_mutation
before insert or update of status on public.student_billing_method_operations
for each row execute function
  private.guard_student_lifecycle_against_subscription_mutation();

alter function private.guard_student_lifecycle_against_subscription_mutation()
  owner to postgres;
revoke all on function private.guard_student_lifecycle_against_subscription_mutation()
  from public, anon, authenticated, service_role;

create or replace function private.guard_student_financial_operation_against_subscription_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_active boolean := false;
begin
  if tg_table_name = 'asaas_student_billing_period_claims' then
    v_active := new.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED');
  elsif tg_table_name = 'asaas_outbound_message_attempts' then
    v_active := new.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN');
  elsif tg_table_name = 'student_overdue_card_charge_claims' then
    v_active := new.status in (
      'PROCESSING', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
    ) or (
      new.status = 'SUCCEEDED'
      and not exists (
        select 1
          from public.student_payments as payment
         where payment.tenant_id = new.tenant_id
           and payment.student_id = new.student_id
           and nullif(pg_catalog.btrim(coalesce(
                 payment.asaas_payment_id, ''
               )), '') = new.asaas_payment_id
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.status, ''
               ))) in ('RECEIVED', 'RECEIVED_IN_CASH')
      )
    );
  end if;
  if not v_active then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || new.tenant_id || ':' ||
        new.student_id::text,
      0
    )
  );
  if exists (
    select 1
      from public.asaas_subscription_mutation_operations as operation
     where operation.tenant_id = new.tenant_id
       and operation.student_id = new.student_id
       and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
  ) then
    raise exception 'student_subscription_mutation_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists guard_billing_period_subscription_mutation
  on public.asaas_student_billing_period_claims;
create trigger guard_billing_period_subscription_mutation
before insert or update of status on public.asaas_student_billing_period_claims
for each row execute function
  private.guard_student_financial_operation_against_subscription_mutation();

drop trigger if exists guard_outbound_message_subscription_mutation
  on public.asaas_outbound_message_attempts;
create trigger guard_outbound_message_subscription_mutation
before insert or update of status on public.asaas_outbound_message_attempts
for each row execute function
  private.guard_student_financial_operation_against_subscription_mutation();

drop trigger if exists guard_overdue_charge_subscription_mutation
  on public.student_overdue_card_charge_claims;
create trigger guard_overdue_charge_subscription_mutation
before insert or update of status on public.student_overdue_card_charge_claims
for each row execute function
  private.guard_student_financial_operation_against_subscription_mutation();

create or replace function private.guard_student_creation_against_subscription_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.lifecycle_student_id is null
     or new.lifecycle_released_at is not null
     or new.status not in (
       'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED'
     )
  then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || new.tenant_id || ':' ||
        new.lifecycle_student_id::text,
      0
    )
  );
  if exists (
    select 1
      from public.asaas_subscription_mutation_operations as operation
     where operation.tenant_id = new.tenant_id
       and operation.student_id = new.lifecycle_student_id
       and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
  ) then
    raise exception 'student_subscription_mutation_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists guard_student_creation_subscription_mutation
  on public.asaas_provider_creation_attempts;
create trigger guard_student_creation_subscription_mutation
before insert or update of status, lifecycle_student_id, lifecycle_released_at
on public.asaas_provider_creation_attempts
for each row execute function
  private.guard_student_creation_against_subscription_mutation();

alter function private.guard_student_financial_operation_against_subscription_mutation()
  owner to postgres;
alter function private.guard_student_creation_against_subscription_mutation()
  owner to postgres;
revoke all on function private.guard_student_financial_operation_against_subscription_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_student_creation_against_subscription_mutation()
  from public, anon, authenticated, service_role;

comment on table public.asaas_subscription_mutation_operations is
  'Single active provider PUT per student subscription. SUBMITTING/UNKNOWN are reconciled by GET and never replayed.';

do $postcheck$
begin
  if pg_catalog.to_regprocedure(
       'public.claim_asaas_subscription_mutation(text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb,uuid,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.mark_asaas_subscription_mutation_submitting(uuid,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finish_asaas_subscription_mutation(uuid,uuid,text,jsonb,integer,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.defer_plan_change_billing_claim(uuid,uuid,text)'
     ) is null
  then
    raise exception 'subscription mutation RPCs are missing';
  end if;
  if pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_asaas_subscription_mutation(text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb,uuid,uuid,integer)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.finish_asaas_subscription_mutation(uuid,uuid,text,jsonb,integer,text)',
       'EXECUTE'
     )
     or not exists (
       select 1
         from pg_catalog.pg_trigger as trigger_definition
        where trigger_definition.tgrelid =
                'public.asaas_provider_creation_attempts'::pg_catalog.regclass
          and trigger_definition.tgname =
                'guard_student_creation_subscription_mutation'
          and not trigger_definition.tgisinternal
     )
  then
    raise exception 'subscription mutation privileges or cross-fences are unsafe';
  end if;
end;
$postcheck$;
