-- Subscription PUTs are single-submit, ordered and lifecycle-fenced.

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

grant execute on all functions in schema pg_temp
  to anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_table_privilege(
    'anon', 'public.asaas_subscription_mutation_operations', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.asaas_subscription_mutation_operations', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.asaas_subscription_mutation_operations', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'public.asaas_subscription_mutation_operations', 'UPDATE'
  )
  and has_function_privilege(
    'service_role',
    'public.claim_asaas_subscription_mutation(text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb,uuid,uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.mark_asaas_subscription_mutation_submitting(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.defer_plan_change_billing_claim(uuid,uuid,text)',
    'EXECUTE'
  ),
  'subscription mutation state exposes unsafe privileges'
);

insert into public.tenants (id, name, slug, saas_status)
values (
  'subscription-mutation-fence',
  'Subscription Mutation Fence',
  'subscription-mutation-fence',
  'active'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000c201',
  'authenticated',
  'authenticated',
  'subscription-mutation@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Subscription Mutation"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'subscription-mutation-fence',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Subscription Mutation',
       cpf = '28718884857',
       asaas_customer_id = 'cus_subscription_mutation',
       subscription_id = 'sub_subscription_mutation'
 where id = '00000000-0000-4000-8000-00000000c201';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id = '00000000-0000-4000-8000-00000000c201';
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '00000000-0000-4000-8000-00000000c201',
  'subscription-mutation-fence',
  'STUDENT',
  'ACTIVE',
  true
);

create temporary table mutation_results (
  label text primary key,
  payload jsonb not null
);
grant select, insert on table pg_temp.mutation_results to service_role;

set local role service_role;

insert into pg_temp.mutation_results values (
  'first-claim',
  public.claim_asaas_subscription_mutation(
    'subscription-mutation-fence',
    '00000000-0000-4000-8000-00000000c201',
    'cus_subscription_mutation',
    'sub_subscription_mutation',
    'PLAN_VALUE',
    'plan-change:first',
    repeat('a', 64),
    '{"valueCents":10000}',
    '{"valueCents":12000}',
    '{"integrationId":"fixture","version":1}',
    null,
    '10000000-0000-4000-8000-00000000c201',
    300
  )
);
insert into pg_temp.mutation_results values (
  'first-submit',
  public.mark_asaas_subscription_mutation_submitting(
    (select (payload->>'operation_id')::uuid
       from pg_temp.mutation_results where label = 'first-claim'),
    '10000000-0000-4000-8000-00000000c201'
  )
);
insert into pg_temp.mutation_results values (
  'first-unknown',
  public.finish_asaas_subscription_mutation(
    (select (payload->>'operation_id')::uuid
       from pg_temp.mutation_results where label = 'first-claim'),
    '10000000-0000-4000-8000-00000000c201',
    'UNKNOWN',
    null,
    408,
    'fixture timeout'
  )
);
insert into pg_temp.mutation_results values (
  'newer-blocked',
  public.claim_asaas_subscription_mutation(
    'subscription-mutation-fence',
    '00000000-0000-4000-8000-00000000c201',
    'cus_subscription_mutation',
    'sub_subscription_mutation',
    'PLAN_VALUE',
    'plan-change:newer',
    repeat('b', 64),
    '{"valueCents":10000}',
    '{"valueCents":13000}',
    '{"integrationId":"fixture","version":1}',
    null,
    '10000000-0000-4000-8000-00000000c202',
    300
  )
);
insert into pg_temp.mutation_results values (
  'first-reconcile',
  public.claim_asaas_subscription_mutation(
    'subscription-mutation-fence',
    '00000000-0000-4000-8000-00000000c201',
    'cus_subscription_mutation',
    'sub_subscription_mutation',
    'PLAN_VALUE',
    'plan-change:first',
    repeat('a', 64),
    '{"valueCents":12000}',
    '{"valueCents":12000}',
    '{"integrationId":"fixture","version":1}',
    null,
    '10000000-0000-4000-8000-00000000c203',
    300
  )
);

reset role;

select pg_temp.assert_true(
  (select payload->>'action' = 'SUBMIT_ONCE'
     from mutation_results where label = 'first-claim')
  and (select payload->>'ok' = 'true'
         from mutation_results where label = 'first-submit')
  and (select payload->>'ok' = 'true'
         from mutation_results where label = 'first-unknown')
  and (select payload->>'action' = 'REVIEW_REQUIRED'
         from mutation_results where label = 'newer-blocked')
  and (select payload->>'action' = 'RECONCILE_REQUIRED'
         from mutation_results where label = 'first-reconcile')
  and (
    select submit_attempt_count = 1 and status = 'UNKNOWN'
      from public.asaas_subscription_mutation_operations
     where tenant_id = 'subscription-mutation-fence'
       and intent_key = 'plan-change:first'
  ),
  'an ambiguous PUT authorized replay or a newer mutation'
);

