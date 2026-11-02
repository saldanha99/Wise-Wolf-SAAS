-- Aula experimental como ENTIDADE COM HISTÓRICO, não como agendamento solto.
--
-- Pedido da direção em 23/09/2026, depois do caso da Ana Carolina: ela avisou às
-- 11:52 que não podia; o bot entendeu e perguntou o novo horário; um humano
-- assumiu às 12:01 e conduziu por fora — e a aula continuou de pé para as 18:30
-- na agenda da Teacher Bruna. A conversa mudou, o SISTEMA não.
--
-- O QUE JÁ EXISTIA e NÃO foi duplicado:
--   · trial-reschedule.ts + decideTrialAction: mantém o mesmo lead, a mesma
--     professora, checa conflito real dela e move a aula sem redisparar leilão;
--   · trial_reschedule_requests + create/respond_trial_reschedule_confirmation:
--     a agenda só muda depois do SIM da professora;
--   · trial_status já ACEITA 'RESCHEDULED' na constraint — só que nada o usava.
--
-- O QUE FALTAVA (os quatro buracos medidos):
--   1. estado para "pediu remarcação e ainda não disse quando" — sem isso, o
--      pedido só virava ação quando o lead mandava data E hora na mesma frase;
--   2. histórico: a aula é movida NO LUGAR (update start_time), então o que
--      aconteceu antes se perdia;
--   3. link da aula: `appointments` não tinha coluna nenhuma;
--   4. porta única para a equipe registrar realizada/não compareceu/cancelada.
--
-- POR QUE NÃO CRIAR UMA NOVA LINHA DE APPOINTMENT A CADA REMARCAÇÃO: a aula
-- movida no lugar mantém agenda, briefing, lançamento e trial_appointment_id
-- todos apontando para a MESMA linha. Criar ocorrência nova faria a antiga
-- aparecer em agenda, em "Aulas de Hoje" e no Lançar Aula de quem não tem mais
-- aula nenhuma — o defeito clássico deste projeto. O histórico que a direção
-- pediu mora em tabela própria, que é onde ele é útil e não atrapalha.

alter table public.appointments
  add column if not exists meeting_link text;

comment on column public.appointments.meeting_link is
  'Sala da aula. Vem do meeting_link do professor no aceite e SOBREVIVE à remarcação — a professora não recria link a cada mudança de horário.';

create table if not exists public.trial_appointment_history (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null,
  opportunity_id uuid not null,
  appointment_id uuid,
  action text not null check (action in (
    'agendada', 'remarcacao_pedida', 'remarcada',
    'realizada', 'nao_compareceu', 'cancelada'
  )),
  from_start_time timestamptz,
  to_start_time timestamptz,
  teacher_id uuid,
  reason text,
  actor_id uuid,
  source text not null default 'app'
    check (source in ('app', 'whatsapp_lead', 'whatsapp_professor', 'direcao', 'sistema')),
  created_at timestamptz not null default now()
);

create index if not exists trial_appointment_history_opportunity_idx
  on public.trial_appointment_history (opportunity_id, created_at desc);
create index if not exists trial_appointment_history_tenant_idx
  on public.trial_appointment_history (tenant_id, created_at desc);

alter table public.trial_appointment_history enable row level security;

-- Leitura pela escola; escrita SÓ pelas RPCs (nenhuma policy de insert).
drop policy if exists trial_history_read on public.trial_appointment_history;
create policy trial_history_read
on public.trial_appointment_history for select to authenticated
using (
  tenant_id = public._my_tenant_id()
  and public._my_role() in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN', 'TEACHER')
);

revoke all on table public.trial_appointment_history from anon;
grant select on table public.trial_appointment_history to authenticated;

