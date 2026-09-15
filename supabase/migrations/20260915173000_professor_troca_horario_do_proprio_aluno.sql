-- ─────────────────────────────────────────────────────────────────────────────
-- Professor troca o horário do PRÓPRIO aluno, com aviso no grupo da Gestão
-- (15/09/2026, decisão da direção)
--
-- Desde 12/09 (20260912203132) a troca exigia aceite da família + aprovação da
-- escola, e o trigger `protect_teacher_booking_schedule` barrava o professor.
-- A direção devolveu a autonomia: o professor aplica a troca dos horários fixos
-- do próprio aluno e TODA troca é avisada no grupo da Gestão.
--
-- O que continua valendo — é o que protege a folha:
-- • vigência: a troca vale a partir de `p_effective_from` (amanhã em diante) e
--   `booking_schedule_versions` preserva o horário antigo nas datas passadas,
--   então aula já dada ou lançada não muda de lugar;
-- • choque de agenda do professor e do aluno (`schedule_change_has_conflict`);
-- • trilha: `schedule_change_requests` (APPLIED, ação TEACHER_APPLIED) e
--   `audit_logs` por aula.
--
-- Disponibilidade declarada NÃO é exigida: quem escolhe o horário é o próprio
-- professor. Exigir a grade cadastrada recusaria justamente o caso que existe
-- para ser atendido (mesma regra da remarcação de experimental).
--
-- O trigger libera só a troca feita por esta função, NA MESMA transação: exige
-- uma solicitação APPLIED com `reviewed_at = now()`, revisor = quem está logado
-- e ação TEACHER_APPLIED. O professor não tem INSERT em
-- `schedule_change_requests`, então não consegue fabricar essa prova por fora;
-- PATCH direto no PostgREST e a RPC antiga continuam barrados.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.teacher_apply_student_schedule_change(
  p_student_id uuid,
  p_changes jsonb,
  p_effective_from date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_is_manager boolean;
  v_change jsonb;
  v_booking_id uuid;
  b public.bookings%rowtype;
  s jsonb;
  v_day text;
  v_time text;
  v_request uuid;
  v_requests uuid[] := '{}';
  v_seen uuid[] := '{}';
  v_lines text := '';
  v_student_name text;
  v_teacher_names text;
  v_actor_name text;
  v_group text;
  v_message text;
  v_notification uuid;
begin
  if v_actor is null or v_tenant is null then
    raise exception using errcode = '42501', message = 'Sessão expirada. Entre novamente.';
  end if;
  v_is_manager := coalesce(private.quality_school_manager(v_tenant), false);
  if v_role is distinct from 'TEACHER' and not v_is_manager then
    raise exception using errcode = '42501', message = 'Seu perfil não pode alterar agendas.';
  end if;
  if coalesce(length(btrim(p_reason)), 0) not between 8 and 1000 then
    raise exception using errcode = '22023', message = 'Informe o motivo da troca (mínimo de 8 caracteres).';
  end if;
  if p_effective_from is null or p_effective_from <= v_today or p_effective_from > v_today + 366 then
    raise exception using errcode = '22023', message = 'A troca vale a partir de amanhã, no máximo em um ano.';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) not between 1 and 14 then
    raise exception using errcode = '22023', message = 'Nenhuma aula selecionada para troca.';
  end if;

  select p.full_name into v_student_name
    from public.profiles p
   where p.id = p_student_id and p.tenant_id = v_tenant and p.role = 'STUDENT';
  if not found then
    raise exception using errcode = '42501', message = 'Aluno fora da sua escola.';
  end if;
  select p.full_name into v_actor_name from public.profiles p where p.id = v_actor;

  -- Ordem determinística de lock (por id da aula) evita deadlock entre duas trocas.
  for v_change in
    select value from jsonb_array_elements(p_changes) order by value ->> 'booking_id'
  loop
    v_booking_id := nullif(v_change ->> 'booking_id', '')::uuid;
    if v_booking_id is null or v_booking_id = any(v_seen) then
      raise exception using errcode = '22023', message = 'Lista de aulas inválida.';
    end if;
    v_seen := v_seen || v_booking_id;

    select * into b from public.bookings where id = v_booking_id for update;
    if not found or b.tenant_id is distinct from v_tenant or b.student_id is distinct from p_student_id then
      raise exception using errcode = '42501', message = 'Aula fora da sua agenda.';
    end if;
    if not v_is_manager and b.teacher_id is distinct from v_actor then
      raise exception using errcode = '42501', message = 'Você só pode alterar alunos da sua própria agenda.';
    end if;
    if upper(coalesce(b.status, '')) <> 'SCHEDULED' or b.date is not null then
      raise exception using errcode = '22023', message = 'Somente aulas fixas ativas podem ter o horário alterado.';
    end if;

    v_day := case public.fold_accents(v_change ->> 'new_day')
      when 'segunda' then 'Segunda' when 'terca' then 'Terça' when 'quarta' then 'Quarta'
      when 'quinta' then 'Quinta' when 'sexta' then 'Sexta' when 'sabado' then 'Sábado'
      else null end;
    v_time := left(btrim(coalesce(v_change ->> 'new_time', '')), 5);
    if v_day is null then
      raise exception using errcode = '22023', message = 'Escolha um dia válido de segunda a sábado.';
    end if;
    if v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' then
      raise exception using errcode = '22023', message = 'Escolha um horário em intervalos de 30 minutos.';
    end if;

    -- Horário que valeria na data da vigência: é o "antes" honesto.
    s := public.booking_schedule_on_date(b.id, p_effective_from);
    if s ->> 'day_of_week' = v_day and s ->> 'time_slot' = v_time then
      continue;
    end if;
    if exists (select 1 from public.booking_schedule_versions
                where booking_id = b.id and valid_from >= p_effective_from) then
      raise exception using errcode = '22023', message = 'Já existe uma troca programada para esta aula a partir dessa data.';
    end if;

    -- Proposta antiga à espera da família perde o sentido: a troca aplicada a substitui.
    update public.schedule_change_requests
       set status = 'CANCELLED', reviewed_by = v_actor, reviewed_at = now(),
           review_note = 'Substituída por troca aplicada pelo professor.',
           history = history || jsonb_build_array(jsonb_build_object(
             'action', 'SUPERSEDED_BY_TEACHER_CHANGE', 'actor_id', v_actor, 'at', now()))
     where booking_id = b.id and status in ('PENDING_FAMILY', 'ACCEPTED');

    insert into public.schedule_change_requests(
      tenant_id, booking_id, student_id, teacher_id, requested_by, initiated_by, scope,
      effective_from, old_day, old_time, new_day, new_time, reason, status,
      reviewed_by, reviewed_at, review_note, history)
    values (
      b.tenant_id, b.id, b.student_id, b.teacher_id, v_actor,
      case when v_role = 'TEACHER' then 'TEACHER' else 'SCHOOL' end, 'PERMANENT',
      p_effective_from, s ->> 'day_of_week', s ->> 'time_slot', v_day, v_time, btrim(p_reason), 'APPLIED',
      v_actor, now(), 'Aplicada diretamente (autonomia do professor).',
      jsonb_build_array(jsonb_build_object(
        'action', 'TEACHER_APPLIED', 'actor_id', v_actor, 'actor_role', v_role, 'at', now())))
    returning id into v_request;
    v_requests := v_requests || v_request;

    perform pg_advisory_xact_lock(hashtextextended(
      'schedule:teacher:' || b.teacher_id::text || ':' || public.fold_accents(v_day) || ':' || v_time, 0));
    perform pg_advisory_xact_lock(hashtextextended(
      'schedule:student:' || b.student_id::text || ':' || public.fold_accents(v_day) || ':' || v_time, 0));
    if private.schedule_change_has_conflict(v_request) then
      raise exception using errcode = '23P01',
        message = format('Choque de agenda: %s às %s já está ocupado.', v_day, v_time);
    end if;

    -- Mesma costura de vigência de `review_booking_schedule_change`.
    if not exists (select 1 from public.booking_schedule_versions where booking_id = b.id) then
      insert into public.booking_schedule_versions(tenant_id, booking_id, valid_from, valid_until, day_of_week, time_slot)
      values (b.tenant_id, b.id, least(coalesce(b.start_date, '1970-01-01'::date), p_effective_from - 1),
              p_effective_from - 1, b.day_of_week, left(b.time_slot, 5));
    else
      update public.booking_schedule_versions set valid_until = p_effective_from - 1
       where booking_id = b.id and valid_from < p_effective_from
         and (valid_until is null or valid_until >= p_effective_from);
    end if;
    insert into public.booking_schedule_versions(tenant_id, booking_id, valid_from, day_of_week, time_slot, request_id)
    values (b.tenant_id, b.id, p_effective_from, v_day, v_time, v_request);
    update public.bookings set day_of_week = v_day, time_slot = v_time where id = b.id;

    insert into public.audit_logs(tenant_id, user_id, user_role, action, resource_type, resource_id,
      old_values, new_values, diff)
    values (b.tenant_id, v_actor, v_role, 'booking_schedule_changed', 'booking', b.id::text,
      jsonb_build_object('day_of_week', s ->> 'day_of_week', 'time_slot', s ->> 'time_slot',
        'teacher_id', b.teacher_id, 'student_id', b.student_id),
      jsonb_build_object('day_of_week', v_day, 'time_slot', v_time,
        'effective_from', p_effective_from, 'request_id', v_request),
      jsonb_build_object('day_of_week', jsonb_build_array(s ->> 'day_of_week', v_day),
        'time_slot', jsonb_build_array(s ->> 'time_slot', v_time)));

    v_lines := v_lines || format(E'• %s %s → *%s %s*\n', s ->> 'day_of_week', s ->> 'time_slot', v_day, v_time);
  end loop;

  if coalesce(array_length(v_requests, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'changed', 0, 'notification_queued', false);
  end if;

  select string_agg(distinct t.full_name, ', ') into v_teacher_names
    from public.bookings bk join public.profiles t on t.id = bk.teacher_id
   where bk.id = any(v_seen);

  -- Grupo da Gestão = o mesmo destino que a escola configurou para o DRE.
  -- Sem ele, cai no grupo operacional da direção: troca de agenda nunca é silenciosa.
  select btrim(cfg.destino) into v_group
    from public.dre_report_settings cfg
   where cfg.tenant_id = v_tenant and cfg.is_active
     and btrim(cfg.destino) ~ '^[0-9]+(-[0-9]+)?@g\.us$';
  if v_group is null then
    select nullif(btrim(p.teachers_group_id), '') into v_group
      from public.profiles p
     where p.tenant_id = v_tenant and p.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
       and nullif(btrim(p.teachers_group_id), '') is not null
     order by case when p.role = 'SCHOOL_ADMIN' then 0 else 1 end, p.created_at
     limit 1;
  end if;

  v_message := format(
    E'🔄 *TROCA DE HORÁRIO*\n\n👤 Aluno: *%s*\n👨‍🏫 Professor(a): *%s*\n\n%s\n📅 Vale a partir de *%s*\n📝 Motivo: %s\n\nAlterado por: %s',
    coalesce(v_student_name, 'Aluno'), coalesce(v_teacher_names, 'Professor'), v_lines,
    to_char(p_effective_from, 'DD/MM/YYYY'), btrim(p_reason), coalesce(v_actor_name, v_role));

  if v_group is not null then
    insert into public.notification_queue(tenant_id, teacher_id, student_id, student_name, student_phone,
      message_body, scheduled_for, status, source_id, source_type, notification_kind, idempotency_key)
    values (v_tenant, (select bk.teacher_id from public.bookings bk where bk.id = v_seen[1]),
      p_student_id, v_student_name, v_group, v_message, now(), 'pending', v_requests[1],
      'SCHEDULE_CHANGE', 'SCHEDULE_CHANGE_GROUP', 'schedule-change-group:' || v_requests[1]::text)
    returning id into v_notification;
  end if;

  return jsonb_build_object('ok', true, 'changed', array_length(v_requests, 1),
    'effective_from', p_effective_from, 'request_ids', to_jsonb(v_requests),
    'notification_queued', v_notification is not null);
end;
$$;

-- A checagem de choque foi criada por outro dono e revogada de todos; a função
-- acima roda como postgres (SECURITY DEFINER não pode ficar com dono superuser).
grant execute on function private.schedule_change_has_conflict(uuid) to postgres;

alter function public.teacher_apply_student_schedule_change(uuid, jsonb, date, text) owner to postgres;
revoke all on function public.teacher_apply_student_schedule_change(uuid, jsonb, date, text) from public, anon;
grant execute on function public.teacher_apply_student_schedule_change(uuid, jsonb, date, text) to authenticated;

-- A cerca continua cobrindo PATCH direto e as RPCs antigas; só abre para a troca
-- aplicada pela função acima na mesma transação.
create or replace function private.protect_teacher_booking_schedule()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_schedule_changed boolean := tg_op = 'UPDATE'
    and (new.day_of_week is distinct from old.day_of_week or new.time_slot is distinct from old.time_slot);
  v_teacher_applied boolean := false;
begin
  if v_schedule_changed then
    v_teacher_applied := exists (
      select 1 from public.booking_schedule_versions v
        join public.schedule_change_requests r on r.id = v.request_id
       where v.booking_id = old.id and r.booking_id = old.id and r.status = 'APPLIED'
         and r.reviewed_at = now() and r.reviewed_by = auth.uid()
         and r.history @> '[{"action":"TEACHER_APPLIED"}]'::jsonb
         and v.valid_from = r.effective_from
         and v.day_of_week = new.day_of_week and v.time_slot = left(new.time_slot, 5));
  end if;
  if v_schedule_changed and not v_teacher_applied
    and exists (select 1 from public.booking_schedule_versions where booking_id = old.id)
    and not exists (select 1 from public.booking_schedule_versions v
      join public.schedule_change_requests r on r.id = v.request_id
      where v.booking_id = old.id and r.status = 'ACCEPTED' and v.day_of_week = new.day_of_week
        and v.time_slot = left(new.time_slot, 5) and r.reviewed_at is null
        and private.quality_school_manager(old.tenant_id)) then
    raise exception using errcode = '42501',
      message = 'A agenda possui vigência e histórico. Registre uma nova proposta para preservar as aulas anteriores.';
  end if;
  if public._my_role() = 'TEACHER' then
    if tg_op <> 'UPDATE' or new.date is distinct from old.date or new.start_date is distinct from old.start_date
      or new.teacher_id is distinct from old.teacher_id or new.student_id is distinct from old.student_id
      or new.status is distinct from old.status
      or (v_schedule_changed and not v_teacher_applied) then
      raise exception using errcode = '42501',
        message = 'Para trocar dia ou horário, use "Alterar horário" na ficha do aluno.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.protect_teacher_booking_schedule() from public, anon, authenticated, service_role;
