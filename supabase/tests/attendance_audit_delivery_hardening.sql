-- Attendance audit: least privilege, intelligent reconciliation, canonical
-- sessions and at-most-once delivery. All fixtures are rolled back.

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

-- Static privilege regression ------------------------------------------------
select pg_temp.assert_true(
  not pg_catalog.has_column_privilege(
    'authenticated', 'public.attendance_confirmations', 'token', 'SELECT'
  )
  and not pg_catalog.has_column_privilege(
    'authenticated', 'public.attendance_confirmations', 'student_phone', 'SELECT'
  )
  and pg_catalog.has_column_privilege(
    'authenticated', 'public.attendance_confirmations', 'status', 'SELECT'
  ),
  'authenticated can read an attendance token/phone or cannot read safe admin fields'
);

select pg_temp.assert_true(
  not pg_catalog.has_table_privilege(
    'authenticated', 'public.attendance_confirmations', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.attendance_confirmations', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.attendance_confirmations', 'DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.class_logs', 'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.class_logs', 'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'public.class_logs', 'DELETE'
  ),
  'browser roles retained direct attendance/class-log DML'
);

select pg_temp.assert_true(
  (select a.attnotnull
     from pg_catalog.pg_attribute a
    where a.attrelid = 'public.attendance_confirmations'::regclass
      and a.attname = 'token_expires_at'
      and not a.attisdropped),
  'attendance token expiration remains nullable'
);

select pg_temp.assert_true(
  pg_catalog.has_function_privilege(
    'anon', 'public.apply_student_response(text,text)', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated', 'public.apply_my_attendance_response(uuid,text)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_attendance_confirmation_deliveries(integer)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.claim_attendance_confirmation_deliveries(integer)',
    'EXECUTE'
  ),
  'attendance RPC ACL contract is unsafe'
);

-- Rows attempted by the legacy sender have no durable provider outcome and no
-- claim metadata. They must remain terminally ambiguous after canonicalization,
-- including attempts that previously reached the retry limit.
select pg_temp.assert_true(
  not exists (
    select 1
      from public.attendance_confirmations ac
     where ac.sent_at is null
       and ac.send_attempts > 0
       and ac.delivery_claimed_at is null
       and (
         ac.delivery_status is distinct from 'AMBIGUOUS'
         or ac.last_delivery_error is distinct from
              'legacy_delivery_attempt_outcome_unknown'
       )
  ),
  'legacy attempted attendance delivery became retryable'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.attendance_confirmations legacy_attempt
      join public.attendance_confirmations session_member
        on coalesce(
             session_member.canonical_confirmation_id,
             session_member.id
           ) = coalesce(
             legacy_attempt.canonical_confirmation_id,
             legacy_attempt.id
           )
     where legacy_attempt.sent_at is null
       and legacy_attempt.send_attempts > 0
       and legacy_attempt.delivery_claimed_at is null
       and legacy_attempt.last_delivery_error =
             'legacy_delivery_attempt_outcome_unknown'
       and session_member.sent_at is null
       and session_member.delivery_status is distinct from 'AMBIGUOUS'
  ),
  'ambiguous legacy attempt was not propagated to its unsent session'
);

-- Tenant and identities -------------------------------------------------------
insert into public.tenants (id, name)
values
  ('attendance-hardening-school', 'Attendance Hardening School'),
  ('attendance-other-school', 'Attendance Other School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'attendance-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Attendance Admin"}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'attendance-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Attendance Teacher"}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'attendance-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Attendance Student"}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated',
    'attendance-session-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Attendance Session Student"}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated',
    'attendance-test-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Attendance Test Student"}', now(), now()
  ),
  (
    '10000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated',
    'attendance-test-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Attendance Test Teacher"}', now(), now()
  );

update public.profiles
   set tenant_id = 'attendance-hardening-school',
       role = 'SCHOOL_ADMIN',
       full_name = 'Attendance Admin'
 where id = '10000000-0000-4000-8000-000000000001';

update public.profiles
   set tenant_id = 'attendance-hardening-school',
       role = 'TEACHER',
       full_name = 'Attendance Teacher',
       phone = '5511999990002'
 where id = '10000000-0000-4000-8000-000000000002';

update public.profiles
   set tenant_id = 'attendance-hardening-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Attendance Student',
       attendance_phone = 'invalid',
       phone = '5511999990003'
 where id = '10000000-0000-4000-8000-000000000003';

update public.profiles
   set tenant_id = 'attendance-hardening-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Attendance Session Student',
       attendance_phone = '5511999990004',
       phone = '5511999990004'
 where id = '10000000-0000-4000-8000-000000000004';

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

update public.profiles
   set tenant_id = 'attendance-hardening-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Attendance Test Student',
       attendance_phone = '5511999990005',
       phone = '5511999990005',
       is_test_account = true,
       test_fixture_key = 'attendance-hardening:test-student'
 where id = '10000000-0000-4000-8000-000000000005';

update public.profiles
   set tenant_id = 'attendance-hardening-school',
       role = 'TEACHER',
       lifecycle_status = 'active',
       full_name = 'Attendance Test Teacher',
       phone = '5511999990006',
       is_test_account = true,
       test_fixture_key = 'attendance-hardening:test-teacher'
 where id = '10000000-0000-4000-8000-000000000006';

select set_config('request.jwt.claims', '{}', true);

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'attendance-hardening-school', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'attendance-hardening-school', 'TEACHER', 'ACTIVE', true
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'attendance-hardening-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'attendance-hardening-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    'attendance-hardening-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '10000000-0000-4000-8000-000000000006',
    'attendance-hardening-school', 'TEACHER', 'ACTIVE', true
  )
on conflict (user_id, tenant_id) do update
  set role = excluded.role,
      status = excluded.status,
      is_primary = excluded.is_primary;

-- Bookings used by reconciliation/late-log tests. English weekday names are
-- accepted by dow_name_to_int and avoid locale-dependent to_char output.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
select
  booking_id,
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  case extract(dow from (now() at time zone 'America/Sao_Paulo')::date)::int
    when 0 then 'Sunday' when 1 then 'Monday' when 2 then 'Tuesday'
    when 3 then 'Wednesday' when 4 then 'Thursday'
    when 5 then 'Friday' else 'Saturday'
  end,
  slot,
  'SCHEDULED',
  (now() at time zone 'America/Sao_Paulo')::date
from (values
  ('20000000-0000-4000-8000-000000000001'::uuid, '10:00'),
  ('20000000-0000-4000-8000-000000000002'::uuid, '11:00'),
  ('20000000-0000-4000-8000-000000000003'::uuid, '12:00'),
  ('20000000-0000-4000-8000-000000000004'::uuid, '12:30'),
  ('20000000-0000-4000-8000-000000000005'::uuid, '14:00'),
  ('20000000-0000-4000-8000-000000000006'::uuid, '14:30'),
  ('20000000-0000-4000-8000-000000000007'::uuid, '16:00')
) fixture(booking_id, slot);

insert into public.attendance_confirmations (
  id, tenant_id, source_id, source_type, teacher_id, student_id,
  student_name, student_phone, teacher_name, class_date, class_time,
  token, token_expires_at, status
)
select
  confirmation_id,
  'attendance-hardening-school',
  booking_id::text,
  'booking',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student',
  '5511999990003',
  'Attendance Teacher',
  (now() at time zone 'America/Sao_Paulo')::date,
  slot,
  token,
  now() + interval '7 days',
  'PENDING'
