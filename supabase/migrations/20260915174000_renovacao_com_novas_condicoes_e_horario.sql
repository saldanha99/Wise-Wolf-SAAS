-- ─────────────────────────────────────────────────────────────────────────────
-- Renovação com NOVAS condições (frequência, valor, vencimento) e HORÁRIO
-- (15/09/2026)
--
-- O motor de 15/09 só renova com as condições de hoje: a proposta recusa preço,
-- frequência ou vencimento diferentes do perfil (`renewal_price_changed`). Mas a
-- renovação é justamente quando o aluno pede para mudar — caso real: 5x por
-- R$ 377,00 virando 3x por R$ 261,00 em horários novos com a mesma professora.
--
-- O que esta migration acrescenta, sem mexer no caminho que já existe:
-- • `register_student_course_renewal_change_proposal`: proposta com condições
--   novas. A aprovação explícita da direção continua obrigatória (approval_ref);
--   o que muda é que o perfil atual vira "de onde veio", não trava.
-- • `cancel_student_course_renewal_offer`: a oferta superada sai de circulação
--   com motivo e evento — nunca apagada. Duas ofertas vivas fariam o aluno
--   assinar a que chegasse primeiro no WhatsApp.
-- • `set_student_course_renewal_offer_schedule`: o horário faz parte do que o
--   aluno assina (professor + dias/horas), checado contra choque de agenda.
-- • Na ASSINATURA: o perfil passa a refletir as condições assinadas, a agenda é
--   criada a partir do início do contrato e a Gestão é avisada no grupo.
--   Aluno suspenso não pode ter aula ativa (guard_active_student_scheduled_booking);
--   nesse caso a agenda fica guardada e é criada sozinha quando o cadastro for
--   reativado. Falha ao montar agenda NUNCA derruba a assinatura: vira evento e
--   aviso para ajuste manual.
-- ─────────────────────────────────────────────────────────────────────────────

alter table private.student_course_renewal_offers add column if not exists schedule_plan jsonb;
alter table private.student_course_renewal_offers add column if not exists schedule_applied_at timestamptz;
alter table private.student_course_renewal_offers add column if not exists cancelled_at timestamptz;
alter table private.student_course_renewal_offers add column if not exists cancel_reason text;
do $shape$
begin
  if not exists (select 1 from pg_constraint where conname = 'student_course_renewal_offers_schedule_plan_shape') then
    alter table private.student_course_renewal_offers add constraint student_course_renewal_offers_schedule_plan_shape
      check (schedule_plan is null or (jsonb_typeof(schedule_plan) = 'object'
        and jsonb_typeof(schedule_plan -> 'slots') = 'array'));
  end if;
end
$shape$;

-- Grupo da Gestão = destino que a escola configurou para o DRE; reserva: grupo
-- operacional da direção. Mesma regra da troca de horário pelo professor.
create or replace function private.management_group_destination(p_tenant text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select btrim(cfg.destino) from public.dre_report_settings cfg
      where cfg.tenant_id = p_tenant and cfg.is_active
        and btrim(cfg.destino) ~ '^[0-9]+(-[0-9]+)?@g\.us$'),
    (select nullif(btrim(p.teachers_group_id), '') from public.profiles p
      where p.tenant_id = p_tenant and p.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        and nullif(btrim(p.teachers_group_id), '') is not null
      order by case when p.role = 'SCHOOL_ADMIN' then 0 else 1 end, p.created_at limit 1));
$$;

