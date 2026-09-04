begin;

-- Progression, evaluation release and legacy unlocks are pedagogical authority,
-- never editable profile preferences. Staff uses the audited RPCs; a student
-- may still edit ordinary profile data, but cannot promote their own journey.
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

  if current_user in ('authenticated', 'anon')
     and row(
       new.current_book_part,
       new.evaluation_unlocked,
       new.unlocked_tests
     ) is distinct from row(
       old.current_book_part,
       old.evaluation_unlocked,
       old.unlocked_tests
     ) then
    raise exception using
      errcode = '42501',
      message = 'pedagogical_progression_fields_are_read_only';
  end if;

  -- Placement changes use set_student_pedagogical_placement so module and book
  -- part cannot diverge. Teacher profiles keep using module as a specialization.
  if current_user in ('authenticated', 'anon')
     and old.role = 'STUDENT'
     and new.module is distinct from old.module
  then
    raise exception using
      errcode = '42501',
      message = 'pedagogical_module_is_not_self_editable';
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
  last_activity,
  current_book_part,
  evaluation_unlocked,
  unlocked_tests,
  module
on public.profiles
for each row execute function public.guard_wolfie_profile_server_fields();

-- UI route guards are convenience only. This database boundary prevents an
-- old token or direct PostgREST call from enrolling, grading or awarding an
-- inactive student after suspension/offboarding.
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
     and tg_op = 'UPDATE' then
    if coalesce(pg_catalog.to_jsonb(new) ->> 'status', '') in (
      'RELEASED',
      'EXPIRED',
      'DENIED'
    ) then
      return new;
    end if;
  end if;

  if tg_table_name = 'student_path_enrollments'
     and tg_op = 'UPDATE' then
    if coalesce(pg_catalog.to_jsonb(new) ->> 'status', '') <> 'ACTIVE' then
      return new;
    end if;
  end if;

  perform 1
    from public.profiles as student
   where student.id = v_student_id
     and student.role = 'STUDENT'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
           student.lifecycle_status,
           'active'
         ))) = 'active'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
           student.status,
           'Ativo'
         ))) not in (
           'inativo', 'inactive', 'arquivado', 'cancelado', 'trancado'
         );
  if not found then
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

do $learning_mutation_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'student_path_enrollments',
    'student_activity_progress',
    'student_learning_activity_attempts',
    'student_complementary_activity_attempts',
    'student_generated_activity_batches',
    'student_activities',
    'student_vocab_reviews',
    'student_vocab_review_attempts',
    'student_heart_consumptions',
    'pedagogical_evaluation_submission_requests',
    'student_verified_xp_awards'
  ] loop
    if pg_catalog.to_regclass('public.' || v_table) is not null then
      execute pg_catalog.format(
        'drop trigger if exists guard_active_student_learning_mutation on public.%I',
        v_table
      );
      execute pg_catalog.format(
        'create trigger guard_active_student_learning_mutation before insert or update on public.%I for each row execute function private.guard_active_student_learning_mutation()',
        v_table
      );
    end if;
  end loop;

  drop trigger if exists guard_active_student_learning_mutation
    on public.student_complementary_generation_reservations;
  create trigger guard_active_student_learning_mutation
  before insert or update
  on public.student_complementary_generation_reservations
  for each row execute function private.guard_active_student_learning_mutation();
end;
$learning_mutation_triggers$;

create table if not exists public.pedagogical_placement_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null,
  student_id uuid not null references public.profiles(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  previous_module text,
  previous_book_part text,
  new_module text not null,
  new_book_part text not null,
  reason text not null,
  occurred_at timestamptz not null default pg_catalog.now()
);

alter table public.pedagogical_placement_audit enable row level security;
revoke all on table public.pedagogical_placement_audit
  from public, anon, authenticated;
grant all on table public.pedagogical_placement_audit to service_role;

drop policy if exists pedagogical_placement_audit_staff_read
  on public.pedagogical_placement_audit;
