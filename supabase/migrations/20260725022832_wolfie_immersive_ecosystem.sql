-- Wolfie immersive ecosystem
--
-- Structured activities are intentionally separate from wolfie_sessions,
-- which remains the conversational tutor transcript. All authoritative writes
-- happen in the authenticated wolfie-activity Edge Function. The browser can
-- read its own safe results, but never answer keys or award itself XP.

create table if not exists public.wolfie_activity_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  subject text not null check (
    subject in (
      'vocabulary',
      'grammar',
      'listening',
      'reading',
      'writing',
      'conversation',
      'global_meetings'
    )
  ),
  cefr_level text not null check (
    cefr_level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
  ),
  sector text,
  phase text not null default 'standard' check (
    phase in (
      'standard',
      'construction',
      'memorization',
      'readaptation',
      'conversation'
    )
  ),
  modality text not null default 'text' check (
    modality in ('text', 'voice', 'mixed')
  ),
  status text not null default 'IN_PROGRESS' check (
    status in (
      'IN_PROGRESS',
      'EVALUATING',
      'COMPLETED',
      'ABANDONED',
      'FAILED'
    )
  ),
  source_session_id uuid,
  request_key uuid not null default gen_random_uuid(),
  activity_content jsonb not null default '{}'::jsonb,
  learner_state jsonb not null default '{}'::jsonb,
  reused_terms text[] not null default '{}'::text[],
  introduced_terms text[] not null default '{}'::text[],
  score smallint check (score between 0 and 100),
  xp_earned integer not null default 0 check (xp_earned >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  test_fixture boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wolfie_activity_sessions_source_phase_check check (
    (
      phase = 'readaptation'
      and source_session_id is not null
    )
    or (
      phase <> 'readaptation'
      and source_session_id is null
    )
  ),
  constraint wolfie_activity_sessions_completed_at_check check (
    completed_at is null or completed_at >= started_at
  ),
  constraint wolfie_activity_sessions_scope_key
    unique (id, student_id, tenant_id),
  constraint wolfie_activity_sessions_source_scope_fkey
    foreign key (source_session_id, student_id, tenant_id)
    references public.wolfie_activity_sessions (id, student_id, tenant_id)
    on delete cascade,
  unique (student_id, request_key)
);

comment on table public.wolfie_activity_sessions is
  'Server-authored structured Wolfie activities and safe learner-visible state.';
comment on column public.wolfie_activity_sessions.activity_content is
  'Learner-visible activity content. Never store correct answers in this column.';

-- Kept in a separate table so a direct Data API read can never disclose the
-- answer key. No anon/authenticated grants or policies are created below.
create table if not exists public.wolfie_activity_keys (
  session_id uuid primary key references public.wolfie_activity_sessions(id)
    on delete cascade,
  answer_key jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.wolfie_activity_keys is
  'Private answer keys for structured Wolfie activities; service-role only.';

create table if not exists public.wolfie_activity_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  request_key uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  step_key text,
  modality text not null default 'text' check (
    modality in ('text', 'voice', 'mixed')
  ),
  response_payload jsonb not null default '{}'::jsonb,
  feedback_payload jsonb not null default '{}'::jsonb,
  score smallint not null check (score between 0 and 100),
  completes_session boolean not null default false,
  created_at timestamptz not null default now(),
  constraint wolfie_activity_attempts_session_scope_fkey
    foreign key (session_id, student_id, tenant_id)
    references public.wolfie_activity_sessions (id, student_id, tenant_id)
    on delete cascade,
  unique (session_id, attempt_number),
  unique (session_id, request_key)
);

comment on table public.wolfie_activity_attempts is
  'Authoritative attempts graded by the Wolfie Edge Function. Raw audio is never persisted.';

create table if not exists public.wolfie_repertoire (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  term_key text not null,
  term text not null,
  translation text,
  definition_pt text,
  example_sentence text,
  cefr_level text not null check (
    cefr_level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
  ),
  source_subject text not null check (
    source_subject in (
      'vocabulary',
      'grammar',
      'listening',
      'reading',
      'writing',
      'conversation',
      'global_meetings'
    )
  ),
  source_session_id uuid references public.wolfie_activity_sessions(id)
    on delete set null,
  sector text,
  tags text[] not null default '{}'::text[],
  mastery_score smallint not null default 0 check (
    mastery_score between 0 and 100
  ),
  exposure_count integer not null default 0 check (exposure_count >= 0),
  correct_count integer not null default 0 check (correct_count >= 0),
  incorrect_count integer not null default 0 check (incorrect_count >= 0),
  independent_use_count integer not null default 0 check (
    independent_use_count >= 0
  ),
  pronunciation_success_count integer not null default 0 check (
    pronunciation_success_count >= 0
  ),
  last_seen_at timestamptz,
  next_review_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, term_key)
);

comment on table public.wolfie_repertoire is
  'Cross-module vocabulary and language structures that reappear in future activities.';

create table if not exists public.wolfie_learning_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.wolfie_activity_sessions(id)
    on delete cascade,
  repertoire_id uuid references public.wolfie_repertoire(id)
    on delete set null,
  event_type text not null check (
    event_type in (
      'EXPOSED',
      'ANSWERED_CORRECTLY',
      'ANSWERED_INCORRECTLY',
      'USED_WITH_GUIDANCE',
      'USED_INDEPENDENTLY',
      'PRONOUNCED_SUCCESSFULLY',
      'SESSION_COMPLETED'
    )
  ),
  subject text not null check (
    subject in (
      'vocabulary',
      'grammar',
      'listening',
      'reading',
      'writing',
      'conversation',
      'global_meetings'
    )
  ),
  cefr_level text not null check (
    cefr_level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
  ),
  event_key text check (
    event_key is null or char_length(event_key) between 1 and 300
  ),
  metadata jsonb not null default '{}'::jsonb,
  test_fixture boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.wolfie_learning_events is
  'Append-only event trail used to explain and recompute Wolfie mastery.';

