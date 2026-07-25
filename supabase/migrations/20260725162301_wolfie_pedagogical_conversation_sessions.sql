set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- The conversational tutor already stores transcripts, corrections and a
-- compact Wolf Intelligence record. This migration turns those records into a
-- structured pedagogical session without duplicating raw chat history.
create table if not exists public.wolf_intelligence (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  accumulated_context text,
  strong_points text[] not null default '{}'::text[],
  weak_points text[] not null default '{}'::text[],
  recommended_approach text,
  vocabulary_level text,
  grammar_level text,
  total_classes_analyzed integer not null default 0 check (
    total_classes_analyzed >= 0
  ),
  last_updated_at timestamptz not null default now(),
  unique (student_id)
);

-- Production predates the migration-backed definition above. Converge those
-- restored/manual installations before adding stricter constraints.
update public.wolf_intelligence as intelligence
   set tenant_id = profile.tenant_id
  from public.profiles as profile
 where profile.id = intelligence.student_id
   and profile.tenant_id is not null
   and intelligence.tenant_id is distinct from profile.tenant_id;

update public.wolf_intelligence
   set strong_points = coalesce(strong_points, '{}'::text[]),
       weak_points = coalesce(weak_points, '{}'::text[]),
       total_classes_analyzed = greatest(
         coalesce(total_classes_analyzed, 0),
         0
       ),
       last_updated_at = coalesce(last_updated_at, now());

alter table public.wolf_intelligence
  alter column strong_points set default '{}'::text[],
  alter column strong_points set not null,
  alter column weak_points set default '{}'::text[],
  alter column weak_points set not null,
  alter column total_classes_analyzed set default 0,
  alter column total_classes_analyzed set not null,
  alter column last_updated_at set default now(),
  alter column last_updated_at set not null;

create unique index if not exists idx_profiles_id_tenant_scope
  on public.profiles (id, tenant_id);
create unique index if not exists idx_wolfie_sessions_scope
  on public.wolfie_sessions (id, student_id, tenant_id);
create unique index if not exists idx_wolfie_turns_session_scope
  on public.wolfie_turns (id, session_id);