-- Quem pode mexer no ciclo da experimental: o bot (service_role), a direção e a
-- coordenação da PRÓPRIA escola. Mesmo desenho do atestado de reposição.
create or replace function private.trial_actor(p_tenant text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_role text;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return private.management_group_default_actor(p_tenant);
  end if;
  if v_actor is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  v_role := public._my_role();
  if coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if v_role <> 'SUPER_ADMIN' and public._my_tenant_id() is distinct from p_tenant then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  return v_actor;
end;
$function$;
alter function private.trial_actor(text) owner to postgres;
revoke all on function private.trial_actor(text) from public, anon, authenticated, service_role;

-- 1) O PEDIDO DE REMARCAÇÃO VIRA ESTADO -------------------------------------
-- É o buraco que deixou a aula da Ana Carolina de pé: "preciso remarcar", sem
-- data nem hora, não tinha onde ser registrado. Agora a aula fica SINALIZADA
-- (trial_status = 'RESCHEDULED') enquanto o horário novo não vem — a professora
-- e a coordenação sabem que aquela aula não vai acontecer, e o histórico começa.
create or replace function public.open_trial_reschedule_request(
  p_opportunity_id uuid,
  p_reason text default null,
  p_source text default 'app'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_opp public.opportunities%rowtype;
  v_appt public.appointments%rowtype;
  v_actor uuid;
  v_teacher_name text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_source text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'app');
begin
  select * into v_opp from public.opportunities
   where id = p_opportunity_id for update;
  if not found or v_opp.kind <> 'TRIAL' then
    raise exception using errcode = 'P0002', message = 'experimental_nao_encontrada';
  end if;
  v_actor := private.trial_actor(v_opp.tenant_id);

  -- Experimental já encerrada não reabre por pedido de remarcação: quem quer
  -- aula depois de DONE/NO_SHOW abre outra, senão o funil perde o desfecho.
  if upper(coalesce(v_opp.trial_status, 'SCHEDULED')) in
     ('DONE', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'CANCELLED') then
    raise exception using errcode = '22023', message = 'experimental_ja_encerrada';
  end if;
  if upper(coalesce(v_opp.trial_status, '')) = 'RESCHEDULED' then
    return jsonb_build_object('ok', true, 'already', true,
      'opportunity_id', v_opp.id, 'appointment_id', v_opp.trial_appointment_id);
  end if;

  select * into v_appt from public.appointments where id = v_opp.trial_appointment_id;
  select full_name into v_teacher_name from public.profiles
   where id = coalesce(v_opp.winner_teacher_id, v_appt.teacher_id);

  -- O histórico é gravado pelo trigger, que enxerga TODO mundo que muda o
  -- trial_status. Motivo e origem viajam por set_config, como em reschedules.
  perform set_config('app.trial_reason', coalesce(v_reason, ''), true);
  perform set_config('app.trial_source', v_source, true);
  update public.opportunities
     set trial_status = 'RESCHEDULED'
   where id = v_opp.id;
  perform set_config('app.trial_reason', '', true);

  return jsonb_build_object(
    'ok', true,
    'opportunity_id', v_opp.id,
    'appointment_id', v_opp.trial_appointment_id,
    'teacher_id', coalesce(v_opp.winner_teacher_id, v_appt.teacher_id),
    'teacher_name', v_teacher_name,
    'lead_name', v_opp.student_name,
    'lead_phone', v_opp.student_phone,
    'start_time', v_appt.start_time
  );
end;
$function$;
alter function public.open_trial_reschedule_request(uuid, text, text) owner to postgres;
revoke all on function public.open_trial_reschedule_request(uuid, text, text) from public, anon;
grant execute on function public.open_trial_reschedule_request(uuid, text, text) to authenticated, service_role;

-- 2) HISTÓRICO POR TRIGGER, NÃO POR PORTA NOVA -------------------------------
-- `update_trial_outcome_secure` já é a porta do desfecho (realizada / faltou /
-- perdido), com idempotência por requestId, override auditado e 341 linhas de
-- regra. Criar um `set_trial_outcome` ao lado seria a segunda porta para o mesmo
-- fato — o defeito que este projeto já pagou caro (duas telas divergindo na
-- regra de lançamento). Então o histórico é capturado por TRIGGER: pega a RPC,
-- pega o bot, pega a remarcação e pega quem vier depois.
create or replace function private.trial_status_history_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_appt public.appointments%rowtype;
  v_action text;
  v_novo text := upper(coalesce(new.trial_status, ''));
