-- ─────────────────────────────────────────────────────────────────────────────
-- Renovação: perguntar se o aluno quer seguir com a professora — só quando há
-- outro professor livre nos horários dele — e alertar a Gestão quando a
-- professora não responde em 24h (15/09/2026, decisão da direção)
--
-- 1. A pergunta é delicada: não pode soar como crítica à professora e só faz
--    sentido quando existe alternativa REAL — outro professor com a grade
--    declarada cobrindo todos os horários e sem choque. Sem alternativa, o bot
--    nem toca no assunto. Uma vez por renovação (`teacher_choice_asked_at`).
--    • aluno pediu horário novo → a pergunta vem antes de consultar a atual;
--    • renovação sem mudança de horário → na primeira conversa sobre a
--      renovação, com os horários atuais (os da oferta ou a agenda ativa).
--    "sim" segue com a atual; "outro professor" consulta o professor livre, e a
--    Gestão aprova como qualquer renovação negociada.
-- 2. Pedido ao professor que passa das 24h vira EXPIRED e a Gestão recebe
--    alerta no grupo (cron a cada 30 min). Antes o prazo só era percebido se o
--    professor escrevesse depois.
-- ─────────────────────────────────────────────────────────────────────────────

alter table private.course_renewal_negotiations add column if not exists teacher_choice_pending boolean not null default false;
alter table private.course_renewal_negotiations add column if not exists teacher_choice_asked_at timestamptz;
alter table private.course_renewal_negotiations add column if not exists alternative_teacher_id uuid references public.profiles(id) on delete restrict;
alter table private.course_renewal_negotiations add column if not exists schedule_change boolean not null default true;

create or replace function private.renewal_slots_text(p_slots jsonb)
returns text language sql immutable set search_path = '' as $$
  select string_agg(format('%s %s', s ->> 'day', s ->> 'time'), ', ')
    from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) s;
$$;

-- Horários que o aluno tem hoje: os que a oferta já fixou, senão a agenda ativa.
create or replace function private.renewal_current_slots(p_tenant text, p_student uuid, p_offer uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.schedule_plan -> 'slots' from private.student_course_renewal_offers o
      where o.id = p_offer and o.schedule_plan is not null),
    (select jsonb_agg(distinct jsonb_build_object('day', public.canonical_weekday_name(b.day_of_week),
        'time', left(b.time_slot, 5)))
       from public.bookings b
      where b.tenant_id = p_tenant and b.student_id = p_student
        and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null
        and public.canonical_weekday_name(b.day_of_week) is not null),
    '[]'::jsonb);
$$;

create or replace function private.renewal_offer_choice_asked(p_offer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.course_renewal_negotiations
    where source_offer_id = p_offer and teacher_choice_asked_at is not null);
$$;

