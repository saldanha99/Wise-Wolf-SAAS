-- Inactive/offboarded students and student-specific learning records must not
-- remain visible to teachers through legacy tenant-wide policies.
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
    select caller.id as teacher_id,
           student.id as student_id,
           ((now() at time zone 'America/Sao_Paulo')::date) as local_date
    from public.profiles as caller
    join public.profiles as student on student.id = p_student_id
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
    select 1 from context as ctx
    where exists (
      select 1 from public.bookings as booking
      where booking.student_id = ctx.student_id
        and booking.teacher_id = ctx.teacher_id
        and booking.tenant_id = p_tenant_id
        and upper(coalesce(booking.status, '')) = 'SCHEDULED'
        and (booking.date is null or booking.date >= ctx.local_date - 7)
    )
    or (
      not exists (
        select 1 from public.bookings as live_booking
        where live_booking.student_id = ctx.student_id
          and live_booking.tenant_id = p_tenant_id
          and upper(coalesce(live_booking.status, '')) = 'SCHEDULED'
          and (live_booking.date is null or live_booking.date >= ctx.local_date - 7)
      )
      and exists (
        select 1 from public.profiles as assigned_student
        where assigned_student.id = ctx.student_id
          and (assigned_student.professor_id = ctx.teacher_id
               or assigned_student.professor_id2 = ctx.teacher_id)
      )
    )
    or exists (
      select 1 from public.class_coverages as coverage
      where coverage.student_id = ctx.student_id
        and coverage.cover_teacher_id = ctx.teacher_id
        and coverage.tenant_id = p_tenant_id
        and lower(coalesce(coverage.status, '')) = 'confirmed'
        and coverage.class_date >= ctx.local_date - 7
    )
    or exists (
      select 1 from public.reschedules as reschedule
      where reschedule.student_id = ctx.student_id
        and reschedule.teacher_id = ctx.teacher_id
        and reschedule.tenant_id = p_tenant_id
        and reschedule.used_at is null
        and case
              when reschedule.date ~ '^\d{4}-\d{2}-\d{2}$' then reschedule.date::date
              else null
            end >= ctx.local_date - 7
    )
  );
$function$;

create or replace function private.staff_can_access_student_data(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles actor
    join public.profiles student on student.id = p_student_id
    where actor.id = (select auth.uid())
      and student.role = 'STUDENT'
      and (
        actor.role = 'SUPER_ADMIN'
        or (
          actor.tenant_id = student.tenant_id
          and (
            actor.role in ('SCHOOL_ADMIN', 'COORDINATOR')
            or (
              actor.role = 'TEACHER'
              and public._teacher_can_access_student(student.id, student.tenant_id)
            )
          )
        )
      )
  );
$function$;

revoke all on function private.staff_can_access_student_data(uuid) from public;
grant execute on function private.staff_can_access_student_data(uuid) to authenticated, service_role;

drop policy if exists "Teachers read tenant achievements" on public.student_achievements;
drop policy if exists "Teachers read assigned student achievements" on public.student_achievements;
create policy "Teachers read assigned student achievements"
on public.student_achievements for select to authenticated
using (private.staff_can_access_student_data(student_id));

drop policy if exists "Teachers read tenant goals" on public.student_daily_goals;
drop policy if exists "Teachers read assigned student goals" on public.student_daily_goals;
create policy "Teachers read assigned student goals"
on public.student_daily_goals for select to authenticated
using (private.staff_can_access_student_data(student_id));

drop policy if exists student_assignments_select_scoped on public.student_assignments;
create policy student_assignments_select_scoped
on public.student_assignments for select to authenticated
using (
  student_id = (select auth.uid())
  or private.staff_can_access_student_data(student_id)
);

drop policy if exists student_assignments_staff_insert on public.student_assignments;
create policy student_assignments_staff_insert
on public.student_assignments for insert to authenticated
with check (
  assigned_by = (select auth.uid())
  and private.staff_can_access_student_data(student_id)
);

