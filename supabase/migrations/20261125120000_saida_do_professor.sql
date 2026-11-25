-- Saída do professor: repasse rápido dos alunos e cálculo da multa de aviso.
--
-- Decisão da direção (25/11/2026, caso da Teacher Bruna): quando um professor sai,
-- os alunos dele são oferecidos aos professores que JÁ têm todos os horários do
-- aluno livres. O primeiro que aceitar fica com o aluno, sem aula experimental:
-- a primeira aula com o novo professor é a de conhecimento.
--
-- Nada aqui inventa regra de agenda: o aceite chama a MESMA transferência
-- definitiva da direção (admin_schedule_student_transfer), que confere os
-- horários, preserva o histórico e, na escola com termo por aluno, deixa a troca
-- PENDING até escola e professor assinarem. Assinado o termo, a troca é aplicada
-- sozinha (gatilho abaixo) e a família recebe o aviso.
--
-- A multa só é CALCULADA e mostrada à direção. Nada é descontado ou cobrado
-- automaticamente: o contrato exige manifestação do professor e acordo escrito.

create table if not exists public.teacher_departures (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  teacher_id uuid not null references public.profiles(id),
  notice_received_at timestamptz not null,
  last_day date not null,
  cutover_date date not null,
  reason text not null,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_reason text
);
create unique index if not exists uq_teacher_departures_open
  on public.teacher_departures (tenant_id, teacher_id) where status = 'OPEN';

create table if not exists public.teacher_departure_offers (
  id uuid primary key default gen_random_uuid(),
  departure_id uuid not null references public.teacher_departures(id) on delete cascade,
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  slots jsonb not null,
  status text not null default 'OPEN' check (status in ('OPEN','CLAIMED','ASSIGNED','CANCELLED')),
  claimed_by uuid references public.profiles(id),
  claimed_at timestamptz,
  transfer_id uuid references public.teacher_transfers(id),
  created_at timestamptz not null default now(),
  unique (departure_id, student_id)
);
create index if not exists idx_teacher_departure_offers_open
  on public.teacher_departure_offers (tenant_id) where status = 'OPEN';
create index if not exists idx_teacher_departure_offers_transfer
  on public.teacher_departure_offers (transfer_id) where transfer_id is not null;

alter table public.teacher_departures owner to postgres;
alter table public.teacher_departure_offers owner to postgres;
alter table public.teacher_departures enable row level security;
alter table public.teacher_departure_offers enable row level security;
-- Só por RPC: sem policy, sem grant direto.
revoke all on public.teacher_departures from public, anon, authenticated;
revoke all on public.teacher_departure_offers from public, anon, authenticated;

-- Horários fixos do aluno com o professor que sai, no formato da transferência
-- (dia canônico + HH:MI). É o mesmo conjunto que admin_schedule_student_transfer
-- conta para exigir "mesma quantidade de aulas".
create or replace function private.departure_student_slots(p_tenant text, p_teacher uuid)
returns table(student_id uuid, slots jsonb)
language sql stable security definer set search_path = '' as $$
  select booking.student_id,
         jsonb_agg(jsonb_build_object(
           'day_of_week', public.canonical_weekday_name(booking.day_of_week),
           'time_slot', left(booking.time_slot, 5))
           order by public.dow_name_to_int(booking.day_of_week), left(booking.time_slot, 5))
    from public.bookings booking
    join public.profiles student on student.id = booking.student_id
   where booking.tenant_id = p_tenant
     and booking.teacher_id = p_teacher
     and student.professor_id = p_teacher
     and booking.status = 'SCHEDULED'
     and booking.date is null
     and booking.student_id is not null
     and student.lifecycle_status = 'active'
   group by booking.student_id;
$$;
alter function private.departure_student_slots(text, uuid) owner to postgres;
revoke all on function private.departure_student_slots(text, uuid) from public, anon, authenticated, service_role;

-- O professor tem TODOS os horários do aluno livres a partir da data da troca.
create or replace function private.departure_fits(p_tenant text, p_teacher uuid, p_student uuid, p_slots jsonb, p_cutover date)
returns boolean
language sql stable security definer set search_path = '' as $$
  select jsonb_array_length(p_slots) > 0 and public.is_student_notifiable(p_student) and not exists (
    select 1 from jsonb_array_elements(p_slots) slot
     where not private.transfer_slot_available(
       p_tenant, p_teacher, public.dow_name_to_int(slot->>'day_of_week'),
       (slot->>'time_slot')::time, p_cutover, p_student));
