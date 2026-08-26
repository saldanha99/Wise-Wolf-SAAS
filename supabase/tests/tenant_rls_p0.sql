-- Tenant RLS P0: runtime isolation for two schools plus privilege regression.

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
do $$
begin
  if to_regprocedure('pg_temp.assert_sqlstate(text, text, text)') is not null then
    execute 'grant execute on function pg_temp.assert_sqlstate(text, text, text) to public';
  end if;
end
$$;

create or replace function pg_temp.assert_direct_write_denied(
  command text,
  message text
)
returns void
language plpgsql
as $$
begin
  begin
    execute command;
  exception
    when insufficient_privilege then return;
  end;
  raise exception 'assertion failed: %', message;
end;
$$;

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    cross join (values ('anon'::name), ('authenticated'::name)) as client(role_name)
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and (
        pg_catalog.has_table_privilege(client.role_name, relation.oid, 'TRUNCATE')
        or pg_catalog.has_table_privilege(client.role_name, relation.oid, 'REFERENCES')
        or pg_catalog.has_table_privilege(client.role_name, relation.oid, 'TRIGGER')
      )
  ),
  'anon/authenticated retained TRUNCATE, REFERENCES or TRIGGER on public tables'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'authenticated', 'public.v_payable_class_logs', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.v_teacher_cost_competencia', 'SELECT'
  ),
  'authenticated retained direct access to finance owner views'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'student_evaluations'
  ) = array[
    'tenant_rls_p0_student_evaluations_insert',
    'tenant_rls_p0_student_evaluations_select'
  ]::text[],
  'student_evaluations has an unreviewed policy set'
);

select pg_temp.assert_true(
  (
    select qual not ilike '%tenant_id is null%'
      and qual ilike '%tenant_rls_p0_has_active_role%'
      and qual ilike '%tenant_rls_p0_has_active_booking%'
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'student_evaluations'
      and policyname = 'tenant_rls_p0_student_evaluations_select'
  )
  and (
    select with_check not ilike '%tenant_id is null%'
      and with_check ilike '%tenant_rls_p0_has_active_role%'
      and with_check ilike '%_my_tenant_is_operational%'
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'student_evaluations'
      and policyname = 'tenant_rls_p0_student_evaluations_insert'
  ),
  'student evaluations retained a null wildcard or unsafe membership check'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'student_insights'
  ) = array[
    'tenant_rls_p0_student_insights_select'
  ]::text[],
  'student_insights has an unreviewed policy set'
);

select pg_temp.assert_true(
  (
    select qual ilike '%tenant_rls_p0_has_active_role%'
      and qual ilike '%tenant_rls_p0_has_active_booking%'
      and qual not ilike '%commercial%'
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'student_insights'
      and policyname = 'tenant_rls_p0_student_insights_select'
  ),
  'student insights retained broad teacher/commercial read access'
);

select pg_temp.assert_true(
  pg_catalog.has_table_privilege(
    'authenticated', 'public.student_insights', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_insights', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_insights', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.student_insights', 'DELETE'
  ),
  'authenticated retained write access to service-owned student insights'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.student_insights'::regclass
      and attname = 'tenant_id'
      and atttypid = 'text'::regtype
      and attnotnull
      and not attisdropped
  ),
  'student_insights.tenant_id is missing, nullable or not text'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.student_insights'::regclass
      and conname = 'student_insights_tenant_id_fkey'
      and contype = 'f'
      and convalidated
  )
  and to_regclass(
    'public.student_insights_tenant_student_created_idx'
  ) is not null,
  'student_insights tenant foreign key or lookup index is missing'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon',
    'private.tenant_rls_p0_has_active_role(uuid,text,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'private.tenant_rls_p0_has_active_role(uuid,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'private.tenant_rls_p0_has_active_booking(uuid,uuid,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'private.tenant_rls_p0_has_active_booking(uuid,uuid,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'private.tenant_rls_p0_has_active_membership(text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'private.tenant_rls_p0_has_active_membership(text)',
    'EXECUTE'
  ),
  'tenant pedagogy policy helpers have unsafe execute privileges'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'pedagogical_materials'
  ) = array[
    'tenant_rls_p0_pedagogical_materials_delete',
    'tenant_rls_p0_pedagogical_materials_insert',
    'tenant_rls_p0_pedagogical_materials_select',
    'tenant_rls_p0_pedagogical_materials_update'
  ]::text[],
  'pedagogical_materials has an unreviewed policy set'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'automation_logs'
  ) = array['tenant_rls_p0_automation_logs_select']::text[],
  'automation_logs has an unreviewed policy set'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'appointments'
  ) = array[
    'secure_trial_appointments_select'
  ]::text[],
  'appointments has an unreviewed policy set'
);

select pg_temp.assert_true(
  pg_catalog.has_table_privilege(
    'authenticated', 'public.appointments', 'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.appointments', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.appointments', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.appointments', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'anon', 'public.appointments', 'SELECT'
  ),
  'appointments retained direct writes or anonymous reads'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'teacher_availability'
  ) = array[
    'tenant_rls_p0_teacher_availability_delete',
    'tenant_rls_p0_teacher_availability_insert',
    'tenant_rls_p0_teacher_availability_select',
    'tenant_rls_p0_teacher_availability_update'
  ]::text[],
  'teacher_availability has an unreviewed policy set'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'prospects'
  ) = array[
    'tenant_rls_p0_prospects_delete',
    'tenant_rls_p0_prospects_insert',
    'tenant_rls_p0_prospects_select',
    'tenant_rls_p0_prospects_service_role',
    'tenant_rls_p0_prospects_update'
  ]::text[],
  'prospects has an unreviewed policy set'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege('anon', 'public.prospects', 'INSERT')
  and not pg_catalog.has_table_privilege('anon', 'public.prospects', 'SELECT')
  and not pg_catalog.has_table_privilege('anon', 'public.prospects', 'UPDATE')
  and not pg_catalog.has_table_privilege('anon', 'public.prospects', 'DELETE'),
  'anonymous role retained direct prospects access'
);

