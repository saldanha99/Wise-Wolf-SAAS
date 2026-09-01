-- Billing schedule corrections keep provider mutations single-submit,
-- tenant/student scoped and webhook observations idempotent.

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

create or replace function pg_temp.assert_sqlstate(
  statement text,
  expected_sqlstate text,
  message text
)
returns void
language plpgsql
as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected_sqlstate then
      return;
    end if;
    raise exception 'assertion failed: % (expected %, received %: %)',
      message, expected_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception 'assertion failed: % (statement did not fail)', message;
end;
$$;

create or replace function pg_temp.observe_schedule_fixture(
  p_provider_event_id text,
  p_event_name text,
  p_subscription_id text,
  p_customer_id text,
  p_provider_status text,
  p_provider_event_at timestamptz,
  p_payload jsonb,
  p_received_at timestamptz default null,
  p_inbox_status text default 'PROCESSING',
  p_valid_lease boolean default true
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  insert into public.asaas_webhook_inbox (
    provider_event_id,
    event_name,
    provider_entity_id,
    event_created_at,
    payload,
    payload_hash,
    status,
    attempt_count,
    lease_owner,
    lease_expires_at,
    received_at,
    last_received_at
  ) values (
    p_provider_event_id,
    p_event_name,
    p_subscription_id,
    p_provider_event_at,
    p_payload,
    pg_catalog.repeat('a', 64),
    p_inbox_status,
    case when p_inbox_status = 'PROCESSING' then 1 else 0 end,
    case when p_inbox_status = 'PROCESSING'
      then '70000000-0000-4000-8000-00000000d101'::uuid
      else null
    end,
    case
      when p_inbox_status <> 'PROCESSING' then null
      when p_valid_lease then pg_catalog.now() + interval '1 hour'
      else pg_catalog.now() - interval '1 hour'
    end,
    coalesce(p_received_at, pg_catalog.now()),
    coalesce(p_received_at, pg_catalog.now())
  ) on conflict (provider_event_id) do nothing;

  return public.observe_asaas_student_billing_schedule_event(
    p_provider_event_id,
    p_event_name,
    p_subscription_id,
    p_customer_id,
    p_provider_status,
    p_provider_event_at,
    p_payload
  );
end;
$$;

grant execute on function pg_temp.assert_true(boolean, text)
  to anon, authenticated, service_role;
grant execute on function pg_temp.assert_sqlstate(text, text, text)
  to anon, authenticated, service_role;
grant execute on function pg_temp.observe_schedule_fixture(
  text, text, text, text, text, timestamptz, jsonb,
  timestamptz, text, boolean
) to service_role;

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'anon',
    'public.asaas_student_billing_schedule_corrections',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.asaas_student_billing_schedule_corrections',
    'SELECT'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_corrections',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_corrections',
    'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_corrections',
    'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_corrections',
    'DELETE'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_steps',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_steps',
    'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_steps',
    'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_steps',
    'DELETE'
  )
  and pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_events',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_events',
    'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_events',
    'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'public.asaas_student_billing_schedule_correction_events',
    'DELETE'
  ),
  'schedule correction tables expose unsafe privileges'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'public',
    'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  and (
    select procedure.prosecdef
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.observe_asaas_student_billing_schedule_event(text,text,text,text,text,timestamptz,jsonb)'::pg_catalog.regprocedure
  ),
  'schedule correction observer is not service-only/security-definer'
);

select pg_temp.assert_true(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_billing_schedule_corrections'::pg_catalog.regclass
  )
  and (
    select relation.relrowsecurity and relation.relforcerowsecurity
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_billing_schedule_correction_steps'::pg_catalog.regclass
  )
  and (
    select relation.relrowsecurity and relation.relforcerowsecurity
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_billing_schedule_correction_events'::pg_catalog.regclass
  ),
  'schedule correction tables do not force RLS'
);

insert into public.tenants (id, name, slug, saas_status)
values (
  'billing-schedule-correction-test',
  'Billing Schedule Correction Test',
  'billing-schedule-correction-test',
  'active'
);

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '00000000-0000-4000-8000-00000000d101',
  'authenticated',
  'authenticated',
  'billing-schedule-correction@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Billing Schedule Correction"}',
  pg_catalog.now(),
  pg_catalog.now()
), (
  '00000000-0000-4000-8000-00000000d102',
  'authenticated',
  'authenticated',
  'billing-schedule-correction-expired@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Expired Billing Schedule Correction"}',
  pg_catalog.now(),
  pg_catalog.now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'billing-schedule-correction-test',
       role = 'STUDENT',
       status = 'Ativo',
       lifecycle_status = 'active',
       full_name = 'Billing Schedule Correction',
       cpf = null,
       asaas_customer_id = 'cus_schedule_correction_a',
       subscription_id = 'sub_schedule_correction_a',
       monthly_fee = 169,
       due_day = 10,
       is_test_account = true,
       test_fixture_key =
         'wise-wolf-primary-student:10000000-0000-4000-8000-00000000d101'
 where id = '00000000-0000-4000-8000-00000000d101';
update public.profiles
   set tenant_id = 'billing-schedule-correction-test',
       role = 'STUDENT',
       status = 'Ativo',
       lifecycle_status = 'active',
       full_name = 'Expired Billing Schedule Correction',
       cpf = null,
       asaas_customer_id = 'cus_schedule_correction_b',
       subscription_id = 'sub_schedule_correction_b',
       monthly_fee = 169,
       due_day = 10,
       is_test_account = true,
       test_fixture_key =
         'wise-wolf-primary-student:10000000-0000-4000-8000-00000000d102'
 where id = '00000000-0000-4000-8000-00000000d102';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '00000000-0000-4000-8000-00000000d101',
   '00000000-0000-4000-8000-00000000d102'
 );
insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
) values (
  '00000000-0000-4000-8000-00000000d101',
  'billing-schedule-correction-test',
  'STUDENT',
  'ACTIVE',
  true
), (
  '00000000-0000-4000-8000-00000000d102',
  'billing-schedule-correction-test',
  'STUDENT',
  'ACTIVE',
  true
);

set local request.jwt.claims = '{"role":"service_role"}';
insert into public.offers (
  id,
  kind,
  tenant_id,
  payload,
  expires_at,
  created_by,
  requires_enrollment,
  enrollment_fee,
  processing_by,
  processing_state,
  metadata,
  invite_security_version
) values (
  '10000000-0000-4000-8000-00000000d101',
  'ENROLLMENT',
  'billing-schedule-correction-test',
  '{"planDuration":12,"value":169,"testMode":true}'::jsonb,
  pg_catalog.now() + interval '1 day',
  '00000000-0000-4000-8000-00000000d101',
  true,
  0,
  '00000000-0000-4000-8000-00000000d101',
  'AWAITING_PAYMENT',
  '{"test_fixture":true,"notificationDisabled":true}'::jsonb,
  1
), (
  '10000000-0000-4000-8000-00000000d102',
  'ENROLLMENT',
  'billing-schedule-correction-test',
  '{"planDuration":12,"value":169,"testMode":true}'::jsonb,
  pg_catalog.now() + interval '1 day',
  '00000000-0000-4000-8000-00000000d102',
  true,
  0,
  '00000000-0000-4000-8000-00000000d102',
  'AWAITING_PAYMENT',
  '{"test_fixture":true,"notificationDisabled":true}'::jsonb,
  1
);
reset request.jwt.claims;