from (values
  ('30000000-0000-4000-8000-000000000001'::uuid, '20000000-0000-4000-8000-000000000001'::uuid, '10:00', 'attendance-token-01'),
  ('30000000-0000-4000-8000-000000000002'::uuid, '20000000-0000-4000-8000-000000000002'::uuid, '11:00', 'attendance-token-02'),
  ('30000000-0000-4000-8000-000000000003'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, '12:00', 'attendance-token-03'),
  ('30000000-0000-4000-8000-000000000004'::uuid, '20000000-0000-4000-8000-000000000004'::uuid, '12:30', 'attendance-token-04'),
  ('30000000-0000-4000-8000-000000000005'::uuid, '20000000-0000-4000-8000-000000000005'::uuid, '14:00', 'attendance-token-05'),
  ('30000000-0000-4000-8000-000000000006'::uuid, '20000000-0000-4000-8000-000000000006'::uuid, '14:30', 'attendance-token-06'),
  ('30000000-0000-4000-8000-000000000007'::uuid, '20000000-0000-4000-8000-000000000007'::uuid, '16:00', 'attendance-token-07')
) fixture(confirmation_id, booking_id, slot, token);

select private.refresh_attendance_confirmation_sessions(
  (now() at time zone 'America/Sao_Paulo')::date,
  (now() at time zone 'America/Sao_Paulo')::date
);

do $null_expiration_is_rejected$
begin
  begin
    update public.attendance_confirmations
       set token_expires_at = null
     where id = '30000000-0000-4000-8000-000000000001';
    raise exception 'nullable token expiration was accepted';
  exception
    when not_null_violation then null;
  end;
end;
$null_expiration_is_rejected$;

select pg_temp.assert_true(
  (select token_expires_at is not null
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000001'),
  'failed null-expiration write changed the token lifetime'
);

-- A two-slot 08:00+08:30-style session is not eligible when only the first
-- slot ended ten minutes ago. Once the final slot also reaches +10 minutes,
-- both financial members are created and grouped behind one delivery.
insert into public.reschedules (
  id, tenant_id, original_booking_id, teacher_id, student_id,
  date, time, fault_type, created_at
)
values
  (
    '70000000-0000-4000-8000-000000000003',
    'attendance-hardening-school',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000004',
    to_char(
      date_trunc('minute', now() at time zone 'America/Sao_Paulo')
        - interval '40 minutes',
      'YYYY-MM-DD'
    ),
    to_char(
      date_trunc('minute', now() at time zone 'America/Sao_Paulo')
        - interval '40 minutes',
      'HH24:MI'
    ),
    'STUDENT', now()
  ),
  (
    '70000000-0000-4000-8000-000000000004',
    'attendance-hardening-school',
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000004',
    to_char(
      date_trunc('minute', now() at time zone 'America/Sao_Paulo')
        - interval '10 minutes',
      'YYYY-MM-DD'
    ),
    to_char(
      date_trunc('minute', now() at time zone 'America/Sao_Paulo')
        - interval '10 minutes',
      'HH24:MI'
    ),
    'STUDENT', now()
  );

select public.enqueue_attendance_confirmations();

select pg_temp.assert_true(
  not exists (
    select 1
      from public.attendance_confirmations
     where source_type = 'reschedule'
       and source_id in (
         '70000000-0000-4000-8000-000000000003',
         '70000000-0000-4000-8000-000000000004'
       )
  ),
  'multi-slot session was enqueued before its final slot ended +10 minutes'
);

update public.reschedules r
   set date = to_char(
         date_trunc('minute', now() at time zone 'America/Sao_Paulo')
           - case when r.id = '70000000-0000-4000-8000-000000000003'
                  then interval '70 minutes'
                  else interval '40 minutes' end,
         'YYYY-MM-DD'
       ),
       time = to_char(
         date_trunc('minute', now() at time zone 'America/Sao_Paulo')
           - case when r.id = '70000000-0000-4000-8000-000000000003'
                  then interval '70 minutes'
                  else interval '40 minutes' end,
         'HH24:MI'
       )
 where r.id in (
   '70000000-0000-4000-8000-000000000003',
   '70000000-0000-4000-8000-000000000004'
 );

select public.enqueue_attendance_confirmations();

select pg_temp.assert_true(
  (select count(*) = 2
     from public.attendance_confirmations
    where source_type = 'reschedule'
      and source_id in (
        '70000000-0000-4000-8000-000000000003',
        '70000000-0000-4000-8000-000000000004'
      ))
  and (select count(distinct coalesce(canonical_confirmation_id, id)) = 1
         from public.attendance_confirmations
        where source_type = 'reschedule'
          and source_id in (
            '70000000-0000-4000-8000-000000000003',
            '70000000-0000-4000-8000-000000000004'
          ))
  and (select count(*) = 1
         from public.attendance_confirmations
        where source_type = 'reschedule'
          and source_id in (
            '70000000-0000-4000-8000-000000000003',
            '70000000-0000-4000-8000-000000000004'
          )
          and coalesce(canonical_confirmation_id, id) = id
          and delivery_status = 'PENDING'
          and session_end_at + interval '10 minutes' <= now()),
  'ready multi-slot session was not grouped into one canonical delivery'
);

-- An occurrence cannot borrow a student/teacher profile from another tenant.
insert into public.reschedules (
  id, tenant_id, original_booking_id, teacher_id, student_id,
  date, time, fault_type, created_at
)
values (
  '70000000-0000-4000-8000-000000000002',
  'attendance-other-school',
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  to_char(
    now() at time zone 'America/Sao_Paulo' - interval '1 hour',
    'YYYY-MM-DD'
  ),
  to_char(
    now() at time zone 'America/Sao_Paulo' - interval '1 hour',
    'HH24:MI'
  ),
  'STUDENT',
  now()
);

select public.enqueue_attendance_confirmations();

select pg_temp.assert_true(
  not exists (
    select 1
      from public.attendance_confirmations
     where source_type = 'reschedule'
       and source_id = '70000000-0000-4000-8000-000000000002'
  ),
  'cross-tenant occurrence created an attendance delivery'
);

-- Even a deliberately inconsistent historical row must not address a
-- conflict alert using a teacher profile owned by another tenant.
insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, reschedule_id,
  presence, date, class_date, start_time, created_at
)
select
  '40000000-0000-4000-8000-000000000008',
  'attendance-other-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '70000000-0000-4000-8000-000000000002',
  'COMPLETED',
  r.date::date,
  r.date::date,
  r.time::time,
  now()
from public.reschedules r
where r.id = '70000000-0000-4000-8000-000000000002';

insert into public.attendance_confirmations (
  id, tenant_id, source_id, source_type, class_log_id,
  teacher_id, student_id, student_name, student_phone, teacher_name,
  class_date, class_time, token, token_expires_at, status,
  student_response, responded_at, response_updated_at,
  response_editable_until
)
select
  '30000000-0000-4000-8000-000000000008',
  'attendance-other-school',
  '70000000-0000-4000-8000-000000000002',
  'reschedule',
  '40000000-0000-4000-8000-000000000008',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student', '5511999990003', 'Attendance Teacher',
  r.date::date,
  r.time, 'attendance-token-cross-tenant', now() + interval '7 days',
  'PENDING', 'TEACHER_NO_SHOW', now() - interval '31 minutes',
  now() - interval '31 minutes', now() - interval '1 minute'
from public.reschedules r
where r.id = '70000000-0000-4000-8000-000000000002';

select private.refresh_attendance_confirmation_sessions(
  (now() at time zone 'America/Sao_Paulo')::date,
  (now() at time zone 'America/Sao_Paulo')::date
);
select public.reconcile_attendance_confirmation(
  '30000000-0000-4000-8000-000000000008'
);