select pg_temp.assert_true(
  (
    select pg_catalog.array_agg(policyname::text order by policyname)
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'opportunities'
  ) = array[
    'secure_trial_opportunities_staff_select'
  ]::text[],
  'opportunities has an unreviewed policy set'
);

select pg_temp.assert_true(
  (
    select qual ilike '%_my_tenant_id%'
      and qual ilike '%_my_role%'
      and qual not ilike '%secure_trial_has_active_membership%'
      and qual not ilike '%TEACHER%'
      and qual not ilike '%STUDENT%'
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'opportunities'
      and policyname = 'secure_trial_opportunities_staff_select'
  ),
  'opportunities policy lost tenant, role or staff-only guards'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege('anon', 'public.opportunities', 'SELECT')
  and not pg_catalog.has_table_privilege('anon', 'public.opportunities', 'INSERT')
  and not pg_catalog.has_table_privilege('anon', 'public.opportunities', 'UPDATE')
  and not pg_catalog.has_table_privilege('anon', 'public.opportunities', 'DELETE')
  and pg_catalog.has_table_privilege('authenticated', 'public.opportunities', 'SELECT')
  and not pg_catalog.has_table_privilege('authenticated', 'public.opportunities', 'INSERT')
  and not pg_catalog.has_table_privilege('authenticated', 'public.opportunities', 'UPDATE')
  and not pg_catalog.has_table_privilege('authenticated', 'public.opportunities', 'DELETE'),
  'opportunities table privileges do not match the reviewed RLS surface'
);

do $test$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.birthdays_today()',
    'public.trial_followups()',
    'public.teacher_agendas_today()',
    'public.weekly_digest_rows()'
  ]
  loop
    if to_regprocedure(function_signature) is not null then
      perform pg_temp.assert_true(
        not pg_catalog.has_function_privilege(
          'anon', to_regprocedure(function_signature), 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated', to_regprocedure(function_signature), 'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
          'service_role', to_regprocedure(function_signature), 'EXECUTE'
        ),
        function_signature || ' is not service-role-only'
      );
    end if;
  end loop;

  if to_regprocedure('public.get_contract_public(uuid)') is not null then
    perform pg_temp.assert_true(
      not pg_catalog.has_function_privilege(
        'anon',
        to_regprocedure('public.get_contract_public(uuid)'),
        'EXECUTE'
      ),
      'anonymous user can execute get_contract_public(uuid)'
    );
  end if;
end;
$test$;

insert into public.tenants (id, name, saas_status)
values
  ('tenant-rls-p0-a', 'Tenant RLS P0 A', 'active'),
  ('tenant-rls-p0-b', 'Tenant RLS P0 B', 'active');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000a001',
    'authenticated', 'authenticated', 'tenant-rls-p0-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Admin A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000a002',
    'authenticated', 'authenticated', 'tenant-rls-p0-teacher-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Teacher A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000a003',
    'authenticated', 'authenticated', 'tenant-rls-p0-student-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Student A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000a004',
    'authenticated', 'authenticated', 'tenant-rls-p0-commercial-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Commercial A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000a005',
    'authenticated', 'authenticated', 'tenant-rls-p0-coordinator-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Coordinator A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000b001',
    'authenticated', 'authenticated', 'tenant-rls-p0-admin-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Admin B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000b002',
    'authenticated', 'authenticated', 'tenant-rls-p0-teacher-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Teacher B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000b003',
    'authenticated', 'authenticated', 'tenant-rls-p0-student-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Student B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000b004',
    'authenticated', 'authenticated', 'tenant-rls-p0-inactive-teacher-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Inactive Teacher B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000b005',
    'authenticated', 'authenticated', 'tenant-rls-p0-lifecycle-teacher-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Lifecycle Teacher B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000c001',
    'authenticated', 'authenticated', 'tenant-rls-p0-super-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tenant P0 Super Admin"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
set tenant_id = 'tenant-rls-p0-a', role = 'SCHOOL_ADMIN',
    full_name = 'Tenant P0 Admin A'
where id = '00000000-0000-4000-8000-00000000a001';
update public.profiles
set tenant_id = 'tenant-rls-p0-a', role = 'TEACHER',
    full_name = 'Tenant P0 Teacher A'
where id = '00000000-0000-4000-8000-00000000a002';
update public.profiles
set tenant_id = 'tenant-rls-p0-a', role = 'STUDENT',
    full_name = 'Tenant P0 Student A'
where id = '00000000-0000-4000-8000-00000000a003';
update public.profiles
set tenant_id = 'tenant-rls-p0-a', role = 'COMMERCIAL',
    full_name = 'Tenant P0 Commercial A'
where id = '00000000-0000-4000-8000-00000000a004';
update public.profiles
set tenant_id = 'tenant-rls-p0-a', role = 'COORDINATOR',
    full_name = 'Tenant P0 Coordinator A'
where id = '00000000-0000-4000-8000-00000000a005';
update public.profiles
set tenant_id = 'tenant-rls-p0-b', role = 'SCHOOL_ADMIN',
    full_name = 'Tenant P0 Admin B'
where id = '00000000-0000-4000-8000-00000000b001';
update public.profiles
set tenant_id = 'tenant-rls-p0-b', role = 'TEACHER',
    full_name = 'Tenant P0 Teacher B'
where id = '00000000-0000-4000-8000-00000000b002';
update public.profiles
set tenant_id = 'tenant-rls-p0-b', role = 'STUDENT',
    full_name = 'Tenant P0 Student B'
