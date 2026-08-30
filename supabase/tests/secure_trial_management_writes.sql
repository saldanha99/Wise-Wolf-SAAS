-- Secure trial management: command-only writes and teacher-authoritative booking.

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

grant execute on function pg_temp.assert_direct_write_denied(text, text) to public;

select pg_temp.assert_true(
  (
    select array_agg(policyname::text order by policyname)
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'opportunities'
  ) = array['secure_trial_opportunities_staff_select']::text[]
  and (
    select array_agg(policyname::text order by policyname)
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'appointments'
  ) = array['secure_trial_appointments_select']::text[]
  and (
    select array_agg(policyname::text order by policyname)
      from pg_catalog.pg_policies
     where schemaname = 'public'
       and tablename = 'enrollment_links'
  ) = array['secure_trial_enrollment_links_staff_select']::text[],
  'trial tables retained an unreviewed policy set'
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
  'opportunity read policy exposes teachers/students or lacks tenant guards'
);

do $static_acl$
declare
  table_name text;
begin
  foreach table_name in array array[
    'opportunities', 'appointments', 'enrollment_links'
  ] loop
    perform pg_temp.assert_true(
      pg_catalog.has_table_privilege(
        'authenticated', format('public.%I', table_name), 'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated', format('public.%I', table_name), 'INSERT'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated', format('public.%I', table_name), 'UPDATE'
      )
      and not pg_catalog.has_table_privilege(
        'authenticated', format('public.%I', table_name), 'DELETE'
      )
      and not pg_catalog.has_table_privilege(
        'anon', format('public.%I', table_name), 'SELECT'
      )
      and not pg_catalog.has_table_privilege(
        'anon', format('public.%I', table_name), 'INSERT'
      )
      and not pg_catalog.has_table_privilege(
        'anon', format('public.%I', table_name), 'UPDATE'
      )
      and not pg_catalog.has_table_privilege(
        'anon', format('public.%I', table_name), 'DELETE'
      ),
      format('%s retained unsafe direct privileges', table_name)
    );
  end loop;
end;
$static_acl$;

do $function_acl$
declare
  signature text;
  function_oid regprocedure;
