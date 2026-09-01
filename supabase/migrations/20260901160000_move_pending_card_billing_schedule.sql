-- Reversible correction for a recurring CREDIT_CARD calendar whose first
-- generated payment was placed one month too late.  The strategy deliberately
-- keeps the existing payment id and never deletes a charge:
--
--   1. PUT the pending payment from old_due_date to target_due_date;
--   2. PUT the subscription nextDueDate to old_due_date and shorten endDate;
--   3. if step 2 is rejected, PUT the same payment back to old_due_date.
--
-- Provider calls remain an explicit operator concern.  These tables only
-- freeze the exact intent and enforce one-submit / compensation fences.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preconditions$
begin
  if pg_catalog.to_regclass(
       'public.asaas_student_billing_period_claims'
     ) is null
     or pg_catalog.to_regclass('public.student_payments') is null
     or pg_catalog.to_regclass('public.financial_transactions') is null
     or pg_catalog.to_regclass('private.tenant_integration_connections') is null
     or pg_catalog.to_regprocedure(
       'private.student_subscription_mutation_scope_valid(text,uuid,text,text)'
     ) is null
     or pg_catalog.to_regprocedure('extensions.digest(bytea,text)') is null
  then
    raise exception 'student_card_schedule_move_prerequisites_missing';
  end if;
  -- Do not silently replace the observer from the deprecated DELETE-based
  -- correction.  Main/production has neither legacy object.  The new table is
  -- the idempotent marker that permits the release pipeline's second pass.
  if pg_catalog.to_regclass('public.asaas_student_card_schedule_moves') is null
     and (
       pg_catalog.to_regclass(
         'public.asaas_student_billing_schedule_corrections'
       ) is not null
       or pg_catalog.to_regprocedure(
         'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)'
       ) is not null
     )
  then
    raise exception 'student_card_schedule_move_legacy_observer_conflict';
  end if;
end
$preconditions$;

create or replace function private.student_card_schedule_snapshot_has_secret(
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
  if p_value is null then return false; end if;
  if pg_catalog.jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in
      select item.key, item.value
        from pg_catalog.jsonb_each(p_value) as item(key, value)
    loop
      if pg_catalog.lower(v_key) ~
           '(secret|token|password|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key)'
         or private.student_card_schedule_snapshot_has_secret(v_child)
      then
        return true;
      end if;
    end loop;
  elsif pg_catalog.jsonb_typeof(p_value) = 'array' then
    for v_child in
      select item.value
        from pg_catalog.jsonb_array_elements(p_value) as item(value)
    loop
      if private.student_card_schedule_snapshot_has_secret(v_child) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$function$;

create or replace function private.student_card_schedule_local_payment_exact(
  p_local_payment_id uuid,
  p_tenant_id text,
  p_student_id uuid,
  p_payment_id text,
  p_customer_id text,
  p_due_date date,
  p_value numeric
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (
    select pg_catalog.count(*) = 1
      from public.student_payments as provider_binding
     where nullif(pg_catalog.btrim(coalesce(
             provider_binding.asaas_payment_id, ''
           )), '') = p_payment_id
        or nullif(pg_catalog.btrim(coalesce(
             provider_binding.asaas_id, ''
           )), '') = p_payment_id
  )
  and exists (
    select 1
      from public.student_payments as payment
     where payment.id = p_local_payment_id
       and payment.tenant_id = p_tenant_id
       and payment.student_id = p_student_id
       and nullif(pg_catalog.btrim(coalesce(
             payment.asaas_payment_id, ''
           )), '') = p_payment_id
       and (
         nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') is null
         or nullif(pg_catalog.btrim(payment.asaas_id), '') = p_payment_id
       )
       and nullif(pg_catalog.btrim(coalesce(
             payment.provider_customer_id, ''
           )), '') = p_customer_id
       and payment.due_date = p_due_date
       and payment.value = p_value
       and payment.amount_cents = pg_catalog.round(p_value * 100)::bigint
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             payment.billing_type, ''
           ))) = 'CREDIT_CARD'
       and (
         nullif(pg_catalog.btrim(coalesce(payment.payment_method, '')), '')
           is null
         or pg_catalog.upper(pg_catalog.btrim(payment.payment_method)) =
           'CREDIT_CARD'
       )
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             payment.payment_type, ''
           ))) = 'SUBSCRIPTION'
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             payment.status, ''
           ))) = 'PENDING'
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             payment.provider_status, ''
           ))) = 'PENDING'
       and payment.payment_date is null
       and payment.paid_at is null
       and payment.credited_at is null
       and coalesce(payment.refunded_amount, 0) = 0
       and coalesce(payment.ledger_entry_created, false) is false
       and not exists (
         select 1
           from public.financial_transactions as ledger_row
          where ledger_row.student_payment_id = payment.id
             or ledger_row.refund_student_payment_id = payment.id
       )
  );
$function$;

-- A historical SUBSCRIPTION_CREATED webhook may already be in TRIAGE for a
-- legacy subscription.  Freeze those exact event/issue ids at preflight; no
-- other TRIAGE item and no newly opened issue is allowed to enter the move.
create or replace function private.student_card_schedule_local_guard_baseline(
  p_tenant_id text,
  p_student_id uuid,
  p_local_payment_id uuid,
  p_payment_id text,
  p_subscription_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'subscriptionCreatedTriageEventIds', coalesce((
      select pg_catalog.jsonb_agg(
               inbox.provider_event_id order by inbox.provider_event_id
             )
        from public.asaas_webhook_inbox as inbox
       where inbox.status = 'TRIAGE'
         and inbox.event_name = 'SUBSCRIPTION_CREATED'
         and (
           inbox.provider_entity_id = p_subscription_id
           or inbox.payload #>> '{subscription,id}' = p_subscription_id
         )
    ), '[]'::jsonb),
    'subscriptionCreatedOpenIssueIds', coalesce((
      select pg_catalog.jsonb_agg(issue.id::text order by issue.id::text)
        from public.asaas_reconciliation_issues as issue
       where issue.resolved_at is null
         and issue.source = 'WEBHOOK'
         and issue.kind = 'WEBHOOK_TRIAGE'
         and issue.details ->> 'eventName' = 'SUBSCRIPTION_CREATED'
         and (
           issue.tenant_id = p_tenant_id
           or issue.tenant_id is null
         )
         and (
           issue.provider_entity_id = p_subscription_id
           or issue.details ->> 'entityId' = p_subscription_id
         )
    ), '[]'::jsonb)
  );