select pg_temp.assert_true(
  (select status = 'CONFLICT'
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000008')
  and not exists (
    select 1
      from public.notification_queue
     where notification_kind = 'CONFLICT_TEACHER_ALERT'
       and source_id = '30000000-0000-4000-8000-000000000008'
  ),
  'cross-tenant teacher profile was used for a conflict alert'
);

-- Snapshot every mutable attendance/financial/Turbo surface in the isolated
-- fixture tenants. Each rejection below must leave the full snapshot unchanged,
-- not merely return the expected error string.
create or replace function pg_temp.attendance_rejection_state()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'confirmations', (
      select coalesce(
        jsonb_agg(to_jsonb(ac) order by ac.id),
        '[]'::jsonb
      )
        from public.attendance_confirmations ac
       where ac.tenant_id in (
         'attendance-hardening-school',
         'attendance-other-school'
       )
    ),
    'class_logs', (
      select coalesce(
        jsonb_agg(to_jsonb(cl) order by cl.id),
        '[]'::jsonb
      )
        from public.class_logs cl
       where cl.tenant_id in (
         'attendance-hardening-school',
         'attendance-other-school'
       )
    ),
    'reschedules', (
      select coalesce(
        jsonb_agg(to_jsonb(r) order by r.id),
        '[]'::jsonb
      )
        from public.reschedules r
       where r.tenant_id in (
         'attendance-hardening-school',
         'attendance-other-school'
       )
    ),
    'turbo_state', (
      select coalesce(
        jsonb_agg(to_jsonb(s) order by s.teacher_id),
        '[]'::jsonb
      )
        from public.teacher_turbo_state s
       where s.tenant_id in (
         'attendance-hardening-school',
         'attendance-other-school'
       )
    ),
    'turbo_disputes', (
      select coalesce(
        jsonb_agg(to_jsonb(d) order by d.confirmation_id),
        '[]'::jsonb
      )
        from public.teacher_turbo_disputes d
       where d.tenant_id in (
         'attendance-hardening-school',
         'attendance-other-school'
       )
    ),
    'turbo_events', (
      select coalesce(
        jsonb_agg(to_jsonb(e) order by e.id),
        '[]'::jsonb
      )
        from public.teacher_turbo_events e
       where e.tenant_id in (
         'attendance-hardening-school',
         'attendance-other-school'
       )
    )
  );
$$;

create temporary table attendance_rejection_snapshots (
  case_key text primary key,
  state jsonb not null
) on commit drop;

-- A director RPC is SECURITY DEFINER, so it must reject a confirmation that
-- points at a financial log from another school before changing either row.
-- The booking source itself is real and fully valid; only class_log.tenant_id is
-- crossed, so this regression cannot pass for an unrelated source error.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
select
  '20000000-0000-4000-8000-00000000000a',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  case extract(dow from cl.class_date)::int
    when 0 then 'Sunday' when 1 then 'Monday' when 2 then 'Tuesday'
    when 3 then 'Wednesday' when 4 then 'Thursday'
    when 5 then 'Friday' else 'Saturday'
  end,
  to_char(cl.start_time, 'HH24:MI'),
  'SCHEDULED',
  cl.class_date
from public.class_logs cl
where cl.id = '40000000-0000-4000-8000-000000000008';

insert into public.attendance_confirmations (
  id, tenant_id, source_id, source_type, class_log_id,
  teacher_id, student_id, student_name, student_phone, teacher_name,
  class_date, class_time, token, token_expires_at, status,
  student_response, responded_at, response_updated_at,
  response_editable_until
)
select
  '30000000-0000-4000-8000-00000000000a',
  'attendance-hardening-school',
  '20000000-0000-4000-8000-00000000000a',
  'booking',
  cl.id,
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student', '5511999990003', 'Attendance Teacher',
  cl.class_date,
  to_char(cl.start_time, 'HH24:MI'),
  'attendance-token-cross-school-log', now() + interval '7 days',
  'AWAITING_TEACHER', 'TEACHER_NO_SHOW', now() - interval '31 minutes',
  now() - interval '31 minutes', now() - interval '1 minute'
from public.class_logs cl
where cl.id = '40000000-0000-4000-8000-000000000008';

insert into pg_temp.attendance_rejection_snapshots (case_key, state)
values ('cross_tenant_class_log', pg_temp.attendance_rejection_state());

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-00000000000a',
    'TEACHER_ABSENT',
    'must reject cross-school class log'
  )->>'error') = 'dados_inconsistentes',
  'director resolved a confirmation through another school class log'
);
reset role;

select pg_temp.assert_true(
  (select status = 'AWAITING_TEACHER'
          and resolved_at is null
          and resolution_verdict is null
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-00000000000a'),
  'rejected cross-school class log resolution mutated the confirmation'
);

select pg_temp.assert_true(
  (select snapshot.state = pg_temp.attendance_rejection_state()
     from pg_temp.attendance_rejection_snapshots snapshot
    where snapshot.case_key = 'cross_tenant_class_log'),
  'cross-school class log rejection mutated a confirmation, log, reschedule or Turbo'
);

delete from public.attendance_confirmations
 where id = '30000000-0000-4000-8000-00000000000a';
delete from public.bookings
 where id = '20000000-0000-4000-8000-00000000000a';

-- A linked historical log must still prove the immutable snapshot time. The
-- booking has since moved to 18:00, the confirmation preserved 17:00, and the
-- linked log belongs to that source but starts at 17:30. Older consistency code
-- accepted the booking fallback plus source id while ignoring the log time.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
values (
  '20000000-0000-4000-8000-00000000000b',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  case extract(dow from (now() at time zone 'America/Sao_Paulo')::date)::int
    when 0 then 'Sunday' when 1 then 'Monday' when 2 then 'Tuesday'
    when 3 then 'Wednesday' when 4 then 'Thursday'
    when 5 then 'Friday' else 'Saturday'
  end,
  '18:00', 'SCHEDULED',
  (now() at time zone 'America/Sao_Paulo')::date
);

set local session_replication_role = replica;
insert into public.class_logs (
  id, tenant_id, teacher_id, student_id,
  booking_id, presence, date, class_date, start_time, created_at
)
values (
  '40000000-0000-4000-8000-00000000000b',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-00000000000b',
  'COMPLETED',
  (now() at time zone 'America/Sao_Paulo')::date,
  (now() at time zone 'America/Sao_Paulo')::date,
  '17:30', now()
);
set local session_replication_role = origin;

insert into public.attendance_confirmations (
  id, tenant_id, source_id, source_type, class_log_id,
  teacher_id, student_id, student_name, student_phone, teacher_name,
  class_date, class_time, token, token_expires_at, status,
  student_response, responded_at, response_updated_at,
  response_editable_until
)
values (
  '30000000-0000-4000-8000-00000000000b',
  'attendance-hardening-school',
  '20000000-0000-4000-8000-00000000000b',
  'booking',
  '40000000-0000-4000-8000-00000000000b',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student', '5511999990003', 'Attendance Teacher',
  (now() at time zone 'America/Sao_Paulo')::date,
  '17:00', 'attendance-token-wrong-legacy-log-time',
  now() + interval '7 days',
  'AWAITING_TEACHER', 'TEACHER_NO_SHOW', now() - interval '31 minutes',
  now() - interval '31 minutes', now() - interval '1 minute'
);

insert into pg_temp.attendance_rejection_snapshots (case_key, state)
values ('wrong_legacy_log_time', pg_temp.attendance_rejection_state());

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-00000000000b',
    'TEACHER_ABSENT',
    'must reject a linked source log from another time'
  )->>'error') = 'dados_inconsistentes',
  'director resolved a confirmation through a linked log from another time'
);
reset role;

select pg_temp.assert_true(
  (select snapshot.state = pg_temp.attendance_rejection_state()
     from pg_temp.attendance_rejection_snapshots snapshot
    where snapshot.case_key = 'wrong_legacy_log_time'),
  'wrong-time legacy log rejection mutated a confirmation, log, reschedule or Turbo'
);

