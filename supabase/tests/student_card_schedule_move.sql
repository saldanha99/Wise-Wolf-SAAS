-- A recurring card calendar move is durable, private, retryable only after a
-- terminal rollback, and never weakens the canonical student lifecycle fence.

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
    if sqlstate = expected_sqlstate then return; end if;
    raise exception 'assertion failed: % (expected %, received %: %)',
      message, expected_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception 'assertion failed: % (statement did not fail)', message;
end;
$$;

grant execute on function pg_temp.assert_true(boolean, text)
  to anon, authenticated, service_role;
grant execute on function pg_temp.assert_sqlstate(text, text, text)
  to anon, authenticated, service_role;

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'anon', 'public.asaas_student_card_schedule_moves', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.asaas_student_card_schedule_moves', 'SELECT'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.asaas_student_card_schedule_moves', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.asaas_student_card_schedule_moves', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.asaas_student_card_schedule_moves', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.asaas_student_card_schedule_moves', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'anon', 'public.asaas_student_card_schedule_move_steps', 'SELECT'
  )
  and pg_catalog.has_table_privilege(
    'service_role', 'public.asaas_student_card_schedule_move_steps', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'public.asaas_student_card_schedule_move_steps', 'UPDATE'
  ),
  'move ledgers expose unsafe privileges'
);

select pg_temp.assert_true(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_card_schedule_moves'::pg_catalog.regclass
  )
  and (
    select relation.relrowsecurity and relation.relforcerowsecurity
      from pg_catalog.pg_class as relation
     where relation.oid =
       'public.asaas_student_card_schedule_move_steps'::pg_catalog.regclass
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
  ),
  'RLS or observer authority is unsafe'
);

select pg_temp.assert_true(
  (
    select index.indexprs is null
      and pg_catalog.strpos(
        pg_catalog.pg_get_expr(index.indpred, index.indrelid), 'FAILED'
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_expr(index.indpred, index.indrelid), 'COMPENSATED'
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.pg_get_expr(index.indpred, index.indrelid), 'COMPLETED'
      ) = 0
      from pg_catalog.pg_index as index
     where index.indexrelid =
       'public.asaas_student_card_schedule_moves_payment_active_uidx'::pg_catalog.regclass
  ),
  'payment retry index does not exclude only rolled-back terminal rows'
);

select pg_temp.assert_true(
  private.student_card_schedule_move_fingerprint(
    'move:test:one', 'card-move-test',
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000002',
    'cus_card_move_test', 'sub_card_move_test', 'pay_card_move_test',
    date '2035-10-10', date '2035-09-10', date '2035-10-10',
    date '2035-11-10', date '2036-08-10', date '2036-09-10', 169, 12
  ) = private.student_card_schedule_move_fingerprint(
    'move:test:one', 'card-move-test',
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000002',
    'cus_card_move_test', 'sub_card_move_test', 'pay_card_move_test',
    date '2035-10-10', date '2035-09-10', date '2035-10-10',
    date '2035-11-10', date '2036-08-10', date '2036-09-10', 169, 12
  )
  and private.student_card_schedule_move_fingerprint(
    'move:test:one', 'card-move-test',
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000002',
    'cus_card_move_test', 'sub_card_move_test', 'pay_card_move_test',
    date '2035-10-10', date '2035-09-10', date '2035-10-10',
    date '2035-11-10', date '2036-08-10', date '2036-09-10', 169, 12
  ) <> private.student_card_schedule_move_fingerprint(
    'move:test:two', 'card-move-test',
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000002',
    'cus_card_move_test', 'sub_card_move_test', 'pay_card_move_test',
    date '2035-10-10', date '2035-09-10', date '2035-10-10',
    date '2035-11-10', date '2036-08-10', date '2036-09-10', 169, 12
  ),
  'server fingerprint is not deterministic and intent-bound'
);

insert into public.tenants (id, name, slug, saas_status)
values ('card-move-test', 'Card Move Test', 'card-move-test', 'active');

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '93000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'card-move@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Card Move Test"}', pg_catalog.now(), pg_catalog.now()
);

