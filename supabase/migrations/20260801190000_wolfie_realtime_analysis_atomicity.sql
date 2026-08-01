-- Make Realtime transcript admission and post-turn analysis atomic at the
-- database boundary. Edge Functions use only these service-role RPCs for
-- claims/CAS; JSONB values are compared inside Postgres, never in URL filters.

alter table public.wolfie_sessions
  add column if not exists classic_handoff_at timestamptz;

comment on column public.wolfie_sessions.classic_handoff_at is
  'Server-authorized boundary after which this Realtime session continues through the classic transport without losing history or retry state.';

create or replace function public.guard_wolfie_session_turn_transport()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  opposite_transport_exists boolean;
begin
  -- One session has one writer protocol. This session lock makes the first
  -- classic/Realtime turn the transport election and prevents a fallback or
  -- second tab from bypassing either protocol's transaction invariants.
  perform 1
    from public.wolfie_sessions
   where id = new.session_id
   for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'wolfie_session_not_found';
  end if;

  select exists (
    select 1
      from public.wolfie_turns
     where session_id = new.session_id
       and source_kind <> new.source_kind
  ) into opposite_transport_exists;
  if opposite_transport_exists then
    raise exception using
      errcode = '55000',
      message = 'wolfie_session_transport_mismatch';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_wolfie_session_turn_transport
  on public.wolfie_turns;
drop trigger if exists trg_00_guard_wolfie_session_turn_transport
  on public.wolfie_turns;
-- PostgreSQL orders same-kind triggers by name. This lock trigger must run
-- before the lighter terminal guard so concurrent inserts never both acquire
-- a share lock and then deadlock while upgrading it.
create trigger trg_00_guard_wolfie_session_turn_transport
before insert on public.wolfie_turns
for each row
execute function public.guard_wolfie_session_turn_transport();

revoke all on function public.guard_wolfie_session_turn_transport()
  from public, anon, authenticated;

create or replace function public.guard_open_wolfie_realtime_turn_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  session_stage text;
  session_status text;
  session_finished_at timestamptz;
  session_classic_handoff_at timestamptz;
begin
  if new.source_kind is distinct from 'openai_realtime' then
    return new;
  end if;

  select current_stage, scenario_status, finished_at, classic_handoff_at
    into session_stage, session_status, session_finished_at,
         session_classic_handoff_at
    from public.wolfie_sessions
   where id = new.session_id
   for share;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'wolfie_session_not_found';
  end if;
  if session_finished_at is not null
     or session_stage = 'completed'
     or session_status in ('completed', 'abandoned', 'failed') then
    raise exception using
      errcode = '55000',
      message = 'wolfie_realtime_session_finished';
  end if;
  if session_classic_handoff_at is not null then
    raise exception using
      errcode = '55000',
      message = 'wolfie_realtime_session_handed_off';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_open_wolfie_realtime_turn_insert
  on public.wolfie_turns;
create trigger trg_guard_open_wolfie_realtime_turn_insert
before insert on public.wolfie_turns
for each row
execute function public.guard_open_wolfie_realtime_turn_insert();

revoke all on function public.guard_open_wolfie_realtime_turn_insert()
  from public, anon, authenticated;

create or replace function public.claim_wolfie_realtime_analysis(
  p_session_id uuid,
  p_assistant_turn_id uuid,
  p_client_turn_id uuid,
  p_claim_token uuid,
  p_resume_confirmed boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_payload jsonb;
  current_marker jsonb;
  claim_marker jsonb;
  marker_status text;
  prior_claimed_at timestamptz;
  claimed_at timestamptz := clock_timestamp();
  session_stage text;
  session_status text;
  session_finished_at timestamptz;
  session_classic_handoff_at timestamptz;
begin
  if p_session_id is null
     or p_assistant_turn_id is null
     or p_client_turn_id is null
     or p_claim_token is null then
    raise exception using errcode = '22023', message = 'invalid_realtime_claim';
  end if;

  select current_stage, scenario_status, finished_at, classic_handoff_at
    into session_stage, session_status, session_finished_at,
         session_classic_handoff_at
    from public.wolfie_sessions
   where id = p_session_id
   for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'wolfie_session_not_found';
  end if;
  if session_finished_at is not null
     or session_stage = 'completed'
     or session_status in ('completed', 'abandoned', 'failed') then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'marker', pg_catalog.jsonb_build_object(
        'version', 1,
        'status', 'unavailable',
        'reason', 'session_finished',
        'currentStage', session_stage,
        'scenarioStatus', session_status
      )
    );
  end if;
  if session_classic_handoff_at is not null then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'marker', pg_catalog.jsonb_build_object(
        'version', 1,
        'status', 'unavailable',
        'reason', 'classic_handoff',
        'classicHandoffAt', session_classic_handoff_at
      )
    );
  end if;

  select coalesce(structured_payload, '{}'::jsonb)
    into current_payload
    from public.wolfie_turns
   where id = p_assistant_turn_id
     and session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'wolfie'
     and source_kind = 'openai_realtime'
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'realtime_turn_not_found';
  end if;

  current_marker := current_payload -> 'realtimeAnalysis';
  marker_status := coalesce(current_marker ->> 'status', '');
  if marker_status in ('completed', 'unavailable')
     or (marker_status = 'awaiting_confirmation' and not p_resume_confirmed) then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'marker', current_marker
    );
  end if;

  if marker_status = 'processing' then
    begin
      prior_claimed_at := nullif(current_marker ->> 'claimedAt', '')::timestamptz;
    exception when others then
      prior_claimed_at := null;
    end;
    if prior_claimed_at is not null
       and claimed_at - prior_claimed_at < interval '2 minutes' then
      return pg_catalog.jsonb_build_object(
        'claimed', false,
        'marker', current_marker
      );
    end if;
  end if;

  claim_marker := pg_catalog.jsonb_build_object(
    'version', 1,
    'status', 'processing',
    'source', 'server_post_turn',
    'configurationSource', 'persisted_session',
    'clientTurnId', p_client_turn_id,
    'assistantTurnId', p_assistant_turn_id,
    'claimToken', p_claim_token,
    'claimedAt', claimed_at,
    'resumedAfterConfirmation',
      marker_status = 'awaiting_confirmation' and p_resume_confirmed
  );

  update public.wolfie_turns
     set structured_payload = current_payload || pg_catalog.jsonb_build_object(
       'eligibleForCorrection', false,
       'realtimeAnalysis', claim_marker
     )
   where id = p_assistant_turn_id;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'marker', claim_marker
  );
