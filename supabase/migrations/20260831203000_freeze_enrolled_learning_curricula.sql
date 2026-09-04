begin;

-- A suspended/offboarded student must lose pedagogical access immediately,
-- including through an old JWT and direct PostgREST/RPC calls. Keep the
-- canonical predicate private and parameterized so caller-facing policies and
-- target-row mutation triggers use exactly the same live lifecycle state.
create or replace function private.student_learning_access_is_active(
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.profiles as profile
     where profile.id = p_student_id
       and profile.role = 'STUDENT'
       and profile.tenant_id is not null
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             profile.lifecycle_status,
             'active'
           ))) = 'active'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             profile.status,
             'Ativo'
           ))) not in (
             'inativo', 'inactive', 'arquivado', 'cancelado', 'trancado'
           )
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             profile.offboarding_status,
             ''
           ))) not in ('REQUESTED', 'PROCESSING', 'COMPLETED')
  );
$function$;

alter function private.student_learning_access_is_active(uuid)
  owner to postgres;
revoke all on function private.student_learning_access_is_active(uuid)
  from public, anon, authenticated, service_role;

create or replace function public._my_learning_access_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.student_learning_access_is_active((select auth.uid()));
$function$;

alter function public._my_learning_access_is_active() owner to postgres;
revoke all on function public._my_learning_access_is_active()
  from public, anon, authenticated;
grant execute on function public._my_learning_access_is_active()
  to authenticated, service_role;

create or replace function private.assert_active_student_learning_access()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if not public._my_learning_access_is_active() then
    raise exception using
      errcode = '42501',
      message = 'inactive_student_learning_access_forbidden';
  end if;
end;
$function$;

alter function private.assert_active_student_learning_access()
  owner to postgres;
revoke all on function private.assert_active_student_learning_access()
  from public, anon, authenticated, service_role;

create or replace function private.assert_active_student_learning_mutation()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if not public._my_learning_access_is_active() then
    raise exception using
      errcode = '42501',
      message = 'inactive_student_learning_mutation_forbidden';
  end if;
end;
$function$;

alter function private.assert_active_student_learning_mutation()
  owner to postgres;
revoke all on function private.assert_active_student_learning_mutation()
  from public, anon, authenticated, service_role;

-- The historical row guard remains defense in depth for privileged/internal
-- writers. Its cleanup exceptions stay intact, but all positive student
-- mutations now share the same predicate, including offboarding_status.
create or replace function private.guard_active_student_learning_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student_id uuid := new.student_id;
begin
  if tg_table_name = 'student_complementary_generation_reservations'
     and tg_op = 'UPDATE'
     and coalesce(pg_catalog.to_jsonb(new) ->> 'status', '') in (
       'RELEASED',
       'EXPIRED',
       'DENIED'
     ) then
    return new;
  end if;

  if tg_table_name = 'student_path_enrollments'
     and tg_op = 'UPDATE'
     and coalesce(pg_catalog.to_jsonb(new) ->> 'status', '') <> 'ACTIVE' then
    return new;
  end if;

  if not private.student_learning_access_is_active(v_student_id) then
    raise exception using
      errcode = '42501',
      message = 'inactive_student_learning_mutation_forbidden';
  end if;

  return new;
end;
$function$;

alter function private.guard_active_student_learning_mutation()
  owner to postgres;
revoke all on function private.guard_active_student_learning_mutation()
  from public, anon, authenticated, service_role;

-- Keep the mature implementations private and fence every student-facing read
-- before it can refresh hearts or reveal curriculum/complementary content.
do $rename_student_learning_read_cores$
begin
  if pg_catalog.to_regprocedure(
       'public.get_student_learning_path_runtime_core(uuid)'
     ) is null then
    alter function public.get_student_learning_path_runtime(uuid)
      rename to get_student_learning_path_runtime_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.get_student_complementary_activities_core(integer)'
     ) is null then
    alter function public.get_student_complementary_activities(integer)
      rename to get_student_complementary_activities_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.get_student_complementary_generation_status_core()'
     ) is null then
    alter function public.get_student_complementary_generation_status()
      rename to get_student_complementary_generation_status_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.get_student_practice_status_core()'
     ) is null then
    alter function public.get_student_practice_status()
      rename to get_student_practice_status_core;
  end if;
end;
$rename_student_learning_read_cores$;

alter function public.get_student_learning_path_runtime_core(uuid)
  owner to postgres;
alter function public.get_student_complementary_activities_core(integer)
  owner to postgres;
alter function public.get_student_complementary_generation_status_core()
  owner to postgres;
alter function public.get_student_practice_status_core()
  owner to postgres;

