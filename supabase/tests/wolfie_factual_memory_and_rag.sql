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
  speech_metrics,
  source_kind,
  client_turn_id
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
    '{}',
    'openai_realtime',
    '40000000-0000-4000-8000-000000000800'
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
    '{}',
    'openai_realtime',
    '40000000-0000-4000-8000-000000000800'
  );

do $transport_guard$
begin
  begin
    insert into public.wolfie_turns (
      session_id,
      speaker,
      content,
      turn_index,
      message_type,
      stage,
      structured_payload,
      requires_retry,
      speech_metrics,
      source_kind
    ) values (
      '10000000-0000-4000-8000-000000000811',
      'student',
      'This classic turn must not enter a Realtime session.',
      2,
      'instruction',
      'practice',
      '{}'::jsonb,
      false,
      '{}'::jsonb,
      'classic'
    );
    raise exception 'transport guard accepted a mixed writer';
  exception when sqlstate '55000' then
    null;
  end;
end;
$transport_guard$;

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
       and bool_and(occurrence_count = 1)
      from public.wolfie_facts
     where student_id = '00000000-0000-4000-8000-000000000811'
       and fact_type = 'resides_in'
       and status = 'active'
  ),
  'explicit replay from the same turn must confirm one fact without incrementing occurrence_count'
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

select
  (:'first_realtime_result'::jsonb ->> 'studentTurnId')::uuid
    as realtime_student_turn_id,
  (:'first_realtime_result'::jsonb ->> 'assistantTurnId')::uuid
    as realtime_assistant_turn_id
\gset

select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'realtime_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000811',
  '50000000-0000-4000-8000-000000000811',
  false
) as realtime_claim
\gset
select pg_temp.assert_true(
  (:'realtime_claim'::jsonb ->> 'claimed')::boolean,
  'the first post-turn analyzer must claim the assistant turn'
);

select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'realtime_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000811',
  '50000000-0000-4000-8000-000000000812',
  false
) as competing_claim
\gset
select pg_temp.assert_true(
  not (:'competing_claim'::jsonb ->> 'claimed')::boolean,
  'a concurrent post-turn analyzer must not steal a fresh claim'
);

savepoint malformed_realtime_marker;
\set malformed_realtime_marker_failed false
\set ON_ERROR_STOP off
select public.finalize_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'realtime_student_turn_id'::uuid,
  :'realtime_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000811',
  '50000000-0000-4000-8000-000000000811',
  '{}'::jsonb
);
\if :ERROR
  \set malformed_realtime_marker_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint malformed_realtime_marker;
select pg_temp.assert_true(
  :'malformed_realtime_marker_failed'::boolean,
  'a terminal marker without server ids and status must be rejected'
);

select pg_temp.assert_true(
  public.finalize_wolfie_realtime_analysis(
    '10000000-0000-4000-8000-000000000811',
    :'realtime_student_turn_id'::uuid,
    :'realtime_assistant_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000811',
    '50000000-0000-4000-8000-000000000811',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'completed',
      'clientTurnId', '40000000-0000-4000-8000-000000000811',
      'studentTurnId', :'realtime_student_turn_id',
      'assistantTurnId', :'realtime_assistant_turn_id',
      'currentStage', 'practice',
      'scenarioStatus', 'active'
    )
  ),
  'the claim owner must atomically finalize both turns'
);
select pg_temp.assert_true(
  (
    select count(*) = 2
       and bool_and(
         structured_payload #>> '{realtimeAnalysis,status}' = 'completed'
       )
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000811'
       and client_turn_id = '40000000-0000-4000-8000-000000000811'
  ),
  'both realtime turns must expose the same terminal marker'
);

select public.record_wolfie_realtime_exchange(
  '10000000-0000-4000-8000-000000000811',
  '40000000-0000-4000-8000-000000000819',
  'I am ready to retry this turn.',
  'Please go ahead.',
  'text',
  null,
  true
) as retryable_exchange
\gset
select
  (:'retryable_exchange'::jsonb ->> 'studentTurnId')::uuid
    as retryable_student_turn_id,
  (:'retryable_exchange'::jsonb ->> 'assistantTurnId')::uuid
    as retryable_assistant_turn_id