$function$;

create or replace function private.student_card_schedule_local_guard_clear(
  p_tenant_id text,
  p_student_id uuid,
  p_local_payment_id uuid,
  p_payment_id text,
  p_subscription_id text,
  p_baseline jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_baseline) = 'object'
  and pg_catalog.jsonb_typeof(
        p_baseline -> 'subscriptionCreatedTriageEventIds'
      ) = 'array'
  and pg_catalog.jsonb_typeof(
        p_baseline -> 'subscriptionCreatedOpenIssueIds'
      ) = 'array'
  and not exists (
    select 1
      from public.asaas_webhook_inbox as inbox
     where (
       inbox.provider_entity_id in (p_payment_id, p_subscription_id)
       or inbox.payload #>> '{payment,id}' = p_payment_id
       or inbox.payload #>> '{payment,subscription}' = p_subscription_id
       or inbox.payload #>> '{subscription,id}' = p_subscription_id
     )
       and (
         inbox.status in ('RECEIVED', 'PROCESSING', 'RETRY', 'DEAD_LETTER')
         or (
           inbox.status = 'TRIAGE'
           and not (
             inbox.event_name = 'SUBSCRIPTION_CREATED'
             and (
               inbox.provider_entity_id = p_subscription_id
               or inbox.payload #>> '{subscription,id}' = p_subscription_id
             )
             and exists (
               select 1
                 from pg_catalog.jsonb_array_elements_text(
                   p_baseline -> 'subscriptionCreatedTriageEventIds'
                 ) as allowed(event_id)
                where allowed.event_id = inbox.provider_event_id
             )
           )
         )
       )
  )
  and not exists (
    select 1
      from public.asaas_reconciliation_issues as issue
     where issue.resolved_at is null
       and (
         issue.tenant_id = p_tenant_id
         or issue.tenant_id is null
       )
       and (
         issue.provider_entity_id in (p_payment_id, p_subscription_id)
         or issue.local_entity_id in (
           p_student_id::text, p_local_payment_id::text
         )
         or issue.details ->> 'entityId' in (p_payment_id, p_subscription_id)
         or issue.details ->> 'paymentId' = p_payment_id
         or issue.details ->> 'subscriptionId' = p_subscription_id
       )
       and not exists (
         select 1
           from pg_catalog.jsonb_array_elements_text(
             p_baseline -> 'subscriptionCreatedOpenIssueIds'
           ) as allowed(issue_id)
          where allowed.issue_id = issue.id::text
       )
  )
  and not exists (
    select 1
      from public.reconciliation_issues as issue
     where issue.tenant_id = p_tenant_id
       and issue.student_payment_id = p_local_payment_id
       and coalesce(issue.resolved, false) is false
       and issue.resolved_at is null
  );
$function$;

