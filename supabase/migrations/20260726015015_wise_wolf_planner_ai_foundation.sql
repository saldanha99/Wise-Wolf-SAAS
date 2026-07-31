-- Wise Wolf Planner AI foundation.
--
-- Student-specific evidence and reusable Wise Wolf teaching material remain in
-- Postgres. Reusable material is chunked and embedded through OpenRouter, then
-- searched with pgvector. Keeping the two concerns separate prevents one
-- student's history from becoming global retrieval context for another.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.lesson_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  teacher_id uuid not null references public.profiles(id),
  student_id uuid not null references public.profiles(id),
  plan_date date default current_date,
  objectives text,
  content text,
  materials text,
  ai_memory text,
  teacher_notes text,
  custom_prompt text,
  ai_suggestions text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.lesson_plans
  add column if not exists task_mode text not null default 'lesson_plan',
  add column if not exists duration_minutes integer not null default 30,
  add column if not exists bilingual boolean not null default true,
  add column if not exists structured_plan jsonb not null default '{}'::jsonb,
  add column if not exists student_memory_update jsonb not null default '{}'::jsonb,
  add column if not exists source_materials jsonb not null default '[]'::jsonb,
  add column if not exists model_id text,
  add column if not exists prompt_version text,
  add column if not exists response_id text,
  add column if not exists planner_run_id uuid;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'lesson_plans_task_mode_check'
      and conrelid = 'public.lesson_plans'::regclass
  ) then
    alter table public.lesson_plans
      add constraint lesson_plans_task_mode_check
      check (
        task_mode in (
          'lesson_plan',
          'student_feedback',
          'oral_test',
          'homework',
          'class_script',
          'vocabulary',
          'presentation_coaching',
          'progress_report',
          'material_generation'
        )
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'lesson_plans_duration_minutes_check'
      and conrelid = 'public.lesson_plans'::regclass
  ) then
    alter table public.lesson_plans
      add constraint lesson_plans_duration_minutes_check
      check (duration_minutes between 10 and 120) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'lesson_plans_json_shapes_check'
      and conrelid = 'public.lesson_plans'::regclass
  ) then
    alter table public.lesson_plans
      add constraint lesson_plans_json_shapes_check
      check (
        jsonb_typeof(structured_plan) = 'object'
        and jsonb_typeof(student_memory_update) = 'object'
        and jsonb_typeof(source_materials) = 'array'
      ) not valid;
  end if;
end
$block$;

alter table public.lesson_plans
  validate constraint lesson_plans_task_mode_check;
alter table public.lesson_plans
  validate constraint lesson_plans_duration_minutes_check;
alter table public.lesson_plans
  validate constraint lesson_plans_json_shapes_check;

create table if not exists public.planner_ai_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  task_mode text not null,
  duration_minutes integer not null default 30,
  bilingual boolean not null default true,
  teacher_request text not null default '',
  model_id text not null,
  prompt_version text not null,
  response_id text,
  usage jsonb not null default '{}'::jsonb,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  rag_used boolean not null default false,
  retrieved_sources jsonb not null default '[]'::jsonb,
  result jsonb not null,
  status text not null default 'DRAFT',
  created_at timestamptz not null default now(),
  saved_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint planner_ai_runs_task_mode_check check (
    task_mode in (
      'lesson_plan',
      'student_feedback',
      'oral_test',
      'homework',
      'class_script',
      'vocabulary',
      'presentation_coaching',
      'progress_report',
      'material_generation'
    )
  ),
  constraint planner_ai_runs_duration_check
    check (duration_minutes between 10 and 120),
  constraint planner_ai_runs_status_check
    check (status in ('DRAFT', 'SAVED', 'EXPIRED')),
  constraint planner_ai_runs_json_shapes_check check (
    jsonb_typeof(retrieved_sources) = 'array'
    and jsonb_typeof(result) = 'object'
    and jsonb_typeof(usage) = 'object'
  ),
  unique (id, tenant_id)
);

