-- Durable, one-submit ledger for correcting an existing student's Asaas
-- subscription schedule. Provider mutations remain an operator concern; this
-- migration only makes their intent, snapshots and observations auditable.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function private.asaas_billing_schedule_snapshot_has_secret(
  p_value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_key text;
  v_child jsonb;
begin
  if p_value is null then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in
      select item.key, item.value
        from pg_catalog.jsonb_each(p_value) as item(key, value)
    loop
      if pg_catalog.lower(v_key) ~
           '(secret|token|password|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key)'
      then
        return true;
      end if;
      if private.asaas_billing_schedule_snapshot_has_secret(v_child) then
        return true;
      end if;
    end loop;
  elsif pg_catalog.jsonb_typeof(p_value) = 'array' then
    for v_child in
      select item.value
        from pg_catalog.jsonb_array_elements(p_value) as item(value)
    loop
      if private.asaas_billing_schedule_snapshot_has_secret(v_child) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$function$;

create or replace function private.asaas_billing_schedule_conflict_evidence_valid(
  p_value jsonb,
  p_subscription_id text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_count integer;
  v_payment jsonb;
begin
  if pg_catalog.jsonb_typeof(p_value) <> 'object'
     or p_value = '{}'::jsonb
     or private.asaas_billing_schedule_snapshot_has_secret(p_value)
     or pg_catalog.jsonb_typeof(p_value -> 'targetPayments') <> 'array'
     or pg_catalog.jsonb_typeof(p_value -> 'targetCompetenceCount') <> 'number'
     or p_value ->> 'subscription' is distinct from p_subscription_id
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(
          p_value ->> 'reason',
          ''
        ))) not between 1 and 500
  then
    return false;
  end if;

  begin
    v_count := (p_value ->> 'targetCompetenceCount')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return false;
  end;

  if v_count not between 1 and 100
     or pg_catalog.jsonb_array_length(p_value -> 'targetPayments') <> v_count
     or p_value is distinct from pg_catalog.jsonb_build_object(
       'reason', p_value ->> 'reason',
       'subscription', p_subscription_id,
       'targetPayments', p_value -> 'targetPayments',
       'targetCompetenceCount', v_count
     )
  then
    return false;
  end if;

  for v_payment in
    select payment.value
      from pg_catalog.jsonb_array_elements(
        p_value -> 'targetPayments'
      ) as payment(value)
  loop
    if pg_catalog.jsonb_typeof(v_payment) <> 'string'
       or pg_catalog.char_length(pg_catalog.btrim(
            v_payment #>> '{}'
          )) not between 1 and 200
    then
      return false;
    end if;
  end loop;

  return true;
end;
$function$;

create or replace function private.asaas_billing_schedule_local_payment_exact(
  p_local_payment_id uuid,
  p_tenant_id text,
  p_student_id uuid,
  p_payment_id text,
  p_customer_id text,
  p_due_date date,
  p_value numeric,
  p_billing_type text,
  p_status text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    pg_catalog.upper(pg_catalog.btrim(coalesce(p_billing_type, ''))) =
      'CREDIT_CARD'
    and pg_catalog.upper(pg_catalog.btrim(coalesce(p_status, ''))) in (
      'PENDING', 'OVERDUE'
    )
    and (
      select pg_catalog.count(*) = 1
        from public.student_payments as provider_binding
       where nullif(pg_catalog.btrim(coalesce(
               provider_binding.asaas_payment_id,
               ''
             )), '') = p_payment_id
          or nullif(pg_catalog.btrim(coalesce(
               provider_binding.asaas_id,
               ''
             )), '') = p_payment_id
    )
    and exists (
      select 1
        from public.student_payments as payment
       where payment.id = p_local_payment_id
         and payment.tenant_id = p_tenant_id
         and payment.student_id = p_student_id
         and nullif(pg_catalog.btrim(coalesce(
               payment.asaas_payment_id,
               ''
             )), '') = p_payment_id
         and (
           nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
             is null
           or nullif(pg_catalog.btrim(payment.asaas_id), '') = p_payment_id
         )
         and nullif(pg_catalog.btrim(coalesce(
               payment.provider_customer_id,
               ''
             )), '') = p_customer_id
         and payment.due_date = p_due_date
         and payment.value = p_value
         and payment.amount_cents = pg_catalog.round(p_value * 100)::bigint
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.billing_type,
               ''
             ))) = pg_catalog.upper(pg_catalog.btrim(p_billing_type))
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.payment_method,
               ''
             ))) = pg_catalog.upper(pg_catalog.btrim(p_billing_type))
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.payment_type,
               ''
             ))) = 'SUBSCRIPTION'
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.status,
               ''
             ))) = pg_catalog.upper(pg_catalog.btrim(p_status))
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.provider_status,
               ''
             ))) = pg_catalog.upper(pg_catalog.btrim(p_status))
         and payment.payment_date is null
         and payment.paid_at is null
         and payment.credited_at is null
         and coalesce(payment.refunded_amount, 0) = 0
         and coalesce(payment.ledger_entry_created, false) is false
         and not exists (
           select 1
             from public.financial_transactions as financial_entry
            where financial_entry.student_payment_id = payment.id
               or financial_entry.refund_student_payment_id = payment.id
         )
    );
$function$;

