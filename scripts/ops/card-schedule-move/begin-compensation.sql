begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table compensation_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'subscription_observed'::jsonb as subscription_observed,
  :'payment_observed'::jsonb as payment_observed,
  :'subscription_payments'::jsonb as subscription_payments;

do $compensate$
declare
  args compensation_args%rowtype;
  operation_row public.asaas_student_card_schedule_moves%rowtype;
  move_step public.asaas_student_card_schedule_move_steps%rowtype;
  update_step public.asaas_student_card_schedule_move_steps%rowtype;
  target_local boolean;
  original_local boolean;
  target_webhook_causal boolean;
begin
  select * into strict args from compensation_args;
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
     and operation.status = 'PAYMENT_MOVED'
   for update;
  select step.* into strict move_step
    from public.asaas_student_card_schedule_move_steps as step
   where step.operation_id = operation_row.id
     and step.step_kind = 'MOVE_PAYMENT_TO_TARGET'
   for update;
  select step.* into strict update_step
    from public.asaas_student_card_schedule_move_steps as step
   where step.operation_id = operation_row.id
     and step.step_kind = 'UPDATE_TARGET_SCHEDULE'
   for update;

  target_local := private.student_card_schedule_local_payment_exact(
    operation_row.student_payment_id,
    operation_row.tenant_id,
    operation_row.student_id,
    operation_row.payment_id,
    operation_row.customer_id,
    operation_row.target_due_date,
    operation_row.expected_value
  );
  original_local := private.student_card_schedule_local_payment_exact(
    operation_row.student_payment_id,
    operation_row.tenant_id,
    operation_row.student_id,
    operation_row.payment_id,
    operation_row.customer_id,
    operation_row.old_due_date,
    operation_row.expected_value
  );
  target_webhook_causal := exists (
    select 1
      from public.student_payments as payment
      cross join public.asaas_webhook_inbox as inbox
     where payment.id = operation_row.student_payment_id
       and inbox.event_name = 'PAYMENT_UPDATED'
       and inbox.provider_entity_id = operation_row.payment_id
       and inbox.status = 'PROCESSED'
       and inbox.processed_at is not null
       and inbox.received_at >= move_step.submitted_at
       and inbox.received_at <= operation_row.accept_events_until
       and inbox.payload #>> '{payment,id}' = operation_row.payment_id
       and inbox.payload #>> '{payment,customer}' = operation_row.customer_id
       and inbox.payload #>> '{payment,subscription}' =
         operation_row.subscription_id
       and inbox.payload #>> '{payment,dueDate}' =
         operation_row.target_due_date::text
  );

  if args.subscription_observed is distinct from
       operation_row.original_subscription_snapshot
     or args.payment_observed is distinct from
       operation_row.target_payment_snapshot
     or args.subscription_payments is distinct from
       pg_catalog.jsonb_build_array(operation_row.target_payment_snapshot)
     or move_step.status <> 'SUCCEEDED'
     or move_step.submit_attempt_count <> 1
     or move_step.submitted_at is null
     or update_step.status <> 'READY'
     or update_step.submit_attempt_count <> 0
     or update_step.submitted_at is not null
     or not (original_local or (target_local and target_webhook_causal))
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
    raise exception 'student_card_schedule_move_compensation_begin_refused';
  end if;

  update public.asaas_student_card_schedule_move_steps
     set status = 'FAILED',
         provider_response = '{}'::jsonb,
         observed_state = operation_row.original_subscription_snapshot,
         completed_at = pg_catalog.clock_timestamp(),
         last_error = 'target_schedule_submit_abandoned',
         updated_at = pg_catalog.clock_timestamp()
   where id = update_step.id;
  update public.asaas_student_card_schedule_moves
     set status = 'COMPENSATING',
         last_error = 'target_schedule_submit_abandoned',
         updated_at = pg_catalog.clock_timestamp()
   where id = operation_row.id;
end
$compensate$;

select pg_catalog.jsonb_build_object(
  'status', operation.status,
  'updateStepStatus', step.status,
  'updateSubmitCount', step.submit_attempt_count
)
from public.asaas_student_card_schedule_moves as operation
join public.asaas_student_card_schedule_move_steps as step
  on step.operation_id = operation.id
 and step.step_kind = 'UPDATE_TARGET_SCHEDULE'
where operation.operation_key = :'operation_key';

commit;
