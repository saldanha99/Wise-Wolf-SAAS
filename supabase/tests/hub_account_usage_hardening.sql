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
      || '{"hubEnabled":true,"catalogReady":true,"securityTestMarker":"preserved"}'::jsonb
where settings_key = 'default';

insert into public.hub_content_items (
  id, slug, title, content_type, preview_enabled, license_summary,
  rights_verified_at, rights_basis, catalog_scope, published_at,
  is_active, metadata
)
values (
  '7a100000-0000-4000-8000-000000000001',
  'hub-account-usage-catalog-fixture',
  'Hub account usage catalog fixture',
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
    'test-fixtures/hub-account-usage/full.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  ),
  (
    'hub-library',
    'test-fixtures/hub-account-usage/preview.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  );

insert into public.hub_content_assets (
  content_id, asset_kind, bucket_id, object_path, mime_type
)
values
  (
    '7a100000-0000-4000-8000-000000000001',
    'FULL',
    'hub-library',
    'test-fixtures/hub-account-usage/full.pdf',
    'application/pdf'
  ),
  (
    '7a100000-0000-4000-8000-000000000001',
    'PREVIEW',
    'hub-library',
    'test-fixtures/hub-account-usage/preview.pdf',
    'application/pdf'
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
values
  (
    '71000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'hub-owner-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Owner A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'hub-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Admin A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000103',
    'authenticated',
    'authenticated',
    'hub-member-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Member A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000104',
    'authenticated',
    'authenticated',
    'hub-owner-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Owner B"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000105',
    'authenticated',
    'authenticated',
    'hub-super-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Super Admin"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000106',
    'authenticated',
    'authenticated',
    'hub-fresh-owner@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Fresh Owner"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '71000000-0000-4000-8000-000000000107',
    'authenticated',
    'authenticated',
    'hub-expired-owner@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Expired Owner"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
set tenant_id = null,
    lifecycle_status = 'active',
    role = case
      when id = '71000000-0000-4000-8000-000000000105'
        then 'SUPER_ADMIN'
      else 'NON_STUDENT'
    end
where id in (
  '71000000-0000-4000-8000-000000000101',
  '71000000-0000-4000-8000-000000000102',
  '71000000-0000-4000-8000-000000000103',
  '71000000-0000-4000-8000-000000000104',
  '71000000-0000-4000-8000-000000000105',
  '71000000-0000-4000-8000-000000000106',
  '71000000-0000-4000-8000-000000000107'
);
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_plans (
  id,
  code,
  name,
  description,
  audience,
  price_monthly,
  price_yearly,
  currency,
  trial_days,
  display_order,
  is_public,
  is_active,
  features,
  metadata,
  product_family
)
values (
  '72000000-0000-4000-8000-000000000101',
  'HUB_SECURITY_FIXTURE',
  'Hub Security Fixture',
  'Transactional security test plan.',
  'ALL',
  1,
  10,
  'BRL',
  7,
  999,
  false,
  true,
  '[]'::jsonb,
  '{"test_fixture":true,"product_family":"HUB_CORE"}'::jsonb,
  'HUB_CORE'
);

insert into public.hub_plan_entitlements (
  plan_id,
  feature_key,
  limit_value,
  reset_period,
  metadata
)
values (
  '72000000-0000-4000-8000-000000000101',
  'educator_ai.generate',
  1,
  'MONTH',
  '{"test_fixture":true}'::jsonb
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
values
  (
    '73000000-0000-4000-8000-000000000101',
    'ORGANIZATION',
    'INSTITUTION',
    'Hub Account A',
    '71000000-0000-4000-8000-000000000101',
    'ACTIVE',
    '{"goal":"Security A","asaasLeak":"must-not-bootstrap"}'::jsonb
  ),
  (
    '73000000-0000-4000-8000-000000000102',
    'ORGANIZATION',
    'INSTITUTION',
    'Hub Account B',
    '71000000-0000-4000-8000-000000000104',
    'ACTIVE',
    '{"goal":"Security B"}'::jsonb
  ),
  (
    '73000000-0000-4000-8000-000000000103',
    'PERSONAL',
    'EDUCATOR',
    'Hub Expired Account',
    '71000000-0000-4000-8000-000000000107',
    'ACTIVE',
    '{"test_fixture":true}'::jsonb
  );

insert into public.hub_memberships (
  account_id,
  user_id,
  membership_role,
  status
)
values
  (
    '73000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000101',
    'OWNER',
    'ACTIVE'
  ),
  (
    '73000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000102',
    'ADMIN',
    'ACTIVE'
  ),
  (
    '73000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000103',
    'MEMBER',
    'ACTIVE'
  ),
  (
    '73000000-0000-4000-8000-000000000102',
    '71000000-0000-4000-8000-000000000104',
    'OWNER',
    'ACTIVE'
  ),
  (
    '73000000-0000-4000-8000-000000000103',
    '71000000-0000-4000-8000-000000000107',
    'OWNER',
    'ACTIVE'
  );

insert into public.hub_subscriptions (
  id,
  account_id,
  plan_id,
  status,
  billing_cycle,
  trial_starts_at,
  trial_ends_at,
  current_period_starts_at,
  current_period_ends_at,
  provider,
  provider_subscription_id,
  provider_payment_id,
  product_family,
  metadata
)
values
  (
    '74000000-0000-4000-8000-000000000101',
    '73000000-0000-4000-8000-000000000101',
    '72000000-0000-4000-8000-000000000101',
    'ACTIVE',
    'MONTHLY',
    null,
    null,
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() + interval '1 month',
    'ASAAS',
    'sub_security_a',
    'pay_security_a',
    'HUB_CORE',
    '{"test_fixture":true,"billingSecret":"must-not-bootstrap"}'::jsonb
  ),
  (
    '74000000-0000-4000-8000-000000000102',
    '73000000-0000-4000-8000-000000000102',
    '72000000-0000-4000-8000-000000000101',
    'ACTIVE',
    'MONTHLY',
    null,
    null,
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() + interval '1 month',
    'ASAAS',
    'sub_security_b',
    'pay_security_b',
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '74000000-0000-4000-8000-000000000103',
    '73000000-0000-4000-8000-000000000103',
    '72000000-0000-4000-8000-000000000101',
    'TRIALING',
    null,
    pg_catalog.now() - interval '8 days',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() - interval '8 days',
    pg_catalog.now() - interval '1 day',
    null,
    null,
    null,
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
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
values
  (
    '75000000-0000-4000-8000-000000000101',
    '73000000-0000-4000-8000-000000000101',
    '72000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000101',
    'MONTHLY',
    'PIX',
    1,
    'PAID',
    'sub_security_a',
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '75000000-0000-4000-8000-000000000102',
    '73000000-0000-4000-8000-000000000102',
    '72000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000104',
    'MONTHLY',
    'PIX',
    1,
    'PAID',
    'sub_security_b',
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  );

insert into public.hub_conversion_events (
  account_id,
  user_id,
  event_name,
  source,
  metadata
)
values
  (
    '73000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000101',
    'plan_interest',
    'hub_plans',
    '{"planCode":"HUB_SECURITY_FIXTURE","test_fixture":true}'::jsonb
  ),
  (
    '73000000-0000-4000-8000-000000000102',
    '71000000-0000-4000-8000-000000000104',
    'plan_interest',
    'hub_plans',
    '{"planCode":"HUB_SECURITY_FIXTURE","test_fixture":true}'::jsonb
  );

insert into public.hub_educator_learners (
  id,
  account_id,
  created_by,
  display_name,
  level_tag,
  objective,
  interests,
  notes
)
values (
  '77000000-0000-4000-8000-000000000101',
  '73000000-0000-4000-8000-000000000102',
  '71000000-0000-4000-8000-000000000104',
  'Learner privado da conta B',
  'B1',
  'Objetivo privado da conta B',
  array['contexto privado'],
  'Notas privadas da conta B'
);

create temporary table hub_security_results (
  result_key text primary key,
  payload jsonb not null
) on commit drop;

grant select, insert, update, delete
  on table hub_security_results
  to authenticated, service_role;

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.hub_reserve_feature(uuid,text,integer,uuid,text,uuid,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_reserve_feature(uuid,text,integer,uuid,text,uuid,jsonb)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.hub_reserve_feature(uuid,text,integer,uuid,text,uuid,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_consume_feature(text,integer,uuid,uuid,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.expire_hub_trials_internal()',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.hub_enforce_active_subscription_guard()',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.hub_enforce_account_billing_transition_guard()',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.hub_finalize_account_status_change(uuid,text,text[],uuid,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.hub_finalize_account_status_change(uuid,text,text[],uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'private.hub_usage_reservations',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_settings',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'public.hub_accounts',
    'SELECT'
  )
  and pg_catalog.has_column_privilege(
    'authenticated',
    'public.hub_accounts',
    'id',
    'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated',
    'public.hub_accounts',
    'asaas_customer_id',
    'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated',
    'public.hub_accounts',
    'metadata',
    'SELECT'
  ),
  'RPC, settings, account and reservation privileges must follow least privilege'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'hub_subscriptions'
      and policyname = 'hub_subscriptions_select_managers'
      and coalesce(qual, '') like '%hub_is_account_manager%'
  )
  and exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'hub_usage_events'
      and policyname = 'hub_usage_events_select_managers'
      and coalesce(qual, '') like '%hub_is_account_manager%'
  ),
  'sensitive Hub policies must be manager scoped'
);

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000103","role":"authenticated"}',
  true
);

select pg_temp.assert_true(
  (select count(id) = 1 from public.hub_accounts
    where id = '73000000-0000-4000-8000-000000000101')
  and (select count(*) = 0 from public.hub_subscriptions
    where account_id = '73000000-0000-4000-8000-000000000101')
  and (select count(*) = 0 from public.hub_checkout_sessions
    where account_id = '73000000-0000-4000-8000-000000000101')
  and (select count(*) = 0 from public.hub_usage_events
    where account_id = '73000000-0000-4000-8000-000000000101')
  and (select count(*) = 0 from public.hub_conversion_events
    where account_id = '73000000-0000-4000-8000-000000000101'),
  'MEMBER must keep product membership but not see billing, usage or events'
);

insert into hub_security_results(result_key, payload)
values (
  'member_personal_claim',
  public.hub_claim_trial('EDUCATOR', 'Member Educator Trial')
);

select pg_temp.assert_true(
  (select payload ->> 'accountId' <> '73000000-0000-4000-8000-000000000101'
    from hub_security_results where result_key = 'member_personal_claim')
  and (
    select count(*) = 2
    from public.hub_list_accounts()
  )
  and exists (
    select 1
    from public.hub_list_accounts()
    where account_type = 'PERSONAL'
      and audience = 'EDUCATOR'
      and membership_role = 'OWNER'
  )
  and exists (
    select 1
    from public.hub_list_accounts()
    where id = '73000000-0000-4000-8000-000000000101'
      and audience = 'INSTITUTION'
      and membership_role = 'MEMBER'
  )
  and public.hub_bootstrap() -> 'access' ->> 'code' = 'HUB_ACCOUNT_AMBIGUOUS'
  and public.hub_bootstrap(
    (select (payload ->> 'accountId')::uuid
     from hub_security_results where result_key = 'member_personal_claim')
  ) -> 'account' ->> 'account_type' = 'PERSONAL',
  'an organization MEMBER educator trial must remain isolated in an owned PERSONAL account'
);

select public.hub_track_event(
  'hub_trial_activated',
  'hub_onboarding',
  '{"audience":"EDUCATOR"}'::jsonb,
  (select (payload ->> 'accountId')::uuid
   from hub_security_results where result_key = 'member_personal_claim')
);

do $learner_trial_event_must_be_rejected$
begin
  begin
    perform public.hub_track_event(
      'hub_trial_activated',
      'hub_onboarding',
      '{"audience":"LEARNER"}'::jsonb,
      (select (payload ->> 'accountId')::uuid
       from hub_security_results where result_key = 'member_personal_claim')
    );
    raise exception 'learner_hub_trial_event_was_accepted';
  exception
    when invalid_parameter_value then null;
  end;
end;
$learner_trial_event_must_be_rejected$;

do $member_must_not_change_account_audience$
declare
  v_rows integer;
begin
  begin
    update public.hub_accounts
    set audience = 'LEARNER'
    where id = '73000000-0000-4000-8000-000000000101';

    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'member_direct_account_update_was_accepted';
    end if;
  exception
    when insufficient_privilege then null;
  end;
end;
$member_must_not_change_account_audience$;

select pg_temp.assert_true(
  not exists (
    select 1
    from public.hub_accounts
    where id = '73000000-0000-4000-8000-000000000101'
      and audience = 'LEARNER'
  ),
  'MEMBER must not change the account audience directly'
);

select public.hub_track_event(
  'saas_cta_click',
  'hub_portal',
  '{}'::jsonb,
  (select (payload ->> 'accountId')::uuid
   from hub_security_results where result_key = 'member_personal_claim')
);

do $legacy_consume_must_be_denied$
begin
  begin
    perform public.hub_consume_feature(
      'educator_ai.generate',
      1,
      '76000000-0000-4000-8000-000000000199',
      '73000000-0000-4000-8000-000000000101',
      '{}'::jsonb
    );
    raise exception 'authenticated_legacy_consume_was_accepted';
  exception
    when insufficient_privilege then null;
  end;
end;
$legacy_consume_must_be_denied$;

do $tracking_metadata_allowlist$
begin
  begin
    perform public.hub_track_event(
      'saas_cta_click',
      'hub_portal',
      '{"unexpected":"blocked"}'::jsonb,
      (select (payload ->> 'accountId')::uuid
       from hub_security_results where result_key = 'member_personal_claim')
    );
    raise exception 'unexpected_tracking_metadata_was_accepted';
  exception
    when invalid_parameter_value then null;
  end;

  begin
    perform public.hub_track_event(
      'plan_interest',
      'hub_plans',
      pg_catalog.jsonb_build_object(
        'planCode',
        pg_catalog.repeat('X', 2000)
      ),
      (select (payload ->> 'accountId')::uuid
       from hub_security_results where result_key = 'member_personal_claim')
    );
    raise exception 'oversized_tracking_metadata_was_accepted';
  exception
    when invalid_parameter_value then null;
  end;
end;
$tracking_metadata_allowlist$;

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);

select pg_temp.assert_true(
  (select count(*) = 1 from public.hub_subscriptions
    where account_id = '73000000-0000-4000-8000-000000000101')
  and (select count(*) = 0 from public.hub_subscriptions
    where account_id = '73000000-0000-4000-8000-000000000102')
  and (select count(*) = 1 from public.hub_checkout_sessions
    where account_id = '73000000-0000-4000-8000-000000000101')
  and (select count(*) >= 1 from public.hub_conversion_events
    where account_id = '73000000-0000-4000-8000-000000000101'),
  'OWNER must see only their own sensitive account rows'
);

select pg_temp.assert_true(
  public.hub_bootstrap('73000000-0000-4000-8000-000000000101')
    -> 'account' ->> 'asaas_customer_id' is null
  and public.hub_bootstrap('73000000-0000-4000-8000-000000000101')
    -> 'account' -> 'metadata' ->> 'asaasLeak' is null
  and public.hub_bootstrap('73000000-0000-4000-8000-000000000101')
    -> 'subscription' ->> 'provider_subscription_id' is null
  and public.hub_bootstrap('73000000-0000-4000-8000-000000000101')
    -> 'subscription' -> 'metadata' is null,
  'bootstrap must expose an allowlisted account/subscription projection only'
);

select pg_temp.assert_true(
  public.hub_get_public_settings() -> 'metadata'
    = '{"hubEnabled":true,"catalogReady":true}'::jsonb
  and public.hub_get_public_settings()
    -> 'metadata' ->> 'securityTestMarker' is null
  and public.hub_get_public_settings() ->> 'securityTestMarker' is null,
  'public settings RPC must expose only operational metadata flags'
);

reset role;
set local role service_role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

insert into hub_security_results(result_key, payload)
values (
  'member_ambiguous_reserve',
  public.hub_reserve_feature(
    '71000000-0000-4000-8000-000000000103',
    'educator_ai.generate',
    1,
    '76000000-0000-4000-8000-000000000198',
    pg_catalog.repeat('e', 64),
    null,
    '{"source":"pedagogical-content"}'::jsonb
  )
);

select pg_temp.assert_true(
  (select payload ->> 'code' = 'HUB_ACCOUNT_AMBIGUOUS'
   from hub_security_results where result_key = 'member_ambiguous_reserve'),
  'service metering must require accountId when a user has multiple accounts'
);

do $multi_unit_reservation_must_fail$
begin
  begin
    perform public.hub_reserve_feature(
      '71000000-0000-4000-8000-000000000101',
      'educator_ai.generate',
      2,
      '76000000-0000-4000-8000-000000000197',
      pg_catalog.repeat('f', 64),
      '73000000-0000-4000-8000-000000000101',
      '{"source":"pedagogical-content"}'::jsonb
    );
    raise exception 'multi_unit_reservation_was_accepted';
  exception
    when invalid_parameter_value then null;
  end;
end;
$multi_unit_reservation_must_fail$;

insert into hub_security_results(result_key, payload)
values (
  'reserve_first',
  public.hub_reserve_feature(
    '71000000-0000-4000-8000-000000000101',
    'educator_ai.generate',
    1,
    '76000000-0000-4000-8000-000000000101',
    pg_catalog.repeat('a', 64),
    '73000000-0000-4000-8000-000000000101',
    '{"source":"pedagogical-content"}'::jsonb
  )
);

insert into hub_security_results(result_key, payload)
values
  (
    'reserve_inflight_replay',
    public.hub_reserve_feature(
      '71000000-0000-4000-8000-000000000101',
      'educator_ai.generate',
      1,
      '76000000-0000-4000-8000-000000000101',
      pg_catalog.repeat('a', 64),
      '73000000-0000-4000-8000-000000000101',
      '{"source":"pedagogical-content"}'::jsonb
    )
  ),
  (
    'reserve_fingerprint_mismatch',
    public.hub_reserve_feature(
      '71000000-0000-4000-8000-000000000101',
      'educator_ai.generate',
      1,
      '76000000-0000-4000-8000-000000000101',
      pg_catalog.repeat('b', 64),
      '73000000-0000-4000-8000-000000000101',
      '{"source":"pedagogical-content"}'::jsonb
    )
  ),
  (
    'reserve_concurrent_second',
    public.hub_reserve_feature(
      '71000000-0000-4000-8000-000000000101',
      'educator_ai.generate',
      1,
      '76000000-0000-4000-8000-000000000102',
      pg_catalog.repeat('c', 64),
      '73000000-0000-4000-8000-000000000101',
      '{"source":"pedagogical-content"}'::jsonb
    )
  );

select pg_temp.assert_true(
  (select payload ->> 'allowed' = 'true'
    from hub_security_results where result_key = 'reserve_first')
  and (select payload ->> 'code' = 'REQUEST_IN_PROGRESS'
    from hub_security_results where result_key = 'reserve_inflight_replay')
  and (select payload ->> 'code' = 'IDEMPOTENCY_KEY_REUSED'
    from hub_security_results where result_key = 'reserve_fingerprint_mismatch')
  and (select payload ->> 'code' = 'USAGE_LIMIT_REACHED'
    from hub_security_results where result_key = 'reserve_concurrent_second'),
  'replay, fingerprint mismatch and overlapping first reservations must fail closed'
);

insert into hub_security_results(result_key, payload)
select
  'release_failed_generation',
  public.hub_release_feature(
    '71000000-0000-4000-8000-000000000101',
    (payload ->> 'reservationId')::uuid,
    (payload ->> 'leaseToken')::uuid,
    (payload ->> 'requestKey')::uuid,
    'PROVIDER_FAILED'
  )
from hub_security_results
where result_key = 'reserve_first';

select pg_temp.assert_true(
  (select payload ->> 'released' = 'true'
    from hub_security_results where result_key = 'release_failed_generation')
  and not exists (
    select 1
    from public.hub_usage_events
    where request_key = '76000000-0000-4000-8000-000000000101'
  )
  and coalesce((
    select pg_catalog.sum(used_units)
    from public.hub_usage_counters
    where subscription_id = '74000000-0000-4000-8000-000000000101'
      and feature_key = 'educator_ai.generate'
  ), 0) = 0,
  'released provider failures must not consume committed quota'
);

insert into hub_security_results(result_key, payload)
values (
  'reserve_after_release',
  public.hub_reserve_feature(
    '71000000-0000-4000-8000-000000000101',
    'educator_ai.generate',
    1,
    '76000000-0000-4000-8000-000000000102',
    pg_catalog.repeat('c', 64),
    '73000000-0000-4000-8000-000000000101',
    '{"source":"pedagogical-content"}'::jsonb
  )
);

insert into hub_security_results(result_key, payload)
select
  'commit_success',
  public.hub_commit_feature(
    '71000000-0000-4000-8000-000000000101',
    (payload ->> 'reservationId')::uuid,
    (payload ->> 'leaseToken')::uuid,
    (payload ->> 'requestKey')::uuid
  )
from hub_security_results
where result_key = 'reserve_after_release';

insert into hub_security_results(result_key, payload)
values (
  'reserve_committed_replay',
  public.hub_reserve_feature(
    '71000000-0000-4000-8000-000000000101',
    'educator_ai.generate',
    1,
    '76000000-0000-4000-8000-000000000102',
    pg_catalog.repeat('c', 64),
    '73000000-0000-4000-8000-000000000101',
    '{"source":"pedagogical-content"}'::jsonb
  )
);

select pg_temp.assert_true(
  (select payload ->> 'allowed' = 'true'
    from hub_security_results where result_key = 'commit_success')
  and (select payload ->> 'code' = 'REQUEST_ALREADY_COMPLETED'
    from hub_security_results where result_key = 'reserve_committed_replay')
  and (
    select count(*) = 1
    from public.hub_usage_events
    where request_key = '76000000-0000-4000-8000-000000000102'
  )
  and (
    select used_units = 1
    from public.hub_usage_counters
    where subscription_id = '74000000-0000-4000-8000-000000000101'
      and feature_key = 'educator_ai.generate'
  ),
  'commit must be exactly once and a committed replay must not regenerate'
);

reset role;

do $direct_suspension_with_live_billing_must_fail$
begin
  begin
    update public.hub_accounts
    set status = 'SUSPENDED'
    where id = '73000000-0000-4000-8000-000000000101';
    raise exception 'live_billing_account_was_suspended_directly';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm <> 'hub_live_billing_cancellation_required' then
        raise;
      end if;
  end;
end;
$direct_suspension_with_live_billing_must_fail$;

set local role service_role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select public.hub_finalize_account_status_change(
  '73000000-0000-4000-8000-000000000101',
  'SUSPENDED',
  array['sub_security_a']::text[],
  null,
  'SECURITY_TEST'
);
reset role;

select pg_temp.assert_true(
  (select status = 'CANCELLED'
    from public.hub_checkout_sessions
    where id = '75000000-0000-4000-8000-000000000101')
  and (select status = 'CANCELLED'
    from public.hub_subscriptions
    where id = '74000000-0000-4000-8000-000000000101'),
  'status finalization must close local recurrence and provider-backed checkout state'
);

do $suspended_account_activation_must_fail$
begin
  begin
    update public.hub_subscriptions
    set status = 'ACTIVE',
        current_period_ends_at = pg_catalog.now() + interval '1 month'
    where id = '74000000-0000-4000-8000-000000000101';
    raise exception 'suspended_account_subscription_was_extended';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'hub_account_inactive' then
        raise;
      end if;
  end;
end;
$suspended_account_activation_must_fail$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);

do $authenticated_reserve_must_be_denied$
begin
  begin
    perform public.hub_reserve_feature(
      '71000000-0000-4000-8000-000000000101',
      'educator_ai.generate',
      1,
      '76000000-0000-4000-8000-000000000104',
      pg_catalog.repeat('d', 64),
      '73000000-0000-4000-8000-000000000101',
      '{"source":"pedagogical-content"}'::jsonb
    );
    raise exception 'authenticated_service_reservation_was_accepted';
  exception
    when insufficient_privilege then null;
  end;
end;
$authenticated_reserve_must_be_denied$;

select pg_temp.assert_true(
  public.hub_bootstrap('73000000-0000-4000-8000-000000000101')
    -> 'account' ->> 'status' = 'SUSPENDED'
  and public.hub_bootstrap('73000000-0000-4000-8000-000000000101')
    -> 'subscription' = 'null'::jsonb
  and public.hub_bootstrap('73000000-0000-4000-8000-000000000101')
    -> 'entitlements' = '{}'::jsonb
  and (select count(*) = 0 from public.hub_accounts
    where id = '73000000-0000-4000-8000-000000000101'),
  'SUSPENDED account must receive only blocked bootstrap state and no access'
);

do $regular_user_killswitch_must_fail$
begin
  begin
    perform public.hub_set_enabled(false);
    raise exception 'regular_user_changed_hub_killswitch';
  exception
    when insufficient_privilege then null;
  end;
end;
$regular_user_killswitch_must_fail$;

reset role;
update public.profiles
set lifecycle_status = 'suspended'
where id = '71000000-0000-4000-8000-000000000105';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000105","role":"authenticated"}',
  true
);
do $suspended_super_admin_killswitch_must_fail$
begin
  begin
    perform public.hub_set_enabled(false);
    raise exception 'suspended_super_admin_changed_hub_killswitch';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'hub_internal_manager_required' then
        raise;
      end if;
  end;
end;
$suspended_super_admin_killswitch_must_fail$;

reset role;
update public.profiles
set lifecycle_status = 'active'
where id = '71000000-0000-4000-8000-000000000105';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000105","role":"authenticated"}',
  true
);
select public.hub_set_enabled(false);

