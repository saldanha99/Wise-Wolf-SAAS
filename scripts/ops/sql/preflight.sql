begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';
set transaction read only;

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
  :'expected_value'::numeric as expected_value,
  :'accept_events_until'::timestamptz as accept_events_until;

do $preflight$
declare
  args operator_args%rowtype;
begin
  select * into strict args from operator_args;
  if args.target_due_date + interval '1 month' <> args.old_due_date::timestamp
     or args.old_due_date + interval '1 month' <>
          args.original_next_due_date::timestamp
     or args.target_end_date + interval '1 month' <>
          args.original_end_date::timestamp
     or extract(day from args.target_due_date) <>
          extract(day from args.old_due_date)
     or args.accept_events_until <= pg_catalog.clock_timestamp()
  then
    raise exception 'billing_schedule_calendar_parameters_invalid';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'student-billing-lifecycle:' || args.tenant_id || ':' ||
           args.student_id::text,
         0
       )
     )
     or not pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'asaas-subscription-mutation:' || args.tenant_id || ':' ||
           args.subscription_id,
         0
       )
     )
  then
    raise exception 'billing_schedule_concurrent_operation_in_progress';
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
  ) then
    raise exception 'billing_schedule_student_scope_mismatch';
  end if;

  if (select pg_catalog.count(*)
      from public.tenant_memberships as membership
      where membership.user_id = args.student_id) <> 1
     or not exists (
       select 1
       from public.tenant_memberships as membership
       where membership.user_id = args.student_id
         and membership.tenant_id = args.tenant_id
         and membership.role = 'STUDENT'
         and membership.status = 'ACTIVE'
     )
  then
    raise exception 'billing_schedule_membership_scope_mismatch';
  end if;

  if not exists (
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
  ) then
    raise exception 'billing_schedule_offer_scope_mismatch';
  end if;

  if not exists (
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
      and pg_catalog.upper(pg_catalog.btrim(coalesce(payment.status, ''))) =
        'PENDING'
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
        payment.provider_status, ''
      ))) = 'PENDING'
      and pg_catalog.round(payment.value, 2) =
        pg_catalog.round(args.expected_value, 2)
      and payment.amount_cents =
        pg_catalog.round(args.expected_value * 100)::integer
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
        payment.billing_type, ''
      ))) = :'expected_billing_type'
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
        payment.payment_method, ''
      ))) = :'expected_billing_type'
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
        payment.payment_type, ''
      ))) = 'SUBSCRIPTION'
      and payment.payment_date is null
      and payment.paid_at is null
      and payment.credited_at is null
      and coalesce(payment.refunded_amount, 0) = 0
      and coalesce(payment.ledger_entry_created, false) is false
  ) then
    raise exception 'billing_schedule_old_local_payment_not_safe';
  end if;

  if (
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
  then
    raise exception 'billing_schedule_old_local_binding_or_ledger_not_safe';
  end if;

  if not exists (
    select 1
    from public.asaas_student_billing_period_claims as claim
    where claim.tenant_id = args.tenant_id
      and claim.student_id = args.student_id
      and claim.due_date = args.old_due_date
      and claim.source = 'SUBSCRIPTION'
      and claim.source_key = 'subscription:' || args.offer_id::text
      and claim.status = 'BOUND'
      and claim.provider_entity_id = args.subscription_id
  ) then
    raise exception 'billing_schedule_old_period_claim_not_preserved';
  end if;

  if exists (
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
    raise exception 'billing_schedule_target_period_already_occupied';
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
  ) then
    raise exception 'billing_schedule_operation_already_exists';
  end if;

  if exists (
       select 1 from public.student_offboarding_operations as operation
       where operation.tenant_id = args.tenant_id
         and operation.student_id = args.student_id
         and operation.status in (
           'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
           'UNKNOWN', 'BLOCKED'
         )
     )
     or exists (
       select 1 from public.student_account_deletion_claims as operation
       where operation.tenant_id = args.tenant_id
         and operation.student_id = args.student_id
         and operation.status in (
           'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE',
           'UNKNOWN', 'BLOCKED'
         )
     )
     or exists (
       select 1 from public.student_billing_method_operations as operation
       where operation.tenant_id = args.tenant_id
         and operation.student_id = args.student_id
         and operation.status in ('CLAIMED', 'MUTATING', 'UNKNOWN', 'BLOCKED')
     )
     or exists (
       select 1 from public.asaas_subscription_mutation_operations as operation
       where operation.tenant_id = args.tenant_id
         and operation.student_id = args.student_id
         and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
     )
     or exists (
       select 1 from public.asaas_student_billing_period_claims as claim
       where claim.tenant_id = args.tenant_id
         and claim.student_id = args.student_id
         and claim.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED')
     )
     or exists (
       select 1
       from public.asaas_provider_creation_attempts as operation
       where operation.tenant_id = args.tenant_id
         and operation.lifecycle_student_id = args.student_id
         and operation.lifecycle_released_at is null
         and operation.status in (
           'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'SUCCEEDED', 'BLOCKED'
         )
     )
     or exists (
       select 1
       from public.student_overdue_card_charge_claims as operation
       where operation.tenant_id = args.tenant_id
         and operation.student_id = args.student_id
         and (
           operation.status in (
             'PROCESSING', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
           )
           or (
             operation.status = 'SUCCEEDED'
             and not exists (
               select 1
               from public.student_payments as settled_payment
               where settled_payment.tenant_id = args.tenant_id
                 and settled_payment.student_id = args.student_id
                 and nullif(pg_catalog.btrim(coalesce(
                       settled_payment.asaas_payment_id, ''
                     )), '') = operation.asaas_payment_id
                 and pg_catalog.upper(pg_catalog.btrim(coalesce(
                       settled_payment.status, ''
                     ))) in ('RECEIVED', 'RECEIVED_IN_CASH')
             )
           )
         )
     )
     or exists (
       select 1
       from public.asaas_outbound_message_attempts as operation
       where operation.tenant_id = args.tenant_id
         and operation.student_id = args.student_id
         and operation.status in ('CLAIMED', 'SUBMITTING', 'UNKNOWN')
     )
  then
    raise exception 'billing_schedule_other_lifecycle_operation_active';
  end if;

  if not exists (
    select 1
    from private.tenant_integration_connections as connection
    where connection.tenant_id = args.tenant_id
      and connection.provider = 'asaas'
      and connection.mode <> 'DISABLED'
      and connection.status in ('configured', 'healthy')
  ) then
    raise exception 'billing_schedule_asaas_integration_unavailable';
  end if;
end
$preflight$;

select pg_catalog.jsonb_build_object(
  'ok', true,
  'integrationSnapshot', pg_catalog.jsonb_build_object(
    'integrationId', connection.id,
    'version', connection.version,
    'environment', :'provider_environment',
    'mode', connection.mode,
    'baseUrl', :'asaas_base_url'
  )
)
from private.tenant_integration_connections as connection
where connection.tenant_id = :'tenant_id'
  and connection.provider = 'asaas'
  and connection.mode <> 'DISABLED'
  and connection.status in ('configured', 'healthy');

rollback;
