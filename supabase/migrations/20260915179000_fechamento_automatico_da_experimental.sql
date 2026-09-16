-- ─────────────────────────────────────────────────────────────────────────────
-- Fechamento automático da experimental (15/09/2026)
--
-- Medido de 01 a 15/09: 9 experimentais aceitas já realizadas, 2 com a aula
-- lançada, 0 links de matrícula. O post-trial-pipeline avisou o diretor duas
-- vezes e ninguém gerou a proposta. O funil morre exatamente aqui.
--
-- As três portas do fechamento exigem um diretor logado (`auth.uid()`):
-- `update_trial_outcome_secure`, o lançamento da aula (que é o que PAGA o
-- professor) e `create_enrollment_offer`. Em vez de copiar essa lógica dura
-- para um caminho novo — que divergiria no primeiro ajuste — o bot ASSUME a
-- identidade de quem de direito e chama as MESMAS funções:
--
--   • resultado da aula e lançamento → o SCHOOL_ADMIN da escola;
--   • comentário da aula (SAVE_FEEDBACK) → o PRÓPRIO professor que respondeu,
--     identificado pelo telefone que mandou a mensagem;
--   • oferta de matrícula → o SCHOOL_ADMIN, com o preço da tabela da escola.
--
-- Nada aqui afrouxa as travas: quem não é professor daquela oportunidade
-- continua recusado, a aula só é lançada depois de terminada, o valor sai de
-- `student_pricing_plans` e o horário é revalidado contra a agenda.
--
-- Ordem obrigatória (descoberta lendo as funções): o professor só consegue
-- salvar o comentário DEPOIS que a aula está lançada, e a oferta só sai depois
-- do comentário.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists private.trial_closing_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  opportunity_id uuid not null,
  appointment_id uuid not null,
  teacher_id uuid not null,
  lead_phone text not null,
  lead_name text,
  stage text not null default 'ASK_TEACHER',
  outcome text,
  teacher_feedback jsonb not null default '{}'::jsonb,
  feedback_saved boolean not null default false,
  plan jsonb not null default '{}'::jsonb,
  teacher_asked_at timestamptz,
  teacher_alerted_at timestamptz,
  teacher_answered_at timestamptz,
  student_asked_at timestamptz,
  offer_id uuid,
  link_url text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A migration roda como supabase_admin e as funções rodam como postgres: sem
-- trocar o dono, elas não enxergam a própria tabela.
alter table private.trial_closing_flows owner to postgres;
alter table private.trial_closing_flows enable row level security;

create unique index if not exists uq_trial_closing_flows_opportunity
  on private.trial_closing_flows (opportunity_id);
create index if not exists ix_trial_closing_flows_stage
  on private.trial_closing_flows (tenant_id, stage);
create index if not exists ix_trial_closing_flows_teacher
  on private.trial_closing_flows (tenant_id, teacher_id, stage);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trial_closing_flows_stage_chk'
  ) then
    alter table private.trial_closing_flows
      add constraint trial_closing_flows_stage_chk
      check (stage in ('ASK_TEACHER', 'ASK_STUDENT', 'OFFER_SENT', 'NO_SHOW'));
  end if;
end $$;

-- Identidade determinística para as travas de idempotência das RPCs seguras:
-- o mesmo passo do mesmo fluxo sempre gera o mesmo requestId, então repetir a
-- chamada devolve o resultado anterior em vez de agir duas vezes. Versão 4 e
-- variante 8 porque as RPCs recusam uuid fora desse formato.
create or replace function private.trial_closing_request_id(p_seed text)
returns uuid language sql immutable set search_path = '' as $$
  select (
    pg_catalog.substr(h, 1, 8) || '-' || pg_catalog.substr(h, 9, 4) || '-4' ||
    pg_catalog.substr(h, 14, 3) || '-8' || pg_catalog.substr(h, 18, 3) || '-' ||
    pg_catalog.substr(h, 21, 12)
  )::uuid
  from (select pg_catalog.md5(coalesce(p_seed, '')) as h) as s;
$$;