create table public.asaas_student_billing_schedule_corrections (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique check (
    pg_catalog.char_length(pg_catalog.btrim(operation_key)) between 1 and 240
  ),
  tenant_id text not null
    references public.tenants(id) on delete restrict,
  student_id uuid not null
    references public.profiles(id) on delete restrict,
  offer_id uuid not null
    references public.offers(id) on delete restrict,
  old_student_payment_id uuid not null
    references public.student_payments(id) on delete restrict,
  target_billing_claim_id uuid not null
    references public.asaas_student_billing_period_claims(id)
    on delete restrict,
  customer_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(customer_id)) between 1 and 200
  ),
  subscription_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(subscription_id)) between 1 and 200
  ),
  old_payment_id text not null unique check (
    pg_catalog.char_length(pg_catalog.btrim(old_payment_id)) between 1 and 200
  ),
  target_due_date date not null,
  target_end_date date not null,
  original_subscription_snapshot jsonb not null check (coalesce((
    pg_catalog.jsonb_typeof(original_subscription_snapshot) = 'object'
    and original_subscription_snapshot <> '{}'::jsonb
    and original_subscription_snapshot ->> 'id' = subscription_id
    and original_subscription_snapshot ->> 'customer' = customer_id
    and original_subscription_snapshot ->> 'status' = 'ACTIVE'
    and original_subscription_snapshot ->> 'billingType' = 'CREDIT_CARD'
    and original_subscription_snapshot ->> 'cycle' = 'MONTHLY'
    and pg_catalog.jsonb_typeof(
      original_subscription_snapshot -> 'value'
    ) = 'number'
    and (original_subscription_snapshot ->> 'value')::numeric > 0
    and pg_catalog.char_length(pg_catalog.btrim(
      original_subscription_snapshot ->> 'externalReference'
    )) between 1 and 240
    and pg_catalog.jsonb_typeof(
      original_subscription_snapshot -> 'maxPayments'
    ) = 'number'
    and (original_subscription_snapshot ->> 'maxPayments')::integer
      between 1 and 120
    and original_subscription_snapshot ->> 'nextDueDate'
      ~ '^\d{4}-\d{2}-\d{2}$'
    and (original_subscription_snapshot ->> 'nextDueDate')::date::text =
      original_subscription_snapshot ->> 'nextDueDate'
    and original_subscription_snapshot ->> 'endDate'
      ~ '^\d{4}-\d{2}-\d{2}$'
    and (original_subscription_snapshot ->> 'endDate')::date::text =
      original_subscription_snapshot ->> 'endDate'
  ), false)),
  original_payment_snapshot jsonb not null check (coalesce((
    pg_catalog.jsonb_typeof(original_payment_snapshot) = 'object'
    and original_payment_snapshot <> '{}'::jsonb
    and original_payment_snapshot ->> 'id' = old_payment_id
    and original_payment_snapshot ->> 'subscription' = subscription_id
    and original_payment_snapshot ->> 'customer' = customer_id
    and original_payment_snapshot ->> 'status' in ('PENDING', 'OVERDUE')
    and original_payment_snapshot ->> 'billingType' = 'CREDIT_CARD'
    and pg_catalog.jsonb_typeof(original_payment_snapshot -> 'deleted') =
      'boolean'
    and (original_payment_snapshot ->> 'deleted')::boolean is false
    and pg_catalog.jsonb_typeof(original_payment_snapshot -> 'value') =
      'number'
    and (original_payment_snapshot ->> 'value')::numeric > 0
    and original_payment_snapshot ->> 'dueDate'
      ~ '^\d{4}-\d{2}-\d{2}$'
    and (original_payment_snapshot ->> 'dueDate')::date::text =
      original_payment_snapshot ->> 'dueDate'
    and original_payment_snapshot ->> 'originalDueDate' =
      original_payment_snapshot ->> 'dueDate'
    and original_payment_snapshot ? 'paymentDate'
    and pg_catalog.jsonb_typeof(
      original_payment_snapshot -> 'paymentDate'
    ) = 'null'
    and original_payment_snapshot ? 'confirmedDate'
    and pg_catalog.jsonb_typeof(
      original_payment_snapshot -> 'confirmedDate'
    ) = 'null'
    and original_payment_snapshot ? 'creditDate'
    and pg_catalog.jsonb_typeof(
      original_payment_snapshot -> 'creditDate'
    ) = 'null'
  ), false)),
  target_subscription_snapshot jsonb not null check (coalesce((
    pg_catalog.jsonb_typeof(target_subscription_snapshot) = 'object'
    and target_subscription_snapshot <> '{}'::jsonb
    and target_subscription_snapshot ->> 'id' = subscription_id
    and target_subscription_snapshot ->> 'customer' = customer_id
    and target_subscription_snapshot ->> 'status' = 'ACTIVE'
    and target_subscription_snapshot ->> 'billingType' = 'CREDIT_CARD'
    and target_subscription_snapshot ->> 'cycle' = 'MONTHLY'
    and pg_catalog.jsonb_typeof(target_subscription_snapshot -> 'value') =
      'number'
    and (target_subscription_snapshot ->> 'value')::numeric =
      (original_subscription_snapshot ->> 'value')::numeric
    and pg_catalog.btrim(
      target_subscription_snapshot ->> 'externalReference'
    ) = pg_catalog.btrim(
      original_subscription_snapshot ->> 'externalReference'
    )
    and pg_catalog.jsonb_typeof(
      target_subscription_snapshot -> 'maxPayments'
    ) = 'number'
    and (target_subscription_snapshot ->> 'maxPayments')::integer =
      (original_subscription_snapshot ->> 'maxPayments')::integer
    and target_subscription_snapshot ->> 'nextDueDate' = target_due_date::text
    and target_subscription_snapshot ->> 'endDate' = target_end_date::text
  ), false)),
  integration_snapshot jsonb not null check (
    pg_catalog.jsonb_typeof(integration_snapshot) = 'object'
    and integration_snapshot <> '{}'::jsonb
    and not private.asaas_billing_schedule_snapshot_has_secret(
      integration_snapshot
    )
  ),
  target_conflict_evidence jsonb check (
    target_conflict_evidence is null
    or private.asaas_billing_schedule_conflict_evidence_valid(
      target_conflict_evidence,
      subscription_id
    )
  ),
  status text not null default 'READY' check (
    status in (
      'READY',
      'INACTIVATING',
      'INACTIVE_CONFIRMED',
      'DELETING_OLD_PAYMENT',
      'OLD_PAYMENT_DELETED',
      'ACTIVATING_TARGET',
      'CONTAINING_TARGET_CONFLICT',
      'TARGET_SCHEDULED',
      'AWAITING_TARGET_PAYMENT',
      'COMPLETED',
      'COMPENSATING_SUBSCRIPTION',
      'ORIGINAL_SUBSCRIPTION_RESTORED',
      'RESTORING_OLD_PAYMENT',
      'COMPENSATED',
      'UNKNOWN',
      'BLOCKED',
      'FAILED'
    )
  ),
  accept_events_until timestamptz not null,
  last_error text check (
    last_error is null
    or pg_catalog.char_length(pg_catalog.btrim(last_error)) between 1 and 1000
  ),
  started_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (target_end_date >= target_due_date),
  check (
    original_payment_snapshot ->> 'dueDate' is not null
    and original_payment_snapshot ->> 'dueDate' <> target_due_date::text
  ),
  check (
    (original_payment_snapshot ->> 'value')::numeric =
      (original_subscription_snapshot ->> 'value')::numeric
  ),
  check (
    accept_events_until > started_at
    and started_at >= created_at
  ),
  check (
    (status in ('COMPLETED', 'COMPENSATED', 'FAILED'))
      = (completed_at is not null)
  )
);

create unique index asaas_student_billing_schedule_one_active_uidx
  on public.asaas_student_billing_schedule_corrections (
    tenant_id,
    subscription_id
  )
  where status in (
    'READY',
    'INACTIVATING',
    'INACTIVE_CONFIRMED',
    'DELETING_OLD_PAYMENT',
    'OLD_PAYMENT_DELETED',
    'ACTIVATING_TARGET',
    'CONTAINING_TARGET_CONFLICT',
    'TARGET_SCHEDULED',
    'AWAITING_TARGET_PAYMENT',
    'COMPENSATING_SUBSCRIPTION',
    'ORIGINAL_SUBSCRIPTION_RESTORED',
    'RESTORING_OLD_PAYMENT',
    'UNKNOWN',
    'BLOCKED'
  );

create index asaas_student_billing_schedule_student_idx
  on public.asaas_student_billing_schedule_corrections (
    tenant_id,
    student_id,
    created_at desc
  );

create index asaas_student_billing_schedule_offer_idx
  on public.asaas_student_billing_schedule_corrections (offer_id);

create index asaas_student_billing_schedule_old_local_payment_idx
  on public.asaas_student_billing_schedule_corrections (
    old_student_payment_id
  );

create index asaas_student_billing_schedule_target_claim_idx
  on public.asaas_student_billing_schedule_corrections (
    target_billing_claim_id
  );

create index asaas_student_billing_schedule_event_scope_idx
  on public.asaas_student_billing_schedule_corrections (
    subscription_id,
    customer_id,
    status,
    accept_events_until
  );

alter table public.asaas_student_billing_schedule_corrections
  owner to postgres;
alter table public.asaas_student_billing_schedule_corrections
  enable row level security;