create policy pedagogical_placement_audit_staff_read
on public.pedagogical_placement_audit
for select
to authenticated
using (
  public._my_role() = 'SUPER_ADMIN'
  or (
    tenant_id = public._my_tenant_id()
    and public._my_role() in ('SCHOOL_ADMIN', 'COORDINATOR')
  )
  or (
    tenant_id = public._my_tenant_id()
    and public._my_role() = 'TEACHER'
    and public._teacher_can_access_student(student_id, tenant_id)
  )
);
grant select on table public.pedagogical_placement_audit to authenticated;

create or replace function public.set_student_pedagogical_placement(
  p_student_id uuid,
  p_module text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor record;
  v_student record;
  v_module text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_module, '')));
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_book_part text;
begin
  if v_actor_id is null or p_student_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_module not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
     or v_reason is null
     or pg_catalog.length(v_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'invalid_pedagogical_placement';
  end if;

  select profile.role, profile.tenant_id
    into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  if not found
     or v_actor.role not in (
       'TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'
     ) then
    raise exception using errcode = '42501', message = 'staff_role_required';
  end if;

  select
    profile.id,
    profile.role,
    profile.tenant_id,
    profile.module,
    profile.current_book_part,
    profile.lifecycle_status,
    profile.status
    into v_student
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found
     or v_student.role <> 'STUDENT'
     or v_student.tenant_id is null
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
          v_student.lifecycle_status,
          'active'
        ))) <> 'active'
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
          v_student.status,
          'Ativo'
        ))) in ('inativo', 'inactive', 'arquivado', 'cancelado', 'trancado') then
    raise exception using errcode = '42501', message = 'student_not_available';
  end if;

  if v_actor.role = 'SUPER_ADMIN' then
    null;
  elsif v_actor.tenant_id is null
        or v_actor.tenant_id <> v_student.tenant_id then
    raise exception using errcode = '42501', message = 'student_not_available';
  elsif v_actor.role = 'TEACHER'
        and not public._teacher_can_access_student(
          p_student_id,
          v_student.tenant_id
        ) then
    raise exception using errcode = '42501', message = 'teacher_student_link_required';
  end if;

  -- Reapplying the same placement is a true no-op: ordinary profile edits must
  -- never send a student from part 2 back to part 1 or clear an evaluation that
  -- was already released. Only a real module change starts its first published
  -- milestone. Advanced CEFR badges without a published milestone keep the
  -- existing COMPLETED convention instead of inventing `${module}-1`.
  if pg_catalog.upper(pg_catalog.btrim(coalesce(v_student.module, ''))) = v_module
     and nullif(
       pg_catalog.btrim(coalesce(v_student.current_book_part, '')),
       ''
     ) is not null then
    v_book_part := pg_catalog.btrim(v_student.current_book_part);
  else
    select catalog.book_part
      into v_book_part
      from public.pedagogical_evaluation_catalog as catalog
     where catalog.module = v_module
       and catalog.active is true
     order by catalog.part asc
     limit 1;
    if not found then
      v_book_part := 'COMPLETED';
    end if;
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(v_student.module, ''))) = v_module
     and coalesce(v_student.current_book_part, '') = v_book_part then
    return pg_catalog.jsonb_build_object(
      'studentId', p_student_id,
      'module', v_module,
      'bookPart', v_book_part,
      'alreadyApplied', true
    );
  end if;

  update public.profiles
     set module = v_module,
         current_book_part = v_book_part,
         evaluation_unlocked = false,
         unlocked_tests = '{}'::text[]
   where id = p_student_id;

  insert into public.pedagogical_placement_audit (
    tenant_id,
    student_id,
    actor_id,
    previous_module,
    previous_book_part,
    new_module,
    new_book_part,
    reason
  ) values (
    v_student.tenant_id,
    p_student_id,
    v_actor_id,
    v_student.module,
    v_student.current_book_part,
    v_module,
    v_book_part,
    v_reason
  );

  return pg_catalog.jsonb_build_object(
    'studentId', p_student_id,
    'module', v_module,
    'bookPart', v_book_part,
    'alreadyApplied', false
  );