end;
$function$;

revoke all on function public.claim_wolfie_realtime_analysis(
  uuid, uuid, uuid, uuid, boolean
) from public, anon, authenticated;
grant execute on function public.claim_wolfie_realtime_analysis(
  uuid, uuid, uuid, uuid, boolean
) to service_role;

create or replace function public.finalize_wolfie_realtime_analysis(
  p_session_id uuid,
  p_student_turn_id uuid,
  p_assistant_turn_id uuid,
  p_client_turn_id uuid,
  p_claim_token uuid,
  p_marker jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  assistant_payload jsonb;
  student_payload jsonb;
  current_marker jsonb;
  marker_status text;
  next_fields jsonb;
begin
  if p_session_id is null
     or p_student_turn_id is null
     or p_assistant_turn_id is null
     or p_client_turn_id is null
     or p_claim_token is null
     or p_marker is null
     or pg_catalog.jsonb_typeof(p_marker) <> 'object'
     or pg_catalog.octet_length(p_marker::text) > 100000
     or coalesce(p_marker ->> 'status', '') not in (
       'completed', 'retryable', 'unavailable', 'awaiting_confirmation'
     )
     or p_marker ->> 'clientTurnId' is distinct from p_client_turn_id::text
     or p_marker ->> 'studentTurnId' is distinct from p_student_turn_id::text
     or p_marker ->> 'assistantTurnId' is distinct from p_assistant_turn_id::text
     or coalesce(p_marker ->> 'version', '') <> '1' then
    raise exception using errcode = '22023', message = 'invalid_realtime_marker';
  end if;

  select coalesce(structured_payload, '{}'::jsonb)
    into assistant_payload
    from public.wolfie_turns
   where id = p_assistant_turn_id
     and session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'wolfie'
     and source_kind = 'openai_realtime'
   for update;
  if not found then
    return false;
  end if;
  current_marker := assistant_payload -> 'realtimeAnalysis';
  marker_status := coalesce(current_marker ->> 'status', '');
  if marker_status in ('completed', 'unavailable', 'awaiting_confirmation') then
    return current_marker ->> 'studentTurnId' = p_student_turn_id::text
      and current_marker ->> 'assistantTurnId' = p_assistant_turn_id::text
      and current_marker ->> 'clientTurnId' = p_client_turn_id::text;
  end if;
  if marker_status <> 'processing'
     or current_marker ->> 'claimToken' <> p_claim_token::text then
    return false;
  end if;

  select coalesce(structured_payload, '{}'::jsonb)
    into student_payload
    from public.wolfie_turns
   where id = p_student_turn_id
     and session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'student'
     and source_kind = 'openai_realtime'
   for update;
  if not found then
    return false;
  end if;

  next_fields := pg_catalog.jsonb_build_object(
    'eligibleForCorrection', p_marker ->> 'status' = 'completed',
    'realtimeAnalysis', p_marker
  );
  if p_marker ? 'learnerIntent' then
    next_fields := next_fields || pg_catalog.jsonb_build_object(
      'learnerIntent', p_marker -> 'learnerIntent'
    );
  end if;

  update public.wolfie_turns
     set structured_payload = student_payload || next_fields
   where id = p_student_turn_id;
  update public.wolfie_turns
     set structured_payload = assistant_payload || next_fields
   where id = p_assistant_turn_id;
  return true;
end;
$function$;

revoke all on function public.finalize_wolfie_realtime_analysis(
  uuid, uuid, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_wolfie_realtime_analysis(
  uuid, uuid, uuid, uuid, uuid, jsonb
) to service_role;

-- Earlier local drafts had the same RPC without the retry/correction fencing
-- arguments. Remove those signatures so PostgREST cannot resolve an unsafe
-- overload in a development database.
-- Remove that signature so PostgREST can never see ambiguous overloads when a
-- development database reapplies this not-yet-released migration.
drop function if exists public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz
);
drop function if exists public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz,
  uuid, uuid, numeric, jsonb
);
drop function if exists public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz,
  uuid, uuid, uuid, uuid, uuid, numeric, jsonb, uuid, jsonb
);
drop function if exists public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz,
  uuid, uuid, uuid, uuid, jsonb, jsonb,
  uuid, uuid, numeric, jsonb, uuid, jsonb
);
drop function if exists public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz,
  uuid, uuid, uuid, uuid, jsonb, jsonb,
  uuid, uuid, uuid, numeric, jsonb, uuid, jsonb
);