insert into public.student_payments (
  id,
  student_id,
  tenant_id,
  asaas_payment_id,
  asaas_id,
  provider_customer_id,
  value,
  amount_cents,
  status,
  provider_status,
  due_date,
  billing_type,
  payment_method,
  description,
  payment_type,
  raw_payload
) values
(
  '20000000-0000-4000-8000-00000000d101',
  '00000000-0000-4000-8000-00000000d101',
  'billing-schedule-correction-test',
  'pay_schedule_correction_a',
  'pay_schedule_correction_a',
  'cus_schedule_correction_a',
  169,
  16900,
  'PENDING',
  'PENDING',
  date '2035-10-10',
  'CREDIT_CARD',
  'CREDIT_CARD',
  'Mensalidade outubro',
  'SUBSCRIPTION',
  '{"testMode":true,"test_fixture":true}'::jsonb
),
(
  '20000000-0000-4000-8000-00000000d102',
  '00000000-0000-4000-8000-00000000d102',
  'billing-schedule-correction-test',
  'pay_schedule_correction_b',
  'pay_schedule_correction_b',
  'cus_schedule_correction_b',
  169,
  16900,
  'PENDING',
  'PENDING',
  date '2036-01-10',
  'CREDIT_CARD',
  'CREDIT_CARD',
  'Mensalidade isolada expirada',
  'SUBSCRIPTION',
  '{"testMode":true,"test_fixture":true}'::jsonb
);

insert into public.asaas_student_billing_period_claims (
  id,
  tenant_id,
  student_id,
  due_date,
  source,
  source_key,
  request_fingerprint,
  status,
  claim_token,
  lease_expires_at,
  submit_attempt_count,
  provider_entity_id
) values
(
  '30000000-0000-4000-8000-00000000d101',
  'billing-schedule-correction-test',
  '00000000-0000-4000-8000-00000000d101',
  date '2035-09-10',
  'SUBSCRIPTION',
  'subscription:10000000-0000-4000-8000-00000000d101',
  repeat('a', 64),
  'BOUND',
  '40000000-0000-4000-8000-00000000d101',
  pg_catalog.now(),
  1,
  'sub_schedule_correction_a'
),
(
  '30000000-0000-4000-8000-00000000d102',
  'billing-schedule-correction-test',
  '00000000-0000-4000-8000-00000000d102',
  date '2035-12-10',
  'SUBSCRIPTION',
  'subscription:10000000-0000-4000-8000-00000000d102',
  repeat('b', 64),
  'BOUND',
  '40000000-0000-4000-8000-00000000d102',
  pg_catalog.now(),
  1,
  'sub_schedule_correction_b'
);

insert into public.asaas_student_billing_schedule_corrections (
  id,
  operation_key,
  tenant_id,
  student_id,
  offer_id,
  old_student_payment_id,
  target_billing_claim_id,
  customer_id,
  subscription_id,
  old_payment_id,
  target_due_date,
  target_end_date,
  original_subscription_snapshot,
  original_payment_snapshot,
  target_subscription_snapshot,
  integration_snapshot,
  status,
  accept_events_until,
  started_at,
  created_at
) values (
  '50000000-0000-4000-8000-00000000d101',
  'schedule-correction-primary',
  'billing-schedule-correction-test',
  '00000000-0000-4000-8000-00000000d101',
  '10000000-0000-4000-8000-00000000d101',
  '20000000-0000-4000-8000-00000000d101',
  '30000000-0000-4000-8000-00000000d101',
  'cus_schedule_correction_a',
  'sub_schedule_correction_a',
  'pay_schedule_correction_a',
  date '2035-09-10',
  date '2036-08-10',
  '{
    "id":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-a",
    "maxPayments":12,
    "nextDueDate":"2035-11-10",
    "endDate":"2036-09-10"
  }'::jsonb,
  '{
    "id":"pay_schedule_correction_a",
    "subscription":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"PENDING",
    "deleted":false,
    "dueDate":"2035-10-10",
    "originalDueDate":"2035-10-10",
    "paymentDate":null,
    "confirmedDate":null,
    "creditDate":null,
    "value":169,
    "billingType":"CREDIT_CARD"
  }'::jsonb,
  '{
    "id":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-a",
    "maxPayments":12,
    "nextDueDate":"2035-09-10",
    "endDate":"2036-08-10"
  }'::jsonb,
  '{
    "integrationId":"integration-fixture",
    "version":1,
    "environment":"test",
    "mode":"test_fixture",
    "baseUrl":"https://example.invalid"
  }'::jsonb,
  'INACTIVATING',
  pg_catalog.now() + interval '1 hour',
  pg_catalog.now() - interval '10 minutes',
  pg_catalog.now() - interval '10 minutes'
);

create or replace function pg_temp.clone_invalid_schedule_operation(
  p_mutation text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_original_subscription jsonb := '{
    "id":"sub_schedule_correction_b",
    "customer":"cus_schedule_correction_b",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-b",
    "maxPayments":12,
    "nextDueDate":"2036-02-10",
    "endDate":"2036-12-10"
  }'::jsonb;
  v_original_payment jsonb := '{
    "id":"pay_schedule_correction_b",
    "subscription":"sub_schedule_correction_b",
    "customer":"cus_schedule_correction_b",
    "status":"PENDING",
    "deleted":false,
    "dueDate":"2036-01-10",
    "originalDueDate":"2036-01-10",
    "paymentDate":null,
    "confirmedDate":null,
    "creditDate":null,
    "value":169,
    "billingType":"CREDIT_CARD"
  }'::jsonb;
  v_target_subscription jsonb := '{
    "id":"sub_schedule_correction_b",
    "customer":"cus_schedule_correction_b",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-b",
    "maxPayments":12,
    "nextDueDate":"2035-12-10",
    "endDate":"2036-11-10"
  }'::jsonb;
  v_integration jsonb := '{
    "integrationId":"integration-fixture",
    "version":1,
    "environment":"test",
    "mode":"test_fixture",
    "baseUrl":"https://example.invalid"
  }'::jsonb;
  v_customer_id text := 'cus_schedule_correction_b';
  v_target_claim_id uuid :=
    '30000000-0000-4000-8000-00000000d102'::uuid;
begin
  case p_mutation
    when 'MISSING_DELETED' then
      v_original_payment := v_original_payment - 'deleted';
    when 'NULL_REFERENCE' then
      v_original_subscription := pg_catalog.jsonb_set(
        v_original_subscription,
        '{externalReference}',
        'null'::jsonb
      );
    when 'SECRET_INTEGRATION' then
      v_integration := v_integration || '{"apiKey":"forbidden"}'::jsonb;
    when 'CROSSED_CLAIM' then
      v_target_claim_id :=
        '30000000-0000-4000-8000-00000000d101'::uuid;
    when 'CROSSED_PROFILE' then
      v_customer_id := 'cus_schedule_correction_a';
    when 'VALID' then
      null;
    else
      raise exception 'unknown negative fixture';
  end case;

  insert into public.asaas_student_billing_schedule_corrections (
    id,
    operation_key,
    tenant_id,
    student_id,
    offer_id,
    old_student_payment_id,
    target_billing_claim_id,
    customer_id,
    subscription_id,
    old_payment_id,
    target_due_date,
    target_end_date,
    original_subscription_snapshot,
    original_payment_snapshot,
    target_subscription_snapshot,
    integration_snapshot,
    status,
    accept_events_until
  ) values (
    pg_catalog.gen_random_uuid(),
    'negative-' || pg_catalog.lower(p_mutation),
    'billing-schedule-correction-test',
    '00000000-0000-4000-8000-00000000d102',
    '10000000-0000-4000-8000-00000000d102',
    '20000000-0000-4000-8000-00000000d102',
    v_target_claim_id,
    v_customer_id,
    'sub_schedule_correction_b',
    'pay_schedule_correction_b',
    date '2035-12-10',
    date '2036-11-10',
    v_original_subscription,
    v_original_payment,
    v_target_subscription,
    v_integration,
    'INACTIVATING',
    pg_catalog.now() + interval '1 hour'
  );
end;
$$;