create or replace function private.notify_management_group(
  p_tenant text, p_student uuid, p_teacher uuid, p_source uuid, p_key text, p_message text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_group text := private.management_group_destination(p_tenant); v_name text;
begin
  if v_group is null then return false; end if;
  select full_name into v_name from public.profiles where id = p_student;
  insert into public.notification_queue(tenant_id, teacher_id, student_id, student_name, student_phone,
    message_body, scheduled_for, status, source_id, source_type, notification_kind, idempotency_key)
  values (p_tenant, p_teacher, p_student, v_name, v_group, p_message, now(), 'pending', p_source,
    'COURSE_RENEWAL', 'SCHEDULE_CHANGE_GROUP', p_key)
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
  return true;
end;
$$;

create or replace function private.register_student_course_renewal_change_proposal(
  p_tenant text, p_student uuid, p_fee_cents bigint, p_frequency smallint,
  p_due_day smallint, p_source_note text, p_approval_ref text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.profiles%rowtype; existing private.student_course_renewal_proposals%rowtype; v_id uuid;
begin
  if p_tenant is null or p_student is null or p_fee_cents is null or p_fee_cents not between 1 and 100000000
    or p_frequency is null or p_frequency not between 1 and 7
    or p_due_day is null or p_due_day not between 1 and 28
    or p_source_note is null or length(btrim(p_source_note)) not between 20 and 1500
    or p_approval_ref is null or p_approval_ref !~ '^[a-f0-9]{64}$' then
    raise exception 'renewal_conditions_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-proposal:' || p_tenant || ':' || p_student::text, 0));
  select * into p from public.profiles where id = p_student for share;
  if not found or p.tenant_id is distinct from p_tenant or p.role is distinct from 'STUDENT'
    or coalesce(p.lifecycle_status, '') not in ('active', 'suspended')
    or p.contract_accepted is distinct from true
    or not private.tenant_is_operational(p_tenant) then
    raise exception 'renewal_student_scope_invalid';
  end if;
  select * into existing from private.student_course_renewal_proposals
   where tenant_id = p_tenant and student_id = p_student and approval_ref = p_approval_ref;
  if found then
    if existing.monthly_fee_cents <> p_fee_cents or existing.classes_per_week <> p_frequency
      or existing.suggested_due_day <> p_due_day or existing.source_note <> btrim(p_source_note) then
      raise exception 'renewal_proposal_replay_conflict';
    end if;
    return existing.id;
  end if;
  insert into private.student_course_renewal_proposals(
    tenant_id, student_id, monthly_fee_cents, classes_per_week, suggested_due_day,
    source_snapshot, source_note, approval_ref)
  values (p_tenant, p_student, p_fee_cents, p_frequency, p_due_day,
    jsonb_build_object('monthly_fee', p.monthly_fee, 'class_frequency', p.class_frequency,
      'due_day', p.due_day, 'fidelity_plan', p.fidelity_plan, 'contract_accepted', p.contract_accepted,
      'accepted_at', p.accepted_at, 'lifecycle_status', p.lifecycle_status,
      'subscription_id', p.subscription_id, 'subscription_end_date', p.asaas_subscription_end_date,
      'conditions_changed', true),
    btrim(p_source_note), p_approval_ref)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.cancel_student_course_renewal_offer(p_offer uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype;
begin
  if coalesce(length(btrim(p_reason)), 0) not between 8 and 500 then raise exception 'renewal_cancel_reason_required'; end if;
  select * into o from private.student_course_renewal_offers where id = p_offer for update;
  if not found then raise exception 'renewal_offer_not_found'; end if;
  if o.status = 'CANCELLED' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status <> 'PENDING_SIGNATURE' then raise exception 'renewal_offer_already_signed'; end if;
  update private.student_course_renewal_offers
     set status = 'CANCELLED', cancelled_at = clock_timestamp(), cancel_reason = btrim(p_reason)
   where id = o.id;
  update public.student_course_renewal_notification_outbox
     set status = 'SUPPRESSED', last_error = 'renewal_offer_cancelled', updated_at = clock_timestamp()
   where offer_id = o.id and submit_attempt_count = 0 and status in ('PENDING', 'CLAIMED');
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'CANCELLED', jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

create or replace function private.set_student_course_renewal_offer_schedule(
  p_offer uuid, p_teacher uuid, p_slots jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o private.student_course_renewal_offers%rowtype; t public.profiles%rowtype;
  slot jsonb; v_day text; v_time text; v_slots jsonb := '[]'; v_keys text[] := '{}';
begin
  select * into o from private.student_course_renewal_offers where id = p_offer for update;
  if not found or o.status <> 'PENDING_SIGNATURE' then raise exception 'renewal_offer_not_pending'; end if;
  select * into t from public.profiles where id = p_teacher;
  if not found or t.role is distinct from 'TEACHER' or t.tenant_id is distinct from o.tenant_id
    or lower(coalesce(t.lifecycle_status, 'active')) <> 'active' then
    raise exception 'renewal_teacher_invalid';
  end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) <> o.classes_per_week then
    raise exception 'renewal_schedule_must_match_frequency';
  end if;
  for slot in select value from jsonb_array_elements(p_slots) loop
    v_day := public.canonical_weekday_name(slot ->> 'day');
    v_time := left(btrim(coalesce(slot ->> 'time', '')), 5);
    if v_day is null or v_day = 'Domingo' or v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' then
      raise exception 'renewal_schedule_slot_invalid';
    end if;
    if (v_day || ' ' || v_time) = any(v_keys) then raise exception 'renewal_schedule_duplicate_slot'; end if;
    v_keys := v_keys || (v_day || ' ' || v_time);
    if exists (select 1 from public.bookings b
        where b.tenant_id = o.tenant_id and b.teacher_id = p_teacher and upper(coalesce(b.status, '')) = 'SCHEDULED'
          and b.date is null and b.student_id is distinct from o.student_id
          and public.canonical_weekday_name(b.day_of_week) = v_day and left(b.time_slot, 5) = v_time) then
      raise exception 'renewal_schedule_conflict: % %', v_day, v_time;
    end if;
    v_slots := v_slots || jsonb_build_array(jsonb_build_object('day', v_day, 'time', v_time));
  end loop;
  update private.student_course_renewal_offers
     set schedule_plan = jsonb_build_object('teacher_id', p_teacher, 'teacher_name', t.full_name, 'slots', v_slots)
   where id = o.id;
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'SCHEDULE_SET', jsonb_build_object('teacher_id', p_teacher, 'slots', v_slots));
  return jsonb_build_object('ok', true, 'slots', v_slots);
