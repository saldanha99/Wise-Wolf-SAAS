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
  '7a400000-0000-4000-8000-000000000001',
  'hub-member-profile-catalog-fixture',
  'Hub member profile catalog fixture',
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
    'test-fixtures/hub-member-profile/full.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  ),
  (
    'hub-library',
    'test-fixtures/hub-member-profile/preview.pdf',
    '{"mimetype":"application/pdf","test_fixture":true}'::jsonb
  );

insert into public.hub_content_assets (
  content_id, asset_kind, bucket_id, object_path, mime_type
)
values
  (
    '7a400000-0000-4000-8000-000000000001',
    'FULL',
    'hub-library',
    'test-fixtures/hub-member-profile/full.pdf',
    'application/pdf'
  ),
  (
    '7a400000-0000-4000-8000-000000000001',
    'PREVIEW',
    'hub-library',
    'test-fixtures/hub-member-profile/preview.pdf',
    'application/pdf'
  );

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.hub_memberships'::pg_catalog.regclass
      and attribute.attname = 'subject_role'
      and attribute.attnotnull
      and not attribute.attisdropped
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.hub_memberships'::pg_catalog.regclass
      and conname = 'hub_memberships_subject_role_check'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.hub_memberships'::pg_catalog.regclass
      and tgname = 'hub_memberships_enforce_subject_role'
      and not tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.hub_accounts'::pg_catalog.regclass
      and tgname = 'hub_accounts_sync_manager_subject_roles'
      and not tgisinternal
  ),
  'membership subject_role is not server constrained'
);

select pg_temp.assert_true(
  not has_table_privilege(
    'authenticated',
    'public.hub_member_profiles',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_member_profiles',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_member_profiles',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_member_profiles',
    'DELETE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_educator_learners',
    'DELETE'
  )
  and not has_table_privilege(
    'anon',
    'public.hub_member_profiles',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'public.hub_educator_learners',
    'SELECT'
  ),
  'Data API still has direct profile or learner CRUD'
);