reset role;

select pg_temp.assert_true(
  (select metadata ->> 'hubEnabled' = 'false'
    and metadata ->> 'securityTestMarker' = 'preserved'
    from public.hub_settings where settings_key = 'default'),
  'kill switch must preserve unrelated settings metadata'
);

set local role service_role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select pg_temp.assert_true(
  public.hub_reserve_feature(
    '71000000-0000-4000-8000-000000000104',
    'educator_ai.generate',
    1,
    '76000000-0000-4000-8000-000000000105',
    pg_catalog.repeat('d', 64),
    '73000000-0000-4000-8000-000000000102',
    '{"source":"pedagogical-content"}'::jsonb
  ) ->> 'code' = 'HUB_DISABLED',
  'kill switch must block service-side feature reservation'
);

reset role;
do $disabled_hub_activation_must_fail$
begin
  begin
    update public.hub_subscriptions
    set current_period_ends_at = current_period_ends_at + interval '1 month'
    where id = '74000000-0000-4000-8000-000000000102';
    raise exception 'disabled_hub_subscription_was_extended';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'hub_disabled' then
        raise;
      end if;
  end;
end;
$disabled_hub_activation_must_fail$;

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000105","role":"authenticated"}',
  true
);
select public.hub_set_enabled(true);

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000106","role":"authenticated"}',
  true
);
do $learner_trial_must_route_to_the_correct_product$
begin
  begin
    perform public.hub_claim_trial('LEARNER', 'Learner Hub Trial Must Fail');
    raise exception 'learner_hub_trial_was_created';
  exception
    when raise_exception then
      if sqlerrm <> 'learner_product_routing_required' then
        raise;
      end if;
  end;