revoke all on function public.get_student_learning_path_runtime_core(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_student_complementary_activities_core(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.get_student_complementary_generation_status_core()
  from public, anon, authenticated, service_role;
revoke all on function public.get_student_practice_status_core()
  from public, anon, authenticated, service_role;

create or replace function public.get_student_learning_path_runtime(
  p_path_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_access();
  return public.get_student_learning_path_runtime_core(p_path_id);
end;
$function$;

create or replace function public.get_student_complementary_activities(
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_access();
  return public.get_student_complementary_activities_core(p_limit);
end;
$function$;

create or replace function public.get_student_complementary_generation_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_access();
  return public.get_student_complementary_generation_status_core();
end;
$function$;

create or replace function public.get_student_practice_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_access();
  return public.get_student_practice_status_core();
end;
$function$;

alter function public.get_student_learning_path_runtime(uuid)
  owner to postgres;
alter function public.get_student_complementary_activities(integer)
  owner to postgres;
alter function public.get_student_complementary_generation_status()
  owner to postgres;
alter function public.get_student_practice_status()
  owner to postgres;

revoke all on function public.get_student_learning_path_runtime(uuid)
  from public, anon, authenticated;
revoke all on function public.get_student_complementary_activities(integer)
  from public, anon, authenticated;
revoke all on function public.get_student_complementary_generation_status()
  from public, anon, authenticated;
revoke all on function public.get_student_practice_status()
  from public, anon, authenticated;

grant execute on function public.get_student_learning_path_runtime(uuid)
  to authenticated, service_role;
grant execute on function public.get_student_complementary_activities(integer)
  to authenticated, service_role;
grant execute on function public.get_student_complementary_generation_status()
  to authenticated, service_role;
grant execute on function public.get_student_practice_status()
  to authenticated, service_role;

-- Replays are reads from durable ledgers and therefore need the same live
-- lifecycle decision as first-time writes. Keep every mature/idempotent body
-- private, and make the public boundary assert before any validation, lookup or
-- early return can reveal state to an old student JWT.
do $rename_student_learning_lifecycle_cores$
begin
  if pg_catalog.to_regprocedure(
       'public.schedule_student_vocab_review_core(uuid,text,text,text)'
     ) is null then
    alter function public.schedule_student_vocab_review(uuid, text, text, text)
      rename to schedule_student_vocab_review_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.submit_student_vocab_review_core(uuid,boolean,text)'
     ) is null then
    alter function public.submit_student_vocab_review(uuid, boolean, text)
      rename to submit_student_vocab_review_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.begin_student_complementary_generation_core(uuid)'
     ) is null then
    alter function public.begin_student_complementary_generation(uuid)
      rename to begin_student_complementary_generation_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.release_student_complementary_generation_core(uuid,uuid,uuid,text)'
     ) is null then
    alter function public.release_student_complementary_generation(
      uuid,
      uuid,
      uuid,
      text
    ) rename to release_student_complementary_generation_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.complete_student_complementary_activity_lifecycle_core(uuid,jsonb,text)'
     ) is null then
    alter function public.complete_student_complementary_activity(
      uuid,
      jsonb,
      text
    ) rename to complete_student_complementary_activity_lifecycle_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.get_student_opt_in_leaderboard_core(integer)'
     ) is null then
    alter function public.get_student_opt_in_leaderboard(integer)
      rename to get_student_opt_in_leaderboard_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.consume_student_heart_core(text,text)'
     ) is null then
    alter function public.consume_student_heart(text, text)
      rename to consume_student_heart_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.grade_quiz_lifecycle_core(uuid,integer[],text)'
     ) is null then
    alter function public.grade_quiz(uuid, integer[], text)
      rename to grade_quiz_lifecycle_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.complete_learning_activity_core(uuid,integer,integer,jsonb,text)'
     ) is null then
    alter function public.complete_learning_activity(
      uuid,
      integer,
      integer,
      jsonb,
      text
    ) rename to complete_learning_activity_core;
  end if;

  if pg_catalog.to_regprocedure(
       'public.award_verified_student_xp_core(text,text)'
     ) is null then
    alter function public.award_verified_student_xp(text, text)
      rename to award_verified_student_xp_core;
  end if;
end;
$rename_student_learning_lifecycle_cores$;

alter function public.schedule_student_vocab_review_core(
  uuid,
  text,
  text,
  text
) owner to postgres;
alter function public.submit_student_vocab_review_core(uuid, boolean, text)
  owner to postgres;
alter function public.begin_student_complementary_generation_core(uuid)
  owner to postgres;
alter function public.release_student_complementary_generation_core(
  uuid,
  uuid,
  uuid,
  text
) owner to postgres;
alter function public.complete_student_complementary_activity_lifecycle_core(
  uuid,
  jsonb,
  text
) owner to postgres;
alter function public.get_student_opt_in_leaderboard_core(integer)
  owner to postgres;
alter function public.consume_student_heart_core(text, text)
  owner to postgres;
alter function public.grade_quiz_lifecycle_core(uuid, integer[], text)
  owner to postgres;
alter function public.complete_learning_activity_core(
  uuid,
  integer,
  integer,
  jsonb,
  text
) owner to postgres;
alter function public.award_verified_student_xp_core(text, text)
  owner to postgres;