\gset
select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'retryable_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000819',
  '50000000-0000-4000-8000-000000000819',
  false
) as retryable_first_claim
\gset
select pg_temp.assert_true(
  public.finalize_wolfie_realtime_analysis(
    '10000000-0000-4000-8000-000000000811',
    :'retryable_student_turn_id'::uuid,
    :'retryable_assistant_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000819',
    '50000000-0000-4000-8000-000000000819',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'retryable',
      'reason', 'provider_unavailable',
      'clientTurnId', '40000000-0000-4000-8000-000000000819',
      'studentTurnId', :'retryable_student_turn_id',
      'assistantTurnId', :'retryable_assistant_turn_id',
      'currentStage', 'practice',
      'scenarioStatus', 'active'
    )
  ),
  'a transient provider failure must finalize as retryable rather than unavailable'
);
select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'retryable_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000819',
  '50000000-0000-4000-8000-000000000820',
  false
) as retryable_second_claim
\gset
select pg_temp.assert_true(
  (:'retryable_second_claim'::jsonb ->> 'claimed')::boolean,
  'a retryable marker must be immediately claimable with the same client turn id'
);
select pg_temp.assert_true(
  public.finalize_wolfie_realtime_analysis(
    '10000000-0000-4000-8000-000000000811',
    :'retryable_student_turn_id'::uuid,
    :'retryable_assistant_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000819',
    '50000000-0000-4000-8000-000000000820',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'completed',
      'clientTurnId', '40000000-0000-4000-8000-000000000819',
      'studentTurnId', :'retryable_student_turn_id',
      'assistantTurnId', :'retryable_assistant_turn_id',
      'currentStage', 'practice',
      'scenarioStatus', 'active'
    )
  ),
  'the idempotent retry must be able to complete the original pair'
);

select public.record_wolfie_realtime_exchange(
  '10000000-0000-4000-8000-000000000811',
  '40000000-0000-4000-8000-000000000821',
  'I applied the retry and named the owner.',
  'The checkpoint is ready.',
  'text',
  null,
  true
) as cas_exchange
\gset
select
  (:'cas_exchange'::jsonb ->> 'studentTurnId')::uuid as cas_student_turn_id,
  (:'cas_exchange'::jsonb ->> 'assistantTurnId')::uuid as cas_assistant_turn_id
\gset

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
  '30000000-0000-4000-8000-000000000813',
  '10000000-0000-4000-8000-000000000811',
  :'cas_student_turn_id'::uuid,
  'I applied retry',
  'I applied the retry',
  'I applied the retry',
  'Use the article in this context.',
  'grammar',
  'high',
  true,
  false
);
update public.wolfie_sessions
   set current_stage = 'retry',
       scenario_status = 'awaiting_retry',
       retry_count = 1
 where id = '10000000-0000-4000-8000-000000000811';

select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'cas_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000821',
  '50000000-0000-4000-8000-000000000821',
  false
) as cas_claim
\gset
select pg_temp.assert_true(
  (:'cas_claim'::jsonb ->> 'claimed')::boolean,
  'the fenced session commit needs a live analysis claim'
);

