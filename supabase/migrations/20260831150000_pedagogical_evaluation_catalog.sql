-- Canonical publication order and secure teacher release for progressive
-- pedagogical evaluations. The question key remains server-only in submit-quiz;
-- this catalog is the authority for which milestones actually exist and what
-- comes next.

create table if not exists public.pedagogical_evaluation_catalog (
  book_part text primary key,
  module text not null,
  part integer not null,
  title text not null,
  next_book_part text null,
  active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint pedagogical_evaluation_catalog_book_part_check
    check (book_part ~ '^(A1|A2|B1|B2|C1|C2)-[1-4]$'),
  constraint pedagogical_evaluation_catalog_module_check
    check (module in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  constraint pedagogical_evaluation_catalog_part_check
    check (part between 1 and 4),
  constraint pedagogical_evaluation_catalog_identity_check
    check (book_part = module || '-' || part::text),
  constraint pedagogical_evaluation_catalog_next_check
    check (
      next_book_part is null
      or next_book_part ~ '^(A1|A2|B1|B2|C1|C2)-[1-4]$'
    )
);

create unique index if not exists idx_pedagogical_evaluation_catalog_active_order
  on public.pedagogical_evaluation_catalog (module, part)
  where active is true;

do $$
begin
  -- A versão diferida deixava eventos de gatilho pendentes depois do upsert e
  -- impedia a segunda aplicação transacional usada pelo release. Esta FK pode
  -- ser imediata: o INSERT é uma única instrução e todos os destinos já fazem
  -- parte do mesmo conjunto canônico.
  if exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'pedagogical_evaluation_catalog_next_fkey'
       and conrelid = 'public.pedagogical_evaluation_catalog'::regclass
       and condeferrable is true
  ) then
    alter table public.pedagogical_evaluation_catalog
      drop constraint pedagogical_evaluation_catalog_next_fkey;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conname = 'pedagogical_evaluation_catalog_next_fkey'
       and conrelid = 'public.pedagogical_evaluation_catalog'::regclass
  ) then
    alter table public.pedagogical_evaluation_catalog
      add constraint pedagogical_evaluation_catalog_next_fkey
      foreign key (next_book_part)
      references public.pedagogical_evaluation_catalog(book_part);
  end if;
end;
$$;

alter table public.pedagogical_evaluation_catalog enable row level security;
revoke all on table public.pedagogical_evaluation_catalog
  from public, anon, authenticated;
grant select on table public.pedagogical_evaluation_catalog to service_role;

insert into public.pedagogical_evaluation_catalog (
  book_part,
  module,
  part,
  title,
  next_book_part,
  active,
  updated_at
) values
  ('A1-1', 'A1', 1, 'Fundamentos A1 · Marco 1', 'A1-2', true, pg_catalog.now()),
  ('A1-2', 'A1', 2, 'Fundamentos A1 · Marco 2', 'A2-1', true, pg_catalog.now()),
  ('A2-1', 'A2', 1, 'Expansão A2 · Marco 1', 'A2-2', true, pg_catalog.now()),
  ('A2-2', 'A2', 2, 'Expansão A2 · Marco 2', 'B1-1', true, pg_catalog.now()),
  ('B1-1', 'B1', 1, 'Autonomia B1 · Marco 1', null, true, pg_catalog.now())
on conflict (book_part) do update
set module = excluded.module,
    part = excluded.part,
    title = excluded.title,
    next_book_part = excluded.next_book_part,
    active = excluded.active,
    updated_at = pg_catalog.now();

create table if not exists public.pedagogical_evaluation_access_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  book_part text not null references public.pedagogical_evaluation_catalog(book_part),
  unlocked boolean not null,
  created_at timestamptz not null default pg_catalog.now()
);

create index if not exists idx_pedagogical_evaluation_access_audit_student
  on public.pedagogical_evaluation_access_audit
  (tenant_id, student_id, created_at desc);