begin
  foreach signature in array array[
    'public.get_teacher_opportunity_preview_secure(uuid,integer)',
    'public.schedule_manual_trial_secure(jsonb)',
    'public.create_vendor_trial_link_secure(jsonb)',
    'public.update_trial_outcome_secure(jsonb)',
    'public.get_opportunity_teacher_dispatch_secure(text,uuid)',
    'public.confirm_vendor_trial_interest_atomic(text,uuid,boolean)'
  ] loop
    function_oid := to_regprocedure(signature);
    perform pg_temp.assert_true(
      function_oid is not null
      and (
        select procedure.prosecdef
          and exists (
            select 1
              from unnest(coalesce(procedure.proconfig, array[]::text[])) setting
             where setting like 'search_path=%'
          )
          from pg_catalog.pg_proc procedure
         where procedure.oid = function_oid
      ),
      format('%s is missing SECURITY DEFINER or a fixed search_path', signature)
    );
  end loop;

  foreach signature in array array[
    'public.get_teacher_opportunity_preview_secure(uuid,integer)',
    'public.schedule_manual_trial_secure(jsonb)',
    'public.create_vendor_trial_link_secure(jsonb)',
    'public.update_trial_outcome_secure(jsonb)'
  ] loop
    perform pg_temp.assert_true(
      not pg_catalog.has_function_privilege('anon', signature, 'EXECUTE')
      and pg_catalog.has_function_privilege(
        'authenticated', signature, 'EXECUTE'
      ),
      format('%s has unsafe client execute privileges', signature)
    );
  end loop;

  perform pg_temp.assert_true(
    not pg_catalog.has_function_privilege(
      'authenticated',
      'public.get_opportunity_teacher_dispatch_secure(text,uuid)',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role',
      'public.get_opportunity_teacher_dispatch_secure(text,uuid)',
      'EXECUTE'
    )
    and
    not pg_catalog.has_function_privilege(
      'anon',
      'public.confirm_vendor_trial_interest_atomic(text,uuid,boolean)',
      'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'authenticated',
      'public.confirm_vendor_trial_interest_atomic(text,uuid,boolean)',
      'EXECUTE'
    )
    and pg_catalog.has_function_privilege(
      'service_role',
      'public.confirm_vendor_trial_interest_atomic(text,uuid,boolean)',
      'EXECUTE'
    ),
    'public confirmation RPC is not service-only'
  );

  foreach signature in array array[
    'private.secure_trial_payload_fingerprint(jsonb)',
    'private.secure_trial_actor_context()',
    'private.secure_trial_portal_origin(text)',
    'private.secure_trial_schedule_conflict(text,uuid,timestamp with time zone,uuid,uuid)'
  ] loop
    function_oid := to_regprocedure(signature);
    perform pg_temp.assert_true(
      function_oid is not null
      and (
        select not procedure.prosecdef
          and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
          and exists (
            select 1
              from unnest(coalesce(procedure.proconfig, array[]::text[])) setting
             where setting like 'search_path=%'
          )
          from pg_catalog.pg_proc procedure
         where procedure.oid = function_oid
      )
      and not pg_catalog.has_function_privilege('anon', signature, 'EXECUTE')
      and not pg_catalog.has_function_privilege(
        'authenticated', signature, 'EXECUTE'
      )
      and not pg_catalog.has_function_privilege(
        'service_role', signature, 'EXECUTE'
      )
      and pg_catalog.has_function_privilege('postgres', signature, 'EXECUTE'),
      format('%s has unsafe or incomplete internal privileges', signature)
    );
  end loop;

  signature := 'private.enforce_vendor_trial_teacher_acceptance()';
  function_oid := to_regprocedure(signature);
  perform pg_temp.assert_true(
    function_oid is not null
    and (
      select procedure.prosecdef
        and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
        and exists (
          select 1
            from unnest(coalesce(procedure.proconfig, array[]::text[])) setting
           where setting like 'search_path=%'
        )
        from pg_catalog.pg_proc procedure
       where procedure.oid = function_oid
    )
    and not pg_catalog.has_function_privilege('anon', signature, 'EXECUTE')
    and not pg_catalog.has_function_privilege(
      'authenticated', signature, 'EXECUTE'
    )
    and not pg_catalog.has_function_privilege(
      'service_role', signature, 'EXECUTE'
    ),
    'vendor trial acceptance trigger helper has unsafe privileges'
  );

  perform pg_temp.assert_true(
    pg_catalog.has_table_privilege(
      'postgres',
      'private.secure_trial_command_receipts',
      'SELECT'
    )
    and pg_catalog.has_table_privilege(
      'postgres',
      'private.secure_trial_command_receipts',
      'INSERT'
    )
    and pg_catalog.has_table_privilege(
      'postgres',
      'private.secure_trial_command_receipts',
      'UPDATE'
    )
    and pg_catalog.has_table_privilege(
      'postgres',
      'private.vendor_trial_teacher_requests',
      'SELECT'
    )
    and pg_catalog.has_table_privilege(
      'postgres',
      'private.vendor_trial_teacher_requests',
      'INSERT'
    )
    and pg_catalog.has_table_privilege(
      'postgres',
      'private.vendor_trial_teacher_requests',
      'UPDATE'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated',
      'private.secure_trial_command_receipts',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'authenticated',
      'private.vendor_trial_teacher_requests',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.secure_trial_command_receipts',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.secure_trial_command_receipts',
      'INSERT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.secure_trial_command_receipts',
      'UPDATE'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.secure_trial_command_receipts',
      'DELETE'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.vendor_trial_teacher_requests',
      'SELECT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.vendor_trial_teacher_requests',
      'INSERT'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.vendor_trial_teacher_requests',
      'UPDATE'
    )
    and not pg_catalog.has_table_privilege(
      'service_role',
      'private.vendor_trial_teacher_requests',
      'DELETE'
    ),
    'private trial tables have unsafe or incomplete internal privileges'
  );
end;
$function_acl$;