select pg_temp.assert_true(
  (
    public.cas_wolfie_realtime_session_analysis(
    '10000000-0000-4000-8000-000000000811',
    '00000000-0000-4000-8000-000000000811',
    'wolfie-factual-fixture',
    '{}',
    '{}',
    '{"checkpoint":"v1"}',
    '{"adaptiveLevel":2}',
    'simulation',
    'active',
    7,
    0,
    false,
    now(),
    :'cas_assistant_turn_id'::uuid,
    :'cas_student_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000821',
    '50000000-0000-4000-8000-000000000821',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'completed',
      'clientTurnId', '40000000-0000-4000-8000-000000000821',
      'studentTurnId', :'cas_student_turn_id',
      'assistantTurnId', :'cas_assistant_turn_id',
      'learnerIntent', 'perform',
      'correctionsCreated', 1,
      'realtimeGuidance', pg_catalog.jsonb_build_object(
        'currentStage', 'simulation',
        'scenarioStatus', 'active',
        'requiresRetry', false
      )
    ),
    pg_catalog.jsonb_build_object(
      'tenant_id', 'wolfie-factual-fixture',
      'student_id', '00000000-0000-4000-8000-000000000811',
      'conversation_session_id', '10000000-0000-4000-8000-000000000811',
      'topic', 'Atomic Realtime fixture',
      'accomplishments', '[]'::jsonb,
      'primary_corrections', '[]'::jsonb,
      'new_vocabulary', '[]'::jsonb,
      'rubric_scores', '{"latest":82,"rubric":{}}'::jsonb,
      'generated_by_model', 'sql-fixture',
      'generated_at', now()
    ),
    'retry',
    'awaiting_retry',
    '30000000-0000-4000-8000-000000000813',
    '30000000-0000-4000-8000-000000000813',
    :'cas_student_turn_id'::uuid,
    82,
    '{"source":"sql_atomic_retry","targetMatched":true}'::jsonb,
      :'cas_student_turn_id'::uuid,
      '[{
        "wrong_sentence":"I applied retry",
        "correct_sentence":"I applied the retry",
        "natural_sentence":"I applied the retry",
        "explanation_pt":"Use the article in this context.",
        "error_type":"grammar",
        "skill_focus":"grammar",
        "priority":"low",
        "requires_retry":false,
        "retry_feedback":{"analysisSnapshot":{"version":1}}
      }]'::jsonb
    ) ->> 'persisted'
  )::boolean,
  'the first JSONB session compare-and-swap must persist with its retry'
);
select pg_temp.assert_true(
  (
    select retry_completed
       and retry_turn_id = :'cas_student_turn_id'::uuid
       and retry_score = 82
       and retry_feedback ->> 'source' = 'sql_atomic_retry'
      from public.wolfie_corrections
     where id = '30000000-0000-4000-8000-000000000813'
  ),
  'retry completion and the canonical session checkpoint must commit together'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_corrections
     where session_id = '10000000-0000-4000-8000-000000000811'
       and turn_id = :'cas_student_turn_id'::uuid
       and wrong_sentence = 'I applied retry'
       and not requires_retry
  ),
  'new corrections must be inserted by the same fenced session transaction'
);
select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.wolfie_turns
     where id in (:'cas_student_turn_id'::uuid, :'cas_assistant_turn_id'::uuid)
       and structured_payload #>> '{realtimeAnalysis,status}' = 'completed'
       and structured_payload #>> '{realtimeAnalysis,persistence,sessionReport}' = 'true'
  ),
  'the session CAS must atomically finalize both turn markers'
);
select pg_temp.assert_true(
  (
    select rubric_scores ->> 'latest' = '82'
      from public.wolfie_session_reports
     where conversation_session_id = '10000000-0000-4000-8000-000000000811'
  ),
  'the session CAS must atomically materialize the canonical report'
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
  '30000000-0000-4000-8000-000000000812',
  '10000000-0000-4000-8000-000000000811',
  :'cas_student_turn_id'::uuid,
  'We need discuss the owner.',
  'We need to discuss the owner.',
  'We need to discuss the owner.',
  'Use need to plus the base verb.',
  'grammar',
  'high',
  true,
  false
);
select pg_temp.assert_true(
  not coalesce((
    public.cas_wolfie_realtime_session_analysis(
      '10000000-0000-4000-8000-000000000811',
      '00000000-0000-4000-8000-000000000811',
      'wolfie-factual-fixture',
      '{}',
      '{}',
      '{"checkpoint":"stale"}',
      '{}',
      'feedback',
      'active',
      5,
      0,
      false,
      now(),
      :'cas_assistant_turn_id'::uuid,
      :'cas_student_turn_id'::uuid,
      '40000000-0000-4000-8000-000000000821',
      '50000000-0000-4000-8000-000000000821',
      pg_catalog.jsonb_build_object(
        'version', 1,
        'status', 'completed',
        'clientTurnId', '40000000-0000-4000-8000-000000000821',
        'studentTurnId', :'cas_student_turn_id',
        'assistantTurnId', :'cas_assistant_turn_id',
        'correctionsCreated', 0,
        'realtimeGuidance', '{}'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'tenant_id', 'wolfie-factual-fixture',
        'student_id', '00000000-0000-4000-8000-000000000811',
        'conversation_session_id', '10000000-0000-4000-8000-000000000811',
        'topic', 'Stale CAS fixture',
        'accomplishments', '[]'::jsonb,
        'primary_corrections', '[]'::jsonb,
        'new_vocabulary', '[]'::jsonb,
        'rubric_scores', '{}'::jsonb,
        'generated_at', now()
      ),
      'simulation',
      'active',
      '30000000-0000-4000-8000-000000000812',
      '30000000-0000-4000-8000-000000000812',
      :'cas_student_turn_id'::uuid,
      90,
      '{"source":"must_not_commit"}'::jsonb,
      :'cas_student_turn_id'::uuid,
      '[]'::jsonb
    ) ->> 'persisted'
  )::boolean, false),
  'a stale JSONB session compare-and-swap must be rejected'
);
select pg_temp.assert_true(
  (
    select not retry_completed and retry_turn_id is null
      from public.wolfie_corrections
     where id = '30000000-0000-4000-8000-000000000812'
  ),
  'a rejected session CAS must not partially complete its retry'
);