create or replace function private.student_card_schedule_membership_exact(
  p_tenant_id text,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (
    select pg_catalog.count(*) = 1
      from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  )
  and exists (
    select 1
      from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = p_tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  );
$function$;

create or replace function private.student_card_schedule_offer_exact(
  p_tenant_id text,
  p_student_id uuid,
  p_offer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.offers as offer
     where offer.id = p_offer_id
       and offer.tenant_id = p_tenant_id
       and offer.kind = 'ENROLLMENT'
       and p_student_id in (offer.processing_by, offer.consumed_by)
       and (offer.processing_by is null or offer.processing_by = p_student_id)
       and (offer.consumed_by is null or offer.consumed_by = p_student_id)
  );
$function$;

create or replace function private.student_card_schedule_claims_exact(
  p_tenant_id text,
  p_student_id uuid,
  p_offer_id uuid,
  p_subscription_id text,
  p_old_due_date date,
  p_target_due_date date,
  p_target_claim_id uuid,
  p_target_claim_fingerprint text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (
    select pg_catalog.count(*) = 1
      from public.asaas_student_billing_period_claims as claim
     where claim.tenant_id = p_tenant_id
       and claim.student_id = p_student_id
       and claim.due_date = p_old_due_date
       and claim.source = 'SUBSCRIPTION'
       and claim.source_key = 'subscription:' || p_offer_id::text
       and claim.status = 'BOUND'
       and claim.provider_entity_id = p_subscription_id
  )
  and exists (
    select 1
      from public.asaas_student_billing_period_claims as claim
     where claim.id = p_target_claim_id
       and claim.tenant_id = p_tenant_id
       and claim.student_id = p_student_id
       and claim.due_date = p_target_due_date
       and claim.source = 'SUBSCRIPTION'
       and claim.source_key = 'subscription:' || p_offer_id::text
       and claim.request_fingerprint = p_target_claim_fingerprint
       and claim.status = 'BOUND'
       and claim.provider_entity_id = p_subscription_id
  );
$function$;

create or replace function private.student_card_schedule_move_fingerprint(
  p_operation_key text,
  p_tenant_id text,
  p_student_id uuid,
  p_offer_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_payment_id text,
  p_old_due_date date,
  p_target_due_date date,
  p_target_next_due_date date,
  p_original_next_due_date date,
  p_target_end_date date,
  p_original_end_date date,
  p_value numeric,
  p_max_payments integer
)
returns text
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'version', 2,
          'strategy', 'MOVE_PENDING_PAYMENT',
          'operationKey', pg_catalog.btrim(p_operation_key),
          'tenantId', pg_catalog.btrim(p_tenant_id),
          'studentId', p_student_id,
          'offerId', p_offer_id,
          'customerId', pg_catalog.btrim(p_customer_id),
          'subscriptionId', pg_catalog.btrim(p_subscription_id),
          'paymentId', pg_catalog.btrim(p_payment_id),
          'oldDueDate', p_old_due_date,
          'targetDueDate', p_target_due_date,
          'targetNextDueDate', p_target_next_due_date,
          'originalNextDueDate', p_original_next_due_date,
          'targetEndDate', p_target_end_date,
          'originalEndDate', p_original_end_date,
          'value', pg_catalog.round(p_value, 2),
          'maxPayments', p_max_payments
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$function$;

create table if not exists public.asaas_student_card_schedule_moves (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique check (
    operation_key ~ '^[a-z0-9][a-z0-9:_-]{7,199}$'
  ),
  tenant_id text references public.tenants(id) on delete set null,
  student_id uuid references public.profiles(id) on delete set null,
  offer_id uuid references public.offers(id) on delete set null,
  student_payment_id uuid
    references public.student_payments(id) on delete set null,
  target_billing_claim_id uuid
    references public.asaas_student_billing_period_claims(id)
    on delete set null,
  target_claim_fingerprint text not null check (
    target_claim_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  customer_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(customer_id)) between 1 and 200
  ),
  subscription_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(subscription_id)) between 1 and 200
  ),
  payment_id text not null check (
    pg_catalog.char_length(pg_catalog.btrim(payment_id)) between 1 and 200
  ),
  old_due_date date not null,
  target_due_date date not null,
  target_next_due_date date not null,
  original_next_due_date date not null,
  target_end_date date not null,
  original_end_date date not null,
  expected_value numeric not null check (expected_value > 0),
  expected_max_payments integer not null check (expected_max_payments = 12),
  original_subscription_snapshot jsonb not null,
  target_subscription_snapshot jsonb not null,
  original_payment_snapshot jsonb not null,
  target_payment_snapshot jsonb not null,
  original_payments_snapshot jsonb not null,
  integration_snapshot jsonb not null,
  status text not null default 'READY' check (status in (
    'READY',
    'MOVING_PAYMENT',
    'PAYMENT_MOVED',
    'UPDATING_TARGET_SCHEDULE',
    'TARGET_SCHEDULED',
    'AWAITING_LOCAL_RECONCILIATION',
    'COMPLETED',
    'COMPENSATING',
    'RESTORING_ORIGINAL_SCHEDULE',
    'ORIGINAL_SCHEDULE_RESTORED',
    'RESTORING_ORIGINAL_PAYMENT',
    'COMPENSATED',
    'UNKNOWN',
    'BLOCKED',
    'FAILED'
  )),
  accept_events_until timestamptz not null,
  last_error text,
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (target_due_date + interval '1 month' = old_due_date::timestamp),
  check (target_next_due_date = old_due_date),
  check (old_due_date + interval '1 month' = original_next_due_date::timestamp),
  check (target_end_date + interval '1 month' = original_end_date::timestamp),
  check (target_end_date >= target_due_date),
  check (accept_events_until > started_at),
  check (
    (status in ('COMPLETED', 'COMPENSATED', 'FAILED')) =
      (completed_at is not null)
  ),
  check (
    status in ('COMPLETED', 'COMPENSATED', 'FAILED')
    or (
      tenant_id is not null
      and student_id is not null
      and offer_id is not null
      and student_payment_id is not null
    )
  ),
  check (
    (status in ('COMPENSATED', 'FAILED') and target_billing_claim_id is null)
    or status = 'COMPLETED'
    or (
      status not in ('COMPLETED', 'COMPENSATED', 'FAILED')
      and target_billing_claim_id is not null
    )
  ),
  check (
    pg_catalog.jsonb_typeof(original_subscription_snapshot) = 'object'
    and original_subscription_snapshot ->> 'id' = subscription_id
    and original_subscription_snapshot ->> 'customer' = customer_id
    and original_subscription_snapshot ->> 'status' = 'ACTIVE'
    and original_subscription_snapshot ->> 'billingType' = 'CREDIT_CARD'
    and original_subscription_snapshot ->> 'cycle' = 'MONTHLY'
    and original_subscription_snapshot -> 'cardAttached' = 'true'::jsonb
    and (original_subscription_snapshot ->> 'value')::numeric = expected_value
    and (original_subscription_snapshot ->> 'maxPayments')::integer =
      expected_max_payments
    and original_subscription_snapshot ->> 'nextDueDate' =
      original_next_due_date::text
    and original_subscription_snapshot ->> 'endDate' = original_end_date::text
  ),
  check (
    target_subscription_snapshot =
      original_subscription_snapshot || pg_catalog.jsonb_build_object(
        'nextDueDate', target_next_due_date::text,
        'endDate', target_end_date::text
      )
  ),
  check (
    pg_catalog.jsonb_typeof(original_payment_snapshot) = 'object'
    and original_payment_snapshot ->> 'id' = payment_id
    and original_payment_snapshot ->> 'customer' = customer_id
    and original_payment_snapshot ->> 'subscription' = subscription_id
    and original_payment_snapshot ->> 'status' = 'PENDING'
    and original_payment_snapshot ->> 'billingType' = 'CREDIT_CARD'
    and (
      nullif(pg_catalog.btrim(coalesce(
        original_payment_snapshot ->> 'externalReference', ''
      )), '') is null
      or original_payment_snapshot ->> 'externalReference' =
        'enrollment:' || offer_id::text || ':subscription'
    )
    and (original_payment_snapshot ->> 'value')::numeric = expected_value
    and original_payment_snapshot ->> 'dueDate' = old_due_date::text
    and original_payment_snapshot ->> 'originalDueDate' = old_due_date::text
    and coalesce((original_payment_snapshot ->> 'deleted')::boolean, false)
      is false
    and original_payment_snapshot -> 'paymentDate' = 'null'::jsonb
    and original_payment_snapshot -> 'clientPaymentDate' = 'null'::jsonb
    and original_payment_snapshot -> 'confirmedDate' = 'null'::jsonb
    and original_payment_snapshot -> 'creditDate' = 'null'::jsonb
  ),
  check (
    target_payment_snapshot =
      pg_catalog.jsonb_set(
        original_payment_snapshot,
        '{dueDate}',
        pg_catalog.to_jsonb(target_due_date::text),
        false
      )
  ),
  check (
    pg_catalog.jsonb_typeof(original_payments_snapshot) = 'array'
    and pg_catalog.jsonb_array_length(original_payments_snapshot) = 1
    and original_payments_snapshot -> 0 = original_payment_snapshot
  ),
  check (
    pg_catalog.jsonb_typeof(integration_snapshot) = 'object'
    and integration_snapshot <> '{}'::jsonb
    and not private.student_card_schedule_snapshot_has_secret(
      integration_snapshot
    )
  )
);