-- O SCHOOL_ADMIN em nome de quem o bot age. Exige tenant ativo E que o tenant
-- ativo dele seja justamente esta escola — diretor de duas escolas não pode
-- emprestar a identidade para a errada.
create or replace function private.trial_closing_school_admin(p_tenant text)
returns uuid language sql stable security definer set search_path = '' as $$
  select membership.user_id
    from public.tenant_memberships as membership
    join public.profiles as profile on profile.id = membership.user_id
   where membership.tenant_id = p_tenant
     and membership.role = 'SCHOOL_ADMIN'
     and membership.status = 'ACTIVE'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, 'active'))) = 'active'
     and private.active_tenant_id(membership.user_id) = p_tenant
   order by membership.is_primary desc nulls last, membership.created_at, membership.id
   limit 1;
$$;

-- Assume a identidade de alguém DENTRO da transação (`is_local = true`), que é
-- o que `auth.uid()` lê. Nunca some com o valor original: quem chama guarda e
-- devolve. Em erro, o rollback do bloco já restaura sozinho.
create or replace function private.trial_closing_act_as(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    case when p_user is null then ''
      else pg_catalog.jsonb_build_object('sub', p_user, 'role', 'authenticated')::text end,
    true
  );
end $$;

create or replace function private.trial_closing_restore(p_sub text, p_claims text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  perform pg_catalog.set_config('request.jwt.claims', coalesce(p_claims, ''), true);
end $$;

-- Telefone no formato que o WhatsApp usa (55 + DDD + número).
create or replace function private.trial_closing_phone(p_raw text)
returns text language sql immutable set search_path = '' as $$
  select case
    when pg_catalog.length(digits.value) in (10, 11) then '55' || digits.value
    else digits.value
  end
  from (
    select pg_catalog.regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') as value
  ) as digits;
$$;

-- Tabela de preços da escola, do jeito que a mensagem precisa.
create or replace function private.trial_closing_prices(p_tenant text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'frequency', plan.classes_per_week,
      'duration', plan.fidelity_months,
      'value', plan.monthly_price
    ) order by plan.classes_per_week, plan.fidelity_months
  ), '[]'::jsonb)
  from public.student_pricing_plans as plan
  where plan.tenant_id = p_tenant
    and coalesce(plan.active, true)
    and plan.classes_per_week between 1 and 6
    and plan.fidelity_months in (1, 6, 12)
    and plan.monthly_price > 0;
$$;

-- Horários que o professor declarou e ainda não tem aula fixa. Mesma leitura de
-- slot discreto do resto do sistema (`end_time` é nulo em toda a base).
create or replace function private.trial_closing_free_slots(p_tenant text, p_teacher uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('day', slot.day_name, 'time', slot.hhmm)
    order by slot.day_of_week, slot.hhmm
  ), '[]'::jsonb)
  from (
    -- No máximo 2 por dia: a grade de um professor tem dezenas de horários no
    -- mesmo dia, e uma lista só de segunda-feira não ajuda ninguém a escolher.
    select livre.day_of_week, livre.day_name, livre.hhmm
    from (
      select distinct availability.day_of_week,
        public.canonical_weekday_name(
          case availability.day_of_week
            when 1 then 'Segunda' when 2 then 'Terça' when 3 then 'Quarta'
            when 4 then 'Quinta' when 5 then 'Sexta' when 6 then 'Sábado'
            else 'Domingo' end
        ) as day_name,
        pg_catalog.to_char(availability.start_time, 'HH24:MI') as hhmm
      from public.teacher_availability as availability
      where availability.tenant_id = p_tenant
        and availability.teacher_id = p_teacher
        and availability.day_of_week between 1 and 6
        and not exists (
          select 1 from public.bookings as booking
          where booking.tenant_id = p_tenant
            and booking.teacher_id = p_teacher
            and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
            and public.dow_name_to_int(booking.day_of_week) = availability.day_of_week
            and pg_catalog.left(pg_catalog.btrim(coalesce(booking.time_slot, '')), 5)
                = pg_catalog.to_char(availability.start_time, 'HH24:MI')
        )
    ) as livre
    where (
      select pg_catalog.count(*)
      from (
        select distinct availability.start_time
        from public.teacher_availability as availability
        where availability.tenant_id = p_tenant
          and availability.teacher_id = p_teacher
          and availability.day_of_week = livre.day_of_week
          and pg_catalog.to_char(availability.start_time, 'HH24:MI') < livre.hhmm
      ) as earlier
    ) < 2
    order by livre.day_of_week, livre.hhmm
    limit 12
  ) as slot;
$$;