select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('MISSING_DELETED')$$,
  '23514',
  'payment snapshot accepted a missing deleted flag'
);
select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('NULL_REFERENCE')$$,
  '23514',
  'subscription snapshot accepted a null stable field'
);
select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('SECRET_INTEGRATION')$$,
  '23514',
  'integration snapshot persisted a credential-like key'
);
select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('CROSSED_CLAIM')$$,
  '23514',
  'target billing claim crossed the student scope'
);
select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('CROSSED_PROFILE')$$,
  '23514',
  'provider customer crossed the authoritative profile scope'
);

insert into public.financial_transactions (
  id,
  tenant_id,
  type,
  category,
  amount,
  amount_cents,
  student_payment_id,
  occurred_at,
  description
) values (
  '80000000-0000-4000-8000-00000000d102',
  'billing-schedule-correction-test',
  'ENTRADA',
  'MENSALIDADE',
  169,
  16900,
  '20000000-0000-4000-8000-00000000d102',
  pg_catalog.now(),
  'fixture that must make PENDING non-exact'
);
select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('VALID')$$,
  '23514',
  'operation accepted a PENDING payment that already had ledger cash'
);
delete from public.financial_transactions
 where id = '80000000-0000-4000-8000-00000000d102';

select pg_temp.assert_true(
  private.student_billing_schedule_correction_active(
    'billing-schedule-correction-test',
    '00000000-0000-4000-8000-00000000d101',
    'sub_schedule_correction_a'
  )
  and not private.student_subscription_mutation_scope_valid(
    'billing-schedule-correction-test',
    '00000000-0000-4000-8000-00000000d101',
    'cus_schedule_correction_a',
    'sub_schedule_correction_a'
  )
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_student_lifecycle_against_subscription_mutation()'::
        pg_catalog.regprocedure
    ),
    'student_billing_schedule_correction_active'
  ) > 0
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_student_financial_operation_against_subscription_mutation()'::
        pg_catalog.regprocedure
    ),
    'student_billing_schedule_correction_active'
  ) > 0
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_student_creation_against_subscription_mutation()'::
        pg_catalog.regprocedure
    ),
    'student_billing_schedule_correction_active'
  ) > 0,
  'active correction is absent from the shared semantic/trigger fences'
);

with result as materialized (
  select public.claim_asaas_subscription_mutation(
    'billing-schedule-correction-test',
    '00000000-0000-4000-8000-00000000d101',
    'cus_schedule_correction_a',
    'sub_schedule_correction_a',
    'PLAN_VALUE',
    'schedule-correction-fence-probe',
    pg_catalog.repeat('9', 64),
    '{"valueCents":16900}'::jsonb,
    '{"valueCents":17000}'::jsonb,
    '{"test_fixture":true}'::jsonb,
    null,
    '70000000-0000-4000-8000-00000000d101'::uuid,
    300
  ) as payload
)
select pg_temp.assert_true(
  (select payload ->> 'ok' = 'false'
      and payload ->> 'action' = 'REVIEW_REQUIRED'
      and payload ->> 'reason' = 'student_subscription_scope_changed'
     from result)
  and not exists (
    select 1
      from public.asaas_subscription_mutation_operations
     where intent_key = 'schedule-correction-fence-probe'
  ),
  'normal subscription mutation crossed an active schedule correction'
);

select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_period_claims
       set status = 'CLAIMED'
     where id = '30000000-0000-4000-8000-00000000d101'
  $sql$,
  '55000',
  'financial guard allowed a billing claim during schedule correction'
);

insert into public.asaas_student_billing_period_claims (
  id,
  tenant_id,
  student_id,
  due_date,
  source,
  source_key,
  request_fingerprint,
  status,
  claim_token,
  lease_expires_at,
  submit_attempt_count
) values (
  '30000000-0000-4000-8000-00000000d202',
  'billing-schedule-correction-test',
  '00000000-0000-4000-8000-00000000d102',
  date '2035-11-10',
  'MANUAL_PIX',
  'schedule-correction-semantic-conflict',
  pg_catalog.repeat('8', 64),
  'CLAIMED',
  '40000000-0000-4000-8000-00000000d202',
  pg_catalog.now() + interval '5 minutes',
  0
);
select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('VALID')$$,
  '55000',
  'schedule correction ignored an active semantic financial fence'
);
delete from public.asaas_student_billing_period_claims
 where id = '30000000-0000-4000-8000-00000000d202';

insert into public.asaas_subscription_mutation_operations (
  id,
  tenant_id,
  student_id,
  customer_id,
  subscription_id,
  mutation_kind,
  intent_key,
  request_fingerprint,
  expected_state,
  desired_state,
  integration_snapshot,
  status,
  claim_token,
  lease_expires_at
) values (
  '70000000-0000-4000-8000-00000000d202',
  'billing-schedule-correction-test',
  '00000000-0000-4000-8000-00000000d102',
  'cus_schedule_correction_b',
  'sub_schedule_correction_b',
  'PLAN_VALUE',
  'schedule-correction-reciprocal-conflict',
  pg_catalog.repeat('7', 64),
  '{"valueCents":16900}'::jsonb,
  '{"valueCents":17000}'::jsonb,
  '{"test_fixture":true}'::jsonb,
  'CLAIMED',
  '70000000-0000-4000-8000-00000000d203',
  pg_catalog.now() + interval '5 minutes'
);
select pg_temp.assert_sqlstate(
  $$select pg_temp.clone_invalid_schedule_operation('VALID')$$,
  '55000',
  'schedule correction crossed an active subscription mutation'
);
delete from public.asaas_subscription_mutation_operations
 where id = '70000000-0000-4000-8000-00000000d202';

insert into public.asaas_student_billing_schedule_correction_steps (
  id,
  operation_id,
  step_kind,
  route_kind,
  ordinal,
  status,
  request_fingerprint,
  expected_before,
  desired_after,
  provider_request,
  submit_attempt_count,
  submitted_at
) values
(
  '60000000-0000-4000-8000-00000000d101',
  '50000000-0000-4000-8000-00000000d101',
  'INACTIVATE_SUBSCRIPTION',
  'TARGET',
  10,
  'SUBMITTING',
  repeat('a', 64),
  '{"status":"ACTIVE"}',
  '{
    "id":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"INACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-a",
    "maxPayments":12,
    "nextDueDate":"2035-11-10",
    "endDate":"2036-09-10"
  }'::jsonb,
  '{"method":"PUT","status":"INACTIVE"}',
  1,
  pg_catalog.now() - interval '5 minutes'
),
(
  '60000000-0000-4000-8000-00000000d102',
  '50000000-0000-4000-8000-00000000d101',
  'DELETE_OLD_PAYMENT',
  'TARGET',
  20,
  'READY',
  repeat('b', 64),
  '{"deleted":false}',
  '{"deleted":true}',
  '{"method":"DELETE","paymentId":"pay_schedule_correction_a"}',
  0,
  null
),
(
  '60000000-0000-4000-8000-00000000d103',
  '50000000-0000-4000-8000-00000000d101',
  'ACTIVATE_TARGET_SCHEDULE',
  'TARGET',
  30,
  'READY',
  repeat('c', 64),
  '{"status":"INACTIVE"}',
  '{
    "id":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-a",
    "maxPayments":12,
    "nextDueDate":"2035-09-10",
    "endDate":"2036-08-10"
  }'::jsonb,
  '{
    "method":"PUT",
    "status":"ACTIVE",
    "nextDueDate":"2035-09-10",
    "endDate":"2036-08-10"
  }'::jsonb,
  0,
  null
),
(
  '60000000-0000-4000-8000-00000000d106',
  '50000000-0000-4000-8000-00000000d101',
  'INACTIVATE_CONFLICTED_SUBSCRIPTION',
  'COMPENSATION',
  35,
  'READY',
  repeat('3', 64),
  '{
    "id":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-a",
    "maxPayments":12,
    "nextDueDate":"2035-09-10",
    "endDate":"2036-08-10"
  }'::jsonb,
  '{
    "id":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"INACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-a",
    "maxPayments":12,
    "nextDueDate":"2035-09-10",
    "endDate":"2036-08-10"
  }'::jsonb,
  '{
    "method":"PUT",
    "path":"/subscriptions/sub_schedule_correction_a",
    "body":{"status":"INACTIVE"}
  }'::jsonb,
  0,
  null
),
(
  '60000000-0000-4000-8000-00000000d104',
  '50000000-0000-4000-8000-00000000d101',
  'ACTIVATE_ORIGINAL_SCHEDULE',
  'COMPENSATION',
  40,
  'READY',
  repeat('d', 64),
  '{"status":"INACTIVE"}',
  '{
    "id":"sub_schedule_correction_a",
    "customer":"cus_schedule_correction_a",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-a",
    "maxPayments":12,
    "nextDueDate":"2035-11-10",
    "endDate":"2036-09-10"
  }'::jsonb,
  '{
    "method":"PUT",
    "status":"ACTIVE",
    "nextDueDate":"2035-11-10",
    "endDate":"2036-09-10"
  }'::jsonb,
  0,
  null
),
(
  '60000000-0000-4000-8000-00000000d105',
  '50000000-0000-4000-8000-00000000d101',
  'RESTORE_OLD_PAYMENT',
  'COMPENSATION',
  50,
  'READY',
  repeat('e', 64),
  '{"deleted":true}',
  '{"deleted":false}',
  '{"method":"POST","paymentId":"pay_schedule_correction_a"}',
  0,
  null
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 6
       and pg_catalog.array_agg(step.ordinal order by step.ordinal) =
         array[10, 20, 30, 35, 40, 50]::smallint[]
      from public.asaas_student_billing_schedule_correction_steps as step
     where step.operation_id = '50000000-0000-4000-8000-00000000d101'
  ),
  'schedule correction did not persist the six-step ledger contract'
);

