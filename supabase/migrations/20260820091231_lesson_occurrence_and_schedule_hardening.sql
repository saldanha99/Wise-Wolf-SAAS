-- Uma ocorrencia de aula e identificada por aluno + professor + data + horario.
-- O booking_id sozinho nao basta: ao recriar um horario, o ID muda e a mesma
-- aula pode ser paga duas vezes (caso real de 11/08/2026). Ao mesmo tempo, um
-- aluno pode legitimamente ter 16:30 e 17:00 no mesmo dia (caso Victor).

alter table public.class_logs
  add column if not exists start_time time without time zone;

-- Status nulo era tratado como ativo por leitores legados, mas escapava dos
-- indices parciais. Canoniza antes de tornar a regra estrutural.
update public.bookings
   set status = 'SCHEDULED'
 where status is null;

alter table public.bookings
  alter column status set default 'SCHEDULED',
  alter column status set not null;

create or replace function public.canonical_weekday_name(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case public.dow_name_to_int(p_value)
    when 0 then 'Domingo'
    when 1 then 'Segunda'
    when 2 then 'Terça'
    when 3 then 'Quarta'
    when 4 then 'Quinta'
    when 5 then 'Sexta'
    when 6 then 'Sábado'
    else null
  end
$$;

comment on function public.canonical_weekday_name(text) is
  'Converte nomes de dia PT/EN, com ou sem acento/-feira, para a grafia canonica usada em bookings.';

create or replace function public.normalize_booking_occurrence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_day text;
  v_time text;
begin
  v_day := public.canonical_weekday_name(new.day_of_week);
  if v_day is null then
    raise exception using errcode = '23514', message = 'invalid_booking_weekday';
  end if;

  v_time := pg_catalog.btrim(new.time_slot);
  if v_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$' then
    raise exception using errcode = '23514', message = 'invalid_booking_time';
  end if;

  new.day_of_week := v_day;
  new.time_slot := pg_catalog.to_char(v_time::time, 'HH24:MI');
  return new;
end;
$$;

-- Corrige a grafia legada (Terca/Terça, Sabado/Sábado) antes de reforcar a
-- unicidade. Se houver uma duplicata ativa canonica, o indice abaixo falha com
-- seguranca e impede que a migration esconda ou apague dados automaticamente.
update public.bookings
   set day_of_week = public.canonical_weekday_name(day_of_week),
       time_slot = pg_catalog.to_char(pg_catalog.btrim(time_slot)::time, 'HH24:MI')
 where public.canonical_weekday_name(day_of_week) is not null
   and pg_catalog.btrim(time_slot) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
   and (
     day_of_week is distinct from public.canonical_weekday_name(day_of_week)
     or time_slot is distinct from pg_catalog.to_char(pg_catalog.btrim(time_slot)::time, 'HH24:MI')
   );

drop trigger if exists trg_normalize_booking_occurrence on public.bookings;
create trigger trg_normalize_booking_occurrence
before insert or update of day_of_week, time_slot on public.bookings
for each row execute function public.normalize_booking_occurrence();

create unique index if not exists uq_bookings_active_canonical_occurrence
  on public.bookings (
    tenant_id,
    student_id,
    teacher_id,
    (public.dow_name_to_int(day_of_week)),
    (pg_catalog.left(time_slot, 5))
  )
  where status = 'SCHEDULED' and student_id is not null;

-- Um aluno nao pode ocupar o mesmo slot com dois professores. Nao existe o
-- indice equivalente para professor: TREINAMENTO e aula regular podem ocupar
-- legitimamente o mesmo horario operacional.
create unique index if not exists uq_bookings_active_student_slot
  on public.bookings (
    tenant_id,
    student_id,
    (public.dow_name_to_int(day_of_week)),
    (pg_catalog.left(time_slot, 5))
  )
  where status = 'SCHEDULED' and student_id is not null;

-- O snapshot enviado ao aluno e a fonte historica mais forte: o booking pode
-- ter mudado de horario depois da aula. Primeiro casa pelo class_log_id e, para
-- registros antigos ainda sem vinculo, pela origem + data.
with confirmation_times as (
  select distinct on (cl.id)
         cl.id as class_log_id,
         pg_catalog.left(pg_catalog.btrim(ac.class_time), 5)::time as start_time
    from public.class_logs cl
    join public.attendance_confirmations ac
      on ac.class_log_id = cl.id
      or (
        ac.class_date = cl.class_date
        and ac.teacher_id = cl.teacher_id
        and ac.student_id is not distinct from cl.student_id
        and (
          (ac.source_type = 'booking' and ac.source_id = cl.booking_id)
          or (ac.source_type = 'reschedule' and ac.source_id = cl.reschedule_id)
          or (ac.source_type = 'appointment' and ac.source_id = cl.appointment_id)
        )
      )
   where cl.start_time is null
     and pg_catalog.btrim(ac.class_time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
   order by cl.id, (ac.class_log_id = cl.id) desc nulls last, ac.created_at desc, ac.id desc
)
update public.class_logs cl
   set start_time = ct.start_time
  from confirmation_times ct
 where cl.id = ct.class_log_id
   and cl.start_time is null;

-- Fontes mutaveis sao apenas fallback para registros sem snapshot.
update public.class_logs cl
   set start_time = pg_catalog.left(pg_catalog.btrim(b.time_slot), 5)::time
  from public.bookings b
 where cl.start_time is null
   and cl.booking_id is not null
   and b.id::text = cl.booking_id
   and pg_catalog.btrim(b.time_slot) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$';

update public.class_logs cl
   set start_time = pg_catalog.left(pg_catalog.btrim(r.time), 5)::time
  from public.reschedules r
 where cl.start_time is null
   and cl.reschedule_id is not null
   and r.id::text = cl.reschedule_id
   and pg_catalog.btrim(r.time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$';

update public.class_logs cl
   set start_time = (a.start_time at time zone 'America/Sao_Paulo')::time
  from public.appointments a
 where cl.start_time is null
   and cl.appointment_id is not null
   and a.id::text = cl.appointment_id
   and a.start_time is not null;

-- `reschedules.date` e texto no schema legado. Datas efetivamente marcadas
-- aparecem em ISO, mas houve clientes antigos em DD/MM/YYYY; `Pendente` e
-- qualquer calendario invalido precisam resultar em NULL, nunca em uma data
-- escolhida permissivamente por `to_date`.
create or replace function public.parse_lesson_date(p_value text)
returns date
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_value text := pg_catalog.btrim(p_value);
begin
  if v_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return pg_catalog.make_date(
      pg_catalog.substr(v_value, 1, 4)::int,
      pg_catalog.substr(v_value, 6, 2)::int,
      pg_catalog.substr(v_value, 9, 2)::int
    );
  elsif v_value ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then
    return pg_catalog.make_date(
      pg_catalog.substr(v_value, 7, 4)::int,
      pg_catalog.substr(v_value, 4, 2)::int,
      pg_catalog.substr(v_value, 1, 2)::int
    );
  end if;

  return null;
exception when others then
  return null;
end;
$$;

create or replace function public.fill_class_log_occurrence_time()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_time text;
  v_supplied_time time := new.start_time;
  v_authoritative_time time;
  v_confirmation_time time;
  v_source_date date;
  v_slot_day int;
  v_appt_type text;
  v_source_count int;
begin
  v_source_count := pg_catalog.num_nonnulls(
    new.booking_id, new.reschedule_id, new.appointment_id
  );

  -- Logs puramente administrativos/legados continuam fora desta regra. Uma
  -- ocorrencia que declara origem, porem, deve declarar exatamente uma.
  if v_source_count = 0 then
    return new;
  elsif v_source_count <> 1 then
    raise exception using
      errcode = '23514',
      message = 'class_log_must_have_exactly_one_source';
  end if;

  if new.class_date is null then
    raise exception using
      errcode = '23514',
      message = 'class_log_source_date_required';
  end if;

  if new.booking_id is not null then
    select pg_catalog.left(pg_catalog.btrim(b.time_slot), 5)::time
      into v_authoritative_time
      from public.bookings b
     where b.id::text = new.booking_id
       and b.tenant_id = new.tenant_id
       and b.status = 'SCHEDULED'
       and b.student_id is not null
       and b.student_id = new.student_id
       and b.start_date is not null
       and b.start_date <= new.class_date
       and public.dow_name_to_int(b.day_of_week) = extract(dow from new.class_date)::int
       and pg_catalog.btrim(b.time_slot) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
       and (
         (
           b.teacher_id = new.teacher_id
           and not exists (
             select 1
               from public.class_coverages c
              where c.booking_id = b.id
                and c.tenant_id = new.tenant_id
                and c.class_date = new.class_date
                and c.status = 'confirmed'
                and c.cover_teacher_id is distinct from new.teacher_id
           )
         )
         or exists (
           select 1
             from public.class_coverages c
            where c.booking_id = b.id
              and c.tenant_id = new.tenant_id
              and c.class_date = new.class_date
              and c.status = 'confirmed'
              and c.cover_teacher_id = new.teacher_id
         )
       )
     limit 1;

    if not found then
      raise exception using
        errcode = '23514',
        message = 'class_log_booking_origin_invalid';
    end if;

  elsif new.reschedule_id is not null then
    select pg_catalog.left(pg_catalog.btrim(r.time), 5)::time
      into v_authoritative_time
      from public.reschedules r
     where r.id::text = new.reschedule_id
       and r.tenant_id = new.tenant_id
       and r.teacher_id = new.teacher_id
       and r.student_id = new.student_id
       and public.parse_lesson_date(r.date) = new.class_date
       and (
         r.used_at is null
         or (
           tg_op = 'UPDATE'
           and old.reschedule_id is not distinct from new.reschedule_id
         )
       )
       and pg_catalog.btrim(r.time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
     limit 1;

    if not found then
      raise exception using
        errcode = '23514',
        message = 'class_log_reschedule_origin_invalid';
    end if;

  elsif new.appointment_id ~* '^trial_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    -- Compatibilidade estrita com TrialsToContracts: antes de existir um
    -- appointment real, a tela gravava `trial_<opportunity_uuid>`. Nao basta o
    -- prefixo: a oportunidade deve estar concluida, sem appointment, pertencer
    -- ao mesmo tenant/professor e fornecer o horario autoritativo.
    select
      case when pg_catalog.lower(coalesce(o.kind, 'TRIAL')) = 'training'
           then 'training' else 'experimental' end,
      public.parse_lesson_date(slot.value ->> 'date'),
      pg_catalog.left(pg_catalog.btrim(slot.value ->> 'time'), 5)::time,
      case
        when pg_catalog.btrim(coalesce(slot.value ->> 'day', '')) ~ '^[0-6]$'
          then pg_catalog.btrim(slot.value ->> 'day')::int
        else public.dow_name_to_int(slot.value ->> 'day')
      end
      into v_appt_type, v_source_date, v_authoritative_time, v_slot_day
      from public.opportunities o
      cross join lateral (
        select item.value
          from pg_catalog.jsonb_array_elements(
            case when pg_catalog.jsonb_typeof(o.slots_proposed) = 'array'
                 then o.slots_proposed else '[]'::jsonb end
          ) with ordinality as item(value, position)
         where pg_catalog.btrim(item.value ->> 'time')
               ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
         order by item.position
         limit 1
      ) slot
     where o.id = pg_catalog.substr(new.appointment_id, 7)::uuid
       and o.tenant_id = new.tenant_id
       and o.winner_teacher_id = new.teacher_id
       and o.status = 'CLAIMED'
       and o.trial_status = 'DONE'
       and o.trial_appointment_id is null
     limit 1;

    if not found
       or new.student_id is not null
       or new.presence is distinct from 'COMPLETED'
       or new.subtype is distinct from (
         case when v_appt_type = 'training'
              then 'TREINAMENTO'
              else 'AULA EXPERIMENTAL' end
       )
    then
      raise exception using
        errcode = '23514',
        message = 'class_log_synthetic_appointment_invalid';
    end if;

    if v_source_date is not null then
      -- O consumidor legado enviava "hoje" quando nao havia appointment. Essa
      -- unica divergencia conhecida e aceita, mas o snapshot gravado e forcado
      -- para a data proposta; uma data arbitraria continua sendo fraude.
      if new.class_date is distinct from v_source_date
         and new.class_date is distinct from
             (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
      then
        raise exception using
          errcode = '23514',
          message = 'class_log_synthetic_appointment_date_mismatch';
      end if;
      new.class_date := v_source_date;
      new.date := v_source_date;
    elsif v_slot_day is null
       or v_slot_day <> extract(dow from new.class_date)::int
    then
      raise exception using
        errcode = '23514',
        message = 'class_log_synthetic_appointment_date_invalid';
    end if;

  elsif new.appointment_id
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    select
      pg_catalog.lower(coalesce(a.type, 'experimental')),
      (a.start_time at time zone 'America/Sao_Paulo')::time
      into v_appt_type, v_authoritative_time
      from public.appointments a
     where a.id::text = new.appointment_id
       and a.tenant_id = new.tenant_id
       and a.start_time is not null
       and (a.start_time at time zone 'America/Sao_Paulo')::date = new.class_date
       and pg_catalog.lower(coalesce(a.status, '')) in ('scheduled', 'completed')
       and pg_catalog.lower(coalesce(a.type, '')) in ('experimental', 'training')
       and (
         coalesce(a.teacher_id, a.professor_id) = new.teacher_id
         or exists (
           select 1
             from public.opportunities o
            where o.trial_appointment_id = a.id
              and o.tenant_id = new.tenant_id
              and o.winner_teacher_id = new.teacher_id
         )
       )
     limit 1;

    if not found
       or new.student_id is not null
       or new.presence is distinct from 'COMPLETED'
    then
      raise exception using
        errcode = '23514',
        message = 'class_log_appointment_origin_invalid';
    end if;

    new.subtype := case when v_appt_type = 'training'
                        then 'TREINAMENTO'
                        else 'AULA EXPERIMENTAL' end;

  else
    raise exception using
      errcode = '23514',
      message = 'class_log_appointment_origin_invalid';
  end if;

  -- A confirmacao enviada ao aluno e o snapshot historico mais forte. Ela so
  -- pode sobrescrever a fonte depois que tenant, professor, aluno e data foram
  -- validados acima.
  select pg_catalog.left(pg_catalog.btrim(ac.class_time), 5)::time
    into v_confirmation_time
    from public.attendance_confirmations ac
   where ac.tenant_id = new.tenant_id
     and ac.class_date = new.class_date
     and ac.teacher_id = new.teacher_id
     and ac.student_id is not distinct from new.student_id
     and pg_catalog.btrim(ac.class_time)
         ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
     and (
       ac.class_log_id = new.id
       or (ac.source_type = 'booking' and ac.source_id = new.booking_id)
       or (ac.source_type = 'reschedule' and ac.source_id = new.reschedule_id)
       or (ac.source_type = 'appointment' and ac.source_id = new.appointment_id)
     )
   order by (ac.class_log_id = new.id) desc nulls last, ac.created_at desc, ac.id desc
   limit 1;

  if found then
    v_authoritative_time := v_confirmation_time;
  end if;

  if v_authoritative_time is null then
    raise exception using
      errcode = '23514',
      message = 'class_log_occurrence_time_required';
  end if;

  if v_supplied_time is not null
     and v_supplied_time is distinct from v_authoritative_time
  then
    raise exception using
      errcode = '23514',
      message = 'class_log_occurrence_time_mismatch';
  end if;

  new.start_time := v_authoritative_time;
  new.date := new.class_date;

  return new;
end;
$$;

drop trigger if exists trg_fill_class_log_occurrence_time on public.class_logs;
create trigger trg_fill_class_log_occurrence_time
before insert or update of booking_id, reschedule_id, appointment_id, start_time,
  class_date, teacher_id, student_id on public.class_logs
for each row execute function public.fill_class_log_occurrence_time();

-- Permite duas aulas no mesmo dia quando os horarios diferem, mas impede a
-- mesma ocorrencia mesmo que o booking tenha sido cancelado e recriado.
create unique index if not exists uq_class_logs_student_occurrence
  on public.class_logs (tenant_id, teacher_id, student_id, class_date, start_time)
  where student_id is not null
    and start_time is not null;

comment on index public.uq_class_logs_student_occurrence is
  'Uma aula por professor/aluno/data/horario em qualquer origem; horarios diferentes no mesmo dia continuam permitidos.';

-- A Ficha 360 existia apenas direto em producao e escondia o horario/origem das
-- aulas. Alem de versiona-la, o teste de permissao passa a tratar NULL como
-- negado (a versao anterior podia continuar quando auth.uid() era NULL).
create or replace function public.get_student_overview(p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant text;
  s public.profiles%rowtype;
  v_is_admin boolean := false;
  v_can boolean := false;
  v_result jsonb;
  v_att int;
  v_abs int;
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if v_uid is null then
    return pg_catalog.jsonb_build_object('error', 'sem_permissao');
  end if;

  select public._my_role(), public._my_tenant_id()
    into v_role, v_tenant;

  if v_role is null or (v_role <> 'SUPER_ADMIN' and v_tenant is null) then
    return pg_catalog.jsonb_build_object('error', 'sem_permissao');
  end if;

  select *
    into s
    from public.profiles p
   where p.id = p_student_id
     and p.role = 'STUDENT'
     and (v_role = 'SUPER_ADMIN' or p.tenant_id = v_tenant);
  if not found then
    return pg_catalog.jsonb_build_object('error', 'nao_encontrado');
  end if;

  v_is_admin := coalesce(v_role in ('SCHOOL_ADMIN', 'SUPER_ADMIN'), false);
  v_can := coalesce(
    v_role = 'SUPER_ADMIN'
    or (v_role = 'SCHOOL_ADMIN' and s.tenant_id = v_tenant)
    or (
      v_role = 'TEACHER'
      and s.tenant_id = v_tenant
      and (
        s.professor_id = v_uid
        or s.professor_id2 = v_uid
        or exists (
          select 1
            from public.bookings b
           where b.student_id = s.id
             and b.teacher_id = v_uid
             and b.tenant_id = s.tenant_id
             and b.status = 'SCHEDULED'
        )
      )
    ),
    false
  );

  if not v_can then
    return pg_catalog.jsonb_build_object('error', 'sem_permissao');
  end if;

  select
    count(*) filter (where cl.presence = 'COMPLETED' and cl.class_date >= v_today - 90),
    count(*) filter (where cl.presence = 'STUDENT_ABSENCE' and cl.class_date >= v_today - 90)
    into v_att, v_abs
    from public.class_logs cl
   where cl.student_id = p_student_id
     and cl.tenant_id = s.tenant_id;

  v_result := pg_catalog.jsonb_build_object(
    'profile', pg_catalog.jsonb_build_object(
      'id', s.id,
      'full_name', s.full_name,
      'avatar_url', s.avatar_url,
      'module', s.module,
      'phone', s.phone,
      'email', s.email,
      'is_kids', coalesce(s.is_kids, false),
      'guardian_name', s.guardian_name,
      'guardian_phone', s.guardian_phone,
      'occupation', s.occupation,
      'interests', s.interests,
      'meeting_link', s.meeting_link,
      'status_financial', s.status_financial,
      'start_date', s.start_date,
      'created_at', s.created_at,
      'class_frequency', s.class_frequency,
      'professor_id', s.professor_id,
      'professor_name', (select p.full_name from public.profiles p where p.id = s.professor_id)
    ),
    'frequency', pg_catalog.jsonb_build_object(
      'attended_90', v_att,
      'absent_90', v_abs,
      'rate', case when v_att + v_abs > 0 then pg_catalog.round(100.0 * v_att / (v_att + v_abs))::int else null end
    ),
    'gamification', pg_catalog.jsonb_build_object(
      'xp', coalesce(s.xp, 0),
      'level', coalesce(s.level, 1),
      'streak', coalesce(s.streak_count, 0),
      'hearts', coalesce(s.hearts, 5),
      'last_activity', s.last_activity
    ),
    'classes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', cl.id,
          'date', cl.class_date,
          'class_time', case when cl.start_time is not null then pg_catalog.to_char(cl.start_time, 'HH24:MI') else null end,
          'origin_type', case
            when cl.booking_id is not null then 'BOOKING'
            when cl.reschedule_id is not null then 'RESCHEDULE'
            when cl.appointment_id is not null then 'APPOINTMENT'
            else 'MANUAL'
          end,
          'booking_id', cl.booking_id,
          'reschedule_id', cl.reschedule_id,
          'appointment_id', cl.appointment_id,
          'presence', cl.presence,
          'subtype', cl.subtype,
          'content', coalesce(cl.content_covered, cl.content),
          'difficulties', cl.student_difficulties,
          'homework', cl.homework_assigned,
          'teacher_id', cl.teacher_id,
          'teacher', (select p.full_name from public.profiles p where p.id = cl.teacher_id)
        ) order by cl.class_date desc nulls last, cl.start_time desc nulls last, cl.created_at desc
      )
      from (
        select *
          from public.class_logs
         where student_id = p_student_id
           and tenant_id = s.tenant_id
         order by class_date desc nulls last, start_time desc nulls last, created_at desc
         limit 25
      ) cl
    ), '[]'::jsonb),
    'notes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', n.id,
          'category', n.category,
          'note', n.note,
          'author_name', n.author_name,
          'created_at', n.created_at
        ) order by n.created_at desc
      )
      from public.student_teacher_notes n
      where n.student_id = p_student_id
        and n.tenant_id = s.tenant_id
    ), '[]'::jsonb)
  );

  if v_is_admin then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'financial', pg_catalog.jsonb_build_object(
        'monthly_fee', s.monthly_fee,
        'due_day', s.due_day,
        'status_financial', s.status_financial,
        'first_overdue_at', s.first_overdue_at
      ),
      'payments', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'value', sp.value,
            'status', sp.status,
            'due_date', sp.due_date,
            'paid_at', coalesce(sp.paid_at, sp.payment_date),
            'invoice_url', sp.invoice_url,
            'description', sp.description
          ) order by sp.due_date desc nulls last
        )
        from (
          select * from public.student_payments
           where student_id = p_student_id
             and tenant_id = s.tenant_id
           order by due_date desc nulls last
           limit 12
        ) sp
      ), '[]'::jsonb),
      'audit', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'field', a.field,
            'old_value', a.old_value,
            'new_value', a.new_value,
            'changed_at', a.changed_at,
            'changed_by', (select p.full_name from public.profiles p where p.id = a.changed_by)
          ) order by a.changed_at desc
        )
        from (
          select * from public.profile_audit_log
           where profile_id = p_student_id
             and tenant_id = s.tenant_id
           order by changed_at desc
           limit 20
        ) a
      ), '[]'::jsonb)
    );
  end if;

  return v_result || pg_catalog.jsonb_build_object(
    'can_edit_financial', v_is_admin,
    'viewer_role', v_role
  );
