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

create or replace function pg_temp.valid_generated_activity_pack()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(
    jsonb_build_object(
      'type','reading','title','Valid reading pack','description','Read',
      'content','{"instructions_pt":"Read carefully","text":"A sufficiently long text for careful reading practice.","checklist":["Read"],"reflection_prompt":"What did you understand?"}',
      'difficulty','BEGINNER'
    ),
    jsonb_build_object(
      'type','grammar','title','Valid grammar pack','description','Grammar',
      'content','{"rule_pt":"Choose the right form.","exercises":[{"sentence":"She ___ daily.","options":["study","studies"],"correct":1}]}',
      'difficulty','BEGINNER'
    ),
    jsonb_build_object(
      'type','quiz','title','Valid quiz pack','description','Quiz',
      'content','{"instructions_pt":"Choose one.","questions":[{"q":"Choose B","options":["A","B"],"correct":1}]}',
      'difficulty','BEGINNER'
    ),
    jsonb_build_object(
      'type','conversation','title','Valid conversation pack','description','Speak',
      'content','{"scenario":"A meeting","instructions_pt":"Speak clearly.","preparation":["Plan"],"target_phrases":["Thank you"],"reflection_prompt":"What went well?"}',
      'difficulty','BEGINNER'
    )
  );
$$;
grant execute on function pg_temp.valid_generated_activity_pack() to public;

create or replace function pg_temp.authoritative_generated_activity_pack()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(
    jsonb_build_object(
      'type', 'reading',
      'title', 'Generated reading',
      'description', 'Read and reflect',
      'content', '{"instructions_pt":"Read carefully","text":"A sufficiently long text for careful reading practice.","checklist":["Read","Review"],"reflection_prompt":"What did you understand?"}',
      'difficulty', 'BEGINNER'
    ),
    jsonb_build_object(
      'type', 'grammar',
      'title', 'Generated grammar',
      'description', 'Practice grammar',
      'content', '{"rule_pt":"Choose the right form.","exercises":[{"id":"grammar-q1","sentence":"She ___ daily.","options":["study","studies"],"correct":1,"exp":"Use studies."}]}',
      'difficulty', 'INTERMEDIATE'
    ),
    jsonb_build_object(
      'type', 'quiz',
      'title', 'Generated quiz',
      'description', 'Answer questions',
      'content', '{"instructions_pt":"Answer","questions":[{"id":"generated-q1","q":"Choose B","options":["A","B"],"correct":1,"exp":"The second generated option is correct."}]}',
      'difficulty', 'INTERMEDIATE'
    ),
    jsonb_build_object(
      'type', 'conversation',
      'title', 'Generated conversation',
      'description', 'Speak and reflect',
      'content', '{"scenario":"A meeting","instructions_pt":"Speak for one minute.","preparation":["Plan your message"],"target_phrases":["Thanks for joining"],"reflection_prompt":"What went well?"}',
      'difficulty', 'ADVANCED'
    )
  );
$$;
grant execute on function pg_temp.authoritative_generated_activity_pack()
  to public;

select pg_temp.assert_true(
  to_regclass('public.learning_paths') is not null
  and to_regclass('public.learning_units') is not null
  and to_regclass('public.unit_activities') is not null
  and to_regclass('public.student_path_enrollments') is not null
  and to_regclass('public.student_activity_progress') is not null
  and to_regclass('public.student_skill_scores') is not null
  and to_regclass('public.student_activities') is not null
  and to_regclass('public.student_vocab_reviews') is not null,
  'ordered learning-path baseline is incomplete on a fresh restore'
);

select pg_temp.assert_true(
  pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE'),
  'student learning hardening revoked the private schema bridge used by existing authenticated RPCs'
);

select pg_temp.assert_true(
  exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'unit_activities'
       and column_name = 'content'
       and udt_name = 'jsonb'
  )
  and exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activity_progress'::regclass
       and conname = 'student_activity_progress_student_id_activity_id_key'
  ),
  'learning-path baseline columns or idempotency key are missing'
);

select pg_temp.assert_true(
  (
    select pg_catalog.count(*) = 14
      from information_schema.columns as column_definition
     where column_definition.table_schema = 'public'
       and column_definition.table_name = 'profiles'
       and column_definition.column_name in (
         'xp',
         'level',
         'daily_xp',
         'daily_xp_date',
         'daily_xp_goal',
         'last_activity',
         'hearts',
         'hearts_updated_at',
         'hearts_full_notified',
         'streak_count',
         'last_streak_date',
         'current_book_part',
         'evaluation_unlocked',
         'unlocked_tests'
       )
  ),
  'ordered baseline is missing a profile gamification field'
);

select pg_temp.assert_true(
  exists (
    select 1
      from information_schema.columns as column_definition
     where column_definition.table_schema = 'public'
       and column_definition.table_name = 'profiles'
       and column_definition.column_name = 'league_opt_in'
       and column_definition.is_nullable = 'NO'
       and column_definition.column_default = 'false'
  ),
  'leaderboard opt-in must be a non-null, explicit false-by-default choice'
);