-- Primeira aula: a próxima data, a partir de amanhã, que cai num dos dias
-- escolhidos. A oferta recusa data no passado.
create or replace function private.trial_closing_start_date(p_slots jsonb)
returns date language sql stable security definer set search_path = '' as $$
  select min(candidate.day)
  from pg_catalog.generate_series(
    ((pg_catalog.now() at time zone 'America/Sao_Paulo')::date + 1),
    ((pg_catalog.now() at time zone 'America/Sao_Paulo')::date + 8),
    interval '1 day'
  ) as candidate(day)
  where exists (
    select 1 from pg_catalog.jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) as item(slot)
    where public.dow_name_to_int(item.slot ->> 'day')
          = extract(dow from candidate.day)::integer
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) A pergunta ao professor: "a experimental aconteceu?"
-- ─────────────────────────────────────────────────────────────────────────────
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
    -- Professor que já lançou a aula E já comentou não é incomodado: o fluxo
    -- nasce direto na conversa com o aluno.
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
    and appointment.start_time + interval '40 minutes' <= pg_catalog.now()
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) A pergunta ao aluno, depois que a aula foi registrada
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.trial_closing_student_asks(p_limit integer default 10)
returns table(
  flow_id uuid, tenant_id text, lead_phone text, lead_name text,
  teacher_name text, prices jsonb
)
language sql security definer set search_path = '' as $$
  select flow.id, flow.tenant_id, flow.lead_phone, flow.lead_name,
    teacher.full_name, private.trial_closing_prices(flow.tenant_id)
  from private.trial_closing_flows as flow
  join public.profiles as teacher on teacher.id = flow.teacher_id
  where flow.stage = 'ASK_STUDENT'
    and flow.student_asked_at is null
  order by flow.created_at
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- Marca o envio. No lado do aluno, também assume os avisos do
-- post-trial-pipeline (o "gostou da aula?" e o alerta ao diretor para gerar a
-- proposta): quem está conduzindo agora é o bot, e dois toques sobre a mesma
-- coisa confundem o lead. O escalonamento de 24h fica de pé de propósito.
create or replace function public.trial_closing_mark_asked(p_flow uuid, p_side text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_flow private.trial_closing_flows%rowtype;
begin
  select * into v_flow from private.trial_closing_flows where id = p_flow for update;
  if not found then return false; end if;
  if p_side = 'teacher' then
    update private.trial_closing_flows
       set teacher_asked_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where id = p_flow;
  elsif p_side = 'student' then
    update private.trial_closing_flows
       set student_asked_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where id = p_flow;
    insert into public.automation_sent (kind, subject_id, ref_date)
    select kind.value, v_flow.opportunity_id::text,
      (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
    from (values ('TRIAL_NO_PROPOSAL_NUDGE'), ('TRIAL_NO_PROPOSAL_ALERT')) as kind(value)
    where not exists (
      select 1 from public.automation_sent as sent
      where sent.kind = kind.value and sent.subject_id = v_flow.opportunity_id::text
    )
    on conflict (kind, subject_id, ref_date) do nothing;
  else
    return false;
  end if;
  return true;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) A resposta do professor
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.trial_closing_teacher_reply(
  p_tenant text, p_teacher uuid, p_outcome text,
  p_level text, p_interest integer, p_plan text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_admin uuid;
  v_sub text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  v_outcome text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_outcome, '')));
  v_feedback jsonb;
  v_level text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_level, '')));
  v_plan text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_plan, '')));
  v_result jsonb;
  v_missing text[] := array[]::text[];
