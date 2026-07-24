begin;

-- Runtime fixes found during the director/teacher/student end-to-end audit.
-- This migration also brings the operational training/oral-test definitions
-- back under source control for environments restored from the production
-- baseline.

-- Notification idempotency columns existed in production through an
-- operational patch. Version them before the enrollment notification Edge
-- Function starts using the durable queue.
alter table if exists public.notification_queue
  add column if not exists source_id uuid,
  add column if not exists source_type text,
  add column if not exists class_date date,
  add column if not exists notification_kind text;

alter table if exists public.notification_queue
  drop constraint if exists notification_queue_status_check;

alter table if exists public.notification_queue
  add constraint notification_queue_status_check
  check (status in ('pending', 'processing', 'sent', 'failed', 'skipped'));

create unique index if not exists idx_notif_queue_idemp
  on public.notification_queue (
    source_id,
    source_type,
    class_date,
    notification_kind
  )
  where source_id is not null;

-- The contract view contains CPF, address and signature metadata. Running it
-- as the invoker keeps the underlying profiles/payment RLS in force.
alter view if exists public.vw_student_contracts
  set (security_invoker = true);
revoke all on table public.vw_student_contracts from anon;
grant select on table public.vw_student_contracts
  to authenticated, service_role;

-- Operational training/oral-test tables were originally created outside the
-- timestamped migration chain. Capture the production-compatible shape here
-- so the RPCs and policies below do not depend on an undocumented patch.
create table if not exists public.training_modules (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references public.tenants(id) on delete cascade,
  title text not null,
  description text,
  video_url text,
  category text default 'General',
  is_mandatory boolean default true,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  pdf_url text,
  target_roles text[] default array['TEACHER'::text],
  thumbnail_url text,
  order_index integer default 0,
  created_by uuid references public.profiles(id),
  active boolean default true
);

alter table public.training_modules
  add column if not exists pdf_url text,
  add column if not exists target_roles text[] default array['TEACHER'::text],
  add column if not exists thumbnail_url text,
  add column if not exists order_index integer default 0,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists active boolean default true;

create table if not exists public.training_progress (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references public.tenants(id) on delete cascade,
  teacher_id uuid references public.profiles(id) on delete cascade,
  module_id uuid references public.training_modules(id) on delete cascade,
  status text default 'COMPLETED',
  completed_at timestamptz not null default timezone('utc'::text, now()),
  user_id uuid references public.profiles(id),
  user_role text
);

alter table public.training_progress
  add column if not exists user_id uuid references public.profiles(id),
  add column if not exists user_role text;

alter table public.profiles
  add column if not exists is_trainer boolean default false,
  add column if not exists rejection_email_sent_at timestamptz,
  add column if not exists rejection_email_claimed_at timestamptz,
  add column if not exists rejection_email_reason_hash text,
  add column if not exists paid_through date,
  add column if not exists prepaid_months integer;

grant select (is_trainer, paid_through, prepaid_months)
  on table public.profiles
  to authenticated;

create or replace function public._can_manage_training(
  p_tenant_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.profiles as caller
     where caller.id = (select auth.uid())
       and (
         caller.role = 'SUPER_ADMIN'
         or (
           caller.tenant_id = p_tenant_id
           and (
             caller.role = 'SCHOOL_ADMIN'
             or (
               caller.role = 'TEACHER'
               and caller.is_trainer is true
             )
           )
         )
       )
  );
$function$;

revoke all on function public._can_manage_training(text)
  from public, anon;
grant execute on function public._can_manage_training(text)
  to authenticated;

create index if not exists idx_training_modules_tenant_id
  on public.training_modules (tenant_id);
create index if not exists idx_training_modules_created_by
  on public.training_modules (created_by);
create index if not exists idx_training_progress_tenant_id
  on public.training_progress (tenant_id);
create index if not exists idx_training_progress_module_id
  on public.training_progress (module_id);
