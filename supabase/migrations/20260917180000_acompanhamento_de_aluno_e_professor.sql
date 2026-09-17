-- ─────────────────────────────────────────────────────────────────────────────
-- ACOMPANHAMENTO DE ALUNO E PROFESSOR — a manutenção de conversa que a direção
-- fazia no gogó (decisão de 17/09/2026).
--
-- Medido nos 30 dias anteriores: 362 aulas dadas, 82 faltas de aluno (18%),
-- 15 alunos com 2+ faltas, 55 reposições de aluno abertas — TODAS sem data. A
-- confirmação de presença pede nota e 796 aulas ficaram sem resposta. O aluno
-- falta, ganha o direito à reposição, e ninguém corre atrás.
--
-- O que nasce aqui:
--   • `care_touchpoints`: cada toque (falta de ontem, semana, mês, professor),
--     idempotente por (assunto, tipo, referência), com o resultado da conversa.
--   • RPCs de "o que está vencido" para o `care-sweeper` (cron 15 min) e de
--     contexto para a conversa no `whatsapp-inbound` (agente `care`).
--   • Reposição por direito: 4 por mês (antes 5). Da 5ª em diante é acordo
--     entre aluno e professor, sem obrigação — o engine de lançamento deixa de
--     criar reposição automática a partir da 5ª falta do mês.
--   • O bot marca a data da reposição na hora, na grade livre do professor.
--
-- Decisões da direção: 4 reposições por direito; aluno contratado passa a
-- conversar com a IA neste acompanhamento (regra dura: nunca fala de cobrança,
-- contrato ou pagamento — isso vai para gente); cadência semanal + mensal +
-- gatilhos.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.care_touchpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  subject_role text not null check (subject_role in ('STUDENT', 'TEACHER')),
  subject_id uuid not null,
  phone text not null,
  kind text not null check (kind in (
    'ABSENCE_FOLLOWUP', 'WEEKLY_CHECKIN', 'MONTHLY_CHECKIN',
    'TEACHER_STUDENT_ABSENCE_NUDGE', 'TEACHER_RESCHEDULE_POLICY', 'TEACHER_MONTHLY_CHECKIN'
  )),
  trigger_ref text not null,
  status text not null default 'SENT' check (status in ('SENT', 'REPLIED', 'HANDOFF', 'CLOSED', 'FAILED')),
  context jsonb not null default '{}'::jsonb,
  sentiment text check (sentiment is null or sentiment in ('POSITIVE', 'NEUTRAL', 'NEGATIVE')),
  summary text,
  sent_at timestamptz,
  replied_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_care_touchpoints_subject_kind_ref
  on public.care_touchpoints (tenant_id, subject_role, subject_id, kind, trigger_ref);
create index if not exists ix_care_touchpoints_phone_recent
  on public.care_touchpoints (tenant_id, phone, created_at desc);
create index if not exists ix_care_touchpoints_open
  on public.care_touchpoints (tenant_id, subject_role, subject_id, created_at desc);
alter table public.care_touchpoints enable row level security;
alter table public.care_touchpoints owner to postgres;
-- Só service_role escreve; a direção lê a própria escola.
drop policy if exists care_touchpoints_admin_read on public.care_touchpoints;
create policy care_touchpoints_admin_read on public.care_touchpoints
  for select to authenticated
  using (
    tenant_id = public._my_tenant_id()
    and public._my_role() in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR')
  );

-- ── Reposição por direito: 4 por mês ─────────────────────────────────────────
-- O engine é derivado a cada release (04/08 → 20/08 → 12/09); patch por âncora,
-- re-executável, como em 20260915170000.
do $quatro_reposicoes$
declare
  d text;
  anchor text := $anchor$          if v_student_absence_count < 5 then$anchor$;
  replacement text := $replacement$          -- 4 reposições por direito no mês (direção, 17/09/2026); da 5ª em
          -- diante é acordo entre aluno e professor, sem obrigação — não nasce
          -- reposição automática.
          if v_student_absence_count < 4 then$replacement$;
begin
  select pg_get_functiondef('private.log_teacher_classes_engine(jsonb)'::regprocedure) into d;
  if strpos(d, '4 reposições por direito no mês') = 0 then
    if strpos(d, anchor) = 0 then
      raise exception 'engine de lançamento inesperado: âncora do limite de reposições não encontrada';
    end if;
    execute replace(d, anchor, replacement);
  end if;
