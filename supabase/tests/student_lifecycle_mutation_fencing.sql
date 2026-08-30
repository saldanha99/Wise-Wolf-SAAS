-- Student lifecycle provider mutations are fenced, snapshot-bound and
-- monotonic across retries and concurrent payment events.

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

-- Keep service-role authorization in the same session across rollback-heavy test
-- sections that may otherwise clear transaction-local GUCs.
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  false
);

select pg_temp.assert_true(
  not has_table_privilege('anon', 'public.student_offboarding_operations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.student_account_deletion_claims', 'SELECT')
  and has_table_privilege('service_role', 'public.student_offboarding_operations', 'SELECT')
  and not has_table_privilege('service_role', 'public.student_offboarding_operations', 'UPDATE')
  and has_table_privilege('service_role', 'public.student_overdue_card_charge_claims', 'SELECT')
  and not has_table_privilege('service_role', 'public.student_overdue_card_charge_claims', 'UPDATE')
  and has_table_privilege('service_role', 'public.student_billing_method_operations', 'SELECT')
  and not has_table_privilege('service_role', 'public.student_billing_method_operations', 'UPDATE'),
  'lifecycle claim tables expose unsafe direct access'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.begin_student_offboarding(text,uuid,uuid,text,text,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finalize_student_offboarding(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.claim_student_overdue_card_charge(text,uuid,text,text,uuid,uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.bind_student_offboarding_integrations(uuid,uuid,text,integer,text,text,text,integer,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bind_student_account_deletion_integrations(uuid,uuid,text,integer,text,text,text,integer,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.begin_student_billing_method_operation(text,uuid,uuid,text,text,text,text,text,text,integer,text,text,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_inactive_student_payment_settlement(text,uuid,uuid,text,text,text,text,timestamp with time zone,integer,text,numeric,date,timestamp with time zone,timestamp with time zone,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.apply_active_student_payment_event(text,uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer,text,numeric,date,date,text,text,text,text,timestamp with time zone,timestamp with time zone,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.apply_active_student_payment_event(text,uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer,text,numeric,date,date,text,text,text,text,timestamp with time zone,timestamp with time zone,jsonb)',
    'EXECUTE'
  ),
  'lifecycle claim RPC privileges are unsafe'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values (
  'student-lifecycle-fence', 'Student Lifecycle Fence',
  'student-lifecycle-fence', 'active', true
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000d501',
    'authenticated', 'authenticated', 'offboard@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Offboard Fence"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000d502',
    'authenticated', 'authenticated', 'delete@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Delete Fence"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000d503',
    'authenticated', 'authenticated', 'overdue@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Overdue Fence"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000d504',
    'authenticated', 'authenticated', 'creation@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Creation Fence"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000d505',
    'authenticated', 'authenticated', 'delete-no-provider@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Delete No Provider"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'student-lifecycle-fence',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Offboard Fence',
       cpf = null,
       asaas_customer_id = 'cus_offboard_fence',
       subscription_id = 'sub_offboard_fence'
 where id = '00000000-0000-4000-8000-00000000d501';
update public.profiles
   set tenant_id = 'student-lifecycle-fence',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Delete Fence',
       cpf = '28718884857',
       is_test_account = true,
       asaas_customer_id = 'cus_delete_fence',
       subscription_id = 'sub_delete_fence'
 where id = '00000000-0000-4000-8000-00000000d502';
update public.profiles
   set tenant_id = 'student-lifecycle-fence',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Overdue Fence',
       cpf = null,
       asaas_customer_id = 'cus_overdue_fence',
       subscription_id = 'sub_overdue_fence'
 where id = '00000000-0000-4000-8000-00000000d503';
update public.profiles
   set tenant_id = 'student-lifecycle-fence',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Creation Fence',
       cpf = null,
       asaas_customer_id = 'cus_creation_fence',
       subscription_id = 'sub_creation_fence'
 where id = '00000000-0000-4000-8000-00000000d504';
update public.profiles
   set tenant_id = 'student-lifecycle-fence',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Delete No Provider',
       cpf = '00000000000',
       is_test_account = true,
       asaas_customer_id = null,
       subscription_id = null
 where id = '00000000-0000-4000-8000-00000000d505';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '00000000-0000-4000-8000-00000000d501',
   '00000000-0000-4000-8000-00000000d502',
   '00000000-0000-4000-8000-00000000d503',
   '00000000-0000-4000-8000-00000000d504',
   '00000000-0000-4000-8000-00000000d505'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '00000000-0000-4000-8000-00000000d501',
    'student-lifecycle-fence', 'STUDENT', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000d502',
    'student-lifecycle-fence', 'STUDENT', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000d503',
    'student-lifecycle-fence', 'STUDENT', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence', 'STUDENT', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000d505',
    'student-lifecycle-fence', 'STUDENT', 'ACTIVE', true
  );

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, due_date
) values
  (
    '10000000-0000-4000-8000-00000000d501',
    '00000000-0000-4000-8000-00000000d501',
    'student-lifecycle-fence', 'pay_future_pending', 'cus_offboard_fence',
    100, 'PENDING',
    current_date + 10
  ),
  (
    '10000000-0000-4000-8000-00000000d502',
    '00000000-0000-4000-8000-00000000d501',
    'student-lifecycle-fence', 'pay_future_received', 'cus_offboard_fence',
    100, 'PENDING',
    current_date + 10
  ),
  (
    '10000000-0000-4000-8000-00000000d503',
    '00000000-0000-4000-8000-00000000d503',
    'student-lifecycle-fence', 'pay_overdue_fence', 'cus_overdue_fence',
    100, 'OVERDUE', current_date - 10
  );

create temporary table lifecycle_results (
  label text primary key,
  payload jsonb not null
);

create or replace function pg_temp.apply_fixture_active_payment_event(
  p_student_id uuid,
  p_customer_id text,
  p_payment_id text,
  p_event_id text,
  p_due_date date,
  p_event_at timestamptz
)
returns jsonb
language sql
as $$
  select public.apply_active_student_payment_event(
    p_payment_id,
    null,
    p_student_id,
    'student-lifecycle-fence',
    p_customer_id,
    null,
    p_student_id::text,
    p_event_id,
    'PAYMENT_CREATED',
    p_event_at,
    20,
    'PENDING',
    50,
    p_due_date,
    null,
    'PIX',
    null,
    'Mensalidade',
    'SUBSCRIPTION',
    null,
    null,
    jsonb_build_object(
      'id', p_event_id,
      'event', 'PAYMENT_CREATED',
      'dateCreated', p_event_at,
      'payment', jsonb_build_object(
        'id', p_payment_id,
        'customer', p_customer_id,
        'status', 'PENDING',
        'value', 50,
        'dueDate', p_due_date::text,
        'billingType', 'PIX',
        'description', 'Mensalidade',
        'externalReference', p_student_id::text
      )
    )
  );
$$;

-- These savepoints exercise both serial orders guaranteed by the shared
-- advisory. If the webhook wins, its row is part of the later lifecycle
-- snapshot. If the lifecycle claim wins, the webhook cannot insert it.
savepoint active_webhook_before_offboarding;
do $active_webhook_before_offboarding$
declare
  event_time timestamptz := pg_catalog.clock_timestamp();
  applied jsonb;
  replayed jsonb;
  same_order_collision jsonb;
  ignored jsonb;
  begun jsonb;
begin
  applied := pg_temp.apply_fixture_active_payment_event(
    '00000000-0000-4000-8000-00000000d504',
    'cus_creation_fence',
    'pay_webhook_before_offboarding',
    'evt_webhook_before_offboarding',
    current_date + 25,
    event_time
  );
  replayed := pg_temp.apply_fixture_active_payment_event(
    '00000000-0000-4000-8000-00000000d504',
    'cus_creation_fence',
    'pay_webhook_before_offboarding',
    'evt_webhook_before_offboarding',
    current_date + 25,
    event_time
  );
  same_order_collision := pg_temp.apply_fixture_active_payment_event(
    '00000000-0000-4000-8000-00000000d504',
    'cus_creation_fence',
    'pay_webhook_before_offboarding',
    'evt_collision_before_offboarding',
    current_date + 25,
    event_time
  );
  ignored := pg_temp.apply_fixture_active_payment_event(
    '00000000-0000-4000-8000-00000000d504',
    'cus_creation_fence',
    'pay_webhook_before_offboarding',
    'evt_older_before_offboarding',
    current_date + 25,
    event_time - interval '1 day'
  );
  begun := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null,
    'offboarded',
    'fixture',
    '51000000-0000-4000-8000-00000000d504',
    300
  );
  if applied->>'action' <> 'INSERTED'
     or replayed->>'action' <> 'REPLAY'
     or same_order_collision->>'action' <> 'IGNORED'
     or ignored->>'action' <> 'IGNORED'
     or begun->>'action' <> 'PROCEED'
     or not exists (
       select 1
         from jsonb_array_elements(begun->'payment_snapshot') as entry
        where entry->>'asaas_payment_id' = 'pay_webhook_before_offboarding'
     )
     or not exists (
       select 1 from public.student_payments as payment
        where payment.asaas_payment_id = 'pay_webhook_before_offboarding'
          and payment.last_provider_event_id = 'evt_webhook_before_offboarding'
     )
  then
    raise exception 'webhook-first offboarding serialization failed: %, %, %, %, %',
      applied, replayed, same_order_collision, ignored, begun;
  end if;
end;
$active_webhook_before_offboarding$;
rollback to savepoint active_webhook_before_offboarding;
release savepoint active_webhook_before_offboarding;

savepoint offboarding_before_active_webhook;
do $offboarding_before_active_webhook$
declare
  begun jsonb;
  blocked jsonb;
begin
  begun := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null,
    'offboarded',
    'fixture',
    '51100000-0000-4000-8000-00000000d504',
    300
  );
  blocked := pg_temp.apply_fixture_active_payment_event(
    '00000000-0000-4000-8000-00000000d504',
    'cus_creation_fence',
    'pay_webhook_after_offboarding',
    'evt_webhook_after_offboarding',
    current_date + 25,
    pg_catalog.clock_timestamp()
  );
  if begun->>'action' <> 'PROCEED'
     or coalesce((blocked->>'ok')::boolean, false)
     or blocked->>'reason' <> 'student_lifecycle_or_binding_changed'
     or exists (
       select 1 from public.student_payments
        where asaas_payment_id = 'pay_webhook_after_offboarding'
     )
  then
    raise exception 'offboarding-first webhook serialization failed: %, %', begun, blocked;
  end if;
end;
$offboarding_before_active_webhook$;
rollback to savepoint offboarding_before_active_webhook;
release savepoint offboarding_before_active_webhook;

-- The handler may have observed ACTIVE before the lifecycle operation committed.
-- The database RPC must still preserve the exact settlement as update-only
-- after taking the shared advisory; it may not lose cash or reactivate effects.
savepoint offboarding_between_active_read_and_settlement;
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, provider_status, due_date, billing_type
) values (
  '10f00000-0000-4000-8000-00000000d504',
  '00000000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'pay_settlement_after_active_read',
  'cus_creation_fence', 50, 'PENDING', 'PENDING', current_date + 25, 'PIX'
);
do $offboarding_between_active_read_and_settlement$
declare
  event_time timestamptz := pg_catalog.clock_timestamp();
  begun jsonb;
  recomputed jsonb;
  settled jsonb;
begin
  begun := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null, 'offboarded', 'fixture',
    '51f00000-0000-4000-8000-00000000d504', 300
  );
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );
  recomputed := public.recompute_student_financial_status(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504'
  );
  settled := public.apply_active_student_payment_event(
    'pay_settlement_after_active_read',
    '10f00000-0000-4000-8000-00000000d504',
    '00000000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    'cus_creation_fence',
    null,
    '00000000-0000-4000-8000-00000000d504',
    'evt_settlement_after_active_read',
    'PAYMENT_RECEIVED',
    event_time,
    80,
    'RECEIVED',
    50,
    current_date + 25,
    null,
    'PIX',
    null,
    'Mensalidade',
    'SUBSCRIPTION',
    event_time,
    null,
    jsonb_build_object(
      'id', 'evt_settlement_after_active_read',
      'event', 'PAYMENT_RECEIVED',
      'dateCreated', event_time,
      'payment', jsonb_build_object(
        'id', 'pay_settlement_after_active_read',
        'customer', 'cus_creation_fence',
        'status', 'RECEIVED',
        'value', 50,
        'dueDate', (current_date + 25)::text,
        'billingType', 'PIX',
        'description', 'Mensalidade',
        'externalReference', '00000000-0000-4000-8000-00000000d504'
      )
    )
  );
  if begun->>'action' <> 'PROCEED'
     or recomputed->>'action' <> 'PRESERVED'
     or recomputed->>'reason' <> 'student_lifecycle_operation_active'
     or settled->>'action' <> 'UPDATED'
     or settled->>'inactive_update_only' <> 'true'
     or not exists (
       select 1 from public.student_payments as payment
        where payment.id = '10f00000-0000-4000-8000-00000000d504'
          and payment.status = 'RECEIVED'
          and payment.last_provider_event_id = 'evt_settlement_after_active_read'
     )
     or exists (
       select 1 from public.notification_queue as notification
        where notification.source_id = '10f00000-0000-4000-8000-00000000d504'
     )
  then
    raise exception 'active-read/offboarding settlement fallback failed: %, %, %',
      begun, recomputed, settled;
  end if;
end;
$offboarding_between_active_read_and_settlement$;
rollback to savepoint offboarding_between_active_read_and_settlement;
release savepoint offboarding_between_active_read_and_settlement;

savepoint active_webhook_before_deletion;
do $active_webhook_before_deletion$
declare
  applied jsonb;
  begun jsonb;
begin
  applied := pg_temp.apply_fixture_active_payment_event(
    '00000000-0000-4000-8000-00000000d502',
    'cus_delete_fence',
    'pay_webhook_before_deletion',
    'evt_webhook_before_deletion',
    current_date + 25,
    pg_catalog.clock_timestamp()
  );
  begun := public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    null,
    '52000000-0000-4000-8000-00000000d502',
    300
  );
  if applied->>'action' <> 'INSERTED'
     or begun->>'action' <> 'PROCEED'
     or not exists (
       select 1 from public.student_payments
        where asaas_payment_id = 'pay_webhook_before_deletion'
     )
  then
    raise exception 'webhook-first deletion serialization failed: %, %', applied, begun;
  end if;
end;
$active_webhook_before_deletion$;
rollback to savepoint active_webhook_before_deletion;
release savepoint active_webhook_before_deletion;

savepoint deletion_before_active_webhook;
do $deletion_before_active_webhook$
declare
  begun jsonb;
  blocked jsonb;
begin
  begun := public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    null,
    '52100000-0000-4000-8000-00000000d502',
    300
  );
  blocked := pg_temp.apply_fixture_active_payment_event(
    '00000000-0000-4000-8000-00000000d502',
    'cus_delete_fence',
    'pay_webhook_after_deletion',
    'evt_webhook_after_deletion',
    current_date + 25,
    pg_catalog.clock_timestamp()
  );
  if begun->>'action' <> 'PROCEED'
     or coalesce((blocked->>'ok')::boolean, false)
     or blocked->>'reason' <> 'student_lifecycle_or_binding_changed'
     or exists (
       select 1 from public.student_payments
        where asaas_payment_id = 'pay_webhook_after_deletion'
     )
  then
    raise exception 'deletion-first webhook serialization failed: %, %', begun, blocked;
  end if;
