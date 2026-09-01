begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temporary table operator_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'offer_id'::uuid as offer_id,
  :'customer_id'::text as customer_id,
  :'subscription_id'::text as subscription_id,
  :'old_payment_id'::text as old_payment_id,
  :'old_student_payment_id'::uuid as old_student_payment_id,
  :'old_due_date'::date as old_due_date,
  :'target_due_date'::date as target_due_date,
  :'target_end_date'::date as target_end_date,
  :'original_next_due_date'::date as original_next_due_date,
  :'original_end_date'::date as original_end_date,
  :'target_claim_fingerprint'::text as target_claim_fingerprint,
  :'accept_events_until'::timestamptz as accept_events_until,
  :'original_subscription_snapshot'::jsonb as original_subscription_snapshot,
  :'original_payment_snapshot'::jsonb as original_payment_snapshot,
  :'target_subscription_snapshot'::jsonb as target_subscription_snapshot,
  :'integration_snapshot'::jsonb as integration_snapshot,
  :'steps_json'::jsonb as steps_json;

do $prepare_validation$
declare
  args operator_args%rowtype;
begin
  select * into strict args from operator_args;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || args.tenant_id || ':' ||
        args.student_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'asaas-subscription-mutation:' || args.tenant_id || ':' ||
        args.subscription_id,
      0
    )
  );

  -- The read-only preflight is a separate transaction. Re-evaluate the
  -- canonical lifecycle fence while both advisory locks are held so no
  -- competing claim can slip between PREPARE's validation and INSERTs.
  if not private.student_subscription_mutation_scope_valid(
       args.tenant_id,
       args.student_id,
       args.customer_id,
       args.subscription_id
     )
     or exists (
       select 1
       from public.asaas_subscription_mutation_operations as operation
       where operation.tenant_id = args.tenant_id
         and operation.student_id = args.student_id
         and operation.status in (
           'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
         )
     )
  then
    raise exception 'billing_schedule_prepare_lifecycle_fence_active';
  end if;

  if args.target_due_date + interval '1 month' <> args.old_due_date::timestamp
     or args.old_due_date + interval '1 month' <>
          args.original_next_due_date::timestamp
     or args.target_end_date + interval '1 month' <>
          args.original_end_date::timestamp
     or args.accept_events_until <= pg_catalog.clock_timestamp()
     or args.target_claim_fingerprint !~ '^[a-f0-9]{64}$'
     or pg_catalog.jsonb_typeof(args.steps_json) <> 'array'
     or pg_catalog.jsonb_array_length(args.steps_json) <> 6
     or args.original_subscription_snapshot ->> 'id' <>
          args.subscription_id
     or args.original_subscription_snapshot ->> 'customer' <>
          args.customer_id
     or args.original_subscription_snapshot ->> 'status' <> 'ACTIVE'
     or args.original_subscription_snapshot ->> 'nextDueDate' <>
          args.original_next_due_date::text
     or args.original_subscription_snapshot ->> 'endDate' <>
          args.original_end_date::text
     or args.original_payment_snapshot ->> 'id' <> args.old_payment_id
     or args.original_payment_snapshot ->> 'subscription' <>
          args.subscription_id
     or args.original_payment_snapshot ->> 'customer' <> args.customer_id
     or args.original_payment_snapshot ->> 'status' <> 'PENDING'
     or args.original_payment_snapshot ->> 'dueDate' <>
          args.old_due_date::text
     or coalesce((args.original_payment_snapshot ->> 'deleted')::boolean, false)
     or args.target_subscription_snapshot ->> 'nextDueDate' <>
          args.target_due_date::text
     or args.target_subscription_snapshot ->> 'endDate' <>
          args.target_end_date::text
     or args.integration_snapshot = '{}'::jsonb
     or not exists (
       select 1
       from private.tenant_integration_connections as connection
       where connection.id::text =
             args.integration_snapshot ->> 'integrationId'
         and connection.tenant_id = args.tenant_id
         and connection.provider = 'asaas'
         and connection.version::text =
             args.integration_snapshot ->> 'version'
         and connection.mode = args.integration_snapshot ->> 'mode'
         and connection.mode <> 'DISABLED'
         and connection.status in ('configured', 'healthy')
     )
  then
    raise exception 'billing_schedule_prepare_snapshot_invalid';
  end if;

  if exists (
       select 1
       from jsonb_to_recordset(args.steps_json) as step(
         "stepKind" text,
         "routeKind" text,
         ordinal smallint,
         status text,
         "requestFingerprint" text,
         "expectedBefore" jsonb,
         "desiredAfter" jsonb,
         "providerRequest" jsonb
       )
       where step.status <> 'READY'
          or step."requestFingerprint" !~ '^[a-f0-9]{64}$'
          or pg_catalog.jsonb_typeof(step."expectedBefore") <> 'object'
          or pg_catalog.jsonb_typeof(step."desiredAfter") <> 'object'
          or pg_catalog.jsonb_typeof(step."providerRequest") <> 'object'
          or not (
            (step."stepKind" = 'INACTIVATE_SUBSCRIPTION'
              and step."routeKind" = 'TARGET' and step.ordinal = 10)
            or (step."stepKind" = 'DELETE_OLD_PAYMENT'
              and step."routeKind" = 'TARGET' and step.ordinal = 20)
            or (step."stepKind" = 'ACTIVATE_TARGET_SCHEDULE'
              and step."routeKind" = 'TARGET' and step.ordinal = 30)
            or (step."stepKind" = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
              and step."routeKind" = 'COMPENSATION' and step.ordinal = 35)
            or (step."stepKind" = 'ACTIVATE_ORIGINAL_SCHEDULE'
              and step."routeKind" = 'COMPENSATION' and step.ordinal = 40)
            or (step."stepKind" = 'RESTORE_OLD_PAYMENT'
              and step."routeKind" = 'COMPENSATION' and step.ordinal = 50)
          )
     )
  then
    raise exception 'billing_schedule_prepare_steps_invalid';
  end if;

  if not exists (
       select 1
       from public.profiles as profile
       where profile.id = args.student_id
         and profile.tenant_id = args.tenant_id
         and profile.role = 'STUDENT'
         and pg_catalog.lower(pg_catalog.btrim(coalesce(
           profile.lifecycle_status, ''
         ))) = 'active'
         and coalesce(profile.is_test_account, false) is false
         and nullif(pg_catalog.btrim(profile.asaas_customer_id), '') =
           args.customer_id
         and nullif(pg_catalog.btrim(profile.subscription_id), '') =
           args.subscription_id
     )
     or not exists (
       select 1
       from public.offers as offer
       where offer.id = args.offer_id
         and offer.tenant_id = args.tenant_id
         and offer.kind = 'ENROLLMENT'
         and (
           offer.processing_by = args.student_id
           or offer.consumed_by = args.student_id
         )
         and (
           offer.processing_by is null
           or offer.processing_by = args.student_id
         )
         and (
           offer.consumed_by is null
           or offer.consumed_by = args.student_id
         )
     )
     or not exists (
       select 1
       from public.student_payments as payment
       where payment.id = args.old_student_payment_id
         and payment.tenant_id = args.tenant_id
         and payment.student_id = args.student_id
         and nullif(pg_catalog.btrim(payment.asaas_payment_id), '') =
           args.old_payment_id
         and (
           nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') is null
           or nullif(pg_catalog.btrim(payment.asaas_id), '') =
             args.old_payment_id
         )
         and nullif(pg_catalog.btrim(payment.provider_customer_id), '') =
           args.customer_id
         and payment.due_date = args.old_due_date
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
           payment.status, ''
         ))) = 'PENDING'
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
           payment.provider_status, ''
         ))) = 'PENDING'
         and pg_catalog.round(payment.value, 2) = pg_catalog.round(
           (args.original_payment_snapshot ->> 'value')::numeric,
           2
         )
         and payment.amount_cents = pg_catalog.round(
           (args.original_payment_snapshot ->> 'value')::numeric * 100
         )::integer
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
           payment.billing_type, ''
         ))) = args.original_payment_snapshot ->> 'billingType'
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
           payment.payment_method, ''
         ))) = args.original_payment_snapshot ->> 'billingType'
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
           payment.payment_type, ''
         ))) = 'SUBSCRIPTION'
         and payment.payment_date is null
         and payment.paid_at is null
         and payment.credited_at is null
         and coalesce(payment.refunded_amount, 0) = 0
         and coalesce(payment.ledger_entry_created, false) is false
     )
     or (
       select pg_catalog.count(*)
       from public.student_payments as payment
       where nullif(pg_catalog.btrim(coalesce(
               payment.asaas_payment_id,
               ''
             )), '') = args.old_payment_id
          or nullif(pg_catalog.btrim(coalesce(
               payment.asaas_id,
               ''
             )), '') = args.old_payment_id
     ) <> 1
     or exists (
       select 1
       from public.financial_transactions as ledger_row
       where ledger_row.student_payment_id = args.old_student_payment_id
          or ledger_row.refund_student_payment_id = args.old_student_payment_id
     )
     or not exists (
       select 1
       from public.asaas_student_billing_period_claims as claim
       where claim.tenant_id = args.tenant_id
         and claim.student_id = args.student_id
         and claim.due_date = args.old_due_date
         and claim.source = 'SUBSCRIPTION'
         and claim.source_key = 'subscription:' || args.offer_id::text
         and claim.status = 'BOUND'
         and claim.provider_entity_id = args.subscription_id
     )
  then
    raise exception 'billing_schedule_prepare_scope_changed';
  end if;

  if exists (
       select 1
       from public.asaas_student_billing_schedule_corrections as operation
       where operation.operation_key = args.operation_key
          or (
            operation.tenant_id = args.tenant_id
            and operation.subscription_id = args.subscription_id
            and operation.status not in ('COMPLETED', 'COMPENSATED', 'FAILED')
          )
     )
     or exists (
       select 1
       from public.asaas_student_billing_period_claims as claim
       where claim.tenant_id = args.tenant_id
         and claim.student_id = args.student_id
         and date_trunc('month', claim.due_date) =
           date_trunc('month', args.target_due_date)
     )
     or exists (
       select 1
       from public.student_payments as payment
       where payment.tenant_id = args.tenant_id
         and payment.student_id = args.student_id
         and date_trunc('month', payment.due_date) =
           date_trunc('month', args.target_due_date)
     )
  then
    raise exception 'billing_schedule_prepare_conflict';
  end if;
