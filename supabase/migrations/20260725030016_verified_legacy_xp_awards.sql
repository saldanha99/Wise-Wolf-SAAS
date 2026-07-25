-- Transitional server-authoritative XP award for confirming a real class log.
-- Other legacy browser-authored completions intentionally no longer award XP:
-- they cannot provide authoritative evidence of completion.

create table if not exists public.student_verified_xp_awards (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  source_type text not null check (
    source_type in (
      'CLASS_LOG_CONFIRM',
      'LEARNING_PATH_QUIZ',
      'PEDAGOGICAL_QUIZ'
    )
  ),
  source_id text not null check (
    length(source_id) between 1 and 180
  ),
  base_xp integer not null check (base_xp between 0 and 100),
  xp_awarded integer not null check (xp_awarded between 0 and 100),
  score_used smallint check (score_used between 0 and 100),
  test_fixture boolean not null default false,
  created_at timestamptz not null default now(),
  unique (student_id, source_type, source_id)
);

comment on table public.student_verified_xp_awards is
  'Idempotency ledger for legacy XP events validated and awarded by Postgres.';

create index if not exists idx_student_verified_xp_awards_tenant_created
  on public.student_verified_xp_awards (tenant_id, created_at desc);
create index if not exists idx_student_verified_xp_awards_student_created
  on public.student_verified_xp_awards (student_id, created_at desc);

alter table public.student_verified_xp_awards enable row level security;

revoke all on table public.student_verified_xp_awards
  from public, anon, authenticated;
grant all on table public.student_verified_xp_awards to service_role;

create or replace function public.award_verified_student_xp(
  p_source_type text,
  p_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student_id uuid := auth.uid();
  v_source_type text := upper(trim(coalesce(p_source_type, '')));
  v_source_id text := trim(coalesce(p_source_id, ''));
  v_source_uuid uuid;
  v_profile record;
  v_existing public.student_verified_xp_awards%rowtype;
  v_base_xp integer;
  v_score smallint;
  v_daily_xp integer;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_xp_awarded integer;
  v_new_xp integer;
  v_old_level integer;
  v_new_level integer;
begin
  if v_student_id is null or auth.role() <> 'authenticated' then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_source_type not in (
    'CLASS_LOG_CONFIRM'
  ) then
    raise exception using errcode = '22023', message = 'invalid_xp_source_type';
  end if;
  if length(v_source_id) < 1 or length(v_source_id) > 180 then
    raise exception using errcode = '22023', message = 'invalid_xp_source_id';
  end if;

  select
    id,
    tenant_id,
    role,
    current_book_part,
    coalesce(xp, 0) as xp,
    coalesce(level, 1) as level,
    coalesce(daily_xp, 0) as daily_xp,
    daily_xp_date,
    coalesce(is_test_account, false) as is_test_account
    into v_profile
    from public.profiles
   where id = v_student_id
   for update;

  if not found or v_profile.role <> 'STUDENT' or v_profile.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_profile_required';
  end if;

  select *
    into v_existing
    from public.student_verified_xp_awards
   where student_id = v_student_id
     and source_type = v_source_type
     and source_id = v_source_id;

  if found then
    return jsonb_build_object(
      'alreadyAwarded', true,
      'xpEarned', 0,
      'originalXpAwarded', v_existing.xp_awarded,
      'newXP', v_profile.xp,
      'newLevel', v_profile.level,
      'leveledUp', false
    );
  end if;

  if v_source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'invalid_xp_source_id';
  end if;
  v_source_uuid := v_source_id::uuid;

  if not exists (
    select 1
      from public.class_logs
     where id = v_source_uuid
       and student_id = v_student_id
       and tenant_id = v_profile.tenant_id
       and student_confirmed is true
  ) then
    raise exception using errcode = '42501', message = 'xp_source_not_verified';
  end if;
  v_base_xp := 100;
  v_score := 100;

  if v_profile.daily_xp_date is distinct from v_today then
    v_daily_xp := 0;
  else
    v_daily_xp := v_profile.daily_xp;
  end if;

  v_xp_awarded := least(v_base_xp, greatest(0, 250 - v_daily_xp));
  if v_profile.is_test_account then
    v_xp_awarded := 0;
  end if;
  v_old_level := v_profile.level;
  v_new_xp := v_profile.xp + v_xp_awarded;
  v_new_level := floor(v_new_xp / 1000) + 1;

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
    v_source_type,
    v_source_id,
    v_base_xp,
    v_xp_awarded,
    v_score,
    v_profile.is_test_account
  );

  update public.profiles
     set xp = v_new_xp,
         level = v_new_level,
         daily_xp = v_daily_xp + v_xp_awarded,
         daily_xp_date = v_today,
         last_activity = now()
   where id = v_student_id;

  return jsonb_build_object(
    'alreadyAwarded', false,
    'xpEarned', v_xp_awarded,
    'newXP', v_new_xp,
    'newLevel', v_new_level,
    'leveledUp', v_new_level > v_old_level
  );
