begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temporary table move_args on commit drop as
select
  :'operation_key'::text as operation_key,
  :'tenant_id'::text as tenant_id,
  :'student_id'::uuid as student_id,
  :'offer_id'::uuid as offer_id,
  :'customer_id'::text as customer_id,
  :'subscription_id'::text as subscription_id,
  :'old_payment_id'::text as payment_id,
  :'old_student_payment_id'::uuid as student_payment_id,
  :'old_due_date'::date as old_due_date,
  :'target_due_date'::date as target_due_date,
  :'old_due_date'::date as target_next_due_date,
  :'original_next_due_date'::date as original_next_due_date,
  :'target_end_date'::date as target_end_date,
  :'original_end_date'::date as original_end_date,
  :'expected_value'::numeric as expected_value,
  :'expected_max_payments'::integer as expected_max_payments,
  :'accept_events_until'::timestamptz as accept_events_until,
  :'original_subscription_snapshot'::jsonb as original_subscription_snapshot,
  :'original_payment_snapshot'::jsonb as original_payment_snapshot,
  :'original_payments_snapshot'::jsonb as original_payments_snapshot,
  :'integration_snapshot'::jsonb as integration_snapshot;

do $prepare$
declare
  args move_args%rowtype;
  operation_id uuid := gen_random_uuid();
  claim_id uuid := gen_random_uuid();
  claim_fingerprint text;
  target_subscription jsonb;
  target_payment jsonb;
  descriptor jsonb;
  step_kind text;
  route_kind text;
  ordinal smallint;
  expected_before jsonb;
  desired_after jsonb;
  request_fingerprint text;
  lock_month date;
