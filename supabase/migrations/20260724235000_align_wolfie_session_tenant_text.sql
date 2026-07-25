begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- `tenants.id`, `profiles.tenant_id` and every other tenant-scoped table use
-- TEXT identifiers. Wolfie sessions were originally created with UUID, which
-- rejects slug-style tenant ids in PostgREST filters and Edge Function inserts.
--
-- Existing UUID values are not discarded. A value that already identifies a
-- tenant is preserved; otherwise the student's profile supplies the tenant.
-- The preflight checks abort the whole transaction if neither source resolves
-- to a real tenant.
do $migration$
declare
  v_tenant_type text;
begin
  if to_regclass('public.wolfie_sessions') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.tenants') is null then
    raise exception
      using
        errcode = '42P01',
        message = 'Wolfie tenant migration requires wolfie_sessions, profiles and tenants';
  end if;

  select format_type(a.atttypid, a.atttypmod)
    into v_tenant_type
    from pg_attribute as a
   where a.attrelid = 'public.wolfie_sessions'::regclass
     and a.attname = 'tenant_id'
     and not a.attisdropped;

  if v_tenant_type is null
     or v_tenant_type not in ('uuid', 'text') then
    raise exception
      using
        errcode = '42804',
        message = format(
          'Unsupported wolfie_sessions.tenant_id type: %s',
          coalesce(v_tenant_type, '<missing>')
        );
  end if;
end;
$migration$;

-- Policies on Wolfie child tables depend on the parent tenant column and must
-- be recreated around the type change. Drop both historical and current names
-- so restored environments converge to one policy set.
drop policy if exists "Admins can view all sessions" on public.wolfie_sessions;
drop policy if exists "Service Role can insert sessions" on public.wolfie_sessions;
drop policy if exists "Students can view their own sessions" on public.wolfie_sessions;
drop policy if exists students_insert_own_sessions on public.wolfie_sessions;
drop policy if exists students_update_own_sessions on public.wolfie_sessions;
drop policy if exists wolfie_sessions_select_scope on public.wolfie_sessions;
drop policy if exists wolfie_sessions_insert_own on public.wolfie_sessions;
drop policy if exists wolfie_sessions_update_own on public.wolfie_sessions;

drop policy if exists "Service Role can insert turns" on public.wolfie_turns;
drop policy if exists "Students can view their own turns" on public.wolfie_turns;
drop policy if exists students_insert_own_turns on public.wolfie_turns;
drop policy if exists wolfie_turns_select_scope on public.wolfie_turns;
drop policy if exists wolfie_turns_insert_own on public.wolfie_turns;

drop policy if exists "Service Role can insert corrections" on public.wolfie_corrections;
drop policy if exists "Students can view their own corrections" on public.wolfie_corrections;
drop policy if exists students_insert_own_corrections on public.wolfie_corrections;
drop policy if exists wolfie_corrections_select_scope on public.wolfie_corrections;
drop policy if exists wolfie_corrections_insert_own on public.wolfie_corrections;

drop policy if exists "Admins can view evaluations" on public.wolfie_evaluations;
drop policy if exists "Service Role can insert evaluations" on public.wolfie_evaluations;
drop policy if exists wolfie_evaluations_select_scope on public.wolfie_evaluations;

do $migration$
declare
  v_tenant_type text;