alter table public.wolfie_learning_events
  add column if not exists event_key text;

do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is not null then
    execute $storage$
      insert into storage.buckets (
        id,
        name,
        public,
        file_size_limit,
        allowed_mime_types
      ) values (
        'wolfie-generated-audio',
        'wolfie-generated-audio',
        false,
        5242880,
        array['audio/wav']::text[]
      )
      on conflict (id) do update
        set public = false,
            file_size_limit = excluded.file_size_limit,
            allowed_mime_types = excluded.allowed_mime_types
    $storage$;
  end if;
end;
$$;

create table if not exists public.wolfie_ai_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  request_key uuid not null,
  operation text not null check (
    operation in ('GENERATE', 'EVALUATE', 'SPEECH')
  ),
  status text not null check (
    status in ('PROCESSING', 'COMPLETED', 'FAILED')
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (
    attempt_count between 0 and 3
  ),
  response_payload jsonb not null default '{}'::jsonb,
  error_code text check (
    error_code is null or char_length(error_code) <= 120
  ),
  test_fixture boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint wolfie_ai_requests_state_check check (
    (
      status = 'PROCESSING'
      and lease_token is not null
      and lease_expires_at is not null
      and completed_at is null
    )
    or (
      status in ('COMPLETED', 'FAILED')
      and completed_at is not null
    )
  ),
  unique (student_id, request_key)
);

comment on table public.wolfie_ai_requests is
  'Service-only AI idempotency, lease and per-student cost-control records.';

create index if not exists idx_wolfie_activity_sessions_student_created
  on public.wolfie_activity_sessions (student_id, created_at desc);
create index if not exists idx_wolfie_activity_sessions_tenant_created
  on public.wolfie_activity_sessions (tenant_id, created_at desc);
create index if not exists idx_wolfie_activity_sessions_source
  on public.wolfie_activity_sessions (source_session_id)
  where source_session_id is not null;
create index if not exists idx_wolfie_activity_sessions_subject_level
  on public.wolfie_activity_sessions (
    student_id,
    subject,
    cefr_level,
    created_at desc
  );
create index if not exists idx_wolfie_activity_attempts_session_created
  on public.wolfie_activity_attempts (session_id, created_at desc);
create unique index if not exists idx_wolfie_activity_attempts_quiz_step_once
  on public.wolfie_activity_attempts (session_id, step_key)
  where step_key like 'quiz:%';
create index if not exists idx_wolfie_repertoire_review
  on public.wolfie_repertoire (
    student_id,
    mastery_score,
    next_review_at
  );
create index if not exists idx_wolfie_repertoire_source_session
  on public.wolfie_repertoire (source_session_id)
  where source_session_id is not null;
create index if not exists idx_wolfie_learning_events_student_created
  on public.wolfie_learning_events (student_id, created_at desc);
create index if not exists idx_wolfie_learning_events_session_created
  on public.wolfie_learning_events (session_id, created_at desc)
  where session_id is not null;
create index if not exists idx_wolfie_learning_events_repertoire_created
  on public.wolfie_learning_events (repertoire_id, created_at desc)
  where repertoire_id is not null;
create unique index if not exists idx_wolfie_learning_events_event_key_once
  on public.wolfie_learning_events (student_id, event_key)
  where event_key is not null;
create index if not exists idx_wolfie_ai_requests_rate_limit
  on public.wolfie_ai_requests (
    student_id,
    operation,
    updated_at desc
  );
create index if not exists idx_wolfie_ai_requests_processing_lease
  on public.wolfie_ai_requests (lease_expires_at)
  where status = 'PROCESSING';

-- The service writes sessions, but tenant/test scope still comes from the
-- authoritative student profile. Readaptation must point to a completed
-- construction or memorization session owned by the same student and tenant.
create or replace function public.prepare_wolfie_activity_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_tenant_id text;
  v_profile_test_fixture boolean;
  v_source_subject text;
  v_source_phase text;
  v_source_status text;
  v_source_rehearsal_count integer;
begin
  select
    profile.tenant_id,
    coalesce(profile.is_test_account, false)
    into
      v_profile_tenant_id,
      v_profile_test_fixture
    from public.profiles as profile
   where profile.id = new.student_id
     and profile.role = 'STUDENT';

  if not found or v_profile_tenant_id is null then
    raise exception 'student_profile_scope_not_found';
  end if;

  new.tenant_id := v_profile_tenant_id;
  new.test_fixture := v_profile_test_fixture;

  if new.phase = 'readaptation' then
    if new.subject <> 'global_meetings'
       or new.source_session_id is null
       or new.source_session_id = new.id then
      raise exception 'invalid_readaptation_source';
    end if;

    select
      source.subject,
      source.phase,
      source.status,
      case
        when pg_catalog.jsonb_typeof(
          source.learner_state #> '{memorization,rehearsalCount}'
        ) = 'number'
          then (
            source.learner_state #>> '{memorization,rehearsalCount}'
          )::integer
        else 0
      end
      into
        v_source_subject,
        v_source_phase,
        v_source_status,
        v_source_rehearsal_count
      from public.wolfie_activity_sessions as source
     where source.id = new.source_session_id
       and source.student_id = new.student_id
       and source.tenant_id = new.tenant_id;

    if not found
       or v_source_subject <> 'global_meetings'
       or v_source_phase <> 'construction'
       or v_source_status <> 'COMPLETED'
       or v_source_rehearsal_count < 1 then
      raise exception 'invalid_readaptation_source';
    end if;
  elsif new.source_session_id is not null then
    raise exception 'source_session_requires_readaptation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prepare_wolfie_activity_session
  on public.wolfie_activity_sessions;