end;
$learner_trial_must_route_to_the_correct_product$;

do $institutional_trial_must_be_sales_assisted$
begin
  begin
    perform public.hub_claim_trial('INSTITUTION', 'Institution Trial Must Fail');
    raise exception 'institutional_trial_was_created';
  exception
    when raise_exception then
      if sqlerrm <> 'institutional_sales_assisted' then
        raise;
      end if;
  end;
end;
$institutional_trial_must_be_sales_assisted$;

select public.hub_claim_trial('EDUCATOR', 'Hub Fresh Owner');

select pg_temp.assert_true(
  exists (
    select 1
    from public.hub_memberships
    where user_id = '71000000-0000-4000-8000-000000000106'
      and membership_role = 'OWNER'
      and status = 'ACTIVE'
  ),
  'first claim may bootstrap a new account only as its OWNER'
);

reset role;

update public.hub_memberships
set status = 'SUSPENDED',
    updated_at = pg_catalog.now()
where user_id = '71000000-0000-4000-8000-000000000106'
  and membership_role = 'OWNER';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000106","role":"authenticated"}',
  true
);
do $suspended_membership_reclaim_must_fail$
begin
  begin
    perform public.hub_claim_trial('EDUCATOR', 'Hub Fresh Owner');
    raise exception 'suspended_membership_was_reactivated';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'hub_membership_inactive' then
        raise;
      end if;
  end;
