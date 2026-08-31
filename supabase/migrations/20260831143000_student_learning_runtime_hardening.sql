begin;

-- Student learning paths predate the ordered migration tree. Reconcile the one
-- legacy table that is still absent from it so a restored environment can apply
-- the runtime hardening without depending on production-only schema drift.
create table if not exists public.student_activities (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  type text not null,
  title text not null,
  description text,
  content text,
  difficulty text default 'INTERMEDIATE',
  category text,
  xp_reward integer default 50,
  status text not null default 'PENDING',
  completed_at timestamptz,
  created_at timestamptz default pg_catalog.now(),
  generated_by_ai boolean default true
);

create index if not exists idx_student_activities_student
  on public.student_activities (student_id);
create index if not exists idx_student_activities_tenant
  on public.student_activities (tenant_id);
create index if not exists idx_student_activities_status
  on public.student_activities (status);

create table if not exists public.student_vocab_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  term text not null,
  translation text not null,
  example text,
  source_activity_id uuid references public.unit_activities(id)
    on delete set null,
  interval_days integer not null default 1,
  consecutive_correct integer not null default 0,
  total_reviews integer not null default 0,
  next_review_at timestamptz not null default pg_catalog.now(),
  last_reviewed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (student_id, term)
);

alter table public.student_vocab_reviews
  add column if not exists tenant_id text
    references public.tenants(id) on delete cascade,
  add column if not exists translation text,
  add column if not exists example text,
  add column if not exists source_activity_id uuid
    references public.unit_activities(id) on delete set null,
  add column if not exists interval_days integer default 1,
  add column if not exists consecutive_correct integer default 0,
  add column if not exists total_reviews integer default 0,
  add column if not exists next_review_at timestamptz default pg_catalog.now(),
  add column if not exists last_reviewed_at timestamptz,
  add column if not exists created_at timestamptz default pg_catalog.now(),
  add column if not exists updated_at timestamptz default pg_catalog.now();

update public.student_vocab_reviews as review
   set tenant_id = profile.tenant_id
  from public.profiles as profile
 where profile.id = review.student_id
   and review.tenant_id is null;

do $block$
begin
  if exists (
    select 1
      from public.student_vocab_reviews as review
     where review.tenant_id is null
  ) then
    raise exception using
      errcode = '23502',
      message = 'student_vocab_review_tenant_backfill_failed';
  end if;
end
$block$;

update public.student_vocab_reviews
   set interval_days = coalesce(interval_days, 1),
       consecutive_correct = coalesce(consecutive_correct, 0),
       total_reviews = coalesce(total_reviews, 0),
       next_review_at = coalesce(next_review_at, pg_catalog.now()),
       created_at = coalesce(created_at, pg_catalog.now()),
       updated_at = coalesce(
         updated_at,
         last_reviewed_at,
         created_at,
         pg_catalog.now()
       );

alter table public.student_vocab_reviews
  alter column tenant_id set not null,
  alter column translation set not null,
  alter column interval_days set default 1,
  alter column interval_days set not null,
  alter column consecutive_correct set default 0,
  alter column consecutive_correct set not null,
  alter column total_reviews set default 0,
  alter column total_reviews set not null,
  alter column next_review_at set default pg_catalog.now(),
  alter column next_review_at set not null,
  alter column created_at set default pg_catalog.now(),
  alter column created_at set not null,
  alter column updated_at set default pg_catalog.now(),
  alter column updated_at set not null;

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_vocab_reviews'::regclass
       and conname = 'student_vocab_reviews_student_id_term_key'
  ) then
    alter table public.student_vocab_reviews
      add constraint student_vocab_reviews_student_id_term_key
      unique (student_id, term);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_vocab_reviews'::regclass
       and conname = 'student_vocab_reviews_runtime_values_check'
  ) then
    alter table public.student_vocab_reviews
      add constraint student_vocab_reviews_runtime_values_check
      check (
        pg_catalog.length(pg_catalog.btrim(term)) between 1 and 200
        and pg_catalog.length(pg_catalog.btrim(translation)) between 1 and 500
        and (example is null or pg_catalog.length(example) <= 2000)
        and interval_days between 1 and 3650
        and consecutive_correct between 0 and 1000000
        and total_reviews between 0 and 1000000
      ) not valid;
  end if;
end
$block$;

create index if not exists idx_vocab_reviews_student_due
  on public.student_vocab_reviews (student_id, next_review_at);
create index if not exists idx_student_vocab_reviews_tenant_due
  on public.student_vocab_reviews (tenant_id, next_review_at);
create index if not exists idx_student_vocab_reviews_source_activity_id
  on public.student_vocab_reviews (source_activity_id);

create table if not exists public.student_vocab_review_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  review_id uuid not null references public.student_vocab_reviews(id)
    on delete cascade,
  request_key text not null check (
    pg_catalog.length(request_key) between 8 and 180
  ),
  correct boolean not null,
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (student_id, request_key)
);

create index if not exists idx_student_vocab_review_attempts_review
  on public.student_vocab_review_attempts (review_id, created_at desc);
create index if not exists idx_student_vocab_review_attempts_tenant
  on public.student_vocab_review_attempts (tenant_id, created_at desc);

-- These gamification-consent fields existed in production but were absent from
-- ordered schema history. Keep the leaderboard opt-in contract restorable.
alter table public.profiles
  add column if not exists league_opt_in boolean not null default false,
  add column if not exists league_display_name text;

-- Production already carried these columns as nullable legacy fields. Normalize
-- the opt-in flag so NULL can never accidentally acquire leaderboard meaning.
update public.profiles
   set league_opt_in = false
 where league_opt_in is null;

alter table public.profiles
  alter column league_opt_in set default false,
  alter column league_opt_in set not null;

create index if not exists idx_profiles_opt_in_student_leaderboard
  on public.profiles (tenant_id, xp desc, id)
  where role = 'STUDENT' and league_opt_in is true;

-- The player/runtime supports exactly these five legacy production types.
-- Reject dormant schema-only types instead of allowing authors to create a
-- lesson that no student can execute.
do $block$
begin
  if exists (
    select 1
      from public.unit_activities as activity
     where activity.type not in (
       'vocab_cards',
       'reading',
       'grammar_drill',
       'quiz',
       'speaking_wolfie'
     )
  ) then
    raise exception using
      errcode = '23514',
      message = 'unsupported_unit_activity_type_exists';
  end if;
end
$block$;

alter table public.unit_activities
  drop constraint if exists unit_activities_type_check;
alter table public.unit_activities
  add constraint unit_activities_type_check
  check (
    type in (
      'vocab_cards',
      'reading',
      'grammar_drill',
      'quiz',
      'speaking_wolfie'
    )
  );

alter table public.student_path_enrollments
  add column if not exists status text,
  add column if not exists status_reason text,
  add column if not exists ended_at timestamptz,
  add column if not exists updated_at timestamptz;

update public.student_path_enrollments
   set status = case
     when completed_at is null then 'ACTIVE'
     else 'COMPLETED'
   end
 where status is null;

update public.student_path_enrollments
   set updated_at = coalesce(completed_at, started_at, pg_catalog.now())
 where updated_at is null;

alter table public.student_path_enrollments
  alter column status set default 'ACTIVE',
  alter column status set not null,
  alter column updated_at set default pg_catalog.now(),
  alter column updated_at set not null;

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_path_enrollments'::regclass
       and conname = 'student_path_enrollments_status_runtime_check'
  ) then
    alter table public.student_path_enrollments
      add constraint student_path_enrollments_status_runtime_check
      check (status in ('ACTIVE', 'COMPLETED', 'SWITCHED', 'PAUSED'))
      not valid;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_path_enrollments'::regclass
       and conname = 'student_path_enrollments_reason_size_check'
  ) then
    alter table public.student_path_enrollments
      add constraint student_path_enrollments_reason_size_check
      check (status_reason is null or pg_catalog.length(status_reason) <= 500)
      not valid;
  end if;
end
$block$;

alter table public.student_activities
  add column if not exists completion_evidence jsonb,
  add column if not exists completion_request_key text,
  add column if not exists completed_by uuid references public.profiles(id),
  add column if not exists updated_at timestamptz;

update public.student_activities
   set updated_at = coalesce(completed_at, created_at, pg_catalog.now())
 where updated_at is null;

alter table public.student_activities
  alter column updated_at set default pg_catalog.now(),
  alter column updated_at set not null;

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activities'::regclass
       and conname = 'student_activities_runtime_status_check'
  ) then
    alter table public.student_activities
      add constraint student_activities_runtime_status_check
      check (status in ('PENDING', 'COMPLETED', 'ARCHIVED'))
      not valid;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activities'::regclass
       and conname = 'student_activities_completion_request_key_check'
  ) then
    alter table public.student_activities
      add constraint student_activities_completion_request_key_check
      check (
        completion_request_key is null
        or pg_catalog.length(completion_request_key) between 8 and 180
      ) not valid;
  end if;
end
$block$;

create unique index if not exists
  uniq_student_complementary_completion_request
  on public.student_activities (student_id, completion_request_key)
  where completion_request_key is not null;

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activity_progress'::regclass
       and conname = 'student_activity_progress_score_runtime_check'
  ) then
    alter table public.student_activity_progress
      add constraint student_activity_progress_score_runtime_check
      check (score is null or score between 0 and 100)
      not valid;
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activity_progress'::regclass
       and conname = 'student_activity_progress_counters_runtime_check'
  ) then
    alter table public.student_activity_progress
      add constraint student_activity_progress_counters_runtime_check
      check (
        coalesce(attempts, 0) >= 0
        and coalesce(time_spent_seconds, 0) >= 0
      ) not valid;
  end if;
end
$block$;

create table if not exists public.student_path_enrollment_history (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null
    references public.student_path_enrollments(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  path_id uuid not null references public.learning_paths(id) on delete cascade,
  event_type text not null check (
    event_type in ('ENROLLED', 'REACTIVATED', 'SWITCHED_OUT', 'COMPLETED', 'PAUSED')
  ),
  from_status text,
  to_status text not null,
  reason text,
  actor_id uuid references public.profiles(id),
  occurred_at timestamptz not null default pg_catalog.now(),
  check (reason is null or pg_catalog.length(reason) <= 500)
);

create index if not exists idx_student_path_enrollment_history_student
  on public.student_path_enrollment_history (student_id, occurred_at desc);
create index if not exists idx_student_path_enrollment_history_enrollment
  on public.student_path_enrollment_history (enrollment_id, occurred_at desc);
create index if not exists idx_student_path_enrollment_history_tenant
  on public.student_path_enrollment_history (tenant_id, occurred_at desc);

create table if not exists public.student_learning_activity_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  enrollment_id uuid references public.student_path_enrollments(id)
    on delete set null,
  activity_id uuid references public.unit_activities(id) on delete set null,
  attempt_kind text not null check (attempt_kind in ('QUIZ', 'COMPLETION')),
  request_key text,
  request_payload jsonb not null default '{}'::jsonb,
  score smallint not null check (score between 0 and 100),
  passed boolean not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  check (request_key is null or pg_catalog.length(request_key) between 8 and 180)
);

create unique index if not exists uniq_student_learning_attempt_request
  on public.student_learning_activity_attempts (student_id, request_key)
  where request_key is not null;
create index if not exists idx_student_learning_attempts_activity
  on public.student_learning_activity_attempts
  (student_id, activity_id, created_at desc);
create index if not exists idx_student_learning_attempts_tenant
  on public.student_learning_activity_attempts (tenant_id, created_at desc);

create table if not exists public.student_complementary_activity_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  activity_id uuid not null references public.student_activities(id)
    on delete cascade,
  request_key text not null check (
    pg_catalog.length(request_key) between 8 and 180
  ),
  evidence jsonb not null,
  score smallint check (score between 0 and 100),
  passed boolean not null,
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (student_id, request_key)
);

create index if not exists idx_student_complementary_attempts_activity
  on public.student_complementary_activity_attempts
  (student_id, activity_id, created_at desc);
create index if not exists idx_student_complementary_attempts_tenant
  on public.student_complementary_activity_attempts
  (tenant_id, created_at desc);

create table if not exists public.student_heart_consumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  request_key text not null check (
    pg_catalog.length(request_key) between 8 and 180
  ),
  reason text not null check (pg_catalog.length(reason) between 1 and 120),
  hearts_before smallint not null check (hearts_before between 0 and 5),
  hearts_after smallint not null check (hearts_after between 0 and 5),
  consumed boolean not null,
  created_at timestamptz not null default pg_catalog.now(),
  unique (student_id, request_key)
);

create index if not exists idx_student_heart_consumptions_tenant
  on public.student_heart_consumptions (tenant_id, created_at desc);

create table if not exists public.student_generated_activity_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  request_key text not null check (
    pg_catalog.length(request_key) between 8 and 180
  ),
  request_payload jsonb not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  unique (student_id, request_key)
);

create index if not exists idx_student_generated_activity_batches_tenant
  on public.student_generated_activity_batches (tenant_id, created_at desc);

create table if not exists public.student_complementary_generation_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  request_key uuid not null,
  lease_token uuid,
  status text not null check (
    status in ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED', 'DENIED')
  ),
  decision_code text not null,
  lease_expires_at timestamptz,
  batch_id uuid references public.student_generated_activity_batches(id)
    on delete set null,
  failure_reason text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  unique (student_id, request_key),
  check (failure_reason is null or pg_catalog.length(failure_reason) <= 500),
  check (
    (status = 'RESERVED' and lease_token is not null and lease_expires_at is not null)
    or status <> 'RESERVED'
  )
);

create unique index if not exists
  uniq_active_student_complementary_generation_lease
  on public.student_complementary_generation_reservations (student_id)
  where status = 'RESERVED';
create index if not exists idx_student_complementary_generation_daily
  on public.student_complementary_generation_reservations
  (student_id, created_at desc);
create index if not exists idx_student_complementary_generation_tenant
  on public.student_complementary_generation_reservations
  (tenant_id, created_at desc);

alter table public.student_activities
  add column if not exists generation_batch_id uuid
    references public.student_generated_activity_batches(id) on delete set null,
  add column if not exists generation_position smallint;

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activities'::regclass
       and conname = 'student_activities_generation_position_check'
  ) then
    alter table public.student_activities
      add constraint student_activities_generation_position_check
      check (generation_position is null or generation_position between 1 and 4)
      not valid;
  end if;
end
$block$;

create unique index if not exists uniq_student_activity_batch_position
  on public.student_activities (generation_batch_id, generation_position)
  where generation_batch_id is not null;

-- Some restored databases predate the legacy one-active-path index. Reconcile
-- them deterministically before enforcing the stronger status-aware invariant.
update public.student_path_enrollments as enrollment
   set tenant_id = profile.tenant_id
  from public.profiles as profile
 where profile.id = enrollment.student_id
   and profile.role = 'STUDENT'
   and profile.tenant_id is not null
   and enrollment.tenant_id is distinct from profile.tenant_id;

with ranked as (
  select
    enrollment.id,
    pg_catalog.row_number() over (
      partition by enrollment.student_id
      order by enrollment.started_at desc nulls last, enrollment.id desc
    ) as active_rank
  from public.student_path_enrollments as enrollment
  where enrollment.status = 'ACTIVE'
    and enrollment.completed_at is null
), reconciled as (
  update public.student_path_enrollments as enrollment
     set status = 'SWITCHED',
         status_reason = 'MIGRATION_ACTIVE_PATH_RECONCILIATION',
         completed_at = pg_catalog.now(),
         ended_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
    from ranked
   where ranked.id = enrollment.id
     and ranked.active_rank > 1
  returning enrollment.*
)
insert into public.student_path_enrollment_history (
  enrollment_id,
  tenant_id,
  student_id,
  path_id,
  event_type,
  from_status,
  to_status,
  reason,
  actor_id,
  occurred_at
)
select
  reconciled.id,
  reconciled.tenant_id,
  reconciled.student_id,
  reconciled.path_id,
  'SWITCHED_OUT',
  'ACTIVE',
  'SWITCHED',
  'MIGRATION_ACTIVE_PATH_RECONCILIATION',
  null,
  reconciled.ended_at
from reconciled
where reconciled.tenant_id is not null;

drop index if exists public.uniq_active_path_enrollment_per_student;
create unique index uniq_active_path_enrollment_per_student
  on public.student_path_enrollments (student_id)
  where status = 'ACTIVE' and completed_at is null;