begin
  if new.kind <> 'TRIAL' then
    return new;
  end if;
  if new.trial_status is not distinct from old.trial_status then
    return new;
  end if;

  v_action := case v_novo
    when 'RESCHEDULED' then 'remarcacao_pedida'
    when 'DONE' then 'realizada'
    when 'NO_SHOW_STUDENT' then 'nao_compareceu'
    when 'NO_SHOW_TEACHER' then 'nao_compareceu'
    when 'CANCELLED' then 'cancelada'
    when 'SCHEDULED' then case
      when upper(coalesce(old.trial_status, '')) = 'RESCHEDULED' then 'remarcada'
      else 'agendada' end
    else null end;
  if v_action is null then
    return new;
  end if;

  select * into v_appt from public.appointments where id = new.trial_appointment_id;

  insert into public.trial_appointment_history (
    tenant_id, opportunity_id, appointment_id, action,
    from_start_time, teacher_id, reason, actor_id, source
  ) values (
    new.tenant_id, new.id, new.trial_appointment_id, v_action,
    v_appt.start_time, coalesce(new.winner_teacher_id, v_appt.teacher_id),
    nullif(btrim(coalesce(current_setting('app.trial_reason', true), '')), ''),
    auth.uid(),
    coalesce(nullif(btrim(coalesce(current_setting('app.trial_source', true), '')), ''), 'app')
  );
  return new;
end;
$function$;
alter function private.trial_status_history_capture() owner to postgres;
revoke all on function private.trial_status_history_capture() from public, anon, authenticated, service_role;

drop trigger if exists trg_zz_trial_status_history on public.opportunities;
create trigger trg_zz_trial_status_history
  after update of trial_status on public.opportunities
  for each row execute function private.trial_status_history_capture();

-- 3) LINK DA AULA ------------------------------------------------------------
-- A sala é do PROFESSOR (profiles.meeting_link). Resolver na hora de mostrar,
-- e gravar no appointment quando existir, faz a remarcação preservar o link
-- sozinha: mudar o horário não mexe na sala.
create or replace function public.trial_meeting_link(p_appointment_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    nullif(btrim(coalesce(appointment.meeting_link, '')), ''),
    nullif(btrim(coalesce(teacher.meeting_link, '')), '')
  )
  from public.appointments as appointment
  left join public.profiles as teacher
    on teacher.id = coalesce(appointment.teacher_id, appointment.professor_id)
  where appointment.id = p_appointment_id;
$function$;
alter function public.trial_meeting_link(uuid) owner to postgres;
revoke all on function public.trial_meeting_link(uuid) from public, anon;
grant execute on function public.trial_meeting_link(uuid) to authenticated, service_role;

-- Carimba a sala do professor na aula assim que ela tem dono, e a mantém em
-- qualquer UPDATE que não traga link novo. É o que tira a professora do ciclo
-- de "criar link de novo porque o horário mudou".
create or replace function private.stamp_trial_meeting_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_link text;
begin
  if tg_op = 'UPDATE' and nullif(btrim(coalesce(old.meeting_link, '')), '') is not null
     and nullif(btrim(coalesce(new.meeting_link, '')), '') is null then
    new.meeting_link := old.meeting_link;
    return new;
  end if;
  if nullif(btrim(coalesce(new.meeting_link, '')), '') is not null then
    return new;
  end if;
  select nullif(btrim(coalesce(teacher.meeting_link, '')), '') into v_link
    from public.profiles as teacher
   where teacher.id = coalesce(new.teacher_id, new.professor_id);
  if v_link is not null then
    new.meeting_link := v_link;
  end if;
  return new;
end;
$function$;
alter function private.stamp_trial_meeting_link() owner to postgres;
revoke all on function private.stamp_trial_meeting_link() from public, anon, authenticated, service_role;

drop trigger if exists trg_stamp_trial_meeting_link on public.appointments;
create trigger trg_stamp_trial_meeting_link
  before insert or update of teacher_id, professor_id, start_time, meeting_link
  on public.appointments
  for each row execute function private.stamp_trial_meeting_link();