select public.record_wolfie_realtime_exchange(
  '10000000-0000-4000-8000-000000000811',
  '40000000-0000-4000-8000-000000000822',
  'I will now try to finish despite the pending retry.',
  'Please continue.',
  'text',
  null,
  true
) as pending_guard_exchange
\gset
select
  (:'pending_guard_exchange'::jsonb ->> 'studentTurnId')::uuid
    as pending_guard_student_turn_id,
  (:'pending_guard_exchange'::jsonb ->> 'assistantTurnId')::uuid
    as pending_guard_assistant_turn_id
\gset
select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'pending_guard_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000822',
  '50000000-0000-4000-8000-000000000822',
  false
) as pending_guard_claim
\gset
select pg_temp.assert_true(
  (:'pending_guard_claim'::jsonb ->> 'claimed')::boolean,
  'the pending retry guard needs its own fenced analysis claim'
);

select public.cas_wolfie_realtime_session_analysis(
  '10000000-0000-4000-8000-000000000811',
  '00000000-0000-4000-8000-000000000811',
  'wolfie-factual-fixture',
  '{"checkpoint":"v1","currentStage":"simulation","scenarioStatus":"active"}',
  '{"adaptiveLevel":2,"currentStage":"simulation"}',
  '{"checkpoint":"must_not_finish"}',
  '{"adaptiveLevel":3}',
  'completed',
  'completed',
  12,
  1,
  false,
  now(),
  :'pending_guard_assistant_turn_id'::uuid,
  :'pending_guard_student_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000822',
  '50000000-0000-4000-8000-000000000822',
  pg_catalog.jsonb_build_object(
    'version', 1,
    'status', 'completed',
    'clientTurnId', '40000000-0000-4000-8000-000000000822',
    'studentTurnId', :'pending_guard_student_turn_id',
    'assistantTurnId', :'pending_guard_assistant_turn_id',
    'correctionsCreated', 0,
    'requiresRetry', false,
    'realtimeGuidance', pg_catalog.jsonb_build_object(
      'currentStage', 'completed',
      'scenarioStatus', 'completed',
      'requiresRetry', false
    )
  ),
  pg_catalog.jsonb_build_object(
    'tenant_id', 'wolfie-factual-fixture',
    'student_id', '00000000-0000-4000-8000-000000000811',
    'conversation_session_id', '10000000-0000-4000-8000-000000000811',
    'topic', 'Pending retry guard fixture',
    'accomplishments', '[]'::jsonb,
    'primary_corrections', '[]'::jsonb,
    'new_vocabulary', '[]'::jsonb,
    'rubric_scores', '{}'::jsonb,
    'generated_at', now()
  ),
  'simulation',
  'active',
  '30000000-0000-4000-8000-000000000812'
) as pending_retry_guard
\gset
select pg_temp.assert_true(
  :'pending_retry_guard'::jsonb ->> 'stage' = 'retry'
    and :'pending_retry_guard'::jsonb ->> 'scenarioStatus' = 'awaiting_retry'
    and (
      select finished_at is null
        from public.wolfie_sessions
       where id = '10000000-0000-4000-8000-000000000811'
    ),
  'an active pending correction must prevent a newer callback from finishing the session'
);
select pg_temp.assert_true(
  :'pending_retry_guard'::jsonb #>> '{marker,realtimeGuidance,requiresRetry}' = 'true'
    and :'pending_retry_guard'::jsonb #>> '{marker,currentStage}' = 'retry'
    and (
      select count(*) = 2
        from public.wolfie_turns
       where id in (
         :'pending_guard_student_turn_id'::uuid,
         :'pending_guard_assistant_turn_id'::uuid
       )
         and requires_retry
         and structured_payload #>> '{realtimeAnalysis,status}' = 'completed'
    )
    and (
      select stage = 'simulation'
        from public.wolfie_turns
       where id = :'pending_guard_student_turn_id'::uuid
    )
    and (
      select stage = 'retry'
        from public.wolfie_turns
       where id = :'pending_guard_assistant_turn_id'::uuid
    ),
  'the atomic marker and turn state must expose the canonical pending retry'
);