create index if not exists idx_training_progress_user_id
  on public.training_progress (user_id);
create unique index if not exists uq_training_progress_user_module
  on public.training_progress (coalesce(user_id, teacher_id), module_id);

alter table public.training_modules enable row level security;
alter table public.training_progress enable row level security;

drop policy if exists "Admins can manage training modules"
  on public.training_modules;
drop policy if exists "Teachers can view training modules"
  on public.training_modules;
drop policy if exists training_modules_select_scope
  on public.training_modules;
drop policy if exists training_modules_insert_manager
  on public.training_modules;
drop policy if exists training_modules_update_manager
  on public.training_modules;
drop policy if exists training_modules_delete_manager
  on public.training_modules;

create policy training_modules_select_scope
  on public.training_modules
  for select
  to authenticated
  using (
    (select public._my_role()) = 'SUPER_ADMIN'
    or (
      tenant_id = (select public._my_tenant_id())
      and (
        (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
        or (
          active is true
          and upper((select public._my_role())) = any (
            coalesce(
              array(
                select upper(target_role)
                  from unnest(target_roles) as target_role
              ),
              array[]::text[]
            )
          )
        )
      )
    )
  );

create policy training_modules_insert_manager
  on public.training_modules
  for insert
  to authenticated
  with check (
    (select public._can_manage_training(tenant_id))
  );

create policy training_modules_update_manager
  on public.training_modules
  for update
  to authenticated
  using (
    (select public._can_manage_training(tenant_id))
  )
  with check (
    (select public._can_manage_training(tenant_id))
  );

create policy training_modules_delete_manager
  on public.training_modules
  for delete
  to authenticated
  using (
    (select public._can_manage_training(tenant_id))
  );

drop policy if exists "Admins can view all progress"
  on public.training_progress;
drop policy if exists "Teachers can manage their own progress"
  on public.training_progress;
drop policy if exists training_progress_select_scope
  on public.training_progress;

create policy training_progress_select_scope
  on public.training_progress
  for select
  to authenticated
  using (
    coalesce(user_id, teacher_id) = (select auth.uid())
    or (select public._my_role()) = 'SUPER_ADMIN'
    or (
      tenant_id = (select public._my_tenant_id())
      and (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
    )
  );

alter table public.profiles
  add column if not exists can_oral_test boolean default false;

update public.profiles
   set can_oral_test = false
 where can_oral_test is null;

alter table public.profiles
  alter column can_oral_test set default false,
  alter column can_oral_test set not null;

create table if not exists public.oral_tests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  student_id uuid not null references public.profiles(id) on delete cascade,
  native_teacher_id uuid references public.profiles(id),
  examiner_id uuid references public.profiles(id),
  status text not null default 'DUE'
    check (status in ('DUE', 'SCHEDULED', 'DONE', 'SKIPPED')),
  cycle_start date not null,
  due_date date not null,
  scheduled_at timestamptz,
  score integer,
  result text,
  notes text,
  director_notified_at timestamptz,
  director_notification_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  unique (student_id, cycle_start)
);

alter table public.oral_tests
  add column if not exists director_notification_claimed_at timestamptz;

create index if not exists oral_tests_examiner_idx
  on public.oral_tests (examiner_id);
create index if not exists oral_tests_tenant_status_idx
  on public.oral_tests (tenant_id, status);

alter table public.oral_tests enable row level security;

drop policy if exists oral_select_tenant on public.oral_tests;
drop policy if exists oral_insert_admin on public.oral_tests;
drop policy if exists oral_update_admin_or_examiner on public.oral_tests;
drop policy if exists oral_delete_admin on public.oral_tests;
drop policy if exists oral_select_scope on public.oral_tests;
drop policy if exists oral_update_scope on public.oral_tests;

create policy oral_select_scope
  on public.oral_tests
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
          and examiner_id = (select auth.uid())
        )
      )
    )
  );