end;
$quatro_reposicoes$;
revoke all on function private.log_teacher_classes_engine(jsonb) from public, anon, authenticated, service_role;

create or replace function public.care_student_makeup_quota(p_tenant text, p_student uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'limit', 4,
    'used', (
      select count(*) from public.reschedules r
       where r.tenant_id = p_tenant and r.student_id = p_student and r.fault_type = 'STUDENT'
         and r.created_at >= pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'America/Sao_Paulo')
    ),
    'pending_without_date', (
      select count(*) from public.reschedules r
       where r.tenant_id = p_tenant and r.student_id = p_student and r.fault_type = 'STUDENT'
         and r.used_at is null and (r.date is null or r.date = 'Pendente')
    )
  );
$$;

-- ── Horários livres do professor nos próximos dias ───────────────────────────
-- Grade declarada (slot discreto de 30 min) menos aula fixa, reposição marcada,
-- experimental e aula avulsa daquele dia. Nada no passado; até `p_days` dias.
create or replace function private.care_teacher_free_slots(p_tenant text, p_teacher uuid, p_days integer default 7, p_limit integer default 4)
returns jsonb language sql stable security definer set search_path = '' as $$
  with dias as (
    select d::date as dia
      from pg_catalog.generate_series((pg_catalog.now() at time zone 'America/Sao_Paulo')::date + 1,
                                      (pg_catalog.now() at time zone 'America/Sao_Paulo')::date + greatest(1, least(coalesce(p_days, 7), 21)), interval '1 day') d
  ),
  candidatos as (
    select dias.dia, av.start_time::time as hora, extract(dow from dias.dia)::int as dow
      from dias
      join public.teacher_availability av
        on av.teacher_id = p_teacher and av.tenant_id = p_tenant
       and av.day_of_week = extract(dow from dias.dia)::int
     where extract(dow from dias.dia) between 1 and 6
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'date', pg_catalog.to_char(c.dia, 'YYYY-MM-DD'),
           'day', public.canonical_weekday_name(pg_catalog.to_char(c.dia, 'FMDay')),
           'time', pg_catalog.to_char(c.hora, 'HH24:MI'),
           'label', pg_catalog.to_char(c.dia, 'DD/MM') || ' às ' || pg_catalog.to_char(c.hora, 'HH24:MI')
         ) order by c.dia, c.hora), '[]'::jsonb)
    from (
      select c.dia, c.hora
        from candidatos c
       where not exists (
               select 1 from public.bookings b
                where b.tenant_id = p_tenant and b.teacher_id = p_teacher
                  and upper(coalesce(b.status, '')) = 'SCHEDULED'
                  and ((b.date is null and public.dow_name_to_int(b.day_of_week) = c.dow) or b.date = c.dia)
                  and left(b.time_slot, 5) = pg_catalog.to_char(c.hora, 'HH24:MI'))
         and not exists (
               select 1 from public.reschedules r
                where r.tenant_id = p_tenant and r.teacher_id = p_teacher and r.used_at is null
                  and public.parse_lesson_date(r.date) = c.dia and left(r.time, 5) = pg_catalog.to_char(c.hora, 'HH24:MI'))
         and not exists (
               select 1 from public.appointments a
                where a.tenant_id = p_tenant and coalesce(a.teacher_id, a.professor_id) = p_teacher
                  and lower(coalesce(a.status, 'scheduled')) not in ('cancelled', 'no_show')
                  and (a.start_time at time zone 'America/Sao_Paulo')::date = c.dia
                  and pg_catalog.to_char(a.start_time at time zone 'America/Sao_Paulo', 'HH24:MI') = pg_catalog.to_char(c.hora, 'HH24:MI'))
       order by c.dia, c.hora
       limit greatest(1, least(coalesce(p_limit, 4), 10))
    ) c;
$$;

-- ── Quem está em acompanhamento humano (não cutucar) ─────────────────────────
create or replace function private.care_subject_on_hold(p_tenant text, p_role text, p_subject uuid, p_days integer default 3)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.care_touchpoints t
     where t.tenant_id = p_tenant and t.subject_role = p_role and t.subject_id = p_subject
       and (
         (t.status = 'HANDOFF' and t.updated_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days))
         or (t.status in ('SENT', 'REPLIED') and t.created_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days))
       )
  );
$$;

