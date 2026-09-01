-- One detached payment can opt out of every Wise Wolf outbound channel
-- without muting the student, tenant or the following recurring charge.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

select pg_temp.assert_true(
  to_regclass('public.student_payment_notification_suppressions') is not null
  and to_regprocedure(
    'private.student_payment_notification_suppression_id(text,uuid,text,text)'
  ) is not null,
  'notification suppression schema is missing'
);

select pg_temp.assert_true(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid =
      'public.student_payment_notification_suppressions'::regclass
  )
  and has_table_privilege(
    'service_role',
    'public.student_payment_notification_suppressions',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'public.student_payment_notification_suppressions',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_payment_notification_suppressions',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'public.student_payment_notification_suppressions',
    'SELECT'
  )
  and not has_function_privilege(
    'service_role',
    'private.student_payment_notification_suppression_id(text,uuid,text,text)',
    'EXECUTE'
  ),
  'notification suppression privileges are too broad'
);

select pg_temp.assert_true(
  position(
    'submit_attempt_count <> 0' in pg_catalog.pg_get_functiondef(
      'private.validate_student_payment_notification_suppression()'::regprocedure
    )
  ) > 0
  and position(
    'provider_entity_id is not null' in pg_catalog.pg_get_functiondef(
      'private.validate_student_payment_notification_suppression()'::regprocedure
    )
  ) > 0
  and position(
    'submitted_at is not null' in pg_catalog.pg_get_functiondef(
      'private.validate_student_payment_notification_suppression()'::regprocedure
    )
  ) > 0,
  'policy is not proven to precede the provider POST'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values (
  'payment-notification-suppression-test',
  'Payment Notification Suppression Test',
  'payment-notification-suppression-test',
  'active',
  true
);

insert into public.tenant_admin_settings (
  tenant_id,
  student_notifications_enabled,
  teacher_notifications_enabled
) values (
  'payment-notification-suppression-test',
  true,
  true
) on conflict (tenant_id) do update
set student_notifications_enabled = excluded.student_notifications_enabled,
    teacher_notifications_enabled = excluded.teacher_notifications_enabled;

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '94000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'payment-notification-suppression@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Suppression Fixture Student"}',
  pg_catalog.now(),
  pg_catalog.now()
);

set local app.enrollment_claim = '1';
update public.profiles
set tenant_id = 'payment-notification-suppression-test',
    role = 'STUDENT',
    lifecycle_status = 'active',
    status = 'Ativo',
    full_name = 'Suppression Fixture Student',
    phone = '5511999999999',
    asaas_customer_id = 'cus_notification_suppression',
    subscription_id = 'sub_notification_suppression_october',
    is_test_account = false,
    test_fixture_key = null
where id = '94000000-0000-4000-8000-000000000001';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
where user_id = '94000000-0000-4000-8000-000000000001';
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '94000000-0000-4000-8000-000000000001',
  'payment-notification-suppression-test',
  'STUDENT',
  'ACTIVE',
  true
);

insert into public.student_manual_pix_issuances (
  id, tenant_id, student_id, due_date, status
) values (
  '94000000-0000-4000-8000-000000000002',
  'payment-notification-suppression-test',
  '94000000-0000-4000-8000-000000000001',
  date '2035-09-10',
  'PROCESSING'
);

create temporary table gap_notification_fixture (
  creation_attempt_id uuid not null,
  creation_claim_token uuid not null,
  suppression_id uuid not null
);

do $prepare_policy$
declare
  v_claim_token uuid := '94000000-0000-4000-8000-000000000004';
  v_claim jsonb;
  v_binding jsonb;
  v_attempt_id uuid;
  v_suppression_id uuid;