end;
$$;

revoke all on function public.award_verified_student_xp(text, text)
  from public, anon;
grant execute on function public.award_verified_student_xp(text, text)
  to authenticated, service_role;

-- The pedagogical shelf quiz is graded in the authenticated Edge Function.
-- This service-only RPC serializes progression and XP, validates that the
-- expected quiz is actually unlocked, records the attempt, and makes a pass
-- idempotent. Browser roles cannot call it or choose an XP amount.
create or replace function public.record_verified_pedagogical_quiz(
  p_student_id uuid,
  p_book_part text,
  p_score integer,
  p_total_questions integer,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_book_part text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_book_part, ''))
  );
  v_profile record;
  v_existing public.student_verified_xp_awards%rowtype;
  v_percentage integer;
  v_passed boolean;
  v_modules text[] := array['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  v_module text;
  v_part integer;
  v_module_index integer;
  v_next_part text;
  v_daily_xp integer;
  v_today date :=
    (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_xp_earned integer := 0;
  v_new_xp integer;
  v_new_level integer;
  v_answer jsonb;
begin
  if p_student_id is null
     or v_book_part !~ '^(A1|A2|B1|B2|C1|C2)-[1-4]$'
     or p_total_questions is null
     or p_total_questions not between 1 and 100
     or p_score is null
     or p_score not between 0 and p_total_questions
     or p_answers is null
     or pg_catalog.jsonb_typeof(p_answers) <> 'array'
     or pg_catalog.jsonb_array_length(p_answers) <> p_total_questions
     or pg_catalog.pg_column_size(p_answers) > 16384 then
    raise exception using
      errcode = '22023',
      message = 'invalid_pedagogical_quiz_result';
  end if;

  for v_answer in
    select value
      from pg_catalog.jsonb_array_elements(p_answers)
  loop
    if pg_catalog.jsonb_typeof(v_answer) <> 'number'
       or v_answer::text !~ '^[0-9]+$' then
      raise exception using
        errcode = '22023',
        message = 'invalid_pedagogical_quiz_answers';
    end if;
  end loop;

  v_percentage := pg_catalog.round(
    (p_score::numeric / p_total_questions::numeric) * 100
  );
  v_passed := v_percentage >= 70;

  select
    profile.tenant_id,
    profile.role,
    profile.module,
    profile.current_book_part,
    profile.evaluation_unlocked,
    coalesce(profile.xp, 0) as xp,
    coalesce(profile.level, 1) as level,
    coalesce(profile.daily_xp, 0) as daily_xp,
    profile.daily_xp_date,
    coalesce(profile.is_test_account, false) as is_test_account
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
    into v_existing
    from public.student_verified_xp_awards as award
   where award.student_id = p_student_id
     and award.source_type = 'PEDAGOGICAL_QUIZ'
     and award.source_id = v_book_part;

  if found then
    return pg_catalog.jsonb_build_object(
      'alreadyAwarded', true,
      'passed', true,
      'score', p_score,
      'totalQuestions', p_total_questions,
      'percentage', v_percentage,
      'xpEarned', 0,
      'nextPart', v_profile.current_book_part,
      'newLevel', v_profile.level,
      'leveledUp', false
    );
  end if;

  if coalesce(
       v_profile.current_book_part,
       coalesce(v_profile.module, 'A1') || '-1'
     ) <> v_book_part
     or coalesce(v_profile.evaluation_unlocked, false) is not true then
    raise exception using
      errcode = 'P0001',
      message = 'pedagogical_quiz_not_unlocked';
  end if;

  insert into public.student_evaluations (
    student_id,
    book_part,
    score,
    total_questions,
    answers,
    completed_at,
    tenant_id
  ) values (
    p_student_id,
    v_book_part,
    p_score,
    p_total_questions,
    p_answers,
    pg_catalog.now(),
    v_profile.tenant_id
  );

  if not v_passed then
    update public.profiles
       set last_activity = pg_catalog.now()
     where id = p_student_id;
    return pg_catalog.jsonb_build_object(
      'alreadyAwarded', false,
      'passed', false,
      'score', p_score,
      'totalQuestions', p_total_questions,
      'percentage', v_percentage,
      'xpEarned', 0,
      'nextPart', v_book_part,
      'newLevel', v_profile.level,
      'leveledUp', false
    );
  end if;

  v_module := pg_catalog.split_part(v_book_part, '-', 1);
  v_part := pg_catalog.split_part(v_book_part, '-', 2)::integer;
  v_module_index := pg_catalog.array_position(v_modules, v_module);
  if v_part < 4 then
    v_next_part := v_module || '-' || (v_part + 1)::text;
  elsif v_module_index < pg_catalog.cardinality(v_modules) then
    v_next_part := v_modules[v_module_index + 1] || '-1';
  else
    v_next_part := 'COMPLETED';
  end if;

  v_daily_xp := case
    when v_profile.daily_xp_date = v_today then v_profile.daily_xp
    else 0
  end;
  v_xp_earned := pg_catalog.round(
    100 * (v_percentage::numeric / 100)
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
    p_student_id,
    'PEDAGOGICAL_QUIZ',
    v_book_part,
    100,
    v_xp_earned,
    v_percentage,
    v_profile.is_test_account
  );

  update public.profiles
     set current_book_part = v_next_part,
         evaluation_unlocked = false,
         module = case
           when v_next_part = 'COMPLETED' then module
           else pg_catalog.split_part(v_next_part, '-', 1)
         end,
         xp = v_new_xp,
         level = v_new_level,
         daily_xp = v_daily_xp + v_xp_earned,
         daily_xp_date = v_today,
         last_activity = pg_catalog.now()
   where id = p_student_id;

  return pg_catalog.jsonb_build_object(
    'alreadyAwarded', false,
    'passed', true,
    'score', p_score,
    'totalQuestions', p_total_questions,
    'percentage', v_percentage,
    'xpEarned', v_xp_earned,
    'nextPart', v_next_part,
    'newLevel', v_new_level,
    'leveledUp', v_new_level > v_profile.level
  );
end;
$$;

revoke all on function public.record_verified_pedagogical_quiz(
  uuid,
  text,
  integer,
  integer,
  jsonb
) from public, anon, authenticated;
grant execute on function public.record_verified_pedagogical_quiz(
  uuid,
  text,
  integer,
  integer,
  jsonb
) to service_role;

-- The previous grade_quiz implementation awarded XP on every replay. Keep
-- unlimited attempts, but validate tenant content server-side and award XP
-- exactly once, on the first passing attempt.
create or replace function public.grade_quiz(
  p_activity_id uuid,
  p_answers integer[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student_id uuid := auth.uid();
  v_profile record;
  v_activity record;
  v_questions jsonb;
  v_total integer;
  v_correct integer := 0;
  v_score integer;
  v_base_xp integer;
  v_xp_earned integer := 0;
  v_daily_xp integer;
  v_today date :=
    (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_new_xp integer;
  v_new_level integer;
  v_existing_award public.student_verified_xp_awards%rowtype;
  i integer;
begin
  if v_student_id is null or auth.role() <> 'authenticated' then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

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
    activity.content,
    least(
      100,
      greatest(0, coalesce(activity.xp_reward, 30))
    ) as xp_reward
    into v_activity
    from public.unit_activities as activity
    join public.learning_units as unit
      on unit.id = activity.unit_id
    join public.learning_paths as path
      on path.id = unit.path_id
   where activity.id = p_activity_id
     and path.tenant_id = v_profile.tenant_id
     and path.active is true;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'quiz_not_available_for_student';
  end if;

  v_questions := coalesce(
    v_activity.content -> 'questions',
    v_activity.content -> 'exercises',
    '[]'::jsonb
  );
  if pg_catalog.jsonb_typeof(v_questions) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_quiz';
  end if;
  v_total := pg_catalog.jsonb_array_length(v_questions);
  if v_total < 1
     or p_answers is null
     or pg_catalog.cardinality(p_answers) <> v_total then
    raise exception using errcode = '22023', message = 'invalid_answers';
  end if;

  for i in 0 .. v_total - 1 loop
    if (v_questions -> i ->> 'correct') ~ '^[0-9]+$'
       and p_answers[i + 1] =
         (v_questions -> i ->> 'correct')::integer then
      v_correct := v_correct + 1;
    end if;
  end loop;
  v_score := pg_catalog.round(
    (v_correct::numeric / v_total::numeric) * 100
  );
  v_base_xp := v_activity.xp_reward;

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
    'COMPLETED',
    v_score,
    1,
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (student_id, activity_id) do update
    set status = 'COMPLETED',
        score = greatest(
          coalesce(public.student_activity_progress.score, 0),
          excluded.score
        ),
        attempts =
          coalesce(public.student_activity_progress.attempts, 0) + 1,
        completed_at = coalesce(
          public.student_activity_progress.completed_at,
          pg_catalog.now()
        ),
        last_attempt_at = pg_catalog.now();

  select *
    into v_existing_award
    from public.student_verified_xp_awards
   where student_id = v_student_id
     and source_type = 'LEARNING_PATH_QUIZ'
     and source_id = p_activity_id::text;

  if not found and v_score >= 60 then
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
           last_activity = pg_catalog.now()
     where id = v_student_id;
  else
    v_xp_earned := 0;
    v_new_xp := v_profile.xp;
    v_new_level := v_profile.level;
    update public.profiles
       set last_activity = pg_catalog.now()
     where id = v_student_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'score', v_score,
    'xpEarned', v_xp_earned,
    'alreadyAwarded', v_existing_award.id is not null,
    'leveledUp', v_new_level > v_profile.level,
    'newLevel', v_new_level
  );
end;
$$;

revoke all on function public.grade_quiz(uuid, integer[])
  from public, anon;
grant execute on function public.grade_quiz(uuid, integer[])
  to authenticated, service_role;