create policy oral_insert_admin
  on public.oral_tests
  for insert
  to authenticated
  with check (
    tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  );

create policy oral_update_scope
  on public.oral_tests
  for update
  to authenticated
  using (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
      or (
        (select public._my_role()) = 'TEACHER'
        and examiner_id = (select auth.uid())
      )
    )
  )
  with check (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
      or (
        (select public._my_role()) = 'TEACHER'
        and examiner_id = (select auth.uid())
      )
    )
  );

create policy oral_delete_admin
  on public.oral_tests
  for delete
  to authenticated
  using (
    tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
  );

alter table public.wolfie_sessions
  add column if not exists started_at timestamptz default now(),
  add column if not exists finished_at timestamptz;

-- ---------------------------------------------------------------------------
-- Wolfie Lab: expose the real profiles relationship and scope reads by tenant.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
      from public.wolfie_sessions as ws
      left join public.profiles as p on p.id = ws.student_id
     where p.id is null
  ) then
    raise exception
      using
        errcode = '23503',
        message = 'wolfie_sessions contains students without a public profile';
  end if;
end;
$$;

alter table public.wolfie_sessions
  drop constraint if exists wolfie_sessions_student_id_fkey;

alter table public.wolfie_sessions
  add constraint wolfie_sessions_student_id_fkey
  foreign key (student_id)
  references public.profiles(id)
  on delete cascade
  not valid;

alter table public.wolfie_sessions
  validate constraint wolfie_sessions_student_id_fkey;

create index if not exists idx_wolfie_sessions_tenant_created_at
  on public.wolfie_sessions (tenant_id, created_at desc);

create or replace function public._teacher_can_access_student(
  p_student_id uuid,
  p_tenant_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.profiles as caller
      join public.profiles as student
        on student.id = p_student_id
     where caller.id = (select auth.uid())
       and caller.role = 'TEACHER'
       and caller.tenant_id = p_tenant_id
       and student.role = 'STUDENT'
       and student.tenant_id = p_tenant_id
       and (
         student.professor_id = caller.id
         or student.professor_id2 = caller.id
       )
  );
$function$;

revoke all on function public._teacher_can_access_student(uuid, text)
  from public, anon;
grant execute on function public._teacher_can_access_student(uuid, text)
  to authenticated;

drop policy if exists "Admins can view all sessions" on public.wolfie_sessions;
drop policy if exists "Service Role can insert sessions" on public.wolfie_sessions;
drop policy if exists "Students can view their own sessions" on public.wolfie_sessions;
drop policy if exists students_insert_own_sessions on public.wolfie_sessions;
drop policy if exists students_update_own_sessions on public.wolfie_sessions;
drop policy if exists wolfie_sessions_select_scope on public.wolfie_sessions;
drop policy if exists wolfie_sessions_insert_own on public.wolfie_sessions;
drop policy if exists wolfie_sessions_update_own on public.wolfie_sessions;

create policy wolfie_sessions_select_scope
  on public.wolfie_sessions
  for select
  to authenticated
  using (
    student_id = (select auth.uid())
    or (select public._my_role()) = 'SUPER_ADMIN'
    or (
      (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
      and tenant_id::text = (select public._my_tenant_id())
    )
    or (
      (select public._my_role()) = 'TEACHER'
      and tenant_id::text = (select public._my_tenant_id())
      and (
        select public._teacher_can_access_student(
          wolfie_sessions.student_id,
          wolfie_sessions.tenant_id::text
        )
      )
    )
  );

create policy wolfie_sessions_insert_own
  on public.wolfie_sessions
  for insert
  to authenticated
  with check (
    student_id = (select auth.uid())
    and tenant_id::text = (select public._my_tenant_id())
    and (select public._my_role()) = 'STUDENT'
  );

create policy wolfie_sessions_update_own
  on public.wolfie_sessions
  for update
  to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id::text = (select public._my_tenant_id())
    and (select public._my_role()) = 'STUDENT'
  )
  with check (
    student_id = (select auth.uid())
    and tenant_id::text = (select public._my_tenant_id())
    and (select public._my_role()) = 'STUDENT'
  );