revoke all on function public.schedule_student_vocab_review_core(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.submit_student_vocab_review_core(
  uuid,
  boolean,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.begin_student_complementary_generation_core(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.release_student_complementary_generation_core(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.complete_student_complementary_activity_lifecycle_core(
  uuid,
  jsonb,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.get_student_opt_in_leaderboard_core(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.consume_student_heart_core(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.grade_quiz_lifecycle_core(
  uuid,
  integer[],
  text
) from public, anon, authenticated, service_role;
revoke all on function public.complete_learning_activity_core(
  uuid,
  integer,
  integer,
  jsonb,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.award_verified_student_xp_core(text, text)
  from public, anon, authenticated, service_role;

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
begin
  perform private.assert_active_student_learning_mutation();
  return public.schedule_student_vocab_review_core(
    p_activity_id,
    p_term,
    p_translation,
    p_example
  );
end;
$function$;

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
begin
  perform private.assert_active_student_learning_mutation();
  return public.submit_student_vocab_review_core(
    p_review_id,
    p_correct,
    p_request_key
  );
end;
$function$;

create or replace function public.begin_student_complementary_generation(
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_mutation();
  return public.begin_student_complementary_generation_core(p_request_key);
end;
$function$;

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
begin
  perform private.assert_active_student_learning_mutation();
  return public.release_student_complementary_generation_core(
    p_reservation_id,
    p_lease_token,
    p_request_key,
    p_reason
  );
end;
$function$;

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
begin
  perform private.assert_active_student_learning_mutation();
  return public.complete_student_complementary_activity_lifecycle_core(
    p_activity_id,
    p_evidence,
    p_request_key
  );
end;
$function$;

create or replace function public.get_student_opt_in_leaderboard(
  p_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_access();
  return public.get_student_opt_in_leaderboard_core(p_limit);
end;
$function$;

create or replace function public.consume_student_heart(
  p_request_key text,
  p_reason text default 'WRONG_ANSWER'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_mutation();
  return public.consume_student_heart_core(p_request_key, p_reason);
end;
$function$;

create or replace function public.grade_quiz(
  p_activity_id uuid,
  p_answers integer[],
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_mutation();
  return public.grade_quiz_lifecycle_core(
    p_activity_id,
    p_answers,
    p_request_key
  );
end;
$function$;

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
begin
  perform private.assert_active_student_learning_mutation();
  return public.complete_learning_activity_core(
    p_activity_id,
    p_score,
    p_time_spent_seconds,
    p_evidence,
    p_request_key
  );
end;
$function$;

create or replace function public.award_verified_student_xp(
  p_source_type text,
  p_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.assert_active_student_learning_mutation();
  return public.award_verified_student_xp_core(
    p_source_type,
    p_source_id
  );
end;
$function$;

alter function public.schedule_student_vocab_review(uuid, text, text, text)
  owner to postgres;
alter function public.submit_student_vocab_review(uuid, boolean, text)
  owner to postgres;
alter function public.begin_student_complementary_generation(uuid)
  owner to postgres;
alter function public.release_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  text
) owner to postgres;
alter function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) owner to postgres;
alter function public.get_student_opt_in_leaderboard(integer)
  owner to postgres;
alter function public.consume_student_heart(text, text) owner to postgres;
alter function public.grade_quiz(uuid, integer[], text) owner to postgres;
alter function public.complete_learning_activity(
  uuid,
  integer,
  integer,
  jsonb,
  text
) owner to postgres;
alter function public.award_verified_student_xp(text, text) owner to postgres;

revoke all on function public.schedule_student_vocab_review(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.submit_student_vocab_review(uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function public.begin_student_complementary_generation(uuid)
  from public, anon, authenticated;
revoke all on function public.release_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
revoke all on function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) from public, anon, authenticated;
revoke all on function public.get_student_opt_in_leaderboard(integer)
  from public, anon, authenticated;
revoke all on function public.consume_student_heart(text, text)
  from public, anon, authenticated;
revoke all on function public.grade_quiz(uuid, integer[], text)
  from public, anon, authenticated;
revoke all on function public.complete_learning_activity(
  uuid,
  integer,
  integer,
  jsonb,
  text
) from public, anon, authenticated;
revoke all on function public.award_verified_student_xp(text, text)
  from public, anon, authenticated;

grant execute on function public.schedule_student_vocab_review(
  uuid,
  text,
  text,
  text
) to authenticated, service_role;
grant execute on function public.submit_student_vocab_review(
  uuid,
  boolean,
  text
) to authenticated, service_role;
grant execute on function public.begin_student_complementary_generation(uuid)
  to authenticated, service_role;
grant execute on function public.release_student_complementary_generation(
  uuid,
  uuid,
  uuid,
  text
) to authenticated, service_role;
grant execute on function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) to authenticated, service_role;
grant execute on function public.get_student_opt_in_leaderboard(integer)
  to authenticated, service_role;
grant execute on function public.consume_student_heart(text, text)
  to authenticated, service_role;
grant execute on function public.grade_quiz(uuid, integer[], text)
  to authenticated, service_role;
grant execute on function public.complete_learning_activity(
  uuid,
  integer,
  integer,
  jsonb,
  text
) to authenticated, service_role;
grant execute on function public.award_verified_student_xp(text, text)
  to authenticated, service_role;

-- Tighten direct read policies as well. Staff keeps its existing tenant scope;
-- a student can see their own history only while their learning access is
-- active. This prevents bypassing the UI through the REST endpoint.
drop policy if exists learning_paths_read_scoped on public.learning_paths;
create policy learning_paths_read_scoped
on public.learning_paths
for select
to authenticated
using (
  (select public._my_role()) = 'SUPER_ADMIN'
  or (
    (select public._my_role()) = 'SCHOOL_ADMIN'
    and (tenant_id is null or tenant_id = (select public._my_tenant_id()))
  )
  or (
    active is true
    and (tenant_id is null or tenant_id = (select public._my_tenant_id()))
    and (
      (select public._my_role()) in ('TEACHER', 'COORDINATOR')
      or (
        (select public._my_role()) = 'STUDENT'
        and (select public._my_learning_access_is_active())
      )
    )
  )
  or (
    (select public._my_role()) = 'STUDENT'
    and (select public._my_learning_access_is_active())
    and exists (
      select 1
        from public.student_path_enrollments as enrollment
       where enrollment.path_id = learning_paths.id
         and enrollment.student_id = (select auth.uid())
         and enrollment.status = 'COMPLETED'
         and enrollment.completed_at is not null
    )
  )
);

drop policy if exists student_path_enrollments_read_scoped
  on public.student_path_enrollments;
create policy student_path_enrollments_read_scoped
on public.student_path_enrollments
for select
to authenticated
using (
  (
    student_id = (select auth.uid())
    and (select public._my_learning_access_is_active())
  )
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and public._teacher_can_access_student(student_id, tenant_id)
      )
    )
  )
);

drop policy if exists student_activity_progress_read_scoped
  on public.student_activity_progress;
create policy student_activity_progress_read_scoped
on public.student_activity_progress
for select
to authenticated
using (
  (
    student_id = (select auth.uid())
    and (select public._my_learning_access_is_active())
  )
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
           and public._teacher_can_access_student(
             student_id,
             student.tenant_id
           )
         )
       )
  )
);

drop policy if exists student_skill_scores_read_scoped
  on public.student_skill_scores;
create policy student_skill_scores_read_scoped
on public.student_skill_scores
for select
to authenticated
using (
  (
    student_id = (select auth.uid())
    and (select public._my_learning_access_is_active())
  )
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
           and public._teacher_can_access_student(
             student_id,
             student.tenant_id
           )
         )
       )
  )
);

drop policy if exists student_path_enrollment_history_read_scoped
  on public.student_path_enrollment_history;
create policy student_path_enrollment_history_read_scoped
on public.student_path_enrollment_history
for select
to authenticated
using (
  (
    student_id = (select auth.uid())
    and (select public._my_learning_access_is_active())
  )
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and public._teacher_can_access_student(student_id, tenant_id)
      )
    )
  )
);

drop policy if exists student_learning_activity_attempts_read_scoped
  on public.student_learning_activity_attempts;
create policy student_learning_activity_attempts_read_scoped
on public.student_learning_activity_attempts
for select
to authenticated
using (
  (
    student_id = (select auth.uid())
    and (select public._my_learning_access_is_active())
  )
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and public._teacher_can_access_student(student_id, tenant_id)
      )
    )
  )
);

drop policy if exists student_complementary_activity_attempts_read_scoped
  on public.student_complementary_activity_attempts;
