-- Atribuição temporária de aulas: um professor assume reposições de um aluno por
-- um período, sem mexer na grade fixa nem no titular.
--
-- O caso (06/11/2026): um professor deixou aulas pendentes; outra professora fica com
-- 1 hora aos sábados (10:30 às 11:30) em novembro e dezembro, e o resto do saldo é
-- distribuído depois. Transferência troca a grade inteira, cobertura vale uma aula
-- do booking de outro professor, e reposição era marcada uma a uma.
--
-- POR QUE GERAR LINHAS EM `reschedules` E NÃO UMA AGENDA NOVA: agenda do professor,
-- Lançar Aula, Pendentes, confirmação de presença, sala oficial, lembrete, Links,
-- histórico e folha já leem reposição com data. Linha nova em tabela nova obrigaria
-- a mexer em todos eles. A atribuição é o "molde + saldo"; cada ocorrência é uma
-- reposição comum, ligada a ela por `temporary_assignment_id`.
--
-- PAGAMENTO: a ocorrência nasce `fault_type = 'TEACHER'` com atestado da direção, o
-- caminho que já existe para "reposição dada por outro professor". Ela vira
-- `REPOSIÇÃO_PROF` e entra em `v_payable_class_logs` sem alterar a view, na tarifa
-- de quem deu a aula (`teacher_student_rate`).
--
-- AULA = 30 MIN: 1 hora são duas linhas (10:30 e 11:00), como dois agendamentos de
-- uma aula de 1 h. O saldo é contado nessa mesma unidade.
--
-- TEXTO LIVRE FICA SÓ NA ATRIBUIÇÃO: professor e aluno leem `reschedules` e
-- `reschedule_events` pela própria RLS. O motivo da direção (que pode falar mal do
-- professor original) não entra nessas tabelas nem nas mensagens.

create table if not exists public.temporary_lesson_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  original_teacher_id uuid not null references public.profiles(id),
  temporary_teacher_id uuid not null references public.profiles(id),
  slots jsonb not null,
  starts_on date not null,
  ends_on date not null,
  lessons_owed integer not null,
  reason text not null,
  status text not null default 'ACTIVE',
  request_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid,
  end_reason text,
  ended_automatically boolean not null default false,
  constraint temporary_lesson_assignments_status_check check (status in ('ACTIVE', 'ENDED')),
  constraint temporary_lesson_assignments_period_check check (ends_on >= starts_on),
  constraint temporary_lesson_assignments_owed_check check (lessons_owed between 1 and 500),
  constraint temporary_lesson_assignments_teachers_check check (temporary_teacher_id <> original_teacher_id),
  constraint temporary_lesson_assignments_request_key unique (tenant_id, request_id)
);
create index if not exists temporary_lesson_assignments_pool_idx
  on public.temporary_lesson_assignments (tenant_id, student_id, original_teacher_id, created_at desc);
create index if not exists temporary_lesson_assignments_active_idx
  on public.temporary_lesson_assignments (status) where status = 'ACTIVE';
comment on table public.temporary_lesson_assignments is
  'Um professor assume reposições de um aluno por um período. Grade fixa e titular não mudam; as aulas são linhas de reschedules. Só por RPC: o motivo não é visível a professor nem a aluno.';
comment on column public.temporary_lesson_assignments.lessons_owed is
  'Saldo total de aulas de 30 min do aluno deixado pelo professor original. Vale o da atribuição mais recente do par aluno + professor original.';

alter table public.temporary_lesson_assignments owner to postgres;
alter table public.temporary_lesson_assignments enable row level security;
revoke all on table public.temporary_lesson_assignments from public, anon, authenticated, service_role;

alter table public.reschedules
  add column if not exists temporary_assignment_id uuid references public.temporary_lesson_assignments(id) on delete set null,
  add column if not exists replaced_by_assignment_id uuid references public.temporary_lesson_assignments(id) on delete set null;
comment on column public.reschedules.temporary_assignment_id is
  'Aula gerada por uma atribuição temporária.';
comment on column public.reschedules.replaced_by_assignment_id is
  'Crédito antigo que uma atribuição temporária substituiu; volta a ficar aberto se a aula gerada for cancelada.';
create index if not exists idx_reschedules_temporary_assignment
  on public.reschedules (temporary_assignment_id) where temporary_assignment_id is not null;
create index if not exists idx_reschedules_replaced_by_assignment
  on public.reschedules (replaced_by_assignment_id) where replaced_by_assignment_id is not null;

-- A checagem de direção mora nesta função, e `postgres` (dono das RPCs abaixo) não
-- estava na ACL dela.
grant execute on function private.quality_school_manager(text) to postgres;

-- ---------------------------------------------------------------------------
-- Horários
-- ---------------------------------------------------------------------------
create or replace function private.temporary_assignment_normalize_slots(p_slots jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_start text;
  v_end text;
  v_out jsonb := '[]'::jsonb;
begin
  if p_slots is null or pg_catalog.jsonb_typeof(p_slots) <> 'array'
     or pg_catalog.jsonb_array_length(p_slots) not between 1 and 14 then
    raise exception using errcode = '22023', message = 'horarios_invalidos';
  end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_slots) loop
    v_start := v_item ->> 'start';
    v_end := v_item ->> 'end';
    if coalesce(v_item ->> 'day_of_week', '') !~ '^[0-6]$'
       or coalesce(v_start, '') !~ '^([01][0-9]|2[0-3]):(00|30)$'
       or coalesce(v_end, '') !~ '^([01][0-9]|2[0-3]):(00|30)$' then
      raise exception using errcode = '22023', message = 'horarios_invalidos';
    end if;
    if v_start::time >= v_end::time or v_end::time - v_start::time > interval '4 hours' then
      raise exception using errcode = '22023', message = 'horarios_invalidos';
    end if;
    v_out := v_out || pg_catalog.jsonb_build_object(
      'day_of_week', (v_item ->> 'day_of_week')::int, 'start', v_start, 'end', v_end);
  end loop;
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(v_out) with ordinality as a(value, position)
      join pg_catalog.jsonb_array_elements(v_out) with ordinality as b(value, position)
        on a.position < b.position
       and a.value ->> 'day_of_week' = b.value ->> 'day_of_week'
       and (a.value ->> 'start')::time < (b.value ->> 'end')::time
       and (b.value ->> 'start')::time < (a.value ->> 'end')::time
  ) then
    raise exception using errcode = '22023', message = 'horarios_sobrepostos';
  end if;
  return (
    select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'day_of_week')::int, item.value ->> 'start')
      from pg_catalog.jsonb_array_elements(v_out) as item
  );