begin
  v_claim := public.claim_asaas_provider_creation(
    'payment-notification-suppression-test',
    'PAYMENT_CREATE',
    'manual-pix:94000000-0000-4000-8000-000000000002',
    'manual-pix:94000000-0000-4000-8000-000000000002:student:94000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    v_claim_token,
    300
  );
  if v_claim->>'action' <> 'SUBMIT_ONCE' then
    raise exception 'creation fixture claim failed: %', v_claim;
  end if;
  v_attempt_id := (v_claim->>'attempt_id')::uuid;

  v_binding := public.bind_student_asaas_creation_lifecycle(
    v_attempt_id,
    v_claim_token,
    'payment-notification-suppression-test',
    '94000000-0000-4000-8000-000000000001',
    'BILLING_PERIOD_PAYMENT',
    'cus_notification_suppression'
  );
  if coalesce((v_binding->>'ok')::boolean, false) is not true then
    raise exception 'creation fixture binding failed: %', v_binding;
  end if;

  insert into public.student_payment_notification_suppressions (
    tenant_id,
    student_id,
    source_operation_id,
    manual_pix_issuance_id,
    creation_attempt_id,
    external_reference,
    due_date
  ) values (
    'payment-notification-suppression-test',
    '94000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000003',
    '94000000-0000-4000-8000-000000000002',
    v_attempt_id,
    'manual-pix:94000000-0000-4000-8000-000000000002:student:94000000-0000-4000-8000-000000000001',
    date '2035-09-10'
  ) returning id into v_suppression_id;

  insert into gap_notification_fixture values (
    v_attempt_id,
    v_claim_token,
    v_suppression_id
  );
end;
$prepare_policy$;

-- Simulate a webhook that wins the race against recording provider success on
-- the creation attempt. The inbox externalReference still identifies the
-- exact payment, so CAPI/WhatsApp remain suppressed during that window.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, asaas_id,
  provider_customer_id, value, amount_cents, status, provider_status,
  due_date, billing_type, payment_method, description, payment_type,
  raw_payload
) values (
  '94000000-0000-4000-8000-000000000005',
  '94000000-0000-4000-8000-000000000001',
  'payment-notification-suppression-test',
  'pay_notification_suppression_gap',
  'pay_notification_suppression_gap',
  'cus_notification_suppression',
  169,
  16900,
  'PENDING',
  'PENDING',
  date '2035-09-10',
  'PIX',
  'PIX',
  'September detached Pix fixture',
  'SUBSCRIPTION',
  '{"testMode":true,"test_fixture":true}'
);

insert into public.asaas_webhook_inbox (
  provider_event_id,
  event_name,
  provider_entity_id,
  payload,
  payload_hash,
  status,
  processed_at
) values (
  'evt_notification_suppression_gap',
  'PAYMENT_CREATED',
  'pay_notification_suppression_gap',
  pg_catalog.jsonb_build_object(
    'id', 'evt_notification_suppression_gap',
    'event', 'PAYMENT_CREATED',
    'payment', pg_catalog.jsonb_build_object(
      'id', 'pay_notification_suppression_gap',
      'externalReference',
      'manual-pix:94000000-0000-4000-8000-000000000002:student:94000000-0000-4000-8000-000000000001'
    )
  ),
  repeat('b', 64),
  'PROCESSED',
  pg_catalog.now()
);

do $outbound_channels$
declare
  v_kind text;
  v_identity text;
  v_claim jsonb;
begin
  foreach v_kind in array array[
    'MANUAL_PIX_CREATED',
    'PAYMENT_CONFIRMED_CAPI',
    'PAYMENT_CONFIRMED_WHATSAPP',
    'PAYMENT_DUE_REMINDER',
    'PAYMENT_OVERDUE_3',
    'PAYMENT_OVERDUE_10',
    'PAYMENT_OVERDUE_20'
  ] loop
    v_identity := case
      when v_kind = 'MANUAL_PIX_CREATED'
        then 'pay_notification_suppression_gap'
      else '94000000-0000-4000-8000-000000000005'
    end;
    v_claim := public.claim_asaas_outbound_message(
      'payment-notification-suppression-test',
      '94000000-0000-4000-8000-000000000001',
      v_identity,
      v_kind,
      gen_random_uuid(),
      300
    );
    if v_claim->>'action' <> 'ALREADY_FINAL'
       or v_claim->>'status' <> 'SUPPRESSED' then
      raise exception 'outbound channel escaped policy: %, %', v_kind, v_claim;
    end if;
  end loop;