insert into public.tenants (id, name, saas_status)
values
  ('secure-trial-a', 'Secure Trial A', 'active'),
  ('secure-trial-b', 'Secure Trial B', 'trial'),
  ('secure-trial-blocked', 'Secure Trial Blocked', 'blocked');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-00000000e001', 'authenticated', 'authenticated', 'secure-admin-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Admin A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e002', 'authenticated', 'authenticated', 'secure-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Teacher A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e003', 'authenticated', 'authenticated', 'secure-other-teacher-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Other Teacher A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e004', 'authenticated', 'authenticated', 'secure-student-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Student A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e005', 'authenticated', 'authenticated', 'secure-salesperson-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Salesperson A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e006', 'authenticated', 'authenticated', 'secure-suspended-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Suspended Admin"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e007', 'authenticated', 'authenticated', 'secure-lifecycle-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Lifecycle Admin"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e008', 'authenticated', 'authenticated', 'secure-lifecycle-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Lifecycle Teacher"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e101', 'authenticated', 'authenticated', 'secure-admin-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Admin B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e102', 'authenticated', 'authenticated', 'secure-teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Teacher B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000e201', 'authenticated', 'authenticated', 'secure-blocked-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Secure Blocked Admin"}', now(), now());

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active', full_name = 'Secure Admin A'
 where id = '00000000-0000-4000-8000-00000000e001';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'TEACHER',
       lifecycle_status = 'active', full_name = 'Secure Teacher A'
 where id = '00000000-0000-4000-8000-00000000e002';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'TEACHER',
       lifecycle_status = 'active', full_name = 'Secure Other Teacher A'
 where id = '00000000-0000-4000-8000-00000000e003';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'STUDENT',
       lifecycle_status = 'active', full_name = 'Secure Student A'
 where id = '00000000-0000-4000-8000-00000000e004';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'SALESPERSON',
       lifecycle_status = 'active', full_name = 'Secure Salesperson A'
 where id = '00000000-0000-4000-8000-00000000e005';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active', full_name = 'Secure Suspended Admin'
 where id = '00000000-0000-4000-8000-00000000e006';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'SCHOOL_ADMIN',
       lifecycle_status = 'suspended', full_name = 'Secure Lifecycle Admin'
 where id = '00000000-0000-4000-8000-00000000e007';
update public.profiles
   set tenant_id = 'secure-trial-a', role = 'TEACHER',
       lifecycle_status = 'suspended', full_name = 'Secure Lifecycle Teacher'
 where id = '00000000-0000-4000-8000-00000000e008';
update public.profiles
   set tenant_id = 'secure-trial-b', role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active', full_name = 'Secure Admin B'
 where id = '00000000-0000-4000-8000-00000000e101';
update public.profiles
   set tenant_id = 'secure-trial-b', role = 'TEACHER',
       lifecycle_status = 'active', full_name = 'Secure Teacher B'
 where id = '00000000-0000-4000-8000-00000000e102';
update public.profiles
   set tenant_id = 'secure-trial-blocked', role = 'SCHOOL_ADMIN',
       lifecycle_status = 'active', full_name = 'Secure Blocked Admin'
 where id = '00000000-0000-4000-8000-00000000e201';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  ('00000000-0000-4000-8000-00000000e001', 'secure-trial-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e001', 'secure-trial-b', 'SCHOOL_ADMIN', 'ACTIVE', false),
  ('00000000-0000-4000-8000-00000000e002', 'secure-trial-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e003', 'secure-trial-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e004', 'secure-trial-a', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e005', 'secure-trial-a', 'SALESPERSON', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e006', 'secure-trial-a', 'SCHOOL_ADMIN', 'SUSPENDED', true),
  ('00000000-0000-4000-8000-00000000e007', 'secure-trial-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e008', 'secure-trial-a', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e101', 'secure-trial-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e102', 'secure-trial-b', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000e201', 'secure-trial-blocked', 'SCHOOL_ADMIN', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-00000000e001', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e002', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e003', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e004', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e005', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e006', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e007', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e008', 'secure-trial-a'),
  ('00000000-0000-4000-8000-00000000e101', 'secure-trial-b'),
  ('00000000-0000-4000-8000-00000000e102', 'secure-trial-b'),
  ('00000000-0000-4000-8000-00000000e201', 'secure-trial-blocked')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.opportunities (
  id, tenant_id, student_name, student_phone, slots_proposed,
  status, kind, conversion_status
)
values
  ('10000000-0000-4000-8000-00000000e001', 'secure-trial-a', 'Secure Read A', '5511999993001', '[]'::jsonb, 'OPEN', 'TRIAL', 'OPEN'),
  ('10000000-0000-4000-8000-00000000e101', 'secure-trial-b', 'Secure Read B', '5511999993101', '[]'::jsonb, 'OPEN', 'TRIAL', 'OPEN');

