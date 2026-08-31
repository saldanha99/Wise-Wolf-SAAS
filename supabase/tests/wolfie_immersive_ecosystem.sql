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

insert into public.tenants (id, name)
values
  ('wolfie-fixture-a', 'Wolfie Fixture A'),
  ('wolfie-fixture-b', 'Wolfie Fixture B');

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
    '00000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'wolfie-a1@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Wolfie A1"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'wolfie-a2@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Wolfie A2"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000201',
    'authenticated',
    'authenticated',
    'wolfie-b1@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Wolfie B1"}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000103',
    'authenticated',
    'authenticated',
    'wolfie-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Wolfie Teacher"}',
    now(),
    now()
  );

set local app.enrollment_claim = '1';

update public.profiles
   set tenant_id = 'wolfie-fixture-a',
       role = 'STUDENT',
       status_financial = 'ACTIVE',
       lifecycle_status = 'active',
       xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       module = 'A1',
       current_book_part = 'A1-1',
       evaluation_unlocked = true,
       is_test_account = false,
       test_fixture_key = 'wolfie-ecosystem-sql'
 where id = '00000000-0000-4000-8000-000000000101';

update public.profiles
   set tenant_id = 'wolfie-fixture-a',
       role = 'STUDENT',
       status_financial = 'ACTIVE',
       lifecycle_status = 'active',
       xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       module = 'A1',
       current_book_part = 'A1-1',
       evaluation_unlocked = true,
       is_test_account = true,
       test_fixture_key = 'wolfie-ecosystem-sql'
 where id = '00000000-0000-4000-8000-000000000102';

update public.profiles
   set tenant_id = 'wolfie-fixture-b',
       role = 'STUDENT',
       status_financial = 'ACTIVE',
       lifecycle_status = 'active',
       xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       is_test_account = false,
       test_fixture_key = 'wolfie-ecosystem-sql'
 where id = '00000000-0000-4000-8000-000000000201';

update public.profiles
   set tenant_id = 'wolfie-fixture-a',
       role = 'TEACHER',
       lifecycle_status = 'active',
       is_test_account = true,
       test_fixture_key = 'wolfie-ecosystem-sql-teacher'
 where id = '00000000-0000-4000-8000-000000000103';

set local app.enrollment_claim = '';

select (
  public.create_wolfie_activity_session(
    '00000000-0000-4000-8000-000000000101',
    'vocabulary',
    'B1',
    null,
    'standard',
    'text',
    null,
    '10000000-0000-4000-8000-000000000001',
    '{
      "title":"Atomic quiz",
      "readinessGoal":"Ready",
      "instructionsPt":"Answer",
      "targetVocabulary":[],
      "questions":[
        {"id":"q1","prompt":"Choose","options":["a","b","c","d"]}
      ]
    }',
    '{
      "questions":[
        {"id":"q1","correctIndex":0,"explanationPt":"Because"}
      ]
    }',
    '{}',
    '{}'
  ) ->> 'id'
) as quiz_session_id
\gset

select (
  public.create_wolfie_activity_session(
    '00000000-0000-4000-8000-000000000101',
    'vocabulary',
    'B1',
    null,
    'standard',
    'text',
    null,
    '10000000-0000-4000-8000-000000000001',
    '{"title":"Must not overwrite"}',
    '{"questions":[]}',
    '{}',
    '{}'
  ) ->> 'id'
) as duplicate_quiz_session_id
\gset

select pg_temp.assert_true(
  :'quiz_session_id' = :'duplicate_quiz_session_id',
  'request_key must return the same session'
);
select pg_temp.assert_true(
  (
    select activity_content ->> 'title' = 'Atomic quiz'
      from public.wolfie_activity_sessions
     where id = :'quiz_session_id'
  ),
  'idempotent create must not overwrite activity content'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_activity_keys
     where session_id = :'quiz_session_id'
  ),
  'session and private answer key must be created atomically'
);

