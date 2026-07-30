set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- Wolfie can be installed without the optional Planner release. Reuse the
-- same pgvector shape when it exists and provide the minimal server-only RAG
-- infrastructure when it does not.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.ai_knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  provider text not null default 'OPENROUTER'
    check (provider = 'OPENROUTER'),
  purpose text not null default 'WOLFIE_TUTOR'
    check (purpose in ('WISE_WOLF_PLANNER', 'WOLFIE_TUTOR')),
  embedding_model text not null default 'openai/text-embedding-3-small',
  embedding_dimensions integer not null default 1536
    check (embedding_dimensions = 1536),
  version integer not null default 1 check (version > 0),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'SYNCING', 'FAILED', 'ARCHIVED')),
  retrieval_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(retrieval_config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, purpose, version),
  unique (id, tenant_id)
);

create table if not exists public.ai_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null,
  tenant_id text not null references public.tenants(id) on delete cascade,
  source_type text not null
    check (source_type in ('PEDAGOGICAL_MATERIAL', 'CHATGPT_IMPORT', 'MANUAL')),
  source_ref text not null,
  title text not null,
  checksum_sha256 text not null,
  content text not null check (length(btrim(content)) > 0),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'INDEXING', 'READY', 'FAILED', 'REMOVED')),
  approved_at timestamptz,
  indexed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_knowledge_documents_base_scope_fkey
    foreign key (knowledge_base_id, tenant_id)
    references public.ai_knowledge_bases(id, tenant_id)
    on delete cascade,
  unique (id, knowledge_base_id, tenant_id),
  unique (knowledge_base_id, source_type, source_ref, checksum_sha256)
);

create table if not exists public.ai_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null,
  tenant_id text not null references public.tenants(id) on delete cascade,
  document_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (
    length(btrim(content)) > 0
    and length(content) <= 12000
  ),
  token_count integer check (token_count is null or token_count >= 0),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now(),
  constraint ai_knowledge_chunks_base_scope_fkey
    foreign key (knowledge_base_id, tenant_id)
    references public.ai_knowledge_bases(id, tenant_id)
    on delete cascade,
  constraint ai_knowledge_chunks_document_scope_fkey
    foreign key (document_id, knowledge_base_id, tenant_id)
    references public.ai_knowledge_documents(
      id,
      knowledge_base_id,
      tenant_id
    )
    on delete cascade,
  unique (document_id, chunk_index)
);

create index if not exists ai_knowledge_bases_tenant_active_idx
  on public.ai_knowledge_bases (tenant_id, purpose, version desc)
  where status = 'ACTIVE';
create unique index if not exists ai_knowledge_bases_one_active_idx
  on public.ai_knowledge_bases (tenant_id, provider, purpose)
  where status = 'ACTIVE';
create index if not exists ai_knowledge_documents_base_status_idx
  on public.ai_knowledge_documents (knowledge_base_id, status, updated_at desc);
create index if not exists ai_knowledge_documents_tenant_source_idx
  on public.ai_knowledge_documents (tenant_id, source_type, source_ref);
create index if not exists ai_knowledge_chunks_base_document_idx
  on public.ai_knowledge_chunks (knowledge_base_id, document_id, chunk_index);
create index if not exists ai_knowledge_chunks_tenant_idx
  on public.ai_knowledge_chunks (tenant_id);
create index if not exists ai_knowledge_chunks_embedding_hnsw_idx
  on public.ai_knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.ai_knowledge_bases enable row level security;
alter table public.ai_knowledge_documents enable row level security;
alter table public.ai_knowledge_chunks enable row level security;

revoke all on table public.ai_knowledge_bases
  from public, anon, authenticated;
revoke all on table public.ai_knowledge_documents
  from public, anon, authenticated;
revoke all on table public.ai_knowledge_chunks
  from public, anon, authenticated;
