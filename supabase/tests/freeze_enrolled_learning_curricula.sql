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
  to_regprocedure('public.delete_learning_unit(uuid)') is not null
  and to_regprocedure('public.reorder_learning_units(uuid,uuid[])') is not null
  and to_regprocedure('public.update_unit_activity(uuid,jsonb)') is not null
  and to_regprocedure('public.delete_unit_activity(uuid)') is not null
  and to_regprocedure('public.reorder_unit_activities(uuid,uuid[])') is not null,
  'path-first curriculum mutation RPCs are missing'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.delete_learning_unit(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.reorder_learning_units(uuid,uuid[])',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.update_unit_activity(uuid,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.delete_unit_activity(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.reorder_unit_activities(uuid,uuid[])',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.delete_learning_unit(uuid)',
    'EXECUTE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.learning_units',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.learning_units',
    'DELETE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.unit_activities',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.unit_activities',
    'DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.learning_units',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.learning_units',
    'DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.unit_activities',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.unit_activities',
    'DELETE'
  )
  and has_table_privilege(
    'service_role',
    'public.learning_paths',
    'DELETE'
  ),
  'child writes remain exposed or the parent cascade privilege was removed'
);

insert into public.tenants (id, name)
values
  ('curriculum-rpc-a', 'Curriculum RPC A'),
  ('curriculum-rpc-b', 'Curriculum RPC B');

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
    '00000000-0000-4000-8000-00000000d101',
    'authenticated',
    'authenticated',
    'curriculum-rpc-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Curriculum RPC Admin A"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000d102',
    'authenticated',
    'authenticated',
    'curriculum-rpc-admin-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Curriculum RPC Admin B"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000d103',
    'authenticated',
    'authenticated',
    'curriculum-rpc-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Curriculum RPC Student"}',
    now(),
    now()
  );

set local app.enrollment_claim = '1';

update public.profiles
   set tenant_id = 'curriculum-rpc-a',
       role = 'SCHOOL_ADMIN',
       full_name = 'Curriculum RPC Admin A',
       status = 'Ativo',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'curriculum-rpc-admin-a-test'
 where id = '00000000-0000-4000-8000-00000000d101';

update public.profiles
   set tenant_id = 'curriculum-rpc-b',
       role = 'SCHOOL_ADMIN',
       full_name = 'Curriculum RPC Admin B',
       status = 'Ativo',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'curriculum-rpc-admin-b-test'
 where id = '00000000-0000-4000-8000-00000000d102';

update public.profiles
   set tenant_id = 'curriculum-rpc-a',
       role = 'STUDENT',
       full_name = 'Curriculum RPC Student',
       status = 'Ativo',
       lifecycle_status = 'active',
       module = 'A1',
       current_book_part = 'A1-1',
       is_test_account = true,
       test_fixture_key = 'curriculum-rpc-student-test'
 where id = '00000000-0000-4000-8000-00000000d103';