select pg_temp.assert_true(
  has_function_privilege(
    'authenticated',
    'public.grade_quiz(uuid,integer[],text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.get_student_learning_path_runtime(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.complete_learning_activity(uuid,integer,integer,jsonb,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.enroll_student_learning_path(uuid,boolean,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.get_student_complementary_generation_status()',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.get_student_complementary_activities(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.complete_student_complementary_activity(uuid,jsonb,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.consume_student_heart(text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.get_student_practice_status()',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.get_student_opt_in_leaderboard(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.schedule_student_vocab_review(uuid,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.submit_student_vocab_review(uuid,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.begin_student_complementary_generation(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.release_student_complementary_generation(uuid,uuid,uuid,text)',
    'EXECUTE'
  ),
  'authenticated role is missing a student learning RPC grant'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.grade_quiz(uuid,integer[],text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_student_learning_path_runtime(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.complete_learning_activity(uuid,integer,integer,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.enroll_student_learning_path(uuid,boolean,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.save_student_generated_activities(uuid,jsonb,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_student_complementary_generation_status()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_student_complementary_activities(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_student_opt_in_leaderboard(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.schedule_student_vocab_review(uuid,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.submit_student_vocab_review(uuid,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.begin_student_complementary_generation(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.commit_student_complementary_generation(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.release_student_complementary_generation(uuid,uuid,uuid,text)',
    'EXECUTE'
  ),
  'anon can execute a student learning mutation RPC'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.save_student_generated_activities(uuid,jsonb,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.commit_student_complementary_generation(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.save_student_generated_activities(uuid,jsonb,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.commit_student_complementary_generation(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and to_regprocedure(
    'public.save_student_generated_activities(jsonb,text)'
  ) is null
  and to_regprocedure(
    'public.commit_student_complementary_generation(uuid,uuid,uuid)'
  ) is null,
  'generated pack persistence or commit is not service-only'
);

select pg_temp.assert_true(
  to_regprocedure('public.grade_quiz(uuid,integer[])') is null
  and to_regprocedure('public.grade_quiz(uuid,integer[],text)') is not null
  and (
    select procedure.pronargdefaults = 0
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.grade_quiz(uuid,integer[],text)'::regprocedure
  ),
  'legacy grade_quiz overload remains or request key is not mandatory'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.get_my_tenant_leaderboard(integer)',
    'EXECUTE'
  ),
  'legacy non-opt-in leaderboard remains browser-callable'
);

select pg_temp.assert_true(
  has_table_privilege(
    'authenticated',
    'public.student_path_enrollments',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_path_enrollments',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_activity_progress',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_skill_scores',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_activities',
    'INSERT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_activities',
    'UPDATE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_vocab_reviews',
    'INSERT,UPDATE,DELETE'
  )
  and not has_table_privilege(
    'authenticated',
    'public.student_complementary_generation_reservations',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and has_table_privilege(
    'authenticated',
    'public.learning_paths',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and has_table_privilege(
    'authenticated',
    'public.learning_units',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and has_table_privilege(
    'authenticated',
    'public.unit_activities',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'learning grants expose student writes or break the staff curriculum builder'
);

insert into public.tenants (id, name)
values
  ('learning-runtime-a', 'Learning Runtime A'),
  ('learning-runtime-b', 'Learning Runtime B');

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
    '00000000-0000-4000-8000-00000000e101',
    'authenticated',
    'authenticated',
    'learning-runtime-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Student A"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000e102',
    'authenticated',
    'authenticated',
    'learning-runtime-switch@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Switch Student"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000e103',
    'authenticated',
    'authenticated',
    'learning-runtime-generation@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Generation Student"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000e201',
    'authenticated',
    'authenticated',
    'learning-runtime-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Student B"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-00000000e301',
    'authenticated',
    'authenticated',
    'learning-runtime-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Learning Runtime Admin"}',
    now(),
    now()
  );

set local app.enrollment_claim = '1';

update public.profiles
   set tenant_id = 'learning-runtime-a',
       role = 'STUDENT',
       full_name = 'Learning Student A',
       lifecycle_status = 'active',
       xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       streak_count = 0,
       last_streak_date = null,
       last_activity = null,
       league_opt_in = true,
       league_display_name = 'Lobo Azul',
       hearts = 5,
       hearts_updated_at = now(),
       is_test_account = false,
       test_fixture_key = 'student-learning-runtime-test'
 where id = '00000000-0000-4000-8000-00000000e101';

update public.profiles
   set tenant_id = 'learning-runtime-a',
       role = 'STUDENT',
       full_name = 'Learning Switch Student',
       lifecycle_status = 'active',
       xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       streak_count = 0,
       last_streak_date = null,
       league_opt_in = false,
       league_display_name = null,
       hearts = 5,
       hearts_updated_at = now(),
       is_test_account = true,
       test_fixture_key = 'student-learning-runtime-switch-test'
 where id = '00000000-0000-4000-8000-00000000e102';

update public.profiles
   set tenant_id = 'learning-runtime-a',
       role = 'STUDENT',
       full_name = 'Learning Generation Student',
       lifecycle_status = 'active',
       xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       streak_count = 0,
       last_streak_date = null,
       league_opt_in = false,
       league_display_name = null,
       hearts = 5,
       hearts_updated_at = now(),
       is_test_account = true,
       test_fixture_key = 'student-learning-runtime-generation-test'
 where id = '00000000-0000-4000-8000-00000000e103';

update public.profiles
   set tenant_id = 'learning-runtime-b',
       role = 'STUDENT',
       full_name = 'Learning Student B',
       lifecycle_status = 'active',
       xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       streak_count = 0,
       last_streak_date = null,
       league_opt_in = true,
       league_display_name = 'Lobo de Outro Tenant',
       hearts = 5,
       hearts_updated_at = now(),
       is_test_account = true,
       test_fixture_key = 'student-learning-runtime-other-test'
 where id = '00000000-0000-4000-8000-00000000e201';

update public.profiles
   set tenant_id = 'learning-runtime-a',
       role = 'SCHOOL_ADMIN',
       full_name = 'Learning Runtime Admin',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'student-learning-runtime-admin-test'
 where id = '00000000-0000-4000-8000-00000000e301';

set local app.enrollment_claim = '';

-- A autoridade atual de tenant vem da associação ACTIVE, não do campo legado
-- profiles.tenant_id. As fixtures precisam atravessar a mesma fronteira usada
-- em produção para que o teste de isolamento não passe por contexto nulo.
insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values
  (
    '00000000-0000-4000-8000-00000000e101',
    'learning-runtime-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000e102',
    'learning-runtime-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000e103',
    'learning-runtime-a',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000e201',
    'learning-runtime-b',
    'STUDENT',
    'ACTIVE',
    true
  ),
  (
    '00000000-0000-4000-8000-00000000e301',
    'learning-runtime-a',
    'SCHOOL_ADMIN',
    'ACTIVE',
    true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-00000000e101', 'learning-runtime-a'),
  ('00000000-0000-4000-8000-00000000e102', 'learning-runtime-a'),
  ('00000000-0000-4000-8000-00000000e103', 'learning-runtime-a'),
  ('00000000-0000-4000-8000-00000000e201', 'learning-runtime-b'),
  ('00000000-0000-4000-8000-00000000e301', 'learning-runtime-a')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = pg_catalog.now();

insert into public.learning_paths (
  id,
  tenant_id,
  name,
  target_level,
  category,
  active
)
values
  (
    '10000000-0000-4000-8000-00000000e001',
    null,
    'Global ordered path',
    'B1',
    'GENERAL',
    true
  ),
  (
    '10000000-0000-4000-8000-00000000e002',
    'learning-runtime-a',
    'Tenant A alternate path',
    'B1',
    'GENERAL',
    true
  ),
  (
    '10000000-0000-4000-8000-00000000e003',
    'learning-runtime-b',
    'Tenant B private path',
    'B1',
    'GENERAL',
    true
  );

insert into public.learning_units (
  id,
  path_id,
  order_index,
  title,
  skill_focus
)
values
  (
    '20000000-0000-4000-8000-00000000e001',
    '10000000-0000-4000-8000-00000000e001',
    1,
    'Global unit',
    array['reading']::text[]
  ),
  (
    '20000000-0000-4000-8000-00000000e002',
    '10000000-0000-4000-8000-00000000e002',
    1,
    'Tenant A unit',
    array['speaking']::text[]
  ),
  (
    '20000000-0000-4000-8000-00000000e003',
    '10000000-0000-4000-8000-00000000e003',
    1,
    'Tenant B unit',
    array['reading']::text[]
  );

insert into public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  content,
  xp_reward
)
values
  (
    '30000000-0000-4000-8000-00000000e001',
    '20000000-0000-4000-8000-00000000e001',
    1,
    'vocab_cards',
    'Review before reading',
    '{"cards":[{"term":"safe","translation":"seguro","example":"This route is safe."}]}',
    90
  ),
  (
    '30000000-0000-4000-8000-00000000e005',
    '20000000-0000-4000-8000-00000000e001',
    2,
    'reading',
    'Server-graded reading',
    '{
      "text":"A safe reading passage.",
      "questions":[
        {
          "id":"reading-q1",
          "q":"Which option is correct?",
          "options":["wrong","right"],
          "correct":1,
          "exp":"The second option is correct.",
          "explanation":"Alias must stay private.",
          "explanation_pt":"Alias privado.",
          "feedback":"Private feedback alias."
        }
      ]
    }',
    0
  ),
  (
    '30000000-0000-4000-8000-00000000e002',
    '20000000-0000-4000-8000-00000000e001',
    3,
    'quiz',
    'Ordered final quiz',
    '{
      "questions":[
        {"q":"One?","options":["wrong","right"],"correct":1},
        {"q":"Two?","options":["right","wrong"],"correct":0}
      ]
    }',
    40
  ),
  (
    '30000000-0000-4000-8000-00000000e003',
    '20000000-0000-4000-8000-00000000e002',
    1,
    'speaking_wolfie',
    'Alternate speaking',
    '{"instructions_pt":"Speak with Wolfie"}',
    80
  ),
  (
    '30000000-0000-4000-8000-00000000e004',
    '20000000-0000-4000-8000-00000000e003',
    1,
    'reading',
    'Tenant B reading',
    '{"text":"Private","questions":[{"id":"tenant-b-q1","q":"Private?","options":["yes","no"],"correct":0}]}',
    80
  );

do $$
begin
  insert into public.unit_activities (
    unit_id,
    order_index,
    type,
    title,
    content
  ) values (
    '20000000-0000-4000-8000-00000000e002',
    99,
    'writing',
    'Unsupported activity',
    '{}'::jsonb
  );
  raise exception 'assertion failed: unsupported unit activity type was created';
exception
  when sqlstate '23514' then
    null;
end;
$$;

-- Curriculum inserts remain tenant-scoped, while child UPDATE/DELETE and path
-- retirement use the path-first authoritative commands installed later.
set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e301"}';

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.learning_paths
     where id in (
       '10000000-0000-4000-8000-00000000e001',
       '10000000-0000-4000-8000-00000000e002',
       '10000000-0000-4000-8000-00000000e003'
     )
  )
  and not exists (
    select 1
      from public.learning_paths
     where id = '10000000-0000-4000-8000-00000000e003'
  ),
  'school admin can read another tenant curriculum'
);

insert into public.learning_paths (
  id,
  tenant_id,
  name,
  active,
  created_by
) values (
  '10000000-0000-4000-8000-00000000e901',
  'learning-runtime-a',
  'Builder policy fixture',
  true,
  auth.uid()
);

insert into public.learning_units (
  id,
  path_id,
  order_index,
  title
) values (
  '20000000-0000-4000-8000-00000000e901',
  '10000000-0000-4000-8000-00000000e901',
  1,
  'Builder policy unit'
);

insert into public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  content
) values (
  '30000000-0000-4000-8000-00000000e901',
  '20000000-0000-4000-8000-00000000e901',
  1,
  'reading',
  'Builder policy activity',
  '{"text":"Tenant-scoped draft"}'::jsonb
);

select public.update_unit_activity(
  '30000000-0000-4000-8000-00000000e901',
  '{"title":"Builder policy activity updated"}'::jsonb
);

select pg_temp.assert_true(
  exists (
    select 1
      from public.unit_activities
     where id = '30000000-0000-4000-8000-00000000e901'
       and title = 'Builder policy activity updated'
  ),
  'school admin curriculum mutation RPC blocked its own tenant'
);

do $$
begin
  insert into public.learning_paths (
    tenant_id,
    name,
    active,
    created_by
  ) values (
    'learning-runtime-b',
    'Forbidden builder path',
    true,
    auth.uid()
  );
  raise exception 'assertion failed: school admin wrote another tenant path';
exception
  when sqlstate '42501' then
    null;
end;
$$;

do $$
begin
  delete from public.learning_paths
   where id = '10000000-0000-4000-8000-00000000e901';
  raise exception 'assertion failed: direct curriculum delete remained exposed';
exception
  when sqlstate '42501' then
    null;
end;
$$;

do $$
declare
  v_res jsonb;
begin
  v_res := public.archive_learning_path(
    '10000000-0000-4000-8000-00000000e901',
    'Retire obsolete builder fixture safely'
  );
  perform pg_temp.assert_true(
    v_res ->> 'active' = 'false'
    and exists (
      select 1
        from public.learning_paths
       where id = '10000000-0000-4000-8000-00000000e901'
         and active is false
    )
    and exists (
      select 1
        from public.unit_activities
       where id = '30000000-0000-4000-8000-00000000e901'
    ),
    'school admin could not archive a curriculum without deleting its content'
  );
end;
$$;

reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

do $$
begin
  perform public.save_student_generated_activities(
    '00000000-0000-4000-8000-00000000e101'::uuid,
    pg_temp.valid_generated_activity_pack(),
    'aaaaaaaa-0000-4000-8000-000000000010'::uuid,
    'aaaaaaaa-0000-4000-8000-000000000011'::uuid,
    'aaaaaaaa-0000-4000-8000-000000000012'::uuid
  );
  raise exception 'assertion failed: student called service-only pack persistence';
exception
  when sqlstate '42501' then
    null;
end;
$$;

select pg_temp.assert_true(
  (
    public.begin_student_complementary_generation(
      'aaaaaaaa-0000-4000-8000-000000000010'::uuid
    ) ->> 'allowed'
  )::boolean,
  'invalid-content fixture could not reserve a server generation lease'
);

reset role;

set local role service_role;

do $$
declare
  v_reservation public.student_complementary_generation_reservations%rowtype;
begin
  select *
    into strict v_reservation
    from public.student_complementary_generation_reservations as reservation
   where reservation.student_id =
           '00000000-0000-4000-8000-00000000e101'::uuid
     and reservation.request_key =
           'aaaaaaaa-0000-4000-8000-000000000010'::uuid;

  begin
    perform public.save_student_generated_activities(
      '00000000-0000-4000-8000-00000000e101'::uuid,
      pg_temp.valid_generated_activity_pack(),
      v_reservation.request_key,
      pg_catalog.gen_random_uuid(),
      pg_catalog.gen_random_uuid()
    );
    raise exception 'assertion failed: pack saved without its reservation';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'generation_reservation_not_owned' then
        raise;
      end if;
  end;

  begin
    perform public.save_student_generated_activities(
      '00000000-0000-4000-8000-00000000e101'::uuid,
      pg_temp.valid_generated_activity_pack(),
      v_reservation.request_key,
      v_reservation.id,
      pg_catalog.gen_random_uuid()
    );
    raise exception 'assertion failed: pack saved with the wrong lease token';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'generation_reservation_not_owned' then
        raise;
      end if;
  end;

  begin
  perform public.save_student_generated_activities(
    '00000000-0000-4000-8000-00000000e101'::uuid,
    jsonb_build_array(
      jsonb_build_object(
        'type','reading','title','Invalid pack reading','description','Read',
        'content','{"instructions_pt":"Read carefully","text":"A sufficiently long text for careful reading practice.","checklist":["Read"],"reflection_prompt":"What did you understand?"}',
        'difficulty','BEGINNER'
      ),
      jsonb_build_object(
        'type','grammar','title','Invalid empty grammar','description','Grammar',
        'content','{"rule_pt":"Choose the right form.","exercises":[]}',
        'difficulty','BEGINNER'
      ),
      jsonb_build_object(
        'type','quiz','title','Invalid pack quiz','description','Quiz',
        'content','{"instructions_pt":"Choose one.","questions":[{"q":"Choose B","options":["A","B"],"correct":1}]}',
        'difficulty','BEGINNER'
      ),
      jsonb_build_object(
        'type','conversation','title','Invalid pack conversation','description','Speak',
        'content','{"scenario":"A meeting","instructions_pt":"Speak clearly.","preparation":["Plan"],"target_phrases":["Thank you"],"reflection_prompt":"What went well?"}',
        'difficulty','BEGINNER'
      )
    ),
    v_reservation.request_key,
    v_reservation.id,
    v_reservation.lease_token
  );
  raise exception 'assertion failed: empty grammar exercise array was saved';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_generated_activity_content' then
      raise;
    end if;
  end;

  begin
  perform public.save_student_generated_activities(
    '00000000-0000-4000-8000-00000000e101'::uuid,
    pg_catalog.jsonb_set(
      pg_temp.valid_generated_activity_pack(),
      '{0,content}',
      pg_catalog.to_jsonb(
        '{"instructions_pt":"Read carefully","text":"A sufficiently long text for careful reading practice.","reflection_prompt":"What did you understand?"}'::text
      )
    ),
    v_reservation.request_key,
    v_reservation.id,
    v_reservation.lease_token
  );
  raise exception 'assertion failed: generated reading without checklist was saved';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_generated_activity_content' then
      raise;
    end if;
  end;
end;
$$;

reset role;

update public.student_complementary_generation_reservations
   set status = 'RELEASED',
       decision_code = 'RELEASED',
       completed_at = pg_catalog.now(),
       updated_at = pg_catalog.now()
 where student_id = '00000000-0000-4000-8000-00000000e101'::uuid
   and request_key = 'aaaaaaaa-0000-4000-8000-000000000010'::uuid;

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e103"}';

do $$
declare
  v_request_key uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_begin jsonb;
  v_replay jsonb;
begin
  v_begin := public.begin_student_complementary_generation(v_request_key);
  perform pg_temp.assert_true(
    (v_begin ->> 'allowed')::boolean
    and v_begin ->> 'code' = 'RESERVED'
    and not (v_begin ->> 'replay')::boolean,
    'first complementary generation was not reserved'
  );

  v_replay := public.begin_student_complementary_generation(v_request_key);
  perform pg_temp.assert_true(
    not (v_replay ->> 'allowed')::boolean
    and (v_replay ->> 'replay')::boolean
    and v_replay ->> 'code' = 'GENERATION_IN_PROGRESS'
    and v_replay ->> 'leaseToken' is null,
    'same active request key could start a duplicate provider invocation'
  );
end;
$$;

do $$
begin
  perform 1
    from public.student_complementary_generation_reservations;
  raise exception 'assertion failed: student read generation reservation table';
exception
  when sqlstate '42501' then
    null;
end;
$$;

reset role;

set local role service_role;

do $$
declare
  v_request_key uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_reservation public.student_complementary_generation_reservations%rowtype;
  v_saved jsonb;
  v_commit jsonb;
begin
  select *
    into strict v_reservation
    from public.student_complementary_generation_reservations as reservation
   where reservation.student_id =
           '00000000-0000-4000-8000-00000000e103'::uuid
     and reservation.request_key = v_request_key;

  v_saved := public.save_student_generated_activities(
    '00000000-0000-4000-8000-00000000e103'::uuid,
    pg_temp.valid_generated_activity_pack(),
    v_request_key,
    v_reservation.id,
    v_reservation.lease_token
  );
  perform pg_temp.assert_true(
    (v_saved ->> 'created')::boolean
    and not (v_saved ->> 'alreadyApplied')::boolean,
    'active service reservation did not persist its validated package'
  );

  v_saved := public.save_student_generated_activities(
    '00000000-0000-4000-8000-00000000e103'::uuid,
    pg_temp.valid_generated_activity_pack(),
    v_request_key,
    v_reservation.id,
    v_reservation.lease_token
  );
  perform pg_temp.assert_true(
    (v_saved ->> 'alreadyApplied')::boolean,
    'service persistence retry was not idempotent'
  );

  v_commit := public.commit_student_complementary_generation(
    '00000000-0000-4000-8000-00000000e103'::uuid,
    v_reservation.id,
    v_reservation.lease_token,
    v_request_key
  );
  perform pg_temp.assert_true(
    v_commit ->> 'status' = 'COMMITTED'
    and not (v_commit ->> 'replay')::boolean
    and pg_catalog.jsonb_array_length(v_commit -> 'activities') = 4
    and (v_commit -> 'activities')::text !~
      '"(correct|correctIndex|correct_option_index|exp|explanation|explanation_pt|feedback)"[[:space:]]*:',
    'committed generation did not return a sanitized persisted package'
  );

  v_commit := public.commit_student_complementary_generation(
    '00000000-0000-4000-8000-00000000e103'::uuid,
    v_reservation.id,
    v_reservation.lease_token,
    v_request_key
  );
  perform pg_temp.assert_true(
    (v_commit ->> 'replay')::boolean
    and v_commit ->> 'code' = 'ALREADY_COMMITTED',
    'generation commit retry was not idempotent'
  );

  v_saved := public.save_student_generated_activities(
    '00000000-0000-4000-8000-00000000e103'::uuid,
    pg_temp.valid_generated_activity_pack(),
    v_request_key,
    v_reservation.id,
    v_reservation.lease_token
  );
  perform pg_temp.assert_true(
    (v_saved ->> 'alreadyApplied')::boolean,
    'committed package persistence retry was not canonical'
  );
end;
$$;

reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e103"}';

do $$
declare
  v_replay jsonb;
begin
  v_replay := public.begin_student_complementary_generation(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid
  );

  perform pg_temp.assert_true(
    not (v_replay ->> 'allowed')::boolean
    and (v_replay ->> 'replay')::boolean
    and v_replay ->> 'code' = 'ALREADY_COMMITTED'
    and pg_catalog.jsonb_array_length(v_replay -> 'activities') = 4,
    'committed generation request was not replay-safe'
  );
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.student_complementary_generation_reservations as reservation
     where reservation.student_id = '00000000-0000-4000-8000-00000000e103'
       and reservation.status = 'COMMITTED'
  )
  and (
    select count(*) = 4
      from public.student_activities as activity
     where activity.student_id = '00000000-0000-4000-8000-00000000e103'
  ),
  'generation replay duplicated reservation or activity rows'
);

insert into public.student_complementary_generation_reservations (
  tenant_id,
  student_id,
  request_key,
  lease_token,
  status,
  decision_code,
  lease_expires_at,
  completed_at,
  created_at,
  updated_at
) values (
  'learning-runtime-b',
  '00000000-0000-4000-8000-00000000e201',
  'bbbbbbbb-0000-4000-8000-000000000000'::uuid,
  'cccccccc-0000-4000-8000-000000000000'::uuid,
  'EXPIRED',
  'LEASE_EXPIRED',
  now() - interval '1 minute',
  now() - interval '1 minute',
  now(),
  now()
);

insert into public.student_complementary_generation_reservations (
  tenant_id,
  student_id,
  request_key,
  lease_token,
  status,
  decision_code,
  completed_at,
  created_at,
  updated_at
) values (
  'learning-runtime-b',
  '00000000-0000-4000-8000-00000000e201',
  'bbbbbbbb-0000-4000-8000-000000000002'::uuid,
  'cccccccc-0000-4000-8000-000000000002'::uuid,
  'DENIED',
  'GENERATION_IN_PROGRESS',
  now(),
  now(),
  now()
);

set local role service_role;

do $$
declare
  v_reservation public.student_complementary_generation_reservations%rowtype;
begin
  for v_reservation in
    select *
      from public.student_complementary_generation_reservations as reservation
     where reservation.student_id =
             '00000000-0000-4000-8000-00000000e201'::uuid
       and reservation.status in ('EXPIRED', 'DENIED')
  loop
    begin
      perform public.save_student_generated_activities(
        v_reservation.student_id,
        pg_temp.valid_generated_activity_pack(),
        v_reservation.request_key,
        v_reservation.id,
        v_reservation.lease_token
      );
      raise exception 'assertion failed: inactive reservation persisted a pack';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'generation_reservation_not_active' then
          raise;
        end if;
    end;
  end loop;
end;
$$;

reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e201"}';

do $$
declare
  v_first jsonb;
  v_result jsonb;
  v_index integer;
begin
  v_result := public.begin_student_complementary_generation(
    'bbbbbbbb-0000-4000-8000-000000000000'::uuid
  );
  perform pg_temp.assert_true(
    (v_result ->> 'allowed')::boolean
    and (v_result ->> 'replay')::boolean
    and v_result ->> 'code' = 'RESERVED'
    and v_result ->> 'leaseToken' <>
          'cccccccc-0000-4000-8000-000000000000',
    'expired request key did not rotate into a retryable lease'
  );
  perform public.release_student_complementary_generation(
    (v_result ->> 'reservationId')::uuid,
    (v_result ->> 'leaseToken')::uuid,
    'bbbbbbbb-0000-4000-8000-000000000000'::uuid,
    'retry_fixture'
  );

  v_first := public.begin_student_complementary_generation(
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid
  );
  perform pg_temp.assert_true(
    (v_first ->> 'allowed')::boolean,
    'first tab did not acquire a generation lease'
  );

  v_result := public.begin_student_complementary_generation(
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid
  );
  perform pg_temp.assert_true(
    not (v_result ->> 'allowed')::boolean
    and (v_result ->> 'replay')::boolean
    and v_result ->> 'code' = 'GENERATION_IN_PROGRESS'
    and v_result ->> 'leaseToken' is null,
    'same generation request could start a concurrent provider call'
  );

  v_result := public.begin_student_complementary_generation(
    'bbbbbbbb-0000-4000-8000-000000000002'::uuid
  );
  perform pg_temp.assert_true(
    not (v_result ->> 'allowed')::boolean
    and v_result ->> 'code' = 'GENERATION_IN_PROGRESS',
    'second tab acquired a concurrent generation lease'
  );

  v_result := public.release_student_complementary_generation(
    (v_first ->> 'reservationId')::uuid,
    (v_first ->> 'leaseToken')::uuid,
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid,
    'provider_failed'
  );
  perform pg_temp.assert_true(
    v_result ->> 'status' = 'RELEASED'
    and not (v_result ->> 'replay')::boolean,
    'generation lease was not released'
  );

  v_result := public.release_student_complementary_generation(
    (v_first ->> 'reservationId')::uuid,
    (v_first ->> 'leaseToken')::uuid,
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid,
    'provider_failed'
  );
  perform pg_temp.assert_true(
    (v_result ->> 'replay')::boolean,
    'generation release retry was not idempotent'
  );

  v_result := public.begin_student_complementary_generation(
    'bbbbbbbb-0000-4000-8000-000000000002'::uuid
  );
  perform pg_temp.assert_true(
    (v_result ->> 'allowed')::boolean
    and (v_result ->> 'replay')::boolean
    and v_result ->> 'code' = 'RESERVED'
    and v_result ->> 'leaseToken' <>
          'cccccccc-0000-4000-8000-000000000002',
    'denied concurrent request did not reactivate after the lease cleared'
  );
  perform public.release_student_complementary_generation(
    (v_result ->> 'reservationId')::uuid,
    (v_result ->> 'leaseToken')::uuid,
    'bbbbbbbb-0000-4000-8000-000000000002'::uuid,
    'provider_failed_after_reactivation'
  );

  v_result := public.begin_student_complementary_generation(
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid
  );
  perform pg_temp.assert_true(
    (v_result ->> 'allowed')::boolean
    and (v_result ->> 'replay')::boolean
    and v_result ->> 'leaseToken' <> v_first ->> 'leaseToken',
    'released request key did not receive a fresh retry lease'
  );
  perform public.release_student_complementary_generation(
    (v_result ->> 'reservationId')::uuid,
    (v_result ->> 'leaseToken')::uuid,
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid,
    'provider_failed_again'
  );

  v_result := public.begin_student_complementary_generation(
    'bbbbbbbb-0000-4000-8000-000000000003'::uuid
  );
  perform pg_temp.assert_true(
    not (v_result ->> 'allowed')::boolean
    and v_result ->> 'code' = 'DAILY_LIMIT_REACHED',
    'daily complementary generation cost limit was not enforced'
  );

  for v_index in 1..12 loop
    v_result := public.begin_student_complementary_generation(
      pg_catalog.gen_random_uuid()
    );
    perform pg_temp.assert_true(
      not (v_result ->> 'allowed')::boolean
      and v_result ->> 'code' = 'DAILY_LIMIT_REACHED',
      'daily denial changed across repeated request keys'
    );
  end loop;
end;
$$;

reset role;

set local role service_role;

do $$
declare
  v_reservation public.student_complementary_generation_reservations%rowtype;
begin
  select *
    into strict v_reservation
    from public.student_complementary_generation_reservations as reservation
   where reservation.student_id =
           '00000000-0000-4000-8000-00000000e201'::uuid
     and reservation.request_key =
           'bbbbbbbb-0000-4000-8000-000000000002'::uuid;

  begin
    perform public.save_student_generated_activities(
      v_reservation.student_id,
      pg_temp.valid_generated_activity_pack(),
      v_reservation.request_key,
      v_reservation.id,
      v_reservation.lease_token
    );
    raise exception 'assertion failed: released lease persisted a package';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'generation_reservation_not_active' then
        raise;
      end if;
  end;
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select count(*) filter (where status = 'RELEASED') = 3
           and count(*) filter (
             where decision_code = 'GENERATION_IN_PROGRESS'
           ) = 0
           and count(*) filter (
             where decision_code = 'DAILY_LIMIT_REACHED'
           ) = 0
           and count(*) filter (where status = 'RESERVED') = 0
           and count(*) = 3
      from public.student_complementary_generation_reservations as reservation
     where reservation.student_id = '00000000-0000-4000-8000-00000000e201'
  ),
  'generation lease concurrency, release or daily ledger is inconsistent'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.learning_paths
     where id in (
       '10000000-0000-4000-8000-00000000e001',
       '10000000-0000-4000-8000-00000000e002',
       '10000000-0000-4000-8000-00000000e003'
     )
  )
  and not exists (
    select 1
      from public.learning_paths
     where id = '10000000-0000-4000-8000-00000000e003'
  ),
  'student can read another tenant curriculum'
);

select pg_temp.assert_true(
  public.enroll_student_learning_path(
    '10000000-0000-4000-8000-00000000e001',
    false,
    null,
    null
  ) ->> 'status' = 'ACTIVE',
  'student could not enroll in a global path'
);

do $$
begin
  perform public.schedule_student_vocab_review(
    '30000000-0000-4000-8000-00000000e001',
    'safe',
    'seguro',
    'An example that is not part of the activity.'
  );
  raise exception 'assertion failed: invented vocab card was scheduled';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'vocab_review_card_not_in_activity' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  (
    public.schedule_student_vocab_review(
      '30000000-0000-4000-8000-00000000e001',
      'safe',
      'seguro',
      'This route is safe.'
    ) ->> 'term'
  ) = 'safe',
  'owned current vocab card was not scheduled'
);

select pg_temp.assert_true(
  (
    select (
      public.submit_student_vocab_review(
        review.id,
        true,
        'vocab-review-request-0001'
      ) ->> 'intervalDays'
    )::integer = 3
      from public.student_vocab_reviews as review
     where review.student_id = auth.uid()
       and review.term = 'safe'
  ),
  'server-side SRS interval was not advanced'
);

select pg_temp.assert_true(
  (
    select (
      public.submit_student_vocab_review(
        review.id,
        true,
        'vocab-review-request-0001'
      ) ->> 'alreadyApplied'
    )::boolean
      from public.student_vocab_reviews as review
     where review.student_id = auth.uid()
       and review.term = 'safe'
  ),
  'vocab review retry was not idempotent'
);

do $$
begin
  update public.student_vocab_reviews
     set interval_days = 3650
   where student_id = auth.uid();
  raise exception 'assertion failed: student updated SRS directly';
exception
  when sqlstate '42501' then
    null;
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select review.total_reviews = 1
           and review.consecutive_correct = 1
           and review.interval_days = 3
      from public.student_vocab_reviews as review
     where review.student_id = '00000000-0000-4000-8000-00000000e101'
       and review.term = 'safe'
  )
  and (
    select count(*) = 1
      from public.student_vocab_review_attempts as attempt
     where attempt.student_id = '00000000-0000-4000-8000-00000000e101'
       and attempt.request_key = 'vocab-review-request-0001'
  )
  and (
    select profile.streak_count = 1
           and profile.last_activity is not null
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000e101'
  ),
  'vocab review replay duplicated SRS or practice effects'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (select count(*) = 0 from public.unit_activities)
  and exists (
    select 1
      from pg_catalog.jsonb_array_elements(
        public.get_student_learning_path_runtime(
          '10000000-0000-4000-8000-00000000e001'
        ) -> 'activities'
      ) as runtime_activity(value)
     where runtime_activity.value ->> 'id' =
             '30000000-0000-4000-8000-00000000e001'
       and not (runtime_activity.value ->> 'locked')::boolean
       and runtime_activity.value -> 'content' <> 'null'::jsonb
  )
  and exists (
    select 1
      from pg_catalog.jsonb_array_elements(
        public.get_student_learning_path_runtime(
          '10000000-0000-4000-8000-00000000e001'
        ) -> 'activities'
      ) as runtime_activity(value)
     where runtime_activity.value ->> 'id' =
             '30000000-0000-4000-8000-00000000e005'
       and (runtime_activity.value ->> 'locked')::boolean
       and runtime_activity.value -> 'content' = 'null'::jsonb
  ),
  'student read raw answer keys or received locked future content'
);

do $$
begin
  perform public.grade_quiz(
    '30000000-0000-4000-8000-00000000e002',
    array[1, 0]::integer[],
    'prerequisite-guard-request-0001'
  );
  raise exception 'assertion failed: quiz bypassed the current prerequisite';
exception
  when sqlstate 'P0001' then
    if sqlerrm <> 'learning_activity_not_current' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  not (
    public.complete_learning_activity(
      '30000000-0000-4000-8000-00000000e001',
      50,
      30,
      '{"activityType":"vocab_cards","score":50,"completedAt":"2026-08-31T11:59:00Z"}',
      'reading-failed-request-0001'
    ) ->> 'passed'
  )::boolean,
  'sub-60 non-quiz activity incorrectly advanced'
);

select pg_temp.assert_true(
  (
    public.complete_learning_activity(
      '30000000-0000-4000-8000-00000000e001',
      50,
      30,
      '{"activityType":"vocab_cards","score":50,"completedAt":"2026-08-31T11:59:05Z"}',
      'reading-failed-request-0001'
    ) ->> 'alreadyApplied'
  )::boolean,
  'failed non-quiz retry was not idempotent'
);

reset role;

select pg_temp.assert_true(
  (
    select progress.status = 'IN_PROGRESS'
           and progress.attempts = 1
           and progress.completed_at is null
      from public.student_activity_progress as progress
     where progress.student_id = '00000000-0000-4000-8000-00000000e101'
       and progress.activity_id = '30000000-0000-4000-8000-00000000e001'
  )
  and exists (
    select 1
      from private.next_incomplete_learning_activity(
        '00000000-0000-4000-8000-00000000e101',
        '10000000-0000-4000-8000-00000000e001'
      ) as next_activity
     where next_activity.activity_id =
       '30000000-0000-4000-8000-00000000e001'
  ),
  'failed non-quiz completion released the next activity'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (public.get_student_complementary_generation_status() ->> 'pendingCount')::integer = 0
  and (public.get_student_complementary_generation_status() ->> 'canGenerate')::boolean,
  'empty complementary queue was not generation-ready'
);

select pg_temp.assert_true(
  (
    public.complete_learning_activity(
      '30000000-0000-4000-8000-00000000e001',
      90,
      120,
      '{"activityType":"vocab_cards","score":90,"completedAt":"2026-08-31T12:00:00Z"}',
      'reading-completion-request-0001'
    ) ->> 'status'
  ) = 'COMPLETED',
  'current non-quiz activity did not complete'
);

select pg_temp.assert_true(
  (
    public.complete_learning_activity(
      '30000000-0000-4000-8000-00000000e001',
      90,
      120,
      '{"activityType":"vocab_cards","score":90,"completedAt":"2026-08-31T12:00:05Z"}',
      'reading-completion-request-0001'
    ) ->> 'alreadyApplied'
  )::boolean,
  'non-quiz completion retry was not idempotent'
);

reset role;

select pg_temp.assert_true(
  (
    select progress.status = 'COMPLETED'
           and progress.attempts = 2
           and progress.time_spent_seconds = 150
      from public.student_activity_progress as progress
     where progress.student_id = '00000000-0000-4000-8000-00000000e101'
       and progress.activity_id = '30000000-0000-4000-8000-00000000e001'
  ),
  'idempotent non-quiz retry duplicated progress counters'
);

select pg_temp.assert_true(
  (
    select profile.xp = 0
           and profile.streak_count = 1
           and profile.last_streak_date =
             (now() at time zone 'America/Sao_Paulo')::date
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000e101'
  ),
  'non-quiz completion changed XP or failed to update server streak'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.jsonb_array_elements(
        public.get_student_learning_path_runtime(
          '10000000-0000-4000-8000-00000000e001'
        ) -> 'activities'
      ) as runtime_activity(value)
     where runtime_activity.value ->> 'id' =
             '30000000-0000-4000-8000-00000000e005'
       and not (runtime_activity.value ->> 'locked')::boolean
       and (
         runtime_activity.value -> 'content'
       )::text !~ '"(correct|correctIndex|correct_option_index|exp|explanation|explanation_pt|feedback)"[[:space:]]*:'
  )
  and exists (
    select 1
      from pg_catalog.jsonb_array_elements(
        public.get_student_learning_path_runtime(
          '10000000-0000-4000-8000-00000000e001'
        ) -> 'activities'
      ) as runtime_activity(value)
     where runtime_activity.value ->> 'id' =
             '30000000-0000-4000-8000-00000000e002'
       and (runtime_activity.value ->> 'locked')::boolean
       and runtime_activity.value -> 'content' = 'null'::jsonb
  ),
  'runtime leaked a reading answer key or future final quiz content'
);

select pg_temp.assert_true(
  (public.grade_quiz(
      '30000000-0000-4000-8000-00000000e005',
      array[1]::integer[],
      'reading-graded-request-0001'
    ) ->> 'passed')::boolean
  and public.grade_quiz(
        '30000000-0000-4000-8000-00000000e005',
        array[1]::integer[],
        'reading-graded-request-0001'
      ) -> 'questionResults' -> 0 ->> 'questionId' = 'reading-q1'
  and (
    public.grade_quiz(
      '30000000-0000-4000-8000-00000000e005',
      array[1]::integer[],
      'reading-graded-request-0001'
    ) -> 'questionResults' -> 0 ->> 'correct'
  )::boolean
  and (
    public.grade_quiz(
      '30000000-0000-4000-8000-00000000e005',
      array[1]::integer[],
      'reading-graded-request-0001'
    ) -> 'questionResults' -> 0 ->> 'correctIndex'
  )::integer = 1
  and public.grade_quiz(
        '30000000-0000-4000-8000-00000000e005',
        array[1]::integer[],
        'reading-graded-request-0001'
      ) -> 'questionResults' -> 0 ->> 'explanation' =
        'The second option is correct.',
  'reading was not graded with authoritative replay-safe feedback'
);

do $$
declare
  v_first jsonb;
  v_replay jsonb;
begin
  v_first := public.grade_quiz(
    '30000000-0000-4000-8000-00000000e002',
    array[0, 1]::integer[],
    'quiz-failed-request-0001'
  );
  v_replay := public.grade_quiz(
    '30000000-0000-4000-8000-00000000e002',
    array[0, 1]::integer[],
    'quiz-failed-request-0001'
  );

  perform pg_temp.assert_true(
    not (v_first ->> 'passed')::boolean
      and (v_first ->> 'hearts')::integer = 3
      and (v_first ->> 'heartsConsumed')::integer = 2,
    'wrong quiz answers did not atomically consume exactly two hearts'
  );
  perform pg_temp.assert_true(
    (v_replay ->> 'alreadyApplied')::boolean
      and (v_replay ->> 'hearts')::integer = 3
      and (v_replay ->> 'heartsConsumed')::integer = 0,
    'lost-response retry duplicated grading or heart consumption'
  );
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select progress.status = 'IN_PROGRESS'
           and progress.completed_at is null
           and progress.attempts = 1
      from public.student_activity_progress as progress
     where progress.student_id = '00000000-0000-4000-8000-00000000e101'
       and progress.activity_id = '30000000-0000-4000-8000-00000000e002'
  ),
  'failed quiz was marked complete'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.student_verified_xp_awards as award
     where award.student_id = '00000000-0000-4000-8000-00000000e101'
       and award.source_type = 'LEARNING_PATH_QUIZ'
       and award.source_id = '30000000-0000-4000-8000-00000000e002'
  )
  and exists (
    select 1
      from private.next_incomplete_learning_activity(
        '00000000-0000-4000-8000-00000000e101',
        '10000000-0000-4000-8000-00000000e001'
      ) as next_activity
     where next_activity.activity_id =
       '30000000-0000-4000-8000-00000000e002'
  ),
  'failed quiz awarded XP or released the next step'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (public.grade_quiz(
    '30000000-0000-4000-8000-00000000e002',
    array[1, 0]::integer[],
    'quiz-passed-request-0001'
  ) ->> 'passed')::boolean,
  'correct quiz answers did not pass'
);

-- This exact retry happens after the final quiz already completed the path.
select pg_temp.assert_true(
  (public.grade_quiz(
    '30000000-0000-4000-8000-00000000e002',
    array[1, 0]::integer[],
    'quiz-passed-request-0001'
  ) ->> 'alreadyApplied')::boolean,
  'lost-response retry of a completed final quiz was not replay-safe'
);

reset role;

select pg_temp.assert_true(
  (
    select enrollment.status = 'COMPLETED'
           and enrollment.completed_at is not null
           and enrollment.current_unit_id is null
      from public.student_path_enrollments as enrollment
     where enrollment.student_id = '00000000-0000-4000-8000-00000000e101'
       and enrollment.path_id = '10000000-0000-4000-8000-00000000e001'
  ),
  'passing final quiz did not complete the enrollment'
);

select pg_temp.assert_true(
  (
    select profile.xp = 40
           and profile.level = 1
           and profile.streak_count = 1
           and profile.hearts = 3
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000e101'
  )
  and (
    select count(*) = 1
      from public.student_verified_xp_awards as award
     where award.student_id = '00000000-0000-4000-8000-00000000e101'
       and award.source_type = 'LEARNING_PATH_QUIZ'
       and award.source_id = '30000000-0000-4000-8000-00000000e002'
  )
  and (
    select count(*) = 2
      from public.student_learning_activity_attempts as attempt
     where attempt.student_id = '00000000-0000-4000-8000-00000000e101'
       and attempt.activity_id = '30000000-0000-4000-8000-00000000e002'
       and attempt.attempt_kind = 'QUIZ'
  )
  and (
    select count(*) = 2
      from public.student_heart_consumptions as consumption
     where consumption.student_id = '00000000-0000-4000-8000-00000000e101'
       and consumption.request_key like 'learning-heart-%'
  ),
  'quiz retry duplicated XP, streak, attempt history or heart consumption'
);

select pg_temp.assert_true(
  exists (
    select 1
      from public.student_skill_scores as skill
     where skill.student_id = '00000000-0000-4000-8000-00000000e101'
       and skill.skill = 'grammar'
       and skill.total_activities = 2
       and skill.current_score between 0 and 100
  ),
  'quiz skill personalization was not updated server-side'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  pg_catalog.jsonb_array_length(
    public.get_student_opt_in_leaderboard(5)
  ) = 1
  and public.get_student_opt_in_leaderboard(5) -> 0 ->> 'displayName' =
        'Lobo Azul'
  and (
    public.get_student_opt_in_leaderboard(5) -> 0 ->> 'xp'
  )::integer = 40
  and (
    (public.get_student_opt_in_leaderboard(5) -> 0)
      - 'displayName'
      - 'xp'
  ) = '{}'::jsonb,
  'leaderboard leaked opt-out, civil-name, cross-tenant or internal fields'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

do $$
begin
  perform public.enroll_student_learning_path(
    '10000000-0000-4000-8000-00000000e003',
    false,
    null,
    null
  );
  raise exception 'assertion failed: student enrolled in another tenant path';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'learning_path_not_available' then
      raise;
    end if;
end;
$$;

reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e102"}';

select public.enroll_student_learning_path(
  '10000000-0000-4000-8000-00000000e001',
  false,
  null,
  null
);

do $$
begin
  perform public.enroll_student_learning_path(
    '10000000-0000-4000-8000-00000000e002',
    false,
    null,
    null
  );
  raise exception 'assertion failed: active path switched implicitly';
exception
  when sqlstate 'P0001' then
    if sqlerrm <> 'active_path_switch_required' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  (public.enroll_student_learning_path(
    '10000000-0000-4000-8000-00000000e002',
    true,
    'Student explicitly chose the speaking path',
    null
  ) ->> 'switched')::boolean,
  'explicit path switch did not report the transition'
);

reset role;

select pg_temp.assert_true(
  (
    select enrollment.status = 'SWITCHED'
           and enrollment.status_reason =
             'Student explicitly chose the speaking path'
           and enrollment.completed_at is not null
      from public.student_path_enrollments as enrollment
     where enrollment.student_id = '00000000-0000-4000-8000-00000000e102'
       and enrollment.path_id = '10000000-0000-4000-8000-00000000e001'
  )
  and (
    select count(*) = 1
      from public.student_path_enrollments as enrollment
     where enrollment.student_id = '00000000-0000-4000-8000-00000000e102'
       and enrollment.status = 'ACTIVE'
       and enrollment.completed_at is null
  )
  and exists (
    select 1
      from public.student_path_enrollment_history as history
     where history.student_id = '00000000-0000-4000-8000-00000000e102'
       and history.event_type = 'SWITCHED_OUT'
       and history.reason = 'Student explicitly chose the speaking path'
  ),
  'explicit path switch lost status, reason or history'
);

insert into public.wolfie_sessions (
  id,
  tenant_id,
  student_id,
  topic,
  mode,
  student_level,
  turn_count
) values
  (
    '50000000-0000-4000-8000-00000000e102',
    'learning-runtime-a',
    '00000000-0000-4000-8000-00000000e102',
    'Speaking verification',
    'fluency',
    'A1',
    4
  ),
  (
    '50000000-0000-4000-8000-00000000e103',
    'learning-runtime-a',
    '00000000-0000-4000-8000-00000000e102',
    'Incomplete speaking verification',
    'fluency',
    'A1',
    1
  ),
  (
    '50000000-0000-4000-8000-00000000e201',
    'learning-runtime-b',
    '00000000-0000-4000-8000-00000000e201',
    'Foreign speaking verification',
    'fluency',
    'A1',
    4
  );

insert into public.student_learning_activity_attempts (
  tenant_id,
  student_id,
  activity_id,
  attempt_kind,
  request_key,
  request_payload,
  score,
  passed,
  result
) values (
  'learning-runtime-a',
  '00000000-0000-4000-8000-00000000e102',
  '30000000-0000-4000-8000-00000000e001',
  'COMPLETION',
  'speaking-reuse-fixture-request-0001',
  '{"evidence":{"wolfieConversationId":"50000000-0000-4000-8000-00000000e102"}}'::jsonb,
  80,
  true,
  '{}'::jsonb
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e102"}';

do $$
begin
  perform public.complete_learning_activity(
    '30000000-0000-4000-8000-00000000e003',
    80,
    90,
    '{"activityType":"speaking_wolfie","score":80}'::jsonb,
    'speaking-invalid-evidence-request-0001'
  );
  raise exception 'assertion failed: empty speaking evidence completed activity';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_speaking_activity_evidence' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.complete_learning_activity(
    '30000000-0000-4000-8000-00000000e003',
    80,
    90,
    '{"activityType":"speaking_wolfie","score":80,"learnerTurns":2,"sessionCompleted":true,"wolfieConversationId":"50000000-0000-4000-8000-00000000e201"}'::jsonb,
    'speaking-foreign-session-request-0001'
  );
  raise exception 'assertion failed: foreign Wolfie session completed activity';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_speaking_activity_evidence' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.complete_learning_activity(
    '30000000-0000-4000-8000-00000000e003',
    80,
    90,
    '{"activityType":"speaking_wolfie","score":80,"learnerTurns":2,"sessionCompleted":true,"wolfieConversationId":"50000000-0000-4000-8000-00000000e103"}'::jsonb,
    'speaking-short-session-request-0001'
  );
  raise exception 'assertion failed: one-turn Wolfie session completed activity';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_speaking_activity_evidence' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.complete_learning_activity(
    '30000000-0000-4000-8000-00000000e003',
    80,
    90,
    '{"activityType":"speaking_wolfie","score":80,"learnerTurns":2,"sessionCompleted":true,"wolfieConversationId":"50000000-0000-4000-8000-00000000e102"}'::jsonb,
    'speaking-reused-session-request-0001'
  );
  raise exception 'assertion failed: reused Wolfie session completed another activity';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_speaking_activity_evidence' then
      raise;
    end if;