set local role service_role;
insert into pg_temp.mutation_results values (
  'first-succeeded',
  public.finish_asaas_subscription_mutation(
    (select (payload->>'operation_id')::uuid
       from pg_temp.mutation_results where label = 'first-reconcile'),
    '10000000-0000-4000-8000-00000000c203',
    'SUCCEEDED',
    '{"valueCents":12000}',
    200,
    null
  )
);
insert into pg_temp.mutation_results values (
  'newer-claim',
  public.claim_asaas_subscription_mutation(
    'subscription-mutation-fence',
    '00000000-0000-4000-8000-00000000c201',
    'cus_subscription_mutation',
    'sub_subscription_mutation',
    'PLAN_VALUE',
    'plan-change:newer',
    repeat('b', 64),
    '{"valueCents":12000}',
    '{"valueCents":13000}',
    '{"integrationId":"fixture","version":1}',
    null,
    '10000000-0000-4000-8000-00000000c204',
    300
  )
);
reset role;

select pg_temp.assert_true(
  (select payload->>'ok' = 'true'
     from mutation_results where label = 'first-succeeded')
  and (select payload->>'action' = 'SUBMIT_ONCE'
         from mutation_results where label = 'newer-claim'),
  'a reconciled predecessor did not release the next ordered mutation'
);

do $lifecycle_interleave$
declare
  blocked boolean := false;
begin
  begin
    perform public.begin_student_offboarding(
      'subscription-mutation-fence',
      '00000000-0000-4000-8000-00000000c201',
      null,
      'offboarded',
      'fixture',
      '10000000-0000-4000-8000-00000000c205',
      300
    );
  exception when sqlstate '55000' then
    blocked := true;
  end;
  if not blocked then
    raise exception 'subscription mutation did not block student offboarding';
  end if;
end;
$lifecycle_interleave$;

do $creation_interleave$
declare
  blocked boolean := false;
begin
  begin
    perform public.claim_asaas_student_billing_period(
      'subscription-mutation-fence',
      '00000000-0000-4000-8000-00000000c201',
      current_date + 30,
      'MANUAL_PIX',
      'manual-pix:subscription-mutation-race',
      repeat('c', 64),
      '10000000-0000-4000-8000-00000000c206',
      300
    );
  exception when sqlstate '55000' then
    blocked := true;
  end;
  if not blocked then
    raise exception 'subscription mutation did not block billing creation';
  end if;
end;
$creation_interleave$;

set local role service_role;
insert into pg_temp.mutation_results values (
  'newer-submit-fixture',
  public.mark_asaas_subscription_mutation_submitting(
    (select (payload->>'operation_id')::uuid
       from pg_temp.mutation_results where label = 'newer-claim'),
    '10000000-0000-4000-8000-00000000c204'
  )
);
insert into pg_temp.mutation_results values (
  'newer-failed-terminal',
  public.finish_asaas_subscription_mutation(
    (select (payload->>'operation_id')::uuid
       from pg_temp.mutation_results where label = 'newer-claim'),
    '10000000-0000-4000-8000-00000000c204',
    'FAILED',
    null,
    422,
    'fixture release for reverse interleave'
  )
);
insert into pg_temp.mutation_results values (
  'billing-first',
  public.claim_asaas_student_billing_period(
    'subscription-mutation-fence',
    '00000000-0000-4000-8000-00000000c201',
    current_date + 30,
    'MANUAL_PIX',
    'manual-pix:subscription-mutation-race',
    repeat('c', 64),
    '10000000-0000-4000-8000-00000000c207',
    300
  )
);
insert into pg_temp.mutation_results values (
  'mutation-after-billing',
  public.claim_asaas_subscription_mutation(
    'subscription-mutation-fence',
    '00000000-0000-4000-8000-00000000c201',
    'cus_subscription_mutation',
    'sub_subscription_mutation',
    'MAX_PAYMENTS',
    'admin-max-payments:reverse-fixture',
    repeat('d', 64),
    '{"maxPayments":12}',
    '{"maxPayments":18}',
    '{"integrationId":"fixture","version":1}',
    null,
    '10000000-0000-4000-8000-00000000c208',
    300
  )
);
reset role;

select pg_temp.assert_true(
  (select payload->>'ok' = 'true'
     from mutation_results where label = 'newer-submit-fixture')
  and (select payload->>'ok' = 'true'
         from mutation_results where label = 'newer-failed-terminal')
  and (select payload->>'action' = 'SUBMIT_ONCE'
         from mutation_results where label = 'billing-first')
  and (select payload->>'action' = 'REVIEW_REQUIRED'
         from mutation_results where label = 'mutation-after-billing')
  and (select payload->>'reason' = 'student_subscription_scope_changed'
         from mutation_results where label = 'mutation-after-billing'),
  'billing creation and subscription mutation were not bidirectionally fenced'
);

rollback;