insert into public.profiles (id, email, full_name, role, tenant_id)
values (
  '93000000-0000-4000-8000-000000000001',
  'card-move@example.invalid', 'Card Move Test', 'STUDENT', 'card-move-test'
) on conflict (id) do nothing;

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'card-move-test',
       role = 'STUDENT',
       status = 'Ativo',
       lifecycle_status = 'active',
       full_name = 'Card Move Test',
       cpf = null,
       asaas_customer_id = 'cus_card_move_test',
       subscription_id = 'sub_card_move_test',
       monthly_fee = 169,
       due_day = 10,
       start_date = date '2035-09-05',
       asaas_subscription_status = 'ACTIVE',
       asaas_subscription_end_date = date '2036-09-10',
       is_test_account = false,
       test_fixture_key = null
 where id = '93000000-0000-4000-8000-000000000001';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id = '93000000-0000-4000-8000-000000000001';
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '93000000-0000-4000-8000-000000000001',
  'card-move-test', 'STUDENT', 'ACTIVE', true
);

set local request.jwt.claims = '{"role":"service_role"}';
insert into public.offers (
  id, kind, tenant_id, payload, expires_at, created_by,
  requires_enrollment, enrollment_fee, processing_by, processing_state,
  metadata, invite_security_version
) values (
  '93000000-0000-4000-8000-000000000002',
  'ENROLLMENT', 'card-move-test',
  '{"planDuration":12,"value":169,"testMode":false,"test_fixture":true}',
  pg_catalog.now() + interval '1 day',
  '93000000-0000-4000-8000-000000000001', true, 0,
  '93000000-0000-4000-8000-000000000001', 'AWAITING_PAYMENT',
  '{"test_fixture":true,"notificationDisabled":true}', 1
);
reset request.jwt.claims;

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, asaas_id,
  provider_customer_id, value, amount_cents, status, provider_status,
  due_date, billing_type, payment_method, description, payment_type, raw_payload
) values (
  '93000000-0000-4000-8000-000000000003',
  '93000000-0000-4000-8000-000000000001',
  'card-move-test', 'pay_card_move_test', 'pay_card_move_test',
  'cus_card_move_test', 169, 16900, 'PENDING', 'PENDING',
  date '2035-10-10', 'CREDIT_CARD', null, 'October test payment',
  'SUBSCRIPTION', '{"testMode":true,"test_fixture":true}'
);

select pg_temp.assert_true(
  private.student_card_schedule_profile_exact(
    'card-move-test', '93000000-0000-4000-8000-000000000001',
    'cus_card_move_test', 'sub_card_move_test', 169,
    date '2035-09-10', date '2036-09-10',
    private.student_card_schedule_profile_snapshot(
      'card-move-test', '93000000-0000-4000-8000-000000000001'
    )
  ),
  'exact non-first-day financial profile was rejected'
);

select pg_temp.assert_true(
  private.student_card_schedule_local_payment_exact(
    '93000000-0000-4000-8000-000000000003',
    'card-move-test', '93000000-0000-4000-8000-000000000001',
    'pay_card_move_test', 'cus_card_move_test', date '2035-10-10', 169
  ),
  'legacy NULL payment_method rejected an exact card payment'
);
update public.student_payments set payment_method = 'PIX'
 where id = '93000000-0000-4000-8000-000000000003';
select pg_temp.assert_true(
  not private.student_card_schedule_local_payment_exact(
    '93000000-0000-4000-8000-000000000003',
    'card-move-test', '93000000-0000-4000-8000-000000000001',
    'pay_card_move_test', 'cus_card_move_test', date '2035-10-10', 169
  ),
  'contradictory payment_method was accepted'
);
update public.student_payments set payment_method = null
 where id = '93000000-0000-4000-8000-000000000003';

