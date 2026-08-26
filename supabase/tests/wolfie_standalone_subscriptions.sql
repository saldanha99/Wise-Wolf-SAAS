\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $function$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$function$;

grant execute on function pg_temp.assert_true(boolean, text) to public;
do $$
begin
  if to_regprocedure('pg_temp.assert_sqlstate(text, text, text)') is not null then
    execute 'grant execute on function pg_temp.assert_sqlstate(text, text, text) to public';
  end if;
end
$$;

update public.hub_settings
set metadata = coalesce(metadata, '{}'::jsonb)
      || '{"hubEnabled":true,"catalogReady":true}'::jsonb
where settings_key = 'default';

insert into public.hub_content_items (
  id, slug, title, content_type, preview_enabled, license_summary,
  rights_verified_at, rights_basis, catalog_scope, published_at,
  is_active, metadata
)
values (
  '7a500000-0000-4000-8000-000000000001',
  'wolfie-standalone-hub-catalog-fixture',
  'Wolfie standalone Hub catalog fixture',
  'PDF',
  true,
  'Owned rollback-only test fixture',
  pg_catalog.now(),
  'OWNED',
  'COMMERCIAL_GLOBAL',
  pg_catalog.now(),
  true,
  '{"test_fixture":true}'::jsonb
);

insert into storage.objects (bucket_id, name, metadata)
values
  (
    'hub-library',
    'test-fixtures/wolfie-standalone-hub/full.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  ),
  (
    'hub-library',
    'test-fixtures/wolfie-standalone-hub/preview.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  );

insert into public.hub_content_assets (
  content_id, asset_kind, bucket_id, object_path, mime_type
)
values
  (
    '7a500000-0000-4000-8000-000000000001',
    'FULL',
    'hub-library',
    'test-fixtures/wolfie-standalone-hub/full.pdf',
    'application/pdf'
  ),
  (
    '7a500000-0000-4000-8000-000000000001',
    'PREVIEW',
    'hub-library',
    'test-fixtures/wolfie-standalone-hub/preview.pdf',
    'application/pdf'
  );

select pg_temp.assert_true(
  (
    select count(*) = 3
      and bool_and(product_family = 'WOLFIE_STANDALONE')
      and bool_and(price_yearly is null)
    from public.hub_plans
    where code in ('WOLFIE_FOCO', 'WOLFIE_RITMO', 'WOLFIE_PERFORMANCE')
      and is_active
      and is_public
  ),
  'three monthly-only public Wolfie plans must be available'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
      and bool_and(active)
      and min(price_brl) = 39.90
      and max(price_brl) = 99.90
    from public.wolfie_topup_packages
    where tenant_id = 'wolfie-direct'
      and minutes in (60, 180)
  ),
  'standalone top-up packages must be seeded with commercial prices'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_class as index_relation
    join pg_catalog.pg_index as index_definition
      on index_definition.indexrelid = index_relation.oid
    where index_relation.relname = 'hub_one_open_checkout_per_product'
      and index_definition.indisunique
      and index_definition.indpred is not null
  ),
  'one open checkout per account and product must be enforced atomically'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_activate_paid_checkout(uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_reverse_paid_checkout(uuid,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_mark_checkout_overdue(uuid,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.hub_activate_paid_checkout(uuid,text)',
    'EXECUTE'
  ),
  'billing state RPCs must remain service-only'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_subscription_payments',
    'SELECT'
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid = 'public.hub_subscription_payments'::regclass
  ),
  'provider payment ledger must be private and protected by RLS'
);

insert into public.tenants (id, name)
values ('wolfie-standalone-school-fixture', 'Standalone School Fixture');

insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000d001',
    'authenticated',
    'authenticated',
    'wolfie-school-fixture@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Wolfie School Fixture"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '00000000-0000-4000-8000-00000000d002',
    'authenticated',
    'authenticated',
    'wolfie-direct-fixture@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Wolfie Direct Fixture"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
set tenant_id = 'wolfie-standalone-school-fixture',
    role = 'STUDENT',
    status_financial = 'ACTIVE'
where id = '00000000-0000-4000-8000-00000000d001';
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values (
  '00000000-0000-4000-8000-00000000d001',
  'wolfie-standalone-school-fixture',
  'STUDENT',
  'ACTIVE',
  true
)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

select pg_temp.assert_true(
  private.wolfie_access_snapshot(
    '00000000-0000-4000-8000-00000000d001'
  ) ->> 'accessKind' = 'SCHOOL',
  'an active school student must retain school-provided Wolfie access'
);

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d002","role":"authenticated"}',
  true
);
set local role authenticated;
select public.wolfie_prepare_checkout_account(
  'Wolfie Direct Fixture',
  '2026-08-03-v1',
  '{"goal":"global_meetings"}'::jsonb
);
select pg_temp.assert_true(
  (select count(*) = 1 from public.wolfie_standalone_acceptances),
  'the buyer must only see their own versioned acceptance through RLS'
);
reset role;