where id = '00000000-0000-4000-8000-00000000b003';
update public.profiles
set tenant_id = 'tenant-rls-p0-b', role = 'TEACHER',
    full_name = 'Tenant P0 Inactive Teacher B'
where id = '00000000-0000-4000-8000-00000000b004';
update public.profiles
set tenant_id = 'tenant-rls-p0-b', role = 'TEACHER',
    lifecycle_status = 'suspended',
    full_name = 'Tenant P0 Lifecycle Teacher B'
where id = '00000000-0000-4000-8000-00000000b005';
update public.profiles
set tenant_id = 'tenant-rls-p0-b', role = 'SUPER_ADMIN',
    full_name = 'Tenant P0 Super Admin'
where id = '00000000-0000-4000-8000-00000000c001';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  ('00000000-0000-4000-8000-00000000a001', 'tenant-rls-p0-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000a002', 'tenant-rls-p0-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000a002', 'tenant-rls-p0-b', 'TEACHER', 'ACTIVE', false),
  ('00000000-0000-4000-8000-00000000a003', 'tenant-rls-p0-a', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000a003', 'tenant-rls-p0-b', 'STUDENT', 'ACTIVE', false),
  ('00000000-0000-4000-8000-00000000a004', 'tenant-rls-p0-a', 'COMMERCIAL', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000a005', 'tenant-rls-p0-a', 'COORDINATOR', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000b001', 'tenant-rls-p0-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000b002', 'tenant-rls-p0-b', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000b003', 'tenant-rls-p0-a', 'STUDENT', 'ACTIVE', false),
  ('00000000-0000-4000-8000-00000000b003', 'tenant-rls-p0-b', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000b004', 'tenant-rls-p0-b', 'TEACHER', 'SUSPENDED', false),
  ('00000000-0000-4000-8000-00000000b005', 'tenant-rls-p0-b', 'TEACHER', 'ACTIVE', false),
  ('00000000-0000-4000-8000-00000000c001', 'tenant-rls-p0-a', 'SCHOOL_ADMIN', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-00000000a001', 'tenant-rls-p0-a'),
  ('00000000-0000-4000-8000-00000000a002', 'tenant-rls-p0-a'),
  ('00000000-0000-4000-8000-00000000a003', 'tenant-rls-p0-a'),
  ('00000000-0000-4000-8000-00000000a004', 'tenant-rls-p0-a'),
  ('00000000-0000-4000-8000-00000000a005', 'tenant-rls-p0-a'),
  ('00000000-0000-4000-8000-00000000b001', 'tenant-rls-p0-b'),
  ('00000000-0000-4000-8000-00000000b002', 'tenant-rls-p0-b'),
  ('00000000-0000-4000-8000-00000000b003', 'tenant-rls-p0-b'),
  ('00000000-0000-4000-8000-00000000b005', 'tenant-rls-p0-b'),
  ('00000000-0000-4000-8000-00000000c001', 'tenant-rls-p0-a')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status
) values
  (
    '80000000-0000-4000-8000-00000000a001',
    'tenant-rls-p0-a',
    '00000000-0000-4000-8000-00000000a002',
    '00000000-0000-4000-8000-00000000a003',
    'Friday', '23:55', 'SCHEDULED'
  ),
  (
    '80000000-0000-4000-8000-00000000b001',
    'tenant-rls-p0-b',
    '00000000-0000-4000-8000-00000000a002',
    '00000000-0000-4000-8000-00000000a003',
    'Friday', '23:55', 'SCHEDULED'
  );

insert into public.student_evaluations (
  id, student_id, teacher_id, book_part, score, total_questions, tenant_id
)
values
  (
    '10000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a003',
    '00000000-0000-4000-8000-00000000a002',
    'A1-1', 9, 10, 'tenant-rls-p0-a'
  ),
  (
    '10000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000a003',
    '00000000-0000-4000-8000-00000000b002',
    'A1-1', 8, 10, 'tenant-rls-p0-b'
  ),
  (
    '10000000-0000-4000-8000-00000000a002',
    '00000000-0000-4000-8000-00000000b003',
    null,
    'A1-UNASSIGNED', 7, 10, 'tenant-rls-p0-a'
  );

insert into public.student_insights (
  id, tenant_id, student_id, content, valid_until
)
values
  (
    '20000000-0000-4000-8000-00000000a001',
    'tenant-rls-p0-a',
    '00000000-0000-4000-8000-00000000a003',
    'tenant-a-insight', now() + interval '1 day'
  ),
  (
    '20000000-0000-4000-8000-00000000b001',
    'tenant-rls-p0-b',
    '00000000-0000-4000-8000-00000000a003',
    'tenant-b-insight', now() + interval '1 day'
  ),
  (
    '20000000-0000-4000-8000-00000000a002',
    'tenant-rls-p0-a',
    '00000000-0000-4000-8000-00000000b003',
    'tenant-a-unassigned-insight', now() + interval '1 day'
  );

insert into public.pedagogical_materials (
  id, tenant_id, title, file_url, type, scope,
  uploaded_by, approval_status
)
values
  (
    '30000000-0000-4000-8000-00000000a001',
    'tenant-rls-p0-a', 'Tenant A Material',
    'https://example.invalid/tenant-a.pdf', 'PDF', 'TENANT',
    '00000000-0000-4000-8000-00000000a001', 'PENDING'
  ),
  (
    '30000000-0000-4000-8000-00000000b001',
    'tenant-rls-p0-b', 'Tenant B Material',
    'https://example.invalid/tenant-b.pdf', 'PDF', 'TENANT',
    '00000000-0000-4000-8000-00000000b001', 'PENDING'
  );

insert into public.automation_logs (id, tenant_id, type, status, message)
values
  (
    '40000000-0000-4000-8000-00000000a001',
    'tenant-rls-p0-a', 'tenant_rls_p0', 'success', 'tenant-a-log'
  ),
  (
    '40000000-0000-4000-8000-00000000b001',
    'tenant-rls-p0-b', 'tenant_rls_p0', 'success', 'tenant-b-log'
  );

insert into public.appointments (
  id, professor_id, teacher_id, student_name, student_phone,
  start_time, status, type, tenant_id
)
values
  (
    '50000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a002',
    '00000000-0000-4000-8000-00000000a002',
    'Tenant A Lead', '5511999990001', now() + interval '1 day',
    'scheduled', 'experimental', 'tenant-rls-p0-a'
  ),
  (
    '50000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b002',
    '00000000-0000-4000-8000-00000000b002',
    'Tenant B Lead', '5511999990002', now() + interval '1 day',
    'scheduled', 'experimental', 'tenant-rls-p0-b'
  );

insert into public.teacher_availability (
  id, teacher_id, day_of_week, start_time, end_time, tenant_id
)
values
  (
    '60000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a002',
    1, '10:00', '11:00', 'tenant-rls-p0-a'
  ),
  (
    '60000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b002',
    2, '10:00', '11:00', 'tenant-rls-p0-b'
  );

insert into public.prospects (
  id, tenant_id, full_name, email, phone, status
)
values
  (
    '70000000-0000-4000-8000-00000000a001',
    'tenant-rls-p0-a', 'Tenant A Prospect',
    'tenant-rls-p0-prospect-a@example.invalid', '5511999991001',
    'PENDING_VERIFICATION'
  ),
  (
    '70000000-0000-4000-8000-00000000b001',
    'tenant-rls-p0-b', 'Tenant B Prospect',
    'tenant-rls-p0-prospect-b@example.invalid', '5511999991002',
    'PENDING_VERIFICATION'
  );

insert into public.opportunities (
  id, student_name, student_phone, slots_proposed,
  status, winner_teacher_id, tenant_id
)
values
  (
    '90000000-0000-4000-8000-00000000a001',
    'Tenant A Claimed Opportunity', '5511999992001', '[]'::jsonb,
    'CLAIMED', '00000000-0000-4000-8000-00000000a002',
    'tenant-rls-p0-a'
  ),
  (
    '90000000-0000-4000-8000-00000000a002',
    'Tenant A Open Opportunity', '5511999992002', '[]'::jsonb,
    'OPEN', null, 'tenant-rls-p0-a'
  ),
  (
    '90000000-0000-4000-8000-00000000b001',
    'Tenant B Claimed Opportunity', '5511999992003', '[]'::jsonb,
    'CLAIMED', '00000000-0000-4000-8000-00000000b002',
    'tenant-rls-p0-b'
  );

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

do $test$
declare
  changed_rows integer;
begin
  begin
    insert into public.prospects (
      id, tenant_id, full_name, email, phone, status
    ) values (
      '70000000-0000-4000-8000-00000000a008',
      'tenant-rls-p0-a', 'Anonymous Poison A',
      'tenant-rls-p0-anon-a@example.invalid', '5511999991081',
      'PENDING_VERIFICATION'
    );
    raise exception 'anonymous caller inserted a prospect in tenant A';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.prospects (
      id, tenant_id, full_name, email, phone, status
    ) values (
      '70000000-0000-4000-8000-00000000b008',
      'tenant-rls-p0-b', 'Anonymous Poison B',
      'tenant-rls-p0-anon-b@example.invalid', '5511999991082',
      'PENDING_VERIFICATION'
    );
    raise exception 'anonymous caller inserted a prospect in tenant B';
  exception
    when insufficient_privilege then null;
  end;

end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}';

insert into public.prospects (
  id, tenant_id, full_name, email, phone, status
) values (
  '70000000-0000-4000-8000-00000000a009',
  'tenant-rls-p0-a', 'Tenant A Staff Prospect',
  'tenant-rls-p0-staff-a@example.invalid', '5511999991091',
  'PENDING_VERIFICATION'
);

select pg_temp.assert_true(
  exists (
    select 1
    from public.prospects
    where id = '70000000-0000-4000-8000-00000000a009'
      and tenant_id = 'tenant-rls-p0-a'
  ),
  'admin A could not insert a prospect in the active tenant'
);

select pg_temp.assert_direct_write_denied(
  $$insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000a009',
      'Tenant A Admin Opportunity', '5511999992091', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-a'
    )$$,
  'admin A inserted an opportunity directly'
);

select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.student_evaluations
   where id in (
     '10000000-0000-4000-8000-00000000a001',
     '10000000-0000-4000-8000-00000000b001'
   )) = array['10000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read evaluations from tenant B'
);
select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.student_insights
   where id in (
     '20000000-0000-4000-8000-00000000a001',
     '20000000-0000-4000-8000-00000000b001'
   )) = array['20000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read insights from tenant B'
);
select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.pedagogical_materials
   where id in (
     '30000000-0000-4000-8000-00000000a001',
     '30000000-0000-4000-8000-00000000b001'
   )) = array['30000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read materials from tenant B'
);
select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.automation_logs
   where id in (
     '40000000-0000-4000-8000-00000000a001',
     '40000000-0000-4000-8000-00000000b001'
   )) = array['40000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read automation logs from tenant B'
);
select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.appointments
   where id in (
     '50000000-0000-4000-8000-00000000a001',
     '50000000-0000-4000-8000-00000000b001'
   )) = array['50000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read appointments from tenant B'
);
select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.teacher_availability
   where id in (
     '60000000-0000-4000-8000-00000000a001',
     '60000000-0000-4000-8000-00000000b001'
   )) = array['60000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read availability from tenant B'
);
select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.prospects
   where id in (
     '70000000-0000-4000-8000-00000000a001',
     '70000000-0000-4000-8000-00000000b001'
   )) = array['70000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read prospects from tenant B'
);
select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.opportunities
   where id in (
     '90000000-0000-4000-8000-00000000a001',
     '90000000-0000-4000-8000-00000000b001'
   )) = array['90000000-0000-4000-8000-00000000a001'::uuid],
  'admin A read opportunities from tenant B'
);