grant all on table public.ai_knowledge_bases to service_role;
grant all on table public.ai_knowledge_documents to service_role;
grant all on table public.ai_knowledge_chunks to service_role;
grant usage on schema extensions to service_role;

create or replace function public.match_wise_wolf_knowledge(
  p_tenant_id text,
  p_knowledge_base_id uuid,
  p_query_embedding extensions.vector(1536),
  p_match_count integer default 8,
  p_min_similarity double precision default 0.45
)
returns table (
  chunk_id uuid,
  document_id uuid,
  title text,
  content text,
  similarity double precision,
  chunk_index integer,
  metadata jsonb
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    chunk.id,
    document.id,
    document.title,
    chunk.content,
    (
      1 - (
        chunk.embedding OPERATOR(extensions.<=>) p_query_embedding
      )
    )::double precision,
    chunk.chunk_index,
    document.metadata || chunk.metadata
  from public.ai_knowledge_chunks as chunk
  join public.ai_knowledge_documents as document
    on document.id = chunk.document_id
   and document.knowledge_base_id = chunk.knowledge_base_id
   and document.tenant_id = chunk.tenant_id
  join public.ai_knowledge_bases as base
    on base.id = chunk.knowledge_base_id
   and base.tenant_id = chunk.tenant_id
  where chunk.tenant_id = p_tenant_id
    and chunk.knowledge_base_id = p_knowledge_base_id
    and document.status = 'READY'
    and base.status = 'ACTIVE'
    and base.provider = 'OPENROUTER'
    and base.embedding_dimensions = 1536
    and 1 - (
      chunk.embedding OPERATOR(extensions.<=>) p_query_embedding
    ) >= greatest(
      -1::double precision,
      least(coalesce(p_min_similarity, 0.45), 1::double precision)
    )
  order by chunk.embedding OPERATOR(extensions.<=>) p_query_embedding
  limit least(greatest(coalesce(p_match_count, 8), 1), 20);
$function$;

revoke all on function public.match_wise_wolf_knowledge(
  text,
  uuid,
  extensions.vector,
  integer,
  double precision
) from public, anon, authenticated;
grant execute on function public.match_wise_wolf_knowledge(
  text,
  uuid,
  extensions.vector,
  integer,
  double precision
) to service_role;

-- A correction is an interpretation of learner language, not an immutable
-- fact. These states let the learner dispute a bad interpretation and make the
-- retry lock depend only on an active correction.
alter table public.wolfie_corrections
  add column if not exists status text not null default 'active',
  add column if not exists status_reason text,
  add column if not exists disputed_at timestamptz,
  add column if not exists invalidated_at timestamptz,
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by_correction_id uuid;

do $migration$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_corrections_status_check'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_status_check check (
        status in ('active', 'disputed', 'invalid', 'superseded')
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_corrections_status_reason_check'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_status_reason_check check (
        status_reason is null or char_length(status_reason) <= 1000
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_corrections_status_state_check'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_status_state_check check (
        (
          status = 'active'
          and disputed_at is null
          and invalidated_at is null
          and superseded_at is null
        )
        or (
          status = 'disputed'
          and disputed_at is not null
          and not requires_retry
        )
        or (
          status = 'invalid'
          and invalidated_at is not null
          and not requires_retry
        )
        or (
          status = 'superseded'
          and superseded_at is not null
          and not requires_retry
        )
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_corrections_superseded_by_fkey'
       and conrelid = 'public.wolfie_corrections'::regclass
  ) then
    alter table public.wolfie_corrections
      add constraint wolfie_corrections_superseded_by_fkey
      foreign key (superseded_by_correction_id)
      references public.wolfie_corrections (id)
      on delete set null;
  end if;
end;
$migration$;