create or replace function public.cas_wolfie_realtime_session_analysis(
  p_session_id uuid,
  p_student_id uuid,
  p_tenant_id text,
  p_expected_report jsonb,
  p_expected_memory jsonb,
  p_next_report jsonb,
  p_next_memory jsonb,
  p_next_stage text,
  p_next_scenario_status text,
  p_next_scenario_step integer,
  p_next_retry_count integer,
  p_needs_external_verification boolean,
  p_recorded_at timestamptz,
  p_assistant_turn_id uuid,
  p_student_turn_id uuid,
  p_client_turn_id uuid,
  p_claim_token uuid,
  p_completion_marker jsonb,
  p_session_report jsonb,
  p_expected_current_stage text,
  p_expected_scenario_status text,
  p_expected_pending_retry_id uuid,
  p_complete_retry_id uuid default null,
  p_retry_turn_id uuid default null,
  p_retry_score numeric default null,
  p_retry_feedback jsonb default '{}'::jsonb,
  p_correction_turn_id uuid default null,
  p_new_corrections jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_current_report jsonb;
  v_current_memory jsonb;
  v_current_stage text;
  v_current_status text;
  v_current_finished_at timestamptz;
  v_current_retry_count integer;
  v_current_pending_retry_id uuid;
  v_assistant_payload jsonb;
  v_student_payload jsonb;
  v_analysis_marker jsonb;
  v_final_marker jsonb;
  v_final_guidance jsonb;
  v_next_turn_fields jsonb;
  v_correction jsonb;
  v_correction_feedback jsonb;
  v_requires_retry boolean;
  v_pending_retry_exists boolean := false;
  v_pending_retry_context jsonb := '{}'::jsonb;
  v_retry_next_action text;
  v_new_required_count integer := 0;
  v_inserted_count integer := 0;
  v_canonical_stage text;
  v_canonical_status text;
  v_canonical_step integer;
  v_canonical_report jsonb;
  v_canonical_memory jsonb;
  v_last_index integer;
  v_report_generated_at timestamptz;
  v_accomplishments text[];
  v_marker_correction_count integer;
  updated_count integer;
  retry_updated_count integer;
  retry_already_completed boolean := false;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_expected_report, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_expected_memory, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_next_report, '{}'::jsonb)) <> 'object'
     or pg_catalog.jsonb_typeof(coalesce(p_next_memory, '{}'::jsonb)) <> 'object'
     or p_next_stage not in (
       'discovery', 'briefing', 'guided_build', 'practice', 'feedback',
       'retry', 'simulation', 'readaptation', 'improvisation',
       'assessment', 'report', 'completed'
     )
     or p_next_scenario_status not in (
       'active', 'awaiting_retry', 'completed', 'abandoned', 'failed'
     )
     or p_next_scenario_step < 1
     or p_next_retry_count < 0
     or p_recorded_at is null
     or p_assistant_turn_id is null
     or p_student_turn_id is null
     or p_client_turn_id is null
     or p_claim_token is null
     or p_completion_marker is null
     or pg_catalog.jsonb_typeof(p_completion_marker) <> 'object'
     or pg_catalog.octet_length(p_completion_marker::text) > 100000
     or p_completion_marker ->> 'status' <> 'completed'
     or p_completion_marker ->> 'clientTurnId' is distinct from p_client_turn_id::text
     or p_completion_marker ->> 'studentTurnId' is distinct from p_student_turn_id::text
     or p_completion_marker ->> 'assistantTurnId' is distinct from p_assistant_turn_id::text
     or coalesce(p_completion_marker ->> 'version', '') <> '1'
     or coalesce(p_completion_marker ->> 'correctionsCreated', '0') !~ '^[0-9]+$'
     or p_session_report is null
     or pg_catalog.jsonb_typeof(p_session_report) <> 'object'
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
     or pg_catalog.jsonb_typeof(p_session_report -> 'rubric_scores') <> 'object'
     or p_expected_current_stage not in (
       'discovery', 'briefing', 'guided_build', 'practice', 'feedback',
       'retry', 'simulation', 'readaptation', 'improvisation',
       'assessment', 'report', 'completed'
     )
     or p_expected_scenario_status not in (
       'active', 'awaiting_retry', 'completed', 'abandoned', 'failed'
     )
     or (p_complete_retry_id is null) <> (p_retry_turn_id is null)
     or (p_retry_turn_id is not null and p_retry_turn_id <> p_student_turn_id)
     or pg_catalog.jsonb_typeof(coalesce(p_retry_feedback, '{}'::jsonb)) <> 'object'
     or pg_catalog.octet_length(coalesce(p_retry_feedback, '{}'::jsonb)::text) > 50000
     or (p_retry_score is not null and (p_retry_score < 0 or p_retry_score > 100))
     or pg_catalog.jsonb_typeof(coalesce(p_new_corrections, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_new_corrections, '[]'::jsonb)) > 5
     or pg_catalog.octet_length(coalesce(p_new_corrections, '[]'::jsonb)::text) > 100000
     or (
       pg_catalog.jsonb_array_length(coalesce(p_new_corrections, '[]'::jsonb)) > 0
       and p_correction_turn_id is distinct from p_student_turn_id
     ) then
    raise exception using errcode = '22023', message = 'invalid_realtime_state_cas';
  end if;

  begin
    v_report_generated_at := nullif(
      pg_catalog.btrim(p_session_report ->> 'generated_at'),
      ''
    )::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_realtime_report_timestamp';
  end;
  if v_report_generated_at is null then
    raise exception using errcode = '22023', message = 'invalid_realtime_report_timestamp';
  end if;
  v_marker_correction_count := pg_catalog.greatest(
    0,
    (p_completion_marker ->> 'correctionsCreated')::integer
  );

  select coalesce(report_json, '{}'::jsonb),
         coalesce(memory_summary, '{}'::jsonb),
         wolfie_sessions.current_stage,
         scenario_status,
         finished_at,
         retry_count
    into v_current_report,
         v_current_memory,
         v_current_stage,
         v_current_status,
         v_current_finished_at,
         v_current_retry_count
    from public.wolfie_sessions
   where id = p_session_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id
   for update;

  if not found
     or v_current_finished_at is not null
     or v_current_stage = 'completed'
     or v_current_status in ('completed', 'abandoned', 'failed')
     or v_current_stage is distinct from p_expected_current_stage
     or v_current_status is distinct from p_expected_scenario_status
     or v_current_report <> coalesce(p_expected_report, '{}'::jsonb)
     or v_current_memory <> coalesce(p_expected_memory, '{}'::jsonb) then
    return pg_catalog.jsonb_build_object('persisted', false, 'reason', 'cas_mismatch');
  end if;

  -- Fence every side effect with the live database claim. A worker that was
  -- paused for two minutes cannot resume after another worker reclaimed and
  -- finalized the same assistant turn.
  select coalesce(structured_payload, '{}'::jsonb)
    into v_assistant_payload
    from public.wolfie_turns
   where id = p_assistant_turn_id
     and session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'wolfie'
     and source_kind = 'openai_realtime'
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('persisted', false, 'reason', 'claim_turn_missing');
  end if;
  v_analysis_marker := v_assistant_payload -> 'realtimeAnalysis';
  if coalesce(v_analysis_marker ->> 'status', '') <> 'processing'
     or v_analysis_marker ->> 'claimToken' <> p_claim_token::text then
    return pg_catalog.jsonb_build_object('persisted', false, 'reason', 'claim_fenced');
  end if;

  select coalesce(structured_payload, '{}'::jsonb)
    into v_student_payload
    from public.wolfie_turns
   where id = p_student_turn_id
     and session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'student'
     and source_kind = 'openai_realtime'
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('persisted', false, 'reason', 'student_turn_missing');
  end if;

  if pg_catalog.jsonb_array_length(coalesce(p_new_corrections, '[]'::jsonb)) > 0
     and p_correction_turn_id is distinct from p_student_turn_id then
    raise exception using errcode = '22023', message = 'invalid_realtime_correction_turn';
  end if;

  -- The evaluator's pending-retry premise is part of the compare-and-swap.
  -- If another writer created, completed or replaced that correction while
  -- the provider was evaluating, no part of this stale analysis may commit.
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
  if v_current_pending_retry_id is distinct from p_expected_pending_retry_id then
    return pg_catalog.jsonb_build_object(
      'persisted', false,
      'reason', 'retry_invariant_changed'
    );
  end if;

  if p_complete_retry_id is not null then
    update public.wolfie_corrections
       set retry_completed = true,
           retry_turn_id = p_retry_turn_id,
           retry_score = p_retry_score,
           retry_feedback = coalesce(retry_feedback, '{}'::jsonb)
             || coalesce(p_retry_feedback, '{}'::jsonb),
           retry_completed_at = coalesce(retry_completed_at, p_recorded_at)
     where id = p_complete_retry_id
       and session_id = p_session_id
       and status = 'active'
       and requires_retry = true
       and retry_completed = false;
    get diagnostics retry_updated_count = row_count;

    if retry_updated_count <> 1 then
      select exists (
        select 1
          from public.wolfie_corrections
         where id = p_complete_retry_id
           and session_id = p_session_id
           and status = 'active'
           and requires_retry = true
           and retry_completed = true
           and retry_turn_id = p_retry_turn_id
      ) into retry_already_completed;
      if not retry_already_completed then
        return pg_catalog.jsonb_build_object('persisted', false, 'reason', 'retry_fenced');
      end if;
    end if;
  end if;

  select pg_catalog.jsonb_build_object(
           'original', wrong_sentence,
           'corrected', correct_sentence,
           'naturalVersion', natural_sentence,
           'category', error_type,
           'priority', priority
         )
    into v_pending_retry_context
    from public.wolfie_corrections
   where session_id = p_session_id
     and status = 'active'
     and requires_retry = true
     and retry_completed = false
   order by created_at desc, id desc
   limit 1
   for update;
  v_pending_retry_exists := found;
  if not v_pending_retry_exists then
    v_pending_retry_context := '{}'::jsonb;
  end if;

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
       or pg_catalog.octet_length(v_correction ->> 'explanation_pt') > 8000
       or coalesce(v_correction ->> 'priority', '') not in ('low', 'medium', 'high')
       or coalesce(v_correction ->> 'requires_retry', 'false') not in ('true', 'false') then
      raise exception using errcode = '22023', message = 'invalid_realtime_correction';
    end if;
    v_correction_feedback := coalesce(
      v_correction -> 'retry_feedback',
      '{}'::jsonb
    );
    if pg_catalog.jsonb_typeof(v_correction_feedback) <> 'object'
       or pg_catalog.octet_length(v_correction_feedback::text) > 50000 then
      raise exception using errcode = '22023', message = 'invalid_realtime_correction_feedback';
    end if;
    v_requires_retry := coalesce(
      (v_correction ->> 'requires_retry')::boolean,
      false
    );
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
      p_correction_turn_id,
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
    v_inserted_count := v_inserted_count + 1;
    if v_requires_retry then
      v_new_required_count := 1;
      v_pending_retry_exists := true;
    end if;
  end loop;

  -- Re-read the invariant while the session is locked. A newer callback may
  -- never advance or finish a session while any canonical retry is open.
  select pg_catalog.jsonb_build_object(
           'original', wrong_sentence,
           'corrected', correct_sentence,
           'naturalVersion', natural_sentence,
           'category', error_type,
           'priority', priority
         )
    into v_pending_retry_context
    from public.wolfie_corrections
   where session_id = p_session_id
     and status = 'active'
     and requires_retry = true
     and retry_completed = false
   order by created_at desc, id desc
   limit 1
   for update;
  v_pending_retry_exists := found;
  if v_pending_retry_exists then
    v_retry_next_action := 'Retry the pending correction before advancing.';
    if nullif(pg_catalog.btrim(v_pending_retry_context ->> 'corrected'), '') is not null then
      v_retry_next_action := v_retry_next_action || ' ' || pg_catalog.left(
        pg_catalog.btrim(v_pending_retry_context ->> 'corrected'),
        1000
      );
    end if;
  else
    v_pending_retry_context := '{}'::jsonb;
  end if;

  -- The inverse invariant matters under retry races: an analyzer that saw a
  -- correction before another worker completed it must never leave the
  -- session awaiting a retry that no longer exists. Raising rolls back every
  -- optional correction/retry side effect and makes the turn re-analyzable.
  if not v_pending_retry_exists
     and (p_next_stage = 'retry' or p_next_scenario_status = 'awaiting_retry') then
    raise exception using
      errcode = '40001',
      message = 'realtime_retry_invariant_changed';
  end if;

  v_canonical_stage := case
    when v_pending_retry_exists then 'retry'
    else p_next_stage
  end;
  v_canonical_status := case
    when v_pending_retry_exists then 'awaiting_retry'
    else p_next_scenario_status
  end;
  v_canonical_step := case
    when v_pending_retry_exists then 6
    else p_next_scenario_step
  end;
  v_canonical_report := coalesce(p_next_report, '{}'::jsonb);
  v_canonical_memory := coalesce(p_next_memory, '{}'::jsonb);
  v_canonical_report := pg_catalog.jsonb_set(
    v_canonical_report,
    '{currentStage}',
    pg_catalog.to_jsonb(v_canonical_stage),
    true
  );
  v_canonical_report := pg_catalog.jsonb_set(
    v_canonical_report,
    '{scenarioStatus}',
    pg_catalog.to_jsonb(v_canonical_status),
    true
  );
  v_canonical_memory := pg_catalog.jsonb_set(
    v_canonical_memory,
    '{currentStage}',
    pg_catalog.to_jsonb(v_canonical_stage),
    true
  );
  if v_pending_retry_exists then
    v_canonical_report := v_canonical_report
      || pg_catalog.jsonb_build_object(
        'nextStep', v_retry_next_action,
        'pendingRetry', v_pending_retry_context
      );
    v_canonical_memory := v_canonical_memory
      || pg_catalog.jsonb_build_object(
        'recommendedNextStep', v_retry_next_action,
        'pendingRetry', v_pending_retry_context
      );
  end if;
  if pg_catalog.jsonb_typeof(v_canonical_report -> 'realtimeAnalyses') = 'array'
     and pg_catalog.jsonb_array_length(v_canonical_report -> 'realtimeAnalyses') > 0 then
    v_last_index := pg_catalog.jsonb_array_length(
      v_canonical_report -> 'realtimeAnalyses'
    ) - 1;
    v_canonical_report := pg_catalog.jsonb_set(
      v_canonical_report,
      array['realtimeAnalyses', v_last_index::text, 'stage'],
      pg_catalog.to_jsonb(v_canonical_stage),
      true
    );
    v_canonical_report := pg_catalog.jsonb_set(
      v_canonical_report,
      array['realtimeAnalyses', v_last_index::text, 'scenarioStatus'],
      pg_catalog.to_jsonb(v_canonical_status),
      true
    );
    v_canonical_report := pg_catalog.jsonb_set(
      v_canonical_report,
      array['realtimeAnalyses', v_last_index::text, 'requiresRetry'],
      pg_catalog.to_jsonb(v_pending_retry_exists),
      true
    );
    if v_pending_retry_exists then
      v_canonical_report := pg_catalog.jsonb_set(
        v_canonical_report,
        array['realtimeAnalyses', v_last_index::text, 'retryCompleted'],
        'false'::jsonb,
        true
      );
      v_canonical_report := pg_catalog.jsonb_set(
        v_canonical_report,
        array['realtimeAnalyses', v_last_index::text, 'nextAction'],
        pg_catalog.to_jsonb(v_retry_next_action),
        true
      );
      v_canonical_report := pg_catalog.jsonb_set(
        v_canonical_report,
        array['realtimeAnalyses', v_last_index::text, 'pendingRetry'],
        v_pending_retry_context,
        true
      );
    end if;
  end if;

  update public.wolfie_sessions
     set current_stage = v_canonical_stage,
         scenario_status = v_canonical_status,
         scenario_step = v_canonical_step,
         retry_count = case
           when pg_catalog.jsonb_array_length(
             coalesce(p_new_corrections, '[]'::jsonb)
           ) > 0 then v_current_retry_count + v_new_required_count
           else pg_catalog.greatest(
             v_current_retry_count + v_new_required_count,
             p_next_retry_count
           )
         end,
         needs_external_verification =
           coalesce(needs_external_verification, false)
           or coalesce(p_needs_external_verification, false),
         report_json = v_canonical_report,
         memory_summary = v_canonical_memory,
         last_activity_at = p_recorded_at,
         updated_at = p_recorded_at,
         finished_at = case
           when v_canonical_status = 'completed' then p_recorded_at
           else finished_at
         end
   where id = p_session_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id
     and finished_at is null
     and current_stage <> 'completed'
     and scenario_status not in ('completed', 'abandoned', 'failed');
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception using
      errcode = '40001',
      message = 'realtime_state_cas_lost_after_lock';
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

  -- The canonical JSON report, its materialized projection and both turn
  -- markers commit together. A crash can therefore never finish a session
  -- while leaving its report stale or its analysis marker in `processing`.
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
    case
      when v_pending_retry_exists then v_retry_next_action
      else nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'next_step', '')), 4000), '')
    end,
    case
      when v_pending_retry_exists then v_retry_next_action
      else nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_session_report ->> 'practice_mission', '')), 4000), '')
    end,
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
    and existing_report.tenant_id = p_tenant_id
    and existing_report.generated_at <= excluded.generated_at;

  v_final_guidance := coalesce(
    p_completion_marker -> 'realtimeGuidance',
    '{}'::jsonb
  );
  if pg_catalog.jsonb_typeof(v_final_guidance) = 'object' then
    v_final_guidance := v_final_guidance
      || pg_catalog.jsonb_build_object(
        'currentStage', v_canonical_stage,
        'scenarioStatus', v_canonical_status,
        'requiresRetry', v_pending_retry_exists
      );
    if v_pending_retry_exists then
      v_final_guidance := v_final_guidance
        || pg_catalog.jsonb_build_object(
          'nextAction', v_retry_next_action,
          'pendingRetry', v_pending_retry_context
        );
    end if;
  else
    v_final_guidance := '{}'::jsonb;
  end if;
  v_marker_correction_count := pg_catalog.greatest(
    v_marker_correction_count,
    v_inserted_count
  );
  v_final_marker := p_completion_marker
    || pg_catalog.jsonb_build_object(
      'currentStage', v_canonical_stage,
      'scenarioStatus', v_canonical_status,
      'correctionsCreated', v_marker_correction_count,
      'requiresRetry', v_pending_retry_exists,
      'persistence', pg_catalog.jsonb_build_object(
        'sessionState', true,
        'sessionReport', true,
        'turnMarkers', true
      ),
      'realtimeGuidance', v_final_guidance
    );
  if v_pending_retry_exists then
    v_final_marker := v_final_marker
      || pg_catalog.jsonb_build_object(
        'retryCompleted', false,
        'nextAction', v_retry_next_action,
        'pendingRetry', v_pending_retry_context
      );
  end if;
  v_next_turn_fields := pg_catalog.jsonb_build_object(
    'eligibleForCorrection', true,
    'learnerIntent', v_final_marker -> 'learnerIntent',
    'realtimeAnalysis', v_final_marker
  );

  update public.wolfie_turns
     set structured_payload = v_student_payload || v_next_turn_fields,
         message_type = case
           when v_marker_correction_count > 0 then 'correction'
           else 'feedback'
         end,
         requires_retry = v_pending_retry_exists
   where id = p_student_turn_id;
  update public.wolfie_turns
     set structured_payload = v_assistant_payload || v_next_turn_fields,
         message_type = case
           when v_marker_correction_count > 0 then 'correction'
           else 'feedback'
         end,
         stage = v_canonical_stage,
         requires_retry = v_pending_retry_exists
   where id = p_assistant_turn_id;

  return pg_catalog.jsonb_build_object(
    'persisted', true,
    'stage', v_canonical_stage,
    'scenarioStatus', v_canonical_status,
    'correctionsCreated', v_marker_correction_count,
    'requiredRetryCreated', v_new_required_count = 1,
    'marker', v_final_marker
  );
