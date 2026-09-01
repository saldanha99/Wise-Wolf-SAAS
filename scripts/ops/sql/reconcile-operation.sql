begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table operator_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'old_payment_id'::text as old_payment_id,
  nullif(:'target_payment_id', '')::text as target_payment_id,
  :'target_payment_observed'::jsonb as target_payment_observed,
  :'subscription_observed'::jsonb as subscription_observed,
  :'old_payment_observed'::jsonb as old_payment_observed;

do $reconcile_operation$
declare
  args operator_args%rowtype;
  operation_row public.asaas_student_billing_schedule_corrections%rowtype;
  target_local_count integer;
  target_active_competence_count integer;
  old_local_reconciled boolean;
  old_local_restored boolean;
  old_provider_deleted boolean := false;
  compensation_causal boolean := false;
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
    and operation.old_payment_id = args.old_payment_id
    and operation.status in (
      'TARGET_SCHEDULED', 'AWAITING_TARGET_PAYMENT',
      'RESTORING_OLD_PAYMENT'
    )
  for update;

  if operation_row.status = 'RESTORING_OLD_PAYMENT' then
    if args.subscription_observed <>
         operation_row.original_subscription_snapshot
       or args.old_payment_observed <>
         operation_row.original_payment_snapshot
       or not exists (
         select 1
         from public.asaas_student_billing_schedule_correction_steps as step
         where step.operation_id = operation_row.id
           and step.step_kind = 'RESTORE_OLD_PAYMENT'
           and step.status = 'SUCCEEDED'
       )
    then
      raise exception 'billing_schedule_compensation_provider_mismatch';
    end if;

    select exists (
      select 1
      from public.student_payments as payment
      where payment.id = operation_row.old_student_payment_id
        and payment.tenant_id = operation_row.tenant_id
        and payment.student_id = operation_row.student_id
        and nullif(pg_catalog.btrim(coalesce(
              payment.asaas_payment_id, ''
            )), '') = operation_row.old_payment_id
        and (
          nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') is null
          or nullif(pg_catalog.btrim(payment.asaas_id), '') =
            operation_row.old_payment_id
        )
        and nullif(pg_catalog.btrim(coalesce(
              payment.provider_customer_id, ''
            )), '') = operation_row.customer_id
        and payment.due_date =
          (operation_row.original_payment_snapshot ->> 'dueDate')::date
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.status, ''
            ))) = 'PENDING'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.provider_status, ''
            ))) = 'PENDING'
        and pg_catalog.round(payment.value, 2) = pg_catalog.round(
          (operation_row.original_payment_snapshot ->> 'value')::numeric,
          2
        )
        and payment.amount_cents = pg_catalog.round(
          (operation_row.original_payment_snapshot ->> 'value')::numeric * 100
        )::integer
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.billing_type, ''
            ))) = operation_row.original_payment_snapshot ->> 'billingType'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.payment_method, ''
            ))) = operation_row.original_payment_snapshot ->> 'billingType'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.payment_type, ''
            ))) = 'SUBSCRIPTION'
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
    ) into old_local_restored;

    compensation_causal :=
      private.asaas_billing_schedule_compensation_causal(operation_row.id);

    update public.asaas_student_billing_schedule_corrections
    set status = case when old_local_restored and compensation_causal
          then 'COMPENSATED'
          else 'RESTORING_OLD_PAYMENT'
        end,
        completed_at = case when old_local_restored and compensation_causal
          then pg_catalog.clock_timestamp()
          else null
        end,
        last_error = case when old_local_restored and compensation_causal
          then null
          else 'awaiting_causal_old_payment_restore_webhook'
        end,
        updated_at = pg_catalog.clock_timestamp()
    where id = operation_row.id;
  else
    select exists (
      select 1
      from public.asaas_student_billing_schedule_correction_steps as delete_step
      where delete_step.operation_id = operation_row.id
        and delete_step.step_kind = 'DELETE_OLD_PAYMENT'
        and delete_step.status = 'SUCCEEDED'
        and delete_step.submit_attempt_count = 1
        and delete_step.submitted_at is not null
        and delete_step.expected_before =
          operation_row.original_payment_snapshot
        and delete_step.desired_after =
          (operation_row.original_payment_snapshot || '{"deleted":true}'::jsonb)
        and delete_step.provider_request = pg_catalog.jsonb_build_object(
          'method', 'DELETE',
          'path', '/payments/' || operation_row.old_payment_id,
          'body', null
        )
        and (
          args.old_payment_observed = delete_step.desired_after
          or (
            args.old_payment_observed = pg_catalog.jsonb_build_object(
              'kind', 'PAYMENT_NOT_FOUND_WITH_SUBSCRIPTION_LIST',
              'id', operation_row.old_payment_id,
              'subscription', operation_row.subscription_id,
              'getHttpStatus', 404,
              'liveOldPaymentCount', 0,
              'listedLivePaymentIds',
                args.old_payment_observed -> 'listedLivePaymentIds'
            )
            and pg_catalog.jsonb_typeof(
                  args.old_payment_observed -> 'listedLivePaymentIds'
                ) = 'array'
            and pg_catalog.jsonb_array_length(
                  args.old_payment_observed -> 'listedLivePaymentIds'
                ) <= 100
            and not exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                args.old_payment_observed -> 'listedLivePaymentIds'
              ) as listed(payment_id)
              where listed.payment_id = operation_row.old_payment_id
                 or listed.payment_id !~ '^pay_[A-Za-z0-9_-]{4,196}$'
            )
          )
        )
        and (
          delete_step.provider_http_status is null
          or delete_step.provider_http_status in (408, 429)
          or delete_step.provider_http_status between 500 and 599
          or (
            delete_step.provider_http_status between 200 and 299
            and delete_step.provider_response ->> 'id' =
              operation_row.old_payment_id
            and coalesce((
              delete_step.provider_response ->> 'deleted'
            )::boolean, false) is true
          )
        )
    ) into old_provider_deleted;

    if (args.subscription_observed - 'nextDueDate') <>
         (operation_row.target_subscription_snapshot - 'nextDueDate')
       or not old_provider_deleted
       or (
         args.target_payment_id is null
         and args.target_payment_observed <> '{}'::jsonb
       )
       or (
         args.target_payment_id is not null
         and not coalesce((
           pg_catalog.jsonb_typeof(args.target_payment_observed) = 'object'
           and args.target_payment_observed ->> 'id' =
             args.target_payment_id
           and args.target_payment_observed ->> 'customer' =
             operation_row.customer_id
           and args.target_payment_observed ->> 'subscription' =
             operation_row.subscription_id
           and args.target_payment_observed ->> 'status' = 'PENDING'
           and args.target_payment_observed ->> 'dueDate' =
             operation_row.target_due_date::text
           and args.target_payment_observed ->> 'originalDueDate' =
             operation_row.target_due_date::text
           and args.target_payment_observed ->> 'billingType' =
             operation_row.target_subscription_snapshot ->> 'billingType'
           and (args.target_payment_observed ->> 'value')::numeric =
             (operation_row.target_subscription_snapshot ->> 'value')::numeric
           and coalesce((
             args.target_payment_observed ->> 'deleted'
           )::boolean, false) is false
           and args.target_payment_observed -> 'paymentDate' = 'null'::jsonb
           and args.target_payment_observed -> 'clientPaymentDate' = 'null'::jsonb
           and args.target_payment_observed -> 'confirmedDate' = 'null'::jsonb
           and args.target_payment_observed -> 'creditDate' = 'null'::jsonb
         ), false)
       )
    then
      raise exception 'billing_schedule_provider_reconciliation_mismatch';
    end if;

    select exists (
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
              payment.asaas_payment_id, ''
            )), '') = operation_row.old_payment_id
        and (
          nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') is null
          or nullif(pg_catalog.btrim(payment.asaas_id), '') =
            operation_row.old_payment_id
        )
        and nullif(pg_catalog.btrim(coalesce(
              payment.provider_customer_id, ''
            )), '') = operation_row.customer_id
        and payment.due_date =
          (operation_row.original_payment_snapshot ->> 'dueDate')::date
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.status, ''
            ))) = 'CANCELLED'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.provider_status, ''
            ))) = 'DELETED'
        and pg_catalog.round(payment.value, 2) = pg_catalog.round(
          (operation_row.original_payment_snapshot ->> 'value')::numeric,
          2
        )
        and payment.amount_cents = pg_catalog.round(
          (operation_row.original_payment_snapshot ->> 'value')::numeric * 100
        )::integer
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.billing_type, ''
            ))) = operation_row.original_payment_snapshot ->> 'billingType'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.payment_method, ''
            ))) = operation_row.original_payment_snapshot ->> 'billingType'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.payment_type, ''
            ))) = 'SUBSCRIPTION'
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
        and deleted_event.payload ->> 'id' = deleted_event.provider_event_id
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
    ) into old_local_reconciled;

    select pg_catalog.count(*)::integer
      into target_active_competence_count
    from public.student_payments as payment
    where payment.tenant_id = operation_row.tenant_id
      and payment.student_id = operation_row.student_id
      and pg_catalog.date_trunc('month', payment.due_date) =
        pg_catalog.date_trunc('month', operation_row.target_due_date)
      and not (
        pg_catalog.upper(pg_catalog.btrim(coalesce(
          payment.status, ''
        ))) in (
          'REFUNDED', 'CANCELLED', 'DELETED', 'CHARGEBACK',
          'CHARGEBACK_REQUESTED', 'RECEIVED_IN_CASH_UNDONE'
        )
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
          payment.provider_status, ''
        ))) in (
          'REFUNDED', 'CANCELLED', 'DELETED', 'CHARGEBACK',
          'CHARGEBACK_REQUESTED', 'RECEIVED_IN_CASH_UNDONE'
        )
      );

    if args.target_payment_id is null then
      target_local_count := 0;
    else
      select pg_catalog.count(*)::integer
        into target_local_count
      from public.student_payments as payment
      where payment.tenant_id = operation_row.tenant_id
        and payment.student_id = operation_row.student_id
        and payment.asaas_payment_id = args.target_payment_id
        and (
          nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '') is null
          or nullif(pg_catalog.btrim(payment.asaas_id), '') =
            args.target_payment_id
        )
        and payment.provider_customer_id = operation_row.customer_id
        and payment.due_date = operation_row.target_due_date
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
          payment.status, ''
        ))) = args.target_payment_observed ->> 'status'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
          payment.provider_status, ''
        ))) = args.target_payment_observed ->> 'status'
        and pg_catalog.round(payment.value, 2) = pg_catalog.round(
          (args.target_payment_observed ->> 'value')::numeric,
          2
        )
        and payment.amount_cents = pg_catalog.round(
          (args.target_payment_observed ->> 'value')::numeric * 100
        )::integer
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
          payment.billing_type, ''
        ))) = args.target_payment_observed ->> 'billingType'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
          payment.payment_method, ''
        ))) = args.target_payment_observed ->> 'billingType'
        and pg_catalog.upper(pg_catalog.btrim(coalesce(
          payment.payment_type, ''
        ))) = 'SUBSCRIPTION'
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
                )), '') = args.target_payment_id
             or nullif(pg_catalog.btrim(coalesce(
                  bound_payment.asaas_id,
                  ''
                )), '') = args.target_payment_id
        ) = 1;
    end if;

    if target_active_competence_count > 1 then
      raise exception 'billing_schedule_target_local_payment_duplicate';
    end if;
    if target_active_competence_count = 1 and target_local_count = 0 then
      raise exception 'billing_schedule_target_local_payment_mismatch';
    end if;

    update public.asaas_student_billing_schedule_corrections
    set status = case
          when args.target_payment_id is not null
            and target_local_count = 1
            and old_local_reconciled
            then 'COMPLETED'
          else 'AWAITING_TARGET_PAYMENT'
        end,
        completed_at = case
          when args.target_payment_id is not null
            and target_local_count = 1
            and old_local_reconciled
            then pg_catalog.clock_timestamp()
          else null
        end,
        last_error = case
          when args.target_payment_id is null
            then 'awaiting_provider_target_payment'
          when target_local_count = 0
            then 'awaiting_target_payment_webhook'
          when not old_local_reconciled
            then 'awaiting_old_payment_deletion_webhook'
          else null
        end,
        updated_at = pg_catalog.clock_timestamp()
    where id = operation_row.id;
  end if;
end
$reconcile_operation$;

select pg_catalog.jsonb_build_object('status', operation.status)
from public.asaas_student_billing_schedule_corrections as operation
where operation.operation_key = :'operation_key';

commit;
