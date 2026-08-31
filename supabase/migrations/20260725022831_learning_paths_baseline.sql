begin;

-- Official ordered baseline for the legacy learning-path schema. The original
-- definitions lived only in /learning_paths_schema.sql, which made a fresh
-- migration replay fail in the immediately following verified-XP migration.
-- Every statement is additive so the production schema remains untouched.

-- Gamification originally shipped as root-level ad-hoc SQL files rather than
-- ordered migrations. The next ordered migration compiles functions against
-- these columns, so establish the complete profile contract first.
alter table public.profiles
  add column if not exists xp integer default 0,
  add column if not exists level integer default 1,
  add column if not exists daily_xp integer default 0,
  add column if not exists daily_xp_date date,
  add column if not exists daily_xp_goal integer default 30,
  add column if not exists last_activity timestamptz,
  add column if not exists hearts integer default 5,
  add column if not exists hearts_updated_at timestamptz
    default pg_catalog.now(),
  add column if not exists hearts_full_notified boolean default true,
  add column if not exists streak_count integer default 0,
  add column if not exists last_streak_date date,
  add column if not exists current_book_part text default 'A1-1'::text,
  add column if not exists evaluation_unlocked boolean default false,
  add column if not exists unlocked_tests text[] default '{}'::text[];

alter table public.profiles
  alter column xp set default 0,
  alter column level set default 1,
  alter column daily_xp set default 0,
  alter column daily_xp_goal set default 30,
  alter column hearts set default 5,
  alter column hearts_updated_at set default pg_catalog.now(),
  alter column hearts_full_notified set default true,
  alter column streak_count set default 0,
  alter column current_book_part set default 'A1-1'::text,
  alter column evaluation_unlocked set default false,
  alter column unlocked_tests set default '{}'::text[];

create table if not exists public.learning_paths (
  id uuid primary key default gen_random_uuid(),
  tenant_id text,
  name text not null,
  description text,
  target_level text,
  category text,
  cover_image_url text,
  estimated_hours integer,
  active boolean default true,
  created_at timestamptz default pg_catalog.now(),
  created_by uuid references public.profiles(id)
);

alter table public.learning_paths
  add column if not exists tenant_id text,
  add column if not exists name text,
  add column if not exists description text,
  add column if not exists target_level text,
  add column if not exists category text,
  add column if not exists cover_image_url text,
  add column if not exists estimated_hours integer,
  add column if not exists active boolean default true,
  add column if not exists created_at timestamptz default pg_catalog.now(),
  add column if not exists created_by uuid references public.profiles(id);

create index if not exists idx_learning_paths_tenant
  on public.learning_paths (tenant_id, active);
create index if not exists idx_learning_paths_category
  on public.learning_paths (category, target_level);

create table if not exists public.learning_units (
  id uuid primary key default gen_random_uuid(),
  path_id uuid not null references public.learning_paths(id) on delete cascade,
  order_index integer not null,
  title text not null,
  description text,
  estimated_minutes integer,
  skill_focus text[],
  created_at timestamptz default pg_catalog.now(),
  unique (path_id, order_index)
);

alter table public.learning_units
  add column if not exists path_id uuid
    references public.learning_paths(id) on delete cascade,
  add column if not exists order_index integer,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists estimated_minutes integer,
  add column if not exists skill_focus text[],
  add column if not exists created_at timestamptz default pg_catalog.now();

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.learning_units'::regclass
       and conname = 'learning_units_path_id_order_index_key'
  ) then
    alter table public.learning_units
      add constraint learning_units_path_id_order_index_key
      unique (path_id, order_index);
  end if;
end
$block$;

create index if not exists idx_learning_units_path
  on public.learning_units (path_id, order_index);

create table if not exists public.unit_activities (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.learning_units(id) on delete cascade,
  order_index integer not null,
  type text not null check (
    type in (
      'vocab_cards',
      'reading',
      'grammar_drill',
      'quiz',
      'speaking_wolfie',
      'listening',
      'writing'
    )
  ),
  title text not null,
  description text,
  content jsonb not null default '{}'::jsonb,
  xp_reward integer default 30,
  estimated_minutes integer default 5,
  created_at timestamptz default pg_catalog.now(),
  unique (unit_id, order_index)
);