insert into public.appointments (
  id, tenant_id, teacher_id, professor_id, student_name, student_phone,
  start_time, status, type
)
values
  ('20000000-0000-4000-8000-00000000e001', 'secure-trial-a', '00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000e002', 'Secure Appointment A', '5511999993201', now() + interval '10 days', 'scheduled', 'experimental'),
  ('20000000-0000-4000-8000-00000000e002', 'secure-trial-a', '00000000-0000-4000-8000-00000000e003', '00000000-0000-4000-8000-00000000e003', 'Secure Other Appointment A', '5511999993202', now() + interval '11 days', 'scheduled', 'experimental'),
  ('20000000-0000-4000-8000-00000000e101', 'secure-trial-b', '00000000-0000-4000-8000-00000000e102', '00000000-0000-4000-8000-00000000e102', 'Secure Appointment B', '5511999993211', now() + interval '10 days', 'scheduled', 'experimental');

insert into public.enrollment_links (
  id, tenant_id, opportunity_id, link_token, link_url,
  student_name, status, purpose, expires_at
)
values
  ('30000000-0000-4000-8000-00000000e001', 'secure-trial-a', '10000000-0000-4000-8000-00000000e001', 'secure-trial-link-token-a-000001', 'https://example.invalid/a', 'Secure Read A', 'PENDING', 'ENROLLMENT', now() + interval '30 days'),
  ('30000000-0000-4000-8000-00000000e101', 'secure-trial-b', '10000000-0000-4000-8000-00000000e101', 'secure-trial-link-token-b-000001', 'https://example.invalid/b', 'Secure Read B', 'PENDING', 'ENROLLMENT', now() + interval '30 days');

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e001","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) from public.opportunities where tenant_id = 'secure-trial-a') = 1
  and (select count(*) from public.opportunities where tenant_id = 'secure-trial-b') = 0
  and (select count(*) from public.appointments where tenant_id = 'secure-trial-a') = 2
  and (select count(*) from public.appointments where tenant_id = 'secure-trial-b') = 0
  and (select count(*) from public.enrollment_links where tenant_id = 'secure-trial-a') = 1
  and (select count(*) from public.enrollment_links where tenant_id = 'secure-trial-b') = 0,
  'tenant A staff read tenant B trial data'
);

select pg_temp.assert_direct_write_denied(
  'insert into public.opportunities default values',
  'authenticated inserted an opportunity directly'
);
select pg_temp.assert_direct_write_denied(
  $$update public.opportunities set student_name = 'unsafe' where id = '10000000-0000-4000-8000-00000000e001'$$,
  'authenticated updated an opportunity directly'
);
select pg_temp.assert_direct_write_denied(
  $$delete from public.opportunities where id = '10000000-0000-4000-8000-00000000e001'$$,
  'authenticated deleted an opportunity directly'
);
select pg_temp.assert_direct_write_denied(
  'insert into public.appointments default values',
  'authenticated inserted an appointment directly'
);
select pg_temp.assert_direct_write_denied(
  $$update public.appointments set status = 'completed' where id = '20000000-0000-4000-8000-00000000e001'$$,
  'authenticated updated an appointment directly'
);
select pg_temp.assert_direct_write_denied(
  $$delete from public.appointments where id = '20000000-0000-4000-8000-00000000e001'$$,
  'authenticated deleted an appointment directly'
);
select pg_temp.assert_direct_write_denied(
  'insert into public.enrollment_links default values',
  'authenticated inserted an enrollment link directly'
);
select pg_temp.assert_direct_write_denied(
  $$update public.enrollment_links set status = 'EXPIRED' where id = '30000000-0000-4000-8000-00000000e001'$$,
  'authenticated updated an enrollment link directly'
);
select pg_temp.assert_direct_write_denied(
  $$delete from public.enrollment_links where id = '30000000-0000-4000-8000-00000000e001'$$,
  'authenticated deleted an enrollment link directly'
);

do $manual_schedule$
declare
  payload jsonb := jsonb_build_object(
    'requestId', '40000000-0000-4000-8000-00000000e001',
    'teacherId', '00000000-0000-4000-8000-00000000e002',
    'studentName', 'Secure Manual Trial',
    'studentPhone', '5511999993301',
    'startsAt', (current_date + 20 + time '09:00')
      at time zone 'America/Sao_Paulo'
  );
  result jsonb;
  retry_result jsonb;