begin
  select * into strict args from move_args;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-membership-user:' || args.student_id::text,
      0
    )
  );
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
  for lock_month in
    select candidate.month_start
      from (values
        (pg_catalog.date_trunc('month', args.old_due_date)::date),
        (pg_catalog.date_trunc('month', args.target_due_date)::date)
      ) as candidate(month_start)
     group by candidate.month_start
     order by candidate.month_start
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-period-month:' || args.tenant_id || ':' ||
          args.student_id::text || ':' || lock_month::text,
        0
      )
    );
  end loop;

  -- Freeze every mutable local row used by the decision. Advisory locks fence
  -- cooperating workflows; row locks also close races with ordinary writers.
  perform 1
    from public.profiles as profile
   where profile.id = args.student_id
     and profile.tenant_id = args.tenant_id
   for update;
  perform 1
    from public.tenant_memberships as membership
   where membership.user_id = args.student_id
   order by membership.tenant_id
   for share;
  perform 1
    from public.offers as offer
   where offer.id = args.offer_id
     and offer.tenant_id = args.tenant_id
   for share;
  perform 1
    from public.student_payments as payment
   where payment.id = args.student_payment_id
     and payment.tenant_id = args.tenant_id
   for update;
  perform 1
    from public.asaas_student_billing_period_claims as claim
   where claim.tenant_id = args.tenant_id
     and claim.student_id = args.student_id
     and claim.due_date = args.old_due_date
     and claim.source = 'SUBSCRIPTION'
   for update;
  perform 1
    from private.tenant_integration_connections as connection
   where connection.id::text =
         args.integration_snapshot ->> 'integrationId'
     and connection.tenant_id = args.tenant_id
     and connection.provider = 'asaas'
   for share;
  perform 1
    from public.asaas_webhook_inbox as inbox
   where inbox.provider_entity_id in (args.payment_id, args.subscription_id)
      or inbox.payload #>> '{payment,id}' = args.payment_id
      or inbox.payload #>> '{payment,subscription}' = args.subscription_id
      or inbox.payload #>> '{subscription,id}' = args.subscription_id
   order by inbox.provider_event_id
   for share;
  perform 1
    from public.asaas_reconciliation_issues as issue
   where issue.resolved_at is null
     and (issue.tenant_id = args.tenant_id or issue.tenant_id is null)
     and (
       issue.provider_entity_id in (args.payment_id, args.subscription_id)
       or issue.local_entity_id in (
         args.student_id::text, args.student_payment_id::text
       )
     )
   order by issue.id
   for share;
  perform 1
    from public.reconciliation_issues as issue
   where issue.tenant_id = args.tenant_id
     and issue.student_payment_id = args.student_payment_id
     and coalesce(issue.resolved, false) is false
     and issue.resolved_at is null
   order by issue.id
   for share;

  if args.target_due_date + interval '1 month' <>
       args.old_due_date::timestamp
     or args.target_next_due_date <> args.old_due_date
     or args.old_due_date + interval '1 month' <>
       args.original_next_due_date::timestamp
     or args.target_end_date + interval '1 month' <>
       args.original_end_date::timestamp
     or args.expected_max_payments <> 12
     or args.accept_events_until <= pg_catalog.clock_timestamp()
     or args.original_subscription_snapshot ->> 'id' <>
       args.subscription_id
     or args.original_subscription_snapshot ->> 'customer' <>
       args.customer_id
     or args.original_subscription_snapshot ->> 'status' <> 'ACTIVE'
     or args.original_subscription_snapshot ->> 'billingType' <>
       'CREDIT_CARD'
     or args.original_subscription_snapshot ->> 'cycle' <> 'MONTHLY'
     or args.original_subscription_snapshot -> 'cardAttached' <>
       'true'::jsonb
     or (args.original_subscription_snapshot ->> 'value')::numeric <>
       args.expected_value
     or (args.original_subscription_snapshot ->> 'maxPayments')::integer <>
       args.expected_max_payments
     or args.original_subscription_snapshot ->> 'nextDueDate' <>
       args.original_next_due_date::text
     or args.original_subscription_snapshot ->> 'endDate' <>
       args.original_end_date::text
     or args.original_payment_snapshot ->> 'id' <> args.payment_id
     or args.original_payment_snapshot ->> 'customer' <> args.customer_id
     or args.original_payment_snapshot ->> 'subscription' <>
       args.subscription_id
     or args.original_payment_snapshot ->> 'status' <> 'PENDING'
     or args.original_payment_snapshot ->> 'billingType' <> 'CREDIT_CARD'
     or (
       nullif(pg_catalog.btrim(coalesce(
         args.original_payment_snapshot ->> 'externalReference', ''
       )), '') is not null
       and args.original_payment_snapshot ->> 'externalReference' <>
         'enrollment:' || args.offer_id::text || ':subscription'
     )
     or (args.original_payment_snapshot ->> 'value')::numeric <>
       args.expected_value
     or args.original_payment_snapshot ->> 'dueDate' <>
       args.old_due_date::text
     or args.original_payment_snapshot ->> 'originalDueDate' <>
       args.old_due_date::text
     or coalesce((args.original_payment_snapshot ->> 'deleted')::boolean, false)
     or args.original_payment_snapshot -> 'paymentDate' <> 'null'::jsonb
     or args.original_payment_snapshot -> 'clientPaymentDate' <> 'null'::jsonb
     or args.original_payment_snapshot -> 'confirmedDate' <> 'null'::jsonb
     or args.original_payment_snapshot -> 'creditDate' <> 'null'::jsonb
     or args.original_payments_snapshot is distinct from
       pg_catalog.jsonb_build_array(args.original_payment_snapshot)
     or pg_catalog.jsonb_typeof(args.integration_snapshot) <> 'object'
     or args.integration_snapshot = '{}'::jsonb
     or args.integration_snapshot -> 'profileSnapshot' is distinct from
       private.student_card_schedule_profile_snapshot(
         args.tenant_id, args.student_id
       )
     or args.integration_snapshot -> 'localGuardBaseline' is distinct from
       private.student_card_schedule_local_guard_baseline(
         args.tenant_id,
         args.student_id,
         args.student_payment_id,
         args.payment_id,
         args.subscription_id
       )
  then
    raise exception 'student_card_schedule_move_snapshot_invalid';
  end if;

  if exists (
       select 1
         from public.asaas_student_card_schedule_moves as operation
        where operation.operation_key = args.operation_key
           or (
             operation.tenant_id = args.tenant_id
             and operation.subscription_id = args.subscription_id
             and operation.status not in ('COMPLETED', 'COMPENSATED', 'FAILED')
           )
     )
  then
    raise exception 'student_card_schedule_move_operation_exists';
  end if;

  -- Revalidate every mutable local invariant inside the same transaction that
  -- freezes the operation and target month claim.
  if private.student_card_schedule_profile_exact(
       args.tenant_id,
       args.student_id,
       args.customer_id,
       args.subscription_id,
       args.expected_value,
       args.target_due_date,
       args.original_end_date,
       args.integration_snapshot -> 'profileSnapshot'
     ) is not true
     or exists (
       select 1
         from public.profiles as profile
        where profile.id = args.student_id
          and profile.tenant_id = args.tenant_id
          and coalesce(profile.is_test_account, false)
     )
     or not private.student_subscription_mutation_scope_before_card_move(
       args.tenant_id,
       args.student_id,
       args.customer_id,
       args.subscription_id
     )
     or exists (
       select 1
         from public.asaas_subscription_mutation_operations as mutation
        where mutation.tenant_id = args.tenant_id
          and mutation.student_id = args.student_id
          and mutation.subscription_id = args.subscription_id
          and mutation.status in (
            'CLAIMED', 'SUBMITTING', 'UNKNOWN', 'BLOCKED'
          )
     )
     or (select pg_catalog.count(*)
           from public.tenant_memberships as membership
          where membership.user_id = args.student_id) <> 1
     or not exists (
       select 1
         from public.tenant_memberships as membership
        where membership.user_id = args.student_id
          and membership.tenant_id = args.tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
     or not exists (
       select 1
         from public.offers as offer
        where offer.id = args.offer_id
          and offer.tenant_id = args.tenant_id
          and offer.kind = 'ENROLLMENT'
          and args.student_id in (offer.processing_by, offer.consumed_by)
          and (offer.processing_by is null
            or offer.processing_by = args.student_id)
          and (offer.consumed_by is null
            or offer.consumed_by = args.student_id)
     )
     or not private.student_card_schedule_local_payment_exact(
       args.student_payment_id,
       args.tenant_id,
       args.student_id,
       args.payment_id,
       args.customer_id,
       args.old_due_date,
       args.expected_value
     )
     or not exists (
       select 1
         from public.asaas_student_billing_period_claims as claim
        where claim.tenant_id = args.tenant_id
          and claim.student_id = args.student_id
          and claim.due_date = args.old_due_date
          and claim.source = 'SUBSCRIPTION'
          and claim.source_key = 'subscription:' || args.offer_id::text
          and claim.status = 'BOUND'
          and claim.provider_entity_id = args.subscription_id
     )
     or exists (
       select 1
         from public.asaas_student_billing_period_claims as claim
        where claim.tenant_id = args.tenant_id
          and claim.student_id = args.student_id
          and pg_catalog.date_trunc('month', claim.due_date) =
            pg_catalog.date_trunc('month', args.target_due_date)
     )
     or exists (
       select 1
         from public.student_payments as payment
        where payment.tenant_id = args.tenant_id
          and payment.student_id = args.student_id
          and pg_catalog.date_trunc('month', payment.due_date) =
            pg_catalog.date_trunc('month', args.target_due_date)
     )
     or not exists (
       select 1
         from private.tenant_integration_connections as connection
        where connection.id::text =
              args.integration_snapshot ->> 'integrationId'
          and connection.tenant_id = args.tenant_id
          and connection.provider = 'asaas'
          and connection.version::text =
              args.integration_snapshot ->> 'version'
          and connection.mode = args.integration_snapshot ->> 'mode'
          and connection.mode <> 'DISABLED'
          and connection.status in ('configured', 'healthy')
     )
     or private.student_card_schedule_local_guard_clear(
       args.tenant_id,
       args.student_id,
       args.student_payment_id,
       args.payment_id,
       args.subscription_id,
       args.integration_snapshot -> 'localGuardBaseline'
     ) is not true
  then
    raise exception 'student_card_schedule_move_local_fence_refused';
  end if;

  target_subscription := args.original_subscription_snapshot ||
    pg_catalog.jsonb_build_object(
      'nextDueDate', args.target_next_due_date::text,
      'endDate', args.target_end_date::text
    );
  target_payment := pg_catalog.jsonb_set(
    args.original_payment_snapshot,
    '{dueDate}',
    pg_catalog.to_jsonb(args.target_due_date::text),
    false
  );

  claim_fingerprint := private.student_card_schedule_move_fingerprint(
    args.operation_key,
    args.tenant_id,
    args.student_id,
    args.offer_id,
    args.customer_id,
    args.subscription_id,
    args.payment_id,
    args.old_due_date,
    args.target_due_date,
    args.target_next_due_date,
    args.original_next_due_date,
    args.target_end_date,
    args.original_end_date,
    args.expected_value,
    args.expected_max_payments
  );

  insert into public.asaas_student_billing_period_claims (
    id, tenant_id, student_id, due_date, source, source_key,
    request_fingerprint, status, claim_token, lease_expires_at,
    submit_attempt_count, provider_entity_id, updated_at
  ) values (
    claim_id, args.tenant_id, args.student_id, args.target_due_date,
    'SUBSCRIPTION', 'subscription:' || args.offer_id::text,
    claim_fingerprint, 'BOUND', operation_id, args.accept_events_until,
    1, args.subscription_id, pg_catalog.clock_timestamp()
  );

  insert into public.asaas_student_card_schedule_moves (
    id, operation_key, tenant_id, student_id, offer_id,
    student_payment_id, target_billing_claim_id, target_claim_fingerprint,
    customer_id,
    subscription_id, payment_id, old_due_date, target_due_date,
    target_next_due_date, original_next_due_date, target_end_date,
    original_end_date, expected_value, expected_max_payments,
    original_subscription_snapshot, target_subscription_snapshot,
    original_payment_snapshot, target_payment_snapshot,
    original_payments_snapshot,
    integration_snapshot, status, accept_events_until
  ) values (
    operation_id, args.operation_key, args.tenant_id, args.student_id,
    args.offer_id, args.student_payment_id, claim_id, claim_fingerprint,
    args.customer_id,
    args.subscription_id, args.payment_id, args.old_due_date,
    args.target_due_date, args.target_next_due_date,
    args.original_next_due_date, args.target_end_date,
    args.original_end_date, args.expected_value,
    args.expected_max_payments, args.original_subscription_snapshot,
    target_subscription, args.original_payment_snapshot, target_payment,
    args.original_payments_snapshot,
    args.integration_snapshot, 'READY', args.accept_events_until
  );

  for step_kind, route_kind, ordinal in
    values
      ('MOVE_PAYMENT_TO_TARGET'::text, 'TARGET'::text, 10::smallint),
      ('UPDATE_TARGET_SCHEDULE'::text, 'TARGET'::text, 20::smallint),
      ('RESTORE_ORIGINAL_SCHEDULE'::text, 'COMPENSATION'::text, 30::smallint),
      ('RESTORE_ORIGINAL_PAYMENT'::text, 'COMPENSATION'::text, 40::smallint)
  loop
    case step_kind
      when 'MOVE_PAYMENT_TO_TARGET' then
        expected_before := args.original_payment_snapshot;
        desired_after := target_payment;
        descriptor := pg_catalog.jsonb_build_object(
          'method', 'PUT',
          'path', '/payments/' || args.payment_id,
          'body', pg_catalog.jsonb_build_object(
            'billingType', 'CREDIT_CARD',
            'value', args.expected_value,
            'dueDate', args.target_due_date::text
          )
        );
      when 'UPDATE_TARGET_SCHEDULE' then
        expected_before := args.original_subscription_snapshot;
        desired_after := target_subscription;
        descriptor := pg_catalog.jsonb_build_object(
          'method', 'PUT',
          'path', '/subscriptions/' || args.subscription_id,
          'body', pg_catalog.jsonb_build_object(
            'nextDueDate', args.target_next_due_date::text,
            'endDate', args.target_end_date::text
          )
        );
      when 'RESTORE_ORIGINAL_SCHEDULE' then
        expected_before := target_subscription;
        desired_after := args.original_subscription_snapshot;
        descriptor := pg_catalog.jsonb_build_object(
          'method', 'PUT',
          'path', '/subscriptions/' || args.subscription_id,
          'body', pg_catalog.jsonb_build_object(
            'nextDueDate', args.original_next_due_date::text,
            'endDate', args.original_end_date::text
          )
        );
      when 'RESTORE_ORIGINAL_PAYMENT' then
        expected_before := target_payment;
        desired_after := args.original_payment_snapshot;
        descriptor := pg_catalog.jsonb_build_object(
          'method', 'PUT',
          'path', '/payments/' || args.payment_id,
          'body', pg_catalog.jsonb_build_object(
            'billingType', 'CREDIT_CARD',
            'value', args.expected_value,
            'dueDate', args.old_due_date::text
          )
        );
    end case;

    request_fingerprint := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'version', 1,
            'operationId', operation_id,
            'operationFingerprint', claim_fingerprint,
            'stepKind', step_kind,
            'request', descriptor,
            'integrationSnapshot', args.integration_snapshot
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    insert into public.asaas_student_card_schedule_move_steps (
      operation_id, step_kind, route_kind, ordinal, status,
      request_fingerprint, expected_before, desired_after, provider_request
    ) values (
      operation_id, step_kind, route_kind, ordinal, 'READY',
      request_fingerprint, expected_before, desired_after, descriptor
    );
  end loop;
end
$prepare$;

select pg_catalog.jsonb_build_object(
  'ok', true,
  'status', operation.status,
  'operationId', operation.id,
  'targetClaimFingerprint', claim.request_fingerprint,
  'stepCount', (
    select pg_catalog.count(*)
      from public.asaas_student_card_schedule_move_steps as step
     where step.operation_id = operation.id
  )
)
from public.asaas_student_card_schedule_moves as operation
join public.asaas_student_billing_period_claims as claim
  on claim.id = operation.target_billing_claim_id
where operation.operation_key = :'operation_key';

commit;
