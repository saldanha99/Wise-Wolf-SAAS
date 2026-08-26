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
values ('wolfie-classic-atomic-fixture', 'Wolfie Classic Atomic Fixture');

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
  '00000000-0000-4000-8000-000000000821',
  'authenticated',
  'authenticated',
  'wolfie-classic-atomic@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Wolfie Classic Atomic"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'wolfie-classic-atomic-fixture',
       role = 'STUDENT',
       lifecycle_status = 'active',
       is_test_account = false,
       test_fixture_key = 'wolfie-classic-atomic-sql'
 where id = '00000000-0000-4000-8000-000000000821';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values (
  '00000000-0000-4000-8000-000000000821',
  'wolfie-classic-atomic-fixture',
  'STUDENT',
  'ACTIVE',
  true
)
on conflict (user_id, tenant_id) do update
  set role = excluded.role,
      status = excluded.status,
      is_primary = excluded.is_primary;

create or replace function pg_temp.commit_classic(
  p_session_id uuid,
  p_client_turn_id uuid,
  p_expected_stage text,
  p_expected_status text,
  p_expected_report jsonb,
  p_expected_memory jsonb,
  p_expected_retry_count integer,
  p_expected_pending_retry_id uuid,
  p_student_content text,
  p_next_stage text,
  p_next_status text,
  p_complete_retry_id uuid,
  p_corrections jsonb,
  p_materialized_report jsonb
)
returns jsonb
language sql
as $$
  select public.commit_wolfie_classic_exchange(
    p_session_id => p_session_id,
    p_student_id => '00000000-0000-4000-8000-000000000821',
    p_tenant_id => 'wolfie-classic-atomic-fixture',
    p_client_turn_id => p_client_turn_id,
    p_expected_current_stage => p_expected_stage,
    p_expected_scenario_status => p_expected_status,
    p_expected_report => p_expected_report,
    p_expected_memory => p_expected_memory,
    p_expected_retry_count => p_expected_retry_count,
    p_expected_pending_retry_id => p_expected_pending_retry_id,
    p_student_content => p_student_content,
    p_student_stage => p_expected_stage,
    p_student_payload => jsonb_build_object('learnerTurnKind', 'perform'),
    p_student_language_code => 'en-US',
    p_student_speech_metrics => '{}'::jsonb,
    p_transcription_confidence => null,
    p_assistant_content => 'Canonical classic answer.',
    p_assistant_message_type => 'feedback',
    p_assistant_language_code => 'en-US',
    p_response_payload => jsonb_build_object(
      'chatResponse', 'Canonical classic answer.',
      'assistant_message', 'Canonical classic answer.',
      'message_type', 'feedback',
      'current_stage', p_next_stage,
      'scenario_status', p_next_status,
      'corrections', '[]'::jsonb,
      'new_vocabulary', '[]'::jsonb,
      'student_strengths', '[]'::jsonb,
      'student_priorities', '[]'::jsonb,
      'next_action', 'Continue.',
      'profile_updates', '{}'::jsonb,
      'session_score', 80,
      'needs_external_verification', false,
      'requires_retry', p_next_status = 'awaiting_retry',
      'retry_completed', p_complete_retry_id is not null
    ),
    p_next_stage => p_next_stage,
    p_next_scenario_status => p_next_status,
    p_next_scenario_step => case p_next_stage
      when 'discovery' then 1
      when 'briefing' then 2
      when 'guided_build' then 3
      when 'practice' then 4
      when 'feedback' then 5
      when 'retry' then 6
      when 'simulation' then 7
      when 'readaptation' then 8
      when 'improvisation' then 9
      when 'assessment' then 10
      when 'report' then 11
      else 12
    end,
    p_needs_external_verification => false,
    p_next_report => p_expected_report || jsonb_build_object(
      'currentStage', p_next_stage,
      'scenarioStatus', p_next_status,
      'updatedAt', now()
    ),
    p_next_memory => p_expected_memory || jsonb_build_object(
      'currentStage', p_next_stage,
      'updatedAt', now()
    ),
    p_session_config => jsonb_build_object(
      'experience_mode', 'global_meeting',
      'correction_mode', 'immediate',
      'language_mode', 'immersive',
      'difficulty', 'balanced',
      'scenario_context', 'Global project update',
      'student_goal', 'Contribute clearly',
      'target_skill', 'status update',
      'planned_duration_minutes', 20,
      'time_limit_seconds', 1200,
      'config_snapshot', jsonb_build_object(
        'experienceMode', 'global_meeting',
        'topic', 'Project update'
      )
    ),
    p_recorded_at => clock_timestamp(),
    p_complete_retry_id => p_complete_retry_id,
    p_retry_score => case when p_complete_retry_id is null then null else 80 end,
    p_retry_feedback => jsonb_build_object('evidence', p_student_content),
    p_new_corrections => p_corrections,
    p_session_report => p_materialized_report
  );