alter table public.unit_activities
  add column if not exists unit_id uuid
    references public.learning_units(id) on delete cascade,
  add column if not exists order_index integer,
  add column if not exists type text,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists content jsonb default '{}'::jsonb,
  add column if not exists xp_reward integer default 30,
  add column if not exists estimated_minutes integer default 5,
  add column if not exists created_at timestamptz default pg_catalog.now();

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.unit_activities'::regclass
       and conname = 'unit_activities_unit_id_order_index_key'
  ) then
    alter table public.unit_activities
      add constraint unit_activities_unit_id_order_index_key
      unique (unit_id, order_index);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.unit_activities'::regclass
       and conname = 'unit_activities_type_check'
  ) then
    alter table public.unit_activities
      add constraint unit_activities_type_check
      check (
        type in (
          'vocab_cards',
          'reading',
          'grammar_drill',
          'quiz',
          'speaking_wolfie',
          'listening',
          'writing'
        )
      ) not valid;
  end if;
end
$block$;

create index if not exists idx_unit_activities_unit
  on public.unit_activities (unit_id, order_index);

create table if not exists public.student_path_enrollments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  path_id uuid not null references public.learning_paths(id) on delete cascade,
  tenant_id text,
  current_unit_id uuid references public.learning_units(id),
  started_at timestamptz default pg_catalog.now(),
  completed_at timestamptz,
  assigned_by uuid references public.profiles(id),
  unique (student_id, path_id)
);

alter table public.student_path_enrollments
  add column if not exists student_id uuid
    references public.profiles(id) on delete cascade,
  add column if not exists path_id uuid
    references public.learning_paths(id) on delete cascade,
  add column if not exists tenant_id text,
  add column if not exists current_unit_id uuid
    references public.learning_units(id),
  add column if not exists started_at timestamptz default pg_catalog.now(),
  add column if not exists completed_at timestamptz,
  add column if not exists assigned_by uuid references public.profiles(id);

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_path_enrollments'::regclass
       and conname = 'student_path_enrollments_student_id_path_id_key'
  ) then
    alter table public.student_path_enrollments
      add constraint student_path_enrollments_student_id_path_id_key
      unique (student_id, path_id);
  end if;
end
$block$;

create index if not exists idx_student_enroll
  on public.student_path_enrollments (student_id);
create index if not exists idx_student_path_enrollments_path_id
  on public.student_path_enrollments (path_id);
create index if not exists idx_student_path_enrollments_current_unit_id
  on public.student_path_enrollments (current_unit_id);
create index if not exists idx_student_path_enrollments_assigned_by
  on public.student_path_enrollments (assigned_by);

create table if not exists public.student_activity_progress (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  activity_id uuid not null
    references public.unit_activities(id) on delete cascade,
  unit_id uuid not null references public.learning_units(id),
  status text not null default 'NOT_STARTED' check (
    status in ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')
  ),
  score numeric,
  attempts integer default 0,
  time_spent_seconds integer default 0,
  completed_at timestamptz,
  last_attempt_at timestamptz default pg_catalog.now(),
  unique (student_id, activity_id)
);

alter table public.student_activity_progress
  add column if not exists student_id uuid
    references public.profiles(id) on delete cascade,
  add column if not exists activity_id uuid
    references public.unit_activities(id) on delete cascade,
  add column if not exists unit_id uuid references public.learning_units(id),
  add column if not exists status text default 'NOT_STARTED',
  add column if not exists score numeric,
  add column if not exists attempts integer default 0,
  add column if not exists time_spent_seconds integer default 0,
  add column if not exists completed_at timestamptz,
  add column if not exists last_attempt_at timestamptz default pg_catalog.now();

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activity_progress'::regclass
       and conname = 'student_activity_progress_student_id_activity_id_key'
  ) then
    alter table public.student_activity_progress
      add constraint student_activity_progress_student_id_activity_id_key
      unique (student_id, activity_id);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_activity_progress'::regclass
       and conname = 'student_activity_progress_status_check'
  ) then
    alter table public.student_activity_progress
      add constraint student_activity_progress_status_check
      check (status in ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'))
      not valid;
  end if;
end
$block$;

create index if not exists idx_activity_progress_student
  on public.student_activity_progress (student_id, unit_id);
create index if not exists idx_student_activity_progress_activity_id
  on public.student_activity_progress (activity_id);
create index if not exists idx_student_activity_progress_unit_id
  on public.student_activity_progress (unit_id);

create table if not exists public.student_skill_scores (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  skill text not null check (
    skill in (
      'grammar',
      'vocabulary',
      'listening',
      'speaking',
      'reading',
      'writing',
      'pronunciation'
    )
  ),
  current_score numeric default 0,
  total_activities integer default 0,
  last_updated timestamptz default pg_catalog.now(),
  unique (student_id, skill)
);

alter table public.student_skill_scores
  add column if not exists student_id uuid
    references public.profiles(id) on delete cascade,
  add column if not exists skill text,
  add column if not exists current_score numeric default 0,
  add column if not exists total_activities integer default 0,
  add column if not exists last_updated timestamptz default pg_catalog.now();

do $block$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_skill_scores'::regclass
       and conname = 'student_skill_scores_student_id_skill_key'
  ) then
    alter table public.student_skill_scores
      add constraint student_skill_scores_student_id_skill_key
      unique (student_id, skill);
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint
     where conrelid = 'public.student_skill_scores'::regclass
       and conname = 'student_skill_scores_skill_check'
  ) then
    alter table public.student_skill_scores
      add constraint student_skill_scores_skill_check
      check (
        skill in (
          'grammar',
          'vocabulary',
          'listening',
          'speaking',
          'reading',
          'writing',
          'pronunciation'
        )
      ) not valid;
  end if;