select pg_temp.assert_true(
  private.wolfie_access_snapshot(
    '00000000-0000-4000-8000-00000000d002'
  ) ->> 'code' = 'WOLFIE_SUBSCRIPTION_REQUIRED',
  'prepared standalone accounts must remain locked until payment'
);

insert into public.hub_checkout_sessions (
  id,
  account_id,
  plan_id,
  requested_by,
  billing_cycle,
  billing_type,
  amount,
  status,
  asaas_subscription_id,
  asaas_payment_id,
  request_key,
  product_family,
  metadata
)
select
  '10000000-0000-4000-8000-00000000d001',
  account.id,
  plan.id,
  '00000000-0000-4000-8000-00000000d002',
  'MONTHLY',
  'PIX',
  plan.price_monthly,
  'PENDING',
  'sub_wolfie_fixture',
  'pay_wolfie_fixture_1',
  '20000000-0000-4000-8000-00000000d001',
  'WOLFIE_STANDALONE',
  '{"test_fixture":true}'::jsonb
from public.hub_accounts as account
cross join public.hub_plans as plan
where account.owner_user_id = '00000000-0000-4000-8000-00000000d002'
  and account.account_type = 'PERSONAL'
  and plan.code = 'WOLFIE_FOCO';

create temporary table expected_wolfie_periods (
  sequence_no integer primary key,
  period_ends_at timestamptz not null
) on commit drop;

select public.hub_activate_paid_checkout(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_1'
);

insert into expected_wolfie_periods(sequence_no, period_ends_at)
select 1, subscription.current_period_ends_at
from public.hub_subscriptions as subscription
where subscription.account_id = (
  select account.id
  from public.hub_accounts as account
  where account.owner_user_id = '00000000-0000-4000-8000-00000000d002'
    and account.account_type = 'PERSONAL'
)
  and subscription.product_family = 'WOLFIE_STANDALONE'
  and subscription.status = 'ACTIVE';

select pg_temp.assert_true(
  private.wolfie_access_snapshot(
    '00000000-0000-4000-8000-00000000d002'
  ) ->> 'allowed' = 'true',
  'the first paid period must unlock standalone access'
);

select public.hub_activate_paid_checkout(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_1'
);

select pg_temp.assert_true(
  (
    select subscription.current_period_ends_at = expected.period_ends_at
    from public.hub_subscriptions as subscription
    cross join expected_wolfie_periods as expected
    where subscription.account_id = (
      select account.id
      from public.hub_accounts as account
      where account.owner_user_id = '00000000-0000-4000-8000-00000000d002'
        and account.account_type = 'PERSONAL'
    )
      and subscription.product_family = 'WOLFIE_STANDALONE'
      and expected.sequence_no = 1
  ),
  'duplicate events for the first payment must not extend the period'
);