create schema if not exists private;
-- Authenticated RPC wrappers from the Hub are intentionally SECURITY INVOKER
-- and call narrowly granted helpers in this schema. Removing schema USAGE here
-- breaks those existing public entry points even though the helpers keep their
-- own least-privilege EXECUTE grants.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.enforce_student_path_enrollment_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_tenant text;
  v_student_role text;
  v_path_tenant text;
begin
  select profile.tenant_id, profile.role
    into v_student_tenant, v_student_role
    from public.profiles as profile
   where profile.id = new.student_id;

  if not found
     or v_student_role <> 'STUDENT'
     or v_student_tenant is null then
    raise exception using
      errcode = '23514',
      message = 'learning_enrollment_requires_student_profile';
  end if;

  select path.tenant_id
    into v_path_tenant
    from public.learning_paths as path
   where path.id = new.path_id;

  if not found
     or (v_path_tenant is not null and v_path_tenant <> v_student_tenant) then
    raise exception using
      errcode = '23514',
      message = 'learning_enrollment_tenant_mismatch';
  end if;

  if new.current_unit_id is not null
     and not exists (
       select 1
         from public.learning_units as unit
        where unit.id = new.current_unit_id
          and unit.path_id = new.path_id
     ) then
    raise exception using
      errcode = '23514',
      message = 'learning_enrollment_current_unit_mismatch';
  end if;

  new.tenant_id := v_student_tenant;
  new.updated_at := pg_catalog.now();

  if new.status = 'ACTIVE' then
    new.completed_at := null;
    new.ended_at := null;
  elsif new.completed_at is null then
    new.completed_at := pg_catalog.now();
    new.ended_at := coalesce(new.ended_at, new.completed_at);
  end if;

  return new;
end;
$function$;

alter function private.enforce_student_path_enrollment_scope() owner to postgres;
revoke all on function private.enforce_student_path_enrollment_scope()
  from public, anon, authenticated;

drop trigger if exists trg_enforce_student_path_enrollment_scope
  on public.student_path_enrollments;
create trigger trg_enforce_student_path_enrollment_scope
before insert or update on public.student_path_enrollments
for each row execute function private.enforce_student_path_enrollment_scope();

create or replace function private.enforce_student_activity_progress_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_expected_unit_id uuid;
begin
  if not exists (
    select 1
      from public.profiles as profile
     where profile.id = new.student_id
       and profile.role = 'STUDENT'
       and profile.tenant_id is not null
  ) then
    raise exception using
      errcode = '23514',
      message = 'learning_progress_requires_student_profile';
  end if;

  select activity.unit_id
    into v_expected_unit_id
    from public.unit_activities as activity
   where activity.id = new.activity_id;

  if not found or new.unit_id is distinct from v_expected_unit_id then
    raise exception using
      errcode = '23514',
      message = 'learning_progress_activity_unit_mismatch';
  end if;

  return new;
end;
$function$;

alter function private.enforce_student_activity_progress_scope() owner to postgres;
revoke all on function private.enforce_student_activity_progress_scope()
  from public, anon, authenticated;

drop trigger if exists trg_enforce_student_activity_progress_scope
  on public.student_activity_progress;
create trigger trg_enforce_student_activity_progress_scope
before insert or update on public.student_activity_progress
for each row execute function private.enforce_student_activity_progress_scope();

create or replace function private.enforce_student_complementary_activity_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_tenant text;
begin
  select profile.tenant_id
    into v_student_tenant
    from public.profiles as profile
   where profile.id = new.student_id
     and profile.role = 'STUDENT';

  if not found or v_student_tenant is null then
    raise exception using
      errcode = '23514',
      message = 'complementary_activity_requires_student_profile';
  end if;

  if new.tenant_id is not null and new.tenant_id <> v_student_tenant then
    raise exception using
      errcode = '23514',
      message = 'complementary_activity_tenant_mismatch';
  end if;

  new.tenant_id := v_student_tenant;
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

alter function private.enforce_student_complementary_activity_scope()
  owner to postgres;
revoke all on function private.enforce_student_complementary_activity_scope()
  from public, anon, authenticated;

drop trigger if exists trg_enforce_student_complementary_activity_scope
  on public.student_activities;
create trigger trg_enforce_student_complementary_activity_scope
before insert or update on public.student_activities
for each row execute function private.enforce_student_complementary_activity_scope();

-- Hearts, streak and XP are runtime state, not editable profile preferences.
-- Keep the existing trigger name so upgrades replace the legacy allow-list.
create or replace function public.guard_wolfie_profile_server_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if current_user in ('authenticated', 'anon')
     and row(
       new.xp,
       new.level,
       new.daily_xp,
       new.daily_xp_date,
       new.role,
       new.tenant_id,
       new.is_test_account,
       new.hearts,
       new.hearts_updated_at,
       new.hearts_full_notified,
       new.streak_count,
       new.last_streak_date,
       new.last_activity
     ) is distinct from row(
       old.xp,
       old.level,
       old.daily_xp,
       old.daily_xp_date,
       old.role,
       old.tenant_id,
       old.is_test_account,
       old.hearts,
       old.hearts_updated_at,
       old.hearts_full_notified,
       old.streak_count,
       old.last_streak_date,
       old.last_activity
     ) then
    raise exception using
      errcode = '42501',
      message = 'profile_server_fields_are_read_only';
  end if;

  return new;
end;
$function$;

alter function public.guard_wolfie_profile_server_fields() owner to postgres;
revoke all on function public.guard_wolfie_profile_server_fields()
  from public, anon, authenticated;

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
  is_test_account,
  hearts,
  hearts_updated_at,
  hearts_full_notified,
  streak_count,
  last_streak_date,
  last_activity
on public.profiles
for each row execute function public.guard_wolfie_profile_server_fields();

create or replace function private.refresh_student_hearts(
  p_student_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile record;
  v_hearts integer;
  v_anchor timestamptz;
  v_regenerated integer := 0;
  v_next_heart_at timestamptz;
begin
  if p_student_id is null or p_now is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_heart_refresh_request';
  end if;

  select
    profile.tenant_id,
    profile.role,
    least(5, greatest(0, coalesce(profile.hearts, 5))) as hearts,
    coalesce(profile.hearts_updated_at, p_now) as hearts_updated_at
    into v_profile
    from public.profiles as profile
   where profile.id = p_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  v_hearts := v_profile.hearts;
  v_anchor := v_profile.hearts_updated_at;

  if v_hearts < 5 and p_now > v_anchor then
    v_regenerated := greatest(
      0,
      pg_catalog.floor(
        extract(epoch from (p_now - v_anchor)) / 1800
      )::integer
    );

    if v_regenerated > 0 then
      v_regenerated := least(v_regenerated, 5 - v_hearts);
      v_hearts := v_hearts + v_regenerated;
      v_anchor := case
        when v_hearts >= 5 then p_now
        else v_anchor + (v_regenerated * interval '30 minutes')
      end;
    end if;
  end if;

  if v_hearts is distinct from v_profile.hearts
     or v_anchor is distinct from v_profile.hearts_updated_at then
    update public.profiles
       set hearts = v_hearts,
           hearts_updated_at = v_anchor
     where id = p_student_id;
  end if;

  v_next_heart_at := case
    when v_hearts < 5 then v_anchor + interval '30 minutes'
    else null
  end;

  return pg_catalog.jsonb_build_object(
    'tenantId', v_profile.tenant_id,
    'hearts', v_hearts,
    'maxHearts', 5,
    'heartsUpdatedAt', v_anchor,
    'nextHeartAt', v_next_heart_at,
    'regenerated', v_regenerated
  );
end;
$function$;

alter function private.refresh_student_hearts(uuid, timestamptz)
  owner to postgres;
revoke all on function private.refresh_student_hearts(uuid, timestamptz)
  from public, anon, authenticated;

create or replace function private.record_student_learning_practice(
  p_student_id uuid,
  p_score integer,
  p_activity_type text,
  p_skill_focus text[],
  p_now timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile record;
  v_today date := (p_now at time zone 'America/Sao_Paulo')::date;
  v_streak integer;
  v_skills text[] := coalesce(p_skill_focus, array[]::text[]);
  v_skill text;
  v_score numeric := least(100, greatest(0, coalesce(p_score, 0)));
begin
  select
    profile.role,
    profile.tenant_id,
    coalesce(profile.streak_count, 0) as streak_count,
    profile.last_streak_date
    into v_profile
    from public.profiles as profile
   where profile.id = p_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  v_streak := case
    when v_profile.last_streak_date = v_today then
      greatest(1, v_profile.streak_count)
    when v_profile.last_streak_date = v_today - 1 then
      greatest(0, v_profile.streak_count) + 1
    else 1
  end;

  update public.profiles
     set streak_count = v_streak,
         last_streak_date = v_today,
         last_activity = p_now
   where id = p_student_id;

  v_skills := v_skills || case p_activity_type
    when 'vocab_cards' then array['vocabulary']::text[]
    when 'quiz' then array['grammar', 'vocabulary']::text[]
    when 'grammar_drill' then array['grammar']::text[]
    when 'reading' then array['reading']::text[]
    when 'speaking_wolfie' then array['speaking', 'pronunciation']::text[]
    when 'listening' then array['listening']::text[]
    when 'writing' then array['writing']::text[]
    else array[]::text[]
  end;

  for v_skill in
    select distinct pg_catalog.lower(pg_catalog.btrim(skill_value))
      from pg_catalog.unnest(v_skills) as skill_value
     where pg_catalog.lower(pg_catalog.btrim(skill_value)) in (
       'grammar',
       'vocabulary',
       'listening',
       'speaking',
       'reading',
       'writing',
       'pronunciation'
     )
  loop
    insert into public.student_skill_scores (
      student_id,
      skill,
      current_score,
      total_activities,
      last_updated
    ) values (
      p_student_id,
      v_skill,
      v_score,
      1,
      p_now
    )
    on conflict (student_id, skill) do update
      set current_score = pg_catalog.round(
            (
              0.4 * excluded.current_score
              + 0.6 * coalesce(public.student_skill_scores.current_score, 0)
            )::numeric,
            1
          ),
          total_activities =
            coalesce(public.student_skill_scores.total_activities, 0) + 1,
          last_updated = p_now;
  end loop;

  return v_streak;
end;
$function$;

alter function private.record_student_learning_practice(
  uuid,
  integer,
  text,
  text[],
  timestamptz
) owner to postgres;
revoke all on function private.record_student_learning_practice(
  uuid,
  integer,
  text,
  text[],
  timestamptz
) from public, anon, authenticated;

create or replace function private.next_incomplete_learning_activity(
  p_student_id uuid,
  p_path_id uuid
)
returns table(activity_id uuid, unit_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  select activity.id, activity.unit_id
    from public.learning_units as unit
    join public.unit_activities as activity
      on activity.unit_id = unit.id
    left join public.student_activity_progress as progress
      on progress.student_id = p_student_id
     and progress.activity_id = activity.id
   where unit.path_id = p_path_id
     and coalesce(progress.status, 'NOT_STARTED') <> 'COMPLETED'
   order by unit.order_index, activity.order_index, activity.id
   limit 1;
$function$;

alter function private.next_incomplete_learning_activity(uuid, uuid)
  owner to postgres;
revoke all on function private.next_incomplete_learning_activity(uuid, uuid)
  from public, anon, authenticated;

create or replace function private.advance_student_learning_enrollment(
  p_enrollment_id uuid,
  p_student_id uuid,
  p_path_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_enrollment public.student_path_enrollments%rowtype;
  v_next record;
begin
  select *
    into v_enrollment
    from public.student_path_enrollments as enrollment
   where enrollment.id = p_enrollment_id
     and enrollment.student_id = p_student_id
     and enrollment.path_id = p_path_id
     and enrollment.status = 'ACTIVE'
     and enrollment.completed_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'active_learning_enrollment_required';
  end if;

  select next_activity.activity_id, next_activity.unit_id
    into v_next
    from private.next_incomplete_learning_activity(
      p_student_id,
      p_path_id
    ) as next_activity;

  if found then
    update public.student_path_enrollments
       set current_unit_id = v_next.unit_id,
           updated_at = p_now
     where id = p_enrollment_id;

    return pg_catalog.jsonb_build_object(
      'nextActivityId', v_next.activity_id,
      'currentUnitId', v_next.unit_id,
      'pathCompleted', false
    );
  end if;

  update public.student_path_enrollments
     set status = 'COMPLETED',
         status_reason = 'ALL_ACTIVITIES_COMPLETED',
         current_unit_id = null,
         completed_at = p_now,
         ended_at = p_now,
         updated_at = p_now
   where id = p_enrollment_id;

  insert into public.student_path_enrollment_history (
    enrollment_id,
    tenant_id,
    student_id,
    path_id,
    event_type,
    from_status,
    to_status,
    reason,
    actor_id,
    occurred_at
  ) values (
    p_enrollment_id,
    v_enrollment.tenant_id,
    p_student_id,
    p_path_id,
    'COMPLETED',
    'ACTIVE',
    'COMPLETED',
    'ALL_ACTIVITIES_COMPLETED',
    p_student_id,
    p_now
  );

  return pg_catalog.jsonb_build_object(
    'nextActivityId', null,
    'currentUnitId', null,
    'pathCompleted', true
  );
end;
$function$;

alter function private.advance_student_learning_enrollment(
  uuid,
  uuid,
  uuid,
  timestamptz
) owner to postgres;
revoke all on function private.advance_student_learning_enrollment(
  uuid,
  uuid,
  uuid,
  timestamptz
) from public, anon, authenticated;

create or replace function private.strip_student_answer_keys(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_key text;
  v_child jsonb;
begin
  if p_value is null then
    return null;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'object' then
    v_result := '{}'::jsonb;
    for v_key, v_child in
      select entry.key, entry.value
        from pg_catalog.jsonb_each(p_value) as entry(key, value)
    loop
      if v_key not in (
        'correct',
        'correctIndex',
        'correct_option_index',
        'exp',
        'explanation',
        'explanation_pt',
        'feedback'
      ) then
        v_result := v_result || pg_catalog.jsonb_build_object(
          v_key,
          private.strip_student_answer_keys(v_child)
        );
      end if;
    end loop;
    return v_result;
  elsif pg_catalog.jsonb_typeof(p_value) = 'array' then
    select coalesce(
             pg_catalog.jsonb_agg(
               private.strip_student_answer_keys(item.value)
               order by item.ordinality
             ),
             '[]'::jsonb
           )
      into v_result
      from pg_catalog.jsonb_array_elements(p_value)
           with ordinality as item(value, ordinality);
    return v_result;
  end if;

  return p_value;
end;
$function$;

alter function private.strip_student_answer_keys(jsonb) owner to postgres;
revoke all on function private.strip_student_answer_keys(jsonb)
  from public, anon, authenticated;

create or replace function public.get_student_learning_path_runtime(
  p_path_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_enrollment public.student_path_enrollments%rowtype;
  v_current_activity_id uuid;
  v_units jsonb;
  v_activities jsonb;
  v_progress jsonb;
begin
  if v_student_id is null or p_path_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  if not exists (
    select 1
      from public.learning_paths as path
     where path.id = p_path_id
       and (
         path.tenant_id is null
         or path.tenant_id = v_profile.tenant_id
       )
  ) then
    raise exception using
      errcode = '42501',
      message = 'learning_path_not_available';
  end if;

  select *
    into v_enrollment
    from public.student_path_enrollments as enrollment
   where enrollment.student_id = v_student_id
     and enrollment.path_id = p_path_id
     and enrollment.tenant_id = v_profile.tenant_id
     and (
       (
         enrollment.status = 'ACTIVE'
         and enrollment.completed_at is null
       )
       or (
         enrollment.status = 'COMPLETED'
         and enrollment.completed_at is not null
       )
     )
   order by
     case when enrollment.status = 'ACTIVE' then 0 else 1 end,
     enrollment.started_at desc,
     enrollment.id desc
   limit 1;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'learning_path_enrollment_required';
  end if;

  if v_enrollment.status = 'ACTIVE' then
    select next_activity.activity_id
      into v_current_activity_id
      from private.next_incomplete_learning_activity(
        v_student_id,
        p_path_id
      ) as next_activity;
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.to_jsonb(unit)
             order by unit.order_index, unit.id
           ),
           '[]'::jsonb
         )
    into v_units
    from public.learning_units as unit
   where unit.path_id = p_path_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             (
               pg_catalog.to_jsonb(activity) - 'content'
             ) || pg_catalog.jsonb_build_object(
               'content', case
                 when v_enrollment.status = 'COMPLETED'
                      or coalesce(progress.status = 'COMPLETED', false)
                      or activity.id = v_current_activity_id then
                   case
                     when activity.type in (
                       'quiz',
                       'grammar_drill',
                       'reading'
                     ) then private.strip_student_answer_keys(activity.content)
                     else activity.content
                   end
                 else null
               end,
               'locked', not (
                 v_enrollment.status = 'COMPLETED'
                 or coalesce(progress.status = 'COMPLETED', false)
                 or activity.id = v_current_activity_id
               )
             )
             order by unit.order_index, activity.order_index, activity.id
           ),
           '[]'::jsonb
         )
    into v_activities
    from public.learning_units as unit
    join public.unit_activities as activity
      on activity.unit_id = unit.id
    left join public.student_activity_progress as progress
      on progress.student_id = v_student_id
     and progress.activity_id = activity.id
   where unit.path_id = p_path_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.to_jsonb(progress)
             order by unit.order_index, activity.order_index, activity.id
           ),
           '[]'::jsonb
         )
    into v_progress
    from public.student_activity_progress as progress
    join public.unit_activities as activity
      on activity.id = progress.activity_id
    join public.learning_units as unit
      on unit.id = activity.unit_id
   where progress.student_id = v_student_id
     and unit.path_id = p_path_id;

  return pg_catalog.jsonb_build_object(
    'units', v_units,
    'activities', v_activities,
    'progress', v_progress
  );