end;
$$;

comment on function public.get_student_overview(uuid) is
  'Ficha 360 do aluno com escopo por tenant e historico de aulas identificado por ID, origem, data e horario.';

alter function public.get_student_overview(uuid) owner to postgres;
revoke all on function public.get_student_overview(uuid) from public, anon;
grant execute on function public.get_student_overview(uuid) to authenticated, service_role;

-- A lista e a regularizacao da direcao tambem precisam comparar a ocorrencia,
-- nao somente o source_id. Foi por este fluxo que o segundo booking de 11/08
-- virou uma segunda falta paga.
create or replace function public.list_unlogged_confirmed_classes(p_days integer default 180)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant text;
  v_days integer;
  v_out jsonb;
begin
  if v_uid is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  select public._my_role(), public._my_tenant_id()
    into v_role, v_tenant;

  if not coalesce(v_role in ('SCHOOL_ADMIN', 'SUPER_ADMIN'), false)
     or (v_role <> 'SUPER_ADMIN' and v_tenant is null) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  v_days := greatest(1, least(coalesce(p_days, 180), 365));

  with confirmations as (
    select
      ac.*,
      coalesce(
        case
          when pg_catalog.btrim(ac.class_time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
          then pg_catalog.left(pg_catalog.btrim(ac.class_time), 5)::time
        end,
        case when ac.source_type = 'booking' then (
          select pg_catalog.left(pg_catalog.btrim(b.time_slot), 5)::time
            from public.bookings b
           where b.id::text = ac.source_id
             and b.tenant_id = ac.tenant_id
             and b.student_id is not distinct from ac.student_id
             and pg_catalog.btrim(b.time_slot) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
           limit 1
        ) end,
        case when ac.source_type = 'reschedule' then (
          select pg_catalog.left(pg_catalog.btrim(r.time), 5)::time
            from public.reschedules r
           where r.id::text = ac.source_id
             and r.tenant_id = ac.tenant_id
             and r.teacher_id = ac.teacher_id
             and r.student_id is not distinct from ac.student_id
             and pg_catalog.btrim(r.time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
           limit 1
        ) end
      ) as occurrence_time
    from public.attendance_confirmations ac
    where ac.source_type in ('booking', 'reschedule')
      and nullif(pg_catalog.btrim(ac.source_id), '') is not null
      and (v_role = 'SUPER_ADMIN' or ac.tenant_id = v_tenant)
  ), orphaned as (
    select
      ac.id,
      ac.teacher_id,
      ac.student_id,
      ac.student_name,
      ac.class_date,
      ac.class_time,
      ac.student_response,
      ac.source_type,
      coalesce(p.full_name, ac.teacher_name, 'Professor') as teacher_name,
      coalesce(public.teacher_student_rate(ac.teacher_id, ac.student_id, ac.class_date), 0) as rate
    from confirmations ac
    left join public.profiles p
      on p.id = ac.teacher_id
     and p.tenant_id = ac.tenant_id
    where ac.status = 'AWAITING_TEACHER'
      and ac.student_response in ('STUDENT_PRESENT', 'STUDENT_SELF_ABSENT')
      and ac.class_log_id is null
      and ac.teacher_id is not null
      and ac.class_date >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - v_days
      and not exists (
        select 1
          from public.class_logs cl
         where cl.tenant_id = ac.tenant_id
           and cl.class_date = ac.class_date
           and (
             (ac.source_type = 'booking' and cl.booking_id = ac.source_id)
             or (ac.source_type = 'reschedule' and cl.reschedule_id = ac.source_id)
             or (
               ac.occurrence_time is not null
               and ac.student_id is not null
               and cl.teacher_id = ac.teacher_id
               and cl.student_id = ac.student_id
               and cl.start_time = ac.occurrence_time
             )
           )
      )
  )
  select pg_catalog.jsonb_build_object(
    'ok', true,
    'total', (select count(*) from orphaned),
    'valor_total', (select coalesce(sum(rate), 0) from orphaned),
    'teachers', coalesce((
      select pg_catalog.jsonb_agg(t order by (t ->> 'aulas')::int desc)
        from (
          select pg_catalog.jsonb_build_object(
            'teacher_id', o.teacher_id,
            'teacher_name', o.teacher_name,
            'aulas', count(*)::int,
            'valor', coalesce(sum(o.rate), 0),
            'mais_antiga', min(o.class_date),
            'classes', pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', o.id,
                'student_name', o.student_name,
                'class_date', o.class_date,
                'class_time', o.class_time,
                'student_response', o.student_response,
                'valor', o.rate
              ) order by o.class_date, o.class_time
            )
          ) as t
          from orphaned o
          group by o.teacher_id, o.teacher_name
        ) grouped
    ), '[]'::jsonb)
  )
  into v_out;

  return v_out;
