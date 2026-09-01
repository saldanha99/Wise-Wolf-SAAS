begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table noop_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'step_kind'::text as step_kind,
  :'observed_after'::jsonb as observed_after,
  :'subscription_observed'::jsonb as subscription_observed,
  :'payment_observed'::jsonb as payment_observed,
  :'subscription_payments'::jsonb as subscription_payments;

do $noop$
declare
  args noop_args%rowtype;
  operation_row public.asaas_student_card_schedule_moves%rowtype;
  step_row public.asaas_student_card_schedule_move_steps%rowtype;
  next_status text;
begin
  select * into strict args from noop_args;
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
   for update;
  select step.* into strict step_row
    from public.asaas_student_card_schedule_move_steps as step
   where step.operation_id = operation_row.id
     and step.step_kind = args.step_kind
   for update;

  next_status := case args.step_kind
    when 'RESTORE_ORIGINAL_SCHEDULE' then 'ORIGINAL_SCHEDULE_RESTORED'
    when 'RESTORE_ORIGINAL_PAYMENT' then 'RESTORING_ORIGINAL_PAYMENT'
    else null
  end;
  if next_status is null
     or step_row.status <> 'READY'
     or step_row.submit_attempt_count <> 0
     or args.observed_after is distinct from step_row.desired_after
     or args.subscription_observed is distinct from
       operation_row.original_subscription_snapshot
     or (
       args.step_kind = 'RESTORE_ORIGINAL_SCHEDULE'
       and (
         args.payment_observed is distinct from
           operation_row.target_payment_snapshot
         or args.subscription_payments is distinct from
           pg_catalog.jsonb_build_array(operation_row.target_payment_snapshot)
       )
     )
     or (
       args.step_kind = 'RESTORE_ORIGINAL_PAYMENT'
       and (
         args.payment_observed is distinct from
           operation_row.original_payment_snapshot
         or args.subscription_payments is distinct from
           operation_row.original_payments_snapshot
       )
     )
     or (
       args.step_kind = 'RESTORE_ORIGINAL_SCHEDULE'
       and operation_row.status <> 'COMPENSATING'
     )
     or (
       args.step_kind = 'RESTORE_ORIGINAL_PAYMENT'
       and operation_row.status <> 'ORIGINAL_SCHEDULE_RESTORED'
     )
     or private.student_card_schedule_local_guard_clear(
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.student_payment_id,
       operation_row.payment_id,
       operation_row.subscription_id,
       operation_row.integration_snapshot -> 'localGuardBaseline'
     ) is not true
     or private.student_card_schedule_profile_exact(
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.customer_id,
       operation_row.subscription_id,
       operation_row.expected_value,
       operation_row.target_due_date,
       operation_row.original_end_date,
       operation_row.integration_snapshot -> 'profileSnapshot'
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
    raise exception 'student_card_schedule_move_noop_refused';
  end if;

  update public.asaas_student_card_schedule_move_steps
     set status = 'SUCCEEDED',
         observed_state = args.observed_after,
         completed_at = pg_catalog.clock_timestamp(),
         last_error = 'provider_already_in_compensation_state',
         updated_at = pg_catalog.clock_timestamp()
   where id = step_row.id;
  update public.asaas_student_card_schedule_moves
     set status = next_status,
         last_error = 'provider_already_in_compensation_state',
         updated_at = pg_catalog.clock_timestamp()
   where id = operation_row.id;
end
$noop$;

select pg_catalog.jsonb_build_object('status', operation.status)
from public.asaas_student_card_schedule_moves as operation
where operation.operation_key = :'operation_key';

commit;
