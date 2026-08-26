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
  not has_table_privilege(
    'authenticated',
    'public.hub_accounts',
    'UPDATE'
  )
  and not has_column_privilege(
    'authenticated',
    'public.hub_accounts',
    'name',
    'UPDATE'
  )
  and not has_column_privilege(
    'authenticated',
    'public.hub_accounts',
    'audience',
    'UPDATE'
  )
  and not has_column_privilege(
    'authenticated',
    'public.hub_accounts',
    'metadata',
    'UPDATE'
  )
  and not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'hub_accounts'
      and cmd = 'UPDATE'
      and roles @> array['authenticated'::name]
  ),
  'authenticated still has a direct Hub account mutation path'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 3
      and pg_catalog.bool_and(procedure.prosecdef)
      and pg_catalog.bool_and(
        procedure.proconfig @> array['search_path=""']::text[]
      )
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where (
      namespace.nspname,
      procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid)
    ) in (
      (
        'private',
        'hub_update_preferences_internal',
        'p_account_id uuid, p_preferences jsonb'
      ),
      (
        'public',
        'hub_update_preferences',
        'p_account_id uuid, p_preferences jsonb'
      ),
      (
        'public',
        'hub_rename_account',
        'p_account_id uuid, p_name text'
      )
    )
  ),
  'Hub mutation RPCs are not SECURITY DEFINER with an empty search_path'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.hub_update_preferences(uuid,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.hub_rename_account(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.hub_update_preferences_internal(uuid,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_update_preferences(uuid,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_rename_account(uuid,text)',
    'EXECUTE'
  ),
  'Hub mutation RPC grants are broader than the public authenticated wrappers'
);

update public.hub_settings
set metadata = coalesce(metadata, '{}'::jsonb)
      || '{"hubEnabled":true}'::jsonb
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
    '79000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'hub-mutation-owner@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Mutation Owner"}',
    pg_catalog.now(),
    pg_catalog.now()
  ),
  (
    '79000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'hub-mutation-member@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Mutation Member"}',
    pg_catalog.now(),
    pg_catalog.now()
  );

select pg_catalog.set_config('app.enrollment_claim', '1', true);
update public.profiles
set tenant_id = null,
    lifecycle_status = 'active',
    role = 'NON_STUDENT'
where id in (
  '79000000-0000-4000-8000-000000000101',
  '79000000-0000-4000-8000-000000000102'
);
select pg_catalog.set_config('app.enrollment_claim', '', true);

insert into public.hub_accounts (
  id,
  account_type,
  audience,
  name,
  owner_user_id,
  status,
  asaas_customer_id,
  metadata
)
values (
  '79000000-0000-4000-8000-000000000201',
  'ORGANIZATION',
  'EDUCATOR',
  'Original Hub Account',
  '79000000-0000-4000-8000-000000000101',
  'ACTIVE',
  'cus_must_not_return',
  '{"existing_private_marker":"preserved"}'::jsonb
);

insert into public.hub_memberships (
  account_id,
  user_id,
  membership_role,
  status
)
values
  (
    '79000000-0000-4000-8000-000000000201',
    '79000000-0000-4000-8000-000000000101',
    'OWNER',
    'ACTIVE'
  ),
  (
    '79000000-0000-4000-8000-000000000201',
    '79000000-0000-4000-8000-000000000102',
    'MEMBER',
    'ACTIVE'
  );

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79000000-0000-4000-8000-000000000101","role":"authenticated"}';

with response as materialized (
  select public.hub_update_preferences(
    '79000000-0000-4000-8000-000000000201',
    '{
      "level":" b2 ",
      "role":"  English teacher  ",
      "goal":"  Build premium lessons  ",
      "interests":"  business English  ",
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
  'preference RPC returned more than accountId and updatedAt'
);

select public.hub_update_preferences(
  '79000000-0000-4000-8000-000000000201',
  '{"goal":"Updated goal only"}'::jsonb
);

select pg_temp.assert_sqlstate(
  $statement$
    update public.hub_accounts
    set audience = 'INSTITUTION'
    where id = '79000000-0000-4000-8000-000000000201'
  $statement$,
  '42501',
  'manager bypassed the RPC and changed account audience directly'
);

select pg_temp.assert_sqlstate(
  $statement$
    select private.hub_update_preferences_internal(
      '79000000-0000-4000-8000-000000000201',
      '{"goal":"private bypass"}'::jsonb
    )
  $statement$,
  '42501',
  'authenticated manager invoked the private mutation helper directly'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_preferences(
      '79000000-0000-4000-8000-000000000201',
      '{"level":"B2","billingSecret":"forbidden"}'::jsonb
    )
  $statement$,
  '22023',
  'unsupported preference key was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_preferences(
      '79000000-0000-4000-8000-000000000201',
      pg_catalog.jsonb_build_object('goal', pg_catalog.repeat('x', 321))
    )
  $statement$,
  '22023',
  'oversized preference value was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_preferences(
      '79000000-0000-4000-8000-000000000201',
      '{"role":{"nested":true}}'::jsonb
    )
  $statement$,
  '22023',
  'non-string preference value was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_preferences(
      '79000000-0000-4000-8000-000000000201',
      '{"preferred_modality":"telepathy"}'::jsonb
    )
  $statement$,
  '22023',
  'unsupported preference modality was accepted'
);

with response as materialized (
  select public.hub_rename_account(
    '79000000-0000-4000-8000-000000000201',
    E'  Premium\nSchool   Account  '
  ) as payload
)
select pg_temp.assert_true(
  (
    select payload->>'name' = 'Premium School Account'
      and payload ?& array['accountId', 'name', 'updatedAt']
      and (
        select pg_catalog.count(*) = 3
        from pg_catalog.jsonb_object_keys(payload)
      )
    from response
  ),
  'rename RPC did not normalize the name or returned internal account fields'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_rename_account(
      '79000000-0000-4000-8000-000000000201',
      pg_catalog.repeat('x', 121)
    )
  $statement$,
  '22023',
  'oversized account name was accepted'
);

reset role;

select pg_temp.assert_true(
  (
    select audience = 'EDUCATOR'
      and name = 'Premium School Account'
      and metadata->>'existing_private_marker' = 'preserved'
      and metadata->>'level' = 'B2'
      and metadata->>'role' = 'English teacher'
      and metadata->>'goal' = 'Updated goal only'
      and metadata->>'interests' = 'business English'
      and metadata->>'preferred_modality' = 'voice'
      and metadata->>'onboarding_completed' = 'true'
      and not (metadata ? 'billingSecret')
    from public.hub_accounts
    where id = '79000000-0000-4000-8000-000000000201'
  ),
  'allowlisted mutation changed protected fields or lost existing metadata'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"79000000-0000-4000-8000-000000000102","role":"authenticated"}';

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_update_preferences(
      '79000000-0000-4000-8000-000000000201',
      '{"goal":"member bypass"}'::jsonb
    )
  $statement$,
  '42501',
  'non-manager member updated account preferences'
);

select pg_temp.assert_sqlstate(
  $statement$
    select public.hub_rename_account(
      '79000000-0000-4000-8000-000000000201',
      'Member Rename'
    )
  $statement$,
  '42501',
  'non-manager member renamed the account'
);

rollback;
