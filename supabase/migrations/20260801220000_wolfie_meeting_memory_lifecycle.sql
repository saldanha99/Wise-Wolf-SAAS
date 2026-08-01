-- Canonical global-meeting memories are derived from authoritative persisted
-- attempts. Raw learner/model text never crosses this write boundary.

create table if not exists public.wolfie_meeting_memory_receipts (
  attempt_id uuid not null,
  source_session_id uuid not null,
  tenant_id text not null,
  student_id uuid not null,
  memory_key text not null check (
    pg_catalog.char_length(memory_key) between 1 and 160
  ),
  dimension text not null check (
    dimension in (
      'taskCompletion',
      'structureAndFacilitation',
      'interactionAndTurnTaking',
      'clarificationAndQuestionHandling',
      'diplomacyAndNegotiation',
      'clarityAndConcision',
      'accuracyAndNaturalness',
      'decisionAndActionableClose'
    )
  ),
  kind text not null check (
    kind in ('strength', 'recommended_strategy', 'structure_in_progress')
  ),
  memory_item_id uuid references public.wolfie_memory_items(id)
    on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (attempt_id, memory_key),
  constraint wolfie_meeting_memory_receipts_attempt_scope_fkey
    foreign key (attempt_id, source_session_id, student_id, tenant_id)
    references public.wolfie_activity_attempts (
      id,
      session_id,
      student_id,
      tenant_id
    )
    on delete cascade
);

create index if not exists idx_wolfie_meeting_memory_receipts_student
  on public.wolfie_meeting_memory_receipts (
    tenant_id,
    student_id,
    created_at desc
  );

alter table public.wolfie_meeting_memory_receipts enable row level security;
revoke all on table public.wolfie_meeting_memory_receipts
  from public, anon, authenticated;
grant all on table public.wolfie_meeting_memory_receipts to service_role;

comment on table public.wolfie_meeting_memory_receipts is
  'Service-only durable idempotency receipts for canonical meeting memories; contains no learner or model text.';

