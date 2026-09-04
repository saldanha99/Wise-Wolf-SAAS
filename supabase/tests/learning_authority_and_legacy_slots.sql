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
  to_regprocedure('public.set_student_pedagogical_placement(uuid,text,text)') is not null
  and to_regprocedure('public.archive_learning_path(uuid,text)') is not null
  and to_regprocedure('public.grade_quiz_core(uuid,integer[],text)') is not null
  and to_regprocedure(
    'public.complete_student_complementary_activity_core(uuid,jsonb,text)'
  ) is not null
  and to_regprocedure(
    'public.enroll_student_learning_path_core(uuid,boolean,text,uuid)'
  ) is not null
  and to_regprocedure(
    'public.get_student_learning_path_runtime_core(uuid)'
  ) is not null
  and to_regprocedure(
    'public.get_student_complementary_activities_core(integer)'
  ) is not null
  and to_regprocedure(
    'public.get_student_complementary_generation_status_core()'
  ) is not null
  and to_regprocedure(
    'public.get_student_practice_status_core()'
  ) is not null,
  'learning authority RPCs or private cores are missing'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.set_student_pedagogical_placement(uuid,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.archive_learning_path(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.grade_quiz_core(uuid,integer[],text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.grade_quiz_core(uuid,integer[],text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.complete_student_complementary_activity_core(uuid,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.enroll_student_learning_path_core(uuid,boolean,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.enroll_student_learning_path_core(uuid,boolean,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_student_learning_path_runtime_core(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_student_complementary_activities_core(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_student_complementary_generation_status_core()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.get_student_practice_status_core()',
    'EXECUTE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.learning_paths',
    'DELETE'
  ),
  'learning cores or destructive curriculum writes remain browser-exposed'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from (values
        ('public.enroll_student_learning_path_core(uuid,boolean,text,uuid)'),
        ('public.get_student_learning_path_runtime_core(uuid)'),
        ('public.get_student_complementary_activities_core(integer)'),
        ('public.get_student_complementary_generation_status_core()'),
        ('public.get_student_practice_status_core()'),
        ('public.schedule_student_vocab_review_core(uuid,text,text,text)'),
        ('public.submit_student_vocab_review_core(uuid,boolean,text)'),
        ('public.begin_student_complementary_generation_core(uuid)'),
        ('public.release_student_complementary_generation_core(uuid,uuid,uuid,text)'),
        ('public.complete_student_complementary_activity_core(uuid,jsonb,text)'),
        ('public.complete_student_complementary_activity_lifecycle_core(uuid,jsonb,text)'),
        ('public.get_student_opt_in_leaderboard_core(integer)'),
        ('public.consume_student_heart_core(text,text)'),
        ('public.grade_quiz_core(uuid,integer[],text)'),
        ('public.grade_quiz_lifecycle_core(uuid,integer[],text)'),
        ('public.complete_learning_activity_core(uuid,integer,integer,jsonb,text)'),
        ('public.award_verified_student_xp_core(text,text)')
      ) as expected(signature)
     where to_regprocedure(expected.signature) is null
        or has_function_privilege(
             'anon',
             expected.signature,
             'EXECUTE'
           )
        or has_function_privilege(
             'authenticated',
             expected.signature,
             'EXECUTE'
           )
        or has_function_privilege(
             'service_role',
             expected.signature,
             'EXECUTE'
           )
  ),
  'a lifecycle core is missing or directly executable'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from (values
        (
          'public.get_student_learning_path_runtime(uuid)',
          'private.assert_active_student_learning_access()'
        ),
        (
          'public.get_student_complementary_activities(integer)',
          'private.assert_active_student_learning_access()'
        ),
        (
          'public.get_student_complementary_generation_status()',
          'private.assert_active_student_learning_access()'
        ),
        (
          'public.get_student_practice_status()',
          'private.assert_active_student_learning_access()'
        ),
        (
          'public.get_student_opt_in_leaderboard(integer)',
          'private.assert_active_student_learning_access()'
        ),
        (
          'public.enroll_student_learning_path(uuid,boolean,text,uuid)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.schedule_student_vocab_review(uuid,text,text,text)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.submit_student_vocab_review(uuid,boolean,text)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.begin_student_complementary_generation(uuid)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.release_student_complementary_generation(uuid,uuid,uuid,text)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.complete_student_complementary_activity(uuid,jsonb,text)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.consume_student_heart(text,text)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.grade_quiz(uuid,integer[],text)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.complete_learning_activity(uuid,integer,integer,jsonb,text)',
          'private.assert_active_student_learning_mutation()'
        ),
        (
          'public.award_verified_student_xp(text,text)',
          'private.assert_active_student_learning_mutation()'
        )
      ) as expected(signature, guard_call)
     where to_regprocedure(expected.signature) is null
        or not has_function_privilege(
             'authenticated',
             expected.signature,
             'EXECUTE'
           )
        or not coalesce(
             (
               select procedure.prosecdef
                 from pg_catalog.pg_proc as procedure
                where procedure.oid = to_regprocedure(expected.signature)
             ),
             false
           )
        or pg_catalog.strpos(
             pg_catalog.pg_get_functiondef(
               to_regprocedure(expected.signature)::oid
             ),
             expected.guard_call
           ) = 0
  ),
  'an authenticated student learning RPC bypasses the lifecycle boundary'
);

select pg_temp.assert_true(
  to_regclass('private.learning_path_archive_capabilities') is not null
  and not has_table_privilege(
    'anon',
    'private.learning_path_archive_capabilities',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'private.learning_path_archive_capabilities',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'private.learning_path_archive_capabilities',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'private.learning_path_archive_capabilities',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'private.learning_path_archive_capabilities',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'private.learning_path_archive_capabilities',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.student_path_enrollments',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.student_path_enrollments',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.student_path_enrollments',
    'DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.student_path_enrollments',
    'TRUNCATE'
  )
  and pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.guard_active_student_learning_mutation()'::regprocedure
    ),
    'private.student_learning_access_is_active(v_student_id)'
  ) > 0,
  'archive capability or privileged lifecycle bypass remains exposed'
);

select pg_temp.assert_true(
  (
    select procedure.pronargdefaults = 0
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.grade_quiz(uuid,integer[],text)'::regprocedure
  ),
  'quiz request key must be mandatory for atomic idempotent heart consumption'
);

insert into public.tenants (id, name)
values ('learning-authority-a', 'Learning Authority A');

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
    '00000000-0000-4000-8000-00000000f601',
    'authenticated',
    'authenticated',
    'learning-authority-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Authority Student"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000f602',
    'authenticated',
    'authenticated',
    'learning-authority-inactive@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Authority Inactive Student"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000f611',
    'authenticated',
    'authenticated',
    'learning-authority-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Authority Admin"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000f621',
    'authenticated',
    'authenticated',
    'learning-authority-super-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Authority Super Admin"}',
    now(),
    now()
  );

set local app.enrollment_claim = '1';

update public.profiles
   set tenant_id = 'learning-authority-a',
       role = 'STUDENT',
       full_name = 'Learning Authority Student',
       status = 'Ativo',
       lifecycle_status = 'active',
       offboarding_status = null,
       module = 'A1',
       current_book_part = 'A1-1',
       evaluation_unlocked = false,
       unlocked_tests = '{}'::text[],
       is_test_account = true,
       test_fixture_key = 'learning-authority-active-student-test'
 where id = '00000000-0000-4000-8000-00000000f601';

update public.profiles
   set tenant_id = 'learning-authority-a',
       role = 'STUDENT',
       full_name = 'Learning Authority Inactive Student',
       status = 'Ativo',
       lifecycle_status = 'active',
       offboarding_status = null,
       module = 'A1',
       current_book_part = 'A1-1',
       evaluation_unlocked = false,
       unlocked_tests = '{}'::text[],
       is_test_account = true,
       test_fixture_key = 'learning-authority-inactive-student-test'
 where id = '00000000-0000-4000-8000-00000000f602';

update public.profiles
   set tenant_id = 'learning-authority-a',
       role = 'SCHOOL_ADMIN',
       full_name = 'Learning Authority Admin',
       status = 'Ativo',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'learning-authority-admin-test'
 where id = '00000000-0000-4000-8000-00000000f611';

update public.profiles
   set tenant_id = null,
       role = 'SUPER_ADMIN',
       full_name = 'Learning Authority Super Admin',
       status = 'Ativo',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'learning-authority-super-admin-test'
 where id = '00000000-0000-4000-8000-00000000f621';

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
    '00000000-0000-4000-8000-00000000f601',
    'learning-authority-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000f602',
    'learning-authority-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000f611',
    'learning-authority-a',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  );

insert into public.learning_paths (
  id,
  tenant_id,
  name,
  description,
  target_level,
  category,
  active,
  created_by
)
values
  (
    '10000000-0000-4000-8000-00000000f601',
    'learning-authority-a',
    'Completed archived path fixture',
    'Preserves completed history.',
    'A1',
    'GENERAL',
    true,
    '00000000-0000-4000-8000-00000000f611'
  ),
  (
    '10000000-0000-4000-8000-00000000f602',
    'learning-authority-a',
    'Active path fixture',
    'Rejects archival while a student is active.',
    'A1',
    'GENERAL',
    true,
    '00000000-0000-4000-8000-00000000f611'
  );

insert into public.learning_units (
  id,
  path_id,
  order_index,
  title,
  description,
  estimated_minutes,
  skill_focus
)
values
  (
    '20000000-0000-4000-8000-00000000f601',
    '10000000-0000-4000-8000-00000000f601',
    1,
    'Completed unit fixture',
    'Completed content.',
    5,
    array['grammar']::text[]
  ),
  (
    '20000000-0000-4000-8000-00000000f602',
    '10000000-0000-4000-8000-00000000f602',
    1,
    'Active unit fixture',
    'Active content.',
    5,
    array['grammar']::text[]
  );

insert into public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  description,
  content,
  xp_reward,
  estimated_minutes
)
values
  (
    '30000000-0000-4000-8000-00000000f601',
    '20000000-0000-4000-8000-00000000f601',
    1,
    'quiz',
    'Completed quiz fixture',
    'Completed quiz.',
    '{"questions":[{"id":"q1","q":"Choose A","options":["A","B"],"correct":0}]}'::jsonb,
    10,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000f603',
    '20000000-0000-4000-8000-00000000f602',
    1,
    'vocab_cards',
    'Active vocabulary fixture',
    'Completable activity used to persist a keyed replay.',
    '{"cards":[{"term":"wolf","translation":"lobo","example":"The wolf learns."}]}'::jsonb,
    0,
    5
  ),
  (
    '30000000-0000-4000-8000-00000000f602',
    '20000000-0000-4000-8000-00000000f602',
    2,
    'quiz',
    'Active quiz fixture',
    'Active quiz.',
    '{"questions":[{"id":"q1","q":"Choose A","options":["A","B"],"correct":0}]}'::jsonb,
    10,
    5
  );