end;
$$;

-- "sábado das 10:30 às 11:30"
create or replace function private.temporary_assignment_slots_text(p_slots jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.string_agg(
    pg_catalog.format('%s das %s às %s',
      (array['domingo','segunda','terça','quarta','quinta','sexta','sábado'])[(item.value ->> 'day_of_week')::int + 1],
      item.value ->> 'start', item.value ->> 'end'),
    ', ' order by (item.value ->> 'day_of_week')::int, item.value ->> 'start')
  from pg_catalog.jsonb_array_elements(p_slots) as item;
$$;

create or replace function private.temporary_assignment_slot_overlaps(p_text text, p_time time)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.left(pg_catalog.btrim(coalesce(p_text, '')), 5) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    then abs(extract(epoch from (pg_catalog.left(pg_catalog.btrim(p_text), 5)::time - p_time))) < 1800
    else false end;
$$;

-- ---------------------------------------------------------------------------
-- Choque de agenda: uma data concreta, não o dia da semana. Reposição de outro
-- sábado não ocupa este sábado. Devolve nulo quando o horário está livre.
-- ---------------------------------------------------------------------------
create or replace function private.temporary_assignment_conflict(
  p_tenant text, p_student uuid, p_teacher uuid, p_date date, p_time time
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_date_text text := pg_catalog.to_char(p_date, 'YYYY-MM-DD');
  v_dow integer := extract(dow from p_date)::integer;
  v_start timestamptz := (p_date + p_time) at time zone 'America/Sao_Paulo';
begin
  -- Professor: aula fixa vigente nessa data, menos a que ele cedeu por cobertura.
  select coalesce(student.full_name, 'aluno') into v_name
    from public.bookings as booking
    left join public.profiles as student on student.id = booking.student_id
    cross join lateral (select public.booking_schedule_on_date(booking.id, p_date) as schedule) as effective
   where booking.tenant_id = p_tenant
     and booking.teacher_id = p_teacher
     and pg_catalog.upper(coalesce(booking.status, '')) = 'SCHEDULED'
     and coalesce((effective.schedule ->> 'valid')::boolean, false)
     and private.temporary_assignment_slot_overlaps(effective.schedule ->> 'time_slot', p_time)
     and not exists (
       select 1 from public.class_coverages as coverage
        where coverage.booking_id = booking.id and coverage.class_date = p_date
          and pg_catalog.lower(coverage.status) = 'confirmed'
          and coverage.cover_teacher_id is distinct from p_teacher)
   limit 1;
  if found then
    return pg_catalog.jsonb_build_object('status', 'PROFESSOR_OCUPADO', 'detail', 'aula fixa de ' || v_name);
  end if;

  select coalesce(student.full_name, 'aluno') into v_name
    from public.reschedules as reschedule
    left join public.profiles as student on student.id = reschedule.student_id
   where reschedule.tenant_id = p_tenant and reschedule.teacher_id = p_teacher
     and reschedule.used_at is null and reschedule.date = v_date_text
     and private.temporary_assignment_slot_overlaps(reschedule.time, p_time)
   limit 1;
  if found then
    return pg_catalog.jsonb_build_object('status', 'PROFESSOR_OCUPADO', 'detail', 'reposição de ' || v_name);
  end if;

  -- Experimental, teste oral e treinamento marcados como agendamento.
  select coalesce(appointment.student_name, 'agendamento') into v_name
    from public.appointments as appointment
   where appointment.tenant_id = p_tenant
     and p_teacher in (appointment.teacher_id, appointment.professor_id)
     and pg_catalog.lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed')
     and appointment.start_time > v_start - interval '30 minutes'
     and appointment.start_time < v_start + interval '30 minutes'
   limit 1;
  if found then
    return pg_catalog.jsonb_build_object('status', 'PROFESSOR_OCUPADO', 'detail', 'agendamento de ' || v_name);
  end if;

  if exists (
    select 1 from public.teacher_training_sessions as training
     where training.tenant_id = p_tenant and p_teacher in (training.trainer_id, training.trainee_id)
       and training.status = 'CONFIRMED'
       and training.starts_at < v_start + interval '30 minutes' and training.ends_at > v_start
  ) then
    return pg_catalog.jsonb_build_object('status', 'PROFESSOR_OCUPADO', 'detail', 'treinamento');
  end if;

  if exists (
    select 1 from public.class_coverages as coverage
     where coverage.tenant_id = p_tenant and coverage.cover_teacher_id = p_teacher
       and coverage.class_date = p_date
       and private.temporary_assignment_slot_overlaps(coverage.class_time, p_time)
       and (pg_catalog.lower(coverage.status) = 'confirmed'
            or (pg_catalog.lower(coverage.status) = 'pending'
                and coalesce(coverage.invite_expires_at, v_start) > pg_catalog.now()))
  ) then
    return pg_catalog.jsonb_build_object('status', 'PROFESSOR_OCUPADO', 'detail', 'cobertura');
  end if;

  if exists (
    select 1 from public.lesson_advances as advance
     where advance.tenant_id = p_tenant and advance.teacher_id = p_teacher
       and advance.status <> 'CANCELLED' and advance.advance_date = p_date
       and advance.advance_time is not null
       and abs(extract(epoch from (advance.advance_time - p_time))) < 1800
  ) then
    return pg_catalog.jsonb_build_object('status', 'PROFESSOR_OCUPADO', 'detail', 'aula antecipada');
  end if;

  -- Horário recorrente segurado para outro aluno.
  if private.future_start_hold_blocks(p_tenant, p_teacher, v_dow, pg_catalog.to_char(p_time, 'HH24:MI'))
     or exists (
       select 1 from private.enrollment_offer_schedule_slots as reserved
        where reserved.tenant_id = p_tenant and reserved.teacher_id = p_teacher
          and reserved.day_of_week = v_dow and reserved.status = 'RESERVED'
          and reserved.reservation_expires_at > pg_catalog.now()
          and abs(extract(epoch from (reserved.class_time - p_time))) < 1800)
     or exists (
       select 1 from private.trial_closing_schedule_holds as hold
        where hold.tenant_id = p_tenant and hold.teacher_id = p_teacher and hold.status = 'HELD'
          and hold.expires_at > pg_catalog.now() and hold.day_of_week = v_dow
          and abs(extract(epoch from (hold.class_time - p_time))) < 1800)
     or exists (
       select 1 from public.teacher_transfers as transfer
        cross join lateral pg_catalog.jsonb_array_elements(transfer.proposed_slots) as slot
        where transfer.tenant_id = p_tenant and transfer.to_teacher_id = p_teacher
          and transfer.student_id is distinct from p_student
          and transfer.status in ('PENDING', 'ACCEPTED') and p_date >= transfer.cutover_date
          and public.dow_name_to_int(slot ->> 'day_of_week') = v_dow
          and private.temporary_assignment_slot_overlaps(slot ->> 'time_slot', p_time))
  then
    return pg_catalog.jsonb_build_object('status', 'PROFESSOR_OCUPADO', 'detail', 'horário reservado para outro aluno');
  end if;

  -- Aluno: não dá para estar em duas aulas, com nenhum professor.
  select coalesce(teacher.full_name, 'professor') into v_name
    from public.bookings as booking
    left join public.profiles as teacher on teacher.id = booking.teacher_id
    cross join lateral (select public.booking_schedule_on_date(booking.id, p_date) as schedule) as effective
   where booking.tenant_id = p_tenant and booking.student_id = p_student
     and pg_catalog.upper(coalesce(booking.status, '')) = 'SCHEDULED'
     and coalesce((effective.schedule ->> 'valid')::boolean, false)
     and private.temporary_assignment_slot_overlaps(effective.schedule ->> 'time_slot', p_time)
   limit 1;
  if found then
    return pg_catalog.jsonb_build_object('status', 'ALUNO_OCUPADO', 'detail', 'aula fixa com ' || v_name);
  end if;

  select coalesce(teacher.full_name, 'professor') into v_name
    from public.reschedules as reschedule
    left join public.profiles as teacher on teacher.id = reschedule.teacher_id
   where reschedule.tenant_id = p_tenant and reschedule.student_id = p_student
     and reschedule.used_at is null and reschedule.date = v_date_text
     and private.temporary_assignment_slot_overlaps(reschedule.time, p_time)
   limit 1;
  if found then
    return pg_catalog.jsonb_build_object('status', 'ALUNO_OCUPADO', 'detail', 'reposição com ' || v_name);
  end if;

  if exists (
    select 1 from public.lesson_advances as advance
     where advance.tenant_id = p_tenant and advance.student_id = p_student
       and advance.status <> 'CANCELLED' and advance.advance_date = p_date
       and advance.advance_time is not null
       and abs(extract(epoch from (advance.advance_time - p_time))) < 1800
  ) then
    return pg_catalog.jsonb_build_object('status', 'ALUNO_OCUPADO', 'detail', 'aula antecipada');
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- O plano: cada ocorrência do período, na ordem, com o que acontece com ela.
-- Preview e criação usam esta mesma função: o que a direção viu é o que nasce.
-- ---------------------------------------------------------------------------
create or replace function private.temporary_assignment_plan(
  p_tenant text, p_student uuid, p_teacher uuid, p_starts date, p_ends date, p_slots jsonb, p_limit integer
)
returns table (class_date date, class_time text, status text, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row record;
  v_conflict jsonb;
  v_used integer := 0;
begin
  for v_row in
    select calendar.day::date as day, slot_time.t::time as t
      from pg_catalog.generate_series(p_starts::timestamp, p_ends::timestamp, interval '1 day') as calendar(day)
      join pg_catalog.jsonb_array_elements(p_slots) as item
        on (item.value ->> 'day_of_week')::int = extract(dow from calendar.day)::int
     cross join lateral pg_catalog.generate_series(
        ('2000-01-01 ' || (item.value ->> 'start'))::timestamp,
        ('2000-01-01 ' || (item.value ->> 'end'))::timestamp - interval '30 minutes',
        interval '30 minutes') as slot_time(t)
     order by 1, 2
  loop
    class_date := v_row.day;
    class_time := pg_catalog.to_char(v_row.t, 'HH24:MI');
    detail := null;
    v_conflict := null;
    if ((v_row.day + v_row.t) at time zone 'America/Sao_Paulo') <= pg_catalog.now() then
      status := 'PASSADO';
    elsif exists (select 1 from public.national_holidays as holiday where holiday.holiday_date = v_row.day) then
      status := 'FERIADO';
      select holiday.name into detail from public.national_holidays as holiday where holiday.holiday_date = v_row.day;
    else
      v_conflict := private.temporary_assignment_conflict(p_tenant, p_student, p_teacher, v_row.day, v_row.t);
      if v_conflict is not null then
        status := v_conflict ->> 'status';
        detail := v_conflict ->> 'detail';
      elsif p_limit is not null and v_used >= p_limit then
        status := 'LIMITE';
      else
        status := 'OK';
        v_used := v_used + 1;
        -- A grade declarada só avisa: a direção combina com a professora por fora.
        if not exists (
          select 1 from public.teacher_availability as availability
           where availability.tenant_id = p_tenant and availability.teacher_id = p_teacher
             and availability.day_of_week = extract(dow from v_row.day)::int
             and availability.start_time = v_row.t
        ) then
          detail := 'fora_da_grade';
        end if;
      end if;
    end if;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Controle: o estado de cada aula vem do lançamento, nunca de um contador.
-- ---------------------------------------------------------------------------
create or replace function private.temporary_assignment_occurrences(p_ids uuid[])
returns table (assignment_id uuid, reschedule_id uuid, class_date text, class_time text, state text)
language sql
stable
security definer
set search_path = ''
as $$
  select reschedule.temporary_assignment_id, reschedule.id, reschedule.date, reschedule.time,
    case
      when reschedule.closed_reason is not null then 'cancelada'
      when log.presence in ('STUDENT_ABSENCE', 'Falta Justificada') then 'aluno_faltou'
      when log.presence in ('TEACHER_ABSENCE', 'Falta do Professor') then 'professor_faltou'
      when log.id is not null then 'realizada'
      when reschedule.used_at is not null then 'cancelada'
      when private.reschedule_slot_start(reschedule.date, reschedule.time) is null then 'sem_data'
      when private.reschedule_slot_start(reschedule.date, reschedule.time) <= pg_catalog.now() then 'a_lancar'
      else 'agendada'
    end
  from public.reschedules as reschedule
  left join public.class_logs as log
    on log.reschedule_id = reschedule.id::text and log.tenant_id = reschedule.tenant_id
  where reschedule.temporary_assignment_id = any (p_ids);
$$;

create or replace function private.temporary_assignment_counts(p_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'total', count(*),
    'agendadas', count(*) filter (where occurrence.state = 'agendada'),
    'a_lancar', count(*) filter (where occurrence.state = 'a_lancar'),
    'sem_data', count(*) filter (where occurrence.state = 'sem_data'),
    'realizadas', count(*) filter (where occurrence.state = 'realizada'),
    'aluno_faltou', count(*) filter (where occurrence.state = 'aluno_faltou'),
    'professor_faltou', count(*) filter (where occurrence.state = 'professor_faltou'),
    'canceladas', count(*) filter (where occurrence.state = 'cancelada'))
  from private.temporary_assignment_occurrences(p_ids) as occurrence;
$$;

-- O saldo é do par aluno + professor original: "as demais aulas serão distribuídas
-- depois" vira outra atribuição, e as duas descontam do mesmo total. Falta do
-- professor temporário não baixa o saldo (a aula continua devida); falta do aluno
-- numa reposição baixa, porque não nasce reposição de reposição.
create or replace function private.temporary_assignment_pool(
  p_tenant text, p_student uuid, p_original uuid, p_owed integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_owed integer;
  v_counts jsonb;
  v_given integer;
  v_on_agenda integer;
begin
  select coalesce(pg_catalog.array_agg(assignment.id), array[]::uuid[]) into v_ids
    from public.temporary_lesson_assignments as assignment
   where assignment.tenant_id = p_tenant and assignment.student_id = p_student
     and assignment.original_teacher_id = p_original;
  select assignment.lessons_owed into v_owed
    from public.temporary_lesson_assignments as assignment
   where assignment.tenant_id = p_tenant and assignment.student_id = p_student
     and assignment.original_teacher_id = p_original
   order by assignment.created_at desc, assignment.id
   limit 1;
  v_owed := coalesce(p_owed, v_owed, 0);
  v_counts := private.temporary_assignment_counts(v_ids);
  v_given := (v_counts ->> 'realizadas')::int + (v_counts ->> 'aluno_faltou')::int;
  v_on_agenda := (v_counts ->> 'agendadas')::int + (v_counts ->> 'a_lancar')::int + (v_counts ->> 'sem_data')::int;
  return v_counts || pg_catalog.jsonb_build_object(
    'owed', v_owed,
    'distribuidas', v_given + v_on_agenda,
    'pendentes', greatest(v_owed - v_given, 0),
    'sem_professor', greatest(v_owed - v_given - v_on_agenda, 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissão e validação (mesmas para preview e criação).
-- ---------------------------------------------------------------------------
create or replace function private.temporary_assignment_require_manager()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := public._my_tenant_id();
begin
  if auth.uid() is null or v_tenant is null
     or not coalesce(private.quality_school_manager(v_tenant), false)
     or not coalesce(public._my_tenant_is_operational(), false) then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  return v_tenant;
end;
$$;

create or replace function private.temporary_assignment_validate(
  p_tenant text, p_student uuid, p_original uuid, p_temporary uuid,
  p_starts date, p_ends date, p_slots jsonb, p_owed integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_slots jsonb := private.temporary_assignment_normalize_slots(p_slots);
  v_occurrences integer;
begin
  if p_starts is null or p_ends is null or p_ends < p_starts or p_starts < v_today or p_ends > p_starts + 366 then
    raise exception using errcode = '22023', message = 'periodo_invalido';
  end if;
  if p_owed is not null and p_owed not between 1 and 500 then
    raise exception using errcode = '22023', message = 'saldo_invalido';
  end if;
  if p_original is null or p_temporary is null or p_original = p_temporary then
    raise exception using errcode = '22023', message = 'professores_iguais';
  end if;
  if not exists (
    select 1 from public.profiles as student
      join public.tenant_memberships as membership
        on membership.user_id = student.id and membership.tenant_id = p_tenant
       and membership.role = 'STUDENT' and membership.status = 'ACTIVE'
     where student.id = p_student and student.tenant_id = p_tenant and student.role = 'STUDENT'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(student.lifecycle_status, ''))) = 'active'
  ) then
    raise exception using errcode = '55000', message = 'aluno_inativo';
  end if;
  if not exists (
    select 1 from public.profiles as teacher
      join public.tenant_memberships as membership
        on membership.user_id = teacher.id and membership.tenant_id = p_tenant
       and membership.role = 'TEACHER' and membership.status = 'ACTIVE'
     where teacher.id = p_temporary and teacher.tenant_id = p_tenant and teacher.role = 'TEACHER'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(teacher.lifecycle_status, ''))) = 'active'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(teacher.status, ''))) in ('ativo', 'active')
  ) then
    raise exception using errcode = '55000', message = 'professor_temporario_inativo';
  end if;
  if not exists (
    select 1 from public.profiles as teacher
     where teacher.id = p_original and teacher.tenant_id = p_tenant and teacher.role = 'TEACHER'
  ) then
    raise exception using errcode = '22023', message = 'professor_original_invalido';
  end if;
  select count(*) into v_occurrences
    from pg_catalog.generate_series(p_starts::timestamp, p_ends::timestamp, interval '1 day') as calendar(day)
    join pg_catalog.jsonb_array_elements(v_slots) as item
      on (item.value ->> 'day_of_week')::int = extract(dow from calendar.day)::int
   cross join lateral pg_catalog.generate_series(
      ('2000-01-01 ' || (item.value ->> 'start'))::timestamp,
      ('2000-01-01 ' || (item.value ->> 'end'))::timestamp - interval '30 minutes',
      interval '30 minutes');
  if v_occurrences = 0 then
    raise exception using errcode = '22023', message = 'periodo_sem_aula';
  end if;
  if v_occurrences > 200 then
    raise exception using errcode = '22023', message = 'periodo_grande_demais';
  end if;
  return v_slots;
end;
$$;

-- A mesma pergunta que o gatilho do termo individual faz numa reposição com data.
create or replace function private.temporary_assignment_term_pending(p_tenant text, p_student uuid, p_teacher uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.student_term_required(p_tenant, null)
    and not private.student_term_covers_reschedule(p_tenant, p_student, p_teacher)
    and not exists (
      select 1 from public.profiles as student
       where student.id = p_student and student.tenant_id = p_tenant
         and (private.student_term_coverage_exempt(p_tenant, p_student, student.professor_id, p_teacher)
              or private.student_term_coverage_exempt(p_tenant, p_student, student.professor_id2, p_teacher)));
$$;

-- ---------------------------------------------------------------------------
-- Avisos: uma mensagem por pessoa, não uma por aula. Cada linha gerada dispararia
-- grupo + família, ~32 mensagens no número da escola.
-- ---------------------------------------------------------------------------
create or replace function private.temporary_assignment_queue(
  p_tenant text, p_teacher uuid, p_student uuid, p_label text, p_destination text, p_body text, p_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_destination is null then return; end if;
  insert into public.notification_queue (tenant_id, teacher_id, student_id, student_name, student_phone,
      message_body, scheduled_for, status, source_type, notification_kind, idempotency_key)
  values (p_tenant, p_teacher, p_student, p_label, p_destination, p_body, pg_catalog.now(), 'pending',
      'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', p_key)
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
exception when others then
  -- Falha no aviso não desfaz a agenda. O painel mostra o que foi gerado.
  raise warning '[atribuição temporária] aviso não enfileirado (%): %', p_key, sqlerrm;
end;
$$;

create or replace function private.temporary_assignment_notify(
  p_id uuid, p_event text, p_actor uuid, p_first date, p_last date, p_closed integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.temporary_lesson_assignments%rowtype;
  v_student public.profiles%rowtype;
  v_teacher public.profiles%rowtype;
  v_original_name text;
  v_actor_name text;
  v_director uuid;
  v_counts jsonb;
  v_pool jsonb;
  v_group text;
  v_family text;
  v_teacher_phone text;
  v_slots text;
  v_student_first text;
  v_teacher_first text;
  v_key text;
begin
  select * into v_row from public.temporary_lesson_assignments where id = p_id;
  select * into v_student from public.profiles where id = v_row.student_id;
  select * into v_teacher from public.profiles where id = v_row.temporary_teacher_id;
  -- Nome com espaço sobrando no cadastro não pode aparecer na mensagem.
  v_student.full_name := pg_catalog.btrim(v_student.full_name);
  v_teacher.full_name := pg_catalog.btrim(v_teacher.full_name);
  select pg_catalog.btrim(full_name) into v_original_name from public.profiles where id = v_row.original_teacher_id;
  select pg_catalog.btrim(full_name) into v_actor_name from public.profiles where id = p_actor;
  v_director := private.management_group_default_actor(v_row.tenant_id);
  v_counts := private.temporary_assignment_counts(array[p_id]);
  v_pool := private.temporary_assignment_pool(v_row.tenant_id, v_row.student_id, v_row.original_teacher_id);
  v_slots := private.temporary_assignment_slots_text(v_row.slots);
  v_student_first := pg_catalog.split_part(pg_catalog.btrim(coalesce(v_student.full_name, 'aluno')), ' ', 1);
  v_teacher_first := pg_catalog.split_part(pg_catalog.btrim(coalesce(v_teacher.full_name, 'professor')), ' ', 1);
  v_key := pg_catalog.format('temporary-assignment:%s:%s:', p_id, p_event);
  v_group := private.tenant_notice_destination(v_row.tenant_id, 'coordenacao');
  v_teacher_phone := private.whatsapp_digits(nullif(v_teacher.phone, ''));
  if public.is_student_notifiable(v_row.student_id) then
    v_family := private.whatsapp_digits(coalesce(nullif(v_student.attendance_phone, ''), nullif(v_student.phone, ''), nullif(v_student.guardian_phone, '')));
  end if;

  if p_event = 'created' then
    perform private.temporary_assignment_queue(v_row.tenant_id, coalesce(v_director, v_row.temporary_teacher_id), v_row.student_id,
      'Coordenação', v_group,
      pg_catalog.format(E'🔁 *Atribuição temporária* · %s\nDe %s para %s · %s\n%s a %s · %s aulas de 30 min na agenda · saldo de %s · %s ainda sem professor\nA grade fixa do aluno não muda.\nPor %s',
        coalesce(v_student.full_name, 'aluno'), coalesce(v_original_name, '?'), coalesce(v_teacher.full_name, '?'), v_slots,
        pg_catalog.to_char(p_first, 'DD/MM'), pg_catalog.to_char(p_last, 'DD/MM'),
        v_counts ->> 'total', v_pool ->> 'owed', v_pool ->> 'sem_professor', coalesce(v_actor_name, 'direção')),
      v_key || 'group');
    perform private.temporary_assignment_queue(v_row.tenant_id, v_row.temporary_teacher_id, v_row.student_id,
      coalesce(v_teacher.full_name, 'Professor'), v_teacher_phone,
      pg_catalog.format(E'Oi, %s! 🐺 A escola te atribuiu, temporariamente, reposições de %s: %s, de %s a %s (%s aulas de 30 min).\n\nElas já estão na sua Agenda e entram em Lançar Aula depois de cada horário. O professor titular do aluno não muda. Qualquer dúvida, fale com a coordenação.',
        v_teacher_first, coalesce(v_student.full_name, 'aluno'), v_slots,
        pg_catalog.to_char(p_first, 'DD/MM'), pg_catalog.to_char(p_last, 'DD/MM'), v_counts ->> 'total'),
      v_key || 'teacher');
    perform private.temporary_assignment_queue(v_row.tenant_id, coalesce(v_director, v_row.temporary_teacher_id), v_row.student_id,
      coalesce(v_student.full_name, 'Aluno'), v_family,
      pg_catalog.format('Oi, %s! 🐺 De %s a %s suas reposições serão com teacher %s: %s. Os horários já estão na sua agenda e a sua grade normal continua igual. Qualquer dúvida, é só responder aqui.',
        v_student_first, pg_catalog.to_char(p_first, 'DD/MM'), pg_catalog.to_char(p_last, 'DD/MM'), v_teacher_first, v_slots),
      v_key || 'family');
  elsif p_event = 'ended' then
    perform private.temporary_assignment_queue(v_row.tenant_id, coalesce(v_director, v_row.temporary_teacher_id), v_row.student_id,
      'Coordenação', v_group,
      pg_catalog.format(E'⏹️ *Atribuição temporária encerrada* · %s · %s\n%s realizadas · %s canceladas · %s a lançar · saldo pendente de %s\nPor %s',
        coalesce(v_student.full_name, 'aluno'), coalesce(v_teacher.full_name, '?'),
        v_counts ->> 'realizadas', v_counts ->> 'canceladas', v_counts ->> 'a_lancar', v_pool ->> 'pendentes',
        coalesce(v_actor_name, 'direção')),
      v_key || 'group');
    if p_closed > 0 then
      perform private.temporary_assignment_queue(v_row.tenant_id, v_row.temporary_teacher_id, v_row.student_id,
        coalesce(v_teacher.full_name, 'Professor'), v_teacher_phone,
        pg_catalog.format('Oi, %s! 🐺 A atribuição temporária de %s terminou e as próximas reposições saíram da sua agenda. Aula já dada e ainda sem lançamento continua em Pendentes.',
          v_teacher_first, coalesce(v_student.full_name, 'aluno')),
        v_key || 'teacher');
      perform private.temporary_assignment_queue(v_row.tenant_id, coalesce(v_director, v_row.temporary_teacher_id), v_row.student_id,
        coalesce(v_student.full_name, 'Aluno'), v_family,
        pg_catalog.format('Oi, %s! 🐺 As próximas reposições com teacher %s foram canceladas. A escola vai combinar com você a continuação. Sua grade normal continua igual.',
          v_student_first, v_teacher_first),
        v_key || 'family');
    end if;
  else
    -- Fim natural do período: só a coordenação precisa saber o que sobrou.
    perform private.temporary_assignment_queue(v_row.tenant_id, coalesce(v_director, v_row.temporary_teacher_id), v_row.student_id,
      'Coordenação', v_group,
      pg_catalog.format(E'🏁 *Atribuição temporária terminou* · %s · %s\n%s realizadas · %s a lançar · saldo pendente de %s · %s sem professor',
        coalesce(v_student.full_name, 'aluno'), coalesce(v_teacher.full_name, '?'),
        v_counts ->> 'realizadas', v_counts ->> 'a_lancar', v_pool ->> 'pendentes', v_pool ->> 'sem_professor'),
      v_key || 'group');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Encerrar: as aulas que ainda não aconteceram saem da agenda. A que já passou e
-- não foi lançada fica aberta, porque o professor ainda precisa lançar.
--
-- `date = 'Pendente'` na hora de fechar não é detalhe: `upcoming_classes` (de
-- propósito) e o Lançar Aula não olham `used_at`. Com a data mantida, o aluno
-- receberia o link "a aula aconteceu?" de um sábado cancelado e a professora veria
-- a aula para lançar. A data antiga fica na trilha (`reschedule_events.from_date`).
-- ---------------------------------------------------------------------------
create or replace function private.temporary_assignment_finish(
  p_id uuid, p_actor uuid, p_reason text, p_automatic boolean, p_notify boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.temporary_lesson_assignments%rowtype;
  v_closed integer;
  v_reopened integer;
begin
  select * into v_row from public.temporary_lesson_assignments where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'atribuicao_nao_encontrada';
  end if;
  if v_row.status <> 'ACTIVE' then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true, 'id', p_id);
  end if;

  perform pg_catalog.set_config('app.reschedule_silent', 'on', true);
  perform pg_catalog.set_config('app.reschedule_close', 'on', true);
  perform pg_catalog.set_config('app.reschedule_source', case when p_automatic then 'sistema' else 'direcao' end, true);
  perform pg_catalog.set_config('app.reschedule_reason', 'Atribuição temporária encerrada', true);

  update public.reschedules as reschedule
     set used_at = pg_catalog.now(), closed_by = p_actor,
         closed_reason = 'Atribuição temporária encerrada',
         date = 'Pendente', time = 'Pendente'
   where reschedule.temporary_assignment_id = p_id
     and reschedule.used_at is null
     and coalesce(private.reschedule_slot_start(reschedule.date, reschedule.time) > pg_catalog.now(), true);
  get diagnostics v_closed = row_count;

  -- Crédito antigo volta a ficar aberto na medida das aulas canceladas.
  update public.reschedules as reschedule
     set used_at = null, closed_by = null, closed_reason = null, replaced_by_assignment_id = null
   where reschedule.id in (
     select credit.id from public.reschedules as credit
      where credit.replaced_by_assignment_id = p_id
      order by credit.created_at desc, credit.id
      limit v_closed);
  get diagnostics v_reopened = row_count;

  perform pg_catalog.set_config('app.reschedule_silent', '', true);
  perform pg_catalog.set_config('app.reschedule_close', '', true);
  perform pg_catalog.set_config('app.reschedule_source', '', true);
  perform pg_catalog.set_config('app.reschedule_reason', '', true);

  update public.temporary_lesson_assignments
     set status = 'ENDED', ended_at = pg_catalog.now(), ended_by = p_actor,
         end_reason = p_reason, ended_automatically = p_automatic
   where id = p_id;

  if p_notify then
    perform private.temporary_assignment_notify(p_id, case when p_automatic then 'finished' else 'ended' end, p_actor, null, null, v_closed);
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'closed', v_closed, 'reopened_credits', v_reopened);
end;
$$;

-- Termina quando não há mais aula por vir: o período acabou, ou todas as aulas já
-- passaram. Uma falha não impede as demais.
create or replace function private.end_due_temporary_assignments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_row record;
  v_ended integer := 0;
begin
  for v_row in
    select assignment.id, assignment.tenant_id
      from public.temporary_lesson_assignments as assignment
     where assignment.status = 'ACTIVE'
       and not exists (
         select 1 from public.reschedules as reschedule
          where reschedule.temporary_assignment_id = assignment.id and reschedule.used_at is null
            and private.reschedule_slot_start(reschedule.date, reschedule.time) > pg_catalog.now())
       and (assignment.ends_on < v_today
            or not exists (
              select 1 from public.reschedules as reschedule
               where reschedule.temporary_assignment_id = assignment.id and reschedule.used_at is null
                 and private.reschedule_slot_start(reschedule.date, reschedule.time) is null))
  loop
    begin
      perform private.temporary_assignment_finish(v_row.id,
        private.management_group_default_actor(v_row.tenant_id), 'Fim do período', true, true);
      v_ended := v_ended + 1;
    exception when others then
      raise warning '[atribuição temporária] % não encerrada: %', v_row.id, sqlerrm;
    end;
  end loop;
  return v_ended;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs da tela
-- ---------------------------------------------------------------------------
create or replace function public.temporary_assignment_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.temporary_assignment_require_manager();
  v_test boolean;
begin
  select coalesce(actor.is_test_account, false) into v_test from public.profiles as actor where actor.id = auth.uid();
  return pg_catalog.jsonb_build_object(
    'students', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', student.id, 'name', student.full_name, 'titular_id', student.professor_id,
          'titular_name', titular.full_name) order by student.full_name)
        from public.profiles as student
        left join public.profiles as titular on titular.id = student.professor_id
       where student.tenant_id = v_tenant and student.role = 'STUDENT'
         and pg_catalog.lower(pg_catalog.btrim(coalesce(student.lifecycle_status, ''))) = 'active'
         and coalesce(student.is_test_account, false) = v_test), '[]'::jsonb),
    -- Professor suspenso ou que saiu pode ter deixado aulas: entra como origem,
    -- nunca como quem assume.
    'teachers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', teacher.id, 'name', teacher.full_name, 'lifecycle_status', teacher.lifecycle_status,
          'can_assign', pg_catalog.lower(pg_catalog.btrim(coalesce(teacher.lifecycle_status, ''))) = 'active'
            and pg_catalog.lower(pg_catalog.btrim(coalesce(teacher.status, ''))) in ('ativo', 'active')
            and exists (select 1 from public.tenant_memberships as membership
                         where membership.user_id = teacher.id and membership.tenant_id = v_tenant
                           and membership.role = 'TEACHER' and membership.status = 'ACTIVE'))
          order by teacher.full_name)
        from public.profiles as teacher
       where teacher.tenant_id = v_tenant and teacher.role = 'TEACHER'
         and coalesce(teacher.is_test_account, false) = v_test), '[]'::jsonb));
