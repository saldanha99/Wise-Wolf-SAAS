-- Serialize the complete classic Wolfie exchange behind one exact-snapshot
-- compare-and-swap. No learner/assistant turn, retry, correction, report or
-- session state is visible unless the whole transaction commits.

alter table public.wolfie_sessions
  add column if not exists classic_first_client_turn_id uuid,
  add column if not exists classic_handoff_at timestamptz;

create unique index if not exists idx_wolfie_sessions_classic_first_turn
  on public.wolfie_sessions (
    tenant_id,
    student_id,
    classic_first_client_turn_id
  )
  where classic_first_client_turn_id is not null;

comment on column public.wolfie_sessions.classic_first_client_turn_id is
  'Idempotency anchor for the first classic exchange, including recovery after a lost HTTP response.';
comment on column public.wolfie_sessions.classic_handoff_at is
  'Server-authorized boundary after which a Realtime session continues via classic turns while retaining its existing history and retry state.';

-- client_turn_id now identifies both classic and Realtime exchanges. Keep
-- legacy classic rows (which predate idempotency keys) valid while requiring
-- the transactional writer below for all new application traffic.
alter table public.wolfie_turns
  drop constraint if exists wolfie_turns_realtime_source_check;
alter table public.wolfie_turns
  drop constraint if exists wolfie_turns_source_identity_check;
alter table public.wolfie_turns
  add constraint wolfie_turns_source_identity_check check (
    source_kind = 'classic'
    or (
      source_kind = 'openai_realtime'
      and client_turn_id is not null
    )
  );

comment on column public.wolfie_turns.client_turn_id is
  'Client-generated UUID shared by the student and Wolfie rows of one idempotent classic or Realtime exchange.';
comment on constraint wolfie_turns_realtime_idempotency_unique
  on public.wolfie_turns is
  'One student row and one Wolfie row per session/client turn across either transport.';

-- Elect the transport from its durable session anchor before the first turn;
-- legacy sessions without an anchor still elect from their first stored turn.
create or replace function public.guard_wolfie_session_turn_transport()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  opposite_transport_exists boolean;
  realtime_anchor uuid;
  classic_anchor uuid;
  classic_handoff_at timestamptz;
begin
  select realtime_first_client_turn_id, classic_first_client_turn_id,
         wolfie_sessions.classic_handoff_at
    into realtime_anchor, classic_anchor, classic_handoff_at
    from public.wolfie_sessions
   where id = new.session_id
   for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'wolfie_session_not_found';
  end if;

  if (
       new.source_kind = 'classic'
       and realtime_anchor is not null
       and classic_handoff_at is null
     ) or (
       new.source_kind = 'openai_realtime'
       and (classic_anchor is not null or classic_handoff_at is not null)
     ) then
    raise exception using
      errcode = '55000',
      message = 'wolfie_session_transport_mismatch';
  end if;

  select exists (
    select 1
      from public.wolfie_turns
     where session_id = new.session_id
       and source_kind <> new.source_kind
  ) into opposite_transport_exists;
  if opposite_transport_exists
     and not (
       new.source_kind = 'classic'
       and classic_handoff_at is not null
     ) then
    raise exception using
      errcode = '55000',
      message = 'wolfie_session_transport_mismatch';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_wolfie_session_turn_transport()
  from public, anon, authenticated;