select (
  public.create_wolfie_activity_session(
    '00000000-0000-4000-8000-000000000201',
    'reading',
    'A2',
    null,
    'standard',
    'text',
    null,
    '10000000-0000-4000-8000-000000000002',
    '{"title":"Other tenant session"}',
    '{"questions":[]}',
    '{}',
    '{}'
  ) ->> 'id'
) as other_tenant_session_id
\gset

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000101"}',
  true
);

select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_activity_sessions
  ),
  'student must only read their own Wolfie session'
);
select pg_temp.assert_true(
  not exists (
    select 1
      from public.wolfie_activity_sessions
     where id = :'other_tenant_session_id'
  ),
  'student must not read a cross-tenant session'
);

savepoint answer_key_private;
\set answer_key_private_failed false
\set ON_ERROR_STOP off
select * from public.wolfie_activity_keys
where session_id = :'quiz_session_id';
\if :ERROR
  \set answer_key_private_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint answer_key_private;
select pg_temp.assert_true(
  :'answer_key_private_failed'::boolean,
  'student must never read private answer keys'
);

savepoint profile_xp_guard;
\set profile_xp_guard_failed false
\set ON_ERROR_STOP off
update public.profiles
   set xp = coalesce(xp, 0) + 999
 where id = '00000000-0000-4000-8000-000000000101';
\if :ERROR
  \set profile_xp_guard_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint profile_xp_guard;
select pg_temp.assert_true(
  :'profile_xp_guard_failed'::boolean,
  'browser role must not mint profile XP'
);

savepoint service_rpc_private;
\set service_rpc_private_failed false
\set ON_ERROR_STOP off
select public.apply_wolfie_repertoire_event(
  :'quiz_session_id',
  'deadline',
  'deadline',
  'prazo',
  'Prazo final',
  'The deadline is Friday.',
  'EXPOSED',
  'browser-forbidden'
);
\if :ERROR
  \set service_rpc_private_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint service_rpc_private;
select pg_temp.assert_true(
  :'service_rpc_private_failed'::boolean,
  'authoritative repertoire RPC must be service-only'
);

savepoint pedagogical_rpc_private;
\set pedagogical_rpc_private_failed false
\set ON_ERROR_STOP off
select public.record_verified_pedagogical_quiz(
  '00000000-0000-4000-8000-000000000101',
  'A1-1',
  10,
  10,
  '[1,2,1,1,1,2,2,3,0,2]'
);
\if :ERROR
  \set pedagogical_rpc_private_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint pedagogical_rpc_private;
select pg_temp.assert_true(
  :'pedagogical_rpc_private_failed'::boolean,
  'pedagogical result RPC must be service-only'
);

savepoint generated_audio_private;
\set generated_audio_private_failed false
\set ON_ERROR_STOP off
insert into storage.objects (bucket_id, name, metadata)
values (
  'wolfie-generated-audio',
  'wolfie-fixture-a/browser.wav',
  '{"mimetype":"audio/wav","size":44}'
);
\if :ERROR
  \set generated_audio_private_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint generated_audio_private;
select pg_temp.assert_true(
  :'generated_audio_private_failed'::boolean,
  'student must not upload generated listening audio directly'
);

reset role;

select pg_temp.assert_true(
  (
    public.record_wolfie_activity_attempt(
      :'quiz_session_id',
      '20000000-0000-4000-8000-000000000001',
      '{"questionId":"q1","selectedIndex":0}',
      '{"correct":true}',
      100,
      1,
      'quiz:q1',
      'text',
      false
    ) ->> 'stepAlreadyAnswered'
  )::boolean is false,
  'first quiz answer must be accepted'
);
select pg_temp.assert_true(
  (
    public.record_wolfie_activity_attempt(
      :'quiz_session_id',
      '20000000-0000-4000-8000-000000000001',
      '{"questionId":"q1","selectedIndex":0}',
      '{"correct":true}',
      100,
      1,
      'quiz:q1',
      'text',
      false
    ) ->> 'alreadyProcessed'
  )::boolean,
  'replaying the same quiz request must be idempotent'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_activity_attempts
     where session_id = :'quiz_session_id'
       and step_key = 'quiz:q1'
  ),
  'quiz answer lock must persist exactly one attempt'
);