begin
  result := public.schedule_manual_trial_secure(
    payload || jsonb_build_object('tenantId', 'secure-trial-b')
  );
  perform pg_temp.assert_true(
    result ->> 'error' = 'invalid_payload',
    'manual RPC accepted a tenant-controlled payload'
  );

  result := public.schedule_manual_trial_secure(payload);
  retry_result := public.schedule_manual_trial_secure(payload);
  perform pg_temp.assert_true(
    coalesce((result ->> 'ok')::boolean, false)
    and not coalesce((result ->> 'idempotent')::boolean, true)
    and result ->> 'state' = 'AWAITING_TEACHER'
    and coalesce((retry_result ->> 'idempotent')::boolean, false)
    and retry_result ->> 'opportunityId' = result ->> 'opportunityId'
    and not exists (
      select 1
        from public.appointments
       where student_name = 'Secure Manual Trial'
    ),
    format('manual request booked or was not idempotent: %s / %s', result, retry_result)
  );

  retry_result := public.schedule_manual_trial_secure(
    jsonb_set(payload, '{studentPhone}', '"5511999993399"'::jsonb)
  );
  perform pg_temp.assert_true(
    retry_result ->> 'error' = 'idempotency_key_reused',
    'manual RPC accepted an idempotency key with another payload'
  );

  result := public.schedule_manual_trial_secure(
    jsonb_set(
      payload,
      '{requestId}',
      '"40000000-0000-4000-8000-00000000e002"'::jsonb
    ) || jsonb_build_object(
      'teacherId', '00000000-0000-4000-8000-00000000e102'
    )
  );
  perform pg_temp.assert_true(
    result ->> 'error' = 'teacher_not_active_for_tenant',
    'manual RPC accepted a teacher from tenant B'
  );
end;
$manual_schedule$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e002","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) from public.opportunities) = 0
  and (select count(*) from public.appointments where teacher_id = '00000000-0000-4000-8000-00000000e002') = 1
  and (select count(*) from public.appointments where teacher_id = '00000000-0000-4000-8000-00000000e003') = 0
  and (select count(*) from public.enrollment_links) = 0,
  'teacher gained opportunity PII, enrollment links or another teacher schedule'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e004","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) from public.opportunities) = 0
  and (select count(*) from public.appointments) = 0
  and (select count(*) from public.enrollment_links) = 0,
  'student gained trial-management reads'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e006","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) from public.opportunities) = 0
  and (select count(*) from public.appointments) = 0
  and (select count(*) from public.enrollment_links) = 0
  and public.schedule_manual_trial_secure(jsonb_build_object(
    'requestId', '40000000-0000-4000-8000-00000000e006',
    'teacherId', '00000000-0000-4000-8000-00000000e002',
    'studentName', 'Suspended Must Fail',
    'studentPhone', '5511999993306',
    'startsAt', (current_date + 21 + time '10:00')
      at time zone 'America/Sao_Paulo'
  )) ->> 'error' = 'forbidden',
  'suspended membership retained trial read/write access'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e007","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) from public.opportunities) = 0
  and (select count(*) from public.appointments) = 0
  and (select count(*) from public.enrollment_links) = 0
  and public.schedule_manual_trial_secure(jsonb_build_object(
    'requestId', '40000000-0000-4000-8000-00000000e007',
    'teacherId', '00000000-0000-4000-8000-00000000e002',
    'studentName', 'Lifecycle Must Fail',
    'studentPhone', '5511999993307',
    'startsAt', (current_date + 21 + time '11:00')
      at time zone 'America/Sao_Paulo'
  )) ->> 'error' = 'forbidden',
  'suspended profile with ACTIVE membership retained access'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e201","role":"authenticated"}';