end;
$deletion_before_active_webhook$;
rollback to savepoint deletion_before_active_webhook;
release savepoint deletion_before_active_webhook;

savepoint deletion_without_provider_objects;
do $deletion_without_provider_objects$
declare
  begun jsonb;
  bound jsonb;
  recovered jsonb;
begin
  begun := public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d505',
    null,
    '20000000-0000-4000-8000-00000000d505',
    300
  );
  bound := public.bind_student_account_deletion_integrations(
    (begun->>'claim_id')::uuid,
    '20000000-0000-4000-8000-00000000d505',
    null, null, null, null,
    null, null, null, null
  );
  recovered := public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d505',
    null,
    '20100000-0000-4000-8000-00000000d505',
    300
  );
  if begun->>'action' <> 'PROCEED'
     or bound->>'action' <> 'BOUND_PROVIDER_COMPLETE'
     or recovered->>'action' <> 'FINALIZE_REQUIRED'
     or not exists (
       select 1 from public.student_account_deletion_claims as deletion
        where deletion.student_id = '00000000-0000-4000-8000-00000000d505'
          and deletion.status = 'PROVIDER_COMPLETE'
          and deletion.subscription_deleted
          and deletion.customer_deleted
          and deletion.integration_snapshot = jsonb_build_object(
            'subscription', null,
            'customer', null
          )
     )
  then
    raise exception 'provider-empty deletion did not become locally finalizable: %, %, %', begun, bound, recovered;
  end if;