delete from public.attendance_confirmations
 where id = '30000000-0000-4000-8000-00000000000b';
delete from public.class_logs
 where id = '40000000-0000-4000-8000-00000000000b';
delete from public.bookings
 where id = '20000000-0000-4000-8000-00000000000b';

-- A real source row still cannot be borrowed across schools, even when there is
-- no class_log_id to expose the mismatch through the financial record.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
values (
  '20000000-0000-4000-8000-00000000000c',
  'attendance-other-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  case extract(dow from (now() at time zone 'America/Sao_Paulo')::date)::int
    when 0 then 'Sunday' when 1 then 'Monday' when 2 then 'Tuesday'
    when 3 then 'Wednesday' when 4 then 'Thursday'
    when 5 then 'Friday' else 'Saturday'
  end,
  '18:00', 'SCHEDULED',
  (now() at time zone 'America/Sao_Paulo')::date
);

insert into public.attendance_confirmations (
  id, tenant_id, source_id, source_type, class_log_id,
  teacher_id, student_id, student_name, student_phone, teacher_name,
  class_date, class_time, token, token_expires_at, status,
  student_response, responded_at, response_updated_at,
  response_editable_until
)
values (
  '30000000-0000-4000-8000-00000000000c',
  'attendance-hardening-school',
  '20000000-0000-4000-8000-00000000000c',
  'booking', null,
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student', '5511999990003', 'Attendance Teacher',
  (now() at time zone 'America/Sao_Paulo')::date,
  '18:00', 'attendance-token-cross-tenant-source',
  now() + interval '7 days',
  'AWAITING_TEACHER', 'TEACHER_NO_SHOW', now() - interval '31 minutes',
  now() - interval '31 minutes', now() - interval '1 minute'
);

insert into pg_temp.attendance_rejection_snapshots (case_key, state)
values ('cross_tenant_source', pg_temp.attendance_rejection_state());

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-00000000000c',
    'TEACHER_ABSENT',
    'must reject another school source'
  )->>'error') = 'dados_inconsistentes',
  'director resolved a confirmation through another school source'
);
reset role;

select pg_temp.assert_true(
  (select snapshot.state = pg_temp.attendance_rejection_state()
     from pg_temp.attendance_rejection_snapshots snapshot
    where snapshot.case_key = 'cross_tenant_source'),
  'cross-school source rejection mutated a confirmation, log, reschedule or Turbo'
);

delete from public.attendance_confirmations
 where id = '30000000-0000-4000-8000-00000000000c';
delete from public.bookings
 where id = '20000000-0000-4000-8000-00000000000c';

-- Every grouped member must carry the immutable canonical session_key. Both
-- bookings and both snapshots are otherwise valid and contiguous.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
select
  booking_id,
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  case extract(dow from (now() at time zone 'America/Sao_Paulo')::date)::int
    when 0 then 'Sunday' when 1 then 'Monday' when 2 then 'Tuesday'
    when 3 then 'Wednesday' when 4 then 'Thursday'
    when 5 then 'Friday' else 'Saturday'
  end,
  slot,
  'SCHEDULED',
  (now() at time zone 'America/Sao_Paulo')::date
from (values
  ('20000000-0000-4000-8000-00000000000d'::uuid, '20:00'),
  ('20000000-0000-4000-8000-00000000000e'::uuid, '20:30')
) fixture(booking_id, slot);

insert into public.attendance_confirmations (
  id, tenant_id, source_id, source_type,
  teacher_id, student_id, student_name, student_phone, teacher_name,
  class_date, class_time, token, token_expires_at, status,
  student_response, responded_at, response_updated_at,
  response_editable_until, session_key, canonical_confirmation_id
)
values
  (
    '30000000-0000-4000-8000-00000000000d',
    'attendance-hardening-school',
    '20000000-0000-4000-8000-00000000000d', 'booking',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'Attendance Student', '5511999990003', 'Attendance Teacher',
    (now() at time zone 'America/Sao_Paulo')::date,
    '20:00', 'attendance-token-session-key-canonical',
    now() + interval '7 days',
    'AWAITING_TEACHER', 'TEACHER_NO_SHOW', now() - interval '31 minutes',
    now() - interval '31 minutes', now() - interval '1 minute',
    'attendance-regression-session-canonical',
    '30000000-0000-4000-8000-00000000000d'
  ),
  (
    '30000000-0000-4000-8000-00000000000e',
    'attendance-hardening-school',
    '20000000-0000-4000-8000-00000000000e', 'booking',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'Attendance Student', '5511999990003', 'Attendance Teacher',
    (now() at time zone 'America/Sao_Paulo')::date,
    '20:30', 'attendance-token-session-key-member',
    now() + interval '7 days',
    'AWAITING_TEACHER', 'TEACHER_NO_SHOW', now() - interval '31 minutes',
    now() - interval '31 minutes', now() - interval '1 minute',
    'attendance-regression-session-member-wrong',
    '30000000-0000-4000-8000-00000000000d'
  );

insert into pg_temp.attendance_rejection_snapshots (case_key, state)
values ('mismatched_member_session_key', pg_temp.attendance_rejection_state());

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-00000000000d',
    'TEACHER_ABSENT',
    'must reject a member from another logical session'
  )->>'error') = 'dados_inconsistentes',
  'director resolved a canonical session with a mismatched member session_key'
);
reset role;

select pg_temp.assert_true(
  (select snapshot.state = pg_temp.attendance_rejection_state()
     from pg_temp.attendance_rejection_snapshots snapshot
    where snapshot.case_key = 'mismatched_member_session_key'),
  'session-key rejection mutated a confirmation, log, reschedule or Turbo'
);

delete from public.attendance_confirmations
 where id = '30000000-0000-4000-8000-00000000000e';
delete from public.attendance_confirmations
 where id = '30000000-0000-4000-8000-00000000000d';
delete from public.bookings
 where id in (
   '20000000-0000-4000-8000-00000000000d',
   '20000000-0000-4000-8000-00000000000e'
 );

-- A confirmed coverage transfers the attendance audit to the teacher who
-- actually taught the class. Use a real, active, non-test substitute identity
-- and a recently finished occurrence so this exercises the production enqueue
-- path instead of manufacturing the expected confirmation.
insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '10000000-0000-4000-8000-000000000007',
  'authenticated', 'authenticated',
  'attendance-cover-teacher@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Attendance Cover Teacher"}', now(), now()
);

update public.profiles
   set tenant_id = 'attendance-hardening-school',
       role = 'TEACHER',
       lifecycle_status = 'active',
       full_name = 'Attendance Cover Teacher',
       phone = '5511999990007',
       is_test_account = false,
       test_fixture_key = null
 where id = '10000000-0000-4000-8000-000000000007';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values (
  '10000000-0000-4000-8000-000000000007',
  'attendance-hardening-school', 'TEACHER', 'ACTIVE', true
)
on conflict (user_id, tenant_id) do update
  set role = excluded.role,
      status = excluded.status,
      is_primary = excluded.is_primary;

select pg_temp.assert_true(
  exists (
    select 1
      from auth.users auth_user
      join public.profiles profile on profile.id = auth_user.id
      join public.tenant_memberships membership
        on membership.user_id = profile.id
       and membership.tenant_id = profile.tenant_id
     where auth_user.id = '10000000-0000-4000-8000-000000000007'
       and profile.tenant_id = 'attendance-hardening-school'
       and profile.role = 'TEACHER'
       and lower(btrim(profile.lifecycle_status)) = 'active'
       and profile.is_test_account is false
       and membership.role = 'TEACHER'
       and membership.status = 'ACTIVE'
  ),
  'confirmed-coverage substitute is not a real active non-test teacher'
);