select pg_temp.assert_true(
  public.schedule_manual_trial_secure(jsonb_build_object(
    'requestId', '40000000-0000-4000-8000-00000000e201',
    'teacherId', '00000000-0000-4000-8000-00000000e002',
    'studentName', 'Blocked Must Fail',
    'studentPhone', '5511999993401',
    'startsAt', (current_date + 21 + time '12:00')
      at time zone 'America/Sao_Paulo'
  )) ->> 'error' = 'tenant_not_operational',
  'blocked tenant scheduled a manual trial'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e005","role":"authenticated"}';

do $vendor_link$
declare
  payload jsonb := jsonb_build_object(
    'requestId', '50000000-0000-4000-8000-00000000e001',
    'teacherId', '00000000-0000-4000-8000-00000000e002',
    'studentName', 'Secure Vendor Trial',
    'studentPhone', '5511999993501',
    'weekday', extract(dow from current_date + 3)::integer,
    'time', '18:00'
  );
  result jsonb;
  retry_result jsonb;
begin
  result := public.create_vendor_trial_link_secure(payload);
  retry_result := public.create_vendor_trial_link_secure(payload);
  perform pg_temp.assert_true(
    coalesce((result ->> 'ok')::boolean, false)
    and result ->> 'state' = 'AWAITING_STUDENT'
    and coalesce((retry_result ->> 'idempotent')::boolean, false)
    and retry_result ->> 'linkId' = result ->> 'linkId'
    and not exists (
      select 1
        from public.appointments
       where student_name = 'Secure Vendor Trial'
    ),
    format('vendor link was not pending/idempotent: %s / %s', result, retry_result)
  );
end;
$vendor_link$;

reset role;
set local role service_role;

select pg_catalog.set_config(
  'app.secure_manual_opportunity_id',
  (select id::text from public.opportunities where student_name = 'Secure Manual Trial'),
  true
);
select pg_catalog.set_config(
  'app.secure_vendor_opportunity_id',
  (select id::text from public.opportunities where student_name = 'Secure Vendor Trial'),
  true
);
select pg_catalog.set_config(
  'app.secure_vendor_link_token',
  (select link_token from public.enrollment_links where student_name = 'Secure Vendor Trial'),
  true
);

select pg_temp.assert_true(
  not exists (
    select 1 from public.appointments
     where student_name = 'Secure Manual Trial'
  ),
  'manual request created an appointment before teacher acceptance'
);

select pg_temp.assert_true(
  public.get_opportunity_teacher_dispatch_secure(
    'secure-trial-a', '10000000-0000-4000-8000-00000000e001'
  ) ->> 'dispatchMode' = 'GENERIC'
  and public.get_opportunity_teacher_dispatch_secure(
    'secure-trial-a',
    current_setting('app.secure_manual_opportunity_id')::uuid
  ) ->> 'dispatchMode' = 'TARGETED'
  and public.get_opportunity_teacher_dispatch_secure(
    'secure-trial-a',
    current_setting('app.secure_manual_opportunity_id')::uuid
  ) ->> 'targetTeacherId' = '00000000-0000-4000-8000-00000000e002'
  and public.get_opportunity_teacher_dispatch_secure(
    'secure-trial-a',
    current_setting('app.secure_vendor_opportunity_id')::uuid
  ) ->> 'dispatchMode' = 'NONE',
  'dispatch guard exposed a directed trial to generic teacher communication'
);

do $claim_requires_student$
declare
  result jsonb;
begin
  begin
    result := public.claim_opportunity_atomic(
      current_setting('app.secure_vendor_opportunity_id')::uuid,
      '00000000-0000-4000-8000-00000000e002',
      1
    );
    raise exception 'teacher claim bypassed student confirmation: %', result;
  exception
    when insufficient_privilege then null;
  end;
  perform pg_temp.assert_true(
    not exists (
      select 1 from public.appointments
       where student_name = 'Secure Vendor Trial'
    ),
    'rejected early claim left an appointment behind'
  );
end;
$claim_requires_student$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e002","role":"authenticated"}';

select pg_temp.assert_true(
  public.get_teacher_opportunity_preview_secure(
    current_setting('app.secure_vendor_opportunity_id')::uuid, 1
  ) ->> 'error' = 'opportunity_not_found',
  'teacher preview exposed a request before student confirmation'
);

reset role;
set local role service_role;

do $public_confirmation$
declare
  token text := current_setting('app.secure_vendor_link_token');
  result jsonb;
  retry_result jsonb;
  legacy_result jsonb;
  appointments_before bigint;
begin
  select count(*) into appointments_before from public.appointments;
  legacy_result := public.confirm_vendor_trial_interest_atomic(
    null,
    current_setting('app.secure_vendor_opportunity_id')::uuid,
    true
  );
  perform pg_temp.assert_true(
    legacy_result ->> 'error' = 'invalid_lookup',
    'legacy UUID lookup remained enabled after opaque-token cutover'
  );
  result := public.confirm_vendor_trial_interest_atomic(token, null, false);
  perform pg_temp.assert_true(
    result ->> 'state' = 'AWAITING_STUDENT'
    and not coalesce((result ->> 'requested')::boolean, true),
    format('GET changed or misreported public confirmation: %s', result)
  );

  result := public.confirm_vendor_trial_interest_atomic(token, null, true);
  retry_result := public.confirm_vendor_trial_interest_atomic(token, null, true);
  perform pg_temp.assert_true(
    coalesce((result ->> 'ok')::boolean, false)
    and result ->> 'state' = 'AWAITING_TEACHER'
    and coalesce((result ->> 'requested')::boolean, false)
    and not coalesce((result ->> 'confirmed')::boolean, true)
    and coalesce((retry_result ->> 'idempotent')::boolean, false)
    and (select count(*) from public.appointments) = appointments_before
    and public.get_opportunity_teacher_dispatch_secure(
      'secure-trial-a',
      current_setting('app.secure_vendor_opportunity_id')::uuid
    ) ->> 'dispatchMode' = 'TARGETED'
    and public.get_opportunity_teacher_dispatch_secure(
      'secure-trial-a',
      current_setting('app.secure_vendor_opportunity_id')::uuid
    ) ->> 'targetTeacherId' = '00000000-0000-4000-8000-00000000e002',
    format('public confirmation booked or was not idempotent: %s / %s', result, retry_result)
  );
end;
$public_confirmation$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e003","role":"authenticated"}';

select pg_temp.assert_true(
  public.get_teacher_opportunity_preview_secure(
    current_setting('app.secure_vendor_opportunity_id')::uuid, 1
  ) ->> 'error' = 'opportunity_not_found',
  'vendor request preview leaked to another teacher'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e008","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) from public.opportunities) = 0
  and public.get_teacher_opportunity_preview_secure(
    current_setting('app.secure_vendor_opportunity_id')::uuid, 1
  ) ->> 'error' = 'forbidden',
  'suspended teacher profile retained direct or preview access'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e002","role":"authenticated"}';