drop policy if exists student_assignments_staff_update on public.student_assignments;
create policy student_assignments_staff_update
on public.student_assignments for update to authenticated
using (
  private.staff_can_access_student_data(student_id)
  and (public._my_role() <> 'TEACHER' or assigned_by = (select auth.uid()))
)
with check (
  private.staff_can_access_student_data(student_id)
  and (public._my_role() <> 'TEACHER' or assigned_by = (select auth.uid()))
);

drop policy if exists student_assignments_staff_delete on public.student_assignments;
create policy student_assignments_staff_delete
on public.student_assignments for delete to authenticated
using (
  private.staff_can_access_student_data(student_id)
  and (public._my_role() <> 'TEACHER' or assigned_by = (select auth.uid()))
);

drop policy if exists "Teacher read attempts" on public.student_quiz_attempts;
drop policy if exists "Teachers read assigned student attempts" on public.student_quiz_attempts;
create policy "Teachers read assigned student attempts"
on public.student_quiz_attempts for select to authenticated
using (private.staff_can_access_student_data(student_id));

drop policy if exists "Teachers read student cards" on public.student_srs_cards;
drop policy if exists "Teachers read assigned student cards" on public.student_srs_cards;
create policy "Teachers read assigned student cards"
on public.student_srs_cards for select to authenticated
using (private.staff_can_access_student_data(student_id));

drop policy if exists "Teachers read tenant streaks" on public.student_streaks;
drop policy if exists "Teachers read assigned student streaks" on public.student_streaks;
create policy "Teachers read assigned student streaks"
on public.student_streaks for select to authenticated
using (private.staff_can_access_student_data(student_id));

drop policy if exists "Teachers read tenant xp" on public.xp_events;
drop policy if exists "Teachers read assigned student xp" on public.xp_events;
create policy "Teachers read assigned student xp"
on public.xp_events for select to authenticated
using (private.staff_can_access_student_data(student_id));

drop policy if exists stn_read on public.student_teacher_notes;
create policy stn_read
on public.student_teacher_notes for select to authenticated
using (private.staff_can_access_student_data(student_id));

drop policy if exists stn_insert on public.student_teacher_notes;
create policy stn_insert
on public.student_teacher_notes for insert to authenticated
with check (
  author_id = (select auth.uid())
  and private.staff_can_access_student_data(student_id)
);

drop policy if exists stn_delete on public.student_teacher_notes;
create policy stn_delete
on public.student_teacher_notes for delete to authenticated
using (
  private.staff_can_access_student_data(student_id)
  and (public._my_role() <> 'TEACHER' or author_id = (select auth.uid()))
);

-- Legacy EDU tables previously granted every authenticated user read access,
-- including financial values, lead contact details and integration API keys.
drop policy if exists "Auth read enrollments" on public.edu_enrollments;
drop policy if exists edu_admin_only on public.edu_enrollments;
drop policy if exists edu_enrollments_management on public.edu_enrollments;
create policy edu_enrollments_management
on public.edu_enrollments for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'));
drop policy if exists edu_enrollments_student_read on public.edu_enrollments;
create policy edu_enrollments_student_read
on public.edu_enrollments for select to authenticated
using (student_id = (select auth.uid()));

drop policy if exists "Allow authenticated read access to leads" on public.edu_leads;
drop policy if exists edu_admin_only on public.edu_leads;
drop policy if exists edu_leads_authorized_staff on public.edu_leads;
create policy edu_leads_authorized_staff
on public.edu_leads for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR', 'COMMERCIAL', 'SALESPERSON'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR', 'COMMERCIAL', 'SALESPERSON'));

drop policy if exists "Auth read transactions" on public.edu_transactions;
drop policy if exists edu_admin_only on public.edu_transactions;
drop policy if exists edu_transactions_management on public.edu_transactions;
create policy edu_transactions_management
on public.edu_transactions for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'));
drop policy if exists edu_transactions_student_read on public.edu_transactions;
create policy edu_transactions_student_read
on public.edu_transactions for select to authenticated
using (student_id = (select auth.uid()));

drop policy if exists edu_admin_only on public.edu_user_integrations;
drop policy if exists edu_user_integrations_management on public.edu_user_integrations;
create policy edu_user_integrations_management
on public.edu_user_integrations for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN'));

notify pgrst, 'reload schema';
