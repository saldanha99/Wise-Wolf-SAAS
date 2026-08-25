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
  '7a200000-0000-4000-8000-000000000001',
  'hub-fulfillment-catalog-fixture',
  'Hub fulfillment catalog fixture',
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
    'test-fixtures/hub-fulfillment/full.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  ),
  (
    'hub-library',
    'test-fixtures/hub-fulfillment/preview.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  );

insert into public.hub_content_assets (
  content_id, asset_kind, bucket_id, object_path, mime_type
)
values
  (
    '7a200000-0000-4000-8000-000000000001',
    'FULL',
    'hub-library',
    'test-fixtures/hub-fulfillment/full.pdf',
    'application/pdf'
  ),
  (
    '7a200000-0000-4000-8000-000000000001',
    'PREVIEW',
    'hub-library',
    'test-fixtures/hub-fulfillment/preview.pdf',
    'application/pdf'
  );

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_fulfillment_outbox',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'anon',
    'public.hub_fulfillment_outbox',
    'SELECT'
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid = 'public.hub_fulfillment_outbox'::regclass
  ),
  'Hub fulfillment PII must remain service-only behind RLS'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_hub_fulfillment_outbox(uuid,integer)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.claim_hub_fulfillment_outbox(uuid,integer)',
    'EXECUTE'
  ),
  'only the service worker may claim Hub deliveries'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.trigger_hub_fulfillment_worker()',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.trigger_hub_fulfillment_worker()',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.trigger_hub_fulfillment_worker()',
    'EXECUTE'
  ),
  'only service role may trigger the Hub fulfillment worker'
);

select pg_temp.assert_true(
  (
    select count(*) = 3
      and bool_and(trigger.tgenabled <> 'D')
    from pg_catalog.pg_trigger as trigger
    where not trigger.tgisinternal
      and trigger.tgname in (
        'hub_release_fulfillment_after_payment_insert',
        'hub_release_fulfillment_after_payment_update',
        'hub_close_unpaid_fulfillment_after_checkout'
      )
  ),
  'payment release and unpaid checkout triggers must stay enabled'
);

select pg_temp.assert_true(
  exists (
    select 1
    from cron.job as job
    where job.jobname = 'wisewolf-hub-fulfillment'
      and job.active
      and job.schedule = '* * * * *'
      and job.command =
        'select public.trigger_hub_fulfillment_worker();'
  ),
  'Hub fulfillment cron must remain active every minute'
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
)
values (
  '81000000-0000-4000-8000-000000000101',
  'authenticated',
  'authenticated',
  'hub-fulfillment@example.invalid',
  '{"provider":"email","providers":["email"],"test_fixture":true}',
  '{"full_name":"Hub Fulfillment Fixture"}',
  pg_catalog.now(),
  pg_catalog.now()
);

insert into public.hub_plans (
  id,
  code,
  name,
  audience,
  price_monthly,
  currency,
  trial_days,
  is_public,
  is_active,
  features,
  metadata,
  product_family
)
values (
  '82000000-0000-4000-8000-000000000101',
  'HUB_FULFILLMENT_FIXTURE',
  'Hub Fulfillment Fixture',
  'ALL',
  1,
  'BRL',
  0,
  false,
  true,
  '[]'::jsonb,
  '{"test_fixture":true,"product_family":"HUB_CORE"}'::jsonb,
  'HUB_CORE'
);

insert into public.hub_accounts (
  id,
  account_type,
  audience,
  name,
  owner_user_id,
  status,
  metadata
)
values (
  '83000000-0000-4000-8000-000000000101',
  'PERSONAL',
  'EDUCATOR',
  'Hub Fulfillment Account',
  '81000000-0000-4000-8000-000000000101',
  'ACTIVE',
  '{"test_fixture":true}'::jsonb
);

insert into public.hub_memberships (
  account_id,
  user_id,
  membership_role,
  status
)
values (
  '83000000-0000-4000-8000-000000000101',
  '81000000-0000-4000-8000-000000000101',
  'OWNER',
  'ACTIVE'
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
  product_family,
  metadata
)
values (
  '84000000-0000-4000-8000-000000000101',
  '83000000-0000-4000-8000-000000000101',
  '82000000-0000-4000-8000-000000000101',
  '81000000-0000-4000-8000-000000000101',
  'MONTHLY',
  'PIX',
  1,
  'PENDING',
  'sub_hub_fulfillment_fixture',
  'HUB_CORE',
  '{"test_fixture":true}'::jsonb
);

