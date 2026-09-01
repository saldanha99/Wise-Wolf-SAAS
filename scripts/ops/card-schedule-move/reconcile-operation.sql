begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table reconcile_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'subscription_observed'::jsonb as subscription_observed,
  :'payment_observed'::jsonb as payment_observed,
  :'subscription_payments'::jsonb as subscription_payments;

do $reconcile$
declare
  args reconcile_args%rowtype;
  operation_row public.asaas_student_card_schedule_moves%rowtype;
  restore_step public.asaas_student_card_schedule_move_steps%rowtype;
  target_local boolean := false;
  original_local boolean := false;
  target_webhook_causal boolean := false;
  restore_webhook_causal boolean := false;
  next_due date;
  target_month_count integer;
  next_month_count integer;
  next_payment_exact_count integer;
  payment_count integer;
  duplicate_month boolean;
  next_provider_payment_id text;
  next_payment_materialized boolean := true;
begin
  select * into strict args from reconcile_args;
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
     and operation.status in (
       'TARGET_SCHEDULED', 'AWAITING_LOCAL_RECONCILIATION',
       'RESTORING_ORIGINAL_PAYMENT'
     )
   for update;

  if private.student_card_schedule_local_guard_clear(
       operation_row.tenant_id,
       operation_row.student_id,
       operation_row.student_payment_id,
       operation_row.payment_id,
       operation_row.subscription_id,
       operation_row.integration_snapshot -> 'localGuardBaseline'
     ) is not true
  then
    raise exception 'student_card_schedule_move_local_backlog_present';
  end if;
  if private.student_card_schedule_membership_exact(
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
    raise exception 'student_card_schedule_move_local_scope_changed';
  end if;

  if operation_row.status = 'RESTORING_ORIGINAL_PAYMENT' then
    if args.subscription_observed is distinct from
         operation_row.original_subscription_snapshot
       or args.payment_observed is distinct from
         operation_row.original_payment_snapshot
       or args.subscription_payments is distinct from
         operation_row.original_payments_snapshot
       or exists (
         select 1
           from pg_catalog.jsonb_array_elements(args.subscription_payments)
             as item(payment)
          where item.payment ->> 'dueDate' is null
             or item.payment ->> 'originalDueDate' is null
             or pg_catalog.date_trunc(
                  'month', (item.payment ->> 'dueDate')::date
                ) = pg_catalog.date_trunc(
                  'month', operation_row.target_due_date
                )
             or pg_catalog.date_trunc(
                  'month', (item.payment ->> 'originalDueDate')::date
                ) = pg_catalog.date_trunc(
                  'month', operation_row.target_due_date
                )
       )
    then
      raise exception 'student_card_schedule_move_compensation_provider_mismatch';
    end if;

    select step.* into strict restore_step
      from public.asaas_student_card_schedule_move_steps as step
     where step.operation_id = operation_row.id
       and step.step_kind = 'RESTORE_ORIGINAL_PAYMENT';
    original_local := private.student_card_schedule_local_payment_exact(
      operation_row.student_payment_id,
      operation_row.tenant_id,
      operation_row.student_id,
      operation_row.payment_id,
      operation_row.customer_id,
      operation_row.old_due_date,
      operation_row.expected_value
    );
    restore_webhook_causal := restore_step.submit_attempt_count = 0
      or exists (
        select 1
          from public.student_payments as payment
          cross join public.asaas_webhook_inbox as inbox
         where payment.id = operation_row.student_payment_id
           and inbox.event_name = 'PAYMENT_UPDATED'
           and inbox.provider_entity_id = operation_row.payment_id
           and inbox.status = 'PROCESSED'
           and inbox.processed_at is not null
           and inbox.received_at >= restore_step.submitted_at
           and inbox.received_at <= operation_row.accept_events_until
           and inbox.payload #>> '{payment,id}' = operation_row.payment_id
           and inbox.payload #>> '{payment,customer}' =
             operation_row.customer_id
           and inbox.payload #>> '{payment,subscription}' =
             operation_row.subscription_id
           and inbox.payload #>> '{payment,dueDate}' =
             operation_row.old_due_date::text
      );

    if original_local and restore_webhook_causal then
      update public.profiles as profile
       set asaas_subscription_status = 'ACTIVE',
           asaas_subscription_end_date = operation_row.original_end_date,
             asaas_subscription_synced_at = pg_catalog.clock_timestamp()
       where profile.id = operation_row.student_id
         and profile.tenant_id = operation_row.tenant_id
         and profile.role = 'STUDENT'
         and nullif(pg_catalog.btrim(profile.asaas_customer_id), '') =
           operation_row.customer_id
         and nullif(pg_catalog.btrim(profile.subscription_id), '') =
           operation_row.subscription_id;
      if not found then
        raise exception 'student_card_schedule_move_profile_scope_changed';
      end if;
    end if;

    update public.asaas_student_card_schedule_moves
       set status = case when original_local and restore_webhook_causal
              then 'COMPENSATED'
              else 'RESTORING_ORIGINAL_PAYMENT'
            end,
           target_billing_claim_id = case
             when original_local and restore_webhook_causal then null
             else operation_row.target_billing_claim_id
           end,
           completed_at = case when original_local and restore_webhook_causal
              then pg_catalog.clock_timestamp()
              else null
            end,
           last_error = case when original_local and restore_webhook_causal
              then null
              else 'awaiting_original_payment_webhook'
            end,
           updated_at = pg_catalog.clock_timestamp()
     where id = operation_row.id;
    if original_local and restore_webhook_causal then
      delete from public.asaas_student_billing_period_claims as claim
       where claim.id = operation_row.target_billing_claim_id
         and claim.tenant_id = operation_row.tenant_id
         and claim.student_id = operation_row.student_id
         and claim.due_date = operation_row.target_due_date
         and claim.source = 'SUBSCRIPTION'
         and claim.source_key =
           'subscription:' || operation_row.offer_id::text
         and claim.request_fingerprint = operation_row.target_claim_fingerprint
         and claim.status = 'BOUND'
         and claim.provider_entity_id = operation_row.subscription_id;
      if not found then
        raise exception 'student_card_schedule_move_target_claim_release_failed';
      end if;
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(args.subscription_payments) <> 'array'
     or pg_catalog.jsonb_array_length(args.subscription_payments) > 100
     or (args.subscription_observed - 'nextDueDate') is distinct from
       (operation_row.target_subscription_snapshot - 'nextDueDate')
     or args.payment_observed is distinct from operation_row.target_payment_snapshot
  then
    raise exception 'student_card_schedule_move_target_provider_mismatch';
  end if;
  begin
    next_due := (args.subscription_observed ->> 'nextDueDate')::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'student_card_schedule_move_next_due_invalid';
  end;
  if next_due not in (
       operation_row.target_next_due_date,
       operation_row.original_next_due_date
     )
  then
    raise exception 'student_card_schedule_move_next_due_invalid';
  end if;

  if exists (
       select 1
         from pg_catalog.jsonb_array_elements(args.subscription_payments)
           as item(payment)
        where pg_catalog.jsonb_typeof(item.payment) <> 'object'
           or item.payment ->> 'customer' <> operation_row.customer_id
           or item.payment ->> 'subscription' <> operation_row.subscription_id
           or (
             nullif(pg_catalog.btrim(coalesce(
               item.payment ->> 'externalReference', ''
             )), '') is not null
             and item.payment ->> 'externalReference' <>
               'enrollment:' || operation_row.offer_id::text || ':subscription'
           )
           or coalesce((item.payment ->> 'deleted')::boolean, false)
           or item.payment ->> 'id' !~ '^pay_[A-Za-z0-9_-]{4,196}$'
           or item.payment ->> 'dueDate' !~ '^\d{4}-\d{2}-\d{2}$'
     )
  then
    raise exception 'student_card_schedule_move_payment_list_invalid';
  end if;

  select
    pg_catalog.count(*) filter (
      where item.payment ->> 'id' = operation_row.payment_id
        and item.payment ->> 'dueDate' = operation_row.target_due_date::text
        and item.payment ->> 'originalDueDate' = operation_row.old_due_date::text
        and item.payment ->> 'status' = 'PENDING'
        and item.payment ->> 'billingType' = 'CREDIT_CARD'
        and (
          nullif(pg_catalog.btrim(coalesce(
            item.payment ->> 'externalReference', ''
          )), '') is null
          or item.payment ->> 'externalReference' =
            'enrollment:' || operation_row.offer_id::text || ':subscription'
        )
        and (item.payment ->> 'value')::numeric = operation_row.expected_value
    ),
    pg_catalog.count(*) filter (
      where pg_catalog.date_trunc(
              'month', (item.payment ->> 'dueDate')::date
            ) = pg_catalog.date_trunc(
              'month', operation_row.target_next_due_date
            )
    ),
    pg_catalog.count(*) filter (
      where item.payment ->> 'dueDate' =
            operation_row.target_next_due_date::text
        and item.payment ->> 'originalDueDate' =
            operation_row.target_next_due_date::text
        and item.payment ->> 'status' = 'PENDING'
        and item.payment ->> 'billingType' = 'CREDIT_CARD'
        and (item.payment ->> 'value')::numeric = operation_row.expected_value
    ),
    pg_catalog.count(*)
    into target_month_count, next_month_count,
         next_payment_exact_count, payment_count
    from pg_catalog.jsonb_array_elements(args.subscription_payments)
      as item(payment);

  if next_due = operation_row.original_next_due_date then
    select pg_catalog.min(item.payment ->> 'id')
      into next_provider_payment_id
      from pg_catalog.jsonb_array_elements(args.subscription_payments)
        as item(payment)
     where pg_catalog.date_trunc(
             'month', (item.payment ->> 'dueDate')::date
           ) = pg_catalog.date_trunc(
             'month', operation_row.target_next_due_date
           );

    next_payment_materialized :=
      next_month_count = 1
      and next_provider_payment_id is not null
      and exists (
        select 1
          from public.student_payments as payment
          join public.asaas_student_card_schedule_move_steps as target_step
            on target_step.operation_id = operation_row.id
           and target_step.step_kind = 'UPDATE_TARGET_SCHEDULE'
          cross join public.asaas_webhook_inbox as inbox
         where payment.tenant_id = operation_row.tenant_id
           and payment.student_id = operation_row.student_id
           and private.student_card_schedule_local_payment_exact(
             payment.id,
             operation_row.tenant_id,
             operation_row.student_id,
             next_provider_payment_id,
             operation_row.customer_id,
             operation_row.target_next_due_date,
             operation_row.expected_value
           )
           and target_step.status = 'SUCCEEDED'
           and target_step.submit_attempt_count = 1
           and target_step.submitted_at is not null
           and inbox.event_name in ('PAYMENT_CREATED', 'PAYMENT_UPDATED')
           and inbox.provider_entity_id = next_provider_payment_id
           and inbox.status = 'PROCESSED'
           and inbox.processed_at is not null
           and inbox.received_at >= target_step.submitted_at
           and inbox.received_at <= operation_row.accept_events_until
           and inbox.payload #>> '{payment,id}' = next_provider_payment_id
           and inbox.payload #>> '{payment,customer}' =
             operation_row.customer_id
           and inbox.payload #>> '{payment,subscription}' =
             operation_row.subscription_id
           and inbox.payload #>> '{payment,dueDate}' =
             operation_row.target_next_due_date::text
      )
      and (select pg_catalog.count(*)
             from public.asaas_student_billing_period_claims as claim
            where claim.tenant_id = operation_row.tenant_id
              and claim.student_id = operation_row.student_id
              and claim.due_date = operation_row.target_next_due_date
              and claim.source = 'SUBSCRIPTION'
              and claim.source_key =
                'subscription:' || operation_row.offer_id::text
              and claim.status = 'BOUND'
              and claim.provider_entity_id =
                operation_row.subscription_id) = 1;
  end if;

  select exists (
    select 1
      from (
        select pg_catalog.date_trunc(
                 'month', (item.payment ->> 'dueDate')::date
               ) as competence,
               pg_catalog.count(*) as payment_count
          from pg_catalog.jsonb_array_elements(args.subscription_payments)
            as item(payment)
         group by 1
        having pg_catalog.count(*) > 1
      ) as duplicate
  ) into duplicate_month;

  if target_month_count <> 1
     or duplicate_month
     or (next_due = operation_row.original_next_due_date
       and (next_month_count <> 1 or next_payment_exact_count <> 1
         or payment_count <> 2))
     or (next_due = operation_row.target_next_due_date
       and (next_month_count <> 0 or payment_count <> 1))
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements(args.subscription_payments)
           as item(payment)
        where (item.payment ->> 'dueDate')::date > operation_row.target_end_date
     )
  then
    raise exception 'student_card_schedule_move_twelve_payment_sequence_invalid';
  end if;

  target_local := private.student_card_schedule_local_payment_exact(
    operation_row.student_payment_id,
    operation_row.tenant_id,
    operation_row.student_id,
    operation_row.payment_id,
    operation_row.customer_id,
    operation_row.target_due_date,
    operation_row.expected_value
  );
  target_webhook_causal := exists (
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
       and inbox.payload #>> '{payment,customer}' =
         operation_row.customer_id
       and inbox.payload #>> '{payment,subscription}' =
         operation_row.subscription_id
       and inbox.payload #>> '{payment,dueDate}' =
         operation_row.target_due_date::text
  );

  if target_local and target_webhook_causal and next_payment_materialized then
    update public.profiles as profile
       set asaas_subscription_status = 'ACTIVE',
           asaas_subscription_end_date = operation_row.target_end_date,
           asaas_subscription_synced_at = pg_catalog.clock_timestamp()
     where profile.id = operation_row.student_id
       and profile.tenant_id = operation_row.tenant_id
       and profile.role = 'STUDENT'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             profile.lifecycle_status, ''
           ))) = 'active'
       and nullif(pg_catalog.btrim(profile.asaas_customer_id), '') =
         operation_row.customer_id
       and nullif(pg_catalog.btrim(profile.subscription_id), '') =
         operation_row.subscription_id;
    if not found then
      raise exception 'student_card_schedule_move_profile_scope_changed';
    end if;
  end if;

  update public.asaas_student_card_schedule_moves
     set status = case when target_local and target_webhook_causal
                            and next_payment_materialized
            then 'COMPLETED'
            else 'AWAITING_LOCAL_RECONCILIATION'
          end,
         completed_at = case when target_local and target_webhook_causal
                                  and next_payment_materialized
            then pg_catalog.clock_timestamp()
            else null
          end,
         last_error = case when target_local and target_webhook_causal
                                and next_payment_materialized
            then null
            when not next_payment_materialized
              then 'awaiting_next_payment_materialization'
            else 'awaiting_target_payment_webhook'
          end,
         updated_at = pg_catalog.clock_timestamp()
   where id = operation_row.id;
end
$reconcile$;

select pg_catalog.jsonb_build_object('status', operation.status)
from public.asaas_student_card_schedule_moves as operation
where operation.operation_key = :'operation_key';

commit;