create policy student_complementary_activity_attempts_read_scoped
on public.student_complementary_activity_attempts
for select
to authenticated
using (
  (
    student_id = (select auth.uid())
    and (select public._my_learning_access_is_active())
  )
  or (select public._my_role()) = 'SUPER_ADMIN'
  or (
    tenant_id = (select public._my_tenant_id())
    and (
      (select public._my_role()) = 'SCHOOL_ADMIN'
      or (
        (select public._my_role()) = 'TEACHER'
        and public._teacher_can_access_student(student_id, tenant_id)
      )
    )
  )
);

drop policy if exists student_vocab_reviews_read_own
  on public.student_vocab_reviews;
create policy student_vocab_reviews_read_own
on public.student_vocab_reviews
for select
to authenticated
using (
  student_id = (select auth.uid())
  and (select public._my_learning_access_is_active())
);

drop policy if exists student_vocab_review_attempts_read_own
  on public.student_vocab_review_attempts;
create policy student_vocab_review_attempts_read_own
on public.student_vocab_review_attempts
for select
to authenticated
using (
  student_id = (select auth.uid())
  and (select public._my_learning_access_is_active())
);

-- Once a path has ever been assigned, its exact curriculum becomes part of
-- the student's academic record. Freeze metadata, units and activities so an
-- edit cannot rewrite completed work or invalidate progress underneath a
-- current student. The path row lock also serializes editing with enrollment.
create table if not exists private.learning_path_archive_capabilities (
  nonce uuid primary key,
  path_id uuid not null,
  actor_id uuid not null,
  backend_pid integer not null,
  transaction_id bigint not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

alter table private.learning_path_archive_capabilities owner to postgres;
revoke all on table private.learning_path_archive_capabilities
  from public, anon, authenticated, service_role;

create or replace function private.guard_enrolled_learning_curriculum()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_new jsonb := case when tg_op = 'DELETE' then null else pg_catalog.to_jsonb(new) end;
  v_old jsonb := case when tg_op = 'INSERT' then null else pg_catalog.to_jsonb(old) end;
  v_path_id uuid;
  v_unit_id uuid;
  v_archive_path text := nullif(
    pg_catalog.current_setting('app.learning_path_archive_id', true),
    ''
  );
  v_archive_nonce text := nullif(
    pg_catalog.current_setting('app.learning_path_archive_nonce', true),
    ''
  );
begin
  if tg_table_name = 'learning_paths' then
    v_path_id := coalesce(
      nullif(v_new ->> 'id', '')::uuid,
      nullif(v_old ->> 'id', '')::uuid
    );
  elsif tg_table_name = 'learning_units' then
    if tg_op = 'UPDATE'
       and v_new ->> 'path_id' is distinct from v_old ->> 'path_id' then
      raise exception using
        errcode = '55000',
        message = 'learning_unit_cannot_change_path';
    end if;
    v_path_id := coalesce(
      nullif(v_new ->> 'path_id', '')::uuid,
      nullif(v_old ->> 'path_id', '')::uuid
    );
  elsif tg_table_name = 'unit_activities' then
    if tg_op = 'UPDATE'
       and v_new ->> 'unit_id' is distinct from v_old ->> 'unit_id' then
      raise exception using
        errcode = '55000',
        message = 'learning_activity_cannot_change_unit';
    end if;
    v_unit_id := coalesce(
      nullif(v_new ->> 'unit_id', '')::uuid,
      nullif(v_old ->> 'unit_id', '')::uuid
    );
    select unit.path_id
      into v_path_id
      from public.learning_units as unit
     where unit.id = v_unit_id;

    -- A parent learning_unit DELETE fires its FK cascade after that parent is
    -- no longer visible. The parent's own BEFORE DELETE guard has already
    -- locked and validated the path, so the child cascade is safe to finish.
    -- A direct activity DELETE still resolves its existing parent normally.
    if v_path_id is null and tg_op = 'DELETE' then
      return old;
    end if;
  else
    raise exception using
      errcode = '55000',
      message = 'unsupported_learning_curriculum_table';
  end if;

  if v_path_id is null then
    raise exception using
      errcode = '23503',
      message = 'learning_curriculum_path_required';
  end if;

  perform 1
    from public.learning_paths as path
   where path.id = v_path_id
   for update;
  if not found then
    -- A parent learning_path DELETE validates and locks itself in its own
    -- BEFORE trigger. Its subsequent unit/activity FK cascades run after the
    -- parent is no longer visible, so only those child DELETEs may finish.
    if tg_op = 'DELETE'
       and tg_table_name in ('learning_units', 'unit_activities') then
      return old;
    end if;

    raise exception using
      errcode = '23503',
      message = 'learning_curriculum_path_not_found';
  end if;

  if exists (
    select 1
      from public.student_path_enrollments as enrollment
     where enrollment.path_id = v_path_id
  ) then
    if tg_table_name = 'learning_paths' and tg_op = 'UPDATE' then
      if v_archive_path = v_path_id::text
         and new.active is false
         and old.active is true
         and (v_new - 'active') = (v_old - 'active')
         and exists (
           select 1
             from private.learning_path_archive_capabilities as capability
            where capability.nonce::text = v_archive_nonce
              and capability.path_id = v_path_id
              and capability.actor_id = auth.uid()
              and capability.backend_pid = pg_catalog.pg_backend_pid()
              and capability.transaction_id = pg_catalog.txid_current()
         ) then
        return new;
      end if;
    end if;

    raise exception using
      errcode = '55000',
      message = 'learning_path_curriculum_frozen_after_enrollment';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

alter function private.guard_enrolled_learning_curriculum()
  owner to postgres;
revoke all on function private.guard_enrolled_learning_curriculum()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_enrolled_learning_curriculum
  on public.learning_paths;
create trigger guard_enrolled_learning_curriculum
before update or delete
on public.learning_paths
for each row execute function private.guard_enrolled_learning_curriculum();

drop trigger if exists guard_enrolled_learning_curriculum
  on public.learning_units;
create trigger guard_enrolled_learning_curriculum
before insert or update or delete
on public.learning_units
for each row execute function private.guard_enrolled_learning_curriculum();

drop trigger if exists guard_enrolled_learning_curriculum
  on public.unit_activities;
create trigger guard_enrolled_learning_curriculum
before insert or update or delete
on public.unit_activities
for each row execute function private.guard_enrolled_learning_curriculum();

-- Serialize enrollment with curriculum mutation and archival. If enrollment
-- wins, archival sees the new ACTIVE row; if archival wins, enrollment sees an
-- inactive path. There is no split-brain outcome.
do $rename_learning_enrollment_core$
begin
  if pg_catalog.to_regprocedure(
       'public.enroll_student_learning_path_core(uuid,boolean,text,uuid)'
     ) is null then
    alter function public.enroll_student_learning_path(
      uuid,
      boolean,
      text,
      uuid
    ) rename to enroll_student_learning_path_core;
  end if;
end;
$rename_learning_enrollment_core$;

alter function public.enroll_student_learning_path_core(
  uuid,
  boolean,
  text,
  uuid
) owner to postgres;
revoke all on function public.enroll_student_learning_path_core(
  uuid,
  boolean,
  text,
  uuid
) from public, anon, authenticated, service_role;

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
  v_path_active boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if exists (
    select 1
      from public.profiles as actor
     where actor.id = auth.uid()
       and actor.role = 'STUDENT'
  ) then
    perform private.assert_active_student_learning_mutation();
  end if;

  if p_path_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select path.active
    into v_path_active
    from public.learning_paths as path
   where path.id = p_path_id
   for update;
  if not found or v_path_active is not true then
    raise exception using errcode = '42501', message = 'learning_path_not_available';
  end if;

  return public.enroll_student_learning_path_core(
    p_path_id,
    p_switch_current,
    p_reason,
    p_student_id
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

-- Trusted automation uses the audited SECURITY DEFINER enrollment RPC too;
-- service_role must not bypass lifecycle and serialization with direct DML.
revoke insert, update, delete, truncate
  on table public.student_path_enrollments
  from service_role;

-- Recreate archival with an explicit, transaction-local capability consumed by
-- the freeze trigger. Normal browser UPDATEs cannot imitate this path.
create or replace function public.archive_learning_path(
  p_path_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_tenant_id text;
  v_path public.learning_paths%rowtype;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_archive_nonce uuid := pg_catalog.gen_random_uuid();
  v_previous_archive_path text := pg_catalog.current_setting(
    'app.learning_path_archive_id',
    true
  );
  v_previous_archive_nonce text := pg_catalog.current_setting(
    'app.learning_path_archive_nonce',
    true
  );
begin
  if v_actor_id is null or p_path_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) not between 5 and 500 then
    raise exception using
      errcode = '22023',
      message = 'learning_path_archive_reason_required';
  end if;

  v_actor_role := private.active_tenant_role(v_actor_id);
  v_actor_tenant_id := private.active_tenant_id(v_actor_id);
  if v_actor_role is null
     or v_actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using
      errcode = '42501',
      message = 'learning_path_archive_not_authorized';
  end if;

  select *
    into v_path
    from public.learning_paths as path
   where path.id = p_path_id
   for update;
  if not found
     or (
       v_actor_role <> 'SUPER_ADMIN'
       and (
         v_path.tenant_id is null
         or v_actor_tenant_id is distinct from v_path.tenant_id
       )
     ) then
    raise exception using
      errcode = '42501',
      message = 'learning_path_archive_not_authorized';
  end if;

  if v_path.active is false then
    return pg_catalog.jsonb_build_object(
      'pathId', p_path_id,
      'active', false,
      'alreadyApplied', true
    );
  end if;

  if exists (
    select 1
      from public.student_path_enrollments as enrollment
     where enrollment.path_id = p_path_id
       and enrollment.status = 'ACTIVE'
       and enrollment.completed_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'learning_path_has_active_students';
  end if;

  begin
    insert into private.learning_path_archive_capabilities (
      nonce,
      path_id,
      actor_id,
      backend_pid,
      transaction_id
    ) values (
      v_archive_nonce,
      p_path_id,
      v_actor_id,
      pg_catalog.pg_backend_pid(),
      pg_catalog.txid_current()
    );

    perform pg_catalog.set_config(
      'app.learning_path_archive_id',
      p_path_id::text,
      true
    );
    perform pg_catalog.set_config(
      'app.learning_path_archive_nonce',
      v_archive_nonce::text,
      true
    );

    update public.learning_paths
       set active = false
     where id = p_path_id;

    insert into public.learning_path_archive_audit (
      tenant_id,
      path_id,
      actor_id,
      reason
    ) values (
      v_path.tenant_id,
      p_path_id,
      v_actor_id,
      v_reason
    );

    delete from private.learning_path_archive_capabilities as capability
     where capability.nonce = v_archive_nonce;

    perform pg_catalog.set_config(
      'app.learning_path_archive_id',
      coalesce(v_previous_archive_path, ''),
      true
    );
    perform pg_catalog.set_config(
      'app.learning_path_archive_nonce',
      coalesce(v_previous_archive_nonce, ''),
      true
    );
  exception
    when others then
      delete from private.learning_path_archive_capabilities as capability
       where capability.nonce = v_archive_nonce;
      perform pg_catalog.set_config(
        'app.learning_path_archive_id',
        coalesce(v_previous_archive_path, ''),
        true
      );
      perform pg_catalog.set_config(
        'app.learning_path_archive_nonce',
        coalesce(v_previous_archive_nonce, ''),
        true
      );
      raise;
  end;

  return pg_catalog.jsonb_build_object(
    'pathId', p_path_id,
    'active', false,
    'alreadyApplied', false
  );
end;
$function$;

alter function public.archive_learning_path(uuid, text) owner to postgres;
revoke all on function public.archive_learning_path(uuid, text)
  from public, anon, authenticated;
grant execute on function public.archive_learning_path(uuid, text)
  to authenticated, service_role;

-- Child curriculum mutations must enter through path-first RPCs. Reading a
-- child id to discover its parent takes no row lock; the parent path is then
-- locked and the child row is only mutated after authorization and freeze
-- validation. This removes the child-row -> parent-row lock inversion from the
-- browser and service-role write surfaces while preserving FK parent cascades.
create or replace function private.lock_mutable_learning_path(
  p_path_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_actor_tenant_id text;
  v_is_service_role boolean := coalesce(auth.role(), '') = 'service_role';
  v_path_tenant_id text;
begin
  if not v_is_service_role then
    if v_actor_id is null then
      raise exception using
        errcode = '42501',
        message = 'authentication_required';
    end if;

    v_actor_role := private.learning_actor_role();
    v_actor_tenant_id := private.learning_actor_tenant_id();
    if v_actor_role is null
       or v_actor_role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
      raise exception using
        errcode = '42501',
        message = 'learning_curriculum_mutation_not_authorized';
    end if;
  end if;

  select path.tenant_id
    into v_path_tenant_id
    from public.learning_paths as path
   where path.id = p_path_id
   for update;

  if not found
     or (
       not v_is_service_role
       and v_actor_role <> 'SUPER_ADMIN'
       and (
         v_path_tenant_id is null
         or v_actor_tenant_id is distinct from v_path_tenant_id
       )
     ) then
    raise exception using
      errcode = '42501',
      message = 'learning_curriculum_mutation_not_authorized';
  end if;

  if exists (
    select 1
      from public.student_path_enrollments as enrollment
     where enrollment.path_id = p_path_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'learning_path_curriculum_frozen_after_enrollment';
  end if;
end;
$function$;

alter function private.lock_mutable_learning_path(uuid) owner to postgres;
revoke all on function private.lock_mutable_learning_path(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.delete_learning_unit(
  p_unit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_path_id uuid;
  v_deleted_id uuid;
begin
  if p_unit_id is null then
    raise exception using
      errcode = '22023',
      message = 'learning_unit_id_required';
  end if;

  select unit.path_id
    into v_path_id
    from public.learning_units as unit
   where unit.id = p_unit_id;

  perform private.lock_mutable_learning_path(v_path_id);

  delete from public.learning_units as unit
   where unit.id = p_unit_id
     and unit.path_id = v_path_id
  returning unit.id into v_deleted_id;

  if v_deleted_id is null then
    raise exception using
      errcode = '55000',
      message = 'learning_unit_changed_during_mutation';
  end if;

  return pg_catalog.jsonb_build_object(
    'unitId', v_deleted_id,
    'pathId', v_path_id,
    'deleted', true
  );
end;
$function$;

alter function public.delete_learning_unit(uuid) owner to postgres;
revoke all on function public.delete_learning_unit(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_learning_unit(uuid)
  to authenticated, service_role;

create or replace function public.reorder_learning_units(
  p_path_id uuid,
  p_unit_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing_count integer;
  v_requested_count integer;
  v_unique_count integer;
  v_null_count integer;
  v_matched_count integer;
  v_min_order integer;
  v_max_order integer;
  v_temp_start bigint;
begin
  if p_path_id is null or p_unit_ids is null then
    raise exception using
      errcode = '22023',
      message = 'learning_unit_order_invalid';
  end if;

  perform private.lock_mutable_learning_path(p_path_id);

  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(unit.order_index),
    pg_catalog.max(unit.order_index)
    into v_existing_count, v_min_order, v_max_order
    from public.learning_units as unit
   where unit.path_id = p_path_id;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(distinct requested.id)::integer,
    pg_catalog.count(*) filter (where requested.id is null)::integer,
    pg_catalog.count(unit.id)::integer
    into
      v_requested_count,
      v_unique_count,
      v_null_count,
      v_matched_count
    from pg_catalog.unnest(p_unit_ids) as requested(id)
    left join public.learning_units as unit
      on unit.id = requested.id
     and unit.path_id = p_path_id;

  if v_requested_count <> v_existing_count
     or v_unique_count <> v_requested_count
     or v_null_count <> 0
     or v_matched_count <> v_requested_count then
    raise exception using
      errcode = '22023',
      message = 'learning_unit_order_invalid';
  end if;

  if v_existing_count > 0 then
    if greatest(v_max_order::bigint, v_existing_count::bigint)
         + v_existing_count::bigint <= 2147483647::bigint then
      v_temp_start := greatest(
        v_max_order::bigint,
        v_existing_count::bigint
      ) + 1;
    elsif least(v_min_order::bigint, 1::bigint)
            - v_existing_count::bigint >= -2147483648::bigint then
      v_temp_start := least(v_min_order::bigint, 1::bigint)
        - v_existing_count::bigint;
    else
      raise exception using
        errcode = '22003',
        message = 'learning_unit_order_range_exhausted';
    end if;

    with requested as (
      select item.id, item.ordinality
        from pg_catalog.unnest(p_unit_ids)
          with ordinality as item(id, ordinality)
    )
    update public.learning_units as unit
       set order_index = (
         v_temp_start + requested.ordinality::bigint - 1
       )::integer
      from requested
     where unit.id = requested.id
       and unit.path_id = p_path_id;

    with requested as (
      select item.id, item.ordinality
        from pg_catalog.unnest(p_unit_ids)
          with ordinality as item(id, ordinality)
    )
    update public.learning_units as unit
       set order_index = requested.ordinality::integer
      from requested
     where unit.id = requested.id
       and unit.path_id = p_path_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'pathId', p_path_id,
    'unitIds', pg_catalog.to_jsonb(p_unit_ids),
    'reordered', true
  );
end;
$function$;

alter function public.reorder_learning_units(uuid, uuid[]) owner to postgres;
revoke all on function public.reorder_learning_units(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.reorder_learning_units(uuid, uuid[])
  to authenticated, service_role;

create or replace function public.update_unit_activity(
  p_activity_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_path_id uuid;
  v_unit_id uuid;
  v_activity public.unit_activities%rowtype;
  v_xp_reward numeric;
  v_estimated_minutes numeric;
begin
  if p_activity_id is null then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_id_required';
  end if;
  if p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or p_payload = '{}'::jsonb
     or exists (
       select 1
         from pg_catalog.jsonb_object_keys(p_payload) as supplied(key)
        where supplied.key not in (
          'title',
          'description',
          'content',
          'xp_reward',
          'estimated_minutes'
        )
     ) then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_payload_invalid';
  end if;

  if p_payload ? 'title'
     and (
       pg_catalog.jsonb_typeof(p_payload -> 'title') <> 'string'
       or nullif(pg_catalog.btrim(p_payload ->> 'title'), '') is null
     ) then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_payload_invalid';
  end if;
  if p_payload ? 'description'
     and pg_catalog.jsonb_typeof(p_payload -> 'description')
       not in ('string', 'null') then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_payload_invalid';
  end if;
  if p_payload ? 'content'
     and pg_catalog.jsonb_typeof(p_payload -> 'content') <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_payload_invalid';
  end if;

  if p_payload ? 'xp_reward' then
    if pg_catalog.jsonb_typeof(p_payload -> 'xp_reward') <> 'number' then
      raise exception using
        errcode = '22023',
        message = 'unit_activity_payload_invalid';
    end if;
    v_xp_reward := (p_payload ->> 'xp_reward')::numeric;
    if v_xp_reward <> pg_catalog.trunc(v_xp_reward)
       or v_xp_reward not between 0::numeric and 10000::numeric then
      raise exception using
        errcode = '22023',
        message = 'unit_activity_payload_invalid';
    end if;
  end if;

  if p_payload ? 'estimated_minutes' then
    if pg_catalog.jsonb_typeof(p_payload -> 'estimated_minutes') <> 'number' then
      raise exception using
        errcode = '22023',
        message = 'unit_activity_payload_invalid';
    end if;
    v_estimated_minutes := (p_payload ->> 'estimated_minutes')::numeric;
    if v_estimated_minutes <> pg_catalog.trunc(v_estimated_minutes)
       or v_estimated_minutes not between 0::numeric and 1440::numeric then
      raise exception using
        errcode = '22023',
        message = 'unit_activity_payload_invalid';
    end if;
  end if;

  select unit.path_id, activity.unit_id
    into v_path_id, v_unit_id
    from public.unit_activities as activity
    join public.learning_units as unit
      on unit.id = activity.unit_id
   where activity.id = p_activity_id;

  perform private.lock_mutable_learning_path(v_path_id);

  update public.unit_activities as activity
     set title = case
           when p_payload ? 'title'
             then pg_catalog.btrim(p_payload ->> 'title')
           else activity.title
         end,
         description = case
           when p_payload ? 'description' then p_payload ->> 'description'
           else activity.description
         end,
         content = case
           when p_payload ? 'content' then p_payload -> 'content'
           else activity.content
         end,
         xp_reward = case
           when p_payload ? 'xp_reward' then v_xp_reward::integer
           else activity.xp_reward
         end,
         estimated_minutes = case
           when p_payload ? 'estimated_minutes'
             then v_estimated_minutes::integer
           else activity.estimated_minutes
         end
   where activity.id = p_activity_id
     and activity.unit_id = v_unit_id
  returning activity.* into v_activity;

  if v_activity.id is null then
    raise exception using
      errcode = '55000',
      message = 'unit_activity_changed_during_mutation';
  end if;

  return pg_catalog.jsonb_build_object(
    'activityId', v_activity.id,
    'unitId', v_unit_id,
    'pathId', v_path_id,
    'activity', pg_catalog.to_jsonb(v_activity)
  );
end;
$function$;

alter function public.update_unit_activity(uuid, jsonb) owner to postgres;
revoke all on function public.update_unit_activity(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_unit_activity(uuid, jsonb)
  to authenticated, service_role;

create or replace function public.delete_unit_activity(
  p_activity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_path_id uuid;
  v_unit_id uuid;
  v_deleted_id uuid;
begin
  if p_activity_id is null then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_id_required';
  end if;

  select unit.path_id, activity.unit_id
    into v_path_id, v_unit_id
    from public.unit_activities as activity
    join public.learning_units as unit
      on unit.id = activity.unit_id
   where activity.id = p_activity_id;

  perform private.lock_mutable_learning_path(v_path_id);

  delete from public.unit_activities as activity
   where activity.id = p_activity_id
     and activity.unit_id = v_unit_id
  returning activity.id into v_deleted_id;

  if v_deleted_id is null then
    raise exception using
      errcode = '55000',
      message = 'unit_activity_changed_during_mutation';
  end if;

  return pg_catalog.jsonb_build_object(
    'activityId', v_deleted_id,
    'unitId', v_unit_id,
    'pathId', v_path_id,
    'deleted', true
  );
end;
$function$;

alter function public.delete_unit_activity(uuid) owner to postgres;
revoke all on function public.delete_unit_activity(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_unit_activity(uuid)
  to authenticated, service_role;

create or replace function public.reorder_unit_activities(
  p_unit_id uuid,
  p_activity_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_path_id uuid;
  v_existing_count integer;
  v_requested_count integer;
  v_unique_count integer;
  v_null_count integer;
  v_matched_count integer;
  v_min_order integer;
  v_max_order integer;
  v_temp_start bigint;
begin
  if p_unit_id is null or p_activity_ids is null then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_order_invalid';
  end if;

  select unit.path_id
    into v_path_id
    from public.learning_units as unit
   where unit.id = p_unit_id;

  perform private.lock_mutable_learning_path(v_path_id);

  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(activity.order_index),
    pg_catalog.max(activity.order_index)
    into v_existing_count, v_min_order, v_max_order
    from public.unit_activities as activity
   where activity.unit_id = p_unit_id;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(distinct requested.id)::integer,
    pg_catalog.count(*) filter (where requested.id is null)::integer,
    pg_catalog.count(activity.id)::integer
    into
      v_requested_count,
      v_unique_count,
      v_null_count,
      v_matched_count
    from pg_catalog.unnest(p_activity_ids) as requested(id)
    left join public.unit_activities as activity
      on activity.id = requested.id
     and activity.unit_id = p_unit_id;

  if v_requested_count <> v_existing_count
     or v_unique_count <> v_requested_count
     or v_null_count <> 0
     or v_matched_count <> v_requested_count then
    raise exception using
      errcode = '22023',
      message = 'unit_activity_order_invalid';
  end if;

  if v_existing_count > 0 then
    if greatest(v_max_order::bigint, v_existing_count::bigint)
         + v_existing_count::bigint <= 2147483647::bigint then
      v_temp_start := greatest(
        v_max_order::bigint,
        v_existing_count::bigint
      ) + 1;
    elsif least(v_min_order::bigint, 1::bigint)
            - v_existing_count::bigint >= -2147483648::bigint then
      v_temp_start := least(v_min_order::bigint, 1::bigint)
        - v_existing_count::bigint;
    else
      raise exception using
        errcode = '22003',
        message = 'unit_activity_order_range_exhausted';
    end if;

    with requested as (
      select item.id, item.ordinality
        from pg_catalog.unnest(p_activity_ids)
          with ordinality as item(id, ordinality)
    )
    update public.unit_activities as activity
       set order_index = (
         v_temp_start + requested.ordinality::bigint - 1
       )::integer
      from requested
     where activity.id = requested.id
       and activity.unit_id = p_unit_id;

    with requested as (
      select item.id, item.ordinality
        from pg_catalog.unnest(p_activity_ids)
          with ordinality as item(id, ordinality)
    )
    update public.unit_activities as activity
       set order_index = requested.ordinality::integer
      from requested
     where activity.id = requested.id
       and activity.unit_id = p_unit_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'unitId', p_unit_id,
    'pathId', v_path_id,
    'activityIds', pg_catalog.to_jsonb(p_activity_ids),
    'reordered', true
  );
end;
$function$;

alter function public.reorder_unit_activities(uuid, uuid[]) owner to postgres;
revoke all on function public.reorder_unit_activities(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.reorder_unit_activities(uuid, uuid[])
  to authenticated, service_role;

revoke update, delete on table
  public.learning_units,
  public.unit_activities
from authenticated, service_role;

do $curriculum_crud_postcheck$
begin
  if pg_catalog.to_regprocedure('public.delete_learning_unit(uuid)') is null
     or pg_catalog.to_regprocedure(
       'public.reorder_learning_units(uuid,uuid[])'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.update_unit_activity(uuid,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure('public.delete_unit_activity(uuid)') is null
     or pg_catalog.to_regprocedure(
       'public.reorder_unit_activities(uuid,uuid[])'
     ) is null then
    raise exception 'learning_curriculum_mutation_rpc_missing';
  end if;

  if not pg_catalog.has_function_privilege(
       'authenticated',
       'public.delete_learning_unit(uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.delete_learning_unit(uuid)',
       'EXECUTE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.learning_units',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.learning_units',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.unit_activities',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.unit_activities',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.learning_units',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.learning_units',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.unit_activities',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.unit_activities',
       'DELETE'
     ) then
    raise exception 'learning_curriculum_mutation_surface_exposed';
  end if;
end;
$curriculum_crud_postcheck$;

do $postcheck$
declare
  v_core regprocedure;
  v_rpc regprocedure;
  v_role text;
begin
  foreach v_core in array array[
    'public.enroll_student_learning_path_core(uuid,boolean,text,uuid)'::regprocedure,
    'public.get_student_learning_path_runtime_core(uuid)'::regprocedure,
    'public.get_student_complementary_activities_core(integer)'::regprocedure,
    'public.get_student_complementary_generation_status_core()'::regprocedure,
    'public.get_student_practice_status_core()'::regprocedure,
    'public.schedule_student_vocab_review_core(uuid,text,text,text)'::regprocedure,
    'public.submit_student_vocab_review_core(uuid,boolean,text)'::regprocedure,
    'public.begin_student_complementary_generation_core(uuid)'::regprocedure,
    'public.release_student_complementary_generation_core(uuid,uuid,uuid,text)'::regprocedure,
    'public.complete_student_complementary_activity_core(uuid,jsonb,text)'::regprocedure,
    'public.complete_student_complementary_activity_lifecycle_core(uuid,jsonb,text)'::regprocedure,
    'public.get_student_opt_in_leaderboard_core(integer)'::regprocedure,
    'public.consume_student_heart_core(text,text)'::regprocedure,
    'public.grade_quiz_core(uuid,integer[],text)'::regprocedure,
    'public.grade_quiz_lifecycle_core(uuid,integer[],text)'::regprocedure,
    'public.complete_learning_activity_core(uuid,integer,integer,jsonb,text)'::regprocedure,
    'public.award_verified_student_xp_core(text,text)'::regprocedure
  ] loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if pg_catalog.has_function_privilege(v_role, v_core, 'EXECUTE') then
        raise exception 'learning_internal_core_exposed: % to %', v_core, v_role;
      end if;
    end loop;
  end loop;

  foreach v_rpc in array array[
    'public.get_student_learning_path_runtime(uuid)'::regprocedure,
    'public.get_student_complementary_activities(integer)'::regprocedure,
    'public.get_student_complementary_generation_status()'::regprocedure,
    'public.get_student_practice_status()'::regprocedure,
    'public.get_student_opt_in_leaderboard(integer)'::regprocedure
  ] loop
    if pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(v_rpc::oid),
         'private.assert_active_student_learning_access()'
       ) = 0 then
      raise exception 'learning_read_lifecycle_guard_missing: %', v_rpc;
    end if;
  end loop;

  foreach v_rpc in array array[
    'public.enroll_student_learning_path(uuid,boolean,text,uuid)'::regprocedure,
    'public.schedule_student_vocab_review(uuid,text,text,text)'::regprocedure,
    'public.submit_student_vocab_review(uuid,boolean,text)'::regprocedure,
    'public.begin_student_complementary_generation(uuid)'::regprocedure,
    'public.release_student_complementary_generation(uuid,uuid,uuid,text)'::regprocedure,
    'public.complete_student_complementary_activity(uuid,jsonb,text)'::regprocedure,
    'public.consume_student_heart(text,text)'::regprocedure,
    'public.grade_quiz(uuid,integer[],text)'::regprocedure,
    'public.complete_learning_activity(uuid,integer,integer,jsonb,text)'::regprocedure,
    'public.award_verified_student_xp(text,text)'::regprocedure
  ] loop
    if pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(v_rpc::oid),
         'private.assert_active_student_learning_mutation()'
       ) = 0 then
      raise exception 'learning_mutation_lifecycle_guard_missing: %', v_rpc;
    end if;
  end loop;

  if pg_catalog.has_table_privilege(
       'anon',
       'private.learning_path_archive_capabilities',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'anon',
       'private.learning_path_archive_capabilities',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'private.learning_path_archive_capabilities',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'private.learning_path_archive_capabilities',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'private.learning_path_archive_capabilities',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'private.learning_path_archive_capabilities',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.student_path_enrollments',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.student_path_enrollments',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.student_path_enrollments',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'public.student_path_enrollments',
       'TRUNCATE'
     ) then
    raise exception 'learning_lifecycle_privileged_bypass_exposed';
  end if;
end;
$postcheck$;

notify pgrst, 'reload schema';

commit;