create temporary table card_move_fixture on commit drop as
select
  pg_catalog.jsonb_build_object(
    'id','sub_card_move_test','customer','cus_card_move_test',
    'status','ACTIVE','billingType','CREDIT_CARD','cycle','MONTHLY',
    'value',169,'maxPayments',12,'nextDueDate','2035-11-10',
    'endDate','2036-09-10',
    'externalReference','enrollment:93000000-0000-4000-8000-000000000002:subscription',
    'cardAttached',true
  ) as original_subscription,
  pg_catalog.jsonb_build_object(
    'id','pay_card_move_test','customer','cus_card_move_test',
    'subscription','sub_card_move_test','status','PENDING',
    'dueDate','2035-10-10','originalDueDate','2035-10-10',
    'billingType','CREDIT_CARD','externalReference',null,'value',169,
    'deleted',false,'paymentDate',null,'clientPaymentDate',null,
    'confirmedDate',null,'creditDate',null
  ) as original_payment;
alter table card_move_fixture add column target_subscription jsonb;
alter table card_move_fixture add column target_payment jsonb;
update card_move_fixture
   set target_subscription = original_subscription ||
         '{"nextDueDate":"2035-10-10","endDate":"2036-08-10"}',
       target_payment = pg_catalog.jsonb_set(
         original_payment, '{dueDate}', '"2035-09-10"', false
       );

insert into public.asaas_student_billing_period_claims (
  id, tenant_id, student_id, due_date, source, source_key,
  request_fingerprint, status, claim_token, lease_expires_at,
  submit_attempt_count, provider_entity_id
) values (
  '93000000-0000-4000-8000-000000000004', 'card-move-test',
  '93000000-0000-4000-8000-000000000001', date '2035-10-10',
  'SUBSCRIPTION',
  'subscription:93000000-0000-4000-8000-000000000002',
  pg_catalog.repeat('a',64), 'BOUND',
  '93000000-0000-4000-8000-000000000005', pg_catalog.now(), 1,
  'sub_card_move_test'
);

-- A previous rolled-back attempt must not consume the provider payment id.
insert into public.asaas_student_card_schedule_moves (
  id, operation_key, tenant_id, student_id, offer_id, student_payment_id,
  target_billing_claim_id, target_claim_fingerprint, customer_id,
  subscription_id, payment_id, old_due_date, target_due_date,
  target_next_due_date, original_next_due_date, target_end_date,
  original_end_date, expected_value, expected_max_payments,
  original_subscription_snapshot, target_subscription_snapshot,
  original_payment_snapshot, target_payment_snapshot,
  original_payments_snapshot, integration_snapshot, status,
  accept_events_until, completed_at
)
select
  '93000000-0000-4000-8000-000000000006', 'move:test:failed',
  'card-move-test', '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000002',
  '93000000-0000-4000-8000-000000000003', null,
  private.student_card_schedule_move_fingerprint(
    'move:test:failed','card-move-test',
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000002',
    'cus_card_move_test','sub_card_move_test','pay_card_move_test',
    date '2035-10-10',date '2035-09-10',date '2035-10-10',
    date '2035-11-10',date '2036-08-10',date '2036-09-10',169,12
  ),
  'cus_card_move_test','sub_card_move_test','pay_card_move_test',
  date '2035-10-10',date '2035-09-10',date '2035-10-10',
  date '2035-11-10',date '2036-08-10',date '2036-09-10',169,12,
  original_subscription,target_subscription,original_payment,target_payment,
  pg_catalog.jsonb_build_array(original_payment),
  '{"integrationId":"93000000-0000-4000-8000-000000000099","version":"1","mode":"DIRECT","environment":"sandbox","baseUrl":"https://api-sandbox.asaas.com/v3"}',
  'FAILED', pg_catalog.now() + interval '1 hour', pg_catalog.now()
from card_move_fixture;

insert into public.asaas_student_billing_period_claims (
  id, tenant_id, student_id, due_date, source, source_key,
  request_fingerprint, status, claim_token, lease_expires_at,
  submit_attempt_count, provider_entity_id
)
select
  '93000000-0000-4000-8000-000000000007', 'card-move-test',
  '93000000-0000-4000-8000-000000000001', date '2035-09-10',
  'SUBSCRIPTION',
  'subscription:93000000-0000-4000-8000-000000000002',
  private.student_card_schedule_move_fingerprint(
    'move:test:active','card-move-test',
    '93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000002',
    'cus_card_move_test','sub_card_move_test','pay_card_move_test',
    date '2035-10-10',date '2035-09-10',date '2035-10-10',
    date '2035-11-10',date '2036-08-10',date '2036-09-10',169,12
  ),
  'BOUND', '93000000-0000-4000-8000-000000000008',
  pg_catalog.now() + interval '1 hour', 1, 'sub_card_move_test';