end;
$outbound_channels$;

select pg_temp.assert_true(
  (
    select count(*) = 7
    from public.asaas_outbound_message_attempts as attempt
    where attempt.tenant_id = 'payment-notification-suppression-test'
      and attempt.student_id = '94000000-0000-4000-8000-000000000001'
      and attempt.status = 'SUPPRESSED'
      and attempt.submit_attempt_count = 0
      and attempt.last_error like 'student_payment_notification_policy:%'
  ),
  'not every direct student/CAPI channel became terminal SUPPRESSED'
);

insert into public.notification_queue (
  id, tenant_id, student_id, student_phone, message_body,
  notification_kind, source_type, source_id, class_date,
  scheduled_for, status, attempts, next_attempt_at, delivery_status,
  max_attempts, idempotency_key
) values (
  '94000000-0000-4000-8000-000000000006',
  'payment-notification-suppression-test',
  '94000000-0000-4000-8000-000000000001',
  '5511999999999',
  'This message must never leave the database',
  'PAYMENT_CONFIRMED',
  'ASAAS_PAYMENT',
  '94000000-0000-4000-8000-000000000005',
  date '2035-09-10',
  pg_catalog.now(),
  'pending',
  0,
  pg_catalog.now(),
  'queued',
  5,
  'suppressed-payment-confirmation'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.notification_queue as notification
    where notification.id = '94000000-0000-4000-8000-000000000006'
      and notification.status = 'skipped'
      and notification.delivery_status = 'skipped'
      and notification.claim_token is null
      and notification.last_error like
        'student_payment_notification_policy:%'
  ),
  'queued payment confirmation remained eligible for WhatsApp'
);

insert into public.management_payment_notification_outbox (
  tenant_id, payment_id, notification_kind, status
) values (
  'payment-notification-suppression-test',
  '94000000-0000-4000-8000-000000000005',
  'PAYMENT_RECEIVED',
  'PENDING'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.management_payment_notification_outbox as outbox
    where outbox.tenant_id = 'payment-notification-suppression-test'
      and outbox.payment_id = '94000000-0000-4000-8000-000000000005'
      and outbox.notification_kind = 'PAYMENT_RECEIVED'
      and outbox.status = 'SUPPRESSED'
      and outbox.submit_attempt_count = 0
  ),
  'management PAYMENT_RECEIVED remained eligible for WhatsApp'
);

update public.management_payment_notification_outbox
set notification_kind = 'PAYMENT_SPLIT',
    status = 'PENDING',
    lease_expires_at = null,
    last_error = null
where tenant_id = 'payment-notification-suppression-test'
  and payment_id = '94000000-0000-4000-8000-000000000005';

select pg_temp.assert_true(
  exists (
    select 1
    from public.management_payment_notification_outbox as outbox
    where outbox.tenant_id = 'payment-notification-suppression-test'
      and outbox.payment_id = '94000000-0000-4000-8000-000000000005'
      and outbox.notification_kind = 'PAYMENT_SPLIT'
      and outbox.status = 'SUPPRESSED'
      and outbox.last_error like 'student_payment_notification_policy:%'
  ),
  'management PAYMENT_SPLIT could be requeued after suppression'
);

-- Persisting the provider response after the policy is expected. The policy
-- remains exact through the creation-attempt identity after the webhook race.
do $bind_provider_identity$
declare
  v_fixture gap_notification_fixture%rowtype;
  v_mark jsonb;
  v_finish jsonb;
begin
  select * into v_fixture from gap_notification_fixture;
  v_mark := public.mark_asaas_provider_creation_submitting(
    v_fixture.creation_attempt_id,
    v_fixture.creation_claim_token
  );
  v_finish := public.record_asaas_provider_creation_state(
    v_fixture.creation_attempt_id,
    v_fixture.creation_claim_token,
    'SUCCEEDED',
    'pay_notification_suppression_gap',
    'PENDING',
    200,
    null,
    '{"id":"pay_notification_suppression_gap","status":"PENDING"}'
  );
  if coalesce((v_mark->>'ok')::boolean, false) is not true
     or coalesce((v_finish->>'ok')::boolean, false) is not true then
    raise exception 'provider identity fixture failed: %, %', v_mark, v_finish;
  end if;