end;
$$;

create or replace function public.settle_confirmed_class(
  p_confirmation_id uuid,
  p_pay boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_tenant text;
  c public.attendance_confirmations%rowtype;
  v_presence text;
  v_log_id uuid;
  v_existing_log_id uuid;
  v_occurrence_time time;
  v_constraint_name text;
begin
  if v_uid is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  select public._my_role(), public._my_tenant_id()
    into v_role, v_tenant;

  if not coalesce(v_role in ('SCHOOL_ADMIN', 'SUPER_ADMIN'), false)
     or (v_role <> 'SUPER_ADMIN' and v_tenant is null) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;

  if p_pay is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'decisao_obrigatoria');
  end if;

  select ac.*
    into c
    from public.attendance_confirmations ac
   where ac.id = p_confirmation_id
     and (v_role = 'SUPER_ADMIN' or ac.tenant_id = v_tenant)
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'nao_encontrado');
  end if;

  if c.class_log_id is not null
     or c.status in ('CONFIRMED', 'RESOLVED_PAID', 'RESOLVED_UNPAID') then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already', true,
      'status', c.status,
      'class_log_id', c.class_log_id
    );
  end if;

  if c.status is distinct from 'AWAITING_TEACHER' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'status_invalido');
  end if;

  if c.tenant_id is null
     or c.teacher_id is null
     or c.student_id is null
     or c.class_date is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'confirmacao_incompleta');
  end if;

  if not coalesce(
    c.student_response in ('STUDENT_PRESENT', 'STUDENT_SELF_ABSENT'),
    false
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'resposta_do_aluno_nao_permite');
  end if;

  if not coalesce(c.source_type in ('booking', 'reschedule'), false)
     or nullif(pg_catalog.btrim(c.source_id), '') is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'origem_invalida');
  end if;

  if not (
    (
      c.source_type = 'booking'
      and exists (
        select 1
          from public.bookings b
         where b.id::text = c.source_id
           and b.tenant_id = c.tenant_id
           and b.student_id is not distinct from c.student_id
           and (
             b.teacher_id = c.teacher_id
             or exists (
               select 1
                 from public.class_coverages coverage
                where coverage.booking_id = b.id
                  and coverage.class_date = c.class_date
                  and coverage.status = 'confirmed'
                  and coverage.cover_teacher_id = c.teacher_id
             )
           )
      )
    )
    or (
      c.source_type = 'reschedule'
      and exists (
        select 1
          from public.reschedules r
         where r.id::text = c.source_id
           and r.tenant_id = c.tenant_id
           and r.teacher_id = c.teacher_id
           and r.student_id is not distinct from c.student_id
      )
    )
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'origem_invalida');
  end if;

  if exists (
    select 1
      from public.class_logs cl
     where cl.tenant_id = c.tenant_id
       and cl.class_date = c.class_date
       and (
         (c.source_type = 'booking' and cl.booking_id = c.source_id)
         or (c.source_type = 'reschedule' and cl.reschedule_id = c.source_id)
       )
  ) then
    perform public.reconcile_attendance_confirmation(c.id);
    return pg_catalog.jsonb_build_object('ok', true, 'already', true, 'error', 'ja_lancado');
  end if;

  v_occurrence_time := case
    when pg_catalog.btrim(c.class_time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
    then pg_catalog.left(pg_catalog.btrim(c.class_time), 5)::time
    else null
  end;

  if v_occurrence_time is null and c.source_type = 'booking' then
    select pg_catalog.left(pg_catalog.btrim(b.time_slot), 5)::time
      into v_occurrence_time
      from public.bookings b
     where b.id::text = c.source_id
       and b.tenant_id = c.tenant_id
       and b.student_id is not distinct from c.student_id
       and pg_catalog.btrim(b.time_slot) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
     limit 1;
  end if;

  if v_occurrence_time is null and c.source_type = 'reschedule' then
    select pg_catalog.left(pg_catalog.btrim(r.time), 5)::time
      into v_occurrence_time
      from public.reschedules r
     where r.id::text = c.source_id
       and r.tenant_id = c.tenant_id
       and r.teacher_id = c.teacher_id
       and r.student_id is not distinct from c.student_id
       and pg_catalog.btrim(r.time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
     limit 1;
  end if;

  if p_pay and v_occurrence_time is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'horario_da_ocorrencia_invalido');
  end if;

  if v_occurrence_time is not null and c.student_id is not null then
    select cl.id
      into v_existing_log_id
      from public.class_logs cl
     where cl.tenant_id = c.tenant_id
       and cl.teacher_id = c.teacher_id
       and cl.student_id = c.student_id
       and cl.class_date = c.class_date
       and cl.start_time = v_occurrence_time
     order by cl.created_at, cl.id
     limit 1;
  end if;

  if v_existing_log_id is not null then
    update public.attendance_confirmations
           set status = 'RESOLVED_UNPAID',
               admin_resolution = 'Ocorrência já lançada em outro agendamento; duplicata não paga',
           resolved_by = v_uid,
           resolved_at = pg_catalog.now()
     where id = c.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already', true,
      'duplicate_occurrence', true,
      'existing_class_log_id', v_existing_log_id
    );
  end if;

  if not p_pay then
    update public.attendance_confirmations
       set status = 'RESOLVED_UNPAID',
           admin_resolution = 'Diretor decidiu não lançar/pagar esta aula',
           resolved_by = v_uid,
           resolved_at = pg_catalog.now()
     where id = c.id;
    return pg_catalog.jsonb_build_object('ok', true, 'paid', false);
  end if;

  v_presence := case
    when c.student_response = 'STUDENT_PRESENT' then 'COMPLETED'
    else 'STUDENT_ABSENCE'
  end;

  begin
    insert into public.class_logs (
      tenant_id,
      teacher_id,
      student_id,
      booking_id,
      reschedule_id,
      presence,
      date,
      class_date,
      start_time,
      observations,
      created_at
    ) values (
      c.tenant_id,
      c.teacher_id,
      c.student_id,
      case when c.source_type = 'booking' then c.source_id end,
      case when c.source_type = 'reschedule' then c.source_id end,
      v_presence,
      c.class_date,
      c.class_date,
      v_occurrence_time,
      'Regularizada pela direção a partir da confirmação do aluno',
      pg_catalog.now()
    )
    returning id into v_log_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint_name = constraint_name;

    if not (
      v_constraint_name = any (array[
        'uq_class_logs_student_occurrence',
        'uq_class_logs_booking_date',
        'unique_class_log_per_booking_date',
        'uq_class_logs_reschedule_id',
        'unique_class_log_per_reschedule'
      ]::text[])
    ) then
      raise;
    end if;

    select cl.id
      into v_existing_log_id
      from public.class_logs cl
     where cl.tenant_id = c.tenant_id
       and cl.class_date = c.class_date
       and (
         (c.source_type = 'booking' and cl.booking_id = c.source_id)
         or (c.source_type = 'reschedule' and cl.reschedule_id = c.source_id)
         or (
           cl.teacher_id = c.teacher_id
           and cl.student_id = c.student_id
           and cl.start_time = v_occurrence_time
         )
       )
     order by cl.created_at, cl.id
     limit 1;

    if v_existing_log_id is null then
      raise;
    end if;

    update public.attendance_confirmations
       set status = 'RESOLVED_UNPAID',
           admin_resolution = 'Ocorrência já lançada simultaneamente; duplicata não paga',
           resolved_by = v_uid,
           resolved_at = pg_catalog.now()
     where id = c.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'already', true,
      'duplicate_occurrence', true,
      'existing_class_log_id', v_existing_log_id
    );
  end;

  update public.attendance_confirmations
     set status = 'RESOLVED_PAID',
         class_log_id = v_log_id,
         admin_resolution = 'Lançada pela direção a partir da confirmação do aluno',
         resolved_by = v_uid,
         resolved_at = pg_catalog.now()
   where id = c.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'paid', true,
    'class_log_id', v_log_id,
    'presence', v_presence
  );