insert into public.asaas_student_card_schedule_moves (
  id, operation_key, tenant_id, student_id, offer_id, student_payment_id,
  target_billing_claim_id, target_claim_fingerprint, customer_id,
  subscription_id, payment_id, old_due_date, target_due_date,
  target_next_due_date, original_next_due_date, target_end_date,
  original_end_date, expected_value, expected_max_payments,
  original_subscription_snapshot, target_subscription_snapshot,
  original_payment_snapshot, target_payment_snapshot,
  original_payments_snapshot, integration_snapshot, status,
  accept_events_until
)
select
  '93000000-0000-4000-8000-000000000009', 'move:test:active',
  'card-move-test', '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000002',
  '93000000-0000-4000-8000-000000000003',
  '93000000-0000-4000-8000-000000000007',
  claim.request_fingerprint,
  'cus_card_move_test','sub_card_move_test','pay_card_move_test',
  date '2035-10-10',date '2035-09-10',date '2035-10-10',
  date '2035-11-10',date '2036-08-10',date '2036-09-10',169,12,
  fixture.original_subscription,fixture.target_subscription,
  fixture.original_payment,fixture.target_payment,
  pg_catalog.jsonb_build_array(fixture.original_payment),
  '{"integrationId":"93000000-0000-4000-8000-000000000099","version":"1","mode":"DIRECT","environment":"sandbox","baseUrl":"https://api-sandbox.asaas.com/v3"}',
  'READY', pg_catalog.now() + interval '1 hour'
from card_move_fixture as fixture
join public.asaas_student_billing_period_claims as claim
  on claim.id = '93000000-0000-4000-8000-000000000007';

select pg_temp.assert_true(
  (select pg_catalog.count(*) = 2
     from public.asaas_student_card_schedule_moves
    where payment_id = 'pay_card_move_test')
  and private.student_card_schedule_move_active(
    'card-move-test','93000000-0000-4000-8000-000000000001',
    'sub_card_move_test'
  ),
  'terminal retry is blocked or active scope is invisible'
);

select pg_temp.assert_sqlstate(
  $$update public.asaas_student_card_schedule_moves
       set payment_id = 'pay_snapshot_tamper'
     where id = '93000000-0000-4000-8000-000000000009'$$,
  '55000', 'frozen operation identity was mutable'
);

select pg_temp.assert_sqlstate(
  $$insert into public.asaas_student_billing_period_claims (
      tenant_id,student_id,due_date,source,source_key,request_fingerprint,
      status,claim_token,lease_expires_at,submit_attempt_count
    ) values (
      'card-move-test','93000000-0000-4000-8000-000000000001',
      date '2035-12-10','SUBSCRIPTION',
      'subscription:93000000-0000-4000-8000-000000000002',
      repeat('b',64),'CLAIMED',
      '93000000-0000-4000-8000-000000000010',now()+interval '1 hour',0
    )$$,
  '55000', 'reciprocal period claim was allowed during an active move'
);

select pg_temp.assert_true(
  not private.student_subscription_mutation_scope_valid(
    'card-move-test','93000000-0000-4000-8000-000000000001',
    'cus_card_move_test','sub_card_move_test'
  ),
  'canonical subscription mutation scope ignored the active move'
);

select pg_temp.assert_sqlstate(
  $$update public.offers
       set metadata = coalesce(metadata, '{}'::jsonb) || '{"blocked":true}'
     where id = '93000000-0000-4000-8000-000000000002'$$,
  '55000', 'offer identity was mutable during an active move'
);

select pg_temp.assert_sqlstate(
  $$update public.profiles
       set monthly_fee = 170
     where id = '93000000-0000-4000-8000-000000000001'$$,
  '55000', 'financial profile was mutable during an active move'
);

select pg_temp.assert_sqlstate(
  $$update public.profiles
       set asaas_subscription_end_date = date '2036-08-10'
     where id = '93000000-0000-4000-8000-000000000001'$$,
  '55000', 'subscription end date was mutable before terminal reconcile'
);