select public.hub_activate_paid_checkout(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_2'
);

insert into expected_wolfie_periods(sequence_no, period_ends_at)
select 2, subscription.current_period_ends_at
from public.hub_subscriptions as subscription
where subscription.account_id = (
  select account.id
  from public.hub_accounts as account
  where account.owner_user_id = '00000000-0000-4000-8000-00000000d002'
    and account.account_type = 'PERSONAL'
)
  and subscription.product_family = 'WOLFIE_STANDALONE';

select pg_temp.assert_true(
  (
    select second.period_ends_at = first.period_ends_at + interval '1 month'
    from expected_wolfie_periods as first
    join expected_wolfie_periods as second
      on first.sequence_no = 1 and second.sequence_no = 2
  )
  and (
    select count(*) = 2
    from public.hub_subscription_payments
    where checkout_id = '10000000-0000-4000-8000-00000000d001'
      and status = 'APPLIED'
  ),
  'a new recurring payment must add exactly one period and one ledger row'
);

select public.hub_activate_paid_checkout(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_2'
);

select pg_temp.assert_true(
  (
    select subscription.current_period_ends_at = expected.period_ends_at
    from public.hub_subscriptions as subscription
    cross join expected_wolfie_periods as expected
    where subscription.account_id = (
      select account.id
      from public.hub_accounts as account
      where account.owner_user_id = '00000000-0000-4000-8000-00000000d002'
        and account.account_type = 'PERSONAL'
    )
      and subscription.product_family = 'WOLFIE_STANDALONE'
      and expected.sequence_no = 2
  ),
  'CONFIRMED and RECEIVED for one recurring payment must be idempotent'
);

select public.hub_mark_checkout_overdue(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_3'
);

select pg_temp.assert_true(
  (
    select status = 'PAST_DUE'
    from public.hub_subscriptions
    where account_id = (
      select id from public.hub_accounts
      where owner_user_id = '00000000-0000-4000-8000-00000000d002'
        and account_type = 'PERSONAL'
    )
      and product_family = 'WOLFIE_STANDALONE'
  )
  and (
    select status_financial = 'SUSPENDED'
    from public.profiles
    where id = '00000000-0000-4000-8000-00000000d002'
  )
  and exists (
    select 1
    from public.tenant_memberships
    where user_id = '00000000-0000-4000-8000-00000000d002'
      and tenant_id = 'wolfie-direct'
      and status = 'ACTIVE'
  ),
  'overdue must suspend paid access without deleting tenant membership'
);

select public.hub_activate_paid_checkout(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_3'
);

insert into expected_wolfie_periods(sequence_no, period_ends_at)
select 3, subscription.current_period_ends_at
from public.hub_subscriptions as subscription
where subscription.account_id = (
  select account.id
  from public.hub_accounts as account
  where account.owner_user_id = '00000000-0000-4000-8000-00000000d002'
    and account.account_type = 'PERSONAL'
)
  and subscription.product_family = 'WOLFIE_STANDALONE';

select pg_temp.assert_true(
  (
    select third.period_ends_at = second.period_ends_at + interval '1 month'
    from expected_wolfie_periods as second
    join expected_wolfie_periods as third
      on second.sequence_no = 2 and third.sequence_no = 3
  )
  and (
    select status = 'APPLIED'
    from public.hub_subscription_payments
    where provider = 'ASAAS'
      and provider_payment_id = 'pay_wolfie_fixture_3'
  ),
  'settling an overdue recurring payment must restore exactly one period'
);

select public.hub_reverse_paid_checkout(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_3',
  'PAYMENT_REFUNDED'
);