end;
$function$;

alter function public.get_student_learning_path_runtime(uuid)
  owner to postgres;
revoke all on function public.get_student_learning_path_runtime(uuid)
  from public, anon, authenticated;
grant execute on function public.get_student_learning_path_runtime(uuid)
  to authenticated, service_role;

create or replace function private.safe_student_complementary_content(
  p_type text,
  p_content text
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_content jsonb;
begin
  begin
    v_content := p_content::jsonb;
  exception
    when others then
      return pg_catalog.to_jsonb(p_content);
  end;

  if pg_catalog.jsonb_typeof(v_content) is distinct from 'object' then
    return pg_catalog.to_jsonb(p_content);
  end if;

  if p_type in ('quiz', 'grammar') then
    return private.strip_student_answer_keys(v_content);
  end if;

  return v_content;
end;
$function$;

alter function private.safe_student_complementary_content(text, text)
  owner to postgres;
revoke all on function private.safe_student_complementary_content(text, text)
  from public, anon, authenticated;

create or replace function public.get_student_complementary_activities(
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_result jsonb;
begin
  if v_student_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'invalid_complementary_activity_limit';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             (
               pg_catalog.to_jsonb(activity) - 'content'
             ) || pg_catalog.jsonb_build_object(
               'content', private.safe_student_complementary_content(
                 activity.type,
                 activity.content
               )
             )
             order by activity.created_at desc, activity.id desc
           ),
           '[]'::jsonb
         )
    into v_result
    from (
      select owned_activity.*
        from public.student_activities as owned_activity
       where owned_activity.student_id = v_student_id
         and owned_activity.tenant_id = v_profile.tenant_id
       order by owned_activity.created_at desc, owned_activity.id desc
       limit p_limit
    ) as activity;

  return v_result;
end;
$function$;

alter function public.get_student_complementary_activities(integer)
  owner to postgres;
revoke all on function public.get_student_complementary_activities(integer)
  from public, anon, authenticated;
grant execute on function public.get_student_complementary_activities(integer)
  to authenticated, service_role;

