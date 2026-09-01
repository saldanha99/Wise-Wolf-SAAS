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
  :'observed_state'::jsonb as observed_state,
  :'reason'::text as reason;

do $mark_blocked$
declare
  args operator_args%rowtype;
  operation_row public.asaas_student_billing_schedule_corrections%rowtype;
  step_row public.asaas_student_billing_schedule_correction_steps%rowtype;
  next_operation_status text;
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

  if operation_row.status in ('COMPLETED', 'COMPENSATED', 'FAILED')
     or pg_catalog.jsonb_typeof(args.observed_state) <> 'object'
     or nullif(pg_catalog.btrim(args.reason), '') is null
  then
    raise exception 'billing_schedule_block_refused';
  end if;

  next_operation_status := case
    when step_row.status = 'READY'
      and args.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
      and operation_row.status = 'CONTAINING_TARGET_CONFLICT'
      then 'CONTAINING_TARGET_CONFLICT'
    when step_row.status = 'READY'
      and args.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
      and args.reason =
        'provider_target_competence_not_empty_before_activation'
      then 'BLOCKED'
    when step_row.status = 'READY'
      and args.step_kind in (
        'DELETE_OLD_PAYMENT', 'ACTIVATE_TARGET_SCHEDULE'
      )
      then 'COMPENSATING_SUBSCRIPTION'
    else 'BLOCKED'
  end;

  if step_row.status = 'READY' then
    update public.asaas_student_billing_schedule_correction_steps
    set status = 'BLOCKED',
        observed_state = args.observed_state,
        completed_at = pg_catalog.clock_timestamp(),
        last_error = args.reason,
        updated_at = pg_catalog.clock_timestamp()
    where id = step_row.id;
  end if;

  update public.asaas_student_billing_schedule_corrections
  set status = next_operation_status,
      last_error = args.reason,
      updated_at = pg_catalog.clock_timestamp()
  where id = operation_row.id;
end
$mark_blocked$;

select 'ok';
commit;