begin
  if p_tenant is null or p_teacher is null then
    return pg_catalog.jsonb_build_object('handled', false);
  end if;
  select * into v_flow
    from private.trial_closing_flows
   where tenant_id = p_tenant and teacher_id = p_teacher
     and stage = 'ASK_TEACHER' and teacher_asked_at is not null
   order by teacher_asked_at
   limit 1
   for update;
  if not found then return pg_catalog.jsonb_build_object('handled', false); end if;

  -- Comentário sem "sim" já diz que a aula aconteceu.
  if v_outcome not in ('DONE', 'NO_SHOW') then
    if v_level <> '' or p_interest is not null or v_plan <> '' then
      v_outcome := 'DONE';
    else
      return pg_catalog.jsonb_build_object('handled', false);
    end if;
  end if;

  if v_flow.outcome is null then
    v_admin := private.trial_closing_school_admin(p_tenant);
    if v_admin is null then
      return pg_catalog.jsonb_build_object('handled', true, 'error', 'sem_diretor');
    end if;
    begin
      perform private.trial_closing_act_as(v_admin);
      v_result := public.update_trial_outcome_secure(pg_catalog.jsonb_build_object(
        'requestId', private.trial_closing_request_id('trial-closing-status:' || v_flow.id::text),
        'opportunityId', v_flow.opportunity_id,
        'action', 'SET_TRIAL_STATUS',
        'trialStatus', case when v_outcome = 'NO_SHOW' then 'NO_SHOW_STUDENT' else 'DONE' end
      ));
      perform private.trial_closing_restore(v_sub, v_claims);
    exception when others then
      perform private.trial_closing_restore(v_sub, v_claims);
      update private.trial_closing_flows
         set last_error = pg_catalog.left(coalesce(sqlerrm, 'erro'), 300), updated_at = pg_catalog.now()
       where id = v_flow.id;
      return pg_catalog.jsonb_build_object('handled', true, 'error', pg_catalog.left(coalesce(sqlerrm, 'erro'), 120));
    end;
    if not coalesce((v_result ->> 'ok')::boolean, false) then
      update private.trial_closing_flows
         set last_error = coalesce(v_result ->> 'error', 'erro'), updated_at = pg_catalog.now()
       where id = v_flow.id;
      return pg_catalog.jsonb_build_object(
        'handled', true, 'error', coalesce(v_result ->> 'error', 'erro'),
        'lead_name', v_flow.lead_name
      );
    end if;
    update private.trial_closing_flows
       set outcome = v_outcome,
           teacher_answered_at = pg_catalog.now(),
           stage = case when v_outcome = 'NO_SHOW' then 'NO_SHOW' else stage end,
           last_error = null,
           updated_at = pg_catalog.now()
     where id = v_flow.id;
    if v_outcome = 'NO_SHOW' then
      return pg_catalog.jsonb_build_object(
        'handled', true, 'stage', 'NO_SHOW', 'flow_id', v_flow.id,
        'lead_phone', v_flow.lead_phone, 'lead_name', v_flow.lead_name
      );
    end if;
  end if;

  -- O comentário da aula: sem ele a oferta de matrícula é recusada.
  v_feedback := v_flow.teacher_feedback;
  if v_level in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2') then
    v_feedback := v_feedback || pg_catalog.jsonb_build_object('level', v_level);
  end if;
  if p_interest between 1 and 5 then
    v_feedback := v_feedback || pg_catalog.jsonb_build_object('interest', p_interest);
  end if;
  if v_plan in ('1x_semana', '2x_semana', '3x_semana', 'intensivo') then
    v_feedback := v_feedback || pg_catalog.jsonb_build_object('plan', v_plan);
  end if;
  update private.trial_closing_flows
     set teacher_feedback = v_feedback, updated_at = pg_catalog.now()
   where id = v_flow.id;

  if not (v_feedback ? 'level') then v_missing := v_missing || 'nivel'; end if;
  if not (v_feedback ? 'interest') then v_missing := v_missing || 'interesse'; end if;
  if not (v_feedback ? 'plan') then v_missing := v_missing || 'frequencia'; end if;
  if pg_catalog.array_length(v_missing, 1) > 0 then
    return pg_catalog.jsonb_build_object(
      'handled', true, 'stage', 'ASK_TEACHER', 'flow_id', v_flow.id,
      'need_feedback', pg_catalog.to_jsonb(v_missing), 'lead_name', v_flow.lead_name
    );
  end if;

  begin
    perform private.trial_closing_act_as(v_flow.teacher_id);
    v_result := public.update_trial_outcome_secure(pg_catalog.jsonb_build_object(
      'requestId', private.trial_closing_request_id(
        'trial-closing-feedback:' || v_flow.id::text || ':' || v_feedback::text
      ),
      'opportunityId', v_flow.opportunity_id,
      'action', 'SAVE_FEEDBACK',
      'recommendedLevel', v_feedback ->> 'level',
      'recommendedPlan', v_feedback ->> 'plan',
      'interestScore', (v_feedback ->> 'interest')::integer,
      'notes', 'Registrado pela professora no WhatsApp.'
    ));
    perform private.trial_closing_restore(v_sub, v_claims);
  exception when others then
    perform private.trial_closing_restore(v_sub, v_claims);
    update private.trial_closing_flows
       set last_error = pg_catalog.left(coalesce(sqlerrm, 'erro'), 300), updated_at = pg_catalog.now()
     where id = v_flow.id;
    return pg_catalog.jsonb_build_object('handled', true, 'error', pg_catalog.left(coalesce(sqlerrm, 'erro'), 120));
  end;
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    update private.trial_closing_flows
       set last_error = coalesce(v_result ->> 'error', 'erro'), updated_at = pg_catalog.now()
     where id = v_flow.id;
    return pg_catalog.jsonb_build_object(
      'handled', true, 'error', coalesce(v_result ->> 'error', 'erro'), 'lead_name', v_flow.lead_name
    );
  end if;

  update private.trial_closing_flows
     set feedback_saved = true, stage = 'ASK_STUDENT', last_error = null, updated_at = pg_catalog.now()
   where id = v_flow.id;

  return pg_catalog.jsonb_build_object(
    'handled', true, 'stage', 'ASK_STUDENT', 'flow_id', v_flow.id,
    'lead_phone', v_flow.lead_phone, 'lead_name', v_flow.lead_name,
    'already_asked', v_flow.student_asked_at is not null,
    'teacher_name', (select full_name from public.profiles where id = v_flow.teacher_id),
    'prices', private.trial_closing_prices(p_tenant)
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) A resposta do aluno: frequência, horários e plano → link de matrícula
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function private.trial_closing_create_offer(p_flow uuid, p_origin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_admin uuid;
  v_sub text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  v_frequency integer;
  v_duration integer;
  v_slots jsonb;
  v_value numeric;
  v_start date;
  v_billing_month text;
  v_due_day integer := 10;
  v_offer_id uuid;
  v_url text;
  v_schedule jsonb;
  v_teacher_name text;
  v_origin text := pg_catalog.rtrim(
    coalesce(nullif(pg_catalog.btrim(coalesce(p_origin, '')), ''), 'https://system.wisewolflanguage.com.br'),
    '/'
  );
begin
  select * into v_flow from private.trial_closing_flows where id = p_flow for update;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'fluxo_inexistente'); end if;
  v_frequency := (v_flow.plan ->> 'frequency')::integer;
  v_duration := (v_flow.plan ->> 'duration')::integer;
  v_slots := v_flow.plan -> 'slots';
  if v_frequency is null or v_duration is null
     or pg_catalog.jsonb_typeof(v_slots) is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_slots) <> v_frequency then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'plano_incompleto');
  end if;

  select plan.monthly_price into v_value
    from public.student_pricing_plans as plan
   where plan.tenant_id = v_flow.tenant_id
     and coalesce(plan.active, true)
     and plan.classes_per_week = v_frequency
     and plan.fidelity_months = v_duration
     and plan.monthly_price > 0
   order by plan.created_at
   limit 1;
  if v_value is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_preco_na_tabela');
  end if;

  v_start := private.trial_closing_start_date(v_slots);
  if v_start is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'horario_invalido');
  end if;
  -- Primeira cobrança: o dia 10 do mês da primeira aula, ou do mês seguinte
  -- quando o dia 10 já passou — a oferta recusa vencimento antes do início.
  v_billing_month := case
    when pg_catalog.make_date(
      extract(year from v_start)::integer, extract(month from v_start)::integer, v_due_day
    ) >= v_start then pg_catalog.to_char(v_start, 'YYYY-MM')
    else pg_catalog.to_char((v_start + interval '1 month')::date, 'YYYY-MM')
  end;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'day', item.slot ->> 'day',
      'time', item.slot ->> 'time',
      'teacherId', v_flow.teacher_id
    ) order by item.ordinality
  ) into v_schedule
  from pg_catalog.jsonb_array_elements(v_slots) with ordinality as item(slot, ordinality);

  begin
    v_admin := private.trial_closing_school_admin(v_flow.tenant_id);
    if v_admin is null then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_diretor');
    end if;
    perform private.trial_closing_act_as(v_admin);
    v_offer_id := public.create_enrollment_offer(pg_catalog.jsonb_build_object(
      'requestId', private.trial_closing_request_id(
        'trial-closing-offer:' || v_flow.id::text || ':' || v_frequency::text || ':' ||
        v_duration::text || ':' || v_slots::text
      ),
      'unitId', v_flow.tenant_id,
      'opportunityId', v_flow.opportunity_id,
      'studentName', coalesce(v_flow.lead_name, 'Aluno'),
      'studentPhone', v_flow.lead_phone,
      'value', v_value,
      'planDuration', v_duration,
      'classesPerWeek', v_frequency,
      'dueDay', v_due_day,
      'professorId', v_flow.teacher_id,
      'schedule', v_schedule,
      'startDate', pg_catalog.to_char(v_start, 'YYYY-MM-DD'),
      'billingStartMonth', v_billing_month,
      'enrollmentFee', 0,
      '_linkOrigin', v_origin
    ));
    perform private.trial_closing_restore(v_sub, v_claims);
  exception when others then
    perform private.trial_closing_restore(v_sub, v_claims);
    update private.trial_closing_flows
       set last_error = pg_catalog.left(coalesce(sqlerrm, 'erro'), 300),
           -- Horário ocupado volta a perguntar o horário, não o plano inteiro.
           plan = case
             when sqlerrm in ('teacher_slot_unavailable', 'teacher_slot_occupied', 'enrollment_schedule_reserved')
             then plan - 'slots' - 'frequency' else plan end,
           updated_at = pg_catalog.now()
     where id = v_flow.id;
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', pg_catalog.left(coalesce(sqlerrm, 'erro'), 120),
      'free_slots', private.trial_closing_free_slots(v_flow.tenant_id, v_flow.teacher_id)
    );
  end;

  select coalesce(link.link_url, v_origin || '/matricula?offer=' || v_offer_id::text)
    into v_url
    from public.enrollment_links as link
   where link.offer_id = v_offer_id
   order by link.created_at desc
   limit 1;
  v_url := coalesce(v_url, v_origin || '/matricula?offer=' || v_offer_id::text);
  select full_name into v_teacher_name from public.profiles where id = v_flow.teacher_id;

  update private.trial_closing_flows
     set stage = 'OFFER_SENT', offer_id = v_offer_id, link_url = v_url,
         last_error = null, updated_at = pg_catalog.now()
   where id = v_flow.id;

  -- A Gestão vê todo link que o bot manda, com preço e horário.
  perform private.notify_management_group(
    v_flow.tenant_id, null, v_flow.teacher_id, v_flow.id,
    'trial-closing-offer:' || v_flow.id::text,
    '🤖 Link de matrícula enviado pelo bot' || chr(10) ||
    'Aluno: ' || coalesce(v_flow.lead_name, 'sem nome') || chr(10) ||
    'Plano: ' || v_frequency::text || 'x por semana · ' ||
      case v_duration when 1 then 'mensal' else v_duration::text || ' meses' end ||
      ' · R$ ' ||
      pg_catalog.replace(pg_catalog.to_char(v_value, 'FM999999990.00'), '.', ',') ||
      '/mês (tabela)' || chr(10) ||
    'Professor: ' || coalesce(v_teacher_name, '—') || chr(10) ||
    'Horário: ' || private.renewal_slots_text(v_slots) || chr(10) ||
    'Início: ' || pg_catalog.to_char(v_start, 'DD/MM') || ' · vencimento dia ' || v_due_day::text
  );

  return pg_catalog.jsonb_build_object(
    'ok', true, 'offer_id', v_offer_id, 'url', v_url, 'value', v_value,
    'frequency', v_frequency, 'duration', v_duration, 'slots', v_slots,
    'start_date', pg_catalog.to_char(v_start, 'DD/MM')
  );