do $test$
declare
  changed_rows integer;
begin
  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Tenant A Admin Updated Opportunity'
      where id = '90000000-0000-4000-8000-00000000a002'$$,
    'admin A updated an opportunity directly'
  );

  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'cross-tenant-opportunity-update'
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'admin A updated an opportunity in tenant B'
  );

  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000a001'$$,
    'admin A deleted an opportunity directly'
  );

  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'admin A deleted an opportunity in tenant B'
  );

  perform pg_temp.assert_direct_write_denied(
    $$update public.appointments
        set student_name = 'cross-tenant-update'
      where id = '50000000-0000-4000-8000-00000000b001'$$,
    'admin A updated an appointment in tenant B'
  );

  delete from public.pedagogical_materials
  where id = '30000000-0000-4000-8000-00000000b001';
  get diagnostics changed_rows = row_count;
  perform pg_temp.assert_true(
    changed_rows = 0,
    'admin A deleted a material in tenant B'
  );

  begin
    insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000b009',
      'Blocked Cross-Tenant Opportunity', '5511999992099', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-b'
    );
    raise exception 'admin A inserted an opportunity in tenant B';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.appointments (
      id, professor_id, teacher_id, student_name,
      start_time, status, type, tenant_id
    ) values (
      '50000000-0000-4000-8000-00000000b009',
      '00000000-0000-4000-8000-00000000b002',
      '00000000-0000-4000-8000-00000000b002',
      'Blocked cross-tenant insert', now() + interval '2 days',
      'scheduled', 'experimental', 'tenant-rls-p0-b'
    );
    raise exception 'admin A inserted an appointment in tenant B';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.prospects (
      id, tenant_id, full_name, email, phone, status
    ) values (
      '70000000-0000-4000-8000-00000000b009',
      'tenant-rls-p0-b', 'Blocked Prospect',
      'tenant-rls-p0-blocked@example.invalid', '5511999991099',
      'PENDING_VERIFICATION'
    );
    raise exception 'admin A inserted a prospect in tenant B';
  exception
    when insufficient_privilege then null;
  end;

