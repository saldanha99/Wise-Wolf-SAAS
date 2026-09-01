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
  :'step_status'::text as step_status,
  :'operation_status'::text as operation_status,
  :'provider_response'::jsonb as provider_response,
  :'observed_state'::jsonb as observed_state,
  :'target_conflict_evidence'::jsonb as target_conflict_evidence,
  nullif(:'provider_http_status', '')::integer as provider_http_status,
  nullif(:'last_error', '')::text as last_error;

do $finish_step$
declare
  args operator_args%rowtype;
  operation_row public.asaas_student_billing_schedule_corrections%rowtype;
  step_row public.asaas_student_billing_schedule_correction_steps%rowtype;
  expected_operation_status text;
  effective_provider_response jsonb;
  effective_provider_http_status integer;
  delete_absence_proof boolean := false;
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

  expected_operation_status := case args.step_kind
    when 'INACTIVATE_SUBSCRIPTION' then 'INACTIVATING'
    when 'DELETE_OLD_PAYMENT' then 'DELETING_OLD_PAYMENT'
    when 'ACTIVATE_TARGET_SCHEDULE' then 'ACTIVATING_TARGET'
    when 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
      then 'CONTAINING_TARGET_CONFLICT'
    when 'ACTIVATE_ORIGINAL_SCHEDULE' then 'COMPENSATING_SUBSCRIPTION'
    when 'RESTORE_OLD_PAYMENT' then 'RESTORING_OLD_PAYMENT'
    else null
  end;
  effective_provider_response := coalesce(
    step_row.provider_response,
    args.provider_response
  );
  effective_provider_http_status := coalesce(
    step_row.provider_http_status,
    args.provider_http_status
  );
  delete_absence_proof := coalesce(
    args.observed_state = pg_catalog.jsonb_build_object(
      'kind', 'PAYMENT_NOT_FOUND_WITH_SUBSCRIPTION_LIST',
      'id', operation_row.old_payment_id,
      'subscription', operation_row.subscription_id,
      'getHttpStatus', 404,
      'liveOldPaymentCount', 0,
      'listedLivePaymentIds',
        args.observed_state -> 'listedLivePaymentIds'
    )
    and pg_catalog.jsonb_typeof(
          args.observed_state -> 'listedLivePaymentIds'
        ) = 'array'
    and pg_catalog.jsonb_array_length(
          args.observed_state -> 'listedLivePaymentIds'
        ) <= 100
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        args.observed_state -> 'listedLivePaymentIds'
      ) as listed(payment_id)
      where listed.payment_id = operation_row.old_payment_id
         or listed.payment_id !~ '^pay_[A-Za-z0-9_-]{4,196}$'
    ),
    false
  );

  if step_row.status not in ('SUBMITTING', 'UNKNOWN')
     or step_row.submit_attempt_count <> 1
     or args.step_status not in ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'BLOCKED')
     or pg_catalog.jsonb_typeof(args.provider_response) <> 'object'
     or pg_catalog.jsonb_typeof(args.observed_state) <> 'object'
     or (
       operation_row.status not in (expected_operation_status, 'UNKNOWN')
     )
  then
    raise exception 'billing_schedule_finish_fence_refused';
  end if;

  if not (
    (args.step_status = 'UNKNOWN' and (
      args.operation_status = 'UNKNOWN'
      or (
        args.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
        and args.operation_status = 'CONTAINING_TARGET_CONFLICT'
      )
    ))
    or (args.step_status = 'BLOCKED'
      and args.operation_status = 'BLOCKED'
      and args.step_kind <> 'ACTIVATE_TARGET_SCHEDULE')
    or (args.step_status = 'BLOCKED'
      and args.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
      and args.operation_status = 'CONTAINING_TARGET_CONFLICT')
    or (args.step_status = 'SUCCEEDED' and (
      (args.step_kind = 'INACTIVATE_SUBSCRIPTION'
        and args.operation_status = 'INACTIVE_CONFIRMED')
      or (args.step_kind = 'DELETE_OLD_PAYMENT'
        and args.operation_status = 'OLD_PAYMENT_DELETED')
      or (args.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
        and args.operation_status = 'TARGET_SCHEDULED')
      or (args.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
        and args.operation_status = 'BLOCKED')
      or (args.step_kind = 'ACTIVATE_ORIGINAL_SCHEDULE'
        and args.operation_status = 'ORIGINAL_SUBSCRIPTION_RESTORED')
      or (args.step_kind = 'RESTORE_OLD_PAYMENT'
        and args.operation_status = 'RESTORING_OLD_PAYMENT')
    ))
    or (args.step_status = 'FAILED' and (
      (args.step_kind = 'INACTIVATE_SUBSCRIPTION'
        and args.operation_status = 'FAILED')
      or (args.step_kind in ('DELETE_OLD_PAYMENT', 'ACTIVATE_TARGET_SCHEDULE')
        and args.operation_status = 'COMPENSATING_SUBSCRIPTION')
      or (args.step_kind in ('ACTIVATE_ORIGINAL_SCHEDULE', 'RESTORE_OLD_PAYMENT')
        and args.operation_status = 'BLOCKED')
      or (args.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
        and args.operation_status = 'CONTAINING_TARGET_CONFLICT')
    ))
  ) then
    raise exception 'billing_schedule_finish_transition_invalid';
  end if;

  if args.target_conflict_evidence <> '{}'::jsonb
     and not (
       args.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
       and args.step_status = 'BLOCKED'
       and args.operation_status = 'CONTAINING_TARGET_CONFLICT'
       and operation_row.target_conflict_evidence is null
       and args.target_conflict_evidence = pg_catalog.jsonb_build_object(
         'reason', args.target_conflict_evidence ->> 'reason',
         'subscription', operation_row.subscription_id,
         'targetPayments',
           args.target_conflict_evidence -> 'targetPayments',
         'targetCompetenceCount',
           pg_catalog.jsonb_array_length(
             args.target_conflict_evidence -> 'targetPayments'
           )
       )
       and pg_catalog.jsonb_typeof(
             args.target_conflict_evidence -> 'targetPayments'
           ) = 'array'
       and pg_catalog.jsonb_array_length(
             args.target_conflict_evidence -> 'targetPayments'
           ) between 1 and 100
       and nullif(pg_catalog.btrim(
             args.target_conflict_evidence ->> 'reason'
           ), '') is not null
     )
  then
    raise exception 'billing_schedule_target_conflict_evidence_invalid';
  end if;

  if args.step_kind = 'DELETE_OLD_PAYMENT'
     and args.step_status = 'SUCCEEDED'
     and (
       step_row.expected_before <> operation_row.original_payment_snapshot
       or step_row.desired_after <>
            (operation_row.original_payment_snapshot || '{"deleted":true}'::jsonb)
       or step_row.provider_request <> pg_catalog.jsonb_build_object(
            'method', 'DELETE',
            'path', '/payments/' || operation_row.old_payment_id,
            'body', null
          )
       or not (
         args.observed_state = step_row.desired_after
         or delete_absence_proof
       )
       or not (
         effective_provider_http_status is null
         or effective_provider_http_status in (408, 429)
         or effective_provider_http_status between 500 and 599
         or (
           effective_provider_http_status between 200 and 299
           and effective_provider_response ->> 'id' =
             operation_row.old_payment_id
           and coalesce((
             effective_provider_response ->> 'deleted'
           )::boolean, false) is true
         )
       )
     )
  then
    raise exception 'billing_schedule_delete_confirmation_invalid';
  end if;

  if args.step_kind = 'RESTORE_OLD_PAYMENT'
     and args.step_status = 'SUCCEEDED'
     and args.observed_state <> step_row.desired_after
  then
    raise exception 'billing_schedule_restore_get_confirmation_invalid';
  end if;

  if args.step_kind = 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
     and args.step_status = 'SUCCEEDED'
     and (
       pg_catalog.upper(pg_catalog.btrim(coalesce(
         args.observed_state ->> 'status',
         ''
       ))) <> 'INACTIVE'
       or not (
         args.observed_state @> (step_row.desired_after - 'nextDueDate')
       )
     )
  then
    raise exception 'billing_schedule_containment_get_confirmation_invalid';
  end if;

  update public.asaas_student_billing_schedule_correction_steps
  set status = args.step_status,
      provider_response = coalesce(
        step_row.provider_response,
        args.provider_response
      ),
      observed_state = args.observed_state,
      provider_http_status = coalesce(
        step_row.provider_http_status,
        args.provider_http_status
      ),
      completed_at = case
        when args.step_status in ('SUCCEEDED', 'FAILED', 'BLOCKED')
          then coalesce(step_row.completed_at, pg_catalog.clock_timestamp())
        else null
      end,
      last_error = args.last_error,
      updated_at = pg_catalog.clock_timestamp()
  where id = step_row.id;

  update public.asaas_student_billing_schedule_corrections
  set status = args.operation_status,
      target_conflict_evidence = case
        when args.target_conflict_evidence <> '{}'::jsonb
          then args.target_conflict_evidence
        else operation_row.target_conflict_evidence
      end,
      completed_at = case
        when args.operation_status in ('COMPLETED', 'COMPENSATED', 'FAILED')
          then coalesce(operation_row.completed_at, pg_catalog.clock_timestamp())
        else null
      end,
      last_error = args.last_error,
      updated_at = pg_catalog.clock_timestamp()
  where id = operation_row.id;
end
$finish_step$;

select 'ok';
commit;