end;
$$;

reset role;

delete from public.student_learning_activity_attempts
 where request_key = 'speaking-reuse-fixture-request-0001';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e102"}';

select pg_temp.assert_true(
  (
    public.complete_learning_activity(
      '30000000-0000-4000-8000-00000000e003',
      80,
      90,
      '{"activityType":"speaking_wolfie","score":80,"learnerTurns":2,"sessionCompleted":true,"wolfieConversationId":"50000000-0000-4000-8000-00000000e102"}'::jsonb,
      'speaking-valid-evidence-request-0001'
    ) ->> 'status'
  ) = 'COMPLETED',
  'verified speaking summary did not complete current activity'
);

reset role;

select pg_temp.assert_true(
  (
    select profile.xp = 0 and profile.streak_count = 1
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000e102'
  )
  and (
    select progress.status = 'COMPLETED'
      from public.student_activity_progress as progress
     where progress.student_id = '00000000-0000-4000-8000-00000000e102'
       and progress.activity_id = '30000000-0000-4000-8000-00000000e003'
  ),
  'speaking completion changed XP or lost authoritative progress'
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
) values (
  '40000000-0000-4000-8000-00000000e102',
  '00000000-0000-4000-8000-00000000e102',
  'learning-runtime-a',
  'reading',
  'Existing partial package item',
  '{"instructions_pt":"Read","text":"An existing reading exercise long enough to remain pending.","checklist":["Read"],"reflection_prompt":"What did you learn?"}',
  0,
  'PENDING',
  true
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e102"}';

select pg_temp.assert_true(
  (public.get_student_complementary_generation_status() ->> 'pendingCount')::integer = 1
  and not (public.get_student_complementary_generation_status() ->> 'canGenerate')::boolean,
  'one pending activity did not block a whole replacement package'
);

select pg_temp.assert_true(
  not (
    public.begin_student_complementary_generation(
      'dddddddd-0000-4000-8000-000000000001'::uuid
    ) ->> 'allowed'
  )::boolean
  and public.begin_student_complementary_generation(
        'dddddddd-0000-4000-8000-000000000001'::uuid
      ) ->> 'code' = 'PENDING_PACKAGE'
  and pg_catalog.jsonb_array_length(
        public.begin_student_complementary_generation(
          'dddddddd-0000-4000-8000-000000000001'::uuid
        ) -> 'activities'
      ) = 1
  and (
    public.begin_student_complementary_generation(
      'dddddddd-0000-4000-8000-000000000001'::uuid
    ) -> 'activities'
  )::text !~
    '"(correct|correctIndex|correct_option_index|exp|explanation|explanation_pt|feedback)"[[:space:]]*:',
  'generation reservation did not return the existing sanitized pending package'
);

reset role;

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.student_activities as activity
     where activity.student_id = '00000000-0000-4000-8000-00000000e102'
  )
  and (
    select count(*) = 0
      from public.student_generated_activity_batches as batch
     where batch.student_id = '00000000-0000-4000-8000-00000000e102'
  )
  and (
    select count(*) = 0
      from public.student_complementary_generation_reservations as reservation
     where reservation.student_id = '00000000-0000-4000-8000-00000000e102'
  ),
  'partial pending queue allowed a mixed generated package'
);