-- Historical/concurrent data may contain more than one pending retry. Keep the
-- newest correction authoritative and supersede the older locks before adding
-- the invariant.
with pending as (
  select
    id,
    first_value(id) over (
      partition by session_id
      order by created_at desc, id desc
    ) as newest_id,
    row_number() over (
      partition by session_id
      order by created_at desc, id desc
    ) as position
  from public.wolfie_corrections
  where status = 'active'
    and requires_retry
    and not retry_completed
)
update public.wolfie_corrections as correction
   set status = 'superseded',
       status_reason = 'migration_multiple_pending_retry',
       superseded_at = now(),
       superseded_by_correction_id = pending.newest_id,
       requires_retry = false
  from pending
 where correction.id = pending.id
   and pending.position > 1;

create unique index if not exists idx_wolfie_corrections_one_pending_retry
  on public.wolfie_corrections (session_id)
  where status = 'active'
    and requires_retry
    and not retry_completed;

create index if not exists idx_wolfie_corrections_session_status_created
  on public.wolfie_corrections (session_id, status, created_at desc);

comment on column public.wolfie_corrections.status is
  'Lifecycle of a model-proposed correction. Only active corrections may lock retry.';
comment on column public.wolfie_corrections.status_reason is
  'Bounded audit reason for dispute, invalidation or supersession.';

-- Realtime transcripts are durable conversation evidence, but an automatic
-- speech transcript remains a rough guide. A client-generated UUID makes a
-- completed user/assistant exchange idempotent without treating either text
-- as a correction or a learner fact.
alter table public.wolfie_sessions
  add column if not exists realtime_first_client_turn_id uuid;

alter table public.wolfie_turns
  add column if not exists source_kind text not null default 'classic',
  add column if not exists client_turn_id uuid;

do $migration$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_sessions_realtime_first_turn_unique'
       and conrelid = 'public.wolfie_sessions'::regclass
  ) then
    alter table public.wolfie_sessions
      add constraint wolfie_sessions_realtime_first_turn_unique
      unique (student_id, realtime_first_client_turn_id);
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_turns_source_kind_check'
       and conrelid = 'public.wolfie_turns'::regclass
  ) then
    alter table public.wolfie_turns
      add constraint wolfie_turns_source_kind_check check (
        source_kind in ('classic', 'openai_realtime')
      );
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_turns_realtime_idempotency_unique'
       and conrelid = 'public.wolfie_turns'::regclass
  ) then
    alter table public.wolfie_turns
      add constraint wolfie_turns_realtime_idempotency_unique
      unique (session_id, client_turn_id, speaker);
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conname = 'wolfie_turns_realtime_source_check'
       and conrelid = 'public.wolfie_turns'::regclass
  ) then
    alter table public.wolfie_turns
      add constraint wolfie_turns_realtime_source_check check (
        (
          source_kind = 'classic'
          and client_turn_id is null
        )
        or (
          source_kind = 'openai_realtime'
          and client_turn_id is not null
          and requires_retry is false
        )
      );
  end if;
end;
$migration$;

create index if not exists idx_wolfie_turns_realtime_client_turn
  on public.wolfie_turns (client_turn_id, session_id)
  where source_kind = 'openai_realtime';

comment on column public.wolfie_sessions.realtime_first_client_turn_id is
  'Idempotency anchor when the first completed Realtime exchange creates the session.';
comment on column public.wolfie_turns.client_turn_id is
  'Client-generated UUID shared by the student and Wolfie rows of one Realtime exchange.';
comment on column public.wolfie_turns.source_kind is
  'Classic model orchestration or OpenAI Realtime transcript persistence.';