alter table public.asaas_student_billing_schedule_corrections
  force row level security;
revoke all on table public.asaas_student_billing_schedule_corrections
  from public, anon, authenticated, service_role;
grant select on table public.asaas_student_billing_schedule_corrections
  to service_role;

-- Make a live schedule correction participate in the same semantic fence as
-- every other student billing/lifecycle mutation. Keeping the active-state
-- predicate in one private helper prevents the reciprocal guards below from
-- drifting away from the partial unique index above.
create or replace function private.student_billing_schedule_correction_active(
  p_tenant_id text,
  p_student_id uuid,
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
      from public.asaas_student_billing_schedule_corrections as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and (
         p_subscription_id is null
         or operation.subscription_id = p_subscription_id
       )
       and operation.status in (
         'READY',
         'INACTIVATING',
         'INACTIVE_CONFIRMED',
         'DELETING_OLD_PAYMENT',
         'OLD_PAYMENT_DELETED',
         'ACTIVATING_TARGET',
         'CONTAINING_TARGET_CONFLICT',
         'TARGET_SCHEDULED',
         'AWAITING_TARGET_PAYMENT',
         'COMPENSATING_SUBSCRIPTION',
         'ORIGINAL_SUBSCRIPTION_RESTORED',
         'RESTORING_OLD_PAYMENT',
         'UNKNOWN',
         'BLOCKED'
       )
  );
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
  )
  and not private.student_billing_schedule_correction_active(
    p_tenant_id,
    p_student_id,
    p_subscription_id
  );
$function$;

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
  ) or private.student_billing_schedule_correction_active(
    new.tenant_id,
    new.student_id,
    null
  ) then
    raise exception 'student_subscription_mutation_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

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
  ) or private.student_billing_schedule_correction_active(
    new.tenant_id,
    new.student_id,
    null
  ) then
    raise exception 'student_subscription_mutation_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

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
  ) or private.student_billing_schedule_correction_active(
    new.tenant_id,
    new.lifecycle_student_id,
    null
  ) then
    raise exception 'student_subscription_mutation_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

alter function private.student_billing_schedule_correction_active(text,uuid,text)
  owner to postgres;
alter function private.asaas_billing_schedule_conflict_evidence_valid(jsonb,text)
  owner to postgres;
alter function private.asaas_billing_schedule_local_payment_exact(
  uuid,text,uuid,text,text,date,numeric,text,text
) owner to postgres;
alter function private.student_subscription_mutation_scope_valid(text,uuid,text,text)
  owner to postgres;
alter function private.guard_student_lifecycle_against_subscription_mutation()
  owner to postgres;
alter function private.guard_student_financial_operation_against_subscription_mutation()
  owner to postgres;
alter function private.guard_student_creation_against_subscription_mutation()
  owner to postgres;
revoke all on function private.student_billing_schedule_correction_active(text,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function private.asaas_billing_schedule_conflict_evidence_valid(jsonb,text)
  from public, anon, authenticated, service_role;
revoke all on function private.asaas_billing_schedule_local_payment_exact(
  uuid,text,uuid,text,text,date,numeric,text,text
) from public, anon, authenticated, service_role;
revoke all on function private.student_subscription_mutation_scope_valid(text,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.guard_student_lifecycle_against_subscription_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_student_financial_operation_against_subscription_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_student_creation_against_subscription_mutation()
  from public, anon, authenticated, service_role;

create table public.asaas_student_billing_schedule_correction_steps (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null
    references public.asaas_student_billing_schedule_corrections(id)
    on delete cascade,
  step_kind text not null check (
    step_kind in (
      'INACTIVATE_SUBSCRIPTION',
      'DELETE_OLD_PAYMENT',
      'ACTIVATE_TARGET_SCHEDULE',
      'INACTIVATE_CONFLICTED_SUBSCRIPTION',
      'ACTIVATE_ORIGINAL_SCHEDULE',
      'RESTORE_OLD_PAYMENT'
    )
  ),
  route_kind text not null check (route_kind in ('TARGET', 'COMPENSATION')),
  ordinal smallint not null check (ordinal in (10, 20, 30, 35, 40, 50)),
  status text not null default 'READY' check (
    status in (
      'READY', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'BLOCKED'
    )
  ),
  request_fingerprint text not null check (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  expected_before jsonb not null check (
    pg_catalog.jsonb_typeof(expected_before) = 'object'
    and expected_before <> '{}'::jsonb
  ),
  desired_after jsonb not null check (
    pg_catalog.jsonb_typeof(desired_after) = 'object'
    and desired_after <> '{}'::jsonb
  ),
  provider_request jsonb not null check (
    pg_catalog.jsonb_typeof(provider_request) = 'object'
    and provider_request <> '{}'::jsonb
  ),
  provider_response jsonb check (
    provider_response is null
    or pg_catalog.jsonb_typeof(provider_response) = 'object'
  ),
  observed_state jsonb check (
    observed_state is null
    or pg_catalog.jsonb_typeof(observed_state) = 'object'
  ),
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  provider_http_status integer check (
    provider_http_status is null
    or provider_http_status between 100 and 599
  ),
  submitted_at timestamptz,
  completed_at timestamptz,
  last_error text check (
    last_error is null
    or pg_catalog.char_length(pg_catalog.btrim(last_error)) between 1 and 1000
  ),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (operation_id, step_kind),
  unique (operation_id, ordinal),
  unique (id, operation_id),
  check (
    (step_kind = 'INACTIVATE_SUBSCRIPTION'
      and route_kind = 'TARGET' and ordinal = 10)
    or (step_kind = 'DELETE_OLD_PAYMENT'
      and route_kind = 'TARGET' and ordinal = 20)
    or (step_kind = 'ACTIVATE_TARGET_SCHEDULE'
      and route_kind = 'TARGET' and ordinal = 30)
    or (step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
      and route_kind = 'COMPENSATION' and ordinal = 35)
    or (step_kind = 'ACTIVATE_ORIGINAL_SCHEDULE'
      and route_kind = 'COMPENSATION' and ordinal = 40)
    or (step_kind = 'RESTORE_OLD_PAYMENT'
      and route_kind = 'COMPENSATION' and ordinal = 50)
  ),
  check (
    (submit_attempt_count = 0 and submitted_at is null)
    or (submit_attempt_count = 1 and submitted_at is not null)
  ),
  check (
    status <> 'READY'
    or (
      submit_attempt_count = 0
      and provider_response is null
      and observed_state is null
      and provider_http_status is null
      and completed_at is null
      and last_error is null
    )
  ),
  check (
    (status in ('SUCCEEDED', 'FAILED', 'BLOCKED'))
      = (completed_at is not null)
  )
);

create index asaas_student_billing_schedule_steps_attention_idx
  on public.asaas_student_billing_schedule_correction_steps (
    status,
    updated_at
  )
  where status in ('SUBMITTING', 'UNKNOWN', 'FAILED', 'BLOCKED');

alter table public.asaas_student_billing_schedule_correction_steps
  owner to postgres;
alter table public.asaas_student_billing_schedule_correction_steps
  enable row level security;
alter table public.asaas_student_billing_schedule_correction_steps
  force row level security;
revoke all on table public.asaas_student_billing_schedule_correction_steps
  from public, anon, authenticated, service_role;
grant select on table public.asaas_student_billing_schedule_correction_steps
  to service_role;

create table public.asaas_student_billing_schedule_correction_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null,
  step_id uuid not null,
  provider_event_id text not null unique check (
    pg_catalog.char_length(pg_catalog.btrim(provider_event_id)) between 1 and 240
  ),
  event_name text not null check (
    event_name in ('SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED')
  ),
  subscription_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(subscription_id)) between 1 and 200
  ),
  customer_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(customer_id)) between 1 and 200
  ),
  provider_status text not null check (
    pg_catalog.char_length(pg_catalog.btrim(provider_status)) between 1 and 80
  ),
  provider_event_at timestamptz,
  payload jsonb not null check (
    pg_catalog.jsonb_typeof(payload) = 'object'
    and payload <> '{}'::jsonb
  ),
  payload_fingerprint text not null check (
    payload_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (step_id, operation_id)
    references public.asaas_student_billing_schedule_correction_steps (
      id,
      operation_id
    )
    on delete cascade
);