create or replace function public.enroll_student_learning_path(
  p_path_id uuid,
  p_switch_current boolean default false,
  p_reason text default null,
  p_student_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor record;
  v_target_id uuid := coalesce(p_student_id, auth.uid());
  v_target record;
  v_path record;
  v_active public.student_path_enrollments%rowtype;
  v_existing public.student_path_enrollments%rowtype;
  v_enrollment public.student_path_enrollments%rowtype;
  v_next record;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_now timestamptz := pg_catalog.now();
  v_event_type text;
  v_switched boolean := false;
begin
  if v_actor_id is null or p_path_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if v_reason is not null and pg_catalog.length(v_reason) > 500 then
    raise exception using
      errcode = '22023',
      message = 'invalid_learning_enrollment_reason';
  end if;

  select profile.id, profile.role, profile.tenant_id
    into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;

  if not found or v_actor.role not in (
    'STUDENT',
    'TEACHER',
    'SCHOOL_ADMIN',
    'SUPER_ADMIN'
  ) then
    raise exception using
      errcode = '42501',
      message = 'learning_enrollment_actor_not_authorized';
  end if;

  if v_actor.role = 'STUDENT' and v_target_id <> v_actor_id then
    raise exception using
      errcode = '42501',
      message = 'student_can_only_enroll_self';
  end if;

  select profile.id, profile.role, profile.tenant_id
    into v_target
    from public.profiles as profile
   where profile.id = v_target_id
   for update;

  if not found
     or v_target.role <> 'STUDENT'
     or v_target.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  if v_actor.role = 'TEACHER'
     and not public._teacher_can_access_student(
       v_target_id,
       v_target.tenant_id
     ) then
    raise exception using
      errcode = '42501',
      message = 'teacher_student_scope_required';
  elsif v_actor.role = 'SCHOOL_ADMIN'
        and v_actor.tenant_id is distinct from v_target.tenant_id then
    raise exception using
      errcode = '42501',
      message = 'learning_enrollment_tenant_mismatch';
  end if;

  select path.id, path.tenant_id, path.active
    into v_path
    from public.learning_paths as path
   where path.id = p_path_id
     and path.active is true
     and (
       path.tenant_id is null
       or path.tenant_id = v_target.tenant_id
     );

  if not found then
    raise exception using
      errcode = '42501',
      message = 'learning_path_not_available';
  end if;

  select next_activity.activity_id, next_activity.unit_id
    into v_next
    from private.next_incomplete_learning_activity(
      v_target_id,
      p_path_id
    ) as next_activity;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'learning_path_has_no_available_activities';
  end if;

  select *
    into v_active
    from public.student_path_enrollments as enrollment
   where enrollment.student_id = v_target_id
     and enrollment.status = 'ACTIVE'
     and enrollment.completed_at is null
   order by enrollment.started_at desc nulls last, enrollment.id desc
   limit 1
   for update;

  if found and v_active.path_id = p_path_id then
    if v_active.current_unit_id is distinct from v_next.unit_id then
      update public.student_path_enrollments
         set current_unit_id = v_next.unit_id,
             updated_at = v_now
       where id = v_active.id
      returning * into v_active;
    end if;

    return pg_catalog.jsonb_build_object(
      'enrollmentId', v_active.id,
      'studentId', v_target_id,
      'pathId', p_path_id,
      'status', v_active.status,
      'currentUnitId', v_active.current_unit_id,
      'alreadyEnrolled', true,
      'switched', false
    );
  end if;

  if found then
    if coalesce(p_switch_current, false) is not true then
      raise exception using
        errcode = 'P0001',
        message = 'active_path_switch_required';
    end if;

    if v_reason is null then
      raise exception using
        errcode = '22023',
        message = 'learning_path_switch_reason_required';
    end if;

    update public.student_path_enrollments
       set status = 'SWITCHED',
           status_reason = v_reason,
           completed_at = v_now,
           ended_at = v_now,
           updated_at = v_now
     where id = v_active.id;

    insert into public.student_path_enrollment_history (
      enrollment_id,
      tenant_id,
      student_id,
      path_id,
      event_type,
      from_status,
      to_status,
      reason,
      actor_id,
      occurred_at
    ) values (
      v_active.id,
      v_active.tenant_id,
      v_target_id,
      v_active.path_id,
      'SWITCHED_OUT',
      'ACTIVE',
      'SWITCHED',
      v_reason,
      v_actor_id,
      v_now
    );
    v_switched := true;
  end if;

  select *
    into v_existing
    from public.student_path_enrollments as enrollment
   where enrollment.student_id = v_target_id
     and enrollment.path_id = p_path_id
   for update;

  if found then
    update public.student_path_enrollments
       set tenant_id = v_target.tenant_id,
           status = 'ACTIVE',
           status_reason = v_reason,
           current_unit_id = v_next.unit_id,
           started_at = v_now,
           completed_at = null,
           ended_at = null,
           assigned_by = case
             when v_actor.role = 'STUDENT' then null
             else v_actor_id
           end,
           updated_at = v_now
     where id = v_existing.id
    returning * into v_enrollment;
    v_event_type := 'REACTIVATED';
  else
    insert into public.student_path_enrollments (
      student_id,
      path_id,
      tenant_id,
      current_unit_id,
      started_at,
      completed_at,
      assigned_by,
      status,
      status_reason,
      ended_at,
      updated_at
    ) values (
      v_target_id,
      p_path_id,
      v_target.tenant_id,
      v_next.unit_id,
      v_now,
      null,
      case when v_actor.role = 'STUDENT' then null else v_actor_id end,
      'ACTIVE',
      v_reason,
      null,
      v_now
    )
    returning * into v_enrollment;
    v_event_type := 'ENROLLED';
  end if;

  insert into public.student_path_enrollment_history (
    enrollment_id,
    tenant_id,
    student_id,
    path_id,
    event_type,
    from_status,
    to_status,
    reason,
    actor_id,
    occurred_at
  ) values (
    v_enrollment.id,
    v_enrollment.tenant_id,
    v_target_id,
    p_path_id,
    v_event_type,
    case when v_event_type = 'REACTIVATED' then v_existing.status else null end,
    'ACTIVE',
    v_reason,
    v_actor_id,
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'enrollmentId', v_enrollment.id,
    'studentId', v_target_id,
    'pathId', p_path_id,
    'status', v_enrollment.status,
    'currentUnitId', v_enrollment.current_unit_id,
    'alreadyEnrolled', false,
    'switched', v_switched
  );
end;
$function$;

alter function public.enroll_student_learning_path(
  uuid,
  boolean,
  text,
  uuid
) owner to postgres;
revoke all on function public.enroll_student_learning_path(
  uuid,
  boolean,
  text,
  uuid
) from public, anon, authenticated;
grant execute on function public.enroll_student_learning_path(
  uuid,
  boolean,
  text,
  uuid
) to authenticated, service_role;

create or replace function public.schedule_student_vocab_review(
  p_activity_id uuid,
  p_term text,
  p_translation text,
  p_example text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_activity record;
  v_enrollment public.student_path_enrollments%rowtype;
  v_current record;
  v_card jsonb;
  v_term text := pg_catalog.btrim(coalesce(p_term, ''));
  v_translation text := pg_catalog.btrim(coalesce(p_translation, ''));
  v_example text := nullif(pg_catalog.btrim(coalesce(p_example, '')), '');
  v_review public.student_vocab_reviews%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  if v_student_id is null or p_activity_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if pg_catalog.length(v_term) not between 1 and 200
     or pg_catalog.length(v_translation) not between 1 and 500
     or (v_example is not null and pg_catalog.length(v_example) > 2000) then
    raise exception using
      errcode = '22023',
      message = 'invalid_vocab_review_card';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select
    activity.id,
    activity.unit_id,
    activity.content,
    unit.path_id
    into v_activity
    from public.unit_activities as activity
    join public.learning_units as unit
      on unit.id = activity.unit_id
    join public.learning_paths as path
      on path.id = unit.path_id
   where activity.id = p_activity_id
     and activity.type = 'vocab_cards'
     and path.active is true
     and (
       path.tenant_id is null
       or path.tenant_id = v_profile.tenant_id
     );

  if not found
     or pg_catalog.jsonb_typeof(v_activity.content -> 'cards')
          is distinct from 'array' then
    raise exception using
      errcode = '42501',
      message = 'vocab_activity_not_available';
  end if;

  select *
    into v_enrollment
    from public.student_path_enrollments as enrollment
   where enrollment.student_id = v_student_id
     and enrollment.path_id = v_activity.path_id
     and enrollment.tenant_id = v_profile.tenant_id
     and enrollment.status = 'ACTIVE'
     and enrollment.completed_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'active_learning_enrollment_required';
  end if;

  select next_activity.activity_id, next_activity.unit_id
    into v_current
    from private.next_incomplete_learning_activity(
      v_student_id,
      v_activity.path_id
    ) as next_activity;

  if not found or v_current.activity_id <> p_activity_id then
    raise exception using
      errcode = 'P0001',
      message = 'learning_activity_not_current';
  end if;

  select card.value
    into v_card
    from pg_catalog.jsonb_array_elements(
      v_activity.content -> 'cards'
    ) as card(value)
   where pg_catalog.jsonb_typeof(card.value) = 'object'
     and pg_catalog.btrim(coalesce(card.value ->> 'term', '')) = v_term
     and pg_catalog.btrim(coalesce(card.value ->> 'translation', '')) =
           v_translation
     and nullif(
           pg_catalog.btrim(coalesce(card.value ->> 'example', '')),
           ''
         ) is not distinct from v_example
   limit 1;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'vocab_review_card_not_in_activity';
  end if;

  insert into public.student_vocab_reviews (
    tenant_id,
    student_id,
    term,
    translation,
    example,
    source_activity_id,
    interval_days,
    consecutive_correct,
    next_review_at,
    created_at,
    updated_at
  ) values (
    v_profile.tenant_id,
    v_student_id,
    v_term,
    v_translation,
    v_example,
    p_activity_id,
    1,
    0,
    v_now + interval '1 day',
    v_now,
    v_now
  )
  on conflict (student_id, term) do update
    set tenant_id = excluded.tenant_id,
        translation = excluded.translation,
        example = excluded.example,
        source_activity_id = excluded.source_activity_id,
        interval_days = 1,
        consecutive_correct = 0,
        next_review_at = excluded.next_review_at,
        updated_at = v_now
  returning * into v_review;

  return pg_catalog.jsonb_build_object(
    'reviewId', v_review.id,
    'term', v_review.term,
    'intervalDays', v_review.interval_days,
    'consecutiveCorrect', v_review.consecutive_correct,
    'totalReviews', v_review.total_reviews,
    'nextReviewAt', v_review.next_review_at
  );
end;
$function$;

alter function public.schedule_student_vocab_review(
  uuid,
  text,
  text,
  text
) owner to postgres;
revoke all on function public.schedule_student_vocab_review(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.schedule_student_vocab_review(
  uuid,
  text,
  text,
  text
) to authenticated, service_role;

create or replace function public.submit_student_vocab_review(
  p_review_id uuid,
  p_correct boolean,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_request_key text := pg_catalog.btrim(coalesce(p_request_key, ''));
  v_existing public.student_vocab_review_attempts%rowtype;
  v_review public.student_vocab_reviews%rowtype;
  v_interval integer;
  v_streak integer;
  v_result jsonb;
  v_now timestamptz := pg_catalog.now();
begin
  if v_student_id is null or p_review_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if p_correct is null
     or pg_catalog.length(v_request_key) not between 8 and 180 then
    raise exception using
      errcode = '22023',
      message = 'invalid_vocab_review_submission';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select *
    into v_existing
    from public.student_vocab_review_attempts as attempt
   where attempt.student_id = v_student_id
     and attempt.request_key = v_request_key
   for update;

  if found then
    if v_existing.review_id <> p_review_id
       or v_existing.correct is distinct from p_correct then
      raise exception using
        errcode = '22023',
        message = 'idempotency_key_reused';
    end if;

    return v_existing.result || pg_catalog.jsonb_build_object(
      'alreadyApplied', true
    );
  end if;

  select *
    into v_review
    from public.student_vocab_reviews as review
   where review.id = p_review_id
     and review.student_id = v_student_id
     and review.tenant_id = v_profile.tenant_id
   for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'vocab_review_not_owned';
  end if;

  v_interval := case
    when p_correct is false then 1
    when v_review.interval_days >= 60 then 120
    when v_review.interval_days >= 30 then 60
    when v_review.interval_days >= 14 then 30
    when v_review.interval_days >= 7 then 14
    when v_review.interval_days >= 3 then 7
    when v_review.interval_days >= 1 then 3
    else 1
  end;

  update public.student_vocab_reviews
     set interval_days = v_interval,
         consecutive_correct = case
           when p_correct then v_review.consecutive_correct + 1
           else 0
         end,
         total_reviews = v_review.total_reviews + 1,
         next_review_at = v_now + pg_catalog.make_interval(days => v_interval),
         last_reviewed_at = v_now,
         updated_at = v_now
   where id = p_review_id
  returning * into v_review;

  -- A submitted review is real practice, but it is not an objective skill
  -- assessment. Record attendance/streak once while leaving skill scores alone.
  v_streak := private.record_student_learning_practice(
    v_student_id,
    case when p_correct then 100 else 0 end,
    'vocab_review',
    array[]::text[],
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'reviewId', v_review.id,
    'correct', p_correct,
    'intervalDays', v_review.interval_days,
    'consecutiveCorrect', v_review.consecutive_correct,
    'totalReviews', v_review.total_reviews,
    'nextReviewAt', v_review.next_review_at,
    'streakCount', v_streak,
    'alreadyApplied', false
  );

  insert into public.student_vocab_review_attempts (
    tenant_id,
    student_id,
    review_id,
    request_key,
    correct,
    result,
    created_at
  ) values (
    v_profile.tenant_id,
    v_student_id,
    p_review_id,
    v_request_key,
    p_correct,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

alter function public.submit_student_vocab_review(uuid, boolean, text)
  owner to postgres;
revoke all on function public.submit_student_vocab_review(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.submit_student_vocab_review(
  uuid,
  boolean,
  text
) to authenticated, service_role;

create or replace function private.learning_text_array_is_valid(
  p_value jsonb,
  p_min_items integer,
  p_max_items integer,
  p_max_item_length integer
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case
    when coalesce(pg_catalog.jsonb_typeof(p_value), 'null') <> 'array' then false
    when pg_catalog.jsonb_array_length(p_value)
           not between p_min_items and p_max_items then false
    else not exists (
      select 1
        from pg_catalog.jsonb_array_elements(p_value) as item(value)
       where pg_catalog.jsonb_typeof(item.value) <> 'string'
          or pg_catalog.length(
               pg_catalog.btrim(item.value #>> '{}')
             ) not between 1 and p_max_item_length
    )
  end;
$function$;

alter function private.learning_text_array_is_valid(
  jsonb,
  integer,
  integer,
  integer
) owner to postgres;
revoke all on function private.learning_text_array_is_valid(
  jsonb,
  integer,
  integer,
  integer
) from public, anon, authenticated;

create or replace function private.generated_activity_content_is_valid(
  p_type text,
  p_content jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_items jsonb;
  v_item jsonb;
  v_options jsonb;
  v_prompt text;
  v_correct_text text;
  v_correct_index integer;
  v_option_count integer;
  v_distinct_options integer;
begin
  if coalesce(pg_catalog.jsonb_typeof(p_content), 'null') <> 'object'
     or p_content = '{}'::jsonb then
    return false;
  end if;

  if p_type = 'reading' then
    return coalesce(
      pg_catalog.length(
             pg_catalog.btrim(coalesce(p_content ->> 'instructions_pt', ''))
           ) between 3 and 2000
       and pg_catalog.length(
             pg_catalog.btrim(coalesce(
               p_content ->> 'text',
               p_content ->> 'passage',
               p_content ->> 'reading_text',
               ''
             ))
           ) between 20 and 12000
       and private.learning_text_array_is_valid(
             p_content -> 'checklist',
             1,
             12,
             500
           )
       and pg_catalog.length(
             pg_catalog.btrim(coalesce(
               p_content ->> 'reflection_prompt',
               p_content ->> 'reflectionPrompt',
               ''
             ))
           ) between 3 and 1200,
      false
    );
  elsif p_type in ('grammar', 'quiz') then
    if p_type = 'grammar' then
      if pg_catalog.length(
           pg_catalog.btrim(coalesce(p_content ->> 'rule_pt', ''))
         ) not between 3 and 4000 then
        return false;
      end if;
      v_items := p_content -> 'exercises';
    else
      if pg_catalog.length(
           pg_catalog.btrim(coalesce(p_content ->> 'instructions_pt', ''))
         ) not between 3 and 2000 then
        return false;
      end if;
      v_items := p_content -> 'questions';
    end if;

    if coalesce(pg_catalog.jsonb_typeof(v_items), 'null') <> 'array'
       or pg_catalog.jsonb_array_length(v_items) not between 1 and 20 then
      return false;
    end if;

    for v_item in
      select item.value
        from pg_catalog.jsonb_array_elements(v_items) as item(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
        return false;
      end if;

      v_prompt := pg_catalog.btrim(coalesce(
        v_item ->> 'q',
        v_item ->> 'question',
        v_item ->> 'question_text',
        v_item ->> 'sentence',
        v_item ->> 'prompt',
        ''
      ));
      v_options := v_item -> 'options';
      v_correct_text := coalesce(
        v_item ->> 'correct',
        v_item ->> 'correctIndex',
        v_item ->> 'correct_option_index'
      );

      if pg_catalog.length(v_prompt) not between 1 and 2000
         or pg_catalog.jsonb_typeof(v_options) is distinct from 'array'
         or pg_catalog.jsonb_array_length(v_options) not between 2 and 8
         or coalesce(v_correct_text ~ '^[0-9]+$', false) is not true
         or pg_catalog.length(v_correct_text) not between 1 and 2
         or (
           v_item ? 'id'
           and pg_catalog.length(
             pg_catalog.btrim(coalesce(v_item ->> 'id', ''))
           ) not between 1 and 160
         )
         or (
           v_item ? 'exp'
           and (
             pg_catalog.jsonb_typeof(v_item -> 'exp') is distinct from 'string'
             or pg_catalog.length(v_item ->> 'exp') > 2000
           )
         ) then
        return false;
      end if;

      select
        pg_catalog.count(*)::integer,
        pg_catalog.count(
          distinct pg_catalog.btrim(option.value #>> '{}')
        )::integer
        into v_option_count, v_distinct_options
        from pg_catalog.jsonb_array_elements(v_options) as option(value)
       where pg_catalog.jsonb_typeof(option.value) = 'string'
         and pg_catalog.length(
               pg_catalog.btrim(option.value #>> '{}')
             ) between 1 and 500;

      v_correct_index := v_correct_text::integer;
      if v_option_count <> pg_catalog.jsonb_array_length(v_options)
         or v_distinct_options <> v_option_count
         or v_correct_index < 0
         or v_correct_index >= v_option_count then
        return false;
      end if;
    end loop;

    return true;
  elsif p_type = 'conversation' then
    return coalesce(
      pg_catalog.length(
             pg_catalog.btrim(coalesce(p_content ->> 'scenario', ''))
           ) between 2 and 1000
       and pg_catalog.length(
             pg_catalog.btrim(coalesce(p_content ->> 'instructions_pt', ''))
           ) between 3 and 4000
       and private.learning_text_array_is_valid(
             p_content -> 'preparation',
             1,
             12,
             500
           )
       and private.learning_text_array_is_valid(
             p_content -> 'target_phrases',
             1,
             20,
             500
           )
       and pg_catalog.length(
             pg_catalog.btrim(coalesce(
               p_content ->> 'reflection_prompt',
               p_content ->> 'reflectionPrompt',
               ''
             ))
           ) between 3 and 1200,
      false
    );
  end if;

  return false;
end;
$function$;

alter function private.generated_activity_content_is_valid(text, jsonb)
  owner to postgres;
revoke all on function private.generated_activity_content_is_valid(text, jsonb)
  from public, anon, authenticated;

drop function if exists public.save_student_generated_activities(jsonb, text);

create or replace function public.save_student_generated_activities(
  p_student_id uuid,
  p_activities jsonb,
  p_request_key uuid,
  p_reservation_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile record;
  v_reservation public.student_complementary_generation_reservations%rowtype;
  v_existing public.student_generated_activity_batches%rowtype;
  v_batch_id uuid;
  v_request_key text := p_request_key::text;
  v_item jsonb;
  v_type text;
  v_title text;
  v_description text;
  v_content text;
  v_content_json jsonb;
  v_difficulty text;
  v_category text;
  v_seen_types text[] := array[]::text[];
  v_position integer;
  v_pending_count integer;
  v_inserted public.student_activities%rowtype;
  v_activities jsonb := '[]'::jsonb;
  v_result jsonb;
  v_now timestamptz := pg_catalog.now();
begin
  if p_student_id is null
     or p_request_key is null
     or p_reservation_id is null
     or p_lease_token is null then
    raise exception using
      errcode = '42501',
      message = 'generation_reservation_required';
  end if;

  if p_activities is null
     or pg_catalog.jsonb_typeof(p_activities) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_activities) <> 4
     or pg_catalog.pg_column_size(p_activities) > 65536 then
    raise exception using
      errcode = '22023',
      message = 'invalid_generated_activity_batch';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = p_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select *
    into v_reservation
    from public.student_complementary_generation_reservations as reservation
   where reservation.id = p_reservation_id
     and reservation.student_id = p_student_id
     and reservation.tenant_id = v_profile.tenant_id
     and reservation.request_key = p_request_key
   for update;

  if not found or v_reservation.lease_token is distinct from p_lease_token then
    raise exception using
      errcode = '42501',
      message = 'generation_reservation_not_owned';
  end if;

  select *
    into v_existing
    from public.student_generated_activity_batches as batch
   where batch.student_id = p_student_id
     and batch.request_key = v_request_key
   for update;

  if found then
    if v_existing.request_payload is distinct from p_activities then
      raise exception using
        errcode = '22023',
        message = 'idempotency_key_reused';
    end if;

    if v_reservation.status not in ('RESERVED', 'COMMITTED')
       or (
         v_reservation.status = 'COMMITTED'
         and v_reservation.batch_id is distinct from v_existing.id
       ) then
      raise exception using
        errcode = 'P0001',
        message = 'generation_reservation_not_active';
    end if;

    if v_reservation.status = 'RESERVED'
       and v_reservation.lease_expires_at <= v_now then
      raise exception using
        errcode = 'P0001',
        message = 'generation_reservation_expired';
    end if;

    if v_reservation.batch_id is null then
      update public.student_complementary_generation_reservations
         set batch_id = v_existing.id,
             updated_at = v_now
       where id = v_reservation.id;
    end if;

    return v_existing.result || pg_catalog.jsonb_build_object(
      'alreadyApplied', true
    );
  end if;

  if v_reservation.status <> 'RESERVED' then
    raise exception using
      errcode = 'P0001',
      message = 'generation_reservation_not_active';
  end if;

  if v_reservation.lease_expires_at <= v_now then
    raise exception using
      errcode = 'P0001',
      message = 'generation_reservation_expired';
  end if;

  for v_item, v_position in
    select value, ordinality::integer
      from pg_catalog.jsonb_array_elements(p_activities)
           with ordinality
  loop
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using
        errcode = '22023',
        message = 'invalid_generated_activity';
    end if;

    v_type := pg_catalog.lower(
      pg_catalog.btrim(coalesce(v_item ->> 'type', ''))
    );
    v_title := pg_catalog.btrim(coalesce(v_item ->> 'title', ''));
    v_description := pg_catalog.btrim(
      coalesce(v_item ->> 'description', '')
    );
    v_difficulty := pg_catalog.upper(
      pg_catalog.btrim(coalesce(v_item ->> 'difficulty', ''))
    );
    v_category := nullif(
      pg_catalog.btrim(coalesce(v_item ->> 'category', '')),
      ''
    );

    if v_type not in ('reading', 'grammar', 'quiz', 'conversation')
       or v_type = any(v_seen_types)
       or pg_catalog.length(v_title) not between 3 and 160
       or pg_catalog.length(v_description) > 1000
       or v_difficulty not in ('BEGINNER', 'INTERMEDIATE', 'ADVANCED')
       or (v_category is not null and pg_catalog.length(v_category) > 160)
       or pg_catalog.jsonb_typeof(v_item -> 'content')
            is distinct from 'string' then
      raise exception using
        errcode = '22023',
        message = 'invalid_generated_activity';
    end if;

    v_content := v_item ->> 'content';
    if pg_catalog.octet_length(v_content) not between 2 and 16000 then
      raise exception using
        errcode = '22023',
        message = 'invalid_generated_activity_content';
    end if;

    begin
      v_content_json := v_content::jsonb;
    exception
      when others then
        raise exception using
          errcode = '22023',
          message = 'invalid_generated_activity_content';
    end;

    if coalesce(
      private.generated_activity_content_is_valid(
        v_type,
        v_content_json
      ),
      false
    ) is not true then
      raise exception using
        errcode = '22023',
        message = 'invalid_generated_activity_content';
    end if;

    v_seen_types := pg_catalog.array_append(v_seen_types, v_type);
  end loop;

  if not (
    'reading' = any(v_seen_types)
    and 'grammar' = any(v_seen_types)
    and 'quiz' = any(v_seen_types)
    and 'conversation' = any(v_seen_types)
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_generated_activity_type_set';
  end if;

  select pg_catalog.count(*)::integer
    into v_pending_count
    from public.student_activities as activity
   where activity.student_id = p_student_id
     and activity.tenant_id = v_profile.tenant_id
     and activity.status = 'PENDING';

  -- Packs are atomic from the learner's point of view. Any unfinished item
  -- means the previous four-pack is still active and a new generation would
  -- create a confusing mixed queue.
  if v_pending_count > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'pending_complementary_package_exists';
  end if;

  v_batch_id := pg_catalog.gen_random_uuid();
  insert into public.student_generated_activity_batches (
    id,
    tenant_id,
    student_id,
    request_key,
    request_payload,
    result,
    created_at
  ) values (
    v_batch_id,
    v_profile.tenant_id,
    p_student_id,
    v_request_key,
    p_activities,
    '{}'::jsonb,
    v_now
  );

  for v_item, v_position in
    select value, ordinality::integer
      from pg_catalog.jsonb_array_elements(p_activities)
           with ordinality
  loop
    v_type := pg_catalog.lower(
      pg_catalog.btrim(v_item ->> 'type')
    );
    v_title := pg_catalog.btrim(v_item ->> 'title');
    v_description := nullif(
      pg_catalog.btrim(coalesce(v_item ->> 'description', '')),
      ''
    );
    v_content := v_item ->> 'content';
    v_difficulty := pg_catalog.upper(
      pg_catalog.btrim(v_item ->> 'difficulty')
    );
    v_category := nullif(
      pg_catalog.btrim(coalesce(v_item ->> 'category', '')),
      ''
    );

    insert into public.student_activities (
      student_id,
      tenant_id,
      type,
      title,
      description,
      content,
      difficulty,
      category,
      xp_reward,
      status,
      generated_by_ai,
      generation_batch_id,
      generation_position,
      created_at,
      updated_at
    ) values (
      p_student_id,
      v_profile.tenant_id,
      v_type,
      v_title,
      v_description,
      v_content,
      v_difficulty,
      v_category,
      0,
      'PENDING',
      true,
      v_batch_id,
      v_position,
      v_now,
      v_now
    )
    returning * into v_inserted;

    v_activities := v_activities || pg_catalog.jsonb_build_array(
      (
        pg_catalog.to_jsonb(v_inserted) - 'content'
      ) || pg_catalog.jsonb_build_object(
        'content', private.safe_student_complementary_content(
          v_inserted.type,
          v_inserted.content
        )
      )
    );
  end loop;

  v_result := pg_catalog.jsonb_build_object(
    'batchId', v_batch_id,
    'requestKey', v_request_key,
    'alreadyApplied', false,
    'created', true,
    'quotaReached', false,
    'activities', v_activities
  );

  update public.student_generated_activity_batches
     set result = v_result
   where id = v_batch_id;

  update public.student_complementary_generation_reservations
     set batch_id = v_batch_id,
         updated_at = v_now
   where id = v_reservation.id;

  return v_result;
end;
$function$;

alter function public.save_student_generated_activities(
  uuid,
  jsonb,
  uuid,
  uuid,
  uuid
)
  owner to postgres;
revoke all on function public.save_student_generated_activities(
  uuid,
  jsonb,
  uuid,
  uuid,
  uuid
)
  from public, anon, authenticated;
grant execute on function public.save_student_generated_activities(
  uuid,
  jsonb,
  uuid,
  uuid,
  uuid
) to service_role;

create or replace function public.get_student_complementary_generation_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_pending_count integer;
begin
  if v_student_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select pg_catalog.count(*)::integer
    into v_pending_count
    from public.student_activities as activity
   where activity.student_id = v_student_id
     and activity.tenant_id = v_profile.tenant_id
     and activity.status = 'PENDING';

  return pg_catalog.jsonb_build_object(
    'pendingCount', v_pending_count,
    'canGenerate', v_pending_count = 0
  );
end;
$function$;

alter function public.get_student_complementary_generation_status()
  owner to postgres;
revoke all on function public.get_student_complementary_generation_status()
  from public, anon, authenticated;
grant execute on function public.get_student_complementary_generation_status()
  to authenticated, service_role;

create or replace function public.begin_student_complementary_generation(
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_existing public.student_complementary_generation_reservations%rowtype;
  v_active public.student_complementary_generation_reservations%rowtype;
  v_reservation public.student_complementary_generation_reservations%rowtype;
  v_batch public.student_generated_activity_batches%rowtype;
  v_pending_count integer;
  v_daily_count integer;
  v_activities jsonb := '[]'::jsonb;
  v_now timestamptz := pg_catalog.now();
  v_today date := (v_now at time zone 'America/Sao_Paulo')::date;
begin
  if v_student_id is null or p_request_key is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  -- The profile lock serializes tabs. Expire stale leases before inspecting the
  -- request or creating another partial-unique RESERVED row.
  update public.student_complementary_generation_reservations
     set status = 'EXPIRED',
         decision_code = 'LEASE_EXPIRED',
         completed_at = coalesce(completed_at, v_now),
         updated_at = v_now
   where student_id = v_student_id
     and status = 'RESERVED'
     and lease_expires_at <= v_now;

  select *
    into v_existing
    from public.student_complementary_generation_reservations as reservation
   where reservation.student_id = v_student_id
     and reservation.request_key = p_request_key
   for update;

  if found then
    if v_existing.status in ('RELEASED', 'EXPIRED')
       or (
         v_existing.status = 'DENIED'
         and v_existing.decision_code = 'GENERATION_IN_PROGRESS'
       ) then
      -- A provider failure or expired lease must not permanently poison the
      -- stable UI request key. If persistence actually succeeded before the
      -- response was lost, recover it as committed without paying the provider
      -- again; otherwise rotate the lease token on the same reservation row.
      select *
        into v_batch
        from public.student_generated_activity_batches as batch
       where batch.student_id = v_student_id
         and batch.tenant_id = v_profile.tenant_id
         and batch.request_key = p_request_key::text
         and coalesce((batch.result ->> 'created')::boolean, false) is true
       order by batch.created_at desc, batch.id desc
       limit 1;

      if found then
        update public.student_complementary_generation_reservations
           set status = 'COMMITTED',
               decision_code = 'COMMITTED',
               batch_id = v_batch.id,
               completed_at = coalesce(completed_at, v_now),
               updated_at = v_now
         where id = v_existing.id
        returning * into v_existing;

        return pg_catalog.jsonb_build_object(
          'allowed', false,
          'code', 'ALREADY_COMMITTED',
          'reservationId', v_existing.id,
          'leaseToken', null,
          'leaseExpiresAt', v_existing.lease_expires_at,
          'requestKey', v_existing.request_key,
          'replay', true,
          'status', v_existing.status,
          'activities', coalesce(v_batch.result -> 'activities', '[]'::jsonb)
        );
      end if;

      select pg_catalog.count(*)::integer
        into v_pending_count
        from (
          select pending.*
            from public.student_activities as pending
           where pending.student_id = v_student_id
             and pending.tenant_id = v_profile.tenant_id
             and pending.status = 'PENDING'
           order by pending.created_at desc, pending.id desc
           limit 4
        ) as activity;

      if v_pending_count > 0 then
        select coalesce(
                 pg_catalog.jsonb_agg(
                   (
                     pg_catalog.to_jsonb(activity) - 'content'
                   ) || pg_catalog.jsonb_build_object(
                     'content', private.safe_student_complementary_content(
                       activity.type,
                       activity.content
                     )
                   )
                   order by activity.created_at desc, activity.id desc
                 ),
                 '[]'::jsonb
               )
          into v_activities
          from (
            select pending.*
              from public.student_activities as pending
             where pending.student_id = v_student_id
               and pending.tenant_id = v_profile.tenant_id
               and pending.status = 'PENDING'
             order by pending.created_at desc, pending.id desc
             limit 4
          ) as activity;

        return pg_catalog.jsonb_build_object(
          'allowed', false,
          'code', 'PENDING_PACKAGE',
          'reservationId', v_existing.id,
          'leaseToken', null,
          'leaseExpiresAt', null,
          'requestKey', v_existing.request_key,
          'replay', true,
          'status', v_existing.status,
          'activities', v_activities
        );
      end if;

      select *
        into v_active
        from public.student_complementary_generation_reservations as reservation
       where reservation.student_id = v_student_id
         and reservation.status = 'RESERVED'
         and reservation.id <> v_existing.id
       limit 1;

      if found then
        return pg_catalog.jsonb_build_object(
          'allowed', false,
          'code', 'GENERATION_IN_PROGRESS',
          'reservationId', v_existing.id,
          'leaseToken', null,
          'leaseExpiresAt', v_active.lease_expires_at,
          'requestKey', v_existing.request_key,
          'replay', true,
          'status', v_existing.status,
          'activities', '[]'::jsonb
        );
      end if;

      -- A denied second-tab request has not consumed a generation slot yet.
      -- Reusing that key may start work only if today's cost fence still has
      -- room. Released/expired requests already occupy their original slot.
      if v_existing.status = 'DENIED' then
        select pg_catalog.count(*)::integer
          into v_daily_count
          from public.student_complementary_generation_reservations as reservation
         where reservation.student_id = v_student_id
           and reservation.status in (
             'RESERVED',
             'COMMITTED',
             'RELEASED',
             'EXPIRED'
           )
           and (
             reservation.created_at at time zone 'America/Sao_Paulo'
           )::date = v_today;

        if v_daily_count >= 3 then
          update public.student_complementary_generation_reservations
             set decision_code = 'DAILY_LIMIT_REACHED',
                 completed_at = coalesce(completed_at, v_now),
                 updated_at = v_now
           where id = v_existing.id
          returning * into v_existing;

          return pg_catalog.jsonb_build_object(
            'allowed', false,
            'code', 'DAILY_LIMIT_REACHED',
            'reservationId', v_existing.id,
            'leaseToken', null,
            'leaseExpiresAt', null,
            'requestKey', v_existing.request_key,
            'replay', true,
            'status', v_existing.status,
            'activities', '[]'::jsonb
          );
        end if;
      end if;

      update public.student_complementary_generation_reservations
         set lease_token = pg_catalog.gen_random_uuid(),
             status = 'RESERVED',
             decision_code = 'RESERVED',
             lease_expires_at = v_now + interval '5 minutes',
             batch_id = null,
             failure_reason = null,
             completed_at = null,
             created_at = case
               when v_existing.status = 'DENIED' then v_now
               else created_at
             end,
             updated_at = v_now
       where id = v_existing.id
      returning * into v_existing;

      return pg_catalog.jsonb_build_object(
        'allowed', true,
        'code', 'RESERVED',
        'reservationId', v_existing.id,
        'leaseToken', v_existing.lease_token,
        'leaseExpiresAt', v_existing.lease_expires_at,
        'requestKey', v_existing.request_key,
        'replay', true,
        'status', v_existing.status,
        'activities', '[]'::jsonb
      );
    end if;

    -- Replaying a still-active key must never hand the lease token to a second
    -- provider invocation. The original Edge request owns the only active run.
    if v_existing.status = 'RESERVED' then
      return pg_catalog.jsonb_build_object(
        'allowed', false,
        'code', 'GENERATION_IN_PROGRESS',
        'reservationId', v_existing.id,
        'leaseToken', null,
        'leaseExpiresAt', v_existing.lease_expires_at,
        'requestKey', v_existing.request_key,
        'replay', true,
        'status', v_existing.status,
        'activities', '[]'::jsonb
      );
    end if;

    if v_existing.status = 'COMMITTED' and v_existing.batch_id is not null then
      select coalesce(batch.result -> 'activities', '[]'::jsonb)
        into v_activities
        from public.student_generated_activity_batches as batch
       where batch.id = v_existing.batch_id
         and batch.student_id = v_student_id;
    elsif v_existing.decision_code = 'PENDING_PACKAGE' then
      select coalesce(
               pg_catalog.jsonb_agg(
                 (
                   pg_catalog.to_jsonb(activity) - 'content'
                 ) || pg_catalog.jsonb_build_object(
                   'content', private.safe_student_complementary_content(
                     activity.type,
                     activity.content
                   )
                 )
                 order by activity.created_at desc, activity.id desc
               ),
               '[]'::jsonb
             )
        into v_activities
        from (
          select pending.*
            from public.student_activities as pending
           where pending.student_id = v_student_id
             and pending.tenant_id = v_profile.tenant_id
             and pending.status = 'PENDING'
           order by pending.created_at desc, pending.id desc
           limit 4
        ) as activity;
    end if;

    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', case
        when v_existing.status = 'COMMITTED' then 'ALREADY_COMMITTED'
        else v_existing.decision_code
      end,
      'reservationId', v_existing.id,
      'leaseToken', case
        when v_existing.status = 'RESERVED' then v_existing.lease_token
        else null
      end,
      'leaseExpiresAt', v_existing.lease_expires_at,
      'requestKey', v_existing.request_key,
      'replay', true,
      'status', v_existing.status,
      'activities', v_activities
    );
  end if;

  select pg_catalog.count(*)::integer
    into v_pending_count
    from public.student_activities as activity
   where activity.student_id = v_student_id
     and activity.tenant_id = v_profile.tenant_id
     and activity.status = 'PENDING';

  if v_pending_count > 0 then
    select coalesce(
             pg_catalog.jsonb_agg(
               (
                 pg_catalog.to_jsonb(activity) - 'content'
               ) || pg_catalog.jsonb_build_object(
                 'content', private.safe_student_complementary_content(
                   activity.type,
                   activity.content
                 )
               )
               order by activity.created_at desc, activity.id desc
             ),
             '[]'::jsonb
           )
      into v_activities
      from (
        select pending.*
          from public.student_activities as pending
         where pending.student_id = v_student_id
           and pending.tenant_id = v_profile.tenant_id
           and pending.status = 'PENDING'
         order by pending.created_at desc, pending.id desc
         limit 4
      ) as activity;

    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'PENDING_PACKAGE',
      'reservationId', null,
      'leaseToken', null,
      'leaseExpiresAt', null,
      'requestKey', p_request_key,
      'replay', false,
      'status', 'DENIED',
      'activities', v_activities
    );
  end if;

  select *
    into v_active
    from public.student_complementary_generation_reservations as reservation
   where reservation.student_id = v_student_id
     and reservation.status = 'RESERVED'
   limit 1;

  if found then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'GENERATION_IN_PROGRESS',
      'reservationId', null,
      'leaseToken', null,
      'leaseExpiresAt', v_active.lease_expires_at,
      'requestKey', p_request_key,
      'replay', false,
      'status', 'DENIED',
      'activities', '[]'::jsonb
    );
  end if;

  select pg_catalog.count(*)::integer
    into v_daily_count
    from public.student_complementary_generation_reservations as reservation
   where reservation.student_id = v_student_id
     and reservation.status in ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED')
     and (reservation.created_at at time zone 'America/Sao_Paulo')::date =
           v_today;

  if v_daily_count >= 3 then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'code', 'DAILY_LIMIT_REACHED',
      'reservationId', null,
      'leaseToken', null,
      'leaseExpiresAt', null,
      'requestKey', p_request_key,
      'replay', false,
      'status', 'DENIED',
      'activities', '[]'::jsonb
    );
  end if;

  insert into public.student_complementary_generation_reservations (
    tenant_id,
    student_id,
    request_key,
    lease_token,
    status,
    decision_code,
    lease_expires_at,
    created_at,
    updated_at
  ) values (
    v_profile.tenant_id,
    v_student_id,
    p_request_key,
    pg_catalog.gen_random_uuid(),
    'RESERVED',
    'RESERVED',
    v_now + interval '5 minutes',
    v_now,
    v_now
  ) returning * into v_reservation;

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'code', 'RESERVED',
    'reservationId', v_reservation.id,
    'leaseToken', v_reservation.lease_token,
    'leaseExpiresAt', v_reservation.lease_expires_at,
    'requestKey', p_request_key,
    'replay', false,
    'status', v_reservation.status,
    'activities', '[]'::jsonb
  );
end;
$function$;

alter function public.begin_student_complementary_generation(uuid)
  owner to postgres;
revoke all on function public.begin_student_complementary_generation(uuid)
  from public, anon, authenticated;
grant execute on function public.begin_student_complementary_generation(uuid)
  to authenticated, service_role;

drop function if exists public.commit_student_complementary_generation(
  uuid,
  uuid,
  uuid
);

create or replace function public.commit_student_complementary_generation(
  p_student_id uuid,
  p_reservation_id uuid,
  p_lease_token uuid,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile record;
  v_reservation public.student_complementary_generation_reservations%rowtype;
  v_batch public.student_generated_activity_batches%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  if p_student_id is null
     or p_reservation_id is null
     or p_lease_token is null
     or p_request_key is null then
    raise exception using
      errcode = '42501',
      message = 'generation_reservation_required';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = p_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select *
    into v_reservation
    from public.student_complementary_generation_reservations as reservation
   where reservation.id = p_reservation_id
     and reservation.student_id = p_student_id
     and reservation.tenant_id = v_profile.tenant_id
     and reservation.request_key = p_request_key
   for update;

  if not found or v_reservation.lease_token is distinct from p_lease_token then
    raise exception using
      errcode = '42501',
      message = 'generation_reservation_not_owned';
  end if;

  if v_reservation.status = 'COMMITTED' then
    select *
      into v_batch
     from public.student_generated_activity_batches as batch
     where batch.id = v_reservation.batch_id
       and batch.student_id = p_student_id
       and batch.tenant_id = v_profile.tenant_id
       and batch.request_key = p_request_key::text;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'generated_activity_batch_not_persisted';
    end if;

    return pg_catalog.jsonb_build_object(
      'reservationId', v_reservation.id,
      'requestKey', v_reservation.request_key,
      'status', v_reservation.status,
      'code', 'ALREADY_COMMITTED',
      'batchId', v_reservation.batch_id,
      'replay', true,
      'activities', coalesce(v_batch.result -> 'activities', '[]'::jsonb)
    );
  end if;

  if v_reservation.status <> 'RESERVED' then
    raise exception using
      errcode = 'P0001',
      message = 'generation_reservation_not_active';
  end if;

  if v_reservation.lease_expires_at <= v_now then
    raise exception using
      errcode = 'P0001',
      message = 'generation_reservation_expired';
  end if;

  select *
    into v_batch
    from public.student_generated_activity_batches as batch
   where batch.student_id = p_student_id
     and batch.tenant_id = v_profile.tenant_id
     and batch.request_key = p_request_key::text
   order by batch.created_at desc, batch.id desc
   limit 1;

  if not found
     or coalesce((v_batch.result ->> 'created')::boolean, false) is not true then
    raise exception using
      errcode = 'P0001',
      message = 'generated_activity_batch_not_persisted';
  end if;

  update public.student_complementary_generation_reservations
     set status = 'COMMITTED',
         decision_code = 'COMMITTED',
         batch_id = v_batch.id,
         completed_at = v_now,
         updated_at = v_now
   where id = v_reservation.id
  returning * into v_reservation;

  return pg_catalog.jsonb_build_object(
    'reservationId', v_reservation.id,
    'requestKey', v_reservation.request_key,
    'status', v_reservation.status,
    'code', v_reservation.decision_code,
    'batchId', v_batch.id,
    'replay', false,
    'activities', coalesce(v_batch.result -> 'activities', '[]'::jsonb)
  );
end;
$function$;

alter function public.commit_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  uuid
)
  owner to postgres;
revoke all on function public.commit_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  uuid
) from public, anon, authenticated;
grant execute on function public.commit_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  uuid
) to service_role;

create or replace function public.release_student_complementary_generation(
  p_reservation_id uuid,
  p_lease_token uuid,
  p_request_key uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_reservation public.student_complementary_generation_reservations%rowtype;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_now timestamptz := pg_catalog.now();
begin
  if v_student_id is null
     or p_reservation_id is null
     or p_lease_token is null
     or p_request_key is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if v_reason is not null and pg_catalog.length(v_reason) > 500 then
    raise exception using
      errcode = '22023',
      message = 'invalid_generation_release_reason';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select *
    into v_reservation
    from public.student_complementary_generation_reservations as reservation
   where reservation.id = p_reservation_id
     and reservation.student_id = v_student_id
     and reservation.tenant_id = v_profile.tenant_id
     and reservation.request_key = p_request_key
   for update;

  if not found or v_reservation.lease_token is distinct from p_lease_token then
    raise exception using
      errcode = '42501',
      message = 'generation_reservation_not_owned';
  end if;

  if v_reservation.status <> 'RESERVED' then
    return pg_catalog.jsonb_build_object(
      'reservationId', v_reservation.id,
      'requestKey', v_reservation.request_key,
      'status', v_reservation.status,
      'code', v_reservation.decision_code,
      'reason', v_reservation.failure_reason,
      'replay', true
    );
  end if;

  update public.student_complementary_generation_reservations
     set status = 'RELEASED',
         decision_code = 'RELEASED',
         failure_reason = v_reason,
         completed_at = v_now,
         updated_at = v_now
   where id = v_reservation.id
  returning * into v_reservation;

  return pg_catalog.jsonb_build_object(
    'reservationId', v_reservation.id,
    'requestKey', v_reservation.request_key,
    'status', v_reservation.status,
    'code', v_reservation.decision_code,
    'reason', v_reservation.failure_reason,
    'replay', false
  );
end;
$function$;

alter function public.release_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  text
) owner to postgres;
revoke all on function public.release_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.release_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  text
) to authenticated, service_role;

create or replace function public.complete_student_complementary_activity(
  p_activity_id uuid,
  p_evidence jsonb,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_activity public.student_activities%rowtype;
  v_existing_attempt public.student_complementary_activity_attempts%rowtype;
  v_request_key text := pg_catalog.btrim(coalesce(p_request_key, ''));
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb) - 'completedAt';
  v_content_json jsonb;
  v_questions jsonb;
  v_question jsonb;
  v_answer jsonb;
  v_question_id jsonb;
  v_checklist jsonb;
  v_expected_checklist jsonb;
  v_question_count integer;
  v_checklist_count integer;
  v_distinct_checklist_count integer;
  v_option_count integer;
  v_selected_index integer;
  v_correct_index integer;
  v_correct_count integer := 0;
  v_score integer;
  v_expected_question_id text;
  v_question_results jsonb := '[]'::jsonb;
  v_passed boolean;
  v_status text;
  v_streak integer;
  v_result jsonb;
  v_now timestamptz := pg_catalog.now();
  i integer;
begin
  if v_student_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if p_activity_id is null
     or pg_catalog.length(v_request_key) not between 8 and 180
     or p_evidence is null
     or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
     or p_evidence = '{}'::jsonb
     or pg_catalog.pg_column_size(p_evidence) > 32768 then
    raise exception using
      errcode = '22023',
      message = 'invalid_complementary_activity_completion';
  end if;

  select
    profile.tenant_id,
    profile.role,
    coalesce(profile.streak_count, 0) as streak_count
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select *
    into v_activity
    from public.student_activities as activity
   where activity.id = p_activity_id
     and activity.student_id = v_student_id
     and activity.tenant_id = v_profile.tenant_id
   for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'complementary_activity_not_owned';
  end if;

  select *
    into v_existing_attempt
    from public.student_complementary_activity_attempts as attempt
   where attempt.student_id = v_student_id
     and attempt.request_key = v_request_key
   for update;

  if found then
    if v_existing_attempt.activity_id <> p_activity_id
       or v_existing_attempt.evidence is distinct from v_evidence then
      raise exception using
        errcode = '22023',
        message = 'idempotency_key_reused';
    end if;

    return v_existing_attempt.result || pg_catalog.jsonb_build_object(
      'alreadyApplied', true
    );
  end if;

  if v_evidence ->> 'activityId' is distinct from p_activity_id::text
     or v_evidence ->> 'activityType' is distinct from v_activity.type
     or coalesce(v_evidence ->> 'contentMode', '')
          not in ('legacy', 'structured') then
    raise exception using
      errcode = '22023',
      message = 'invalid_complementary_activity_evidence';
  end if;

  begin
    v_content_json := v_activity.content::jsonb;
  exception
    when others then
      v_content_json := null;
  end;

  if v_evidence ->> 'contentMode' = 'structured'
     and pg_catalog.jsonb_typeof(v_content_json) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'invalid_complementary_activity_evidence';
  elsif v_evidence ->> 'contentMode' = 'legacy'
        and pg_catalog.jsonb_typeof(v_content_json) = 'object' then
    raise exception using
      errcode = '22023',
      message = 'invalid_complementary_activity_evidence';
  end if;

  if v_evidence ->> 'contentMode' = 'structured'
     and v_activity.type in ('quiz', 'grammar') then
    v_questions := case v_activity.type
      when 'grammar' then v_content_json -> 'exercises'
      else v_content_json -> 'questions'
    end;

    if pg_catalog.jsonb_typeof(v_questions) is distinct from 'array' then
      raise exception using
        errcode = '22023',
        message = 'invalid_complementary_activity_evidence';
    end if;

    v_question_count := pg_catalog.jsonb_array_length(v_questions);
    if v_question_count not between 1 and 20
       or pg_catalog.jsonb_typeof(v_evidence -> 'answers')
            is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_evidence -> 'answers')
            <> v_question_count
       or pg_catalog.jsonb_typeof(v_evidence -> 'questionIds')
            is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_evidence -> 'questionIds')
            <> v_question_count
       or v_evidence ? 'questionResults'
       or v_evidence ? 'scorePercentage' then
      raise exception using
        errcode = '22023',
        message = 'invalid_complementary_activity_evidence';
    end if;

    for i in 0 .. v_question_count - 1 loop
      v_question := v_questions -> i;
      v_answer := v_evidence -> 'answers' -> i;
      v_question_id := v_evidence -> 'questionIds' -> i;
      v_expected_question_id := coalesce(
        nullif(pg_catalog.btrim(v_question ->> 'id'), ''),
        'question-' || (i + 1)::text
      );

      if pg_catalog.jsonb_typeof(v_question) is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_question -> 'options')
              is distinct from 'array'
         or coalesce(
              coalesce(
                v_question ->> 'correct',
                v_question ->> 'correctIndex',
                v_question ->> 'correct_option_index'
              ) ~ '^[0-9]+$',
              false
            ) is not true
         or pg_catalog.jsonb_typeof(v_answer) is distinct from 'number'
         or v_answer::text !~ '^[0-9]+$'
         or pg_catalog.length(v_answer::text) > 2
         or pg_catalog.jsonb_typeof(v_question_id) is distinct from 'string'
         or v_question_id #>> '{}' is distinct from v_expected_question_id then
        raise exception using
          errcode = '22023',
          message = 'invalid_complementary_activity_evidence';
      end if;

      v_option_count := pg_catalog.jsonb_array_length(v_question -> 'options');
      v_selected_index := v_answer::text::integer;
      v_correct_index := coalesce(
        v_question ->> 'correct',
        v_question ->> 'correctIndex',
        v_question ->> 'correct_option_index'
      )::integer;

      if v_option_count < 2
         or v_selected_index >= v_option_count
         or v_correct_index >= v_option_count
         or v_selected_index < 0
         or v_correct_index < 0 then
        raise exception using
          errcode = '22023',
          message = 'invalid_complementary_activity_evidence';
      end if;

      if v_selected_index = v_correct_index then
        v_correct_count := v_correct_count + 1;
      end if;

      v_question_results := v_question_results || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'questionId', v_expected_question_id,
          'selectedIndex', v_selected_index,
          'correct', v_selected_index = v_correct_index,
          'correctIndex', v_correct_index,
          'explanation', coalesce(
            nullif(pg_catalog.btrim(v_question ->> 'exp'), ''),
            nullif(pg_catalog.btrim(v_question ->> 'explanation'), ''),
            nullif(pg_catalog.btrim(v_question ->> 'explanation_pt'), ''),
            nullif(pg_catalog.btrim(v_question ->> 'feedback'), '')
          )
        )
      );
    end loop;

    v_score := pg_catalog.round(
      (v_correct_count::numeric / v_question_count::numeric) * 100
    );
    v_passed := v_score >= 60;
  else
    if v_evidence ? 'answers'
       or v_evidence ? 'questionIds'
       or v_evidence ? 'questionResults'
       or v_evidence ? 'scorePercentage'
       or not private.learning_text_array_is_valid(
         v_evidence -> 'checklistCompleted',
         1,
         12,
         500
       )
       or pg_catalog.length(
            pg_catalog.btrim(coalesce(v_evidence ->> 'reflection', ''))
          ) not between 20 and 1200 then
      raise exception using
        errcode = '22023',
        message = 'invalid_complementary_activity_evidence';
    end if;

    select
      pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(
          pg_catalog.btrim(item.value #>> '{}')
        )
        order by item.ordinality
      ),
      pg_catalog.count(*)::integer,
      pg_catalog.count(
        distinct pg_catalog.lower(
          pg_catalog.btrim(item.value #>> '{}')
        )
      )::integer
      into
        v_checklist,
        v_checklist_count,
        v_distinct_checklist_count
      from pg_catalog.jsonb_array_elements(
        v_evidence -> 'checklistCompleted'
      ) with ordinality as item(value, ordinality);

    if v_distinct_checklist_count <> v_checklist_count then
      raise exception using
        errcode = '22023',
        message = 'invalid_complementary_activity_evidence';
    end if;

    if v_evidence ->> 'contentMode' = 'structured' then
      v_expected_checklist := case
        when pg_catalog.jsonb_typeof(v_content_json -> 'checklist') = 'array'
             and pg_catalog.jsonb_array_length(
                   v_content_json -> 'checklist'
                 ) > 0 then v_content_json -> 'checklist'
        when pg_catalog.jsonb_typeof(v_content_json -> 'steps') = 'array'
             and pg_catalog.jsonb_array_length(
                   v_content_json -> 'steps'
                 ) > 0 then v_content_json -> 'steps'
        when pg_catalog.jsonb_typeof(v_content_json -> 'preparation') = 'array'
             and pg_catalog.jsonb_array_length(
                   v_content_json -> 'preparation'
                 ) > 0 then v_content_json -> 'preparation'
        else null
      end;

      if not private.learning_text_array_is_valid(
        v_expected_checklist,
        1,
        12,
        500
      ) then
        raise exception using
          errcode = '22023',
          message = 'invalid_complementary_activity_evidence';
      end if;

      select pg_catalog.jsonb_agg(
               pg_catalog.to_jsonb(
                 pg_catalog.btrim(item.value #>> '{}')
               )
               order by item.ordinality
             )
        into v_expected_checklist
        from pg_catalog.jsonb_array_elements(v_expected_checklist)
             with ordinality as item(value, ordinality);

      if v_checklist is distinct from v_expected_checklist then
        raise exception using
          errcode = '22023',
          message = 'invalid_complementary_activity_evidence';
      end if;
    end if;

    -- Legacy free-text activities have no server-authored checklist to match;
    -- they still receive the strict bounded/nonempty/distinct evidence guard.
    v_score := null;
    v_passed := true;
  end if;

  if v_activity.status = 'COMPLETED' then
    return pg_catalog.jsonb_build_object(
      'activityId', v_activity.id,
      'status', v_activity.status,
      'passed', true,
      'scorePercentage', null,
      'questionResults', '[]'::jsonb,
      'completedAt', v_activity.completed_at,
      'alreadyApplied', true,
      'evidenceAccepted', true,
      'streakCount', coalesce(v_profile.streak_count, 0),
      'xpEarned', 0
    );
  end if;

  if v_activity.status <> 'PENDING' then
    raise exception using
      errcode = 'P0001',
      message = 'complementary_activity_not_pending';
  end if;

  v_status := case when v_passed then 'COMPLETED' else 'PENDING' end;

  if v_passed then
    update public.student_activities
       set status = 'COMPLETED',
           completion_evidence = v_evidence,
           completion_request_key = v_request_key,
           completed_by = v_student_id,
           completed_at = v_now,
           updated_at = v_now
     where id = p_activity_id
    returning * into v_activity;

    -- Only the first successful completion updates the practice clock/streak.
    -- Objective quiz/grammar scores are server-derived; reflective activities
    -- intentionally use an unmapped type so no skill score is fabricated.
    v_streak := private.record_student_learning_practice(
      v_student_id,
      coalesce(v_score, 0),
      case v_activity.type
        when 'quiz' then 'quiz'
        when 'grammar' then 'grammar_drill'
        else 'complementary_completion'
      end,
      array[]::text[],
      v_now
    );
  else
    v_streak := coalesce(v_profile.streak_count, 0);
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'activityId', v_activity.id,
    'status', v_status,
    'passed', v_passed,
    'scorePercentage', v_score,
    'questionResults', v_question_results,
    'completedAt', case when v_passed then v_activity.completed_at else null end,
    'alreadyApplied', false,
    'evidenceAccepted', true,
    'streakCount', v_streak,
    'xpEarned', 0
  );

  insert into public.student_complementary_activity_attempts (
    tenant_id,
    student_id,
    activity_id,
    request_key,
    evidence,
    score,
    passed,
    result,
    created_at
  ) values (
    v_profile.tenant_id,
    v_student_id,
    p_activity_id,
    v_request_key,
    v_evidence,
    v_score,
    v_passed,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

alter function public.complete_student_complementary_activity(uuid, jsonb, text)
  owner to postgres;
revoke all on function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) to authenticated, service_role;

create or replace function public.get_student_practice_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_now timestamptz := pg_catalog.now();
  v_today date := (v_now at time zone 'America/Sao_Paulo')::date;
  v_hearts jsonb;
  v_profile record;
begin
  if v_student_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  v_hearts := private.refresh_student_hearts(v_student_id, v_now);

  select
    coalesce(profile.xp, 0) as xp,
    coalesce(profile.level, 1) as level,
    coalesce(profile.streak_count, 0) as streak_count,
    profile.last_streak_date,
    coalesce(profile.daily_xp, 0) as daily_xp,
    profile.daily_xp_date,
    coalesce(profile.daily_xp_goal, 30) as daily_xp_goal
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id;

  return v_hearts || pg_catalog.jsonb_build_object(
    'xp', v_profile.xp,
    'level', v_profile.level,
    'streakCount', case
      when v_profile.last_streak_date between v_today - 1 and v_today then
        v_profile.streak_count
      else 0
    end,
    'lastStreakDate', v_profile.last_streak_date,
    'practicedToday', v_profile.last_streak_date = v_today,
    'dailyXp', case
      when v_profile.daily_xp_date = v_today then v_profile.daily_xp
      else 0
    end,
    'dailyXpGoal', v_profile.daily_xp_goal,
    'businessDate', v_today
  );
end;
$function$;

alter function public.get_student_practice_status() owner to postgres;
revoke all on function public.get_student_practice_status()
  from public, anon, authenticated;
grant execute on function public.get_student_practice_status()
  to authenticated, service_role;

create or replace function public.get_student_opt_in_leaderboard(
  p_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_result jsonb;
begin
  if v_student_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if p_limit is null or p_limit not between 1 and 50 then
    raise exception using
      errcode = '22023',
      message = 'invalid_leaderboard_limit';
  end if;

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'displayName', ranked.display_name,
               'xp', ranked.xp
             )
             order by ranked.position
           ),
           '[]'::jsonb
         )
    into v_result
    from (
      select
        pg_catalog.row_number() over (
          order by coalesce(student.xp, 0) desc, student.id
        ) as position,
        coalesce(
          nullif(pg_catalog.btrim(student.league_display_name), ''),
          'Lobo ' || pg_catalog.row_number() over (
            order by coalesce(student.xp, 0) desc, student.id
          )::text
        ) as display_name,
        greatest(0, coalesce(student.xp, 0)) as xp
      from public.profiles as student
      where student.tenant_id = v_profile.tenant_id
        and student.role = 'STUDENT'
        and coalesce(student.league_opt_in, false) is true
      order by coalesce(student.xp, 0) desc, student.id
      limit p_limit
    ) as ranked;

  return v_result;