$$;
alter function private.departure_fits(text, uuid, uuid, jsonb, date) owner to postgres;
revoke all on function private.departure_fits(text, uuid, uuid, jsonb, date) from public, anon, authenticated, service_role;

-- Professores que podem receber aluno: ativos na escola, mesma marca de teste do aluno.
create or replace function private.departure_eligible_teachers(p_tenant text, p_exclude uuid)
returns table(teacher_id uuid, full_name text, phone text, is_test_account boolean)
language sql stable security definer set search_path = '' as $$
  select teacher.id, teacher.full_name,
         private.whatsapp_digits(coalesce(nullif(teacher.attendance_phone, ''), nullif(teacher.phone, ''))),
         coalesce(teacher.is_test_account, false)
    from public.profiles teacher
    join public.tenant_memberships membership
      on membership.user_id = teacher.id and membership.tenant_id = p_tenant
     and membership.role = 'TEACHER' and membership.status = 'ACTIVE'
   where teacher.tenant_id = p_tenant
     and teacher.role = 'TEACHER'
     and teacher.lifecycle_status = 'active'
     and teacher.id <> p_exclude;
$$;
alter function private.departure_eligible_teachers(text, uuid) owner to postgres;
revoke all on function private.departure_eligible_teachers(text, uuid) from public, anon, authenticated, service_role;