end;
$$;

create or replace function public.preview_temporary_assignment(
  p_student_id uuid, p_original_teacher_id uuid, p_temporary_teacher_id uuid,
  p_starts_on date, p_ends_on date, p_slots jsonb, p_lessons_owed integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.temporary_assignment_require_manager();
  v_slots jsonb;
  v_pool jsonb;
  v_open_total integer;
  v_open_teacher integer;
  v_available integer;
  v_owed integer;
  v_limit integer;
  v_occurrences jsonb;
begin
  v_slots := private.temporary_assignment_validate(v_tenant, p_student_id, p_original_teacher_id,
    p_temporary_teacher_id, p_starts_on, p_ends_on, p_slots, p_lessons_owed);
  v_pool := private.temporary_assignment_pool(v_tenant, p_student_id, p_original_teacher_id);
  select count(*), count(*) filter (where credit.fault_type = 'TEACHER')
    into v_open_total, v_open_teacher
    from public.reschedules as credit
   where credit.tenant_id = v_tenant and credit.student_id = p_student_id
     and credit.teacher_id = p_original_teacher_id and credit.used_at is null
     and private.reschedule_slot_start(credit.date, credit.time) is null;
  select count(*) into v_available
    from private.temporary_assignment_plan(v_tenant, p_student_id, p_temporary_teacher_id, p_starts_on, p_ends_on, v_slots, null) as plan
   where plan.status = 'OK';
  -- Sem saldo informado, a sugestão é o que já se sabe dever.
  v_owed := coalesce(p_lessons_owed,
    nullif((v_pool ->> 'owed')::int, 0),
    greatest(v_open_total, v_available, 1));
  v_limit := greatest(v_owed - (v_pool ->> 'distribuidas')::int, 0);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'date', plan.class_date, 'time', plan.class_time, 'status', plan.status, 'detail', plan.detail)
      order by plan.class_date, plan.class_time), '[]'::jsonb)
    into v_occurrences
    from private.temporary_assignment_plan(v_tenant, p_student_id, p_temporary_teacher_id, p_starts_on, p_ends_on, v_slots, v_limit) as plan;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'occurrences', v_occurrences,
    'generated', (select count(*) from pg_catalog.jsonb_array_elements(v_occurrences) as item where item.value ->> 'status' = 'OK'),
    'owed', v_owed,
    'limit', v_limit,
    'pool', v_pool,
    'open_credits', v_open_total,
    'open_credits_teacher_fault', v_open_teacher,
    'term_pending', private.temporary_assignment_term_pending(v_tenant, p_student_id, p_temporary_teacher_id),
    'slots_text', private.temporary_assignment_slots_text(v_slots));
