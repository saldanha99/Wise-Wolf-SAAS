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

insert into public.tenants (id, name)
values ('wolfie-factual-fixture', 'Wolfie Factual Fixture');

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
values (
  '00000000-0000-4000-8000-000000000811',
  'authenticated',
  'authenticated',
  'wolfie-factual@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Wolfie Factual"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'wolfie-factual-fixture',
       role = 'STUDENT',
       lifecycle_status = 'active',
       is_test_account = false,
       test_fixture_key = 'wolfie-factual-memory-sql'
 where id = '00000000-0000-4000-8000-000000000811';
set local app.enrollment_claim = '';

insert into public.wolfie_sessions (
  id,
  tenant_id,
  student_id,
  topic,
  mode,
  student_level,
  experience_mode,
  correction_mode,
  language_mode,
  difficulty,
  current_stage,
  scenario_status,
  retry_count,
  config_snapshot,
  report_json,
  memory_summary
)
values (
  '10000000-0000-4000-8000-000000000811',
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  'Introductions',
  'fluency',
  'A1',
  'free_conversation',
  'immediate',
  'bilingual',
  'balanced',
  'retry',
  'awaiting_retry',
  1,
  '{}',
  '{}',
  '{}'
);

insert into public.wolfie_turns (
  id,
  session_id,
  speaker,
  content,
  turn_index,
  message_type,
  stage,
  structured_payload,
  requires_retry,
  speech_metrics
)
values
  (
    '20000000-0000-4000-8000-000000000811',
    '10000000-0000-4000-8000-000000000811',
    'student',
    'I live in Nova Iguaçu.',
    0,
    'instruction',
    'practice',
    '{}',
    false,
    '{}'
  ),
  (
    '20000000-0000-4000-8000-000000000812',
    '10000000-0000-4000-8000-000000000811',
    'wolfie',
    'Thanks for telling me.',
    1,
    'feedback',
    'practice',
    '{}',
    false,
    '{}'
  );

select public.record_wolfie_fact(
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  'resides_in',
  'student',
  'Nova Iguaçu',
  'nova iguacu',
  false,
  '10000000-0000-4000-8000-000000000811',
  '20000000-0000-4000-8000-000000000811',
  'I live in Nova Iguaçu.',
  0.99,
  '{"source":"sql_test"}',
  false
);

select public.record_wolfie_fact(
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  'resides_in',
  'student',
  'Nova Iguaçu',
  'nova iguacu',
  false,
  '10000000-0000-4000-8000-000000000811',
  '20000000-0000-4000-8000-000000000811',
  'I live in Nova Iguaçu.',
  0.99,
  '{"source":"sql_test","reviewed":true}',
  true
);

select pg_temp.assert_true(
  (
    select count(*) = 1
       and bool_and(verification_status = 'confirmed')
       and bool_and(source_kind = 'learner_confirmation')
      from public.wolfie_facts
     where student_id = '00000000-0000-4000-8000-000000000811'
       and fact_type = 'resides_in'
       and status = 'active'
  ),
  'explicit confirmation must confirm exactly one active fact'
);

select public.record_wolfie_fact(
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  'resides_in',
  'student',
  'Bahia',
  'bahia',
  false,
  '10000000-0000-4000-8000-000000000811',
  '20000000-0000-4000-8000-000000000811',
  'I live in Bahia.',
  null,
  '{"source":"sql_test","typed":true}',
  false
);

select pg_temp.assert_true(
  (
    select count(*) = 2
       and count(*) filter (where status = 'active' and value = 'Bahia') = 1
       and count(*) filter (
         where status = 'superseded' and value = 'Nova Iguaçu'
       ) = 1
       and max(version) = 2
      from public.wolfie_facts
     where student_id = '00000000-0000-4000-8000-000000000811'
       and fact_type = 'resides_in'
  ),
  'a current conflicting statement must supersede the old slot'
);

insert into public.wolfie_corrections (
  id,
  session_id,
  turn_id,
  wrong_sentence,
  correct_sentence,
  natural_sentence,
  explanation_pt,
  error_type,
  priority,
  requires_retry,
  retry_completed
)
values (
  '30000000-0000-4000-8000-000000000811',
  '10000000-0000-4000-8000-000000000811',
  '20000000-0000-4000-8000-000000000811',
  'I live at Bahia',
  'I live in Bahia',
  'I live in Bahia',
  'Use in with cities and states.',
  'grammar',
  'high',
  true,
  false
);

savepoint second_pending_retry;
\set second_pending_retry_failed false
\set ON_ERROR_STOP off
insert into public.wolfie_corrections (
  session_id,
  turn_id,
  wrong_sentence,
  correct_sentence,
  explanation_pt,
  error_type,
  priority,
  requires_retry,
  retry_completed
)
values (
  '10000000-0000-4000-8000-000000000811',
  '20000000-0000-4000-8000-000000000811',
  'I am live in Bahia',
  'I live in Bahia',
  'Remove am.',
  'grammar',
  'medium',
  true,
  false
);
\if :ERROR
  \set second_pending_retry_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint second_pending_retry;

select pg_temp.assert_true(
  :'second_pending_retry_failed'::boolean,
  'the database must reject a second active pending retry'
);

select public.dispute_wolfie_pending_correction(
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  '10000000-0000-4000-8000-000000000811',
  'learner_reported_bad_transcription'
);

select pg_temp.assert_true(
  (
    select status = 'disputed'
       and requires_retry is false
       and disputed_at is not null
      from public.wolfie_corrections
     where id = '30000000-0000-4000-8000-000000000811'
  ),
  'a dispute must atomically deactivate the correction'
);
select pg_temp.assert_true(
  (
    select current_stage = 'practice'
       and scenario_status = 'active'
       and retry_count = 0
      from public.wolfie_sessions
     where id = '10000000-0000-4000-8000-000000000811'
  ),
  'a dispute must atomically release the session retry lock'
);

select public.record_wolfie_realtime_exchange(
  '10000000-0000-4000-8000-000000000811',
  '40000000-0000-4000-8000-000000000811',
  'I live in Rio.',
  'Thanks. Let us keep practicing.',
  'realtime_audio',
  0.72,
  true
) as first_realtime_result
\gset

select public.record_wolfie_realtime_exchange(
  '10000000-0000-4000-8000-000000000811',
  '40000000-0000-4000-8000-000000000811',
  'I live in Rio.',
  'Thanks. Let us keep practicing.',
  'realtime_audio',
  0.72,
  true
) as replayed_realtime_result
\gset

select pg_temp.assert_true(
  (:'first_realtime_result'::jsonb ->> 'inserted')::boolean,
  'the first realtime callback must insert the pair'
);
select pg_temp.assert_true(
  not (:'replayed_realtime_result'::jsonb ->> 'inserted')::boolean,
  'a repeated realtime callback must be idempotent'
);
select pg_temp.assert_true(
  (
    select count(*) = 2
       and bool_and(requires_retry is false)
       and bool_and(
         (structured_payload ->> 'eligibleForFactExtraction')::boolean
           is false
       )
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000811'
       and client_turn_id = '40000000-0000-4000-8000-000000000811'
  ),
  'realtime rough-guide transcripts must create exactly two inert turns'
);
select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.wolfie_facts
     where student_id = '00000000-0000-4000-8000-000000000811'
  ),
  'realtime transcript persistence must not infer a learner fact'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000811"}',
  true
);
select pg_temp.assert_true(
  (select count(*) = 2 from public.wolfie_facts),
  'a learner may read only their own factual assertions'
);

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000899"}',
  true
);
select pg_temp.assert_true(
  (select count(*) = 0 from public.wolfie_facts),
  'another authenticated learner must not read these facts'
);

savepoint authenticated_fact_write;
\set authenticated_fact_write_failed false
\set ON_ERROR_STOP off
select public.record_wolfie_fact(
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  'resides_in',
  'student',
  'Blocked',
  'blocked',
  false,
  null,
  null,
  'Blocked',
  null,
  '{}',
  false
);
\if :ERROR
  \set authenticated_fact_write_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint authenticated_fact_write;
select pg_temp.assert_true(
  :'authenticated_fact_write_failed'::boolean,
  'authenticated clients must not execute the fact writer'
);

reset role;
rollback;