select public.record_wolfie_realtime_exchange(
  '10000000-0000-4000-8000-000000000811',
  '40000000-0000-4000-8000-000000000812',
  'The revised deadline is Friday.',
  'Please confirm that deadline.',
  'realtime_audio',
  0.55,
  true
) as confirmation_exchange
\gset
select
  (:'confirmation_exchange'::jsonb ->> 'studentTurnId')::uuid
    as confirmation_student_turn_id,
  (:'confirmation_exchange'::jsonb ->> 'assistantTurnId')::uuid
    as confirmation_assistant_turn_id
\gset
select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000812',
  '50000000-0000-4000-8000-000000000813',
  false
) as confirmation_claim
\gset
select pg_temp.assert_true(
  public.finalize_wolfie_realtime_analysis(
    '10000000-0000-4000-8000-000000000811',
    :'confirmation_student_turn_id'::uuid,
    :'confirmation_assistant_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000812',
    '50000000-0000-4000-8000-000000000813',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'awaiting_confirmation',
      'clientTurnId', '40000000-0000-4000-8000-000000000812',
      'studentTurnId', :'confirmation_student_turn_id',
      'assistantTurnId', :'confirmation_assistant_turn_id',
      'currentStage', 'simulation',
      'scenarioStatus', 'active'
    )
  ),
  'a low-confidence factual turn must pause atomically'
);
select public.claim_wolfie_realtime_analysis(
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_assistant_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000812',
  '50000000-0000-4000-8000-000000000814',
  true
) as resumed_confirmation_claim
\gset
select pg_temp.assert_true(
  (:'resumed_confirmation_claim'::jsonb ->> 'claimed')::boolean,
  'explicit learner confirmation must resume the paused post-turn analysis'
);
select pg_temp.assert_true(
  public.finalize_wolfie_realtime_analysis(
    '10000000-0000-4000-8000-000000000811',
    :'confirmation_student_turn_id'::uuid,
    :'confirmation_assistant_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000812',
    '50000000-0000-4000-8000-000000000814',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'completed',
      'clientTurnId', '40000000-0000-4000-8000-000000000812',
      'studentTurnId', :'confirmation_student_turn_id',
      'assistantTurnId', :'confirmation_assistant_turn_id',
      'currentStage', 'simulation',
      'scenarioStatus', 'active'
    )
  ),
  'the confirmed transcript must finish the resumed analysis claim'
);

select public.claim_wolfie_realtime_fact_confirmation(
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_student_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000812',
  '50000000-0000-4000-8000-000000000815',
  'The confirmed deadline is next Friday.'
) as fact_confirmation_claim
\gset
select pg_temp.assert_true(
  (:'fact_confirmation_claim'::jsonb ->> 'claimed')::boolean,
  'the first transcript confirmation callback must own the fact claim'
);

select public.claim_wolfie_realtime_fact_confirmation(
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_student_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000812',
  '50000000-0000-4000-8000-000000000816',
  'The confirmed deadline is next Friday.'
) as duplicate_fact_confirmation_claim
\gset
select pg_temp.assert_true(
  not (:'duplicate_fact_confirmation_claim'::jsonb ->> 'claimed')::boolean
    and :'duplicate_fact_confirmation_claim'::jsonb ->> 'status' = 'processing',
  'a duplicate callback must not enter the fact write section while the claim is fresh'
);

select pg_temp.assert_true(
  public.finalize_wolfie_realtime_fact_confirmation(
    '10000000-0000-4000-8000-000000000811',
    :'confirmation_student_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000812',
    '50000000-0000-4000-8000-000000000815',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'retryable',
      'clientTurnId', '40000000-0000-4000-8000-000000000812',
      'studentTurnId', :'confirmation_student_turn_id',
      'claimToken', '50000000-0000-4000-8000-000000000815',
      'confirmedTranscript', 'The confirmed deadline is next Friday.',
      'originalRoughTranscript', 'The revised deadline is Friday.',
      'reason', 'transient_fact_write',
      'retryableAt', now()
    )
  ),
  'a transient fact write must release its claim immediately'
);
select public.claim_wolfie_realtime_fact_confirmation(
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_student_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000812',
  '50000000-0000-4000-8000-000000000816',
  'The confirmed deadline is next Friday.'
) as resumed_fact_confirmation_claim
\gset
select pg_temp.assert_true(
  (:'resumed_fact_confirmation_claim'::jsonb ->> 'claimed')::boolean,
  'the released fact confirmation must be immediately claimable'
);