create unique index if not exists asaas_student_card_schedule_moves_active_uidx
  on public.asaas_student_card_schedule_moves (tenant_id, subscription_id)
  where status in (
    'READY', 'MOVING_PAYMENT', 'PAYMENT_MOVED',
    'UPDATING_TARGET_SCHEDULE', 'TARGET_SCHEDULED',
    'AWAITING_LOCAL_RECONCILIATION', 'COMPENSATING',
    'RESTORING_ORIGINAL_SCHEDULE',
    'ORIGINAL_SCHEDULE_RESTORED', 'RESTORING_ORIGINAL_PAYMENT',
    'UNKNOWN', 'BLOCKED'
  );

create unique index if not exists asaas_student_card_schedule_moves_payment_active_uidx
  on public.asaas_student_card_schedule_moves (payment_id)
  where status not in ('FAILED', 'COMPENSATED');

create index if not exists asaas_student_card_schedule_moves_student_idx
  on public.asaas_student_card_schedule_moves (
    tenant_id, student_id, created_at desc
  );

create table if not exists public.asaas_student_card_schedule_move_steps (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null
    references public.asaas_student_card_schedule_moves(id) on delete cascade,
  step_kind text not null check (step_kind in (
    'MOVE_PAYMENT_TO_TARGET',
    'UPDATE_TARGET_SCHEDULE',
    'RESTORE_ORIGINAL_SCHEDULE',
    'RESTORE_ORIGINAL_PAYMENT'
  )),
  route_kind text not null check (route_kind in ('TARGET', 'COMPENSATION')),
  ordinal smallint not null check (ordinal in (10, 20, 30, 40)),
  status text not null default 'READY' check (status in (
    'READY', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'BLOCKED'
  )),
  request_fingerprint text not null check (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  expected_before jsonb not null check (
    pg_catalog.jsonb_typeof(expected_before) = 'object'
  ),
  desired_after jsonb not null check (
    pg_catalog.jsonb_typeof(desired_after) = 'object'
  ),
  provider_request jsonb not null check (
    pg_catalog.jsonb_typeof(provider_request) = 'object'
  ),
  provider_response jsonb,
  observed_state jsonb,
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  provider_http_status integer check (
    provider_http_status is null or provider_http_status between 100 and 599
  ),
  submitted_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique (operation_id, step_kind),
  unique (operation_id, ordinal),
  check (
    (step_kind = 'MOVE_PAYMENT_TO_TARGET'
      and route_kind = 'TARGET' and ordinal = 10)
    or (step_kind = 'UPDATE_TARGET_SCHEDULE'
      and route_kind = 'TARGET' and ordinal = 20)
    or (step_kind = 'RESTORE_ORIGINAL_SCHEDULE'
      and route_kind = 'COMPENSATION' and ordinal = 30)
    or (step_kind = 'RESTORE_ORIGINAL_PAYMENT'
      and route_kind = 'COMPENSATION' and ordinal = 40)
  ),
  check (
    (submit_attempt_count = 0 and submitted_at is null)
    or (submit_attempt_count = 1 and submitted_at is not null)
  ),
  check (
    (status in ('SUCCEEDED', 'FAILED', 'BLOCKED')) =
      (completed_at is not null)
  )
);

create index if not exists asaas_student_card_schedule_move_steps_attention_idx
  on public.asaas_student_card_schedule_move_steps (status, updated_at)
  where status in ('SUBMITTING', 'UNKNOWN', 'FAILED', 'BLOCKED');

alter table public.asaas_student_card_schedule_moves owner to postgres;
alter table public.asaas_student_card_schedule_move_steps owner to postgres;
alter table public.asaas_student_card_schedule_moves enable row level security;
alter table public.asaas_student_card_schedule_moves force row level security;
alter table public.asaas_student_card_schedule_move_steps enable row level security;
alter table public.asaas_student_card_schedule_move_steps force row level security;
revoke all on table public.asaas_student_card_schedule_moves
  from public, anon, authenticated, service_role;
revoke all on table public.asaas_student_card_schedule_move_steps
  from public, anon, authenticated, service_role;
grant select on table public.asaas_student_card_schedule_moves to service_role;
grant select on table public.asaas_student_card_schedule_move_steps to service_role;

-- Existing reciprocal lifecycle/financial triggers call this helper.  Extend
-- it so the safe move and the legacy correction ledger cannot overlap.
create or replace function private.student_card_schedule_move_active(
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
      from public.asaas_student_card_schedule_moves as operation
     where operation.tenant_id = p_tenant_id
       and operation.student_id = p_student_id
       and (p_subscription_id is null
         or operation.subscription_id = p_subscription_id)
       and operation.status in (
         'READY', 'MOVING_PAYMENT', 'PAYMENT_MOVED',
         'UPDATING_TARGET_SCHEDULE', 'TARGET_SCHEDULED',
         'AWAITING_LOCAL_RECONCILIATION', 'COMPENSATING',
         'RESTORING_ORIGINAL_SCHEDULE',
         'ORIGINAL_SCHEDULE_RESTORED', 'RESTORING_ORIGINAL_PAYMENT',
         'UNKNOWN', 'BLOCKED'
       )
  );
$function$;

-- Preserve the existing scope validator and add this long-lived operation to
-- it.  Renaming once avoids copying (and later drifting from) the canonical
-- lifecycle checks maintained by the subscription mutation subsystem.
do $wrap_scope$
begin
  if pg_catalog.to_regprocedure(
       'private.student_subscription_mutation_scope_before_card_move(text,uuid,text,text)'
     ) is null
  then
    alter function private.student_subscription_mutation_scope_valid(
      text, uuid, text, text
    ) rename to student_subscription_mutation_scope_before_card_move;
  end if;
end
$wrap_scope$;

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
  select private.student_subscription_mutation_scope_before_card_move(
    p_tenant_id,
    p_student_id,
    p_customer_id,
    p_subscription_id
  )
  and not private.student_card_schedule_move_active(
    p_tenant_id,
    p_student_id,
    p_subscription_id
  );
$function$;

create or replace function private.guard_against_student_card_schedule_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text;
  v_student_id uuid;
  v_subscription_id text;
  v_active boolean := false;
begin
  if tg_table_name = 'asaas_provider_creation_attempts' then
    v_tenant_id := new.tenant_id;
    v_student_id := new.lifecycle_student_id;
    v_active := v_student_id is not null
      and new.lifecycle_released_at is null
      and new.status in (
        'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED'
      );
  elsif tg_table_name = 'student_overdue_card_charge_claims' then
    v_tenant_id := new.tenant_id;
    v_student_id := new.student_id;
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
  else
    v_tenant_id := new.tenant_id;
    v_student_id := new.student_id;
    v_active := case tg_table_name
      when 'student_offboarding_operations' then new.status in (
        'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
        'UNKNOWN', 'BLOCKED'
      )
      when 'student_account_deletion_claims' then new.status in (
        'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
        'UNKNOWN', 'BLOCKED'
      )
      when 'student_billing_method_operations' then new.status in (
        'CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED'
      )
      when 'asaas_student_billing_period_claims' then new.status in (
        'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
      )
      when 'asaas_outbound_message_attempts' then new.status in (
        'CLAIMED', 'SUBMITTING', 'UNKNOWN'
      )
      when 'asaas_subscription_mutation_operations' then new.status in (
        'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
      )
      else false
    end;
    if tg_table_name = 'asaas_subscription_mutation_operations' then
      v_subscription_id := new.subscription_id;
    end if;
  end if;

  if not v_active or v_student_id is null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || v_tenant_id || ':' ||
        v_student_id::text,
      0
    )
  );
  if private.student_card_schedule_move_active(
       v_tenant_id,
       v_student_id,
       v_subscription_id
     )
  then
    raise exception 'student_card_schedule_move_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