end;
$deletion_without_provider_objects$;
rollback to savepoint deletion_without_provider_objects;
release savepoint deletion_without_provider_objects;

savepoint competing_customer_creation_routes;
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at
) values
  (
    '20200000-0000-4000-8000-00000000d505',
    'student-lifecycle-fence', 'CUSTOMER_CREATE', 'student:route-a',
    '00000000-0000-4000-8000-00000000d505', repeat('2', 64), 'CLAIMED',
    '20300000-0000-4000-8000-00000000d505', now() + interval '5 minutes'
  ),
  (
    '20400000-0000-4000-8000-00000000d505',
    'student-lifecycle-fence', 'CUSTOMER_CREATE', 'student-customer:route-b',
    '00000000-0000-4000-8000-00000000d505', repeat('3', 64), 'CLAIMED',
    '20500000-0000-4000-8000-00000000d505', now() + interval '5 minutes'
  );
do $competing_customer_creation_routes$
declare
  first_binding jsonb;
  competing_binding jsonb;
begin
  first_binding := public.bind_student_asaas_creation_lifecycle(
    '20200000-0000-4000-8000-00000000d505',
    '20300000-0000-4000-8000-00000000d505',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d505',
    'CUSTOMER', null
  );
  competing_binding := public.bind_student_asaas_creation_lifecycle(
    '20400000-0000-4000-8000-00000000d505',
    '20500000-0000-4000-8000-00000000d505',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d505',
    'CUSTOMER', null
  );
  if first_binding->>'action' <> 'BOUND'
     or coalesce((competing_binding->>'ok')::boolean, false) is true
     or competing_binding->>'reason' <> 'singleton_creation_binding_in_flight'
  then
    raise exception 'competing customer routes crossed singleton lifecycle: %, %', first_binding, competing_binding;
  end if;
end;
$competing_customer_creation_routes$;
rollback to savepoint competing_customer_creation_routes;
release savepoint competing_customer_creation_routes;

insert into lifecycle_results values (
  'charge-claim',
  public.claim_student_overdue_card_charge(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d503',
    'sub_overdue_fence',
    'pay_overdue_fence',
    null,
    '20000000-0000-4000-8000-00000000d501',
    300
  )
);
insert into lifecycle_results values (
  'charge-submit',
  public.mark_student_overdue_card_charge_submitting(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'charge-claim'),
    '20000000-0000-4000-8000-00000000d501'
  )
);
insert into lifecycle_results values (
  'charge-unknown',
  public.finish_student_overdue_card_charge(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'charge-claim'),
    '20000000-0000-4000-8000-00000000d501',
    'UNKNOWN', '', 408, 'timeout'
  )
);
insert into lifecycle_results values (
  'charge-retry',
  public.claim_student_overdue_card_charge(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d503',
    'sub_overdue_fence',
    'pay_overdue_fence',
    null,
    '20000000-0000-4000-8000-00000000d502',
    300
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'SUBMIT_ONCE' from lifecycle_results where label = 'charge-claim')
  and (select payload->>'ok' = 'true' from lifecycle_results where label = 'charge-submit')
  and (select payload->>'action' = 'REVIEW_REQUIRED' from lifecycle_results where label = 'charge-retry')
  and (select status = 'UNKNOWN' and attempt_count = 1
         from public.student_overdue_card_charge_claims
        where asaas_payment_id = 'pay_overdue_fence'),
  'SUBMITTING/UNKNOWN overdue charge authorized a second POST'
);

insert into lifecycle_results values (
  'charge-succeeded-awaiting-cash',
  public.finish_student_overdue_card_charge(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'charge-claim'),
    '20000000-0000-4000-8000-00000000d501',
    'SUCCEEDED', 'CONFIRMED', 200, null
  )
);
insert into lifecycle_results values (
  'offboard-blocked-awaiting-cash',
  public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d503',
    null,
    'offboarded',
    'fixture',
    '20000000-0000-4000-8000-00000000d503',
    300
  )
);
select pg_temp.assert_true(
  (select payload->>'ok' = 'true' from lifecycle_results where label = 'charge-succeeded-awaiting-cash')
  and (select payload->>'reason' = 'overdue_charge_in_flight'
         from lifecycle_results where label = 'offboard-blocked-awaiting-cash'),
  'provider-confirmed overdue charge released lifecycle before local cash settlement'
);
savepoint overdue_cash_reconciled;
update public.student_payments
   set status = 'RECEIVED', credited_at = now()
 where asaas_payment_id = 'pay_overdue_fence';
do $overdue_cash_reconciled$
declare
  result jsonb;
begin
  result := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d503',
    null,
    'offboarded',
    'fixture',
    '20000000-0000-4000-8000-00000000d504',
    300
  );
  if result->>'action' <> 'PROCEED' then
    raise exception 'locally settled overdue charge did not release lifecycle: %', result;
  end if;
end;
$overdue_cash_reconciled$;
rollback to savepoint overdue_cash_reconciled;
release savepoint overdue_cash_reconciled;

insert into public.asaas_student_billing_period_claims (
  tenant_id, student_id, due_date, source, source_key,
  request_fingerprint, status, claim_token, lease_expires_at
) values (
  'student-lifecycle-fence',
  '00000000-0000-4000-8000-00000000d501',
  current_date + 30,
  'MANUAL_PIX',
  'manual-pix:offboarding-race',
  repeat('a', 64),
  'CLAIMED',
  '30000000-0000-4000-8000-00000000d500',
  now() + interval '5 minutes'
);
insert into lifecycle_results values (
  'offboard-blocked-inflight',
  public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d501',
    null,
    'offboarded',
    'fixture',
    '30000000-0000-4000-8000-00000000d500',
    300
  )
);
select pg_temp.assert_true(
  (select payload->>'action' = 'REVIEW_REQUIRED'
          and payload->>'reason' = 'billing_creation_in_flight'
     from lifecycle_results where label = 'offboard-blocked-inflight'),
  'offboarding crossed an in-flight student billing creation'
);
delete from public.asaas_student_billing_period_claims
 where source_key = 'manual-pix:offboarding-race';

