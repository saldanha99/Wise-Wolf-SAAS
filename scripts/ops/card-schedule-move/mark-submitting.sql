begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table submit_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'step_kind'::text as step_kind,
  :'observed_before'::jsonb as observed_before,
  :'subscription_observed'::jsonb as subscription_observed,
  :'payment_observed'::jsonb as payment_observed,
  :'subscription_payments'::jsonb as subscription_payments;

do $submit$
declare
  args submit_args%rowtype;
  operation_row public.asaas_student_card_schedule_moves%rowtype;
  step_row public.asaas_student_card_schedule_move_steps%rowtype;
  required_status text;
  next_status text;
  local_due date;
begin
  select * into strict args from submit_args;
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

  required_status := case args.step_kind
    when 'MOVE_PAYMENT_TO_TARGET' then 'READY'
    when 'UPDATE_TARGET_SCHEDULE' then 'PAYMENT_MOVED'
    when 'RESTORE_ORIGINAL_SCHEDULE' then 'COMPENSATING'
    when 'RESTORE_ORIGINAL_PAYMENT' then 'ORIGINAL_SCHEDULE_RESTORED'
    else null
  end;
  next_status := case args.step_kind
    when 'MOVE_PAYMENT_TO_TARGET' then 'MOVING_PAYMENT'
    when 'UPDATE_TARGET_SCHEDULE' then 'UPDATING_TARGET_SCHEDULE'
    when 'RESTORE_ORIGINAL_SCHEDULE' then 'RESTORING_ORIGINAL_SCHEDULE'
    when 'RESTORE_ORIGINAL_PAYMENT' then 'RESTORING_ORIGINAL_PAYMENT'
    else null
  end;

  if required_status is null
     or operation_row.status <> required_status
     or step_row.status <> 'READY'
     or step_row.submit_attempt_count <> 0
     or step_row.submitted_at is not null
     or args.observed_before is distinct from step_row.expected_before
     or pg_catalog.jsonb_typeof(args.subscription_observed) <> 'object'
     or pg_catalog.jsonb_typeof(args.payment_observed) <> 'object'
     or pg_catalog.jsonb_typeof(args.subscription_payments) <> 'array'
     or pg_catalog.jsonb_array_length(args.subscription_payments) <> 1
     or (
       args.step_kind = 'MOVE_PAYMENT_TO_TARGET'
       and (
         args.subscription_observed is distinct from
           operation_row.original_subscription_snapshot
         or args.payment_observed is distinct from
           operation_row.original_payment_snapshot
         or args.subscription_payments is distinct from
           operation_row.original_payments_snapshot
       )
     )
     or (
       args.step_kind <> 'MOVE_PAYMENT_TO_TARGET'
       and (
         args.payment_observed is distinct from
           operation_row.target_payment_snapshot
         or args.subscription_payments is distinct from
           pg_catalog.jsonb_build_array(operation_row.target_payment_snapshot)
       )
     )
     or (
       args.step_kind = 'UPDATE_TARGET_SCHEDULE'
       and args.subscription_observed is distinct from
         operation_row.original_subscription_snapshot
     )
     or (
       args.step_kind = 'RESTORE_ORIGINAL_SCHEDULE'
       and args.subscription_observed is distinct from
         operation_row.target_subscription_snapshot
     )
     or (
       args.step_kind = 'RESTORE_ORIGINAL_PAYMENT'
       and args.subscription_observed is distinct from
         operation_row.original_subscription_snapshot
     )
     or (
       args.step_kind in (
         'MOVE_PAYMENT_TO_TARGET', 'UPDATE_TARGET_SCHEDULE'
       )
       and pg_catalog.clock_timestamp() >= operation_row.accept_events_until
     )
     or (
       args.step_kind in ('MOVE_PAYMENT_TO_TARGET', 'UPDATE_TARGET_SCHEDULE')
       and not exists (
       select 1
         from private.tenant_integration_connections as connection
        where connection.id::text =
              operation_row.integration_snapshot ->> 'integrationId'
          and connection.tenant_id = operation_row.tenant_id
          and connection.provider = 'asaas'
          and connection.version::text =
              operation_row.integration_snapshot ->> 'version'
          and connection.mode = operation_row.integration_snapshot ->> 'mode'
          and connection.mode <> 'DISABLED'
          and connection.status in ('configured', 'healthy')
         )
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
    raise exception 'student_card_schedule_move_submit_fence_refused';
  end if;

  local_due := case
    when args.step_kind = 'MOVE_PAYMENT_TO_TARGET'
      then operation_row.old_due_date
    else operation_row.target_due_date
  end;
  if args.step_kind = 'RESTORE_ORIGINAL_PAYMENT' then
    if not private.student_card_schedule_local_payment_exact(
         operation_row.student_payment_id,
         operation_row.tenant_id,
         operation_row.student_id,
         operation_row.payment_id,
         operation_row.customer_id,
         operation_row.target_due_date,
         operation_row.expected_value
       )
       and not private.student_card_schedule_local_payment_exact(
         operation_row.student_payment_id,
         operation_row.tenant_id,
         operation_row.student_id,
         operation_row.payment_id,
         operation_row.customer_id,
         operation_row.old_due_date,
         operation_row.expected_value
       )
    then
      raise exception 'student_card_schedule_move_local_payment_changed';
    end if;
  elsif not private.student_card_schedule_local_payment_exact(
       operation_row.student_payment_id,
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.payment_id,
       operation_row.customer_id,
       local_due,
       operation_row.expected_value
     )
  then
    raise exception 'student_card_schedule_move_local_payment_changed';
  end if;

  if (
       args.step_kind in (
         'UPDATE_TARGET_SCHEDULE', 'RESTORE_ORIGINAL_SCHEDULE'
       )
       or (
         args.step_kind = 'RESTORE_ORIGINAL_PAYMENT'
         and not private.student_card_schedule_local_payment_exact(
           operation_row.student_payment_id,
           operation_row.tenant_id,
           operation_row.student_id,
           operation_row.payment_id,
           operation_row.customer_id,
           operation_row.old_due_date,
           operation_row.expected_value
         )
       )
     )
     and not exists (
       select 1
         from public.asaas_student_card_schedule_move_steps as move_step
         join public.student_payments as payment
           on payment.id = operation_row.student_payment_id
         cross join public.asaas_webhook_inbox as inbox
        where move_step.operation_id = operation_row.id
          and move_step.step_kind = 'MOVE_PAYMENT_TO_TARGET'
          and move_step.status = 'SUCCEEDED'
          and move_step.submit_attempt_count = 1
          and move_step.submitted_at is not null
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
     )
  then
    raise exception 'student_card_schedule_move_target_webhook_not_reconciled';
  end if;

  update public.asaas_student_card_schedule_move_steps
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         submitted_at = pg_catalog.clock_timestamp(),
         updated_at = pg_catalog.clock_timestamp()
   where id = step_row.id;
  update public.asaas_student_card_schedule_moves
     set status = next_status,
         last_error = null,
         updated_at = pg_catalog.clock_timestamp()
   where id = operation_row.id;
end
$submit$;

select pg_catalog.jsonb_build_object(
  'requestFingerprint', step.request_fingerprint,
  'providerRequest', step.provider_request,
  'status', step.status,
  'submitAttemptCount', step.submit_attempt_count
)
from public.asaas_student_card_schedule_moves as operation
join public.asaas_student_card_schedule_move_steps as step
  on step.operation_id = operation.id
where operation.operation_key = :'operation_key'
  and step.step_kind = :'step_kind';

commit;