end;
$function$;

revoke all on function public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz,
  uuid, uuid, uuid, uuid, jsonb, jsonb,
  text, text, uuid, uuid, uuid, numeric, jsonb, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz,
  uuid, uuid, uuid, uuid, jsonb, jsonb,
  text, text, uuid, uuid, uuid, numeric, jsonb, uuid, jsonb
) to service_role;

create or replace function public.claim_wolfie_realtime_fact_confirmation(
  p_session_id uuid,
  p_student_turn_id uuid,
  p_client_turn_id uuid,
  p_claim_token uuid,
  p_confirmed_transcript text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_payload jsonb;
  current_content text;
  current_confirmation jsonb;
  confirmation_status text;
  current_transcript text;
  normalized_current text;
  normalized_requested text;
  prior_claimed_at timestamptz;
  claimed_at timestamptz := clock_timestamp();
  claim_marker jsonb;
begin
  if p_session_id is null
     or p_student_turn_id is null
     or p_client_turn_id is null
     or p_claim_token is null
     or nullif(pg_catalog.btrim(p_confirmed_transcript), '') is null
     or pg_catalog.octet_length(p_confirmed_transcript) > 32000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_realtime_fact_confirmation_claim';
  end if;

  normalized_requested := pg_catalog.lower(
    pg_catalog.regexp_replace(
      pg_catalog.btrim(p_confirmed_transcript),
      '\s+',
      ' ',
      'g'
    )
  );

  select pg_catalog.coalesce(structured_payload, '{}'::jsonb),
         pg_catalog.coalesce(content, '')
    into current_payload, current_content
    from public.wolfie_turns
   where id = p_student_turn_id
     and session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'student'
     and source_kind = 'openai_realtime'
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'realtime_turn_not_found';
  end if;

  current_confirmation := current_payload -> 'factualConfirmation';
  confirmation_status := pg_catalog.coalesce(
    current_confirmation ->> 'status',
    ''
  );
  current_transcript := pg_catalog.coalesce(
    current_confirmation ->> 'confirmedTranscript',
    ''
  );
  normalized_current := pg_catalog.lower(
    pg_catalog.regexp_replace(
      pg_catalog.btrim(current_transcript),
      '\s+',
      ' ',
      'g'
    )
  );

  if confirmation_status = 'confirmed' then
    if normalized_current is distinct from normalized_requested then
      return pg_catalog.jsonb_build_object(
        'claimed', false,
        'conflict', true,
        'status', 'confirmed'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'conflict', false,
      'idempotent', true,
      'status', 'confirmed',
      'confirmation', current_confirmation
    );
  end if;

  if confirmation_status in ('processing', 'retryable')
     and normalized_current is distinct from normalized_requested then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'conflict', true,
      'status', confirmation_status
    );
  end if;

  if confirmation_status = 'processing' then
    begin
      prior_claimed_at := nullif(
        current_confirmation ->> 'claimedAt',
        ''
      )::timestamptz;
    exception when others then
      prior_claimed_at := null;
    end;
    if prior_claimed_at is not null
       and claimed_at - prior_claimed_at < interval '2 minutes' then
      return pg_catalog.jsonb_build_object(
        'claimed', false,
        'conflict', false,
        'idempotent', false,
        'status', 'processing',
        'confirmation', current_confirmation
      );
    end if;
  end if;

  claim_marker := pg_catalog.jsonb_build_object(
    'version', 1,
    'status', 'processing',
    'clientTurnId', p_client_turn_id,
    'studentTurnId', p_student_turn_id,
    'claimToken', p_claim_token,
    'claimedAt', claimed_at,
    'confirmedTranscript', pg_catalog.btrim(p_confirmed_transcript),
    'originalRoughTranscript', current_content
  );

  update public.wolfie_turns
     set structured_payload = current_payload || pg_catalog.jsonb_build_object(
       'factualConfirmation', claim_marker
     )
   where id = p_student_turn_id;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'conflict', false,
    'idempotent', false,
    'status', 'processing',
    'confirmation', claim_marker
  );