end;
$function$;

alter function public.set_student_pedagogical_placement(uuid, text, text)
  owner to postgres;
revoke all on function public.set_student_pedagogical_placement(
  uuid,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.set_student_pedagogical_placement(
  uuid,
  text,
  text
) to authenticated, service_role;

-- Correct the previous nominal SUPER_ADMIN branch: platform support may act
-- cross-tenant, while every school-scoped role remains tenant/teacher bound.
create or replace function public.set_student_pedagogical_evaluation_access(
  p_student_id uuid,
  p_expected_book_part text,
  p_unlocked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  if not found
     or v_actor.role not in (
       'TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'
     )
     or (v_actor.role <> 'SUPER_ADMIN' and v_actor.tenant_id is null) then
    raise exception using errcode = '42501', message = 'authorized_staff_profile_required';
  end if;

  select
    profile.id,
    profile.tenant_id,
    profile.role,
    coalesce(profile.current_book_part, coalesce(profile.module, 'A1') || '-1')
      as current_book_part,
    profile.lifecycle_status,
    profile.status
    into v_student
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found
     or v_student.role <> 'STUDENT'
     or v_student.tenant_id is null
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
          v_student.lifecycle_status,
          'active'
        ))) <> 'active'
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
          v_student.status,
          'Ativo'
        ))) in ('inativo', 'inactive', 'arquivado', 'cancelado', 'trancado') then
    raise exception using errcode = '42501', message = 'student_not_available';
  end if;

  if v_actor.role = 'SUPER_ADMIN' then
    null;
  elsif v_actor.tenant_id <> v_student.tenant_id then
    raise exception using errcode = '42501', message = 'student_not_available';
  elsif v_actor.role = 'TEACHER'
        and not public._teacher_can_access_student(
          p_student_id,
          v_student.tenant_id
        ) then
    raise exception using errcode = '42501', message = 'teacher_student_link_required';
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
$function$;

alter function public.set_student_pedagogical_evaluation_access(
  uuid,
  text,
  boolean
) owner to postgres;
revoke all on function public.set_student_pedagogical_evaluation_access(
  uuid,
  text,
  boolean
) from public, anon, authenticated;
grant execute on function public.set_student_pedagogical_evaluation_access(
  uuid,
  text,
  boolean
) to authenticated, service_role;

create table if not exists public.learning_path_archive_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text,
  path_id uuid not null references public.learning_paths(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  reason text not null,
  occurred_at timestamptz not null default pg_catalog.now()
);

alter table public.learning_path_archive_audit enable row level security;
revoke all on table public.learning_path_archive_audit
  from public, anon, authenticated;
grant all on table public.learning_path_archive_audit to service_role;

drop policy if exists learning_path_archive_audit_staff_read
  on public.learning_path_archive_audit;
create policy learning_path_archive_audit_staff_read
on public.learning_path_archive_audit
for select
to authenticated
using (
  public._my_role() = 'SUPER_ADMIN'
  or (
    tenant_id = public._my_tenant_id()
    and public._my_role() in ('SCHOOL_ADMIN', 'COORDINATOR')
  )
);
grant select on table public.learning_path_archive_audit to authenticated;

drop policy if exists learning_paths_staff_delete on public.learning_paths;
revoke delete on table public.learning_paths from authenticated;

-- Students retain read-only review of an archived curriculum they completed.
drop policy if exists learning_paths_read_scoped on public.learning_paths;
create policy learning_paths_read_scoped
on public.learning_paths
for select
to authenticated
using (
  public._my_role() = 'SUPER_ADMIN'
  or (
    public._my_role() = 'SCHOOL_ADMIN'
    and (tenant_id is null or tenant_id = public._my_tenant_id())
  )
  or (
    active is true
    and (tenant_id is null or tenant_id = public._my_tenant_id())
  )
  or exists (
    select 1
      from public.student_path_enrollments as enrollment
     where enrollment.path_id = learning_paths.id
       and enrollment.student_id = auth.uid()
       and enrollment.status = 'COMPLETED'
       and enrollment.completed_at is not null
  )
);

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
  v_actor record;
  v_path public.learning_paths%rowtype;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