select pg_temp.assert_true(
  (
    select status = 'CANCELLED'
    from public.hub_subscriptions
    where account_id = (
      select id from public.hub_accounts
      where owner_user_id = '00000000-0000-4000-8000-00000000d002'
        and account_type = 'PERSONAL'
    )
      and product_family = 'WOLFIE_STANDALONE'
  )
  and (
    select status = 'REVERSED'
    from public.hub_subscription_payments
    where provider = 'ASAAS'
      and provider_payment_id = 'pay_wolfie_fixture_3'
  )
  and exists (
    select 1
    from public.tenant_memberships
    where user_id = '00000000-0000-4000-8000-00000000d002'
      and tenant_id = 'wolfie-direct'
      and status = 'ACTIVE'
  ),
  'reversing the latest recurring payment must revoke access, not membership'
);

select public.hub_reverse_paid_checkout(
  '10000000-0000-4000-8000-00000000d001',
  'pay_wolfie_fixture_3',
  'PAYMENT_REFUNDED'
);

select pg_temp.assert_true(
  private.wolfie_access_snapshot(
    '00000000-0000-4000-8000-00000000d002'
  ) ->> 'allowed' = 'false',
  'reversed standalone subscriptions must remain denied'
);

-- A Hub account may own both product families. Legacy Hub RPCs must only
-- bootstrap, trial and meter HUB_CORE even when the active Wolfie subscription
-- is newer.
insert into auth.users (
  id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-00000000d003',
  'authenticated',
  'authenticated',
  'hub-product-scope-fixture@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Hub Product Scope Fixture"}',
  pg_catalog.now(),
  pg_catalog.now()
);

insert into public.hub_accounts (
  id, account_type, audience, name, owner_user_id, status
)
values (
  '40000000-0000-4000-8000-00000000d003',
  'PERSONAL',
  'EDUCATOR',
  'Hub Product Scope Fixture',
  '00000000-0000-4000-8000-00000000d003',
  'ACTIVE'
);
insert into public.hub_memberships (
  account_id, user_id, membership_role, status
)
values (
  '40000000-0000-4000-8000-00000000d003',
  '00000000-0000-4000-8000-00000000d003',
  'OWNER',
  'ACTIVE'
);
insert into public.hub_subscriptions (
  id,
  account_id,
  plan_id,
  status,
  billing_cycle,
  current_period_starts_at,
  current_period_ends_at,
  product_family,
  metadata
)
select
  '50000000-0000-4000-8000-00000000d003',
  '40000000-0000-4000-8000-00000000d003',
  plan.id,
  'ACTIVE',
  'MONTHLY',
  pg_catalog.now(),
  pg_catalog.now() + interval '1 month',
  'WOLFIE_STANDALONE',
  '{"test_fixture":true}'::jsonb
from public.hub_plans as plan
where plan.code = 'WOLFIE_FOCO';

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d003","role":"authenticated"}',
  true
);
select public.hub_claim_trial('EDUCATOR', 'Hub Product Scope Fixture');

select pg_temp.assert_true(
  (
    select count(*) = 2
      and count(*) filter (where product_family = 'HUB_CORE') = 1
      and count(*) filter (
        where product_family = 'WOLFIE_STANDALONE'
      ) = 1
    from public.hub_subscriptions
    where account_id = '40000000-0000-4000-8000-00000000d003'
      and status in ('TRIALING', 'ACTIVE')
  ),
  'a Wolfie subscription must not consume or suppress the independent Hub trial'
);

select pg_temp.assert_true(
  public.hub_bootstrap(
    '40000000-0000-4000-8000-00000000d003'
  ) -> 'plan' ->> 'product_family' = 'HUB_CORE'
  and public.hub_bootstrap(
    '40000000-0000-4000-8000-00000000d003'
  ) -> 'plan' ->> 'code' = 'DISCOVERY',
  'Hub bootstrap must ignore a coexisting Wolfie subscription'
);

create temporary table hub_scope_usage_result (
  payload jsonb not null
) on commit drop;
insert into hub_scope_usage_result(payload)
values (
  public.hub_consume_feature(
    'wolfie.turn',
    1,
    '60000000-0000-4000-8000-00000000d003',
    '40000000-0000-4000-8000-00000000d003',
    '{"test_fixture":true}'::jsonb
  )
);