select pg_temp.assert_true(
  (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid = 'public.hub_member_profiles'::pg_catalog.regclass
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid = 'public.hub_educator_learners'::pg_catalog.regclass
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'hub_educator_learners'
  ),
  'learner table is not fail-closed behind RLS and zero policies'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.hub_get_member_profile(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.hub_update_member_preferences(uuid,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.hub_set_member_subject_role(uuid,uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.hub_list_educator_learners(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.hub_create_educator_learner(uuid,text,text,text,text[],text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.hub_bootstrap(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_get_member_profile(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_update_member_preferences(uuid,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_list_educator_learners(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.hub_create_educator_learner(uuid,text,text,text,text[],text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_authorize_educator_planner_access(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.hub_authorize_educator_planner_access(uuid,uuid)',
    'EXECUTE'
  ),
  'Hub member RPC grants are broader or narrower than intended'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where (
      namespace.nspname,
      procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid)
    ) in (
      ('public', 'hub_get_member_profile', 'p_account_id uuid'),
      (
        'public',
        'hub_update_member_preferences',
        'p_account_id uuid, p_preferences jsonb'
      ),
      (
        'public',
        'hub_set_member_subject_role',
        'p_account_id uuid, p_member_user_id uuid, p_subject_role text'
      ),
      ('public', 'hub_list_educator_learners', 'p_account_id uuid'),
      (
        'public',
        'hub_create_educator_learner',
        'p_account_id uuid, p_name text, p_level text, p_objective text, p_interests text[], p_notes text'
      ),
      (
        'public',
        'hub_authorize_educator_planner_access',
        'p_user_id uuid, p_account_id uuid'
      ),
      (
        'private',
        'hub_user_has_educator_planner_access',
        'p_account_id uuid, p_user_id uuid'
      ),
      (
        'private',
        'hub_has_educator_planner_access',
        'p_account_id uuid'
      ),
      ('private', 'hub_seed_member_profile', '')
    )
      and (
        not procedure.prosecdef
        or not (
          procedure.proconfig @> array['search_path=""']::text[]
        )
      )
  ),
  'a privileged Hub RPC is not SECURITY DEFINER with empty search_path'
);

update public.hub_settings
set metadata = coalesce(metadata, '{}'::jsonb) || '{"hubEnabled":true}'::jsonb
where settings_key = 'default';

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
    '79191000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'hub-191-owner-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Owner Account A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79191000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'hub-191-learner-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learner Member A"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79191000-0000-4000-8000-000000000103',
    'authenticated',
    'authenticated',
    'hub-191-educator-a1@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Educator Member A One"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79191000-0000-4000-8000-000000000104',
    'authenticated',
    'authenticated',
    'hub-191-educator-a2@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Educator Member A Two"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79191000-0000-4000-8000-000000000105',
    'authenticated',
    'authenticated',
    'hub-191-owner-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Owner Account B"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79191000-0000-4000-8000-000000000106',
    'authenticated',
    'authenticated',
    'hub-191-educator-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Educator Member B"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79191000-0000-4000-8000-000000000107',
    'authenticated',
    'authenticated',
    'hub-191-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Admin Account A"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
set tenant_id = null,
    lifecycle_status = 'active',
    role = 'NON_STUDENT'
where id in (
  '79191000-0000-4000-8000-000000000101',
  '79191000-0000-4000-8000-000000000102',
  '79191000-0000-4000-8000-000000000103',
  '79191000-0000-4000-8000-000000000104',
  '79191000-0000-4000-8000-000000000105',
  '79191000-0000-4000-8000-000000000106',
  '79191000-0000-4000-8000-000000000107'
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
  '79191000-0000-4000-8000-000000000201',
  'HUB_MEMBER_SECURITY_191000',
  'Hub Member Security 191000',
  'Isolated test plan.',
  'ALL',
  1,
  10,
  'BRL',
  0,
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
  '79191000-0000-4000-8000-000000000201',
  'educator_ai.generate',
  100,
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
    '79191000-0000-4000-8000-000000000301',
    'ORGANIZATION',
    'INSTITUTION',
    'Hub Security Account A',
    '79191000-0000-4000-8000-000000000101',
    'ACTIVE',
    '{
      "test_fixture":true,
      "goal":"shared bootstrap leak",
      "role":"shared account role",
      "interests":"shared account interests",
      "preferred_modality":"voice"
    }'::jsonb
  ),
  (
    '79191000-0000-4000-8000-000000000302',
    'ORGANIZATION',
    'INSTITUTION',
    'Hub Security Account B',
    '79191000-0000-4000-8000-000000000105',
    'ACTIVE',
    '{"test_fixture":true}'::jsonb
  );

insert into public.hub_memberships (
  account_id,
  user_id,
  membership_role,
  subject_role,
  status
)
values
  (
    '79191000-0000-4000-8000-000000000301',
    '79191000-0000-4000-8000-000000000101',
    'OWNER',
    'LEARNER',
    'ACTIVE'
  ),
  (
    '79191000-0000-4000-8000-000000000301',
    '79191000-0000-4000-8000-000000000102',
    'MEMBER',
    'LEARNER',
    'ACTIVE'
  ),
  (
    '79191000-0000-4000-8000-000000000301',
    '79191000-0000-4000-8000-000000000103',
    'MEMBER',
    'EDUCATOR',
    'ACTIVE'
  ),
  (
    '79191000-0000-4000-8000-000000000301',
    '79191000-0000-4000-8000-000000000104',
    'MEMBER',
    'EDUCATOR',
    'ACTIVE'
  ),
  (
    '79191000-0000-4000-8000-000000000302',
    '79191000-0000-4000-8000-000000000105',
    'OWNER',
    'LEARNER',
    'ACTIVE'
  ),
  (
    '79191000-0000-4000-8000-000000000302',
    '79191000-0000-4000-8000-000000000106',
    'MEMBER',
    'EDUCATOR',
    'ACTIVE'
  ),
  (
    '79191000-0000-4000-8000-000000000301',
    '79191000-0000-4000-8000-000000000107',
    'ADMIN',
    'LEARNER',
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
  provider,
  provider_subscription_id,
  product_family,
  metadata
)
values
  (
    '79191000-0000-4000-8000-000000000401',
    '79191000-0000-4000-8000-000000000301',
    '79191000-0000-4000-8000-000000000201',
    'ACTIVE',
    'MONTHLY',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() + interval '30 days',
    'TEST',
    'hub-191-subscription-a',
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '79191000-0000-4000-8000-000000000402',
    '79191000-0000-4000-8000-000000000302',
    '79191000-0000-4000-8000-000000000201',
    'ACTIVE',
    'MONTHLY',
    pg_catalog.now() - interval '1 day',
    pg_catalog.now() + interval '30 days',
    'TEST',
    'hub-191-subscription-b',
    'HUB_CORE',
    '{"test_fixture":true}'::jsonb
  );

select pg_temp.assert_true(
  (
    select subject_role = 'EDUCATOR'
    from public.hub_memberships
    where account_id = '79191000-0000-4000-8000-000000000301'
      and user_id = '79191000-0000-4000-8000-000000000101'
  )
  and (
    select subject_role = 'EDUCATOR'
    from public.hub_memberships
    where account_id = '79191000-0000-4000-8000-000000000301'
      and user_id = '79191000-0000-4000-8000-000000000107'
  )
  and (
    select subject_role = 'LEARNER'
    from public.hub_memberships
    where account_id = '79191000-0000-4000-8000-000000000301'
      and user_id = '79191000-0000-4000-8000-000000000102'
  ),
  'manager effective role or MEMBER fail-closed default is wrong'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 7
    from public.hub_member_profiles
    where account_id in (
      '79191000-0000-4000-8000-000000000301',
      '79191000-0000-4000-8000-000000000302'
    )
  ),
  'membership trigger did not create one isolated profile per membership'
);

create temporary table hub_member_security_results (
  result_key text primary key,
  payload jsonb not null
) on commit drop;

grant select, insert, update, delete
  on table hub_member_security_results
  to authenticated, service_role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

insert into hub_member_security_results (result_key, payload)
values
  (
    'authorize_owner_a',
    public.hub_authorize_educator_planner_access(
      '79191000-0000-4000-8000-000000000101',
      '79191000-0000-4000-8000-000000000301'
    )
  ),
  (
    'authorize_admin_a',
    public.hub_authorize_educator_planner_access(
      '79191000-0000-4000-8000-000000000107',
      '79191000-0000-4000-8000-000000000301'
    )
  ),
  (
    'authorize_learner_a',
    public.hub_authorize_educator_planner_access(
      '79191000-0000-4000-8000-000000000102',
      '79191000-0000-4000-8000-000000000301'
    )
  ),
  (
    'authorize_educator_a_cross_b',
    public.hub_authorize_educator_planner_access(
      '79191000-0000-4000-8000-000000000103',
      '79191000-0000-4000-8000-000000000302'
    )
  );

select pg_temp.assert_true(
  (
    select payload->>'allowed' = 'true'
      and payload->>'subjectRole' = 'EDUCATOR'
    from hub_member_security_results
    where result_key = 'authorize_owner_a'
  )
  and (
    select payload->>'allowed' = 'true'
      and payload->>'subjectRole' = 'EDUCATOR'
    from hub_member_security_results
    where result_key = 'authorize_admin_a'
  )
  and (
    select payload->>'allowed' = 'false'
      and payload->>'code' = 'EDUCATOR_ROLE_REQUIRED'
      and payload->>'subjectRole' = 'LEARNER'
    from hub_member_security_results
    where result_key = 'authorize_learner_a'
  )
  and (
    select payload->>'allowed' = 'false'
    from hub_member_security_results
    where result_key = 'authorize_educator_a_cross_b'
  ),
  'Planner authorization ignored subject role or account boundary'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000102","role":"authenticated"}';

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )
  $statement$,
  '42501',
  'LEARNER MEMBER listed Planner learners'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_create_educator_learner(
      '79191000-0000-4000-8000-000000000301',
      'Blocked Learner'
    )
  $statement$,
  '42501',
  'LEARNER MEMBER created a Planner learner'
);

select pg_temp.assert_true(
  not private.hub_has_educator_planner_access(
    '79191000-0000-4000-8000-000000000301'
  ),
  'LEARNER MEMBER passed the current-user Planner helper'
);

with response as materialized (
  select public.hub_bootstrap(
    '79191000-0000-4000-8000-000000000301'
  ) as payload
)
select pg_temp.assert_true(
  (
    select payload->'account'->>'id'
        = '79191000-0000-4000-8000-000000000301'
      and payload#>'{account,metadata}' = '{}'::jsonb
      and payload ?& array[
        'account',
        'membership',
        'isManager',
        'entitlements',
        'settings'
      ]
      and payload::text not like '%shared bootstrap leak%'
      and payload::text not like '%shared account role%'
      and payload::text not like '%shared account interests%'
    from response
  ),
  'public bootstrap leaked shared personalization or changed its contract'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000103","role":"authenticated"}';

insert into hub_member_security_results (result_key, payload)
values (
  'create_educator_a1',
  public.hub_create_educator_learner(
    '79191000-0000-4000-8000-000000000301',
    E'  Ana\nPrópria  ',
    ' b2 ',
    'Conversação profissional',
    array['negócios', 'viagens'],
    'Contexto próprio'
  )
);

select pg_temp.assert_true(
  pg_catalog.jsonb_array_length(
    public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )
  ) = 1
  and (
    public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )->0->>'display_name'
  ) = 'Ana Própria',
  'educator MEMBER did not receive own-only learner list'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000302'
    )
  $statement$,
  '42501',
  'educator MEMBER crossed into another Hub account'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_create_educator_learner(
      '79191000-0000-4000-8000-000000000301',
      'X'
    )
  $statement$,
  '22023',
  'one-character learner name was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_create_educator_learner(
      '79191000-0000-4000-8000-000000000301',
      'Invalid Level',
      'Z9'
    )
  $statement$,
  '22023',
  'invalid CEFR learner level was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_create_educator_learner(
      '79191000-0000-4000-8000-000000000301',
      'Oversized Objective',
      'B1',
      pg_catalog.repeat('x', 801)
    )
  $statement$,
  '22023',
  'oversized learner objective was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_create_educator_learner(
      '79191000-0000-4000-8000-000000000301',
      'Oversized Notes',
      'B1',
      null,
      '{}'::text[],
      pg_catalog.repeat('x', 1201)
    )
  $statement$,
  '22023',
  'oversized learner notes were accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_create_educator_learner(
      '79191000-0000-4000-8000-000000000301',
      'Too Many Interests',
      'B1',
      null,
      array[
        '1','2','3','4','5','6','7','8','9','10','11','12','13'
      ]
    )
  $statement$,
  '22023',
  'learner interests cardinality was not bounded'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_create_educator_learner(
      '79191000-0000-4000-8000-000000000301',
      'Long Interest',
      'B1',
      null,
      array[pg_catalog.repeat('x', 81)]
    )
  $statement$,
  '22023',
  'learner interest item length was not bounded'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000104","role":"authenticated"}';