create trigger trg_prepare_wolfie_activity_session
before insert or update on public.wolfie_activity_sessions
for each row execute function public.prepare_wolfie_activity_session();

-- Keep broad legacy profile UPDATE grants working for ordinary profile fields,
-- while preventing browser roles from minting XP or changing authorization and
-- fixture scope. Service-role writes (including the attempt RPC) are unaffected.
create or replace function public.guard_wolfie_profile_server_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and row(
       new.xp,
       new.level,
       new.daily_xp,
       new.daily_xp_date,
       new.role,
       new.tenant_id,
       new.is_test_account
     ) is distinct from row(
       old.xp,
       old.level,
       old.daily_xp,
       old.daily_xp_date,
       old.role,
       old.tenant_id,
       old.is_test_account
     ) then
    raise exception
      using
        errcode = '42501',
        message = 'profile_server_fields_are_read_only';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_wolfie_profile_server_fields
  on public.profiles;
create trigger trg_guard_wolfie_profile_server_fields
before update of
  xp,
  level,
  daily_xp,
  daily_xp_date,
  role,
  tenant_id,
  is_test_account
on public.profiles
for each row execute function public.guard_wolfie_profile_server_fields();

create or replace function public.set_wolfie_activity_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists trg_wolfie_activity_sessions_updated_at
  on public.wolfie_activity_sessions;
create trigger trg_wolfie_activity_sessions_updated_at
before update on public.wolfie_activity_sessions
for each row execute function public.set_wolfie_activity_updated_at();

drop trigger if exists trg_wolfie_repertoire_updated_at
  on public.wolfie_repertoire;
create trigger trg_wolfie_repertoire_updated_at
before update on public.wolfie_repertoire
for each row execute function public.set_wolfie_activity_updated_at();

-- Claims one provider call before the Edge Function reaches OpenRouter/Gemini.
-- The profile row lock serializes different request keys for the same student,
-- making the hourly cap deterministic under concurrency.
create or replace function public.claim_wolfie_ai_request(
  p_student_id uuid,
  p_request_key uuid,
  p_operation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_tenant_id text;
  v_profile_test_fixture boolean;
  v_request public.wolfie_ai_requests%rowtype;
  v_has_request boolean := false;
  v_lease_token uuid;
  v_rate_cap integer;
  v_recent_attempts integer;
begin
  if p_student_id is null or p_request_key is null then
    raise exception 'invalid_ai_request_identity';
  end if;
  if p_operation is null
     or p_operation not in ('GENERATE', 'EVALUATE', 'SPEECH') then
    raise exception 'invalid_ai_operation';
  end if;

  select
    profile.tenant_id,
    coalesce(profile.is_test_account, false)
    into
      v_profile_tenant_id,
      v_profile_test_fixture
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.role = 'STUDENT'
   for update;

  if not found or v_profile_tenant_id is null then
    raise exception 'student_profile_scope_not_found';
  end if;

  select *
    into v_request
    from public.wolfie_ai_requests as request
   where request.student_id = p_student_id
     and request.request_key = p_request_key
   for update;
  v_has_request := found;

  if v_has_request and v_request.operation <> p_operation then
    raise exception 'ai_request_key_reused_for_another_operation';
  end if;

  if v_profile_test_fixture then
    if v_has_request then
      update public.wolfie_ai_requests
         set status = 'COMPLETED',
             response_payload =
               '{"skipped":"test_fixture"}'::jsonb,
             error_code = null,
             test_fixture = true,
             lease_expires_at = pg_catalog.now(),
             completed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where id = v_request.id
       returning * into v_request;
    else
      insert into public.wolfie_ai_requests (
        tenant_id,
        student_id,
        request_key,
        operation,
        status,
        attempt_count,
        response_payload,
        test_fixture,
        completed_at
      ) values (
        v_profile_tenant_id,
        p_student_id,
        p_request_key,
        p_operation,
        'COMPLETED',
        0,
        '{"skipped":"test_fixture"}'::jsonb,
        true,
        pg_catalog.now()
      )
      returning * into v_request;
    end if;

    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', v_request.status,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', v_request.response_payload,
      'testFixture', true
    );
  end if;

  if v_has_request and v_request.status = 'COMPLETED' then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', v_request.status,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', v_request.response_payload,
      'errorCode', v_request.error_code,
      'testFixture', v_request.test_fixture
    );
  end if;

  if v_has_request
     and v_request.status = 'PROCESSING'
     and v_request.lease_expires_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', v_request.status,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', '{}'::jsonb,
      'errorCode', null,
      'testFixture', false
    );
  end if;

  if v_has_request and v_request.attempt_count >= 3 then
    if v_request.status = 'PROCESSING' then
      update public.wolfie_ai_requests
         set status = 'FAILED',
             error_code = 'AI_RETRY_LIMIT_EXCEEDED',
             completed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where id = v_request.id
       returning * into v_request;
    end if;

    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'status', 'FAILED',
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'leaseToken', null,
      'leaseExpiresAt', v_request.lease_expires_at,
      'responsePayload', v_request.response_payload,
      'errorCode',
        coalesce(v_request.error_code, 'AI_RETRY_LIMIT_EXCEEDED'),
      'testFixture', false
    );
  end if;

  v_rate_cap := case p_operation
    when 'EVALUATE' then 40
    else 20
  end;

  select coalesce(pg_catalog.sum(request.attempt_count), 0)::integer
    into v_recent_attempts
    from public.wolfie_ai_requests as request
   where request.student_id = p_student_id
     and request.operation = p_operation
     and request.updated_at >=
       pg_catalog.now() - interval '1 hour';

  if v_recent_attempts >= v_rate_cap then
    raise exception
      using
        errcode = 'P0001',
        message = 'wolfie_ai_rate_limit_exceeded';
  end if;

  v_lease_token := gen_random_uuid();
  if v_has_request then
    update public.wolfie_ai_requests
       set status = 'PROCESSING',
           lease_token = v_lease_token,
           lease_expires_at =
             pg_catalog.now() + interval '45 seconds',
           attempt_count = attempt_count + 1,
           response_payload = '{}'::jsonb,
           error_code = null,
           completed_at = null,
           updated_at = pg_catalog.now()
     where id = v_request.id
     returning * into v_request;
  else
    insert into public.wolfie_ai_requests (
      tenant_id,
      student_id,
      request_key,
      operation,
      status,
      lease_token,
      lease_expires_at,
      attempt_count,
      test_fixture
    ) values (
      v_profile_tenant_id,
      p_student_id,
      p_request_key,
      p_operation,
      'PROCESSING',
      v_lease_token,
      pg_catalog.now() + interval '45 seconds',
      1,
      false
    )
    returning * into v_request;
  end if;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'status', v_request.status,
    'requestKey', v_request.request_key,
    'operation', v_request.operation,
    'attemptCount', v_request.attempt_count,
    'leaseToken', v_request.lease_token,
    'leaseExpiresAt', v_request.lease_expires_at,
    'responsePayload', '{}'::jsonb,
    'errorCode', null,
    'testFixture', false
  );