end;
$function$;

alter function public.get_student_opt_in_leaderboard(integer)
  owner to postgres;
revoke all on function public.get_student_opt_in_leaderboard(integer)
  from public, anon, authenticated;
grant execute on function public.get_student_opt_in_leaderboard(integer)
  to authenticated, service_role;

-- The legacy leaderboard exposes civil names and students who never opted in.
-- Keep it available only to trusted server code; browsers use the pseudonymous
-- opt-in RPC above.
revoke all on function public.get_my_tenant_leaderboard(integer)
  from public, anon, authenticated;
grant execute on function public.get_my_tenant_leaderboard(integer)
  to service_role;

create or replace function public.consume_student_heart(
  p_request_key text,
  p_reason text default 'WRONG_ANSWER'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_request_key text := pg_catalog.btrim(coalesce(p_request_key, ''));
  v_reason text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_reason, 'WRONG_ANSWER'))
  );
  v_now timestamptz := pg_catalog.now();
  v_status jsonb;
  v_existing public.student_heart_consumptions%rowtype;
  v_tenant_id text;
  v_hearts_before integer;
  v_hearts_after integer;
  v_anchor timestamptz;
  v_consumed boolean;
begin
  if v_student_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if pg_catalog.length(v_request_key) not between 8 and 180
     or pg_catalog.length(v_reason) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'invalid_heart_consumption_request';
  end if;

  -- The refresh locks the profile row, serializing consumption and regeneration.
  v_status := private.refresh_student_hearts(v_student_id, v_now);
  v_tenant_id := v_status ->> 'tenantId';

  select *
    into v_existing
    from public.student_heart_consumptions as consumption
   where consumption.student_id = v_student_id
     and consumption.request_key = v_request_key;

  if found then
    if v_existing.reason <> v_reason then
      raise exception using
        errcode = '22023',
        message = 'idempotency_key_reused';
    end if;

    return v_status || pg_catalog.jsonb_build_object(
      'consumed', v_existing.consumed,
      'alreadyApplied', true,
      'heartsAtAttempt', v_existing.hearts_after
    );
  end if;

  v_hearts_before := (v_status ->> 'hearts')::integer;
  v_hearts_after := greatest(0, v_hearts_before - 1);
  v_consumed := v_hearts_before > 0;

  select profile.hearts_updated_at
    into v_anchor
    from public.profiles as profile
   where profile.id = v_student_id;

  if v_consumed then
    if v_hearts_before >= 5 then
      v_anchor := v_now;
    end if;

    update public.profiles
       set hearts = v_hearts_after,
           hearts_updated_at = v_anchor,
           hearts_full_notified = false
     where id = v_student_id;
  end if;

  insert into public.student_heart_consumptions (
    tenant_id,
    student_id,
    request_key,
    reason,
    hearts_before,
    hearts_after,
    consumed,
    created_at
  ) values (
    v_tenant_id,
    v_student_id,
    v_request_key,
    v_reason,
    v_hearts_before,
    v_hearts_after,
    v_consumed,
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'tenantId', v_tenant_id,
    'hearts', v_hearts_after,
    'maxHearts', 5,
    'heartsUpdatedAt', v_anchor,
    'nextHeartAt', case
      when v_hearts_after < 5 then v_anchor + interval '30 minutes'
      else null
    end,
    'consumed', v_consumed,
    'alreadyApplied', false,
    'heartsAtAttempt', v_hearts_after
  );