savepoint provider_creation_first;
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at
) values (
  '31000000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'PAYMENT_CREATE', 'fixture:creation-first',
  '00000000-0000-4000-8000-00000000d504', repeat('e', 64), 'CLAIMED',
  '31100000-0000-4000-8000-00000000d504', now() + interval '5 minutes'
);
do $provider_creation_first$
declare
  marked jsonb;
  blocked jsonb;
begin
  marked := public.mark_student_asaas_creation_submitting(
    '31000000-0000-4000-8000-00000000d504',
    '31100000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'STUDENT_PAYMENT',
    'cus_creation_fence'
  );
  blocked := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null, 'offboarded', 'fixture',
    '31200000-0000-4000-8000-00000000d504', 300
  );
  if coalesce((marked->>'ok')::boolean, false) is not true
     or blocked->>'reason' <> 'provider_creation_in_flight'
  then
    raise exception 'provider creation crossed lifecycle snapshot: %, %', marked, blocked;
  end if;
end;
$provider_creation_first$;
rollback to savepoint provider_creation_first;
release savepoint provider_creation_first;

savepoint provider_creation_release_requires_snapshot;
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  '31300000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'PAYMENT_CREATE', 'fixture:release',
  '00000000-0000-4000-8000-00000000d504', repeat('f', 64), 'SUCCEEDED',
  '31400000-0000-4000-8000-00000000d504', now(), 'pay_release_snapshot'
);
do $provider_creation_release_requires_snapshot$
declare
  bound jsonb;
  premature jsonb;
  wrong_customer jsonb;
  released jsonb;
begin
  bound := public.bind_student_asaas_creation_lifecycle(
    '31300000-0000-4000-8000-00000000d504', null,
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'STUDENT_PAYMENT', 'cus_creation_fence'
  );
  premature := public.release_student_asaas_creation_lifecycle(
    '31300000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'pay_release_snapshot'
  );
  insert into public.student_payments (
    id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
    value, status, due_date
  ) values (
    '31500000-0000-4000-8000-00000000d504',
    '00000000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence', 'pay_release_snapshot',
    'cus_wrong_context', 50, 'OVERDUE', current_date - 1
  );
  wrong_customer := public.release_student_asaas_creation_lifecycle(
    '31300000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'pay_release_snapshot'
  );
  delete from public.student_payments
   where id = '31500000-0000-4000-8000-00000000d504';
  insert into public.student_payments (
    id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
    value, status, due_date
  ) values (
    '31500000-0000-4000-8000-00000000d504',
    '00000000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence', 'pay_release_snapshot',
    'cus_creation_fence', 50, 'OVERDUE', current_date - 1
  );
  released := public.release_student_asaas_creation_lifecycle(
    '31300000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'pay_release_snapshot'
  );
  if coalesce((bound->>'ok')::boolean, false) is not true
     or coalesce((premature->>'ok')::boolean, false) is true
     or premature->>'reason' <> 'local_provider_binding_unverified'
     or coalesce((wrong_customer->>'ok')::boolean, false) is true
     or wrong_customer->>'reason' <> 'local_provider_binding_unverified'
     or released->>'action' <> 'RELEASED'
  then
    raise exception 'student payment lifecycle released without exact durable binding: %, %, %, %', bound, premature, wrong_customer, released;
  end if;
end;
$provider_creation_release_requires_snapshot$;
rollback to savepoint provider_creation_release_requires_snapshot;
release savepoint provider_creation_release_requires_snapshot;

savepoint billing_period_release_requires_customer_binding;
insert into public.asaas_student_billing_period_claims (
  tenant_id, student_id, due_date, source, source_key,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  'student-lifecycle-fence',
  '00000000-0000-4000-8000-00000000d504',
  current_date + 2,
  'SUBSCRIPTION',
  'subscription:release-customer-binding',
  repeat('5', 64),
  'BOUND',
  '31510000-0000-4000-8000-00000000d504',
  now(),
  'pay_period_release'
);
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  '31520000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'PAYMENT_CREATE', 'fixture:period-release',
  '00000000-0000-4000-8000-00000000d504', repeat('4', 64), 'SUCCEEDED',
  '31530000-0000-4000-8000-00000000d504', now(), 'pay_period_release'
);
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, due_date
) values (
  '31540000-0000-4000-8000-00000000d504',
  '00000000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'pay_period_release',
  'cus_wrong_context', 50, 'PENDING', current_date + 2
);
do $billing_period_release_requires_customer_binding$
declare
  bound jsonb;
  rejected jsonb;
  released jsonb;
begin
  bound := public.bind_student_asaas_creation_lifecycle(
    '31520000-0000-4000-8000-00000000d504', null,
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'BILLING_PERIOD_PAYMENT', 'cus_creation_fence'
  );
  rejected := public.release_student_asaas_creation_lifecycle(
    '31520000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'pay_period_release'
  );
  delete from public.student_payments
   where id = '31540000-0000-4000-8000-00000000d504';
  insert into public.student_payments (
    id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
    value, status, due_date
  ) values (
    '31540000-0000-4000-8000-00000000d504',
    '00000000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence', 'pay_period_release',
    'cus_creation_fence', 50, 'PENDING', current_date + 2
  );
  released := public.release_student_asaas_creation_lifecycle(
    '31520000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'pay_period_release'
  );
  if coalesce((bound->>'ok')::boolean, false) is not true
     or coalesce((rejected->>'ok')::boolean, false) is true
     or rejected->>'reason' <> 'local_provider_binding_unverified'
     or released->>'action' <> 'RELEASED'
  then
    raise exception 'billing-period release accepted a divergent customer: %, %, %', bound, rejected, released;
  end if;
end;
$billing_period_release_requires_customer_binding$;
rollback to savepoint billing_period_release_requires_customer_binding;
release savepoint billing_period_release_requires_customer_binding;

-- Compatibility for attempts created before lifecycle columns existed is
-- deliberately narrow: only a SUCCEEDED provider id that already equals the
-- immutable local binding may be adopted. A CLAIMED attempt or any divergent
-- id remains blocked.
savepoint legacy_succeeded_customer_binding;
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  '31600000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'CUSTOMER_CREATE', 'fixture:legacy-customer',
  '00000000-0000-4000-8000-00000000d504', repeat('6', 64), 'SUCCEEDED',
  '31700000-0000-4000-8000-00000000d504', now(), 'cus_creation_fence'
);
do $legacy_succeeded_customer_binding$
declare
  result jsonb;
begin
  result := public.bind_student_asaas_creation_lifecycle(
    '31600000-0000-4000-8000-00000000d504', null,
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'CUSTOMER', null
  );
  if result->>'action' <> 'BOUND' then
    raise exception 'exact legacy customer binding was not adopted: %', result;
  end if;
end;
$legacy_succeeded_customer_binding$;
rollback to savepoint legacy_succeeded_customer_binding;
release savepoint legacy_succeeded_customer_binding;

savepoint legacy_succeeded_enrollment_binding;
set local app.enrollment_claim = '1';
update public.profiles
   set enrollment_payment_id = 'pay_legacy_enrollment'
 where id = '00000000-0000-4000-8000-00000000d504';
set local app.enrollment_claim = '';
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  '31800000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'PAYMENT_CREATE', 'fixture:legacy-enrollment',
  '00000000-0000-4000-8000-00000000d504', repeat('7', 64), 'SUCCEEDED',
  '31900000-0000-4000-8000-00000000d504', now(), 'pay_legacy_enrollment'
);
do $legacy_succeeded_enrollment_binding$
declare
  result jsonb;
begin
  result := public.bind_student_asaas_creation_lifecycle(
    '31800000-0000-4000-8000-00000000d504', null,
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'ENROLLMENT_PAYMENT', 'cus_creation_fence'
  );
  if result->>'action' <> 'BOUND' then
    raise exception 'exact legacy enrollment payment binding was not adopted: %', result;
  end if;