create index asaas_student_billing_schedule_events_operation_idx
  on public.asaas_student_billing_schedule_correction_events (
    operation_id,
    received_at,
    id
  );

create index asaas_student_billing_schedule_events_step_idx
  on public.asaas_student_billing_schedule_correction_events (
    step_id,
    received_at,
    id
  );

alter table public.asaas_student_billing_schedule_correction_events
  owner to postgres;
alter table public.asaas_student_billing_schedule_correction_events
  enable row level security;
alter table public.asaas_student_billing_schedule_correction_events
  force row level security;
revoke all on table public.asaas_student_billing_schedule_correction_events
  from public, anon, authenticated, service_role;
revoke all on sequence
  public.asaas_student_billing_schedule_correction_events_id_seq
  from public, anon, authenticated, service_role;
grant select on table public.asaas_student_billing_schedule_correction_events
  to service_role;

create or replace function private.asaas_billing_schedule_compensation_causal(
  p_operation_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_operation public.asaas_student_billing_schedule_corrections%rowtype;
  v_delete public.asaas_student_billing_schedule_correction_steps%rowtype;
  v_restore public.asaas_student_billing_schedule_correction_steps%rowtype;
  v_local_pending boolean := false;
begin
  select operation.*
    into v_operation
    from public.asaas_student_billing_schedule_corrections as operation
   where operation.id = p_operation_id;
  if not found then
    return false;
  end if;

  if (
    select pg_catalog.count(*)
      from public.asaas_student_billing_schedule_correction_steps as step
     where step.operation_id = p_operation_id
  ) <> 6 then
    return false;
  end if;

  select step.*
    into v_delete
    from public.asaas_student_billing_schedule_correction_steps as step
   where step.operation_id = p_operation_id
     and step.step_kind = 'DELETE_OLD_PAYMENT';
  if not found then
    return false;
  end if;

  select step.*
    into v_restore
    from public.asaas_student_billing_schedule_correction_steps as step
   where step.operation_id = p_operation_id
     and step.step_kind = 'RESTORE_OLD_PAYMENT';
  if not found then
    return false;
  end if;

  v_local_pending := private.asaas_billing_schedule_local_payment_exact(
    v_operation.old_student_payment_id,
    v_operation.tenant_id,
    v_operation.student_id,
    v_operation.old_payment_id,
    v_operation.customer_id,
    (v_operation.original_payment_snapshot ->> 'dueDate')::date,
    (v_operation.original_payment_snapshot ->> 'value')::numeric,
    v_operation.original_payment_snapshot ->> 'billingType',
    'PENDING'
  );

  if not v_local_pending
     or v_restore.status <> 'SUCCEEDED'
  then
    return false;
  end if;

  -- If DELETE was refused before submission, the old PENDING charge never
  -- left the provider and RESTORE must likewise be a proven no-op. This is
  -- the only route that does not require DELETE/RESTORE webhook causality.
  if v_delete.submit_attempt_count = 0 then
    return v_delete.submitted_at is null
      and v_delete.status in ('SUCCEEDED', 'FAILED', 'BLOCKED')
      and v_restore.submit_attempt_count = 0
      and v_restore.submitted_at is null;
  end if;

  if v_delete.status <> 'SUCCEEDED'
     or v_delete.submit_attempt_count <> 1
     or v_delete.submitted_at is null
     or v_restore.submit_attempt_count <> 1
     or v_restore.submitted_at is null
  then
    return false;
  end if;

  return exists (
    select 1
      from public.student_payments as payment
      join public.asaas_webhook_inbox as restored
        on restored.provider_event_id =
          nullif(pg_catalog.btrim(coalesce(
            payment.last_provider_event_id,
            ''
          )), '')
     where payment.id = v_operation.old_student_payment_id
       and restored.event_name = 'PAYMENT_RESTORED'
       and restored.provider_entity_id = v_operation.old_payment_id
       and restored.status = 'PROCESSED'
       and restored.processed_at is not null
       and restored.received_at >= v_restore.submitted_at
       and restored.processed_at >= v_restore.submitted_at
       and restored.processed_at >= restored.received_at
       and restored.payload ->> 'id' = restored.provider_event_id
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             restored.payload ->> 'event',
             ''
           ))) = 'PAYMENT_RESTORED'
       and pg_catalog.jsonb_typeof(restored.payload -> 'payment') = 'object'
       and restored.payload #>> '{payment,id}' = v_operation.old_payment_id
       and restored.payload #>> '{payment,customer}' = v_operation.customer_id
       and restored.payload #>> '{payment,subscription}' =
         v_operation.subscription_id
       and exists (
         select 1
           from public.asaas_webhook_inbox as deleted
          where deleted.provider_event_id <> restored.provider_event_id
            and deleted.event_name = 'PAYMENT_DELETED'
            and deleted.provider_entity_id = v_operation.old_payment_id
            and deleted.status = 'PROCESSED'
            and deleted.processed_at is not null
            and deleted.received_at >= v_delete.submitted_at
            and deleted.processed_at >= v_delete.submitted_at
            and deleted.processed_at >= deleted.received_at
            and deleted.received_at <= v_restore.submitted_at
            and deleted.processed_at <= v_restore.submitted_at
            and deleted.received_at <= restored.received_at
            and deleted.processed_at <= restored.processed_at
            and deleted.payload ->> 'id' = deleted.provider_event_id
            and pg_catalog.upper(pg_catalog.btrim(coalesce(
                  deleted.payload ->> 'event',
                  ''
                ))) = 'PAYMENT_DELETED'
            and pg_catalog.jsonb_typeof(
                  deleted.payload -> 'payment'
                ) = 'object'
            and deleted.payload #>> '{payment,id}' =
              v_operation.old_payment_id
            and deleted.payload #>> '{payment,customer}' =
              v_operation.customer_id
            and deleted.payload #>> '{payment,subscription}' =
              v_operation.subscription_id
       )
  );
end;
$function$;

create or replace function private.validate_asaas_billing_schedule_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_original_due_text text := new.original_payment_snapshot ->> 'dueDate';
  v_original_due date;
  v_original_value numeric :=
    (new.original_payment_snapshot ->> 'value')::numeric;
