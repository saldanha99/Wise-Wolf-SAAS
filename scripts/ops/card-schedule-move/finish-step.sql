begin;
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create temporary table finish_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'subscription_id'::text as subscription_id,
  :'step_kind'::text as step_kind,
  :'step_status'::text as step_status,
  :'observed_after'::jsonb as observed_after,
  :'subscription_payments'::jsonb as subscription_payments,
  :'provider_response'::jsonb as provider_response,
  nullif(:'provider_http_status', '')::integer as provider_http_status,
  nullif(:'last_error', '')::text as last_error;

do $finish$
declare
  args finish_args%rowtype;
  operation_row public.asaas_student_card_schedule_moves%rowtype;
  step_row public.asaas_student_card_schedule_move_steps%rowtype;
  next_status text;
  success_matches boolean := false;
  observed_next_due date;
  target_payment_count integer := 0;
  next_payment_count integer := 0;
  next_payment_exact_count integer := 0;
  payment_count integer := 0;
  duplicate_month boolean := false;
  invalid_payment_list boolean := true;
begin
  select * into strict args from finish_args;
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

  success_matches := args.observed_after is not distinct from
    step_row.desired_after;
  if args.step_kind = 'UPDATE_TARGET_SCHEDULE'
     and args.step_status = 'SUCCEEDED'
     and pg_catalog.jsonb_typeof(args.subscription_payments) = 'array'
     and pg_catalog.jsonb_array_length(args.subscription_payments) <= 100
     and (args.observed_after - 'nextDueDate') is not distinct from
       (step_row.desired_after - 'nextDueDate')
     and args.observed_after ->> 'id' = operation_row.subscription_id
     and args.observed_after ->> 'customer' = operation_row.customer_id
     and args.observed_after ->> 'status' = 'ACTIVE'
     and args.observed_after ->> 'billingType' = 'CREDIT_CARD'
     and args.observed_after ->> 'cycle' = 'MONTHLY'
     and args.observed_after ->> 'externalReference' =
       'enrollment:' || operation_row.offer_id::text || ':subscription'
     and args.observed_after ->> 'endDate' =
       operation_row.target_end_date::text
     and args.observed_after -> 'value' =
       pg_catalog.to_jsonb(operation_row.expected_value)
     and args.observed_after -> 'maxPayments' =
       pg_catalog.to_jsonb(operation_row.expected_max_payments)
     and args.observed_after -> 'cardAttached' = 'true'::jsonb
  then
    select exists (
      select 1
        from pg_catalog.jsonb_array_elements(args.subscription_payments)
          as item(payment)
       where pg_catalog.jsonb_typeof(item.payment) <> 'object'
          or item.payment ->> 'customer' is distinct from
            operation_row.customer_id
          or item.payment ->> 'subscription' is distinct from
            operation_row.subscription_id
          or coalesce(item.payment ->> 'id', '') !~
            '^pay_[A-Za-z0-9_-]{4,196}$'
          or item.payment ->> 'status' is distinct from 'PENDING'
          or item.payment ->> 'billingType' is distinct from 'CREDIT_CARD'
          or item.payment -> 'value' is distinct from
            pg_catalog.to_jsonb(operation_row.expected_value)
          or item.payment -> 'deleted' is distinct from 'false'::jsonb
          or coalesce(item.payment ->> 'dueDate', '') !~
            '^\d{4}-\d{2}-\d{2}$'
          or coalesce(item.payment ->> 'originalDueDate', '') !~
            '^\d{4}-\d{2}-\d{2}$'
          or (
            nullif(pg_catalog.btrim(coalesce(
              item.payment ->> 'externalReference', ''
            )), '') is not null
            and item.payment ->> 'externalReference' <>
              'enrollment:' || operation_row.offer_id::text || ':subscription'
          )
    ) into invalid_payment_list;
    if not invalid_payment_list then
      begin
        observed_next_due := (args.observed_after ->> 'nextDueDate')::date;
      exception when invalid_datetime_format or datetime_field_overflow then
        observed_next_due := null;
      end;
      select
        pg_catalog.count(*) filter (
        where item.payment ->> 'id' = operation_row.payment_id
          and item.payment ->> 'dueDate' = operation_row.target_due_date::text
          and item.payment ->> 'originalDueDate' =
            operation_row.old_due_date::text
          and item.payment ->> 'status' = 'PENDING'
          and item.payment ->> 'billingType' = 'CREDIT_CARD'
          and (
            nullif(pg_catalog.btrim(coalesce(
              item.payment ->> 'externalReference', ''
            )), '') is null
            or item.payment ->> 'externalReference' =
              'enrollment:' || operation_row.offer_id::text || ':subscription'
          )
          and item.payment -> 'value' =
            pg_catalog.to_jsonb(operation_row.expected_value)
      ),
      pg_catalog.count(*) filter (
        where pg_catalog.left(item.payment ->> 'dueDate', 7) =
              pg_catalog.left(operation_row.target_next_due_date::text, 7)
      ),
      pg_catalog.count(*) filter (
        where item.payment ->> 'dueDate' =
              operation_row.target_next_due_date::text
          and item.payment ->> 'originalDueDate' =
              operation_row.target_next_due_date::text
          and item.payment ->> 'status' = 'PENDING'
          and item.payment ->> 'billingType' = 'CREDIT_CARD'
          and item.payment -> 'value' =
            pg_catalog.to_jsonb(operation_row.expected_value)
          and (
            nullif(pg_catalog.btrim(coalesce(
              item.payment ->> 'externalReference', ''
            )), '') is null
            or item.payment ->> 'externalReference' =
              'enrollment:' || operation_row.offer_id::text || ':subscription'
          )
      ),
      pg_catalog.count(*)
      into target_payment_count, next_payment_count,
           next_payment_exact_count, payment_count
        from pg_catalog.jsonb_array_elements(args.subscription_payments)
          as item(payment);
      select exists (
        select 1
          from (
            select pg_catalog.left(item.payment ->> 'dueDate', 7)
                     as competence
              from pg_catalog.jsonb_array_elements(args.subscription_payments)
                as item(payment)
             group by 1
            having pg_catalog.count(*) > 1
          ) as duplicate
      ) into duplicate_month;
      success_matches := target_payment_count = 1
        and not duplicate_month
        and (
          (observed_next_due = operation_row.target_next_due_date
            and next_payment_count = 0 and payment_count = 1)
          or (observed_next_due = operation_row.original_next_due_date
            and next_payment_count = 1 and next_payment_exact_count = 1
            and payment_count = 2)
        );
    end if;
  end if;

  if step_row.status not in ('SUBMITTING', 'UNKNOWN')
     or step_row.submit_attempt_count <> 1
     or args.step_status not in ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'BLOCKED')
     or pg_catalog.jsonb_typeof(args.observed_after) <> 'object'
     or pg_catalog.jsonb_typeof(args.provider_response) <> 'object'
     or (args.step_status = 'SUCCEEDED' and not success_matches)
     or (
       args.step_status = 'SUCCEEDED'
       and args.step_kind in (
         'MOVE_PAYMENT_TO_TARGET', 'RESTORE_ORIGINAL_SCHEDULE'
       )
       and args.subscription_payments is distinct from
         pg_catalog.jsonb_build_array(operation_row.target_payment_snapshot)
     )
     or (
       args.step_status = 'SUCCEEDED'
       and args.step_kind = 'RESTORE_ORIGINAL_PAYMENT'
       and args.subscription_payments is distinct from
         operation_row.original_payments_snapshot
     )
     or (args.step_status = 'FAILED'
       and args.observed_after is distinct from step_row.expected_before)
     or (
       args.step_kind = 'UPDATE_TARGET_SCHEDULE'
       and args.step_status = 'FAILED'
       and (
         args.subscription_payments is distinct from
           pg_catalog.jsonb_build_array(operation_row.target_payment_snapshot)
         or not private.student_card_schedule_local_payment_exact(
           operation_row.student_payment_id,
           operation_row.tenant_id,
           operation_row.student_id,
           operation_row.payment_id,
           operation_row.customer_id,
           operation_row.target_due_date,
           operation_row.expected_value
         )
       )
     )
     or (
       args.step_kind = 'MOVE_PAYMENT_TO_TARGET'
       and args.step_status = 'FAILED'
       and (
         args.subscription_payments is distinct from
           operation_row.original_payments_snapshot
         or not private.student_card_schedule_local_payment_exact(
           operation_row.student_payment_id,
           operation_row.tenant_id,
           operation_row.student_id,
           operation_row.payment_id,
           operation_row.customer_id,
           operation_row.old_due_date,
           operation_row.expected_value
         )
         or exists (
           select 1
             from public.asaas_webhook_inbox as inbox
            where inbox.event_name in ('PAYMENT_CREATED', 'PAYMENT_UPDATED')
              and inbox.provider_entity_id = operation_row.payment_id
              and inbox.received_at >= step_row.submitted_at
              and inbox.payload #>> '{payment,id}' = operation_row.payment_id
              and inbox.payload #>> '{payment,customer}' =
                operation_row.customer_id
              and inbox.payload #>> '{payment,subscription}' =
                operation_row.subscription_id
              and inbox.payload #>> '{payment,dueDate}' =
                operation_row.target_due_date::text
         )
       )
     )
     or (
       args.step_status = 'FAILED'
       and args.step_kind in (
         'MOVE_PAYMENT_TO_TARGET', 'UPDATE_TARGET_SCHEDULE'
       )
       and private.student_card_schedule_local_guard_clear(
         operation_row.tenant_id,
         operation_row.student_id,
         operation_row.student_payment_id,
         operation_row.payment_id,
         operation_row.subscription_id,
         operation_row.integration_snapshot -> 'localGuardBaseline'
       ) is not true
     )
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
  then
    raise exception 'student_card_schedule_move_finish_fence_refused';
  end if;

  next_status := case
    when args.step_status = 'UNKNOWN' then 'UNKNOWN'
    when args.step_status = 'BLOCKED' then 'BLOCKED'
    when args.step_kind = 'MOVE_PAYMENT_TO_TARGET'
      and args.step_status = 'SUCCEEDED' then 'PAYMENT_MOVED'
    when args.step_kind = 'MOVE_PAYMENT_TO_TARGET'
      and args.step_status = 'FAILED' then 'FAILED'
    when args.step_kind = 'UPDATE_TARGET_SCHEDULE'
      and args.step_status = 'SUCCEEDED' then 'TARGET_SCHEDULED'
    when args.step_kind = 'UPDATE_TARGET_SCHEDULE'
      and args.step_status = 'FAILED' then 'COMPENSATING'
    when args.step_kind = 'RESTORE_ORIGINAL_SCHEDULE'
      and args.step_status = 'SUCCEEDED' then 'ORIGINAL_SCHEDULE_RESTORED'
    when args.step_kind = 'RESTORE_ORIGINAL_SCHEDULE'
      and args.step_status = 'FAILED' then 'BLOCKED'
    when args.step_kind = 'RESTORE_ORIGINAL_PAYMENT'
      and args.step_status = 'SUCCEEDED' then 'RESTORING_ORIGINAL_PAYMENT'
    when args.step_kind = 'RESTORE_ORIGINAL_PAYMENT'
      and args.step_status = 'FAILED' then 'BLOCKED'
    else null
  end;
  if next_status is null then
    raise exception 'student_card_schedule_move_finish_transition_invalid';
  end if;

  update public.asaas_student_card_schedule_move_steps
     set status = args.step_status,
         provider_response = coalesce(
           step_row.provider_response,
           args.provider_response
         ),
         provider_http_status = coalesce(
           step_row.provider_http_status,
           args.provider_http_status
         ),
         observed_state = args.observed_after,
         completed_at = case
           when args.step_status in ('SUCCEEDED', 'FAILED', 'BLOCKED')
             then coalesce(step_row.completed_at, pg_catalog.clock_timestamp())
           else null
         end,
         last_error = args.last_error,
         updated_at = pg_catalog.clock_timestamp()
   where id = step_row.id;

  update public.asaas_student_card_schedule_moves
     set status = next_status,
         target_billing_claim_id = case when next_status = 'FAILED'
           then null
           else operation_row.target_billing_claim_id
         end,
         completed_at = case when next_status = 'FAILED'
           then pg_catalog.clock_timestamp()
           else null
         end,
         last_error = args.last_error,
         updated_at = pg_catalog.clock_timestamp()
   where id = operation_row.id;

  if next_status = 'FAILED' then
    delete from public.asaas_student_billing_period_claims as claim
     where claim.id = operation_row.target_billing_claim_id
       and claim.tenant_id = operation_row.tenant_id
       and claim.student_id = operation_row.student_id
       and claim.due_date = operation_row.target_due_date
       and claim.source = 'SUBSCRIPTION'
       and claim.source_key = 'subscription:' || operation_row.offer_id::text
       and claim.request_fingerprint = operation_row.target_claim_fingerprint
       and claim.status = 'BOUND'
       and claim.provider_entity_id = operation_row.subscription_id;
    if not found then
      raise exception 'student_card_schedule_move_target_claim_release_failed';
    end if;
  end if;
end
$finish$;

select pg_catalog.jsonb_build_object(
  'status', operation.status,
  'stepStatus', step.status
)
from public.asaas_student_card_schedule_moves as operation
join public.asaas_student_card_schedule_move_steps as step
  on step.operation_id = operation.id
where operation.operation_key = :'operation_key'
  and step.step_kind = :'step_kind';

commit;
