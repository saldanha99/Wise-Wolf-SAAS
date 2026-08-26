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

create or replace function pg_temp.assert_sqlstate(
  statement text,
  expected_sqlstate text,
  message text
)
returns void
language plpgsql
as $function$
begin
  begin
    execute statement;
  exception
    when others then
      if sqlstate = expected_sqlstate then
        return;
      end if;
      raise exception 'assertion failed: % (expected %, received %)',
        message,
        expected_sqlstate,
        sqlstate;
  end;
  raise exception 'assertion failed: % (statement did not fail)', message;
end;
$function$;

grant execute on function pg_temp.assert_sqlstate(text, text, text) to public;

select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.hub_schedule_core_cancellation(uuid,uuid,text[])',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_begin_core_cancellation(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_begin_core_cancellation(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_schedule_core_cancellation(uuid,uuid,text[])',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_schedule_core_cancellation(uuid,uuid,text[])',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.hub_schedule_core_cancellation_internal(uuid,uuid,text[])',
    'EXECUTE'
  ),
  'Hub cancellation finalization is not service-role-only'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 6
      and pg_catalog.bool_and(procedure.prosecdef)
      and pg_catalog.bool_and(
        pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
      )
      and pg_catalog.bool_and(
        procedure.proconfig @> array['search_path=""']::text[]
      )
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where (
      namespace.nspname,
      procedure.proname
    ) in (
      ('private', 'hub_catalog_is_ready'),
      ('private', 'hub_guard_core_checkout_creation'),
      ('private', 'hub_guard_core_subscription_activation'),
      ('private', 'hub_begin_core_cancellation_internal'),
      ('private', 'hub_schedule_core_cancellation_internal'),
      ('private', 'expire_hub_core_cancellations_internal')
    )
  ),
  'privileged Hub cancellation functions lack an empty search_path'
);

select pg_temp.assert_true(
  pg_catalog.pg_get_functiondef(
    'private.hub_guard_core_checkout_creation()'::regprocedure
  ) like '%pg_advisory_xact_lock%'
  and pg_catalog.pg_get_functiondef(
    'private.hub_guard_core_checkout_creation()'::regprocedure
  ) like '%hub-core-cancellation:%',
  'checkout creation does not share the cancellation advisory lock'
);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '7c000000-0000-4000-8000-000000000101',
    'authenticated', 'authenticated', 'cancel-owner@example.invalid',
    '{"provider":"email","providers":["email"]}', '{}',
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '7c000000-0000-4000-8000-000000000102',
    'authenticated', 'authenticated', 'cancel-admin@example.invalid',
    '{"provider":"email","providers":["email"]}', '{}',
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '7c000000-0000-4000-8000-000000000103',
    'authenticated', 'authenticated', 'cancel-member@example.invalid',
    '{"provider":"email","providers":["email"]}', '{}',
    pg_catalog.now(), pg_catalog.now()
  ),
  (
    '7c000000-0000-4000-8000-000000000104',
    'authenticated', 'authenticated', 'cancel-owner-b@example.invalid',
    '{"provider":"email","providers":["email"]}', '{}',
    pg_catalog.now(), pg_catalog.now()
  );

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
set tenant_id = null,
    lifecycle_status = 'active',
    role = 'NON_STUDENT'
where id in (
  '7c000000-0000-4000-8000-000000000101',
  '7c000000-0000-4000-8000-000000000102',
  '7c000000-0000-4000-8000-000000000103',
  '7c000000-0000-4000-8000-000000000104'
);
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_plans (
  id, code, name, description, audience, price_monthly, price_yearly,
  trial_days, display_order, is_public, is_active, features, metadata,
  product_family
)
values (
  '7c000000-0000-4000-8000-000000000201',
  'TEST_HUB_CANCEL_CORE',
  'Test Hub Cancellation',
  'Rollback-only fixture',
  'ALL',
  10,
  100,
  7,
  9999,
  false,
  true,
  '[]'::jsonb,
  '{"test_fixture":true}'::jsonb,
  'HUB_CORE'
);

