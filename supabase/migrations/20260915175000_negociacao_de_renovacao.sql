-- ─────────────────────────────────────────────────────────────────────────────
-- Negociação de renovação pelo WhatsApp (15/09/2026, pedido da direção)
--
-- O fluxo que a direção definiu, e que o banco agora faz valer:
-- 1. O aluno que está renovando pede outra frequência/horário no WhatsApp.
-- 2. Pergunta-se PRIMEIRO ao professor que já dá aula para ele. Se ele aceita,
--    segue; se não, ele pode propor outro horário, que volta para o aluno.
-- 3. Só se não houver acordo com esse professor procura-se OUTRO professor livre.
-- 4. Condição nova (preço inclusive) é decisão da Gestão: o link só nasce depois
--    de "aprovar #código" no grupo, por diretor ou coordenação.
-- 5. Tudo fica registrado (histórico da negociação + eventos da renovação).
--
-- O bot conversa; quem decide estado, conflito de agenda e dinheiro é o banco.
-- As funções são exclusivas do service_role usado pelo webhook.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists private.course_renewal_negotiations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  source_offer_id uuid not null references private.student_course_renewal_offers(id) on delete restrict,
  status text not null default 'WAITING_TEACHER'
    check (status in ('WAITING_TEACHER', 'WAITING_STUDENT', 'WAITING_MANAGEMENT', 'APPROVED', 'CLOSED')),
  classes_per_week smallint not null check (classes_per_week between 1 and 7),
  requested_slots jsonb not null check (jsonb_typeof(requested_slots) = 'array'),
  proposed_slots jsonb check (proposed_slots is null or jsonb_typeof(proposed_slots) = 'array'),
  teacher_id uuid references public.profiles(id) on delete restrict,
  tried_teacher_ids uuid[] not null default '{}',
  approval_code text unique check (approval_code is null or approval_code ~ '^[A-F0-9]{8}$'),
  approved_fee_cents bigint check (approved_fee_cents is null or approved_fee_cents > 0),
  approved_by uuid references public.profiles(id) on delete restrict,
  new_offer_id uuid references private.student_course_renewal_offers(id) on delete restrict,
  student_note text,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index if not exists course_renewal_negotiations_one_open
  on private.course_renewal_negotiations(student_id)
  where status in ('WAITING_TEACHER', 'WAITING_STUDENT', 'WAITING_MANAGEMENT');
create index if not exists course_renewal_negotiations_tenant_idx
  on private.course_renewal_negotiations(tenant_id, status, created_at desc);
alter table private.course_renewal_negotiations owner to postgres;
alter table private.course_renewal_negotiations enable row level security;
revoke all on private.course_renewal_negotiations from public, anon, authenticated, service_role;

create table if not exists private.course_renewal_teacher_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  negotiation_id uuid not null references private.course_renewal_negotiations(id) on delete restrict,
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  reply_code text not null unique
    default upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 8))
    check (reply_code ~ '^[A-F0-9]{8}$'),
  slots jsonb not null check (jsonb_typeof(slots) = 'array'),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'COUNTERED', 'SUPERSEDED', 'EXPIRED')),
  counter_slots jsonb check (counter_slots is null or jsonb_typeof(counter_slots) = 'array'),
  response_text text,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  responded_at timestamptz
);
create unique index if not exists course_renewal_teacher_requests_one_pending
  on private.course_renewal_teacher_requests(negotiation_id) where status = 'PENDING';
create index if not exists course_renewal_teacher_requests_teacher_idx
  on private.course_renewal_teacher_requests(teacher_id, status, created_at desc);
alter table private.course_renewal_teacher_requests owner to postgres;
alter table private.course_renewal_teacher_requests enable row level security;
revoke all on private.course_renewal_teacher_requests from public, anon, authenticated, service_role;

-- ── Peças puras ──────────────────────────────────────────────────────────────

