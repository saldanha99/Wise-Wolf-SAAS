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

create or replace function pg_temp.meeting_feedback(
  overall_score integer,
  task_score integer
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'score', overall_score,
    'requiresRetry', false,
    'rubric', jsonb_build_object(
      'taskCompletion', task_score,
      'structureAndFacilitation', 80,
      'interactionAndTurnTaking', 80,
      'clarificationAndQuestionHandling', 80,
      'diplomacyAndNegotiation', 80,
      'clarityAndConcision', 80,
      'accuracyAndNaturalness', 80,
      'decisionAndActionableClose', 80
    ),
    'modelNarrative', 'must never become memory evidence'
  );
$$;

create or replace function pg_temp.meeting_memory_candidates(
  source_attempt_id uuid,
  include_untrusted_fields boolean default false
)
returns jsonb
language sql
stable
as $$
  select jsonb_agg(
    jsonb_build_object(
      'kind', candidate.candidate_kind,
      'memoryKey', candidate.candidate_memory_key,
      'content', candidate.candidate_content,
      'confidence', candidate.candidate_confidence,
      'evidence', case
        when include_untrusted_fields then
          candidate.candidate_evidence || jsonb_build_object(
            'rawTranscript', 'private learner text',
            'modelFeedback', 'untrusted narrative'
          )
        else candidate.candidate_evidence
      end
    ) order by candidate.candidate_memory_key
  )
  from private.wolfie_meeting_memory_candidates(source_attempt_id)
    as candidate;
$$;

insert into public.tenants (id, name)
values ('wolfie-meeting-memory-test', 'Wolfie Meeting Memory Test');

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
  '00000000-0000-4000-8000-000000000921',
  'authenticated',
  'authenticated',
  'wolfie-meeting-memory@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Wolfie Meeting Memory"}',
  now(),
  now()
);

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'wolfie-meeting-memory-test',
       role = 'STUDENT',
       lifecycle_status = 'active',
       is_test_account = false,
       test_fixture_key = 'wolfie-meeting-memory-sql'
 where id = '00000000-0000-4000-8000-000000000921';
set local app.enrollment_claim = '';

insert into public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary
)
values (
  '00000000-0000-4000-8000-000000000921',
  'wolfie-meeting-memory-test',
  'STUDENT',
  'ACTIVE',
  true
)
on conflict (user_id, tenant_id) do update
  set role = excluded.role,
      status = excluded.status,
      is_primary = excluded.is_primary,
      updated_at = now();

insert into public.wolfie_activity_sessions (
  id,
  tenant_id,
  student_id,
  subject,
  cefr_level,
  phase,
  modality,
  request_key
)
values (
  '00000000-0000-4000-8000-000000000922',
  'wolfie-meeting-memory-test',
  '00000000-0000-4000-8000-000000000921',
  'global_meetings',
  'B2',
  'standard',
  'text',
  '00000000-0000-4000-8000-000000000923'
);

insert into public.wolfie_memory_items (
  tenant_id,
  student_id,
  kind,
  memory_key,
  content,
  status,
  confidence,
  occurrence_count,
  evidence,
  sensitive
)
values (
  'wolfie-meeting-memory-test',
  '00000000-0000-4000-8000-000000000921',
  'recommended_strategy',
  'meeting:00000000-0000-4000-8000-000000000921:taskCompletion:recommended_strategy',
  'Legacy guided memory that must be replaced.',
  'dismissed',
  0.5,
  1,
  '[]',
  false
);