select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_correction_steps
       set status = 'SUBMITTING',
           submit_attempt_count = 1,
           submitted_at = pg_catalog.clock_timestamp()
     where id = '60000000-0000-4000-8000-00000000d106'
  $sql$,
  '55000',
  'containment provider step left READY before conflict containment was active'
);

create temporary table schedule_observation_results (
  label text primary key,
  payload jsonb not null
);
grant select, insert on table pg_temp.schedule_observation_results
  to service_role;

set local role service_role;
insert into pg_temp.schedule_observation_results values (
  'received-before-operation-start',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_before_operation',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_before_operation",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb,
    (
      select operation.started_at - interval '1 minute'
        from public.asaas_student_billing_schedule_corrections as operation
       where operation.id = '50000000-0000-4000-8000-00000000d101'
    )
  )
);
insert into pg_temp.schedule_observation_results values (
  'received-before-step-submit',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_before_submit',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_before_submit",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb,
    (
      select step.submitted_at - interval '1 minute'
        from public.asaas_student_billing_schedule_correction_steps as step
       where step.id = '60000000-0000-4000-8000-00000000d101'
    )
  )
);
insert into pg_temp.schedule_observation_results values (
  'inactivated',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_inactivated',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    null,
    '{
      "id":"evt_schedule_inactivated",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb
  )
);
insert into pg_temp.schedule_observation_results values (
  'inactivated-duplicate',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_inactivated',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    null,
    '{
      "id":"evt_schedule_inactivated",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb
  )
);
reset role;

select pg_temp.assert_true(
  (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' = 'no_expected_schedule_correction_event'
     from schedule_observation_results
    where label = 'received-before-operation-start')
  and (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' = 'no_expected_schedule_correction_event'
     from schedule_observation_results
    where label = 'received-before-step-submit')
  and (select payload ->> 'handled' = 'true'
      and payload ->> 'duplicate' = 'false'
      and payload ->> 'operation_id' =
        '50000000-0000-4000-8000-00000000d101'
      and payload ->> 'step_kind' = 'INACTIVATE_SUBSCRIPTION'
     from schedule_observation_results where label = 'inactivated')
  and (select payload ->> 'handled' = 'true'
      and payload ->> 'duplicate' = 'true'
     from schedule_observation_results
    where label = 'inactivated-duplicate')
  and (
    select pg_catalog.count(*) = 1
      from public.asaas_student_billing_schedule_correction_events
     where provider_event_id = 'evt_schedule_inactivated'
  )
  and not exists (
    select 1
      from public.asaas_student_billing_schedule_correction_events
     where provider_event_id in (
       'evt_schedule_before_operation',
       'evt_schedule_before_submit'
     )
  )
  and (
    select status = 'INACTIVATING'
      from public.asaas_student_billing_schedule_corrections
     where id = '50000000-0000-4000-8000-00000000d101'
  )
  and (
    select status = 'SUBMITTING'
      from public.asaas_student_billing_schedule_correction_steps
     where id = '60000000-0000-4000-8000-00000000d101'
  ),
  'observer was not idempotent or advanced critical state'
);

set local role service_role;
insert into pg_temp.schedule_observation_results values (
  'payload-mismatch',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_payload_mismatch',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_different_body_id",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE"
      }
    }'::jsonb
  )
);
insert into pg_temp.schedule_observation_results values (
  'customer-mismatch',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_customer_mismatch',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_wrong_customer',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_customer_mismatch",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_wrong_customer",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb
  )
);
insert into pg_temp.schedule_observation_results values (
  'event-id-collision',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_inactivated',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    null,
    '{
      "id":"evt_schedule_inactivated",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2037-01-10"
      }
    }'::jsonb
  )
);
insert into pg_temp.schedule_observation_results values (
  'inbox-not-processing',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_inbox_received',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_inbox_received",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb,
    pg_catalog.now(),
    'RECEIVED',
    true
  )
);
insert into pg_temp.schedule_observation_results values (
  'inbox-expired-lease',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_inbox_expired_lease',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_inbox_expired_lease",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb,
    pg_catalog.now(),
    'PROCESSING',
    false
  )
);
reset role;

select pg_temp.assert_true(
  (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' = 'schedule_correction_payload_mismatch'
     from schedule_observation_results where label = 'payload-mismatch')
  and (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' = 'no_expected_schedule_correction_event'
     from schedule_observation_results where label = 'customer-mismatch')
  and (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' =
        'schedule_correction_inbox_not_claimed'
     from schedule_observation_results where label = 'event-id-collision')
  and (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' = 'schedule_correction_inbox_not_claimed'
     from schedule_observation_results where label = 'inbox-not-processing')
  and (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' = 'schedule_correction_inbox_not_claimed'
     from schedule_observation_results where label = 'inbox-expired-lease')
  and not exists (
    select 1
      from public.asaas_student_billing_schedule_correction_events
     where provider_event_id in (
       'evt_schedule_payload_mismatch',
       'evt_schedule_customer_mismatch',
       'evt_schedule_inbox_received',
       'evt_schedule_inbox_expired_lease'
     )
  ),
  'mismatched or colliding event crossed the correction scope'
);

update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUCCEEDED',
       completed_at = pg_catalog.now(),
       provider_http_status = 200,
       observed_state = desired_after
 where id = '60000000-0000-4000-8000-00000000d101';

create or replace function pg_temp.exercise_pending_never_altered_rejected()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_terminal_rejected boolean := false;
begin
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         submitted_at = pg_catalog.clock_timestamp()
   where id = '60000000-0000-4000-8000-00000000d102';
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUCCEEDED',
         completed_at = pg_catalog.clock_timestamp(),
         provider_http_status = 204,
         observed_state = desired_after
   where id = '60000000-0000-4000-8000-00000000d102';
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         submitted_at = pg_catalog.clock_timestamp()
   where id = '60000000-0000-4000-8000-00000000d105';
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUCCEEDED',
         completed_at = pg_catalog.clock_timestamp(),
         provider_http_status = 200,
         observed_state = desired_after
   where id = '60000000-0000-4000-8000-00000000d105';

  begin
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATED',
           completed_at = pg_catalog.clock_timestamp()
     where id = '50000000-0000-4000-8000-00000000d101';
  exception when sqlstate '55000' then
    v_terminal_rejected := true;
  end;

  if not v_terminal_rejected
     or private.asaas_billing_schedule_compensation_causal(
       '50000000-0000-4000-8000-00000000d101'
     )
  then
    raise exception 'unchanged local PENDING looked like a restored payment';
  end if;

  raise exception using
    errcode = 'Z0050',
    message = 'unchanged PENDING compensation rejected';