-- Persist one AI-generated package through the RPC. Content is deliberately a
-- JSON string because the legacy table stores it as text.
set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (
    public.begin_student_complementary_generation(
      'aaaaaaaa-0000-4000-8000-000000000020'::uuid
    ) ->> 'allowed'
  )::boolean,
  'generated package did not acquire a reservation'
);

reset role;

set local role service_role;

select pg_temp.assert_true(
  (
    public.save_student_generated_activities(
      '00000000-0000-4000-8000-00000000e101'::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'type', 'reading',
          'title', 'Generated reading',
          'description', 'Read and reflect',
          'content', '{"instructions_pt":"Read carefully","text":"A sufficiently long text for careful reading practice.","checklist":["Read","Review"],"reflection_prompt":"What did you understand?"}',
          'difficulty', 'BEGINNER'
        ),
        jsonb_build_object(
          'type', 'grammar',
          'title', 'Generated grammar',
          'description', 'Practice grammar',
          'content', '{"rule_pt":"Choose the right form.","exercises":[{"id":"grammar-q1","sentence":"She ___ daily.","options":["study","studies"],"correct":1,"exp":"Use studies."}]}',
          'difficulty', 'INTERMEDIATE'
        ),
        jsonb_build_object(
          'type', 'quiz',
          'title', 'Generated quiz',
          'description', 'Answer questions',
          'content', '{"instructions_pt":"Answer","questions":[{"id":"generated-q1","q":"Choose B","options":["A","B"],"correct":1,"exp":"The second generated option is correct."}]}',
          'difficulty', 'INTERMEDIATE'
        ),
        jsonb_build_object(
          'type', 'conversation',
          'title', 'Generated conversation',
          'description', 'Speak and reflect',
          'content', '{"scenario":"A meeting","instructions_pt":"Speak for one minute.","preparation":["Plan your message"],"target_phrases":["Thanks for joining"],"reflection_prompt":"What went well?"}',
          'difficulty', 'ADVANCED'
        )
      ),
      'aaaaaaaa-0000-4000-8000-000000000020'::uuid,
      (
        select reservation.id
          from public.student_complementary_generation_reservations as reservation
         where reservation.student_id =
                 '00000000-0000-4000-8000-00000000e101'::uuid
           and reservation.request_key =
                 'aaaaaaaa-0000-4000-8000-000000000020'::uuid
      ),
      (
        select reservation.lease_token
          from public.student_complementary_generation_reservations as reservation
         where reservation.student_id =
                 '00000000-0000-4000-8000-00000000e101'::uuid
           and reservation.request_key =
                 'aaaaaaaa-0000-4000-8000-000000000020'::uuid
      )
    ) ->> 'created'
  )::boolean,
  'validated generated activity package was not persisted'
);