end;
$legacy_succeeded_enrollment_binding$;
rollback to savepoint legacy_succeeded_enrollment_binding;
release savepoint legacy_succeeded_enrollment_binding;

savepoint legacy_succeeded_subscription_binding;
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  '31a00000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'SUBSCRIPTION_CREATE',
  'fixture:legacy-subscription',
  '00000000-0000-4000-8000-00000000d504', repeat('8', 64), 'SUCCEEDED',
  '31b00000-0000-4000-8000-00000000d504', now(), 'sub_creation_fence'
);
do $legacy_succeeded_subscription_binding$
declare
  adopted jsonb;
begin
  adopted := public.bind_student_asaas_creation_lifecycle(
    '31a00000-0000-4000-8000-00000000d504', null,
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'SUBSCRIPTION', 'cus_creation_fence'
  );
  if adopted->>'action' <> 'BOUND' then
    raise exception 'exact legacy subscription binding was not adopted: %', adopted;
  end if;
end;
$legacy_succeeded_subscription_binding$;
rollback to savepoint legacy_succeeded_subscription_binding;
release savepoint legacy_succeeded_subscription_binding;

savepoint unfinished_subscription_binding;
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  '31c00000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'SUBSCRIPTION_CREATE',
  'fixture:claimed-subscription',
  '00000000-0000-4000-8000-00000000d504', repeat('a', 64), 'CLAIMED',
  '31d00000-0000-4000-8000-00000000d504', now() + interval '5 minutes',
  'sub_creation_fence'
);
do $unfinished_subscription_binding$
declare
  rejected jsonb;
begin
  rejected := public.bind_student_asaas_creation_lifecycle(
    '31c00000-0000-4000-8000-00000000d504',
    '31d00000-0000-4000-8000-00000000d504',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'SUBSCRIPTION', 'cus_creation_fence'
  );
  if coalesce((rejected->>'ok')::boolean, false) is true
     or rejected->>'reason' <> 'student_subscription_binding_changed'
  then
    raise exception 'unfinished subscription impersonated a legacy success: %', rejected;
  end if;
end;
$unfinished_subscription_binding$;
rollback to savepoint unfinished_subscription_binding;
release savepoint unfinished_subscription_binding;

savepoint billing_method_first;
do $billing_method_first$
declare
  begun jsonb;
  marked jsonb;
  blocked jsonb;
  unknown_result jsonb;
  retry_result jsonb;
begin
  begun := public.begin_student_billing_method_operation(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null, 'cus_creation_fence', 'sub_creation_fence',
    'PIX', 'BOLETO', null,
    'integration_billing_method_v1', 1, 'production', 'TENANT_BYOK',
    '32000000-0000-4000-8000-00000000d504', 300
  );
  marked := public.mark_student_billing_method_mutating(
    (begun->>'operation_id')::uuid,
    '32000000-0000-4000-8000-00000000d504'
  );
  blocked := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null, 'offboarded', 'fixture',
    '32100000-0000-4000-8000-00000000d504', 300
  );
  unknown_result := public.finish_student_billing_method_operation(
    (begun->>'operation_id')::uuid,
    '32000000-0000-4000-8000-00000000d504',
    'UNKNOWN', 408, 'timeout'
  );
  retry_result := public.begin_student_billing_method_operation(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null, 'cus_creation_fence', 'sub_creation_fence',
    'PIX', 'BOLETO', null,
    'integration_billing_method_v1', 1, 'production', 'TENANT_BYOK',
    '32200000-0000-4000-8000-00000000d504', 300
  );
  if begun->>'action' <> 'SUBMIT_ONCE'
     or coalesce((marked->>'ok')::boolean, false) is not true
     or blocked->>'reason' <> 'billing_method_mutation_in_flight'
     or coalesce((unknown_result->>'ok')::boolean, false) is not true
     or retry_result->>'action' <> 'RECONCILE_REQUIRED'
     or exists (
       select 1 from public.student_billing_method_operations
        where id = (begun->>'operation_id')::uuid
          and status <> 'UNKNOWN'
     )
  then
    raise exception 'billing method mutation was not one-way fenced: %, %, %, %, %', begun, marked, blocked, unknown_result, retry_result;
  end if;
end;
$billing_method_first$;
rollback to savepoint billing_method_first;
release savepoint billing_method_first;

-- A refund can commit after the message claim but before the irreversible
-- provider call. The mark RPC locks and rechecks the exact source payment, so
-- the stale confirmation is suppressed atomically before SUBMITTING.
savepoint payment_confirmation_source_changed;
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, provider_status, due_date
) values (
  '33f00000-0000-4000-8000-00000000d504',
  '00000000-0000-4000-8000-00000000d504',
  'student-lifecycle-fence', 'pay_confirmation_source_changed',
  'cus_creation_fence', 50, 'RECEIVED', 'RECEIVED', current_date
);
do $payment_confirmation_source_changed$
declare
  claimed jsonb;
  marked jsonb;
begin
  claimed := public.claim_asaas_outbound_message(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    '33f00000-0000-4000-8000-00000000d504',
    'PAYMENT_CONFIRMED_CAPI',
    '33e00000-0000-4000-8000-00000000d504',
    300
  );
  update public.student_payments
     set status = 'REFUNDED', provider_status = 'REFUNDED'
   where id = '33f00000-0000-4000-8000-00000000d504';
  marked := public.mark_asaas_outbound_message_submitting(
    (claimed->>'attempt_id')::uuid,
    '33e00000-0000-4000-8000-00000000d504'
  );
  if claimed->>'action' <> 'SUBMIT_ONCE'
     or marked->>'action' <> 'SUPPRESSED'
     or marked->>'reason' <> 'payment_state_changed_before_notification_send'
     or not exists (
       select 1 from public.asaas_outbound_message_attempts as message_attempt
        where message_attempt.id = (claimed->>'attempt_id')::uuid
          and message_attempt.status = 'SUPPRESSED'
          and message_attempt.submit_attempt_count = 0
     )
  then
    raise exception 'stale payment confirmation crossed source fence: %, %', claimed, marked;
  end if;
end;
$payment_confirmation_source_changed$;
rollback to savepoint payment_confirmation_source_changed;
release savepoint payment_confirmation_source_changed;

-- claim -> offboarding request -> mark: the lifecycle request durably
-- suppresses a message that provably has not entered provider submission, and
-- the stale sender token can no longer cross the lifecycle boundary.
savepoint outbound_message_first;
do $outbound_message_first$
declare
  claimed jsonb;
  blocked jsonb;
  marked jsonb;
begin
  claimed := public.claim_asaas_outbound_message(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'pay_message_claim_first',
    'MANUAL_PIX_CREATED',
    '34000000-0000-4000-8000-00000000d504',
    300
  );
  blocked := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null, 'offboarded', 'fixture',
    '34100000-0000-4000-8000-00000000d504', 300
  );
  marked := public.mark_asaas_outbound_message_submitting(
    (claimed->>'attempt_id')::uuid,
    '34000000-0000-4000-8000-00000000d504'
  );
  if claimed->>'action' <> 'SUBMIT_ONCE'
     or blocked->>'action' <> 'PROCEED'
     or coalesce((marked->>'ok')::boolean, false) is true
     or marked->>'reason' <> 'claim_lost'
     or not exists (
       select 1 from public.asaas_outbound_message_attempts as message_attempt
        where message_attempt.id = (claimed->>'attempt_id')::uuid
          and message_attempt.status = 'SUPPRESSED'
          and message_attempt.submit_attempt_count = 0
          and message_attempt.last_error = 'student_offboarding_requested_before_send'
     )
     or not exists (
       select 1 from public.student_offboarding_operations as operation
        where operation.tenant_id = 'student-lifecycle-fence'
          and operation.student_id = '00000000-0000-4000-8000-00000000d504'
          and operation.status in (
            'CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED'
          )
     )
  then
    raise exception 'claimed outbound message crossed offboarding: %, %, %', claimed, blocked, marked;
  end if;