-- Explicitly fence the transport switch. The session row lock serializes the
-- handoff with Realtime claims and turn admission. It never clears turns,
-- corrections, reports, or retry state.
create or replace function public.handoff_wolfie_realtime_to_classic(
  p_session_id uuid,
  p_student_id uuid,
  p_tenant_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_current_stage text;
  v_current_status text;
  v_finished_at timestamptz;
  v_realtime_anchor uuid;
  v_classic_anchor uuid;
  v_handoff_at timestamptz;
  v_requires_retry boolean;
  v_analysis_turn record;
  v_analysis_marker jsonb;
  v_claimed_at timestamptz;
  v_lease_checked_at timestamptz;
  v_stale_processing_turn_ids uuid[] := '{}'::uuid[];
  v_released_processing_count integer := 0;
begin
  if p_session_id is null
     or p_student_id is null
     or nullif(pg_catalog.btrim(p_tenant_id), '') is null then
    raise exception using errcode = '22023', message = 'invalid_classic_handoff';
  end if;

  select
    session.current_stage,
    session.scenario_status,
    session.finished_at,
    session.realtime_first_client_turn_id,
    session.classic_first_client_turn_id,
    session.classic_handoff_at
  into
    v_current_stage,
    v_current_status,
    v_finished_at,
    v_realtime_anchor,
    v_classic_anchor,
    v_handoff_at
  from public.wolfie_sessions as session
  where session.id = p_session_id
    and session.student_id = p_student_id
    and session.tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'wolfie_session_not_found';
  end if;
  select
    v_current_status = 'awaiting_retry'
    or exists (
      select 1
        from public.wolfie_corrections as correction
       where correction.session_id = p_session_id
         and correction.status = 'active'
         and correction.requires_retry = true
         and correction.retry_completed = false
    )
    into v_requires_retry;
  if v_handoff_at is not null then
    return pg_catalog.jsonb_build_object(
      'handedOff', true,
      'idempotent', true,
      'reused', true,
      'sessionId', p_session_id,
      'classicHandoffAt', v_handoff_at,
      'currentStage', v_current_stage,
      'scenarioStatus', v_current_status,
      'requiresRetry', v_requires_retry,
      'releasedRealtimeClaims', 0
    );
  end if;
  if v_finished_at is not null
     or v_current_stage = 'completed'
     or v_current_status in ('completed', 'abandoned', 'failed') then
    raise exception using errcode = '55000', message = 'wolfie_session_finished';
  end if;
  if v_realtime_anchor is null then
    raise exception using errcode = '55000', message = 'realtime_anchor_required';
  end if;
  if v_classic_anchor is not null then
    raise exception using errcode = '55000', message = 'classic_transport_already_started';
  end if;
  if exists (
    select 1
      from public.wolfie_live_grants as live_grant
     where live_grant.session_id = p_session_id
       and live_grant.student_id = p_student_id
       and live_grant.tenant_id = p_tenant_id
       and live_grant.status in ('RESERVED', 'ACTIVE', 'CLOSING')
  ) then
    raise exception using errcode = '55000', message = 'wolfie_live_grant_still_open';
  end if;
  -- Mirror claim_wolfie_realtime_analysis exactly: a processing claim owns a
  -- two-minute lease only when claimedAt parses and has not expired. Lock the
  -- marker rows after the session row so claim, finalize and handoff cannot
  -- cross the transport boundary with different snapshots.
  v_lease_checked_at := pg_catalog.clock_timestamp();
  for v_analysis_turn in
    select
      turn.id,
      coalesce(turn.structured_payload, '{}'::jsonb) as structured_payload
    from public.wolfie_turns as turn
    where turn.session_id = p_session_id
      and turn.speaker = 'wolfie'
      and turn.source_kind = 'openai_realtime'
      and turn.structured_payload #>> '{realtimeAnalysis,status}' in (
        'processing',
        'awaiting_confirmation'
      )
    order by turn.id
    for update
  loop
    v_analysis_marker :=
      v_analysis_turn.structured_payload -> 'realtimeAnalysis';
    if v_analysis_marker ->> 'status' = 'awaiting_confirmation' then
      raise exception using
        errcode = '55000',
        message = 'wolfie_realtime_analysis_not_terminal';
    end if;

    begin
      v_claimed_at := nullif(v_analysis_marker ->> 'claimedAt', '')::timestamptz;
    exception when others then
      v_claimed_at := null;
    end;
    if v_claimed_at is not null
       and v_lease_checked_at - v_claimed_at < interval '2 minutes' then
      raise exception using
        errcode = '55000',
        message = 'wolfie_realtime_analysis_not_terminal';
    end if;

    v_stale_processing_turn_ids := pg_catalog.array_append(
      v_stale_processing_turn_ids,
      v_analysis_turn.id
    );
  end loop;

  v_handoff_at := pg_catalog.clock_timestamp();
  if pg_catalog.cardinality(v_stale_processing_turn_ids) > 0 then
    update public.wolfie_turns as turn
       set structured_payload =
         coalesce(turn.structured_payload, '{}'::jsonb)
         || pg_catalog.jsonb_build_object(
           'eligibleForCorrection', false,
           'realtimeAnalysis',
             coalesce(
               turn.structured_payload -> 'realtimeAnalysis',
               '{}'::jsonb
             ) || pg_catalog.jsonb_build_object(
               'status', 'unavailable',
               'reason', 'classic_handoff',
               'unavailableAt', v_handoff_at
             )
         )
     where turn.session_id = p_session_id
       and turn.id = any(v_stale_processing_turn_ids);
    get diagnostics v_released_processing_count = row_count;
  end if;

  update public.wolfie_sessions
     set classic_handoff_at = v_handoff_at,
         updated_at = v_handoff_at
   where id = p_session_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id;

  return pg_catalog.jsonb_build_object(
    'handedOff', true,
    'idempotent', false,
    'reused', false,
    'sessionId', p_session_id,
    'classicHandoffAt', v_handoff_at,
    'currentStage', v_current_stage,
    'scenarioStatus', v_current_status,
    'requiresRetry', v_requires_retry,
    'releasedRealtimeClaims', v_released_processing_count
  );
