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
  :'request_fingerprint'::text as request_fingerprint,
  :'provider_request'::jsonb as provider_request;

do $mark_submitting$
declare
  args operator_args%rowtype;
  operation_row public.asaas_student_billing_schedule_corrections%rowtype;
  step_row public.asaas_student_billing_schedule_correction_steps%rowtype;
  required_operation_status text;
  submitting_operation_status text;
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

  required_operation_status := case args.step_kind
    when 'INACTIVATE_SUBSCRIPTION' then 'READY'
    when 'DELETE_OLD_PAYMENT' then 'INACTIVE_CONFIRMED'
    when 'ACTIVATE_TARGET_SCHEDULE' then 'OLD_PAYMENT_DELETED'
    when 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
      then 'CONTAINING_TARGET_CONFLICT'
    when 'ACTIVATE_ORIGINAL_SCHEDULE' then 'COMPENSATING_SUBSCRIPTION'
    when 'RESTORE_OLD_PAYMENT' then 'ORIGINAL_SUBSCRIPTION_RESTORED'
    else null
  end;
  submitting_operation_status := case args.step_kind
    when 'INACTIVATE_SUBSCRIPTION' then 'INACTIVATING'
    when 'DELETE_OLD_PAYMENT' then 'DELETING_OLD_PAYMENT'
    when 'ACTIVATE_TARGET_SCHEDULE' then 'ACTIVATING_TARGET'
    when 'INACTIVATE_CONFLICTED_SUBSCRIPTION'
      then 'CONTAINING_TARGET_CONFLICT'
    when 'ACTIVATE_ORIGINAL_SCHEDULE' then 'COMPENSATING_SUBSCRIPTION'
    when 'RESTORE_OLD_PAYMENT' then 'RESTORING_OLD_PAYMENT'
    else null
  end;

  if required_operation_status is null
     or operation_row.status <> required_operation_status
     or not (
       operation_row.accept_events_until >= pg_catalog.clock_timestamp()
     )
     or step_row.status <> 'READY'
     or step_row.submit_attempt_count <> 0
     or step_row.submitted_at is not null
     or step_row.request_fingerprint <> args.request_fingerprint
     or step_row.provider_request <> args.provider_request
     or not exists (
       select 1
       from private.tenant_integration_connections as connection
       where connection.id::text =
             operation_row.integration_snapshot ->> 'integrationId'
         and connection.tenant_id = operation_row.tenant_id
         and connection.provider = 'asaas'
         and connection.version::text =
             operation_row.integration_snapshot ->> 'version'
         and connection.mode =
             operation_row.integration_snapshot ->> 'mode'
         and connection.mode <> 'DISABLED'
         and connection.status in ('configured', 'healthy')
     )
  then
    raise exception 'billing_schedule_submit_fence_refused';
  end if;

  if args.step_kind = 'DELETE_OLD_PAYMENT'
     and (
       not exists (
         select 1
         from public.student_payments as payment
         where payment.id = operation_row.old_student_payment_id
           and payment.tenant_id = operation_row.tenant_id
           and payment.student_id = operation_row.student_id
           and nullif(pg_catalog.btrim(coalesce(
                 payment.asaas_payment_id,
                 ''
               )), '') = operation_row.old_payment_id
           and (
             nullif(pg_catalog.btrim(coalesce(
               payment.asaas_id,
               ''
             )), '') is null
             or nullif(pg_catalog.btrim(payment.asaas_id), '') =
               operation_row.old_payment_id
           )
           and nullif(pg_catalog.btrim(coalesce(
                 payment.provider_customer_id,
                 ''
               )), '') = operation_row.customer_id
           and payment.due_date =
             (operation_row.original_payment_snapshot ->> 'dueDate')::date
           and pg_catalog.round(payment.value, 2) = pg_catalog.round(
             (operation_row.original_payment_snapshot ->> 'value')::numeric,
             2
           )
           and payment.amount_cents = pg_catalog.round(
             (operation_row.original_payment_snapshot ->> 'value')::numeric * 100
           )::integer
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.billing_type,
                 ''
               ))) = operation_row.original_payment_snapshot ->> 'billingType'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.payment_method,
                 ''
               ))) = operation_row.original_payment_snapshot ->> 'billingType'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.payment_type,
                 ''
               ))) = 'SUBSCRIPTION'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.status,
                 ''
               ))) = 'PENDING'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.provider_status,
                 ''
               ))) = 'PENDING'
           and payment.payment_date is null
           and payment.paid_at is null
           and payment.credited_at is null
           and coalesce(payment.refunded_amount, 0) = 0
           and coalesce(payment.ledger_entry_created, false) is false
           and not exists (
             select 1
             from public.financial_transactions as ledger_row
             where ledger_row.student_payment_id = payment.id
                or ledger_row.refund_student_payment_id = payment.id
           )
           and (
             select pg_catalog.count(*)
             from public.student_payments as bound_payment
             where nullif(pg_catalog.btrim(coalesce(
                     bound_payment.asaas_payment_id,
                     ''
                   )), '') = operation_row.old_payment_id
                or nullif(pg_catalog.btrim(coalesce(
                     bound_payment.asaas_id,
                     ''
                   )), '') = operation_row.old_payment_id
           ) = 1
       )
       or (
         select pg_catalog.count(*)
         from public.student_payments as payment
         where nullif(pg_catalog.btrim(coalesce(
                 payment.asaas_payment_id,
                 ''
               )), '') = operation_row.old_payment_id
            or nullif(pg_catalog.btrim(coalesce(
                 payment.asaas_id,
                 ''
               )), '') = operation_row.old_payment_id
       ) <> 1
       or exists (
         select 1
         from public.financial_transactions as ledger_row
         where ledger_row.student_payment_id =
           operation_row.old_student_payment_id
            or ledger_row.refund_student_payment_id =
              operation_row.old_student_payment_id
       )
     )
  then
    raise exception 'billing_schedule_delete_local_unsettled_gate_refused';
  end if;

  if args.step_kind in (
       'ACTIVATE_TARGET_SCHEDULE', 'RESTORE_OLD_PAYMENT'
     )
     and not exists (
         select 1
         from public.student_payments as payment
         join public.asaas_student_billing_schedule_correction_steps
           as delete_step
           on delete_step.operation_id = operation_row.id
          and delete_step.step_kind = 'DELETE_OLD_PAYMENT'
         join public.asaas_webhook_inbox as deleted_event
           on deleted_event.provider_event_id = nullif(
                pg_catalog.btrim(coalesce(
                  payment.last_provider_event_id,
                  ''
                )),
                ''
              )
         where payment.id = operation_row.old_student_payment_id
           and payment.tenant_id = operation_row.tenant_id
           and payment.student_id = operation_row.student_id
           and nullif(pg_catalog.btrim(coalesce(
                 payment.asaas_payment_id,
                 ''
               )), '') = operation_row.old_payment_id
           and (
             nullif(pg_catalog.btrim(coalesce(
               payment.asaas_id,
               ''
             )), '') is null
             or nullif(pg_catalog.btrim(payment.asaas_id), '') =
               operation_row.old_payment_id
           )
           and nullif(pg_catalog.btrim(coalesce(
                 payment.provider_customer_id,
                 ''
               )), '') = operation_row.customer_id
           and payment.due_date =
             (operation_row.original_payment_snapshot ->> 'dueDate')::date
           and pg_catalog.round(payment.value, 2) = pg_catalog.round(
             (operation_row.original_payment_snapshot ->> 'value')::numeric,
             2
           )
           and payment.amount_cents = pg_catalog.round(
             (operation_row.original_payment_snapshot ->> 'value')::numeric * 100
           )::integer
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.billing_type,
                 ''
               ))) = operation_row.original_payment_snapshot ->> 'billingType'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.payment_method,
                 ''
               ))) = operation_row.original_payment_snapshot ->> 'billingType'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.payment_type,
                 ''
               ))) = 'SUBSCRIPTION'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.status,
                 ''
               ))) = 'CANCELLED'
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 payment.provider_status,
                 ''
               ))) = 'DELETED'
           and payment.payment_date is null
           and payment.paid_at is null
           and payment.credited_at is null
           and coalesce(payment.refunded_amount, 0) = 0
           and coalesce(payment.ledger_entry_created, false) is false
           and not exists (
             select 1
             from public.financial_transactions as ledger_row
             where ledger_row.student_payment_id = payment.id
                or ledger_row.refund_student_payment_id = payment.id
           )
           and (
             select pg_catalog.count(*)
             from public.student_payments as bound_payment
             where nullif(pg_catalog.btrim(coalesce(
                     bound_payment.asaas_payment_id,
                     ''
                   )), '') = operation_row.old_payment_id
                or nullif(pg_catalog.btrim(coalesce(
                     bound_payment.asaas_id,
                     ''
                   )), '') = operation_row.old_payment_id
           ) = 1
           and delete_step.status = 'SUCCEEDED'
           and delete_step.submit_attempt_count = 1
           and delete_step.submitted_at is not null
           and deleted_event.event_name = 'PAYMENT_DELETED'
           and deleted_event.provider_entity_id = operation_row.old_payment_id
           and deleted_event.status = 'PROCESSED'
           and deleted_event.processed_at is not null
           and deleted_event.received_at >= delete_step.submitted_at
           and deleted_event.processed_at >= delete_step.submitted_at
           and deleted_event.payload ->> 'id' =
             deleted_event.provider_event_id
           and pg_catalog.upper(pg_catalog.btrim(coalesce(
                 deleted_event.payload ->> 'event',
                 ''
               ))) = 'PAYMENT_DELETED'
           and pg_catalog.jsonb_typeof(
                 deleted_event.payload -> 'payment'
               ) = 'object'
           and deleted_event.payload #>> '{payment,id}' =
             operation_row.old_payment_id
           and deleted_event.payload #>> '{payment,customer}' =
             operation_row.customer_id
           and deleted_event.payload #>> '{payment,subscription}' =
             operation_row.subscription_id
       )
  then
    raise exception 'billing_schedule_old_payment_causal_gate_refused';
  end if;

  if args.step_kind = 'ACTIVATE_TARGET_SCHEDULE'
     and exists (
       select 1
       from public.student_payments as target_payment
       where target_payment.tenant_id = operation_row.tenant_id
         and target_payment.student_id = operation_row.student_id
         and pg_catalog.date_trunc('month', target_payment.due_date) =
           pg_catalog.date_trunc('month', operation_row.target_due_date)
     )
  then
    raise exception 'billing_schedule_target_local_competence_not_empty';
  end if;

  update public.asaas_student_billing_schedule_correction_steps
  set status = 'SUBMITTING',
      submit_attempt_count = submit_attempt_count + 1,
      submitted_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where id = step_row.id
    and status = 'READY'
    and submit_attempt_count = 0;
  if not found then
    raise exception 'billing_schedule_submit_already_consumed';
  end if;

  update public.asaas_student_billing_schedule_corrections
  set status = submitting_operation_status,
      last_error = null,
      updated_at = pg_catalog.clock_timestamp()
  where id = operation_row.id
    and status = required_operation_status;
  if not found then
    raise exception 'billing_schedule_operation_state_changed';
  end if;
end
$mark_submitting$;

select 'ok';
commit;
