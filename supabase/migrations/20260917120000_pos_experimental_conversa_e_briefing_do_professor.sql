-- ─────────────────────────────────────────────────────────────────────────────
-- PÓS-EXPERIMENTAL: o bot fala com o aluno 10 minutos depois da aula, sempre —
-- e o professor recebe o briefing da experimental antes dela.
--
-- Decisão da direção (17/09/2026): "sempre pós uma aula experimental, o bot já
-- tem que tentar fechar negócio com o lead — se gostou da aula, o que achou da
-- professora, quantas vezes na semana teria interesse — dez minutos depois que
-- terminar a aula, sempre; ou quando a aula for lançada de que aconteceu."
--
-- Até aqui o aluno só era chamado DEPOIS de a professora responder "sim" ao
-- bot (etapa ASK_STUDENT). Professora que demorava horas travava a conversa
-- inteira — em 16/09 três experimentais ficaram "sem resposta de <teacher>".
-- Agora a conversa com o aluno começa na hora (aula de 30 min + 10), em
-- paralelo com a pergunta à professora. O LINK de matrícula continua exigindo
-- o "sim" dela (antifraude: quem diz que deu a aula é quem recebe por ela) —
-- `trial_closing_pending_offers` já solta o link assim que ela responde.
--
-- Migration re-executável (roda em todo release): só create or replace.
-- `trial_closing_student_asks` NÃO muda de assinatura — a migration antiga a
-- recria a cada release com o retorno antigo, e um retorno diferente aqui
-- faria aquela `create or replace` quebrar. A abertura de conversa vem de uma
-- função NOVA (`trial_closing_student_openers`).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) O fluxo nasce também quando a aula é LANÇADA antes dos 40 minutos.
create or replace function public.trial_closing_teacher_asks(p_limit integer default 10)
returns table(
  flow_id uuid, tenant_id text, teacher_id uuid, teacher_phone text,
  teacher_name text, lead_name text, when_text text
)
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.trial_closing_flows (
    tenant_id, opportunity_id, appointment_id, teacher_id, lead_phone, lead_name, stage
  )
  select
    opportunity.tenant_id,
    opportunity.id,
    appointment.id,
    coalesce(opportunity.winner_teacher_id, opportunity.professor_id),
    private.trial_closing_phone(coalesce(opportunity.student_phone, appointment.student_phone)),
    coalesce(nullif(pg_catalog.btrim(coalesce(opportunity.student_name, '')), ''), appointment.student_name),
    case
      when opportunity.trial_status = 'DONE'
       and private.trial_feedback_is_complete(opportunity.id) then 'ASK_STUDENT'
      else 'ASK_TEACHER'
    end
  from public.opportunities as opportunity
  join public.appointments as appointment
    on appointment.id = opportunity.trial_appointment_id
   and appointment.tenant_id = opportunity.tenant_id
  where opportunity.kind = 'TRIAL'
    and opportunity.status = 'CLAIMED'
    and coalesce(opportunity.conversion_status, 'OPEN') = 'OPEN'
    and coalesce(opportunity.trial_status, '') not in ('NO_SHOW_STUDENT', 'NO_SHOW_TEACHER')
    and coalesce(opportunity.is_test_fixture, false) = false
    and pg_catalog.lower(coalesce(appointment.type, '')) = 'experimental'
    and pg_catalog.lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed', 'completed')
    -- 30 min de aula + 10 — ou a aula já lançada como dada, o que vier antes.
    and (
      appointment.start_time + interval '40 minutes' <= pg_catalog.now()
      or (opportunity.trial_status = 'DONE' and appointment.start_time <= pg_catalog.now())
    )
    and appointment.start_time >= pg_catalog.now() - interval '7 days'
    and coalesce(opportunity.winner_teacher_id, opportunity.professor_id) is not null
    and pg_catalog.length(
      private.trial_closing_phone(coalesce(opportunity.student_phone, appointment.student_phone))
    ) between 12 and 13
    and not exists (
      select 1 from public.enrollment_links as link
      where link.opportunity_id = opportunity.id
    )
    and not exists (
      select 1 from public.offers as offer
      where offer.opportunity_id = opportunity.id
        and offer.kind = 'ENROLLMENT' and offer.revoked_at is null
    )
  on conflict (opportunity_id) do nothing;

  return query
  select flow.id, flow.tenant_id, flow.teacher_id,
    private.trial_closing_phone(teacher.phone),
    teacher.full_name, flow.lead_name,
    pg_catalog.to_char(appointment.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI')
  from private.trial_closing_flows as flow
  join public.appointments as appointment on appointment.id = flow.appointment_id
  join public.profiles as teacher on teacher.id = flow.teacher_id
  where flow.stage = 'ASK_TEACHER'
    and flow.teacher_asked_at is null
    and pg_catalog.length(private.trial_closing_phone(teacher.phone)) between 12 and 13
  order by appointment.start_time
  limit greatest(1, least(coalesce(p_limit, 10), 50));
end $$;

-- 2) Abertura da conversa com o aluno: 10 min depois da aula, sem esperar a
--    professora. Fluxo que ela já marcou como NO_SHOW não recebe abordagem.
create or replace function public.trial_closing_student_openers(p_limit integer default 10)
returns table(
  flow_id uuid, tenant_id text, lead_phone text, lead_name text,
  teacher_name text, when_text text, class_logged boolean
)
language sql security definer set search_path = '' as $$
  select flow.id, flow.tenant_id, flow.lead_phone, flow.lead_name,
    teacher.full_name,
    pg_catalog.to_char(appointment.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI'),
    coalesce(opportunity.trial_status, '') = 'DONE'
  from private.trial_closing_flows as flow
  join public.appointments as appointment on appointment.id = flow.appointment_id
  join public.opportunities as opportunity on opportunity.id = flow.opportunity_id
  join public.profiles as teacher on teacher.id = flow.teacher_id
  where flow.stage in ('ASK_TEACHER', 'ASK_STUDENT')
    and flow.student_asked_at is null
    and flow.outcome is distinct from 'NO_SHOW'
    and (
      appointment.start_time + interval '40 minutes' <= pg_catalog.now()
      or coalesce(opportunity.trial_status, '') = 'DONE'
    )
    -- "Como foi a aula?" uma semana depois soa a abandono; fluxo mais velho
    -- que isso já foi cobrado da professora e fica com a coordenação.
    and appointment.start_time >= pg_catalog.now() - interval '3 days'
  order by appointment.start_time
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- 3) A escolha do aluno vale mesmo antes do "sim" da professora: fica guardada
--    e o link sai quando ela responder (`waiting: feedback`, como já era).
create or replace function public.trial_closing_student_plan(
  p_tenant text, p_phone text, p_frequency integer, p_duration integer,
  p_slots jsonb, p_origin text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_plan jsonb;
  v_slots jsonb := '[]'::jsonb;
  v_frequency integer;
  v_duration integer;
  v_offer jsonb;
  v_need text[] := array[]::text[];
begin
  if p_tenant is null or coalesce(pg_catalog.btrim(coalesce(p_phone, '')), '') = '' then
    return pg_catalog.jsonb_build_object('handled', false);
  end if;
  select * into v_flow
    from private.trial_closing_flows
   where tenant_id = p_tenant and stage in ('ASK_TEACHER', 'ASK_STUDENT')
     and outcome is distinct from 'NO_SHOW'
     and private.notification_phones_same_recipient(lead_phone, private.trial_closing_phone(p_phone))
   order by created_at desc
   limit 1
   for update;
  if not found then return pg_catalog.jsonb_build_object('handled', false); end if;

  v_plan := v_flow.plan;
  if pg_catalog.jsonb_typeof(p_slots) = 'array' and pg_catalog.jsonb_array_length(p_slots) > 0 then
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('day', public.canonical_weekday_name(item.slot ->> 'day'), 'time', item.slot ->> 'time')
      order by item.ordinality
    ), '[]'::jsonb) into v_slots
    from pg_catalog.jsonb_array_elements(p_slots) with ordinality as item(slot, ordinality)
    where public.dow_name_to_int(item.slot ->> 'day') between 1 and 6
      and coalesce(item.slot ->> 'time', '') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$';
    if pg_catalog.jsonb_array_length(v_slots) > 0 then
      v_plan := v_plan || pg_catalog.jsonb_build_object(
        'slots', v_slots, 'frequency', pg_catalog.jsonb_array_length(v_slots)
      );
    end if;
  end if;
  if p_frequency between 1 and 6
     and pg_catalog.jsonb_typeof(v_plan -> 'slots') is distinct from 'array' then
    v_plan := v_plan || pg_catalog.jsonb_build_object('frequency', p_frequency);
  end if;
  if p_duration in (1, 6, 12) then
    v_plan := v_plan || pg_catalog.jsonb_build_object('duration', p_duration);
  end if;
  update private.trial_closing_flows
     set plan = v_plan, updated_at = pg_catalog.now()
   where id = v_flow.id;

  v_frequency := (v_plan ->> 'frequency')::integer;
  v_duration := (v_plan ->> 'duration')::integer;
  if pg_catalog.jsonb_typeof(v_plan -> 'slots') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_plan -> 'slots') <> coalesce(v_frequency, -1) then
    v_need := v_need || 'horarios';
  end if;
  if v_duration is null then v_need := v_need || 'plano'; end if;
  if pg_catalog.array_length(v_need, 1) > 0 then
    return pg_catalog.jsonb_build_object(
      'handled', true, 'flow_id', v_flow.id, 'need', pg_catalog.to_jsonb(v_need),
      'frequency', v_frequency, 'lead_name', v_flow.lead_name,
      'prices', private.trial_closing_prices(p_tenant)
    );
  end if;

  -- Sem o "sim" da professora não há link: o plano fica guardado e
  -- `trial_closing_pending_offers` solta o link assim que ela responder.
  if v_flow.stage <> 'ASK_STUDENT'
     or not private.trial_feedback_is_complete(v_flow.opportunity_id) then
    return pg_catalog.jsonb_build_object(
      'handled', true, 'flow_id', v_flow.id, 'waiting', 'feedback', 'lead_name', v_flow.lead_name
    );
  end if;

  v_offer := private.trial_closing_create_offer(v_flow.id, p_origin);
  return pg_catalog.jsonb_build_object(
    'handled', true, 'flow_id', v_flow.id, 'lead_name', v_flow.lead_name, 'offer', v_offer
  );