end;
$$;

select pg_temp.assert_sqlstate(
  $$select pg_temp.exercise_pending_never_altered_rejected()$$,
  'Z0050',
  'a local PENDING row that never observed DELETE/RESTORE terminalized compensation'
);

create or replace function pg_temp.exercise_delete_not_submitted_noop()
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'BLOCKED',
         completed_at = pg_catalog.clock_timestamp(),
         observed_state = '{"reason":"provider_changed_before_delete"}'::jsonb,
         last_error = 'provider_changed_before_delete'
   where id = '60000000-0000-4000-8000-00000000d102';
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUCCEEDED',
         completed_at = pg_catalog.clock_timestamp(),
         observed_state = desired_after
   where id = '60000000-0000-4000-8000-00000000d104';
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUCCEEDED',
         completed_at = pg_catalog.clock_timestamp(),
         observed_state = desired_after
   where id = '60000000-0000-4000-8000-00000000d105';
  update public.asaas_student_billing_schedule_corrections
     set status = 'RESTORING_OLD_PAYMENT'
   where id = '50000000-0000-4000-8000-00000000d101';

  if not private.asaas_billing_schedule_compensation_causal(
    '50000000-0000-4000-8000-00000000d101'
  ) then
    raise exception 'DELETE-not-submitted no-op was not recognized';
  end if;

  update public.asaas_student_billing_schedule_corrections
     set status = 'COMPENSATED',
         completed_at = pg_catalog.clock_timestamp()
   where id = '50000000-0000-4000-8000-00000000d101';

  raise exception using
    errcode = 'Z0052',
    message = 'DELETE-not-submitted no-op accepted';
end;
$$;

select pg_temp.assert_sqlstate(
  $$select pg_temp.exercise_delete_not_submitted_noop()$$,
  'Z0052',
  'compensation no-op was not limited to an unsubmitted DELETE'
);

update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUBMITTING',
       submit_attempt_count = 1,
       submitted_at = pg_catalog.clock_timestamp()
 where id = '60000000-0000-4000-8000-00000000d102';
update public.asaas_student_billing_schedule_corrections
   set status = 'DELETING_OLD_PAYMENT'
 where id = '50000000-0000-4000-8000-00000000d101';
insert into public.asaas_webhook_inbox (
  provider_event_id,
  event_name,
  provider_entity_id,
  event_created_at,
  payload,
  payload_hash,
  status,
  attempt_count,
  received_at,
  last_received_at,
  processed_at
)
select
  'evt_schedule_payment_deleted',
  'PAYMENT_DELETED',
  'pay_schedule_correction_a',
  step.submitted_at,
  '{
    "id":"evt_schedule_payment_deleted",
    "event":"PAYMENT_DELETED",
    "payment":{
      "id":"pay_schedule_correction_a",
      "customer":"cus_schedule_correction_a",
      "subscription":"sub_schedule_correction_a"
    }
  }'::jsonb,
  pg_catalog.repeat('d', 64),
  'PROCESSED',
  1,
  step.submitted_at,
  step.submitted_at,
  step.submitted_at
from public.asaas_student_billing_schedule_correction_steps as step
where step.id = '60000000-0000-4000-8000-00000000d102';
update public.student_payments
   set status = 'CANCELLED',
       provider_status = 'DELETED',
       last_provider_event_id = 'evt_schedule_payment_deleted',
       last_provider_event_at = pg_catalog.clock_timestamp()
 where id = '20000000-0000-4000-8000-00000000d101';
update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUCCEEDED',
       completed_at = pg_catalog.clock_timestamp(),
       provider_http_status = 204,
       observed_state = desired_after
 where id = '60000000-0000-4000-8000-00000000d102';
update public.asaas_student_billing_schedule_corrections
   set status = 'OLD_PAYMENT_DELETED'
 where id = '50000000-0000-4000-8000-00000000d101';

update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUBMITTING',
       submit_attempt_count = 1,
       submitted_at = pg_catalog.now()
 where id = '60000000-0000-4000-8000-00000000d103';
update public.asaas_student_billing_schedule_corrections
   set status = 'ACTIVATING_TARGET'
 where id = '50000000-0000-4000-8000-00000000d101';

set local role service_role;
insert into pg_temp.schedule_observation_results values (
  'target-updated-advanced-next-due',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_target_updated',
    'SUBSCRIPTION_UPDATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'ACTIVE',
    timestamptz '1900-01-01 00:00:00+00',
    '{
      "id":"evt_schedule_target_updated",
      "event":"SUBSCRIPTION_UPDATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"ACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-10-10",
        "endDate":"2036-08-10"
      }
    }'::jsonb
  )
);
reset role;

select pg_temp.assert_true(
  (select payload ->> 'handled' = 'true'
      and payload ->> 'step_kind' = 'ACTIVATE_TARGET_SCHEDULE'
     from schedule_observation_results
    where label = 'target-updated-advanced-next-due')
  and (
    select status = 'SUBMITTING'
      from public.asaas_student_billing_schedule_correction_steps
     where id = '60000000-0000-4000-8000-00000000d103'
  ),
  'advanced nextDueDate/provider timestamp affected target correlation'
);

update public.asaas_student_billing_schedule_correction_steps
   set status = 'UNKNOWN',
       last_error = 'provider response ambiguous'
 where id = '60000000-0000-4000-8000-00000000d103';

select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_corrections
       set status = 'CONTAINING_TARGET_CONFLICT',
           target_conflict_evidence = '{
             "reason":"provider_payment_competence_conflict",
             "subscription":"sub_schedule_correction_a",
             "targetPayments":["pay_conflict_1","pay_conflict_2"],
             "targetCompetenceCount":2
           }'::jsonb
     where id = '50000000-0000-4000-8000-00000000d101'
  $sql$,
  '55000',
  'containment started before ACTIVATE_TARGET was consumed/closed'
);

create or replace function pg_temp.exercise_target_conflict_containment()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_observation jsonb;
  v_restore_blocked boolean := false;
  v_escape_blocked boolean := false;
  v_evidence_blocked boolean := false;