create table if not exists public.student_learning_memories (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null,
  source_ref text,
  occurred_at timestamptz not null default now(),
  lesson_objective text not null default '',
  content_practiced text[] not null default '{}'::text[],
  new_vocabulary text[] not null default '{}'::text[],
  recurring_errors text[] not null default '{}'::text[],
  corrections_mastered text[] not null default '{}'::text[],
  strengths_observed text[] not null default '{}'::text[],
  homework_assigned text not null default '',
  recommended_next_step text not null default '',
  confidence_level text not null default 'LOW',
  notes_to_verify text[] not null default '{}'::text[],
  verification_status text not null default 'PROPOSED',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_learning_memories_source_type_check check (
    source_type in (
      'CLASS_LOG',
      'WOLFIE_SESSION',
      'PLANNER_AI',
      'CHATGPT_IMPORT',
      'MANUAL'
    )
  ),
  constraint student_learning_memories_confidence_check
    check (confidence_level in ('LOW', 'MEDIUM', 'HIGH')),
  constraint student_learning_memories_verification_check
    check (verification_status in ('PROPOSED', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED')),
  constraint student_learning_memories_metadata_shape_check
    check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.ai_knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  provider text not null default 'OPENROUTER'
    check (provider = 'OPENROUTER'),
  purpose text not null default 'WISE_WOLF_PLANNER',
  embedding_model text not null default 'openai/text-embedding-3-small',
  embedding_dimensions integer not null default 1536
    check (embedding_dimensions = 1536),
  version integer not null default 1 check (version > 0),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'SYNCING', 'FAILED', 'ARCHIVED')),
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
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'INDEXING', 'READY', 'FAILED', 'REMOVED')),
  approved_at timestamptz,
  indexed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_knowledge_documents_metadata_shape_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint ai_knowledge_documents_content_check
    check (length(btrim(content)) > 0),
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

-- Composite foreign keys make tenant ownership a database invariant. They are
-- added as NOT VALID to minimize the lock window, then validated before any
-- broader educator read policy is installed.
do $block$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'lesson_plans_tenant_id_fkey'
      and conrelid = 'public.lesson_plans'::regclass
  ) then
    alter table public.lesson_plans
      add constraint lesson_plans_tenant_id_fkey
      foreign key (tenant_id)
      references public.tenants(id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'lesson_plans_teacher_tenant_fkey'
      and conrelid = 'public.lesson_plans'::regclass
  ) then
    alter table public.lesson_plans
      add constraint lesson_plans_teacher_tenant_fkey
      foreign key (teacher_id, tenant_id)
      references public.profiles(id, tenant_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'lesson_plans_student_tenant_fkey'
      and conrelid = 'public.lesson_plans'::regclass
  ) then
    alter table public.lesson_plans
      add constraint lesson_plans_student_tenant_fkey
      foreign key (student_id, tenant_id)
      references public.profiles(id, tenant_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'planner_ai_runs_teacher_tenant_fkey'
      and conrelid = 'public.planner_ai_runs'::regclass
  ) then
    alter table public.planner_ai_runs
      add constraint planner_ai_runs_teacher_tenant_fkey
      foreign key (teacher_id, tenant_id)
      references public.profiles(id, tenant_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'planner_ai_runs_student_tenant_fkey'
      and conrelid = 'public.planner_ai_runs'::regclass
  ) then
    alter table public.planner_ai_runs
      add constraint planner_ai_runs_student_tenant_fkey
      foreign key (student_id, tenant_id)
      references public.profiles(id, tenant_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'student_learning_memories_student_tenant_fkey'
      and conrelid = 'public.student_learning_memories'::regclass
  ) then
    alter table public.student_learning_memories
      add constraint student_learning_memories_student_tenant_fkey
      foreign key (student_id, tenant_id)
      references public.profiles(id, tenant_id)
      on delete cascade
      not valid;
  end if;
end
$block$;

alter table public.lesson_plans
  validate constraint lesson_plans_tenant_id_fkey;
alter table public.lesson_plans
  validate constraint lesson_plans_teacher_tenant_fkey;
alter table public.lesson_plans
  validate constraint lesson_plans_student_tenant_fkey;
alter table public.planner_ai_runs
  validate constraint planner_ai_runs_teacher_tenant_fkey;
alter table public.planner_ai_runs
  validate constraint planner_ai_runs_student_tenant_fkey;
alter table public.student_learning_memories
  validate constraint student_learning_memories_student_tenant_fkey;

do $block$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'lesson_plans_planner_run_tenant_fkey'
      and conrelid = 'public.lesson_plans'::regclass
  ) then
    alter table public.lesson_plans
      add constraint lesson_plans_planner_run_tenant_fkey
      foreign key (planner_run_id, tenant_id)
      references public.planner_ai_runs(id, tenant_id)
      on delete restrict
      not valid;
  end if;
end
$block$;

alter table public.lesson_plans
  validate constraint lesson_plans_planner_run_tenant_fkey;

drop index if exists public.lesson_plans_planner_run_unique_idx;
create unique index lesson_plans_planner_run_unique_idx
  on public.lesson_plans (planner_run_id);
create index if not exists lesson_plans_tenant_student_created_idx
  on public.lesson_plans (tenant_id, student_id, created_at desc);