end;
$suspended_membership_reclaim_must_fail$;

reset role;
select pg_temp.assert_true(
  exists (
    select 1
    from public.hub_memberships
    where user_id = '71000000-0000-4000-8000-000000000106'
      and membership_role = 'OWNER'
      and status = 'SUSPENDED'
  ),
  'a public trial claim must not reactivate a suspended membership'
);

update public.profiles
set lifecycle_status = 'suspended'
where id = '71000000-0000-4000-8000-000000000104';

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);

do $suspended_profile_learner_reads_must_fail$
begin
  begin
    perform pg_catalog.count(*)
    from public.hub_educator_learners;
    raise exception 'suspended_profile_read_learner_table_directly';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.hub_list_educator_learners(
      '73000000-0000-4000-8000-000000000102'
    );
    raise exception 'suspended_profile_listed_learners_through_rpc';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'educator_planner_access_required' then
        raise;
      end if;
  end;

  begin
    perform public.hub_create_educator_learner(
      '73000000-0000-4000-8000-000000000102',
      'Suspended Learner'
    );
    raise exception 'suspended_profile_created_learner_through_rpc';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'educator_planner_access_required' then
        raise;
      end if;
  end;
end;
$suspended_profile_learner_reads_must_fail$;

select pg_temp.assert_true(
  (select count(*) = 0 from public.hub_accounts)
  and (select count(*) = 0 from public.hub_subscriptions)
  and (select count(*) = 0 from public.hub_checkout_sessions)
  and (select count(*) = 0 from public.hub_list_accounts()),
  'a suspended profile must immediately lose Hub account and billing reads'
);