begin
  update public.asaas_student_billing_schedule_correction_steps
     set status = 'BLOCKED',
         completed_at = pg_catalog.now(),
         observed_state = '{
           "reason":"provider_payment_competence_conflict",
           "targetPayments":["pay_conflict_1","pay_conflict_2"]
         }'::jsonb,
         last_error = 'provider_payment_competence_conflict'
   where id = '60000000-0000-4000-8000-00000000d103';

  update public.asaas_student_billing_schedule_corrections
     set status = 'CONTAINING_TARGET_CONFLICT',
         target_conflict_evidence = '{
           "reason":"provider_payment_competence_conflict",
           "subscription":"sub_schedule_correction_a",
           "targetPayments":["pay_conflict_1","pay_conflict_2"],
           "targetCompetenceCount":2
         }'::jsonb
   where id = '50000000-0000-4000-8000-00000000d101';

  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         submitted_at = pg_catalog.now()
   where id = '60000000-0000-4000-8000-00000000d106';

  v_observation := pg_temp.observe_schedule_fixture(
    'evt_schedule_conflict_contained',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_conflict_contained",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-10-10",
        "endDate":"2036-08-10"
      }
    }'::jsonb,
    pg_catalog.now()
  );

  if v_observation ->> 'handled' <> 'true'
     or v_observation ->> 'step_kind' <>
       'INACTIVATE_CONFLICTED_SUBSCRIPTION'
  then
    raise exception 'containment observer did not select step 35';
  end if;

  update public.asaas_student_billing_schedule_correction_steps
     set status = 'SUCCEEDED',
         completed_at = pg_catalog.now(),
         provider_http_status = 200,
         observed_state = '{
           "id":"sub_schedule_correction_a",
           "customer":"cus_schedule_correction_a",
           "status":"INACTIVE",
           "billingType":"CREDIT_CARD",
           "cycle":"MONTHLY",
           "value":169,
           "externalReference":"schedule-correction-a",
           "maxPayments":12,
           "nextDueDate":"2035-10-10",
           "endDate":"2036-08-10"
         }'::jsonb
   where id = '60000000-0000-4000-8000-00000000d106';

  update public.asaas_student_billing_schedule_corrections
     set status = 'BLOCKED',
         last_error = 'target_conflict_contained_manual_reconciliation_required'
   where id = '50000000-0000-4000-8000-00000000d101';

  begin
    update public.asaas_student_billing_schedule_correction_steps
       set status = 'SUBMITTING',
           submit_attempt_count = 1,
           submitted_at = pg_catalog.now()
     where id = '60000000-0000-4000-8000-00000000d104';
  exception when sqlstate '55000' then
    v_restore_blocked := true;
  end;

  begin
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATING_SUBSCRIPTION'
     where id = '50000000-0000-4000-8000-00000000d101';
  exception when sqlstate '55000' then
    v_escape_blocked := true;
  end;

  begin
    update public.asaas_student_billing_schedule_corrections
       set target_conflict_evidence = pg_catalog.jsonb_set(
         target_conflict_evidence,
         '{reason}',
         '"rewritten"'::jsonb
       )
     where id = '50000000-0000-4000-8000-00000000d101';
  exception when sqlstate '55000' then
    v_evidence_blocked := true;
  end;

  if not v_restore_blocked
     or not v_escape_blocked
     or not v_evidence_blocked
     or not private.student_billing_schedule_correction_active(
       'billing-schedule-correction-test',
       '00000000-0000-4000-8000-00000000d101',
       'sub_schedule_correction_a'
     )
     or not exists (
       select 1
         from public.asaas_student_billing_schedule_corrections as operation
        where operation.id = '50000000-0000-4000-8000-00000000d101'
          and operation.status = 'BLOCKED'
          and operation.completed_at is null
          and operation.target_conflict_evidence is not null
     )
     or exists (
       select 1
         from public.asaas_student_billing_schedule_correction_steps as step
        where step.operation_id = '50000000-0000-4000-8000-00000000d101'
          and step.step_kind in (
            'ACTIVATE_ORIGINAL_SCHEDULE',
            'RESTORE_OLD_PAYMENT'
          )
          and (
            step.status <> 'READY'
            or step.submit_attempt_count <> 0
          )
     )
  then
    raise exception 'containment did not remain fenced/manual-only';
  end if;

  raise exception using
    errcode = 'Z0035',
    message = 'containment transition exercised';
end;
$$;

select pg_temp.assert_sqlstate(
  $$select pg_temp.exercise_target_conflict_containment()$$,
  'Z0035',
  'target conflict containment did not block automatic restoration'
);

update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUBMITTING',
       submit_attempt_count = 1,
       submitted_at = pg_catalog.now()
 where id = '60000000-0000-4000-8000-00000000d104';
update public.asaas_student_billing_schedule_corrections
   set status = 'COMPENSATING_SUBSCRIPTION'
 where id = '50000000-0000-4000-8000-00000000d101';

set local role service_role;
insert into pg_temp.schedule_observation_results values (
  'original-schedule-compensation',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_original_updated',
    'SUBSCRIPTION_UPDATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'ACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_original_updated",
      "event":"SUBSCRIPTION_UPDATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"ACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb
  )
);
reset role;

select pg_temp.assert_true(
  (select payload ->> 'handled' = 'true'
      and payload ->> 'step_kind' = 'ACTIVATE_ORIGINAL_SCHEDULE'
     from schedule_observation_results
    where label = 'original-schedule-compensation')
  and (
    select status = 'COMPENSATING_SUBSCRIPTION'
      from public.asaas_student_billing_schedule_corrections
     where id = '50000000-0000-4000-8000-00000000d101'
  ),
  'compensation event was not isolated or advanced operation state'
);

update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUCCEEDED',
       completed_at = pg_catalog.now(),
       provider_http_status = 200,
       observed_state = desired_after
 where id = '60000000-0000-4000-8000-00000000d104';
update public.asaas_student_billing_schedule_corrections
   set status = 'RESTORING_OLD_PAYMENT'
 where id = '50000000-0000-4000-8000-00000000d101';
update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUBMITTING',
       submit_attempt_count = 1,
       submitted_at = pg_catalog.clock_timestamp()
 where id = '60000000-0000-4000-8000-00000000d105';
update public.asaas_student_billing_schedule_correction_steps
   set status = 'SUCCEEDED',
       completed_at = pg_catalog.clock_timestamp(),
       provider_http_status = 200,
       observed_state = desired_after
 where id = '60000000-0000-4000-8000-00000000d105';

select pg_temp.assert_true(
  (
    select status = 'RESTORING_OLD_PAYMENT'
      from public.asaas_student_billing_schedule_corrections
     where id = '50000000-0000-4000-8000-00000000d101'
  )
  and (
    select status = 'SUCCEEDED'
      from public.asaas_student_billing_schedule_correction_steps
     where id = '60000000-0000-4000-8000-00000000d105'
  ),
  'restore provider success prematurely made compensation terminal'
);

select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATED',
           completed_at = pg_catalog.clock_timestamp()
     where id = '50000000-0000-4000-8000-00000000d101'
  $sql$,
  '55000',
  'provider RESTORE success terminalized before exact local reconciliation'
);

update public.student_payments
   set status = 'PENDING',
       provider_status = 'PENDING'
 where id = '20000000-0000-4000-8000-00000000d101';
select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATED',
           completed_at = pg_catalog.clock_timestamp()
     where id = '50000000-0000-4000-8000-00000000d101'
  $sql$,
  '55000',
  'local PENDING without a new processed PAYMENT_RESTORED event was trusted'
);

insert into public.asaas_webhook_inbox (
  provider_event_id,
  event_name,
  provider_entity_id,
  event_created_at,
  payload,
  payload_hash,
  status,
  attempt_count,
  received_at,
  last_received_at,
  processed_at
)
select
  'evt_schedule_payment_restored',
  'PAYMENT_RESTORED',
  'pay_schedule_correction_a',
  step.submitted_at,
  '{
    "id":"evt_schedule_payment_restored",
    "event":"PAYMENT_RESTORED",
    "payment":{
      "id":"pay_schedule_correction_a",
      "customer":"cus_schedule_correction_a",
      "subscription":"sub_schedule_correction_a"
    }
  }'::jsonb,
  pg_catalog.repeat('e', 64),
  'PROCESSED',
  1,
  step.submitted_at,
  step.submitted_at,
  step.submitted_at
from public.asaas_student_billing_schedule_correction_steps as step
where step.id = '60000000-0000-4000-8000-00000000d105';
update public.student_payments
   set last_provider_event_id = 'evt_schedule_payment_restored',
       last_provider_event_at = pg_catalog.clock_timestamp()
 where id = '20000000-0000-4000-8000-00000000d101';

insert into public.financial_transactions (
  id,
  tenant_id,
  type,
  category,
  amount,
  amount_cents,
  student_payment_id,
  occurred_at,
  description
) values (
  '80000000-0000-4000-8000-00000000d101',
  'billing-schedule-correction-test',
  'ENTRADA',
  'MENSALIDADE',
  169,
  16900,
  '20000000-0000-4000-8000-00000000d101',
  pg_catalog.now(),
  'fixture that must block terminal compensation'
);
select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATED',
           completed_at = pg_catalog.clock_timestamp()
     where id = '50000000-0000-4000-8000-00000000d101'
  $sql$,
  '55000',
  'terminal compensation trusted local PENDING with a financial transaction'
);
delete from public.financial_transactions
 where id = '80000000-0000-4000-8000-00000000d101';