insert into public.student_path_enrollments (
  id,
  student_id,
  path_id,
  tenant_id,
  current_unit_id,
  status,
  completed_at,
  assigned_by
)
values (
  '40000000-0000-4000-8000-00000000f601',
  '00000000-0000-4000-8000-00000000f601',
  '10000000-0000-4000-8000-00000000f601',
  'learning-authority-a',
  null,
  'COMPLETED',
  now(),
  '00000000-0000-4000-8000-00000000f611'
);

insert into public.student_activities (
  id,
  student_id,
  tenant_id,
  type,
  title,
  content,
  xp_reward,
  status,
  generated_by_ai
)
values (
  '50000000-0000-4000-8000-00000000f601',
  '00000000-0000-4000-8000-00000000f601',
  'learning-authority-a',
  'reading',
  'Complementary replay fixture',
  '{"instructions_pt":"Leia o texto.","text":"A short passage for a secure replay test.","checklist":["Li o texto."],"reflection_prompt":"O que você aprendeu?"}',
  0,
  'PENDING',
  false
);

insert into public.student_vocab_reviews (
  id,
  tenant_id,
  student_id,
  term,
  translation,
  example,
  source_activity_id,
  interval_days,
  consecutive_correct,
  total_reviews,
  next_review_at
)
values (
  '51000000-0000-4000-8000-00000000f601',
  'learning-authority-a',
  '00000000-0000-4000-8000-00000000f601',
  'wolf',
  'lobo',
  'The wolf learns.',
  '30000000-0000-4000-8000-00000000f603',
  1,
  0,
  0,
  now() - interval '1 day'
);