select pg_temp.assert_true(
  (
    select payload ->> 'allowed' = 'true'
      and payload ->> 'productFamily' = 'HUB_CORE'
      and (payload ->> 'subscriptionId')::uuid = subscription.id
    from hub_scope_usage_result
    join public.hub_subscriptions as subscription
      on subscription.id = (payload ->> 'subscriptionId')::uuid
    where subscription.account_id =
      '40000000-0000-4000-8000-00000000d003'
      and subscription.product_family = 'HUB_CORE'
  ),
  'Hub metering must charge the HUB_CORE entitlement only'
);

-- Once a provider-backed checkout exists, a competing checkout must fail
-- closed and leave the original row untouched.
insert into public.hub_checkout_sessions (
  id, account_id, plan_id, requested_by, billing_cycle, billing_type,
  amount, status, asaas_subscription_id, asaas_payment_id, request_key,
  product_family, metadata
)
select
  '70000000-0000-4000-8000-00000000d003',
  '40000000-0000-4000-8000-00000000d003',
  plan.id,
  '00000000-0000-4000-8000-00000000d003',
  'MONTHLY',
  'PIX',
  plan.price_monthly,
  'PENDING',
  'sub_provider_backed_fixture',
  'pay_provider_backed_fixture',
  '80000000-0000-4000-8000-00000000d003',
  'HUB_CORE',
  '{"test_fixture":true}'::jsonb
from public.hub_plans as plan
where plan.code = 'EDUCATOR_PRO';

do $duplicate_checkout_must_fail_closed$
begin
  begin
    insert into public.hub_checkout_sessions (
      id, account_id, plan_id, requested_by, billing_cycle, billing_type,
      amount, status, request_key, product_family, metadata
    )
    select
      '70000000-0000-4000-8000-00000000d004',
      '40000000-0000-4000-8000-00000000d003',
      plan.id,
      '00000000-0000-4000-8000-00000000d003',
      'MONTHLY',
      'PIX',
      plan.price_monthly,
      'PENDING',
      '80000000-0000-4000-8000-00000000d004',
      'HUB_CORE',
      '{"test_fixture":true}'::jsonb
    from public.hub_plans as plan
    where plan.code = 'EDUCATOR_PRO';
    raise exception 'duplicate_open_checkout_was_accepted';
  exception
    when unique_violation then null;
  end;
end;
$duplicate_checkout_must_fail_closed$;

select pg_temp.assert_true(
  (
    select count(*) = 1
      and bool_and(status = 'PENDING')
      and bool_and(asaas_subscription_id = 'sub_provider_backed_fixture')
      and bool_and(asaas_payment_id = 'pay_provider_backed_fixture')
    from public.hub_checkout_sessions
    where account_id = '40000000-0000-4000-8000-00000000d003'
      and product_family = 'HUB_CORE'
      and status in ('CREATED', 'PENDING', 'OVERDUE')
  ),
  'provider-backed checkout must remain intact after a competing insert'
);

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d002","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  public.hub_bootstrap(null) is null
  and public.hub_consume_feature(
    'wolfie.turn',
    1,
    '60000000-0000-4000-8000-00000000d002',
    null,
    '{}'::jsonb
  ) ->> 'code' = 'PRODUCT_SCOPE_FORBIDDEN',
  'wolfie-direct identities must not bootstrap or consume Hub Core'
);

do $direct_trial_must_be_rejected$
begin
  begin
    perform public.hub_claim_trial('LEARNER', 'Direct Fixture');
    raise exception 'wolfie_direct_hub_trial_was_accepted';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'learner_product_routing_required' then
        raise;
      end if;
  end;
end;
$direct_trial_must_be_rejected$;

rollback;