end
$block$;

create index if not exists idx_skill_scores_student
  on public.student_skill_scores (student_id);

-- The immediately following Wolfie migration revokes these two legacy tables.
-- They were also previously present only through production drift, so create a
-- compatible baseline before that revoke executes on a clean migration replay.
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

alter table public.student_activities
  add column if not exists student_id uuid
    references public.profiles(id) on delete cascade,
  add column if not exists tenant_id text
    references public.tenants(id) on delete cascade,
  add column if not exists type text,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists content text,
  add column if not exists difficulty text default 'INTERMEDIATE',
  add column if not exists category text,
  add column if not exists xp_reward integer default 50,
  add column if not exists status text default 'PENDING',
  add column if not exists completed_at timestamptz,
  add column if not exists created_at timestamptz default pg_catalog.now(),
  add column if not exists generated_by_ai boolean default true;

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
  add column if not exists student_id uuid
    references public.profiles(id) on delete cascade,
  add column if not exists term text,
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

create index if not exists idx_vocab_reviews_student_due
  on public.student_vocab_reviews (student_id, next_review_at);
create index if not exists idx_student_vocab_reviews_tenant_due
  on public.student_vocab_reviews (tenant_id, next_review_at);
create index if not exists idx_student_vocab_reviews_source_activity_id
  on public.student_vocab_reviews (source_activity_id);

alter table public.learning_paths enable row level security;
alter table public.learning_units enable row level security;
alter table public.unit_activities enable row level security;
alter table public.student_path_enrollments enable row level security;
alter table public.student_activity_progress enable row level security;
alter table public.student_skill_scores enable row level security;

-- This baseline is intentionally earlier than the multi-tenant context helpers
-- introduced by later migrations. Keep a small actor-context bridge here so a
-- fresh restore is usable at every point in the ordered history. Once the
-- membership helpers exist, these functions automatically delegate to them.
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

create or replace function private.learning_actor_tenant_id()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text;
begin
  if pg_catalog.to_regprocedure('private.active_tenant_id(uuid)') is not null then
    execute 'select private.active_tenant_id($1)'
      into v_tenant_id
      using (select auth.uid());
    return v_tenant_id;
  end if;

  select profile.tenant_id
    into v_tenant_id
    from public.profiles as profile
   where profile.id = (select auth.uid());

  return v_tenant_id;
end;
$function$;

create or replace function private.learning_actor_role()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text;
begin
  if pg_catalog.to_regprocedure('private.active_tenant_role(uuid)') is not null then
    execute 'select private.active_tenant_role($1)'
      into v_role
      using (select auth.uid());
    return v_role;
  end if;

  select profile.role::text
    into v_role
    from public.profiles as profile
   where profile.id = (select auth.uid());

  return v_role;
end;
$function$;

revoke all on function private.learning_actor_tenant_id()
  from public, anon, authenticated;
revoke all on function private.learning_actor_role()
  from public, anon, authenticated;
grant execute on function private.learning_actor_tenant_id()
  to authenticated, service_role;
grant execute on function private.learning_actor_role()
  to authenticated, service_role;