-- ── 1) Faltou ontem → conversa no dia seguinte ───────────────────────────────
create or replace function public.care_due_absence_followups(p_limit integer default 20)
returns table(
  tenant_id text, student_id uuid, student_name text, phone text, class_log_id uuid,
  class_date date, teacher_id uuid, teacher_name text, reschedule_id uuid,
  quota jsonb, free_slots jsonb
)
language sql stable security definer set search_path = '' as $$
  select l.tenant_id, l.student_id, s.full_name, pg_catalog.regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'),
         l.id, l.class_date, l.teacher_id, t.full_name,
         (select r.id from public.reschedules r
           where r.tenant_id = l.tenant_id and r.student_id = l.student_id and r.fault_type = 'STUDENT'
             and r.used_at is null and (r.date is null or r.date = 'Pendente')
           order by r.created_at desc limit 1),
         public.care_student_makeup_quota(l.tenant_id, l.student_id),
         private.care_teacher_free_slots(l.tenant_id, l.teacher_id, 7, 3)
    from public.class_logs l
    join public.profiles s on s.id = l.student_id
    join public.profiles t on t.id = l.teacher_id
   where l.presence = 'STUDENT_ABSENCE'
     and l.class_date between (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 2
                          and (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 1
     and l.created_at >= pg_catalog.now() - interval '3 days'
     and public.is_student_notifiable(s.id)
     and pg_catalog.length(pg_catalog.regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) between 10 and 13
     and coalesce(s.is_test_account, false) = false
     and not exists (select 1 from public.care_touchpoints c
                      where c.tenant_id = l.tenant_id and c.subject_role = 'STUDENT' and c.subject_id = l.student_id
                        and c.kind = 'ABSENCE_FOLLOWUP' and c.trigger_ref = l.id::text)
     and not private.care_subject_on_hold(l.tenant_id, 'STUDENT', l.student_id, 2)
   order by l.class_date, l.created_at
   limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

-- ── 2) Sexta à tarde: como foi a semana (só quem teve aula) ──────────────────
create or replace function public.care_due_weekly_checkins(p_limit integer default 20)
returns table(tenant_id text, student_id uuid, student_name text, phone text, teacher_name text, week_ref text, classes_this_week integer)
language sql stable security definer set search_path = '' as $$
  with semana as (
    select pg_catalog.date_trunc('week', (pg_catalog.now() at time zone 'America/Sao_Paulo')::date)::date as ini,
           'W' || pg_catalog.to_char((pg_catalog.now() at time zone 'America/Sao_Paulo')::date, 'IYYY-IW') as ref
  )
  select l.tenant_id, l.student_id, s.full_name, pg_catalog.regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'),
         (select t.full_name from public.profiles t where t.id = (array_agg(l.teacher_id order by l.class_date desc))[1]),
         semana.ref, count(*)::int
    from public.class_logs l
    cross join semana
    join public.profiles s on s.id = l.student_id
   where l.presence = 'COMPLETED'
     and l.class_date >= semana.ini
     and l.class_date <= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
     and public.is_student_notifiable(s.id)
     and coalesce(s.is_test_account, false) = false
     and pg_catalog.length(pg_catalog.regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) between 10 and 13
     and not exists (select 1 from public.care_touchpoints c
                      where c.tenant_id = l.tenant_id and c.subject_role = 'STUDENT' and c.subject_id = l.student_id
                        and c.kind = 'WEEKLY_CHECKIN' and c.trigger_ref = semana.ref)
     and not private.care_subject_on_hold(l.tenant_id, 'STUDENT', l.student_id, 3)
   group by l.tenant_id, l.student_id, s.full_name, s.phone, semana.ref
   order by count(*) desc
   limit greatest(1, least(coalesce(p_limit, 20), 60));
$$;

-- ── 3) A cada 30 dias: o curso está te atendendo? ────────────────────────────
create or replace function public.care_due_monthly_checkins(p_limit integer default 8)
returns table(tenant_id text, student_id uuid, student_name text, phone text, teacher_name text, month_ref text, months_enrolled integer)
language sql stable security definer set search_path = '' as $$
  select s.tenant_id, s.id, s.full_name, pg_catalog.regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'),
         (select t.full_name from public.bookings b join public.profiles t on t.id = b.teacher_id
           where b.student_id = s.id and upper(coalesce(b.status, '')) = 'SCHEDULED' order by b.created_at desc limit 1),
         'M' || pg_catalog.to_char((pg_catalog.now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM'),
         greatest(1, (extract(epoch from pg_catalog.now() - s.created_at) / 2592000)::int)
    from public.profiles s
   where s.role = 'STUDENT'
     and public.is_student_notifiable(s.id)
     and coalesce(s.is_test_account, false) = false
     and lower(coalesce(s.lifecycle_status, 'active')) = 'active'
     and s.created_at <= pg_catalog.now() - interval '30 days'
     and pg_catalog.length(pg_catalog.regexp_replace(coalesce(s.phone, ''), '\D', '', 'g')) between 10 and 13
     and exists (select 1 from public.bookings b where b.student_id = s.id and upper(coalesce(b.status, '')) = 'SCHEDULED')
     and exists (select 1 from public.class_logs l where l.student_id = s.id and l.class_date >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 45)
     and not exists (select 1 from public.care_touchpoints c
                      where c.tenant_id = s.tenant_id and c.subject_role = 'STUDENT' and c.subject_id = s.id
                        and c.kind = 'MONTHLY_CHECKIN' and c.created_at >= pg_catalog.now() - interval '30 days')
     and not private.care_subject_on_hold(s.tenant_id, 'STUDENT', s.id, 3)
   order by s.created_at
   limit greatest(1, least(coalesce(p_limit, 8), 30));
$$;

-- ── 4) Professor: aluno que faltou e não respondeu; remarcação demais; mês ───
create or replace function public.care_due_teacher_touchpoints(p_limit integer default 20)
returns table(kind text, tenant_id text, teacher_id uuid, teacher_name text, phone text, trigger_ref text, context jsonb)
language sql stable security definer set search_path = '' as $$
  -- a) aluno faltou, o bot falou com ele há mais de 24 h e ele não respondeu
  (select 'TEACHER_STUDENT_ABSENCE_NUDGE', c.tenant_id, l.teacher_id, t.full_name,
          pg_catalog.regexp_replace(coalesce(t.phone, ''), '\D', '', 'g'), c.id::text,
          pg_catalog.jsonb_build_object('student_name', s.full_name, 'class_date', l.class_date,
            'quota', public.care_student_makeup_quota(c.tenant_id, c.subject_id),
            'free_slots', private.care_teacher_free_slots(c.tenant_id, l.teacher_id, 7, 2))
     from public.care_touchpoints c
     join public.class_logs l on l.id::text = c.trigger_ref
     join public.profiles t on t.id = l.teacher_id
     join public.profiles s on s.id = c.subject_id
    where c.subject_role = 'STUDENT' and c.kind = 'ABSENCE_FOLLOWUP' and c.status = 'SENT'
      and c.sent_at is not null and c.sent_at <= pg_catalog.now() - interval '24 hours'
      and c.sent_at >= pg_catalog.now() - interval '4 days'
      and lower(coalesce(t.lifecycle_status, 'active')) = 'active'
      and pg_catalog.length(pg_catalog.regexp_replace(coalesce(t.phone, ''), '\D', '', 'g')) between 10 and 13
      and not exists (select 1 from public.care_touchpoints x
                       where x.tenant_id = c.tenant_id and x.subject_role = 'TEACHER' and x.subject_id = l.teacher_id
                         and x.kind = 'TEACHER_STUDENT_ABSENCE_NUDGE' and x.trigger_ref = c.id::text))
  union all
  -- b) 2+ remarcações/faltas do professor em 30 dias → lembrete da política, 1×/mês
  (select 'TEACHER_RESCHEDULE_POLICY', t.tenant_id, t.id, t.full_name,
          pg_catalog.regexp_replace(coalesce(t.phone, ''), '\D', '', 'g'),
          'M' || pg_catalog.to_char((pg_catalog.now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM'),
          pg_catalog.jsonb_build_object('reschedules_30d', x.n)
     from (
       -- Falta do professor SEM cobertura: quem avisou e teve a aula coberta
       -- fez o certo e não recebe lembrete de política.
       select l.teacher_id, l.tenant_id, count(*) as n
         from public.class_logs l
        where l.presence = 'TEACHER_ABSENCE'
          and l.class_date >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 30
          and not exists (
            select 1 from public.class_coverages c
             where c.tenant_id = l.tenant_id and c.original_teacher_id = l.teacher_id
               and c.class_date = l.class_date and lower(coalesce(c.status, '')) = 'confirmed'
               and (c.booking_id::text = l.booking_id::text or c.student_id = l.student_id))
        group by l.teacher_id, l.tenant_id
       having count(*) >= 2
     ) x
     join public.profiles t on t.id = x.teacher_id
    where lower(coalesce(t.lifecycle_status, 'active')) = 'active'
      and pg_catalog.length(pg_catalog.regexp_replace(coalesce(t.phone, ''), '\D', '', 'g')) between 10 and 13
      and not exists (select 1 from public.care_touchpoints c
                       where c.tenant_id = t.tenant_id and c.subject_role = 'TEACHER' and c.subject_id = t.id
                         and c.kind = 'TEACHER_RESCHEDULE_POLICY' and c.created_at >= pg_catalog.now() - interval '30 days'))
  union all
  -- c) check-in mensal com quem deu aula nos últimos 30 dias
  (select 'TEACHER_MONTHLY_CHECKIN', t.tenant_id, t.id, t.full_name,
          pg_catalog.regexp_replace(coalesce(t.phone, ''), '\D', '', 'g'),
          'M' || pg_catalog.to_char((pg_catalog.now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM'),
          pg_catalog.jsonb_build_object('classes_30d', (select count(*) from public.class_logs l where l.teacher_id = t.id and l.class_date >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 30))
     from public.profiles t
    where t.role = 'TEACHER'
      and lower(coalesce(t.lifecycle_status, 'active')) = 'active'
      and coalesce(t.is_test_account, false) = false
      and pg_catalog.length(pg_catalog.regexp_replace(coalesce(t.phone, ''), '\D', '', 'g')) between 10 and 13
      and exists (select 1 from public.class_logs l where l.teacher_id = t.id and l.class_date >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 30)
      and t.created_at <= pg_catalog.now() - interval '30 days'
      and not exists (select 1 from public.care_touchpoints c
                       where c.tenant_id = t.tenant_id and c.subject_role = 'TEACHER' and c.subject_id = t.id
                         and c.kind = 'TEACHER_MONTHLY_CHECKIN' and c.created_at >= pg_catalog.now() - interval '30 days')
      and not private.care_subject_on_hold(t.tenant_id, 'TEACHER', t.id, 3))
  limit greatest(1, least(coalesce(p_limit, 20), 60));
$$;

-- ── Registro do toque (marca antes de enviar; apaga se o envio falhar) ───────
create or replace function public.care_touchpoint_open(
  p_tenant text, p_role text, p_subject uuid, p_phone text, p_kind text, p_trigger text, p_context jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.care_touchpoints (tenant_id, subject_role, subject_id, phone, kind, trigger_ref, context, status)
  values (p_tenant, p_role, p_subject, p_phone, p_kind, p_trigger, coalesce(p_context, '{}'::jsonb), 'SENT')
  on conflict (tenant_id, subject_role, subject_id, kind, trigger_ref) do nothing
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.care_touchpoint_delivery(p_id uuid, p_delivered boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_delivered then
    update public.care_touchpoints set sent_at = pg_catalog.now(), updated_at = pg_catalog.now() where id = p_id;
  else
    delete from public.care_touchpoints where id = p_id and sent_at is null;
  end if;
end $$;

-- ── A conversa aberta deste telefone (para o inbound) ────────────────────────
create or replace function public.care_open_conversation(p_tenant text, p_phone text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'status', c.status, 'subject_role', c.subject_role, 'subject_id', c.subject_id,
    'subject_name', p.full_name, 'context', c.context, 'sent_at', c.sent_at, 'summary', c.summary,
    'teacher_id', case when c.subject_role = 'STUDENT' then coalesce(
        (select l.teacher_id from public.class_logs l where l.id::text = c.trigger_ref),
        (select b.teacher_id from public.bookings b where b.student_id = c.subject_id and upper(coalesce(b.status, '')) = 'SCHEDULED' order by b.created_at desc limit 1)) end,
    'teacher_name', case when c.subject_role = 'STUDENT' then (
        select t.full_name from public.profiles t where t.id = coalesce(
          (select l.teacher_id from public.class_logs l where l.id::text = c.trigger_ref),
          (select b.teacher_id from public.bookings b where b.student_id = c.subject_id and upper(coalesce(b.status, '')) = 'SCHEDULED' order by b.created_at desc limit 1))) end,
    'quota', case when c.subject_role = 'STUDENT' then public.care_student_makeup_quota(c.tenant_id, c.subject_id) end,
    'reschedule_id', case when c.subject_role = 'STUDENT' then (
        select r.id from public.reschedules r
         where r.tenant_id = c.tenant_id and r.student_id = c.subject_id and r.fault_type = 'STUDENT'
           and r.used_at is null and (r.date is null or r.date = 'Pendente')
         order by r.created_at desc limit 1) end
  )
  from public.care_touchpoints c
  join public.profiles p on p.id = c.subject_id
  where c.tenant_id = p_tenant
    and private.notification_phones_same_recipient(c.phone, pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'))
    and c.status in ('SENT', 'REPLIED', 'HANDOFF')
    and c.created_at >= pg_catalog.now() - interval '7 days'
  order by c.created_at desc
  limit 1;
$$;

create or replace function public.care_teacher_free_slots(p_tenant text, p_teacher uuid, p_days integer default 7, p_limit integer default 4)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.care_teacher_free_slots(p_tenant, p_teacher, p_days, p_limit);
$$;

create or replace function public.care_touchpoint_reply(p_id uuid, p_status text, p_sentiment text, p_summary text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.care_touchpoints
     set status = case when p_status in ('REPLIED', 'HANDOFF', 'CLOSED') then p_status else status end,
         sentiment = case when p_sentiment in ('POSITIVE', 'NEUTRAL', 'NEGATIVE') then p_sentiment else sentiment end,
         summary = coalesce(nullif(pg_catalog.btrim(coalesce(p_summary, '')), ''), summary),
         replied_at = coalesce(replied_at, pg_catalog.now()),
         closed_at = case when p_status = 'CLOSED' then pg_catalog.now() else closed_at end,
         updated_at = pg_catalog.now()
   where id = p_id;
end $$;

-- ── O bot marca a reposição na grade livre do professor ──────────────────────
create or replace function public.care_set_reschedule_slot(p_tenant text, p_student uuid, p_reschedule uuid, p_date date, p_time text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.reschedules%rowtype; v_time text := left(pg_catalog.btrim(coalesce(p_time, '')), 5); v_free jsonb; t public.profiles%rowtype;
begin
  select * into r from public.reschedules where id = p_reschedule and tenant_id = p_tenant and student_id = p_student for update;
  if not found or r.used_at is not null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'reposicao_nao_encontrada'); end if;
  if p_date is null or p_date <= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date or v_time !~ '^(0[0-9]|1[0-9]|2[0-3]):(00|30)$' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'horario_invalido');
  end if;
  v_free := private.care_teacher_free_slots(p_tenant, r.teacher_id, 21, 10);
  if not exists (select 1 from pg_catalog.jsonb_array_elements(v_free) s
                  where s ->> 'date' = pg_catalog.to_char(p_date, 'YYYY-MM-DD') and s ->> 'time' = v_time) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'professor_ocupado', 'free_slots', v_free);
  end if;
  update public.reschedules set date = pg_catalog.to_char(p_date, 'YYYY-MM-DD'), time = v_time where id = r.id;
  select * into t from public.profiles where id = r.teacher_id;
  return pg_catalog.jsonb_build_object('ok', true, 'date', pg_catalog.to_char(p_date, 'YYYY-MM-DD'), 'time', v_time,
    'day', public.canonical_weekday_name(pg_catalog.to_char(p_date, 'FMDay')),
    'teacher_name', t.full_name, 'teacher_phone', pg_catalog.regexp_replace(coalesce(t.phone, ''), '\D', '', 'g'));
end $$;

-- ── Cron ────────────────────────────────────────────────────────────────────
create or replace function public.trigger_care_sweeper() returns bigint language plpgsql security definer set search_path = '' as $fn$
declare v_key text; v_request bigint;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'wisewolf_service_role_key' limit 1;
  if nullif(v_key, '') is null then return -1; end if;
  select net.http_post(url := 'http://kong:8000/functions/v1/care-sweeper',
    headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"sweep":true}'::jsonb, timeout_milliseconds := 120000) into v_request;
  return v_request;
end $fn$;

do $owners$ declare f regprocedure; n text; begin
  for f, n in select p.oid::regprocedure, s.nspname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where p.proname like 'care_%' or p.proname = 'trigger_care_sweeper'
  loop
    execute format('alter function %s owner to postgres', f);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    if n = 'public' then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $owners$;

do $cron$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'wisewolf-care-sweeper';
    perform cron.schedule('wisewolf-care-sweeper', '*/15 * * * *', 'select public.trigger_care_sweeper();');
  end if;
end $cron$;