end;
$bind_provider_identity$;

select pg_temp.assert_true(
  private.student_payment_notification_suppression_id(
    'payment-notification-suppression-test',
    '94000000-0000-4000-8000-000000000001',
    'pay_notification_suppression_gap',
    'PAYMENT_DUE_REMINDER'
  ) = (select suppression_id from gap_notification_fixture),
  'provider identity did not remain attached to its suppression policy'
);

do $immutability$
begin
  begin
    update public.student_payment_notification_suppressions
    set reason = reason
    where source_operation_id = '94000000-0000-4000-8000-000000000003';
    raise exception 'suppression update unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;

  begin
    delete from public.student_payment_notification_suppressions
    where source_operation_id = '94000000-0000-4000-8000-000000000003';
    raise exception 'suppression delete unexpectedly succeeded';
  exception when sqlstate '55000' then
    null;
  end;
end;
$immutability$;

-- Same student and tenant, but the October recurring payment has a different
-- provider/local identity and must remain completely untouched.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, asaas_id,
  provider_customer_id, value, amount_cents, status, provider_status,
  due_date, billing_type, description, payment_type,
  raw_payload
) values (
  '94000000-0000-4000-8000-000000000007',
  '94000000-0000-4000-8000-000000000001',
  'payment-notification-suppression-test',
  'pay_notification_suppression_october',
  'pay_notification_suppression_october',
  'cus_notification_suppression',
  169,
  16900,
  'PENDING',
  'PENDING',
  date '2035-10-10',
  'CREDIT_CARD',
  'October recurring fixture',
  'SUBSCRIPTION',
  '{"testMode":true,"test_fixture":true}'
);

do $october_not_suppressed$
declare
  v_claim jsonb;
begin
  v_claim := public.claim_asaas_outbound_message(
    'payment-notification-suppression-test',
    '94000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000007',
    'PAYMENT_DUE_REMINDER',
    gen_random_uuid(),
    300
  );
  if v_claim->>'action' <> 'SUBMIT_ONCE' then
    raise exception 'October recurring payment inherited suppression: %', v_claim;
  end if;
end;
$october_not_suppressed$;

insert into public.notification_queue (
  id, tenant_id, student_id, student_phone, message_body,
  notification_kind, source_type, source_id, class_date,
  scheduled_for, status, attempts, next_attempt_at, delivery_status,
  max_attempts, idempotency_key
) values (
  '94000000-0000-4000-8000-000000000008',
  'payment-notification-suppression-test',
  '94000000-0000-4000-8000-000000000001',
  '5511999999999',
  'October control notification',
  'PAYMENT_CONFIRMED',
  'ASAAS_PAYMENT',
  '94000000-0000-4000-8000-000000000007',
  date '2035-10-10',
  pg_catalog.now(),
  'pending',
  0,
  pg_catalog.now(),
  'queued',
  5,
  'october-control-confirmation'
);

insert into public.management_payment_notification_outbox (
  tenant_id, payment_id, notification_kind, status
) values (
  'payment-notification-suppression-test',
  '94000000-0000-4000-8000-000000000007',
  'PAYMENT_RECEIVED',
  'PENDING'
);

select pg_temp.assert_true(
  exists (
    select 1 from public.notification_queue
    where id = '94000000-0000-4000-8000-000000000008'
      and status = 'pending'
      and delivery_status = 'queued'
  )
  and exists (
    select 1 from public.management_payment_notification_outbox
    where tenant_id = 'payment-notification-suppression-test'
      and payment_id = '94000000-0000-4000-8000-000000000007'
      and status = 'PENDING'
  )
  and private.student_payment_notification_suppression_id(
    'payment-notification-suppression-test',
    '94000000-0000-4000-8000-000000000001',
    'pay_notification_suppression_october',
    'PAYMENT_RECEIVED'
  ) is null,
  'suppression escaped the exact September payment identity'
);

rollback;