insert into public.hub_fulfillment_outbox (
  checkout_id,
  account_id,
  user_id,
  product_family,
  plan_code,
  plan_name,
  channel,
  recipient,
  recipient_name,
  metadata
)
values
  (
    '84000000-0000-4000-8000-000000000101',
    '83000000-0000-4000-8000-000000000101',
    '81000000-0000-4000-8000-000000000101',
    'HUB_CORE',
    'HUB_FULFILLMENT_FIXTURE',
    'Hub Fulfillment Fixture',
    'EMAIL',
    'hub-fulfillment@example.invalid',
    'Hub Fulfillment Fixture',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '84000000-0000-4000-8000-000000000101',
    '83000000-0000-4000-8000-000000000101',
    '81000000-0000-4000-8000-000000000101',
    'HUB_CORE',
    'HUB_FULFILLMENT_FIXTURE',
    'Hub Fulfillment Fixture',
    'WHATSAPP',
    '11999990000',
    'Hub Fulfillment Fixture',
    '{"test_fixture":true}'::jsonb
  );

insert into public.hub_subscriptions (
  id,
  account_id,
  plan_id,
  status,
  billing_cycle,
  current_period_starts_at,
  current_period_ends_at,
  provider,
  provider_subscription_id,
  provider_payment_id,
  product_family,
  metadata
)
values (
  '85000000-0000-4000-8000-000000000101',
  '83000000-0000-4000-8000-000000000101',
  '82000000-0000-4000-8000-000000000101',
  'ACTIVE',
  'MONTHLY',
  pg_catalog.now(),
  pg_catalog.now() + interval '1 month',
  'ASAAS',
  'sub_hub_fulfillment_fixture',
  'pay_hub_fulfillment_fixture',
  'HUB_CORE',
  '{"test_fixture":true}'::jsonb
);

insert into public.hub_subscription_payments (
  provider,
  provider_payment_id,
  checkout_id,
  subscription_id,
  account_id,
  product_family,
  status,
  period_starts_at,
  period_ends_at,
  applied_at,
  metadata
)
values (
  'ASAAS',
  'pay_hub_fulfillment_fixture',
  '84000000-0000-4000-8000-000000000101',
  '85000000-0000-4000-8000-000000000101',
  '83000000-0000-4000-8000-000000000101',
  'HUB_CORE',
  'APPLIED',
  pg_catalog.now(),
  pg_catalog.now() + interval '1 month',
  pg_catalog.now(),
  '{"renewal":false,"test_fixture":true}'::jsonb
);

select pg_temp.assert_true(
  (
    select count(*) = 2
      and bool_and(status = 'SKIPPED')
      and bool_and(last_error = 'test_fixture_suppressed')
      and bool_and(subscription_id = '85000000-0000-4000-8000-000000000101')
    from public.hub_fulfillment_outbox
    where checkout_id = '84000000-0000-4000-8000-000000000101'
  ),
  'paid test fixtures must be suppressed atomically before provider delivery'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.claim_hub_fulfillment_outbox(
      '84000000-0000-4000-8000-000000000101',
      20
    )
  ),
  'suppressed fixture deliveries must never be claimable'
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
  product_family,
  metadata
)
values (
  '84000000-0000-4000-8000-000000000102',
  '83000000-0000-4000-8000-000000000101',
  '82000000-0000-4000-8000-000000000101',
  '81000000-0000-4000-8000-000000000101',
  'MONTHLY',
  'PIX',
  1,
  'PAID',
  'sub_hub_fulfillment_claim_fixture',
  'HUB_CORE',
  '{}'::jsonb
);