end;
$function$;

alter function public.consume_student_heart(text, text) owner to postgres;
revoke all on function public.consume_student_heart(text, text)
  from public, anon, authenticated;
grant execute on function public.consume_student_heart(text, text)
  to authenticated, service_role;

-- Replace the legacy two-argument implementation instead of leaving a second,
-- divergent overload. The third argument has a default, so older SQL callers
-- can still pass two arguments while current clients get durable request replay.
drop function if exists public.grade_quiz(uuid, integer[]);

create or replace function public.grade_quiz(
  p_activity_id uuid,
  p_answers integer[],
  p_request_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_activity record;
  v_enrollment public.student_path_enrollments%rowtype;
  v_replay_attempt public.student_learning_activity_attempts%rowtype;
  v_request_key text := nullif(
    pg_catalog.btrim(coalesce(p_request_key, '')),
    ''
  );
  v_request_payload jsonb;
  v_current record;
  v_question jsonb;
  v_questions jsonb;
  v_option_count integer;
  v_correct_index integer;
  v_question_id text;
  v_question_results jsonb := '[]'::jsonb;
  v_total integer;
  v_correct integer := 0;
  v_score integer;
  v_passed boolean;
  v_status text;
  v_base_xp integer;
  v_xp_earned integer := 0;
  v_daily_xp integer;
  v_today date;
  v_new_xp integer;
  v_new_level integer;
  v_existing_award public.student_verified_xp_awards%rowtype;
  v_already_awarded boolean := false;
  v_progression jsonb;
  v_result jsonb;
  v_streak integer;
  v_now timestamptz := pg_catalog.now();
  i integer;
begin
  if v_student_id is null or p_activity_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if v_request_key is not null
     and pg_catalog.length(v_request_key) not between 8 and 180 then
    raise exception using
      errcode = '22023',
      message = 'invalid_quiz_request_key';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'answers', pg_catalog.to_jsonb(p_answers)
  );

  select
    profile.tenant_id,
    profile.role,
    coalesce(profile.xp, 0) as xp,
    coalesce(profile.level, 1) as level,
    coalesce(profile.daily_xp, 0) as daily_xp,
    profile.daily_xp_date,
    coalesce(profile.is_test_account, false) as is_test_account
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select
    activity.id,
    activity.unit_id,
    activity.type,
    activity.content,
    least(100, greatest(0, coalesce(activity.xp_reward, 30))) as xp_reward,
    unit.path_id,
    unit.skill_focus,
    path.tenant_id as path_tenant_id
    into v_activity
    from public.unit_activities as activity
    join public.learning_units as unit
      on unit.id = activity.unit_id
    join public.learning_paths as path
      on path.id = unit.path_id
   where activity.id = p_activity_id
     and activity.type in ('quiz', 'grammar_drill', 'reading')
     and path.active is true
     and (
       path.tenant_id is null
       or path.tenant_id = v_profile.tenant_id
     );

  if not found then
    raise exception using
      errcode = '42501',
      message = 'quiz_not_available_for_student';
  end if;

  -- Resolve a durable keyed replay before requiring an ACTIVE enrollment. This
  -- covers both failed and passing attempts, including the final quiz that may
  -- already have closed the path when the HTTP response is lost.
  if v_request_key is not null then
    select *
      into v_replay_attempt
      from public.student_learning_activity_attempts as attempt
     where attempt.student_id = v_student_id
       and attempt.request_key = v_request_key
     for update;

    if found then
      if v_replay_attempt.activity_id is distinct from p_activity_id
         or v_replay_attempt.attempt_kind <> 'QUIZ'
         or v_replay_attempt.request_payload is distinct from v_request_payload then
        raise exception using
          errcode = '22023',
          message = 'idempotency_key_reused';
      end if;

      return v_replay_attempt.result || pg_catalog.jsonb_build_object(
        'alreadyApplied', true
      );
    end if;
  end if;

  -- Compatibility for legacy two-argument callers: an exact replay of the most
  -- recent passing payload is safe even after progression closed the path.
  select *
    into v_replay_attempt
    from public.student_learning_activity_attempts as attempt
   where attempt.student_id = v_student_id
     and attempt.activity_id = p_activity_id
     and attempt.attempt_kind = 'QUIZ'
     and attempt.passed is true
   order by attempt.created_at desc, attempt.id desc
   limit 1;

  if found
     and v_replay_attempt.request_payload = v_request_payload then
    return v_replay_attempt.result || pg_catalog.jsonb_build_object(
      'alreadyApplied', true
    );
  end if;

  select *
    into v_enrollment
    from public.student_path_enrollments as enrollment
   where enrollment.student_id = v_student_id
     and enrollment.path_id = v_activity.path_id
     and enrollment.tenant_id = v_profile.tenant_id
     and enrollment.status = 'ACTIVE'
     and enrollment.completed_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'active_learning_enrollment_required';
  end if;

  select next_activity.activity_id, next_activity.unit_id
    into v_current
    from private.next_incomplete_learning_activity(
      v_student_id,
      v_activity.path_id
    ) as next_activity;

  if not found or v_current.activity_id <> p_activity_id then
    raise exception using
      errcode = 'P0001',
      message = 'learning_activity_not_current';
  end if;

  v_questions := case v_activity.type
    when 'grammar_drill' then v_activity.content -> 'exercises'
    else v_activity.content -> 'questions'
  end;

  if v_questions is null
     or pg_catalog.jsonb_typeof(v_questions) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'invalid_quiz';
  end if;

  v_total := pg_catalog.jsonb_array_length(v_questions);
  if v_total < 1
     or v_total > 100
     or p_answers is null
     or pg_catalog.cardinality(p_answers) <> v_total then
    raise exception using
      errcode = '22023',
      message = 'invalid_answers';
  end if;

  for i in 0 .. v_total - 1 loop
    v_question := v_questions -> i;

    if pg_catalog.jsonb_typeof(v_question) is distinct from 'object'
       or pg_catalog.jsonb_typeof(v_question -> 'options')
            is distinct from 'array'
       or coalesce(
            coalesce(
              v_question ->> 'correct',
              v_question ->> 'correctIndex',
              v_question ->> 'correct_option_index'
            ) ~ '^[0-9]+$',
            false
          ) is not true then
      raise exception using
        errcode = '22023',
        message = 'invalid_quiz';
    end if;

    v_option_count := pg_catalog.jsonb_array_length(v_question -> 'options');
    v_correct_index := coalesce(
      v_question ->> 'correct',
      v_question ->> 'correctIndex',
      v_question ->> 'correct_option_index'
    )::integer;
    v_question_id := coalesce(
      nullif(pg_catalog.btrim(v_question ->> 'id'), ''),
      'question-' || (i + 1)::text
    );
    if v_option_count < 2
       or v_correct_index >= v_option_count
       or p_answers[i + 1] is null
       or p_answers[i + 1] < 0
       or p_answers[i + 1] >= v_option_count then
      raise exception using
        errcode = '22023',
        message = 'invalid_answers';
    end if;

    if p_answers[i + 1] = v_correct_index then
      v_correct := v_correct + 1;
    end if;

    v_question_results := v_question_results || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'questionId', v_question_id,
        'questionIndex', i,
        'selectedIndex', p_answers[i + 1],
        'correct', p_answers[i + 1] = v_correct_index,
        'correctIndex', v_correct_index,
        'explanation', coalesce(
          nullif(pg_catalog.btrim(v_question ->> 'exp'), ''),
          nullif(pg_catalog.btrim(v_question ->> 'explanation'), ''),
          nullif(pg_catalog.btrim(v_question ->> 'explanation_pt'), ''),
          nullif(pg_catalog.btrim(v_question ->> 'feedback'), '')
        )
      )
    );
  end loop;

  v_score := pg_catalog.round(
    (v_correct::numeric / v_total::numeric) * 100
  );
  v_passed := v_score >= 60;
  v_status := case when v_passed then 'COMPLETED' else 'IN_PROGRESS' end;
  v_base_xp := v_activity.xp_reward;
  v_today := (v_now at time zone 'America/Sao_Paulo')::date;

  insert into public.student_activity_progress (
    student_id,
    activity_id,
    unit_id,
    status,
    score,
    attempts,
    completed_at,
    last_attempt_at
  ) values (
    v_student_id,
    p_activity_id,
    v_activity.unit_id,
    v_status,
    v_score,
    1,
    case when v_passed then v_now else null end,
    v_now
  )
  on conflict (student_id, activity_id) do update
    set status = case
          when excluded.status = 'COMPLETED' then 'COMPLETED'
          else 'IN_PROGRESS'
        end,
        score = greatest(
          coalesce(public.student_activity_progress.score, 0),
          excluded.score
        ),
        attempts =
          coalesce(public.student_activity_progress.attempts, 0) + 1,
        completed_at = case
          when excluded.status = 'COMPLETED' then
            coalesce(public.student_activity_progress.completed_at, v_now)
          else null
        end,
        last_attempt_at = v_now;

  if v_passed then
    v_progression := private.advance_student_learning_enrollment(
      v_enrollment.id,
      v_student_id,
      v_activity.path_id,
      v_now
    );
  else
    v_progression := pg_catalog.jsonb_build_object(
      'nextActivityId', p_activity_id,
      'currentUnitId', v_activity.unit_id,
      'pathCompleted', false
    );
  end if;

  select *
    into v_existing_award
    from public.student_verified_xp_awards as award
   where award.student_id = v_student_id
     and award.source_type = 'LEARNING_PATH_QUIZ'
     and award.source_id = p_activity_id::text;
  v_already_awarded := found;

  v_new_xp := v_profile.xp;
  v_new_level := v_profile.level;

  if v_passed and not v_already_awarded then
    v_daily_xp := case
      when v_profile.daily_xp_date = v_today then v_profile.daily_xp
      else 0
    end;
    v_xp_earned := pg_catalog.round(
      v_base_xp * (v_score::numeric / 100)
    );
    v_xp_earned := least(
      v_xp_earned,
      greatest(0, 250 - v_daily_xp)
    );
    if v_profile.is_test_account then
      v_xp_earned := 0;
    end if;

    v_new_xp := v_profile.xp + v_xp_earned;
    v_new_level := pg_catalog.floor(v_new_xp / 1000) + 1;

    insert into public.student_verified_xp_awards (
      tenant_id,
      student_id,
      source_type,
      source_id,
      base_xp,
      xp_awarded,
      score_used,
      test_fixture
    ) values (
      v_profile.tenant_id,
      v_student_id,
      'LEARNING_PATH_QUIZ',
      p_activity_id::text,
      v_base_xp,
      v_xp_earned,
      v_score,
      v_profile.is_test_account
    );

    update public.profiles
       set xp = v_new_xp,
           level = v_new_level,
           daily_xp = v_daily_xp + v_xp_earned,
           daily_xp_date = v_today,
           last_activity = v_now
     where id = v_student_id;
  end if;

  v_streak := private.record_student_learning_practice(
    v_student_id,
    v_score,
    v_activity.type,
    v_activity.skill_focus,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'score', v_score,
    'correctAnswers', v_correct,
    'totalQuestions', v_total,
    'questionResults', v_question_results,
    'passed', v_passed,
    'status', v_status,
    'xpEarned', v_xp_earned,
    'alreadyAwarded', v_already_awarded,
    'leveledUp', v_new_level > v_profile.level,
    'newLevel', v_new_level,
    'streakCount', v_streak
  ) || v_progression;

  insert into public.student_learning_activity_attempts (
    tenant_id,
    student_id,
    enrollment_id,
    activity_id,
    attempt_kind,
    request_key,
    request_payload,
    score,
    passed,
    result,
    created_at
  ) values (
    v_profile.tenant_id,
    v_student_id,
    v_enrollment.id,
    p_activity_id,
    'QUIZ',
    v_request_key,
    v_request_payload,
    v_score,
    v_passed,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

alter function public.grade_quiz(uuid, integer[], text) owner to postgres;
revoke all on function public.grade_quiz(uuid, integer[], text)
  from public, anon, authenticated;
grant execute on function public.grade_quiz(uuid, integer[], text)
  to authenticated, service_role;

create or replace function public.complete_learning_activity(
  p_activity_id uuid,
  p_score integer default 100,
  p_time_spent_seconds integer default 0,
  p_evidence jsonb default '{}'::jsonb,
  p_request_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_activity record;
  v_enrollment public.student_path_enrollments%rowtype;
  v_current record;
  v_existing_attempt public.student_learning_activity_attempts%rowtype;
  v_request_key text := nullif(
    pg_catalog.btrim(coalesce(p_request_key, '')),
    ''
  );
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb) - 'completedAt';
  v_request_payload jsonb;
  v_progression jsonb;
  v_result jsonb;
  v_streak integer;
  v_wolfie_conversation_id uuid;
  v_wolfie_session record;
  v_passed boolean := coalesce(p_score >= 60, false);
  v_status text := case
    when coalesce(p_score >= 60, false) then 'COMPLETED'
    else 'IN_PROGRESS'
  end;
  v_now timestamptz := pg_catalog.now();
begin
  if v_student_id is null or p_activity_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if p_score is null
     or p_score not between 0 and 100
     or p_time_spent_seconds is null
     or p_time_spent_seconds not between 0 and 86400
     or p_evidence is null
     or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
     or p_evidence = '{}'::jsonb
     or pg_catalog.pg_column_size(p_evidence) > 32768
     or v_request_key is null
     or pg_catalog.length(v_request_key) not between 8 and 180 then
    raise exception using
      errcode = '22023',
      message = 'invalid_learning_activity_completion';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'score', p_score,
    'timeSpentSeconds', p_time_spent_seconds,
    'evidence', v_evidence
  );

  select profile.tenant_id, profile.role
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;

  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null then
    raise exception using
      errcode = '42501',
      message = 'student_profile_required';
  end if;

  select
    activity.id,
    activity.unit_id,
    activity.type,
    unit.path_id,
    unit.skill_focus,
    path.tenant_id as path_tenant_id
    into v_activity
    from public.unit_activities as activity
    join public.learning_units as unit
      on unit.id = activity.unit_id
    join public.learning_paths as path
      on path.id = unit.path_id
   where activity.id = p_activity_id
     and activity.type not in ('quiz', 'grammar_drill', 'reading')
     and path.active is true
     and (
       path.tenant_id is null
       or path.tenant_id = v_profile.tenant_id
     );

  if not found then
    raise exception using
      errcode = '42501',
      message = 'learning_activity_not_available';
  end if;

  -- Legacy non-quiz runners are self-attested. Bind the evidence to the actual
  -- activity and score, but do not let this unverified score alter skill models.
  -- Rich, type-specific evidence can replace this transitional contract later.
  if v_evidence ->> 'activityType' is distinct from v_activity.type
     or coalesce((v_evidence ->> 'score') ~ '^[0-9]+$', false) is not true
     or (v_evidence ->> 'score')::integer <> p_score then
    raise exception using
      errcode = '22023',
      message = 'invalid_learning_activity_evidence';
  end if;

  if v_activity.type = 'speaking_wolfie'
     and (
       coalesce((v_evidence ->> 'learnerTurns') ~ '^[0-9]+$', false)
         is not true
       or pg_catalog.length(v_evidence ->> 'learnerTurns') > 4
       or (v_evidence ->> 'learnerTurns')::integer not between 2 and 1000
       or pg_catalog.jsonb_typeof(v_evidence -> 'sessionCompleted')
            is distinct from 'boolean'
       or (v_evidence ->> 'sessionCompleted')::boolean is not true
       or p_score not between 60 and 100
     ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_speaking_activity_evidence';
  end if;

  if v_activity.type = 'speaking_wolfie' then
    begin
      v_wolfie_conversation_id :=
        (v_evidence ->> 'wolfieConversationId')::uuid;
    exception
      when invalid_text_representation then
        raise exception using
          errcode = '22023',
          message = 'invalid_speaking_activity_evidence';
    end;

    if v_wolfie_conversation_id is null then
      raise exception using
        errcode = '22023',
        message = 'invalid_speaking_activity_evidence';
    end if;

    v_evidence := pg_catalog.jsonb_set(
      v_evidence,
      '{wolfieConversationId}',
      pg_catalog.to_jsonb(v_wolfie_conversation_id::text),
      true
    );
    v_request_payload := pg_catalog.jsonb_build_object(
      'score', p_score,
      'timeSpentSeconds', p_time_spent_seconds,
      'evidence', v_evidence
    );

    select session.id, coalesce(session.turn_count, 0) as turn_count
      into v_wolfie_session
      from public.wolfie_sessions as session
     where session.id = v_wolfie_conversation_id
       and session.student_id = v_student_id
       and session.tenant_id = v_profile.tenant_id;

    if not found
       or v_wolfie_session.turn_count < 2
       or v_wolfie_session.turn_count <
            (v_evidence ->> 'learnerTurns')::integer then
      raise exception using
        errcode = '22023',
        message = 'invalid_speaking_activity_evidence';
    end if;
  end if;

  -- Resolve an exact request replay before requiring an ACTIVE enrollment. The
  -- first call may have completed the final activity and closed the enrollment
  -- even if its HTTP response never reached the client.
  if v_request_key is not null then
    select *
      into v_existing_attempt
      from public.student_learning_activity_attempts as attempt
     where attempt.student_id = v_student_id
       and attempt.request_key = v_request_key
     for update;

    if found then
      if v_existing_attempt.activity_id is distinct from p_activity_id
         or v_existing_attempt.attempt_kind <> 'COMPLETION'
         or v_existing_attempt.request_payload is distinct from v_request_payload then
        raise exception using
          errcode = '22023',
          message = 'idempotency_key_reused';
      end if;

      return v_existing_attempt.result || pg_catalog.jsonb_build_object(
        'alreadyApplied', true
      );
    end if;
  end if;

  if v_activity.type = 'speaking_wolfie'
     and exists (
       select 1
         from public.student_learning_activity_attempts as attempt
        where attempt.student_id = v_student_id
          and attempt.attempt_kind = 'COMPLETION'
          and attempt.activity_id is distinct from p_activity_id
          and pg_catalog.lower(
                attempt.request_payload #>>
                  '{evidence,wolfieConversationId}'
              ) =
                v_wolfie_conversation_id::text
     ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_speaking_activity_evidence';
  end if;

  select *
    into v_enrollment
    from public.student_path_enrollments as enrollment
   where enrollment.student_id = v_student_id
     and enrollment.path_id = v_activity.path_id
     and enrollment.tenant_id = v_profile.tenant_id
     and enrollment.status = 'ACTIVE'
     and enrollment.completed_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'active_learning_enrollment_required';
  end if;

  select next_activity.activity_id, next_activity.unit_id
    into v_current
    from private.next_incomplete_learning_activity(
      v_student_id,
      v_activity.path_id
    ) as next_activity;

  if not found or v_current.activity_id <> p_activity_id then
    raise exception using
      errcode = 'P0001',
      message = 'learning_activity_not_current';
  end if;

  insert into public.student_activity_progress (
    student_id,
    activity_id,
    unit_id,
    status,
    score,
    attempts,
    time_spent_seconds,
    completed_at,
    last_attempt_at
  ) values (
    v_student_id,
    p_activity_id,
    v_activity.unit_id,
    v_status,
    p_score,
    1,
    p_time_spent_seconds,
    case when v_passed then v_now else null end,
    v_now
  )
  on conflict (student_id, activity_id) do update
    set status = case
          when excluded.status = 'COMPLETED' then 'COMPLETED'
          else 'IN_PROGRESS'
        end,
        score = greatest(
          coalesce(public.student_activity_progress.score, 0),
          excluded.score
        ),
        attempts =
          coalesce(public.student_activity_progress.attempts, 0) + 1,
        time_spent_seconds = least(
          2147483647,
          coalesce(public.student_activity_progress.time_spent_seconds, 0)
            + excluded.time_spent_seconds
        ),
        completed_at = case
          when excluded.status = 'COMPLETED' then coalesce(
            public.student_activity_progress.completed_at,
            v_now
          )
          else public.student_activity_progress.completed_at
        end,
        last_attempt_at = v_now;

  v_streak := private.record_student_learning_practice(
    v_student_id,
    p_score,
    'unverified_completion',
    array[]::text[],
    v_now
  );

  if v_passed then
    v_progression := private.advance_student_learning_enrollment(
      v_enrollment.id,
      v_student_id,
      v_activity.path_id,
      v_now
    );
  else
    v_progression := pg_catalog.jsonb_build_object(
      'nextActivityId', p_activity_id,
      'currentUnitId', v_activity.unit_id,
      'pathCompleted', false
    );
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'activityId', p_activity_id,
    'score', p_score,
    'passed', v_passed,
    'status', v_status,
    'xpEarned', 0,
    'streakCount', v_streak,
    'alreadyApplied', false
  ) || v_progression;

  insert into public.student_learning_activity_attempts (
    tenant_id,
    student_id,
    enrollment_id,
    activity_id,
    attempt_kind,
    request_key,
    request_payload,
    score,
    passed,
    result,
    created_at
  ) values (
    v_profile.tenant_id,
    v_student_id,
    v_enrollment.id,
    p_activity_id,
    'COMPLETION',
    v_request_key,
    v_request_payload,
    p_score,
    v_passed,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

alter function public.complete_learning_activity(
  uuid,
  integer,
  integer,
  jsonb,
  text
) owner to postgres;
revoke all on function public.complete_learning_activity(
  uuid,
  integer,
  integer,
  jsonb,
  text
) from public, anon, authenticated;
grant execute on function public.complete_learning_activity(
  uuid,
  integer,
  integer,
  jsonb,
  text
) to authenticated, service_role;

alter table public.student_path_enrollments enable row level security;
alter table public.student_activity_progress enable row level security;
alter table public.student_skill_scores enable row level security;
alter table public.student_activities enable row level security;
alter table public.student_path_enrollment_history enable row level security;
alter table public.student_learning_activity_attempts enable row level security;
alter table public.student_complementary_activity_attempts enable row level security;
alter table public.student_heart_consumptions enable row level security;
alter table public.student_generated_activity_batches enable row level security;
alter table public.student_complementary_generation_reservations
  enable row level security;
alter table public.student_vocab_reviews enable row level security;
alter table public.student_vocab_review_attempts enable row level security;

-- Replace permissive legacy FOR ALL policies with read-only, role-aware tenant
-- policies. Every browser-authored state transition now enters through an RPC.
do $block$
declare
  v_policy record;
begin
  for v_policy in
    select
      namespace.nspname as schema_name,
      relation.relname as table_name,
      policy.polname as policy_name
    from pg_catalog.pg_policy as policy
    join pg_catalog.pg_class as relation
      on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'student_path_enrollments',
        'student_activity_progress',
        'student_skill_scores',
        'student_activities',
        'student_path_enrollment_history',
        'student_learning_activity_attempts',
        'student_complementary_activity_attempts',
        'student_heart_consumptions',
        'student_generated_activity_batches',
        'student_complementary_generation_reservations',
        'student_vocab_reviews',
        'student_vocab_review_attempts'
      )
  loop
    execute pg_catalog.format(
      'drop policy if exists %I on %I.%I',
      v_policy.policy_name,
      v_policy.schema_name,
      v_policy.table_name
    );
  end loop;
end
$block$;

create policy student_path_enrollments_read_scoped
on public.student_path_enrollments
for select
to authenticated
using (
  student_id = (select auth.uid())
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and (select public._teacher_can_access_student(student_id, tenant_id))
      )
    )
  )
);