insert into hub_member_security_results (result_key, payload)
values (
  'create_educator_a2',
  public.hub_create_educator_learner(
    '79191000-0000-4000-8000-000000000301',
    'Bruno Isolado',
    'A2'
  )
);

select pg_temp.assert_true(
  pg_catalog.jsonb_array_length(
    public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )
  ) = 1
  and (
    public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )->0->>'display_name'
  ) = 'Bruno Isolado',
  'second educator MEMBER received another creator learner'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000106","role":"authenticated"}';

insert into hub_member_security_results (result_key, payload)
values (
  'create_educator_b',
  public.hub_create_educator_learner(
    '79191000-0000-4000-8000-000000000302',
    'Learner Account B',
    'C1'
  )
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000101","role":"authenticated"}';

select pg_temp.assert_true(
  pg_catalog.jsonb_array_length(
    public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )
  ) = 2
  and not (
    public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )::text like '%Learner Account B%'
  ),
  'manager lost account-wide access or crossed into another account'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_set_member_subject_role(
      '79191000-0000-4000-8000-000000000301',
      '79191000-0000-4000-8000-000000000101',
      'LEARNER'
    )
  $statement$,
  '42501',
  'manager-only role RPC changed OWNER functional role'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_set_member_subject_role(
      '79191000-0000-4000-8000-000000000301',
      '79191000-0000-4000-8000-000000000106',
      'LEARNER'
    )
  $statement$,
  '42501',
  'manager-only role RPC changed another account membership'
);