insert into public.wolfie_sessions (
  id,
  tenant_id,
  student_id,
  topic,
  mode,
  student_level,
  retry_count
) values (
  '50000000-0000-4000-8000-000000000001',
  'wolfie-fixture-a',
  '00000000-0000-4000-8000-000000000101',
  'Retry constraint regression',
  'fluency',
  'B1',
  501
);
select pg_temp.assert_true(
  (
    select retry_count = 501
      from public.wolfie_sessions
     where id = '50000000-0000-4000-8000-000000000001'
  ),
  'conversation retry_count must support values above 500'
);

select public.create_wolfie_activity_session(
  '00000000-0000-4000-8000-000000000101',
  'vocabulary',
  'B1',
  null,
  'standard',
  'text',
  null,
  '10000000-0000-4000-8000-000000000008',
  '{
    "title":"Retry lineage regression",
    "questions":[
      {"id":"q1","prompt":"Choose","options":["a","b"]},
      {"id":"q2","prompt":"Continue","options":["a","b"]}
    ]
  }',
  '{"questions":[]}',
  '{}',
  '{}'
);

do $$
declare
  v_session_id uuid;
  v_initial jsonb;
  v_retry jsonb;
  v_replay jsonb;
  v_parent_attempt_id uuid;
  v_retry_attempt_id uuid;
