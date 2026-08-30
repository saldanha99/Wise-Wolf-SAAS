-- Reschedule notification revisions are monotonic and database-owned.

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
  exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'reschedules'
       and column_name = 'notification_revision'
       and data_type = 'bigint'
       and is_nullable = 'NO'
       and column_default = '1'
  ),
  'notification_revision is not a bigint NOT NULL with default 1'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'private'
       and procedure.proname = 'bump_reschedule_notification_revision'
       and procedure.prosecdef is false
       and procedure.proconfig @> array['search_path=""']::text[]
  ),
  'revision trigger function is not SECURITY INVOKER with an empty search_path'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon',
    'private.bump_reschedule_notification_revision()',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'private.bump_reschedule_notification_revision()',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'private.bump_reschedule_notification_revision()',
    'EXECUTE'
  ),
  'browser/service roles can execute the internal revision trigger function'
);

insert into public.tenants (id, name)
values ('reschedule-revision-school', 'Reschedule Revision School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '91000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'reschedule-revision-teacher-1@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Revision Teacher One"}', now(), now()
  ),
  (
    '91000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated',
    'reschedule-revision-teacher-2@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Revision Teacher Two"}', now(), now()
  ),
  (
    '91000000-0000-4000-8000-000000000003',
    'authenticated', 'authenticated',
    'reschedule-revision-student-1@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Revision Student One"}', now(), now()
  ),
  (
    '91000000-0000-4000-8000-000000000004',
    'authenticated', 'authenticated',
    'reschedule-revision-student-2@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Revision Student Two"}', now(), now()
  );

update public.profiles
   set tenant_id = 'reschedule-revision-school', role = 'TEACHER'
 where id in (
   '91000000-0000-4000-8000-000000000001',
   '91000000-0000-4000-8000-000000000002'
 );

update public.profiles
   set tenant_id = 'reschedule-revision-school', role = 'STUDENT'
 where id in (
   '91000000-0000-4000-8000-000000000003',
   '91000000-0000-4000-8000-000000000004'
 );

insert into public.reschedules (
  id, tenant_id, teacher_id, student_id, date, time, fault_type,
  notification_revision
)
values (
  '92000000-0000-4000-8000-000000000001',
  'reschedule-revision-school',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000003',
  '2026-09-01', '19:00', 'STUDENT', 999
);

select pg_temp.assert_true(
  (
    select notification_revision = 1 and time = '19:00'
      from public.reschedules
     where id = '92000000-0000-4000-8000-000000000001'
  ),
  'caller-supplied insert revision was not forced to initial revision 1'
);

-- 19:00 -> 20:00 is revision 2. A simultaneous caller-supplied jump is ignored.
update public.reschedules
   set time = '20:00', notification_revision = 999
 where id = '92000000-0000-4000-8000-000000000001';

select pg_temp.assert_true(
  (
    select notification_revision = 2 and time = '20:00'
      from public.reschedules
     where id = '92000000-0000-4000-8000-000000000001'
  ),
  '19:00 -> 20:00 did not produce exactly revision 2'
);

-- Returning to an earlier business value is still a new notification revision.
update public.reschedules
   set time = '19:00'
 where id = '92000000-0000-4000-8000-000000000001';

select pg_temp.assert_true(
  (
    select notification_revision = 3 and time = '19:00'
      from public.reschedules
     where id = '92000000-0000-4000-8000-000000000001'
  ),
  '20:00 -> 19:00 did not produce exactly revision 3'
);

-- Replaying the same material values is not a new revision.
update public.reschedules
   set date = '2026-09-01', time = '19:00'
 where id = '92000000-0000-4000-8000-000000000001';

select pg_temp.assert_true(
  (
    select notification_revision = 3
      from public.reschedules
     where id = '92000000-0000-4000-8000-000000000001'
  ),
  'same-value replay incremented the revision'
);

-- A direct manipulation with no material change is restored to OLD.
update public.reschedules
   set notification_revision = 1
 where id = '92000000-0000-4000-8000-000000000001';

select pg_temp.assert_true(
  (
    select notification_revision = 3
      from public.reschedules
     where id = '92000000-0000-4000-8000-000000000001'
  ),
  'direct revision manipulation was accepted'
);

-- Irrelevant updates preserve the current revision.
update public.reschedules
   set fault_type = 'TEACHER'
 where id = '92000000-0000-4000-8000-000000000001';

select pg_temp.assert_true(
  (
    select notification_revision = 3 and fault_type = 'TEACHER'
      from public.reschedules
     where id = '92000000-0000-4000-8000-000000000001'
  ),
  'irrelevant update changed the revision'
);

-- Every material dimension participates in the same monotonic counter.
update public.reschedules
   set date = '2026-09-02',
       teacher_id = '91000000-0000-4000-8000-000000000002',
       student_id = '91000000-0000-4000-8000-000000000004'
 where id = '92000000-0000-4000-8000-000000000001';

select pg_temp.assert_true(
  (
    select notification_revision = 4
      from public.reschedules
     where id = '92000000-0000-4000-8000-000000000001'
  ),
  'one update touching date/teacher/student did not increment exactly once'
);

rollback;