create or replace function pg_temp.exercise_out_of_order_compensation_rejected()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_terminal_rejected boolean := false;
  v_early_delete_process_rejected boolean := false;
  v_stale_restore_rejected boolean := false;
begin
  update public.asaas_webhook_inbox as deleted
     set received_at = restored.received_at + interval '1 second',
         last_received_at = restored.received_at + interval '1 second',
         processed_at = restored.processed_at + interval '1 second'
    from public.asaas_webhook_inbox as restored
   where deleted.provider_event_id = 'evt_schedule_payment_deleted'
     and restored.provider_event_id = 'evt_schedule_payment_restored';

  begin
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATED',
           completed_at = pg_catalog.clock_timestamp()
     where id = '50000000-0000-4000-8000-00000000d101';
  exception when sqlstate '55000' then
    v_terminal_rejected := true;
  end;

  update public.asaas_webhook_inbox as deleted
     set received_at = delete_step.submitted_at,
         last_received_at = delete_step.submitted_at,
         processed_at = delete_step.submitted_at - interval '1 second'
    from public.asaas_student_billing_schedule_correction_steps as delete_step
   where deleted.provider_event_id = 'evt_schedule_payment_deleted'
     and delete_step.id = '60000000-0000-4000-8000-00000000d102';

  begin
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATED',
           completed_at = pg_catalog.clock_timestamp()
     where id = '50000000-0000-4000-8000-00000000d101';
  exception when sqlstate '55000' then
    v_early_delete_process_rejected := true;
  end;

  update public.asaas_webhook_inbox as deleted
     set received_at = delete_step.submitted_at,
         last_received_at = delete_step.submitted_at,
         processed_at = delete_step.submitted_at
    from public.asaas_student_billing_schedule_correction_steps as delete_step
   where deleted.provider_event_id = 'evt_schedule_payment_deleted'
     and delete_step.id = '60000000-0000-4000-8000-00000000d102';
  update public.asaas_webhook_inbox as restored
     set received_at = restore_step.submitted_at - interval '1 second',
         last_received_at = restore_step.submitted_at - interval '1 second',
         processed_at = restore_step.submitted_at - interval '1 second'
    from public.asaas_student_billing_schedule_correction_steps as restore_step
   where restored.provider_event_id = 'evt_schedule_payment_restored'
     and restore_step.id = '60000000-0000-4000-8000-00000000d105';

  begin
    update public.asaas_student_billing_schedule_corrections
       set status = 'COMPENSATED',
           completed_at = pg_catalog.clock_timestamp()
     where id = '50000000-0000-4000-8000-00000000d101';
  exception when sqlstate '55000' then
    v_stale_restore_rejected := true;
  end;

  if not v_terminal_rejected
     or not v_early_delete_process_rejected
     or not v_stale_restore_rejected
     or private.asaas_billing_schedule_compensation_causal(
       '50000000-0000-4000-8000-00000000d101'
     )
  then
    raise exception 'out-of-order DELETE/RESTORE evidence was accepted';
  end if;

  raise exception using
    errcode = 'Z0051',
    message = 'out-of-order compensation rejected';
end;
$$;

select pg_temp.assert_sqlstate(
  $$select pg_temp.exercise_out_of_order_compensation_rejected()$$,
  'Z0051',
  'out-of-order or pre-RESTORE webhook evidence was accepted'
);

select pg_temp.assert_true(
  private.asaas_billing_schedule_compensation_causal(
    '50000000-0000-4000-8000-00000000d101'
  ),
  'exact ordered PAYMENT_DELETED/PAYMENT_RESTORED evidence was not causal'
);

update public.asaas_student_billing_schedule_corrections
   set status = 'COMPENSATED',
       completed_at = pg_catalog.clock_timestamp()
 where id = '50000000-0000-4000-8000-00000000d101';

select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_corrections
       set status = 'READY',
           completed_at = null
     where id = '50000000-0000-4000-8000-00000000d101'
  $sql$,
  '55000',
  'terminal compensation could re-enter the active state machine'
);

set local role service_role;
insert into pg_temp.schedule_observation_results values (
  'compensated-operation-delayed-event',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_compensated_delayed',
    'SUBSCRIPTION_UPDATED',
    'sub_schedule_correction_a',
    'cus_schedule_correction_a',
    'ACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_compensated_delayed",
      "event":"SUBSCRIPTION_UPDATED",
      "subscription":{
        "id":"sub_schedule_correction_a",
        "customer":"cus_schedule_correction_a",
        "status":"ACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-a",
        "maxPayments":12,
        "nextDueDate":"2035-11-10",
        "endDate":"2036-09-10"
      }
    }'::jsonb,
    pg_catalog.now()
  )
);
reset role;

select pg_temp.assert_true(
  (select payload ->> 'handled' = 'true'
      and payload ->> 'step_kind' = 'ACTIVATE_ORIGINAL_SCHEDULE'
     from schedule_observation_results
    where label = 'compensated-operation-delayed-event'),
  'in-window event was lost after the operation became COMPENSATED'
);

insert into public.asaas_student_billing_schedule_corrections (
  id,
  operation_key,
  tenant_id,
  student_id,
  offer_id,
  old_student_payment_id,
  target_billing_claim_id,
  customer_id,
  subscription_id,
  old_payment_id,
  target_due_date,
  target_end_date,
  original_subscription_snapshot,
  original_payment_snapshot,
  target_subscription_snapshot,
  integration_snapshot,
  status,
  accept_events_until,
  started_at,
  created_at
) values (
  '50000000-0000-4000-8000-00000000d102',
  'schedule-correction-expired',
  'billing-schedule-correction-test',
  '00000000-0000-4000-8000-00000000d102',
  '10000000-0000-4000-8000-00000000d102',
  '20000000-0000-4000-8000-00000000d102',
  '30000000-0000-4000-8000-00000000d102',
  'cus_schedule_correction_b',
  'sub_schedule_correction_b',
  'pay_schedule_correction_b',
  date '2035-12-10',
  date '2036-11-10',
  '{
    "id":"sub_schedule_correction_b",
    "customer":"cus_schedule_correction_b",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-b",
    "maxPayments":12,
    "nextDueDate":"2036-02-10",
    "endDate":"2036-12-10"
  }'::jsonb,
  '{
    "id":"pay_schedule_correction_b",
    "subscription":"sub_schedule_correction_b",
    "customer":"cus_schedule_correction_b",
    "status":"PENDING",
    "deleted":false,
    "dueDate":"2036-01-10",
    "originalDueDate":"2036-01-10",
    "paymentDate":null,
    "confirmedDate":null,
    "creditDate":null,
    "value":169,
    "billingType":"CREDIT_CARD"
  }'::jsonb,
  '{
    "id":"sub_schedule_correction_b",
    "customer":"cus_schedule_correction_b",
    "status":"ACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-b",
    "maxPayments":12,
    "nextDueDate":"2035-12-10",
    "endDate":"2036-11-10"
  }'::jsonb,
  '{"integrationId":"integration-fixture","version":1}'::jsonb,
  'INACTIVATING',
  pg_catalog.now() - interval '1 hour',
  pg_catalog.now() - interval '2 hours',
  pg_catalog.now() - interval '2 hours'
);