begin
  select id
    into v_session_id
    from public.wolfie_activity_sessions
   where request_key = '10000000-0000-4000-8000-000000000008';

  v_initial := public.record_wolfie_activity_attempt(
    v_session_id,
    '20000000-0000-4000-8000-000000000007',
    '{
      "attemptKind":"initial",
      "logicalStepKey":"quiz:q1",
      "questionId":"q1",
      "selectedIndex":1
    }',
    '{
      "correct":false,
      "requiresRetry":true,
      "retryPrompt":"Try the same question again.",
      "priorities":["word choice"]
    }',
    25,
    4,
    'quiz:q1',
    'text',
    false
  );
  v_parent_attempt_id := (v_initial ->> 'attemptId')::uuid;

  perform pg_temp.assert_true(
    not (v_initial ->> 'alreadyProcessed')::boolean
      and (v_initial ->> 'requiresRetry')::boolean
      and not (v_initial ->> 'retryCompleted')::boolean,
    'an insufficient initial attempt must require retry'
  );

  begin
    perform public.record_wolfie_activity_attempt(
      v_session_id,
      '20000000-0000-4000-8000-000000000008',
      '{
        "attemptKind":"initial",
        "logicalStepKey":"quiz:q2",
        "questionId":"q2",
        "selectedIndex":0
      }',
      '{"correct":true,"requiresRetry":false}',
      100,
      5,
      'quiz:q2',
      'text',
      false
    );
    raise exception 'unexpected_success_with_pending_retry';
  exception
    when others then
      if sqlerrm <> 'retry_required' then
        raise;
      end if;
  end;

  begin
    perform public.record_wolfie_activity_attempt(
      v_session_id,
      '20000000-0000-4000-8000-000000000009',
      '{
        "attemptKind":"retry",
        "logicalStepKey":"quiz:q1",
        "questionId":"q1",
        "selectedIndex":0
      }',
      '{"correct":true,"requiresRetry":false}',
      100,
      5,
      'quiz:q1',
      'text',
      false
    );
    raise exception 'unexpected_success_without_parent';
  exception
    when others then
      if sqlerrm <> 'parent_attempt_required' then
        raise;
      end if;
  end;

  v_retry := public.record_wolfie_activity_attempt(
    v_session_id,
    '20000000-0000-4000-8000-000000000010',
    pg_catalog.jsonb_build_object(
      'attemptKind', 'retry',
      'logicalStepKey', 'quiz:q1',
      'parentAttemptId', v_parent_attempt_id,
      'questionId', 'q1',
      'selectedIndex', 0
    ),
    '{
      "correct":true,
      "requiresRetry":false,
      "strengths":["word choice corrected"]
    }',
    100,
    7,
    'quiz:q1',
    'text',
    false
  );
  v_retry_attempt_id := (v_retry ->> 'attemptId')::uuid;

  perform pg_temp.assert_true(
    not (v_retry ->> 'alreadyProcessed')::boolean
      and not (v_retry ->> 'requiresRetry')::boolean
      and (v_retry ->> 'retryCompleted')::boolean
      and (v_retry ->> 'parentAttemptId')::uuid = v_parent_attempt_id,
    'a valid retry must close its parent attempt'
  );

  v_replay := public.record_wolfie_activity_attempt(
    v_session_id,
    '20000000-0000-4000-8000-000000000007',
    '{
      "attemptKind":"initial",
      "logicalStepKey":"quiz:q1",
      "questionId":"q1",
      "selectedIndex":1
    }',
    '{"correct":false,"requiresRetry":true}',
    25,
    4,
    'quiz:q1',
    'text',
    false
  );

  perform pg_temp.assert_true(
    (v_replay ->> 'alreadyProcessed')::boolean
      and not (v_replay ->> 'requiresRetry')::boolean
      and (v_replay ->> 'retryCompleted')::boolean
      and not (
        v_replay -> 'feedbackPayload' ->> 'requiresRetry'
      )::boolean
      and (
        v_replay -> 'feedbackPayload' ->> 'retryCompleted'
      )::boolean,
    'replaying the original attempt must not reopen a completed retry'
  );

  perform pg_temp.assert_true(
    (
      select count(*) = 2
        from public.wolfie_activity_attempts
       where session_id = v_session_id
    ),
    'retry replay and rejected attempts must not add attempt rows'
  );
  perform pg_temp.assert_true(
    exists (
      select 1
        from public.wolfie_activity_attempts
       where id = v_parent_attempt_id
         and attempt_kind = 'initial'
         and requires_retry
         and retry_completed
         and retry_completed_by_attempt_id = v_retry_attempt_id
    ) and exists (
      select 1
        from public.wolfie_activity_attempts
       where id = v_retry_attempt_id
         and attempt_kind = 'retry'
         and parent_attempt_id = v_parent_attempt_id
         and not requires_retry
    ),
    'retry attempts must preserve bidirectional lineage'
  );
  perform pg_temp.assert_true(
    (
      select required_retry_count = 1
        and completed_retry_count = 1
        and attempt_count = 2
        and status = 'IN_PROGRESS'
        and current_stage = 'practice'
        and report_json #>> '{latestAttempt,attemptId}' =
          v_retry_attempt_id::text
        and report_json #>> '{latestAttempt,parentAttemptId}' =
          v_parent_attempt_id::text
        and report_json #>> '{latestAttempt,attemptNumber}' = '2'
        and report_json #>> '{latestAttempt,stepKey}' = 'quiz:q1'
        and report_json #>> '{latestAttempt,modality}' = 'text'
        and report_json #>> '{latestAttempt,score}' = '100'
        and report_json #>> '{latestAttempt,requiresRetry}' = 'false'
        and report_json #>> '{latestAttempt,retryCompleted}' = 'true'
        and report_json #>>
          '{latestAttempt,responsePayload,attemptKind}' = 'retry'
        and report_json #>>
          '{latestAttempt,feedbackPayload,correct}' = 'true'
        from public.wolfie_activity_sessions
       where id = v_session_id
    ),
    'session counters and report_json.latestAttempt must track the retry'
  );
end;
$$;

update public.profiles
   set xp = 0,
       level = 1,
       daily_xp = 240,
       daily_xp_date =
         (now() at time zone 'America/Sao_Paulo')::date
 where id = '00000000-0000-4000-8000-000000000101';