end;
$$;

create or replace function public.finish_wolfie_ai_request(
  p_student_id uuid,
  p_request_key uuid,
  p_lease_token uuid,
  p_status text,
  p_response_payload jsonb default '{}'::jsonb,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.wolfie_ai_requests%rowtype;
begin
  if p_student_id is null
     or p_request_key is null
     or p_lease_token is null then
    raise exception 'invalid_ai_request_identity';
  end if;
  if p_status is null
     or p_status not in ('COMPLETED', 'FAILED') then
    raise exception 'invalid_ai_final_status';
  end if;
  if pg_catalog.pg_column_size(
    coalesce(p_response_payload, '{}'::jsonb)
  ) > 1048576 then
    raise exception 'ai_response_payload_too_large';
  end if;

  select *
    into v_request
    from public.wolfie_ai_requests as request
   where request.student_id = p_student_id
     and request.request_key = p_request_key
   for update;

  if not found then
    raise exception 'ai_request_not_found';
  end if;

  if v_request.status = 'COMPLETED' then
    return pg_catalog.jsonb_build_object(
      'alreadyFinished', true,
      'status', v_request.status,
      'requestKey', v_request.request_key,
      'operation', v_request.operation,
      'attemptCount', v_request.attempt_count,
      'responsePayload', v_request.response_payload,
      'errorCode', v_request.error_code
    );
  end if;

  if v_request.status <> 'PROCESSING'
     or v_request.lease_token <> p_lease_token then
    raise exception 'ai_lease_not_owned';
  end if;

  update public.wolfie_ai_requests
     set status = p_status,
         response_payload = case
           when p_status = 'COMPLETED'
             then coalesce(p_response_payload, '{}'::jsonb)
           else '{}'::jsonb
         end,
         error_code = case
           when p_status = 'FAILED'
             then pg_catalog.left(
               coalesce(p_error_code, 'AI_PROVIDER_FAILED'),
               120
             )
           else null
         end,
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = v_request.id
   returning * into v_request;

  return pg_catalog.jsonb_build_object(
    'alreadyFinished', false,
    'status', v_request.status,
    'requestKey', v_request.request_key,
    'operation', v_request.operation,
    'attemptCount', v_request.attempt_count,
    'responsePayload', v_request.response_payload,
    'errorCode', v_request.error_code
  );
end;
$$;

-- Serializes attempts and makes completion/XP idempotent. Only the Edge
-- Function's service role may call it.
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
as $$
declare
  v_session public.wolfie_activity_sessions%rowtype;
  v_existing_attempt public.wolfie_activity_attempts%rowtype;
  v_attempt_number integer;
  v_step_key text;
  v_meeting_section_count integer;
  v_base_xp integer;
  v_xp_earned integer := 0;
  v_profile_xp integer;
  v_profile_level integer;
  v_daily_xp integer;
  v_daily_xp_date date;
  v_profile_test_fixture boolean;
  v_effective_test_fixture boolean;
  v_today date :=
    (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_new_xp integer;
  v_new_level integer;
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

  v_step_key := nullif(
    pg_catalog.left(coalesce(p_step_key, ''), 120),
    ''
  );

  select *
    into v_session
    from public.wolfie_activity_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'session_not_found';
  end if;

  select *
    into v_existing_attempt
    from public.wolfie_activity_attempts
   where session_id = v_session.id
     and request_key = p_request_key;

  if found then
    return pg_catalog.jsonb_build_object(
      'alreadyProcessed', true,
      'alreadyCompleted', v_session.status = 'COMPLETED',
      'stepAlreadyAnswered',
        v_existing_attempt.step_key like 'quiz:%',
      'requestKey', v_existing_attempt.request_key,
      'stepKey', v_existing_attempt.step_key,
      'attemptNumber', v_existing_attempt.attempt_number,
      'score', v_existing_attempt.score,
      'responsePayload', v_existing_attempt.response_payload,
      'feedbackPayload', v_existing_attempt.feedback_payload,
      'xpEarned', case
        when v_existing_attempt.completes_session
          and v_session.status = 'COMPLETED'
          then v_session.xp_earned
        else 0
      end,
      'leveledUp', false,
      'newLevel', null
    );
  end if;

  if v_step_key like 'quiz:%' then
    select *
      into v_existing_attempt
      from public.wolfie_activity_attempts
     where session_id = v_session.id
       and step_key = v_step_key;

    if found then
      return pg_catalog.jsonb_build_object(
        'alreadyProcessed', true,
        'alreadyCompleted', v_session.status = 'COMPLETED',
        'stepAlreadyAnswered', true,
        'requestKey', v_existing_attempt.request_key,
        'stepKey', v_existing_attempt.step_key,
        'attemptNumber', v_existing_attempt.attempt_number,
        'score', v_existing_attempt.score,
        'responsePayload', v_existing_attempt.response_payload,
        'feedbackPayload', v_existing_attempt.feedback_payload,
        'xpEarned', case
          when v_existing_attempt.completes_session
            and v_session.status = 'COMPLETED'
            then v_session.xp_earned
          else 0
        end,
        'leveledUp', false,
        'newLevel', null
      );
    end if;
  end if;

  if v_session.status = 'COMPLETED' then
    return pg_catalog.jsonb_build_object(
      'alreadyProcessed', false,
      'alreadyCompleted', true,
      'stepAlreadyAnswered', false,
      'requestKey', p_request_key,
      'stepKey', v_step_key,
      'attemptNumber', v_session.attempt_count,
      'score', v_session.score,
      'xpEarned', v_session.xp_earned,
      'leveledUp', false,
      'newLevel', null
    );
  end if;

  if v_session.subject = 'global_meetings' then
    if not p_complete then
      if v_session.phase <> 'construction' then
        raise exception 'invalid_meeting_partial_phase';
      end if;

      if v_step_key is null
         or not (
           v_step_key = any (
             array[
               'opening',
               'context',
               'data',
               'proposal',
               'next_steps',
               'closing'
             ]::text[]
           )
         ) then
        raise exception 'invalid_meeting_section';
      end if;
    else
      if v_session.phase not in (
        'construction',
        'memorization',
        'readaptation'
      ) or (
        v_session.phase = 'construction'
        and v_step_key is distinct from 'construction_complete'
      ) or (
        v_session.phase = 'memorization'
        and v_step_key is distinct from 'memorization_complete'
      ) or (
        v_session.phase = 'readaptation'
        and (
          v_step_key is null
          or v_step_key not in ('readaptation', 'readaptation_speech')
        )
      ) then
        raise exception 'invalid_meeting_final_step';
      end if;

      if v_session.phase = 'construction' then
        select pg_catalog.count(distinct attempt.step_key)
          into v_meeting_section_count
          from public.wolfie_activity_attempts as attempt
         where attempt.session_id = v_session.id
           and not attempt.completes_session
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

        if (
          p_modality = 'text'
          and nullif(
            pg_catalog.btrim(p_response_payload ->> 'text'),
            ''
          ) is null
        ) or (
          p_modality = 'voice'
          and coalesce(
            p_response_payload ->> 'audioAnalyzed',
            'false'
          ) <> 'true'
        ) or p_modality not in ('text', 'voice') then
          raise exception 'invalid_meeting_final_response';
        end if;
      elsif v_session.phase = 'memorization' then
        if coalesce(
          (
            v_session.learner_state
              -> 'memorization'
              ->> 'rehearsalCount'
          )::integer,
          0
        ) < 1 then
          raise exception 'memorization_rehearsal_required';
        end if;
      elsif v_step_key = 'readaptation' then
        if p_modality <> 'text'
           or nullif(
             pg_catalog.btrim(p_response_payload ->> 'text'),
             ''
           ) is null then
          raise exception 'invalid_readaptation_response';
        end if;
      elsif v_step_key = 'readaptation_speech' then
        if p_modality <> 'voice'
           or coalesce(
             p_response_payload ->> 'audioAnalyzed',
             'false'
           ) <> 'true' then
          raise exception 'invalid_readaptation_response';
        end if;
      end if;
    end if;
  end if;

  if v_session.status in ('ABANDONED', 'FAILED')
     or (v_session.status = 'EVALUATING' and not p_complete) then
    raise exception 'session_not_writable';
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
    completes_session
  ) values (
    v_session.id,
    v_session.tenant_id,
    v_session.student_id,
    p_request_key,
    v_attempt_number,
    v_step_key,
    p_modality,
    coalesce(p_response_payload, '{}'::jsonb),
    coalesce(p_feedback_payload, '{}'::jsonb),
    p_score,
    p_complete
  );

  update public.wolfie_activity_sessions
     set attempt_count = v_attempt_number,
         duration_seconds = greatest(
           duration_seconds,
           least(p_duration_seconds, 86400)
         ),
         learner_state = case
           when v_session.subject = 'global_meetings'
             and v_session.phase = 'construction'
             and not p_complete then
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
                   coalesce(p_response_payload ->> 'text', ''),
                 'corrected',
                   coalesce(
                     p_feedback_payload ->> 'correctedText',
                     p_response_payload ->> 'text',
                     ''
                   ),
                 'naturalVersion',
                   coalesce(
                     p_feedback_payload ->> 'naturalVersion',
                     p_feedback_payload ->> 'correctedText',
                     p_response_payload ->> 'text',
                     ''
                   ),
                 'score', p_score,
                 'savedAt', pg_catalog.now(),
                 'responsePayload',
                   coalesce(p_response_payload, '{}'::jsonb),
                 'feedbackPayload',
                   coalesce(p_feedback_payload, '{}'::jsonb)
               ),
               true
             )
           else learner_state
         end,
         updated_at = pg_catalog.now()
   where id = v_session.id;

  if p_complete then
    v_base_xp := case
      when v_session.subject = 'global_meetings'
        and v_session.phase = 'readaptation' then 100
      when v_session.subject = 'global_meetings' then 75
      when v_session.subject = 'conversation' then 60
      else 50
    end;
    v_xp_earned :=
      pg_catalog.round(v_base_xp * (p_score::numeric / 100));

    select
      coalesce(profile.xp, 0),
      coalesce(profile.level, 1),
      coalesce(profile.daily_xp, 0),
      profile.daily_xp_date,
      coalesce(profile.is_test_account, false)
      into
        v_profile_xp,
        v_profile_level,
        v_daily_xp,
        v_daily_xp_date,
        v_profile_test_fixture
      from public.profiles as profile
     where profile.id = v_session.student_id
       and profile.tenant_id = v_session.tenant_id
       and profile.role = 'STUDENT'
     for update;

    if not found then
      raise exception 'profile_scope_not_found';
    end if;

    v_effective_test_fixture :=
      v_session.test_fixture or v_profile_test_fixture;
    if v_effective_test_fixture then
      v_xp_earned := 0;
    end if;

    if v_daily_xp_date is distinct from v_today then
      v_daily_xp := 0;
    end if;

    -- Practice remains unlimited, while XP farming is capped server-side.
    v_xp_earned := least(
      v_xp_earned,
      greatest(0, 250 - v_daily_xp)
    );
    v_new_xp := v_profile_xp + v_xp_earned;
    v_new_level := pg_catalog.floor(v_new_xp / 1000) + 1;

    update public.profiles
       set xp = v_new_xp,
           level = v_new_level,
           daily_xp = v_daily_xp + v_xp_earned,
           daily_xp_date = v_today,
           last_activity = pg_catalog.now()
     where id = v_session.student_id
       and tenant_id = v_session.tenant_id;

    update public.wolfie_activity_sessions
       set status = 'COMPLETED',
           score = p_score,
           xp_earned = v_xp_earned,
           test_fixture = v_effective_test_fixture,
           completed_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = v_session.id;

    insert into public.wolfie_learning_events (
      tenant_id,
      student_id,
      session_id,
      event_type,
      subject,
      cefr_level,
      metadata,
      test_fixture
    ) values (
      v_session.tenant_id,
      v_session.student_id,
      v_session.id,
      'SESSION_COMPLETED',
      v_session.subject,
      v_session.cefr_level,
      pg_catalog.jsonb_build_object(
        'score', p_score,
        'xpEarned', v_xp_earned,
        'phase', v_session.phase
      ),
      v_effective_test_fixture
    );

    return pg_catalog.jsonb_build_object(
      'alreadyProcessed', false,
      'alreadyCompleted', false,
      'stepAlreadyAnswered', false,
      'requestKey', p_request_key,
      'stepKey', v_step_key,
      'attemptNumber', v_attempt_number,
      'score', p_score,
      'xpEarned', v_xp_earned,
      'leveledUp', v_new_level > v_profile_level,
      'newLevel', v_new_level
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'alreadyProcessed', false,
    'alreadyCompleted', false,
    'stepAlreadyAnswered', false,
    'requestKey', p_request_key,
    'stepKey', v_step_key,
    'attemptNumber', v_attempt_number,
    'score', p_score,
    'xpEarned', 0,
    'leveledUp', false,
    'newLevel', null
  );