create policy student_activity_progress_read_scoped
on public.student_activity_progress
for select
to authenticated
using (
  student_id = (select auth.uid())
  or (select public._my_role()) = 'SUPER_ADMIN'
  or exists (
    select 1
      from public.profiles as student
     where student.id = student_id
       and student.role = 'STUDENT'
       and student.tenant_id = (select public._my_tenant_id())
       and (
         (select public._my_role()) = 'SCHOOL_ADMIN'
         or (
           (select public._my_role()) = 'TEACHER'
           and (
             select public._teacher_can_access_student(
               student_id,
               student.tenant_id
             )
           )
         )
       )
  )
);

create policy student_skill_scores_read_scoped
on public.student_skill_scores
for select
to authenticated
using (
  student_id = (select auth.uid())
  or (select public._my_role()) = 'SUPER_ADMIN'
  or exists (
    select 1
      from public.profiles as student
     where student.id = student_id
       and student.role = 'STUDENT'
       and student.tenant_id = (select public._my_tenant_id())
       and (
         (select public._my_role()) = 'SCHOOL_ADMIN'
         or (
           (select public._my_role()) = 'TEACHER'
           and (
             select public._teacher_can_access_student(
               student_id,
               student.tenant_id
             )
           )
         )
       )
  )
);

create policy student_activities_read_scoped
on public.student_activities
for select
to authenticated
using (
  (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and (select public._teacher_can_access_student(student_id, tenant_id))
      )
    )
  )
);