select pg_temp.assert_true(
  (
    public.record_wolfie_activity_attempt(
      :'quiz_session_id',
      '20000000-0000-4000-8000-000000000003',
      '{"answeredQuestionIds":["q1"]}',
      '{"score":100}',
      100,
      20,
      'quiz',
      'text',
      true
    ) ->> 'xpEarned'
  )::integer = 10,
  'daily XP cap must be enforced server-side'
);
select pg_temp.assert_true(
  (
    select xp = 10 and daily_xp = 250
      from public.profiles
     where id = '00000000-0000-4000-8000-000000000101'
  ),
  'profile XP must match the capped award'
);
select pg_temp.assert_true(
  (
    public.record_wolfie_activity_attempt(
      :'quiz_session_id',
      '20000000-0000-4000-8000-000000000004',
      '{}',
      '{}',
      100,
      21,
      'quiz',
      'text',
      true
    ) ->> 'alreadyCompleted'
  )::boolean,
  'replaying completion must be idempotent'
);
select pg_temp.assert_true(
  (
    select xp = 10
      from public.profiles
     where id = '00000000-0000-4000-8000-000000000101'
  ),
  'completion replay must not award XP twice'
);

select (
  public.create_wolfie_activity_session(
    '00000000-0000-4000-8000-000000000102',
    'writing',
    'A2',
    null,
    'standard',
    'text',
    null,
    '10000000-0000-4000-8000-000000000003',
    '{"title":"Fixture writing"}',
    '{"rubric":{}}',
    '{}',
    '{}'
  ) ->> 'id'
) as fixture_session_id
\gset
select pg_temp.assert_true(
  (
    public.record_wolfie_activity_attempt(
      :'fixture_session_id',
      '20000000-0000-4000-8000-000000000005',
      '{"text":"Fixture response"}',
      '{"score":100}',
      100,
      5,
      'final',
      'text',
      true
    ) ->> 'xpEarned'
  )::integer = 0,
  'test fixture must never earn XP'
);

select (
  public.create_wolfie_activity_session(
    '00000000-0000-4000-8000-000000000101',
    'global_meetings',
    'B2',
    'technology_ai',
    'construction',
    'mixed',
    null,
    '10000000-0000-4000-8000-000000000004',
    '{
      "title":"Construction",
      "sections":[
        {"key":"opening"},{"key":"context"},{"key":"data"},
        {"key":"proposal"},{"key":"next_steps"},{"key":"closing"}
      ]
    }',
    '{"rubric":{}}',
    '{}',
    '{}'
  ) ->> 'id'
) as construction_session_id
\gset

savepoint premature_readaptation;
\set premature_readaptation_failed false
\set ON_ERROR_STOP off
select public.create_wolfie_activity_session(
  '00000000-0000-4000-8000-000000000101',
  'global_meetings',
  'B2',
  'tax',
  'readaptation',
  'mixed',
  :'construction_session_id',
  '10000000-0000-4000-8000-000000000005',
  '{"title":"Too early"}',
  '{"rubric":{}}',
  '{}',
  '{}'
);
\if :ERROR
  \set premature_readaptation_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint premature_readaptation;
select pg_temp.assert_true(
  :'premature_readaptation_failed'::boolean,
  'readaptation must reject an incomplete source'
);

do $$
declare
  v_session_id uuid;
  v_step text;
begin
  select id
    into v_session_id
    from public.wolfie_activity_sessions
   where request_key = '10000000-0000-4000-8000-000000000004';
  foreach v_step in array array[
    'opening',
    'context',
    'data',
    'proposal',
    'next_steps',
    'closing'
  ]::text[]
  loop
    perform public.record_wolfie_activity_attempt(
      v_session_id,
      gen_random_uuid(),
      jsonb_build_object('text', 'A complete English meeting section.'),
      jsonb_build_object(
        'correctedText',
        'A complete English meeting section.',
        'naturalVersion',
        'A natural English meeting section.'
      ),
      85,
      10,
      v_step,
      'text',
      false
    );
  end loop;
end;
$$;