end $$;

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
   where tenant_id = p_tenant and stage = 'ASK_STUDENT'
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

  -- O comentário da professora pode não ter chegado ainda; o plano fica
  -- guardado e o link sai sozinho quando ela responder.
  if not private.trial_feedback_is_complete(v_flow.opportunity_id) then
    return pg_catalog.jsonb_build_object(
      'handled', true, 'flow_id', v_flow.id, 'waiting', 'feedback', 'lead_name', v_flow.lead_name
    );
  end if;

  v_offer := private.trial_closing_create_offer(v_flow.id, p_origin);
  return pg_catalog.jsonb_build_object(
    'handled', true, 'flow_id', v_flow.id, 'lead_name', v_flow.lead_name, 'offer', v_offer
  );
end $$;

-- Fecha o que ficou esperando o comentário da professora: quando ela responde
-- depois do aluno, o link sai na mesma hora.
create or replace function public.trial_closing_pending_offers(p_origin text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_flow private.trial_closing_flows%rowtype; v_rows jsonb := '[]'::jsonb; v_offer jsonb;
begin
  for v_flow in
    select * from private.trial_closing_flows
     where stage = 'ASK_STUDENT'
       and plan ? 'duration' and plan ? 'slots'
       and private.trial_feedback_is_complete(opportunity_id)
     order by created_at
     limit 10
  loop
    v_offer := private.trial_closing_create_offer(v_flow.id, p_origin);
    if coalesce((v_offer ->> 'ok')::boolean, false) then
      v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'tenant_id', v_flow.tenant_id, 'lead_phone', v_flow.lead_phone,
        'lead_name', v_flow.lead_name, 'offer', v_offer
      ));
    end if;
  end loop;
  return v_rows;