end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000c001","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 1
   from public.student_evaluations
   where id in (
     '10000000-0000-4000-8000-00000000a001',
     '10000000-0000-4000-8000-00000000b001'
   ))
  and (select count(*) = 1
       from public.student_insights
       where id in (
         '20000000-0000-4000-8000-00000000a001',
         '20000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 1
       from public.pedagogical_materials
       where id in (
         '30000000-0000-4000-8000-00000000a001',
         '30000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 1
       from public.automation_logs
       where id in (
         '40000000-0000-4000-8000-00000000a001',
         '40000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 1
       from public.appointments
       where id in (
         '50000000-0000-4000-8000-00000000a001',
         '50000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 1
       from public.teacher_availability
       where id in (
         '60000000-0000-4000-8000-00000000a001',
         '60000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 1
       from public.prospects
       where id in (
         '70000000-0000-4000-8000-00000000a001',
         '70000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 1
       from public.opportunities
       where id in (
         '90000000-0000-4000-8000-00000000a001',
         '90000000-0000-4000-8000-00000000b001'
       )),
  'super admin escaped the active tenant A context'
);

do $test$
begin
  begin
    insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000b013',
      'Blocked Super Admin Cross-Tenant Opportunity',
      '5511999992131', '[]'::jsonb, 'OPEN', 'tenant-rls-p0-b'
    );
    raise exception 'super admin A inserted an opportunity in tenant B';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.appointments (
      id, professor_id, teacher_id, student_name,
      start_time, status, type, tenant_id
    ) values (
      '50000000-0000-4000-8000-00000000b013',
      '00000000-0000-4000-8000-00000000b002',
      '00000000-0000-4000-8000-00000000b002',
      'Blocked super admin cross-tenant insert', now() + interval '5 days',
      'scheduled', 'experimental', 'tenant-rls-p0-b'
    );
    raise exception 'super admin A inserted an appointment in tenant B';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.prospects (
      id, tenant_id, full_name, email, phone, status
    ) values (
      '70000000-0000-4000-8000-00000000b013',
      'tenant-rls-p0-b', 'Blocked Super Admin Prospect',
      'tenant-rls-p0-super-blocked@example.invalid', '5511999991130',
      'PENDING_VERIFICATION'
    );
    raise exception 'super admin A inserted a prospect in tenant B';
  exception
    when insufficient_privilege then null;
  end;
end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}';

select pg_temp.assert_true(
  private.tenant_rls_p0_has_active_role(
    '00000000-0000-4000-8000-00000000a002',
    'tenant-rls-p0-a',
    'TEACHER'
  )
  and private.tenant_rls_p0_has_active_membership('tenant-rls-p0-a')
  and private.tenant_rls_p0_has_active_booking(
    '00000000-0000-4000-8000-00000000a002',
    '00000000-0000-4000-8000-00000000a003',
    'tenant-rls-p0-a'
  )
  and not private.tenant_rls_p0_has_active_role(
    '00000000-0000-4000-8000-00000000a002',
    'tenant-rls-p0-b',
    'TEACHER'
  )
  and not private.tenant_rls_p0_has_active_membership('tenant-rls-p0-b')
  and not private.tenant_rls_p0_has_active_booking(
    '00000000-0000-4000-8000-00000000a002',
    '00000000-0000-4000-8000-00000000a003',
    'tenant-rls-p0-b'
  ),
  'private tenant helper leaked active role, membership or booking from tenant B'
);

select pg_temp.assert_true(
  (select count(*) = 1
   from public.appointments
   where id in (
     '50000000-0000-4000-8000-00000000a001',
     '50000000-0000-4000-8000-00000000b001'
   ))
  and (select count(*) = 1
       from public.teacher_availability
       where id in (
         '60000000-0000-4000-8000-00000000a001',
         '60000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 0
       from public.automation_logs
       where id in (
         '40000000-0000-4000-8000-00000000a001',
         '40000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 0
       from public.prospects
       where id in (
         '70000000-0000-4000-8000-00000000a001',
         '70000000-0000-4000-8000-00000000b001'
       )),
  'teacher A escaped owner scope or gained administrative data'
);

select pg_temp.assert_true(
  (select count(*) = 1
   from public.student_evaluations
   where id in (
     '10000000-0000-4000-8000-00000000a001',
     '10000000-0000-4000-8000-00000000b001'
   ))
  and (select count(*) = 1
       from public.student_insights
       where id in (
         '20000000-0000-4000-8000-00000000a001',
         '20000000-0000-4000-8000-00000000b001'
       ))
  and not exists (
    select 1
    from public.student_evaluations
    where id = '10000000-0000-4000-8000-00000000a002'
  )
  and not exists (
    select 1
    from public.student_insights
    where id = '20000000-0000-4000-8000-00000000a002'
  ),
  'teacher A read cross-tenant or unassigned student pedagogy'
);

select pg_temp.assert_true(
  (select count(*)
   from public.opportunities
   where id in (
     '90000000-0000-4000-8000-00000000a001',
     '90000000-0000-4000-8000-00000000a002',
     '90000000-0000-4000-8000-00000000b001'
   )) = 0,
  'teacher A received direct opportunity PII'
);

do $test$
begin
  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Tenant A Teacher Updated Own Opportunity'
      where id = '90000000-0000-4000-8000-00000000a001'$$,
    'teacher A updated their claimed opportunity directly'
  );

  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Teacher Must Not Update Open Opportunity'
      where id = '90000000-0000-4000-8000-00000000a002'$$,
    'teacher A updated an opportunity they had not won'
  );

  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Teacher Must Not Update Tenant B'
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'teacher A updated an opportunity in tenant B'
  );

  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000a001'$$,
    'teacher A deleted an opportunity'
  );

  begin
    insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000a010',
      'Teacher Must Not Insert', '5511999992100', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-a'
    );
    raise exception 'teacher A inserted an opportunity';
  exception
    when insufficient_privilege then null;
  end;