-- Seed the idempotency row that the legacy verified-XP RPC would otherwise
-- return before reaching any target-table trigger.
insert into public.student_verified_xp_awards (
  tenant_id,
  student_id,
  source_type,
  source_id,
  base_xp,
  xp_awarded,
  score_used,
  test_fixture
)
values (
  'learning-authority-a',
  '00000000-0000-4000-8000-00000000f601',
  'CLASS_LOG_CONFIRM',
  '70000000-0000-4000-8000-00000000f601',
  100,
  0,
  100,
  true
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f621"}';

select pg_temp.assert_true(
  public.set_student_pedagogical_evaluation_access(
    '00000000-0000-4000-8000-00000000f601',
    'A1-1',
    true
  ) ->> 'bookPart' = 'A1-1',
  'SUPER_ADMIN could not release a valid cross-tenant evaluation'
);

reset role;

update public.profiles
   set module = 'A1',
       current_book_part = 'A1-2',
       evaluation_unlocked = true,
       unlocked_tests = array['A1-2']::text[]
 where id = '00000000-0000-4000-8000-00000000f601';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f611"}';

select pg_temp.assert_true(
  public.set_student_pedagogical_placement(
    '00000000-0000-4000-8000-00000000f601',
    'A1',
    'Unrelated profile edit must preserve current milestone'
  ) ->> 'bookPart' = 'A1-2',
  'same-module placement reset the student to the first milestone'
);

select pg_temp.assert_true(
  (
    select profile.current_book_part = 'A1-2'
           and profile.evaluation_unlocked is true
           and profile.unlocked_tests = array['A1-2']::text[]
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000f601'
  ),
  'same-module placement cleared existing progression or evaluation access'
);

select pg_temp.assert_true(
  public.set_student_pedagogical_placement(
    '00000000-0000-4000-8000-00000000f601',
    'A2',
    'Placement test to first published A2 milestone'
  ) ->> 'bookPart' = 'A2-1',
  'placement did not derive the first published milestone'
);

select pg_temp.assert_true(
  public.set_student_pedagogical_placement(
    '00000000-0000-4000-8000-00000000f601',
    'C1',
    'Placement test for unpublished advanced evaluation'
  ) ->> 'bookPart' = 'COMPLETED',
  'advanced placement created a non-existent evaluation milestone'
);

select pg_catalog.set_config(
  'app.learning_path_archive_id',
  'caller-path-sentinel',
  true
);
select pg_catalog.set_config(
  'app.learning_path_archive_nonce',
  'caller-nonce-sentinel',
  true
);

select pg_temp.assert_true(
  public.archive_learning_path(
    '10000000-0000-4000-8000-00000000f601',
    'Completed fixture archived safely'
  ) ->> 'active' = 'false',
  'completed learning path was not archived safely'
);

select pg_temp.assert_true(
  pg_catalog.current_setting('app.learning_path_archive_id', true)
    = 'caller-path-sentinel'
  and pg_catalog.current_setting('app.learning_path_archive_nonce', true)
    = 'caller-nonce-sentinel',
  'archive RPC failed to restore caller GUCs'
);

-- Browser DML is revoked; exercise the historical-record trigger through the
-- privileged/internal writer path that remains capable of reaching it.
reset role;

do $$
begin
  update public.learning_units
     set title = 'A historical curriculum must never be rewritten'
   where id = '20000000-0000-4000-8000-00000000f601';
  raise exception 'assertion failed: enrolled learning unit was edited';
exception
  when sqlstate '55000' then
    if sqlerrm <> 'learning_path_curriculum_frozen_after_enrollment' then
      raise;
    end if;
end;
$$;

do $$
begin
  update public.unit_activities
     set content = '{"questions":[]}'::jsonb
   where id = '30000000-0000-4000-8000-00000000f601';
  raise exception 'assertion failed: enrolled learning activity was edited';
exception
  when sqlstate '55000' then
    if sqlerrm <> 'learning_path_curriculum_frozen_after_enrollment' then
      raise;
    end if;
end;
$$;

reset role;

insert into public.student_path_enrollments (
  id,
  student_id,
  path_id,
  tenant_id,
  current_unit_id,
  status,
  assigned_by
)
values (
  '40000000-0000-4000-8000-00000000f602',
  '00000000-0000-4000-8000-00000000f601',
  '10000000-0000-4000-8000-00000000f602',
  'learning-authority-a',
  '20000000-0000-4000-8000-00000000f602',
  'ACTIVE',
  '00000000-0000-4000-8000-00000000f611'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f601"}';

do $$
declare
  v_completion jsonb;
  v_quiz jsonb;
  v_vocab jsonb;
  v_heart jsonb;
  v_complementary jsonb;
  v_generation jsonb;
begin
  v_completion := public.complete_learning_activity(
    '30000000-0000-4000-8000-00000000f603',
    100,
    12,
    '{"activityType":"vocab_cards","score":100}'::jsonb,
    'learning-authority-learning-replay-0001'
  );
  v_quiz := public.grade_quiz(
    '30000000-0000-4000-8000-00000000f602',
    array[0]::integer[],
    'learning-authority-quiz-replay-0001'
  );
  v_vocab := public.submit_student_vocab_review(
    '51000000-0000-4000-8000-00000000f601',
    true,
    'learning-authority-vocab-replay-0001'
  );
  v_heart := public.consume_student_heart(
    'learning-authority-heart-replay-0001',
    'WRONG_ANSWER'
  );
  v_complementary := public.complete_student_complementary_activity(
    '50000000-0000-4000-8000-00000000f601',
    '{"activityId":"50000000-0000-4000-8000-00000000f601","activityType":"reading","contentMode":"structured","checklistCompleted":["Li o texto."],"reflection":"Aprendi que um retry precisa preservar a mesma evidência.","completedAt":"2026-08-31T12:00:00Z"}'::jsonb,
    'learning-authority-complementary-replay-0001'
  );
  v_generation := public.begin_student_complementary_generation(
    '60000000-0000-4000-8000-00000000f601'
  );

  perform pg_temp.assert_true(
    coalesce((v_completion ->> 'passed')::boolean, false)
    and coalesce((v_quiz ->> 'passed')::boolean, false)
    and coalesce((v_vocab ->> 'correct')::boolean, false)
    and (v_heart ? 'hearts')
    and coalesce((v_complementary ->> 'passed')::boolean, false)
    and coalesce((v_generation ->> 'allowed')::boolean, false),
    'active student replay fixtures were not persisted'
  );
end;
$$;

reset role;

update public.profiles
   set status = 'Inativo',
       lifecycle_status = 'offboarded',
       offboarding_status = 'COMPLETED'
 where id = '00000000-0000-4000-8000-00000000f601';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f601"}';

do $$
declare
  v_case record;
begin
  for v_case in
    select *
      from (values
        ('runtime read', 'read'),
        ('complementary read', 'read'),
        ('generation status read', 'read'),
        ('practice read', 'read'),
        ('leaderboard read', 'read')
      ) as cases(name, expected_kind)
  loop
    begin
      case v_case.name
        when 'runtime read' then
          perform public.get_student_learning_path_runtime(
            '10000000-0000-4000-8000-00000000f602'
          );
        when 'complementary read' then
          perform public.get_student_complementary_activities(50);
        when 'generation status read' then
          perform public.get_student_complementary_generation_status();
        when 'practice read' then
          perform public.get_student_practice_status();
        when 'leaderboard read' then
          perform public.get_student_opt_in_leaderboard(5);
      end case;
      raise exception 'assertion failed: inactive student passed %', v_case.name;
    exception
      when sqlstate '42501' then
        if sqlerrm <> 'inactive_student_learning_access_forbidden' then
          raise;
        end if;
    end;
  end loop;
end;
$$;

do $$
declare
  v_case text;
begin
  foreach v_case in array array[
    'schedule vocab',
    'submit vocab replay',
    'begin generation replay',
    'release generation',
    'complementary replay',
    'heart replay',
    'quiz replay',
    'learning completion replay',
    'verified xp replay'
  ] loop
    begin
      case v_case
        when 'schedule vocab' then
          perform public.schedule_student_vocab_review(
            '30000000-0000-4000-8000-00000000f603',
            'wolf',
            'lobo',
            'The wolf learns.'
          );
        when 'submit vocab replay' then
          perform public.submit_student_vocab_review(
            '51000000-0000-4000-8000-00000000f601',
            true,
            'learning-authority-vocab-replay-0001'
          );
        when 'begin generation replay' then
          perform public.begin_student_complementary_generation(
            '60000000-0000-4000-8000-00000000f601'
          );
        when 'release generation' then
          perform public.release_student_complementary_generation(
            '61000000-0000-4000-8000-00000000f601',
            '62000000-0000-4000-8000-00000000f601',
            '60000000-0000-4000-8000-00000000f601',
            'inactive client cleanup'
          );
        when 'complementary replay' then
          perform public.complete_student_complementary_activity(
            '50000000-0000-4000-8000-00000000f601',
            '{"activityId":"50000000-0000-4000-8000-00000000f601","activityType":"reading","contentMode":"structured","checklistCompleted":["Li o texto."],"reflection":"Aprendi que um retry precisa preservar a mesma evidência.","completedAt":"2026-08-31T12:00:07Z"}'::jsonb,
            'learning-authority-complementary-replay-0001'
          );
        when 'heart replay' then
          perform public.consume_student_heart(
            'learning-authority-heart-replay-0001',
            'WRONG_ANSWER'
          );
        when 'quiz replay' then
          perform public.grade_quiz(
            '30000000-0000-4000-8000-00000000f602',
            array[0]::integer[],
            'learning-authority-quiz-replay-0001'
          );
        when 'learning completion replay' then
          perform public.complete_learning_activity(
            '30000000-0000-4000-8000-00000000f603',
            100,
            12,
            '{"activityType":"vocab_cards","score":100}'::jsonb,
            'learning-authority-learning-replay-0001'
          );
        when 'verified xp replay' then
          perform public.award_verified_student_xp(
            'CLASS_LOG_CONFIRM',
            '70000000-0000-4000-8000-00000000f601'
          );
      end case;
      raise exception 'assertion failed: inactive student passed %', v_case;
    exception
      when sqlstate '42501' then
        if sqlerrm <> 'inactive_student_learning_mutation_forbidden' then
          raise;
        end if;
    end;
  end loop;
end;
$$;

reset role;

update public.profiles
   set status = 'Inativo',
       lifecycle_status = 'active',
       offboarding_status = null
 where id = '00000000-0000-4000-8000-00000000f602';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f602"}';

do $$
begin
  perform public.get_student_complementary_generation_status();
  raise exception 'assertion failed: status-inactive student read generation state';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'inactive_student_learning_access_forbidden' then
      raise;
    end if;
end;
$$;

reset role;

update public.profiles
   set status = 'Ativo',
       lifecycle_status = 'active',
       offboarding_status = 'COMPLETED'
 where id = '00000000-0000-4000-8000-00000000f602';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f602"}';

do $$
begin
  perform public.begin_student_complementary_generation(
    '60000000-0000-4000-8000-00000000f602'
  );
  raise exception 'assertion failed: offboarding-complete student began generation';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'inactive_student_learning_mutation_forbidden' then
      raise;
    end if;
end;
$$;

reset role;

update public.profiles
   set status = 'Ativo',
       lifecycle_status = 'active',
       offboarding_status = null
 where id = '00000000-0000-4000-8000-00000000f602';

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.student_learning_activity_attempts as attempt
     where attempt.student_id = '00000000-0000-4000-8000-00000000f601'
       and attempt.request_key = 'learning-authority-learning-replay-0001'
  )
  and (
    select count(*) = 1
      from public.student_learning_activity_attempts as attempt
     where attempt.student_id = '00000000-0000-4000-8000-00000000f601'
       and attempt.request_key = 'learning-authority-quiz-replay-0001'
  )
  and (
    select count(*) = 1
      from public.student_vocab_review_attempts as attempt
     where attempt.student_id = '00000000-0000-4000-8000-00000000f601'
       and attempt.request_key = 'learning-authority-vocab-replay-0001'
  )
  and (
    select count(*) = 1
      from public.student_heart_consumptions as consumption
     where consumption.student_id = '00000000-0000-4000-8000-00000000f601'
       and consumption.request_key = 'learning-authority-heart-replay-0001'
  )
  and (
    select count(*) = 1
      from public.student_complementary_generation_reservations as reservation
     where reservation.student_id = '00000000-0000-4000-8000-00000000f601'
       and reservation.request_key = '60000000-0000-4000-8000-00000000f601'
  )
  and (
    select count(*) = 1
      from public.student_verified_xp_awards as award
     where award.student_id = '00000000-0000-4000-8000-00000000f601'
       and award.source_type = 'CLASS_LOG_CONFIRM'
       and award.source_id = '70000000-0000-4000-8000-00000000f601'
  ),
  'blocked lifecycle replays changed an idempotency ledger'
);