set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values
  (
    '00000000-0000-4000-8000-00000000d101',
    'curriculum-rpc-a',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000d102',
    'curriculum-rpc-b',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000d103',
    'curriculum-rpc-a',
    'STUDENT',
    'ACTIVE',
    true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.learning_paths (
  id,
  tenant_id,
  name,
  target_level,
  category,
  active,
  created_by
)
values
  (
    '10000000-0000-4000-8000-00000000d101',
    'curriculum-rpc-a',
    'Mutable curriculum RPC path',
    'A1',
    'GENERAL',
    true,
    '00000000-0000-4000-8000-00000000d101'
  ),
  (
    '10000000-0000-4000-8000-00000000d102',
    'curriculum-rpc-a',
    'Frozen curriculum RPC path',
    'A1',
    'GENERAL',
    true,
    '00000000-0000-4000-8000-00000000d101'
  ),
  (
    '10000000-0000-4000-8000-00000000d103',
    'curriculum-rpc-b',
    'Foreign curriculum RPC path',
    'A1',
    'GENERAL',
    true,
    '00000000-0000-4000-8000-00000000d102'
  ),
  (
    '10000000-0000-4000-8000-00000000d104',
    'curriculum-rpc-a',
    'Parent cascade RPC path',
    'A1',
    'GENERAL',
    true,
    '00000000-0000-4000-8000-00000000d101'
  );

insert into public.learning_units (
  id,
  path_id,
  order_index,
  title,
  estimated_minutes
)
values
  (
    '20000000-0000-4000-8000-00000000d101',
    '10000000-0000-4000-8000-00000000d101',
    1,
    'Mutable unit one',
    10
  ),
  (
    '20000000-0000-4000-8000-00000000d102',
    '10000000-0000-4000-8000-00000000d101',
    2,
    'Mutable unit two',
    10
  ),
  (
    '20000000-0000-4000-8000-00000000d103',
    '10000000-0000-4000-8000-00000000d101',
    3,
    'Mutable unit three',
    10
  ),
  (
    '20000000-0000-4000-8000-00000000d104',
    '10000000-0000-4000-8000-00000000d102',
    1,
    'Frozen unit',
    10
  ),
  (
    '20000000-0000-4000-8000-00000000d105',
    '10000000-0000-4000-8000-00000000d103',
    1,
    'Foreign unit',
    10
  ),
  (
    '20000000-0000-4000-8000-00000000d106',
    '10000000-0000-4000-8000-00000000d104',
    1,
    'Cascade unit',
    10
  );

insert into public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  content,
  xp_reward,
  estimated_minutes
)
values
  (
    '30000000-0000-4000-8000-00000000d101',
    '20000000-0000-4000-8000-00000000d101',
    1,
    'reading',
    'Mutable activity one',
    '{"text":"One"}'::jsonb,
    10,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000d102',
    '20000000-0000-4000-8000-00000000d101',
    2,
    'reading',
    'Mutable activity two',
    '{"text":"Two"}'::jsonb,
    10,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000d103',
    '20000000-0000-4000-8000-00000000d101',
    3,
    'reading',
    'Mutable activity three',
    '{"text":"Three"}'::jsonb,
    10,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000d104',
    '20000000-0000-4000-8000-00000000d102',
    1,
    'reading',
    'Unit delete cascade activity',
    '{"text":"Delete with unit"}'::jsonb,
    10,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000d105',
    '20000000-0000-4000-8000-00000000d104',
    1,
    'reading',
    'Frozen activity',
    '{"text":"Frozen"}'::jsonb,
    10,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000d106',
    '20000000-0000-4000-8000-00000000d105',
    1,
    'reading',
    'Foreign activity',
    '{"text":"Foreign"}'::jsonb,
    10,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000d107',
    '20000000-0000-4000-8000-00000000d106',
    1,
    'reading',
    'Parent cascade activity',
    '{"text":"Cascade"}'::jsonb,
    10,
    5
  );

insert into public.student_path_enrollments (
  id,
  student_id,
  path_id,
  tenant_id,
  status,
  completed_at,
  assigned_by
)
values (
  '40000000-0000-4000-8000-00000000d101',
  '00000000-0000-4000-8000-00000000d103',
  '10000000-0000-4000-8000-00000000d102',
  'curriculum-rpc-a',
  'COMPLETED',
  now(),
  '00000000-0000-4000-8000-00000000d101'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000d101"}';

select pg_temp.assert_true(
  public.reorder_learning_units(
    '10000000-0000-4000-8000-00000000d101',
    array[
      '20000000-0000-4000-8000-00000000d103',
      '20000000-0000-4000-8000-00000000d101',
      '20000000-0000-4000-8000-00000000d102'
    ]::uuid[]
  ) ->> 'reordered' = 'true',
  'same-tenant SCHOOL_ADMIN could not reorder units'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(unit.id order by unit.order_index) = array[
      '20000000-0000-4000-8000-00000000d103',
      '20000000-0000-4000-8000-00000000d101',
      '20000000-0000-4000-8000-00000000d102'
    ]::uuid[]
      from public.learning_units as unit
     where unit.path_id = '10000000-0000-4000-8000-00000000d101'
  ),
  'unit reorder did not persist the complete requested order'
);

do $$
begin
  perform public.reorder_learning_units(
    '10000000-0000-4000-8000-00000000d101',
    array[
      '20000000-0000-4000-8000-00000000d101',
      '20000000-0000-4000-8000-00000000d101',
      '20000000-0000-4000-8000-00000000d102'
    ]::uuid[]
  );
  raise exception 'assertion failed: duplicate unit ids were accepted';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'learning_unit_order_invalid' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.reorder_learning_units(
    '10000000-0000-4000-8000-00000000d101',
    array[
      '20000000-0000-4000-8000-00000000d101',
      '20000000-0000-4000-8000-00000000d102',
      '20000000-0000-4000-8000-00000000d105'
    ]::uuid[]
  );
  raise exception 'assertion failed: a foreign unit id was accepted';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'learning_unit_order_invalid' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  public.reorder_unit_activities(
    '20000000-0000-4000-8000-00000000d101',
    array[
      '30000000-0000-4000-8000-00000000d103',
      '30000000-0000-4000-8000-00000000d101',
      '30000000-0000-4000-8000-00000000d102'
    ]::uuid[]
  ) ->> 'reordered' = 'true',
  'same-tenant SCHOOL_ADMIN could not reorder activities'
);