create or replace function public.renewal_negotiation_context(p_tenant text, p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype; n private.course_renewal_negotiations%rowtype;
  v_teacher uuid; t public.profiles%rowtype; v_slots jsonb; v_alternative boolean := false;
begin
  select * into o from private.student_course_renewal_offers
   where tenant_id = p_tenant and student_id = p_student and status = 'PENDING_SIGNATURE'
     and expires_at > clock_timestamp()
   order by created_at desc limit 1;
  select * into n from private.course_renewal_negotiations
   where tenant_id = p_tenant and student_id = p_student
     and status in ('WAITING_TEACHER', 'WAITING_STUDENT', 'WAITING_MANAGEMENT')
   limit 1;
  if o.id is null and n.id is null then return jsonb_build_object('active', false); end if;
  v_teacher := private.renewal_current_teacher(p_tenant, p_student);
  select * into t from public.profiles where id = coalesce(n.teacher_id, v_teacher);
  -- Só oferece trocar de professor se existir alternativa real nos horários atuais.
  if o.id is not null and n.id is null and v_teacher is not null
     and not private.renewal_offer_choice_asked(o.id) then
    v_slots := private.renewal_current_slots(p_tenant, p_student, o.id);
    v_alternative := jsonb_array_length(v_slots) = o.classes_per_week
      and exists (select 1 from private.renewal_teacher_candidates(p_tenant, p_student, v_slots, array[v_teacher]));
  end if;
  return jsonb_build_object('active', true,
    'alternative_for_current', v_alternative,
    'teacher_choice_asked', o.id is not null and private.renewal_offer_choice_asked(o.id),
    'offer', case when o.id is null then null else jsonb_build_object('id', o.id, 'token', o.token,
      'monthly_fee_cents', o.monthly_fee_cents, 'classes_per_week', o.classes_per_week,
      'contract_start', o.contract_start, 'first_due_date', o.first_due_date,
      'service_end_date', o.service_end_date, 'schedule', o.schedule_plan -> 'slots') end,
    'negotiation', case when n.id is null then null else jsonb_build_object('id', n.id, 'status', n.status,
      'classes_per_week', n.classes_per_week, 'requested_slots', n.requested_slots,
      'proposed_slots', n.proposed_slots, 'teacher_choice_pending', n.teacher_choice_pending,
      'schedule_change', n.schedule_change) end,
    'teacher', case when t.id is null then null else jsonb_build_object('id', t.id, 'name', t.full_name) end);
end;
$$;

-- Mesma abertura de negociação, agora com a pergunta sobre a professora quando
-- há alternativa real (uma vez por negociação).
create or replace function public.open_renewal_negotiation(
  p_tenant text, p_student uuid, p_classes_per_week smallint, p_slots jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype; n private.course_renewal_negotiations%rowtype;
  v_slots jsonb; v_teacher uuid; v_candidate record; v_alternative uuid; t public.profiles%rowtype;
begin
  v_slots := private.renewal_normalize_slots(p_slots);
  if p_classes_per_week is null or jsonb_array_length(v_slots) <> p_classes_per_week then
    return jsonb_build_object('ok', false, 'error', 'slots_must_match_frequency');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-negotiation:' || p_tenant || ':' || p_student::text, 0));
  select * into o from private.student_course_renewal_offers
   where tenant_id = p_tenant and student_id = p_student and status = 'PENDING_SIGNATURE'
     and expires_at > clock_timestamp()
   order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_pending_renewal'); end if;

  select * into n from private.course_renewal_negotiations
   where student_id = p_student and status in ('WAITING_TEACHER', 'WAITING_STUDENT', 'WAITING_MANAGEMENT')
   for update;
  if found then
    update private.course_renewal_negotiations
       set source_offer_id = o.id, classes_per_week = p_classes_per_week, requested_slots = v_slots,
           proposed_slots = null, approval_code = null, tried_teacher_ids = '{}',
           teacher_choice_pending = false, schedule_change = true,
           student_note = left(btrim(coalesce(p_note, '')), 1000), updated_at = clock_timestamp()
     where id = n.id returning * into n;
    perform private.renewal_negotiation_log(n.id, 'STUDENT_CHANGED_REQUEST', jsonb_build_object('slots', v_slots));
  else
    insert into private.course_renewal_negotiations(tenant_id, student_id, source_offer_id, classes_per_week,
      requested_slots, student_note)
    values (p_tenant, p_student, o.id, p_classes_per_week, v_slots, left(btrim(coalesce(p_note, '')), 1000))
    returning * into n;
    perform private.renewal_negotiation_log(n.id, 'OPENED', jsonb_build_object('slots', v_slots,
      'classes_per_week', p_classes_per_week));
  end if;

  v_teacher := private.renewal_current_teacher(p_tenant, p_student);
  if v_teacher is not null then
    if n.teacher_choice_asked_at is null and not private.renewal_offer_choice_asked(o.id) then
      select c.teacher_id into v_alternative
        from private.renewal_teacher_candidates(p_tenant, p_student, v_slots, array[v_teacher]) c limit 1;
      if v_alternative is not null then
        update private.course_renewal_teacher_requests set status = 'SUPERSEDED', responded_at = clock_timestamp()
         where negotiation_id = n.id and status = 'PENDING';
        update private.course_renewal_negotiations
           set status = 'WAITING_STUDENT', teacher_id = v_teacher, alternative_teacher_id = v_alternative,
               teacher_choice_pending = true, teacher_choice_asked_at = clock_timestamp(), updated_at = clock_timestamp()
         where id = n.id;
        perform private.renewal_negotiation_log(n.id, 'TEACHER_CHOICE_ASKED',
          jsonb_build_object('current_teacher_id', v_teacher, 'alternative_teacher_id', v_alternative, 'slots', v_slots));
        select * into t from public.profiles where id = v_teacher;
        return jsonb_build_object('ok', true, 'action', 'ask_student_teacher_choice', 'negotiation_id', n.id,
          'teacher_id', v_teacher, 'teacher_name', t.full_name, 'slots', v_slots, 'schedule_change', true);
      end if;
    end if;
    return jsonb_build_object('ok', true, 'action', 'ask_teacher', 'negotiation_id', n.id, 'current_teacher', true)
      || private.renewal_ask_teacher(n.id, v_teacher, v_slots);
  end if;
  select * into v_candidate from private.renewal_teacher_candidates(p_tenant, p_student, v_slots, '{}') limit 1;
  if found then
    return jsonb_build_object('ok', true, 'action', 'ask_other_teacher', 'negotiation_id', n.id, 'current_teacher', false)
      || private.renewal_ask_teacher(n.id, v_candidate.teacher_id, v_slots);
  end if;
  update private.course_renewal_negotiations set status = 'WAITING_STUDENT', updated_at = clock_timestamp() where id = n.id;
  perform private.renewal_negotiation_log(n.id, 'NO_TEACHER_AVAILABLE', jsonb_build_object('slots', v_slots));
  return jsonb_build_object('ok', true, 'action', 'no_teacher_available', 'negotiation_id', n.id);
end;
$$;

-- Renovação sem mudança de horário: faz a pergunta uma vez, se houver alternativa real.
create or replace function public.offer_renewal_teacher_choice(p_tenant text, p_student uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype; v_teacher uuid; v_slots jsonb;
  v_alternative uuid; v_id uuid; t public.profiles%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-negotiation:' || p_tenant || ':' || p_student::text, 0));
  select * into o from private.student_course_renewal_offers
   where tenant_id = p_tenant and student_id = p_student and status = 'PENDING_SIGNATURE'
     and expires_at > clock_timestamp()
   order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_pending_renewal'); end if;
  if exists (select 1 from private.course_renewal_negotiations where student_id = p_student
      and status in ('WAITING_TEACHER', 'WAITING_STUDENT', 'WAITING_MANAGEMENT')) then
    return jsonb_build_object('ok', false, 'error', 'negotiation_open');
  end if;
  if private.renewal_offer_choice_asked(o.id) then return jsonb_build_object('ok', false, 'error', 'already_asked'); end if;
  v_teacher := private.renewal_current_teacher(p_tenant, p_student);
  if v_teacher is null then return jsonb_build_object('ok', false, 'error', 'no_current_teacher'); end if;
  v_slots := private.renewal_current_slots(p_tenant, p_student, o.id);
  if jsonb_array_length(v_slots) = 0 or jsonb_array_length(v_slots) <> o.classes_per_week then
    return jsonb_build_object('ok', false, 'error', 'no_current_schedule');
  end if;
  select c.teacher_id into v_alternative
    from private.renewal_teacher_candidates(p_tenant, p_student, v_slots, array[v_teacher]) c limit 1;
  if v_alternative is null then return jsonb_build_object('ok', false, 'error', 'no_alternative'); end if;
  insert into private.course_renewal_negotiations(tenant_id, student_id, source_offer_id, status, classes_per_week,
    requested_slots, teacher_id, alternative_teacher_id, teacher_choice_pending, teacher_choice_asked_at, schedule_change)
  values (p_tenant, p_student, o.id, 'WAITING_STUDENT', o.classes_per_week, v_slots, v_teacher, v_alternative,
    true, clock_timestamp(), false)
  returning id into v_id;
  perform private.renewal_negotiation_log(v_id, 'TEACHER_CHOICE_ASKED',
    jsonb_build_object('current_teacher_id', v_teacher, 'alternative_teacher_id', v_alternative,
      'slots', v_slots, 'schedule_change', false));
  select * into t from public.profiles where id = v_teacher;
  return jsonb_build_object('ok', true, 'action', 'ask_student_teacher_choice', 'negotiation_id', v_id,
    'teacher_id', v_teacher, 'teacher_name', t.full_name, 'slots', v_slots, 'schedule_change', false);
end;
$$;

-- Resposta do aluno: seguir com a atual (p_keep) ou consultar outro professor livre.
create or replace function public.student_choose_renewal_teacher(p_tenant text, p_student uuid, p_keep boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n private.course_renewal_negotiations%rowtype; s public.profiles%rowtype; t public.profiles%rowtype;
  v_alternative uuid;
begin
  if p_keep is null then raise exception 'renewal_choice_invalid'; end if;
  select * into n from private.course_renewal_negotiations
   where tenant_id = p_tenant and student_id = p_student and status = 'WAITING_STUDENT' and teacher_choice_pending
   for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_choice_pending'); end if;
  select * into s from public.profiles where id = n.student_id;
  select * into t from public.profiles where id = n.teacher_id;
  update private.course_renewal_negotiations set teacher_choice_pending = false, updated_at = clock_timestamp()
   where id = n.id;

  if p_keep then
    perform private.renewal_negotiation_log(n.id, 'STUDENT_KEPT_TEACHER', jsonb_build_object('teacher_id', n.teacher_id));
    if n.schedule_change then
      return jsonb_build_object('ok', true, 'action', 'ask_teacher', 'negotiation_id', n.id, 'current_teacher', true)
        || private.renewal_ask_teacher(n.id, n.teacher_id, n.requested_slots);
    end if;
    update private.course_renewal_negotiations set status = 'CLOSED', updated_at = clock_timestamp() where id = n.id;
    return jsonb_build_object('ok', true, 'action', 'kept', 'negotiation_id', n.id, 'teacher_name', t.full_name);
  end if;

  perform private.renewal_negotiation_log(n.id, 'STUDENT_ASKED_OTHER_TEACHER', jsonb_build_object('teacher_id', n.teacher_id));
  -- A alternativa pode ter sido ocupada desde a pergunta: revalida e cai para a próxima.
  select c.teacher_id into v_alternative
    from private.renewal_teacher_candidates(n.tenant_id, n.student_id, n.requested_slots, array[n.teacher_id]) c
   order by (c.teacher_id = n.alternative_teacher_id) desc, c.teacher_name limit 1;
  if v_alternative is null then
    perform private.renewal_negotiation_log(n.id, 'ALTERNATIVE_NO_LONGER_FREE', '{}'::jsonb);
    if n.schedule_change then
      return jsonb_build_object('ok', true, 'action', 'ask_teacher', 'negotiation_id', n.id,
        'current_teacher', true, 'no_alternative_left', true)
        || private.renewal_ask_teacher(n.id, n.teacher_id, n.requested_slots);
    end if;
    update private.course_renewal_negotiations set status = 'CLOSED', updated_at = clock_timestamp() where id = n.id;
    return jsonb_build_object('ok', true, 'action', 'no_alternative_left', 'negotiation_id', n.id, 'teacher_name', t.full_name);
  end if;
  update private.course_renewal_negotiations set tried_teacher_ids = tried_teacher_ids || n.teacher_id,
    updated_at = clock_timestamp() where id = n.id;
  return jsonb_build_object('ok', true, 'action', 'ask_other_teacher', 'negotiation_id', n.id,
    'previous_teacher_name', t.full_name, 'student_name', s.full_name, 'student_phone', s.phone)
    || private.renewal_ask_teacher(n.id, v_alternative, n.requested_slots);
end;
$$;

-- Prazo de 24h do professor: expira e avisa a Gestão.
create or replace function private.expire_renewal_teacher_requests()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_count integer := 0;
begin
  for r in
    select req.id, req.negotiation_id, req.teacher_id, req.reply_code, req.slots,
           n.tenant_id, n.student_id, s.full_name as student_name, t.full_name as teacher_name
      from private.course_renewal_teacher_requests req
      join private.course_renewal_negotiations n on n.id = req.negotiation_id
      left join public.profiles s on s.id = n.student_id
      left join public.profiles t on t.id = req.teacher_id
     where req.status = 'PENDING' and req.expires_at <= clock_timestamp()
     for update of req skip locked
  loop
    update private.course_renewal_teacher_requests set status = 'EXPIRED', responded_at = clock_timestamp()
     where id = r.id;
    perform private.renewal_negotiation_log(r.negotiation_id, 'TEACHER_REQUEST_EXPIRED',
      jsonb_build_object('teacher_id', r.teacher_id, 'reply_code', r.reply_code));
    perform private.notify_management_group(r.tenant_id, r.student_id, r.teacher_id, r.negotiation_id,
      'renewal-teacher-expired:' || r.id::text,
      format(E'⏰ *RENOVAÇÃO SEM RESPOSTA*\n\n👩‍🏫 %s não respondeu em 24h ao pedido de horário de *%s*: %s.\n\nFale com a professora ou peça ao aluno outros horários — quando ele mandar de novo, o bot reabre a consulta.',
        coalesce(r.teacher_name, 'O professor'), coalesce(r.student_name, 'aluno'), private.renewal_slots_text(r.slots)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

do $owners$
declare f text;
begin
  foreach f in array array[
    'private.renewal_slots_text(jsonb)',
    'private.renewal_current_slots(text,uuid,uuid)',
    'private.renewal_offer_choice_asked(uuid)',
    'private.expire_renewal_teacher_requests()',
    'public.renewal_negotiation_context(text,uuid)',
    'public.open_renewal_negotiation(text,uuid,smallint,jsonb,text)',
    'public.offer_renewal_teacher_choice(text,uuid)',
    'public.student_choose_renewal_teacher(text,uuid,boolean)'
  ] loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.renewal_negotiation_context(text,uuid)',
    'public.open_renewal_negotiation(text,uuid,smallint,jsonb,text)',
    'public.offer_renewal_teacher_choice(text,uuid)',
    'public.student_choose_renewal_teacher(text,uuid,boolean)'
  ] loop
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$owners$;

do $cron$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('wisewolf-renewal-teacher-expiry', '*/30 * * * *',
      'select private.expire_renewal_teacher_requests();');
  end if;
end $cron$;