$$;

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
  memory_summary,
  classic_first_client_turn_id
)
values (
  '10000000-0000-4000-8000-000000000821',
  'wolfie-classic-atomic-fixture',
  '00000000-0000-4000-8000-000000000821',
  'Project update',
  'fluency',
  'B2',
  'global_meeting',
  'immediate',
  'immersive',
  'balanced',
  'practice',
  'active',
  0,
  '{}',
  '{}',
  '{}',
  '40000000-0000-4000-8000-000000000821'
);

do $first_commit$
declare
  result jsonb;
  materialized jsonb;
begin
  materialized := jsonb_build_object(
    'tenant_id', 'wolfie-classic-atomic-fixture',
    'student_id', '00000000-0000-4000-8000-000000000821',
    'conversation_session_id', '10000000-0000-4000-8000-000000000821',
    'topic', 'Project update',
    'objective', 'Contribute clearly',
    'difficulty', 'balanced',
    'accomplishments', jsonb_build_array('Clear opening'),
    'primary_corrections', '[]'::jsonb,
    'new_vocabulary', '[]'::jsonb,
    'rubric_scores', jsonb_build_object('latest', 80),
    'generated_by_model', 'sql-fixture',
    'generated_at', clock_timestamp()
  );
  result := pg_temp.commit_classic(
    '10000000-0000-4000-8000-000000000821',
    '40000000-0000-4000-8000-000000000821',
    'practice',
    'active',
    '{}'::jsonb,
    '{}'::jsonb,
    0,
    null,
    'Here is our project update.',
    'simulation',
    'active',
    null,
    '[]'::jsonb,
    materialized
  );
  perform pg_temp.assert_true(
    result ->> 'persisted' = 'true' and result ->> 'idempotent' = 'false',
    'the first classic exchange must commit once'
  );
end;
$first_commit$;

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000821'
       and client_turn_id = '40000000-0000-4000-8000-000000000821'
       and source_kind = 'classic'
  ),
  'the student/assistant pair must commit atomically'
);
select pg_temp.assert_true(
  (
    select current_stage = 'simulation'
       and scenario_status = 'active'
       and retry_count = 0
       and report_json ->> 'currentStage' = 'simulation'
       and memory_summary ->> 'currentStage' = 'simulation'
       and turn_count = 1
      from public.wolfie_sessions
     where id = '10000000-0000-4000-8000-000000000821'
  ),
  'session state, report and memory must share the committed checkpoint'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_session_reports
     where conversation_session_id = '10000000-0000-4000-8000-000000000821'
       and topic = 'Project update'
  ),
  'the materialized report must commit with the exchange'
);
select pg_temp.assert_true(
  (
    select bool_and(structured_payload -> 'classicCommit' ->> 'status' = 'completed')
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000821'
       and client_turn_id = '40000000-0000-4000-8000-000000000821'
  ),
  'both classic turns must carry a completed transaction marker'
);

do $idempotent_replay$
declare
  result jsonb;
begin
  result := pg_temp.commit_classic(
    '10000000-0000-4000-8000-000000000821',
    '40000000-0000-4000-8000-000000000821',
    'practice',
    'active',
    '{}'::jsonb,
    '{}'::jsonb,
    0,
    null,
    'Here is our project update.',
    'simulation',
    'active',
    null,
    '[]'::jsonb,
    null
  );
  perform pg_temp.assert_true(
    result ->> 'persisted' = 'true'
      and result ->> 'idempotent' = 'true'
      and result -> 'responsePayload' ->> 'chatResponse' = 'Canonical classic answer.',
    'the same client turn must replay its canonical response before CAS'
  );
end;
$idempotent_replay$;

select pg_temp.assert_true(
  (
    select count(*) = 2
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000821'
  ),
  'idempotent replay must not add turns'
);

do $stale_snapshot$
declare
  result jsonb;