end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000a003","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 1
   from public.student_evaluations
   where id in (
     '10000000-0000-4000-8000-00000000a001',
     '10000000-0000-4000-8000-00000000b001'
   ))
  and (select count(*) = 1
       from public.student_insights
       where id in (
         '20000000-0000-4000-8000-00000000a001',
         '20000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 0
       from public.appointments
       where id in (
         '50000000-0000-4000-8000-00000000a001',
         '50000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 0
       from public.teacher_availability
       where id in (
         '60000000-0000-4000-8000-00000000a001',
         '60000000-0000-4000-8000-00000000b001'
       ))
  and (select count(*) = 0
       from public.opportunities
       where id in (
         '90000000-0000-4000-8000-00000000a001',
         '90000000-0000-4000-8000-00000000a002',
         '90000000-0000-4000-8000-00000000b001'
       )),
  'student A escaped self scope or gained staff scheduling data'
);

insert into public.student_evaluations (
  id, student_id, teacher_id, book_part, score, total_questions, tenant_id
)
values (
  '10000000-0000-4000-8000-00000000a009',
  '00000000-0000-4000-8000-00000000a003',
  null,
  'A1-2', 10, 10, 'tenant-rls-p0-a'
);

do $test$
declare
  changed_rows integer;
begin
  begin
    insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000a011',
      'Student Must Not Insert', '5511999992110', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-a'
    );
    raise exception 'student A inserted an opportunity';
  exception
    when insufficient_privilege then null;
  end;

  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Student Must Not Update'
      where id = '90000000-0000-4000-8000-00000000a001'$$,
    'student A updated an opportunity'
  );

  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000a001'$$,
    'student A deleted an opportunity'
  );

  begin
    insert into public.student_evaluations (
      id, student_id, teacher_id, book_part,
      score, total_questions, tenant_id
    ) values (
      '10000000-0000-4000-8000-00000000b009',
      '00000000-0000-4000-8000-00000000a003',
      '00000000-0000-4000-8000-00000000b002',
      'A1-3', 10, 10, 'tenant-rls-p0-b'
    );
    raise exception 'student A inserted an evaluation in tenant B';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.student_insights (
      id, tenant_id, student_id, content, valid_until
    ) values (
      '20000000-0000-4000-8000-00000000a009',
      'tenant-rls-p0-a',
      '00000000-0000-4000-8000-00000000a003',
      'student-cannot-write-insight', now() + interval '1 day'
    );
    raise exception 'student A inserted an administrative insight';
  exception
    when insufficient_privilege then null;
  end;
end;
$test$;

reset role;
update public.tenant_user_contexts
set tenant_id = 'tenant-rls-p0-b',
    updated_at = now()
where user_id = '00000000-0000-4000-8000-00000000a003';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000a003","role":"authenticated"}';

select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.student_insights
   where id in (
     '20000000-0000-4000-8000-00000000a001',
     '20000000-0000-4000-8000-00000000b001'
   )) = array['20000000-0000-4000-8000-00000000b001'::uuid],
  'multi-tenant student did not follow the active tenant B insight context'
);