with local_clock as (
  select now() at time zone 'America/Sao_Paulo' as local_now
), occurrence as (
  select date_trunc('hour', local_now)
         + case when extract(minute from local_now) >= 30
                then interval '30 minutes' else interval '0 minutes' end
         - interval '1 hour' as starts_at
    from local_clock
)
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
select
  '20000000-0000-4000-8000-00000000000f',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  -- Keep this clock-derived occurrence on its dedicated student. Otherwise a
  -- release run can land on one of the fixed reconciliation slots above and
  -- trip the real duplicate-booking guard before exercising coverage routing.
  '10000000-0000-4000-8000-000000000004',
  case extract(dow from starts_at)::int
    when 0 then 'Sunday' when 1 then 'Monday' when 2 then 'Tuesday'
    when 3 then 'Wednesday' when 4 then 'Thursday'
    when 5 then 'Friday' else 'Saturday'
  end,
  to_char(starts_at, 'HH24:MI'),
  'SCHEDULED',
  starts_at::date
from occurrence;

insert into public.teacher_absences (
  id, tenant_id, teacher_id, starts_at, ends_at, reason, status
)
select
  '50000000-0000-4000-8000-00000000000f',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  booking.start_date,
  booking.start_date,
  'OTHER',
  'ACTIVE'
from public.bookings booking
where booking.id = '20000000-0000-4000-8000-00000000000f';

-- The strict coverage trigger deliberately rejects historical inserts because
-- real coverages must be arranged before the class. Disable user triggers only
-- for this single historical fixture statement and restore them immediately.
set local session_replication_role = replica;
insert into public.class_coverages (
  id, original_teacher_id, cover_teacher_id, student_id,
  booking_id, absence_id, tenant_id, class_date, class_time,
  status, token, notes, confirmed_at, dispatched_at, invite_expires_at
)
select
  '60000000-0000-4000-8000-00000000000f',
  booking.teacher_id,
  '10000000-0000-4000-8000-000000000007',
  booking.student_id,
  booking.id,
  '50000000-0000-4000-8000-00000000000f',
  booking.tenant_id,
  booking.start_date,
  booking.time_slot,
  'confirmed',
  null,
  'Confirmed coverage attendance regression',
  now() - interval '90 minutes',
  null,
  null
from public.bookings booking
where booking.id = '20000000-0000-4000-8000-00000000000f';
set local session_replication_role = origin;

select pg_temp.assert_true(
  public.enqueue_attendance_confirmations() >= 1,
  'enqueue did not create the recently finished covered occurrence'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.attendance_confirmations confirmation
     where confirmation.tenant_id = 'attendance-hardening-school'
       and confirmation.source_type = 'booking'
       and confirmation.source_id =
             '20000000-0000-4000-8000-00000000000f'
       and confirmation.teacher_id =
             '10000000-0000-4000-8000-000000000007'
       and confirmation.teacher_name = 'Attendance Cover Teacher'
  )
  and not exists (
    select 1
      from public.attendance_confirmations confirmation
     where confirmation.tenant_id = 'attendance-hardening-school'
       and confirmation.source_type = 'booking'
       and confirmation.source_id =
             '20000000-0000-4000-8000-00000000000f'
       and confirmation.teacher_id =
             '10000000-0000-4000-8000-000000000002'
  ),
  'confirmed coverage audit was addressed to the original teacher'
);

select confirmation.id as covered_confirmation_id
  from public.attendance_confirmations confirmation
 where confirmation.tenant_id = 'attendance-hardening-school'
   and confirmation.source_type = 'booking'
   and confirmation.source_id = '20000000-0000-4000-8000-00000000000f'
\gset

select pg_temp.assert_true(
  private.attendance_session_is_consistent(:'covered_confirmation_id'::uuid),
  'correct substitute confirmation is not internally processable'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'private.attendance_session_is_consistent(uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'private.attendance_session_is_consistent(uuid)',
    'EXECUTE'
  ),
  'private attendance consistency helper was exposed as an RPC'
);

-- Simulate historical corruption after proving the enqueue output: the same
-- covered occurrence now falsely points back to the original teacher and is
-- made mature enough to reach the director's consistency gate.
update public.attendance_confirmations
   set teacher_id = '10000000-0000-4000-8000-000000000002',
       teacher_name = 'Attendance Teacher',
       session_key = 'attendance:' || md5(
         tenant_id || '|' ||
         '10000000-0000-4000-8000-000000000002' || '|' ||
         student_id::text || '|' ||
         class_date::text || '|' ||
         (left(btrim(class_time), 5)::time)::text
       ),
       status = 'AWAITING_TEACHER',
       student_response = 'TEACHER_NO_SHOW',
       responded_at = now() - interval '31 minutes',
       response_updated_at = now() - interval '31 minutes',
       response_editable_until = now() - interval '1 minute'
 where id = :'covered_confirmation_id'::uuid;

select pg_temp.assert_true(
  not private.attendance_session_is_consistent(
    :'covered_confirmation_id'::uuid
  ),
  'original-teacher tampering remained internally consistent despite coverage'
);

insert into pg_temp.attendance_rejection_snapshots (case_key, state)
values (
  'confirmed_coverage_original_teacher_tamper',
  pg_temp.attendance_rejection_state()
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    :'covered_confirmation_id'::uuid,
    'TEACHER_ABSENT',
    'must reject the original teacher after confirmed coverage'
  )->>'error') = 'dados_inconsistentes',
  'director penalized the original teacher for a confirmed covered occurrence'
);
reset role;

select pg_temp.assert_true(
  (
    select confirmation.teacher_id =
             '10000000-0000-4000-8000-000000000002'
           and confirmation.teacher_name = 'Attendance Teacher'
           and confirmation.status = 'AWAITING_TEACHER'
           and confirmation.resolved_at is null
           and confirmation.resolution_verdict is null
      from public.attendance_confirmations confirmation
     where confirmation.id = :'covered_confirmation_id'::uuid
  )
  and (
    select snapshot.state = pg_temp.attendance_rejection_state()
      from pg_temp.attendance_rejection_snapshots snapshot
     where snapshot.case_key =
           'confirmed_coverage_original_teacher_tamper'
  )
  and exists (
    select 1
      from public.class_coverages coverage
     where coverage.id = '60000000-0000-4000-8000-00000000000f'
       and lower(coverage.status) = 'confirmed'
       and coverage.original_teacher_id =
             '10000000-0000-4000-8000-000000000002'
       and coverage.cover_teacher_id =
             '10000000-0000-4000-8000-000000000007'
  ),
  'covered-occurrence rejection mutated attendance, coverage or Turbo state'
);

delete from public.attendance_confirmations
 where id = :'covered_confirmation_id'::uuid;
delete from public.class_coverages
 where id = '60000000-0000-4000-8000-00000000000f';
delete from public.teacher_absences
 where id = '50000000-0000-4000-8000-00000000000f';
delete from public.bookings
 where id = '20000000-0000-4000-8000-00000000000f';
delete from public.tenant_memberships
 where user_id = '10000000-0000-4000-8000-000000000007'
   and tenant_id = 'attendance-hardening-school';
delete from public.teacher_turbo_disputes
 where teacher_id = '10000000-0000-4000-8000-000000000007';
delete from public.teacher_turbo_events
 where teacher_id = '10000000-0000-4000-8000-000000000007';
delete from public.teacher_turbo_state
 where teacher_id = '10000000-0000-4000-8000-000000000007';
delete from public.profiles
 where id = '10000000-0000-4000-8000-000000000007';
delete from auth.users
 where id = '10000000-0000-4000-8000-000000000007';