do $$
begin
  perform public.reorder_unit_activities(
    '20000000-0000-4000-8000-00000000d101',
    array[
      '30000000-0000-4000-8000-00000000d101',
      '30000000-0000-4000-8000-00000000d101',
      '30000000-0000-4000-8000-00000000d102'
    ]::uuid[]
  );
  raise exception 'assertion failed: duplicate activity ids were accepted';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'unit_activity_order_invalid' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  public.update_unit_activity(
    '30000000-0000-4000-8000-00000000d101',
    '{"title":"Updated activity","description":null,"content":{"text":"Updated"},"xp_reward":25,"estimated_minutes":8}'::jsonb
  ) ->> 'activityId' = '30000000-0000-4000-8000-00000000d101',
  'same-tenant SCHOOL_ADMIN could not update an activity through the RPC'
);

select pg_temp.assert_true(
  (
    select activity.title = 'Updated activity'
           and activity.description is null
           and activity.content = '{"text":"Updated"}'::jsonb
           and activity.xp_reward = 25
           and activity.estimated_minutes = 8
      from public.unit_activities as activity
     where activity.id = '30000000-0000-4000-8000-00000000d101'
  ),
  'activity update RPC did not persist its allowlisted payload'
);

do $$
begin
  perform public.update_unit_activity(
    '30000000-0000-4000-8000-00000000d101',
    '{"unit_id":"20000000-0000-4000-8000-00000000d105"}'::jsonb
  );
  raise exception 'assertion failed: an activity parent rewrite was accepted';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'unit_activity_payload_invalid' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.update_unit_activity(
    '30000000-0000-4000-8000-00000000d101',
    '{"xp_reward":-1,"estimated_minutes":1441}'::jsonb
  );
  raise exception 'assertion failed: unsafe activity reward bounds were accepted';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'unit_activity_payload_invalid' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  public.delete_unit_activity(
    '30000000-0000-4000-8000-00000000d102'
  ) ->> 'deleted' = 'true',
  'same-tenant SCHOOL_ADMIN could not delete an activity through the RPC'
);

select pg_temp.assert_true(
  public.delete_learning_unit(
    '20000000-0000-4000-8000-00000000d102'
  ) ->> 'deleted' = 'true',
  'same-tenant SCHOOL_ADMIN could not delete a unit through the RPC'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.unit_activities
     where id = '30000000-0000-4000-8000-00000000d104'
  ),
  'unit delete RPC did not preserve its child FK cascade'
);

do $$
begin
  perform public.update_unit_activity(
    '30000000-0000-4000-8000-00000000d106',
    '{"title":"Cross-tenant rewrite"}'::jsonb
  );
  raise exception 'assertion failed: cross-tenant activity update was accepted';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'learning_curriculum_mutation_not_authorized' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.update_unit_activity(
    '30000000-0000-4000-8000-00000000d105',
    '{"title":"Frozen rewrite"}'::jsonb
  );
  raise exception 'assertion failed: frozen activity update was accepted';
exception
  when sqlstate '55000' then
    if sqlerrm <> 'learning_path_curriculum_frozen_after_enrollment' then
      raise;
    end if;
end;
$$;

do $$
begin
  update public.learning_units
     set title = 'Direct authenticated rewrite'
   where id = '20000000-0000-4000-8000-00000000d101';
  raise exception 'assertion failed: authenticated retained direct child UPDATE';
exception
  when sqlstate '42501' then null;
end;
$$;

reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000d103"}';

do $$
begin
  perform public.delete_unit_activity(
    '30000000-0000-4000-8000-00000000d101'
  );
  raise exception 'assertion failed: STUDENT curriculum mutation was accepted';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'learning_curriculum_mutation_not_authorized' then
      raise;
    end if;
end;
$$;

reset role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
begin
  update public.unit_activities
     set title = 'Direct service rewrite'
   where id = '30000000-0000-4000-8000-00000000d103';
  raise exception 'assertion failed: service_role retained direct child UPDATE';
exception
  when sqlstate '42501' then null;
end;
$$;

do $$
begin
  delete from public.learning_units
   where id = '20000000-0000-4000-8000-00000000d103';
  raise exception 'assertion failed: service_role retained direct child DELETE';
exception
  when sqlstate '42501' then null;
end;
$$;

select pg_temp.assert_true(
  public.update_unit_activity(
    '30000000-0000-4000-8000-00000000d103',
    '{"title":"Service RPC update"}'::jsonb
  ) ->> 'activityId' = '30000000-0000-4000-8000-00000000d103',
  'service_role could not use the path-first mutation RPC'
);

delete from public.learning_paths
 where id = '10000000-0000-4000-8000-00000000d104';

select pg_temp.assert_true(
  not exists (
    select 1
      from public.learning_units
     where id = '20000000-0000-4000-8000-00000000d106'
  )
  and not exists (
    select 1
      from public.unit_activities
     where id = '30000000-0000-4000-8000-00000000d107'
  ),
  'revoking direct child DELETE blocked a legitimate parent FK cascade'
);

reset role;

rollback;
