-- Make the active schedule the canonical source of teacher/student access.
-- Historical coverage and reschedule records must not grant access forever.
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
  with context as (
    select
      caller.id as teacher_id,
      student.id as student_id,
      ((now() at time zone 'America/Sao_Paulo')::date) as local_date
    from public.profiles as caller
    join public.profiles as student
      on student.id = p_student_id
    where caller.id = (select auth.uid())
      and caller.role = 'TEACHER'
      and caller.status = 'Ativo'
      and caller.tenant_id = p_tenant_id
      and student.role = 'STUDENT'
      and lower(coalesce(student.status, '')) in ('ativo', 'active')
      and lower(coalesce(student.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
      and student.tenant_id = p_tenant_id
  )
  select exists (
    select 1
    from context as ctx
    where
      -- Current recurring/future lesson with this teacher.
      exists (
        select 1
        from public.bookings as booking
        where booking.student_id = ctx.student_id
          and booking.teacher_id = ctx.teacher_id
          and booking.tenant_id = p_tenant_id
          and upper(coalesce(booking.status, '')) = 'SCHEDULED'
          and (booking.date is null or booking.date >= ctx.local_date - 7)
      )
      -- Compatibility fallback for students that do not have a live schedule yet.
      or (
        not exists (
          select 1
          from public.bookings as live_booking
          where live_booking.student_id = ctx.student_id
            and live_booking.tenant_id = p_tenant_id
            and upper(coalesce(live_booking.status, '')) = 'SCHEDULED'
            and (live_booking.date is null or live_booking.date >= ctx.local_date - 7)
        )
        and exists (
          select 1
          from public.profiles as assigned_student
          where assigned_student.id = ctx.student_id
            and (
              assigned_student.professor_id = ctx.teacher_id
              or assigned_student.professor_id2 = ctx.teacher_id
            )
        )
      )
      -- A confirmed coverage is operational only near its lesson date.
      or exists (
        select 1
        from public.class_coverages as coverage
        where coverage.student_id = ctx.student_id
          and coverage.cover_teacher_id = ctx.teacher_id
          and coverage.tenant_id = p_tenant_id
          and lower(coalesce(coverage.status, '')) = 'confirmed'
          and coverage.class_date >= ctx.local_date - 7
      )
      -- An unused reschedule grants access only after receiving a real date.
      or exists (
        select 1
        from public.reschedules as reschedule
        where reschedule.student_id = ctx.student_id
          and reschedule.teacher_id = ctx.teacher_id
          and reschedule.tenant_id = p_tenant_id
          and reschedule.used_at is null
          and reschedule.date ~ '^\d{4}-\d{2}-\d{2}$'
          and case
                when reschedule.date ~ '^\d{4}-\d{2}-\d{2}$'
                  then reschedule.date::date
                else null
              end >= ctx.local_date - 7
      )
  );
$function$;

comment on function public._teacher_can_access_student(uuid, text) is
  'Restricts teacher access to current schedules, recent confirmed coverages, dated unused reschedules, or unscheduled direct assignments.';

-- PostgreSQL combines permissive policies with OR. Every policy that admits a
-- teacher therefore has to apply the same student ownership boundary.
drop policy if exists "Secure: Update Student Unlocks" on public.profiles;
create policy "Secure: Update Student Unlocks"
on public.profiles
for update
to authenticated
using (
  public._my_role() = 'SUPER_ADMIN'
  or (
    tenant_id = public._my_tenant_id()
    and (
      public._my_role() in ('SCHOOL_ADMIN', 'COORDINATOR')
      or (
        public._my_role() = 'TEACHER'
        and role = 'STUDENT'
        and public._teacher_can_access_student(id, tenant_id)
      )
    )
  )
)
with check (
  public._my_role() = 'SUPER_ADMIN'
  or (
    tenant_id = public._my_tenant_id()
    and (
      public._my_role() in ('SCHOOL_ADMIN', 'COORDINATOR')
      or (
        public._my_role() = 'TEACHER'
        and role = 'STUDENT'
        and public._teacher_can_access_student(id, tenant_id)
      )
    )
  )
);

drop policy if exists "Teachers can update student modules" on public.profiles;
create policy "Teachers can update student modules"
on public.profiles
for update
to authenticated
using (
  public._my_role() = 'TEACHER'
  and role = 'STUDENT'
  and tenant_id = public._my_tenant_id()
  and public._teacher_can_access_student(id, tenant_id)
)
with check (
  public._my_role() = 'TEACHER'
  and role = 'STUDENT'
  and tenant_id = public._my_tenant_id()
  and public._teacher_can_access_student(id, tenant_id)
);

drop policy if exists profiles_update_student_scoped on public.profiles;
create policy profiles_update_student_scoped
on public.profiles
for update
to authenticated
using (
  role = 'STUDENT'
  and (
    public._my_role() = 'SUPER_ADMIN'
    or (
      tenant_id = public._my_tenant_id()
      and (
        public._my_role() in ('SCHOOL_ADMIN', 'COORDINATOR')
        or (
          public._my_role() = 'TEACHER'
          and public._teacher_can_access_student(id, tenant_id)
        )
      )
    )
  )
)
with check (
  role = 'STUDENT'
  and (
    public._my_role() = 'SUPER_ADMIN'
    or (
      tenant_id = public._my_tenant_id()
      and (
        public._my_role() in ('SCHOOL_ADMIN', 'COORDINATOR')
        or (
          public._my_role() = 'TEACHER'
          and public._teacher_can_access_student(id, tenant_id)
        )
      )
    )
  )
);

create or replace function private.sync_student_primary_teacher(
  p_student_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_teacher_count integer;
  v_teacher_id uuid;
begin
  if p_student_id is null then
    return;
  end if;

  select
    count(distinct booking.teacher_id)::integer,
    (array_agg(distinct booking.teacher_id))[1]
  into v_teacher_count, v_teacher_id
  from public.bookings as booking
  where booking.student_id = p_student_id
    and booking.teacher_id is not null
    and booking.date is null
    and upper(coalesce(booking.status, '')) = 'SCHEDULED';

  if v_teacher_count = 1 then
    update public.profiles
    set professor_id = v_teacher_id
    where id = p_student_id
      and role = 'STUDENT'
      and professor_id is distinct from v_teacher_id;
  end if;
end;
$function$;

revoke all on function private.sync_student_primary_teacher(uuid) from public;

create or replace function private.sync_student_primary_teacher_from_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    perform private.sync_student_primary_teacher(old.student_id);
    return old;
  elsif tg_op = 'INSERT' then
    perform private.sync_student_primary_teacher(new.student_id);
    return new;
  else
    if old.student_id is distinct from new.student_id then
      perform private.sync_student_primary_teacher(old.student_id);
    end if;
    perform private.sync_student_primary_teacher(new.student_id);
    return new;
  end if;
end;
$function$;

drop trigger if exists bookings_sync_student_primary_teacher on public.bookings;
create trigger bookings_sync_student_primary_teacher
after insert or delete or update of teacher_id, student_id, status, date
on public.bookings
for each row
execute function private.sync_student_primary_teacher_from_booking();

-- Repair every legacy mismatch where the active recurring schedule has exactly
-- one teacher. This includes profiles with a blank professor_id.
with canonical as (
  select
    booking.student_id,
    (array_agg(distinct booking.teacher_id))[1] as teacher_id
  from public.bookings as booking
  where booking.student_id is not null
    and booking.teacher_id is not null
    and booking.date is null
    and upper(coalesce(booking.status, '')) = 'SCHEDULED'
  group by booking.student_id
  having count(distinct booking.teacher_id) = 1
)
update public.profiles as student
set professor_id = canonical.teacher_id
from canonical
where student.id = canonical.student_id
  and student.role = 'STUDENT'
  and student.professor_id is distinct from canonical.teacher_id;

notify pgrst, 'reload schema';