begin
  result := pg_temp.commit_classic(
    '10000000-0000-4000-8000-000000000821',
    '40000000-0000-4000-8000-000000000822',
    'practice',
    'active',
    '{}'::jsonb,
    '{}'::jsonb,
    0,
    null,
    'A stale concurrent contribution.',
    'assessment',
    'active',
    null,
    '[]'::jsonb,
    null
  );
  perform pg_temp.assert_true(
    result ->> 'persisted' = 'false' and result ->> 'reason' = 'cas_mismatch',
    'a different worker with an old snapshot must lose without rebasing'
  );
end;
$stale_snapshot$;

select pg_temp.assert_true(
  (
    select count(*) = 0
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000821'
       and client_turn_id = '40000000-0000-4000-8000-000000000822'
  ),
  'a stale classic worker must leave no partial turn'
);

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
  memory_summary,
  classic_first_client_turn_id
)
values (
  '10000000-0000-4000-8000-000000000822',
  'wolfie-classic-atomic-fixture',
  '00000000-0000-4000-8000-000000000821',
  'Project update retry',
  'fluency',
  'B2',
  'global_meeting',
  'immediate',
  'immersive',
  'balanced',
  'retry',
  'awaiting_retry',
  1,
  '{}',
  '{}',
  '{}',
  '40000000-0000-4000-8000-000000000823'
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
values (
  '20000000-0000-4000-8000-000000000821',
  '10000000-0000-4000-8000-000000000822',
  'student',
  'We discuss the results yesterday.',
  0,
  'instruction',
  'practice',
  '{}',
  true,
  '{}',
  'classic',
  '40000000-0000-4000-8000-000000000820'
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
  skill_focus,
  priority,
  requires_retry,
  retry_completed,
  retry_feedback,
  status
)
values (
  '30000000-0000-4000-8000-000000000821',
  '10000000-0000-4000-8000-000000000822',
  '20000000-0000-4000-8000-000000000821',
  'We discuss the results yesterday.',
  'We discussed the results yesterday.',
  'We discussed yesterday''s results.',
  'Use o passado para uma ação concluída.',
  'grammar',
  'grammar',
  'high',
  true,
  false,
  '{}',
  'active'
);

do $retry_replacement$
declare
  result jsonb;
  materialized jsonb;
begin
  materialized := jsonb_build_object(
    'tenant_id', 'wolfie-classic-atomic-fixture',
    'student_id', '00000000-0000-4000-8000-000000000821',
    'conversation_session_id', '10000000-0000-4000-8000-000000000822',
    'topic', 'Project update retry',
    'accomplishments', '[]'::jsonb,
    'primary_corrections', '[]'::jsonb,
    'new_vocabulary', '[]'::jsonb,
    'rubric_scores', '{}'::jsonb,
    'generated_by_model', 'sql-fixture',
    'generated_at', clock_timestamp()
  );
  result := pg_temp.commit_classic(
    '10000000-0000-4000-8000-000000000822',
    '40000000-0000-4000-8000-000000000823',
    'retry',
    'awaiting_retry',
    '{}'::jsonb,
    '{}'::jsonb,
    1,
    '30000000-0000-4000-8000-000000000821',
    'We discussed yesterday''s results.',
    'practice',
    'active',
    '30000000-0000-4000-8000-000000000821',
    jsonb_build_array(jsonb_build_object(
      'wrong_sentence', 'We need improve clarity.',
      'correct_sentence', 'We need to improve clarity.',
      'natural_sentence', 'We need to make this clearer.',
      'explanation_pt', 'Use “need to” antes do verbo.',
      'error_type', 'grammar',
      'skill_focus', 'grammar',
      'priority', 'high',
      'requires_retry', true,
      'retry_feedback', '{}'::jsonb
    )),
    materialized
  );
  perform pg_temp.assert_true(
    result ->> 'persisted' = 'true'
      and result ->> 'stage' = 'retry'
      and result ->> 'scenarioStatus' = 'awaiting_retry'
      and result ->> 'retryCount' = '2',
    'completing one retry and creating its replacement must be one canonical commit'
  );
end;
$retry_replacement$;

select pg_temp.assert_true(
  (
    select retry_completed
       and retry_turn_id is not null
       and retry_completed_at is not null
      from public.wolfie_corrections
     where id = '30000000-0000-4000-8000-000000000821'
  ),
  'the prior retry must point to the new learner evidence turn'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_corrections
     where session_id = '10000000-0000-4000-8000-000000000822'
       and status = 'active'
       and requires_retry
       and not retry_completed
  ),
  'the transaction must preserve exactly one active retry lock'
);

do $late_validation_rollback$
declare
  snapshot_report jsonb;
  snapshot_memory jsonb;
  snapshot_retry_count integer;