insert into public.hub_fulfillment_outbox (
  checkout_id,
  account_id,
  user_id,
  product_family,
  plan_code,
  plan_name,
  channel,
  recipient,
  recipient_name,
  metadata
)
values
  (
    '84000000-0000-4000-8000-000000000102',
    '83000000-0000-4000-8000-000000000101',
    '81000000-0000-4000-8000-000000000101',
    'HUB_CORE',
    'HUB_FULFILLMENT_FIXTURE',
    'Hub Fulfillment Fixture',
    'EMAIL',
    'claim-fixture@example.invalid',
    'Claim Fixture',
    '{}'::jsonb
  ),
  (
    '84000000-0000-4000-8000-000000000102',
    '83000000-0000-4000-8000-000000000101',
    '81000000-0000-4000-8000-000000000101',
    'HUB_CORE',
    'HUB_FULFILLMENT_FIXTURE',
    'Hub Fulfillment Fixture',
    'WHATSAPP',
    '11999990001',
    'Claim Fixture',
    '{}'::jsonb
  );

insert into public.hub_subscription_payments (
  provider,
  provider_payment_id,
  checkout_id,
  subscription_id,
  account_id,
  product_family,
  status,
  period_starts_at,
  period_ends_at,
  applied_at,
  metadata
)
values (
  'ASAAS',
  'pay_hub_fulfillment_claim_fixture',
  '84000000-0000-4000-8000-000000000102',
  '85000000-0000-4000-8000-000000000101',
  '83000000-0000-4000-8000-000000000101',
  'HUB_CORE',
  'APPLIED',
  pg_catalog.now(),
  pg_catalog.now() + interval '1 month',
  pg_catalog.now(),
  '{"renewal":false}'::jsonb
);

create temporary table claimed_hub_fulfillment on commit drop as
select *
from public.claim_hub_fulfillment_outbox(
  '84000000-0000-4000-8000-000000000102',
  20
);

select pg_temp.assert_true(
  (
    select count(*) = 2
      and bool_and(attempt_count = 1)
      and bool_and(lease_token is not null)
      and bool_and(provider_dispatch_started_at is null)
    from claimed_hub_fulfillment
  ),
  'one worker claim must atomically token-lease both paid delivery channels'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from public.claim_hub_fulfillment_outbox(
      '84000000-0000-4000-8000-000000000102',
      20
    )
  ),
  'an active lease must prevent duplicate email and WhatsApp delivery'
);

update public.hub_fulfillment_outbox
set provider_dispatch_started_at = pg_catalog.now(),
    lease_expires_at = pg_catalog.now() - interval '1 minute',
    updated_at = pg_catalog.now()
where checkout_id = '84000000-0000-4000-8000-000000000102';

create temporary table reclaimed_hub_fulfillment on commit drop as
select *
from public.claim_hub_fulfillment_outbox(
  '84000000-0000-4000-8000-000000000102',
  20
);

select pg_temp.assert_true(
  (
    select count(*) = 1
      and bool_and(channel = 'EMAIL')
      and bool_and(provider_dispatch_started_at is not null)
      and bool_and(
        lease_token <> (
          select first_claim.lease_token
          from claimed_hub_fulfillment as first_claim
          where first_claim.channel = 'EMAIL'
        )
      )
    from reclaimed_hub_fulfillment
  ),
  'email may retry inside the provider idempotency window with a fresh lease'
);

select pg_temp.assert_true(
  (
    select status = 'UNCERTAIN'
      and lease_token is null
      and lease_expires_at is null
      and last_error = 'provider_outcome_unknown'
    from public.hub_fulfillment_outbox
    where checkout_id = '84000000-0000-4000-8000-000000000102'
      and channel = 'WHATSAPP'
  ),
  'stale WhatsApp dispatches must be quarantined instead of resent'
);

with stale_update as (
  update public.hub_fulfillment_outbox as delivery
  set status = 'SENT'
  from claimed_hub_fulfillment as first_claim
  where delivery.id = first_claim.id
    and first_claim.channel = 'EMAIL'
    and delivery.status = 'PROCESSING'
    and delivery.lease_token = first_claim.lease_token
  returning delivery.id
)
select pg_temp.assert_true(
  (select count(*) = 0 from stale_update),
  'a stale lease token must not finalize a delivery reclaimed by another worker'
);

rollback;