begin
  select format_type(a.atttypid, a.atttypmod)
    into v_tenant_type
    from pg_attribute as a
   where a.attrelid = 'public.wolfie_sessions'::regclass
     and a.attname = 'tenant_id'
     and not a.attisdropped;

  if v_tenant_type = 'uuid' then
    if exists (
      select 1
        from pg_attribute as a
       where a.attrelid = 'public.wolfie_sessions'::regclass
         and a.attname = 'tenant_id__text_migration'
         and not a.attisdropped
    ) then
      raise exception
        using
          errcode = '42701',
          message = 'Reserved migration column tenant_id__text_migration already exists';
    end if;

    alter table public.wolfie_sessions
      add column tenant_id__text_migration text;

    update public.wolfie_sessions as ws
       set tenant_id__text_migration = coalesce(
         (
           select t.id
             from public.tenants as t
            where t.id = ws.tenant_id::text
         ),
         p.tenant_id
       )
      from public.profiles as p
     where p.id = ws.student_id;

    if exists (
      select 1
        from public.wolfie_sessions as ws
       where ws.tenant_id__text_migration is null
    ) then
      raise exception
        using
          errcode = '23502',
          message = 'A Wolfie session has no resolvable tenant';
    end if;

    if exists (
      select 1
        from public.wolfie_sessions as ws
        left join public.tenants as t
          on t.id = ws.tenant_id__text_migration
       where t.id is null
    ) then
      raise exception
        using
          errcode = '23503',
          message = 'A Wolfie session resolves to an unknown tenant';
    end if;

    alter table public.wolfie_sessions
      alter column tenant_id type text
      using tenant_id__text_migration;

    alter table public.wolfie_sessions
      drop column tenant_id__text_migration;
  elsif v_tenant_type = 'text' then
    if exists (
      select 1
        from public.wolfie_sessions as ws
        left join public.tenants as t
          on t.id = ws.tenant_id
       where ws.tenant_id is null
          or t.id is null
    ) then
      raise exception
        using
          errcode = '23503',
          message = 'Existing text Wolfie tenant ids must reference tenants';
    end if;
  else
    raise exception
      using
        errcode = '42804',
        message = format(
          'Unsupported wolfie_sessions.tenant_id type: %s',
          coalesce(v_tenant_type, '<missing>')
        );
  end if;
end;
$migration$;

-- Normalize the relationship after the values and types are compatible.
alter table public.wolfie_sessions
  drop constraint if exists wolfie_sessions_tenant_id_fkey;

alter table public.wolfie_sessions
  add constraint wolfie_sessions_tenant_id_fkey
  foreign key (tenant_id)
  references public.tenants(id)
  not valid;

alter table public.wolfie_sessions
  validate constraint wolfie_sessions_tenant_id_fkey;

comment on column public.wolfie_sessions.tenant_id is
  'Tenant text identifier; references public.tenants(id).';

-- Recreate tenant-aware RLS without UUID/TEXT casts. Child records inherit
-- their tenant scope through the session foreign key.
alter table public.wolfie_sessions enable row level security;
alter table public.wolfie_turns enable row level security;
alter table public.wolfie_corrections enable row level security;
alter table public.wolfie_evaluations enable row level security;

create policy wolfie_sessions_select_scope
  on public.wolfie_sessions
  for select
  to authenticated
  using (
    student_id = (select auth.uid())
    or (select public._my_role()) = 'SUPER_ADMIN'
    or (
      (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR')
      and tenant_id = (select public._my_tenant_id())
    )
    or (
      (select public._my_role()) = 'TEACHER'
      and tenant_id = (select public._my_tenant_id())
      and (
        select public._teacher_can_access_student(
          wolfie_sessions.student_id,
          wolfie_sessions.tenant_id
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
    and tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) = 'STUDENT'
  );

create policy wolfie_sessions_update_own
  on public.wolfie_sessions
  for update
  to authenticated
  using (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) = 'STUDENT'
  )
  with check (
    student_id = (select auth.uid())
    and tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) = 'STUDENT'
  );

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
             and ws.tenant_id = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and ws.tenant_id = (select public._my_tenant_id())
             and (
               select public._teacher_can_access_student(
                 ws.student_id,
                 ws.tenant_id
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
         and ws.tenant_id = (select public._my_tenant_id())
         and (select public._my_role()) = 'STUDENT'
    )
  );

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
             and ws.tenant_id = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and ws.tenant_id = (select public._my_tenant_id())
             and (
               select public._teacher_can_access_student(
                 ws.student_id,
                 ws.tenant_id
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
         and ws.tenant_id = (select public._my_tenant_id())
         and (select public._my_role()) = 'STUDENT'
    )
  );

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
             and ws.tenant_id = (select public._my_tenant_id())
           )
           or (
             (select public._my_role()) = 'TEACHER'
             and ws.tenant_id = (select public._my_tenant_id())
             and (
               select public._teacher_can_access_student(
                 ws.student_id,
                 ws.tenant_id
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

grant select, insert, update on table public.wolfie_sessions
  to authenticated;
grant select, insert on table public.wolfie_turns
  to authenticated;
grant select, insert on table public.wolfie_corrections
  to authenticated;
grant select on table public.wolfie_evaluations
  to authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