begin
  if new.target_conflict_evidence is not null
     or new.status = 'CONTAINING_TARGET_CONFLICT'
  then
    raise exception 'billing_schedule_correction_initial_conflict_state_invalid'
      using errcode = '23514';
  end if;

  if v_original_due_text is null
     or v_original_due_text !~ '^\d{4}-\d{2}-\d{2}$'
  then
    raise exception 'billing_schedule_correction_original_due_invalid'
      using errcode = '23514';
  end if;

  begin
    v_original_due := v_original_due_text::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'billing_schedule_correction_original_due_invalid'
      using errcode = '23514';
  end;

  -- Use the same lock order as the normal subscription mutation RPCs. This
  -- closes the race where either workflow validates an empty fence and both
  -- become active before the other commits.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || new.tenant_id || ':' ||
        new.student_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'asaas-subscription-mutation:' || new.tenant_id || ':' ||
        new.subscription_id,
      0
    )
  );

  if not exists (
    select 1
      from public.profiles as student
     where student.id = new.student_id
       and student.tenant_id = new.tenant_id
       and student.role = 'STUDENT'
       and nullif(pg_catalog.btrim(coalesce(
             student.asaas_customer_id,
             ''
           )), '') = new.customer_id
       and nullif(pg_catalog.btrim(coalesce(
             student.subscription_id,
             ''
           )), '') = new.subscription_id
  )
  then
    raise exception 'billing_schedule_correction_student_scope_mismatch'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
      from public.offers as offer
     where offer.id = new.offer_id
       and offer.tenant_id = new.tenant_id
       and offer.kind = 'ENROLLMENT'
       and (
         offer.processing_by = new.student_id
         or offer.consumed_by = new.student_id
       )
       and (
         offer.processing_by is null
         or offer.processing_by = new.student_id
       )
       and (
         offer.consumed_by is null
         or offer.consumed_by = new.student_id
       )
  )
  then
    raise exception 'billing_schedule_correction_offer_scope_mismatch'
      using errcode = '23514';
  end if;

  if not private.asaas_billing_schedule_local_payment_exact(
    new.old_student_payment_id,
    new.tenant_id,
    new.student_id,
    new.old_payment_id,
    new.customer_id,
    v_original_due,
    v_original_value,
    new.original_payment_snapshot ->> 'billingType',
    new.original_payment_snapshot ->> 'status'
  )
  then
    raise exception 'billing_schedule_correction_old_payment_scope_mismatch'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
      from public.asaas_student_billing_period_claims as billing_claim
     where billing_claim.id = new.target_billing_claim_id
       and billing_claim.tenant_id = new.tenant_id
       and billing_claim.student_id = new.student_id
       and billing_claim.due_date = new.target_due_date
       and billing_claim.source = 'SUBSCRIPTION'
       and billing_claim.source_key =
         'subscription:' || new.offer_id::text
       and billing_claim.status = 'BOUND'
       and billing_claim.submit_attempt_count = 1
       and nullif(pg_catalog.btrim(coalesce(
             billing_claim.provider_entity_id,
             ''
           )), '') = new.subscription_id
  )
  then
    raise exception 'billing_schedule_correction_target_claim_scope_mismatch'
      using errcode = '23514';
  end if;

  if not private.student_subscription_mutation_scope_valid(
       new.tenant_id,
       new.student_id,
       new.customer_id,
       new.subscription_id
     )
     or exists (
       select 1
         from public.asaas_subscription_mutation_operations as operation
        where operation.tenant_id = new.tenant_id
          and operation.student_id = new.student_id
          and operation.subscription_id = new.subscription_id
          and operation.status in (
            'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
          )
     )
  then
    raise exception 'billing_schedule_correction_semantic_fence_active'
      using errcode = '55000';
  end if;

  return new;
end;
$function$;

create trigger validate_asaas_billing_schedule_operation
before insert on public.asaas_student_billing_schedule_corrections
for each row execute function
  private.validate_asaas_billing_schedule_operation();

create or replace function private.guard_asaas_billing_schedule_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.operation_key is distinct from new.operation_key
     or old.tenant_id is distinct from new.tenant_id
     or old.student_id is distinct from new.student_id
     or old.offer_id is distinct from new.offer_id
     or old.old_student_payment_id is distinct from new.old_student_payment_id
     or old.target_billing_claim_id is distinct from new.target_billing_claim_id
     or old.customer_id is distinct from new.customer_id
     or old.subscription_id is distinct from new.subscription_id
     or old.old_payment_id is distinct from new.old_payment_id
     or old.target_due_date is distinct from new.target_due_date
     or old.target_end_date is distinct from new.target_end_date
     or old.original_subscription_snapshot
          is distinct from new.original_subscription_snapshot
     or old.original_payment_snapshot
          is distinct from new.original_payment_snapshot
     or old.target_subscription_snapshot
          is distinct from new.target_subscription_snapshot
     or old.integration_snapshot is distinct from new.integration_snapshot
     or old.accept_events_until is distinct from new.accept_events_until
     or old.started_at is distinct from new.started_at
     or old.created_at is distinct from new.created_at
  then
    raise exception 'billing_schedule_correction_snapshot_immutable'
      using errcode = '55000';
  end if;

  if old.target_conflict_evidence is not null
     and new.target_conflict_evidence
       is distinct from old.target_conflict_evidence
  then
    raise exception 'billing_schedule_correction_conflict_evidence_immutable'
      using errcode = '55000';
  end if;

  if old.status in ('COMPLETED', 'COMPENSATED', 'FAILED')
     and (
       new.status is distinct from old.status
       or new.completed_at is distinct from old.completed_at
     )
  then
    raise exception 'billing_schedule_correction_terminal_immutable'
      using errcode = '55000';
  end if;

  if old.target_conflict_evidence is null
     and new.target_conflict_evidence is not null
     and (
       new.status <> 'CONTAINING_TARGET_CONFLICT'
       or old.status not in (
         'ACTIVATING_TARGET',
         'TARGET_SCHEDULED',
         'AWAITING_TARGET_PAYMENT',
         'UNKNOWN',
         'BLOCKED'
       )
       or not private.asaas_billing_schedule_conflict_evidence_valid(
         new.target_conflict_evidence,
         new.subscription_id
       )
       or not exists (
         select 1
           from public.asaas_student_billing_schedule_correction_steps as step
          where step.operation_id = new.id
            and step.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
            and step.status in ('SUCCEEDED', 'BLOCKED')
            and step.submit_attempt_count = 1
            and step.submitted_at is not null
       )
       or not exists (
         select 1
           from public.asaas_student_billing_schedule_correction_steps as step
          where step.operation_id = new.id
            and step.step_kind = 'DELETE_OLD_PAYMENT'
            and step.status = 'SUCCEEDED'
            and step.submit_attempt_count between 0 and 1
       )
       or (
         select pg_catalog.count(*)
           from public.asaas_student_billing_schedule_correction_steps as step
          where step.operation_id = new.id
       ) <> 6
       or not exists (
         select 1
           from public.asaas_student_billing_schedule_correction_steps as step
          where step.operation_id = new.id
            and step.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
            and step.status = 'READY'
            and step.submit_attempt_count = 0
            and step.submitted_at is null
       )
       or exists (
         select 1
           from public.asaas_student_billing_schedule_correction_steps as step
          where step.operation_id = new.id
            and step.step_kind in (
              'ACTIVATE_ORIGINAL_SCHEDULE',
              'RESTORE_OLD_PAYMENT'
            )
            and (
              step.status <> 'READY'
              or step.submit_attempt_count <> 0
              or step.submitted_at is not null
            )
       )
     )
  then
    raise exception 'billing_schedule_correction_target_conflict_invalid'
      using errcode = '55000';
  end if;

  if new.status = 'CONTAINING_TARGET_CONFLICT'
     and new.target_conflict_evidence is null
  then
    raise exception 'billing_schedule_correction_target_conflict_missing'
      using errcode = '55000';
  end if;

  if old.status = 'CONTAINING_TARGET_CONFLICT'
     and new.status not in ('CONTAINING_TARGET_CONFLICT', 'BLOCKED')
  then
    raise exception 'billing_schedule_correction_containment_must_block'
      using errcode = '55000';
  end if;

  if old.status = 'CONTAINING_TARGET_CONFLICT'
     and new.status = 'BLOCKED'
     and (
       not exists (
         select 1
           from public.asaas_student_billing_schedule_correction_steps as step
          where step.operation_id = new.id
            and step.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
            and step.status = 'SUCCEEDED'
            and step.submit_attempt_count between 0 and 1
            and pg_catalog.upper(pg_catalog.btrim(coalesce(
                  step.observed_state ->> 'status',
                  ''
                ))) = 'INACTIVE'
            and step.observed_state @> (step.desired_after - 'nextDueDate')
       )
       or exists (
         select 1
           from public.asaas_student_billing_schedule_correction_steps as step
          where step.operation_id = new.id
            and step.step_kind in (
              'ACTIVATE_ORIGINAL_SCHEDULE',
              'RESTORE_OLD_PAYMENT'
            )
            and (
              step.status <> 'READY'
              or step.submit_attempt_count <> 0
              or step.submitted_at is not null
            )
       )
     )
  then
    raise exception 'billing_schedule_correction_containment_unconfirmed'
      using errcode = '55000';
  end if;

  if old.status = 'BLOCKED'
     and old.target_conflict_evidence is not null
     and new.status <> 'BLOCKED'
  then
    raise exception 'billing_schedule_correction_containment_fence_active'
      using errcode = '55000';
  end if;

  if old.status <> 'COMPENSATED'
     and new.status = 'COMPENSATED'
     and (
       old.status <> 'RESTORING_OLD_PAYMENT'
       or not private.asaas_billing_schedule_compensation_causal(new.id)
     )
  then
    raise exception 'billing_schedule_correction_compensation_not_reconciled'
      using errcode = '55000';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create trigger guard_asaas_billing_schedule_operation