insert into public.asaas_student_billing_schedule_correction_steps (
  id,
  operation_id,
  step_kind,
  route_kind,
  ordinal,
  status,
  request_fingerprint,
  expected_before,
  desired_after,
  provider_request,
  submit_attempt_count,
  submitted_at
) values (
  '60000000-0000-4000-8000-00000000d201',
  '50000000-0000-4000-8000-00000000d102',
  'INACTIVATE_SUBSCRIPTION',
  'TARGET',
  10,
  'SUBMITTING',
  repeat('f', 64),
  '{"status":"ACTIVE"}',
  '{
    "id":"sub_schedule_correction_b",
    "customer":"cus_schedule_correction_b",
    "status":"INACTIVE",
    "billingType":"CREDIT_CARD",
    "cycle":"MONTHLY",
    "value":169,
    "externalReference":"schedule-correction-b",
    "maxPayments":12,
    "nextDueDate":"2036-02-10",
    "endDate":"2036-12-10"
  }'::jsonb,
  '{"method":"PUT","status":"INACTIVE"}',
  1,
  pg_catalog.now() - interval '2 hours'
);

insert into public.asaas_student_billing_schedule_correction_steps (
  id,
  operation_id,
  step_kind,
  route_kind,
  ordinal,
  status,
  request_fingerprint,
  expected_before,
  desired_after,
  provider_request
) values (
  '60000000-0000-4000-8000-00000000d202',
  '50000000-0000-4000-8000-00000000d102',
  'DELETE_OLD_PAYMENT',
  'TARGET',
  20,
  'READY',
  pg_catalog.repeat('6', 64),
  '{"deleted":false}',
  '{"deleted":true}',
  '{"method":"DELETE","paymentId":"pay_schedule_correction_b"}'
);
select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_correction_steps
       set status = 'SUBMITTING',
           submit_attempt_count = 1,
           submitted_at = pg_catalog.clock_timestamp()
     where id = '60000000-0000-4000-8000-00000000d202'
  $sql$,
  '55000',
  'provider submission started after the event acceptance window expired'
);

set local role service_role;
insert into pg_temp.schedule_observation_results values (
  'received-before-window-drained-after',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_expired',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_b',
    'cus_schedule_correction_b',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_expired",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_b",
        "customer":"cus_schedule_correction_b",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-b",
        "maxPayments":12,
        "nextDueDate":"2036-02-10",
        "endDate":"2036-12-10"
      }
    }'::jsonb,
    pg_catalog.now() - interval '90 minutes'
  )
);
insert into pg_temp.schedule_observation_results values (
  'received-after-window',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_received_late',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_b',
    'cus_schedule_correction_b',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_received_late",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_b",
        "customer":"cus_schedule_correction_b",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-b",
        "maxPayments":12,
        "nextDueDate":"2036-02-10",
        "endDate":"2036-12-10"
      }
    }'::jsonb
  )
);
reset role;

select pg_temp.assert_true(
  (select payload ->> 'handled' = 'true'
      and payload ->> 'step_kind' = 'INACTIVATE_SUBSCRIPTION'
     from schedule_observation_results
    where label = 'received-before-window-drained-after')
  and (select payload ->> 'handled' = 'false'
      and payload ->> 'reason' = 'no_expected_schedule_correction_event'
     from schedule_observation_results where label = 'received-after-window')
  and exists (
    select 1
      from public.asaas_student_billing_schedule_correction_events
     where provider_event_id = 'evt_schedule_expired'
       and received_at <= (
         select accept_events_until
           from public.asaas_student_billing_schedule_corrections
          where id = '50000000-0000-4000-8000-00000000d102'
       )
  )
  and not exists (
    select 1
      from public.asaas_student_billing_schedule_correction_events
     where provider_event_id = 'evt_schedule_received_late'
  ),
  'receipt-time window rejected a valid retry or accepted a late delivery'
);

update public.asaas_student_billing_schedule_corrections
   set status = 'COMPLETED',
       completed_at = pg_catalog.clock_timestamp()
 where id = '50000000-0000-4000-8000-00000000d102';

set local role service_role;
insert into pg_temp.schedule_observation_results values (
  'completed-operation-delayed-event',
  pg_temp.observe_schedule_fixture(
    'evt_schedule_completed_delayed',
    'SUBSCRIPTION_INACTIVATED',
    'sub_schedule_correction_b',
    'cus_schedule_correction_b',
    'INACTIVE',
    pg_catalog.now(),
    '{
      "id":"evt_schedule_completed_delayed",
      "event":"SUBSCRIPTION_INACTIVATED",
      "subscription":{
        "id":"sub_schedule_correction_b",
        "customer":"cus_schedule_correction_b",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-b",
        "maxPayments":12,
        "nextDueDate":"2036-02-10",
        "endDate":"2036-12-10"
      }
    }'::jsonb,
    pg_catalog.now() - interval '80 minutes'
  )
);
reset role;

select pg_temp.assert_true(
  (select payload ->> 'handled' = 'true'
      and payload ->> 'step_kind' = 'INACTIVATE_SUBSCRIPTION'
     from schedule_observation_results
    where label = 'completed-operation-delayed-event'),
  'in-window event was lost after the operation became COMPLETED'
);

select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_correction_steps
       set submit_attempt_count = 2
     where id = '60000000-0000-4000-8000-00000000d103'
  $sql$,
  '55000',
  'a submitted provider step can be replayed'
);

select pg_temp.assert_sqlstate(
  $sql$
    update public.asaas_student_billing_schedule_corrections
       set target_due_date = date '2035-09-11'
     where id = '50000000-0000-4000-8000-00000000d101'
  $sql$,
  '55000',
  'operation identity/snapshots are mutable'
);

select pg_temp.assert_sqlstate(
  $sql$
    insert into public.asaas_student_billing_schedule_correction_steps (
      operation_id,
      step_kind,
      route_kind,
      ordinal,
      status,
      request_fingerprint,
      expected_before,
      desired_after,
      provider_request
    ) values (
      '50000000-0000-4000-8000-00000000d102',
      'INACTIVATE_CONFLICTED_SUBSCRIPTION',
      'COMPENSATION',
      35,
      'READY',
      repeat('4', 64),
      '{
        "id":"sub_schedule_correction_b",
        "customer":"cus_schedule_correction_b",
        "status":"ACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-b",
        "maxPayments":12,
        "nextDueDate":"2035-12-10",
        "endDate":"2036-11-10"
      }'::jsonb,
      '{
        "id":"sub_schedule_correction_b",
        "customer":"cus_schedule_correction_b",
        "status":"INACTIVE",
        "billingType":"CREDIT_CARD",
        "cycle":"MONTHLY",
        "value":169,
        "externalReference":"schedule-correction-b",
        "maxPayments":12,
        "nextDueDate":"2035-12-10",
        "endDate":"2036-11-10"
      }'::jsonb,
      '{
        "method":"PUT",
        "path":"/subscriptions/sub_schedule_correction_b",
        "body":{"status":"ACTIVE"}
      }'::jsonb
    )
  $sql$,
  '23514',
  'containment step accepted a provider request other than PUT INACTIVE'
);

select pg_temp.assert_sqlstate(
  $sql$
    insert into public.asaas_student_billing_schedule_correction_steps (
      operation_id,
      step_kind,
      route_kind,
      ordinal,
      status,
      request_fingerprint,
      expected_before,
      desired_after,
      provider_request
    ) values (
      '50000000-0000-4000-8000-00000000d102',
      'DELETE_OLD_PAYMENT',
      'COMPENSATION',
      20,
      'READY',
      repeat('0', 64),
      '{"deleted":false}',
      '{"deleted":true}',
      '{"method":"DELETE"}'
    )
  $sql$,
  '23514',
  'target and compensation step routes can be crossed'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 4
      from public.asaas_student_billing_schedule_correction_events
     where operation_id = '50000000-0000-4000-8000-00000000d101'
  )
  and (
    select pg_catalog.count(*) = 2
      from public.asaas_student_billing_schedule_correction_events
     where operation_id = '50000000-0000-4000-8000-00000000d102'
  ),
  'event ledger lost idempotency or operation isolation'
);

rollback;
