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

grant execute on function pg_temp.assert_true(boolean, text) to public;

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'assign_class_coverage'
      and (
        has_function_privilege('anon', procedure.oid, 'EXECUTE')
        or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      )
  ),
  'legacy coverage RPC remains executable by a browser role'
);

insert into public.tenants (id, name, slug, saas_status)
values ('teacher-offboarding-school', 'Teacher Offboarding School', 'teacher-offboarding-school', 'active');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'offboarding-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Offboarding Admin"}', now(), now()),
  ('f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'offboarding-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Offboarding Teacher"}', now(), now());

update public.profiles
set tenant_id = 'teacher-offboarding-school',
    role = 'SCHOOL_ADMIN',
    status = 'Ativo',
    lifecycle_status = 'active'
where id = 'f1000000-0000-4000-8000-000000000001';

update public.profiles
set tenant_id = 'teacher-offboarding-school',
    role = 'TEACHER',
    status = 'Ativo',
    lifecycle_status = 'active',
    offboarding_status = 'APPROVED',
    date_automation_enabled = true
where id = 'f1000000-0000-4000-8000-000000000002';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
values
  ('f1000000-0000-4000-8000-000000000001', 'teacher-offboarding-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('f1000000-0000-4000-8000-000000000002', 'teacher-offboarding-school', 'TEACHER', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('f1000000-0000-4000-8000-000000000001', 'teacher-offboarding-school'),
  ('f1000000-0000-4000-8000-000000000002', 'teacher-offboarding-school')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.notification_queue (
  tenant_id, teacher_id, student_phone, message_body,
  scheduled_for, status, notification_kind
)
values (
  'teacher-offboarding-school',
  'f1000000-0000-4000-8000-000000000002',
  '5511999999999',
  'fixture that must never be delivered',
  now() + interval '5 minutes',
  'pending',
  'TEACHER_OFFBOARDING_FIXTURE'
);

insert into auth.sessions (id, user_id)
values (
  'f2000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000002'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select public.complete_teacher_offboarding('f1000000-0000-4000-8000-000000000002');

reset role;

select pg_temp.assert_true(
  exists (
    select 1
    from public.tenant_memberships
    where user_id = 'f1000000-0000-4000-8000-000000000002'
      and tenant_id = 'teacher-offboarding-school'
      and status = 'REVOKED'
      and is_primary is false
  ),
  'teacher membership was not revoked'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.profiles
    where id = 'f1000000-0000-4000-8000-000000000002'
      and status = 'Inativo'
      and lifecycle_status = 'offboarded'
      and offboarding_status = 'COMPLETED'
      and offboarding_completed_at is not null
      and date_automation_enabled is false
  ),
  'profile did not reach the canonical offboarded state'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.notification_queue
    where teacher_id = 'f1000000-0000-4000-8000-000000000002'
      and tenant_id = 'teacher-offboarding-school'
      and status = 'skipped'
      and last_error = 'teacher_offboarded'
  ),
  'queued teacher notification was not suppressed'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from auth.sessions
    where user_id = 'f1000000-0000-4000-8000-000000000002'
  ),
  'teacher refresh session survived offboarding'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select pg_temp.assert_true(
  (select tenant_id is null and role is null from public.get_my_access_context()),
  'offboarded teacher still resolves an active access context'
);

rollback;
