begin;
set local lock_timeout = '3s';
set local statement_timeout = '20s';
create temporary table preflight_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'offer_id'::uuid as offer_id,
  :'customer_id'::text as customer_id,
  :'subscription_id'::text as subscription_id,
  :'old_payment_id'::text as payment_id,
  :'old_student_payment_id'::uuid as student_payment_id,
  :'old_due_date'::date as old_due_date,
  :'target_due_date'::date as target_due_date,
  :'original_next_due_date'::date as original_next_due_date,
  :'target_end_date'::date as target_end_date,
  :'original_end_date'::date as original_end_date,
  :'expected_value'::numeric as expected_value,
  :'expected_max_payments'::integer as expected_max_payments,
  :'accept_events_until'::timestamptz as accept_events_until,
  :'provider_environment'::text as provider_environment,
  :'asaas_base_url'::text as asaas_base_url;

do $preflight$
declare
  args preflight_args%rowtype;
begin
  select * into strict args from preflight_args;
  if args.target_due_date + interval '1 month' <>
       args.old_due_date::timestamp
     or args.old_due_date + interval '1 month' <>
       args.original_next_due_date::timestamp
     or args.target_end_date + interval '1 month' <>
       args.original_end_date::timestamp
     or args.expected_max_payments <> 12
     or args.accept_events_until <= pg_catalog.clock_timestamp()
  then
    raise exception 'student_card_schedule_move_calendar_invalid';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended(
         'student-membership-user:' || args.student_id::text,
         0
       )
     )
     or not pg_catalog.pg_try_advisory_xact_lock(
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
    raise exception 'student_card_schedule_move_concurrent_operation';
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
     or not private.student_subscription_mutation_scope_valid(
       args.tenant_id,
       args.student_id,
       args.customer_id,
       args.subscription_id
     )
     or not private.student_card_schedule_local_payment_exact(
       args.student_payment_id,
       args.tenant_id,
       args.student_id,
       args.payment_id,
       args.customer_id,
       args.old_due_date,
       args.expected_value
     )
     or private.student_card_schedule_local_guard_clear(
       args.tenant_id,
       args.student_id,
       args.student_payment_id,
       args.payment_id,
       args.subscription_id,
       private.student_card_schedule_local_guard_baseline(
         args.tenant_id,
         args.student_id,
         args.student_payment_id,
         args.payment_id,
         args.subscription_id
       )
     ) is not true
     or private.student_card_schedule_membership_exact(
       args.tenant_id, args.student_id
     ) is not true
     or private.student_card_schedule_offer_exact(
       args.tenant_id, args.student_id, args.offer_id
     ) is not true
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
     or exists (
       select 1
         from public.asaas_student_billing_period_claims as claim
        where claim.tenant_id = args.tenant_id
          and claim.student_id = args.student_id
          and pg_catalog.date_trunc('month', claim.due_date) =
            pg_catalog.date_trunc('month', args.target_due_date)
     )
     or exists (
       select 1
         from public.student_payments as payment
        where payment.tenant_id = args.tenant_id
          and payment.student_id = args.student_id
          and pg_catalog.date_trunc('month', payment.due_date) =
            pg_catalog.date_trunc('month', args.target_due_date)
     )
     or exists (
       select 1
         from public.asaas_student_card_schedule_moves as operation
        where operation.operation_key = args.operation_key
           or (
             operation.tenant_id = args.tenant_id
             and operation.subscription_id = args.subscription_id
             and operation.status not in ('COMPLETED', 'COMPENSATED', 'FAILED')
           )
     )
     or (select pg_catalog.count(*)
           from private.tenant_integration_connections as connection
          where connection.tenant_id = args.tenant_id
            and connection.provider = 'asaas'
            and connection.mode <> 'DISABLED'
            and connection.status in ('configured', 'healthy')) <> 1
  then
    raise exception 'student_card_schedule_move_preflight_refused';
  end if;
end
$preflight$;

select pg_catalog.jsonb_build_object(
  'ok', true,
  'integrationSnapshot', pg_catalog.jsonb_build_object(
    'integrationId', connection.id,
    'version', connection.version,
    'environment', args.provider_environment,
    'mode', connection.mode,
    'baseUrl', args.asaas_base_url,
    'localGuardBaseline',
      private.student_card_schedule_local_guard_baseline(
        args.tenant_id,
        args.student_id,
        args.student_payment_id,
        args.payment_id,
        args.subscription_id
      )
  )
)
from private.tenant_integration_connections as connection
cross join preflight_args as args
where connection.tenant_id = args.tenant_id
  and connection.provider = 'asaas'
  and connection.mode <> 'DISABLED'
  and connection.status in ('configured', 'healthy');

rollback;
