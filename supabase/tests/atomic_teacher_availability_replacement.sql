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
  not has_function_privilege(
    'anon', 'public.replace_teacher_availability(uuid,jsonb)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.replace_teacher_availability(uuid,jsonb)', 'EXECUTE'
  ),
  'replace_teacher_availability has unsafe execute grants'
);

insert into public.tenants (id, name)
values ('atomic-availability-school', 'Atomic Availability School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-000000000731',
  'authenticated',
  'authenticated',
  'atomic-availability-teacher@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Professor Disponibilidade"}',
  now(),
  now()
);

update public.profiles
   set tenant_id = 'atomic-availability-school',
       role = 'TEACHER',
       full_name = 'Professor Disponibilidade'
 where id = '00000000-0000-4000-8000-000000000731';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000731","role":"authenticated"}';

select public.replace_teacher_availability(
  '00000000-0000-4000-8000-000000000731',
  jsonb_build_array(
    jsonb_build_object('day_of_week', 1, 'start_time', '08:00'),
    jsonb_build_object('day_of_week', 3, 'start_time', '19:30'),
    jsonb_build_object('day_of_week', 3, 'start_time', '19:30')
  )
);

reset role;

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.teacher_availability
     where teacher_id = '00000000-0000-4000-8000-000000000731'
  ),
  'duplicate availability slots were not normalized'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000731","role":"authenticated"}';

do $$
begin
  perform public.replace_teacher_availability(
    '00000000-0000-4000-8000-000000000731',
    jsonb_build_array(
      jsonb_build_object('day_of_week', 2, 'start_time', '99:00')
    )
  );
  raise exception 'assertion failed: invalid availability unexpectedly succeeded';
exception
  when sqlstate '22023' then
    null;
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.teacher_availability
     where teacher_id = '00000000-0000-4000-8000-000000000731'
  ),
  'a failed replacement erased the previously published schedule'
);

rollback;