begin
  select report_json, memory_summary, retry_count
    into snapshot_report, snapshot_memory, snapshot_retry_count
    from public.wolfie_sessions
   where id = '10000000-0000-4000-8000-000000000822';
  begin
    perform pg_temp.commit_classic(
      '10000000-0000-4000-8000-000000000822',
      '40000000-0000-4000-8000-000000000824',
      'retry',
      'awaiting_retry',
      snapshot_report,
      snapshot_memory,
      snapshot_retry_count,
      (
        select id
          from public.wolfie_corrections
         where session_id = '10000000-0000-4000-8000-000000000822'
           and status = 'active'
           and requires_retry
           and not retry_completed
      ),
      'We need to improve clarity.',
      'practice',
      'active',
      (
        select id
          from public.wolfie_corrections
         where session_id = '10000000-0000-4000-8000-000000000822'
           and status = 'active'
           and requires_retry
           and not retry_completed
      ),
      '[]'::jsonb,
      '{}'::jsonb
    );
    raise exception 'malformed materialized report was accepted';
  exception when sqlstate '22023' then
    null;
  end;
end;
$late_validation_rollback$;

select pg_temp.assert_true(
  (
    select count(*) = 0
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000822'
       and client_turn_id = '40000000-0000-4000-8000-000000000824'
  ),
  'a late validation error must roll back turns and retry completion'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      from public.wolfie_corrections
     where session_id = '10000000-0000-4000-8000-000000000822'
       and status = 'active'
       and requires_retry
       and not retry_completed
  ),
  'a failed atomic commit must leave the pending retry untouched'
);

-- A Realtime session may continue in classic mode only after the explicit
-- server-side handoff. Existing turns and the session snapshot stay intact.
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
  memory_summary,
  realtime_first_client_turn_id
)
values (
  '10000000-0000-4000-8000-000000000823',
  'wolfie-classic-atomic-fixture',
  '00000000-0000-4000-8000-000000000821',
  'Realtime fallback',
  'fluency',
  'B2',
  'global_meeting',
  'immediate',
  'immersive',
  'balanced',
  'practice',
  'active',
  0,
  '{}',
  '{}',
  '{}',
  '40000000-0000-4000-8000-000000000830'
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
    '20000000-0000-4000-8000-000000000830',
    '10000000-0000-4000-8000-000000000823',
    'student',
    'Realtime contribution.',
    0,
    'instruction',
    'practice',
    '{}',
    false,
    '{}',
    'openai_realtime',
    '40000000-0000-4000-8000-000000000830'
  ),
  (
    '20000000-0000-4000-8000-000000000831',
    '10000000-0000-4000-8000-000000000823',
    'wolfie',
    'Realtime response.',
    1,
    'feedback',
    'practice',
    '{"realtimeAnalysis":{"version":1,"status":"completed"}}',
    false,
    '{}',
    'openai_realtime',
    '40000000-0000-4000-8000-000000000830'
  );

do $explicit_handoff$
declare
  first_handoff jsonb;
  replay_handoff jsonb;
  claim_result jsonb;
  live_grant_result jsonb;
  commit_result jsonb;
begin
  first_handoff := public.handoff_wolfie_realtime_to_classic(
    '10000000-0000-4000-8000-000000000823',
    '00000000-0000-4000-8000-000000000821',
    'wolfie-classic-atomic-fixture'
  );
  replay_handoff := public.handoff_wolfie_realtime_to_classic(
    '10000000-0000-4000-8000-000000000823',
    '00000000-0000-4000-8000-000000000821',
    'wolfie-classic-atomic-fixture'
  );
  perform pg_temp.assert_true(
    first_handoff ->> 'handedOff' = 'true'
      and first_handoff ->> 'idempotent' = 'false'
      and replay_handoff ->> 'idempotent' = 'true',
    'handoff must be explicit and idempotent'
  );

  claim_result := public.claim_wolfie_realtime_analysis(
    '10000000-0000-4000-8000-000000000823',
    '20000000-0000-4000-8000-000000000831',
    '40000000-0000-4000-8000-000000000830',
    gen_random_uuid(),
    false
  );
  perform pg_temp.assert_true(
    claim_result ->> 'claimed' = 'false'
      and claim_result -> 'marker' ->> 'reason' = 'classic_handoff',
    'Realtime analysis claims must stop after handoff'
  );

  live_grant_result := public.claim_wolfie_live_grant(
    'wolfie-classic-atomic-fixture',
    '00000000-0000-4000-8000-000000000821',
    '10000000-0000-4000-8000-000000000823',
    60
  );
  perform pg_temp.assert_true(
    live_grant_result ->> 'claimed' = 'false'
      and live_grant_result ->> 'reason' = 'classic_handoff',
    'a new live grant must not race past the classic handoff'
  );

  commit_result := pg_temp.commit_classic(
    '10000000-0000-4000-8000-000000000823',
    '40000000-0000-4000-8000-000000000831',
    'practice',
    'active',
    '{}'::jsonb,
    '{}'::jsonb,
    0,
    null,
    'Classic fallback contribution.',
    'simulation',
    'active',
    null,
    '[]'::jsonb,
    null
  );
  perform pg_temp.assert_true(
    commit_result ->> 'persisted' = 'true',
    'classic commit must continue the same session after handoff'
  );