-- Horários canônicos ("Segunda"/"14:30"), sem repetição. Erro = pedido inválido.
create or replace function private.renewal_normalize_slots(p_slots jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare slot jsonb; v_day text; v_time text; v_out jsonb := '[]'; v_keys text[] := '{}';
begin
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) not between 1 and 7 then
    raise exception 'renewal_slots_invalid';
  end if;
  for slot in select value from jsonb_array_elements(p_slots) loop
    -- Aceita "seg", "segunda", "Segunda-feira", "terca"…: as três primeiras letras decidem.
    v_day := case left(public.fold_accents(lower(btrim(coalesce(slot ->> 'day', '')))), 3)
      when 'seg' then 'Segunda' when 'ter' then 'Terça' when 'qua' then 'Quarta'
      when 'qui' then 'Quinta' when 'sex' then 'Sexta' when 'sab' then 'Sábado' else null end;
    v_time := left(btrim(coalesce(slot ->> 'time', '')), 5);
    if v_day is null or v_day = 'Domingo' or v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' then
      raise exception 'renewal_slots_invalid';
    end if;
    if (v_day || ' ' || v_time) = any(v_keys) then raise exception 'renewal_slots_invalid'; end if;
    v_keys := v_keys || (v_day || ' ' || v_time);
    v_out := v_out || jsonb_build_array(jsonb_build_object('day', v_day, 'time', v_time));
  end loop;
  return v_out;
end;
$$;

-- Horários em que o professor já tem aula fixa com OUTRO aluno.
create or replace function private.renewal_teacher_busy_slots(
  p_tenant text, p_teacher uuid, p_student uuid, p_slots jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(s.value), '[]'::jsonb)
    from jsonb_array_elements(p_slots) s
   where exists (
     select 1 from public.bookings b
      where b.tenant_id = p_tenant and b.teacher_id = p_teacher
        and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null
        and b.student_id is distinct from p_student
        and public.canonical_weekday_name(b.day_of_week) = s.value ->> 'day'
        and left(b.time_slot, 5) = s.value ->> 'time');
$$;

-- Professor que já dá aula ao aluno: agenda ativa primeiro, depois o último lançamento.
create or replace function private.renewal_current_teacher(p_tenant text, p_student uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select b.teacher_id from public.bookings b
      where b.tenant_id = p_tenant and b.student_id = p_student
        and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.teacher_id is not null
      group by b.teacher_id order by count(*) desc limit 1),
    (select cl.teacher_id from public.class_logs cl
      where cl.tenant_id = p_tenant and cl.student_id = p_student and cl.teacher_id is not null
        and cl.class_date >= (now() at time zone 'America/Sao_Paulo')::date - 120
      order by cl.class_date desc, cl.created_at desc limit 1));
$$;

-- Professores ativos, com a grade declarada cobrindo TODOS os horários e sem choque.
create or replace function private.renewal_teacher_candidates(
  p_tenant text, p_student uuid, p_slots jsonb, p_exclude uuid[])