select pg_temp.assert_true(
  (
    public.save_student_generated_activities(
      '00000000-0000-4000-8000-00000000e101'::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'type', 'reading',
          'title', 'Generated reading',
          'description', 'Read and reflect',
          'content', '{"instructions_pt":"Read carefully","text":"A sufficiently long text for careful reading practice.","checklist":["Read","Review"],"reflection_prompt":"What did you understand?"}',
          'difficulty', 'BEGINNER'
        ),
        jsonb_build_object(
          'type', 'grammar',
          'title', 'Generated grammar',
          'description', 'Practice grammar',
          'content', '{"rule_pt":"Choose the right form.","exercises":[{"id":"grammar-q1","sentence":"She ___ daily.","options":["study","studies"],"correct":1,"exp":"Use studies."}]}',
          'difficulty', 'INTERMEDIATE'
        ),
        jsonb_build_object(
          'type', 'quiz',
          'title', 'Generated quiz',
          'description', 'Answer questions',
          'content', '{"instructions_pt":"Answer","questions":[{"id":"generated-q1","q":"Choose B","options":["A","B"],"correct":1,"exp":"The second generated option is correct."}]}',
          'difficulty', 'INTERMEDIATE'
        ),
        jsonb_build_object(
          'type', 'conversation',
          'title', 'Generated conversation',
          'description', 'Speak and reflect',
          'content', '{"scenario":"A meeting","instructions_pt":"Speak for one minute.","preparation":["Plan your message"],"target_phrases":["Thanks for joining"],"reflection_prompt":"What went well?"}',
          'difficulty', 'ADVANCED'
        )
      ),
      'aaaaaaaa-0000-4000-8000-000000000020'::uuid,
      (
        select reservation.id
          from public.student_complementary_generation_reservations as reservation
         where reservation.student_id =
                 '00000000-0000-4000-8000-00000000e101'::uuid
           and reservation.request_key =
                 'aaaaaaaa-0000-4000-8000-000000000020'::uuid
      ),
      (
        select reservation.lease_token
          from public.student_complementary_generation_reservations as reservation
         where reservation.student_id =
                 '00000000-0000-4000-8000-00000000e101'::uuid
           and reservation.request_key =
                 'aaaaaaaa-0000-4000-8000-000000000020'::uuid
      )
    ) ->> 'alreadyApplied'
  )::boolean,
  'generated activity package retry was not idempotent'
);