select pg_temp.assert_true(
  not exists (
    select 1
      from auth.users
     where id = '10000000-0000-4000-8000-000000000007'
  )
  and not exists (
    select 1
      from public.bookings
     where id = '20000000-0000-4000-8000-00000000000f'
  )
  and not exists (
    select 1
      from public.class_coverages
     where id = '60000000-0000-4000-8000-00000000000f'
  )
  and not exists (
    select 1
      from public.attendance_confirmations
     where id = :'covered_confirmation_id'::uuid
  ),
  'confirmed-coverage attendance fixtures were not cleaned'
);

drop table pg_temp.attendance_rejection_snapshots;
drop function pg_temp.attendance_rejection_state();

-- The earlier cross-tenant alert fixtures are no longer used below.
delete from public.attendance_confirmations
 where id = '30000000-0000-4000-8000-000000000008';
delete from public.class_logs
 where id = '40000000-0000-4000-8000-000000000008';
delete from public.reschedules
 where id = '70000000-0000-4000-8000-000000000002';

-- A pending audit is not a dispute and cannot be finalized by an admin/agent.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-000000000001',
    'DO_NOT_PAY',
    'must not mutate pending audit'
  )->>'error') = 'estado_invalido',
  'PENDING audit was accepted as a financial dispute'
);
reset role;

select pg_temp.assert_true(
  (select status = 'PENDING'
          and resolved_at is null
          and resolution_verdict is null
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000001'),
  'rejected PENDING resolution mutated the audit'
);

insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name, student_phone,
  teacher_name, class_date, class_time, token, token_expires_at,
  status, student_response, responded_at, response_updated_at,
  response_editable_until
)
values (
  '30000000-0000-4000-8000-000000000009',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student', '5511999990003', 'Attendance Teacher',
  (now() at time zone 'America/Sao_Paulo')::date,
  '19:00', 'attendance-token-light-conflict', now() + interval '7 days',
  'CONFLICT', 'STUDENT_PRESENT', now() - interval '31 minutes',
  now() - interval '31 minutes', now() - interval '1 minute'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-000000000009',
    'DO_NOT_PAY',
    'must not penalize an attendance mismatch'
  )->>'error') = 'resposta_incompativel',
  'non-no-show CONFLICT accepted a financial penalty'
);
reset role;

select pg_temp.assert_true(
  (select status = 'CONFLICT'
          and resolved_at is null
          and resolution_verdict is null
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000009'),
  'rejected non-no-show resolution mutated the audit'
);

insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, booking_id,
  presence, date, class_date, start_time, created_at
)
values
  (
    '40000000-0000-4000-8000-000000000001',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000001',
    'STUDENT_ABSENCE',
    (now() at time zone 'America/Sao_Paulo')::date,
    (now() at time zone 'America/Sao_Paulo')::date,
    '10:00', now()
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000002',
    'COMPLETED',
    (now() at time zone 'America/Sao_Paulo')::date,
    (now() at time zone 'America/Sao_Paulo')::date,
    '11:00', now()
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000003',
    'COMPLETED',
    (now() at time zone 'America/Sao_Paulo')::date,
    (now() at time zone 'America/Sao_Paulo')::date,
    '12:00', now()
  ),
  (
    '40000000-0000-4000-8000-000000000004',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
    'COMPLETED',
    (now() at time zone 'America/Sao_Paulo')::date,
    (now() at time zone 'America/Sao_Paulo')::date,
    '12:30', now()
  ),
  (
    '40000000-0000-4000-8000-000000000005',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'COMPLETED',
    (now() at time zone 'America/Sao_Paulo')::date,
    (now() at time zone 'America/Sao_Paulo')::date,
    '14:00', now()
  ),
  (
    '40000000-0000-4000-8000-000000000006',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000006',
    'COMPLETED',
    (now() at time zone 'America/Sao_Paulo')::date,
    (now() at time zone 'America/Sao_Paulo')::date,
    '14:30', now()
  );

-- Student-authenticated responses: light mismatches do not hold payment. ------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select pg_temp.assert_true(
  (public.apply_my_attendance_response(
    '30000000-0000-4000-8000-000000000001', 'STUDENT_PRESENT'
  )->>'ok')::boolean,
  'student could not answer own attendance audit'
);

select pg_temp.assert_true(
  (public.apply_my_attendance_response(
    '30000000-0000-4000-8000-000000000002', 'STUDENT_SELF_ABSENT'
  )->>'ok')::boolean,
  'student could not report own absence'
);

reset role;

select pg_temp.assert_true(
  (select status = 'ATTENDANCE_MISMATCH'
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000001')
  and not (select payment_hold
             from public.class_logs
            where id = '40000000-0000-4000-8000-000000000001'),
  'STUDENT_ABSENCE + STUDENT_PRESENT held teacher payment'
);

select pg_temp.assert_true(
  (select status = 'ATTENDANCE_MISMATCH'
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000002')
  and not (select payment_hold
             from public.class_logs
            where id = '40000000-0000-4000-8000-000000000002'),
  'COMPLETED + STUDENT_SELF_ABSENT held teacher payment'
);

-- Hard no-show is one session conflict, delayed alert, and fully reversible. --
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select public.apply_my_attendance_response(
  '30000000-0000-4000-8000-000000000003', 'TEACHER_NO_SHOW'
);

select pg_temp.assert_true(
  (public.rate_attendance('attendance-token-03', 5)->>'error') = 'avaliacao_nao_permitida',
  'student rated a no-show lesson'
);

reset role;

select pg_temp.assert_true(
  (select count(*) = 2
     from public.attendance_confirmations
    where coalesce(canonical_confirmation_id, id) = '30000000-0000-4000-8000-000000000003'
      and status = 'CONFLICT')
  and (select count(*) = 2
         from public.class_logs
        where id in (
          '40000000-0000-4000-8000-000000000003',
          '40000000-0000-4000-8000-000000000004'
        ) and payment_hold),
  'TEACHER_NO_SHOW did not hold every financial slot in the session'
);

select pg_temp.assert_true(
  (select count(*) = 0
     from public.teacher_turbo_disputes d
    where d.confirmation_id in (
      '30000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000004'
    )
      and d.status = 'OPEN')
  and (public.teacher_turbo_status(
    '10000000-0000-4000-8000-000000000002'
  )->>'status') <> 'SUSPENDED',
  'correction-window no-show opened/suspended Turbo prematurely'
);

select pg_temp.assert_true(
  (select count(*) = 1
     from public.notification_queue
    where notification_kind = 'CONFLICT_TEACHER_ALERT'
      and source_id = '30000000-0000-4000-8000-000000000003'
      and status = 'pending'
      and scheduled_for >= (
        select response_editable_until
          from public.attendance_confirmations
         where id = '30000000-0000-4000-8000-000000000003'
      )),
  'hard conflict alert duplicated or was scheduled before correction closed'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select public.apply_my_attendance_response(
  '30000000-0000-4000-8000-000000000003', 'STUDENT_PRESENT'
);
select public.rate_attendance('attendance-token-03', 5);
select public.apply_my_attendance_response(
  '30000000-0000-4000-8000-000000000003', 'STUDENT_SELF_ABSENT'
);
reset role;

select pg_temp.assert_true(
  (select count(*) = 0
     from public.class_logs
    where id in (
      '40000000-0000-4000-8000-000000000003',
      '40000000-0000-4000-8000-000000000004'
    ) and payment_hold)
  and (select status = 'skipped'
         from public.notification_queue
        where notification_kind = 'CONFLICT_TEACHER_ALERT'
          and source_id = '30000000-0000-4000-8000-000000000003')
  and (select student_rating is null
         from public.attendance_confirmations
        where id = '30000000-0000-4000-8000-000000000003'),
  'correction left hold/alert/rating effects behind'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.teacher_turbo_disputes d
     where d.confirmation_id in (
       '30000000-0000-4000-8000-000000000003',
       '30000000-0000-4000-8000-000000000004'
     )
       and d.status = 'OPEN'
  ),
  'student correction left an OPEN Turbo dispute'
);

-- Final no-show resolution covers all slots and survives a later overwrite. --
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select public.apply_my_attendance_response(
  '30000000-0000-4000-8000-000000000005', 'TEACHER_NO_SHOW'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-000000000005',
    'TEACHER_ABSENT',
    'too early'
  )->>'error') = 'aguardando_janela_correcao',
  'director finalized a no-show during the correction window'
);
reset role;