set local app.enrollment_claim = '1';
select pg_temp.assert_sqlstate(
  $$update public.profiles
       set is_test_account = true,
           test_fixture_key = 'student-card-schedule-move:tamper'
     where id = '93000000-0000-4000-8000-000000000001'$$,
  '55000', 'real profile could be converted into a fixture during an active move'
);
set local app.enrollment_claim = '';

select pg_temp.assert_sqlstate(
  $$insert into public.tenant_memberships (
      tenant_id,user_id,role,status,is_primary
    ) values (
      'master','93000000-0000-4000-8000-000000000001',
      'STUDENT','ACTIVE',false
    )$$,
  '55000', 'cross-tenant membership was inserted during an active move'
);

insert into public.asaas_student_billing_period_claims (
  id,tenant_id,student_id,due_date,source,source_key,request_fingerprint,
  status,claim_token,lease_expires_at,submit_attempt_count,provider_entity_id
) values (
  '93000000-0000-4000-8000-000000000012','card-move-test',
  '93000000-0000-4000-8000-000000000001',date '2035-12-15',
  'SUBSCRIPTION','subscription:claim-new-side',repeat('d',64),'BOUND',
  '93000000-0000-4000-8000-000000000013',now()+interval '1 hour',0,
  'sub_claim_new_side'
);
select pg_temp.assert_sqlstate(
  $$update public.asaas_student_billing_period_claims
       set due_date = date '2035-09-15'
     where id = '93000000-0000-4000-8000-000000000012'$$,
  '55000', 'claim NEW side entered the protected target month'
);
delete from public.asaas_student_billing_period_claims
 where id = '93000000-0000-4000-8000-000000000012';

select pg_temp.assert_true(
  private.student_card_schedule_local_guard_clear(
    'card-move-test','93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000003','pay_card_move_test',
    'sub_card_move_test',
    private.student_card_schedule_local_guard_baseline(
      'card-move-test','93000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000003','pay_card_move_test',
      'sub_card_move_test'
    )
  ),
  'clean local automation state was rejected'
);

insert into public.asaas_webhook_inbox (
  provider_event_id,event_name,provider_entity_id,payload,payload_hash,status,
  attempt_count,delivery_count,received_at,last_received_at,updated_at
) values (
  'evt_card_move_pending_guard','PAYMENT_UPDATED','pay_card_move_test',
  '{"id":"evt_card_move_pending_guard","event":"PAYMENT_UPDATED","payment":{"id":"pay_card_move_test","customer":"cus_card_move_test","subscription":"sub_card_move_test","dueDate":"2035-09-10"}}',
  repeat('e',64),'RETRY',1,1,now(),now(),now()
);
select pg_temp.assert_true(
  private.student_card_schedule_local_guard_clear(
    'card-move-test','93000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000003','pay_card_move_test',
    'sub_card_move_test',
    '{"subscriptionCreatedOpenIssueIds":[],"subscriptionCreatedTriageEventIds":[]}'
  ) is false,
  'pending provider webhook did not close the local guard'
);
delete from public.asaas_webhook_inbox
 where provider_event_id = 'evt_card_move_pending_guard';

insert into public.asaas_student_card_schedule_move_steps (
  id,operation_id,step_kind,route_kind,ordinal,status,request_fingerprint,
  expected_before,desired_after,provider_request,submit_attempt_count,
  submitted_at
)
select
  '93000000-0000-4000-8000-000000000014',
  '93000000-0000-4000-8000-000000000009',
  'RESTORE_ORIGINAL_SCHEDULE','COMPENSATION',30,'SUBMITTING',repeat('f',64),
  target_subscription,original_subscription,
  '{"method":"PUT","path":"/subscriptions/sub_card_move_test","body":{"nextDueDate":"2035-11-10","endDate":"2036-09-10"}}',
  1,now()-interval '1 minute'