create index if not exists lesson_plans_teacher_created_idx
  on public.lesson_plans (teacher_id, created_at desc);
create index if not exists lesson_plans_student_idx
  on public.lesson_plans (student_id);
create index if not exists planner_ai_runs_teacher_created_idx
  on public.planner_ai_runs (teacher_id, created_at desc);
create index if not exists planner_ai_runs_tenant_student_created_idx
  on public.planner_ai_runs (tenant_id, student_id, created_at desc);
create index if not exists planner_ai_runs_student_idx
  on public.planner_ai_runs (student_id);
create index if not exists planner_ai_runs_draft_expiry_idx
  on public.planner_ai_runs (expires_at)
  where status = 'DRAFT';
create index if not exists student_learning_memories_tenant_student_time_idx
  on public.student_learning_memories (tenant_id, student_id, occurred_at desc);
create index if not exists student_learning_memories_student_idx
  on public.student_learning_memories (student_id);
create index if not exists student_learning_memories_created_by_idx
  on public.student_learning_memories (created_by)
  where created_by is not null;
create index if not exists student_learning_memories_review_queue_idx
  on public.student_learning_memories (tenant_id, verification_status, created_at)
  where verification_status in ('PROPOSED', 'NEEDS_REVIEW');
drop index if exists public.student_learning_memories_source_unique_idx;
create unique index student_learning_memories_source_unique_idx
  on public.student_learning_memories (
    tenant_id,
    student_id,
    source_type,
    source_ref
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

alter table public.lesson_plans enable row level security;
alter table public.planner_ai_runs enable row level security;
alter table public.student_learning_memories enable row level security;
alter table public.ai_knowledge_bases enable row level security;
alter table public.ai_knowledge_documents enable row level security;
alter table public.ai_knowledge_chunks enable row level security;

-- Lesson plans are readable by educators with a current tenant context. Draft
-- runs and structured learning memory remain server-only so internal notes and
-- student evidence cannot be queried directly from the browser.
do $block$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'lesson_plans'
  loop
    execute format(
      'drop policy %I on public.lesson_plans',
      policy_row.policyname
    );
  end loop;
end
$block$;

create policy lesson_plans_educator_read
on public.lesson_plans
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
        and exists (
          select 1
          from public.bookings booking
          where booking.tenant_id = lesson_plans.tenant_id
            and booking.teacher_id = (select auth.uid())
            and booking.student_id = lesson_plans.student_id
            and coalesce(booking.status, 'SCHEDULED') = 'SCHEDULED'
        )
      )
    )
  )
);

revoke all on table public.lesson_plans from public, anon, authenticated;
grant select on table public.lesson_plans to authenticated;
grant all on table public.lesson_plans to service_role;

revoke all on table public.planner_ai_runs from public, anon, authenticated;
revoke all on table public.student_learning_memories from public, anon, authenticated;
revoke all on table public.ai_knowledge_bases from public, anon, authenticated;
revoke all on table public.ai_knowledge_documents from public, anon, authenticated;
revoke all on table public.ai_knowledge_chunks from public, anon, authenticated;
grant all on table public.planner_ai_runs to service_role;
grant all on table public.student_learning_memories to service_role;
grant all on table public.ai_knowledge_bases to service_role;
grant all on table public.ai_knowledge_documents to service_role;
grant all on table public.ai_knowledge_chunks to service_role;
grant usage on schema extensions to service_role;

-- Semantic retrieval is intentionally service-only. Both tenant and knowledge
-- base are explicit inputs and are rechecked against the active base and ready
-- document, so a stale or cross-tenant identifier cannot retrieve content.
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
    chunk.id as chunk_id,
    document.id as document_id,
    document.title,
    chunk.content,
    (
      1 - (
        chunk.embedding OPERATOR(extensions.<=>) p_query_embedding
      )
    )::double precision
      as similarity,
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