select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.student_evaluations
   where id in (
     '10000000-0000-4000-8000-00000000a001',
     '10000000-0000-4000-8000-00000000b001'
   )) = array['10000000-0000-4000-8000-00000000b001'::uuid],
  'multi-tenant student did not follow the active tenant B context'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000a004","role":"authenticated"}';

select pg_temp.assert_true(
  (select pg_catalog.array_agg(id order by id)
   from public.opportunities
   where id in (
     '90000000-0000-4000-8000-00000000a001',
     '90000000-0000-4000-8000-00000000b001'
   )) = array['90000000-0000-4000-8000-00000000a001'::uuid],
  'commercial A read opportunities from tenant B'
);

select pg_temp.assert_direct_write_denied(
  $$insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000a012',
      'Tenant A Commercial Opportunity', '5511999992120', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-a'
    )$$,
  'commercial A inserted an opportunity directly'
);

do $test$
begin
  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Tenant A Commercial Updated Opportunity'
      where id = '90000000-0000-4000-8000-00000000a002'$$,
    'commercial A updated an opportunity directly'
  );

  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Commercial Must Not Update Tenant B'
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'commercial A updated an opportunity in tenant B'
  );

  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000a001'$$,
    'commercial A deleted an opportunity'
  );

  begin
    insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000b012',
      'Commercial Must Not Insert Tenant B', '5511999992121', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-b'
    );
    raise exception 'commercial A inserted an opportunity in tenant B';
  exception
    when insufficient_privilege then null;
  end;
end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000a005","role":"authenticated"}';

do $test$
begin
  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000a001'$$,
    'coordinator A deleted an opportunity in tenant A'
  );

  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'coordinator A deleted an opportunity in tenant B'
  );
end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000b001","role":"authenticated"}';

insert into public.prospects (
  id, tenant_id, full_name, email, phone, status
) values (
  '70000000-0000-4000-8000-00000000b010',
  'tenant-rls-p0-b', 'Tenant B Staff Prospect',
  'tenant-rls-p0-staff-b@example.invalid', '5511999991102',
  'PENDING_VERIFICATION'
);

select pg_temp.assert_direct_write_denied(
  $$insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000b010',
      'Tenant B Admin Opportunity', '5511999992102', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-b'
    )$$,
  'admin B inserted an opportunity directly'
);

select pg_temp.assert_direct_write_denied(
  $$insert into public.appointments (
      id, professor_id, teacher_id, student_name,
      start_time, status, type, tenant_id
    ) values (
      '50000000-0000-4000-8000-00000000b011',
      null,
      '00000000-0000-4000-8000-00000000a002',
      'Teacher-only active membership', now() + interval '3 days',
      'scheduled', 'experimental', 'tenant-rls-p0-b'
    )$$,
  'admin B inserted an appointment directly'
);

select pg_temp.assert_direct_write_denied(
  $$insert into public.appointments (
      id, professor_id, teacher_id, student_name,
      start_time, status, type, tenant_id
    ) values (
      '50000000-0000-4000-8000-00000000b015',
      '00000000-0000-4000-8000-00000000a002',
      null,
      'Legacy professor-only active membership', now() + interval '3 days',
      'scheduled', 'experimental', 'tenant-rls-p0-b'
    )$$,
  'admin B inserted a legacy appointment directly'
);

insert into public.teacher_availability (
  id, teacher_id, day_of_week, start_time, end_time, tenant_id
) values (
  '60000000-0000-4000-8000-00000000b011',
  '00000000-0000-4000-8000-00000000a002',
  3, '12:00', '13:00', 'tenant-rls-p0-b'
);

do $test$
begin
  begin
    insert into public.appointments (
      id, professor_id, teacher_id, student_name,
      start_time, status, type, tenant_id
    ) values (
      '50000000-0000-4000-8000-00000000b012',
      null,
      '00000000-0000-4000-8000-00000000b004',
      'Inactive legacy teacher', now() + interval '4 days',
      'scheduled', 'experimental', 'tenant-rls-p0-b'
    );
    raise exception 'admin B scheduled a teacher without ACTIVE membership';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.teacher_availability (
      id, teacher_id, day_of_week, start_time, end_time, tenant_id
    ) values (
      '60000000-0000-4000-8000-00000000b012',
      '00000000-0000-4000-8000-00000000b004',
      4, '12:00', '13:00', 'tenant-rls-p0-b'
    );
    raise exception 'admin B changed availability for an inactive teacher';
  exception
    when insufficient_privilege then null;
  end;
end;
$test$;

select pg_temp.assert_true(
  (select count(*) = 1
   from public.appointments
   where id in (
     '50000000-0000-4000-8000-00000000a001',
     '50000000-0000-4000-8000-00000000b001'
   ))
  and (select count(*) = 1
       from public.prospects
       where id in (
         '70000000-0000-4000-8000-00000000a001',
         '70000000-0000-4000-8000-00000000b001'
       ))
  and (select pg_catalog.array_agg(id order by id)
       from public.student_insights
       where id in (
         '20000000-0000-4000-8000-00000000a001',
         '20000000-0000-4000-8000-00000000b001'
       )) = array['20000000-0000-4000-8000-00000000b001'::uuid]
  and exists (
    select 1
    from public.teacher_availability
    where id = '60000000-0000-4000-8000-00000000b011'
      and tenant_id = 'tenant-rls-p0-b'
  )
  and not exists (
    select 1
    from public.appointments
    where id = '50000000-0000-4000-8000-00000000b012'
  )
  and not exists (
    select 1
    from public.teacher_availability
    where id = '60000000-0000-4000-8000-00000000b012'
  )
  and exists (
    select 1
    from public.prospects
    where id = '70000000-0000-4000-8000-00000000b010'
      and tenant_id = 'tenant-rls-p0-b'
  )
  and (select pg_catalog.array_agg(id order by id)
       from public.opportunities
       where id in (
         '90000000-0000-4000-8000-00000000a001',
         '90000000-0000-4000-8000-00000000b001'
       )) = array['90000000-0000-4000-8000-00000000b001'::uuid]
  and not exists (
    select 1
    from public.prospects
    where id = '70000000-0000-4000-8000-00000000a009'
  ),
  'admin B did not receive only tenant B data'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000b004","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 0
   from public.opportunities
   where tenant_id = 'tenant-rls-p0-b'),
  'suspended teacher B read tenant opportunities'
);