from card_move_fixture;
insert into public.asaas_webhook_inbox (
  provider_event_id,event_name,provider_entity_id,payload,payload_hash,status,
  attempt_count,delivery_count,lease_owner,lease_expires_at,received_at,
  last_received_at,updated_at
)
select
  'evt_card_move_minimal_subscription','SUBSCRIPTION_UPDATED',
  'sub_card_move_test',
  jsonb_build_object(
    'id','evt_card_move_minimal_subscription','event','SUBSCRIPTION_UPDATED',
    'subscription',jsonb_build_object(
      'id','sub_card_move_test','customer','cus_card_move_test',
      'status','ACTIVE','value',169,'cycle','MONTHLY',
      'billingType','CREDIT_CARD',
      'externalReference',
        'enrollment:93000000-0000-4000-8000-000000000002:subscription'
    )
  ),repeat('1',64),'PROCESSING',1,1,gen_random_uuid(),null,
  step.submitted_at+interval '1 second',step.submitted_at+interval '1 second',
  now()
from public.asaas_student_card_schedule_move_steps as step
where step.id = '93000000-0000-4000-8000-000000000014';
select pg_temp.assert_true(
  (public.observe_asaas_student_billing_schedule_event(
    'evt_card_move_minimal_subscription','SUBSCRIPTION_UPDATED',
    'sub_card_move_test','cus_card_move_test','ACTIVE',null,
    (select payload from public.asaas_webhook_inbox
      where provider_event_id='evt_card_move_minimal_subscription')
  ) ->> 'handled') = 'false',
  'observer accepted a PROCESSING inbox without a live lease'
);
update public.asaas_webhook_inbox
   set lease_expires_at=now()+interval '5 minutes'
 where provider_event_id='evt_card_move_minimal_subscription';
select pg_temp.assert_true(
  (public.observe_asaas_student_billing_schedule_event(
    'evt_card_move_minimal_subscription','SUBSCRIPTION_UPDATED',
    'sub_card_move_test','cus_card_move_test','ACTIVE',null,
    (select payload from public.asaas_webhook_inbox
      where provider_event_id='evt_card_move_minimal_subscription')
  ) ->> 'handled') = 'true',
  'official minimal SUBSCRIPTION_UPDATED payload was not correlated'
);
delete from public.asaas_webhook_inbox
 where provider_event_id='evt_card_move_minimal_subscription';
delete from public.asaas_student_card_schedule_move_steps
 where id='93000000-0000-4000-8000-000000000014';

insert into public.asaas_student_card_schedule_move_steps (
  id, operation_id, step_kind, route_kind, ordinal, status,
  request_fingerprint, expected_before, desired_after, provider_request,
  provider_response, observed_state, completed_at, last_error
)
select
  '93000000-0000-4000-8000-000000000011',
  '93000000-0000-4000-8000-000000000009',
  'UPDATE_TARGET_SCHEDULE','TARGET',20,'FAILED',pg_catalog.repeat('c',64),
  original_subscription,target_subscription,
  '{"method":"PUT","path":"/subscriptions/sub_card_move_test","body":{"nextDueDate":"2035-10-10","endDate":"2036-08-10"}}',
  '{"errors":[{"code":"rejected"}]}',original_subscription,
  pg_catalog.now(),'test_terminal_step'
from card_move_fixture;

select pg_temp.assert_sqlstate(
  $$update public.asaas_student_card_schedule_move_steps
       set provider_response = '{"tampered":true}'
     where id = '93000000-0000-4000-8000-000000000011'$$,
  '55000', 'terminal step evidence was mutable'
);

-- The finalizer deliberately writes the ledger terminal state before its
-- profile CAS. Both writes still live in one transaction and must roll back
-- together if any later fence fails.
do $target_profile_cas_rollback$
declare
  v_profile_updated boolean := false;
begin
  begin
    update public.asaas_student_card_schedule_moves
       set status = 'COMPLETED', completed_at = pg_catalog.clock_timestamp()
     where id = '93000000-0000-4000-8000-000000000009';
    update public.profiles
       set asaas_subscription_end_date = date '2036-08-10',
           asaas_subscription_synced_at = pg_catalog.clock_timestamp()
     where id = '93000000-0000-4000-8000-000000000001';
    v_profile_updated := found;
    raise exception 'force_target_profile_cas_rollback';
  exception when raise_exception then
    null;
  end;
  if not v_profile_updated then
    raise exception 'target profile CAS was not reached';
  end if;
