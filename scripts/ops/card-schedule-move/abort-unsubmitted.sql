begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table abort_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'subscription_observed'::jsonb as subscription_observed,
  :'payment_observed'::jsonb as payment_observed,
  :'subscription_payments'::jsonb as subscription_payments;

do $abort$
declare
  args abort_args%rowtype;
  operation_row public.asaas_student_card_schedule_moves%rowtype;
begin
  select * into strict args from abort_args;
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
  select operation.* into strict operation_row
    from public.asaas_student_card_schedule_moves as operation
   where operation.operation_key = args.operation_key
     and operation.tenant_id = args.tenant_id
     and operation.student_id = args.student_id
     and operation.subscription_id = args.subscription_id
     and operation.status = 'READY'
   for update;

  if args.subscription_observed is distinct from
       operation_row.original_subscription_snapshot
     or args.payment_observed is distinct from
       operation_row.original_payment_snapshot
     or args.subscription_payments is distinct from
       operation_row.original_payments_snapshot
     or (select pg_catalog.count(*)
           from public.asaas_student_card_schedule_move_steps as step
          where step.operation_id = operation_row.id) <> 4
     or exists (
       select 1
         from public.asaas_student_card_schedule_move_steps as step
        where step.operation_id = operation_row.id
          and (
            step.status <> 'READY'
            or step.submit_attempt_count <> 0
            or step.submitted_at is not null
          )
     )
     or not private.student_card_schedule_local_payment_exact(
       operation_row.student_payment_id,
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.payment_id,
       operation_row.customer_id,
       operation_row.old_due_date,
       operation_row.expected_value
     )
     or exists (
       select 1
         from public.student_payments as payment
        where payment.tenant_id = operation_row.tenant_id
          and payment.student_id = operation_row.student_id
          and pg_catalog.date_trunc('month', payment.due_date) =
            pg_catalog.date_trunc('month', operation_row.target_due_date)
     )
     or private.student_card_schedule_local_guard_clear(
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.student_payment_id,
       operation_row.payment_id,
       operation_row.subscription_id,
       operation_row.integration_snapshot -> 'localGuardBaseline'
     ) is not true
     or private.student_card_schedule_membership_exact(
       operation_row.tenant_id, operation_row.student_id
     ) is not true
     or private.student_card_schedule_offer_exact(
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.offer_id
     ) is not true
     or private.student_card_schedule_claims_exact(
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.offer_id,
       operation_row.subscription_id,
       operation_row.old_due_date,
       operation_row.target_due_date,
       operation_row.target_billing_claim_id,
       operation_row.target_claim_fingerprint
     ) is not true
  then
    raise exception 'student_card_schedule_move_abort_refused';
  end if;

  update public.asaas_student_card_schedule_moves
     set status = 'FAILED',
         target_billing_claim_id = null,
         completed_at = pg_catalog.clock_timestamp(),
         last_error = 'aborted_before_provider_submit',
         updated_at = pg_catalog.clock_timestamp()
   where id = operation_row.id;
  delete from public.asaas_student_billing_period_claims as claim
   where claim.id = operation_row.target_billing_claim_id
     and claim.tenant_id = operation_row.tenant_id
     and claim.student_id = operation_row.student_id
     and claim.due_date = operation_row.target_due_date
     and claim.source = 'SUBSCRIPTION'
     and claim.source_key = 'subscription:' || operation_row.offer_id::text
     and claim.request_fingerprint = operation_row.target_claim_fingerprint
     and claim.status = 'BOUND'
     and claim.provider_entity_id = operation_row.subscription_id;
  if not found then
    raise exception 'student_card_schedule_move_target_claim_release_failed';
  end if;
end
$abort$;

select pg_catalog.jsonb_build_object(
  'status', operation.status,
  'claimReleased', operation.target_billing_claim_id is null
)
from public.asaas_student_card_schedule_moves as operation
where operation.operation_key = :'operation_key';

commit;