update public.profiles
   set status = 'Ativo',
       lifecycle_status = 'active',
       offboarding_status = null
 where id = '00000000-0000-4000-8000-00000000f601';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f601"}';

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.learning_paths
     where id = '10000000-0000-4000-8000-00000000f601'
       and active is false
  ),
  'student lost read-only review of an archived completed path'
);

do $$
begin
  update public.profiles
     set current_book_part = 'A1-2'
   where id = auth.uid();
  raise exception 'assertion failed: student edited current_book_part directly';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'pedagogical_progression_fields_are_read_only' then
      raise;
    end if;
end;
$$;

do $$
begin
  update public.profiles
     set module = 'B2'
   where id = auth.uid();
  raise exception 'assertion failed: student edited module directly';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'pedagogical_module_is_not_self_editable' then
      raise;
    end if;
end;
$$;

do $$
declare
  v_first jsonb;
  v_replay jsonb;
begin
  v_first := public.complete_student_complementary_activity(
    '50000000-0000-4000-8000-00000000f601',
    '{"activityId":"50000000-0000-4000-8000-00000000f601","activityType":"reading","contentMode":"structured","checklistCompleted":["Li o texto."],"reflection":"Aprendi que um retry precisa preservar a mesma evidência.","completedAt":"2026-08-31T12:00:00Z"}'::jsonb,
    'learning-authority-complementary-replay-0001'
  );
  v_replay := public.complete_student_complementary_activity(
    '50000000-0000-4000-8000-00000000f601',
    '{"activityId":"50000000-0000-4000-8000-00000000f601","activityType":"reading","contentMode":"structured","checklistCompleted":["Li o texto."],"reflection":"Aprendi que um retry precisa preservar a mesma evidência.","completedAt":"2026-08-31T12:00:07Z"}'::jsonb,
    'learning-authority-complementary-replay-0001'
  );

  perform pg_temp.assert_true(
    coalesce((v_first ->> 'passed')::boolean, false)
    and coalesce((v_replay ->> 'alreadyApplied')::boolean, false)
    and coalesce((v_replay ->> 'canonicalResultAvailable')::boolean, false),
    'same-key complementary replay changed only by completedAt was rejected'
  );