end
$target_profile_cas_rollback$;
select pg_temp.assert_true(
  (select status = 'READY' and completed_at is null
     from public.asaas_student_card_schedule_moves
    where id = '93000000-0000-4000-8000-000000000009')
  and (select asaas_subscription_end_date = date '2036-09-10'
         from public.profiles
        where id = '93000000-0000-4000-8000-000000000001'),
  'target ledger/profile CAS did not roll back atomically'
);

do $compensation_profile_cas_rollback$
declare
  v_profile_updated boolean := false;
  v_claim_deleted boolean := false;
begin
  begin
    update public.asaas_student_card_schedule_moves
       set status = 'COMPENSATED', target_billing_claim_id = null,
           completed_at = pg_catalog.clock_timestamp()
     where id = '93000000-0000-4000-8000-000000000009';
    update public.profiles
       set asaas_subscription_synced_at = pg_catalog.clock_timestamp()
     where id = '93000000-0000-4000-8000-000000000001';
    v_profile_updated := found;
    delete from public.asaas_student_billing_period_claims
     where id = '93000000-0000-4000-8000-000000000007';
    v_claim_deleted := found;
    raise exception 'force_compensation_profile_cas_rollback';
  exception when raise_exception then
    null;
  end;
  if not v_profile_updated or not v_claim_deleted then
    raise exception 'compensation profile/claim CAS was not reached';
  end if;
end
$compensation_profile_cas_rollback$;
select pg_temp.assert_true(
  (select status = 'READY' and target_billing_claim_id =
            '93000000-0000-4000-8000-000000000007'
     from public.asaas_student_card_schedule_moves
    where id = '93000000-0000-4000-8000-000000000009')
  and exists (
    select 1 from public.asaas_student_billing_period_claims
     where id = '93000000-0000-4000-8000-000000000007'
  ),
  'compensation ledger/profile/claim CAS did not roll back atomically'
);

-- Terminal cleanup keeps the audit snapshot but releases the target claim and
-- allows a later retry of the same provider payment.
update public.asaas_student_card_schedule_moves
   set status = 'FAILED', target_billing_claim_id = null,
       completed_at = pg_catalog.now(), last_error = 'test_terminal_cleanup'
 where id = '93000000-0000-4000-8000-000000000009';
delete from public.asaas_student_billing_period_claims
 where id = '93000000-0000-4000-8000-000000000007';

update public.offers
   set metadata = coalesce(metadata, '{}'::jsonb) || '{"terminalUpdate":true}'
 where id = '93000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(
  (select metadata @> '{"terminalUpdate":true}'::jsonb
     from public.offers
    where id = '93000000-0000-4000-8000-000000000002'),
  'offer trigger replaced NEW with OLD after the move became terminal'
);

update public.profiles
   set monthly_fee = 170,
       asaas_subscription_synced_at = pg_catalog.clock_timestamp()
 where id = '93000000-0000-4000-8000-000000000001';
select pg_temp.assert_true(
  (select monthly_fee = 170
     from public.profiles
    where id = '93000000-0000-4000-8000-000000000001'),
  'ordinary profile update stayed blocked after terminal cleanup'
);

select pg_temp.assert_true(
  (select status = 'FAILED' and target_billing_claim_id is null
     from public.asaas_student_card_schedule_moves
    where id = '93000000-0000-4000-8000-000000000009')
  and not private.student_card_schedule_move_active(
    'card-move-test','93000000-0000-4000-8000-000000000001',
    'sub_card_move_test'
  ),
  'terminal status did not remain visible after claim release'
);

select pg_temp.assert_sqlstate(
  $$update public.asaas_student_card_schedule_moves
       set last_error = 'tampered'
     where id = '93000000-0000-4000-8000-000000000009'$$,
  '55000', 'terminal operation evidence was mutable'
);

delete from public.student_payments
 where id = '93000000-0000-4000-8000-000000000003';
select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 2
      from public.asaas_student_card_schedule_moves
     where payment_id = 'pay_card_move_test'
       and student_payment_id is null
       and status = 'FAILED'
  ),
  'terminal audit rows blocked payment cleanup or lost their snapshots'
);

rollback;