end;
$explicit_handoff$;

select pg_temp.assert_true(
  (
    select classic_handoff_at is not null
       and realtime_first_client_turn_id =
         '40000000-0000-4000-8000-000000000830'
       and classic_first_client_turn_id =
         '40000000-0000-4000-8000-000000000831'
      from public.wolfie_sessions
     where id = '10000000-0000-4000-8000-000000000823'
  ) and (
    select count(*) = 2
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000823'
       and source_kind = 'openai_realtime'
  ) and (
    select count(*) = 2
      from public.wolfie_turns
     where session_id = '10000000-0000-4000-8000-000000000823'
       and source_kind = 'classic'
  ),
  'handoff must preserve Realtime history and append classic history'
);

do $realtime_after_handoff_denied$
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
    source_kind,
    client_turn_id
  ) values (
    '10000000-0000-4000-8000-000000000823',
    'student',
    'Realtime must stay closed after handoff.',
    99,
    'instruction',
    'simulation',
    '{}',
    false,
    '{}',
    'openai_realtime',
    '40000000-0000-4000-8000-000000000832'
  );
  raise exception 'Realtime turn was accepted after classic handoff';
exception when sqlstate '55000' then
  null;
end;
$realtime_after_handoff_denied$;

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
  memory_summary,
  realtime_first_client_turn_id
)
values (
  '10000000-0000-4000-8000-000000000824',
  'wolfie-classic-atomic-fixture',
  '00000000-0000-4000-8000-000000000821',
  'Pending Realtime analysis',
  'fluency',
  'B2',
  'global_meeting',
  'immediate',
  'immersive',
  'balanced',
  'practice',
  'active',
  0,
  '{}',
  '{}',
  '{}',
  '40000000-0000-4000-8000-000000000840'
);
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
  source_kind,
  client_turn_id
)
values (
  '10000000-0000-4000-8000-000000000824',
  'wolfie',
  'Pending response.',
  0,
  'feedback',
  'practice',
  jsonb_build_object(
    'realtimeAnalysis', jsonb_build_object(
      'version', 1,
      'status', 'processing',
      'claimToken', '30000000-0000-4000-8000-000000000840',
      'claimedAt', clock_timestamp()
    )
  ),
  false,
  '{}',
  'openai_realtime',
  '40000000-0000-4000-8000-000000000840'
);
do $pending_analysis_handoff_denied$
begin
  perform public.handoff_wolfie_realtime_to_classic(
    '10000000-0000-4000-8000-000000000824',
    '00000000-0000-4000-8000-000000000821',
    'wolfie-classic-atomic-fixture'
  );
  raise exception 'handoff accepted a Realtime analysis with a live lease';
exception when sqlstate '55000' then
  null;
end;
$pending_analysis_handoff_denied$;

update public.wolfie_turns
   set structured_payload =
     '{"realtimeAnalysis":{"version":1,"status":"awaiting_confirmation"}}'
 where session_id = '10000000-0000-4000-8000-000000000824'
   and source_kind = 'openai_realtime'
   and speaker = 'wolfie';
do $awaiting_confirmation_handoff_denied$
begin
  perform public.handoff_wolfie_realtime_to_classic(
    '10000000-0000-4000-8000-000000000824',
    '00000000-0000-4000-8000-000000000821',
    'wolfie-classic-atomic-fixture'
  );
  raise exception 'handoff bypassed an awaiting-confirmation analysis';
exception when sqlstate '55000' then
  null;
end;
$awaiting_confirmation_handoff_denied$;