end;
$function$;

revoke all on function public.claim_wolfie_realtime_fact_confirmation(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.claim_wolfie_realtime_fact_confirmation(
  uuid, uuid, uuid, uuid, text
) to service_role;

create or replace function public.finalize_wolfie_realtime_fact_confirmation(
  p_session_id uuid,
  p_student_turn_id uuid,
  p_client_turn_id uuid,
  p_claim_token uuid,
  p_confirmation jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_payload jsonb;
  current_confirmation jsonb;
  current_status text;
  current_transcript text;
  requested_transcript text;
  requested_status text;
begin
  requested_status := pg_catalog.coalesce(p_confirmation ->> 'status', '');
  if p_session_id is null
     or p_student_turn_id is null
     or p_client_turn_id is null
     or p_claim_token is null
     or p_confirmation is null
     or pg_catalog.jsonb_typeof(p_confirmation) <> 'object'
     or pg_catalog.octet_length(p_confirmation::text) > 100000
     or requested_status not in ('confirmed', 'retryable')
     or p_confirmation ->> 'clientTurnId' is distinct from p_client_turn_id::text
     or p_confirmation ->> 'studentTurnId' is distinct from p_student_turn_id::text
     or p_confirmation ->> 'claimToken' is distinct from p_claim_token::text
     or pg_catalog.coalesce(p_confirmation ->> 'version', '') <> '1'
     or nullif(p_confirmation ->> 'confirmedTranscript', '') is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_realtime_fact_confirmation';
  end if;

  select pg_catalog.coalesce(structured_payload, '{}'::jsonb)
    into current_payload
    from public.wolfie_turns
   where id = p_student_turn_id
     and session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'student'
     and source_kind = 'openai_realtime'
   for update;
  if not found then
    return false;
  end if;

  current_confirmation := current_payload -> 'factualConfirmation';
  current_status := pg_catalog.coalesce(current_confirmation ->> 'status', '');
  current_transcript := pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.btrim(pg_catalog.coalesce(
      current_confirmation ->> 'confirmedTranscript',
      ''
    )),
    '\s+',
    ' ',
    'g'
  ));
  requested_transcript := pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.btrim(p_confirmation ->> 'confirmedTranscript'),
    '\s+',
    ' ',
    'g'
  ));

  if current_status = 'confirmed' then
    -- Never downgrade a confirmation when a release request races with a
    -- successful commit whose response was lost.
    return current_transcript = requested_transcript;
  end if;
  if current_status = 'retryable' then
    return requested_status = 'retryable'
      and current_confirmation ->> 'claimToken' = p_claim_token::text
      and current_transcript = requested_transcript;
  end if;
  if current_status <> 'processing'
     or current_confirmation ->> 'claimToken' <> p_claim_token::text
     or current_transcript <> requested_transcript then
    return false;
  end if;

  -- Merge against the locked, current payload. In particular, never replace a
  -- completed realtimeAnalysis marker with the snapshot read before facts ran.
  if requested_status = 'confirmed' then
    update public.wolfie_turns
       set content = p_confirmation ->> 'confirmedTranscript',
           structured_payload = current_payload || pg_catalog.jsonb_build_object(
             'factsConfirmedByLearner', true,
             'factualConfirmation', p_confirmation
           )
     where id = p_student_turn_id;
  else
    -- A failed fact write releases the fresh claim immediately. The same
    -- transcript can be claimed again without waiting for stale-lease expiry.
    update public.wolfie_turns
       set structured_payload = current_payload || pg_catalog.jsonb_build_object(
         'factualConfirmation', p_confirmation
       )
     where id = p_student_turn_id;
  end if;
  return true;