end;
$function$;

revoke all on function public.handoff_wolfie_realtime_to_classic(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.handoff_wolfie_realtime_to_classic(
  uuid, uuid, text
) to service_role;

create or replace function public.commit_wolfie_classic_exchange(
  p_session_id uuid,
  p_student_id uuid,
  p_tenant_id text,
  p_client_turn_id uuid,
  p_expected_current_stage text,
  p_expected_scenario_status text,
  p_expected_report jsonb,
  p_expected_memory jsonb,
  p_expected_retry_count integer,
  p_expected_pending_retry_id uuid,
  p_student_content text,
  p_student_stage text,
  p_student_payload jsonb,
  p_student_language_code text,
  p_student_speech_metrics jsonb,
  p_transcription_confidence numeric,
  p_assistant_content text,
  p_assistant_message_type text,
  p_assistant_language_code text,
  p_response_payload jsonb,
  p_next_stage text,
  p_next_scenario_status text,
  p_next_scenario_step integer,
  p_needs_external_verification boolean,
  p_next_report jsonb,
  p_next_memory jsonb,
  p_session_config jsonb,
  p_recorded_at timestamptz,
  p_complete_retry_id uuid default null,
  p_retry_score numeric default null,
  p_retry_feedback jsonb default '{}'::jsonb,
  p_new_corrections jsonb default '[]'::jsonb,
  p_session_report jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_current_stage text;
  v_current_status text;
  v_current_report jsonb;
  v_current_memory jsonb;
  v_current_retry_count integer;
  v_current_finished_at timestamptz;
  v_realtime_anchor uuid;
  v_classic_anchor uuid;
  v_classic_handoff_at timestamptz;
  v_current_pending_retry_id uuid;
  v_existing_student_id uuid;
  v_existing_assistant_id uuid;
  v_existing_student_content text;
  v_existing_response jsonb;
  v_student_turn_id uuid;
  v_assistant_turn_id uuid;
  v_next_turn_index integer;
  v_correction jsonb;
  v_correction_feedback jsonb;
  v_requires_retry boolean;
  v_pending_retry_exists boolean := false;
  v_new_required_count integer := 0;
  v_inserted_corrections integer := 0;
  v_retry_updated integer := 0;
  v_canonical_stage text;
  v_canonical_status text;
  v_canonical_step integer;
  v_canonical_report jsonb;
  v_canonical_memory jsonb;
  v_canonical_response jsonb;
  v_commit_marker jsonb;
  v_report_generated_at timestamptz;
  v_accomplishments text[];
  v_experience_mode text;
  v_correction_mode text;
  v_language_mode text;
  v_difficulty text;
  v_scenario_context text;
  v_student_goal text;
  v_target_skill text;
  v_planned_duration integer;
  v_time_limit integer;
  v_config_snapshot jsonb;
begin
  if p_session_id is null
     or p_student_id is null
     or nullif(pg_catalog.btrim(p_tenant_id), '') is null
     or p_client_turn_id is null
     or p_expected_current_stage not in (
       'discovery', 'briefing', 'guided_build', 'practice', 'feedback',
       'retry', 'simulation', 'readaptation', 'improvisation',
       'assessment', 'report', 'completed'
     )
     or p_expected_scenario_status not in (
       'active', 'awaiting_retry', 'completed', 'abandoned', 'failed'
     )
     or p_student_stage not in (
       'discovery', 'briefing', 'guided_build', 'practice', 'feedback',
       'retry', 'simulation', 'readaptation', 'improvisation',
       'assessment', 'report', 'completed'
     )
     or p_next_stage not in (
       'discovery', 'briefing', 'guided_build', 'practice', 'feedback',
       'retry', 'simulation', 'readaptation', 'improvisation',
       'assessment', 'report', 'completed'
     )
     or p_next_scenario_status not in (
       'active', 'awaiting_retry', 'completed'
     )
     or p_next_scenario_step not between 1 and 12
     or p_expected_retry_count < 0
     or p_recorded_at is null
     or nullif(pg_catalog.btrim(p_student_content), '') is null
     or pg_catalog.octet_length(p_student_content) > 32000
     or nullif(pg_catalog.btrim(p_assistant_content), '') is null
     or pg_catalog.octet_length(p_assistant_content) > 32000
     or p_assistant_message_type not in (
       'question', 'correction', 'explanation', 'simulation', 'feedback',
       'instruction'
     )
     or (p_student_language_code is not null and p_student_language_code not in ('pt-BR', 'en-US', 'mixed'))
     or (p_assistant_language_code is not null and p_assistant_language_code not in ('pt-BR', 'en-US', 'mixed'))
     or (p_transcription_confidence is not null and (p_transcription_confidence < 0 or p_transcription_confidence > 1))
     or pg_catalog.jsonb_typeof(coalesce(p_expected_report, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_expected_memory, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_next_report, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_next_memory, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_student_payload, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_student_speech_metrics, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_response_payload, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_session_config, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_retry_feedback, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_new_corrections, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_new_corrections, '[]'::jsonb)) > 5
     or pg_catalog.octet_length(coalesce(p_expected_report, '{}'::jsonb)::text) > 250000
     or pg_catalog.octet_length(coalesce(p_expected_memory, '{}'::jsonb)::text) > 250000
     or pg_catalog.octet_length(coalesce(p_next_report, '{}'::jsonb)::text) > 250000
     or pg_catalog.octet_length(coalesce(p_next_memory, '{}'::jsonb)::text) > 250000
     or pg_catalog.octet_length(coalesce(p_response_payload, '{}'::jsonb)::text) > 250000
     or pg_catalog.octet_length(coalesce(p_new_corrections, '[]'::jsonb)::text) > 100000
     or nullif(pg_catalog.btrim(p_response_payload ->> 'chatResponse'), '') is null
     or p_response_payload ->> 'current_stage' is distinct from p_next_stage
     or p_response_payload ->> 'scenario_status' is distinct from p_next_scenario_status
     or (p_complete_retry_id is null and p_retry_score is not null)
     or (p_complete_retry_id is not null and p_complete_retry_id is distinct from p_expected_pending_retry_id)
     or (p_retry_score is not null and (p_retry_score < 0 or p_retry_score > 100)) then
    raise exception using
      errcode = '22023',
      message = 'invalid_classic_exchange_commit';
  end if;

  v_experience_mode := p_session_config ->> 'experience_mode';
  v_correction_mode := p_session_config ->> 'correction_mode';
  v_language_mode := p_session_config ->> 'language_mode';
  v_difficulty := p_session_config ->> 'difficulty';
  v_scenario_context := nullif(p_session_config ->> 'scenario_context', '');
  v_student_goal := nullif(p_session_config ->> 'student_goal', '');
  v_target_skill := nullif(p_session_config ->> 'target_skill', '');
  v_config_snapshot := p_session_config -> 'config_snapshot';
  begin
    v_planned_duration := nullif(p_session_config ->> 'planned_duration_minutes', '')::integer;
    v_time_limit := nullif(p_session_config ->> 'time_limit_seconds', '')::integer;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_classic_session_timing';
  end;
  if v_experience_mode not in (
       'free_conversation', 'guided_lesson', 'roleplay', 'presentation',
       'global_meeting', 'interview', 'exam', 'writing', 'pronunciation',
       'vocabulary', 'storytelling', 'child_mission', 'teen_challenge',
       'examiner', 'fluency', 'emergency'
     )
     or v_correction_mode not in ('immediate', 'end', 'selective', 'examiner')
     or v_language_mode not in ('pt_support', 'bilingual', 'immersive', 'english_rescue')
     or v_difficulty not in ('supportive', 'balanced', 'challenging', 'adaptive')
     or (v_planned_duration is not null and v_planned_duration not between 1 and 240)
     or (v_time_limit is not null and v_time_limit not between 10 and 86400)
     or pg_catalog.jsonb_typeof(coalesce(v_config_snapshot, '{}'::jsonb)) <> 'object'
     or pg_catalog.octet_length(coalesce(v_config_snapshot, '{}'::jsonb)::text) > 100000 then
    raise exception using errcode = '22023', message = 'invalid_classic_session_config';
  end if;

  select current_stage,
         scenario_status,
         coalesce(report_json, '{}'::jsonb),
         coalesce(memory_summary, '{}'::jsonb),
         greatest(0, coalesce(retry_count, 0)),
         finished_at,
         realtime_first_client_turn_id,
         classic_first_client_turn_id,
         classic_handoff_at
    into v_current_stage,
         v_current_status,
         v_current_report,
         v_current_memory,
         v_current_retry_count,
         v_current_finished_at,
         v_realtime_anchor,
         v_classic_anchor,
         v_classic_handoff_at
    from public.wolfie_sessions
   where id = p_session_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'wolfie_session_not_found';
  end if;
  if v_realtime_anchor is not null and v_classic_handoff_at is null then
    raise exception using errcode = '55000', message = 'wolfie_session_transport_mismatch';
  end if;

  select id, content
    into v_existing_student_id, v_existing_student_content
    from public.wolfie_turns
   where session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'student'
     and source_kind = 'classic';
  select id, coalesce(structured_payload -> 'classicResponse', structured_payload)
    into v_existing_assistant_id, v_existing_response
    from public.wolfie_turns
   where session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'wolfie'
     and source_kind = 'classic';
  if (v_existing_student_id is null) <> (v_existing_assistant_id is null) then
    raise exception using errcode = '55000', message = 'classic_exchange_incomplete';
  end if;
  if v_existing_student_id is not null then
    if v_existing_student_content is distinct from pg_catalog.btrim(p_student_content) then
      raise exception using errcode = '22023', message = 'classic_client_turn_id_reused';
    end if;
    return pg_catalog.jsonb_build_object(
      'persisted', true,
      'idempotent', true,
      'studentTurnId', v_existing_student_id,
      'assistantTurnId', v_existing_assistant_id,
      'stage', coalesce(v_existing_response ->> 'current_stage', v_current_stage),
      'scenarioStatus', coalesce(v_existing_response ->> 'scenario_status', v_current_status),
      'retryCount', v_current_retry_count,
      'responsePayload', coalesce(v_existing_response, '{}'::jsonb)
    );
  end if;

  select id
    into v_current_pending_retry_id
    from public.wolfie_corrections
   where session_id = p_session_id
     and status = 'active'
     and requires_retry = true
     and retry_completed = false
   order by created_at desc, id desc
   limit 1
   for update;

  if v_current_finished_at is not null
     or v_current_stage = 'completed'
     or v_current_status in ('completed', 'abandoned', 'failed')
     or v_current_stage is distinct from p_expected_current_stage
     or v_current_status is distinct from p_expected_scenario_status
     or v_current_report <> coalesce(p_expected_report, '{}'::jsonb)
     or v_current_memory <> coalesce(p_expected_memory, '{}'::jsonb)
     or v_current_retry_count <> p_expected_retry_count then
    return pg_catalog.jsonb_build_object('persisted', false, 'reason', 'cas_mismatch');
  end if;
  if v_current_pending_retry_id is distinct from p_expected_pending_retry_id then
    return pg_catalog.jsonb_build_object(
      'persisted', false,
      'reason', 'retry_invariant_changed'
    );
  end if;

  select coalesce(max(turn_index), -1) + 1
    into v_next_turn_index
    from public.wolfie_turns
   where session_id = p_session_id;

  insert into public.wolfie_turns (
    session_id,
    speaker,
    content,
    turn_index,
    message_type,
    stage,
    structured_payload,
    requires_retry,
    language_code,
    speech_metrics,
    transcription_confidence,
    source_kind,
    client_turn_id
  ) values (
    p_session_id,
    'student',
    pg_catalog.btrim(p_student_content),
    v_next_turn_index,
    'instruction',
    p_student_stage,
    coalesce(p_student_payload, '{}'::jsonb),
    p_expected_pending_retry_id is not null,
    p_student_language_code,
    coalesce(p_student_speech_metrics, '{}'::jsonb),
    p_transcription_confidence,
    'classic',
    p_client_turn_id
  ) returning id into v_student_turn_id;
  v_next_turn_index := v_next_turn_index + 1;

  -- Retry completion is fenced by the exact pending id and points to the
  -- immutable learner evidence turn inserted above.
  if p_complete_retry_id is not null then
    update public.wolfie_corrections
       set retry_completed = true,
           retry_turn_id = v_student_turn_id,
           retry_score = p_retry_score,
           retry_feedback = coalesce(retry_feedback, '{}'::jsonb)
             || coalesce(p_retry_feedback, '{}'::jsonb),
           retry_completed_at = p_recorded_at
     where id = p_complete_retry_id
       and session_id = p_session_id
       and status = 'active'
       and requires_retry = true
       and retry_completed = false;
    get diagnostics v_retry_updated = row_count;
    if v_retry_updated <> 1 then
      raise exception using errcode = '40001', message = 'classic_retry_fenced';
    end if;
  end if;

  select exists (
    select 1
      from public.wolfie_corrections
     where session_id = p_session_id
       and status = 'active'
       and requires_retry = true
       and retry_completed = false
  ) into v_pending_retry_exists;

  for v_correction in
    select value
      from pg_catalog.jsonb_array_elements(
        coalesce(p_new_corrections, '[]'::jsonb)
      )
  loop
    if pg_catalog.jsonb_typeof(v_correction) <> 'object'
       or nullif(pg_catalog.btrim(v_correction ->> 'wrong_sentence'), '') is null
       or nullif(pg_catalog.btrim(v_correction ->> 'correct_sentence'), '') is null
       or nullif(pg_catalog.btrim(v_correction ->> 'explanation_pt'), '') is null
       or pg_catalog.octet_length(v_correction ->> 'wrong_sentence') > 8000
       or pg_catalog.octet_length(v_correction ->> 'correct_sentence') > 8000
       or pg_catalog.octet_length(coalesce(v_correction ->> 'natural_sentence', '')) > 8000
       or pg_catalog.octet_length(v_correction ->> 'explanation_pt') > 12000
       or coalesce(v_correction ->> 'priority', '') not in ('low', 'medium', 'high')
       or coalesce(v_correction ->> 'requires_retry', 'false') not in ('true', 'false') then
      raise exception using errcode = '22023', message = 'invalid_classic_correction';
    end if;
    v_correction_feedback := coalesce(v_correction -> 'retry_feedback', '{}'::jsonb);
    if pg_catalog.jsonb_typeof(v_correction_feedback) <> 'object'
       or pg_catalog.octet_length(v_correction_feedback::text) > 50000 then
      raise exception using errcode = '22023', message = 'invalid_classic_correction_feedback';
    end if;
    v_requires_retry := coalesce((v_correction ->> 'requires_retry')::boolean, false);
    if v_pending_retry_exists or v_new_required_count > 0 then
      v_requires_retry := false;
    end if;

    insert into public.wolfie_corrections (
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
      retry_feedback
    ) values (
      p_session_id,
      v_student_turn_id,
      pg_catalog.left(pg_catalog.btrim(v_correction ->> 'wrong_sentence'), 2000),
      pg_catalog.left(pg_catalog.btrim(v_correction ->> 'correct_sentence'), 2000),
      pg_catalog.left(pg_catalog.btrim(coalesce(v_correction ->> 'natural_sentence', '')), 2000),
      pg_catalog.left(pg_catalog.btrim(v_correction ->> 'explanation_pt'), 3000),
      pg_catalog.left(pg_catalog.btrim(coalesce(v_correction ->> 'error_type', 'general')), 80),
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(v_correction ->> 'skill_focus', '')), 80), ''),
      v_correction ->> 'priority',
      v_requires_retry,
      false,
      v_correction_feedback
    );
    v_inserted_corrections := v_inserted_corrections + 1;
    if v_requires_retry then
      v_new_required_count := 1;
      v_pending_retry_exists := true;
    end if;
  end loop;

  select exists (
    select 1
      from public.wolfie_corrections
     where session_id = p_session_id
       and status = 'active'
       and requires_retry = true
       and retry_completed = false
  ) into v_pending_retry_exists;

  if not v_pending_retry_exists
     and (p_next_stage = 'retry' or p_next_scenario_status = 'awaiting_retry') then
    raise exception using
      errcode = '40001',
      message = 'classic_retry_invariant_changed';
  end if;

  v_canonical_stage := case when v_pending_retry_exists then 'retry' else p_next_stage end;
  v_canonical_status := case when v_pending_retry_exists then 'awaiting_retry' else p_next_scenario_status end;
  v_canonical_step := case when v_pending_retry_exists then 6 else p_next_scenario_step end;
  v_canonical_report := coalesce(p_next_report, '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
      'currentStage', v_canonical_stage,
      'scenarioStatus', v_canonical_status
    );
  v_canonical_memory := coalesce(p_next_memory, '{}'::jsonb)
    || pg_catalog.jsonb_build_object('currentStage', v_canonical_stage);
  v_canonical_response := coalesce(p_response_payload, '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
      'current_stage', v_canonical_stage,
      'scenario_status', v_canonical_status,
      'requires_retry', v_pending_retry_exists,
      'retry_completed',
        coalesce((p_response_payload ->> 'retry_completed')::boolean, false)
        and not v_pending_retry_exists
    );

  v_commit_marker := pg_catalog.jsonb_build_object(
    'version', 1,
    'status', 'completed',
    'source', 'classic_atomic_commit',
    'clientTurnId', p_client_turn_id,
    'studentTurnId', v_student_turn_id,
    'stage', v_canonical_stage,
    'scenarioStatus', v_canonical_status,
    'retryCount', v_current_retry_count + v_new_required_count,
    'correctionsCreated', v_inserted_corrections,
    'committedAt', p_recorded_at
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
    language_code,
    speech_metrics,
    source_kind,
    client_turn_id
  ) values (
    p_session_id,
    'wolfie',
    pg_catalog.btrim(p_assistant_content),
    v_next_turn_index,
    p_assistant_message_type,
    v_canonical_stage,
    v_canonical_response || pg_catalog.jsonb_build_object(
      'classicResponse', v_canonical_response,
      'classicCommit', v_commit_marker
    ),
    v_pending_retry_exists,
    p_assistant_language_code,
    '{}'::jsonb,
    'classic',
    p_client_turn_id
  ) returning id into v_assistant_turn_id;

  v_commit_marker := v_commit_marker
    || pg_catalog.jsonb_build_object('assistantTurnId', v_assistant_turn_id);
  update public.wolfie_turns
     set structured_payload = coalesce(structured_payload, '{}'::jsonb)
       || pg_catalog.jsonb_build_object('classicCommit', v_commit_marker)
   where id = v_student_turn_id;
  update public.wolfie_turns
     set structured_payload = coalesce(structured_payload, '{}'::jsonb)
       || pg_catalog.jsonb_build_object('classicCommit', v_commit_marker)
   where id = v_assistant_turn_id;

  update public.wolfie_sessions
     set experience_mode = v_experience_mode,
         correction_mode = v_correction_mode,
         language_mode = v_language_mode,
         difficulty = v_difficulty,
         scenario_context = v_scenario_context,
         student_goal = v_student_goal,
         target_skill = v_target_skill,
         planned_duration_minutes = v_planned_duration,
         time_limit_seconds = v_time_limit,
         current_stage = v_canonical_stage,
         scenario_status = v_canonical_status,
         scenario_step = v_canonical_step,
         retry_count = v_current_retry_count + v_new_required_count,
         needs_external_verification =
           coalesce(needs_external_verification, false)
           or coalesce(p_needs_external_verification, false),
         report_json = v_canonical_report,
         memory_summary = v_canonical_memory,
         config_snapshot = v_config_snapshot,
         classic_first_client_turn_id = coalesce(
           classic_first_client_turn_id,
           p_client_turn_id
         ),
         turn_count = greatest(0, coalesce(turn_count, 0)) + 1,
         student_word_count = greatest(0, coalesce(student_word_count, 0))
           + cardinality(pg_catalog.regexp_split_to_array(pg_catalog.btrim(p_student_content), '\s+')),
         wolfie_word_count = greatest(0, coalesce(wolfie_word_count, 0))
           + cardinality(pg_catalog.regexp_split_to_array(pg_catalog.btrim(p_assistant_content), '\s+')),
         last_activity_at = p_recorded_at,
         updated_at = p_recorded_at,
         finished_at = case
           when v_canonical_status = 'completed' then p_recorded_at
           else null
         end
   where id = p_session_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id;

  if p_session_report is not null then
    if pg_catalog.jsonb_typeof(p_session_report) <> 'object'
       or pg_catalog.octet_length(p_session_report::text) > 250000
       or p_session_report ->> 'tenant_id' is distinct from p_tenant_id
       or p_session_report ->> 'student_id' is distinct from p_student_id::text
       or p_session_report ->> 'conversation_session_id' is distinct from p_session_id::text
       or nullif(pg_catalog.btrim(p_session_report ->> 'topic'), '') is null
       or pg_catalog.jsonb_typeof(p_session_report -> 'accomplishments') <> 'array'
       or pg_catalog.jsonb_array_length(p_session_report -> 'accomplishments') > 20
       or pg_catalog.jsonb_typeof(p_session_report -> 'primary_corrections') <> 'array'
       or pg_catalog.jsonb_array_length(p_session_report -> 'primary_corrections') > 20
       or pg_catalog.jsonb_typeof(p_session_report -> 'new_vocabulary') <> 'array'
       or pg_catalog.jsonb_array_length(p_session_report -> 'new_vocabulary') > 30
       or pg_catalog.jsonb_typeof(p_session_report -> 'rubric_scores') <> 'object' then
      raise exception using errcode = '22023', message = 'invalid_classic_session_report';
    end if;
    begin
      v_report_generated_at := nullif(
        pg_catalog.btrim(p_session_report ->> 'generated_at'),
        ''
      )::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_classic_report_timestamp';
    end;
    if v_report_generated_at is null then
      raise exception using errcode = '22023', message = 'invalid_classic_report_timestamp';
    end if;
    select coalesce(
             pg_catalog.array_agg(
               pg_catalog.left(item.value, 500)
               order by item.ordinality
             ),
             '{}'::text[]
           )
      into v_accomplishments
      from pg_catalog.jsonb_array_elements_text(
        p_session_report -> 'accomplishments'
      ) with ordinality as item(value, ordinality);

    insert into public.wolfie_session_reports as existing_report (
      tenant_id,
      student_id,
      conversation_session_id,
      activity_session_id,
      topic,
      objective,
      difficulty,
      accomplishments,
      primary_corrections,
      new_vocabulary,
      recurring_error,
      best_phrase,
      review_point,
      next_step,
      practice_mission,
      rubric_scores,
      generated_by_model,
      generated_at
    ) values (
      p_tenant_id,
      p_student_id,
      p_session_id,
      null,
      pg_catalog.left(pg_catalog.btrim(p_session_report ->> 'topic'), 1000),
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'objective', '')), 4000), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'difficulty', '')), 100), ''),
      v_accomplishments,
      p_session_report -> 'primary_corrections',
      p_session_report -> 'new_vocabulary',
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'recurring_error', '')), 4000), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'best_phrase', '')), 4000), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'review_point', '')), 4000), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'next_step', '')), 4000), ''),
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'practice_mission', '')), 4000), ''),
      p_session_report -> 'rubric_scores',
      nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'generated_by_model', '')), 200), ''),
      v_report_generated_at
    )
    on conflict (conversation_session_id)
      where conversation_session_id is not null
    do update set
      tenant_id = excluded.tenant_id,
      student_id = excluded.student_id,
      topic = excluded.topic,
      objective = excluded.objective,
      difficulty = excluded.difficulty,
      accomplishments = excluded.accomplishments,
      primary_corrections = excluded.primary_corrections,
      new_vocabulary = excluded.new_vocabulary,
      recurring_error = excluded.recurring_error,
      best_phrase = excluded.best_phrase,
      review_point = excluded.review_point,
      next_step = excluded.next_step,
      practice_mission = excluded.practice_mission,
      rubric_scores = excluded.rubric_scores,
      generated_by_model = excluded.generated_by_model,
      generated_at = excluded.generated_at
    where existing_report.student_id = p_student_id
      and existing_report.tenant_id = p_tenant_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'persisted', true,
    'idempotent', false,
    'studentTurnId', v_student_turn_id,
    'assistantTurnId', v_assistant_turn_id,
    'stage', v_canonical_stage,
    'scenarioStatus', v_canonical_status,
    'retryCount', v_current_retry_count + v_new_required_count,
    'correctionsCreated', v_inserted_corrections,
    'responsePayload', v_canonical_response,
    'marker', v_commit_marker
  );
end;
$function$;

revoke all on function public.commit_wolfie_classic_exchange(
  uuid, uuid, text, uuid, text, text, jsonb, jsonb, integer, uuid,
  text, text, jsonb, text, jsonb, numeric, text, text, text, jsonb,
  text, text, integer, boolean, jsonb, jsonb, jsonb, timestamptz,
  uuid, numeric, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_wolfie_classic_exchange(
  uuid, uuid, text, uuid, text, text, jsonb, jsonb, integer, uuid,
  text, text, jsonb, text, jsonb, numeric, text, text, text, jsonb,
  text, text, integer, boolean, jsonb, jsonb, jsonb, timestamptz,
  uuid, numeric, jsonb, jsonb, jsonb
) to service_role;

comment on function public.commit_wolfie_classic_exchange(
  uuid, uuid, text, uuid, text, text, jsonb, jsonb, integer, uuid,
  text, text, jsonb, text, jsonb, numeric, text, text, text, jsonb,
  text, text, integer, boolean, jsonb, jsonb, jsonb, timestamptz,
  uuid, numeric, jsonb, jsonb, jsonb
) is
  'Exact-snapshot, idempotent transaction for one complete classic Wolfie exchange.';