end;
$$;

alter function public.list_unlogged_confirmed_classes(integer) owner to postgres;
alter function public.settle_confirmed_class(uuid, boolean) owner to postgres;
alter function public.normalize_booking_occurrence() owner to postgres;
alter function public.fill_class_log_occurrence_time() owner to postgres;
alter function public.parse_lesson_date(text) owner to postgres;
revoke all on function public.list_unlogged_confirmed_classes(integer) from public, anon;
revoke all on function public.settle_confirmed_class(uuid, boolean) from public, anon;
grant execute on function public.list_unlogged_confirmed_classes(integer) to authenticated, service_role;
grant execute on function public.settle_confirmed_class(uuid, boolean) to authenticated, service_role;

-- Funcoes de trigger nao fazem parte da Data API. O trigger continua podendo
-- executa-las; apenas a chamada RPC direta fica indisponivel.
revoke all on function public.normalize_booking_occurrence()
  from public, anon, authenticated, service_role;
revoke all on function public.fill_class_log_occurrence_time()
  from public, anon, authenticated, service_role;
revoke all on function public.parse_lesson_date(text)
  from public, anon, authenticated, service_role;

revoke all on function public.canonical_weekday_name(text) from public, anon;
grant execute on function public.canonical_weekday_name(text) to authenticated, service_role;