create policy student_path_enrollment_history_read_scoped
on public.student_path_enrollment_history
for select
to authenticated
using (
  student_id = (select auth.uid())
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and (select public._teacher_can_access_student(student_id, tenant_id))
      )
    )
  )
);

create policy student_learning_activity_attempts_read_scoped
on public.student_learning_activity_attempts
for select
to authenticated
using (
  student_id = (select auth.uid())
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and (select public._teacher_can_access_student(student_id, tenant_id))
      )
    )
  )
);

create policy student_complementary_activity_attempts_read_scoped
on public.student_complementary_activity_attempts
for select
to authenticated
using (
  student_id = (select auth.uid())
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and (select public._teacher_can_access_student(student_id, tenant_id))
      )
    )
  )
);

create policy student_generated_activity_batches_read_scoped
on public.student_generated_activity_batches
for select
to authenticated
using (
  (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and (select public._teacher_can_access_student(student_id, tenant_id))
      )
    )
  )
);

create policy student_vocab_reviews_read_own
on public.student_vocab_reviews
for select
to authenticated
using (
  student_id = (select auth.uid())
);

create policy student_vocab_review_attempts_read_own
on public.student_vocab_review_attempts
for select
to authenticated
using (
  student_id = (select auth.uid())
);

revoke all on table
  public.student_path_enrollments,
  public.student_activity_progress,
  public.student_skill_scores,
  public.student_activities,
  public.student_path_enrollment_history,
  public.student_learning_activity_attempts,
  public.student_complementary_activity_attempts,
  public.student_heart_consumptions,
  public.student_generated_activity_batches,
  public.student_complementary_generation_reservations,
  public.student_vocab_reviews,
  public.student_vocab_review_attempts
from public, anon, authenticated;

grant select on table
  public.student_path_enrollments,
  public.student_activity_progress,
  public.student_skill_scores,
  public.student_activities,
  public.student_path_enrollment_history,
  public.student_learning_activity_attempts,
  public.student_complementary_activity_attempts,
  public.student_generated_activity_batches,
  public.student_vocab_reviews,
  public.student_vocab_review_attempts
to authenticated;

grant all on table
  public.student_path_enrollments,
  public.student_activity_progress,
  public.student_skill_scores,
  public.student_activities,
  public.student_path_enrollment_history,
  public.student_learning_activity_attempts,
  public.student_complementary_activity_attempts,
  public.student_heart_consumptions,
  public.student_generated_activity_batches,
  public.student_complementary_generation_reservations,
  public.student_vocab_reviews,
  public.student_vocab_review_attempts
to service_role;

comment on function public.grade_quiz(uuid, integer[], text) is
  'Server-authoritative ordered learning-path quiz attempt with keyed replay, pass-gated progression, skills, streak and idempotent XP.';
comment on function public.complete_learning_activity(
  uuid,
  integer,
  integer,
  jsonb,
  text
) is
  'Records the current non-quiz learning-path attempt without XP; a required request key makes pass/fail retries idempotent and scores below 60 do not advance.';
comment on function public.enroll_student_learning_path(
  uuid,
  boolean,
  text,
  uuid
) is
  'Creates or resumes one active path and requires an explicit reason when switching away from another active enrollment.';
comment on function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) is
  'Server-grades objective complementary evidence, pass-gates completion, records practice once, and awards no XP.';
comment on function public.get_student_complementary_activities(integer) is
  'Returns only the authenticated student complementary activities with answer keys recursively removed.';
comment on function public.get_student_complementary_generation_status() is
  'Returns package-at-a-time pending quota state before complementary generation.';
comment on function public.begin_student_complementary_generation(uuid) is
  'Reserves one five-minute generation lease, blocks duplicate tabs/pending packs and enforces a three-per-day cost fence.';
comment on function public.commit_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  uuid
) is
  'Service-only commit of a student generation lease after its idempotent four-pack was persisted.';
comment on function public.release_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  text
) is
  'Releases an owned generation lease after provider or persistence failure without allowing cost-limit bypass.';
comment on function public.save_student_generated_activities(
  uuid,
  jsonb,
  uuid,
  uuid,
  uuid
) is
  'Service-only persistence of one validated four-type generated activity pack bound to an active student reservation, with zero XP and request idempotency.';
comment on function public.consume_student_heart(text, text) is
  'Atomically regenerates and consumes one student heart, fenced by a caller request key.';
comment on function public.get_student_practice_status() is
  'Returns server-authoritative hearts, streak and daily practice status in the America/Sao_Paulo business day.';
comment on function public.schedule_student_vocab_review(uuid, text, text, text) is
  'Schedules an owned card from the current vocab activity without trusting browser scope.';
comment on function public.submit_student_vocab_review(uuid, boolean, text) is
  'Applies one idempotent server-side SRS transition and records zero-XP practice.';

notify pgrst, 'reload schema';

commit;
