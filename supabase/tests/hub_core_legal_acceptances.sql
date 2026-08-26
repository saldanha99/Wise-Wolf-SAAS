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

select pg_temp.assert_true(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.hub_core_legal_acceptances'::regclass
  )
  and has_table_privilege(
    'authenticated',
    'public.hub_core_legal_acceptances',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_core_legal_acceptances',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_core_legal_acceptances',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.hub_core_legal_acceptances',
    'DELETE'
  )
  and has_table_privilege(
    'service_role',
    'public.hub_core_legal_acceptances',
    'INSERT'
  )
  and not has_table_privilege(
    'anon',
    'public.hub_core_legal_acceptances',
    'SELECT'
  ),
  'legal acceptance grants or RLS are broader than intended'
);

select pg_temp.assert_true(
  (
    select constraint_record.confdeltype = 'r'
    from pg_catalog.pg_constraint as constraint_record
    where constraint_record.conrelid =
      'public.hub_core_legal_acceptances'::regclass
      and constraint_record.conname =
        'hub_core_legal_acceptances_account_id_fkey'
  )
  and (
    select constraint_record.confdeltype = 'r'
    from pg_catalog.pg_constraint as constraint_record
    where constraint_record.conrelid =
      'public.hub_core_legal_acceptances'::regclass
      and constraint_record.conname =
        'hub_core_legal_acceptances_user_id_fkey'
  ),
  'legal evidence can be cascade-deleted with its account or user'
);

select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.hub_catalog_checkout_is_ready()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.hub_catalog_checkout_is_ready()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.hub_catalog_checkout_is_ready()',
    'EXECUTE'
  )
  and (
    select procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'hub_catalog_checkout_is_ready'
      and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
  ),
  'catalog checkout guard is callable outside service role or is not hardened'
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
    '7a000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'hub-legal-owner-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Legal Owner A"}',
    now(),
    now()
  ),
  (
    '7a000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'hub-legal-owner-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Hub Legal Owner B"}',
    now(),
    now()
  );

insert into public.hub_accounts (
  id,
  account_type,
  audience,
  name,
  owner_user_id,
  status
)
values
  (
    '7a000000-0000-4000-8000-000000000201',
    'PERSONAL',
    'EDUCATOR',
    'Hub Legal Account A',
    '7a000000-0000-4000-8000-000000000101',
    'ACTIVE'
  ),
  (
    '7a000000-0000-4000-8000-000000000202',
    'PERSONAL',
    'EDUCATOR',
    'Hub Legal Account B',
    '7a000000-0000-4000-8000-000000000102',
    'ACTIVE'
  );

insert into public.hub_memberships (
  account_id,
  user_id,
  membership_role,
  status
)
values
  (
    '7a000000-0000-4000-8000-000000000201',
    '7a000000-0000-4000-8000-000000000101',
    'OWNER',
    'ACTIVE'
  ),
  (
    '7a000000-0000-4000-8000-000000000202',
    '7a000000-0000-4000-8000-000000000102',
    'OWNER',
    'ACTIVE'
  );

do $test$
begin
  begin
    insert into public.hub_core_legal_acceptances (
      account_id,
      user_id,
      terms_version,
      terms_snapshot,
      terms_sha256,
      privacy_version,
      privacy_snapshot,
      privacy_sha256,
      request_key
    ) values (
      '7a000000-0000-4000-8000-000000000201',
      '7a000000-0000-4000-8000-000000000101',
      '2026-08-24',
      repeat('Hub Core terms immutable fixture. ', 20),
      repeat('0', 64),
      '2026-08-24',
      repeat('Hub Core privacy immutable fixture. ', 20),
      repeat('0', 64),
      '7a000000-0000-4000-8000-000000000399'
    );
    raise exception 'snapshot with a forged digest was accepted';
  exception
    when check_violation then
      null;
  end;
end;
$test$;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

insert into public.hub_core_legal_acceptances (
  account_id,
  user_id,
  terms_version,
  terms_snapshot,
  terms_sha256,
  privacy_version,
  privacy_snapshot,
  privacy_sha256,
  source,
  request_key
)
values
  (
    '7a000000-0000-4000-8000-000000000201',
    '7a000000-0000-4000-8000-000000000101',
    '2026-08-24',
    repeat('Hub Core terms immutable fixture. ', 20),
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          repeat('Hub Core terms immutable fixture. ', 20),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    '2026-08-24',
    repeat('Hub Core privacy immutable fixture. ', 20),
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          repeat('Hub Core privacy immutable fixture. ', 20),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    'HUB_CORE_CHECKOUT',
    '7a000000-0000-4000-8000-000000000301'
  ),
  (
    '7a000000-0000-4000-8000-000000000202',
    '7a000000-0000-4000-8000-000000000102',
    '2026-08-24',
    repeat('Hub Core terms immutable fixture. ', 20),
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          repeat('Hub Core terms immutable fixture. ', 20),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    '2026-08-24',
    repeat('Hub Core privacy immutable fixture. ', 20),
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          repeat('Hub Core privacy immutable fixture. ', 20),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ),
    'HUB_CORE_CHECKOUT',
    '7a000000-0000-4000-8000-000000000302'
  );

reset role;
set local request.jwt.claims = '{}';

do $test$
begin
  begin
    update public.hub_core_legal_acceptances
    set terms_snapshot = terms_snapshot || 'mutated'
    where id = (
      select acceptance.id
      from public.hub_core_legal_acceptances as acceptance
      limit 1
    );
    raise exception 'legal snapshot was mutated';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'hub_core_legal_acceptance_immutable' then
        raise;
      end if;
  end;

  begin
    delete from public.hub_core_legal_acceptances
    where id = (
      select acceptance.id
      from public.hub_core_legal_acceptances as acceptance
      limit 1
    );
    raise exception 'legal acceptance evidence was deleted';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'hub_core_legal_acceptance_immutable' then
        raise;
      end if;
  end;

  begin
    delete from public.hub_accounts
    where id = '7a000000-0000-4000-8000-000000000201';
    raise exception 'accepted Hub account was hard-deleted';
  exception
    when foreign_key_violation then
      null;
  end;

  begin
    delete from auth.users
    where id = '7a000000-0000-4000-8000-000000000101';
    raise exception 'accepting Hub user was hard-deleted';
  exception
    when foreign_key_violation then
      null;
  end;
end;
$test$;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"7a000000-0000-4000-8000-000000000101","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.hub_core_legal_acceptances
    where account_id = '7a000000-0000-4000-8000-000000000201'
      and user_id = '7a000000-0000-4000-8000-000000000101'
      and terms_version = '2026-08-24'
      and privacy_version = '2026-08-24'
      and terms_sha256 = pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(terms_snapshot, 'UTF8'),
          'sha256'
        ),
        'hex'
      )
      and privacy_sha256 = pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(privacy_snapshot, 'UTF8'),
          'sha256'
        ),
        'hex'
      )
  )
  and not exists (
    select 1
    from public.hub_core_legal_acceptances
    where account_id = '7a000000-0000-4000-8000-000000000202'
  ),
  'RLS exposed another Hub account legal acceptance'
);

reset role;
set local request.jwt.claims = '{}';

rollback;
