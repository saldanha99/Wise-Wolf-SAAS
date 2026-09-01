begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table operator_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'target_conflict_evidence'::jsonb as target_conflict_evidence,
  :'reason'::text as reason;

do $mark_target_conflict$
declare
  args operator_args%rowtype;
  operation_row public.asaas_student_billing_schedule_corrections%rowtype;
  target_step public.asaas_student_billing_schedule_correction_steps%rowtype;
  containment_step public.asaas_student_billing_schedule_correction_steps%rowtype;
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
  select step.* into strict target_step
  from public.asaas_student_billing_schedule_correction_steps as step
  where step.operation_id = operation_row.id
    and step.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
  for update;
  select step.* into strict containment_step
  from public.asaas_student_billing_schedule_correction_steps as step
  where step.operation_id = operation_row.id
    and step.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
  for update;

  if operation_row.status not in (
       'TARGET_SCHEDULED', 'AWAITING_TARGET_PAYMENT'
     )
     or operation_row.target_conflict_evidence is not null
     or target_step.status <> 'SUCCEEDED'
     or target_step.submit_attempt_count <> 1
     or target_step.submitted_at is null
     or target_step.desired_after <>
          operation_row.target_subscription_snapshot
     or containment_step.status <> 'READY'
     or containment_step.submit_attempt_count <> 0
     or containment_step.submitted_at is not null
     or exists (
       select 1
       from public.asaas_student_billing_schedule_correction_steps as step
       where step.operation_id = operation_row.id
         and step.step_kind in (
           'ACTIVATE_ORIGINAL_SCHEDULE', 'RESTORE_OLD_PAYMENT'
         )
         and (
           step.status <> 'READY'
           or step.submit_attempt_count <> 0
           or step.submitted_at is not null
         )
     )
     or pg_catalog.jsonb_typeof(
          args.target_conflict_evidence -> 'targetPayments'
        ) <> 'array'
     or pg_catalog.jsonb_array_length(
          args.target_conflict_evidence -> 'targetPayments'
        ) not between 1 and 100
     or args.target_conflict_evidence <> pg_catalog.jsonb_build_object(
          'reason', args.reason,
          'subscription', operation_row.subscription_id,
          'targetPayments',
            args.target_conflict_evidence -> 'targetPayments',
          'targetCompetenceCount',
            pg_catalog.jsonb_array_length(
              args.target_conflict_evidence -> 'targetPayments'
            )
        )
     or nullif(pg_catalog.btrim(args.reason), '') is null
  then
    raise exception 'billing_schedule_target_conflict_transition_refused';
  end if;

  update public.asaas_student_billing_schedule_corrections
  set status = 'CONTAINING_TARGET_CONFLICT',
      target_conflict_evidence = args.target_conflict_evidence,
      completed_at = null,
      last_error = args.reason,
      updated_at = pg_catalog.clock_timestamp()
  where id = operation_row.id
    and target_conflict_evidence is null;
  if not found then
    raise exception 'billing_schedule_target_conflict_already_recorded';
  end if;
end
$mark_target_conflict$;

select pg_catalog.jsonb_build_object('status', operation.status)
from public.asaas_student_billing_schedule_corrections as operation
where operation.operation_key = :'operation_key';

commit;
