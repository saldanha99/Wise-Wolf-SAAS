-- P0: close cross-tenant reads and remove dangerous client privileges.
--
-- The production database contains a few legacy tables that were created
-- outside the numbered migration chain.  Every operation below is therefore
-- guarded by catalog lookups so this migration remains replayable on a clean
-- project as well as on the current self-hosted database.

do $student_insights_tenant$
begin
  if to_regclass('public.student_insights') is null then
    return;
  end if;
  if to_regclass('public.tenants') is null
     or to_regclass('public.tenant_memberships') is null then
    raise exception 'student_insights_tenant_hardening_requires_tenant_foundation';
  end if;

  alter table public.student_insights
    add column if not exists tenant_id text;

  -- Legacy rows are a regenerable cache whose tenant of origin was never
  -- recorded. Inferring it from today's profile or membership can expose one
  -- school's pedagogy to another, so invalidate only those ambiguous rows.
  delete from public.student_insights
  where tenant_id is null;

  alter table public.student_insights
    alter column tenant_id set not null;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.student_insights'::regclass
      and conname = 'student_insights_tenant_id_fkey'
  ) then
    alter table public.student_insights
      add constraint student_insights_tenant_id_fkey
      foreign key (tenant_id)
      references public.tenants(id)
      on delete cascade
      not valid;
  end if;

  alter table public.student_insights
    validate constraint student_insights_tenant_id_fkey;

  create index if not exists student_insights_tenant_student_created_idx
    on public.student_insights (tenant_id, student_id, created_at desc);
end
$student_insights_tenant$;