do $migration$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_student_tenant_fkey'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_student_tenant_fkey
      foreign key (student_id, tenant_id)
      references public.profiles (id, tenant_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_tenant_id_fkey'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_tenant_id_fkey
      foreign key (tenant_id)
      references public.tenants (id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_total_classes_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_total_classes_check check (
        total_classes_analyzed >= 0
      ) not valid;
  end if;
end;
$migration$;

alter table public.wolf_intelligence
  validate constraint wolf_intelligence_student_tenant_fkey;
alter table public.wolf_intelligence
  validate constraint wolf_intelligence_tenant_id_fkey;
alter table public.wolf_intelligence
  validate constraint wolf_intelligence_total_classes_check;

alter table public.wolf_intelligence
  add column if not exists age_group text,
  add column if not exists estimated_level text,
  add column if not exists primary_goal text,
  add column if not exists secondary_goals text[] not null default '{}'::text[],
  add column if not exists profession text,
  add column if not exists industry text,
  add column if not exists job_role text,
  add column if not exists interests text[] not null default '{}'::text[],
  add column if not exists travel_destination text,
  add column if not exists exchange_context text,
  add column if not exists target_exam text,
  add column if not exists target_date date,
  add column if not exists preferred_correction_mode text,
  add column if not exists preferred_language_mode text,
  add column if not exists confidence_level text,
  add column if not exists preferred_session_minutes integer,
  add column if not exists pressure_level integer,
  add column if not exists recurring_grammar_errors text[] not null default '{}'::text[],
  add column if not exists recurring_pronunciation_issues text[] not null default '{}'::text[],
  add column if not exists recurring_vocabulary_gaps text[] not null default '{}'::text[],
  add column if not exists structures_mastered text[] not null default '{}'::text[],
  add column if not exists structures_in_progress text[] not null default '{}'::text[],
  add column if not exists recent_topics text[] not null default '{}'::text[],
  add column if not exists professional_scenarios text[] not null default '{}'::text[],
  add column if not exists completed_simulations text[] not null default '{}'::text[],
  add column if not exists scores_history jsonb not null default '[]'::jsonb,
  add column if not exists recommended_next_step text,
  add column if not exists previous_session_summary jsonb not null default '{}'::jsonb,
  add column if not exists profile_version integer not null default 1,
  add column if not exists profiled_at timestamptz;

update public.wolf_intelligence
   set secondary_goals = coalesce(secondary_goals, '{}'::text[]),
       interests = coalesce(interests, '{}'::text[]),
       recurring_grammar_errors =
         coalesce(recurring_grammar_errors, '{}'::text[]),
       recurring_pronunciation_issues =
         coalesce(recurring_pronunciation_issues, '{}'::text[]),
       recurring_vocabulary_gaps =
         coalesce(recurring_vocabulary_gaps, '{}'::text[]),
       structures_mastered = coalesce(structures_mastered, '{}'::text[]),
       structures_in_progress =
         coalesce(structures_in_progress, '{}'::text[]),
       recent_topics = coalesce(recent_topics, '{}'::text[]),
       professional_scenarios =
         coalesce(professional_scenarios, '{}'::text[]),
       completed_simulations =
         coalesce(completed_simulations, '{}'::text[]),
       scores_history = case
         when jsonb_typeof(scores_history) = 'array' then scores_history
         else '[]'::jsonb
       end,
       previous_session_summary = case
         when jsonb_typeof(previous_session_summary) = 'object'
           then previous_session_summary
         else '{}'::jsonb
       end,
       profile_version = greatest(coalesce(profile_version, 1), 1);

alter table public.wolf_intelligence
  alter column secondary_goals set default '{}'::text[],
  alter column secondary_goals set not null,
  alter column interests set default '{}'::text[],
  alter column interests set not null,
  alter column recurring_grammar_errors set default '{}'::text[],
  alter column recurring_grammar_errors set not null,
  alter column recurring_pronunciation_issues set default '{}'::text[],
  alter column recurring_pronunciation_issues set not null,
  alter column recurring_vocabulary_gaps set default '{}'::text[],
  alter column recurring_vocabulary_gaps set not null,
  alter column structures_mastered set default '{}'::text[],
  alter column structures_mastered set not null,
  alter column structures_in_progress set default '{}'::text[],
  alter column structures_in_progress set not null,
  alter column recent_topics set default '{}'::text[],
  alter column recent_topics set not null,
  alter column professional_scenarios set default '{}'::text[],
  alter column professional_scenarios set not null,
  alter column completed_simulations set default '{}'::text[],
  alter column completed_simulations set not null,
  alter column scores_history set default '[]'::jsonb,
  alter column scores_history set not null,
  alter column previous_session_summary set default '{}'::jsonb,
  alter column previous_session_summary set not null,
  alter column profile_version set default 1,
  alter column profile_version set not null;

do $migration$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_estimated_level_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_estimated_level_check check (
        estimated_level is null
        or estimated_level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_correction_mode_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_correction_mode_check check (
        preferred_correction_mode is null
        or preferred_correction_mode in (
          'immediate',
          'end',
          'selective',
          'examiner'
        )
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_language_mode_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_language_mode_check check (
        preferred_language_mode is null
        or preferred_language_mode in (
          'pt_support',
          'bilingual',
          'immersive',
          'english_rescue'
        )
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_confidence_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_confidence_check check (
        confidence_level is null
        or confidence_level in (
          'very_low',
          'low',
          'medium',
          'high',
          'very_high'
        )
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_practice_preferences_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_practice_preferences_check check (
        (
          preferred_session_minutes is null
          or preferred_session_minutes between 1 and 240
        )
        and (
          pressure_level is null
          or pressure_level between 1 and 5
        )
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_json_shapes_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_json_shapes_check check (
        jsonb_typeof(scores_history) = 'array'
        and jsonb_array_length(scores_history) <= 100
        and jsonb_typeof(previous_session_summary) = 'object'
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolf_intelligence_profile_version_check'
       and conrelid = 'public.wolf_intelligence'::regclass
  ) then
    alter table public.wolf_intelligence
      add constraint wolf_intelligence_profile_version_check check (
        profile_version between 1 and 1000000
      );
  end if;
end;
$migration$;

alter table public.wolfie_sessions
  add column if not exists experience_mode text not null default 'free_conversation',
  add column if not exists correction_mode text not null default 'selective',
  add column if not exists language_mode text not null default 'bilingual',
  add column if not exists difficulty text not null default 'balanced',
  add column if not exists scenario_context text,
  add column if not exists student_goal text,
  add column if not exists target_skill text,
  add column if not exists current_stage text not null default 'discovery',
  add column if not exists scenario_status text not null default 'active',
  add column if not exists planned_duration_minutes integer,
  add column if not exists time_limit_seconds integer,
  add column if not exists retry_count integer not null default 0,
  add column if not exists needs_external_verification boolean not null default false,
  add column if not exists report_json jsonb not null default '{}'::jsonb,
  add column if not exists memory_summary jsonb not null default '{}'::jsonb,
  add column if not exists sensitive_memory_consent_at timestamptz,
  add column if not exists transcript_retention_until timestamptz,
  add column if not exists last_activity_at timestamptz not null default now();

update public.wolfie_sessions
   set report_json = case
         when jsonb_typeof(report_json) = 'object' then report_json
         else '{}'::jsonb
       end,
       memory_summary = case
         when jsonb_typeof(memory_summary) = 'object' then memory_summary
         else '{}'::jsonb
       end,
       last_activity_at = coalesce(
         last_activity_at,
         updated_at,
         created_at,
         now()
       );

alter table public.wolfie_sessions
  alter column report_json set default '{}'::jsonb,
  alter column report_json set not null,
  alter column memory_summary set default '{}'::jsonb,
  alter column memory_summary set not null,
  alter column last_activity_at set default now(),
  alter column last_activity_at set not null;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_experience_mode_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_experience_mode_check check (
        experience_mode in (
          'free_conversation',
          'guided_lesson',
          'roleplay',
          'presentation',
          'global_meeting',
          'interview',
          'exam',
          'writing',
          'pronunciation',
          'vocabulary',
          'storytelling',
          'child_mission',
          'teen_challenge',
          'examiner',
          'fluency',
          'emergency'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_correction_mode_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_correction_mode_check check (
        correction_mode in ('immediate', 'end', 'selective', 'examiner')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_language_mode_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_language_mode_check check (
        language_mode in (
          'pt_support',
          'bilingual',
          'immersive',
          'english_rescue'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_difficulty_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_difficulty_check check (
        difficulty in ('supportive', 'balanced', 'challenging', 'adaptive')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_retry_count_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_retry_count_check check (
        retry_count >= 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_scenario_status_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_scenario_status_check check (
        scenario_status in (
          'active',
          'awaiting_retry',
          'completed',
          'abandoned',
          'failed'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_timing_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_timing_check check (
        (
          planned_duration_minutes is null
          or planned_duration_minutes between 1 and 240
        )
        and (
          time_limit_seconds is null
          or time_limit_seconds between 10 and 86400
        )
        and (
          finished_at is null
          or started_at is null
          or finished_at >= started_at
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_json_shapes_check'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_json_shapes_check check (
        jsonb_typeof(report_json) = 'object'
        and jsonb_typeof(memory_summary) = 'object'
      );
  end if;

  if exists (
    select 1
      from public.wolfie_sessions as session
      join public.profiles as profile on profile.id = session.student_id
     where session.tenant_id is distinct from profile.tenant_id
  ) then
    raise exception
      using
        errcode = '23503',
        message = 'wolfie_sessions contains a student/tenant scope mismatch';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_sessions_student_tenant_fkey'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_student_tenant_fkey
      foreign key (student_id, tenant_id)
      references public.profiles (id, tenant_id)
      on delete cascade
      not valid;
  end if;
end;
$migration$;

alter table public.wolfie_sessions
  validate constraint wolfie_sessions_student_tenant_fkey;

alter table public.wolfie_turns
  add column if not exists message_type text not null default 'question',
  add column if not exists stage text,
  add column if not exists structured_payload jsonb not null default '{}'::jsonb,
  add column if not exists requires_retry boolean not null default false,
  add column if not exists language_code text,
  add column if not exists speech_metrics jsonb not null default '{}'::jsonb,
  add column if not exists transcription_confidence numeric(4, 3);

update public.wolfie_turns
   set structured_payload = case
         when jsonb_typeof(structured_payload) = 'object'
           then structured_payload
         else '{}'::jsonb
       end,
       speech_metrics = case
         when jsonb_typeof(speech_metrics) = 'object' then speech_metrics
         else '{}'::jsonb
       end;

alter table public.wolfie_turns
  alter column structured_payload set default '{}'::jsonb,
  alter column structured_payload set not null,
  alter column speech_metrics set default '{}'::jsonb,
  alter column speech_metrics set not null;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_turns_message_type_check'
       and conrelid = 'public.wolfie_turns'::regclass
  ) then
    alter table public.wolfie_turns
      add constraint wolfie_turns_message_type_check check (
        message_type in (
          'question',
          'correction',
          'explanation',
          'simulation',
          'feedback',
          'instruction'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_turns_language_code_check'
       and conrelid = 'public.wolfie_turns'::regclass
  ) then
    alter table public.wolfie_turns
      add constraint wolfie_turns_language_code_check check (
        language_code is null
        or language_code in ('pt-BR', 'en-US', 'mixed')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_turns_payload_shape_check'
       and conrelid = 'public.wolfie_turns'::regclass
  ) then
    alter table public.wolfie_turns
      add constraint wolfie_turns_payload_shape_check check (
        jsonb_typeof(structured_payload) = 'object'
        and jsonb_typeof(speech_metrics) = 'object'
        and (
          transcription_confidence is null
          or transcription_confidence between 0 and 1
        )
      );
  end if;
end;
$migration$;

alter table public.wolfie_corrections
  add column if not exists natural_sentence text,
  add column if not exists priority text not null default 'medium',
  add column if not exists skill_focus text,
  add column if not exists requires_retry boolean,
  add column if not exists retry_completed boolean not null default false,
  add column if not exists retry_turn_id uuid,
  add column if not exists retry_score smallint,
  add column if not exists retry_feedback jsonb not null default '{}'::jsonb,
  add column if not exists retry_completed_at timestamptz;

-- Historical corrections predate mandatory retry. New corrections require it
-- by default; the application may explicitly waive only a non-priority item.
update public.wolfie_corrections
   set requires_retry = false
 where requires_retry is null;
update public.wolfie_corrections
   set retry_feedback = case
         when jsonb_typeof(retry_feedback) = 'object' then retry_feedback
         else '{}'::jsonb
       end;

alter table public.wolfie_corrections
  alter column requires_retry set default true,
  alter column requires_retry set not null,
  alter column retry_feedback set default '{}'::jsonb,
  alter column retry_feedback set not null;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_corrections_priority_check'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_priority_check check (
        priority in ('low', 'medium', 'high')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_corrections_skill_focus_check'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_skill_focus_check check (
        skill_focus is null
        or skill_focus in (
          'grammar',
          'vocabulary',
          'pronunciation',
          'fluency',
          'formality',
          'clarity',
          'structure',
          'naturalness'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_corrections_retry_state_check'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_retry_state_check check (
        jsonb_typeof(retry_feedback) = 'object'
        and (retry_score is null or retry_score between 0 and 100)
        and (
          not retry_completed
          or (
            retry_turn_id is not null
            and retry_completed_at is not null
          )
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_corrections_turn_session_fkey'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_turn_session_fkey
      foreign key (turn_id, session_id)
      references public.wolfie_turns (id, session_id)
      on delete set null (turn_id)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_corrections_retry_turn_session_fkey'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_retry_turn_session_fkey
      foreign key (retry_turn_id, session_id)
      references public.wolfie_turns (id, session_id)
      not valid;
  end if;
end;
$migration$;

alter table public.wolfie_corrections
  validate constraint wolfie_corrections_turn_session_fkey;
alter table public.wolfie_corrections
  validate constraint wolfie_corrections_retry_turn_session_fkey;

-- Structured activities already have authoritative server-side attempts.
-- Add lineage so a retry is evidence, not a boolean awarded by the browser.
alter table public.wolfie_activity_sessions
  add column if not exists current_stage text not null default 'briefing',
  add column if not exists required_retry_count integer not null default 0,
  add column if not exists completed_retry_count integer not null default 0,
  add column if not exists report_json jsonb not null default '{}'::jsonb,
  add column if not exists last_activity_at timestamptz not null default now();

update public.wolfie_activity_sessions
   set report_json = case
         when jsonb_typeof(report_json) = 'object' then report_json
         else '{}'::jsonb
       end,
       last_activity_at = coalesce(last_activity_at, updated_at, created_at);

alter table public.wolfie_activity_sessions
  alter column report_json set default '{}'::jsonb,
  alter column report_json set not null,
  alter column last_activity_at set default now(),
  alter column last_activity_at set not null;

alter table public.wolfie_activity_attempts
  add column if not exists attempt_kind text not null default 'initial',
  add column if not exists parent_attempt_id uuid,
  add column if not exists requires_retry boolean not null default false,
  add column if not exists retry_completed boolean not null default false,
  add column if not exists retry_completed_by_attempt_id uuid;

create unique index if not exists idx_wolfie_activity_attempts_scope
  on public.wolfie_activity_attempts (
    id,
    session_id,
    student_id,
    tenant_id
  );

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_activity_sessions_retry_counts_check'
       and conrelid = 'public.wolfie_activity_sessions'::regclass
  ) then
    alter table public.wolfie_activity_sessions
      add constraint wolfie_activity_sessions_retry_counts_check check (
        required_retry_count >= 0
        and completed_retry_count between 0 and required_retry_count
        and jsonb_typeof(report_json) = 'object'
      );
  end if;

  alter table public.wolfie_activity_sessions
    drop constraint if exists wolfie_activity_sessions_status_check;
  alter table public.wolfie_activity_sessions
    add constraint wolfie_activity_sessions_status_check check (
      status in (
        'IN_PROGRESS',
        'EVALUATING',
        'AWAITING_RETRY',
        'COMPLETED',
        'ABANDONED',
        'FAILED'
      )
    );

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_activity_attempts_kind_check'
       and conrelid = 'public.wolfie_activity_attempts'::regclass
  ) then
    alter table public.wolfie_activity_attempts
      add constraint wolfie_activity_attempts_kind_check check (
        attempt_kind in ('initial', 'retry', 'transfer', 'final')
        and (
          (attempt_kind = 'retry' and parent_attempt_id is not null)
          or (attempt_kind <> 'retry' and parent_attempt_id is null)
        )
        and (
          not retry_completed
          or retry_completed_by_attempt_id is not null
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_activity_attempts_parent_scope_fkey'
       and conrelid = 'public.wolfie_activity_attempts'::regclass
  ) then
    alter table public.wolfie_activity_attempts
      add constraint wolfie_activity_attempts_parent_scope_fkey
      foreign key (
        parent_attempt_id,
        session_id,
        student_id,
        tenant_id
      )
      references public.wolfie_activity_attempts (
        id,
        session_id,
        student_id,
        tenant_id
      )
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'wolfie_activity_attempts_completed_by_scope_fkey'
       and conrelid = 'public.wolfie_activity_attempts'::regclass
  ) then
    alter table public.wolfie_activity_attempts
      add constraint wolfie_activity_attempts_completed_by_scope_fkey
      foreign key (
        retry_completed_by_attempt_id,
        session_id,
        student_id,
        tenant_id
      )
      references public.wolfie_activity_attempts (
        id,
        session_id,
        student_id,
        tenant_id
      )
      not valid;
  end if;
end;
$migration$;

alter table public.wolfie_activity_attempts
  validate constraint wolfie_activity_attempts_parent_scope_fkey;
alter table public.wolfie_activity_attempts
  validate constraint wolfie_activity_attempts_completed_by_scope_fkey;

-- A wrong answer may now be tried again. Idempotency remains protected by
-- (session_id, request_key), while each attempt keeps its own global number.
drop index if exists public.idx_wolfie_activity_attempts_quiz_step_once;
create index if not exists idx_wolfie_activity_attempts_step_history
  on public.wolfie_activity_attempts (
    session_id,
    step_key,
    attempt_number desc
  )
  where step_key is not null;
create index if not exists idx_wolfie_activity_attempts_parent
  on public.wolfie_activity_attempts (parent_attempt_id)
  where parent_attempt_id is not null;

-- Preserve unfinished wrong quiz answers created before retry lineage existed.
-- Completed historical sessions remain immutable and are not reopened.
update public.wolfie_activity_attempts as attempt
   set requires_retry = true
  from public.wolfie_activity_sessions as session
 where session.id = attempt.session_id
   and session.status in ('IN_PROGRESS', 'EVALUATING', 'AWAITING_RETRY')
   and attempt.feedback_payload @> '{"correct": false}'::jsonb
   and not attempt.requires_retry;

with retry_counts as (
  select
    attempt.session_id,
    count(*) filter (where attempt.requires_retry)::integer as required_count,
    count(*) filter (
      where attempt.requires_retry and attempt.retry_completed
    )::integer as completed_count,
    count(*) filter (
      where attempt.requires_retry and not attempt.retry_completed
    )::integer as pending_count
  from public.wolfie_activity_attempts as attempt
  group by attempt.session_id
)
update public.wolfie_activity_sessions as session
   set required_retry_count = counts.required_count,
       completed_retry_count = counts.completed_count,
       status = case
         when counts.pending_count > 0
          and session.status in ('IN_PROGRESS', 'EVALUATING')
           then 'AWAITING_RETRY'
         else session.status
       end,
       current_stage = case
         when counts.pending_count > 0 then 'retry'
         else session.current_stage
       end,
       last_activity_at = greatest(
         session.last_activity_at,
         session.updated_at
       )
  from retry_counts as counts
 where session.id = counts.session_id;

-- Keep the established XP/completion routine as a private implementation.
-- The public service RPC below wraps it with atomic retry lineage. Partial
-- attempts are written directly because the legacy routine deliberately
-- treated every incomplete global-meeting attempt as a construction section.
do $migration$
begin
  if pg_catalog.to_regprocedure(
    'public.record_wolfie_activity_attempt_legacy(uuid,uuid,jsonb,jsonb,integer,integer,text,text,boolean)'
  ) is null then
    alter function public.record_wolfie_activity_attempt(
      uuid,
      uuid,
      jsonb,
      jsonb,
      integer,
      integer,
      text,
      text,
      boolean
    ) rename to record_wolfie_activity_attempt_legacy;
  end if;
end;
$migration$;

create or replace function public.record_wolfie_activity_attempt(
  p_session_id uuid,
  p_request_key uuid,
  p_response_payload jsonb,
  p_feedback_payload jsonb,
  p_score integer,
  p_duration_seconds integer default 0,
  p_step_key text default null,
  p_modality text default 'text',
  p_complete boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_session public.wolfie_activity_sessions%rowtype;
  v_existing public.wolfie_activity_attempts%rowtype;
  v_parent public.wolfie_activity_attempts%rowtype;
  v_attempt public.wolfie_activity_attempts%rowtype;
  v_attempt_kind text;
  v_parent_attempt_id uuid;
  v_step_key text;
  v_parent_step_key text;
  v_response_payload jsonb;
  v_feedback_payload jsonb;
  v_requires_retry boolean;
  v_effective_complete boolean;
  v_retry_completed_for_response boolean;
  v_attempt_number integer;
  v_required_count integer;
  v_completed_count integer;
  v_pending_count integer;
  v_other_pending_count integer;
  v_meeting_section_count integer;
  v_result jsonb;
begin
  if p_request_key is null then
    raise exception 'request_key_required';
  end if;
  if p_score is null or p_score < 0 or p_score > 100 then
    raise exception 'score_out_of_range';
  end if;
  if p_duration_seconds is null
     or p_duration_seconds < 0
     or p_duration_seconds > 86400 then
    raise exception 'duration_out_of_range';
  end if;
  if p_modality is null
     or p_modality not in ('text', 'voice', 'mixed') then
    raise exception 'invalid_modality';
  end if;
  if p_complete is null then
    raise exception 'complete_flag_required';
  end if;
  if pg_catalog.pg_column_size(
    coalesce(p_response_payload, '{}'::jsonb)
  ) > 1048576
     or pg_catalog.pg_column_size(
       coalesce(p_feedback_payload, '{}'::jsonb)
     ) > 1048576 then
    raise exception 'attempt_payload_too_large';
  end if;

  v_step_key := nullif(
    pg_catalog.left(coalesce(p_step_key, ''), 120),
    ''
  );
  v_attempt_kind := coalesce(
    nullif(p_response_payload ->> 'attemptKind', ''),
    'initial'
  );
  if v_attempt_kind not in ('initial', 'retry') then
    raise exception 'invalid_attempt_kind';
  end if;
  v_requires_retry :=
    coalesce(p_feedback_payload ->> 'requiresRetry', 'false') = 'true';

  select *
    into v_session
    from public.wolfie_activity_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'session_not_found';
  end if;

  select *
    into v_existing
    from public.wolfie_activity_attempts
   where session_id = v_session.id
     and request_key = p_request_key;

  if found then
    return pg_catalog.jsonb_build_object(
      'alreadyProcessed', true,
      'alreadyCompleted', v_session.status = 'COMPLETED',
      'stepAlreadyAnswered', false,
      'requestKey', v_existing.request_key,
      'stepKey', v_existing.step_key,
      'attemptId', v_existing.id,
      'attemptNumber', v_existing.attempt_number,
      'score', v_existing.score,
      'responsePayload', v_existing.response_payload,
      'feedbackPayload', v_existing.feedback_payload
        || pg_catalog.jsonb_build_object(
          'requiresRetry',
            v_existing.requires_retry and not v_existing.retry_completed,
          'retryCompleted', v_existing.retry_completed or coalesce(
            v_existing.feedback_payload ->> 'retryCompleted',
            'false'
          ) = 'true'
        ),
      'requiresRetry',
        v_existing.requires_retry and not v_existing.retry_completed,
      'retryCompleted',
        v_existing.retry_completed or coalesce(
          v_existing.feedback_payload ->> 'retryCompleted',
          'false'
        ) = 'true',
      'parentAttemptId', v_existing.parent_attempt_id,
      'xpEarned', case
        when v_existing.completes_session
          and v_session.status = 'COMPLETED'
          then v_session.xp_earned
        else 0
      end,
      'leveledUp', false,
      'newLevel', null
    );
  end if;

  if v_session.status = 'COMPLETED' then
    return pg_catalog.jsonb_build_object(
      'alreadyProcessed', false,
      'alreadyCompleted', true,
      'stepAlreadyAnswered', false,
      'requestKey', p_request_key,
      'stepKey', v_step_key,
      'attemptId', null,
      'attemptNumber', v_session.attempt_count,
      'score', v_session.score,
      'requiresRetry', false,
      'retryCompleted', false,
      'parentAttemptId', null,
      'xpEarned', v_session.xp_earned,
      'leveledUp', false,
      'newLevel', null
    );
  end if;
  if v_session.status in ('ABANDONED', 'FAILED', 'EVALUATING') then
    raise exception 'session_not_writable';
  end if;

  if v_attempt_kind = 'retry' then
    begin
      v_parent_attempt_id :=
        nullif(p_response_payload ->> 'parentAttemptId', '')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'invalid_parent_attempt_id';
    end;
    if v_parent_attempt_id is null then
      raise exception 'parent_attempt_required';
    end if;

    select *
      into v_parent
      from public.wolfie_activity_attempts
     where id = v_parent_attempt_id
       and session_id = v_session.id
       and student_id = v_session.student_id
       and tenant_id = v_session.tenant_id
     for update;

    if not found
       or not v_parent.requires_retry
       or v_parent.retry_completed then
      raise exception 'parent_attempt_not_retryable';
    end if;

    v_parent_step_key := coalesce(
      nullif(v_parent.response_payload ->> 'logicalStepKey', ''),
      v_parent.step_key
    );
    if v_parent_step_key is distinct from v_step_key then
      raise exception 'parent_attempt_step_mismatch';
    end if;
  elsif nullif(p_response_payload ->> 'parentAttemptId', '') is not null then
    raise exception 'initial_attempt_cannot_have_parent';
  end if;

  -- Guided Writing always requires at least one reformulation and keeps the
  -- retry chain open until the latest version meets the calibrated threshold.
  if v_session.subject = 'writing'
     and v_step_key = 'writing'
     and not p_complete
     and v_attempt_kind = 'initial' then
    v_requires_retry := true;
  end if;

  v_effective_complete := p_complete and not v_requires_retry;
  v_retry_completed_for_response :=
    v_parent_attempt_id is not null and not v_requires_retry;
  v_response_payload :=
    coalesce(p_response_payload, '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
      'logicalStepKey', v_step_key,
      'attemptKind', v_attempt_kind,
      'parentAttemptId', v_parent_attempt_id
    );
  v_feedback_payload :=
    coalesce(p_feedback_payload, '{}'::jsonb)
    || pg_catalog.jsonb_build_object(
      'requiresRetry', v_requires_retry,
      'retryCompleted', v_retry_completed_for_response,
      'parentAttemptId', v_parent_attempt_id
    );

  select pg_catalog.count(*)::integer
    into v_other_pending_count
    from public.wolfie_activity_attempts as pending
   where pending.session_id = v_session.id
     and pending.requires_retry
     and not pending.retry_completed
     and pending.id is distinct from v_parent_attempt_id;

  if v_attempt_kind = 'initial' and v_other_pending_count > 0 then
    raise exception 'retry_required';
  end if;
  if v_effective_complete and v_other_pending_count > 0 then
    raise exception 'retry_required';
  end if;

  if not v_effective_complete then
    if v_session.subject = 'global_meetings' then
      if v_session.phase = 'construction'
         and v_step_key = any (
           array[
             'opening',
             'context',
             'data',
             'proposal',
             'next_steps',
             'closing'
           ]::text[]
         ) then
        if p_modality <> 'text'
           or nullif(
             pg_catalog.btrim(v_response_payload ->> 'text'),
             ''
           ) is null then
          raise exception 'invalid_meeting_section_response';
        end if;
      elsif coalesce(
        v_response_payload ->> 'completeWhenReady',
        'false'
      ) = 'true' then
        if (
          v_session.phase = 'construction'
          and v_step_key is distinct from 'construction_complete'
        ) or (
          v_session.phase = 'memorization'
          and v_step_key is distinct from 'memorization_complete'
        ) or (
          v_session.phase = 'readaptation'
          and v_step_key not in ('readaptation', 'readaptation_speech')
        ) or v_session.phase not in (
          'construction',
          'memorization',
          'readaptation'
        ) then
          raise exception 'invalid_meeting_final_step';
        end if;

        if v_session.phase = 'construction' then
          select pg_catalog.count(distinct attempt.step_key)
            into v_meeting_section_count
            from public.wolfie_activity_attempts as attempt
           where attempt.session_id = v_session.id
             and attempt.step_key = any (
               array[
                 'opening',
                 'context',
                 'data',
                 'proposal',
                 'next_steps',
                 'closing'
               ]::text[]
             )
             and nullif(
               pg_catalog.btrim(attempt.response_payload ->> 'text'),
               ''
             ) is not null;
          if v_meeting_section_count <> 6 then
            raise exception 'meeting_sections_incomplete';
          end if;
        elsif v_session.phase = 'memorization'
          and coalesce(
            (
              v_session.learner_state
                -> 'memorization'
                ->> 'rehearsalCount'
            )::integer,
            0
          ) < 1 then
          raise exception 'memorization_rehearsal_required';
        end if;

        if (
          p_modality = 'text'
          and nullif(
            pg_catalog.btrim(v_response_payload ->> 'text'),
            ''
          ) is null
        ) or (
          p_modality = 'voice'
          and coalesce(
            v_response_payload ->> 'audioAnalyzed',
            'false'
          ) <> 'true'
        ) or p_modality not in ('text', 'voice') then
          raise exception 'invalid_meeting_final_response';
        end if;
      else
        raise exception 'invalid_meeting_partial_attempt';
      end if;
    end if;

    v_attempt_number := v_session.attempt_count + 1;
    insert into public.wolfie_activity_attempts (
      session_id,
      tenant_id,
      student_id,
      request_key,
      attempt_number,
      step_key,
      modality,
      response_payload,
      feedback_payload,
      score,
      completes_session,
      attempt_kind,
      parent_attempt_id,
      requires_retry,
      retry_completed
    ) values (
      v_session.id,
      v_session.tenant_id,
      v_session.student_id,
      p_request_key,
      v_attempt_number,
      v_step_key,
      p_modality,
      v_response_payload,
      v_feedback_payload,
      p_score,
      false,
      v_attempt_kind,
      v_parent_attempt_id,
      v_requires_retry,
      false
    )
    returning * into v_attempt;

    if v_parent_attempt_id is not null then
      update public.wolfie_activity_attempts
         set retry_completed = true,
             retry_completed_by_attempt_id = v_attempt.id
       where id = v_parent_attempt_id;
    end if;

    select
      pg_catalog.count(*) filter (
        where attempt.requires_retry
      )::integer,
      pg_catalog.count(*) filter (
        where attempt.requires_retry and attempt.retry_completed
      )::integer,
      pg_catalog.count(*) filter (
        where attempt.requires_retry and not attempt.retry_completed
      )::integer
      into v_required_count, v_completed_count, v_pending_count
      from public.wolfie_activity_attempts as attempt
     where attempt.session_id = v_session.id;

    update public.wolfie_activity_sessions
       set attempt_count = v_attempt_number,
           duration_seconds = greatest(
             duration_seconds,
             least(p_duration_seconds, 86400)
           ),
           learner_state = case
             when v_session.subject = 'global_meetings'
              and v_session.phase = 'construction'
              and v_step_key = any (
                array[
                  'opening',
                  'context',
                  'data',
                  'proposal',
                  'next_steps',
                  'closing'
                ]::text[]
              ) then
               pg_catalog.jsonb_set(
                 pg_catalog.jsonb_set(
                   coalesce(learner_state, '{}'::jsonb),
                   array['sections']::text[],
                   case
                     when pg_catalog.jsonb_typeof(
                       learner_state -> 'sections'
                     ) = 'object'
                       then learner_state -> 'sections'
                     else '{}'::jsonb
                   end,
                   true
                 ),
                 array['sections', v_step_key]::text[],
                 pg_catalog.jsonb_build_object(
                   'original',
                     coalesce(v_response_payload ->> 'text', ''),
                   'corrected',
                     coalesce(
                       v_feedback_payload ->> 'correctedText',
                       v_response_payload ->> 'text',
                       ''
                     ),
                   'naturalVersion',
                     coalesce(
                       v_feedback_payload ->> 'naturalVersion',
                       v_feedback_payload ->> 'correctedText',
                       v_response_payload ->> 'text',
                       ''
                     ),
                   'score', p_score,
                   'attemptId', v_attempt.id,
                   'requiresRetry', v_requires_retry,
                   'retryCompleted',
                     v_retry_completed_for_response,
                   'parentAttemptId', v_parent_attempt_id,
                   'savedAt', pg_catalog.now(),
                   'responsePayload', v_response_payload,
                   'feedbackPayload', v_feedback_payload
                 ),
                 true
               )
             when v_session.subject in (
               'vocabulary',
               'grammar',
               'listening',
               'reading'
             ) and v_step_key like 'quiz:%' then
               pg_catalog.jsonb_set(
                 pg_catalog.jsonb_set(
                   coalesce(learner_state, '{}'::jsonb),
                   array['quizAnswers']::text[],
                   case
                     when pg_catalog.jsonb_typeof(
                       learner_state -> 'quizAnswers'
                     ) = 'object'
                       then learner_state -> 'quizAnswers'
                     else '{}'::jsonb
                   end,
                   true
                 ),
                 array[
                   'quizAnswers',
                   pg_catalog.substring(v_step_key, 6)
                 ]::text[],
                 v_feedback_payload || pg_catalog.jsonb_build_object(
                   'attemptId', v_attempt.id,
                   'attemptNumber', v_attempt_number,
                   'score', p_score,
                   'requiresRetry', v_requires_retry,
                   'retryCompleted', v_retry_completed_for_response,
                   'parentAttemptId', v_parent_attempt_id,
                   'selectedIndex',
                     v_response_payload -> 'selectedIndex',
                   'savedAt', pg_catalog.now()
                 ),
                 true
               )
             else learner_state
           end,
           required_retry_count = v_required_count,
           completed_retry_count = v_completed_count,
           report_json = coalesce(report_json, '{}'::jsonb)
             || pg_catalog.jsonb_build_object(
               'lastScore', p_score,
               'requiresRetry', v_requires_retry,
               'retryCompleted', v_retry_completed_for_response,
               'retryPrompt',
                 coalesce(v_feedback_payload ->> 'retryPrompt', ''),
               'strengths',
                 coalesce(
                   v_feedback_payload -> 'strengths',
                   '[]'::jsonb
                 ),
               'priorities',
                 coalesce(
                   v_feedback_payload -> 'priorities',
                   '[]'::jsonb
                 ),
               'attemptId', v_attempt.id,
               'parentAttemptId', v_parent_attempt_id,
               'latestAttempt', pg_catalog.jsonb_build_object(
                 'attemptId', v_attempt.id,
                 'attemptNumber', v_attempt_number,
                 'stepKey', v_step_key,
                 'modality', p_modality,
                 'score', p_score,
                 'requiresRetry', v_requires_retry,
                 'retryCompleted', v_retry_completed_for_response,
                 'parentAttemptId', v_parent_attempt_id,
                 'responsePayload', v_response_payload,
                 'feedbackPayload', v_feedback_payload,
                 'recordedAt', pg_catalog.now()
               ),
               'updatedAt', pg_catalog.now()
             ),
           status = case
             when v_pending_count > 0 then 'AWAITING_RETRY'
             else 'IN_PROGRESS'
           end,
           current_stage = case
             when v_pending_count > 0 then 'retry'
             else 'practice'
           end,
           last_activity_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = v_session.id;

    return pg_catalog.jsonb_build_object(
      'alreadyProcessed', false,
      'alreadyCompleted', false,
      'stepAlreadyAnswered', false,
      'requestKey', p_request_key,
      'stepKey', v_step_key,
      'attemptId', v_attempt.id,
      'attemptNumber', v_attempt_number,
      'score', p_score,
      'requiresRetry', v_requires_retry,
      'retryCompleted', v_retry_completed_for_response,
      'parentAttemptId', v_parent_attempt_id,
      'xpEarned', 0,
      'leveledUp', false,
      'newLevel', null
    );
  end if;

  v_result := public.record_wolfie_activity_attempt_legacy(
    p_session_id,
    p_request_key,
    v_response_payload,
    v_feedback_payload,
    p_score,
    p_duration_seconds,
    v_step_key,
    p_modality,
    true
  );

  select *
    into v_attempt
    from public.wolfie_activity_attempts
   where session_id = v_session.id
     and request_key = p_request_key;

  if not found then
    return v_result;
  end if;

  update public.wolfie_activity_attempts
     set attempt_kind = v_attempt_kind,
         parent_attempt_id = v_parent_attempt_id,
         requires_retry = false
   where id = v_attempt.id
   returning * into v_attempt;

  if v_parent_attempt_id is not null then
    update public.wolfie_activity_attempts
       set retry_completed = true,
           retry_completed_by_attempt_id = v_attempt.id
     where id = v_parent_attempt_id;
  end if;

  select
    pg_catalog.count(*) filter (
      where attempt.requires_retry
    )::integer,
    pg_catalog.count(*) filter (
      where attempt.requires_retry and attempt.retry_completed
    )::integer,
    pg_catalog.count(*) filter (
      where attempt.requires_retry and not attempt.retry_completed
    )::integer
    into v_required_count, v_completed_count, v_pending_count
    from public.wolfie_activity_attempts as attempt
   where attempt.session_id = v_session.id;

  update public.wolfie_activity_sessions
     set required_retry_count = v_required_count,
         completed_retry_count = v_completed_count,
         report_json = coalesce(report_json, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
             'lastScore', p_score,
             'requiresRetry', false,
             'retryCompleted', v_retry_completed_for_response,
             'retryPrompt', '',
             'strengths',
               coalesce(
                 v_feedback_payload -> 'strengths',
                 '[]'::jsonb
               ),
             'priorities',
               coalesce(
                 v_feedback_payload -> 'priorities',
                 '[]'::jsonb
               ),
             'attemptId', v_attempt.id,
             'parentAttemptId', v_parent_attempt_id,
             'latestAttempt', pg_catalog.jsonb_build_object(
               'attemptId', v_attempt.id,
               'attemptNumber', v_attempt.attempt_number,
               'stepKey', v_step_key,
               'modality', p_modality,
               'score', p_score,
               'requiresRetry', false,
               'retryCompleted', v_retry_completed_for_response,
               'parentAttemptId', v_parent_attempt_id,
               'responsePayload', v_response_payload,
               'feedbackPayload', v_feedback_payload,
               'recordedAt', pg_catalog.now()
             ),
             'status', 'completed',
             'updatedAt', pg_catalog.now()
           ),
         current_stage = 'completed',
         last_activity_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = v_session.id;

  return v_result || pg_catalog.jsonb_build_object(
    'attemptId', v_attempt.id,
    'attemptNumber', v_attempt.attempt_number,
    'requiresRetry', false,
    'retryCompleted', v_retry_completed_for_response,
    'parentAttemptId', v_parent_attempt_id
  );
end;
$function$;

revoke all on function public.record_wolfie_activity_attempt_legacy(
  uuid,
  uuid,
  jsonb,
  jsonb,
  integer,
  integer,
  text,
  text,
  boolean
) from public, anon, authenticated, service_role;
revoke all on function public.record_wolfie_activity_attempt(
  uuid,
  uuid,
  jsonb,
  jsonb,
  integer,
  integer,
  text,
  text,
  boolean
) from public, anon, authenticated;
grant execute on function public.record_wolfie_activity_attempt(
  uuid,
  uuid,
  jsonb,
  jsonb,
  integer,
  integer,
  text,
  text,
  boolean
) to service_role;

-- Individual memory items preserve evidence, recurrence and spaced review.
-- Sensitive memories (for example a personal story) require explicit consent.
create table if not exists public.wolfie_memory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (
    kind in (
      'grammar_error',
      'pronunciation_issue',
      'vocabulary_gap',
      'structure_in_progress',
      'structure_mastered',
      'strength',
      'goal',
      'preferred_topic',
      'professional_scenario',
      'completed_simulation',
      'personal_story',
      'recommended_strategy'
    )
  ),
  memory_key text not null check (
    char_length(memory_key) between 1 and 160
  ),
  content text not null check (
    char_length(content) between 1 and 2000
  ),
  status text not null default 'active' check (
    status in ('active', 'mastered', 'dismissed')
  ),
  confidence numeric(4, 3) not null default 0.500 check (
    confidence between 0 and 1
  ),
  occurrence_count integer not null default 1 check (
    occurrence_count between 1 and 1000000
  ),
  evidence jsonb not null default '[]'::jsonb check (
    jsonb_typeof(evidence) = 'array'
    and jsonb_array_length(evidence) <= 20
  ),
  sensitive boolean not null default false,
  consented_at timestamptz,
  source_conversation_session_id uuid,
  source_activity_session_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  next_review_at timestamptz,
  mastered_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wolfie_memory_items_scope_fkey
    foreign key (student_id, tenant_id)
    references public.profiles (id, tenant_id)
    on delete cascade,
  constraint wolfie_memory_items_conversation_scope_fkey
    foreign key (
      source_conversation_session_id,
      student_id,
      tenant_id
    )
    references public.wolfie_sessions (id, student_id, tenant_id)
    on delete set null (source_conversation_session_id),
  constraint wolfie_memory_items_activity_scope_fkey
    foreign key (
      source_activity_session_id,
      student_id,
      tenant_id
    )
    references public.wolfie_activity_sessions (id, student_id, tenant_id)
    on delete set null (source_activity_session_id),
  constraint wolfie_memory_items_source_check check (
    num_nonnulls(
      source_conversation_session_id,
      source_activity_session_id
    ) <= 1
  ),
  constraint wolfie_memory_items_consent_check check (
    not sensitive or consented_at is not null
  ),
  constraint wolfie_memory_items_dates_check check (
    last_seen_at >= first_seen_at
    and (mastered_at is null or mastered_at >= first_seen_at)
    and (expires_at is null or expires_at > created_at)
  ),
  unique (student_id, kind, memory_key)
);

create index if not exists idx_wolfie_memory_items_review
  on public.wolfie_memory_items (
    student_id,
    status,
    next_review_at
  )
  where status = 'active';
create index if not exists idx_wolfie_memory_items_tenant_kind
  on public.wolfie_memory_items (
    tenant_id,
    kind,
    last_seen_at desc
  );
create index if not exists idx_wolfie_memory_items_conversation
  on public.wolfie_memory_items (source_conversation_session_id)
  where source_conversation_session_id is not null;
create index if not exists idx_wolfie_memory_items_activity
  on public.wolfie_memory_items (source_activity_session_id)
  where source_activity_session_id is not null;

-- Reports are durable, structured summaries. They let the prompt use a bounded
-- previous-session context rather than replaying every raw transcript.
create table if not exists public.wolfie_session_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  conversation_session_id uuid,
  activity_session_id uuid,
  topic text not null,
  objective text,
  difficulty text,
  accomplishments text[] not null default '{}'::text[],
  primary_corrections jsonb not null default '[]'::jsonb,
  new_vocabulary jsonb not null default '[]'::jsonb,
  recurring_error text,
  best_phrase text,
  review_point text,
  next_step text,
  practice_mission text,
  rubric_scores jsonb not null default '{}'::jsonb,
  generated_by_model text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint wolfie_session_reports_scope_fkey
    foreign key (student_id, tenant_id)
    references public.profiles (id, tenant_id)
    on delete cascade,
  constraint wolfie_session_reports_conversation_scope_fkey
    foreign key (
      conversation_session_id,
      student_id,
      tenant_id
    )
    references public.wolfie_sessions (id, student_id, tenant_id)
    on delete cascade,
  constraint wolfie_session_reports_activity_scope_fkey
    foreign key (
      activity_session_id,
      student_id,
      tenant_id
    )
    references public.wolfie_activity_sessions (id, student_id, tenant_id)
    on delete cascade,
  constraint wolfie_session_reports_source_check check (
    num_nonnulls(conversation_session_id, activity_session_id) = 1
  ),
  constraint wolfie_session_reports_json_shapes_check check (
    jsonb_typeof(primary_corrections) = 'array'
    and jsonb_array_length(primary_corrections) <= 20
    and jsonb_typeof(new_vocabulary) = 'array'
    and jsonb_array_length(new_vocabulary) <= 30
    and jsonb_typeof(rubric_scores) = 'object'
  )
);

create unique index if not exists idx_wolfie_session_reports_conversation
  on public.wolfie_session_reports (conversation_session_id)
  where conversation_session_id is not null;
create unique index if not exists idx_wolfie_session_reports_activity
  on public.wolfie_session_reports (activity_session_id)
  where activity_session_id is not null;
create index if not exists idx_wolfie_session_reports_student_generated
  on public.wolfie_session_reports (student_id, generated_at desc);

create index if not exists idx_wolf_intelligence_tenant_updated
  on public.wolf_intelligence (tenant_id, last_updated_at desc);
create index if not exists idx_wolfie_sessions_student_activity
  on public.wolfie_sessions (student_id, last_activity_at desc);
create index if not exists idx_wolfie_sessions_student_mode_stage
  on public.wolfie_sessions (
    student_id,
    experience_mode,
    current_stage,
    last_activity_at desc
  );
create index if not exists idx_wolfie_turns_session_stage
  on public.wolfie_turns (session_id, stage, turn_index)
  where stage is not null;
create index if not exists idx_wolfie_corrections_session_retry
  on public.wolfie_corrections (session_id, retry_completed, created_at desc);
create index if not exists idx_wolfie_corrections_pending_retry
  on public.wolfie_corrections (session_id, priority, created_at)
  where requires_retry and not retry_completed;

alter table public.wolf_intelligence enable row level security;
alter table public.wolfie_memory_items enable row level security;
alter table public.wolfie_session_reports enable row level security;

drop policy if exists "student_reads_own_wolf_intel"
  on public.wolf_intelligence;
drop policy if exists "students_update_own_wolf_intel"
  on public.wolf_intelligence;
drop policy if exists "students_upsert_own_wolf_intel"
  on public.wolf_intelligence;
drop policy if exists "system_writes_wolf_intel"
  on public.wolf_intelligence;
drop policy if exists "teacher_reads_wolf_intel"
  on public.wolf_intelligence;
drop policy if exists wolf_intelligence_student_select
  on public.wolf_intelligence;
drop policy if exists wolf_intelligence_educator_select
  on public.wolf_intelligence;
create policy wolf_intelligence_student_select
  on public.wolf_intelligence
  for select
  to authenticated
  using (student_id = (select auth.uid()));
create policy wolf_intelligence_educator_select
  on public.wolf_intelligence
  for select
  to authenticated
  using (
    (select public._my_role()) = 'SUPER_ADMIN'
    or (
      tenant_id = (select public._my_tenant_id())
      and (
        (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
        or (
          (select public._my_role()) = 'TEACHER'
          and public._teacher_can_access_student(student_id, tenant_id)
        )
      )
    )
  );

drop policy if exists wolfie_memory_items_student_select
  on public.wolfie_memory_items;
drop policy if exists wolfie_memory_items_educator_select
  on public.wolfie_memory_items;
create policy wolfie_memory_items_student_select
  on public.wolfie_memory_items
  for select
  to authenticated
  using (student_id = (select auth.uid()));
create policy wolfie_memory_items_educator_select
  on public.wolfie_memory_items
  for select
  to authenticated
  using (
    not sensitive
    and (
      (select public._my_role()) = 'SUPER_ADMIN'
      or (
        tenant_id = (select public._my_tenant_id())
        and (
          (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
          or (
            (select public._my_role()) = 'TEACHER'
            and public._teacher_can_access_student(student_id, tenant_id)
          )
        )
      )
    )
  );

drop policy if exists wolfie_session_reports_student_select
  on public.wolfie_session_reports;
drop policy if exists wolfie_session_reports_educator_select
  on public.wolfie_session_reports;
create policy wolfie_session_reports_student_select
  on public.wolfie_session_reports
  for select
  to authenticated
  using (student_id = (select auth.uid()));
create policy wolfie_session_reports_educator_select
  on public.wolfie_session_reports
  for select
  to authenticated
  using (
    (select public._my_role()) = 'SUPER_ADMIN'
    or (
      tenant_id = (select public._my_tenant_id())
      and (
        (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
        or (
          (select public._my_role()) = 'TEACHER'
          and public._teacher_can_access_student(student_id, tenant_id)
        )
      )
    )
  );

-- The Edge Functions are the only authoritative writers. In production the
-- legacy policies allowed students to mint transcript/correction rows and to
-- overwrite score-like session fields directly.
drop policy if exists wolfie_sessions_insert_own
  on public.wolfie_sessions;
drop policy if exists wolfie_sessions_update_own
  on public.wolfie_sessions;
drop policy if exists wolfie_turns_insert_own
  on public.wolfie_turns;
drop policy if exists wolfie_corrections_insert_own
  on public.wolfie_corrections;

drop policy if exists "Everyone can read presets"
  on public.wolfie_presets;
drop policy if exists wolfie_presets_authenticated_read
  on public.wolfie_presets;
create policy wolfie_presets_authenticated_read
  on public.wolfie_presets
  for select
  to authenticated
  using (is_active is true);

-- Students only need to read their memory. Pedagogical writes are normalized
-- and applied by the authenticated Edge Function with the service role.
revoke all on table public.wolf_intelligence
  from public, anon, authenticated;
revoke all on table public.wolfie_memory_items
  from public, anon, authenticated;
revoke all on table public.wolfie_session_reports
  from public, anon, authenticated;
revoke all on table public.wolfie_presets
  from public, anon, authenticated;
revoke all on table public.wolfie_sessions
  from public, anon, authenticated;
revoke all on table public.wolfie_turns
  from public, anon, authenticated;
revoke all on table public.wolfie_corrections
  from public, anon, authenticated;

grant select on table public.wolf_intelligence to authenticated;
grant select on table public.wolfie_memory_items to authenticated;
grant select on table public.wolfie_session_reports to authenticated;
grant select on table public.wolfie_presets to authenticated;
grant select on table public.wolfie_sessions to authenticated;
grant select on table public.wolfie_turns to authenticated;
grant select on table public.wolfie_corrections to authenticated;

grant all on table public.wolf_intelligence to service_role;
grant all on table public.wolfie_memory_items to service_role;
grant all on table public.wolfie_session_reports to service_role;
grant all on table public.wolfie_presets to service_role;
grant all on table public.wolfie_sessions to service_role;
grant all on table public.wolfie_turns to service_role;
grant all on table public.wolfie_corrections to service_role;

drop trigger if exists trg_wolfie_memory_items_updated_at
  on public.wolfie_memory_items;
create trigger trg_wolfie_memory_items_updated_at
before update on public.wolfie_memory_items
for each row execute function public.set_wolfie_activity_updated_at();

comment on table public.wolf_intelligence is
  'Compact compatibility snapshot of the student pedagogical profile. Detailed evidence lives in wolfie_memory_items.';
comment on table public.wolfie_memory_items is
  'Selective pedagogical memories with evidence, recurrence, consent and spaced-review scheduling; never a raw transcript dump.';
comment on table public.wolfie_session_reports is
  'Bounded end-of-session report used for continuity without replaying all raw turns.';
comment on column public.wolfie_turns.structured_payload is
  'Normalized learner-visible feedback, next action and stage metadata for this turn.';
comment on column public.wolfie_sessions.scenario_context is
  'Bounded session scenario and objective supplied by the application; treated as untrusted learning data.';
comment on column public.wolfie_corrections.retry_turn_id is
  'Student turn that proves the required new attempt was actually made.';
comment on column public.wolfie_activity_attempts.parent_attempt_id is
  'Original attempt retried by this row; populated only for attempt_kind=retry.';

select pg_notify('pgrst', 'reload schema');