do $install_reciprocal_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'student_offboarding_operations',
    'student_account_deletion_claims',
    'student_billing_method_operations',
    'asaas_student_billing_period_claims',
    'asaas_outbound_message_attempts',
    'student_overdue_card_charge_claims',
    'asaas_provider_creation_attempts',
    'asaas_subscription_mutation_operations'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists guard_against_student_card_schedule_move on public.%I',
      v_table
    );
    execute pg_catalog.format(
      'create trigger guard_against_student_card_schedule_move before insert or update on public.%I for each row execute function private.guard_against_student_card_schedule_move()',
      v_table
    );
  end loop;
end
$install_reciprocal_triggers$;

create or replace function private.guard_profile_against_student_card_schedule_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    if private.student_card_schedule_move_active(
         old.tenant_id,
         old.id,
         old.subscription_id
       )
    then
      raise exception 'student_card_schedule_move_in_flight'
        using errcode = '55000';
    end if;
    return old;
  end if;
  if (
       old.tenant_id is distinct from new.tenant_id
       or old.role is distinct from new.role
       or old.lifecycle_status is distinct from new.lifecycle_status
       or old.asaas_customer_id is distinct from new.asaas_customer_id
       or old.subscription_id is distinct from new.subscription_id
     )
     and private.student_card_schedule_move_active(
       old.tenant_id,
       old.id,
       old.subscription_id
     )
  then
    raise exception 'student_card_schedule_move_in_flight'
      using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists guard_profile_against_student_card_schedule_move
  on public.profiles;
create trigger guard_profile_against_student_card_schedule_move
before update or delete on public.profiles
for each row execute function
  private.guard_profile_against_student_card_schedule_move();

create or replace function private.guard_membership_against_student_card_schedule_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_student_id uuid := case when tg_op = 'INSERT' then null else old.user_id end;
  v_new_student_id uuid := case when tg_op = 'DELETE' then null else new.user_id end;
  v_lock_student_id uuid;
  v_operation record;
begin
  for v_lock_student_id in
    select candidate.student_id
      from (values (v_old_student_id), (v_new_student_id))
        as candidate(student_id)
     where candidate.student_id is not null
     group by candidate.student_id
     order by candidate.student_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-membership-user:' || v_lock_student_id::text,
        0
      )
    );
  end loop;
  for v_operation in
    select operation.tenant_id, operation.student_id,
           operation.subscription_id
      from public.asaas_student_card_schedule_moves as operation
     where operation.student_id in (
       v_old_student_id, v_new_student_id
     )
       and operation.status in (
         'READY', 'MOVING_PAYMENT', 'PAYMENT_MOVED',
         'UPDATING_TARGET_SCHEDULE', 'TARGET_SCHEDULED',
         'AWAITING_LOCAL_RECONCILIATION', 'COMPENSATING',
         'RESTORING_ORIGINAL_SCHEDULE',
         'ORIGINAL_SCHEDULE_RESTORED', 'RESTORING_ORIGINAL_PAYMENT',
         'UNKNOWN', 'BLOCKED'
       )
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || v_operation.tenant_id || ':' ||
          v_operation.student_id::text,
        0
      )
    );
    if private.student_card_schedule_move_active(
         v_operation.tenant_id,
         v_operation.student_id,
         v_operation.subscription_id
       )
    then
      raise exception 'student_card_schedule_move_in_flight'
        using errcode = '55000';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists guard_membership_against_student_card_schedule_move
  on public.tenant_memberships;