alter table public.pedagogical_evaluation_access_audit enable row level security;
revoke all on table public.pedagogical_evaluation_access_audit
  from public, anon, authenticated;
grant all on table public.pedagogical_evaluation_access_audit to service_role;

create table if not exists public.pedagogical_progression_repair_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  previous_book_part text not null,
  repaired_book_part text not null,
  reason text not null,
  repaired_at timestamptz not null default pg_catalog.now()
);

alter table public.pedagogical_progression_repair_audit enable row level security;
revoke all on table public.pedagogical_progression_repair_audit
  from public, anon, authenticated;
grant all on table public.pedagogical_progression_repair_audit to service_role;

create table if not exists public.pedagogical_evaluation_submission_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  request_key text not null,
  request_payload jsonb not null,
  result jsonb null,
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz null,
  constraint pedagogical_evaluation_submission_request_key_check
    check (pg_catalog.length(request_key) between 8 and 180),
  constraint pedagogical_evaluation_submission_unique
    unique (student_id, request_key)
);

create index if not exists idx_pedagogical_evaluation_submissions_student
  on public.pedagogical_evaluation_submission_requests
  (tenant_id, student_id, created_at desc);

alter table public.pedagogical_evaluation_submission_requests enable row level security;
revoke all on table public.pedagogical_evaluation_submission_requests
  from public, anon, authenticated;
grant all on table public.pedagogical_evaluation_submission_requests to service_role;

-- Older recorder versions assumed four milestones per CEFR module and could
-- leave a student on a key that has never been published. Repair those states
-- deterministically and leave an auditable before/after record.
with orphaned as (
  select
    profile.id,
    profile.tenant_id,
    profile.current_book_part as previous_book_part,
    case
      when profile.current_book_part ~ '^A1-[1-4]$' then 'A2-1'
      when profile.current_book_part ~ '^A2-[1-4]$' then 'B1-1'
      else 'COMPLETED'
    end as repaired_book_part
  from public.profiles as profile
  where profile.role = 'STUDENT'
    and profile.tenant_id is not null
    and profile.current_book_part ~ '^(A1|A2|B1|B2|C1|C2)-[1-4]$'
    and not exists (
      select 1
      from public.pedagogical_evaluation_catalog as catalog
      where catalog.book_part = profile.current_book_part
        and catalog.active is true
    )
), audited as (
  insert into public.pedagogical_progression_repair_audit (
    tenant_id,
    student_id,
    previous_book_part,
    repaired_book_part,
    reason
  )
  select
    orphaned.tenant_id,
    orphaned.id,
    orphaned.previous_book_part,
    orphaned.repaired_book_part,
    'LEGACY_UNPUBLISHED_EVALUATION_TARGET'
  from orphaned
  returning student_id, repaired_book_part
)
update public.profiles as profile
set current_book_part = audited.repaired_book_part,
    evaluation_unlocked = false,
    module = case
      when audited.repaired_book_part = 'COMPLETED' then profile.module
      else pg_catalog.split_part(audited.repaired_book_part, '-', 1)
    end
from audited
where profile.id = audited.student_id;