-- A rolled-back Edge Function may still send the former assessment shape.
-- The attempt remains authoritative, while memory creation fails closed.
insert into public.wolfie_activity_attempts (
  id,
  session_id,
  tenant_id,
  student_id,
  request_key,
  attempt_number,
  step_key,
  modality,
  feedback_payload,
  score,
  requires_retry
)
values (
  '00000000-0000-4000-8000-000000000929',
  '00000000-0000-4000-8000-000000000922',
  'wolfie-meeting-memory-test',
  '00000000-0000-4000-8000-000000000921',
  '00000000-0000-4000-8000-000000000930',
  99,
  'final',
  'text',
  '{"legacyAssessment":true}',
  50,
  false
);
select pg_temp.assert_true(
  exists (
    select 1
      from public.wolfie_activity_attempts
     where id = '00000000-0000-4000-8000-000000000929'
  ) and not exists (
    select 1
      from public.wolfie_meeting_memory_receipts
     where attempt_id = '00000000-0000-4000-8000-000000000929'
  ),
  'legacy attempt shapes must persist without creating unverified memories'
);

-- The AFTER INSERT trigger must create the memories atomically with the
-- authoritative attempt, before the compatibility RPC is called.
insert into public.wolfie_activity_attempts (
  id,
  session_id,
  tenant_id,
  student_id,
  request_key,
  attempt_number,
  step_key,
  modality,
  feedback_payload,
  score,
  requires_retry
)
values (
  '00000000-0000-4000-8000-000000000924',
  '00000000-0000-4000-8000-000000000922',
  'wolfie-meeting-memory-test',
  '00000000-0000-4000-8000-000000000921',
  '00000000-0000-4000-8000-000000000925',
  1,
  'final',
  'text',
  pg_temp.meeting_feedback(78, 70),
  78,
  false
);

select pg_temp.assert_true(
  (
    select count(*) = 1
       and max(occurrence_count) = 1
       and max(jsonb_array_length(evidence)) = 1
       and max(content) =
         'State the meeting objective, expected outcome, and main request explicitly.'
      from public.wolfie_memory_items
     where tenant_id = 'wolfie-meeting-memory-test'
       and student_id = '00000000-0000-4000-8000-000000000921'
       and memory_key =
         'meeting:00000000-0000-4000-8000-000000000921:taskCompletion:recommended_strategy'
  ),
  'persisting an eligible attempt must atomically persist its memory'
);

-- The legacy Edge call is now only a validator/replay. Untrusted extra fields
-- are accepted for compatibility but never copied into evidence.
select public.record_wolfie_meeting_memories(
  'wolfie-meeting-memory-test',
  '00000000-0000-4000-8000-000000000921',
  '00000000-0000-4000-8000-000000000922',
  '00000000-0000-4000-8000-000000000924',
  pg_temp.meeting_memory_candidates(
    '00000000-0000-4000-8000-000000000924',
    true
  )
);

select pg_temp.assert_true(
  (
    select occurrence_count = 1
       and jsonb_array_length(evidence) = 1
       and evidence -> 0 ->> 'stepKey' = 'final'
       and not (evidence -> 0 ? 'rawTranscript')
       and not (evidence -> 0 ? 'modelFeedback')
      from public.wolfie_memory_items
     where tenant_id = 'wolfie-meeting-memory-test'
       and student_id = '00000000-0000-4000-8000-000000000921'
       and memory_key =
         'meeting:00000000-0000-4000-8000-000000000921:taskCompletion:recommended_strategy'
  ),
  'replay must be idempotent and evidence must be reconstructed/sanitized'
);

-- A distinct persisted checkpoint is genuine recurrence.
insert into public.wolfie_activity_attempts (
  id,
  session_id,
  tenant_id,
  student_id,
  request_key,
  attempt_number,
  step_key,
  modality,
  feedback_payload,
  score,
  requires_retry
)
values (
  '00000000-0000-4000-8000-000000000926',
  '00000000-0000-4000-8000-000000000922',
  'wolfie-meeting-memory-test',
  '00000000-0000-4000-8000-000000000921',
  '00000000-0000-4000-8000-000000000927',
  2,
  'readaptation',
  'text',
  pg_temp.meeting_feedback(82, 72),
  82,
  false
);