select pg_temp.assert_true(
  (
    public.record_wolfie_activity_attempt(
      :'construction_session_id',
      '20000000-0000-4000-8000-000000000006',
      '{"text":"A full English meeting script."}',
      '{"score":90}',
      90,
      90,
      'construction_complete',
      'text',
      true
    ) ->> 'alreadyCompleted'
  )::boolean is false,
  'construction must complete after all six sections'
);

savepoint readaptation_without_rehearsal;
\set readaptation_without_rehearsal_failed false
\set ON_ERROR_STOP off
select public.create_wolfie_activity_session(
  '00000000-0000-4000-8000-000000000101',
  'global_meetings',
  'B2',
  'tax',
  'readaptation',
  'mixed',
  :'construction_session_id',
  '10000000-0000-4000-8000-000000000006',
  '{"title":"Still too early"}',
  '{"rubric":{}}',
  '{}',
  '{}'
);
\if :ERROR
  \set readaptation_without_rehearsal_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint readaptation_without_rehearsal;
select pg_temp.assert_true(
  :'readaptation_without_rehearsal_failed'::boolean,
  'readaptation must require a memorization rehearsal'
);

update public.wolfie_activity_sessions
   set learner_state = jsonb_set(
     learner_state,
     '{memorization}',
     '{"hiddenSections":[],"rehearsalCount":1,"confidence":70}',
     true
   )
 where id = :'construction_session_id';

select (
  public.create_wolfie_activity_session(
    '00000000-0000-4000-8000-000000000101',
    'global_meetings',
    'B2',
    'tax',
    'readaptation',
    'mixed',
    :'construction_session_id',
    '10000000-0000-4000-8000-000000000007',
    '{"title":"Independent tax scenario"}',
    '{"rubric":{}}',
    '{"deadline"}',
    '{"caveat"}'
  ) ->> 'id'
) as readaptation_session_id
\gset
select pg_temp.assert_true(
  (
    select
      source_session_id = :'construction_session_id'
      and sector = 'tax'
      and phase = 'readaptation'
      from public.wolfie_activity_sessions
     where id = :'readaptation_session_id'
  ),
  'valid readaptation must support a different sector'
);

select public.apply_wolfie_repertoire_event(
  :'construction_session_id',
  'deadline',
  'deadline',
  'prazo',
  'Prazo final',
  'The deadline is Friday.',
  'EXPOSED',
  'repertoire:deadline:exposed'
);
select public.apply_wolfie_repertoire_event(
  :'construction_session_id',
  'deadline',
  'deadline',
  'prazo',
  'Prazo final',
  'The deadline is Friday.',
  'EXPOSED',
  'repertoire:deadline:exposed'
);
select pg_temp.assert_true(
  (
    select exposure_count = 1 and mastery_score = 2
      from public.wolfie_repertoire
     where student_id = '00000000-0000-4000-8000-000000000101'
       and term_key = 'deadline'
  ),
  'repertoire event key must be idempotent'
);
select public.apply_wolfie_repertoire_event(
  :'construction_session_id',
  'deadline',
  'deadline',
  'prazo',
  'Prazo final',
  'The deadline is Friday.',
  'ANSWERED_CORRECTLY',
  'repertoire:deadline:correct'
);
select pg_temp.assert_true(
  (
    select
      exposure_count = 2
      and correct_count = 1
      and mastery_score = 14
      from public.wolfie_repertoire
     where student_id = '00000000-0000-4000-8000-000000000101'
       and term_key = 'deadline'
  ),
  'repertoire counters and mastery must increment atomically'
);

do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_lease uuid;
  i integer;