drop policy if exists "Service Role can insert turns" on public.wolfie_turns;
drop policy if exists "Students can view their own turns" on public.wolfie_turns;
drop policy if exists students_insert_own_turns on public.wolfie_turns;
drop policy if exists wolfie_turns_select_scope on public.wolfie_turns;
drop policy if exists wolfie_turns_insert_own on public.wolfie_turns;

create policy wolfie_turns_select_scope
  on public.wolfie_turns
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.wolfie_sessions as ws
       where ws.id = wolfie_turns.session_id
         and (
           ws.student_id = (select auth.uid())
           or (select public._my_role()) = 'SUPER_ADMIN'
           or (
             (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
             and ws.tenant_id::text = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and ws.tenant_id::text = (select public._my_tenant_id())
             and (
               select public._teacher_can_access_student(
                 ws.student_id,
                 ws.tenant_id::text
               )
             )
           )
         )
    )
  );

create policy wolfie_turns_insert_own
  on public.wolfie_turns
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.wolfie_sessions as ws
       where ws.id = wolfie_turns.session_id
         and ws.student_id = (select auth.uid())
         and ws.tenant_id::text = (select public._my_tenant_id())
         and (select public._my_role()) = 'STUDENT'
    )
  );

drop policy if exists "Service Role can insert corrections" on public.wolfie_corrections;
drop policy if exists "Students can view their own corrections" on public.wolfie_corrections;
drop policy if exists students_insert_own_corrections on public.wolfie_corrections;
drop policy if exists wolfie_corrections_select_scope on public.wolfie_corrections;
drop policy if exists wolfie_corrections_insert_own on public.wolfie_corrections;

create policy wolfie_corrections_select_scope
  on public.wolfie_corrections
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.wolfie_sessions as ws
       where ws.id = wolfie_corrections.session_id
         and (
           ws.student_id = (select auth.uid())
           or (select public._my_role()) = 'SUPER_ADMIN'
           or (
             (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
             and ws.tenant_id::text = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and ws.tenant_id::text = (select public._my_tenant_id())
             and (
               select public._teacher_can_access_student(
                 ws.student_id,
                 ws.tenant_id::text
               )
             )
           )
         )
    )
  );

create policy wolfie_corrections_insert_own
  on public.wolfie_corrections
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.wolfie_sessions as ws
       where ws.id = wolfie_corrections.session_id
         and ws.student_id = (select auth.uid())
         and ws.tenant_id::text = (select public._my_tenant_id())
         and (select public._my_role()) = 'STUDENT'
    )
  );

drop policy if exists "Admins can view evaluations" on public.wolfie_evaluations;
drop policy if exists "Service Role can insert evaluations" on public.wolfie_evaluations;
drop policy if exists wolfie_evaluations_select_scope on public.wolfie_evaluations;

create policy wolfie_evaluations_select_scope
  on public.wolfie_evaluations
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.wolfie_sessions as ws
       where ws.id = wolfie_evaluations.session_id
         and (
           ws.student_id = (select auth.uid())
           or (select public._my_role()) = 'SUPER_ADMIN'
           or (
             (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
             and ws.tenant_id::text = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and ws.tenant_id::text = (select public._my_tenant_id())
             and (
               select public._teacher_can_access_student(
                 ws.student_id,
                 ws.tenant_id::text
               )
             )
           )
         )
    )
  );

revoke all on table
  public.wolfie_sessions,
  public.wolfie_turns,
  public.wolfie_corrections,
  public.wolfie_evaluations
from anon;

revoke all on table
  public.wolfie_sessions,
  public.wolfie_turns,
  public.wolfie_corrections,
  public.wolfie_evaluations