insert into public.hub_accounts (
  id, account_type, audience, name, owner_user_id, status, metadata
)
values
  (
    '7c000000-0000-4000-8000-000000000301',
    'ORGANIZATION', 'EDUCATOR', 'Cancellation Account A',
    '7c000000-0000-4000-8000-000000000101',
    'ACTIVE', '{"test_fixture":true}'::jsonb
  ),
  (
    '7c000000-0000-4000-8000-000000000302',
    'ORGANIZATION', 'EDUCATOR', 'Cancellation Account B',
    '7c000000-0000-4000-8000-000000000104',
    'ACTIVE', '{"test_fixture":true}'::jsonb
  );

insert into public.hub_memberships (
  account_id, user_id, membership_role, status
)
values
  (
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000101',
    'OWNER', 'ACTIVE'
  ),
  (
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000102',
    'ADMIN', 'ACTIVE'
  ),
  (
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000103',
    'MEMBER', 'ACTIVE'
  ),
  (
    '7c000000-0000-4000-8000-000000000302',
    '7c000000-0000-4000-8000-000000000104',
    'OWNER', 'ACTIVE'
  ),
  (
    '7c000000-0000-4000-8000-000000000302',
    '7c000000-0000-4000-8000-000000000102',
    'ADMIN', 'ACTIVE'
  );

update public.hub_settings
set metadata = coalesce(metadata, '{}'::jsonb)
      || '{"catalogReady":false,"hubEnabled":true}'::jsonb
where settings_key = 'default';

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_subscriptions (
      account_id, plan_id, status, trial_starts_at, trial_ends_at,
      current_period_starts_at, current_period_ends_at, product_family
    ) values (
      '7c000000-0000-4000-8000-000000000301',
      '7c000000-0000-4000-8000-000000000201',
      'TRIALING', now(), now() + interval '7 days', now(),
      now() + interval '7 days', 'HUB_CORE'
    )
  $statement$,
  '55000',
  'a Discovery trial was created while the catalog was not ready'
);