end $$;

-- Professor que não responde trava o fechamento: a Gestão fica sabendo em 6h.
create or replace function public.trial_closing_overdue()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_flow record; v_count integer := 0;
begin
  for v_flow in
    select flow.id, flow.tenant_id, flow.teacher_id, flow.lead_name,
      teacher.full_name as teacher_name, appointment.start_time
    from private.trial_closing_flows as flow
    join public.profiles as teacher on teacher.id = flow.teacher_id
    join public.appointments as appointment on appointment.id = flow.appointment_id
    where flow.stage = 'ASK_TEACHER'
      and flow.teacher_asked_at is not null
      and flow.teacher_asked_at < pg_catalog.now() - interval '6 hours'
      and flow.teacher_alerted_at is null
    order by flow.teacher_asked_at
    limit 20
  loop
    perform private.notify_management_group(
      v_flow.tenant_id, null, v_flow.teacher_id, v_flow.id,
      'trial-closing-overdue:' || v_flow.id::text,
      '⏰ A experimental de ' || coalesce(v_flow.lead_name, 'um lead') || ' (' ||
      pg_catalog.to_char(v_flow.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI') ||
      ') está sem resposta de ' || coalesce(v_flow.teacher_name, 'a professora') ||
      '. Enquanto ela não disser se a aula aconteceu, o link de matrícula não sai.'
    );
    update private.trial_closing_flows
       set teacher_alerted_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where id = v_flow.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

alter function private.trial_closing_request_id(text) owner to postgres;
alter function private.trial_closing_school_admin(text) owner to postgres;
alter function private.trial_closing_act_as(uuid) owner to postgres;
alter function private.trial_closing_restore(text, text) owner to postgres;
alter function private.trial_closing_prices(text) owner to postgres;
alter function private.trial_closing_free_slots(text, uuid) owner to postgres;
alter function private.trial_closing_start_date(jsonb) owner to postgres;
alter function private.trial_closing_phone(text) owner to postgres;
alter function private.trial_closing_create_offer(uuid, text) owner to postgres;
alter function public.trial_closing_teacher_asks(integer) owner to postgres;
alter function public.trial_closing_student_asks(integer) owner to postgres;
alter function public.trial_closing_mark_asked(uuid, text) owner to postgres;
alter function public.trial_closing_teacher_reply(text, uuid, text, text, integer, text) owner to postgres;
alter function public.trial_closing_student_plan(text, text, integer, integer, jsonb, text) owner to postgres;
alter function public.trial_closing_pending_offers(text) owner to postgres;
alter function public.trial_closing_overdue() owner to postgres;

revoke all on function public.trial_closing_teacher_asks(integer) from public, anon, authenticated;
revoke all on function public.trial_closing_student_asks(integer) from public, anon, authenticated;
revoke all on function public.trial_closing_mark_asked(uuid, text) from public, anon, authenticated;
revoke all on function public.trial_closing_teacher_reply(text, uuid, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.trial_closing_student_plan(text, text, integer, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.trial_closing_pending_offers(text) from public, anon, authenticated;
revoke all on function public.trial_closing_overdue() from public, anon, authenticated;

grant execute on function public.trial_closing_teacher_asks(integer) to service_role;
grant execute on function public.trial_closing_student_asks(integer) to service_role;
grant execute on function public.trial_closing_mark_asked(uuid, text) to service_role;
grant execute on function public.trial_closing_teacher_reply(text, uuid, text, text, integer, text) to service_role;
grant execute on function public.trial_closing_student_plan(text, text, integer, integer, jsonb, text) to service_role;
grant execute on function public.trial_closing_pending_offers(text) to service_role;
grant execute on function public.trial_closing_overdue() to service_role;