select pg_temp.assert_true(
  (
    public.commit_student_complementary_generation(
      '00000000-0000-4000-8000-00000000e101'::uuid,
      (
        select reservation.id
          from public.student_complementary_generation_reservations as reservation
         where reservation.student_id =
                 '00000000-0000-4000-8000-00000000e101'::uuid
           and reservation.request_key =
                 'aaaaaaaa-0000-4000-8000-000000000020'::uuid
      ),
      (
        select reservation.lease_token
          from public.student_complementary_generation_reservations as reservation
         where reservation.student_id =
                 '00000000-0000-4000-8000-00000000e101'::uuid
           and reservation.request_key =
                 'aaaaaaaa-0000-4000-8000-000000000020'::uuid
      ),
      'aaaaaaaa-0000-4000-8000-000000000020'::uuid
    ) ->> 'status'
  ) = 'COMMITTED',
  'service did not commit the persisted generated package'
);

reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (public.get_student_complementary_generation_status() ->> 'pendingCount')::integer = 4
  and not (public.get_student_complementary_generation_status() ->> 'canGenerate')::boolean,
  'active complementary package did not block another generation'
);

select pg_temp.assert_true(
  not (
    public.begin_student_complementary_generation(
      'aaaaaaaa-0000-4000-8000-000000000021'::uuid
    ) ->> 'allowed'
  )::boolean
  and public.begin_student_complementary_generation(
        'aaaaaaaa-0000-4000-8000-000000000021'::uuid
      ) ->> 'code' = 'PENDING_PACKAGE'
  and pg_catalog.jsonb_array_length(
        public.begin_student_complementary_generation(
          'aaaaaaaa-0000-4000-8000-000000000021'::uuid
        ) -> 'activities'
      ) = 4,
  'pending complementary package did not stop a second provider generation'
);