-- Typed, versioned learner assertions. Exact personal facts belong in
-- relational storage; they must never be embedded into the reusable knowledge
-- base shared by a tenant.
create table if not exists public.wolfie_facts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  fact_type text not null check (
    fact_type in (
      'resides_in',
      'is_from',
      'born_in',
      'preferred_name',
      'pronouns',
      'timezone',
      'language_preference',
      'learning_preference',
      'personal_preference'
    )
  ),
  subject_key text not null default 'student' check (
    char_length(subject_key) between 1 and 160
  ),
  value text not null check (char_length(value) between 1 and 1000),
  normalized_value text not null check (
    char_length(normalized_value) between 1 and 1000
  ),
  status text not null default 'active' check (
    status in ('active', 'superseded', 'disputed', 'dismissed')
  ),
  verification_status text not null default 'observed' check (
    verification_status in ('observed', 'confirmed', 'rejected')
  ),
  confidence numeric(4, 3) not null default 0.700 check (
    confidence between 0 and 1
  ),
  occurrence_count integer not null default 1 check (
    occurrence_count between 1 and 1000000
  ),
  version integer not null default 1 check (version between 1 and 1000000),
  source_kind text not null default 'learner_statement' check (
    source_kind in (
      'learner_statement',
      'learner_confirmation',
      'manual',
      'import'
    )
  ),
  source_session_id uuid,
  source_turn_id uuid,
  source_transcript text check (
    source_transcript is null or char_length(source_transcript) <= 4000
  ),
  transcription_confidence numeric(4, 3) check (
    transcription_confidence is null
    or transcription_confidence between 0 and 1
  ),
  evidence jsonb not null default '{}'::jsonb check (
    jsonb_typeof(evidence) = 'object'
  ),
  supersedes_fact_id uuid,
  superseded_by_fact_id uuid,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  confirmed_at timestamptz,
  disputed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wolfie_facts_student_tenant_fkey
    foreign key (student_id, tenant_id)
    references public.profiles (id, tenant_id)
    on delete cascade,
  constraint wolfie_facts_session_scope_fkey
    foreign key (source_session_id, student_id, tenant_id)
    references public.wolfie_sessions (id, student_id, tenant_id)
    on delete set null (source_session_id),
  constraint wolfie_facts_turn_session_fkey
    foreign key (source_turn_id, source_session_id)
    references public.wolfie_turns (id, session_id)
    on delete set null (source_turn_id),
  constraint wolfie_facts_supersedes_fkey
    foreign key (supersedes_fact_id)
    references public.wolfie_facts (id)
    on delete set null,
  constraint wolfie_facts_superseded_by_fkey
    foreign key (superseded_by_fact_id)
    references public.wolfie_facts (id)
    on delete set null,
  constraint wolfie_facts_source_pair_check check (
    source_turn_id is null or source_session_id is not null
  ),
  constraint wolfie_facts_validity_check check (
    valid_to is null or valid_to >= valid_from
  ),
  constraint wolfie_facts_confirmation_check check (
    (
      verification_status = 'confirmed'
      and confirmed_at is not null
    )
    or verification_status <> 'confirmed'
  ),
  constraint wolfie_facts_status_dates_check check (
    (
      status = 'active'
      and valid_to is null
      and disputed_at is null
    )
    or (
      status = 'superseded'
      and valid_to is not null
    )
    or (
      status = 'disputed'
      and disputed_at is not null
    )
    or status = 'dismissed'
  ),
  unique (student_id, fact_type, subject_key, version)
);

create unique index if not exists idx_wolfie_facts_one_active_value
  on public.wolfie_facts (student_id, fact_type, subject_key)
  where status = 'active';
create index if not exists idx_wolfie_facts_student_active
  on public.wolfie_facts (
    student_id,
    status,
    verification_status,
    updated_at desc
  );
create index if not exists idx_wolfie_facts_tenant_type
  on public.wolfie_facts (tenant_id, fact_type, updated_at desc);
create index if not exists idx_wolfie_facts_source_session
  on public.wolfie_facts (source_session_id)
  where source_session_id is not null;

alter table public.wolfie_facts enable row level security;

drop policy if exists wolfie_facts_student_select on public.wolfie_facts;
create policy wolfie_facts_student_select
  on public.wolfie_facts
  for select
  to authenticated
  using (student_id = (select auth.uid()));