end;
$$;

create or replace function public.create_temporary_assignment(
  p_student_id uuid, p_original_teacher_id uuid, p_temporary_teacher_id uuid,
  p_starts_on date, p_ends_on date, p_slots jsonb, p_lessons_owed integer,
  p_reason text, p_request_id uuid, p_notify boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.temporary_assignment_require_manager();
  v_actor uuid := auth.uid();
  v_reason text := nullif(left(pg_catalog.btrim(coalesce(p_reason, '')), 500), '');
  v_existing public.temporary_lesson_assignments%rowtype;
  v_slots jsonb;
  v_pool jsonb;
  v_available integer;
  v_open_total integer;
  v_owed integer;
  v_limit integer;
  v_id uuid;
  v_generated integer;
  v_absorbed integer;
  v_first date;
  v_last date;
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'pedido_invalido';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;
  -- Dois cliques, ou duas pessoas distribuindo o mesmo saldo ao mesmo tempo.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('temporary-assignment:' || p_student_id::text, 0));
  select * into v_existing from public.temporary_lesson_assignments
   where tenant_id = v_tenant and request_id = p_request_id;
  if found then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true, 'id', v_existing.id);
  end if;

  v_slots := private.temporary_assignment_validate(v_tenant, p_student_id, p_original_teacher_id,
    p_temporary_teacher_id, p_starts_on, p_ends_on, p_slots, p_lessons_owed);
  v_pool := private.temporary_assignment_pool(v_tenant, p_student_id, p_original_teacher_id);
  select count(*) into v_available
    from private.temporary_assignment_plan(v_tenant, p_student_id, p_temporary_teacher_id, p_starts_on, p_ends_on, v_slots, null) as plan
   where plan.status = 'OK';
  select count(*) into v_open_total
    from public.reschedules as credit
   where credit.tenant_id = v_tenant and credit.student_id = p_student_id
     and credit.teacher_id = p_original_teacher_id and credit.used_at is null
     and private.reschedule_slot_start(credit.date, credit.time) is null;
  v_owed := coalesce(p_lessons_owed,
    nullif((v_pool ->> 'owed')::int, 0),
    greatest(v_open_total, v_available, 1));
  v_limit := v_owed - (v_pool ->> 'distribuidas')::int;
  if v_limit <= 0 then
    raise exception using errcode = '22023', message = 'saldo_ja_distribuido';
  end if;
  if v_available = 0 then
    raise exception using errcode = '23P01', message = 'nenhuma_aula_disponivel';
  end if;

  insert into public.temporary_lesson_assignments (tenant_id, student_id, original_teacher_id, temporary_teacher_id,
      slots, starts_on, ends_on, lessons_owed, reason, request_id, created_by)
  values (v_tenant, p_student_id, p_original_teacher_id, p_temporary_teacher_id,
      v_slots, p_starts_on, p_ends_on, v_owed, v_reason, p_request_id, v_actor)
  returning id into v_id;

  -- Texto neutro: professor e aluno leem estas linhas. O motivo fica na atribuição.
  perform pg_catalog.set_config('app.reschedule_silent', 'on', true);
  perform pg_catalog.set_config('app.reschedule_source', 'direcao', true);
  perform pg_catalog.set_config('app.reschedule_reason', 'Atribuição temporária', true);

  insert into public.reschedules (tenant_id, teacher_id, student_id, date, time, fault_type,
      attested_by, attested_at, attestation_reason, temporary_assignment_id)
  select v_tenant, p_temporary_teacher_id, p_student_id,
         pg_catalog.to_char(plan.class_date, 'YYYY-MM-DD'), plan.class_time, 'TEACHER',
         v_actor, pg_catalog.now(), 'Atribuição temporária definida pela escola', v_id
    from private.temporary_assignment_plan(v_tenant, p_student_id, p_temporary_teacher_id, p_starts_on, p_ends_on, v_slots, v_limit) as plan
   where plan.status = 'OK'
   order by plan.class_date, plan.class_time;
  get diagnostics v_generated = row_count;

  select min(reschedule.date::date), max(reschedule.date::date) into v_first, v_last
    from public.reschedules as reschedule where reschedule.temporary_assignment_id = v_id;

  -- A aula devida agora tem data e professor: o crédito antigo, sem data, sairia em
  -- dobro nos contadores e na tela do aluno.
  perform pg_catalog.set_config('app.reschedule_close', 'on', true);
  perform pg_catalog.set_config('app.reschedule_reason', 'Substituída por reposição agendada', true);
  update public.reschedules as reschedule
     set used_at = pg_catalog.now(), closed_by = v_actor,
         closed_reason = 'Substituída por reposição agendada', replaced_by_assignment_id = v_id
   where reschedule.id in (
     select credit.id from public.reschedules as credit
      where credit.tenant_id = v_tenant and credit.student_id = p_student_id
        and credit.teacher_id = p_original_teacher_id and credit.used_at is null
        and private.reschedule_slot_start(credit.date, credit.time) is null
      order by credit.created_at, credit.id
      limit v_generated);
  get diagnostics v_absorbed = row_count;

  perform pg_catalog.set_config('app.reschedule_silent', '', true);
  perform pg_catalog.set_config('app.reschedule_close', '', true);
  perform pg_catalog.set_config('app.reschedule_source', '', true);
  perform pg_catalog.set_config('app.reschedule_reason', '', true);

  if p_notify then
    perform private.temporary_assignment_notify(v_id, 'created', v_actor, v_first, v_last, 0);
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'id', v_id, 'generated', v_generated,
    'absorbed_credits', v_absorbed, 'first_date', v_first, 'last_date', v_last,
    'pool', private.temporary_assignment_pool(v_tenant, p_student_id, p_original_teacher_id));