-- O RPC principal ainda barrava reposicao por aluno + data, o que impedia
-- duas aulas legitimas no mesmo dia. Ele e versionado novamente aqui para
-- usar a identidade completa da ocorrencia e gravar seu horario.
create or replace function public.log_teacher_classes(p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_teacher_id uuid := auth.uid();
  v_role text;
  v_tenant text;
  v_profile record;
  v_entry jsonb;
  v_count int;

  -- por entrada
  v_ref text;
  v_booking_id text;
  v_reschedule_id text;
  v_appointment_id text;
  v_student_id uuid;
  v_class_date date;
  v_presence text;
  v_kind text;
  v_subtype text;
  v_fault_origin text;
  v_appt_type text;
  v_new_id uuid;
  v_skip_reason text;
  v_student_absence_count int;
  v_occurrence_time time;
  v_confirmation_time time;
  v_source_date date;
  v_slot_day int;
  v_constraint_name text;

  v_results jsonb := '[]'::jsonb;
  v_inserted_ids uuid[] := array[]::uuid[];
  v_inserted int := 0;
  v_skipped int := 0;
  v_reschedules_created int := 0;

  v_delta_amount numeric := 0;
  v_delta_lessons int := 0;
  v_projection jsonb;
begin
  ---------------------------------------------------------------------------
  -- 1. Autenticação e escopo. `teacher_id` é SEMPRE auth.uid(): não existe
  --    parâmetro para lançar aula em nome de outra pessoa.
  ---------------------------------------------------------------------------
  if v_teacher_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select public._my_role(), public._my_tenant_id()
    into v_role, v_tenant;

  if not coalesce(v_role in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN'), false)
     or v_tenant is null then
    raise exception using errcode = '42501', message = 'teacher_profile_required';
  end if;

  select p.id, v_tenant as tenant_id, v_role as role
    into v_profile
    from public.profiles p
   where p.id = v_teacher_id;

  if not found
     or v_profile.tenant_id is null then
    raise exception using errcode = '42501', message = 'teacher_profile_required';
  end if;

  if p_entries is null or pg_catalog.jsonb_typeof(p_entries) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_entries';
  end if;

  v_count := pg_catalog.jsonb_array_length(p_entries);
  if v_count < 1 or v_count > 100 then
    raise exception using errcode = '22023', message = 'invalid_entries_length';
  end if;

  ---------------------------------------------------------------------------
  -- 2. Uma entrada por vez. Nada aqui aborta o lote: entrada inválida ou já
  --    lançada vira `skipped` com motivo, e o resto do lote grava normalmente.
  --    (Antes, um 23505 no meio derrubava o insert inteiro e o professor
  --    relançava tudo na mão.)
  ---------------------------------------------------------------------------
  for v_entry in select value from pg_catalog.jsonb_array_elements(p_entries)
  loop
    v_ref := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'ref', '')), '');
    v_booking_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'booking_id', '')), '');
    v_reschedule_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'reschedule_id', '')), '');
    v_appointment_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'appointment_id', '')), '');
    v_presence := pg_catalog.btrim(coalesce(v_entry ->> 'presence', 'COMPLETED'));
    v_skip_reason := null;
    v_new_id := null;
    v_student_id := null;
    v_class_date := null;
    v_kind := null;
    v_subtype := null;
    v_fault_origin := null;
    v_appt_type := null;
    v_occurrence_time := null;
    v_confirmation_time := null;
    v_source_date := null;
    v_slot_day := null;
    v_constraint_name := null;

    -- student_id / class_date com validação de formato (entrada do navegador)
    begin
      v_student_id := nullif(pg_catalog.btrim(coalesce(v_entry ->> 'student_id', '')), '')::uuid;
    exception when others then
      v_student_id := null;
    end;

    begin
      v_class_date := (v_entry ->> 'class_date')::date;
    exception when others then
      v_class_date := null;
    end;

    if v_class_date is null then
      v_skip_reason := 'data_invalida';
    elsif v_class_date > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date then
      -- aula no futuro nunca aconteceu: bloquear é mais barato que estornar
      v_skip_reason := 'aula_no_futuro';
    elsif v_class_date < ((pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 120) then
      v_skip_reason := 'fora_da_janela';
    elsif v_presence not in ('COMPLETED', 'STUDENT_ABSENCE', 'TEACHER_ABSENCE', 'Falta Justificada') then
      v_skip_reason := 'presenca_invalida';
    elsif v_booking_id is null and v_reschedule_id is null and v_appointment_id is null then
      v_skip_reason := 'sem_origem';
    elsif pg_catalog.num_nonnulls(
      v_booking_id, v_reschedule_id, v_appointment_id
    ) <> 1 then
      v_skip_reason := 'origem_ambigua';
    end if;

    -----------------------------------------------------------------------
    -- 2a. A ORIGEM é deduzida do banco, não do que o cliente diz que é.
    -----------------------------------------------------------------------
    if v_skip_reason is null then
      if v_reschedule_id is not null then
        v_kind := 'REPOSICAO';

        select
          r.fault_type,
          r.student_id,
          case
            when pg_catalog.btrim(r.time) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
            then pg_catalog.left(pg_catalog.btrim(r.time), 5)::time
          end
          into v_fault_origin, v_student_id, v_occurrence_time
          from public.reschedules r
         where r.id::text = v_reschedule_id
           and r.teacher_id = v_teacher_id
           and r.tenant_id = v_profile.tenant_id
           and r.used_at is null
           and public.parse_lesson_date(r.date) = v_class_date
           and pg_catalog.btrim(r.time)
               ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
         for update of r;

        if not found then
          v_skip_reason := 'reposicao_inexistente';
        else
          -- AQUI mora a correção: quem decide se a reposição paga é a ORIGEM
          -- registrada no banco. Falta do professor → 'REPOSIÇÃO_PROF' (paga).
          -- Falta do aluno (ou origem desconhecida) → 'REPOSIÇÃO' (não paga).
          v_subtype := case
            when v_fault_origin = 'TEACHER' then 'REPOSIÇÃO_PROF'
            else 'REPOSIÇÃO'
          end;
        end if;

      elsif v_appointment_id
            ~* '^trial_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then
        select
          case when pg_catalog.lower(coalesce(o.kind, 'TRIAL')) = 'training'
               then 'training' else 'experimental' end,
          public.parse_lesson_date(slot.value ->> 'date'),
          pg_catalog.left(pg_catalog.btrim(slot.value ->> 'time'), 5)::time,
          case
            when pg_catalog.btrim(coalesce(slot.value ->> 'day', '')) ~ '^[0-6]$'
              then pg_catalog.btrim(slot.value ->> 'day')::int
            else public.dow_name_to_int(slot.value ->> 'day')
          end
          into v_appt_type, v_source_date, v_occurrence_time, v_slot_day
          from public.opportunities o
          cross join lateral (
            select item.value
              from pg_catalog.jsonb_array_elements(
                case when pg_catalog.jsonb_typeof(o.slots_proposed) = 'array'
                     then o.slots_proposed else '[]'::jsonb end
              ) with ordinality as item(value, position)
             where pg_catalog.btrim(item.value ->> 'time')
                   ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
             order by item.position
             limit 1
          ) slot
         where o.id = pg_catalog.substr(v_appointment_id, 7)::uuid
           and o.tenant_id = v_profile.tenant_id
           and o.winner_teacher_id = v_teacher_id
           and o.status = 'CLAIMED'
           and o.trial_status = 'DONE'
           and o.trial_appointment_id is null;

        if not found
           or v_presence <> 'COMPLETED'
           or (
             v_source_date is not null
             and v_source_date <> v_class_date
           )
           or (
             v_source_date is null
             and (
               v_slot_day is null
               or v_slot_day <> extract(dow from v_class_date)::int
             )
           )
        then
          v_skip_reason := 'agendamento_sintetico_invalido';
        elsif v_appt_type = 'training' then
          v_kind := 'TRAINING';
          v_subtype := 'TREINAMENTO';
        else
          v_kind := 'TRIAL';
          v_subtype := 'AULA EXPERIMENTAL';
        end if;
        v_student_id := null;

      elsif v_appointment_id is not null then
        select
          pg_catalog.lower(coalesce(a.type, 'experimental')),
          (a.start_time at time zone 'America/Sao_Paulo')::time
          into v_appt_type, v_occurrence_time
          from public.appointments a
         where a.id::text = v_appointment_id
           and a.tenant_id = v_profile.tenant_id
           and (a.start_time at time zone 'America/Sao_Paulo')::date = v_class_date
           and pg_catalog.lower(coalesce(a.status, '')) in ('scheduled', 'completed')
           and pg_catalog.lower(coalesce(a.type, '')) in ('experimental', 'training')
           and (
             coalesce(a.teacher_id, a.professor_id) = v_teacher_id
             or exists (
               select 1
                 from public.opportunities o
                where o.trial_appointment_id = a.id
                  and o.tenant_id = v_profile.tenant_id
                  and o.winner_teacher_id = v_teacher_id
             )
           );

        if not found then
          v_skip_reason := 'agendamento_inexistente';
        elsif v_presence <> 'COMPLETED' then
          v_skip_reason := 'presenca_invalida_para_agendamento';
        elsif v_appt_type = 'training' then
          v_kind := 'TRAINING';
          v_subtype := 'TREINAMENTO';
        else
          v_kind := 'TRIAL';
          v_subtype := 'AULA EXPERIMENTAL';
        end if;
        v_student_id := null; -- experimental/treino é lead, não aluno matriculado

      else
        v_kind := 'REGULAR';

        -- COBERTURA: quem lança é quem DEU a aula, não necessariamente o dono do
        -- agendamento. Aula assumida (`class_coverages.cover_teacher_id`) usa o
        -- booking do professor original — validar só por `b.teacher_id` recusaria
        -- o lançamento de quem realmente trabalhou.
        select
          b.student_id,
          case
            when pg_catalog.btrim(b.time_slot) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
            then pg_catalog.left(pg_catalog.btrim(b.time_slot), 5)::time
          end
          into v_student_id, v_occurrence_time
          from public.bookings b
         where b.id::text = v_booking_id
           and b.tenant_id = v_profile.tenant_id
           and b.status = 'SCHEDULED'
           and b.start_date is not null
           and b.start_date <= v_class_date
           and public.dow_name_to_int(b.day_of_week)
               = extract(dow from v_class_date)::int
           and pg_catalog.btrim(b.time_slot)
               ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
           and (
             (
               b.teacher_id = v_teacher_id
               and not exists (
                 select 1
                   from public.class_coverages c
                  where c.booking_id = b.id
                    and c.tenant_id = v_profile.tenant_id
                    and c.class_date = v_class_date
                    and c.status = 'confirmed'
                    and c.cover_teacher_id is distinct from v_teacher_id
               )
             )
             or exists (
               select 1
                 from public.class_coverages c
                where c.booking_id = b.id
                  and c.tenant_id = v_profile.tenant_id
                  and c.class_date = v_class_date
                  and c.status = 'confirmed'
                  and c.cover_teacher_id = v_teacher_id
             )
           );

        if not found then
          v_skip_reason := 'agendamento_inexistente';

        -- E o inverso: quem CEDEU a aula não pode lançá-la. A tela já esconde,
        -- mas a trava do dinheiro tem de estar no servidor — lançar aula cedida
        -- pagaria dois professores pela mesma hora.
        elsif exists (
          select 1
            from public.class_coverages c
           where c.booking_id::text = v_booking_id
             and c.tenant_id = v_profile.tenant_id
             and c.class_date = v_class_date
             and c.status = 'confirmed'
             and c.original_teacher_id = v_teacher_id
             and c.cover_teacher_id is distinct from v_teacher_id
        ) then
          v_skip_reason := 'aula_cedida_para_outro_professor';

        else
          -- Motivo da falta (Doença/Trabalho/Viagem/Outros) só quando houve falta.
          v_subtype := case
            when v_presence = 'COMPLETED' then null
            else nullif(pg_catalog.btrim(coalesce(v_entry ->> 'absence_reason', '')), '')
          end;
        end if;
      end if;
    end if;

    -- Se houve confirmacao enviada ao aluno, seu horario e o snapshot
    -- historico autoritativo; a consulta so roda depois que a origem real foi
    -- validada no tenant/data/professor acima.
    if v_skip_reason is null then
      select pg_catalog.left(pg_catalog.btrim(ac.class_time), 5)::time
        into v_confirmation_time
        from public.attendance_confirmations ac
       where ac.tenant_id = v_profile.tenant_id
         and ac.class_date = v_class_date
         and ac.teacher_id = v_teacher_id
         and ac.student_id is not distinct from v_student_id
         and pg_catalog.btrim(ac.class_time)
             ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
         and (
           (ac.source_type = 'booking' and ac.source_id = v_booking_id)
           or (ac.source_type = 'reschedule' and ac.source_id = v_reschedule_id)
           or (ac.source_type = 'appointment' and ac.source_id = v_appointment_id)
         )
       order by ac.created_at desc, ac.id desc
       limit 1;

      if found then
        v_occurrence_time := v_confirmation_time;
      end if;
    end if;

    if v_skip_reason is null and v_occurrence_time is null then
      v_skip_reason := 'horario_da_ocorrencia_invalido';
    end if;

    -----------------------------------------------------------------------
    -- 2b. Anti-duplicata NO SERVIDOR. O guard antigo vivia no navegador e era
    --     fail-open: numa queda de rede ele liberava tudo.
    --     A identidade e tenant + professor + aluno + data + horario. Isso barra
    --     a origem recriada/cruzada sem impedir 16:30 e 17:00 no mesmo dia.
    -----------------------------------------------------------------------
    if v_skip_reason is null then
      if v_kind = 'REGULAR' and exists (
        select 1 from public.class_logs cl
         where cl.tenant_id = v_profile.tenant_id
           and cl.booking_id = v_booking_id
           and cl.class_date = v_class_date
      ) then
        v_skip_reason := 'ja_lancada';

      elsif v_kind = 'REPOSICAO' and exists (
        select 1 from public.class_logs cl
         where cl.tenant_id = v_profile.tenant_id
           and cl.reschedule_id = v_reschedule_id
      ) then
        v_skip_reason := 'ja_lancada';

      elsif v_student_id is not null and exists (
        select 1 from public.class_logs cl
         where cl.tenant_id = v_profile.tenant_id
           and cl.teacher_id = v_teacher_id
           and cl.student_id = v_student_id
           and cl.class_date = v_class_date
           and cl.start_time = v_occurrence_time
      ) then
        v_skip_reason := 'ocorrencia_ja_lancada';

      elsif v_kind in ('TRIAL', 'TRAINING') and exists (
        select 1 from public.class_logs cl
         where cl.tenant_id = v_profile.tenant_id
           and cl.appointment_id = v_appointment_id
      ) then
        v_skip_reason := 'ja_lancada';
      end if;
    end if;

    -----------------------------------------------------------------------
    -- 2c. Grava.
    -----------------------------------------------------------------------
    if v_skip_reason is null then
      begin
        insert into public.class_logs (
          tenant_id, teacher_id, student_id,
          booking_id, reschedule_id, appointment_id,
          presence, subtype,
          content_covered, content, observations,
          assessment_level, psychological_profile, teacher_verdict,
          date, class_date, start_time, created_at
        ) values (
          v_profile.tenant_id, v_teacher_id, v_student_id,
          case when v_kind = 'REGULAR' then v_booking_id else null end,
          case when v_kind = 'REPOSICAO' then v_reschedule_id else null end,
          case when v_kind in ('TRIAL', 'TRAINING') then v_appointment_id else null end,
          v_presence, v_subtype,
          nullif(pg_catalog.btrim(coalesce(v_entry ->> 'content_covered', '')), ''),
          nullif(pg_catalog.btrim(coalesce(v_entry ->> 'content_covered', '')), ''),
          nullif(pg_catalog.btrim(coalesce(v_entry ->> 'observations', '')), ''),
          case when v_kind = 'TRIAL' then nullif(pg_catalog.btrim(coalesce(v_entry ->> 'assessment_level', '')), '') end,
          case when v_kind = 'TRIAL' then nullif(pg_catalog.btrim(coalesce(v_entry ->> 'psychological_profile', '')), '') end,
          case when v_kind = 'TRIAL' then nullif(pg_catalog.btrim(coalesce(v_entry ->> 'teacher_verdict', '')), '') end,
          v_class_date, v_class_date, v_occurrence_time, pg_catalog.now()
        )
        returning id into v_new_id;
      exception when unique_violation then
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = any (array[
          'uq_class_logs_student_occurrence',
          'uq_class_logs_booking_date',
          'unique_class_log_per_booking_date',
          'uq_class_logs_reschedule_id',
          'unique_class_log_per_reschedule',
          'uq_class_logs_appointment'
        ]::text[]) then
          v_skip_reason := 'ja_lancada';
          v_new_id := null;
        else
          raise;
        end if;
      end;
    end if;

    if v_skip_reason is null then
      v_inserted := v_inserted + 1;
      v_inserted_ids := pg_catalog.array_append(v_inserted_ids, v_new_id);

      ---------------------------------------------------------------------
      -- 2d. Consome a reposição — MARCA `used_at`, não apaga.
      --     Apagar destruía a prova de quem faltou (`reschedules.fault_type`),
      --     e é ela que decide se a reposição paga. Com a linha apagada, 12 dos
      --     13 class_logs ficaram apontando para nada e a regra nunca disparou
      --     (diagnóstico do commit 0bd4053). A lista de pendentes já filtra por
      --     "existe class_log apontando para esta reposição?", então a linha
      --     consumida não reaparece para lançar.
      ---------------------------------------------------------------------
      if v_kind = 'REPOSICAO' then
        update public.reschedules r
           set used_at = pg_catalog.now()
         where r.id::text = v_reschedule_id
           and r.teacher_id = v_teacher_id
           and r.tenant_id = v_profile.tenant_id
           and r.used_at is null;
      end if;

      ---------------------------------------------------------------------
      -- 2e. Falta gera reposição — e a ORIGEM fica gravada, que é o que
      --     permite pagar a reposição do professor lá na frente.
      --     Falta do professor: ilimitada (é o único caminho dele receber).
      --     Falta do aluno: 5 por mês.
      ---------------------------------------------------------------------
      if v_presence in ('TEACHER_ABSENCE', 'STUDENT_ABSENCE', 'Falta Justificada')
         and v_student_id is not null
         and coalesce(v_subtype, '') not in ('REPOSIÇÃO', 'REPOSIÇÃO_PROF')
      then
        if v_presence = 'TEACHER_ABSENCE' then
          insert into public.reschedules (
            tenant_id, teacher_id, student_id, original_booking_id,
            date, time, fault_type, created_at
          ) values (
            v_profile.tenant_id, v_teacher_id, v_student_id,
            case when v_kind = 'REGULAR' then v_booking_id::uuid else null end,
            'Pendente', 'Pendente', 'TEACHER', pg_catalog.now()
          );
          v_reschedules_created := v_reschedules_created + 1;
        else
          select count(*)::int
            into v_student_absence_count
            from public.reschedules r
           where r.student_id = v_student_id
             and r.tenant_id = v_profile.tenant_id
             and r.fault_type = 'STUDENT'
             and r.created_at >= pg_catalog.date_trunc('month', pg_catalog.now());

          if v_student_absence_count < 5 then
            insert into public.reschedules (
              tenant_id, teacher_id, student_id, original_booking_id,
              date, time, fault_type, created_at
            ) values (
              v_profile.tenant_id, v_teacher_id, v_student_id,
              case when v_kind = 'REGULAR' then v_booking_id::uuid else null end,
              'Pendente', 'Pendente', 'STUDENT', pg_catalog.now()
            );
            v_reschedules_created := v_reschedules_created + 1;
          end if;
        end if;
      end if;

      ---------------------------------------------------------------------
      -- 2f. Experimental lançada move o lead no CRM.
      ---------------------------------------------------------------------
      if v_kind = 'TRIAL' then
        update public.crm_leads l
           set status = 'TRIAL_DONE'
         where l.tenant_id = v_profile.tenant_id
           and l.phone is not null
           and l.phone in (
             select a.student_phone from public.appointments a
              where a.id::text = v_appointment_id
                and a.tenant_id = v_profile.tenant_id
                and a.student_phone is not null
           );
      end if;

    else
      v_skipped := v_skipped + 1;
    end if;

    v_results := v_results || pg_catalog.jsonb_build_object(
      'ref', v_ref,
      'id', v_new_id,
      'status', case when v_skip_reason is null then 'lancada' else 'ignorada' end,
      'reason', v_skip_reason,
      'kind', v_kind,
      'subtype', v_subtype
    );
  end loop;

  ---------------------------------------------------------------------------
  -- 3. Quanto isso virou de caixa — pela MESMA fonte que paga o professor
  --    (`v_payable_class_logs`). Nada de `aulas × tarifa` estimado: o valor por
  --    aula muda conforme a posição de antiguidade do aluno na carteira e o
  --    estado do turbo. Estimar aqui reproduziria exatamente a divergência que
  --    já gerou contestação em série no painel Financeiro.
  ---------------------------------------------------------------------------
  if pg_catalog.array_length(v_inserted_ids, 1) > 0 then
    select coalesce(sum(v.rate_efetivo), 0), count(*)::int
      into v_delta_amount, v_delta_lessons
      from public.v_payable_class_logs v
     where v.id = any(v_inserted_ids);

    -- Cada aula lançada recebe seu valor real (0 quando não entra na folha) e o
    -- motivo — é o que deixa a tela dizer a verdade em vez de fingir festa.
    select pg_catalog.jsonb_agg(
             r || pg_catalog.jsonb_build_object(
               'amount', coalesce(pay.rate_efetivo, 0),
               'paid', pay.id is not null,
               'unpaid_reason', case
                 when pay.id is not null then null
                 when r ->> 'id' is null then null
                 when cl.presence in ('TEACHER_ABSENCE', 'Falta do Professor') then 'falta_professor'
                 when cl.subtype = 'REPOSIÇÃO' then 'reposicao_falta_aluno'
                 when cl.subtype = 'Teste Oral' then 'teste_oral'
                 when coalesce(cl.payment_hold, false) then 'em_conferencia'
                 when cl.student_id is not null
                      and not public.is_billable_student(cl.student_id) then 'aluno_nao_faturavel'
                 else 'fora_da_folha'
               end
             )
           )
      into v_results
      from pg_catalog.jsonb_array_elements(v_results) r
      left join public.class_logs cl on cl.id::text = (r ->> 'id')
      left join public.v_payable_class_logs pay on pay.id::text = (r ->> 'id');
  end if;

  v_projection := public.teacher_pay_projection(v_teacher_id);

  return pg_catalog.jsonb_build_object(
    'inserted', v_inserted,
    'skipped', v_skipped,
    'reschedules_created', v_reschedules_created,
    'delta_amount', v_delta_amount,
    'delta_lessons', v_delta_lessons,
    'month_amount', coalesce((v_projection ->> 'amount_logged')::numeric, 0),
    'month_lessons', coalesce((v_projection ->> 'lessons_logged')::int, 0),
    'turbo_active', coalesce((v_projection -> 'turbo' ->> 'active')::boolean, false),
    'entries', coalesce(v_results, '[]'::jsonb)
  );
end;
$$;

comment on function public.log_teacher_classes(jsonb) is
  'Lançamento de aula transacional. Deriva subtype da origem real (REPOSIÇÃO_PROF quando a reposição vem de falta do professor), barra duplicata no servidor, gera a reposição com fault_type e devolve o valor autoritativo que entrou no caixa do professor.';

-- A migration é aplicada como `supabase_admin`, que é SUPERUSER. Uma função
-- SECURITY DEFINER roda com os poderes do DONO — deixá-la com esse dono daria
-- superusuário a qualquer aluno autenticado que chamasse a RPC. Passa para
-- `postgres`, que é o dono das demais funções do projeto (teacher_pay_projection etc).
alter function public.log_teacher_classes(jsonb) owner to postgres;

revoke all on function public.log_teacher_classes(jsonb) from public, anon;
grant execute on function public.log_teacher_classes(jsonb) to authenticated, service_role;