update public.wolfie_turns
   set structured_payload =
     '{"realtimeAnalysis":{"version":1,"status":"retryable"}}'
 where session_id = '10000000-0000-4000-8000-000000000824'
   and source_kind = 'openai_realtime'
   and speaker = 'wolfie';
select pg_temp.assert_true(
  (
    public.handoff_wolfie_realtime_to_classic(
      '10000000-0000-4000-8000-000000000824',
      '00000000-0000-4000-8000-000000000821',
      'wolfie-classic-atomic-fixture'
    ) ->> 'handedOff'
  ) = 'true',
  'retryable analysis may fall back from the last stable snapshot'
);

-- A crashed worker must not strand fallback forever. Once the same two-minute
-- lease used by claim_wolfie_realtime_analysis expires, handoff fences the old
-- claim by making its marker terminal in the same transaction.
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
  memory_summary,
  realtime_first_client_turn_id
)
values (
  '10000000-0000-4000-8000-000000000825',
  'wolfie-classic-atomic-fixture',
  '00000000-0000-4000-8000-000000000821',
  'Expired Realtime analysis',
  'fluency',
  'B2',
  'global_meeting',
  'immediate',
  'immersive',
  'balanced',
  'practice',
  'active',
  0,
  '{}',
  '{}',
  '{}',
  '40000000-0000-4000-8000-000000000841'
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
values (
  '20000000-0000-4000-8000-000000000841',
  '10000000-0000-4000-8000-000000000825',
  'wolfie',
  'Orphaned processing response.',
  0,
  'feedback',
  'practice',
  jsonb_build_object(
    'realtimeAnalysis', jsonb_build_object(
      'version', 1,
      'status', 'processing',
      'clientTurnId', '40000000-0000-4000-8000-000000000841',
      'assistantTurnId', '20000000-0000-4000-8000-000000000841',
      'claimToken', '30000000-0000-4000-8000-000000000841',
      'claimedAt', clock_timestamp() - interval '3 minutes'
    )
  ),
  false,
  '{}',
  'openai_realtime',
  '40000000-0000-4000-8000-000000000841'
);

do $expired_processing_handoff_allowed$
declare
  handoff_result jsonb;
begin
  handoff_result := public.handoff_wolfie_realtime_to_classic(
    '10000000-0000-4000-8000-000000000825',
    '00000000-0000-4000-8000-000000000821',
    'wolfie-classic-atomic-fixture'
  );
  perform pg_temp.assert_true(
    handoff_result ->> 'handedOff' = 'true'
      and handoff_result ->> 'idempotent' = 'false'
      and handoff_result ->> 'releasedRealtimeClaims' = '1',
    'an expired processing lease must permit handoff and fence one claim'
  );
  perform pg_temp.assert_true(
    (
      select classic_handoff_at is not null
        from public.wolfie_sessions
       where id = '10000000-0000-4000-8000-000000000825'
    ) and (
      select structured_payload #>> '{realtimeAnalysis,status}' = 'unavailable'
         and structured_payload #>> '{realtimeAnalysis,reason}' =
           'classic_handoff'
         and structured_payload #>> '{realtimeAnalysis,claimToken}' =
           '30000000-0000-4000-8000-000000000841'
        from public.wolfie_turns
       where id = '20000000-0000-4000-8000-000000000841'
    ),
    'handoff and stale-claim fencing must commit as one state transition'
  );
end;
$expired_processing_handoff_allowed$;

do $anchored_transport_guard$
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
      source_kind,
      client_turn_id
    ) values (
      '10000000-0000-4000-8000-000000000821',
      'student',
      'Realtime must not enter a classic-anchored session.',
      99,
      'instruction',
      'simulation',
      '{}',
      false,
      '{}',
      'openai_realtime',
      '40000000-0000-4000-8000-000000000899'
    );
    raise exception 'transport guard accepted Realtime in a classic session';
  exception when sqlstate '55000' then
    null;
  end;
end;
$anchored_transport_guard$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000821"}',
  true
);
do $authenticated_writer_denied$
begin
  begin
    perform pg_temp.commit_classic(
      '10000000-0000-4000-8000-000000000821',
      '40000000-0000-4000-8000-000000000898',
      'simulation',
      'active',
      '{}'::jsonb,
      '{}'::jsonb,
      0,
      null,
      'Blocked.',
      'assessment',
      'active',
      null,
      '[]'::jsonb,
      null
    );
    raise exception 'authenticated role executed the classic writer';
  exception when insufficient_privilege then
    null;
  end;
end;
$authenticated_writer_denied$;

reset role;
rollback;