end;
$$;

create or replace function public.end_temporary_assignment(p_id uuid, p_reason text, p_notify boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.temporary_assignment_require_manager();
  v_reason text := nullif(left(pg_catalog.btrim(coalesce(p_reason, '')), 500), '');
begin
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;
  if not exists (select 1 from public.temporary_lesson_assignments as assignment
                  where assignment.id = p_id and assignment.tenant_id = v_tenant) then
    raise exception using errcode = 'P0002', message = 'atribuicao_nao_encontrada';
  end if;
  return private.temporary_assignment_finish(p_id, auth.uid(), v_reason, false, coalesce(p_notify, true));
end;
$$;

create or replace function public.list_temporary_assignments(p_student_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.temporary_assignment_require_manager();
begin
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', assignment.id,
        'status', assignment.status,
        'student_id', assignment.student_id,
        'student_name', student.full_name,
        'original_teacher_id', assignment.original_teacher_id,
        'original_teacher_name', original.full_name,
        'temporary_teacher_id', assignment.temporary_teacher_id,
        'temporary_teacher_name', temp_teacher.full_name,
        'slots', assignment.slots,
        'slots_text', private.temporary_assignment_slots_text(assignment.slots),
        'starts_on', assignment.starts_on,
        'ends_on', assignment.ends_on,
        'lessons_owed', assignment.lessons_owed,
        'reason', assignment.reason,
        'created_at', assignment.created_at,
        'created_by_name', creator.full_name,
        'ended_at', assignment.ended_at,
        'ended_by_name', ender.full_name,
        'end_reason', assignment.end_reason,
        'ended_automatically', assignment.ended_automatically,
        'participants_active',
          pg_catalog.lower(pg_catalog.btrim(coalesce(student.lifecycle_status, ''))) = 'active'
          and pg_catalog.lower(pg_catalog.btrim(coalesce(temp_teacher.lifecycle_status, ''))) = 'active',
        'counts', private.temporary_assignment_counts(array[assignment.id]),
        'pool', private.temporary_assignment_pool(assignment.tenant_id, assignment.student_id, assignment.original_teacher_id),
        'occurrences', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', occurrence.reschedule_id, 'date', occurrence.class_date,
              'time', occurrence.class_time, 'state', occurrence.state)
              order by occurrence.class_date, occurrence.class_time)
            from private.temporary_assignment_occurrences(array[assignment.id]) as occurrence
           where occurrence.state <> 'cancelada'), '[]'::jsonb))
        order by (assignment.status = 'ACTIVE') desc, assignment.created_at desc)
      from (
        select recent.* from public.temporary_lesson_assignments as recent
         where recent.tenant_id = v_tenant and (p_student_id is null or recent.student_id = p_student_id)
         order by (recent.status = 'ACTIVE') desc, recent.created_at desc
         limit 100
      ) as assignment
      join public.profiles as student on student.id = assignment.student_id
      join public.profiles as original on original.id = assignment.original_teacher_id
      join public.profiles as temp_teacher on temp_teacher.id = assignment.temporary_teacher_id
      left join public.profiles as creator on creator.id = assignment.created_by
      left join public.profiles as ender on ender.id = assignment.ended_by
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Donos e permissões
-- ---------------------------------------------------------------------------
do $grants$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
     where n.nspname = 'private'
       and (p.proname like 'temporary\_assignment\_%' or p.proname = 'end_due_temporary_assignments')
  loop
    execute format('alter function %s owner to postgres', r.signature);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.signature);
    execute format('grant execute on function %s to postgres', r.signature);
  end loop;
  for r in
    select p.oid::regprocedure as signature
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('temporary_assignment_options', 'preview_temporary_assignment',
                         'create_temporary_assignment', 'end_temporary_assignment', 'list_temporary_assignments')
  loop
    execute format('alter function %s owner to postgres', r.signature);
    execute format('revoke all on function %s from public, anon, service_role', r.signature);
    execute format('grant execute on function %s to authenticated', r.signature);
  end loop;
end;
$grants$;

select cron.schedule('wisewolf-temporary-assignments-end', '20 9 * * *', 'select private.end_due_temporary_assignments();');

notify pgrst, 'reload schema';