do $suspended_profile_bootstrap_must_fail$
begin
  begin
    perform public.hub_bootstrap('73000000-0000-4000-8000-000000000102');
    raise exception 'suspended_profile_bootstrapped_hub';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'profile_inactive' then
        raise;
      end if;
  end;
end;
$suspended_profile_bootstrap_must_fail$;

do $suspended_profile_learner_write_must_fail$
begin
  begin
    insert into public.hub_educator_learners (
      account_id,
      created_by,
      display_name
    ) values (
      '73000000-0000-4000-8000-000000000102',
      '71000000-0000-4000-8000-000000000104',
      'Learner indevido'
    );
    raise exception 'suspended_profile_created_learner';
  exception
    when insufficient_privilege then null;
  end;
end;
$suspended_profile_learner_write_must_fail$;

reset role;
set local role service_role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select pg_temp.assert_true(
  public.hub_reserve_feature(
    '71000000-0000-4000-8000-000000000104',
    'educator_ai.generate',
    1,
    '76000000-0000-4000-8000-000000000106',
    pg_catalog.repeat('e', 64),
    '73000000-0000-4000-8000-000000000102',
    '{"source":"pedagogical-content"}'::jsonb
  ) ->> 'code' = 'PROFILE_INACTIVE',
  'service-side metering must reject a suspended profile immediately'
);

reset role;

select pg_temp.assert_true(
  private.expire_hub_trials_internal() >= 1,
  'elapsed TRIALING subscriptions must expire'
);

select pg_temp.assert_true(
  (
    select status = 'EXPIRED'
    from public.hub_subscriptions
    where id = '74000000-0000-4000-8000-000000000103'
  )
  and private.expire_hub_trials_internal() = 0,
  'elapsed TRIALING subscriptions must expire idempotently'
);

select pg_temp.assert_true(
  exists (
    select 1
    from cron.job
    where jobname = 'wisewolf-expire-hub-trials'
      and command = 'select private.expire_hub_trials_internal();'
  ),
  'pg_cron must schedule the private Hub trial expiration routine'
);

rollback;