select pg_temp.assert_true(
  public.finalize_wolfie_realtime_fact_confirmation(
    '10000000-0000-4000-8000-000000000811',
    :'confirmation_student_turn_id'::uuid,
    '40000000-0000-4000-8000-000000000812',
    '50000000-0000-4000-8000-000000000816',
    pg_catalog.jsonb_build_object(
      'version', 1,
      'status', 'confirmed',
      'clientTurnId', '40000000-0000-4000-8000-000000000812',
      'studentTurnId', :'confirmation_student_turn_id',
      'claimToken', '50000000-0000-4000-8000-000000000816',
      'confirmedTranscript', 'The confirmed deadline is next Friday.',
      'originalRoughTranscript', 'The revised deadline is Friday.',
      'factsRecorded', 0,
      'factTypes', '[]'::jsonb,
      'confirmedAt', now()
    )
  ),
  'the fact claim owner must atomically finalize the current student payload'
);
select pg_temp.assert_true(
  (
    select content = 'The confirmed deadline is next Friday.'
       and structured_payload #>> '{factualConfirmation,originalRoughTranscript}' =
         'The revised deadline is Friday.'
       and structured_payload #>> '{realtimeAnalysis,status}' = 'completed'
      from public.wolfie_turns
     where id = :'confirmation_student_turn_id'::uuid
  ),
  'confirmation must update reload context while preserving rough evidence and a completed analysis marker'
);

select public.claim_wolfie_realtime_fact_confirmation(
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_student_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000812',
  '50000000-0000-4000-8000-000000000817',
  'The confirmed deadline is next Friday.'
) as replayed_fact_confirmation
\gset
select pg_temp.assert_true(
  not (:'replayed_fact_confirmation'::jsonb ->> 'claimed')::boolean
    and (:'replayed_fact_confirmation'::jsonb ->> 'idempotent')::boolean,
  'the same confirmed transcript must replay idempotently'
);

select public.claim_wolfie_realtime_fact_confirmation(
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_student_turn_id'::uuid,
  '40000000-0000-4000-8000-000000000812',
  '50000000-0000-4000-8000-000000000818',
  'A different deadline was confirmed.'
) as conflicting_fact_confirmation
\gset
select pg_temp.assert_true(
  (:'conflicting_fact_confirmation'::jsonb ->> 'conflict')::boolean,
  'a different transcript must not overwrite a completed confirmation'
);

select public.record_wolfie_fact(
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  'born_in',
  'student',
  'Recife',
  'recife',
  false,
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_student_turn_id'::uuid,
  'I was born in Recife.',
  1,
  '{"source":"realtime_text"}',
  true
);
select public.record_wolfie_fact(
  'wolfie-factual-fixture',
  '00000000-0000-4000-8000-000000000811',
  'born_in',
  'student',
  'Recife',
  'recife',
  false,
  '10000000-0000-4000-8000-000000000811',
  :'confirmation_student_turn_id'::uuid,
  'I was born in Recife.',
  1,
  '{"source":"realtime_text_replay"}',
  true
);
select pg_temp.assert_true(
  (
    select occurrence_count = 1 and verification_status = 'confirmed'
      from public.wolfie_facts
     where student_id = '00000000-0000-4000-8000-000000000811'
       and fact_type = 'born_in'
       and status = 'active'
  ),
  'text Realtime fact replay must remain one confirmed occurrence per persisted turn'
);

update public.wolfie_sessions
   set scenario_status = 'abandoned',
       finished_at = now()
 where id = '10000000-0000-4000-8000-000000000811';
savepoint realtime_after_close;
\set realtime_after_close_failed false
\set ON_ERROR_STOP off
select public.record_wolfie_realtime_exchange(
  '10000000-0000-4000-8000-000000000811',
  '40000000-0000-4000-8000-000000000813',
  'This turn must not be stored.',
  'This answer must not be stored.',
  'realtime_audio',
  0.90,
  true
);
\if :ERROR
  \set realtime_after_close_failed true
\endif
\set ON_ERROR_STOP on
rollback to savepoint realtime_after_close;
select pg_temp.assert_true(
  :'realtime_after_close_failed'::boolean,
  'the database must reject a realtime callback after session closure'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000811"}',
  true
);
select pg_temp.assert_true(
  (
    select count(*) = 3
       and bool_and(
         student_id = '00000000-0000-4000-8000-000000000811'
       )
      from public.wolfie_facts
  ),
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