before update on public.asaas_student_billing_schedule_corrections
for each row execute function
  private.guard_asaas_billing_schedule_operation();

create or replace function private.guard_asaas_billing_schedule_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation public.asaas_student_billing_schedule_corrections%rowtype;
begin
  if old.operation_id is distinct from new.operation_id
     or old.step_kind is distinct from new.step_kind
     or old.route_kind is distinct from new.route_kind
     or old.ordinal is distinct from new.ordinal
     or old.request_fingerprint is distinct from new.request_fingerprint
     or old.expected_before is distinct from new.expected_before
     or old.desired_after is distinct from new.desired_after
     or old.provider_request is distinct from new.provider_request
     or old.created_at is distinct from new.created_at
  then
    raise exception 'billing_schedule_correction_step_snapshot_immutable'
      using errcode = '55000';
  end if;

  if new.submit_attempt_count < old.submit_attempt_count
     or new.submit_attempt_count > old.submit_attempt_count + 1
     or (
       old.submit_attempt_count = 1
       and new.submit_attempt_count is distinct from 1
     )
     or (
       old.submitted_at is not null
       and new.submitted_at is distinct from old.submitted_at
     )
     or (
       old.completed_at is not null
       and new.completed_at is distinct from old.completed_at
     )
  then
    raise exception 'billing_schedule_correction_step_submit_immutable'
      using errcode = '55000';
  end if;

  if new.status = 'SUBMITTING' and old.status <> 'SUBMITTING' then
    if old.status <> 'READY'
       or old.submit_attempt_count <> 0
       or new.submit_attempt_count <> 1
       or new.submitted_at is null
    then
      raise exception 'billing_schedule_correction_step_resubmit_forbidden'
        using errcode = '55000';
    end if;

    select operation.*
      into v_operation
      from public.asaas_student_billing_schedule_corrections as operation
     where operation.id = new.operation_id
     for share;

    if not found
       or pg_catalog.clock_timestamp() >= v_operation.accept_events_until
       or new.submitted_at < v_operation.started_at
       or new.submitted_at > v_operation.accept_events_until
    then
      raise exception 'billing_schedule_correction_event_window_expired'
        using errcode = '55000';
    end if;
  end if;

  if new.step_kind in (
       'ACTIVATE_ORIGINAL_SCHEDULE',
       'RESTORE_OLD_PAYMENT'
     )
     and (
       new.status <> 'READY'
       or new.submit_attempt_count <> 0
       or new.submitted_at is not null
     )
     and exists (
       select 1
         from public.asaas_student_billing_schedule_corrections as operation
        where operation.id = new.operation_id
          and operation.target_conflict_evidence is not null
     )
  then
    raise exception 'billing_schedule_correction_conflict_restore_forbidden'
      using errcode = '55000';
  end if;

  if new.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
     and old.status = 'READY'
     and new.status <> 'READY'
     and not exists (
       select 1
         from public.asaas_student_billing_schedule_corrections as operation
        where operation.id = new.operation_id
          and operation.status = 'CONTAINING_TARGET_CONFLICT'
          and operation.target_conflict_evidence is not null
     )
  then
    raise exception 'billing_schedule_correction_containment_not_active'
      using errcode = '55000';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

create trigger guard_asaas_billing_schedule_step
before update on public.asaas_student_billing_schedule_correction_steps
for each row execute function private.guard_asaas_billing_schedule_step();

create or replace function private.validate_asaas_billing_schedule_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation public.asaas_student_billing_schedule_corrections%rowtype;
  v_expected_status text;
begin
  select operation.*
    into v_operation
    from public.asaas_student_billing_schedule_corrections as operation
   where operation.id = new.operation_id;

  if not found then
    raise exception 'billing_schedule_correction_operation_missing'
      using errcode = '23503';
  end if;

  if new.step_kind in (
       'INACTIVATE_SUBSCRIPTION',
       'ACTIVATE_TARGET_SCHEDULE',
       'INACTIVATE_CONFLICTED_SUBSCRIPTION',
       'ACTIVATE_ORIGINAL_SCHEDULE'
     )
  then
    v_expected_status := case
      when new.step_kind in (
        'INACTIVATE_SUBSCRIPTION',
        'INACTIVATE_CONFLICTED_SUBSCRIPTION'
      ) then 'INACTIVE'
      else 'ACTIVE'
    end;

    if new.desired_after ->> 'id'
         is distinct from v_operation.subscription_id
       or new.desired_after ->> 'customer'
         is distinct from v_operation.customer_id
       or pg_catalog.upper(pg_catalog.btrim(coalesce(
            new.desired_after ->> 'status', ''
          ))) <> v_expected_status
       or not (new.desired_after ? 'endDate')
       or not (new.desired_after ? 'billingType')
       or not (new.desired_after ? 'cycle')
       or not (new.desired_after ? 'value')
       or not (new.desired_after ? 'externalReference')
       or not (new.desired_after ? 'maxPayments')
    then
      raise exception 'billing_schedule_correction_step_scope_mismatch'
        using errcode = '23514';
    end if;

    if new.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
       and new.desired_after ->> 'endDate'
         is distinct from v_operation.target_end_date::text
    then
      raise exception 'billing_schedule_correction_target_end_date_mismatch'
        using errcode = '23514';
    end if;

    if new.step_kind = 'ACTIVATE_ORIGINAL_SCHEDULE'
       and new.desired_after ->> 'endDate' is distinct from
         v_operation.original_subscription_snapshot ->> 'endDate'
    then
      raise exception 'billing_schedule_correction_original_end_date_mismatch'
        using errcode = '23514';
    end if;

    if new.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
       and (
         new.status <> 'READY'
         or new.submit_attempt_count <> 0
         or new.submitted_at is not null
         or new.expected_before is distinct from
           v_operation.target_subscription_snapshot
         or new.desired_after is distinct from pg_catalog.jsonb_set(
           v_operation.target_subscription_snapshot,
           '{status}',
           '"INACTIVE"'::jsonb,
           false
         )
         or new.provider_request is distinct from
           pg_catalog.jsonb_build_object(
             'method', 'PUT',
             'path', '/subscriptions/' || v_operation.subscription_id,
             'body', pg_catalog.jsonb_build_object('status', 'INACTIVE')
           )
       )
    then
      raise exception 'billing_schedule_correction_containment_step_invalid'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

