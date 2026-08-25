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

select pg_temp.assert_true(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ai_conversations'
      and column_name = 'product_family'
      and is_nullable = 'NO'
      and column_default = '''SCHOOL''::text'
  )
  and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ai_conversations'
      and column_name = 'hub_account_id'
      and data_type = 'uuid'
  ),
  'conversation scope columns are missing or unsafe'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.ai_conversations'::regclass
      and conname = 'ai_conversations_product_scope_check'
      and convalidated
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.ai_conversations'::regclass
      and conname = 'ai_conversations_hub_account_id_fkey'
      and convalidated
  ),
  'conversation account and product constraints are not validated'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'ai_conversations'
      and policyname = 'ai_conversations_school_owner_read'
      and permissive = 'PERMISSIVE'
      and roles = array['authenticated'::name]
  )
  and exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'ai_conversations'
      and policyname = 'ai_conversations_private_hub_guard'
      and permissive = 'RESTRICTIVE'
      and roles = array['authenticated'::name]
  )
  and exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'ai_messages'
      and policyname = 'ai_messages_private_hub_guard'
      and permissive = 'RESTRICTIVE'
      and roles = array['authenticated'::name]
  ),
  'Hub conversations are not protected by restrictive client-read guards'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'private.enforce_ai_conversation_scope_immutable()',
    'EXECUTE'
  ),
  'authenticated users can invoke the scope immutability trigger directly'
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
  '78000000-0000-4000-8000-000000000101',
  'authenticated',
  'authenticated',
  'hub-wolfie-scope@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Hub Wolfie Scope"}',
  pg_catalog.now(),
  pg_catalog.now()
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
    '78000000-0000-4000-8000-000000000201',
    'ORGANIZATION',
    'INSTITUTION',
    'Hub Wolfie Scope A',
    '78000000-0000-4000-8000-000000000101',
    'ACTIVE',
    '{"test_fixture":true}'::jsonb
  ),
  (
    '78000000-0000-4000-8000-000000000202',
    'ORGANIZATION',
    'INSTITUTION',
    'Hub Wolfie Scope B',
    '78000000-0000-4000-8000-000000000101',
    'ACTIVE',
    '{"test_fixture":true}'::jsonb
  );

insert into public.ai_conversations (
  id,
  student_id,
  topic,
  product_family,
  hub_account_id
)
values
  (
    '78000000-0000-4000-8000-000000000301',
    '78000000-0000-4000-8000-000000000101',
    'School conversation',
    'SCHOOL',
    null
  ),
  (
    '78000000-0000-4000-8000-000000000302',
    '78000000-0000-4000-8000-000000000101',
    'Hub conversation',
    'HUB_CORE',
    '78000000-0000-4000-8000-000000000201'
  );

insert into public.ai_messages (conversation_id, role, content)
values
  (
    '78000000-0000-4000-8000-000000000301',
    'user',
    'school-visible'
  ),
  (
    '78000000-0000-4000-8000-000000000302',
    'user',
    'hub-private'
  );

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.ai_conversations (
      id,
      student_id,
      product_family,
      hub_account_id
    ) values (
      '78000000-0000-4000-8000-000000000303',
      '78000000-0000-4000-8000-000000000101',
      'HUB_CORE',
      null
    )
  $statement$,
  '23514',
  'HUB_CORE conversation without an account was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    insert into public.ai_conversations (
      id,
      student_id,
      product_family,
      hub_account_id
    ) values (
      '78000000-0000-4000-8000-000000000304',
      '78000000-0000-4000-8000-000000000101',
      'SCHOOL',
      '78000000-0000-4000-8000-000000000201'
    )
  $statement$,
  '23514',
  'school conversation with a Hub account was accepted'
);

select pg_temp.assert_sqlstate(
  $statement$
    update public.ai_conversations
    set hub_account_id = '78000000-0000-4000-8000-000000000202'
    where id = '78000000-0000-4000-8000-000000000302'
  $statement$,
  '42501',
  'conversation account scope was mutable after creation'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"78000000-0000-4000-8000-000000000101","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(product_family = 'SCHOOL')
    from public.ai_conversations
    where id in (
      '78000000-0000-4000-8000-000000000301',
      '78000000-0000-4000-8000-000000000302'
    )
  ),
  'authenticated owner can read a Hub conversation directly or lost school access'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 1
      and pg_catalog.bool_and(content = 'school-visible')
    from public.ai_messages
    where conversation_id in (
      '78000000-0000-4000-8000-000000000301',
      '78000000-0000-4000-8000-000000000302'
    )
  ),
  'authenticated owner can read Hub messages directly or lost school history'
);

rollback;
