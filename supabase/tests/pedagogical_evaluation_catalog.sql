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
  to_regclass('public.pedagogical_evaluation_catalog') is not null
  and to_regclass('public.pedagogical_evaluation_access_audit') is not null
  and to_regclass('public.pedagogical_evaluation_submission_requests') is not null,
  'pedagogical evaluation catalog runtime is incomplete'
);

select pg_temp.assert_true(
  (
    select count(*) = 5
       and count(*) filter (where active) = 5
       and jsonb_agg(
         jsonb_build_array(book_part, next_book_part)
         order by module, part
       ) = '[
         ["A1-1", "A1-2"],
         ["A1-2", "A2-1"],
         ["A2-1", "A2-2"],
         ["A2-2", "B1-1"],
         ["B1-1", null]
       ]'::jsonb
      from public.pedagogical_evaluation_catalog
  ),
  'published pedagogical catalog or its canonical order drifted'
);

select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.record_verified_pedagogical_quiz_v2(uuid,text,integer,integer,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.record_verified_pedagogical_quiz_v2(uuid,text,integer,integer,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.record_verified_pedagogical_quiz_v2(uuid,text,integer,integer,jsonb,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.set_student_pedagogical_evaluation_access(uuid,text,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.set_student_pedagogical_evaluation_access(uuid,text,boolean)',
    'EXECUTE'
  ),
  'pedagogical evaluation RPC grants are not fail-closed'
);

select pg_temp.assert_true(
  has_table_privilege(
    'service_role',
    'public.pedagogical_evaluation_catalog',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.pedagogical_evaluation_catalog',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'public.pedagogical_evaluation_catalog',
    'SELECT'
  )
  and has_table_privilege(
    'service_role',
    'public.pedagogical_evaluation_submission_requests',
    'SELECT'
  )
  and has_table_privilege(
    'service_role',
    'public.pedagogical_evaluation_submission_requests',
    'INSERT'
  )
  and has_table_privilege(
    'service_role',
    'public.pedagogical_evaluation_submission_requests',
    'UPDATE'
  )
  and has_table_privilege(
    'service_role',
    'public.pedagogical_evaluation_submission_requests',
    'DELETE'
  ),
  'service role cannot own the catalog and submission ledger runtime'
);

select pg_temp.assert_true(
  not has_table_privilege(
    'authenticated',
    'public.pedagogical_evaluation_submission_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.pedagogical_evaluation_submission_requests',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.pedagogical_evaluation_submission_requests',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.pedagogical_evaluation_submission_requests',
    'DELETE'
  )
  and not has_table_privilege(
    'anon',
    'public.pedagogical_evaluation_submission_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'public.pedagogical_evaluation_submission_requests',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_evaluations',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_evaluations',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_evaluations',
    'DELETE'
  ),
  'browser roles retained a direct pedagogical attempt or ledger write surface'
);

insert into public.tenants (id, name)
values
  ('ped-eval-catalog-a', 'Pedagogical Evaluation Catalog A'),
  ('ped-eval-catalog-b', 'Pedagogical Evaluation Catalog B');

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
    '00000000-0000-4000-8000-00000000f501',
    'authenticated',
    'authenticated',
    'ped-eval-student-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Pedagogical Evaluation Student"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000f511',
    'authenticated',
    'authenticated',
    'ped-eval-linked-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Pedagogical Evaluation Linked Teacher"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000f512',
    'authenticated',
    'authenticated',
    'ped-eval-unlinked-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Pedagogical Evaluation Unlinked Teacher"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000f521',
    'authenticated',
    'authenticated',
    'ped-eval-cross-tenant-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Pedagogical Evaluation Cross Tenant Teacher"}',
    now(),
    now()
  );

set local app.enrollment_claim = '1';

update public.profiles
   set tenant_id = 'ped-eval-catalog-a',
       role = 'TEACHER',
       full_name = 'Pedagogical Evaluation Linked Teacher',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'pedagogical-evaluation-linked-teacher-test'
 where id = '00000000-0000-4000-8000-00000000f511';

update public.profiles
   set tenant_id = 'ped-eval-catalog-a',
       role = 'TEACHER',
       full_name = 'Pedagogical Evaluation Unlinked Teacher',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'pedagogical-evaluation-unlinked-teacher-test'
 where id = '00000000-0000-4000-8000-00000000f512';

update public.profiles
   set tenant_id = 'ped-eval-catalog-b',
       role = 'TEACHER',
       full_name = 'Pedagogical Evaluation Cross Tenant Teacher',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'pedagogical-evaluation-cross-tenant-test'
 where id = '00000000-0000-4000-8000-00000000f521';

update public.profiles
   set tenant_id = 'ped-eval-catalog-a',
       role = 'STUDENT',
       full_name = 'Pedagogical Evaluation Student',
       lifecycle_status = 'active',
       professor_id = '00000000-0000-4000-8000-00000000f511',
       professor_id2 = null,
       module = 'A1',
       current_book_part = 'A1-1',
       evaluation_unlocked = false,
       unlocked_tests = '{}'::text[],
       xp = 137,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       streak_count = 0,
       last_streak_date = null,
       last_activity = null,
       hearts = 5,
       hearts_updated_at = now(),
       is_test_account = true,
       test_fixture_key = 'pedagogical-evaluation-student-test'
 where id = '00000000-0000-4000-8000-00000000f501';

set local app.enrollment_claim = '';

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000f512","role":"authenticated"}';

do $unlinked_teacher$
begin
  begin
    perform public.set_student_pedagogical_evaluation_access(
      '00000000-0000-4000-8000-00000000f501',
      'A1-1',
      true
    );
    raise exception 'assertion failed: unlinked teacher released an evaluation';
  exception when sqlstate '42501' then
    if sqlerrm <> 'teacher_student_link_required' then
      raise;
    end if;
  end;
end;
$unlinked_teacher$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000f521","role":"authenticated"}';

do $cross_tenant_teacher$
begin
  begin
    perform public.set_student_pedagogical_evaluation_access(
      '00000000-0000-4000-8000-00000000f501',
      'A1-1',
      true
    );
    raise exception 'assertion failed: cross-tenant teacher released an evaluation';
  exception when sqlstate '42501' then
    if sqlerrm <> 'student_not_available' then
      raise;
    end if;
  end;
end;
$cross_tenant_teacher$;

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000f511","role":"authenticated"}';

select pg_temp.assert_true(
  public.set_student_pedagogical_evaluation_access(
    '00000000-0000-4000-8000-00000000f501',
    'A1-1',
    true
  ) = jsonb_build_object(
    'studentId', '00000000-0000-4000-8000-00000000f501'::uuid,
    'bookPart', 'A1-1',
    'unlocked', true
  ),
  'linked teacher could not release the current published evaluation'
);

reset role;

select pg_temp.assert_true(
  (
    select evaluation_unlocked
       and current_book_part = 'A1-1'
       and unlocked_tests = '{}'::text[]
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f501'
  )
  and (
    select count(*) = 1
      from public.pedagogical_evaluation_access_audit
     where tenant_id = 'ped-eval-catalog-a'
       and student_id = '00000000-0000-4000-8000-00000000f501'
       and actor_id = '00000000-0000-4000-8000-00000000f511'
       and book_part = 'A1-1'
       and unlocked
  ),
  'release did not update only the canonical flag or was not audited'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $failed_idempotency$
declare
  first_result jsonb;
  replay_result jsonb;
begin
  first_result := public.record_verified_pedagogical_quiz_v2(
    '00000000-0000-4000-8000-00000000f501',
    'A1-1',
    2,
    10,
    '[0,1,2,3,0,1,2,3,0,1]'::jsonb,
    'ped-eval-failed-request-0001'
  );
  replay_result := public.record_verified_pedagogical_quiz_v2(
    '00000000-0000-4000-8000-00000000f501',
    'A1-1',
    2,
    10,
    '[0,1,2,3,0,1,2,3,0,1]'::jsonb,
    'ped-eval-failed-request-0001'
  );

  perform pg_temp.assert_true(
    not coalesce((first_result ->> 'passed')::boolean, true)
    and not coalesce((first_result ->> 'alreadySubmitted')::boolean, true)
    and not coalesce((replay_result ->> 'passed')::boolean, true)
    and coalesce((replay_result ->> 'alreadySubmitted')::boolean, false),
    format('failed evaluation replay was not idempotent: %s / %s', first_result, replay_result)
  );
end;
$failed_idempotency$;

reset role;

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.student_evaluations
     where tenant_id = 'ped-eval-catalog-a'
       and student_id = '00000000-0000-4000-8000-00000000f501'
       and book_part = 'A1-1'
  )
  and (
    select count(*) = 1
      from public.pedagogical_evaluation_submission_requests
     where tenant_id = 'ped-eval-catalog-a'
       and student_id = '00000000-0000-4000-8000-00000000f501'
       and request_key = 'ped-eval-failed-request-0001'
       and result is not null
       and completed_at is not null
  )
  and (
    select current_book_part = 'A1-1'
       and evaluation_unlocked
       and streak_count = 1
       and xp = 137
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f501'
  )
  and (
    select count(*) = 2
       and min(total_activities) = 1
       and max(total_activities) = 1
      from public.student_skill_scores
     where student_id = '00000000-0000-4000-8000-00000000f501'
       and skill in ('grammar', 'vocabulary')
  ),
  'failed replay duplicated its attempt, practice/streak effects, or changed progression'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $passing_idempotency$
declare
  first_result jsonb;
  replay_result jsonb;
  persisted_result jsonb;
begin
  first_result := public.record_verified_pedagogical_quiz_v2(
    '00000000-0000-4000-8000-00000000f501',
    'A1-1',
    10,
    10,
    '[0,1,2,3,0,1,2,3,0,1]'::jsonb,
    'ped-eval-passing-request-0001'
  );

  select request.result
    into persisted_result
    from public.pedagogical_evaluation_submission_requests as request
   where request.student_id = '00000000-0000-4000-8000-00000000f501'
     and request.request_key = 'ped-eval-passing-request-0001';

  replay_result := public.record_verified_pedagogical_quiz_v2(
    '00000000-0000-4000-8000-00000000f501',
    'A1-1',
    10,
    10,
    '[0,1,2,3,0,1,2,3,0,1]'::jsonb,
    'ped-eval-passing-request-0001'
  );

  perform pg_temp.assert_true(
    coalesce((first_result ->> 'passed')::boolean, false)
    and not coalesce((first_result ->> 'alreadySubmitted')::boolean, true)
    and first_result ->> 'nextPart' = 'A1-2'
    and coalesce((replay_result ->> 'passed')::boolean, false)
    and coalesce((replay_result ->> 'alreadySubmitted')::boolean, false)
    and replay_result ->> 'nextPart' = 'A1-2',
    format('passing evaluation did not advance once: %s / %s', first_result, replay_result)
  );

  perform pg_temp.assert_true(
    persisted_result = first_result
    and replay_result - 'alreadySubmitted' = persisted_result - 'alreadySubmitted',
    format(
      'same-key replay did not return the canonical stored result: %s / %s / %s',
      first_result,
      persisted_result,
      replay_result
    )
  );

  begin
    perform public.record_verified_pedagogical_quiz_v2(
      '00000000-0000-4000-8000-00000000f501',
      'A1-1',
      0,
      10,
      '[3,3,3,3,3,3,3,3,3,3]'::jsonb,
      'ped-eval-passing-request-0001'
    );
    raise exception 'assertion failed: same request key accepted a different fingerprint';
  exception when sqlstate '22023' then
    if sqlerrm <> 'evaluation_submission_idempotency_conflict' then
      raise;
    end if;
  end;

  begin
    perform public.record_verified_pedagogical_quiz_v2(
      '00000000-0000-4000-8000-00000000f501',
      'A1-1',
      0,
      10,
      '[3,3,3,3,3,3,3,3,3,3]'::jsonb,
      'ped-eval-obsolete-request-0001'
    );
    raise exception 'assertion failed: completed evaluation accepted a new request key';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'pedagogical_quiz_already_completed' then
      raise;
    end if;
  end;
end;
$passing_idempotency$;

reset role;

select pg_temp.assert_true(
  (
    select current_book_part = 'A1-2'
       and module = 'A1'
       and not evaluation_unlocked
       and streak_count = 1
       and xp = 137
      from public.profiles
     where id = '00000000-0000-4000-8000-00000000f501'
  )
  and exists (
    select 1
      from public.pedagogical_evaluation_catalog
     where book_part = 'A1-2'
       and active
  )
  and (
    select count(*) = 2
      from public.student_evaluations
     where tenant_id = 'ped-eval-catalog-a'
       and student_id = '00000000-0000-4000-8000-00000000f501'
       and book_part = 'A1-1'
  )
  and (
    select count(*) = 2
      from public.pedagogical_evaluation_submission_requests
     where tenant_id = 'ped-eval-catalog-a'
       and student_id = '00000000-0000-4000-8000-00000000f501'
       and result is not null
       and completed_at is not null
  )
  and not exists (
    select 1
      from public.pedagogical_evaluation_submission_requests
     where tenant_id = 'ped-eval-catalog-a'
       and student_id = '00000000-0000-4000-8000-00000000f501'
       and request_key = 'ped-eval-obsolete-request-0001'
  )
  and (
    select count(*) = 1
       and min(xp_awarded) = 0
       and max(xp_awarded) = 0
       and bool_and(test_fixture)
      from public.student_verified_xp_awards
     where tenant_id = 'ped-eval-catalog-a'
       and student_id = '00000000-0000-4000-8000-00000000f501'
       and source_type = 'PEDAGOGICAL_QUIZ'
       and source_id = 'A1-1'
  )
  and (
    select count(*) = 2
       and min(total_activities) = 2
       and max(total_activities) = 2
      from public.student_skill_scores
     where student_id = '00000000-0000-4000-8000-00000000f501'
       and skill in ('grammar', 'vocabulary')
  ),
  'passing replay duplicated attempt, XP/practice effects, or advanced off catalog'
);

rollback;