end $$;

-- 4) O que a atendente precisa saber para conduzir o fechamento como gente:
--    professora, quando foi, se já está lançada, o que o aluno já escolheu e
--    os horários livres da professora. NULL quando não há pós-experimental.
create or replace function public.trial_closing_student_context(p_tenant text, p_phone text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'flow_id', flow.id,
    'stage', flow.stage,
    'outcome', flow.outcome,
    'teacher_id', flow.teacher_id,
    'teacher_name', teacher.full_name,
    'when_text', pg_catalog.to_char(appointment.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI'),
    'class_logged', coalesce(opportunity.trial_status, '') = 'DONE',
    'student_asked_at', flow.student_asked_at,
    'teacher_answered_at', flow.teacher_answered_at,
    'offer_sent', flow.stage = 'OFFER_SENT' or flow.link_url is not null,
    'plan', flow.plan,
    'free_slots', private.trial_closing_free_slots(flow.tenant_id, flow.teacher_id),
    'prices', private.trial_closing_prices(flow.tenant_id)
  )
  from private.trial_closing_flows as flow
  join public.appointments as appointment on appointment.id = flow.appointment_id
  join public.opportunities as opportunity on opportunity.id = flow.opportunity_id
  join public.profiles as teacher on teacher.id = flow.teacher_id
  where flow.tenant_id = p_tenant
    and flow.created_at >= pg_catalog.now() - interval '14 days'
    and private.notification_phones_same_recipient(flow.lead_phone, private.trial_closing_phone(p_phone))
  order by flow.created_at desc
  limit 1;
$$;

-- 5) Briefing da experimental para o professor: quem é o aluno, telefone,
--    objetivo, nível, contexto e o horário — até 2h30 antes da aula (ou na
--    primeira varredura depois do aceite, quando o aceite é em cima da hora).
--    Dedupe fica com o chamador (`automation_sent`, kind TRIAL_TEACHER_BRIEFING).
create or replace function public.trial_teacher_briefings(p_limit integer default 20)
returns table(
  appointment_id uuid, tenant_id text, teacher_id uuid, teacher_phone text,
  teacher_name text, teacher_meeting_link text, class_date date, when_text text,
  lead_name text, lead_phone text, goal text, level text, notes text,
  weekly_availability text, interests text
)
language sql security definer set search_path = '' as $$
  select appointment.id, opportunity.tenant_id,
    coalesce(opportunity.winner_teacher_id, opportunity.professor_id),
    private.trial_closing_phone(teacher.phone),
    teacher.full_name, teacher.meeting_link,
    (appointment.start_time at time zone 'America/Sao_Paulo')::date,
    pg_catalog.to_char(appointment.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI'),
    coalesce(nullif(pg_catalog.btrim(coalesce(opportunity.student_name, '')), ''), appointment.student_name),
    private.trial_closing_phone(coalesce(opportunity.student_phone, appointment.student_phone)),
    lead.goal, lead.level, lead.notes, lead.weekly_availability, opportunity.interests
  from public.opportunities as opportunity
  join public.appointments as appointment
    on appointment.id = opportunity.trial_appointment_id
   and appointment.tenant_id = opportunity.tenant_id
  join public.profiles as teacher
    on teacher.id = coalesce(opportunity.winner_teacher_id, opportunity.professor_id)
  left join lateral (
    select l.goal, l.level, l.notes, l.weekly_availability
    from public.crm_leads as l
    where l.tenant_id = opportunity.tenant_id
      and private.notification_phones_same_recipient(
        l.phone, private.trial_closing_phone(coalesce(opportunity.student_phone, appointment.student_phone))
      )
    order by l.created_at desc
    limit 1
  ) as lead on true
  where opportunity.kind = 'TRIAL'
    and opportunity.status = 'CLAIMED'
    and coalesce(opportunity.is_test_fixture, false) = false
    and pg_catalog.lower(coalesce(appointment.type, '')) = 'experimental'
    and pg_catalog.lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed')
    and appointment.start_time > pg_catalog.now()
    and appointment.start_time <= pg_catalog.now() + interval '150 minutes'
    and pg_catalog.length(private.trial_closing_phone(teacher.phone)) between 12 and 13
    and pg_catalog.lower(coalesce(teacher.lifecycle_status, 'active')) = 'active'
    and not exists (
      select 1 from public.automation_sent as sent
      where sent.kind = 'TRIAL_TEACHER_BRIEFING' and sent.subject_id = appointment.id::text
    )
  order by appointment.start_time
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

alter function public.trial_closing_teacher_asks(integer) owner to postgres;
alter function public.trial_closing_student_openers(integer) owner to postgres;
alter function public.trial_closing_student_plan(text, text, integer, integer, jsonb, text) owner to postgres;
alter function public.trial_closing_student_context(text, text) owner to postgres;
alter function public.trial_teacher_briefings(integer) owner to postgres;

revoke all on function public.trial_closing_student_openers(integer) from public, anon, authenticated;
revoke all on function public.trial_closing_student_context(text, text) from public, anon, authenticated;
revoke all on function public.trial_teacher_briefings(integer) from public, anon, authenticated;

grant execute on function public.trial_closing_student_openers(integer) to service_role;
grant execute on function public.trial_closing_student_context(text, text) to service_role;
grant execute on function public.trial_teacher_briefings(integer) to service_role;