revoke all on table public.wolfie_facts from public, anon, authenticated;
grant select on table public.wolfie_facts to authenticated;
grant all on table public.wolfie_facts to service_role;

drop trigger if exists trg_wolfie_facts_updated_at on public.wolfie_facts;
create trigger trg_wolfie_facts_updated_at
before update on public.wolfie_facts
for each row execute function public.set_wolfie_activity_updated_at();

comment on table public.wolfie_facts is
  'Typed, versioned learner assertions with source evidence. Current self-report supersedes only the same fact type.';
comment on column public.wolfie_facts.verification_status is
  'Observed self-report remains a claim; confirmed requires explicit learner confirmation.';

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
             evidence = coalesce(p_evidence, '{}'::jsonb)
               || jsonb_build_object('negated_at', observed_at)
       where id = active_fact.id;
      return active_fact.id;
    end if;
    return null;
  end if;

  if active_fact.id is not null
     and active_fact.normalized_value = p_normalized_value then
    update public.wolfie_facts
       set occurrence_count = least(occurrence_count + 1, 1000000),
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
           evidence = coalesce(p_evidence, '{}'::jsonb)
             || jsonb_build_object('last_observed_at', observed_at)
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
  text,
  uuid,
  text,
  text,
  text,
  text,
  boolean,
  uuid,
  uuid,
  text,
  numeric,
  jsonb,
  boolean
) from public, anon, authenticated;
grant execute on function public.record_wolfie_fact(
  text,
  uuid,
  text,
  text,
  text,
  text,
  boolean,
  uuid,
  uuid,
  text,
  numeric,
  jsonb,
  boolean
) to service_role;