returns table(teacher_id uuid, teacher_name text, teacher_phone text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, coalesce(nullif(btrim(p.attendance_phone), ''), p.phone)
    from public.profiles p
    join public.tenant_memberships m on m.user_id = p.id and m.tenant_id = p_tenant
     and m.status = 'ACTIVE' and m.role = 'TEACHER'
   where p.tenant_id = p_tenant and p.role = 'TEACHER'
     and lower(coalesce(p.lifecycle_status, 'active')) = 'active'
     and not (p.id = any(coalesce(p_exclude, '{}')))
     and not exists (
       select 1 from jsonb_array_elements(p_slots) s
        where not exists (
          select 1 from public.teacher_availability a
           where a.teacher_id = p.id and a.tenant_id = p_tenant
             and a.day_of_week = public.dow_name_to_int(s.value ->> 'day')
             and a.start_time = (s.value ->> 'time')::time))
     and jsonb_array_length(private.renewal_teacher_busy_slots(p_tenant, p.id, p_student, p_slots)) = 0
   order by p.full_name;
$$;

create or replace function private.renewal_negotiation_log(
  p_negotiation uuid, p_action text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare n private.course_renewal_negotiations%rowtype;
begin
  update private.course_renewal_negotiations
     set history = history || jsonb_build_array(jsonb_build_object('action', p_action, 'at', clock_timestamp()) || coalesce(p_payload, '{}')),
         updated_at = clock_timestamp()
   where id = p_negotiation returning * into n;
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (n.tenant_id, n.source_offer_id, 'NEGOTIATION_' || p_action,
          jsonb_build_object('negotiation_id', n.id) || coalesce(p_payload, '{}'));
end;
$$;

-- Pedido ao professor (substitui o pendente anterior da mesma negociação).
create or replace function private.renewal_ask_teacher(p_negotiation uuid, p_teacher uuid, p_slots jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n private.course_renewal_negotiations%rowtype; r private.course_renewal_teacher_requests%rowtype;
  t public.profiles%rowtype;
begin
  select * into n from private.course_renewal_negotiations where id = p_negotiation for update;
  update private.course_renewal_teacher_requests set status = 'SUPERSEDED', responded_at = clock_timestamp()
   where negotiation_id = n.id and status = 'PENDING';
  insert into private.course_renewal_teacher_requests(tenant_id, negotiation_id, teacher_id, slots)
  values (n.tenant_id, n.id, p_teacher, p_slots) returning * into r;
  update private.course_renewal_negotiations
     set status = 'WAITING_TEACHER', teacher_id = p_teacher, updated_at = clock_timestamp()
   where id = n.id;
  select * into t from public.profiles where id = p_teacher;
  perform private.renewal_negotiation_log(n.id, 'TEACHER_ASKED',
    jsonb_build_object('teacher_id', p_teacher, 'slots', p_slots, 'reply_code', r.reply_code));
  return jsonb_build_object('teacher_id', p_teacher, 'teacher_name', t.full_name,
    'teacher_phone', coalesce(nullif(btrim(t.attendance_phone), ''), t.phone),
    'reply_code', r.reply_code, 'slots', p_slots,
    'busy_slots', private.renewal_teacher_busy_slots(n.tenant_id, p_teacher, n.student_id, p_slots));
end;
$$;

-- Valor sugerido: mesma frequência mantém o valor da oferta; frequência nova usa a
-- tabela de 6 meses da escola. A Gestão confirma ou informa outro valor.
create or replace function private.renewal_suggested_fee_cents(p_negotiation uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select case when n.classes_per_week = o.classes_per_week then o.monthly_fee_cents else
    (select round(sp.monthly_price * 100)::bigint from public.student_pricing_plans sp
      where sp.tenant_id = n.tenant_id and sp.classes_per_week = n.classes_per_week
        and sp.fidelity_months = 6 and coalesce(sp.active, true)
      order by sp.monthly_price limit 1) end
    from private.course_renewal_negotiations n
    join private.student_course_renewal_offers o on o.id = n.source_offer_id
   where n.id = p_negotiation;
$$;

create or replace function private.renewal_await_management(p_negotiation uuid, p_teacher uuid, p_slots jsonb, p_source text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 8));
  n private.course_renewal_negotiations%rowtype; t public.profiles%rowtype; s public.profiles%rowtype;
begin
  update private.course_renewal_negotiations
     set status = 'WAITING_MANAGEMENT', teacher_id = p_teacher, proposed_slots = p_slots,
         approval_code = v_code, updated_at = clock_timestamp()
   where id = p_negotiation returning * into n;
  select * into t from public.profiles where id = p_teacher;
  select * into s from public.profiles where id = n.student_id;
  perform private.renewal_negotiation_log(n.id, 'AWAITING_MANAGEMENT',
    jsonb_build_object('teacher_id', p_teacher, 'slots', p_slots, 'approval_code', v_code, 'source', p_source));
  return jsonb_build_object('action', 'await_management', 'negotiation_id', n.id, 'approval_code', v_code,
    'student_id', n.student_id, 'student_name', s.full_name, 'student_phone', s.phone,
    'teacher_id', p_teacher, 'teacher_name', t.full_name, 'slots', p_slots,
    'classes_per_week', n.classes_per_week, 'suggested_fee_cents', private.renewal_suggested_fee_cents(n.id));
end;
$$;

-- ── Superfície do webhook (service_role) ─────────────────────────────────────

-- Fatos para o bot responder sem inventar: oferta pendente, negociação aberta, professor.
create or replace function public.renewal_negotiation_context(p_tenant text, p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype; n private.course_renewal_negotiations%rowtype;
  v_teacher uuid; t public.profiles%rowtype;
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
  return jsonb_build_object('active', true,
    'offer', case when o.id is null then null else jsonb_build_object('id', o.id, 'token', o.token,
      'monthly_fee_cents', o.monthly_fee_cents, 'classes_per_week', o.classes_per_week,
      'contract_start', o.contract_start, 'first_due_date', o.first_due_date,
      'service_end_date', o.service_end_date, 'schedule', o.schedule_plan -> 'slots') end,
    'negotiation', case when n.id is null then null else jsonb_build_object('id', n.id, 'status', n.status,
      'classes_per_week', n.classes_per_week, 'requested_slots', n.requested_slots,
      'proposed_slots', n.proposed_slots) end,
    'teacher', case when t.id is null then null else jsonb_build_object('id', t.id, 'name', t.full_name) end);
end;
$$;

-- O webhook só desvia mensagem de professor para este fluxo se houver pedido aberto.
create or replace function public.renewal_teacher_has_pending(p_tenant text, p_teacher uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.course_renewal_teacher_requests
    where tenant_id = p_tenant and teacher_id = p_teacher and status = 'PENDING');
$$;

-- Aluno pediu mudança. Pergunta primeiro ao professor atual; sem professor atual,
-- vai direto a quem está livre.
create or replace function public.open_renewal_negotiation(
  p_tenant text, p_student uuid, p_classes_per_week smallint, p_slots jsonb, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype; n private.course_renewal_negotiations%rowtype;
  v_slots jsonb; v_teacher uuid; v_candidate record;
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

-- Resposta do professor: ACCEPT, DECLINE ou COUNTER (com outros horários).
create or replace function public.respond_renewal_teacher_request(
  p_tenant text, p_teacher uuid, p_code text, p_decision text, p_counter_slots jsonb, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r private.course_renewal_teacher_requests%rowtype; n private.course_renewal_negotiations%rowtype;
  v_slots jsonb; v_busy jsonb; v_candidate record; s public.profiles%rowtype;
begin
  if p_decision not in ('ACCEPT', 'DECLINE', 'COUNTER') then raise exception 'renewal_decision_invalid'; end if;
  select * into r from private.course_renewal_teacher_requests
   where tenant_id = p_tenant and teacher_id = p_teacher and status = 'PENDING'
     and (nullif(upper(btrim(coalesce(p_code, ''))), '') is null or reply_code = upper(btrim(p_code)))
   order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_pending_request'); end if;
  select * into n from private.course_renewal_negotiations where id = r.negotiation_id for update;
  select * into s from public.profiles where id = n.student_id;
  if r.expires_at <= clock_timestamp() then
    update private.course_renewal_teacher_requests set status = 'EXPIRED', responded_at = clock_timestamp(),
      response_text = left(p_text, 500) where id = r.id;
    perform private.renewal_negotiation_log(n.id, 'TEACHER_REQUEST_EXPIRED', jsonb_build_object('teacher_id', p_teacher));
    return jsonb_build_object('ok', false, 'error', 'request_expired');
  end if;

  if p_decision = 'ACCEPT' then
    v_busy := private.renewal_teacher_busy_slots(n.tenant_id, p_teacher, n.student_id, r.slots);
    if jsonb_array_length(v_busy) > 0 then
      return jsonb_build_object('ok', false, 'error', 'teacher_busy', 'busy_slots', v_busy, 'reply_code', r.reply_code);
    end if;
    update private.course_renewal_teacher_requests set status = 'ACCEPTED', responded_at = clock_timestamp(),
      response_text = left(p_text, 500) where id = r.id;
    perform private.renewal_negotiation_log(n.id, 'TEACHER_ACCEPTED', jsonb_build_object('teacher_id', p_teacher, 'slots', r.slots));
    return jsonb_build_object('ok', true) || private.renewal_await_management(n.id, p_teacher, r.slots, 'teacher_accepted');
  end if;

  if p_decision = 'COUNTER' then
    v_slots := private.renewal_normalize_slots(p_counter_slots);
    if jsonb_array_length(v_slots) <> n.classes_per_week then
      return jsonb_build_object('ok', false, 'error', 'slots_must_match_frequency', 'classes_per_week', n.classes_per_week);
    end if;
    v_busy := private.renewal_teacher_busy_slots(n.tenant_id, p_teacher, n.student_id, v_slots);
    if jsonb_array_length(v_busy) > 0 then
      return jsonb_build_object('ok', false, 'error', 'teacher_busy', 'busy_slots', v_busy, 'reply_code', r.reply_code);
    end if;
    update private.course_renewal_teacher_requests set status = 'COUNTERED', counter_slots = v_slots,
      responded_at = clock_timestamp(), response_text = left(p_text, 500) where id = r.id;
    update private.course_renewal_negotiations set status = 'WAITING_STUDENT', proposed_slots = v_slots,
      teacher_id = p_teacher, updated_at = clock_timestamp() where id = n.id;
    perform private.renewal_negotiation_log(n.id, 'TEACHER_COUNTERED', jsonb_build_object('teacher_id', p_teacher, 'slots', v_slots));
    return jsonb_build_object('ok', true, 'action', 'ask_student', 'negotiation_id', n.id, 'slots', v_slots,
      'student_id', n.student_id, 'student_name', s.full_name, 'student_phone', s.phone);
  end if;

  -- DECLINE: tenta outro professor livre nos horários pedidos pelo aluno.
  update private.course_renewal_teacher_requests set status = 'DECLINED', responded_at = clock_timestamp(),
    response_text = left(p_text, 500) where id = r.id;
  update private.course_renewal_negotiations set tried_teacher_ids = tried_teacher_ids || p_teacher,
    updated_at = clock_timestamp() where id = n.id returning * into n;
  perform private.renewal_negotiation_log(n.id, 'TEACHER_DECLINED', jsonb_build_object('teacher_id', p_teacher));
  select * into v_candidate from private.renewal_teacher_candidates(n.tenant_id, n.student_id, n.requested_slots, n.tried_teacher_ids) limit 1;
  if found then
    return jsonb_build_object('ok', true, 'action', 'ask_other_teacher', 'negotiation_id', n.id,
      'student_id', n.student_id, 'student_name', s.full_name, 'student_phone', s.phone)
      || private.renewal_ask_teacher(n.id, v_candidate.teacher_id, n.requested_slots);
  end if;
  update private.course_renewal_negotiations set status = 'WAITING_STUDENT', teacher_id = null,
    updated_at = clock_timestamp() where id = n.id;
  perform private.renewal_negotiation_log(n.id, 'NO_TEACHER_AVAILABLE', jsonb_build_object('slots', n.requested_slots));
  return jsonb_build_object('ok', true, 'action', 'no_teacher_available', 'negotiation_id', n.id,
    'student_id', n.student_id, 'student_name', s.full_name, 'student_phone', s.phone);
end;
$$;

-- Aluno aceitou os horários que o professor propôs: o professor já disse que pode.
create or replace function public.student_accept_renewal_proposal(p_tenant text, p_student uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n private.course_renewal_negotiations%rowtype;
begin
  select * into n from private.course_renewal_negotiations
   where tenant_id = p_tenant and student_id = p_student and status = 'WAITING_STUDENT'
     and proposed_slots is not null and teacher_id is not null
   for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_proposal'); end if;
  if jsonb_array_length(private.renewal_teacher_busy_slots(n.tenant_id, n.teacher_id, n.student_id, n.proposed_slots)) > 0 then
    return jsonb_build_object('ok', false, 'error', 'teacher_busy');
  end if;
  perform private.renewal_negotiation_log(n.id, 'STUDENT_ACCEPTED_PROPOSAL', jsonb_build_object('slots', n.proposed_slots));
  return jsonb_build_object('ok', true) || private.renewal_await_management(n.id, n.teacher_id, n.proposed_slots, 'student_accepted');
end;
$$;

-- Gestão aprova no grupo: cancela a oferta antiga, emite a nova com horário e
-- põe o aviso oficial (com o link) na fila do `student-renewal-notify`.
create or replace function public.approve_renewal_negotiation(
  p_tenant text, p_code text, p_actor uuid, p_fee_cents bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n private.course_renewal_negotiations%rowtype; o private.student_course_renewal_offers%rowtype;
  v_fee bigint; v_due smallint; v_offer jsonb; v_offer_id uuid; v_note text; t public.profiles%rowtype;
begin
  if not exists (select 1 from public.tenant_memberships m join public.profiles p on p.id = m.user_id
      where m.user_id = p_actor and m.tenant_id = p_tenant and m.status = 'ACTIVE'
        and m.role in ('SCHOOL_ADMIN', 'COORDINATOR') and lower(coalesce(p.lifecycle_status, 'active')) = 'active') then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into n from private.course_renewal_negotiations
   where tenant_id = p_tenant and approval_code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if n.status = 'APPROVED' then return jsonb_build_object('ok', true, 'already', true, 'new_offer_id', n.new_offer_id); end if;
  if n.status <> 'WAITING_MANAGEMENT' then return jsonb_build_object('ok', false, 'error', 'not_awaiting_approval'); end if;
  select * into o from private.student_course_renewal_offers where id = n.source_offer_id for update;
  if o.status <> 'PENDING_SIGNATURE' then return jsonb_build_object('ok', false, 'error', 'source_offer_not_pending'); end if;
  v_fee := coalesce(p_fee_cents, private.renewal_suggested_fee_cents(n.id));
  if v_fee is null or v_fee <= 0 then return jsonb_build_object('ok', false, 'error', 'fee_required'); end if;
  v_due := least(extract(day from o.first_due_date)::smallint, 28::smallint);
  select * into t from public.profiles where id = n.teacher_id;
  v_note := format('Aprovado pela Gestão no WhatsApp (negociação %s, código %s): %sx por semana, %s com %s, R$ %s/mês.',
    n.id, n.approval_code, n.classes_per_week,
    (select string_agg(format('%s %s', s ->> 'day', s ->> 'time'), ', ') from jsonb_array_elements(n.proposed_slots) s),
    coalesce(t.full_name, 'professor'), replace(to_char(v_fee / 100.0, 'FM999999990.00'), '.', ','));

  perform private.cancel_student_course_renewal_offer(o.id, 'Superada por negociação aprovada pela Gestão (' || n.approval_code || ').');
  v_offer := private.issue_student_course_renewal_offer(
    private.register_student_course_renewal_change_proposal(n.tenant_id, n.student_id, v_fee, n.classes_per_week,
      v_due, v_note, encode(sha256(convert_to('renewal-negotiation:' || n.id::text || ':' || v_fee::text || ':' || p_actor::text, 'UTF8')), 'hex')),
    o.contract_start, o.previous_service_end_date, o.billing_strategy, o.provider_customer_id,
    o.provider_subscription_id, o.billing_type, o.expires_at);
  v_offer_id := (v_offer ->> 'id')::uuid;
  perform private.set_student_course_renewal_offer_schedule(v_offer_id, n.teacher_id, n.proposed_slots);
  -- O link segue pelo canal oficial da renovação (recibo de entrega incluído).
  insert into public.student_course_renewal_notification_outbox(offer_id, tenant_id, student_id, milestone, scheduled_at)
  values (v_offer_id, n.tenant_id, n.student_id, 'INITIAL', clock_timestamp())
  on conflict (offer_id, milestone) do nothing;
  update private.course_renewal_negotiations
     set status = 'APPROVED', approved_fee_cents = v_fee, approved_by = p_actor, new_offer_id = v_offer_id,
         updated_at = clock_timestamp()
   where id = n.id;
  perform private.renewal_negotiation_log(n.id, 'APPROVED',
    jsonb_build_object('approved_by', p_actor, 'fee_cents', v_fee, 'new_offer_id', v_offer_id));
  return jsonb_build_object('ok', true, 'already', false, 'new_offer_id', v_offer_id, 'fee_cents', v_fee,
    'student_id', n.student_id, 'teacher_id', n.teacher_id, 'teacher_name', t.full_name, 'slots', n.proposed_slots,
    'classes_per_week', n.classes_per_week);
end;
$$;

create or replace function public.close_renewal_negotiation(p_tenant text, p_code text, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n private.course_renewal_negotiations%rowtype;
begin
  if not exists (select 1 from public.tenant_memberships m
      where m.user_id = p_actor and m.tenant_id = p_tenant and m.status = 'ACTIVE'
        and m.role in ('SCHOOL_ADMIN', 'COORDINATOR')) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into n from private.course_renewal_negotiations
   where tenant_id = p_tenant and approval_code = upper(btrim(coalesce(p_code, '')))
     and status = 'WAITING_MANAGEMENT' for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update private.course_renewal_negotiations set status = 'CLOSED', updated_at = clock_timestamp() where id = n.id;
  perform private.renewal_negotiation_log(n.id, 'MANAGEMENT_DECLINED',
    jsonb_build_object('actor', p_actor, 'reason', left(btrim(coalesce(p_reason, '')), 500)));
  return jsonb_build_object('ok', true, 'student_id', n.student_id);
end;
$$;

-- Aluno suspenso não passa pelo filtro de perfis ativos do webhook e cairia no
-- funil de lead. Com renovação pendente ele é aluno: reconhece pelo telefone
-- (últimos 8 dígitos, imune ao 9º dígito e ao DDI) e só com resultado único.
create or replace function public.renewal_student_for_phone(p_tenant text, p_phone text)
returns table(student_id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  -- Mesma regra do `phonesMatch` do webhook: últimos 8 dígitos iguais e, quando os
  -- dois têm DDD, o DDD também (sem o 55 e sem o 9º dígito).
  with digits as (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d),
  input as (select right(d, 8) as tail,
      right(regexp_replace(regexp_replace(left(d, greatest(length(d) - 8, 0)), '^55', ''), '9$', ''), 2) as ddd
    from digits),
  matches as (
    select distinct p.id, p.full_name
      from public.profiles p, input i,
           lateral (select regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') as d) pd
     where length(i.tail) = 8 and p.tenant_id = p_tenant and p.role = 'STUDENT'
       and right(pd.d, 8) = i.tail
       and (i.ddd = '' or right(regexp_replace(regexp_replace(left(pd.d, greatest(length(pd.d) - 8, 0)), '^55', ''), '9$', ''), 2) in ('', i.ddd))
       and (exists (select 1 from private.student_course_renewal_offers o
                     where o.student_id = p.id and o.tenant_id = p_tenant
                       and o.status = 'PENDING_SIGNATURE' and o.expires_at > clock_timestamp())
            or exists (select 1 from private.course_renewal_negotiations n
                     where n.student_id = p.id and n.tenant_id = p_tenant
                       and n.status in ('WAITING_TEACHER', 'WAITING_STUDENT', 'WAITING_MANAGEMENT'))))
  select m.id, m.full_name from matches m where (select count(*) from matches) = 1;
$$;

do $owners$
declare f text;
begin
  foreach f in array array[
    'public.renewal_student_for_phone(text,text)',
    'public.renewal_teacher_has_pending(text,uuid)',
    'private.renewal_normalize_slots(jsonb)',
    'private.renewal_teacher_busy_slots(text,uuid,uuid,jsonb)',
    'private.renewal_current_teacher(text,uuid)',
    'private.renewal_teacher_candidates(text,uuid,jsonb,uuid[])',
    'private.renewal_negotiation_log(uuid,text,jsonb)',
    'private.renewal_ask_teacher(uuid,uuid,jsonb)',
    'private.renewal_suggested_fee_cents(uuid)',
    'private.renewal_await_management(uuid,uuid,jsonb,text)',
    'public.renewal_negotiation_context(text,uuid)',
    'public.open_renewal_negotiation(text,uuid,smallint,jsonb,text)',
    'public.respond_renewal_teacher_request(text,uuid,text,text,jsonb,text)',
    'public.student_accept_renewal_proposal(text,uuid)',
    'public.approve_renewal_negotiation(text,text,uuid,bigint)',
    'public.close_renewal_negotiation(text,text,uuid,text)'
  ] loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.renewal_negotiation_context(text,uuid)',
    'public.open_renewal_negotiation(text,uuid,smallint,jsonb,text)',
    'public.respond_renewal_teacher_request(text,uuid,text,text,jsonb,text)',
    'public.student_accept_renewal_proposal(text,uuid)',
    'public.approve_renewal_negotiation(text,text,uuid,bigint)',
    'public.close_renewal_negotiation(text,text,uuid,text)'
  ] loop
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$owners$;