do $safe_preview$
declare
  result jsonb;
begin
  result := public.get_teacher_opportunity_preview_secure(
    current_setting('app.secure_vendor_opportunity_id')::uuid, 1
  );
  perform pg_temp.assert_true(
    coalesce((result ->> 'ok')::boolean, false)
    and result ->> 'student_name' = 'Secure Vendor Trial'
    and not result ? 'student_phone'
    and not result ? 'tenant_id'
    and not result ? 'created_by_vendor_id',
    format('teacher preview failed or exposed restricted data: %s', result)
  );
end;
$safe_preview$;

reset role;
set local role service_role;

do $teacher_acceptance$
declare
  result jsonb;
  manual_result jsonb;
  confirmation jsonb;
  expired_confirmation jsonb;
begin
  result := public.claim_opportunity_atomic(
    current_setting('app.secure_vendor_opportunity_id')::uuid,
    '00000000-0000-4000-8000-00000000e002',
    1
  );
  confirmation := public.confirm_vendor_trial_interest_atomic(
    current_setting('app.secure_vendor_link_token'), null, false
  );
  manual_result := public.claim_opportunity_atomic(
    current_setting('app.secure_manual_opportunity_id')::uuid,
    '00000000-0000-4000-8000-00000000e002',
    1
  );
  perform pg_temp.assert_true(
    coalesce((result ->> 'ok')::boolean, false)
    and coalesce((manual_result ->> 'ok')::boolean, false)
    and confirmation ->> 'state' = 'CONFIRMED'
    and coalesce((confirmation ->> 'confirmed')::boolean, false)
    and exists (
      select 1
        from public.appointments appointment
       where appointment.id = (result ->> 'appointmentId')::uuid
         and appointment.tenant_id = 'secure-trial-a'
         and appointment.teacher_id = '00000000-0000-4000-8000-00000000e002'
         and appointment.professor_id = '00000000-0000-4000-8000-00000000e002'
    ),
    format(
      'authenticated teacher acceptance was not atomic: %s / %s / %s',
      result,
      manual_result,
      confirmation
    )
  );

  update public.enrollment_links
     set expires_at = now() - interval '1 second'
   where link_token = current_setting('app.secure_vendor_link_token');
  expired_confirmation := public.confirm_vendor_trial_interest_atomic(
    current_setting('app.secure_vendor_link_token'), null, false
  );
  perform pg_temp.assert_true(
    expired_confirmation ->> 'error' = 'link_expired',
    'accepted token returned PII after its expiry'
  );
end;
$teacher_acceptance$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e001","role":"authenticated"}';