insert into hub_member_security_results (result_key, payload)
values (
  'promote_learner_a',
  public.hub_set_member_subject_role(
    '79191000-0000-4000-8000-000000000301',
    '79191000-0000-4000-8000-000000000102',
    'EDUCATOR'
  )
);

select pg_temp.assert_true(
  (
    select payload->>'subjectRole' = 'EDUCATOR'
      and payload ?& array['accountId', 'userId', 'subjectRole', 'updatedAt']
      and (
        select pg_catalog.count(*) = 4
        from pg_catalog.jsonb_object_keys(payload)
      )
    from hub_member_security_results
    where result_key = 'promote_learner_a'
  ),
  'manager role RPC returned excessive data or failed to promote MEMBER'
);

select pg_temp.assert_sqlstate(
  $statement$
    update public.hub_memberships
    set subject_role = 'LEARNER'
    where account_id = '79191000-0000-4000-8000-000000000301'
      and user_id = '79191000-0000-4000-8000-000000000103'
  $statement$,
  '42501',
  'manager bypassed role RPC through direct membership UPDATE'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000102","role":"authenticated"}';

insert into hub_member_security_results (result_key, payload)
values (
  'create_promoted_member',
  public.hub_create_educator_learner(
    '79191000-0000-4000-8000-000000000301',
    'Carla Promovida',
    'B1'
  )
);

select pg_temp.assert_true(
  pg_catalog.jsonb_array_length(
    public.hub_list_educator_learners(
      '79191000-0000-4000-8000-000000000301'
    )
  ) = 1,
  'promoted MEMBER did not retain own-only learner scope'
);

with response as materialized (
  select public.hub_update_member_preferences(
    '79191000-0000-4000-8000-000000000301',
    '{
      "display_name":"Private Learner Profile",
      "level":"a2",
      "role":"Student",
      "goal":"Learner private goal",
      "interests":"Learner private interests",
      "preferred_modality":"VOICE"
    }'::jsonb
  ) as payload
)
select pg_temp.assert_true(
  (
    select payload ?& array['accountId', 'updatedAt']
      and (
        select pg_catalog.count(*) = 2
        from pg_catalog.jsonb_object_keys(payload)
      )
    from response
  ),
  'member preference update returned more than accountId and updatedAt'
);