-- This is the only candidate builder. It validates the durable checkpoint and
-- reconstructs every score, rubric dimension, kind, key and evidence object
-- from the stored attempt. Free-form feedback and response payloads are never
-- copied into memory evidence.
create or replace function private.wolfie_meeting_memory_candidates(
  p_attempt_id uuid
)
returns table (
  candidate_tenant_id text,
  candidate_student_id uuid,
  candidate_source_session_id uuid,
  candidate_attempt_id uuid,
  candidate_kind text,
  candidate_dimension text,
  candidate_memory_key text,
  candidate_content text,
  candidate_confidence numeric,
  candidate_evidence jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_attempt public.wolfie_activity_attempts%rowtype;
  v_subject text;
  v_rubric jsonb;
  v_canonical_rubric jsonb := '{}'::jsonb;
  v_rubric_dimension text;
  v_dimension_score numeric;
  v_feedback_score numeric;
  v_feedback_requires_retry boolean;
begin
  if p_attempt_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_wolfie_meeting_attempt';
  end if;

  select attempt.*
    into v_attempt
    from public.wolfie_activity_attempts as attempt
   where attempt.id = p_attempt_id;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'wolfie_meeting_attempt_not_found';
  end if;

  select session.subject
    into v_subject
    from public.wolfie_activity_sessions as session
   where session.id = v_attempt.session_id
     and session.tenant_id = v_attempt.tenant_id
     and session.student_id = v_attempt.student_id;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'invalid_wolfie_meeting_memory_lineage';
  end if;

  if v_subject <> 'global_meetings'
     or v_attempt.step_key is null
     or v_attempt.step_key not in (
       'final',
       'final_speech',
       'memorization_complete',
       'readaptation',
       'readaptation_speech'
     ) then
    return;
  end if;

  if not exists (
    select 1
      from public.tenant_memberships as membership
     where membership.tenant_id = v_attempt.tenant_id
       and membership.user_id = v_attempt.student_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    raise exception using
      errcode = '42501',
      message = 'inactive_wolfie_meeting_memory_membership';
  end if;

  if pg_catalog.jsonb_typeof(v_attempt.feedback_payload) <> 'object'
     or pg_catalog.jsonb_typeof(v_attempt.feedback_payload -> 'score')
       is distinct from 'number'
     or pg_catalog.jsonb_typeof(
       v_attempt.feedback_payload -> 'requiresRetry'
     ) is distinct from 'boolean'
     or pg_catalog.jsonb_typeof(v_attempt.feedback_payload -> 'rubric')
       is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'invalid_persisted_wolfie_meeting_assessment';
  end if;

  begin
    v_feedback_score := (v_attempt.feedback_payload ->> 'score')::numeric;
    v_feedback_requires_retry :=
      (v_attempt.feedback_payload ->> 'requiresRetry')::boolean;
  exception when others then
    raise exception using
      errcode = '22023',
      message = 'invalid_persisted_wolfie_meeting_assessment';
  end;

  if v_feedback_score not between 0 and 100
     or v_feedback_score <> v_attempt.score
     or v_feedback_requires_retry is distinct from v_attempt.requires_retry then
    raise exception using
      errcode = '22023',
      message = 'inconsistent_persisted_wolfie_meeting_assessment';
  end if;

  v_rubric := v_attempt.feedback_payload -> 'rubric';
  foreach v_rubric_dimension in array array[
    'taskCompletion',
    'structureAndFacilitation',
    'interactionAndTurnTaking',
    'clarificationAndQuestionHandling',
    'diplomacyAndNegotiation',
    'clarityAndConcision',
    'accuracyAndNaturalness',
    'decisionAndActionableClose'
  ]
  loop
    if pg_catalog.jsonb_typeof(v_rubric -> v_rubric_dimension)
         is distinct from 'number' then
      raise exception using
        errcode = '22023',
        message = 'invalid_persisted_wolfie_meeting_rubric';
    end if;
    begin
      v_dimension_score := (v_rubric ->> v_rubric_dimension)::numeric;
    exception when others then
      raise exception using
        errcode = '22023',
        message = 'invalid_persisted_wolfie_meeting_rubric';
    end;
    if v_dimension_score not between 0 and 100 then
      raise exception using
        errcode = '22023',
        message = 'invalid_persisted_wolfie_meeting_rubric';
    end if;
    v_canonical_rubric := v_canonical_rubric
      || pg_catalog.jsonb_build_object(
        v_rubric_dimension,
        v_dimension_score
      );
  end loop;

  return query
  with rubric_dimensions as (
    select
      ordered.dimension_name,
      ordered.dimension_order::integer as dimension_order,
      (v_canonical_rubric ->> ordered.dimension_name)::numeric
        as dimension_score
    from pg_catalog.unnest(array[
      'taskCompletion',
      'structureAndFacilitation',
      'interactionAndTurnTaking',
      'clarificationAndQuestionHandling',
      'diplomacyAndNegotiation',
      'clarityAndConcision',
      'accuracyAndNaturalness',
      'decisionAndActionableClose'
    ]::text[]) with ordinality
      as ordered(dimension_name, dimension_order)
  ), priorities as (
    select
      dimension_name,
      dimension_order,
      dimension_score,
      0 as group_order,
      pg_catalog.row_number() over (
        order by dimension_score, dimension_order
      )::integer as candidate_order
    from rubric_dimensions
    where dimension_score < 75
    order by candidate_order
    limit 3
  ), strengths as (
    select
      dimension_name,
      dimension_order,
      dimension_score,
      1 as group_order,
      pg_catalog.row_number() over (
        order by dimension_score desc, dimension_order
      )::integer as candidate_order
    from rubric_dimensions
    where dimension_score >= 75
    order by candidate_order
    limit 2
  ), selected_dimensions as (
    select * from priorities
    union all
    select * from strengths
  )
  select
    v_attempt.tenant_id,
    v_attempt.student_id,
    v_attempt.session_id,
    v_attempt.id,
    case
      when selected.dimension_score >= 75 then 'strength'
      when v_attempt.requires_retry then 'structure_in_progress'
      else 'recommended_strategy'
    end,
    selected.dimension_name,
    pg_catalog.concat(
      'meeting:',
      v_attempt.student_id::text,
      ':',
      selected.dimension_name,
      ':',
      case
        when selected.dimension_score >= 75 then 'strength'
        when v_attempt.requires_retry then 'structure_in_progress'
        else 'recommended_strategy'
      end
    ),
    case selected.dimension_name
      when 'taskCompletion' then
        case when selected.dimension_score >= 75
          then 'Keep the meeting objective, expected outcome, and main request explicit.'
          else 'State the meeting objective, expected outcome, and main request explicitly.' end
      when 'structureAndFacilitation' then
        case when selected.dimension_score >= 75
          then 'Keep facilitating the meeting through a clear, signposted sequence.'
          else 'Use a clear sequence: opening, context, evidence, proposal, next steps, and close.' end
      when 'interactionAndTurnTaking' then
        case when selected.dimension_score >= 75
          then 'Keep inviting contributions and managing turn-taking explicitly.'
          else 'Invite contributions, manage turn-taking, and acknowledge other participants.' end
      when 'clarificationAndQuestionHandling' then
        case when selected.dimension_score >= 75
          then 'Keep clarifying questions and confirming shared understanding.'
          else 'Clarify questions before answering and confirm shared understanding.' end
      when 'diplomacyAndNegotiation' then
        case when selected.dimension_score >= 75
          then 'Keep using diplomatic language when negotiating or disagreeing.'
          else 'Use diplomatic language to disagree, negotiate, and propose alternatives.' end
      when 'clarityAndConcision' then
        case when selected.dimension_score >= 75
          then 'Keep contributions concise, specific, and easy to act on.'
          else 'Make each contribution concise, specific, and easy to act on.' end
      when 'accuracyAndNaturalness' then
        case when selected.dimension_score >= 75
          then 'Keep using accurate, natural English without sacrificing fluency.'
          else 'Use accurate, natural English while preserving fluency.' end
      when 'decisionAndActionableClose' then
        case when selected.dimension_score >= 75
          then 'Keep closing with a decision, owner, deadline, and next step.'
          else 'Close with the decision, owner, deadline, and verifiable next step.' end
    end,
    case when selected.dimension_score >= 75 then 0.8 else 0.85 end::numeric,
    pg_catalog.jsonb_build_object(
      'basis', 'session_assessment',
      'policyVersion', 1,
      'attemptId', v_attempt.id,
      'stepKey', v_attempt.step_key,
      'score', v_attempt.score,
      'dimension', selected.dimension_name,
      'dimensionScore', selected.dimension_score,
      'rubric', v_canonical_rubric
    )
  from selected_dimensions as selected
  order by selected.group_order, selected.candidate_order;
end;
$function$;

revoke all on function private.wolfie_meeting_memory_candidates(uuid)
  from public, anon, authenticated, service_role;

-- Durable receipts are inserted before the memory mutation in the same
-- transaction. A failure rolls both back; a replay remains idempotent even
-- after its evidence has aged out of the bounded 20-item JSON array.
create or replace function private.persist_wolfie_meeting_attempt_memories(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate record;
  v_existing public.wolfie_memory_items%rowtype;
  v_combined_evidence jsonb;
  v_receipt_attempt_id uuid;
  v_memory_item_id uuid;
  v_candidate_count integer := 0;
  v_recorded integer := 0;
  v_replayed integer := 0;
begin
  for v_candidate in
    select *
      from private.wolfie_meeting_memory_candidates(p_attempt_id)
  loop
    v_candidate_count := v_candidate_count + 1;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_candidate.candidate_tenant_id
          || ':'
          || v_candidate.candidate_student_id::text
          || ':'
          || v_candidate.candidate_memory_key,
        0
      )
    );

    v_receipt_attempt_id := null;
    insert into public.wolfie_meeting_memory_receipts (
      attempt_id,
      source_session_id,
      tenant_id,
      student_id,
      memory_key,
      dimension,
      kind
    ) values (
      v_candidate.candidate_attempt_id,
      v_candidate.candidate_source_session_id,
      v_candidate.candidate_tenant_id,
      v_candidate.candidate_student_id,
      v_candidate.candidate_memory_key,
      v_candidate.candidate_dimension,
      v_candidate.candidate_kind
    )
    on conflict (attempt_id, memory_key) do nothing
    returning attempt_id into v_receipt_attempt_id;

    if v_receipt_attempt_id is null then
      v_replayed := v_replayed + 1;
      continue;
    end if;

    select memory.*
      into v_existing
      from public.wolfie_memory_items as memory
     where memory.tenant_id = v_candidate.candidate_tenant_id
       and memory.student_id = v_candidate.candidate_student_id
       and memory.kind = v_candidate.candidate_kind
       and memory.memory_key = v_candidate.candidate_memory_key
     for update;

    if found then
      if pg_catalog.jsonb_typeof(v_existing.evidence) = 'array' then
        v_combined_evidence := v_existing.evidence
          || pg_catalog.jsonb_build_array(v_candidate.candidate_evidence);
      else
        v_combined_evidence :=
          pg_catalog.jsonb_build_array(v_candidate.candidate_evidence);
      end if;

      if pg_catalog.jsonb_array_length(v_combined_evidence) > 20 then
        select coalesce(
                 pg_catalog.jsonb_agg(entry.value order by entry.ordinality),
                 '[]'::jsonb
               )
          into v_combined_evidence
          from pg_catalog.jsonb_array_elements(v_combined_evidence)
            with ordinality as entry(value, ordinality)
         where entry.ordinality >
           pg_catalog.jsonb_array_length(v_combined_evidence) - 20;
      end if;

      update public.wolfie_memory_items
         set content = v_candidate.candidate_content,
             status = 'active',
             confidence = v_candidate.candidate_confidence,
             occurrence_count = case
               when v_existing.status = 'dismissed'
                and v_existing.occurrence_count = 1
                and v_existing.evidence = '[]'::jsonb
                and v_existing.source_conversation_session_id is null
                and v_existing.source_activity_session_id is null
                and v_existing.next_review_at is null
                and v_existing.expires_at is null
                 then 1
               else least(
                 coalesce(occurrence_count, 1) + 1,
                 1000000
               )
             end,
             evidence = v_combined_evidence,
             sensitive = false,
             consented_at = null,
             source_conversation_session_id = null,
             source_activity_session_id =
               v_candidate.candidate_source_session_id,
             last_seen_at = pg_catalog.now(),
             next_review_at = pg_catalog.now() + interval '30 days',
             mastered_at = null,
             expires_at = pg_catalog.now() + interval '180 days',
             updated_at = pg_catalog.now()
       where id = v_existing.id
       returning id into v_memory_item_id;
    else
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
        sensitive,
        consented_at,
        source_conversation_session_id,
        source_activity_session_id,
        next_review_at,
        expires_at
      ) values (
        v_candidate.candidate_tenant_id,
        v_candidate.candidate_student_id,
        v_candidate.candidate_kind,
        v_candidate.candidate_memory_key,
        v_candidate.candidate_content,
        'active',
        v_candidate.candidate_confidence,
        1,
        pg_catalog.jsonb_build_array(v_candidate.candidate_evidence),
        false,
        null,
        null,
        v_candidate.candidate_source_session_id,
        pg_catalog.now() + interval '30 days',
        pg_catalog.now() + interval '180 days'
      )
      returning id into v_memory_item_id;
    end if;

    update public.wolfie_meeting_memory_receipts
       set memory_item_id = v_memory_item_id
     where attempt_id = v_candidate.candidate_attempt_id
       and memory_key = v_candidate.candidate_memory_key;
    v_recorded := v_recorded + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'eligible', v_candidate_count > 0,
    'recorded', v_recorded,
    'replayed', v_replayed
  );