begin
  if v_actor_id is null or p_path_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'learning_path_archive_reason_required';
  end if;

  select profile.role, profile.tenant_id
    into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  if not found or v_actor.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'learning_path_archive_not_authorized';
  end if;

  select *
    into v_path
    from public.learning_paths as path
   where path.id = p_path_id
   for update;
  if not found
     or (
       v_actor.role <> 'SUPER_ADMIN'
       and (
         v_path.tenant_id is null
         or v_actor.tenant_id is distinct from v_path.tenant_id
       )
     ) then
    raise exception using errcode = '42501', message = 'learning_path_archive_not_authorized';
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
    raise exception using errcode = '55000', message = 'learning_path_has_active_students';
  end if;

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

-- Keep the mature grader as a private core and put heart consumption in the
-- same transaction as grading. A network loss can no longer save a wrong
-- attempt without its corresponding life consumption, and keyed replays do not
-- consume twice.
do $rename_grade_core$
begin
  if pg_catalog.to_regprocedure(
       'public.grade_quiz_core(uuid,integer[],text)'
     ) is null then
    alter function public.grade_quiz(uuid, integer[], text)
      rename to grade_quiz_core;
  end if;
end;
$rename_grade_core$;

alter function public.grade_quiz_core(uuid, integer[], text)
  owner to postgres;
revoke all on function public.grade_quiz_core(uuid, integer[], text)
  from public, anon, authenticated, service_role;

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
declare
  v_student_id uuid := auth.uid();
  v_request_key text := pg_catalog.btrim(coalesce(p_request_key, ''));
  v_result jsonb;
  v_heart_result jsonb;
  v_wrong_answers integer;
  v_consumed integer := 0;
  v_hearts integer;
  i integer;
begin
  if pg_catalog.length(v_request_key) not between 8 and 180 then
    raise exception using
      errcode = '22023',
      message = 'invalid_quiz_request_key';
  end if;

  v_result := public.grade_quiz_core(
    p_activity_id,
    p_answers,
    v_request_key
  );

  v_wrong_answers := least(
    5,
    greatest(
      0,
      coalesce(nullif(v_result ->> 'totalQuestions', '')::integer, 0)
        - coalesce(nullif(v_result ->> 'correctAnswers', '')::integer, 0)
    )
  );

  for i in 1 .. v_wrong_answers loop
    v_heart_result := public.consume_student_heart(
      'learning-heart-' || pg_catalog.md5(
        p_activity_id::text || ':' || v_request_key || ':' || i::text
      ),
      'WRONG_ANSWER'
    );
    v_hearts := nullif(v_heart_result ->> 'hearts', '')::integer;
    if coalesce((v_heart_result ->> 'consumed')::boolean, false)
       and not coalesce(
         (v_heart_result ->> 'alreadyApplied')::boolean,
         false
       ) then
      v_consumed := v_consumed + 1;
    end if;
  end loop;

  if v_hearts is null and v_student_id is not null then
    select coalesce(profile.hearts, 5)
      into v_hearts
      from public.profiles as profile
     where profile.id = v_student_id;
  end if;

  return v_result || pg_catalog.jsonb_build_object(
    'hearts', v_hearts,
    'heartsConsumed', v_consumed
  );
end;
$function$;

alter function public.grade_quiz(uuid, integer[], text) owner to postgres;
revoke all on function public.grade_quiz(uuid, integer[], text)
  from public, anon, authenticated;
grant execute on function public.grade_quiz(uuid, integer[], text)
  to authenticated, service_role;

comment on function public.grade_quiz(uuid, integer[], text) is
  'Atomic server-authoritative quiz grading, progression, XP, streak and idempotent heart consumption.';