begin
  v_first := public.claim_wolfie_ai_request(
    '00000000-0000-4000-8000-000000000101',
    '30000000-0000-4000-8000-000000000001',
    'GENERATE'
  );
  perform pg_temp.assert_true(
    (v_first ->> 'claimed')::boolean,
    'first AI request must acquire a lease'
  );
  v_lease := (v_first ->> 'leaseToken')::uuid;

  v_second := public.claim_wolfie_ai_request(
    '00000000-0000-4000-8000-000000000101',
    '30000000-0000-4000-8000-000000000001',
    'GENERATE'
  );
  perform pg_temp.assert_true(
    not (v_second ->> 'claimed')::boolean
      and v_second ->> 'status' = 'PROCESSING',
    'concurrent AI replay must not acquire a second lease'
  );
  perform public.finish_wolfie_ai_request(
    p_student_id => '00000000-0000-4000-8000-000000000101'::uuid,
    p_request_key => '30000000-0000-4000-8000-000000000001'::uuid,
    p_lease_token => v_lease,
    p_status => 'COMPLETED'::text,
    p_response_payload => '{"ok":true}'::jsonb,
    p_error_code => null::text
  );

  for i in 2 .. 20 loop
    perform public.claim_wolfie_ai_request(
      '00000000-0000-4000-8000-000000000101',
      (
        '30000000-0000-4000-8000-'
        || pg_catalog.lpad(i::text, 12, '0')
      )::uuid,
      'GENERATE'
    );
  end loop;

  begin
    perform public.claim_wolfie_ai_request(
      '00000000-0000-4000-8000-000000000101',
      '30000000-0000-4000-8000-000000000021',
      'GENERATE'
    );
    raise exception 'AI rate limit did not reject request 21';
  exception
    when others then
      if sqlerrm not like '%wolfie_ai_rate_limit_exceeded%' then
        raise;
      end if;
  end;
end;
$$;

select pg_temp.assert_true(
  (
    public.claim_wolfie_ai_request(
      '00000000-0000-4000-8000-000000000102',
      '30000000-0000-4000-8000-000000000101',
      'SPEECH'
    ) ->> 'testFixture'
  )::boolean,
  'fixture AI claim must be completed without a provider lease'
);

insert into public.class_logs (
  id,
  tenant_id,
  teacher_id,
  student_id,
  student_confirmed,
  class_date
) values (
  '35000000-0000-4000-8000-000000000001',
  'wolfie-fixture-a',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000101',
  true,
  current_date
);

update public.profiles
   set xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null
 where id = '00000000-0000-4000-8000-000000000101';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000101"}',
  true
);
do $$
declare
  v_first jsonb;
  v_second jsonb;
begin
  v_first := public.award_verified_student_xp(
    'CLASS_LOG_CONFIRM',
    '35000000-0000-4000-8000-000000000001'
  );
  v_second := public.award_verified_student_xp(
    'CLASS_LOG_CONFIRM',
    '35000000-0000-4000-8000-000000000001'
  );
  perform pg_temp.assert_true(
    (v_first ->> 'xpEarned')::integer = 100
      and not (v_first ->> 'alreadyAwarded')::boolean,
    'verified class log must award XP once'
  );
  perform pg_temp.assert_true(
    (v_second ->> 'xpEarned')::integer = 0
      and (v_second ->> 'alreadyAwarded')::boolean,
    'verified class log replay must not report or mint new XP'
  );
end;
$$;
reset role;
select pg_temp.assert_true(
  (
    select xp = 100
      from public.profiles
     where id = '00000000-0000-4000-8000-000000000101'
  ),
  'class log XP must persist exactly once'
);

insert into public.learning_paths (
  id,
  tenant_id,
  name,
  active
) values (
  '40000000-0000-4000-8000-000000000001',
  'wolfie-fixture-a',
  'Verified path',
  true
);
insert into public.learning_units (
  id,
  path_id,
  order_index,
  title
) values (
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000001',
  1,
  'Verified unit'
);
insert into public.unit_activities (
  id,
  unit_id,
  order_index,
  type,
  title,
  content,
  xp_reward
) values (
  '40000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000002',
  1,
  'quiz',
  'Verified quiz',
  '{"questions":[{"id":"verified-q1","prompt":"One","options":["A","B"],"correct":0},{"id":"verified-q2","prompt":"Two","options":["A","B"],"correct":1}]}',
  40
);

update public.profiles
   set xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null
 where id = '00000000-0000-4000-8000-000000000101';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000101"}',
  true
);