-- Remove the permissive policies from the legacy standalone schema before
-- recreating an explicit tenant/global curriculum boundary.
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
        'learning_paths',
        'learning_units',
        'unit_activities'
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

create policy learning_paths_read_scoped
on public.learning_paths
for select
to authenticated
using (
  (select private.learning_actor_role()) = 'SUPER_ADMIN'
  or (
    (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
    and (
      tenant_id is null
      or tenant_id = (select private.learning_actor_tenant_id())
    )
  )
  or (
    active is true
    and (
      tenant_id is null
      or tenant_id = (select private.learning_actor_tenant_id())
    )
  )
);

create policy learning_paths_staff_insert
on public.learning_paths
for insert
to authenticated
with check (
  (select private.learning_actor_role()) = 'SUPER_ADMIN'
  or (
    (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
    and tenant_id = (select private.learning_actor_tenant_id())
    and (created_by is null or created_by = (select auth.uid()))
  )
);

create policy learning_paths_staff_update
on public.learning_paths
for update
to authenticated
using (
  (select private.learning_actor_role()) = 'SUPER_ADMIN'
  or (
    (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
    and tenant_id = (select private.learning_actor_tenant_id())
  )
)
with check (
  (select private.learning_actor_role()) = 'SUPER_ADMIN'
  or (
    (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
    and tenant_id = (select private.learning_actor_tenant_id())
  )
);

create policy learning_paths_staff_delete
on public.learning_paths
for delete
to authenticated
using (
  (select private.learning_actor_role()) = 'SUPER_ADMIN'
  or (
    (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
    and tenant_id = (select private.learning_actor_tenant_id())
  )
);

create policy learning_units_read_scoped
on public.learning_units
for select
to authenticated
using (
  exists (
    select 1
      from public.learning_paths as path
     where path.id = path_id
  )
);

create policy learning_units_staff_insert
on public.learning_units
for insert
to authenticated
with check (
  exists (
    select 1
      from public.learning_paths as path
     where path.id = path_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
);

create policy learning_units_staff_update
on public.learning_units
for update
to authenticated
using (
  exists (
    select 1
      from public.learning_paths as path
     where path.id = path_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
)
with check (
  exists (
    select 1
      from public.learning_paths as path
     where path.id = path_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
);

create policy learning_units_staff_delete
on public.learning_units
for delete
to authenticated
using (
  exists (
    select 1
      from public.learning_paths as path
     where path.id = path_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
);

create policy unit_activities_read_scoped
on public.unit_activities
for select
to authenticated
using (
  (select private.learning_actor_role()) in (
    'SUPER_ADMIN',
    'SCHOOL_ADMIN',
    'COORDINATOR',
    'TEACHER'
  )
  and exists (
      select 1
        from public.learning_units as unit
       where unit.id = unit_id
    )
);

create policy unit_activities_staff_insert
on public.unit_activities
for insert
to authenticated
with check (
  exists (
    select 1
      from public.learning_units as unit
      join public.learning_paths as path
        on path.id = unit.path_id
     where unit.id = unit_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
);

create policy unit_activities_staff_update
on public.unit_activities
for update
to authenticated
using (
  exists (
    select 1
      from public.learning_units as unit
      join public.learning_paths as path
        on path.id = unit.path_id
     where unit.id = unit_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
)
with check (
  exists (
    select 1
      from public.learning_units as unit
      join public.learning_paths as path
        on path.id = unit.path_id
     where unit.id = unit_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
);

create policy unit_activities_staff_delete
on public.unit_activities
for delete
to authenticated
using (
  exists (
    select 1
      from public.learning_units as unit
      join public.learning_paths as path
        on path.id = unit.path_id
     where unit.id = unit_id
       and (
         (select private.learning_actor_role()) = 'SUPER_ADMIN'
         or (
           (select private.learning_actor_role()) = 'SCHOOL_ADMIN'
           and path.tenant_id = (select private.learning_actor_tenant_id())
         )
       )
  )
);

revoke all on table
  public.learning_paths,
  public.learning_units,
  public.unit_activities
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.learning_paths,
  public.learning_units,
  public.unit_activities
to authenticated;

grant all on table
  public.learning_paths,
  public.learning_units,
  public.unit_activities
to service_role;

comment on table public.learning_paths is
  'Ordered tenant/global curricula; official baseline restored to migration history.';

commit;