end;
$$;

create or replace function public.create_wolfie_activity_session(
  p_student_id uuid,
  p_subject text,
  p_cefr_level text,
  p_sector text,
  p_phase text,
  p_modality text,
  p_source_session_id uuid,
  p_request_key uuid,
  p_activity_content jsonb,
  p_answer_key jsonb,
  p_reused_terms text[],
  p_introduced_terms text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id text;
  v_session public.wolfie_activity_sessions%rowtype;
begin
  select profile.tenant_id
    into v_tenant_id
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.role = 'STUDENT';
  if not found or v_tenant_id is null then
    raise exception 'student_profile_scope_not_found';
  end if;

  begin
    insert into public.wolfie_activity_sessions (
      tenant_id,
      student_id,
      subject,
      cefr_level,
      sector,
      phase,
      modality,
      source_session_id,
      request_key,
      activity_content,
      reused_terms,
      introduced_terms
    ) values (
      v_tenant_id,
      p_student_id,
      p_subject,
      p_cefr_level,
      nullif(pg_catalog.btrim(p_sector), ''),
      p_phase,
      p_modality,
      p_source_session_id,
      p_request_key,
      coalesce(p_activity_content, '{}'::jsonb),
      coalesce(p_reused_terms, '{}'::text[]),
      coalesce(p_introduced_terms, '{}'::text[])
    )
    returning * into v_session;

    insert into public.wolfie_activity_keys (
      session_id,
      answer_key
    ) values (
      v_session.id,
      coalesce(p_answer_key, '{}'::jsonb)
    );
  exception
    when unique_violation then
      select session.*
        into v_session
        from public.wolfie_activity_sessions as session
       where session.student_id = p_student_id
         and session.request_key = p_request_key;
      if not found then
        raise;
      end if;
  end;

  return pg_catalog.to_jsonb(v_session);
end;
$$;

create or replace function public.apply_wolfie_repertoire_event(
  p_session_id uuid,
  p_term_key text,
  p_term text,
  p_translation text,
  p_definition_pt text,
  p_example_sentence text,
  p_event_type text,
  p_event_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.wolfie_activity_sessions%rowtype;
  v_event_id uuid;
  v_repertoire_id uuid;
  v_term_key text;
  v_delta integer;
  v_mastery integer;
  v_review_days integer;
begin
  v_term_key := pg_catalog.left(
    pg_catalog.btrim(pg_catalog.lower(coalesce(p_term_key, ''))),
    160
  );
  if v_term_key = ''
     or pg_catalog.btrim(coalesce(p_term, '')) = ''
     or pg_catalog.char_length(coalesce(p_event_key, '')) not between 1 and 300
     or p_event_type not in (
       'EXPOSED',
       'ANSWERED_CORRECTLY',
       'ANSWERED_INCORRECTLY',
       'USED_WITH_GUIDANCE',
       'USED_INDEPENDENTLY',
       'PRONOUNCED_SUCCESSFULLY'
     ) then
    raise exception 'invalid_repertoire_event';
  end if;

  select session.*
    into v_session
    from public.wolfie_activity_sessions as session
   where session.id = p_session_id;
  if not found then
    raise exception 'wolfie_session_not_found';
  end if;

  insert into public.wolfie_learning_events (
    tenant_id,
    student_id,
    session_id,
    event_type,
    subject,
    cefr_level,
    event_key,
    metadata,
    test_fixture
  ) values (
    v_session.tenant_id,
    v_session.student_id,
    v_session.id,
    p_event_type,
    v_session.subject,
    v_session.cefr_level,
    p_event_key,
    pg_catalog.jsonb_build_object(
      'term', pg_catalog.left(pg_catalog.btrim(p_term), 120),
      'phase', v_session.phase
    ),
    v_session.test_fixture
  )
  on conflict do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'eventKey', p_event_key
    );
  end if;

  v_delta := case p_event_type
    when 'ANSWERED_CORRECTLY' then 12
    when 'ANSWERED_INCORRECTLY' then -8
    when 'USED_INDEPENDENTLY' then 18
    when 'PRONOUNCED_SUCCESSFULLY' then 15
    when 'USED_WITH_GUIDANCE' then 7
    else 2
  end;

  insert into public.wolfie_repertoire (
    tenant_id,
    student_id,
    term_key,
    term,
    translation,
    definition_pt,
    example_sentence,
    cefr_level,
    source_subject,
    source_session_id,
    sector,
    mastery_score,
    exposure_count,
    correct_count,
    incorrect_count,
    independent_use_count,
    pronunciation_success_count,
    last_seen_at,
    next_review_at
  ) values (
    v_session.tenant_id,
    v_session.student_id,
    v_term_key,
    pg_catalog.left(pg_catalog.btrim(p_term), 120),
    nullif(pg_catalog.left(pg_catalog.btrim(p_translation), 240), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(p_definition_pt), 500), ''),
    nullif(pg_catalog.left(pg_catalog.btrim(p_example_sentence), 500), ''),
    v_session.cefr_level,
    v_session.subject,
    v_session.id,
    v_session.sector,
    greatest(0, least(100, v_delta)),
    1,
    case when p_event_type = 'ANSWERED_CORRECTLY' then 1 else 0 end,
    case when p_event_type = 'ANSWERED_INCORRECTLY' then 1 else 0 end,
    case when p_event_type = 'USED_INDEPENDENTLY' then 1 else 0 end,
    case when p_event_type = 'PRONOUNCED_SUCCESSFULLY' then 1 else 0 end,
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (student_id, term_key) do update
    set tenant_id = excluded.tenant_id,
        term = excluded.term,
        translation = coalesce(
          excluded.translation,
          public.wolfie_repertoire.translation
        ),
        definition_pt = coalesce(
          excluded.definition_pt,
          public.wolfie_repertoire.definition_pt
        ),
        example_sentence = coalesce(
          excluded.example_sentence,
          public.wolfie_repertoire.example_sentence
        ),
        cefr_level = excluded.cefr_level,
        source_subject = excluded.source_subject,
        source_session_id = excluded.source_session_id,
        sector = excluded.sector,
        mastery_score = greatest(
          0,
          least(
            100,
            public.wolfie_repertoire.mastery_score + v_delta
          )
        ),
        exposure_count = public.wolfie_repertoire.exposure_count + 1,
        correct_count = public.wolfie_repertoire.correct_count
          + case when p_event_type = 'ANSWERED_CORRECTLY' then 1 else 0 end,
        incorrect_count = public.wolfie_repertoire.incorrect_count
          + case when p_event_type = 'ANSWERED_INCORRECTLY' then 1 else 0 end,
        independent_use_count =
          public.wolfie_repertoire.independent_use_count
          + case when p_event_type = 'USED_INDEPENDENTLY' then 1 else 0 end,
        pronunciation_success_count =
          public.wolfie_repertoire.pronunciation_success_count
          + case
              when p_event_type = 'PRONOUNCED_SUCCESSFULLY' then 1
              else 0
            end,
        last_seen_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
  returning id, mastery_score
    into v_repertoire_id, v_mastery;

  v_review_days := case
    when v_mastery >= 85 then 21
    when v_mastery >= 65 then 10
    when v_mastery >= 40 then 5
    else 2
  end;

  update public.wolfie_repertoire
     set next_review_at =
       pg_catalog.now() + pg_catalog.make_interval(days => v_review_days)
   where id = v_repertoire_id;

  update public.wolfie_learning_events
     set repertoire_id = v_repertoire_id
   where id = v_event_id;

  return pg_catalog.jsonb_build_object(
    'applied', true,
    'eventKey', p_event_key,
    'repertoireId', v_repertoire_id,
    'masteryScore', v_mastery
  );
end;
$$;

alter table public.wolfie_activity_sessions enable row level security;
alter table public.wolfie_activity_keys enable row level security;
alter table public.wolfie_activity_attempts enable row level security;
alter table public.wolfie_repertoire enable row level security;
alter table public.wolfie_learning_events enable row level security;
alter table public.wolfie_ai_requests enable row level security;

-- Read access is deliberately separate from write access. Students and
-- educators never write authoritative scores through PostgREST.
drop policy if exists wolfie_activity_sessions_read_own
  on public.wolfie_activity_sessions;
create policy wolfie_activity_sessions_read_own
  on public.wolfie_activity_sessions
  for select
  to authenticated
  using ((select auth.uid()) = student_id);

drop policy if exists wolfie_activity_sessions_read_educator
  on public.wolfie_activity_sessions;
create policy wolfie_activity_sessions_read_educator
  on public.wolfie_activity_sessions
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

drop policy if exists wolfie_activity_attempts_read_own
  on public.wolfie_activity_attempts;
create policy wolfie_activity_attempts_read_own
  on public.wolfie_activity_attempts
  for select
  to authenticated
  using ((select auth.uid()) = student_id);

drop policy if exists wolfie_activity_attempts_read_educator
  on public.wolfie_activity_attempts;
create policy wolfie_activity_attempts_read_educator
  on public.wolfie_activity_attempts
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

drop policy if exists wolfie_repertoire_read_own
  on public.wolfie_repertoire;
create policy wolfie_repertoire_read_own
  on public.wolfie_repertoire
  for select
  to authenticated
  using ((select auth.uid()) = student_id);

drop policy if exists wolfie_repertoire_read_educator
  on public.wolfie_repertoire;
create policy wolfie_repertoire_read_educator
  on public.wolfie_repertoire
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

drop policy if exists wolfie_learning_events_read_own
  on public.wolfie_learning_events;
create policy wolfie_learning_events_read_own
  on public.wolfie_learning_events
  for select
  to authenticated
  using ((select auth.uid()) = student_id);

drop policy if exists wolfie_learning_events_read_educator
  on public.wolfie_learning_events;
create policy wolfie_learning_events_read_educator
  on public.wolfie_learning_events
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

revoke all on table public.wolfie_activity_sessions from anon, authenticated;
revoke all on table public.wolfie_activity_keys from anon, authenticated;
revoke all on table public.wolfie_activity_attempts from anon, authenticated;
revoke all on table public.wolfie_repertoire from anon, authenticated;
revoke all on table public.wolfie_learning_events from anon, authenticated;
revoke all on table public.wolfie_ai_requests from anon, authenticated;

grant select on table public.wolfie_activity_sessions to authenticated;
grant select on table public.wolfie_activity_attempts to authenticated;
grant select on table public.wolfie_repertoire to authenticated;
grant select on table public.wolfie_learning_events to authenticated;

grant all on table public.wolfie_activity_sessions to service_role;
grant all on table public.wolfie_activity_keys to service_role;
grant all on table public.wolfie_activity_attempts to service_role;
grant all on table public.wolfie_repertoire to service_role;
grant all on table public.wolfie_learning_events to service_role;
grant all on table public.wolfie_ai_requests to service_role;

revoke all on function public.prepare_wolfie_activity_session()
  from public, anon, authenticated;
revoke all on function public.guard_wolfie_profile_server_fields()
  from public, anon, authenticated;
revoke all on function public.set_wolfie_activity_updated_at()
  from public, anon, authenticated;
revoke all on function public.claim_wolfie_ai_request(
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.claim_wolfie_ai_request(
  uuid,
  uuid,
  text
) to service_role;
revoke all on function public.finish_wolfie_ai_request(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.finish_wolfie_ai_request(
  uuid,
  uuid,
  uuid,
  text,
  jsonb,
  text
) to service_role;

revoke all on function public.create_wolfie_activity_session(
  uuid,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  jsonb,
  jsonb,
  text[],
  text[]
) from public, anon, authenticated;
grant execute on function public.create_wolfie_activity_session(
  uuid,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  jsonb,
  jsonb,
  text[],
  text[]
) to service_role;

revoke all on function public.apply_wolfie_repertoire_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.apply_wolfie_repertoire_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to service_role;

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

-- Reduce the blast radius of legacy grants without breaking authenticated
-- learning-path clients. Anonymous visitors have no reason to access them.
revoke all on table public.learning_paths from anon;
revoke all on table public.learning_units from anon;
revoke all on table public.unit_activities from anon;
revoke all on table public.student_activity_progress from anon;
revoke all on table public.student_skill_scores from anon;
revoke all on table public.student_vocab_reviews from anon;
revoke all on table public.student_activities from anon;