end;
$outbound_message_first$;
rollback to savepoint outbound_message_first;
release savepoint outbound_message_first;

-- Once submission is ambiguous it cannot be suppressed or ignored by a
-- lifecycle snapshot. Human/provider reconciliation is required first.
savepoint outbound_message_unknown;
do $outbound_message_unknown$
declare
  claimed jsonb;
  marked jsonb;
  finished jsonb;
  blocked jsonb;
begin
  claimed := public.claim_asaas_outbound_message(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    'pay_message_unknown',
    'MANUAL_PIX_CREATED',
    '34200000-0000-4000-8000-00000000d504',
    300
  );
  marked := public.mark_asaas_outbound_message_submitting(
    (claimed->>'attempt_id')::uuid,
    '34200000-0000-4000-8000-00000000d504'
  );
  finished := public.finish_asaas_outbound_message(
    (claimed->>'attempt_id')::uuid,
    '34200000-0000-4000-8000-00000000d504',
    'UNKNOWN', 504, 'provider_timeout'
  );
  blocked := public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d504',
    null, 'offboarded', 'fixture',
    '34300000-0000-4000-8000-00000000d504', 300
  );
  if claimed->>'action' <> 'SUBMIT_ONCE'
     or coalesce((marked->>'ok')::boolean, false) is not true
     or finished->>'status' <> 'UNKNOWN'
     or blocked->>'reason' <> 'outbound_message_in_flight'
     or not exists (
       select 1 from public.asaas_outbound_message_attempts as message_attempt
        where message_attempt.id = (claimed->>'attempt_id')::uuid
          and message_attempt.status = 'UNKNOWN'
          and message_attempt.submit_attempt_count = 1
     )
  then
    raise exception 'ambiguous outbound message did not fence offboarding: %, %, %, %', claimed, marked, finished, blocked;
  end if;
end;
$outbound_message_unknown$;
rollback to savepoint outbound_message_unknown;
release savepoint outbound_message_unknown;

insert into lifecycle_results values (
  'offboard-begin',
  public.begin_student_offboarding(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d501',
    null,
    'offboarded',
    'fixture',
    '30000000-0000-4000-8000-00000000d501',
    300
  )
);
savepoint offboarding_first_blocks_billing;
insert into public.asaas_provider_creation_attempts (
  id, tenant_id, operation, logical_key, external_reference,
  request_fingerprint, status, claim_token, lease_expires_at
) values (
  '33000000-0000-4000-8000-00000000d501',
  'student-lifecycle-fence', 'PAYMENT_CREATE', 'fixture:offboarding-first',
  '00000000-0000-4000-8000-00000000d501', repeat('1', 64), 'CLAIMED',
  '33100000-0000-4000-8000-00000000d501', now() + interval '5 minutes'
);
do $offboarding_first_blocks_billing$
declare
  creation_result jsonb;
  billing_result jsonb;
  message_result jsonb;
begin
  creation_result := public.bind_student_asaas_creation_lifecycle(
    '33000000-0000-4000-8000-00000000d501',
    '33100000-0000-4000-8000-00000000d501',
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d501',
    'STUDENT_PAYMENT', 'cus_offboard_fence'
  );
  billing_result := public.begin_student_billing_method_operation(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d501',
    null, 'cus_offboard_fence', 'sub_offboard_fence',
    'PIX', 'BOLETO', null,
    'integration_billing_method_v1', 1, 'production', 'TENANT_BYOK',
    '33200000-0000-4000-8000-00000000d501', 300
  );
  message_result := public.claim_asaas_outbound_message(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d501',
    'pay_message_offboarding_first',
    'MANUAL_PIX_CREATED',
    '33300000-0000-4000-8000-00000000d501',
    300
  );
  if creation_result->>'reason' <> 'lifecycle_operation_active'
     or billing_result->>'reason' <> 'lifecycle_operation_active'
     or message_result->>'reason' <> 'lifecycle_operation_active'
     or exists (
       select 1 from public.asaas_outbound_message_attempts as message_attempt
        where message_attempt.tenant_id = 'student-lifecycle-fence'
          and message_attempt.provider_entity_id = 'pay_message_offboarding_first'
     )
  then
    raise exception 'offboarding did not fence later provider mutation: %, %, %', creation_result, billing_result, message_result;
  end if;