update public.attendance_confirmations
   set response_editable_until = now() - interval '1 second'
 where coalesce(canonical_confirmation_id, id) = '30000000-0000-4000-8000-000000000005';

select public.reconcile_attendance_confirmation(
  '30000000-0000-4000-8000-000000000005'
);

select pg_temp.assert_true(
  (select status = 'CONFLICT'
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000005')
  and (select count(*) = 1
         from public.teacher_turbo_disputes d
        where d.confirmation_id in (
          '30000000-0000-4000-8000-000000000005',
          '30000000-0000-4000-8000-000000000006'
        )
          and d.status = 'OPEN')
  and exists (
    select 1
      from public.teacher_turbo_disputes d
     where d.confirmation_id = '30000000-0000-4000-8000-000000000005'
       and d.status = 'OPEN'
  )
  and not exists (
    select 1
      from public.teacher_turbo_disputes d
     where d.confirmation_id = '30000000-0000-4000-8000-000000000006'
       and d.status = 'OPEN'
  ),
  'mature two-slot conflict did not create exactly one canonical Turbo dispute'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '30000000-0000-4000-8000-000000000005',
    'TEACHER_ABSENT',
    'teacher absence verified'
  )->>'ok')::boolean,
  'director could not resolve a mature no-show'
);
reset role;

select pg_temp.assert_true(
  (select count(*) = 2
     from public.class_logs
    where id in (
      '40000000-0000-4000-8000-000000000005',
      '40000000-0000-4000-8000-000000000006'
    )
      and presence = 'TEACHER_ABSENCE'
      and verification_status = 'RESOLVED_UNPAID'
      and not payment_hold)
  and (select count(*) = 1
         from public.reschedules
        where attendance_session_key = (
          select session_key
            from public.attendance_confirmations
           where id = '30000000-0000-4000-8000-000000000005'
        )
          and fault_type = 'TEACHER'
          and used_at is null),
  'TEACHER_ABSENT did not normalize all logs/create one make-up'
);

update public.class_logs
   set presence = 'COMPLETED'
 where id = '40000000-0000-4000-8000-000000000005';

select pg_temp.assert_true(
  (select presence = 'TEACHER_ABSENCE'
     from public.class_logs
    where id = '40000000-0000-4000-8000-000000000005'),
  'final teacher-absence decision was overwritten later'
);

-- A nearby but different occurrence must not be swallowed by the final-session
-- reschedule dedupe trigger.
insert into public.reschedules (
  id, tenant_id, original_booking_id, teacher_id, student_id,
  date, time, fault_type, created_at
)
values (
  '70000000-0000-4000-8000-000000000001',
  'attendance-hardening-school',
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Pendente', 'Pendente', 'TEACHER', now()
);

select pg_temp.assert_true(
  exists (
    select 1 from public.reschedules
     where id = '70000000-0000-4000-8000-000000000001'
  ),
  'final-session dedupe suppressed a different nearby lesson reschedule'
);

-- Resolve before the teacher logs, then prove a late log is normalized/linked.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select public.apply_my_attendance_response(
  '30000000-0000-4000-8000-000000000007', 'TEACHER_NO_SHOW'
);
reset role;

select pg_temp.assert_true(
  (select status = 'AWAITING_TEACHER'
     from public.attendance_confirmations
    where id = '30000000-0000-4000-8000-000000000007')
  and not exists (
    select 1
      from public.teacher_turbo_disputes d
     where d.confirmation_id = '30000000-0000-4000-8000-000000000007'
       and d.status = 'OPEN'
  )
  and (public.teacher_turbo_status(
    '10000000-0000-4000-8000-000000000002'
  )->>'status') <> 'SUSPENDED',
  'no-show without a class log opened/suspended Turbo'
);

update public.attendance_confirmations
   set response_editable_until = now() - interval '1 second'
 where id = '30000000-0000-4000-8000-000000000007';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select public.resolve_attendance_conflict_v2(
  '30000000-0000-4000-8000-000000000007',
  'TEACHER_ABSENT',
  'resolved before late log'
);
reset role;

insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, booking_id,
  presence, date, class_date, start_time, created_at
)
values (
  '40000000-0000-4000-8000-000000000007',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000007',
  'COMPLETED',
  (now() at time zone 'America/Sao_Paulo')::date,
  (now() at time zone 'America/Sao_Paulo')::date,
  '16:00', now()
);

select pg_temp.assert_true(
  (select presence = 'TEACHER_ABSENCE'
          and verification_status = 'RESOLVED_UNPAID'
          and not payment_hold
     from public.class_logs
    where id = '40000000-0000-4000-8000-000000000007')
  and (select class_log_id = '40000000-0000-4000-8000-000000000007'
         from public.attendance_confirmations
        where id = '30000000-0000-4000-8000-000000000007'),
  'late class log escaped or was not linked to final attendance decision'
);

-- Safe authenticated projections contain no token and only canonical rows. --
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  public.my_attendance_audits()::text not like '%"token"%'
  and not exists (
    select 1
      from jsonb_array_elements(public.my_attendance_audits()) item
     where item->>'id' in (
       '30000000-0000-4000-8000-000000000004',
       '30000000-0000-4000-8000-000000000006'
     )
  ),
  'student audit projection exposed token or duplicate session members'
);

select pg_temp.assert_true(
  (public.confirm_my_class_log(
    '40000000-0000-4000-8000-000000000001'
  )->>'ok')::boolean,
  'student could not confirm own class log through RPC'
);
reset role;

-- Test fixtures are suppressed at enqueue and again at the atomic claim. -----
insert into public.reschedules (
  id, tenant_id, original_booking_id, teacher_id, student_id,
  date, time, fault_type, created_at
)
values
  (
    '70000000-0000-4000-8000-000000000005',
    'attendance-hardening-school',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000005',
    to_char(now() at time zone 'America/Sao_Paulo' - interval '1 hour', 'YYYY-MM-DD'),
    to_char(now() at time zone 'America/Sao_Paulo' - interval '1 hour', 'HH24:MI'),
    'STUDENT', now()
  ),
  (
    '70000000-0000-4000-8000-000000000006',
    'attendance-hardening-school',
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000003',
    to_char(now() at time zone 'America/Sao_Paulo' - interval '1 hour', 'YYYY-MM-DD'),
    to_char(now() at time zone 'America/Sao_Paulo' - interval '1 hour', 'HH24:MI'),
    'STUDENT', now()
  );

select public.enqueue_attendance_confirmations();

select pg_temp.assert_true(
  not exists (
    select 1
      from public.attendance_confirmations
     where source_type = 'reschedule'
       and source_id in (
         '70000000-0000-4000-8000-000000000005',
         '70000000-0000-4000-8000-000000000006'
       )
  ),
  'test student or teacher was enqueued for external attendance delivery'
);

create temporary table test_account_claimed_delivery as
select * from public.claim_attendance_confirmation_deliveries(1) with no data;
grant select, insert on table test_account_claimed_delivery to service_role;

savepoint before_test_account_claim;

insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name, student_phone,
  teacher_name, class_date, class_time, token, token_expires_at,
  session_end_at, status, delivery_status
)
values
  (
    '50000000-0000-4000-8000-000000000004',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000005',
    'Attendance Test Student', '5511999990005', 'Attendance Teacher',
    (now() at time zone 'America/Sao_Paulo')::date, '00:01',
    'test-account-delivery-token-01', now() + interval '7 days',
    now() - interval '20 minutes', 'PENDING', 'PENDING'
  ),
  (
    '50000000-0000-4000-8000-000000000005',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000003',
    'Attendance Student', '5511999990003', 'Attendance Test Teacher',
    (now() at time zone 'America/Sao_Paulo')::date, '00:02',
    'test-account-delivery-token-02', now() + interval '7 days',
    now() - interval '20 minutes', 'PENDING', 'PENDING'
  );

select private.refresh_attendance_confirmation_sessions(
  (now() at time zone 'America/Sao_Paulo')::date,
  (now() at time zone 'America/Sao_Paulo')::date
);

update public.attendance_confirmations
   set session_end_at = now() - interval '20 minutes'
 where id in (
   '50000000-0000-4000-8000-000000000004',
   '50000000-0000-4000-8000-000000000005'
 );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into test_account_claimed_delivery
select * from public.claim_attendance_confirmation_deliveries(100);
reset role;

select pg_temp.assert_true(
  not exists (
    select 1
      from test_account_claimed_delivery
     where id in (
       '50000000-0000-4000-8000-000000000004',
       '50000000-0000-4000-8000-000000000005'
     )
  ),
  'test student or teacher was claimed for external attendance delivery'
);

rollback to savepoint before_test_account_claim;

-- Atomic delivery and terminal ambiguity ------------------------------------
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name, student_phone,
  teacher_name, class_date, class_time, token, token_expires_at,
  session_end_at, status, delivery_status
)
values
  (
    '50000000-0000-4000-8000-000000000001',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'Attendance Student', '5511999990003', 'Attendance Teacher',
    (now() at time zone 'America/Sao_Paulo')::date, '01:00',
    'delivery-token-01', now() + interval '7 days', now() - interval '20 minutes',
    'PENDING', 'PENDING'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    'attendance-hardening-school',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'Attendance Student', '5511999990003', 'Attendance Teacher',
    (now() at time zone 'America/Sao_Paulo')::date, '01:30',
    'delivery-token-02', now() + interval '7 days', now() - interval '20 minutes',
    'PENDING', 'PENDING'
  );

-- Simulates a row repaired after the legacy Edge sender attempted delivery but
-- left no atomic claim metadata. A missing source occurrence must never turn
-- this terminally uncertain provider outcome into CANCELLED/retryable state.
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name, student_phone,
  teacher_name, class_date, class_time, token, token_expires_at,
  session_end_at, status, delivery_status, source_id, source_type,
  send_attempts, last_delivery_error
)
values (
  '50000000-0000-4000-8000-000000000006',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student', '5511999990003', 'Attendance Teacher',
  (now() at time zone 'America/Sao_Paulo')::date, '23:01',
  'late-legacy-delivery-token-01', now() + interval '7 days',
  now() - interval '20 minutes', 'PENDING', 'AMBIGUOUS',
  'late-legacy-missing-occurrence', 'booking', 1,
  'legacy_delivery_attempt_outcome_unknown'
);

select private.refresh_attendance_confirmation_sessions(
  (now() at time zone 'America/Sao_Paulo')::date,
  (now() at time zone 'America/Sao_Paulo')::date
);

-- Make the computed logical end eligible independent of the wall-clock hour.
update public.attendance_confirmations
   set session_end_at = now() - interval '20 minutes'
 where coalesce(canonical_confirmation_id, id) = '50000000-0000-4000-8000-000000000001';

-- Delivery must resolve the live profile instead of reusing the phone copied
-- into the confirmation before the student updated their contact details.
update public.profiles
   set attendance_phone = '5511999990099',
       phone = '5511999990098'
 where id = '10000000-0000-4000-8000-000000000003';

create temporary table claimed_delivery as
select * from public.claim_attendance_confirmation_deliveries(1) with no data;
grant select, insert, delete, truncate on table claimed_delivery to service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into claimed_delivery
select * from public.claim_attendance_confirmation_deliveries(1);
reset role;

select pg_temp.assert_true(
  (select count(*) = 1 from claimed_delivery)
  and (select count(distinct canonical_confirmation_id) = 1
         from public.attendance_confirmations
        where id in (
          '50000000-0000-4000-8000-000000000001',
          '50000000-0000-4000-8000-000000000002'
        )),
  'contiguous slots were claimed more than once'
);

select pg_temp.assert_true(
  (select attendance_phone = '5511999990099' from claimed_delivery),
  'delivery claim reused a stale confirmation phone instead of the live profile'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from claimed_delivery
     where id = '50000000-0000-4000-8000-000000000006'
  )
  and (select status = 'CANCELLED'
          and delivery_status = 'AMBIGUOUS'
          and last_delivery_error =
                'legacy_delivery_attempt_outcome_unknown'
     from public.attendance_confirmations
    where id = '50000000-0000-4000-8000-000000000006'),
  'anti-ghost sweep overwrote a terminally ambiguous legacy attempt'
);

update public.attendance_confirmations
   set delivery_claim_expires_at = now() - interval '1 second'
 where id = (select id from claimed_delivery);

truncate claimed_delivery;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into claimed_delivery
select * from public.claim_attendance_confirmation_deliveries(10);
reset role;

select pg_temp.assert_true(
  not exists (
    select 1 from claimed_delivery
     where id = '50000000-0000-4000-8000-000000000001'
  )
  and (select delivery_status = 'AMBIGUOUS'
         and last_delivery_error = 'claim_lease_expired_delivery_outcome_unknown'
         from public.attendance_confirmations
        where id = '50000000-0000-4000-8000-000000000001'),
  'expired in-flight lease was reclaimed instead of terminally AMBIGUOUS'
);

-- A stale-delivery decision is terminal but never cancels a real audit.
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name, student_phone,
  teacher_name, class_date, class_time, token, token_expires_at,
  session_end_at, status, delivery_status, delivery_key,
  session_key, canonical_confirmation_id, delivery_claim_token,
  delivery_claimed_at, delivery_claim_expires_at, send_attempts
)
values (
  '50000000-0000-4000-8000-000000000003',
  'attendance-hardening-school',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'Attendance Student', '5511999990003', 'Attendance Teacher',
  (now() at time zone 'America/Sao_Paulo')::date, '03:00',
  'delivery-token-03', now() + interval '7 days', now() - interval '20 minutes',
  'PENDING', 'PROCESSING', 'attendance-delivery:test-stale',
  'attendance:test-stale', '50000000-0000-4000-8000-000000000003',
  '60000000-0000-4000-8000-000000000003', now(), now() + interval '5 minutes', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.assert_true(
  (public.complete_attendance_confirmation_delivery(
    '50000000-0000-4000-8000-000000000003',
    '60000000-0000-4000-8000-000000000003',
    null
  )->>'error') = 'provider_message_id_obrigatorio',
  'delivery was marked SENT without a provider message id'
);
reset role;

select pg_temp.assert_true(
  (select delivery_status = 'PROCESSING' and sent_at is null
     from public.attendance_confirmations
    where id = '50000000-0000-4000-8000-000000000003'),
  'missing provider id changed the in-flight claim'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.fail_attendance_confirmation_delivery(
  '50000000-0000-4000-8000-000000000003',
  '60000000-0000-4000-8000-000000000003',
  'stale_delivery_suppressed',
  false
);
reset role;

select pg_temp.assert_true(
  (select delivery_status = 'FAILED' and status = 'PENDING'
     from public.attendance_confirmations
    where id = '50000000-0000-4000-8000-000000000003'),
  'stale delivery suppression corrupted the lesson audit status'
);

rollback;