create trigger guard_membership_against_student_card_schedule_move
before insert or update or delete on public.tenant_memberships
for each row execute function
  private.guard_membership_against_student_card_schedule_move();

create or replace function private.guard_offer_against_student_card_schedule_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation record;
begin
  for v_operation in
    select operation.tenant_id, operation.student_id,
           operation.subscription_id
      from public.asaas_student_card_schedule_moves as operation
     where operation.offer_id = old.id
       and operation.status in (
         'READY', 'MOVING_PAYMENT', 'PAYMENT_MOVED',
         'UPDATING_TARGET_SCHEDULE', 'TARGET_SCHEDULED',
         'AWAITING_LOCAL_RECONCILIATION', 'COMPENSATING',
         'RESTORING_ORIGINAL_SCHEDULE',
         'ORIGINAL_SCHEDULE_RESTORED', 'RESTORING_ORIGINAL_PAYMENT',
         'UNKNOWN', 'BLOCKED'
       )
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || v_operation.tenant_id || ':' ||
          v_operation.student_id::text,
        0
      )
    );
    if private.student_card_schedule_move_active(
         v_operation.tenant_id,
         v_operation.student_id,
         v_operation.subscription_id
       )
    then
      raise exception 'student_card_schedule_move_in_flight'
        using errcode = '55000';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists guard_offer_against_student_card_schedule_move
  on public.offers;
create trigger guard_offer_against_student_card_schedule_move
before update or delete on public.offers
for each row execute function private.guard_offer_against_student_card_schedule_move();

create or replace function private.guard_claim_against_student_card_schedule_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation record;
  v_old_claim_id uuid := case when tg_op = 'INSERT' then null else old.id end;
  v_new_claim_id uuid := case when tg_op = 'DELETE' then null else new.id end;
  v_old_tenant_id text := case when tg_op = 'INSERT' then null else old.tenant_id end;
  v_new_tenant_id text := case when tg_op = 'DELETE' then null else new.tenant_id end;
  v_old_student_id uuid := case when tg_op = 'INSERT' then null else old.student_id end;
  v_new_student_id uuid := case when tg_op = 'DELETE' then null else new.student_id end;
  v_old_due_date date := case when tg_op = 'INSERT' then null else old.due_date end;
  v_new_due_date date := case when tg_op = 'DELETE' then null else new.due_date end;
  v_lock_key text;
begin
  for v_lock_key in
    select candidate.lock_key
      from (values
        (case when v_old_tenant_id is null or v_old_student_id is null
                    or v_old_due_date is null then null else
          'student-billing-period-month:' || v_old_tenant_id || ':' ||
            v_old_student_id::text || ':' ||
            pg_catalog.date_trunc('month', v_old_due_date)::date::text end),
        (case when v_new_tenant_id is null or v_new_student_id is null
                    or v_new_due_date is null then null else
          'student-billing-period-month:' || v_new_tenant_id || ':' ||
            v_new_student_id::text || ':' ||
            pg_catalog.date_trunc('month', v_new_due_date)::date::text end)
      ) as candidate(lock_key)
     where candidate.lock_key is not null
     group by candidate.lock_key
     order by candidate.lock_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_lock_key, 0)
    );
  end loop;
  for v_operation in
    select operation.tenant_id, operation.student_id,
           operation.subscription_id
      from public.asaas_student_card_schedule_moves as operation
     where operation.status in (
       'READY', 'MOVING_PAYMENT', 'PAYMENT_MOVED',
       'UPDATING_TARGET_SCHEDULE', 'TARGET_SCHEDULED',
       'AWAITING_LOCAL_RECONCILIATION', 'COMPENSATING',
       'RESTORING_ORIGINAL_SCHEDULE',
       'ORIGINAL_SCHEDULE_RESTORED', 'RESTORING_ORIGINAL_PAYMENT',
       'UNKNOWN', 'BLOCKED'
     )
       and (
         operation.target_billing_claim_id in (
           v_old_claim_id, v_new_claim_id
         )
         or (
           v_old_tenant_id = operation.tenant_id
           and v_old_student_id = operation.student_id
           and pg_catalog.date_trunc('month', v_old_due_date) in (
             pg_catalog.date_trunc('month', operation.old_due_date),
             pg_catalog.date_trunc('month', operation.target_due_date)
           )
         )
         or (
           v_new_tenant_id = operation.tenant_id
           and v_new_student_id = operation.student_id
           and pg_catalog.date_trunc('month', v_new_due_date) in (
             pg_catalog.date_trunc('month', operation.old_due_date),
             pg_catalog.date_trunc('month', operation.target_due_date)
           )
         )
       )
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || v_operation.tenant_id || ':' ||
          v_operation.student_id::text,
        0
      )
    );
    if private.student_card_schedule_move_active(
         v_operation.tenant_id,
         v_operation.student_id,
         v_operation.subscription_id
       )
    then
      raise exception 'student_card_schedule_move_in_flight'
        using errcode = '55000';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists guard_claim_against_student_card_schedule_move
  on public.asaas_student_billing_period_claims;
create trigger guard_claim_against_student_card_schedule_move
before insert or update or delete on public.asaas_student_billing_period_claims
for each row execute function private.guard_claim_against_student_card_schedule_move();

-- Subscription-only webhooks are acknowledged only when they match a
-- submitted step. They never advance the ledger: completion still requires
-- the operator's authoritative GET.
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
  v_inbox public.asaas_webhook_inbox%rowtype;
  v_operation_id uuid;
  v_step_kind text;
  v_match_count integer;