-- Multa de aviso não cumprido. Regras (só cálculo, nunca cobrança):
-- * contrato geral (6.4 até a v2; 6.5 na v3 PJ): média mensal dos até 3 últimos
--   fechamentos anteriores ao mês do aviso × dias de aviso não cumpridos ÷ 30;
-- * termo individual a partir do modelo jurídico 2 (cláusula 5.2): dois meses de
--   honorários daquele aluno (média dos meses completos, até 3; sem mês completo,
--   valor de referência × unidades semanais × 8,6). Esse aluno sai da base do
--   contrato geral para não cobrar duas vezes o mesmo atendimento;
-- * crédito a receber (fechamentos não pagos + aulas do mês ainda sem fechamento),
--   que é o que permite compensar por acordo escrito.
create or replace function private.teacher_departure_penalty(p_tenant text, p_teacher uuid, p_notice_at timestamptz, p_last_day date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_notice date := (p_notice_at at time zone 'America/Sao_Paulo')::date;
  v_served integer;
  v_missing integer;
  v_version integer;
  v_closings jsonb := '[]'::jsonb;
  v_base numeric := 0;
  v_count integer := 0;
  v_general numeric := 0;
  v_terms jsonb := '[]'::jsonb;
  v_terms_total numeric := 0;
  v_unpaid numeric := 0;
  v_accrual numeric := 0;
  v_last_month text;
  r record;
  t record;
  v_share numeric;
  v_months integer;
  v_avg numeric;
  v_amount numeric;
begin
  v_served := greatest(0, least(30, p_last_day - v_notice));
  v_missing := 30 - v_served;

  select coalesce(max(a.terms_version), 0) into v_version
    from public.contract_terms_acceptances a
   where a.user_id = p_teacher and a.tenant_id = p_tenant and a.contract_kind = 'TEACHER';
  if v_version = 0 then
    select coalesce(max(nullif(rec.commercial_snapshot->>'contractTermsVersion', '')::integer), 1) into v_version
      from public.tenant_contract_records rec
     where rec.user_id = p_teacher and rec.tenant_id = p_tenant and rec.contract_kind = 'TEACHER';
  end if;
  v_version := coalesce(nullif(v_version, 0), 1);

  -- Termos com multa própria de abandono (modelo jurídico >= 2).
  for t in
    select term.student_id, term.student_name, term.unit_rate, term.starts_on,
           jsonb_array_length(coalesce(term.slots, '[]'::jsonb)) as units,
           coalesce((substring(term.body from 'Modelo jurídico: ([0-9]+)'))::integer, 1) as model
      from private.teacher_student_terms term
     where term.tenant_id = p_tenant and term.teacher_id = p_teacher
       and term.status = 'EXECUTED' and term.retired_at is null
  loop
    if t.model < 2 then continue; end if;
    select count(*), avg(month_total) into v_months, v_avg
      from (
        select month_start,
               coalesce((select sum(log.rate_efetivo) from public.v_payable_class_logs log
                          where log.teacher_id = p_teacher and log.student_id = t.student_id
                            and log.class_date >= month_start
                            and log.class_date < (month_start + interval '1 month')::date), 0) as month_total
          from generate_series(date_trunc('month', v_notice) - interval '3 months',
                               date_trunc('month', v_notice) - interval '1 month',
                               interval '1 month') as gs(month_ts)
          cross join lateral (select gs.month_ts::date as month_start) m
         where m.month_start >= coalesce(t.starts_on, 'infinity'::date)
      ) months;
    if coalesce(v_months, 0) > 0 then
      v_amount := round(v_avg * 2, 2);
    else
      v_amount := round(coalesce(t.unit_rate, 0) * t.units * 8.6, 2);
    end if;
    if v_missing = 0 then v_amount := 0; end if;
    v_terms_total := v_terms_total + v_amount;
    v_terms := v_terms || jsonb_build_object(
      'student_id', t.student_id, 'student_name', t.student_name, 'model', t.model,
      'method', case when coalesce(v_months, 0) > 0 then 'MEDIA_DOS_MESES_COMPLETOS' else 'REFERENCIA_X_UNIDADES_X_8_6' end,
      'complete_months', coalesce(v_months, 0), 'unit_rate', t.unit_rate, 'units_per_week', t.units,
      'amount', v_amount);
  end loop;

  -- Base do contrato geral: fechamentos anteriores ao mês do aviso, sem os alunos com termo próprio.
  for r in
    select closing.month_year, closing.total_amount
      from public.teacher_closings closing
     where closing.tenant_id = p_tenant and closing.teacher_id = p_teacher
       and closing.month_year < to_char(v_notice, 'YYYY-MM')
     order by closing.month_year desc
     limit 3
  loop
    select coalesce(sum(log.rate_efetivo), 0) into v_share
      from public.v_payable_class_logs log
     where log.teacher_id = p_teacher
       and to_char(log.class_date, 'YYYY-MM') = r.month_year
       and log.student_id in (select (term->>'student_id')::uuid from jsonb_array_elements(v_terms) term);
    v_closings := v_closings || jsonb_build_object(
      'month', r.month_year, 'amount', coalesce(r.total_amount, 0), 'term_students_share', v_share);
    v_base := v_base + greatest(0, coalesce(r.total_amount, 0) - v_share);
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then
    v_base := round(v_base / v_count, 2);
    v_general := round(v_base * v_missing / 30.0, 2);
  end if;

  -- Crédito a receber, que pode ser compensado por acordo escrito.
  select coalesce(sum(closing.total_amount), 0), max(closing.month_year) into v_unpaid, v_last_month
    from public.teacher_closings closing
   where closing.tenant_id = p_tenant and closing.teacher_id = p_teacher and closing.paid_at is null;
  select max(closing.month_year) into v_last_month
    from public.teacher_closings closing
   where closing.tenant_id = p_tenant and closing.teacher_id = p_teacher;
  select coalesce(sum(log.rate_efetivo), 0) into v_accrual
    from public.v_payable_class_logs log
   where log.teacher_id = p_teacher
     and (v_last_month is null or log.class_date >= ((v_last_month || '-01')::date + interval '1 month')::date);

  return jsonb_build_object(
    'notice_date', v_notice,
    'notice_end', v_notice + 30,
    'last_day', p_last_day,
    'days_served', v_served,
    'days_missing', v_missing,
    'contract_version', v_version,
    'contract_clause', case when v_version >= 3 then '6.5' else '6.4' end,
    'closings', v_closings,
    'monthly_base', v_base,
    'general_penalty', v_general,
    'term_penalties', v_terms,
    'term_penalties_total', v_terms_total,
    'total', v_general + v_terms_total,
    'transition_bonus_lost', v_missing > 0,
    'credit', jsonb_build_object('unpaid_closings', v_unpaid, 'current_accrual', v_accrual, 'total', v_unpaid + v_accrual)
  );
end $$;
alter function private.teacher_departure_penalty(text, uuid, timestamptz, date) owner to postgres;
revoke all on function private.teacher_departure_penalty(text, uuid, timestamptz, date) from public, anon, authenticated, service_role;

-- Texto curto dos horários: "Segunda 15:30, Terça 15:30".
create or replace function private.departure_slots_text(p_slots jsonb)
returns text language sql immutable set search_path = '' as $$
  select coalesce(string_agg((slot->>'day_of_week') || ' ' || (slot->>'time_slot'), ', ' order by ord), '')
    from jsonb_array_elements(p_slots) with ordinality as s(slot, ord);
$$;
alter function private.departure_slots_text(jsonb) owner to postgres;
revoke all on function private.departure_slots_text(jsonb) from public, anon, authenticated, service_role;

-- Aviso pela fila oficial (instância central), idempotente pela chave.
create or replace function private.departure_enqueue(p_tenant text, p_name text, p_destination text, p_body text, p_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_destination is null or btrim(p_destination) = '' then return false; end if;
  insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
      source_type, notification_kind, idempotency_key)
  values (p_tenant, private.management_group_default_actor(p_tenant), p_name, p_destination, p_body, now(), 'pending',
      'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', p_key)
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;
  return v_id is not null;
end $$;
alter function private.departure_enqueue(text, text, text, text, text) owner to postgres;
revoke all on function private.departure_enqueue(text, text, text, text, text) from public, anon, authenticated, service_role;

-- Aviso à família quando a troca passa a valer (termo assinado ou escola sem termo).
create or replace function private.departure_notify_applied(p_offer uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.teacher_departure_offers%rowtype;
  d public.teacher_departures%rowtype;
  student public.profiles%rowtype;
  teacher public.profiles%rowtype;
  v_cutover date;
  v_phone text;
begin
  select * into o from public.teacher_departure_offers where id = p_offer;
  if not found or o.claimed_by is null then return; end if;
  select * into d from public.teacher_departures where id = o.departure_id;
  select * into student from public.profiles where id = o.student_id;
  select * into teacher from public.profiles where id = o.claimed_by;
  select cutover_date into v_cutover from public.teacher_transfers where id = o.transfer_id;
  v_cutover := coalesce(v_cutover, d.cutover_date);
  if public.is_student_notifiable(student.id) then
    v_phone := private.whatsapp_digits(coalesce(nullif(student.attendance_phone, ''), nullif(student.phone, ''), nullif(student.guardian_phone, '')));
    perform private.departure_enqueue(o.tenant_id, student.full_name, v_phone, format(
      E'Olá, %s! 🐺\n\nA partir de %s, suas aulas (%s) passam a ser com a *Teacher %s*. Os dias e horários continuam os mesmos.\n\nA primeira aula já é para vocês se conhecerem. Se por algum motivo não se adaptar, é só responder aqui que a escola encontra outra opção.\n\nBons estudos!',
      split_part(btrim(coalesce(student.full_name, '')), ' ', 1), to_char(v_cutover, 'DD/MM'),
      private.departure_slots_text(o.slots), split_part(btrim(coalesce(teacher.full_name, '')), ' ', 1)),
      'teacher-departure-offer:' || o.id::text || ':family');
  end if;
  perform private.departure_enqueue(o.tenant_id, 'Coordenação', private.tenant_notice_destination(o.tenant_id, 'coordenacao'), format(
    E'✅ Troca confirmada: *%s* passa para a *Teacher %s* a partir de %s (%s). A família foi avisada.',
    btrim(coalesce(student.full_name, '')), btrim(coalesce(teacher.full_name, '')), to_char(v_cutover, 'DD/MM'),
    private.departure_slots_text(o.slots)),
    'teacher-departure-offer:' || o.id::text || ':applied');
end $$;
alter function private.departure_notify_applied(uuid) owner to postgres;
revoke all on function private.departure_notify_applied(uuid) from public, anon, authenticated, service_role;

-- Aceite (pelo professor) ou atribuição (pela direção): a transferência oficial.
create or replace function private.departure_take_offer(p_offer uuid, p_teacher uuid, p_status text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o public.teacher_departure_offers%rowtype;
  d public.teacher_departures%rowtype;
  student public.profiles%rowtype;
  teacher public.profiles%rowtype;
  leaving public.profiles%rowtype;
  v_cutover date;
  v_result jsonb;
  v_transfer public.teacher_transfers%rowtype;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into o from public.teacher_departure_offers where id = p_offer for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'oferta_inexistente'); end if;
  if o.status <> 'OPEN' then return jsonb_build_object('ok', false, 'error', 'aluno_ja_atribuido'); end if;
  select * into d from public.teacher_departures where id = o.departure_id;
  if d.status <> 'OPEN' then return jsonb_build_object('ok', false, 'error', 'saida_encerrada'); end if;
  select * into student from public.profiles where id = o.student_id;
  select * into teacher from public.profiles where id = p_teacher;
  select * into leaving from public.profiles where id = d.teacher_id;
  if student.professor_id is distinct from d.teacher_id then
    return jsonb_build_object('ok', false, 'error', 'aluno_mudou_de_professor');
  end if;
  v_cutover := greatest(d.cutover_date, v_today);
  if not private.departure_fits(o.tenant_id, p_teacher, o.student_id, o.slots, v_cutover) then
    return jsonb_build_object('ok', false, 'error', 'horario_indisponivel');
  end if;

  -- A transferência oficial exige gestor da escola na sessão: quem aceita pelo
  -- painel é professor, então age como a direção da escola só nesta chamada.
  perform private.trial_closing_act_as(p_actor);
  begin
    v_result := public.admin_schedule_student_transfer(
      o.student_id, p_teacher, o.slots, v_cutover,
      format('Saída da Teacher %s: aluno assumido pelo repasse de alunos', btrim(coalesce(leaving.full_name, ''))),
      o.id);
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'error', 'horario_indisponivel');
  end;

  select * into v_transfer from public.teacher_transfers where id = (v_result->>'transfer_id')::uuid;
  update public.teacher_departure_offers
     set status = p_status, claimed_by = p_teacher, claimed_at = now(), transfer_id = v_transfer.id
   where id = o.id;

  insert into public.audit_logs (tenant_id, user_id, user_role, action, resource_type, resource_id, new_values)
  values (o.tenant_id, p_actor, 'SCHOOL_ADMIN',
          case when p_status = 'CLAIMED' then 'teacher_departure_offer_claimed' else 'teacher_departure_offer_assigned' end,
          'teacher_departure_offers', o.id::text,
          jsonb_build_object('teacher', p_teacher, 'transfer_id', v_transfer.id, 'cutover', v_cutover));

  perform private.departure_enqueue(o.tenant_id, 'Coordenação', private.tenant_notice_destination(o.tenant_id, 'coordenacao'), format(
    E'🔁 *Teacher %s* %s o aluno *%s* (%s), a partir de %s.%s',
    btrim(coalesce(teacher.full_name, '')),
    case when p_status = 'CLAIMED' then 'aceitou' else 'recebeu da direção' end,
    btrim(coalesce(student.full_name, '')), private.departure_slots_text(o.slots), to_char(v_cutover, 'DD/MM'),
    case when v_transfer.status = 'PENDING' then E'\nFalta assinar o termo do aluno (escola e professor recebem o link). Assinado, a troca vale sozinha.' else '' end),
    'teacher-departure-offer:' || o.id::text || ':taken');

  if v_transfer.status in ('ACCEPTED', 'APPLIED') then
    perform private.departure_notify_applied(o.id);
  end if;

  return jsonb_build_object('ok', true, 'transfer_id', v_transfer.id, 'cutover_date', v_cutover,
    'pending_terms', v_transfer.status = 'PENDING', 'student_name', student.full_name);
end $$;
alter function private.departure_take_offer(uuid, uuid, text, uuid) owner to postgres;
revoke all on function private.departure_take_offer(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- Prévia e situação para a direção.
create or replace function private.departure_students_view(p_tenant text, p_teacher uuid, p_cutover date, p_departure uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  with base as (
    select o.id as offer_id, o.student_id, o.slots, o.status, o.claimed_by, o.transfer_id
      from public.teacher_departure_offers o
     where p_departure is not null and o.departure_id = p_departure
    union all
    select null::uuid, s.student_id, s.slots, 'PREVIEW', null::uuid, null::uuid
      from private.departure_student_slots(p_tenant, p_teacher) s
     where p_departure is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'offer_id', b.offer_id,
           'student_id', b.student_id,
           'student_name', student.full_name,
           'blocked', not public.is_student_notifiable(b.student_id),
           'slots', b.slots,
           'status', b.status,
           'claimed_by_name', taker.full_name,
           'transfer_status', transfer.status,
           'transfer_cutover', transfer.cutover_date,
           'candidates', case when b.status in ('OPEN', 'PREVIEW') then coalesce((
              select jsonb_agg(jsonb_build_object('id', t.teacher_id, 'name', t.full_name) order by t.full_name)
                from private.departure_eligible_teachers(p_tenant, p_teacher) t
               where t.is_test_account = coalesce(student.is_test_account, false)
                 and private.departure_fits(p_tenant, t.teacher_id, b.student_id, b.slots, p_cutover)), '[]'::jsonb)
             else '[]'::jsonb end
         ) order by student.full_name), '[]'::jsonb)
    into v
    from base b
    join public.profiles student on student.id = b.student_id
    left join public.profiles taker on taker.id = b.claimed_by
    left join public.teacher_transfers transfer on transfer.id = b.transfer_id;
  return v;
end $$;
alter function private.departure_students_view(text, uuid, date, uuid) owner to postgres;
revoke all on function private.departure_students_view(text, uuid, date, uuid) from public, anon, authenticated, service_role;

create or replace function public.teacher_departure_preview(p_teacher uuid, p_notice_at timestamptz, p_last_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare teacher public.profiles%rowtype; v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into teacher from public.profiles where id = p_teacher and role = 'TEACHER';
  if auth.uid() is null or not found or not coalesce(private.quality_school_manager(teacher.tenant_id), false) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_notice_at is null or p_last_day is null then
    raise exception 'Informe quando o aviso chegou e o último dia de aula.' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true,
    'cutover_date', greatest(p_last_day + 1, v_today),
    'students', private.departure_students_view(teacher.tenant_id, p_teacher, greatest(p_last_day + 1, v_today), null),
    'penalty', private.teacher_departure_penalty(teacher.tenant_id, p_teacher, p_notice_at, p_last_day));
end $$;

create or replace function public.get_teacher_departure(p_teacher uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare teacher public.profiles%rowtype; d public.teacher_departures%rowtype; v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into teacher from public.profiles where id = p_teacher and role = 'TEACHER';
  if auth.uid() is null or not found or not coalesce(private.quality_school_manager(teacher.tenant_id), false) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  select * into d from public.teacher_departures
   where tenant_id = teacher.tenant_id and teacher_id = p_teacher
   order by (status = 'OPEN') desc, created_at desc limit 1;
  if not found then return jsonb_build_object('ok', true, 'departure', null); end if;
  return jsonb_build_object('ok', true,
    'departure', jsonb_build_object('id', d.id, 'status', d.status, 'notice_received_at', d.notice_received_at,
       'last_day', d.last_day, 'cutover_date', d.cutover_date, 'reason', d.reason, 'created_at', d.created_at),
    'students', private.departure_students_view(teacher.tenant_id, p_teacher, greatest(d.cutover_date, v_today), d.id),
    'penalty', private.teacher_departure_penalty(teacher.tenant_id, p_teacher, d.notice_received_at, d.last_day));
end $$;

create or replace function public.open_teacher_departure(p_teacher uuid, p_notice_at timestamptz, p_last_day date, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  teacher public.profiles%rowtype;
  v_id uuid;
  v_cutover date;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_offers integer := 0;
  v_without integer := 0;
  v_notified integer := 0;
  v_portal text;
  s record;
  t record;
  v_fit integer;
begin
  select * into teacher from public.profiles where id = p_teacher and role = 'TEACHER' for update;
  if auth.uid() is null or not found or not coalesce(private.quality_school_manager(teacher.tenant_id), false) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_notice_at is null or p_last_day is null or p_notice_at > now() + interval '1 day' then
    raise exception 'Informe quando o aviso chegou e o último dia de aula.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) not between 8 and 1000 then
    raise exception 'Informe o motivo da saída (mínimo de 8 caracteres).' using errcode = '22023';
  end if;
  if exists (select 1 from public.teacher_departures where tenant_id = teacher.tenant_id and teacher_id = p_teacher and status = 'OPEN') then
    raise exception 'Já existe uma saída aberta para este professor.' using errcode = '23505';
  end if;

  v_cutover := greatest(p_last_day + 1, v_today);
  insert into public.teacher_departures (tenant_id, teacher_id, notice_received_at, last_day, cutover_date, reason, created_by)
  values (teacher.tenant_id, p_teacher, p_notice_at, p_last_day, p_last_day + 1, btrim(p_reason), auth.uid())
  returning id into v_id;

  for s in select * from private.departure_student_slots(teacher.tenant_id, p_teacher) loop
    insert into public.teacher_departure_offers (departure_id, tenant_id, student_id, slots)
    values (v_id, teacher.tenant_id, s.student_id, s.slots);
    v_offers := v_offers + 1;
    if not exists (
      select 1 from private.departure_eligible_teachers(teacher.tenant_id, p_teacher) cand
        join public.profiles student on student.id = s.student_id
       where cand.is_test_account = coalesce(student.is_test_account, false)
         and private.departure_fits(teacher.tenant_id, cand.teacher_id, s.student_id, s.slots, v_cutover)
    ) then v_without := v_without + 1; end if;
  end loop;

  -- Um WhatsApp por professor que tem algum aluno cabendo inteiro na agenda.
  v_portal := private.lesson_recording_portal_url(teacher.tenant_id);
  for t in select * from private.departure_eligible_teachers(teacher.tenant_id, p_teacher) loop
    select count(*) into v_fit
      from public.teacher_departure_offers o
      join public.profiles student on student.id = o.student_id
     where o.departure_id = v_id
       and coalesce(student.is_test_account, false) = t.is_test_account
       and private.departure_fits(teacher.tenant_id, t.teacher_id, o.student_id, o.slots, v_cutover);
    if v_fit > 0 and private.departure_enqueue(teacher.tenant_id, t.full_name, t.phone, format(
      E'Oi, Teacher %s! 🐺\n\nTemos *%s aluno(s)* da escola trocando de professor, com horários que já cabem inteiros na sua agenda a partir de %s.\n\nQuem aceitar primeiro fica com o aluno, sem aula experimental: a primeira aula já é para vocês se conhecerem.\n\nPara ver e aceitar, entre no portal%s: aparece no seu Início, em *Alunos disponíveis*.',
      split_part(btrim(coalesce(t.full_name, '')), ' ', 1), v_fit, to_char(v_cutover, 'DD/MM'),
      case when v_portal is not null then ' (' || v_portal || ')' else '' end),
      'teacher-departure:' || v_id::text || ':invite:' || t.teacher_id::text) then
      v_notified := v_notified + 1;
    end if;
  end loop;

  perform private.departure_enqueue(teacher.tenant_id, 'Coordenação', private.tenant_notice_destination(teacher.tenant_id, 'coordenacao'), format(
    E'📤 Saída da *Teacher %s*: último dia %s. %s aluno(s) abertos para os professores (%s avisados).%s',
    btrim(coalesce(teacher.full_name, '')), to_char(p_last_day, 'DD/MM'), v_offers, v_notified,
    case when v_without > 0 then format(E'\n⚠️ %s aluno(s) sem professor livre em todos os horários: a direção atribui na ficha da Teacher.', v_without) else '' end),
    'teacher-departure:' || v_id::text || ':opened');

  insert into public.audit_logs (tenant_id, user_id, user_role, action, resource_type, resource_id, new_values)
  values (teacher.tenant_id, auth.uid(), public._my_role(), 'teacher_departure_opened', 'teacher_departures', v_id::text,
          jsonb_build_object('teacher', p_teacher, 'last_day', p_last_day, 'notice_at', p_notice_at, 'offers', v_offers));

  return jsonb_build_object('ok', true, 'departure_id', v_id, 'offers', v_offers, 'without_candidate', v_without,
    'teachers_notified', v_notified, 'cutover_date', v_cutover);
end $$;

create or replace function public.assign_departure_offer(p_offer uuid, p_teacher uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tenant text;
begin
  select tenant_id into v_tenant from public.teacher_departure_offers where id = p_offer;
  if auth.uid() is null or v_tenant is null or not coalesce(private.quality_school_manager(v_tenant), false) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  return private.departure_take_offer(p_offer, p_teacher, 'ASSIGNED', auth.uid());
end $$;

create or replace function public.close_teacher_departure(p_departure uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.teacher_departures%rowtype; v_cancelled integer;
begin
  select * into d from public.teacher_departures where id = p_departure for update;
  if auth.uid() is null or not found or not coalesce(private.quality_school_manager(d.tenant_id), false) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception 'Informe o motivo (mínimo de 8 caracteres).' using errcode = '22023';
  end if;
  if d.status <> 'OPEN' then return jsonb_build_object('ok', true, 'idempotent', true); end if;
  update public.teacher_departure_offers set status = 'CANCELLED' where departure_id = d.id and status = 'OPEN';
  get diagnostics v_cancelled = row_count;
  update public.teacher_departures set status = 'CLOSED', closed_at = now(), closed_reason = btrim(p_reason) where id = d.id;
  insert into public.audit_logs (tenant_id, user_id, user_role, action, resource_type, resource_id, new_values)
  values (d.tenant_id, auth.uid(), public._my_role(), 'teacher_departure_closed', 'teacher_departures', d.id::text,
          jsonb_build_object('reason', btrim(p_reason), 'offers_cancelled', v_cancelled));
  return jsonb_build_object('ok', true, 'offers_cancelled', v_cancelled);
end $$;

-- Painel do professor: alunos abertos que cabem inteiros na agenda dele.
-- Antes do aceite só aparecem primeiro nome + inicial e os horários.
create or replace function public.my_departure_offers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.profiles%rowtype; v_today date := (now() at time zone 'America/Sao_Paulo')::date; v jsonb;
begin
  select * into me from public.profiles where id = auth.uid();
  if not found or me.role <> 'TEACHER' or me.lifecycle_status <> 'active' or not exists (
    select 1 from public.tenant_memberships m where m.user_id = me.id and m.tenant_id = me.tenant_id and m.role = 'TEACHER' and m.status = 'ACTIVE')
  then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'offer_id', o.id,
           'student_label', split_part(btrim(student.full_name), ' ', 1)
              || case when position(' ' in btrim(student.full_name)) > 0
                      then ' ' || left(regexp_replace(btrim(student.full_name), '^.*\s', ''), 1) || '.'
                      else '' end,
           'slots', o.slots,
           'starts_on', greatest(d.cutover_date, v_today)
         ) order by o.created_at), '[]'::jsonb)
    into v
    from public.teacher_departure_offers o
    join public.teacher_departures d on d.id = o.departure_id and d.status = 'OPEN'
    join public.profiles student on student.id = o.student_id
   where o.tenant_id = me.tenant_id and o.status = 'OPEN'
     and d.teacher_id <> me.id
     and coalesce(student.is_test_account, false) = coalesce(me.is_test_account, false)
     and private.departure_fits(o.tenant_id, me.id, o.student_id, o.slots, greatest(d.cutover_date, v_today));
  return v;
end $$;

create or replace function public.claim_departure_offer(p_offer uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.profiles%rowtype; v_tenant text; v_actor uuid; v_result jsonb;
begin
  select * into me from public.profiles where id = auth.uid();
  select tenant_id into v_tenant from public.teacher_departure_offers where id = p_offer;
  if not found or me.role is distinct from 'TEACHER' or me.lifecycle_status is distinct from 'active'
     or v_tenant is distinct from me.tenant_id or not exists (
       select 1 from public.tenant_memberships m where m.user_id = me.id and m.tenant_id = v_tenant and m.role = 'TEACHER' and m.status = 'ACTIVE')
  then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  v_actor := private.management_group_default_actor(v_tenant);
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'escola_sem_direcao_ativa'); end if;
  v_result := private.departure_take_offer(p_offer, me.id, 'CLAIMED', v_actor);
  perform private.trial_closing_act_as(me.id);
  return v_result;
end $$;

-- Termo do aluno assinado: a troca do repasse vale sozinha e a família é avisada.
create or replace function private.departure_apply_on_term_executed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare o public.teacher_departure_offers%rowtype;
begin
  if new.status is distinct from 'EXECUTED' or old.status is not distinct from 'EXECUTED' or new.source_kind <> 'TRANSFER' then
    return new;
  end if;
  select * into o from public.teacher_departure_offers where transfer_id = new.source_id and status in ('CLAIMED', 'ASSIGNED');
  if not found then return new; end if;
  begin
    update public.teacher_transfers set status = 'ACCEPTED', decided_at = coalesce(decided_at, now())
     where id = o.transfer_id and status = 'PENDING';
    perform public.apply_teacher_transfer(o.transfer_id);
    perform private.departure_notify_applied(o.id);
  exception when others then
    raise warning '[saida do professor] troca % nao aplicada apos o termo: %', o.transfer_id, sqlerrm;
  end;
  return new;
end $$;
alter function private.departure_apply_on_term_executed() owner to postgres;
revoke all on function private.departure_apply_on_term_executed() from public, anon, authenticated, service_role;
drop trigger if exists zz_departure_apply_on_term_executed on private.teacher_student_terms;
create trigger zz_departure_apply_on_term_executed after update of status on private.teacher_student_terms
  for each row execute function private.departure_apply_on_term_executed();

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.teacher_departure_preview(uuid,timestamptz,date)',
    'public.get_teacher_departure(uuid)',
    'public.open_teacher_departure(uuid,timestamptz,date,text)',
    'public.assign_departure_offer(uuid,uuid)',
    'public.close_teacher_departure(uuid,text)',
    'public.my_departure_offers()',
    'public.claim_departure_offer(uuid)'
  ] loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

-- O mural de julho reescrevia os agendamentos antigos por cima (o histórico de
-- pagamento perdia a origem) e ignorava o termo por aluno. Nunca foi usado
-- (0 oportunidades); fica sem acesso para ninguém cair nele.
do $legacy$
begin
  if to_regprocedure('public.open_reallocation_for_teacher(uuid)') is not null then
    revoke all on function public.open_reallocation_for_teacher(uuid) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.claim_student_opportunity(uuid)') is not null then
    revoke all on function public.claim_student_opportunity(uuid) from public, anon, authenticated;
  end if;
end $legacy$;