reset role;

select pg_temp.assert_true(
  (
    select count(*) = 4
           and count(*) filter (where xp_reward = 0) = 4
           and count(distinct type) = 4
           and min(tenant_id) = 'learning-runtime-a'
           and max(tenant_id) = 'learning-runtime-a'
      from public.student_activities as activity
     where activity.student_id = '00000000-0000-4000-8000-00000000e101'
  )
  and (
    select count(*) = 1
      from public.student_generated_activity_batches as batch
     where batch.student_id = '00000000-0000-4000-8000-00000000e101'
  ),
  'generated activity package duplicated rows or trusted client XP/tenant'
);

update public.profiles
   set last_activity = '2000-01-01 00:00:00+00'::timestamptz,
       streak_count = 1,
       last_streak_date = (now() at time zone 'America/Sao_Paulo')::date
 where id = '00000000-0000-4000-8000-00000000e101';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (select count(*) = 0 from public.student_activities)
  and (select count(*) = 0 from public.student_generated_activity_batches)
  and pg_catalog.jsonb_array_length(
        public.get_student_complementary_activities(50)
      ) = 4
  and not exists (
    select 1
      from pg_catalog.jsonb_array_elements(
        public.get_student_complementary_activities(50)
      ) as activity(value)
     where activity.value -> 'content' is null
        or (activity.value -> 'content')::text ~
          '"(correct|correctIndex|correct_option_index|exp|explanation|explanation_pt|feedback)"[[:space:]]*:'
  ),
  'student reached raw complementary answer keys or batch request payloads'
);

do $$
declare
  v_activity_id uuid;
begin
  select (activity.value ->> 'id')::uuid
    into v_activity_id
    from pg_catalog.jsonb_array_elements(
      public.get_student_complementary_activities(50)
    ) as activity(value)
   where activity.value ->> 'type' = 'reading'
   limit 1;

  perform public.complete_student_complementary_activity(
    v_activity_id,
    '{"x":1}'::jsonb,
    'invalid-evidence-request-0001'
  );
  raise exception 'assertion failed: arbitrary complementary evidence succeeded';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_complementary_activity_evidence' then
      raise;
    end if;
end;
$$;

do $$
declare
  v_activity_id uuid;
begin
  select (activity.value ->> 'id')::uuid
    into v_activity_id
    from pg_catalog.jsonb_array_elements(
      public.get_student_complementary_activities(50)
    ) as activity(value)
   where activity.value ->> 'type' = 'quiz'
   limit 1;

  perform public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'quiz',
      'contentMode', 'structured',
      'checklistCompleted', pg_catalog.jsonb_build_array('answered'),
      'reflection', 'I completed this quiz without sending verifiable answers.'
    ),
    'quiz-checklist-bypass-request-0001'
  );
  raise exception 'assertion failed: structured quiz accepted checklist evidence';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_complementary_activity_evidence' then
      raise;
    end if;
end;
$$;

do $$
declare
  v_activity_id uuid;
begin
  select (activity.value ->> 'id')::uuid
    into v_activity_id
    from pg_catalog.jsonb_array_elements(
      public.get_student_complementary_activities(50)
    ) as activity(value)
   where activity.value ->> 'type' = 'quiz'
   limit 1;

  perform public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'quiz',
      'contentMode', 'structured',
      'answers', pg_catalog.jsonb_build_array(0),
      'questionIds', pg_catalog.jsonb_build_array('generated-q1'),
      'questionResults', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'questionId', 'generated-q1',
          'selectedIndex', 0,
          'correct', true
        )
      ),
      'scorePercentage', 100
    ),
    'quiz-tampered-evidence-request-0001'
  );
  raise exception 'assertion failed: tampered quiz evidence succeeded';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_complementary_activity_evidence' then
      raise;
    end if;
end;
$$;

do $$
declare
  v_activity_id uuid;
  v_result jsonb;
begin
  select (activity.value ->> 'id')::uuid
    into v_activity_id
    from pg_catalog.jsonb_array_elements(
      public.get_student_complementary_activities(50)
    ) as activity(value)
   where activity.value ->> 'type' = 'quiz'
   limit 1;

  v_result := public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'quiz',
      'contentMode', 'structured',
      'answers', pg_catalog.jsonb_build_array(0),
      'questionIds', pg_catalog.jsonb_build_array('generated-q1'),
      'completedAt', '2026-08-31T12:00:00Z'
    ),
    'quiz-failed-complement-request-0001'
  );

  perform pg_temp.assert_true(
    not (v_result ->> 'passed')::boolean
    and v_result ->> 'status' = 'PENDING'
    and (v_result ->> 'scorePercentage')::integer = 0
    and (v_result -> 'questionResults' -> 0 ->> 'correct')::boolean is false
    and (v_result -> 'questionResults' -> 0 ->> 'correctIndex')::integer = 1,
    'wrong complementary quiz was not server-graded and kept pending'
  );

  v_result := public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'quiz',
      'contentMode', 'structured',
      'answers', pg_catalog.jsonb_build_array(0),
      'questionIds', pg_catalog.jsonb_build_array('generated-q1'),
      'completedAt', '2026-08-31T12:00:07Z'
    ),
    'quiz-failed-complement-request-0001'
  );

  perform pg_temp.assert_true(
    (v_result ->> 'alreadyApplied')::boolean
    and not (v_result ->> 'passed')::boolean,
    'failed complementary quiz replay was not idempotent'
  );

  v_result := public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'quiz',
      'contentMode', 'structured',
      'answers', pg_catalog.jsonb_build_array(1),
      'questionIds', pg_catalog.jsonb_build_array('generated-q1'),
      'completedAt', '2026-08-31T12:01:00Z'
    ),
    'quiz-passed-complement-request-0001'
  );

  perform pg_temp.assert_true(
    (v_result ->> 'passed')::boolean
    and v_result ->> 'status' = 'COMPLETED'
    and (v_result ->> 'scorePercentage')::integer = 100
    and (v_result -> 'questionResults' -> 0 ->> 'correct')::boolean
    and (v_result -> 'questionResults' -> 0 ->> 'correctIndex')::integer = 1
    and v_result -> 'questionResults' -> 0 ->> 'explanation' =
          'The second generated option is correct.',
    'server-authoritative complementary quiz feedback is incomplete'
  );

  v_result := public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'quiz',
      'contentMode', 'structured',
      'answers', pg_catalog.jsonb_build_array(1),
      'questionIds', pg_catalog.jsonb_build_array('generated-q1'),
      'completedAt', '2026-08-31T12:01:09Z'
    ),
    'quiz-passed-complement-request-0001'
  );

  perform pg_temp.assert_true(
    (v_result ->> 'alreadyApplied')::boolean,
    'successful complementary quiz replay was not idempotent'
  );

  -- A stale tab can submit a different request after another tab completed the
  -- activity. It must receive the stored authoritative result, never a made-up
  -- null/0 score, and must not create another attempt.
  v_result := public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'quiz',
      'contentMode', 'structured',
      'answers', pg_catalog.jsonb_build_array(0),
      'questionIds', pg_catalog.jsonb_build_array('generated-q1'),
      'completedAt', '2026-08-31T12:02:00Z'
    ),
    'quiz-stale-tab-request-0002'
  );

  perform pg_temp.assert_true(
    (v_result ->> 'alreadyApplied')::boolean
      and (v_result ->> 'canonicalResultAvailable')::boolean
      and (v_result ->> 'passed')::boolean
      and (v_result ->> 'scorePercentage')::integer = 100
      and (v_result -> 'questionResults' -> 0 ->> 'correct')::boolean,
    'stale complementary tab did not receive canonical passing feedback'
  );
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select activity.status = 'COMPLETED'
      from public.student_activities as activity
     where activity.student_id = '00000000-0000-4000-8000-00000000e101'
       and activity.type = 'quiz'
  )
  and (
    select count(*) = 2
      from public.student_complementary_activity_attempts as attempt
     where attempt.student_id = '00000000-0000-4000-8000-00000000e101'
       and attempt.activity_id = (
         select activity.id
           from public.student_activities as activity
          where activity.student_id = '00000000-0000-4000-8000-00000000e101'
            and activity.type = 'quiz'
       )
  )
  and (
    select profile.last_activity > '2000-01-01 00:00:00+00'::timestamptz
           and profile.streak_count = 1
           and profile.xp = 40
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000e101'
  )
  and (
    select skill.total_activities = 4
      from public.student_skill_scores as skill
     where skill.student_id = '00000000-0000-4000-8000-00000000e101'
       and skill.skill = 'grammar'
  ),
  'complementary quiz replay duplicated practice, skill or XP effects'
);

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