-- Preserve the mature complementary evaluator as a private core. The wrapper
-- gives every valid objective attempt the same streak semantics and, when an
-- obsolete tab submits an already completed activity with a new key, returns
-- the canonical passing feedback instead of a misleading null/empty score.
do $rename_complementary_core$
begin
  if pg_catalog.to_regprocedure(
       'public.complete_student_complementary_activity_core(uuid,jsonb,text)'
     ) is null then
    alter function public.complete_student_complementary_activity(
      uuid,
      jsonb,
      text
    ) rename to complete_student_complementary_activity_core;
  end if;
end;
$rename_complementary_core$;

alter function public.complete_student_complementary_activity_core(
  uuid,
  jsonb,
  text
) owner to postgres;
revoke all on function public.complete_student_complementary_activity_core(
  uuid,
  jsonb,
  text
) from public, anon, authenticated, service_role;

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
  v_request_key text := pg_catalog.btrim(coalesce(p_request_key, ''));
  v_profile record;
  v_activity public.student_activities%rowtype;
  v_existing_attempt public.student_complementary_activity_attempts%rowtype;
  v_result jsonb;
  v_canonical_result jsonb;
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb) - 'completedAt';
  v_activity_type text;
  v_streak integer;
  v_now timestamptz := pg_catalog.now();
begin
  if v_student_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
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
    profile.lifecycle_status,
    profile.status,
    coalesce(profile.streak_count, 0) as streak_count
    into v_profile
    from public.profiles as profile
   where profile.id = v_student_id
   for update;
  if not found
     or v_profile.role <> 'STUDENT'
     or v_profile.tenant_id is null
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
          v_profile.lifecycle_status,
          'active'
        ))) <> 'active'
     or pg_catalog.lower(pg_catalog.btrim(coalesce(
          v_profile.status,
          'Ativo'
        ))) in ('inativo', 'inactive', 'arquivado', 'cancelado', 'trancado') then
    raise exception using
      errcode = '42501',
      message = 'inactive_student_learning_mutation_forbidden';
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

  -- Preserve strict same-key idempotency before resolving a stale completed
  -- tab with a different key.
  select *
    into v_existing_attempt
    from public.student_complementary_activity_attempts as attempt
   where attempt.student_id = v_student_id
     and attempt.request_key = v_request_key
   for update;
  if found then
    if v_existing_attempt.activity_id <> p_activity_id
       or v_existing_attempt.evidence is distinct from v_evidence then
      raise exception using errcode = '22023', message = 'idempotency_key_reused';
    end if;
    return v_existing_attempt.result || pg_catalog.jsonb_build_object(
      'alreadyApplied', true,
      'canonicalResultAvailable', true
    );
  end if;

  if v_activity.status = 'COMPLETED' then
    select attempt.result
      into v_canonical_result
      from public.student_complementary_activity_attempts as attempt
     where attempt.student_id = v_student_id
       and attempt.activity_id = p_activity_id
       and attempt.passed is true
     order by
       (attempt.request_key = v_activity.completion_request_key) desc,
       attempt.created_at desc,
       attempt.id desc
     limit 1;

    if v_canonical_result is not null then
      return v_canonical_result || pg_catalog.jsonb_build_object(
        'alreadyApplied', true,
        'canonicalResultAvailable', true
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'activityId', v_activity.id,
      'status', 'COMPLETED',
      'passed', true,
      'scorePercentage', null,
      'questionResults', '[]'::jsonb,
      'completedAt', v_activity.completed_at,
      'alreadyApplied', true,
      'evidenceAccepted', false,
      'canonicalResultAvailable', false,
      'streakCount', v_profile.streak_count,
      'xpEarned', 0
    );
  end if;

  v_result := public.complete_student_complementary_activity_core(
    p_activity_id,
    p_evidence,
    v_request_key
  );

  if coalesce((v_result ->> 'alreadyApplied')::boolean, false)
     and coalesce((v_result ->> 'passed')::boolean, false)
     and (
       not (v_result ? 'scorePercentage')
       or v_result -> 'scorePercentage' = 'null'::jsonb
     ) then
    select attempt.result
      into v_canonical_result
      from public.student_complementary_activity_attempts as attempt
     where attempt.student_id = v_student_id
       and attempt.activity_id = p_activity_id
       and attempt.passed is true
     order by attempt.created_at desc, attempt.id desc
     limit 1;

    if v_canonical_result is not null then
      v_result := v_canonical_result || pg_catalog.jsonb_build_object(
        'alreadyApplied', true,
        'canonicalResultAvailable', true
      );
    end if;
  end if;

  if not coalesce((v_result ->> 'alreadyApplied')::boolean, false)
     and not coalesce((v_result ->> 'passed')::boolean, false) then
    v_activity_type := v_activity.type;

    if v_activity_type in ('quiz', 'grammar') then
      v_streak := private.record_student_learning_practice(
        v_student_id,
        coalesce(nullif(v_result ->> 'scorePercentage', '')::integer, 0),
        case v_activity_type
          when 'grammar' then 'grammar_drill'
          else 'quiz'
        end,
        array[]::text[],
        v_now
      );
      v_result := v_result || pg_catalog.jsonb_build_object(
        'streakCount', v_streak
      );

      update public.student_complementary_activity_attempts as attempt
         set result = v_result
       where attempt.student_id = v_student_id
         and attempt.activity_id = p_activity_id
         and attempt.request_key = v_request_key;
    end if;
  end if;

  return v_result;
