begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table operator_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'step_kind'::text as step_kind,
  :'operation_status'::text as operation_status,
  :'observed_state'::jsonb as observed_state,
  :'reason'::text as reason;

do $record_noop$
declare
  args operator_args%rowtype;
  operation_row public.asaas_student_billing_schedule_corrections%rowtype;
  step_row public.asaas_student_billing_schedule_correction_steps%rowtype;
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
  select operation.* into strict operation_row
  from public.asaas_student_billing_schedule_corrections as operation
  where operation.operation_key = args.operation_key
    and operation.tenant_id = args.tenant_id
    and operation.student_id = args.student_id
    and operation.subscription_id = args.subscription_id
  for update;
  select step.* into strict step_row
  from public.asaas_student_billing_schedule_correction_steps as step
  where step.operation_id = operation_row.id
    and step.step_kind = args.step_kind
  for update;

  if args.step_kind not in (
       'INACTIVATE_CONFLICTED_SUBSCRIPTION',
       'ACTIVATE_ORIGINAL_SCHEDULE',
       'RESTORE_OLD_PAYMENT'
     )
     or step_row.status <> 'READY'
     or step_row.submit_attempt_count <> 0
     or pg_catalog.jsonb_typeof(args.observed_state) <> 'object'
     or nullif(pg_catalog.btrim(args.reason), '') is null
     or (
       args.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
       and (
         operation_row.status <> 'CONTAINING_TARGET_CONFLICT'
         or operation_row.target_conflict_evidence is null
         or args.operation_status <> 'BLOCKED'
         or pg_catalog.upper(pg_catalog.btrim(coalesce(
              args.observed_state ->> 'status',
              ''
            ))) <> 'INACTIVE'
         or not (
           args.observed_state @> (step_row.desired_after - 'nextDueDate')
         )
       )
     )
     or (
       args.step_kind = 'ACTIVATE_ORIGINAL_SCHEDULE'
       and (
         operation_row.status <> 'COMPENSATING_SUBSCRIPTION'
         or args.observed_state <> step_row.desired_after
         or args.operation_status <> 'ORIGINAL_SUBSCRIPTION_RESTORED'
       )
     )
     or (
       args.step_kind = 'RESTORE_OLD_PAYMENT'
       and (
         operation_row.status <> 'ORIGINAL_SUBSCRIPTION_RESTORED'
         or args.observed_state <> step_row.desired_after
         or args.operation_status <> 'RESTORING_OLD_PAYMENT'
       )
     )
  then
    raise exception 'billing_schedule_noop_reconciliation_refused';
  end if;

  update public.asaas_student_billing_schedule_correction_steps
  set status = 'SUCCEEDED',
      observed_state = args.observed_state,
      completed_at = pg_catalog.clock_timestamp(),
      last_error = args.reason,
      updated_at = pg_catalog.clock_timestamp()
  where id = step_row.id;

  update public.asaas_student_billing_schedule_corrections
  set status = args.operation_status,
      completed_at = null,
      last_error = args.reason,
      updated_at = pg_catalog.clock_timestamp()
  where id = operation_row.id;
end
$record_noop$;

select 'ok';
commit;