create or replace function public.set_student_pedagogical_evaluation_access(
  p_student_id uuid,
  p_expected_book_part text,
  p_unlocked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_expected text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_expected_book_part, ''))
  );
  v_actor record;
  v_student record;
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_student_id is null or p_unlocked is null then
    raise exception using errcode = '22023', message = 'invalid_evaluation_access_request';
  end if;

  select profile.role, profile.tenant_id
    into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  if not found or v_actor.tenant_id is null then
    raise exception using errcode = '42501', message = 'authorized_staff_profile_required';
  end if;

  select
    profile.id,
    profile.tenant_id,
    profile.role,
    coalesce(profile.current_book_part, coalesce(profile.module, 'A1') || '-1')
      as current_book_part,
    coalesce(profile.evaluation_unlocked, false) as evaluation_unlocked
    into v_student
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found
     or v_student.role <> 'STUDENT'
     or v_student.tenant_id is null
     or v_student.tenant_id <> v_actor.tenant_id then
    raise exception using errcode = '42501', message = 'student_not_available';
  end if;

  if v_actor.role = 'TEACHER' then
    if not public._teacher_can_access_student(p_student_id, v_student.tenant_id) then
      raise exception using errcode = '42501', message = 'teacher_student_link_required';
    end if;
  elsif v_actor.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    raise exception using errcode = '42501', message = 'staff_role_required';
  end if;

  if v_expected <> v_student.current_book_part then
    raise exception using errcode = '40001', message = 'stale_pedagogical_book_part';
  end if;
  if not exists (
    select 1
      from public.pedagogical_evaluation_catalog as catalog
     where catalog.book_part = v_expected
       and catalog.active is true
  ) then
    raise exception using errcode = '22023', message = 'evaluation_not_published';
  end if;

  update public.profiles
     set evaluation_unlocked = p_unlocked
   where id = p_student_id;

  insert into public.pedagogical_evaluation_access_audit (
    tenant_id,
    student_id,
    actor_id,
    book_part,
    unlocked
  ) values (
    v_student.tenant_id,
    p_student_id,
    v_actor_id,
    v_expected,
    p_unlocked
  );

  return pg_catalog.jsonb_build_object(
    'studentId', p_student_id,
    'bookPart', v_expected,
    'unlocked', p_unlocked
  );
end;
$$;

alter function public.set_student_pedagogical_evaluation_access(
  uuid,
  text,
  boolean
) owner to postgres;
revoke all on function public.set_student_pedagogical_evaluation_access(
  uuid,
  text,
  boolean
) from public, anon;
grant execute on function public.set_student_pedagogical_evaluation_access(
  uuid,
  text,
  boolean
) to authenticated, service_role;

-- Wrap the already hardened recorder so publication order comes from the
-- canonical catalog instead of assuming every CEFR module has four parts.
create or replace function public.record_verified_pedagogical_quiz_v2(
  p_student_id uuid,
  p_book_part text,
  p_score integer,
  p_total_questions integer,
  p_answers jsonb,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_part text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_book_part, ''))
  );
  v_request_key text := pg_catalog.btrim(coalesce(p_request_key, ''));
  v_next_part text;
  v_result jsonb;
  v_request_payload jsonb;
  v_existing_request public.pedagogical_evaluation_submission_requests%rowtype;
  v_profile record;
  v_streak integer;
