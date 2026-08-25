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

alter table public.hub_content_items
  drop constraint if exists hub_content_items_catalog_scope_check;
alter table public.hub_content_items
  drop constraint if exists hub_content_items_publication_integrity_check;

update public.hub_content_items
set is_active = false,
    published_at = null;

update public.hub_settings
set metadata = coalesce(metadata, '{}'::jsonb)
      || '{"catalogReady":true,"hubEnabled":true}'::jsonb
where settings_key = 'default';

select pg_temp.assert_true(
  not private.hub_catalog_is_ready(),
  'an empty catalog was considered commercially ready'
);

do $test$
declare
  v_owner_id uuid;
  v_account_id uuid := pg_catalog.gen_random_uuid();
  v_discovery_plan_id uuid;
begin
  select user_record.id into v_owner_id
  from auth.users as user_record
  order by user_record.created_at, user_record.id
  limit 1;

  select plan.id into v_discovery_plan_id
  from public.hub_plans as plan
  where plan.code = 'DISCOVERY'
    and plan.product_family = 'HUB_CORE';

  if v_owner_id is null or v_discovery_plan_id is null then
    raise exception 'hub catalog readiness fixtures are unavailable';
  end if;

  insert into public.hub_accounts (
    id,
    account_type,
    audience,
    name,
    owner_user_id,
    metadata
  ) values (
    v_account_id,
    'ORGANIZATION',
    'EDUCATOR',
    'Hub catalog readiness fixture',
    v_owner_id,
    '{"test_fixture":true}'::jsonb
  );

  begin
    insert into public.hub_subscriptions (
      account_id,
      plan_id,
      product_family,
      status,
      trial_starts_at,
      trial_ends_at,
      current_period_starts_at,
      current_period_ends_at,
      metadata
    ) values (
      v_account_id,
      v_discovery_plan_id,
      'HUB_CORE',
      'TRIALING',
      pg_catalog.now(),
      pg_catalog.now() + interval '7 days',
      pg_catalog.now(),
      pg_catalog.now() + interval '7 days',
      '{"test_fixture":true}'::jsonb
    );
    raise exception 'empty catalog trial unexpectedly succeeded';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'hub_catalog_not_ready' then
        raise;
      end if;
  end;

  insert into public.hub_content_items (
    id,
    slug,
    title,
    content_type,
    catalog_scope,
    license_summary,
    rights_verified_at,
    rights_basis,
    published_at,
    preview_enabled,
    is_active,
    metadata
  ) values (
    '7a000000-0000-4000-8000-000000000401',
    'hub-catalog-readiness-fixture',
    'Hub catalog readiness fixture',
    'PDF',
    'COMMERCIAL_GLOBAL',
    'Owned test fixture',
    pg_catalog.now(),
    'OWNED',
    pg_catalog.now(),
    true,
    true,
    '{"test_fixture":true}'::jsonb
  );

  insert into storage.objects (bucket_id, name, metadata)
  values
    (
      'hub-library',
      'test-fixtures/catalog-readiness/full.pdf',
      '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
    ),
    (
      'hub-library',
      'test-fixtures/catalog-readiness/preview.pdf',
      '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
    );

  insert into public.hub_content_assets (
    content_id, asset_kind, bucket_id, object_path, mime_type
  ) values
    (
      '7a000000-0000-4000-8000-000000000401',
      'FULL',
      'hub-library',
      'test-fixtures/catalog-readiness/full.pdf',
      'application/pdf'
    ),
    (
      '7a000000-0000-4000-8000-000000000401',
      'PREVIEW',
      'hub-library',
      'test-fixtures/catalog-readiness/preview.pdf',
      'application/pdf'
    );

  if not private.hub_catalog_is_ready() then
    raise exception 'a rights-verified item with stored assets did not open the catalog';
  end if;

  update public.hub_content_items
  set catalog_scope = 'TENANT_PRIVATE'
  where id = '7a000000-0000-4000-8000-000000000401';
  if private.hub_catalog_is_ready() then
    raise exception 'tenant-private content opened the commercial catalog';
  end if;

  update public.hub_content_items
  set catalog_scope = 'COMMERCIAL_GLOBAL',
      rights_basis = null
  where id = '7a000000-0000-4000-8000-000000000401';
  if private.hub_catalog_is_ready() then
    raise exception 'content without a valid rights basis opened the catalog';
  end if;

  update public.hub_content_items
  set rights_basis = 'OWNED',
      license_summary = '   '
  where id = '7a000000-0000-4000-8000-000000000401';
  if private.hub_catalog_is_ready() then
    raise exception 'content without a license summary opened the catalog';
  end if;

  update public.hub_content_items
  set license_summary = 'Owned test fixture'
  where id = '7a000000-0000-4000-8000-000000000401';

  insert into public.hub_subscriptions (
    account_id,
    plan_id,
    product_family,
    status,
    trial_starts_at,
    trial_ends_at,
    current_period_starts_at,
    current_period_ends_at,
    metadata
  ) values (
    v_account_id,
    v_discovery_plan_id,
    'HUB_CORE',
    'TRIALING',
    pg_catalog.now(),
    pg_catalog.now() + interval '7 days',
    pg_catalog.now(),
    pg_catalog.now() + interval '7 days',
    '{"test_fixture":true}'::jsonb
  );
end;
$test$;

select pg_temp.assert_true(
  not has_function_privilege(
    'anon', 'private.hub_catalog_is_ready()', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'private.hub_catalog_is_ready()', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'private.hub_catalog_is_ready()', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.hub_guard_discovery_catalog_ready()',
    'EXECUTE'
  ),
  'catalog readiness internals are directly callable'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_trigger as trigger_record
    where trigger_record.tgrelid = 'public.hub_subscriptions'::regclass
      and trigger_record.tgname = 'hub_guard_discovery_catalog_ready'
      and not trigger_record.tgisinternal
  ),
  'the discovery catalog guard trigger is missing'
);

rollback;
