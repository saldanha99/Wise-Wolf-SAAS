-- Remove tenant-wide teacher access from the remaining legacy education tables.
drop policy if exists "Auth read attendance" on public.edu_attendance;
drop policy if exists edu_admin_only on public.edu_attendance;
drop policy if exists edu_attendance_management on public.edu_attendance;
create policy edu_attendance_management
on public.edu_attendance for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'));
drop policy if exists edu_attendance_student_read on public.edu_attendance;
create policy edu_attendance_student_read
on public.edu_attendance for select to authenticated
using (student_id = (select auth.uid()));
drop policy if exists edu_attendance_assigned_teacher on public.edu_attendance;
create policy edu_attendance_assigned_teacher
on public.edu_attendance for all to authenticated
using (
  public._my_role() = 'TEACHER'
  and private.staff_can_access_student_data(student_id)
  and exists (
    select 1 from public.edu_classes class
    where class.id = edu_attendance.class_id
      and class.teacher_id = (select auth.uid())
  )
)
with check (
  public._my_role() = 'TEACHER'
  and private.staff_can_access_student_data(student_id)
  and exists (
    select 1 from public.edu_classes class
    where class.id = edu_attendance.class_id
      and class.teacher_id = (select auth.uid())
  )
);

drop policy if exists "Auth read classes" on public.edu_classes;
drop policy if exists edu_admin_only on public.edu_classes;
drop policy if exists edu_classes_management on public.edu_classes;
create policy edu_classes_management
on public.edu_classes for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'));
drop policy if exists edu_classes_own_teacher on public.edu_classes;
create policy edu_classes_own_teacher
on public.edu_classes for all to authenticated
using (
  public._my_role() = 'TEACHER'
  and teacher_id = (select auth.uid())
)
with check (
  public._my_role() = 'TEACHER'
  and teacher_id = (select auth.uid())
);

drop policy if exists edu_admin_only on public.edu_tasks;
drop policy if exists edu_tasks_management on public.edu_tasks;
create policy edu_tasks_management
on public.edu_tasks for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'));
drop policy if exists edu_tasks_owner on public.edu_tasks;
create policy edu_tasks_owner
on public.edu_tasks for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists edu_admin_only on public.edu_message_templates;
drop policy if exists edu_message_templates_management on public.edu_message_templates;
create policy edu_message_templates_management
on public.edu_message_templates for all to authenticated
using (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'))
with check (public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'));
drop policy if exists edu_message_templates_staff_read on public.edu_message_templates;
create policy edu_message_templates_staff_read
on public.edu_message_templates for select to authenticated
using (public._my_role() in ('TEACHER', 'COMMERCIAL', 'SALESPERSON'));

notify pgrst, 'reload schema';