create or replace function public.dispute_wolfie_pending_correction(
  p_tenant_id text,
  p_student_id uuid,
  p_session_id uuid,
  p_reason text default 'learner_disputed'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  session_stage text;
  session_status text;
  pending_correction public.wolfie_corrections%rowtype;
  disputed_on timestamptz := now();
begin
  select current_stage, scenario_status
    into session_stage, session_status
    from public.wolfie_sessions
   where id = p_session_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'owned_wolfie_session_not_found';
  end if;

  select *
    into pending_correction
    from public.wolfie_corrections
   where session_id = p_session_id
     and status = 'active'
     and requires_retry
     and not retry_completed
   order by created_at desc, id desc
   limit 1
   for update;

  if pending_correction.id is null then
    return pg_catalog.jsonb_build_object(
      'correctionId', null,
      'currentStage', session_stage,
      'scenarioStatus', session_status
    );
  end if;

  update public.wolfie_corrections
     set status = 'disputed',
         status_reason = left(
           coalesce(nullif(btrim(p_reason), ''), 'learner_disputed'),
           1000
         ),
         disputed_at = disputed_on,
         requires_retry = false
   where id = pending_correction.id
     and session_id = p_session_id
     and status = 'active';

  session_stage := case
    when session_stage = 'retry' then 'practice'
    else session_stage
  end;
  session_status := case
    when session_status = 'awaiting_retry' then 'active'
    else session_status
  end;

  update public.wolfie_sessions
     set current_stage = session_stage,
         scenario_status = session_status,
         retry_count = greatest(0, coalesce(retry_count, 0) - 1),
         last_activity_at = disputed_on,
         updated_at = disputed_on
   where id = p_session_id
     and student_id = p_student_id
     and tenant_id = p_tenant_id;

  return pg_catalog.jsonb_build_object(
    'correctionId', pending_correction.id,
    'correctSentence', pending_correction.correct_sentence,
    'explanationPt', pending_correction.explanation_pt,
    'errorType', pending_correction.error_type,
    'currentStage', session_stage,
    'scenarioStatus', session_status,
    'disputedAt', disputed_on
  );
end;
$function$;

revoke all on function public.dispute_wolfie_pending_correction(
  text,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.dispute_wolfie_pending_correction(
  text,
  uuid,
  uuid,
  text
) to service_role;

create or replace function public.record_wolfie_realtime_exchange(
  p_session_id uuid,
  p_client_turn_id uuid,
  p_user_transcript text,
  p_assistant_transcript text,
  p_input_method text,
  p_asr_confidence numeric,
  p_transcript_is_rough_guide boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  session_stage text;
  next_turn_index integer;
  student_turn_id uuid;
  assistant_turn_id uuid;
  stored_student_content text;
  stored_assistant_content text;
  student_inserted boolean := false;
  assistant_inserted boolean := false;
  normalized_input_method text := lower(btrim(p_input_method));
  recorded_at timestamptz := now();
begin
  if p_session_id is null or p_client_turn_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_realtime_exchange_identity';
  end if;
  if nullif(btrim(p_user_transcript), '') is null
     or char_length(p_user_transcript) > 4000
     or nullif(btrim(p_assistant_transcript), '') is null
     or char_length(p_assistant_transcript) > 4000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_realtime_exchange_transcript';
  end if;
  if normalized_input_method = ''
     or char_length(normalized_input_method) > 40
     or normalized_input_method !~ '^[a-z0-9_-]+$' then
    raise exception using
      errcode = '22023',
      message = 'invalid_realtime_input_method';
  end if;
  if p_asr_confidence is not null
     and (p_asr_confidence < 0 or p_asr_confidence > 1) then
    raise exception using
      errcode = '22023',
      message = 'invalid_realtime_asr_confidence';
  end if;
  if normalized_input_method ~ '(audio|voice|microphone|mic)'
     and not coalesce(p_transcript_is_rough_guide, false) then
    raise exception using
      errcode = '22023',
      message = 'audio_transcript_must_be_rough_guide';
  end if;

  -- Locking the owning session serializes turn-index allocation and makes the
  -- user/assistant pair atomic under concurrent completion callbacks.
  select current_stage
    into session_stage
    from public.wolfie_sessions
   where id = p_session_id
   for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'wolfie_session_not_found';
  end if;

  select id, content
    into student_turn_id, stored_student_content
    from public.wolfie_turns
   where session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'student';
  select id, content
    into assistant_turn_id, stored_assistant_content
    from public.wolfie_turns
   where session_id = p_session_id
     and client_turn_id = p_client_turn_id
     and speaker = 'wolfie';

  if student_turn_id is not null
     and stored_student_content <> btrim(p_user_transcript) then
    raise exception using
      errcode = '22023',
      message = 'realtime_client_turn_id_reused';
  end if;
  if assistant_turn_id is not null
     and stored_assistant_content <> btrim(p_assistant_transcript) then
    raise exception using
      errcode = '22023',
      message = 'realtime_client_turn_id_reused';
  end if;
  if student_turn_id is not null and assistant_turn_id is not null then
    return pg_catalog.jsonb_build_object(
      'studentTurnId', student_turn_id,
      'assistantTurnId', assistant_turn_id,
      'inserted', false
    );
  end if;

  select coalesce(max(turn_index), -1) + 1
    into next_turn_index
    from public.wolfie_turns
   where session_id = p_session_id;

  if student_turn_id is null then
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
      btrim(p_user_transcript),
      next_turn_index,
      'instruction',
      session_stage,
      pg_catalog.jsonb_build_object(
        'source', 'openai_realtime',
        'clientTurnId', p_client_turn_id,
        'inputMethod', normalized_input_method,
        'transcriptIsRoughGuide',
          coalesce(p_transcript_is_rough_guide, false),
        'eligibleForFactExtraction', false,
        'eligibleForCorrection', false
      ),
      false,
      null,
      pg_catalog.jsonb_build_object(
        'asrConfidence', p_asr_confidence,
        'inputMethod', normalized_input_method,
        'transcriptIsRoughGuide',
          coalesce(p_transcript_is_rough_guide, false)
      ),
      p_asr_confidence,
      'openai_realtime',
      p_client_turn_id
    )
    returning id into student_turn_id;
    student_inserted := true;
    next_turn_index := next_turn_index + 1;
  end if;

  if assistant_turn_id is null then
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
      'wolfie',
      btrim(p_assistant_transcript),
      next_turn_index,
      'feedback',
      session_stage,
      pg_catalog.jsonb_build_object(
        'source', 'openai_realtime',
        'clientTurnId', p_client_turn_id,
        'inputMethod', normalized_input_method,
        'transcriptIsRoughGuide',
          coalesce(p_transcript_is_rough_guide, false),
        'eligibleForFactExtraction', false,
        'eligibleForCorrection', false
      ),
      false,
      null,
      '{}'::jsonb,
      null,
      'openai_realtime',
      p_client_turn_id
    )
    returning id into assistant_turn_id;
    assistant_inserted := true;
  end if;

  update public.wolfie_sessions
     set turn_count = greatest(0, coalesce(turn_count, 0)) +
           case when student_inserted or assistant_inserted then 1 else 0 end,
         student_word_count = greatest(
           0,
           coalesce(student_word_count, 0)
         ) + case
           when student_inserted then
             cardinality(
               pg_catalog.regexp_split_to_array(
                 btrim(p_user_transcript),
                 '\s+'
               )
             )
           else 0
         end,
         wolfie_word_count = greatest(
           0,
           coalesce(wolfie_word_count, 0)
         ) + case
           when assistant_inserted then
             cardinality(
               pg_catalog.regexp_split_to_array(
                 btrim(p_assistant_transcript),
                 '\s+'
               )
             )
           else 0
         end,
         last_activity_at = recorded_at,
         updated_at = recorded_at
   where id = p_session_id;

  return pg_catalog.jsonb_build_object(
    'studentTurnId', student_turn_id,
    'assistantTurnId', assistant_turn_id,
    'inserted', student_inserted or assistant_inserted
  );
end;
$function$;

revoke all on function public.record_wolfie_realtime_exchange(
  uuid,
  uuid,
  text,
  text,
  text,
  numeric,
  boolean
) from public, anon, authenticated;
grant execute on function public.record_wolfie_realtime_exchange(
  uuid,
  uuid,
  text,
  text,
  text,
  numeric,
  boolean
) to service_role;

-- The existing vector infrastructure is shared mechanically, while purpose
-- keeps Planner and Tutor corpora separate. No student fact belongs here.
alter table public.ai_knowledge_bases
  add column if not exists retrieval_config jsonb not null default '{}'::jsonb;

alter table public.ai_knowledge_bases
  drop constraint if exists ai_knowledge_bases_purpose_check;
alter table public.ai_knowledge_bases
  add constraint ai_knowledge_bases_purpose_check check (
    purpose in ('WISE_WOLF_PLANNER', 'WOLFIE_TUTOR')
  );

do $migration$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'ai_knowledge_bases_retrieval_config_check'
       and conrelid = 'public.ai_knowledge_bases'::regclass
  ) then
    alter table public.ai_knowledge_bases
      add constraint ai_knowledge_bases_retrieval_config_check check (
        jsonb_typeof(retrieval_config) = 'object'
      );
  end if;
end;
$migration$;

create index if not exists ai_knowledge_bases_wolfie_active_idx
  on public.ai_knowledge_bases (tenant_id, version desc)
  where purpose = 'WOLFIE_TUTOR' and status = 'ACTIVE';

comment on column public.ai_knowledge_bases.purpose is
  'Separates reusable Planner and Wolfie Tutor corpora. Student-specific facts remain relational.';
comment on column public.ai_knowledge_bases.retrieval_config is
  'Server-controlled bounded retrieval settings such as match_count and min_similarity.';

select pg_notify('pgrst', 'reload schema');