select pg_temp.assert_true(
  public.enroll_student_learning_path(
    '40000000-0000-4000-8000-000000000001',
    false,
    null,
    null
  ) ->> 'status' = 'ACTIVE',
  'verified quiz fixture must have an active authoritative enrollment'
);

do $$
declare
  v_first jsonb;
  v_second jsonb;
begin
  v_first := public.grade_quiz(
    '40000000-0000-4000-8000-000000000003',
    array[0, 1]
  );
  v_second := public.grade_quiz(
    '40000000-0000-4000-8000-000000000003',
    array[0, 1]
  );
  perform pg_temp.assert_true(
    (v_first ->> 'score')::integer = 100
      and (v_first ->> 'xpEarned')::integer = 40,
    'verified quiz must award score-based XP once'
  );
  perform pg_temp.assert_true(
    (v_second ->> 'xpEarned')::integer = 40
      and (v_second ->> 'alreadyApplied')::boolean,
    'verified quiz replay must return the durable first result without farming XP'
  );
end;
$$;

reset role;
select pg_temp.assert_true(
  (
    select xp = 40
      from public.profiles
     where id = '00000000-0000-4000-8000-000000000101'
  ),
  'verified quiz profile XP must be awarded exactly once'
);

update public.profiles
   set xp = 0,
       level = 1,
       daily_xp = 0,
       daily_xp_date = null,
       module = 'A1',
       current_book_part = 'A1-1',
       evaluation_unlocked = true
 where id = '00000000-0000-4000-8000-000000000101';

do $$
declare
  v_failed jsonb;
  v_passed jsonb;
  v_replayed jsonb;
begin
  v_failed := public.record_verified_pedagogical_quiz(
    '00000000-0000-4000-8000-000000000101',
    'A1-1',
    6,
    10,
    '[1,2,1,1,1,2,0,0,0,0]'
  );
  perform pg_temp.assert_true(
    not (v_failed ->> 'passed')::boolean
      and (v_failed ->> 'xpEarned')::integer = 0,
    'failed pedagogical quiz must remain repeatable without XP'
  );

  v_passed := public.record_verified_pedagogical_quiz(
    '00000000-0000-4000-8000-000000000101',
    'A1-1',
    10,
    10,
    '[1,2,1,1,1,2,2,3,0,2]'
  );
  v_replayed := public.record_verified_pedagogical_quiz(
    '00000000-0000-4000-8000-000000000101',
    'A1-1',
    10,
    10,
    '[1,2,1,1,1,2,2,3,0,2]'
  );
  perform pg_temp.assert_true(
    (v_passed ->> 'passed')::boolean
      and (v_passed ->> 'xpEarned')::integer = 100
      and v_passed ->> 'nextPart' = 'A1-2',
    'verified pedagogical pass must progress and award capped XP'
  );
  perform pg_temp.assert_true(
    (v_replayed ->> 'alreadyAwarded')::boolean
      and (v_replayed ->> 'xpEarned')::integer = 0,
    'pedagogical pass replay must not farm XP'
  );
end;
$$;

select pg_temp.assert_true(
  (
    select
      xp = 100
      and current_book_part = 'A1-2'
      and evaluation_unlocked is false
      and module = 'A1'
      from public.profiles
     where id = '00000000-0000-4000-8000-000000000101'
  ),
  'pedagogical progression and XP must commit atomically'
);
select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.student_evaluations
     where student_id = '00000000-0000-4000-8000-000000000101'
       and book_part = 'A1-1'
  ),
  'failed and passing attempts must be recorded without replay duplication'
);

select pg_temp.assert_true(
  (
    public.record_verified_pedagogical_quiz(
      '00000000-0000-4000-8000-000000000102',
      'A1-1',
      10,
      10,
      '[1,2,1,1,1,2,2,3,0,2]'
    ) ->> 'xpEarned'
  )::integer = 0,
  'fixture pedagogical quiz must never earn XP'
);

select 'wolfie_immersive_ecosystem_tests_passed' as result;
rollback;