end;
$function$;

revoke all on function private.persist_wolfie_meeting_attempt_memories(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.capture_wolfie_meeting_attempt_memories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  begin
    perform private.persist_wolfie_meeting_attempt_memories(new.id);
  exception when sqlstate '22023' then
    -- A rolled-back Edge Function may still persist the former assessment
    -- shape. Keep that authoritative attempt, but fail closed by creating no
    -- memory. Permission, lineage, constraint and storage failures still abort
    -- the transaction.
    null;
  end;
  return new;
end;
$function$;

revoke all on function private.capture_wolfie_meeting_attempt_memories()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_capture_wolfie_meeting_attempt_memories
  on public.wolfie_activity_attempts;
create trigger trg_capture_wolfie_meeting_attempt_memories
after insert on public.wolfie_activity_attempts
for each row
execute function private.capture_wolfie_meeting_attempt_memories();

-- Compatibility RPC for the currently deployed Edge Function. The caller's
-- candidate list is verified against the persisted attempt, but all stored
-- evidence is rebuilt by the private processor above. Extra caller fields are
-- deliberately discarded.
create or replace function public.record_wolfie_meeting_memories(
  p_tenant_id text,
  p_student_id uuid,
  p_source_session_id uuid,
  p_attempt_id uuid,
  p_memories jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate jsonb;
  v_candidate_evidence jsonb;
  v_expected record;
  v_expected_count integer;
  v_unique_key_count integer;
  v_rubric_dimension text;
begin
  if p_tenant_id is null
     or p_student_id is null
     or p_source_session_id is null
     or p_attempt_id is null
     or pg_catalog.jsonb_typeof(p_memories) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_memories) not between 1 and 5 then
    raise exception using
      errcode = '22023',
      message = 'invalid_wolfie_meeting_memory_batch';
  end if;

  select *
    into v_expected
    from private.wolfie_meeting_memory_candidates(p_attempt_id)
   limit 1;
  if not found then
    raise exception using
      errcode = '22023',
      message = 'non_durable_wolfie_meeting_attempt';
  end if;
  if v_expected.candidate_tenant_id is distinct from p_tenant_id
     or v_expected.candidate_student_id is distinct from p_student_id
     or v_expected.candidate_source_session_id
       is distinct from p_source_session_id then
    raise exception using
      errcode = '23503',
      message = 'invalid_wolfie_meeting_memory_lineage';
  end if;

  select pg_catalog.count(*)::integer
    into v_expected_count
    from private.wolfie_meeting_memory_candidates(p_attempt_id);
  if pg_catalog.jsonb_array_length(p_memories) <> v_expected_count then
    raise exception using
      errcode = '22023',
      message = 'incomplete_wolfie_meeting_memory_batch';
  end if;

  for v_candidate in
    select value from pg_catalog.jsonb_array_elements(p_memories)
  loop
    if pg_catalog.jsonb_typeof(v_candidate) <> 'object'
       or pg_catalog.jsonb_typeof(v_candidate -> 'evidence')
         is distinct from 'object'
       or pg_catalog.jsonb_typeof(v_candidate -> 'confidence')
         is distinct from 'number' then
      raise exception using
        errcode = '22023',
        message = 'invalid_wolfie_meeting_memory_candidate';
    end if;

    v_candidate_evidence := v_candidate -> 'evidence';
    select *
      into v_expected
      from private.wolfie_meeting_memory_candidates(p_attempt_id) as expected
     where expected.candidate_memory_key = v_candidate ->> 'memoryKey'
       and expected.candidate_kind = v_candidate ->> 'kind'
       and expected.candidate_dimension =
         v_candidate_evidence ->> 'dimension';
    if not found then
      raise exception using
        errcode = '22023',
        message = 'invalid_wolfie_meeting_memory_identity';
    end if;

    if v_candidate ->> 'content'
         is distinct from v_expected.candidate_content
       or (v_candidate ->> 'confidence')::numeric
         is distinct from v_expected.candidate_confidence
       or v_candidate_evidence ->> 'basis'
         is distinct from 'session_assessment'
       or v_candidate_evidence ->> 'policyVersion' is distinct from '1'
       or v_candidate_evidence ->> 'attemptId'
         is distinct from p_attempt_id::text
       or pg_catalog.jsonb_typeof(v_candidate_evidence -> 'score')
         is distinct from 'number'
       or (v_candidate_evidence ->> 'score')::numeric
         is distinct from
           (v_expected.candidate_evidence ->> 'score')::numeric
       or pg_catalog.jsonb_typeof(v_candidate_evidence -> 'dimensionScore')
         is distinct from 'number'
       or (v_candidate_evidence ->> 'dimensionScore')::numeric
         is distinct from
           (v_expected.candidate_evidence ->> 'dimensionScore')::numeric
       or pg_catalog.jsonb_typeof(v_candidate_evidence -> 'rubric')
         is distinct from 'object' then
      raise exception using
        errcode = '22023',
        message = 'invalid_wolfie_meeting_memory_evidence';
    end if;

    foreach v_rubric_dimension in array array[
      'taskCompletion',
      'structureAndFacilitation',
      'interactionAndTurnTaking',
      'clarificationAndQuestionHandling',
      'diplomacyAndNegotiation',
      'clarityAndConcision',
      'accuracyAndNaturalness',
      'decisionAndActionableClose'
    ]
    loop
      if pg_catalog.jsonb_typeof(
           v_candidate_evidence -> 'rubric' -> v_rubric_dimension
         ) is distinct from 'number'
         or (
           v_candidate_evidence -> 'rubric' ->> v_rubric_dimension
         )::numeric is distinct from (
           v_expected.candidate_evidence
             -> 'rubric'
             ->> v_rubric_dimension
         )::numeric then
        raise exception using
          errcode = '22023',
          message = 'invalid_wolfie_meeting_memory_rubric';
      end if;
    end loop;
  end loop;

  select pg_catalog.count(distinct candidate.value ->> 'memoryKey')::integer
    into v_unique_key_count
    from pg_catalog.jsonb_array_elements(p_memories) as candidate(value);
  if v_unique_key_count <> v_expected_count then
    raise exception using
      errcode = '22023',
      message = 'duplicate_wolfie_meeting_memory_candidate';
  end if;

  return private.persist_wolfie_meeting_attempt_memories(p_attempt_id);
end;
$function$;

revoke all on function public.record_wolfie_meeting_memories(
  text,
  uuid,
  uuid,
  uuid,
  jsonb
) from public, anon, authenticated;
grant execute on function public.record_wolfie_meeting_memories(
  text,
  uuid,
  uuid,
  uuid,
  jsonb
) to service_role;

comment on function public.record_wolfie_meeting_memories(
  text,
  uuid,
  uuid,
  uuid,
  jsonb
) is
  'Compatibility validator for canonical meeting memories; durable writes are derived atomically from the persisted activity attempt.';

-- Earlier builds could create a canonical-looking meeting memory from a
-- guided construction step. Fail closed before reconciliation: preserve the
-- pedagogical text row, but remove its unverifiable recurrence/evidence and
-- make it ineligible for recall. A verified durable attempt below reactivates
-- the same row and starts occurrence_count at one.
update public.wolfie_memory_items as memory
   set status = 'dismissed',
       occurrence_count = 1,
       evidence = '[]'::jsonb,
       source_conversation_session_id = null,
       source_activity_session_id = null,
       next_review_at = null,
       mastered_at = null,
       expires_at = null,
       updated_at = pg_catalog.now()
 where memory.kind in (
       'strength',
       'recommended_strategy',
       'structure_in_progress'
     )
   and pg_catalog.split_part(memory.memory_key, ':', 1) = 'meeting'
   and pg_catalog.split_part(memory.memory_key, ':', 2) =
     memory.student_id::text
   and pg_catalog.split_part(memory.memory_key, ':', 3) in (
     'taskCompletion',
     'structureAndFacilitation',
     'interactionAndTurnTaking',
     'clarificationAndQuestionHandling',
     'diplomacyAndNegotiation',
     'clarityAndConcision',
     'accuracyAndNaturalness',
     'decisionAndActionableClose'
   )
   and memory.memory_key = pg_catalog.concat(
     'meeting:',
     memory.student_id::text,
     ':',
     pg_catalog.split_part(memory.memory_key, ':', 3),
     ':',
     memory.kind
   );

delete from public.wolfie_meeting_memory_receipts as receipt
 where exists (
   select 1
     from public.wolfie_memory_items as memory
    where memory.tenant_id = receipt.tenant_id
      and memory.student_id = receipt.student_id
      and memory.memory_key = receipt.memory_key
      and memory.kind = receipt.kind
      and memory.status = 'dismissed'
      and memory.occurrence_count = 1
      and memory.evidence = '[]'::jsonb
      and memory.kind in (
        'strength',
        'recommended_strategy',
        'structure_in_progress'
      )
      and memory.memory_key = pg_catalog.concat(
        'meeting:',
        memory.student_id::text,
        ':',
        receipt.dimension,
        ':',
        memory.kind
      )
 );

-- Reconcile eligible attempts written before this trigger existed. Invalid or
-- noncanonical historical assessments are skipped without weakening the
-- strict trigger used by all new attempts.
do $reconcile$
declare
  v_attempt record;
begin
  for v_attempt in
    select attempt.id
      from public.wolfie_activity_attempts as attempt
      join public.wolfie_activity_sessions as session
        on session.id = attempt.session_id
       and session.tenant_id = attempt.tenant_id
       and session.student_id = attempt.student_id
     where session.subject = 'global_meetings'
       and attempt.step_key in (
         'final',
         'final_speech',
         'memorization_complete',
         'readaptation',
         'readaptation_speech'
       )
     order by attempt.created_at, attempt.id
  loop
    begin
      perform private.persist_wolfie_meeting_attempt_memories(v_attempt.id);
    exception
      when sqlstate '22023' or sqlstate '42501' then null;
    end;
  end loop;
end;
$reconcile$;