with response as materialized (
  select public.hub_get_member_profile(
    '79191000-0000-4000-8000-000000000301'
  ) as payload
)
select pg_temp.assert_true(
  (
    select payload->>'displayName' = 'Private Learner Profile'
      and payload->>'subjectRole' = 'EDUCATOR'
      and payload->>'onboarding_completed' = 'true'
      and payload->>'level' = 'A2'
      and payload->>'goal' = 'Learner private goal'
      and payload->>'preferred_modality' = 'voice'
      and payload ?& array[
        'accountId',
        'displayName',
        'subjectRole',
        'onboarding_completed',
        'level',
        'role',
        'goal',
        'interests',
        'preferred_modality',
        'personalized_at'
      ]
      and (
        select pg_catalog.count(*) = 10
        from pg_catalog.jsonb_object_keys(payload)
      )
    from response
  ),
  'own member profile was not normalized or returned excessive data'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_get_member_profile(
      '79191000-0000-4000-8000-000000000302'
    )
  $statement$,
  '42501',
  'member read a profile through another account id'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_member_preferences(
      '79191000-0000-4000-8000-000000000301',
      '{"unknown":"secret"}'::jsonb
    )
  $statement$,
  '22023',
  'unknown member preference key was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_member_preferences(
      '79191000-0000-4000-8000-000000000301',
      '{"role":{"nested":true}}'::jsonb
    )
  $statement$,
  '22023',
  'nested member preference value was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_member_preferences(
      '79191000-0000-4000-8000-000000000301',
      pg_catalog.jsonb_build_object('goal', pg_catalog.repeat('x', 321))
    )
  $statement$,
  '22023',
  'oversized member preference value was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_member_preferences(
      '79191000-0000-4000-8000-000000000301',
      '{"level":"Z9"}'::jsonb
    )
  $statement$,
  '22023',
  'invalid member CEFR level was accepted'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000103","role":"authenticated"}';

select public.hub_update_member_preferences(
  '79191000-0000-4000-8000-000000000301',
  '{
    "display_name":"Private Educator Profile",
    "goal":"Educator private secret"
  }'::jsonb
);