-- 4) A REMARCAÇÃO ACEITA PASSA A DEIXAR RASTRO --------------------------------
-- (Corpo copiado de 20260822121843, com a única adição marcada abaixo. A regra
-- continua a mesma: a agenda só muda depois do SIM da professora.)
create or replace function public.respond_trial_reschedule_confirmation(
  p_request_id uuid,
  p_teacher_id uuid,
  p_accept boolean,
  p_response_text text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_request public.trial_reschedule_requests%rowtype;
  v_appointment public.appointments%rowtype;
  v_local timestamp;
  v_date text;
  v_time text;
  v_day_number integer;
  v_day_name text;
begin
  select request.*
    into v_request
    from public.trial_reschedule_requests as request
   where request.id = p_request_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'request_not_found');
  end if;
  if v_request.teacher_id is distinct from p_teacher_id then
    return jsonb_build_object('ok', false, 'error', 'teacher_mismatch');
  end if;

  select appointment.*
    into v_appointment
    from public.appointments as appointment
   where appointment.id = v_request.appointment_id
   for update;

  select request.*
    into v_request
    from public.trial_reschedule_requests as request
   where request.id = p_request_id
   for update;

  if v_request.status <> 'PENDING' then
    return jsonb_build_object(
      'ok', true,
      'already_answered', true,
      'status', v_request.status
    );
  end if;
  if v_request.expires_at <= now() or v_request.requested_start_time <= now() then
    update public.trial_reschedule_requests
       set status = 'EXPIRED', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', false, 'error', 'request_expired');
  end if;
  if not coalesce(p_accept, false) then
    update public.trial_reschedule_requests
       set status = 'DECLINED', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', true, 'accepted', false, 'status', 'DECLINED');
  end if;
  if v_appointment.id is null
     or lower(coalesce(v_appointment.status, '')) not in (
       'scheduled', 'confirmed', 'no_show'
     )
     or coalesce(v_appointment.teacher_id, v_appointment.professor_id) is distinct from p_teacher_id
     or v_appointment.start_time is distinct from v_request.from_start_time
     or not exists (
       select 1
         from public.opportunities as opportunity
        where opportunity.id = v_request.opportunity_id
          and opportunity.trial_appointment_id = v_request.appointment_id
          and coalesce(opportunity.winner_teacher_id, opportunity.professor_id) = p_teacher_id
          and upper(coalesce(opportunity.trial_status, 'SCHEDULED')) not in (
            'DONE', 'COMPLETED', 'CANCELLED', 'CANCELED'
          )
     )
     or exists (
       select 1
         from public.class_logs as class_log
        where class_log.appointment_id = v_request.appointment_id::text
     ) then
    update public.trial_reschedule_requests
       set status = 'SUPERSEDED', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', false, 'error', 'appointment_changed');
  end if;

  v_local := timezone('America/Sao_Paulo', v_request.requested_start_time);
  v_date := to_char(v_local, 'YYYY-MM-DD');
  v_time := to_char(v_local, 'HH24:MI');
  v_day_number := extract(dow from v_local)::integer;
  v_day_name := case v_day_number
    when 0 then 'domingo'
    when 1 then 'segunda'
    when 2 then 'terca'
    when 3 then 'quarta'
    when 4 then 'quinta'
    when 5 then 'sexta'
    when 6 then 'sabado'
  end;

  if exists (
    select 1
      from public.appointments as conflict
     where conflict.id <> v_appointment.id
       and coalesce(conflict.teacher_id, conflict.professor_id) = p_teacher_id
       and lower(coalesce(conflict.status, '')) in ('scheduled', 'confirmed')
       and abs(extract(epoch from (conflict.start_time - v_request.requested_start_time))) < 1800
  ) or exists (
    select 1
      from public.bookings as conflict
     where conflict.teacher_id = p_teacher_id
       and upper(coalesce(conflict.status, '')) <> 'CANCELLED'
       and left(coalesce(conflict.time_slot, ''), 5) ~ '^[0-2][0-9]:[0-5][0-9]$'
       and (
         conflict.date::text = v_date
         or (
           lower(translate(coalesce(conflict.day_of_week, ''), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) = v_day_name
         )
       )
       and abs(extract(epoch from (
         (v_date || ' ' || left(conflict.time_slot, 5))::timestamp - v_local
       ))) < 1800
  ) then
    update public.trial_reschedule_requests
       set status = 'CONFLICT', response_text = left(p_response_text, 500), responded_at = now()
     where id = v_request.id;
    return jsonb_build_object('ok', false, 'error', 'teacher_conflict');
  end if;

  -- O horário anterior entra no histórico pelo trigger de trial_status
  -- (RESCHEDULED -> SCHEDULED vira 'remarcada'). Tem de ser marcado ANTES do
  -- update que dispara o trigger, senão a origem sai como 'app'.
  perform set_config('app.trial_source', 'whatsapp_professor', true);
  perform set_config('app.trial_reason',
    coalesce(nullif(btrim(coalesce(p_response_text, '')), ''), 'confirmado pela professora'), true);

  update public.appointments
     set start_time = v_request.requested_start_time,
         status = 'scheduled'
   where id = v_appointment.id;

  update public.opportunities
     set slots_proposed = jsonb_build_array(jsonb_build_object(
       'day', v_day_number,
       'date', v_date,
       'time', v_time,
       'formatted', to_char(v_local, 'DD/MM/YYYY') || ' (' ||
         case v_day_number
           when 0 then 'Domingo'
           when 1 then 'Segunda'
           when 2 then 'Terça'
           when 3 then 'Quarta'
           when 4 then 'Quinta'
           when 5 then 'Sexta'
           when 6 then 'Sábado'
         end || ')'
     )),
         status = 'CLAIMED',
         trial_status = 'SCHEDULED',
         conversion_status = 'OPEN',
         lost_reason = null
   where id = v_request.opportunity_id
     and trial_appointment_id = v_request.appointment_id;

  update public.trial_reschedule_requests
     set status = 'ACCEPTED', response_text = left(p_response_text, 500), responded_at = now()
   where id = v_request.id;

  return jsonb_build_object('ok', true, 'accepted', true, 'status', 'ACCEPTED');
end;
$function$;

alter function public.respond_trial_reschedule_confirmation(uuid, uuid, boolean, text) owner to postgres;
revoke all on function public.respond_trial_reschedule_confirmation(uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.respond_trial_reschedule_confirmation(uuid, uuid, boolean, text)
  to service_role;

-- 5) CARIMBO ÚNICO DO LINK NAS AULAS QUE JÁ EXISTEM --------------------------
-- Só as experimentais que ainda vão acontecer: reescrever aula passada não
-- ajuda ninguém e mexeria em registro fechado. One-shot porque a pré-validação
-- do release roda o pacote duas vezes.
DO $onshot$
DECLARE
  v_carimbadas int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_one_shots
              WHERE key = 'trial_meeting_link_backfill_20260923') THEN
    RETURN;
  END IF;

  WITH alvo AS (
    UPDATE public.appointments AS appointment
       SET meeting_link = teacher.meeting_link
      FROM public.profiles AS teacher
     WHERE teacher.id = coalesce(appointment.teacher_id, appointment.professor_id)
       AND nullif(btrim(coalesce(teacher.meeting_link, '')), '') IS NOT NULL
       AND nullif(btrim(coalesce(appointment.meeting_link, '')), '') IS NULL
       AND lower(coalesce(appointment.type, '')) = 'experimental'
       AND appointment.start_time >= now()
    RETURNING 1
  )
  SELECT count(*) INTO v_carimbadas FROM alvo;

  INSERT INTO public.schema_one_shots (key, nota)
  VALUES ('trial_meeting_link_backfill_20260923',
    format('experimentais futuras com sala do professor: %s', v_carimbadas));
  RAISE NOTICE 'link carimbado em % experimentais futuras', v_carimbadas;
END
$onshot$;