end;
$offboarding_first_blocks_billing$;
rollback to savepoint offboarding_first_blocks_billing;
release savepoint offboarding_first_blocks_billing;
insert into lifecycle_results values (
  'offboard-integrations',
  public.bind_student_offboarding_integrations(
    (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'),
    '30000000-0000-4000-8000-00000000d501',
    'integration_subscription_v1', 1, 'production', 'TENANT_BYOK',
    'integration_payment_v1', 1, 'production', 'TENANT_BYOK'
  )
);
savepoint offboard_integration_rotation;
do $offboard_integration_rotation$
declare
  result jsonb;
begin
  result := public.bind_student_offboarding_integrations(
    (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'),
    '30000000-0000-4000-8000-00000000d501',
    'integration_subscription_v2', 2, 'production', 'TENANT_BYOK',
    'integration_payment_v2', 2, 'production', 'TENANT_BYOK'
  );
  if coalesce((result->>'ok')::boolean, false)
     or result->>'reason' <> 'integration_context_changed'
     or not exists (
       select 1 from public.student_offboarding_operations
        where id = (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin')
          and status = 'BLOCKED'
          and last_error = 'integration_context_changed'
     )
  then
    raise exception 'offboarding accepted a rotated Asaas integration';
  end if;
end;
$offboard_integration_rotation$;
rollback to savepoint offboard_integration_rotation;
release savepoint offboard_integration_rotation;
-- Simulate a webhook winning after the immutable snapshot but before local
-- finalization. The finalizer may cancel the other PENDING row, never this one.
update public.student_payments
   set status = 'RECEIVED', credited_at = now()
 where id = '10000000-0000-4000-8000-00000000d502';
insert into lifecycle_results values (
  'offboard-mutating',
  public.record_student_offboarding_provider_state(
    (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'),
    '30000000-0000-4000-8000-00000000d501',
    'MUTATING', null
  )
);
insert into lifecycle_results values (
  'offboard-provider-complete',
  public.record_student_offboarding_provider_state(
    (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'),
    '30000000-0000-4000-8000-00000000d501',
    'COMPLETE', null
  )
);
insert into lifecycle_results
select 'offboard-completed-at', jsonb_build_object('value', provider_completed_at)
  from public.student_offboarding_operations
 where id = (
   select (payload->>'operation_id')::uuid
     from lifecycle_results where label = 'offboard-begin'
 );
insert into lifecycle_results values (
  'offboard-late-unknown',
  public.record_student_offboarding_provider_state(
    (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'),
    '30000000-0000-4000-8000-00000000d501',
    'UNKNOWN', 'late replay'
  )
);
insert into lifecycle_results values (
  'offboard-stale-finalize',
  public.finalize_student_offboarding(
    (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'),
    '30000000-0000-4000-8000-00000000d599'
  )
);
insert into lifecycle_results values (
  'offboard-finalize',
  public.finalize_student_offboarding(
    (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'),
    '30000000-0000-4000-8000-00000000d501'
  )
);

select pg_temp.assert_true(
  (select payload->>'ok' = 'false' from lifecycle_results where label = 'offboard-stale-finalize')
  and (select payload->>'ok' = 'true' from lifecycle_results where label = 'offboard-integrations')
  and (select payload->>'ok' = 'true' from lifecycle_results where label = 'offboard-late-unknown')
  and (select provider_completed_at = (
        select (payload->>'value')::timestamptz from lifecycle_results where label = 'offboard-completed-at'
      ) from public.student_offboarding_operations
     where id = (select (payload->>'operation_id')::uuid from lifecycle_results where label = 'offboard-begin'))
  and (select payload->>'ok' = 'true' from lifecycle_results where label = 'offboard-finalize')
  and (select lifecycle_status = 'offboarded'
         from public.profiles where id = '00000000-0000-4000-8000-00000000d501')
  and (select status = 'CANCELLED'
         from public.student_payments where id = '10000000-0000-4000-8000-00000000d501')
  and (select status = 'RECEIVED'
         from public.student_payments where id = '10000000-0000-4000-8000-00000000d502'),
  'offboarding fencing failed or regressed a terminal payment to CANCELLED'
);

update public.tenant_memberships
   set status = 'SUSPENDED'
 where user_id = '00000000-0000-4000-8000-00000000d501'
   and tenant_id = 'student-lifecycle-fence';
do $inactive_cash_settlement$
declare
  applied jsonb;
  recomputed jsonb;
  ignored jsonb;
  event_time timestamptz := clock_timestamp();
  cash_date date := current_date;
begin
  applied := public.apply_inactive_student_payment_settlement(
    'pay_future_pending',
    '10000000-0000-4000-8000-00000000d501',
    '00000000-0000-4000-8000-00000000d501',
    'student-lifecycle-fence',
    'cus_offboard_fence',
    'evt_inactive_cash_new',
    'PAYMENT_RECEIVED_IN_CASH',
    event_time,
    80,
    'RECEIVED_IN_CASH',
    100,
    cash_date,
    null,
    null,
    jsonb_build_object(
      'id', 'evt_inactive_cash_new',
      'event', 'PAYMENT_RECEIVED_IN_CASH',
      'payment', jsonb_build_object(
        'id', 'pay_future_pending',
        'customer', 'cus_offboard_fence',
        'value', 100,
        'paymentDate', cash_date::text
      )
    )
  );
  recomputed := public.recompute_student_financial_status(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d501'
  );
  ignored := public.apply_inactive_student_payment_settlement(
    'pay_future_pending',
    '10000000-0000-4000-8000-00000000d501',
    '00000000-0000-4000-8000-00000000d501',
    'student-lifecycle-fence',
    'cus_offboard_fence',
    'evt_inactive_cash_old',
    'PAYMENT_RECEIVED_IN_CASH',
    event_time - interval '1 day',
    80,
    'RECEIVED_IN_CASH',
    100,
    cash_date - 1,
    null,
    null,
    jsonb_build_object(
      'id', 'evt_inactive_cash_old',
      'event', 'PAYMENT_RECEIVED_IN_CASH',
      'payment', jsonb_build_object(
        'id', 'pay_future_pending',
        'customer', 'cus_offboard_fence',
        'value', 100,
        'paymentDate', (cash_date - 1)::text
      )
    )
  );
  if applied->>'action' <> 'UPDATED'
     or recomputed->>'action' <> 'PRESERVED'
     or ignored->>'action' <> 'IGNORED'
     or not exists (
       select 1 from public.student_payments as payment
        where payment.id = '10000000-0000-4000-8000-00000000d501'
          and payment.status = 'RECEIVED_IN_CASH'
          and payment.payment_date = cash_date
          and payment.paid_at = cash_date + interval '12 hours'
          and payment.last_provider_event_id = 'evt_inactive_cash_new'
     )
     or not exists (
       select 1 from public.financial_transactions as transaction
        where transaction.student_payment_id = '10000000-0000-4000-8000-00000000d501'
          and transaction.type = 'ENTRADA'
          and transaction.occurred_at::date = cash_date
     )
     or not exists (
       select 1 from public.profiles as profile
        where profile.id = '00000000-0000-4000-8000-00000000d501'
          and profile.lifecycle_status = 'offboarded'
     )
     or not exists (
      select 1 from public.tenant_memberships as membership
        where membership.user_id = '00000000-0000-4000-8000-00000000d501'
          and membership.tenant_id = 'student-lifecycle-fence'
          and membership.status = 'SUSPENDED'
     )
     or exists (
       select 1 from public.notification_queue as notification
        where notification.source_id = '10000000-0000-4000-8000-00000000d501'
          and notification.notification_kind = 'PAYMENT_CONFIRMED'
     )
  then
    raise exception 'inactive settlement was not update-only: %, %, %', applied, recomputed, ignored;
  end if;
end;
$inactive_cash_settlement$;

do $blocked_after_offboarding$
begin
  begin
    insert into public.asaas_student_billing_period_claims (
      tenant_id, student_id, due_date, source, source_key,
      request_fingerprint, status, claim_token, lease_expires_at
    ) values (
      'student-lifecycle-fence',
      '00000000-0000-4000-8000-00000000d501',
      current_date + 60,
      'SUBSCRIPTION',
      'subscription:after-offboarding',
      repeat('b', 64),
      'CLAIMED',
      '30000000-0000-4000-8000-00000000d598',
      now() + interval '5 minutes'
    );
    raise exception 'billing claim unexpectedly inserted after offboarding';
  exception
    when sqlstate '55000' then null;
  end;
end;
$blocked_after_offboarding$;

insert into public.asaas_student_billing_period_claims (
  tenant_id, student_id, due_date, source, source_key,
  request_fingerprint, status, claim_token, lease_expires_at
) values (
  'student-lifecycle-fence',
  '00000000-0000-4000-8000-00000000d502',
  current_date + 30,
  'MANUAL_PIX',
  'manual-pix:deletion-race',
  repeat('c', 64),
  'CLAIMED',
  '40000000-0000-4000-8000-00000000d500',
  now() + interval '5 minutes'
);
insert into lifecycle_results values (
  'delete-blocked-inflight',
  public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    null,
    '40000000-0000-4000-8000-00000000d500',
    300
  )
);
select pg_temp.assert_true(
  (select payload->>'action' = 'REVIEW_REQUIRED'
          and payload->>'reason' = 'billing_creation_in_flight'
     from lifecycle_results where label = 'delete-blocked-inflight'),
  'permanent deletion crossed an in-flight student billing creation'
);
delete from public.asaas_student_billing_period_claims
 where source_key = 'manual-pix:deletion-race';

savepoint outbound_message_before_deletion;
do $outbound_message_before_deletion$
declare
  claimed jsonb;
  blocked jsonb;
  marked jsonb;
begin
  claimed := public.claim_asaas_outbound_message(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    'pay_message_delete_first',
    'MANUAL_PIX_CREATED',
    '41000000-0000-4000-8000-00000000d502',
    300
  );
  blocked := public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    null,
    '41100000-0000-4000-8000-00000000d502',
    300
  );
  marked := public.mark_asaas_outbound_message_submitting(
    (claimed->>'attempt_id')::uuid,
    '41000000-0000-4000-8000-00000000d502'
  );
  if claimed->>'action' <> 'SUBMIT_ONCE'
     or blocked->>'action' <> 'PROCEED'
     or coalesce((marked->>'ok')::boolean, false) is true
     or not exists (
       select 1 from public.asaas_outbound_message_attempts as message_attempt
        where message_attempt.id = (claimed->>'attempt_id')::uuid
          and message_attempt.status = 'SUPPRESSED'
          and message_attempt.submit_attempt_count = 0
          and message_attempt.last_error = 'student_deletion_requested_before_send'
     )
     or not exists (
       select 1 from public.student_account_deletion_claims as deletion
        where deletion.tenant_id = 'student-lifecycle-fence'
          and deletion.student_id = '00000000-0000-4000-8000-00000000d502'
          and deletion.status = 'CLAIMED'
     )
  then
    raise exception 'claimed outbound message crossed account deletion: %, %, %', claimed, blocked, marked;
  end if;
end;
$outbound_message_before_deletion$;
rollback to savepoint outbound_message_before_deletion;
release savepoint outbound_message_before_deletion;

-- Completed operational attempts must not strand permanent fixture cleanup.
-- They are not financial history and are deleted together with the test
-- profile, while the durable account-deletion claim itself survives.
insert into public.asaas_student_billing_period_claims (
  tenant_id, student_id, due_date, source, source_key,
  request_fingerprint, status, claim_token, lease_expires_at,
  provider_entity_id
) values (
  'student-lifecycle-fence',
  '00000000-0000-4000-8000-00000000d502',
  current_date + 15,
  'MANUAL_PIX',
  'manual-pix:completed-before-deletion',
  repeat('9', 64),
  'BOUND',
  '41300000-0000-4000-8000-00000000d502',
  now(),
  'pay_completed_before_deletion'
);
insert into public.asaas_outbound_message_attempts (
  tenant_id, student_id, provider_entity_id, notification_kind,
  status, claim_token, lease_expires_at, submit_attempt_count
) values (
  'student-lifecycle-fence',
  '00000000-0000-4000-8000-00000000d502',
  'pay_completed_before_deletion',
  'MANUAL_PIX_CREATED',
  'SENT',
  '41400000-0000-4000-8000-00000000d502',
  now(),
  1
);

insert into lifecycle_results values (
  'delete-begin',
  public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    null,
    '40000000-0000-4000-8000-00000000d501',
    300
  )
);
insert into lifecycle_results values (
  'delete-integrations',
  public.bind_student_account_deletion_integrations(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'delete-begin'),
    '40000000-0000-4000-8000-00000000d501',
    'integration_delete_subscription_v1', 1, 'production', 'TENANT_BYOK',
    'integration_delete_customer_v1', 1, 'production', 'TENANT_BYOK'
  )
);
savepoint deletion_integration_rotation;
do $deletion_integration_rotation$
declare
  result jsonb;
begin
  result := public.bind_student_account_deletion_integrations(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'delete-begin'),
    '40000000-0000-4000-8000-00000000d501',
    'integration_delete_subscription_v2', 2, 'production', 'TENANT_BYOK',
    'integration_delete_customer_v2', 2, 'production', 'TENANT_BYOK'
  );
  if coalesce((result->>'ok')::boolean, false)
     or result->>'reason' <> 'integration_context_changed'
     or not exists (
       select 1 from public.student_account_deletion_claims
        where id = (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'delete-begin')
          and status = 'BLOCKED'
          and last_error = 'integration_context_changed'
     )
  then
    raise exception 'account deletion accepted a rotated Asaas integration';
  end if;
end;
$deletion_integration_rotation$;
rollback to savepoint deletion_integration_rotation;
release savepoint deletion_integration_rotation;
do $blocked_after_deletion_claim$
declare
  message_result jsonb;
begin
  begin
    insert into public.asaas_student_billing_period_claims (
      tenant_id, student_id, due_date, source, source_key,
      request_fingerprint, status, claim_token, lease_expires_at
    ) values (
      'student-lifecycle-fence',
      '00000000-0000-4000-8000-00000000d502',
      current_date + 60,
      'SUBSCRIPTION',
      'subscription:after-deletion-claim',
      repeat('d', 64),
      'CLAIMED',
      '40000000-0000-4000-8000-00000000d598',
      now() + interval '5 minutes'
    );
    raise exception 'billing claim unexpectedly inserted during permanent deletion';
  exception
    when sqlstate '55000' then null;
  end;
  message_result := public.claim_asaas_outbound_message(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    'pay_message_deletion_first',
    'MANUAL_PIX_CREATED',
    '41200000-0000-4000-8000-00000000d502',
    300
  );
  if message_result->>'reason' <> 'lifecycle_operation_active'
     or exists (
       select 1 from public.asaas_outbound_message_attempts as message_attempt
        where message_attempt.tenant_id = 'student-lifecycle-fence'
          and message_attempt.provider_entity_id = 'pay_message_deletion_first'
     )
  then
    raise exception 'deletion did not fence later outbound message: %', message_result;
  end if;
end;
$blocked_after_deletion_claim$;
insert into lifecycle_results values (
  'delete-sub-absent',
  public.record_student_account_deletion_provider_state(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'delete-begin'),
    '40000000-0000-4000-8000-00000000d501',
    'subscription', 'ABSENT', null
  )
);
insert into lifecycle_results values (
  'delete-customer-absent',
  public.record_student_account_deletion_provider_state(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'delete-begin'),
    '40000000-0000-4000-8000-00000000d501',
    'customer', 'ABSENT', null
  )
);
insert into lifecycle_results
select 'delete-completed-at', jsonb_build_object('value', provider_completed_at)
  from public.student_account_deletion_claims
 where id = (
   select (payload->>'claim_id')::uuid
     from lifecycle_results where label = 'delete-begin'
 );
insert into lifecycle_results values (
  'delete-late-unknown',
  public.record_student_account_deletion_provider_state(
    (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'delete-begin'),
    '40000000-0000-4000-8000-00000000d501',
    'customer', 'UNKNOWN', 'late replay'
  )
);

select pg_temp.assert_true(
  (select payload->>'action' = 'PROCEED' and payload->>'billing_cpf' = '28718884857'
     from lifecycle_results where label = 'delete-begin')
  and (select payload->>'ok' = 'true' from lifecycle_results where label = 'delete-integrations')
  and (select status = 'PROVIDER_COMPLETE'
             and snapshot::text not like '%28718884857%'
             and provider_completed_at = (
               select (payload->>'value')::timestamptz from lifecycle_results where label = 'delete-completed-at'
             )
         from public.student_account_deletion_claims
        where student_id = '00000000-0000-4000-8000-00000000d502')
  and not (
    public.finalize_student_account_deletion(
      (select (payload->>'claim_id')::uuid from lifecycle_results where label = 'delete-begin'),
      '40000000-0000-4000-8000-00000000d599',
      true,
      true
    )->>'ok'
  )::boolean,
  'deletion snapshot leaked CPF or accepted a stale fencing token'
);

set local app.enrollment_claim = '1';
delete from public.profiles
 where id = '00000000-0000-4000-8000-00000000d502';
set local app.enrollment_claim = '';
select pg_temp.assert_true(
  not exists (
    select 1 from public.asaas_student_billing_period_claims
     where student_id = '00000000-0000-4000-8000-00000000d502'
  )
  and not exists (
    select 1 from public.asaas_outbound_message_attempts
     where student_id = '00000000-0000-4000-8000-00000000d502'
  )
  and exists (
    select 1 from public.student_account_deletion_claims
     where student_id = '00000000-0000-4000-8000-00000000d502'
       and status = 'PROVIDER_COMPLETE'
  ),
  'completed operational attempts blocked fixture deletion or durable recovery was lost'
);
insert into lifecycle_results values (
  'delete-profile-absent-recovery',
  public.begin_student_account_deletion(
    'student-lifecycle-fence',
    '00000000-0000-4000-8000-00000000d502',
    null,
    '40000000-0000-4000-8000-00000000d503',
    300
  )
);
select pg_temp.assert_true(
  (select payload->>'action' = 'FINALIZE_REQUIRED'
          and payload->>'claim_token' = '40000000-0000-4000-8000-00000000d503'
     from lifecycle_results where label = 'delete-profile-absent-recovery'),
  'provider-complete deletion could not recover after profile removal'
);

rollback;