do $$
declare
  v_activity_id uuid;
begin
  select (activity.value ->> 'id')::uuid
    into v_activity_id
    from pg_catalog.jsonb_array_elements(
      public.get_student_complementary_activities(50)
    ) as activity(value)
   where activity.value ->> 'type' = 'reading'
   limit 1;

  perform public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'reading',
      'contentMode', 'structured',
      'checklistCompleted', pg_catalog.jsonb_build_array(null),
      'reflection', 'This reflection is long enough but its checklist is null.'
    ),
    'reading-null-checklist-request-0001'
  );
  raise exception 'assertion failed: null checklist evidence was accepted';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_complementary_activity_evidence' then
      raise;
    end if;
end;
$$;

do $$
declare
  v_activity_id uuid;
begin
  select (activity.value ->> 'id')::uuid
    into v_activity_id
    from pg_catalog.jsonb_array_elements(
      public.get_student_complementary_activities(50)
    ) as activity(value)
   where activity.value ->> 'type' = 'reading'
   limit 1;

  perform public.complete_student_complementary_activity(
    v_activity_id,
    pg_catalog.jsonb_build_object(
      'activityId', v_activity_id::text,
      'activityType', 'reading',
      'contentMode', 'structured',
      'checklistCompleted', pg_catalog.jsonb_build_array('Read', 'Invented'),
      'reflection', 'This reflection is long enough but invents a checklist item.'
    ),
    'reading-invented-checklist-request-0001'
  );
  raise exception 'assertion failed: invented checklist evidence was accepted';
exception
  when sqlstate '22023' then
    if sqlerrm <> 'invalid_complementary_activity_evidence' then
      raise;
    end if;
end;
$$;

select pg_temp.assert_true(
  (
    select (
      public.complete_student_complementary_activity(
        (activity.value ->> 'id')::uuid,
        jsonb_build_object(
          'activityId', activity.value ->> 'id',
          'activityType', activity.value ->> 'type',
          'contentMode', 'structured',
          'checklistCompleted', jsonb_build_array('Read', 'Review'),
          'reflection', 'I understood the main idea and reviewed the new words.',
          'completedAt', '2026-08-31T12:00:00Z'
        ),
        'complementary-completion-request-0001'
      ) ->> 'status'
    ) = 'COMPLETED'
      from pg_catalog.jsonb_array_elements(
        public.get_student_complementary_activities(50)
      ) as activity(value)
     where activity.value ->> 'type' = 'reading'
     limit 1
  ),
  'valid complementary evidence did not complete the owned activity'
);

select pg_temp.assert_true(
  (
    select (
      public.complete_student_complementary_activity(
        (activity.value ->> 'id')::uuid,
        jsonb_build_object(
          'activityId', activity.value ->> 'id',
          'activityType', activity.value ->> 'type',
          'contentMode', 'structured',
          'checklistCompleted', jsonb_build_array('Read', 'Review'),
          'reflection', 'I understood the main idea and reviewed the new words.',
          'completedAt', '2026-08-31T12:00:07Z'
        ),
        'complementary-completion-request-0001'
      ) ->> 'alreadyApplied'
    )::boolean
      from pg_catalog.jsonb_array_elements(
        public.get_student_complementary_activities(50)
      ) as activity(value)
     where activity.value ->> 'type' = 'reading'
     limit 1
  ),
  'complementary completion retry was not idempotent'
);

reset role;

select pg_temp.assert_true(
  (
    select profile.xp = 40 and profile.streak_count = 1
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000e101'
  )
  and (
    select count(*) = 3
      from public.student_complementary_activity_attempts as attempt
     where attempt.student_id = '00000000-0000-4000-8000-00000000e101'
  )
  and (
    select skill.total_activities = 3
      from public.student_skill_scores as skill
     where skill.student_id = '00000000-0000-4000-8000-00000000e101'
       and skill.skill = 'reading'
  ),
  'complementary replay awarded XP or duplicated practice/skill effects'
);

update public.profiles
   set streak_count = 9,
       last_streak_date =
         (now() at time zone 'America/Sao_Paulo')::date - 3
 where id = '00000000-0000-4000-8000-00000000e101';

update public.profiles
   set hearts = 2,
       hearts_updated_at = now(),
       hearts_full_notified = false
 where id = '00000000-0000-4000-8000-00000000e101';

set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e101"}';

select pg_temp.assert_true(
  (public.get_student_practice_status() ->> 'xp')::integer = 40
  and (public.get_student_practice_status() ->> 'level')::integer = 1
  and (public.get_student_practice_status() ->> 'hearts')::integer = 2
  and (public.get_student_practice_status() ->> 'streakCount')::integer = 0,
  'practice status omitted XP/level/hearts or displayed a stale streak'
);

select pg_temp.assert_true(
  (public.consume_student_heart(
    'heart-consumption-request-0001',
    'WRONG_ANSWER'
  ) ->> 'hearts')::integer = 1,
  'atomic heart consumption did not decrement exactly once'
);

select pg_temp.assert_true(
  (public.consume_student_heart(
    'heart-consumption-request-0001',
    'WRONG_ANSWER'
  ) ->> 'alreadyApplied')::boolean,
  'heart retry was not idempotent'
);

do $$
begin
  update public.student_activity_progress
     set score = 100
   where student_id = auth.uid();
  raise exception 'assertion failed: student updated progress directly';
exception
  when sqlstate '42501' then
    null;
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select profile.hearts = 1 and profile.streak_count = 9
      from public.profiles as profile
     where profile.id = '00000000-0000-4000-8000-00000000e101'
  )
  and (
    select count(*) = 1
      from public.student_heart_consumptions as consumption
     where consumption.student_id = '00000000-0000-4000-8000-00000000e101'
       and consumption.request_key = 'heart-consumption-request-0001'
  ),
  'heart idempotency duplicated state or stale-streak read mutated storage'
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
  '40000000-0000-4000-8000-00000000e001',
  '00000000-0000-4000-8000-00000000e101',
  'learning-runtime-a',
  'reading',
  'Cross tenant completion fixture',
  'Legacy reading instructions',
  0,
  'PENDING',
  false
);

-- Tenant B cannot see or complete tenant A learning data.
set local role authenticated;
set local request.jwt.claims =
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-00000000e201"}';

select pg_temp.assert_true(
  (select count(*) = 0 from public.student_activities)
  and (select count(*) = 0 from public.student_activity_progress)
  and (select count(*) = 0 from public.student_path_enrollment_history)
  and not exists (
    select 1
      from public.learning_paths
     where id = '10000000-0000-4000-8000-00000000e002'
  )
  and not exists (
    select 1
      from public.learning_units
     where id = '20000000-0000-4000-8000-00000000e002'
  )
  and not exists (
    select 1
      from public.unit_activities
     where id = '30000000-0000-4000-8000-00000000e003'
  )
  and exists (
    select 1
      from public.learning_paths
     where id = '10000000-0000-4000-8000-00000000e001'
  )
  and exists (
    select 1
      from public.learning_paths
     where id = '10000000-0000-4000-8000-00000000e003'
  ),
  'student can read another tenant learning rows'
);

do $$
begin
  perform public.complete_student_complementary_activity(
    '40000000-0000-4000-8000-00000000e001',
    '{
      "activityId":"40000000-0000-4000-8000-00000000e001",
      "activityType":"reading",
      "contentMode":"legacy",
      "checklistCompleted":["read"],
      "reflection":"This reflection belongs to the wrong tenant student."
    }'::jsonb,
    'cross-tenant-completion-request-0001'
  );
  raise exception 'assertion failed: tenant B completed tenant A activity';
exception
  when sqlstate '42501' then
    if sqlerrm <> 'complementary_activity_not_owned' then
      raise;
    end if;
end;
$$;

reset role;

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.student_path_enrollment_history as history
     where history.student_id = '00000000-0000-4000-8000-00000000e101'
       and history.event_type = 'COMPLETED'
  ),
  'path completion history was not recorded exactly once'
);

rollback;