begin
  if p_student_id is null
     or pg_catalog.length(v_request_key) not between 8 and 180 then
    raise exception using errcode = '22023', message = 'invalid_evaluation_submission_request';
  end if;

  select catalog.next_book_part
    into v_next_part
    from public.pedagogical_evaluation_catalog as catalog
   where catalog.book_part = v_book_part
     and catalog.active is true;
  if not found then
    raise exception using errcode = '22023', message = 'evaluation_not_published';
  end if;

  -- Serialize every submission for this student before consulting the request
  -- ledger. A same-key retry may read its canonical stored result after the
  -- stage advances; a different key must revalidate the live progression.
  select
    profile.tenant_id,
    coalesce(
      profile.current_book_part,
      coalesce(profile.module, 'A1') || '-1'
    ) as current_book_part,
    coalesce(profile.evaluation_unlocked, false) as evaluation_unlocked
    into v_profile
    from public.profiles as profile
   where profile.id = p_student_id
     and profile.role = 'STUDENT'
   for update;
  if not found or v_profile.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_profile_required';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'bookPart', v_book_part,
    'score', p_score,
    'totalQuestions', p_total_questions,
    'answers', p_answers
  );

  select request.*
    into v_existing_request
    from public.pedagogical_evaluation_submission_requests as request
   where request.student_id = p_student_id
     and request.request_key = v_request_key
   for update;
  if found then
    if v_existing_request.request_payload is distinct from v_request_payload
       or v_existing_request.result is null then
      raise exception using errcode = '22023', message = 'evaluation_submission_idempotency_conflict';
    end if;
    return v_existing_request.result || pg_catalog.jsonb_build_object(
      'alreadySubmitted', true
    );
  end if;

  -- The legacy recorder treats any existing XP award as a successful replay,
  -- even when a caller supplies a brand-new request and a failing score. Only
  -- the persisted request/fingerprint branch above is a legitimate replay.
  if v_profile.current_book_part <> v_book_part
     or exists (
       select 1
         from public.student_verified_xp_awards as award
        where award.student_id = p_student_id
          and award.source_type = 'PEDAGOGICAL_QUIZ'
          and award.source_id = v_book_part
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'pedagogical_quiz_already_completed';
  end if;

  if v_profile.evaluation_unlocked is not true then
    raise exception using
      errcode = 'P0001',
      message = 'pedagogical_quiz_not_unlocked';
  end if;

  insert into public.pedagogical_evaluation_submission_requests (
    tenant_id,
    student_id,
    request_key,
    request_payload
  ) values (
    v_profile.tenant_id,
    p_student_id,
    v_request_key,
    v_request_payload
  );

  v_result := public.record_verified_pedagogical_quiz(
    p_student_id,
    v_book_part,
    p_score,
    p_total_questions,
    p_answers
  );

  if not coalesce((v_result ->> 'alreadyAwarded')::boolean, false) then
    v_streak := private.record_student_learning_practice(
      p_student_id,
      coalesce((v_result ->> 'percentage')::integer, 0),
      'quiz',
      array['grammar', 'vocabulary']::text[],
      pg_catalog.now()
    );
  else
    select coalesce(profile.streak_count, 0)
      into v_streak
      from public.profiles as profile
     where profile.id = p_student_id;
  end if;

  if coalesce((v_result ->> 'passed')::boolean, false)
     and not coalesce((v_result ->> 'alreadyAwarded')::boolean, false) then
    update public.profiles
       set current_book_part = coalesce(v_next_part, 'COMPLETED'),
           module = case
             when v_next_part is null then module
             else pg_catalog.split_part(v_next_part, '-', 1)
           end
     where id = p_student_id;

    v_result := pg_catalog.jsonb_set(
      v_result,
      '{nextPart}',
      pg_catalog.to_jsonb(coalesce(v_next_part, 'COMPLETED')),
      true
    );
  end if;

  v_result := v_result || pg_catalog.jsonb_build_object(
    'streakCount', coalesce(v_streak, 0),
    'alreadySubmitted', false
  );

  update public.pedagogical_evaluation_submission_requests
     set result = v_result,
         completed_at = pg_catalog.now()
   where student_id = p_student_id
     and request_key = v_request_key;

  return v_result;
end;
$$;

alter function public.record_verified_pedagogical_quiz_v2(
  uuid,
  text,
  integer,
  integer,
  jsonb,
  text
) owner to postgres;
revoke all on function public.record_verified_pedagogical_quiz_v2(
  uuid,
  text,
  integer,
  integer,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.record_verified_pedagogical_quiz_v2(
  uuid,
  text,
  integer,
  integer,
  jsonb,
  text
) to service_role;

-- Preserve a legitimate legacy release, then make the old array read-only.
update public.profiles as profile
   set evaluation_unlocked = true
 where profile.role = 'STUDENT'
   and coalesce(profile.evaluation_unlocked, false) is false
   and coalesce(profile.current_book_part, '') <> ''
   and pg_catalog.split_part(profile.current_book_part, '-', 1)
       = any(coalesce(profile.unlocked_tests, '{}'::text[]))
   and exists (
     select 1
       from public.pedagogical_evaluation_catalog as catalog
      where catalog.book_part = profile.current_book_part
        and catalog.active is true
   );

-- Attempts are evidence, not a browser-write surface. The service-only RPC is
-- the sole writer; existing SELECT policies continue serving authorized views.
revoke insert, update, delete on table public.student_evaluations
  from public, anon, authenticated;
grant all on table public.student_evaluations to service_role;

notify pgrst, 'reload schema';