create or replace function private.tenant_rls_p0_has_active_role(
  p_user_id uuid,
  p_tenant_id text,
  p_role text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_tenant_id = private.active_tenant_id((select auth.uid()))
  and exists (
    select 1
    from public.tenant_memberships as membership
    join public.profiles as profile
      on profile.id = membership.user_id
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
    where membership.user_id = p_user_id
      and membership.tenant_id = p_tenant_id
      and membership.status = 'ACTIVE'
      and membership.role = p_role
  );
$function$;
revoke all on function private.tenant_rls_p0_has_active_role(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.tenant_rls_p0_has_active_role(uuid, text, text)
  to authenticated, service_role;

create or replace function private.tenant_rls_p0_has_active_membership(
  p_tenant_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_tenant_id = private.active_tenant_id((select auth.uid()))
  and exists (
    select 1
    from public.tenant_memberships as membership
    join public.profiles as profile
      on profile.id = membership.user_id
     and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
    where membership.user_id = (select auth.uid())
      and membership.tenant_id = p_tenant_id
      and membership.status = 'ACTIVE'
  );
$function$;
revoke all on function private.tenant_rls_p0_has_active_membership(text)
  from public, anon, authenticated;
grant execute on function private.tenant_rls_p0_has_active_membership(text)
  to authenticated, service_role;

create or replace function private.tenant_rls_p0_has_active_booking(
  p_teacher_id uuid,
  p_student_id uuid,
  p_tenant_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_tenant_id = private.active_tenant_id((select auth.uid()))
  and (
    p_teacher_id = (select auth.uid())
    or private.active_tenant_role((select auth.uid())) in (
      'SCHOOL_ADMIN', 'COORDINATOR', 'DIRECTOR', 'SUPER_ADMIN'
    )
  )
  and exists (
    select 1
    from public.bookings as booking
    where booking.teacher_id = p_teacher_id
      and booking.student_id = p_student_id
      and booking.tenant_id = p_tenant_id
      and booking.status = 'SCHEDULED'
  );
$function$;
revoke all on function private.tenant_rls_p0_has_active_booking(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function private.tenant_rls_p0_has_active_booking(uuid, uuid, text)
  to authenticated, service_role;

do $migration$
declare
  target_table text;
  stale_policy record;
begin
  if to_regprocedure('public._my_tenant_id()') is null
     or to_regprocedure('public._my_role()') is null
     or to_regprocedure('public._my_tenant_is_operational()') is null
     or to_regclass('public.tenant_memberships') is null
     or to_regclass('public.bookings') is null then
    raise exception 'tenant_rls_p0_requires_active_tenant_helpers';
  end if;

  foreach target_table in array array[
    'student_evaluations',
    'student_insights',
    'pedagogical_materials',
    'automation_logs',
    'appointments',
    'teacher_availability',
    'prospects',
    'opportunities'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is null then
      continue;
    end if;

    execute format(
      'alter table public.%I enable row level security',
      target_table
    );

    -- These tables accumulated overlapping permissive policies over time.
    -- Replace the complete policy set with one reviewed, deterministic set.
    for stale_policy in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public'
        and tablename = target_table
    loop
      execute format(
        'drop policy if exists %I on public.%I',
        stale_policy.policyname,
        target_table
      );
    end loop;
  end loop;

  if to_regclass('public.student_evaluations') is not null then
    execute 'revoke all on table public.student_evaluations from public, anon, authenticated';
    execute 'grant select, insert on table public.student_evaluations to authenticated';

    execute $policy$
      create policy tenant_rls_p0_student_evaluations_select
      on public.student_evaluations
      for select
      to authenticated
      using (
        student_evaluations.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_role(
          student_evaluations.student_id,
          student_evaluations.tenant_id,
          'STUDENT'
        )
        and (
          (
            (select public._my_role()) = 'STUDENT'
            and student_evaluations.student_id = (select auth.uid())
          )
          or (
            (select public._my_role()) = 'TEACHER'
            and private.tenant_rls_p0_has_active_booking(
              (select auth.uid()),
              student_evaluations.student_id,
              student_evaluations.tenant_id
            )
          )
          or (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_student_evaluations_insert
      on public.student_evaluations
      for insert
      to authenticated
      with check (
        (select public._my_role()) = 'STUDENT'
        and student_evaluations.student_id = (select auth.uid())
        and student_evaluations.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_role(
          student_evaluations.student_id,
          student_evaluations.tenant_id,
          'STUDENT'
        )
        and (select public._my_tenant_is_operational())
        -- A client may record only its own quiz attempt. Teacher attribution is
        -- added by reviewed service-role RPCs, never trusted from the browser.
        and student_evaluations.teacher_id is null
      )
    $policy$;
  end if;

  if to_regclass('public.student_insights') is not null then
    execute 'revoke all on table public.student_insights from public, anon, authenticated';
    execute 'grant select on table public.student_insights to authenticated';

    execute $policy$
      create policy tenant_rls_p0_student_insights_select
      on public.student_insights
      for select
      to authenticated
      using (
        student_insights.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_role(
          student_insights.student_id,
          student_insights.tenant_id,
          'STUDENT'
        )
        and (
          (
            (select public._my_role()) = 'STUDENT'
            and student_insights.student_id = (select auth.uid())
          )
          or (
            (select public._my_role()) = 'TEACHER'
            and private.tenant_rls_p0_has_active_booking(
              (select auth.uid()),
              student_insights.student_id,
              student_insights.tenant_id
            )
          )
          or (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'
          )
        )
      )
    $policy$;
  end if;

  if to_regclass('public.pedagogical_materials') is not null then
    execute 'revoke all on table public.pedagogical_materials from public, anon, authenticated';
    execute 'grant select, insert, update, delete on table public.pedagogical_materials to authenticated';

    execute $policy$
      create policy tenant_rls_p0_pedagogical_materials_select
      on public.pedagogical_materials
      for select
      to authenticated
      using (
        (
          (
            pedagogical_materials.scope = 'GLOBAL'
            or pedagogical_materials.is_global is true
          )
          and pedagogical_materials.approval_status = 'APPROVED'
        )
        or (
          pedagogical_materials.tenant_id = (select public._my_tenant_id())
          and (
            pedagogical_materials.approval_status = 'APPROVED'
            or pedagogical_materials.uploaded_by = (select auth.uid())
            or (select public._my_role()) in (
              'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER',
              'SUPER_ADMIN'
            )
            or exists (
              select 1
              from public.student_assignments as assignment
              where assignment.material_id = pedagogical_materials.id
                and assignment.student_id = (select auth.uid())
            )
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_pedagogical_materials_insert
      on public.pedagogical_materials
      for insert
      to authenticated
      with check (
        pedagogical_materials.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and pedagogical_materials.uploaded_by = (select auth.uid())
        and (select public._my_role()) in (
          'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
        )
        and pedagogical_materials.scope <> 'GLOBAL'
        and coalesce(pedagogical_materials.is_global, false) is false
        and (
          (select public._my_role()) <> 'TEACHER'
          or pedagogical_materials.approval_status = 'PENDING'
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_pedagogical_materials_update
      on public.pedagogical_materials
      for update
      to authenticated
      using (
        pedagogical_materials.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
          )
          or pedagogical_materials.uploaded_by = (select auth.uid())
        )
      )
      with check (
        pedagogical_materials.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and pedagogical_materials.scope <> 'GLOBAL'
        and coalesce(pedagogical_materials.is_global, false) is false
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
          )
          or (
            pedagogical_materials.uploaded_by = (select auth.uid())
            and pedagogical_materials.approval_status = 'PENDING'
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_pedagogical_materials_delete
      on public.pedagogical_materials
      for delete
      to authenticated
      using (
        pedagogical_materials.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'MANAGER', 'SUPER_ADMIN'
          )
          or pedagogical_materials.uploaded_by = (select auth.uid())
        )
      )
    $policy$;
  end if;

  if to_regclass('public.automation_logs') is not null then
    execute 'revoke all on table public.automation_logs from public, anon, authenticated';
    execute 'grant select on table public.automation_logs to authenticated';

    execute $policy$
      create policy tenant_rls_p0_automation_logs_select
      on public.automation_logs
      for select
      to authenticated
      using (
        automation_logs.tenant_id = (select public._my_tenant_id())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'
        )
      )
    $policy$;
  end if;

  if to_regclass('public.appointments') is not null then
    execute 'revoke all on table public.appointments from public, anon, authenticated';
    execute 'grant select, insert, update, delete on table public.appointments to authenticated';

    execute $policy$
      create policy tenant_rls_p0_appointments_select
      on public.appointments
      for select
      to authenticated
      using (
        appointments.tenant_id = (select public._my_tenant_id())
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
            'SALESPERSON', 'DIRECTOR', 'SUPER_ADMIN'
          )
          or (
            (select public._my_role()) = 'TEACHER'
            and (
              appointments.teacher_id = (select auth.uid())
              or appointments.professor_id = (select auth.uid())
            )
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_appointments_insert
      on public.appointments
      for insert
      to authenticated
      with check (
        (
          appointments.professor_id is not null
          or appointments.teacher_id is not null
        )
        and (
          appointments.professor_id is null
          or private.tenant_rls_p0_has_active_role(
            appointments.professor_id,
            appointments.tenant_id,
            'TEACHER'
          )
        )
        and (
          appointments.teacher_id is null
          or private.tenant_rls_p0_has_active_role(
            appointments.teacher_id,
            appointments.tenant_id,
            'TEACHER'
          )
        )
        and (
          appointments.tenant_id = (select public._my_tenant_id())
          and (select public._my_tenant_is_operational())
          and (
            (select public._my_role()) in (
              'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
              'SALESPERSON', 'DIRECTOR', 'SUPER_ADMIN'
            )
            or (
              (select public._my_role()) = 'TEACHER'
              and (
                appointments.professor_id = (select auth.uid())
                or appointments.teacher_id = (select auth.uid())
              )
              and (
                appointments.professor_id is null
                or appointments.professor_id = (select auth.uid())
              )
              and (
                appointments.teacher_id is null
                or appointments.teacher_id = (select auth.uid())
              )
            )
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_appointments_update
      on public.appointments
      for update
      to authenticated
      using (
        appointments.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
            'SALESPERSON', 'DIRECTOR', 'SUPER_ADMIN'
          )
          or (
            (select public._my_role()) = 'TEACHER'
            and (
              appointments.teacher_id = (select auth.uid())
              or appointments.professor_id = (select auth.uid())
            )
          )
        )
      )
      with check (
        (
          appointments.professor_id is not null
          or appointments.teacher_id is not null
        )
        and (
          appointments.professor_id is null
          or private.tenant_rls_p0_has_active_role(
            appointments.professor_id,
            appointments.tenant_id,
            'TEACHER'
          )
        )
        and (
          appointments.teacher_id is null
          or private.tenant_rls_p0_has_active_role(
            appointments.teacher_id,
            appointments.tenant_id,
            'TEACHER'
          )
        )
        and (
          appointments.tenant_id = (select public._my_tenant_id())
          and (select public._my_tenant_is_operational())
          and (
            (select public._my_role()) in (
              'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
              'SALESPERSON', 'DIRECTOR', 'SUPER_ADMIN'
            )
            or (
              (select public._my_role()) = 'TEACHER'
              and (
                appointments.professor_id = (select auth.uid())
                or appointments.teacher_id = (select auth.uid())
              )
              and (
                appointments.professor_id is null
                or appointments.professor_id = (select auth.uid())
              )
              and (
                appointments.teacher_id is null
                or appointments.teacher_id = (select auth.uid())
              )
            )
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_appointments_delete
      on public.appointments
      for delete
      to authenticated
      using (
        appointments.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
            'SALESPERSON', 'DIRECTOR', 'SUPER_ADMIN'
          )
          or (
            (select public._my_role()) = 'TEACHER'
            and (
              appointments.teacher_id = (select auth.uid())
              or appointments.professor_id = (select auth.uid())
            )
          )
        )
      )
    $policy$;
  end if;

  if to_regclass('public.teacher_availability') is not null then
    execute 'revoke all on table public.teacher_availability from public, anon, authenticated';
    execute 'grant select, insert, update, delete on table public.teacher_availability to authenticated';

    execute $policy$
      create policy tenant_rls_p0_teacher_availability_select
      on public.teacher_availability
      for select
      to authenticated
      using (
        teacher_availability.tenant_id = (select public._my_tenant_id())
        and (
          teacher_availability.teacher_id = (select auth.uid())
          or (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'COMMERCIAL',
            'SALESPERSON', 'DIRECTOR', 'SUPER_ADMIN'
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_teacher_availability_insert
      on public.teacher_availability
      for insert
      to authenticated
      with check (
        private.tenant_rls_p0_has_active_role(
          teacher_availability.teacher_id,
          teacher_availability.tenant_id,
          'TEACHER'
        )
        and (
          teacher_availability.tenant_id = (select public._my_tenant_id())
          and (select public._my_tenant_is_operational())
          and (
            teacher_availability.teacher_id = (select auth.uid())
            or (select public._my_role()) in (
              'SCHOOL_ADMIN', 'COORDINATOR', 'DIRECTOR', 'SUPER_ADMIN'
            )
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_teacher_availability_update
      on public.teacher_availability
      for update
      to authenticated
      using (
        teacher_availability.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (
          teacher_availability.teacher_id = (select auth.uid())
          or (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'DIRECTOR', 'SUPER_ADMIN'
          )
        )
      )
      with check (
        private.tenant_rls_p0_has_active_role(
          teacher_availability.teacher_id,
          teacher_availability.tenant_id,
          'TEACHER'
        )
        and (
          teacher_availability.tenant_id = (select public._my_tenant_id())
          and (select public._my_tenant_is_operational())
          and (
            teacher_availability.teacher_id = (select auth.uid())
            or (select public._my_role()) in (
              'SCHOOL_ADMIN', 'COORDINATOR', 'DIRECTOR', 'SUPER_ADMIN'
            )
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_teacher_availability_delete
      on public.teacher_availability
      for delete
      to authenticated
      using (
        teacher_availability.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (
          teacher_availability.teacher_id = (select auth.uid())
          or (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR', 'DIRECTOR', 'SUPER_ADMIN'
          )
        )
      )
    $policy$;
  end if;

  if to_regclass('public.prospects') is not null then
    -- Public intake must enter through a server endpoint/capability that derives
    -- the tenant. A raw anon INSERT would let the browser poison any school.
    execute 'revoke all on table public.prospects from public, anon, authenticated';
    execute 'grant select, insert, update, delete on table public.prospects to authenticated';

    execute $policy$
      create policy tenant_rls_p0_prospects_select
      on public.prospects
      for select
      to authenticated
      using (
        prospects.tenant_id = (select public._my_tenant_id())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL', 'SALESPERSON'
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_prospects_insert
      on public.prospects
      for insert
      to authenticated
      with check (
        prospects.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL', 'SALESPERSON'
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_prospects_update
      on public.prospects
      for update
      to authenticated
      using (
        prospects.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL', 'SALESPERSON'
        )
      )
      with check (
        prospects.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL', 'SALESPERSON'
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_prospects_delete
      on public.prospects
      for delete
      to authenticated
      using (
        prospects.tenant_id = (select public._my_tenant_id())
        and (select public._my_tenant_is_operational())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COMMERCIAL', 'SALESPERSON'
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_prospects_service_role
      on public.prospects
      for all
      to service_role
      using (true)
      with check (true)
    $policy$;
  end if;

  if to_regclass('public.opportunities') is not null then
    execute 'revoke all on table public.opportunities from public, anon, authenticated';
    execute 'grant select, insert, update, delete on table public.opportunities to authenticated';

    execute $policy$
      create policy tenant_rls_p0_opportunities_select
      on public.opportunities
      for select
      to authenticated
      using (
        opportunities.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_membership(
          opportunities.tenant_id
        )
        and (select public._my_role()) in (
          'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR',
          'COMMERCIAL', 'SALESPERSON', 'SUPER_ADMIN'
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_opportunities_insert
      on public.opportunities
      for insert
      to authenticated
      with check (
        opportunities.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_membership(
          opportunities.tenant_id
        )
        and (select public._my_tenant_is_operational())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'COORDINATOR',
          'COMMERCIAL', 'SALESPERSON', 'SUPER_ADMIN'
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_opportunities_update
      on public.opportunities
      for update
      to authenticated
      using (
        opportunities.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_membership(
          opportunities.tenant_id
        )
        and (select public._my_tenant_is_operational())
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR',
            'COMMERCIAL', 'SALESPERSON', 'SUPER_ADMIN'
          )
          or (
            (select public._my_role()) = 'TEACHER'
            and opportunities.winner_teacher_id = (select auth.uid())
          )
        )
      )
      with check (
        opportunities.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_membership(
          opportunities.tenant_id
        )
        and (select public._my_tenant_is_operational())
        and (
          (select public._my_role()) in (
            'SCHOOL_ADMIN', 'COORDINATOR',
            'COMMERCIAL', 'SALESPERSON', 'SUPER_ADMIN'
          )
          or (
            (select public._my_role()) = 'TEACHER'
            and opportunities.winner_teacher_id = (select auth.uid())
          )
        )
      )
    $policy$;

    execute $policy$
      create policy tenant_rls_p0_opportunities_delete
      on public.opportunities
      for delete
      to authenticated
      using (
        opportunities.tenant_id = (select public._my_tenant_id())
        and private.tenant_rls_p0_has_active_membership(
          opportunities.tenant_id
        )
        and (select public._my_tenant_is_operational())
        and (select public._my_role()) in (
          'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'
        )
      )
    $policy$;
  end if;
end
$migration$;

-- Finance views are owner-executed legacy views.  They are consumed by
-- reviewed RPCs; direct PostgREST access would bypass the tenant filters those
-- RPCs apply, so clients no longer receive SELECT on the views themselves.
do $migration$
begin
  if to_regclass('public.v_payable_class_logs') is not null then
    execute 'revoke select on table public.v_payable_class_logs from public, anon, authenticated';
  end if;
  if to_regclass('public.v_teacher_cost_competencia') is not null then
    execute 'revoke select on table public.v_teacher_cost_competencia from public, anon, authenticated';
  end if;
end
$migration$;

-- RLS does not govern TRUNCATE. REFERENCES and TRIGGER are also schema-owner
-- capabilities, never application-client capabilities.
do $migration$
declare
  target_relation record;
begin
  for target_relation in
    select namespace.nspname, relation.relname
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
  loop
    execute format(
      'revoke truncate, references, trigger on table %I.%I from anon, authenticated',
      target_relation.nspname,
      target_relation.relname
    );
  end loop;
end
$migration$;

-- These RPCs aggregate personal or financial information across every tenant
-- and are called only from service-role Edge Functions / cron jobs.
do $migration$
declare
  service_only_signature text;
begin
  foreach service_only_signature in array array[
    'public.birthdays_today()',
    'public.trial_followups()',
    'public.teacher_agendas_today()',
    'public.weekly_digest_rows()'
  ]
  loop
    if to_regprocedure(service_only_signature) is not null then
      execute format(
        'revoke execute on function %s from public, anon, authenticated',
        service_only_signature
      );
      execute format(
        'grant execute on function %s to service_role',
        service_only_signature
      );
    end if;
  end loop;

  -- The legacy contract lookup is not an authenticated public token flow: a
  -- bare UUID exposed identity and signature metadata.  Keep only the explicit
  -- authenticated/service grants until it is replaced by a signed, expiring
  -- contract token.
  if to_regprocedure('public.get_contract_public(uuid)') is not null then
    execute 'revoke execute on function public.get_contract_public(uuid) from public, anon';
  end if;
end
$migration$;