end
$prepare_validation$;

with new_claim as (
  insert into public.asaas_student_billing_period_claims (
    tenant_id,
    student_id,
    due_date,
    source,
    source_key,
    request_fingerprint,
    status,
    claim_token,
    lease_expires_at,
    submit_attempt_count,
    provider_entity_id,
    last_error
  )
  select
    args.tenant_id,
    args.student_id,
    args.target_due_date,
    'SUBSCRIPTION',
    'subscription:' || args.offer_id::text,
    args.target_claim_fingerprint,
    'BOUND',
    gen_random_uuid(),
    pg_catalog.clock_timestamp(),
    1,
    args.subscription_id,
    null
  from operator_args as args
  returning id
), new_operation as (
  insert into public.asaas_student_billing_schedule_corrections (
    operation_key,
    tenant_id,
    student_id,
    offer_id,
    old_student_payment_id,
    target_billing_claim_id,
    customer_id,
    subscription_id,
    old_payment_id,
    target_due_date,
    target_end_date,
    original_subscription_snapshot,
    original_payment_snapshot,
    target_subscription_snapshot,
    integration_snapshot,
    status,
    accept_events_until
  )
  select
    args.operation_key,
    args.tenant_id,
    args.student_id,
    args.offer_id,
    args.old_student_payment_id,
    new_claim.id,
    args.customer_id,
    args.subscription_id,
    args.old_payment_id,
    args.target_due_date,
    args.target_end_date,
    args.original_subscription_snapshot,
    args.original_payment_snapshot,
    args.target_subscription_snapshot,
    args.integration_snapshot,
    'READY',
    args.accept_events_until
  from operator_args as args
  cross join new_claim
  returning id
)
insert into public.asaas_student_billing_schedule_correction_steps (
  operation_id,
  step_kind,
  route_kind,
  ordinal,
  status,
  request_fingerprint,
  expected_before,
  desired_after,
  provider_request
)
select
  new_operation.id,
  step."stepKind",
  step."routeKind",
  step.ordinal,
  step.status,
  step."requestFingerprint",
  step."expectedBefore",
  step."desiredAfter",
  step."providerRequest"
from operator_args as args
cross join new_operation
cross join lateral jsonb_to_recordset(args.steps_json) as step(
  "stepKind" text,
  "routeKind" text,
  ordinal smallint,
  status text,
  "requestFingerprint" text,
  "expectedBefore" jsonb,
  "desiredAfter" jsonb,
  "providerRequest" jsonb
);

select pg_catalog.jsonb_build_object(
  'ok', true,
  'status', operation.status,
  'stepCount', (
    select pg_catalog.count(*)
    from public.asaas_student_billing_schedule_correction_steps as step
    where step.operation_id = operation.id
  )
)
from public.asaas_student_billing_schedule_corrections as operation
join operator_args as args on args.operation_key = operation.operation_key;

commit;