select pg_temp.assert_true(
  public.hub_get_member_profile(
    '79191000-0000-4000-8000-000000000301'
  )->>'goal' = 'Educator private secret',
  'second member profile did not remain isolated'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79191000-0000-4000-8000-000000000101","role":"authenticated"}';

select pg_temp.assert_true(
  public.hub_get_member_profile(
    '79191000-0000-4000-8000-000000000301'
  )->>'displayName' = 'Owner Account A'
  and not (
    public.hub_get_member_profile(
      '79191000-0000-4000-8000-000000000301'
    )::text like '%private secret%'
  )
  and not (
    public.hub_get_member_profile(
      '79191000-0000-4000-8000-000000000301'
    )::text like '%private goal%'
  ),
  'manager received another member private profile data'
);

select pg_temp.assert_sqlstate(
  $statement$
    select * from public.hub_member_profiles
  $statement$,
  '42501',
  'manager bypassed own-profile RPC through direct table SELECT'
);

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_learners (
      account_id,
      created_by,
      display_name
    ) values (
      '79191000-0000-4000-8000-000000000301',
      '79191000-0000-4000-8000-000000000101',
      'Direct Bypass'
    )
  $statement$,
  '42501',
  'manager bypassed learner create RPC through direct table INSERT'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.hub_educator_learners (
      account_id,
      created_by,
      display_name,
      interests
    ) values (
      '79191000-0000-4000-8000-000000000301',
      '79191000-0000-4000-8000-000000000101',
      'X',
      '{}'::text[]
    )
  $statement$,
  '23514',
  'service-role direct write bypassed learner table constraints'
);

reset role;

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 3
      and pg_catalog.bool_and(
        created_by in (
          '79191000-0000-4000-8000-000000000102',
          '79191000-0000-4000-8000-000000000103',
          '79191000-0000-4000-8000-000000000104'
        )
      )
    from public.hub_educator_learners
    where account_id = '79191000-0000-4000-8000-000000000301'
  )
  and (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(
        created_by = '79191000-0000-4000-8000-000000000106'
      )
    from public.hub_educator_learners
    where account_id = '79191000-0000-4000-8000-000000000302'
  ),
  'server-derived learner ownership or cross-account storage is wrong'
);

insert into public.hub_accounts (
  id,
  account_type,
  audience,
  name,
  owner_user_id,
  status,
  metadata
) values (
  '79191000-0000-4000-8000-000000000303',
  'PERSONAL',
  'LEARNER',
  'Hub Learner Owner Account',
  '79191000-0000-4000-8000-000000000105',
  'ACTIVE',
  '{"test_fixture":true}'::jsonb
);

insert into public.hub_memberships (
  account_id,
  user_id,
  membership_role,
  subject_role,
  status
) values (
  '79191000-0000-4000-8000-000000000303',
  '79191000-0000-4000-8000-000000000105',
  'OWNER',
  'EDUCATOR',
  'ACTIVE'
);

select pg_temp.assert_true(
  (
    select subject_role = 'LEARNER'
    from public.hub_memberships
    where account_id = '79191000-0000-4000-8000-000000000303'
      and user_id = '79191000-0000-4000-8000-000000000105'
  ),
  'a LEARNER account OWNER was promoted to educator'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  public.hub_authorize_educator_planner_access(
    '79191000-0000-4000-8000-000000000105',
    '79191000-0000-4000-8000-000000000303'
  )->>'code' = 'EDUCATOR_ROLE_REQUIRED',
  'a LEARNER account OWNER received educator Planner authorization'
);

reset role;

update public.hub_accounts
set audience = 'EDUCATOR'
where id = '79191000-0000-4000-8000-000000000303';

select pg_temp.assert_true(
  (
    select subject_role = 'EDUCATOR'
    from public.hub_memberships
    where account_id = '79191000-0000-4000-8000-000000000303'
      and user_id = '79191000-0000-4000-8000-000000000105'
  ),
  'manager persona did not follow a trusted account audience change'
);

update public.hub_accounts
set audience = 'LEARNER'
where id = '79191000-0000-4000-8000-000000000303';

select pg_temp.assert_true(
  (
    select subject_role = 'LEARNER'
    from public.hub_memberships
    where account_id = '79191000-0000-4000-8000-000000000303'
      and user_id = '79191000-0000-4000-8000-000000000105'
  ),
  'manager persona did not return to LEARNER with account audience'
);

rollback;