end;
$function$;

alter function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) owner to postgres;
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

comment on function public.complete_student_complementary_activity(
  uuid,
  jsonb,
  text
) is
  'Server-authoritative complementary completion with canonical replay and consistent valid-practice streak semantics.';

-- Preserve an exact rollback record before releasing legacy recurring slots
-- that predate the lifecycle state machine. The current trigger already blocks
-- their recreation after this repair.
create schema if not exists private;
revoke all on schema private from public, anon;

create table if not exists private.legacy_inactive_booking_release_audit (
  booking_id uuid primary key,
  student_id uuid not null,
  teacher_id uuid,
  original_row jsonb not null,
  released_at timestamptz not null default pg_catalog.now(),
  release_reason text not null default 'inactive_student_legacy_slot'
);

alter table private.legacy_inactive_booking_release_audit owner to postgres;
revoke all on table private.legacy_inactive_booking_release_audit
  from public, anon, authenticated, service_role;

insert into private.legacy_inactive_booking_release_audit (
  booking_id,
  student_id,
  teacher_id,
  original_row
)
select
  booking.id,
  booking.student_id,
  booking.teacher_id,
  pg_catalog.to_jsonb(booking)
from public.bookings as booking
join public.profiles as student
  on student.id = booking.student_id
where student.role = 'STUDENT'
  and pg_catalog.lower(pg_catalog.btrim(coalesce(
        student.lifecycle_status,
        ''
      ))) in ('suspended', 'offboarded')
  and pg_catalog.upper(pg_catalog.btrim(coalesce(
        booking.status,
        ''
      ))) = 'SCHEDULED'
on conflict (booking_id) do nothing;

update public.bookings as booking
   set status = 'CANCELLED'
  from public.profiles as student
 where student.id = booking.student_id
   and student.role = 'STUDENT'
   and pg_catalog.lower(pg_catalog.btrim(coalesce(
         student.lifecycle_status,
         ''
       ))) in ('suspended', 'offboarded')
   and pg_catalog.upper(pg_catalog.btrim(coalesce(
         booking.status,
         ''
       ))) = 'SCHEDULED';

do $postcheck$
begin
  if exists (
    select 1
      from public.bookings as booking
      join public.profiles as student on student.id = booking.student_id
     where student.role = 'STUDENT'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             student.lifecycle_status,
             ''
           ))) in ('suspended', 'offboarded')
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             booking.status,
             ''
           ))) = 'SCHEDULED'
  ) then
    raise exception 'inactive_student_scheduled_booking_repair_incomplete';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'public.grade_quiz_core(uuid,integer[],text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.complete_student_complementary_activity_core(uuid,jsonb,text)',
       'EXECUTE'
     ) then
    raise exception 'learning_core_function_exposed';
  end if;
end;
$postcheck$;

commit;