do $outcomes$
declare
  vendor_opportunity uuid :=
    current_setting('app.secure_vendor_opportunity_id')::uuid;
  manual_opportunity uuid;
  result jsonb;
  retry_result jsonb;
begin
  select id into manual_opportunity
    from public.opportunities
   where student_name = 'Secure Manual Trial';

  result := public.update_trial_outcome_secure(jsonb_build_object(
    'requestId', '60000000-0000-4000-8000-00000000e001',
    'opportunityId', vendor_opportunity,
    'action', 'SET_TRIAL_STATUS',
    'trialStatus', 'DONE'
  ));
  retry_result := public.update_trial_outcome_secure(jsonb_build_object(
    'requestId', '60000000-0000-4000-8000-00000000e001',
    'opportunityId', vendor_opportunity,
    'action', 'SET_TRIAL_STATUS',
    'trialStatus', 'DONE'
  ));
  perform pg_temp.assert_true(
    coalesce((result ->> 'ok')::boolean, false)
    and result ->> 'appointmentStatus' = 'completed'
    and coalesce((retry_result ->> 'idempotent')::boolean, false),
    format('DONE outcome was not atomic/idempotent: %s / %s', result, retry_result)
  );

  result := public.update_trial_outcome_secure(jsonb_build_object(
    'requestId', '60000000-0000-4000-8000-00000000e002',
    'opportunityId', manual_opportunity,
    'action', 'SET_TRIAL_STATUS',
    'trialStatus', 'NO_SHOW_STUDENT'
  ));
  perform pg_temp.assert_true(
    coalesce((result ->> 'ok')::boolean, false)
    and result ->> 'appointmentStatus' = 'no_show',
    format('no-show outcome did not update the appointment: %s', result)
  );

  result := public.update_trial_outcome_secure(jsonb_build_object(
    'requestId', '60000000-0000-4000-8000-00000000e003',
    'opportunityId', '10000000-0000-4000-8000-00000000e101',
    'action', 'MARK_LOST',
    'lostReason', 'cross tenant must fail'
  ));
  perform pg_temp.assert_true(
    result ->> 'error' = 'opportunity_not_found',
    'outcome RPC altered tenant B'
  );
end;
$outcomes$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e002","role":"authenticated"}';

select pg_temp.assert_true(
  coalesce((public.update_trial_outcome_secure(jsonb_build_object(
    'requestId', '60000000-0000-4000-8000-00000000e004',
    'opportunityId', current_setting('app.secure_vendor_opportunity_id')::uuid,
    'action', 'SAVE_FEEDBACK',
    'recommendedLevel', 'A2',
    'recommendedPlan', '2x_semana',
    'interestScore', 5,
    'notes', 'Feedback seguro'
  )) ->> 'ok')::boolean, false),
  'assigned teacher could not save secure feedback'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000e003","role":"authenticated"}';

select pg_temp.assert_true(
  public.update_trial_outcome_secure(jsonb_build_object(
    'requestId', '60000000-0000-4000-8000-00000000e005',
    'opportunityId', current_setting('app.secure_vendor_opportunity_id')::uuid,
    'action', 'SAVE_FEEDBACK',
    'recommendedLevel', 'A2',
    'recommendedPlan', '2x_semana',
    'interestScore', 5,
    'notes', 'Teacher mismatch'
  )) ->> 'error' = 'forbidden',
  'another teacher saved feedback for the trial'
);

reset role;
set local role service_role;

select pg_temp.assert_true(
  exists (
    select 1
      from public.opportunities opportunity
      join public.appointments appointment
        on appointment.id = opportunity.trial_appointment_id
     where opportunity.id =
           current_setting('app.secure_vendor_opportunity_id')::uuid
       and opportunity.trial_status = 'DONE'
       and appointment.status = 'completed'
  )
  and (
    select count(*)
      from public.class_logs class_log
     where class_log.appointment_id = (
       select opportunity.trial_appointment_id::text
         from public.opportunities opportunity
        where opportunity.id =
              current_setting('app.secure_vendor_opportunity_id')::uuid
     )
  ) = 1
  and exists (
    select 1
      from public.opportunities opportunity
      join public.appointments appointment
        on appointment.id = opportunity.trial_appointment_id
     where opportunity.student_name = 'Secure Manual Trial'
       and opportunity.trial_status = 'NO_SHOW_STUDENT'
       and appointment.status = 'no_show'
  ),
  'outcomes left opportunity, appointment or class log inconsistent'
);

rollback;