end;
$$;

reset role;

insert into public.student_path_enrollments (
  id,
  student_id,
  path_id,
  tenant_id,
  current_unit_id,
  status,
  assigned_by
)
values (
  '40000000-0000-4000-8000-00000000f602',
  '00000000-0000-4000-8000-00000000f601',
  '10000000-0000-4000-8000-00000000f602',
  'learning-authority-a',
  '20000000-0000-4000-8000-00000000f602',
  'ACTIVE',
  '00000000-0000-4000-8000-00000000f611'
)
on conflict (id) do nothing;

insert into public.student_path_enrollments (
  id,
  student_id,
  path_id,
  tenant_id,
  current_unit_id,
  status,
  assigned_by
)
values (
  '40000000-0000-4000-8000-00000000f603',
  '00000000-0000-4000-8000-00000000f602',
  '10000000-0000-4000-8000-00000000f602',
  'learning-authority-a',
  '20000000-0000-4000-8000-00000000f602',
  'ACTIVE',
  '00000000-0000-4000-8000-00000000f611'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f611"}';

do $$
begin
  perform pg_catalog.set_config(
    'app.learning_path_archive_id',
    '10000000-0000-4000-8000-00000000f602',
    true
  );
  perform pg_catalog.set_config(
    'app.learning_path_archive_nonce',
    '70000000-0000-4000-8000-00000000f602',
    true
  );

  begin
    update public.learning_paths
       set active = false
     where id = '10000000-0000-4000-8000-00000000f602';
    raise exception 'assertion failed: forged archive GUC bypassed curriculum freeze';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'learning_path_curriculum_frozen_after_enrollment' then
        raise;
      end if;
  end;

  perform pg_catalog.set_config('app.learning_path_archive_id', '', true);
  perform pg_catalog.set_config('app.learning_path_archive_nonce', '', true);
end;
$$;

select pg_temp.assert_true(
  (
    select path.active is true
      from public.learning_paths as path
     where path.id = '10000000-0000-4000-8000-00000000f602'
  ),
  'forged archive GUC changed an enrolled path'
);

do $$
begin
  perform public.archive_learning_path(
    '10000000-0000-4000-8000-00000000f602',
    'Must remain active while assigned'
  );
  raise exception 'assertion failed: active learning path was archived';
exception
  when sqlstate '55000' then
    if sqlerrm <> 'learning_path_has_active_students' then
      raise;
    end if;
end;
$$;

reset role;

update public.profiles
   set status = 'Ativo',
       lifecycle_status = 'suspended',
       offboarding_status = null
 where id = '00000000-0000-4000-8000-00000000f602';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000f602"}';

select pg_temp.assert_true(
  not public._my_learning_access_is_active(),
  'offboarded student retained active pedagogical access'
);

do $$
begin
  perform public.get_student_practice_status();
  raise exception 'assertion failed: offboarded student read practice status';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'inactive_student_learning_access_forbidden' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.get_student_complementary_activities(50);
  raise exception 'assertion failed: offboarded student read complementary activities';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'inactive_student_learning_access_forbidden' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  (
    select count(*) = 0
      from public.learning_paths
     where tenant_id = 'learning-authority-a'
  ),
  'offboarded student retained direct curriculum read access'
);

do $$
begin
  perform public.enroll_student_learning_path(
    '10000000-0000-4000-8000-00000000f602',
    false,
    null,
    null
  );
  raise exception 'assertion failed: offboarded student enrolled in learning path';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'inactive_student_learning_mutation_forbidden' then
      raise;
    end if;
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select profile.module = 'C1'
           and profile.current_book_part = 'COMPLETED'
           and profile.evaluation_unlocked is false
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000f601'
  )
  and (
    select count(*) = 2
      from public.pedagogical_placement_audit as audit
     where audit.student_id = '00000000-0000-4000-8000-00000000f601'
  )
  and (
    select count(*) = 1
      from public.learning_path_archive_audit as audit
     where audit.path_id = '10000000-0000-4000-8000-00000000f601'
  )
  and not exists (
    select 1
      from private.learning_path_archive_capabilities
  ),
  'pedagogical placement or archive audit is incomplete'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.bookings as booking
      join public.profiles as student on student.id = booking.student_id
     where student.role = 'STUDENT'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             student.lifecycle_status,
             ''
           ))) in ('suspended', 'offboarded')
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             booking.status,
             ''
           ))) = 'SCHEDULED'
  ),
  'a suspended/offboarded student still occupies a teacher slot'
);

rollback;
