-- A professora avisa pelo WhatsApp que o lead não compareceu, e o sistema age.
--
-- Pedido da direção em 23/09/2026. Hoje a professora manda "o aluno não
-- apareceu" para o número da escola e isso morre na conversa: alguém precisa
-- abrir a plataforma, marcar a falta e chamar o lead de volta.
--
-- NÃO cria porta nova para o desfecho: `update_trial_outcome_secure` continua
-- sendo quem registra realizada/faltou/perdido, com idempotência, override
-- auditado e 341 linhas de regra. A função abaixo só RESOLVE QUAL aula é, prova
-- que quem avisou é a professora dela, e age como a direção
-- (private.trial_closing_act_as) para chamar aquela mesma RPC.

-- Correção do que subiu hoje mais cedo: eu havia bloqueado o pedido de
-- remarcação quando a experimental estava como falta. Mas "ALUNO NÃO
-- COMPARECEU → POSSÍVEL REAGENDAMENTO" é exatamente o fluxo que a direção
-- pediu, e a tela já oferece "Reagendar" depois de uma falta. Só desfecho
-- DEFINITIVO (realizada ou cancelada) recusa.
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

  -- Aula que ACONTECEU (realizada) ou processo encerrado (cancelada) não
  -- reabre por remarcação: quem quer aula depois disso abre outra, senão o
  -- funil perde o desfecho. Falta do aluno ou do professor SIM reabre — a aula
  -- não aconteceu e o lead continua vivo.
  if upper(coalesce(v_opp.trial_status, 'SCHEDULED')) in ('DONE', 'CANCELLED') then
    raise exception using errcode = '22023', message = 'experimental_ja_encerrada';
  end if;
  if upper(coalesce(v_opp.trial_status, '')) = 'RESCHEDULED' then
    return jsonb_build_object('ok', true, 'already', true,
      'opportunity_id', v_opp.id, 'appointment_id', v_opp.trial_appointment_id);
  end if;

  select * into v_appt from public.appointments where id = v_opp.trial_appointment_id;
  select full_name into v_teacher_name from public.profiles
   where id = coalesce(v_opp.winner_teacher_id, v_appt.teacher_id);

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

-- Qual experimental a professora está comentando? A que já começou e ainda não
-- teve desfecho. Janela de 6 horas: depois disso é conversa sobre o passado, e
-- marcar falta retroativa às cegas mexe no pagamento dela.
create or replace function public.teacher_open_trial_for_no_show(
  p_tenant text,
  p_teacher uuid
)
returns table (
  opportunity_id uuid,
  appointment_id uuid,
  lead_name text,
  lead_phone text,
  start_time timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select opportunity.id, appointment.id, opportunity.student_name,
         opportunity.student_phone, appointment.start_time
    from public.opportunities as opportunity
    join public.appointments as appointment
      on appointment.id = opportunity.trial_appointment_id
   where opportunity.tenant_id = p_tenant
     and opportunity.kind = 'TRIAL'
     and opportunity.status = 'CLAIMED'
     and coalesce(opportunity.winner_teacher_id, appointment.teacher_id) = p_teacher
     and upper(coalesce(opportunity.trial_status, 'SCHEDULED'))
         not in ('DONE', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'CANCELLED')
     and lower(coalesce(appointment.type, '')) = 'experimental'
     and appointment.start_time <= now()
     and appointment.start_time >= now() - interval '6 hours'
   order by appointment.start_time desc;
$function$;
alter function public.teacher_open_trial_for_no_show(text, uuid) owner to postgres;
revoke all on function public.teacher_open_trial_for_no_show(text, uuid) from public, anon, authenticated;
grant execute on function public.teacher_open_trial_for_no_show(text, uuid) to service_role;

-- O aviso da professora vira falta registrada, pela porta de sempre.
create or replace function public.teacher_report_trial_no_show(
  p_tenant text,
  p_teacher uuid,
  p_opportunity_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_alvo record;
  v_admin uuid;
  v_resultado jsonb;
  v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;

  select * into v_alvo from public.teacher_open_trial_for_no_show(p_tenant, p_teacher)
   where opportunity_id = p_opportunity_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'experimental_nao_elegivel');
  end if;

  v_admin := private.management_group_default_actor(p_tenant);
  if v_admin is null then
    return jsonb_build_object('ok', false, 'error', 'sem_ator_de_direcao');
  end if;

  -- A falta é registrada pela MESMA RPC da tela do diretor. A professora avisa;
  -- quem registra continua sendo a direção, e o rastro diz de onde veio.
  perform set_config('app.trial_reason',
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'professora avisou pelo WhatsApp'), true);
  perform set_config('app.trial_source', 'whatsapp_professor', true);
  perform private.trial_closing_act_as(v_admin);

  v_resultado := public.update_trial_outcome_secure(jsonb_build_object(
    'requestId', extensions.gen_random_uuid(),
    'opportunityId', v_alvo.opportunity_id,
    'action', 'SET_TRIAL_STATUS',
    'trialStatus', 'NO_SHOW_STUDENT'
  ));

  perform private.trial_closing_restore(v_sub, v_claims);
  perform set_config('app.trial_reason', '', true);

  if coalesce(v_resultado ->> 'ok', 'false') <> 'true' then
    return jsonb_build_object('ok', false, 'error', coalesce(v_resultado ->> 'error', 'falha_no_desfecho'));
  end if;

  return jsonb_build_object(
    'ok', true,
    'opportunity_id', v_alvo.opportunity_id,
    'lead_name', v_alvo.lead_name,
    'lead_phone', v_alvo.lead_phone,
    'start_time', v_alvo.start_time
  );
end;
$function$;
alter function public.teacher_report_trial_no_show(text, uuid, uuid, text) owner to postgres;
revoke all on function public.teacher_report_trial_no_show(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.teacher_report_trial_no_show(text, uuid, uuid, text) to service_role;