do $test$
begin
  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Suspended Teacher Must Not Update'
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'suspended teacher B updated an opportunity'
  );

  begin
    insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000b013',
      'Suspended Teacher Must Not Insert', '5511999992130', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-b'
    );
    raise exception 'suspended teacher B inserted an opportunity';
  exception
    when insufficient_privilege then null;
  end;
end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000b005","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) from public.opportunities) = 0
  and (select count(*) from public.appointments) = 0
  and public.get_teacher_opportunity_preview_secure(
    '90000000-0000-4000-8000-00000000b001', 1
  ) ->> 'error' = 'forbidden',
  'suspended profile with ACTIVE membership retained read or preview access'
);

reset role;
update public.tenants
set saas_status = 'blocked'
where id = 'tenant-rls-p0-b';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000b001","role":"authenticated"}';

select pg_temp.assert_true(
  exists (
    select 1 from public.appointments
    where id = '50000000-0000-4000-8000-00000000b001'
  )
  and exists (
    select 1 from public.pedagogical_materials
    where id = '30000000-0000-4000-8000-00000000b001'
  )
  and exists (
    select 1 from public.prospects
    where id = '70000000-0000-4000-8000-00000000b001'
  )
  and exists (
    select 1 from public.opportunities
    where id = '90000000-0000-4000-8000-00000000b001'
  ),
  'blocked tenant lost read access needed for portability'
);

do $test$
declare
  changed_rows integer;
begin
  begin
    insert into public.opportunities (
      id, student_name, student_phone, slots_proposed, status, tenant_id
    ) values (
      '90000000-0000-4000-8000-00000000b014',
      'Blocked Tenant Must Not Insert', '5511999992140', '[]'::jsonb,
      'OPEN', 'tenant-rls-p0-b'
    );
    raise exception 'blocked tenant inserted an opportunity';
  exception
    when insufficient_privilege then null;
  end;

  perform pg_temp.assert_direct_write_denied(
    $$update public.opportunities
        set student_name = 'Blocked Tenant Must Not Update'
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'blocked tenant updated an opportunity'
  );

  perform pg_temp.assert_direct_write_denied(
    $$delete from public.opportunities
      where id = '90000000-0000-4000-8000-00000000b001'$$,
    'blocked tenant deleted an opportunity'
  );

  begin
    insert into public.appointments (
      id, professor_id, teacher_id, student_name,
      start_time, status, type, tenant_id
    ) values (
      '50000000-0000-4000-8000-00000000b014',
      '00000000-0000-4000-8000-00000000b002',
      '00000000-0000-4000-8000-00000000b002',
      'Blocked subscription appointment', now() + interval '6 days',
      'scheduled', 'experimental', 'tenant-rls-p0-b'
    );
    raise exception 'blocked tenant inserted an appointment';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.teacher_availability (
      id, teacher_id, day_of_week, start_time, end_time, tenant_id
    ) values (
      '60000000-0000-4000-8000-00000000b014',
      '00000000-0000-4000-8000-00000000b002',
      5, '12:00', '13:00', 'tenant-rls-p0-b'
    );
    raise exception 'blocked tenant inserted teacher availability';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.pedagogical_materials (
      id, tenant_id, title, file_url, type, scope,
      uploaded_by, approval_status
    ) values (
      '30000000-0000-4000-8000-00000000b014',
      'tenant-rls-p0-b', 'Blocked Tenant Material',
      'https://example.invalid/blocked.pdf', 'PDF', 'TENANT',
      '00000000-0000-4000-8000-00000000b001', 'PENDING'
    );
    raise exception 'blocked tenant inserted pedagogical material';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.prospects (
      id, tenant_id, full_name, email, phone, status
    ) values (
      '70000000-0000-4000-8000-00000000b014',
      'tenant-rls-p0-b', 'Blocked Tenant Prospect',
      'tenant-rls-p0-blocked-plan@example.invalid', '5511999991140',
      'PENDING_VERIFICATION'
    );
    raise exception 'blocked tenant inserted prospect';
  exception
    when insufficient_privilege then null;
  end;

  perform pg_temp.assert_direct_write_denied(
    $$update public.appointments
        set student_name = 'blocked-subscription-update'
      where id = '50000000-0000-4000-8000-00000000b001'$$,
    'blocked tenant updated an appointment'
  );

  delete from public.teacher_availability
  where id = '60000000-0000-4000-8000-00000000b001';
  get diagnostics changed_rows = row_count;
  perform pg_temp.assert_true(
    changed_rows = 0,
    'blocked tenant deleted teacher availability'
  );
end;
$test$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000b003","role":"authenticated"}';

do $test$
begin
  begin
    insert into public.student_evaluations (
      id, student_id, teacher_id, book_part,
      score, total_questions, tenant_id
    ) values (
      '10000000-0000-4000-8000-00000000b014',
      '00000000-0000-4000-8000-00000000b003',
      null, 'A1-BLOCKED', 10, 10, 'tenant-rls-p0-b'
    );
    raise exception 'blocked tenant student inserted an evaluation';
  exception
    when insufficient_privilege then null;
  end;
end;
$test$;

reset role;
rollback;