select pg_temp.assert_true(
  (
    select occurrence_count = 2
       and jsonb_array_length(evidence) = 2
       and status = 'active'
       and sensitive is false
       and expires_at > now()
      from public.wolfie_memory_items
     where tenant_id = 'wolfie-meeting-memory-test'
       and student_id = '00000000-0000-4000-8000-000000000921'
       and memory_key =
         'meeting:00000000-0000-4000-8000-000000000921:taskCompletion:recommended_strategy'
  ),
  'a distinct assessed attempt must update bounded recurrence evidence'
);

-- A durable receipt outlives the bounded evidence array. Fill past 20, then
-- replay the first attempt and prove occurrence_count cannot increase.
do $test$
declare
  attempt_number integer;
begin
  for attempt_number in 3..23 loop
    insert into public.wolfie_activity_attempts (
      id,
      session_id,
      tenant_id,
      student_id,
      request_key,
      attempt_number,
      step_key,
      modality,
      feedback_payload,
      score,
      requires_retry
    ) values (
      gen_random_uuid(),
      '00000000-0000-4000-8000-000000000922',
      'wolfie-meeting-memory-test',
      '00000000-0000-4000-8000-000000000921',
      gen_random_uuid(),
      attempt_number,
      'readaptation',
      'text',
      pg_temp.meeting_feedback(80, 70 + (attempt_number % 4)),
      80,
      false
    );
  end loop;
end;
$test$;

select pg_temp.assert_true(
  (
    select occurrence_count = 23 and jsonb_array_length(evidence) = 20
      from public.wolfie_memory_items
     where tenant_id = 'wolfie-meeting-memory-test'
       and student_id = '00000000-0000-4000-8000-000000000921'
       and memory_key =
         'meeting:00000000-0000-4000-8000-000000000921:taskCompletion:recommended_strategy'
  ),
  'meeting evidence must stay bounded while recurrence remains accurate'
);

select public.record_wolfie_meeting_memories(
  'wolfie-meeting-memory-test',
  '00000000-0000-4000-8000-000000000921',
  '00000000-0000-4000-8000-000000000922',
  '00000000-0000-4000-8000-000000000924',
  pg_temp.meeting_memory_candidates(
    '00000000-0000-4000-8000-000000000924'
  )
);

select pg_temp.assert_true(
  (
    select occurrence_count = 23
       and jsonb_array_length(evidence) = 20
      from public.wolfie_memory_items
     where tenant_id = 'wolfie-meeting-memory-test'
       and student_id = '00000000-0000-4000-8000-000000000921'
       and memory_key =
         'meeting:00000000-0000-4000-8000-000000000921:taskCompletion:recommended_strategy'
  ) and (
    select count(*) = 23
      from public.wolfie_meeting_memory_receipts
     where tenant_id = 'wolfie-meeting-memory-test'
       and student_id = '00000000-0000-4000-8000-000000000921'
       and memory_key =
         'meeting:00000000-0000-4000-8000-000000000921:taskCompletion:recommended_strategy'
  ),
  'an attempt receipt must prevent replay after evidence eviction'
);

do $test$
begin
  perform public.record_wolfie_meeting_memories(
    'wolfie-meeting-memory-test',
    '00000000-0000-4000-8000-000000000921',
    '00000000-0000-4000-8000-000000000922',
    '00000000-0000-4000-8000-000000000926',
    jsonb_set(
      pg_temp.meeting_memory_candidates(
        '00000000-0000-4000-8000-000000000926'
      ),
      '{0,content}',
      '"Discuss confidential Project X"'::jsonb
    )
  );
  raise exception 'noncanonical meeting memory was accepted';
exception
  when sqlstate '22023' then null;
end;
$test$;

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.record_wolfie_meeting_memories(text,uuid,uuid,uuid,jsonb)',
    'EXECUTE'
  ) and has_function_privilege(
    'service_role',
    'public.record_wolfie_meeting_memories(text,uuid,uuid,uuid,jsonb)',
    'EXECUTE'
  ),
  'only service role may call the compatibility memory RPC'
);

rollback;