begin
  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_event_name, ''))) <>
       'SUBSCRIPTION_UPDATED'
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
          p_provider_status, ''
        ))) <> 'ACTIVE'
     or pg_catalog.jsonb_typeof(p_payload -> 'subscription') <> 'object'
     or p_payload ->> 'id' is distinct from p_provider_event_id
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
          p_payload ->> 'event', ''
        ))) <> 'SUBSCRIPTION_UPDATED'
     or p_payload #>> '{subscription,id}' is distinct from p_subscription_id
     or p_payload #>> '{subscription,customer}' is distinct from p_customer_id
  then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'student_card_schedule_move_event_mismatch'
    );
  end if;

  select inbox.* into v_inbox
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_event_id = p_provider_event_id;
  if not found
     or v_inbox.event_name <> 'SUBSCRIPTION_UPDATED'
     or v_inbox.provider_entity_id <> p_subscription_id
     or v_inbox.payload is distinct from p_payload
     or v_inbox.status <> 'PROCESSING'
     or v_inbox.lease_owner is null
     or v_inbox.lease_expires_at is null
     or v_inbox.lease_expires_at <= pg_catalog.clock_timestamp()
  then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', 'student_card_schedule_move_inbox_not_claimed'
    );
  end if;

  select pg_catalog.count(*),
         (pg_catalog.array_agg(operation.id order by step.ordinal desc))[1],
         (pg_catalog.array_agg(step.step_kind order by step.ordinal desc))[1]
    into v_match_count, v_operation_id, v_step_kind
    from public.asaas_student_card_schedule_moves as operation
    join public.asaas_student_card_schedule_move_steps as step
      on step.operation_id = operation.id
   where operation.subscription_id = p_subscription_id
     and operation.customer_id = p_customer_id
     and operation.status <> 'FAILED'
     and step.step_kind in (
       'UPDATE_TARGET_SCHEDULE', 'RESTORE_ORIGINAL_SCHEDULE'
     )
     and step.status in ('SUBMITTING', 'UNKNOWN', 'SUCCEEDED')
     and step.submit_attempt_count = 1
     and step.submitted_at is not null
     and v_inbox.received_at >= step.submitted_at
     and v_inbox.received_at <= operation.accept_events_until
     and (p_payload -> 'subscription') @>
       pg_catalog.jsonb_build_object(
         'id', step.desired_after -> 'id',
         'customer', step.desired_after -> 'customer',
         'status', step.desired_after -> 'status',
         'value', step.desired_after -> 'value',
         'cycle', step.desired_after -> 'cycle',
         'billingType', step.desired_after -> 'billingType',
         'externalReference', step.desired_after -> 'externalReference'
       );

  if v_match_count <> 1 then
    return pg_catalog.jsonb_build_object(
      'handled', false,
      'reason', case when v_match_count = 0
        then 'no_expected_student_card_schedule_move_event'
        else 'ambiguous_student_card_schedule_move_event'
      end
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'handled', true,
    'operation_id', v_operation_id,
    'step_kind', v_step_kind,
    'duplicate', false,
    'authoritative_get_required', true
  );
end;
$function$;

create or replace function private.guard_student_card_schedule_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.operation_key is distinct from new.operation_key
     or (
       old.tenant_id is distinct from new.tenant_id
       and not (
         old.tenant_id is not null and new.tenant_id is null
         and old.status in ('COMPLETED', 'COMPENSATED', 'FAILED')
         and new.status = old.status
       )
     )
     or (
       old.student_id is distinct from new.student_id
       and not (
         old.student_id is not null and new.student_id is null
         and old.status in ('COMPLETED', 'COMPENSATED', 'FAILED')
         and new.status = old.status
       )
     )
     or (
       old.offer_id is distinct from new.offer_id
       and not (
         old.offer_id is not null and new.offer_id is null
         and old.status in ('COMPLETED', 'COMPENSATED', 'FAILED')
         and new.status = old.status
       )
     )
     or (
       old.student_payment_id is distinct from new.student_payment_id
       and not (
         old.student_payment_id is not null
         and new.student_payment_id is null
         and old.status in ('COMPLETED', 'COMPENSATED', 'FAILED')
         and new.status = old.status
       )
     )
     or (
       old.target_billing_claim_id is distinct from new.target_billing_claim_id
       and not (
         old.target_billing_claim_id is not null
         and new.target_billing_claim_id is null
         and new.status in ('COMPLETED', 'FAILED', 'COMPENSATED')
       )
     )
     or old.target_claim_fingerprint is distinct from
          new.target_claim_fingerprint
     or old.customer_id is distinct from new.customer_id
     or old.subscription_id is distinct from new.subscription_id
     or old.payment_id is distinct from new.payment_id
     or old.old_due_date is distinct from new.old_due_date
     or old.target_due_date is distinct from new.target_due_date
     or old.target_next_due_date is distinct from new.target_next_due_date
     or old.original_next_due_date is distinct from new.original_next_due_date
     or old.target_end_date is distinct from new.target_end_date
     or old.original_end_date is distinct from new.original_end_date
     or old.expected_value is distinct from new.expected_value
     or old.expected_max_payments is distinct from new.expected_max_payments
     or old.original_subscription_snapshot is distinct from
          new.original_subscription_snapshot
     or old.target_subscription_snapshot is distinct from
          new.target_subscription_snapshot
     or old.original_payment_snapshot is distinct from
          new.original_payment_snapshot
     or old.target_payment_snapshot is distinct from new.target_payment_snapshot
     or old.original_payments_snapshot is distinct from
          new.original_payments_snapshot
     or old.integration_snapshot is distinct from new.integration_snapshot
     or old.accept_events_until is distinct from new.accept_events_until
     or old.started_at is distinct from new.started_at
     or old.created_at is distinct from new.created_at
  then
    raise exception 'student_card_schedule_move_snapshot_immutable'
      using errcode = '55000';
  end if;

  if old.status in ('COMPLETED', 'COMPENSATED', 'FAILED')
     and (
       new.status is distinct from old.status
       or new.last_error is distinct from old.last_error
     )
  then
    raise exception 'student_card_schedule_move_terminal'
      using errcode = '55000';
  end if;
  if old.completed_at is not null
     and new.completed_at is distinct from old.completed_at
  then
    raise exception 'student_card_schedule_move_completion_immutable'
      using errcode = '55000';
  end if;

  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists guard_student_card_schedule_move
  on public.asaas_student_card_schedule_moves;