insert into public.hub_content_items (
  id, slug, title, description, content_type, level_tag, niche,
  preview_enabled, license_summary, author_name, rights_verified_at,
  rights_basis, catalog_scope, published_at, is_active, metadata
)
values (
  '7c000000-0000-4000-8000-000000000401',
  'test-hub-cancel-ready-content',
  'Ready content fixture',
  'Rollback-only fixture',
  'PDF',
  'B1',
  'GENERAL',
  true,
  'Rights verified for automated rollback test only',
  'Wise Wolf QA',
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
    'test-fixtures/cancellation/full.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  ),
  (
    'hub-library',
    'test-fixtures/cancellation/preview.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  );

insert into public.hub_content_assets (
  content_id, asset_kind, bucket_id, object_path, mime_type
)
values
  (
    '7c000000-0000-4000-8000-000000000401',
    'FULL', 'hub-library',
    'test-fixtures/cancellation/full.pdf', 'application/pdf'
  ),
  (
    '7c000000-0000-4000-8000-000000000401',
    'PREVIEW', 'hub-library',
    'test-fixtures/cancellation/preview.pdf', 'application/pdf'
  );

update public.hub_settings
set metadata = coalesce(metadata, '{}'::jsonb)
      || '{"catalogReady":true,"hubEnabled":true}'::jsonb
where settings_key = 'default';

select pg_temp.assert_true(
  private.hub_catalog_is_ready()
  and coalesce(
    (public.hub_get_public_settings() -> 'metadata' ->> 'catalogReady')::boolean,
    false
  ),
  'the ready licensed catalog was not exposed through public settings'
);

insert into public.hub_subscriptions (
  id, account_id, plan_id, status, billing_cycle,
  current_period_starts_at, current_period_ends_at,
  provider, provider_subscription_id, provider_payment_id,
  product_family, metadata
)
values
  (
    '7c000000-0000-4000-8000-000000000501',
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000201',
    'ACTIVE', 'MONTHLY', pg_catalog.now(), '2099-01-15T12:00:00Z',
    'ASAAS', 'sub_cancel_a', 'pay_cancel_a', 'HUB_CORE',
    '{"checkoutId":"7c000000-0000-4000-8000-000000000601"}'::jsonb
  ),
  (
    '7c000000-0000-4000-8000-000000000502',
    '7c000000-0000-4000-8000-000000000302',
    '7c000000-0000-4000-8000-000000000201',
    'ACTIVE', 'MONTHLY', pg_catalog.now(), '2099-02-15T12:00:00Z',
    'ASAAS', 'sub_cancel_b', 'pay_cancel_b', 'HUB_CORE',
    '{"checkoutId":"7c000000-0000-4000-8000-000000000602"}'::jsonb
  );

insert into public.hub_checkout_sessions (
  id, account_id, plan_id, requested_by, billing_cycle, billing_type,
  amount, status, asaas_subscription_id, asaas_payment_id,
  product_family, metadata
)
values
  (
    '7c000000-0000-4000-8000-000000000601',
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000201',
    '7c000000-0000-4000-8000-000000000101',
    'MONTHLY', 'PIX', 10, 'PAID',
    'sub_cancel_a', 'pay_cancel_a', 'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '7c000000-0000-4000-8000-000000000602',
    '7c000000-0000-4000-8000-000000000302',
    '7c000000-0000-4000-8000-000000000201',
    '7c000000-0000-4000-8000-000000000104',
    'MONTHLY', 'PIX', 10, 'PAID',
    'sub_cancel_b', 'pay_cancel_b', 'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '7c000000-0000-4000-8000-000000000604',
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000201',
    '7c000000-0000-4000-8000-000000000101',
    'MONTHLY', 'PIX', 10, 'CREATED',
    null, null, 'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  );

set local role service_role;

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_schedule_core_cancellation(
      '7c000000-0000-4000-8000-000000000301',
      '7c000000-0000-4000-8000-000000000103',
      array['sub_cancel_a']::text[]
    )
  $statement$,
  '42501',
  'a MEMBER cancelled the Hub subscription'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_schedule_core_cancellation(
      '7c000000-0000-4000-8000-000000000302',
      '7c000000-0000-4000-8000-000000000101',
      array['sub_cancel_b']::text[]
    )
  $statement$,
  '42501',
  'an OWNER crossed the Hub account boundary'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_schedule_core_cancellation(
      '7c000000-0000-4000-8000-000000000301',
      '7c000000-0000-4000-8000-000000000101',
      '{}'::text[]
    )
  $statement$,
  '55000',
  'local cancellation completed without provider confirmation'
);

select pg_temp.assert_true(
  (
    select payload ->> 'cancellationInProgress' = 'true'
    from (
      select public.hub_begin_core_cancellation(
        '7c000000-0000-4000-8000-000000000301',
        '7c000000-0000-4000-8000-000000000101'
      ) as payload
    ) as cancellation_begin
  ),
  'the provider synchronization barrier was not returned'
);

reset role;
select pg_temp.assert_true(
  (
    select subscription.metadata ->> 'cancellationInProgress' = 'true'
    from public.hub_subscriptions as subscription
    where subscription.id = '7c000000-0000-4000-8000-000000000501'
  ),
  'the provider synchronization barrier was not recorded'
);
set local role service_role;

select pg_temp.assert_sqlstate(
  $statement$
    update public.hub_checkout_sessions
    set asaas_subscription_id = 'sub_raced_a'
    where id = '7c000000-0000-4000-8000-000000000604'
  $statement$,
  '55000',
  'a provider subscription link raced past the cancellation barrier'
);

with cancelled as materialized (
  select public.hub_schedule_core_cancellation(
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000101',
    array['sub_cancel_a']::text[]
  ) as payload
)
select pg_temp.assert_true(
  (
    select payload ->> 'cancelAtPeriodEnd' = 'true'
      and payload ->> 'status' = 'ACTIVE'
      and payload ->> 'accessEndsAt' = '2099-01-15T12:00:00+00:00'
    from cancelled
  ),
  'cancellation did not preserve the paid access payload'
);

reset role;
select pg_temp.assert_true(
  (
    select subscription.status = 'ACTIVE'
      and subscription.current_period_ends_at = '2099-01-15T12:00:00Z'
      and subscription.cancelled_at is not null
      and subscription.metadata ->> 'cancelAtPeriodEnd' = 'true'
    from public.hub_subscriptions as subscription
    where subscription.id = '7c000000-0000-4000-8000-000000000501'
  ),
  'cancellation did not preserve the paid subscription boundary'
);
select pg_temp.assert_true(
  (
    select checkout.status = 'CANCELLED'
      and checkout.metadata ->> 'cancelAtPeriodEnd' = 'true'
    from public.hub_checkout_sessions as checkout
    where checkout.id = '7c000000-0000-4000-8000-000000000601'
  ),
  'cancellation did not close the provider checkout'
);
set local role service_role;

with repeated as materialized (
  select public.hub_schedule_core_cancellation(
    '7c000000-0000-4000-8000-000000000301',
    '7c000000-0000-4000-8000-000000000101',
    array['sub_cancel_a']::text[]
  ) as payload
)
select pg_temp.assert_true(
  (select payload ->> 'idempotent' = 'true' from repeated)
  and (
    select pg_catalog.count(*) = 1
    from public.hub_conversion_events as event
    where event.account_id = '7c000000-0000-4000-8000-000000000301'
      and event.event_name = 'hub_subscription_cancellation_scheduled'
  ),
  'repeated cancellation created a second state transition'
);

with late_payment as materialized (
  select public.hub_activate_paid_checkout(
    '7c000000-0000-4000-8000-000000000601',
    'pay_after_cancel_a'
  ) as payload
)
select pg_temp.assert_true(
  (select payload ->> 'applied' = 'false' from late_payment)
  and (
    select subscription.status = 'ACTIVE'
      and subscription.current_period_ends_at = '2099-01-15T12:00:00Z'
    from public.hub_subscriptions as subscription
    where subscription.id = '7c000000-0000-4000-8000-000000000501'
  ),
  'a late webhook resurrected or extended the cancelled subscription'
);

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_checkout_sessions (
      account_id, plan_id, requested_by, billing_cycle, billing_type,
      amount, status, product_family, metadata
    ) values (
      '7c000000-0000-4000-8000-000000000301',
      '7c000000-0000-4000-8000-000000000201',
      '7c000000-0000-4000-8000-000000000101',
      'MONTHLY', 'PIX', 10, 'CREATED', 'HUB_CORE',
      '{"test_fixture":true}'::jsonb
    )
  $statement$,
  '55000',
  'a new checkout opened before the cancelled paid period ended'
);

select pg_temp.assert_true(
  (
    select payload ->> 'cancelAtPeriodEnd' = 'true'
      and payload ->> 'status' = 'ACTIVE'
    from (
      select public.hub_schedule_core_cancellation(
        '7c000000-0000-4000-8000-000000000302',
        '7c000000-0000-4000-8000-000000000102',
        array['sub_cancel_b']::text[]
      ) as payload
    ) as admin_cancellation
  ),
  'an active ADMIN could not cancel within the exact account'
);

reset role;

update public.hub_subscriptions
set current_period_ends_at = pg_catalog.now() - interval '1 second'
where id = '7c000000-0000-4000-8000-000000000501';

select pg_temp.assert_true(
  private.expire_hub_core_cancellations_internal() >= 1,
  'the cancellation expiry worker did not expire a due subscription'
);
select pg_temp.assert_true(
  (
    select subscription.status = 'EXPIRED'
      and subscription.metadata ->> 'expiredBy' =
        'hub_core_period_expiration'
    from public.hub_subscriptions as subscription
    where subscription.id = '7c000000-0000-4000-8000-000000000501'
  ),
  'the expired subscription did not retain its audit state'
);

insert into public.hub_checkout_sessions (
  id, account_id, plan_id, requested_by, billing_cycle, billing_type,
  amount, status, asaas_subscription_id, asaas_payment_id,
  product_family, metadata
)
values (
  '7c000000-0000-4000-8000-000000000603',
  '7c000000-0000-4000-8000-000000000301',
  '7c000000-0000-4000-8000-000000000201',
  '7c000000-0000-4000-8000-000000000101',
  'MONTHLY', 'PIX', 10, 'CREATED',
  'sub_new_a', 'pay_new_a', 'HUB_CORE',
  '{"test_fixture":true}'::jsonb
);

set local role service_role;
select public.hub_activate_paid_checkout(
  '7c000000-0000-4000-8000-000000000603',
  'pay_new_a'
);
reset role;

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 1
    from public.hub_subscriptions as subscription
    where subscription.account_id =
      '7c000000-0000-4000-8000-000000000301'
      and subscription.product_family = 'HUB_CORE'
      and subscription.status = 'ACTIVE'
      and subscription.provider_subscription_id = 'sub_new_a'
  ),
  'a new subscription could not start after the cancelled period expired'
);

rollback;