from authenticated;

grant select, insert, update on table public.wolfie_sessions to authenticated;
grant select, insert on table public.wolfie_turns to authenticated;
grant select, insert on table public.wolfie_corrections to authenticated;
grant select on table public.wolfie_evaluations to authenticated;

-- ---------------------------------------------------------------------------
-- Training: version and harden the two RPCs that previously existed only in
-- production. Every identifier is qualified to avoid PL/pgSQL output-variable
-- ambiguity (SQLSTATE 42702).
-- ---------------------------------------------------------------------------

create or replace function public.my_training_modules()
returns table (
  id uuid,
  title text,
  description text,
  video_url text,
  pdf_url text,
  thumbnail_url text,
  category text,
  is_mandatory boolean,
  order_index integer,
  target_roles text[],
  progress_status text,
  progress_completed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  with caller as (
    select
      p.id as user_id,
      p.role as user_role,
      p.tenant_id as user_tenant_id
    from public.profiles as p
    where p.id = (select auth.uid())
  )
  select
    m.id,
    m.title,
    m.description,
    m.video_url,
    m.pdf_url,
    m.thumbnail_url,
    m.category,
    m.is_mandatory,
    m.order_index,
    m.target_roles,
    coalesce(tp.status, 'NOT_STARTED'::text) as progress_status,
    tp.completed_at as progress_completed_at
  from caller as c
  join public.training_modules as m
    on m.tenant_id = c.user_tenant_id
  left join public.training_progress as tp
    on tp.module_id = m.id
   and coalesce(tp.user_id, tp.teacher_id) = c.user_id
  where m.active is true
    and (
      c.user_role = 'SUPER_ADMIN'
      or upper(c.user_role) = any (
        coalesce(
          array(
            select upper(target_role)
              from unnest(m.target_roles) as target_role
          ),
          array[]::text[]
        )
      )
    )
  order by m.order_index, m.created_at desc;
$function$;

create or replace function public.mark_training_complete(p_module_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant_id text;
  v_module_id uuid;
begin
  if v_uid is null then
    raise exception
      using errcode = '28000', message = 'Authentication required';
  end if;

  select p.role, p.tenant_id
    into v_role, v_tenant_id
    from public.profiles as p
   where p.id = v_uid;

  if not found or v_tenant_id is null or v_role is null then
    raise exception
      using errcode = '42501', message = 'Active profile required';
  end if;

  select m.id
    into v_module_id
    from public.training_modules as m
   where m.id = p_module_id
     and m.tenant_id = v_tenant_id
     and m.active is true
     and (
       v_role = 'SUPER_ADMIN'
       or upper(v_role) = any (
         coalesce(
           array(
             select upper(target_role)
               from unnest(m.target_roles) as target_role
           ),
           array[]::text[]
         )
       )
     );

  if v_module_id is null then
    raise exception
      using errcode = '42501', message = 'Training module is unavailable';
  end if;

  insert into public.training_progress (
    tenant_id,
    teacher_id,
    user_id,
    user_role,
    module_id,
    status,
    completed_at
  )
  values (
    v_tenant_id,
    case when v_role = 'TEACHER' then v_uid else null end,
    v_uid,
    v_role,
    v_module_id,
    'COMPLETED',
    now()
  )
  on conflict (coalesce(user_id, teacher_id), module_id)
  do update
     set status = excluded.status,
         completed_at = excluded.completed_at,
         tenant_id = excluded.tenant_id,
         user_id = excluded.user_id,
         user_role = excluded.user_role;

  return jsonb_build_object(
    'status', 'OK',
    'module_id', v_module_id,
    'completed_at', now()
  );
end;
$function$;

revoke all on function public.my_training_modules() from public, anon;
revoke all on function public.mark_training_complete(uuid) from public, anon;
grant execute on function public.my_training_modules() to authenticated;
grant execute on function public.mark_training_complete(uuid) to authenticated;

revoke all on table public.training_modules, public.training_progress from anon;
revoke all on table public.training_modules, public.training_progress from authenticated;
grant select, insert, update, delete on table public.training_modules to authenticated;
grant select on table public.training_progress to authenticated;

create or replace function public.claim_rejection_email(
  p_student_id uuid,
  p_reason text,
  p_reason_hash text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_profile public.profiles%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception
      using errcode = '42501', message = 'Service role required';
  end if;
  if p_reason_hash !~ '^[0-9a-f]{64}$' then
    raise exception
      using errcode = '22023', message = 'Invalid rejection reason hash';
  end if;

  select p.*
    into v_profile
    from public.profiles as p
   where p.id = p_student_id
     and p.role = 'STUDENT'
   for update;

  if not found
     or v_profile.documentation_status is distinct from 'REJECTED'
     or btrim(coalesce(v_profile.rejection_reason, ''))
       is distinct from btrim(coalesce(p_reason, '')) then
    raise exception
      using errcode = '55000', message = 'Rejection state changed';
  end if;

  if v_profile.rejection_email_reason_hash = p_reason_hash
     and v_profile.rejection_email_sent_at is not null then
    return 'already_sent';
  end if;

  if v_profile.rejection_email_reason_hash = p_reason_hash
     and v_profile.rejection_email_claimed_at
       > now() - interval '10 minutes' then
    return 'in_progress';
  end if;

  update public.profiles as p
     set rejection_email_reason_hash = p_reason_hash,
         rejection_email_claimed_at = now(),
         rejection_email_sent_at = null
   where p.id = p_student_id;

  return 'claimed';
end;
$function$;

revoke all on function public.claim_rejection_email(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_rejection_email(uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Oral tests: make the eligibility flag readable, but only mutable by a
-- tenant administrator. A trigger also protects against direct profile writes.
-- ---------------------------------------------------------------------------

grant select (can_oral_test)
  on table public.profiles
  to authenticated;

create or replace function public.enforce_can_oral_test_admin_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant_id text;
begin
  if old.can_oral_test is distinct from new.can_oral_test
     and new.can_oral_test is true
     and new.role <> 'TEACHER' then
    raise exception
      using
        errcode = '23514',
        message = 'Only teacher profiles can be eligible for oral tests';
  end if;

  if old.can_oral_test is distinct from new.can_oral_test
     and v_uid is not null then
    select p.role, p.tenant_id
      into v_role, v_tenant_id
      from public.profiles as p
     where p.id = v_uid;

    if v_role is null
       or v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
       or (
         v_role <> 'SUPER_ADMIN'
         and v_tenant_id is distinct from new.tenant_id
       ) then
      raise exception
        using
          errcode = '42501',
          message = 'Only tenant administrators can change oral-test eligibility';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists profiles_protect_can_oral_test on public.profiles;
create trigger profiles_protect_can_oral_test
before update of can_oral_test on public.profiles
for each row
execute function public.enforce_can_oral_test_admin_only();

revoke all on function public.enforce_can_oral_test_admin_only()
  from public, anon, authenticated;

create or replace function public.set_teacher_oral_test_eligibility(
  p_teacher_id uuid,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant_id text;
  v_target_tenant_id text;
begin
  if v_uid is null then
    raise exception
      using errcode = '28000', message = 'Authentication required';
  end if;

  select p.role, p.tenant_id
    into v_role, v_tenant_id
    from public.profiles as p
   where p.id = v_uid;

  if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception
      using errcode = '42501', message = 'Administrator role required';
  end if;

  select p.tenant_id
    into v_target_tenant_id
    from public.profiles as p
   where p.id = p_teacher_id
     and p.role = 'TEACHER'
     and (
       v_role = 'SUPER_ADMIN'
       or p.tenant_id = v_tenant_id
     )
   for update;

  if not found then
    raise exception
      using errcode = '42501', message = 'Teacher is outside the allowed tenant';
  end if;

  update public.profiles as p
     set can_oral_test = p_enabled
   where p.id = p_teacher_id
     and p.tenant_id = v_target_tenant_id;

  return jsonb_build_object(
    'teacher_id', p_teacher_id,
    'enabled', p_enabled
  );
end;
$function$;

revoke all on function public.set_teacher_oral_test_eligibility(uuid, boolean)
  from public, anon;
grant execute on function public.set_teacher_oral_test_eligibility(uuid, boolean)
  to authenticated;

create or replace function public.detect_due_oral_tests(
  p_tenant text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant_id text;
  v_count integer;
begin
  if p_tenant is null or btrim(p_tenant) = '' then
    raise exception
      using errcode = '22023', message = 'Tenant is required';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_uid is null then
      raise exception
        using errcode = '28000', message = 'Authentication required';
    end if;

    select p.role, p.tenant_id
      into v_role, v_tenant_id
      from public.profiles as p
     where p.id = v_uid;

    if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
       or (
         v_role <> 'SUPER_ADMIN'
         and v_tenant_id is distinct from p_tenant
       ) then
      raise exception
        using errcode = '42501', message = 'Administrator role required';
    end if;
  end if;

  with base as (
    select
      p.id as student_id,
      p.tenant_id,
      (
        select min(cl.class_date)::date
          from public.class_logs as cl
         where cl.student_id = p.id
      ) as first_class,
      (
        select max(ot.done_at)::date
          from public.oral_tests as ot
         where ot.student_id = p.id
           and ot.status = 'DONE'
      ) as last_done
    from public.profiles as p
    where p.tenant_id = p_tenant
      and p.role = 'STUDENT'
      and coalesce(p.lifecycle_status, 'active') = 'active'
      and coalesce(p.is_test_account, false) is false
  ),
  eligible as (
    select
      base.student_id,
      base.tenant_id,
      coalesce(base.last_done, base.first_class) as baseline
    from base
    where base.first_class is not null
      and coalesce(base.last_done, base.first_class)
        <= (current_date - interval '45 days')::date
  ),
  native_teacher as (
    select ranked.student_id, ranked.teacher_id
      from (
        select
          cl.student_id,
          cl.teacher_id,
          row_number() over (
            partition by cl.student_id
            order by count(*) desc, cl.teacher_id
          ) as position
        from public.class_logs as cl
        join eligible as e on e.student_id = cl.student_id
        where cl.teacher_id is not null
        group by cl.student_id, cl.teacher_id
      ) as ranked
     where ranked.position = 1
  ),
  inserted as (
    insert into public.oral_tests (
      tenant_id,
      student_id,
      native_teacher_id,
      status,
      cycle_start,
      due_date
    )
    select
      e.tenant_id,
      e.student_id,
      nt.teacher_id,
      'DUE',
      e.baseline,
      (e.baseline + interval '45 days')::date
    from eligible as e
    left join native_teacher as nt on nt.student_id = e.student_id
    on conflict (student_id, cycle_start) do nothing
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$function$;

create or replace function public.schedule_oral_test(
  p_test_id uuid,
  p_examiner_id uuid,
  p_scheduled_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant_id text;
  v_test public.oral_tests%rowtype;
begin
  if v_uid is null then
    raise exception
      using errcode = '28000', message = 'Authentication required';
  end if;
  if p_scheduled_at is null then
    raise exception
      using errcode = '22023', message = 'Schedule date is required';
  end if;

  select p.role, p.tenant_id
    into v_role, v_tenant_id
    from public.profiles as p
   where p.id = v_uid;

  if v_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception
      using errcode = '42501', message = 'Administrator role required';
  end if;

  select ot.*
    into v_test
    from public.oral_tests as ot
   where ot.id = p_test_id
   for update;

  if not found
     or (
       v_role <> 'SUPER_ADMIN'
       and v_test.tenant_id is distinct from v_tenant_id
     ) then
    raise exception
      using errcode = '42501', message = 'Oral test is outside the allowed tenant';
  end if;
  if v_test.status in ('DONE', 'SKIPPED') then
    raise exception
      using errcode = '22023', message = 'Completed oral tests cannot be scheduled';
  end if;

  if p_examiner_id is not null
     and not exists (
       select 1
         from public.profiles as examiner
        where examiner.id = p_examiner_id
          and examiner.role = 'TEACHER'
          and examiner.tenant_id = v_test.tenant_id
          and examiner.can_oral_test is true
          and examiner.id is distinct from v_test.native_teacher_id
     ) then
    raise exception
      using errcode = '42501', message = 'Examiner is not eligible for this oral test';
  end if;

  update public.oral_tests as ot
     set examiner_id = p_examiner_id,
         scheduled_at = p_scheduled_at,
         status = 'SCHEDULED'
   where ot.id = v_test.id;

  return jsonb_build_object(
    'test_id', v_test.id,
    'status', 'SCHEDULED',
    'scheduled_at', p_scheduled_at,
    'examiner_id', p_examiner_id
  );
end;
$function$;

create or replace function public.complete_oral_test(
  p_test_id uuid,
  p_score integer,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant_id text;
  v_test public.oral_tests%rowtype;
begin
  if v_uid is null then
    raise exception
      using errcode = '28000', message = 'Authentication required';
  end if;
  if p_score is not null and (p_score < 0 or p_score > 10) then
    raise exception
      using errcode = '22023', message = 'Score must be between 0 and 10';
  end if;
  if char_length(coalesce(p_notes, '')) > 4000 then
    raise exception
      using errcode = '22023', message = 'Notes are too long';
  end if;

  select p.role, p.tenant_id
    into v_role, v_tenant_id
    from public.profiles as p
   where p.id = v_uid;

  select ot.*
    into v_test
    from public.oral_tests as ot
   where ot.id = p_test_id
   for update;

  if not found then
    raise exception
      using errcode = '42501', message = 'Oral test is unavailable';
  end if;
  if v_test.status in ('DONE', 'SKIPPED') then
    raise exception
      using errcode = '22023', message = 'Oral test is already closed';
  end if;

  if not (
    v_role = 'SUPER_ADMIN'
    or (
      v_role = 'SCHOOL_ADMIN'
      and v_tenant_id = v_test.tenant_id
    )
    or (
      v_role = 'TEACHER'
      and v_tenant_id = v_test.tenant_id
      and v_test.examiner_id = v_uid
      and v_test.native_teacher_id is distinct from v_uid
    )
  ) then
    raise exception
      using errcode = '42501', message = 'Caller cannot complete this oral test';
  end if;

  update public.oral_tests as ot
     set status = 'DONE',
         done_at = now(),
         score = p_score,
         notes = nullif(btrim(coalesce(p_notes, '')), '')
   where ot.id = v_test.id;

  return jsonb_build_object(
    'test_id', v_test.id,
    'status', 'DONE',
    'done_at', now()
  );
end;
$function$;

revoke all on function public.detect_due_oral_tests(text)
  from public, anon;
revoke all on function public.schedule_oral_test(uuid, uuid, timestamptz)
  from public, anon;
revoke all on function public.complete_oral_test(uuid, integer, text)
  from public, anon;
grant execute on function public.detect_due_oral_tests(text)
  to authenticated, service_role;
grant execute on function public.schedule_oral_test(uuid, uuid, timestamptz)
  to authenticated;
grant execute on function public.complete_oral_test(uuid, integer, text)
  to authenticated;

revoke all on table public.oral_tests from anon;
revoke all on table public.oral_tests from authenticated;
grant select on table public.oral_tests to authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