create trigger validate_asaas_billing_schedule_step
before insert on public.asaas_student_billing_schedule_correction_steps
for each row execute function private.validate_asaas_billing_schedule_step();

alter function private.asaas_billing_schedule_snapshot_has_secret(jsonb)
  owner to postgres;
alter function private.asaas_billing_schedule_compensation_causal(uuid)
  owner to postgres;
alter function private.validate_asaas_billing_schedule_operation()
  owner to postgres;
alter function private.guard_asaas_billing_schedule_operation()
  owner to postgres;
alter function private.guard_asaas_billing_schedule_step()
  owner to postgres;
alter function private.validate_asaas_billing_schedule_step()
  owner to postgres;
revoke all on function private.asaas_billing_schedule_snapshot_has_secret(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.asaas_billing_schedule_compensation_causal(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_asaas_billing_schedule_operation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_asaas_billing_schedule_operation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_asaas_billing_schedule_step()
  from public, anon, authenticated, service_role;
revoke all on function private.validate_asaas_billing_schedule_step()
  from public, anon, authenticated, service_role;

create or replace function public.observe_asaas_student_billing_schedule_event(
  p_provider_event_id text,
  p_event_name text,
  p_subscription_id text,
  p_customer_id text,
  p_provider_status text,
  p_provider_event_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_event_id text := nullif(
    pg_catalog.btrim(coalesce(p_provider_event_id, '')),
    ''
  );
  v_event_name text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_event_name, ''))
  );
  v_subscription_id text := nullif(
    pg_catalog.btrim(coalesce(p_subscription_id, '')),
    ''
  );
  v_customer_id text := nullif(
    pg_catalog.btrim(coalesce(p_customer_id, '')),
    ''
  );
  v_provider_status text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_provider_status, ''))
  );
  v_subscription_payload jsonb;
  v_payload_fingerprint text;
  v_inbox public.asaas_webhook_inbox%rowtype;
  v_existing public.asaas_student_billing_schedule_correction_events%rowtype;
  v_match_count bigint;
  v_operation_id uuid;
  v_step_id uuid;
  v_step_kind text;
begin
  if v_provider_event_id is null
     or pg_catalog.char_length(v_provider_event_id) > 240
     or v_event_name not in (
       'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED'
     )
     or v_subscription_id is null
     or pg_catalog.char_length(v_subscription_id) > 200
     or v_customer_id is null
     or pg_catalog.char_length(v_customer_id) > 200
     or v_provider_status = ''
     or pg_catalog.char_length(v_provider_status) > 80
     or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or p_payload = '{}'::jsonb
  then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'invalid_schedule_correction_event'
    );
  end if;

  v_subscription_payload := p_payload -> 'subscription';
  if p_payload ->> 'id' is distinct from v_provider_event_id
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
          p_payload ->> 'event', ''
        ))) <> v_event_name
     or pg_catalog.jsonb_typeof(v_subscription_payload) <> 'object'
     or v_subscription_payload ->> 'id' is distinct from v_subscription_id
     or v_subscription_payload ->> 'customer' is distinct from v_customer_id
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
          v_subscription_payload ->> 'status', ''
        ))) <> v_provider_status
  then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'schedule_correction_payload_mismatch'
    );
  end if;

  if (v_event_name = 'SUBSCRIPTION_INACTIVATED'
      and v_provider_status <> 'INACTIVE')
     or (v_event_name = 'SUBSCRIPTION_UPDATED'
      and v_provider_status <> 'ACTIVE')
  then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'schedule_correction_status_mismatch'
    );
  end if;

  select inbox.*
    into v_inbox
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_event_id = v_provider_event_id
   for share;

  if not found
     or v_inbox.event_name is distinct from v_event_name
     or v_inbox.provider_entity_id is distinct from v_subscription_id
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
          v_inbox.payload_hash,
          ''
        ))) !~ '^[a-f0-9]{64}$'
     or v_inbox.payload is distinct from p_payload
     or v_inbox.status <> 'PROCESSING'
     or v_inbox.lease_owner is null
     or v_inbox.lease_expires_at is null
     or v_inbox.lease_expires_at <= pg_catalog.clock_timestamp()
  then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'schedule_correction_inbox_not_claimed'
    );
  end if;

  -- The inbox owns canonical webhook hashing (the Edge implementation uses a
  -- JS canonicalizer). Copy that hash; jsonb::text is not byte-equivalent.
  v_payload_fingerprint := pg_catalog.lower(
    pg_catalog.btrim(v_inbox.payload_hash)
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'asaas-student-billing-schedule-event:' || v_provider_event_id,
      0
    )
  );

  select observed.*
    into v_existing
    from public.asaas_student_billing_schedule_correction_events as observed
   where observed.provider_event_id = v_provider_event_id;

  if found then
    if v_existing.event_name = v_event_name
       and v_existing.subscription_id = v_subscription_id
       and v_existing.customer_id = v_customer_id
       and v_existing.provider_status = v_provider_status
       and v_existing.provider_event_at is not distinct from p_provider_event_at
       and v_existing.payload_fingerprint = v_payload_fingerprint
    then
      select step.step_kind
        into v_step_kind
        from public.asaas_student_billing_schedule_correction_steps as step
       where step.id = v_existing.step_id;

      return pg_catalog.jsonb_build_object(
        'handled', true,
        'operation_id', v_existing.operation_id,
        'step_kind', v_step_kind,
        'duplicate', true
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'schedule_correction_provider_event_id_collision',
      'duplicate', false
    );
  end if;

  select
    pg_catalog.count(*),
    (pg_catalog.array_agg(
      operation.id order by step.ordinal desc
    ))[1],
    (pg_catalog.array_agg(
      step.id order by step.ordinal desc
    ))[1],
    (pg_catalog.array_agg(
      step.step_kind order by step.ordinal desc
    ))[1]
    into v_match_count, v_operation_id, v_step_id, v_step_kind
    from public.asaas_student_billing_schedule_corrections as operation
    join public.asaas_student_billing_schedule_correction_steps as step
      on step.operation_id = operation.id
   where operation.subscription_id = v_subscription_id
     and operation.customer_id = v_customer_id
     and operation.status in (
       'READY',
       'INACTIVATING',
       'INACTIVE_CONFIRMED',
       'DELETING_OLD_PAYMENT',
       'OLD_PAYMENT_DELETED',
       'ACTIVATING_TARGET',
       'CONTAINING_TARGET_CONFLICT',
       'TARGET_SCHEDULED',
       'AWAITING_TARGET_PAYMENT',
       'COMPENSATING_SUBSCRIPTION',
       'ORIGINAL_SUBSCRIPTION_RESTORED',
       'RESTORING_OLD_PAYMENT',
       'COMPLETED',
       'COMPENSATED',
       'UNKNOWN',
       'BLOCKED'
     )
     -- The provider timestamp is intentionally audit-only. Eligibility uses
     -- the immutable first receipt from the exact leased inbox row. Inclusive
     -- lower bounds reject stale pre-operation/pre-submit events, while a
     -- delayed or retried drain remains valid when its first receipt happened
     -- after submission and inside the operation window.
     and v_inbox.received_at >= operation.started_at
     and v_inbox.received_at >= step.submitted_at
     and v_inbox.received_at <= operation.accept_events_until
     and step.status in ('SUBMITTING', 'UNKNOWN', 'SUCCEEDED')
     and step.submit_attempt_count = 1
     and (
       (v_event_name = 'SUBSCRIPTION_INACTIVATED'
         and step.step_kind in (
           'INACTIVATE_SUBSCRIPTION',
           'INACTIVATE_CONFLICTED_SUBSCRIPTION'
         ))
       or (v_event_name = 'SUBSCRIPTION_UPDATED'
         and step.step_kind in (
           'ACTIVATE_TARGET_SCHEDULE',
           'ACTIVATE_ORIGINAL_SCHEDULE'
         ))
     )
     and pg_catalog.upper(pg_catalog.btrim(coalesce(
           step.desired_after ->> 'status', ''
         ))) = v_provider_status
     -- Asaas may advance nextDueDate synchronously when it materializes the
     -- first charge. All other stable desired fields must match exactly.
     and v_subscription_payload @> (step.desired_after - 'nextDueDate');

  if v_match_count = 0 then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'no_expected_schedule_correction_event'
    );
  end if;

  if v_match_count > 1 then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'ambiguous_schedule_correction_event'
    );
  end if;

  insert into public.asaas_student_billing_schedule_correction_events (
    operation_id,
    step_id,
    provider_event_id,
    event_name,
    subscription_id,
    customer_id,
    provider_status,
    provider_event_at,
    payload,
    payload_fingerprint,
    received_at
  ) values (
    v_operation_id,
    v_step_id,
    v_provider_event_id,
    v_event_name,
    v_subscription_id,
    v_customer_id,
    v_provider_status,
    p_provider_event_at,
    p_payload,
    v_payload_fingerprint,
    v_inbox.received_at
  );

  return pg_catalog.jsonb_build_object(
    'handled', true,
    'operation_id', v_operation_id,
    'step_kind', v_step_kind,
    'duplicate', false
  );