create trigger guard_student_card_schedule_move
before update on public.asaas_student_card_schedule_moves
for each row execute function private.guard_student_card_schedule_move();

create or replace function private.guard_student_card_schedule_move_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
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
    raise exception 'student_card_schedule_move_step_snapshot_immutable'
      using errcode = '55000';
  end if;
  if new.submit_attempt_count < old.submit_attempt_count
     or new.submit_attempt_count > old.submit_attempt_count + 1
     or (old.submit_attempt_count = 1 and new.submit_attempt_count <> 1)
     or (old.submitted_at is not null
       and new.submitted_at is distinct from old.submitted_at)
     or (old.completed_at is not null
       and new.completed_at is distinct from old.completed_at)
  then
    raise exception 'student_card_schedule_move_step_submit_immutable'
      using errcode = '55000';
  end if;
  if new.status = 'SUBMITTING' and old.status <> 'SUBMITTING'
     and (old.status <> 'READY' or old.submit_attempt_count <> 0
       or new.submit_attempt_count <> 1 or new.submitted_at is null)
  then
    raise exception 'student_card_schedule_move_step_resubmit_forbidden'
      using errcode = '55000';
  end if;
  if old.status in ('SUCCEEDED', 'FAILED', 'BLOCKED')
     and (
       new.status is distinct from old.status
       or new.provider_response is distinct from old.provider_response
       or new.observed_state is distinct from old.observed_state
       or new.provider_http_status is distinct from old.provider_http_status
       or new.submit_attempt_count is distinct from old.submit_attempt_count
       or new.submitted_at is distinct from old.submitted_at
       or new.completed_at is distinct from old.completed_at
       or new.last_error is distinct from old.last_error
     )
  then
    raise exception 'student_card_schedule_move_step_terminal'
      using errcode = '55000';
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$function$;

drop trigger if exists guard_student_card_schedule_move_step
  on public.asaas_student_card_schedule_move_steps;
create trigger guard_student_card_schedule_move_step
before update on public.asaas_student_card_schedule_move_steps
for each row execute function private.guard_student_card_schedule_move_step();

alter function private.student_card_schedule_move_fingerprint(
  text,text,uuid,uuid,text,text,text,date,date,date,date,date,date,numeric,integer
) owner to postgres;
alter function private.student_card_schedule_snapshot_has_secret(jsonb)
  owner to postgres;
alter function private.student_card_schedule_local_payment_exact(
  uuid,text,uuid,text,text,date,numeric
) owner to postgres;
alter function private.student_card_schedule_local_guard_baseline(
  text,uuid,uuid,text,text
) owner to postgres;
alter function private.student_card_schedule_local_guard_clear(
  text,uuid,uuid,text,text,jsonb
) owner to postgres;
alter function private.student_card_schedule_membership_exact(text,uuid)
  owner to postgres;
alter function private.student_card_schedule_offer_exact(text,uuid,uuid)
  owner to postgres;
alter function private.student_card_schedule_claims_exact(
  text,uuid,uuid,text,date,date,uuid,text
) owner to postgres;
alter function private.student_card_schedule_move_active(text,uuid,text)
  owner to postgres;
alter function private.student_subscription_mutation_scope_before_card_move(
  text,uuid,text,text
) owner to postgres;
alter function private.student_subscription_mutation_scope_valid(
  text,uuid,text,text
) owner to postgres;
alter function private.guard_against_student_card_schedule_move()
  owner to postgres;
alter function private.guard_profile_against_student_card_schedule_move()
  owner to postgres;
alter function private.guard_membership_against_student_card_schedule_move()
  owner to postgres;
alter function private.guard_offer_against_student_card_schedule_move()
  owner to postgres;
alter function private.guard_claim_against_student_card_schedule_move()
  owner to postgres;
alter function private.guard_student_card_schedule_move() owner to postgres;
alter function private.guard_student_card_schedule_move_step() owner to postgres;
alter function public.observe_asaas_student_billing_schedule_event(
  text,text,text,text,text,timestamptz,jsonb
) owner to postgres;
revoke all on function private.student_card_schedule_move_fingerprint(
  text,text,uuid,uuid,text,text,text,date,date,date,date,date,date,numeric,integer
) from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_snapshot_has_secret(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_local_payment_exact(
  uuid,text,uuid,text,text,date,numeric
) from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_local_guard_baseline(
  text,uuid,uuid,text,text
) from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_local_guard_clear(
  text,uuid,uuid,text,text,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_membership_exact(text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_offer_exact(text,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_claims_exact(
  text,uuid,uuid,text,date,date,uuid,text
) from public, anon, authenticated, service_role;
revoke all on function private.student_card_schedule_move_active(
  text,uuid,text
) from public, anon, authenticated, service_role;
revoke all on function private.student_subscription_mutation_scope_before_card_move(
  text,uuid,text,text
) from public, anon, authenticated, service_role;
revoke all on function private.student_subscription_mutation_scope_valid(
  text,uuid,text,text
) from public, anon, authenticated, service_role;
revoke all on function private.guard_against_student_card_schedule_move()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_profile_against_student_card_schedule_move()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_membership_against_student_card_schedule_move()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_offer_against_student_card_schedule_move()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_claim_against_student_card_schedule_move()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_student_card_schedule_move()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_student_card_schedule_move_step()
  from public, anon, authenticated, service_role;
revoke all on function public.observe_asaas_student_billing_schedule_event(
  text,text,text,text,text,timestamptz,jsonb
) from public, anon, authenticated;
grant execute on function public.observe_asaas_student_billing_schedule_event(
  text,text,text,text,text,timestamptz,jsonb
) to service_role;

commit;