-- The browser can only request this operation through the Edge Function.
-- Generation, plan persistence, memory proposal and draft transition are one
-- transaction, and repeated saves return the original plan.
create or replace function public.save_planner_ai_run(
  p_run_id uuid,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run_row public.planner_ai_runs%rowtype;
  memory_row jsonb;
  lesson_plan_id uuid;
  materials_text text;
  has_memory boolean;
begin
  select *
    into run_row
    from public.planner_ai_runs
   where id = p_run_id
   for update;

  if not found then
    raise exception 'planner_run_not_found' using errcode = 'P0002';
  end if;

  if run_row.teacher_id <> p_actor_id then
    raise exception 'planner_run_forbidden' using errcode = '42501';
  end if;

  if run_row.status = 'SAVED' then
    select id
      into lesson_plan_id
      from public.lesson_plans
     where planner_run_id = run_row.id;
    if lesson_plan_id is null then
      raise exception 'planner_saved_run_inconsistent' using errcode = 'P0002';
    end if;
    return lesson_plan_id;
  end if;

  if run_row.status <> 'DRAFT' or run_row.expires_at <= now() then
    raise exception 'planner_run_expired' using errcode = '22023';
  end if;

  select coalesce(string_agg(material ->> 'title', ', '), '')
    into materials_text
    from jsonb_array_elements(
      case
        when jsonb_typeof(run_row.result -> 'materials') = 'array'
          then run_row.result -> 'materials'
        else '[]'::jsonb
      end
    ) as material;

  insert into public.lesson_plans (
    tenant_id,
    teacher_id,
    student_id,
    plan_date,
    objectives,
    content,
    materials,
    ai_memory,
    custom_prompt,
    ai_suggestions,
    task_mode,
    duration_minutes,
    bilingual,
    structured_plan,
    student_memory_update,
    source_materials,
    model_id,
    prompt_version,
    response_id,
    planner_run_id
  )
  values (
    run_row.tenant_id,
    run_row.teacher_id,
    run_row.student_id,
    current_date,
    coalesce(run_row.result ->> 'objective', ''),
    coalesce(
      run_row.result ->> 'legacy_content',
      run_row.result ->> 'overview',
      ''
    ),
    materials_text,
    coalesce(run_row.result ->> 'ai_memory_reflection', ''),
    run_row.teacher_request,
    coalesce(run_row.result ->> 'overview', ''),
    run_row.task_mode,
    run_row.duration_minutes,
    run_row.bilingual,
    run_row.result - 'legacy_content',
    coalesce(run_row.result -> 'student_memory_update', '{}'::jsonb),
    run_row.retrieved_sources,
    run_row.model_id,
    run_row.prompt_version,
    run_row.response_id,
    run_row.id
  )
  on conflict (planner_run_id)
  do update set planner_run_id = excluded.planner_run_id
  returning id into lesson_plan_id;

  memory_row := coalesce(
    run_row.result -> 'student_memory_update',
    '{}'::jsonb
  );
  has_memory :=
    coalesce(memory_row ->> 'lesson_objective', '') <> ''
    or coalesce(memory_row ->> 'homework_assigned', '') <> ''
    or coalesce(memory_row ->> 'recommended_next_step', '') <> ''
    or jsonb_array_length(
      case when jsonb_typeof(memory_row -> 'content_practiced') = 'array'
        then memory_row -> 'content_practiced' else '[]'::jsonb end
    ) > 0
    or jsonb_array_length(
      case when jsonb_typeof(memory_row -> 'new_vocabulary') = 'array'
        then memory_row -> 'new_vocabulary' else '[]'::jsonb end
    ) > 0
    or jsonb_array_length(
      case when jsonb_typeof(memory_row -> 'recurring_errors') = 'array'
        then memory_row -> 'recurring_errors' else '[]'::jsonb end
    ) > 0
    or jsonb_array_length(
      case when jsonb_typeof(memory_row -> 'corrections_mastered') = 'array'
        then memory_row -> 'corrections_mastered' else '[]'::jsonb end
    ) > 0
    or jsonb_array_length(
      case when jsonb_typeof(memory_row -> 'strengths_observed') = 'array'
        then memory_row -> 'strengths_observed' else '[]'::jsonb end
    ) > 0
    or jsonb_array_length(
      case when jsonb_typeof(memory_row -> 'notes_to_verify') = 'array'
        then memory_row -> 'notes_to_verify' else '[]'::jsonb end
    ) > 0;

  if has_memory then
    insert into public.student_learning_memories (
      tenant_id,
      student_id,
      source_type,
      source_ref,
      occurred_at,
      lesson_objective,
      content_practiced,
      new_vocabulary,
      recurring_errors,
      corrections_mastered,
      strengths_observed,
      homework_assigned,
      recommended_next_step,
      confidence_level,
      notes_to_verify,
      verification_status,
      metadata,
      created_by
    )
    values (
      run_row.tenant_id,
      run_row.student_id,
      'PLANNER_AI',
      run_row.id::text,
      now(),
      coalesce(memory_row ->> 'lesson_objective', ''),
      array(
        select jsonb_array_elements_text(
          case when jsonb_typeof(memory_row -> 'content_practiced') = 'array'
            then memory_row -> 'content_practiced' else '[]'::jsonb end
        )
      ),
      array(
        select jsonb_array_elements_text(
          case when jsonb_typeof(memory_row -> 'new_vocabulary') = 'array'
            then memory_row -> 'new_vocabulary' else '[]'::jsonb end
        )
      ),
      array(
        select jsonb_array_elements_text(
          case when jsonb_typeof(memory_row -> 'recurring_errors') = 'array'
            then memory_row -> 'recurring_errors' else '[]'::jsonb end
        )
      ),
      array(
        select jsonb_array_elements_text(
          case when jsonb_typeof(memory_row -> 'corrections_mastered') = 'array'
            then memory_row -> 'corrections_mastered' else '[]'::jsonb end
        )
      ),
      array(
        select jsonb_array_elements_text(
          case when jsonb_typeof(memory_row -> 'strengths_observed') = 'array'
            then memory_row -> 'strengths_observed' else '[]'::jsonb end
        )
      ),
      coalesce(memory_row ->> 'homework_assigned', ''),
      coalesce(memory_row ->> 'recommended_next_step', ''),
      case
        when memory_row ->> 'confidence_level' in ('LOW', 'MEDIUM', 'HIGH')
          then memory_row ->> 'confidence_level'
        else 'LOW'
      end,
      array(
        select jsonb_array_elements_text(
          case when jsonb_typeof(memory_row -> 'notes_to_verify') = 'array'
            then memory_row -> 'notes_to_verify' else '[]'::jsonb end
        )
      ),
      'PROPOSED',
      jsonb_build_object(
        'planner_run_id',
        run_row.id,
        'planned_not_observed',
        true
      ),
      p_actor_id
    )
    on conflict (tenant_id, student_id, source_type, source_ref)
    do nothing;
  end if;

  update public.planner_ai_runs
     set status = 'SAVED',
         saved_at = now()
   where id = run_row.id;

  return lesson_plan_id;
end
$function$;

revoke all on function public.save_planner_ai_run(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.save_planner_ai_run(uuid, uuid)
  to service_role;

create or replace function public.touch_planner_ai_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end
$function$;

revoke all on function public.touch_planner_ai_updated_at()
  from public, anon, authenticated;

create or replace function public.guard_ai_knowledge_embedding_config()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if (
    new.embedding_model,
    new.embedding_dimensions
  ) is distinct from (
    old.embedding_model,
    old.embedding_dimensions
  ) and exists (
    select 1
    from public.ai_knowledge_chunks as chunk
    where chunk.knowledge_base_id = old.id
    limit 1
  ) then
    raise exception 'knowledge_base_embedding_config_is_immutable'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

revoke all on function public.guard_ai_knowledge_embedding_config()
  from public, anon, authenticated;

drop trigger if exists trg_lesson_plans_updated_at
  on public.lesson_plans;
create trigger trg_lesson_plans_updated_at
before update on public.lesson_plans
for each row execute function public.touch_planner_ai_updated_at();

drop trigger if exists trg_student_learning_memories_updated_at
  on public.student_learning_memories;
create trigger trg_student_learning_memories_updated_at
before update on public.student_learning_memories
for each row execute function public.touch_planner_ai_updated_at();

drop trigger if exists trg_ai_knowledge_bases_updated_at
  on public.ai_knowledge_bases;
create trigger trg_ai_knowledge_bases_updated_at
before update on public.ai_knowledge_bases
for each row execute function public.touch_planner_ai_updated_at();

drop trigger if exists trg_ai_knowledge_bases_embedding_guard
  on public.ai_knowledge_bases;
create trigger trg_ai_knowledge_bases_embedding_guard
before update of embedding_model, embedding_dimensions
on public.ai_knowledge_bases
for each row execute function public.guard_ai_knowledge_embedding_config();

drop trigger if exists trg_ai_knowledge_documents_updated_at
  on public.ai_knowledge_documents;
create trigger trg_ai_knowledge_documents_updated_at
before update on public.ai_knowledge_documents
for each row execute function public.touch_planner_ai_updated_at();

comment on table public.planner_ai_runs is
  'Server-only Planner AI drafts and OpenRouter/pgvector retrieval audit records.';
comment on table public.student_learning_memories is
  'Structured, source-labelled student memory. Unverified imports remain hypotheses.';
comment on table public.ai_knowledge_bases is
  'Server-only OpenRouter embedding configuration and pgvector routing by tenant.';
comment on table public.ai_knowledge_documents is
  'Approved, sanitized Wise Wolf knowledge and indexing provenance.';
comment on table public.ai_knowledge_chunks is
  'Server-only reusable Wise Wolf chunks and OpenRouter embeddings for RAG.';
comment on column public.student_learning_memories.verification_status is
  'Only VERIFIED entries are facts; PROPOSED and NEEDS_REVIEW must be treated as hypotheses.';