end;
$function$;

alter function public.observe_asaas_student_billing_schedule_event(
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
) owner to postgres;
revoke all on function public.observe_asaas_student_billing_schedule_event(
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
) from public, anon, authenticated;
grant execute on function public.observe_asaas_student_billing_schedule_event(
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
) to service_role;

comment on table public.asaas_student_billing_schedule_corrections is
  'Durable immutable snapshots and state for one existing-student Asaas schedule correction, including causal compensation and manual target-conflict containment.';
comment on table public.asaas_student_billing_schedule_correction_steps is
  'Six one-submit provider steps for the target route, target-conflict containment and explicit compensation route.';
comment on table public.asaas_student_billing_schedule_correction_events is
  'Idempotent subscription webhook observations correlated to an expected correction step; observations never advance operation state.';
comment on function public.observe_asaas_student_billing_schedule_event(
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  jsonb
) is
  'Service-only observer for expected subscription inactivation/update events. Uses database receipt time for accept_events_until and never advances critical operation state.';

do $postcheck$
begin
  if not exists (
    select 1
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_billing_schedule_corrections'::pg_catalog.regclass
       and relation.relrowsecurity
       and relation.relforcerowsecurity
  )
  or not exists (
    select 1
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_billing_schedule_correction_steps'::pg_catalog.regclass
       and relation.relrowsecurity
       and relation.relforcerowsecurity
  )
  or not exists (
    select 1
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_billing_schedule_correction_events'::pg_catalog.regclass
       and relation.relrowsecurity
       and relation.relforcerowsecurity
  )
  or pg_catalog.to_regprocedure(
    'private.student_billing_schedule_correction_active(text,uuid,text)'
  ) is null
  or pg_catalog.to_regprocedure(
    'private.asaas_billing_schedule_compensation_causal(uuid)'
  ) is null
  or pg_catalog.to_regprocedure(
    'private.asaas_billing_schedule_local_payment_exact(uuid,text,uuid,text,text,date,numeric,text,text)'
  ) is null
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.student_subscription_mutation_scope_valid(text,uuid,text,text)'::
        pg_catalog.regprocedure
    ),
    'student_billing_schedule_correction_active'
  ) = 0
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_student_lifecycle_against_subscription_mutation()'::
        pg_catalog.regprocedure
    ),
    'student_billing_schedule_correction_active'
  ) = 0
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_student_financial_operation_against_subscription_mutation()'::
        pg_catalog.regprocedure
    ),
    'student_billing_schedule_correction_active'
  ) = 0
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_student_creation_against_subscription_mutation()'::
        pg_catalog.regprocedure
    ),
    'student_billing_schedule_correction_active'
  ) = 0
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_asaas_billing_schedule_step()'::pg_catalog.regprocedure
    ),
    'accept_events_until'
  ) = 0
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_asaas_billing_schedule_operation()'::
        pg_catalog.regprocedure
    ),
    'asaas_billing_schedule_compensation_causal'
  ) = 0
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.validate_asaas_billing_schedule_operation()'::
        pg_catalog.regprocedure
    ),
    'asaas_billing_schedule_local_payment_exact'
  ) = 0
  or pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.asaas_billing_schedule_compensation_causal(uuid)'::
        pg_catalog.regprocedure
    ),
    'asaas_billing_schedule_local_payment_exact'
  ) = 0
  or pg_catalog.has_function_privilege(
    'anon',
    'private.student_billing_schedule_correction_active(text,uuid,text)',
    'EXECUTE'
  )
  or pg_catalog.has_function_privilege(
    'anon',
    'private.asaas_billing_schedule_compensation_causal(uuid)',
    'EXECUTE'
  )
  or pg_catalog.has_function_privilege(
    'anon',
    'private.asaas_billing_schedule_local_payment_exact(uuid,text,uuid,text,text,date,numeric,text,text)',
    'EXECUTE'
  )
  or pg_catalog.has_function_privilege(
    'anon',
    'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  or pg_catalog.has_function_privilege(
    'authenticated',
    'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  or not pg_catalog.has_function_privilege(
    'service_role',
    'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  then
    raise exception 'billing schedule correction security postcheck failed';
  end if;
end;
$postcheck$;

commit;