end;
$$;

-- Mesma função pública, agora com o horário que o aluno está assinando.
create or replace function public.get_student_course_renewal_public(p_token text)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare o private.student_course_renewal_offers%rowtype; r private.student_course_renewal_proposals%rowtype; p public.profiles%rowtype; v_school text;
begin
  if p_token is null or p_token!~'^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  select * into o from private.student_course_renewal_offers where token=p_token;
  if not found then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  select * into r from private.student_course_renewal_proposals where id=o.proposal_id;
  select * into p from public.profiles where id=o.student_id and tenant_id=o.tenant_id;
  select coalesce(nullif(btrim(name),''),'Wise Wolf') into v_school from public.tenants where id=o.tenant_id;
  if p.id is null or r.id is null or r.monthly_fee_cents<>o.monthly_fee_cents or r.classes_per_week<>o.classes_per_week
    or r.term_months<>o.term_months or o.status='CANCELLED' then return jsonb_build_object('ok',false,'error','Esta proposta não está disponível.'); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('student_name',p.full_name,'school_name',v_school,
    'term_months',o.term_months,'monthly_fee_cents',o.monthly_fee_cents,'classes_per_week',o.classes_per_week,
    'contract_start',o.contract_start,'first_due_date',o.first_due_date,'last_due_date',o.last_due_date,
    'service_end_date',o.service_end_date,'status',o.status,'billing_status',o.billing_status,
    'signed_at',o.signed_at,'expired',(o.expires_at<clock_timestamp() and o.status='PENDING_SIGNATURE'),
    'schedule',case when o.schedule_plan is null then null else jsonb_build_object(
      'teacher_first_name',split_part(btrim(coalesce(o.schedule_plan->>'teacher_name','')),' ',1),
      'slots',o.schedule_plan->'slots') end));
end $fn$;