end;
$function$;

revoke all on function public.finalize_wolfie_realtime_fact_confirmation(
  uuid, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_wolfie_realtime_fact_confirmation(
  uuid, uuid, uuid, uuid, jsonb
) to service_role;

-- A retry of the same persisted learner turn is evidence recovery, not a new
-- occurrence. The existing advisory lock serializes parallel callbacks for the
-- same fact slot; this replacement makes that serialization idempotent.
create or replace function public.record_wolfie_fact(
  p_tenant_id text,
  p_student_id uuid,
  p_fact_type text,
  p_subject_key text,
  p_value text,
  p_normalized_value text,
  p_negated boolean,
  p_source_session_id uuid,
  p_source_turn_id uuid,
  p_source_transcript text,
  p_transcription_confidence numeric,
  p_evidence jsonb default '{}'::jsonb,
  p_explicitly_confirmed boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  active_fact public.wolfie_facts%rowtype;
  next_fact_id uuid;
  observed_at timestamptz := now();
  bounded_confidence numeric(4, 3);
  repeated_source_turn boolean := false;
begin
  if p_tenant_id is null
     or p_student_id is null
     or nullif(btrim(p_fact_type), '') is null
     or nullif(btrim(p_subject_key), '') is null
     or nullif(btrim(p_value), '') is null
     or nullif(btrim(p_normalized_value), '') is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_wolfie_fact';
  end if;
  if jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'invalid_wolfie_fact_evidence';
  end if;
  if p_fact_type not in ('resides_in', 'is_from', 'born_in') then
    raise exception using
      errcode = '22023',
      message = 'unsupported_wolfie_fact_type';
  end if;

  bounded_confidence := greatest(
    0::numeric,
    least(coalesce(p_transcription_confidence, 0.900), 1::numeric)
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id || ':' || p_student_id::text || ':' ||
      p_fact_type || ':' || p_subject_key,
      0
    )
  );

  select *
    into active_fact
    from public.wolfie_facts
   where tenant_id = p_tenant_id
     and student_id = p_student_id
     and fact_type = p_fact_type
     and subject_key = p_subject_key
     and status = 'active'
   for update;

  repeated_source_turn := active_fact.id is not null
    and p_source_turn_id is not null
    and active_fact.source_turn_id = p_source_turn_id;

  if coalesce(p_negated, false) then
    if active_fact.id is not null
       and active_fact.normalized_value = p_normalized_value then
      update public.wolfie_facts
         set status = 'disputed',
             verification_status = 'rejected',
             disputed_at = observed_at,
             valid_to = observed_at,
             source_session_id = p_source_session_id,
             source_turn_id = p_source_turn_id,
             source_transcript = left(p_source_transcript, 4000),
             transcription_confidence = bounded_confidence,
             evidence = coalesce(active_fact.evidence, '{}'::jsonb)
               || coalesce(p_evidence, '{}'::jsonb)
               || jsonb_build_object('negated_at', observed_at)
       where id = active_fact.id;
      return active_fact.id;
    end if;
    return null;
  end if;

  if active_fact.id is not null
     and active_fact.normalized_value = p_normalized_value then
    update public.wolfie_facts
       set occurrence_count = case
             when repeated_source_turn then occurrence_count
             else least(occurrence_count + 1, 1000000)
           end,
           verification_status = case
             when coalesce(p_explicitly_confirmed, false) then 'confirmed'
             else verification_status
           end,
           confirmed_at = case
             when coalesce(p_explicitly_confirmed, false)
               then coalesce(confirmed_at, observed_at)
             else confirmed_at
           end,
           source_kind = case
             when coalesce(p_explicitly_confirmed, false)
               then 'learner_confirmation'
             else source_kind
           end,
           confidence = greatest(confidence, bounded_confidence),
           source_session_id = p_source_session_id,
           source_turn_id = p_source_turn_id,
           source_transcript = left(p_source_transcript, 4000),
           transcription_confidence = bounded_confidence,
           evidence = coalesce(active_fact.evidence, '{}'::jsonb)
             || coalesce(p_evidence, '{}'::jsonb)
             || jsonb_build_object(
               case when repeated_source_turn
                 then 'last_replayed_at'
                 else 'last_observed_at'
               end,
               observed_at
             )
     where id = active_fact.id;
    return active_fact.id;
  end if;

  if active_fact.id is not null then
    update public.wolfie_facts
       set status = 'superseded',
           valid_to = observed_at
     where id = active_fact.id;
  end if;

  insert into public.wolfie_facts (
    tenant_id,
    student_id,
    fact_type,
    subject_key,
    value,
    normalized_value,
    status,
    verification_status,
    confidence,
    occurrence_count,
    version,
    source_kind,
    source_session_id,
    source_turn_id,
    source_transcript,
    transcription_confidence,
    evidence,
    supersedes_fact_id,
    valid_from,
    confirmed_at
  ) values (
    p_tenant_id,
    p_student_id,
    p_fact_type,
    p_subject_key,
    left(btrim(p_value), 1000),
    left(btrim(p_normalized_value), 1000),
    'active',
    case
      when coalesce(p_explicitly_confirmed, false) then 'confirmed'
      else 'observed'
    end,
    bounded_confidence,
    1,
    coalesce(active_fact.version, 0) + 1,
    case
      when coalesce(p_explicitly_confirmed, false)
        then 'learner_confirmation'
      else 'learner_statement'
    end,
    p_source_session_id,
    p_source_turn_id,
    left(p_source_transcript, 4000),
    bounded_confidence,
    coalesce(p_evidence, '{}'::jsonb)
      || jsonb_build_object('observed_at', observed_at),
    active_fact.id,
    observed_at,
    case
      when coalesce(p_explicitly_confirmed, false) then observed_at
      else null
    end
  )
  returning id into next_fact_id;

  if active_fact.id is not null then
    update public.wolfie_facts
       set superseded_by_fact_id = next_fact_id
     where id = active_fact.id;
  end if;

  return next_fact_id;
end;
$function$;

revoke all on function public.record_wolfie_fact(
  text, uuid, text, text, text, text, boolean, uuid, uuid, text, numeric,
  jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.record_wolfie_fact(
  text, uuid, text, text, text, text, boolean, uuid, uuid, text, numeric,
  jsonb, boolean
) to service_role;

comment on function public.guard_wolfie_session_turn_transport() is
  'Elects one writer transport per session and rejects classic/Realtime mixing under the session lock.';
comment on function public.claim_wolfie_realtime_analysis(
  uuid, uuid, uuid, uuid, boolean
) is 'Claims one Realtime post-turn analysis with a database lock and stale-claim recovery.';
comment on function public.finalize_wolfie_realtime_analysis(
  uuid, uuid, uuid, uuid, uuid, jsonb
) is 'Atomically finalizes the same server claim on both persisted Realtime turns.';
comment on function public.cas_wolfie_realtime_session_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, jsonb,
  text, text, integer, integer, boolean, timestamptz,
  uuid, uuid, uuid, uuid, jsonb, jsonb,
  text, text, uuid, uuid, uuid, numeric, jsonb, uuid, jsonb
) is 'Fenced atomic commit for Realtime state, materialized report, turn markers, corrections and optional retry completion.';
comment on function public.claim_wolfie_realtime_fact_confirmation(
  uuid, uuid, uuid, uuid, text
) is 'Locks a Realtime student turn and idempotently claims one transcript confirmation.';
comment on function public.finalize_wolfie_realtime_fact_confirmation(
  uuid, uuid, uuid, uuid, jsonb
) is 'Finalizes or immediately releases a claimed confirmation without regressing analysis state.';