-- Cria a agenda assinada. Devolve o desfecho; quem chama decide o que avisar.
create or replace function private.apply_student_course_renewal_schedule(p_offer uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare o private.student_course_renewal_offers%rowtype; p public.profiles%rowtype; slot jsonb; v_start date;
begin
  select * into o from private.student_course_renewal_offers where id = p_offer for update;
  if not found or o.status <> 'SIGNED' or o.schedule_plan is null or o.schedule_applied_at is not null then
    return 'nothing';
  end if;
  select * into p from public.profiles where id = o.student_id and tenant_id = o.tenant_id;
  if lower(coalesce(p.lifecycle_status, '')) <> 'active'
     or lower(btrim(coalesce(p.status, 'Ativo'))) in ('inativo', 'inactive', 'arquivado', 'cancelado', 'trancado') then
    return 'pending_reactivation';
  end if;
  if exists (select 1 from public.bookings b where b.tenant_id = o.tenant_id and b.student_id = o.student_id
              and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null) then
    return 'needs_review_existing_schedule';
  end if;
  -- Aula não nasce no passado: começa no início do contrato ou amanhã, o que vier depois.
  v_start := greatest(o.contract_start, (now() at time zone 'America/Sao_Paulo')::date + 1);
  for slot in select value from jsonb_array_elements(o.schedule_plan -> 'slots') loop
    insert into public.bookings(tenant_id, teacher_id, student_id, day_of_week, time_slot, status, start_date)
    values (o.tenant_id, (o.schedule_plan ->> 'teacher_id')::uuid, o.student_id,
            slot ->> 'day', slot ->> 'time', 'SCHEDULED', v_start);
  end loop;
  update private.student_course_renewal_offers set schedule_applied_at = clock_timestamp() where id = o.id;
  insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
  values (o.tenant_id, o.id, 'SCHEDULE_APPLIED', jsonb_build_object('start_date', v_start, 'slots', o.schedule_plan -> 'slots'));
  return 'applied';
end;
$$;

create or replace function private.renewal_schedule_text(p_plan jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when p_plan is null then null else
    (select string_agg(format('%s %s', s ->> 'day', s ->> 'time'), ', ') from jsonb_array_elements(p_plan -> 'slots') s)
    || ' com ' || coalesce(p_plan ->> 'teacher_name', 'o(a) professor(a)') end;
$$;

create or replace function private.on_student_course_renewal_signed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_fee numeric := new.monthly_fee_cents / 100.0;
  v_frequency text := new.classes_per_week::text || 'x';
  v_due smallint := case when extract(day from new.first_due_date) <= 28 then extract(day from new.first_due_date)::smallint end;
  v_outcome text := 'no_schedule';
  v_profile_note text := '';
  v_student text;
begin
  -- Condições assinadas passam a valer no perfil (a cobrança vem da Asaas pela oferta).
  begin
    update public.profiles
       set monthly_fee = v_fee, class_frequency = v_frequency, due_day = coalesce(v_due, due_day)
     where id = new.student_id and tenant_id = new.tenant_id
       and (monthly_fee is distinct from v_fee or class_frequency is distinct from v_frequency
            or (v_due is not null and due_day is distinct from v_due));
  exception when others then
    v_profile_note := E'\n⚠️ Não foi possível atualizar valor/frequência no cadastro: ajuste manual.';
    insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
    values (new.tenant_id, new.id, 'PROFILE_UPDATE_FAILED', jsonb_build_object('error', left(sqlerrm, 200)));
  end;

  if new.schedule_plan is not null then
    begin
      v_outcome := private.apply_student_course_renewal_schedule(new.id);
    exception when others then
      v_outcome := 'apply_failed';
      insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
      values (new.tenant_id, new.id, 'SCHEDULE_APPLY_FAILED', jsonb_build_object('error', left(sqlerrm, 200)));
    end;
    if v_outcome in ('pending_reactivation', 'needs_review_existing_schedule') then
      insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
      values (new.tenant_id, new.id, 'SCHEDULE_' || upper(v_outcome), '{}'::jsonb);
    end if;
  end if;

  select full_name into v_student from public.profiles where id = new.student_id;
  perform private.notify_management_group(new.tenant_id, new.student_id,
    nullif(new.schedule_plan ->> 'teacher_id', '')::uuid, new.id, 'renewal-signed:' || new.id::text,
    format(E'✅ *RENOVAÇÃO ASSINADA*\n\n👤 Aluno(a): *%s*\n📄 6 meses · %sx por semana · *R$ %s*/mês\n📅 Início: %s · 1º vencimento: %s%s%s%s',
      coalesce(v_student, 'Aluno'), new.classes_per_week, replace(to_char(v_fee, 'FM999999990.00'), '.', ','),
      to_char(new.contract_start, 'DD/MM/YYYY'), to_char(new.first_due_date, 'DD/MM/YYYY'),
      coalesce(E'\n🕑 Horário: ' || private.renewal_schedule_text(new.schedule_plan), ''),
      case v_outcome
        when 'applied' then E'\n✔️ Agenda criada no sistema.'
        when 'pending_reactivation' then E'\n⚠️ Aluno(a) suspenso(a): reative o cadastro — a agenda é criada automaticamente na reativação.'
        when 'needs_review_existing_schedule' then E'\n⚠️ Aluno(a) já tem agenda ativa: ajuste manual necessário.'
        when 'apply_failed' then E'\n⚠️ Não foi possível criar a agenda (possível choque): ajuste manual necessário.'
        else '' end,
      v_profile_note));
  return null;
end;
$$;
drop trigger if exists student_course_renewal_signed_effects on private.student_course_renewal_offers;
create trigger student_course_renewal_signed_effects
  after update of status on private.student_course_renewal_offers
  for each row when (new.status = 'SIGNED' and old.status is distinct from 'SIGNED')
  execute function private.on_student_course_renewal_signed();

-- Reativação cria a agenda que ficou guardada na assinatura.
create or replace function private.apply_pending_renewal_schedule_on_reactivation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_offer private.student_course_renewal_offers%rowtype; v_outcome text;
begin
  if not (lower(coalesce(new.lifecycle_status, '')) = 'active'
          and lower(btrim(coalesce(new.status, 'Ativo'))) not in ('inativo', 'inactive', 'arquivado', 'cancelado', 'trancado'))
     or (lower(coalesce(old.lifecycle_status, '')) = 'active'
          and lower(btrim(coalesce(old.status, 'Ativo'))) not in ('inativo', 'inactive', 'arquivado', 'cancelado', 'trancado')) then
    return null;
  end if;
  for v_offer in select * from private.student_course_renewal_offers
     where student_id = new.id and tenant_id = new.tenant_id and status = 'SIGNED'
       and schedule_plan is not null and schedule_applied_at is null
     order by signed_at loop
    begin
      v_outcome := private.apply_student_course_renewal_schedule(v_offer.id);
    exception when others then
      v_outcome := 'apply_failed';
      insert into private.student_course_renewal_events(tenant_id, offer_id, event_type, payload)
      values (v_offer.tenant_id, v_offer.id, 'SCHEDULE_APPLY_FAILED', jsonb_build_object('error', left(sqlerrm, 200)));
    end;
    if v_outcome in ('applied', 'apply_failed', 'needs_review_existing_schedule') then
      perform private.notify_management_group(v_offer.tenant_id, v_offer.student_id,
        nullif(v_offer.schedule_plan ->> 'teacher_id', '')::uuid, v_offer.id,
        'renewal-schedule:' || v_offer.id::text || ':' || v_outcome,
        format(E'🗓️ *AGENDA DA RENOVAÇÃO*\n\n👤 Aluno(a): *%s*\n🕑 %s\n%s',
          coalesce(new.full_name, 'Aluno'), private.renewal_schedule_text(v_offer.schedule_plan),
          case v_outcome when 'applied' then '✔️ Cadastro reativado e agenda criada.'
            else '⚠️ Cadastro reativado, mas a agenda precisa de ajuste manual.' end));
    end if;
  end loop;
  return null;
end;
$$;
drop trigger if exists apply_pending_renewal_schedule_on_reactivation on public.profiles;
create trigger apply_pending_renewal_schedule_on_reactivation
  after update of lifecycle_status, status on public.profiles
  for each row when (new.role = 'STUDENT')
  execute function private.apply_pending_renewal_schedule_on_reactivation();

do $owners$
begin
  alter function private.management_group_destination(text) owner to postgres;
  alter function private.notify_management_group(text, uuid, uuid, uuid, text, text) owner to postgres;
  alter function private.register_student_course_renewal_change_proposal(text, uuid, bigint, smallint, smallint, text, text) owner to postgres;
  alter function private.cancel_student_course_renewal_offer(uuid, text) owner to postgres;
  alter function private.set_student_course_renewal_offer_schedule(uuid, uuid, jsonb) owner to postgres;
  alter function private.apply_student_course_renewal_schedule(uuid) owner to postgres;
  alter function private.renewal_schedule_text(jsonb) owner to postgres;
  alter function private.on_student_course_renewal_signed() owner to postgres;
  alter function private.apply_pending_renewal_schedule_on_reactivation() owner to postgres;
end
$owners$;
revoke all on function private.management_group_destination(text),
  private.notify_management_group(text, uuid, uuid, uuid, text, text),
  private.register_student_course_renewal_change_proposal(text, uuid, bigint, smallint, smallint, text, text),
  private.cancel_student_course_renewal_offer(uuid, text),
  private.set_student_course_renewal_offer_schedule(uuid, uuid, jsonb),
  private.apply_student_course_renewal_schedule(uuid),
  private.renewal_schedule_text(jsonb),
  private.on_student_course_renewal_signed(),
  private.apply_pending_renewal_schedule_on_reactivation()
from public, anon, authenticated, service_role;
