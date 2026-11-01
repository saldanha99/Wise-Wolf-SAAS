-- Turbo visível em reais + aula experimental conferida pelo Google Meet.
-- Decisão da direção (31/10/2026):
--   1. Quando o Turbo estiver ativo, deixar claro para a escola e para o
--      professor QUANTO ele recebe a mais por causa do Turbo.
--   2. A direção não quer mais aprovar experimental à mão: a sala da escola no
--      Meet confere se professor e lead estiveram juntos e liquida sozinha.
--
-- Reexecutável: o release aplica a migration duas vezes antes de valer.

-- ───────────────────────── 1. TURBO EM REAIS ─────────────────────────

-- Tarifa que a aula teria SEM o Turbo: a mesma régua de teacher_student_rate
-- antes do teste do Turbo (contrato por aula usa o valor fixo do perfil).
create or replace function private.teacher_rate_without_turbo(p_teacher uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text; v_flat numeric; v_base numeric; v_per_lesson boolean;
begin
  select p.tenant_id, p.hourly_rate into v_tenant, v_flat
    from public.profiles p where p.id = p_teacher;
  select coalesce((
    select r.commercial_snapshot ->> 'rateUnit' = 'PER_LESSON'
      from public.tenant_contract_records r
     where r.user_id = p_teacher and r.tenant_id = v_tenant and r.contract_kind = 'TEACHER'
     order by r.accepted_at desc, r.created_at desc limit 1), false)
    into v_per_lesson;
  select t.rate into v_base from public.teacher_pay_tiers t
   where t.tenant_id = v_tenant and t.min_students = 1;
  return case when v_per_lesson then coalesce(v_flat, v_base, 0) else coalesce(v_base, v_flat, 0) end;
end;
$$;

-- Aula a aula do mês: o que ela pagou e quanto disso é Turbo. Só conta como
-- Turbo a aula paga pela régua das faixas (sem ajuste manual, sem valor de
-- cobertura oferecido pela direção, sem tarifa de treinador), num dia em que o
-- Turbo do professor estava ligado. A fonte é a mesma da folha
-- (v_payable_class_logs): o extra da tela é exatamente o que ele recebe.
create or replace function private.turbo_lessons(p_tenant text, p_month text)
returns table (
  teacher_id uuid, student_id uuid, class_date date,
  rate_efetivo numeric, base_rate numeric, extra numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with aulas as (
    select v.teacher_id, v.student_id, v.class_date, v.rate_efetivo, v.rate_override,
           v.treinamento_ministrado,
           private.teacher_rate_without_turbo(v.teacher_id) as base_rate
      from public.v_payable_class_logs v
      join public.profiles t on t.id = v.teacher_id
     where t.tenant_id = p_tenant
       and pg_catalog.to_char(v.class_date, 'YYYY-MM') = p_month
  )
  select a.teacher_id, a.student_id, a.class_date, a.rate_efetivo, a.base_rate,
         case
           when a.rate_override is null
            and not coalesce(a.treinamento_ministrado, false)
            and a.student_id is not null
            and a.rate_efetivo > a.base_rate
            and public.teacher_turbo_on(a.teacher_id, a.class_date)
            and a.rate_efetivo = public.teacher_student_rate(a.teacher_id, a.student_id, a.class_date)
           then a.rate_efetivo - a.base_rate
           else 0
         end as extra
    from aulas a
$$;

-- Resumo por professor, com a abertura por aluno.
create or replace function private.turbo_month_summary(p_tenant text, p_month text, p_teacher uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with l as (
    select * from private.turbo_lessons(p_tenant, p_month)
     where p_teacher is null or teacher_id = p_teacher
  ), por_aluno as (
    select l.teacher_id, l.student_id, s.full_name,
           count(*) filter (where l.extra > 0)::int as aulas_turbo,
           sum(l.extra) as extra,
           max(l.rate_efetivo) filter (where l.extra > 0) as tarifa_turbo
      from l left join public.profiles s on s.id = l.student_id
     group by 1, 2, 3
    having sum(l.extra) > 0
  ), por_prof as (
    select l.teacher_id,
           count(*)::int as aulas,
           count(*) filter (where l.extra > 0)::int as aulas_turbo,
           coalesce(sum(l.extra), 0) as extra,
           coalesce(sum(l.rate_efetivo), 0) as total,
           max(l.base_rate) as base_rate
      from l group by 1
  )
  select pg_catalog.jsonb_build_object(
    'month', p_month,
    'extra', coalesce((select pg_catalog.round(sum(extra), 2) from por_prof), 0),
    'teachers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'teacher_id', p.teacher_id,
               'aulas', p.aulas,
               'aulas_turbo', p.aulas_turbo,
               'extra', pg_catalog.round(p.extra, 2),
               'total', pg_catalog.round(p.total, 2),
               'base_rate', p.base_rate,
               'students', coalesce((
                 select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'name', pg_catalog.split_part(coalesce(a.full_name, 'Aluno'), ' ', 1),
                          'aulas_turbo', a.aulas_turbo,
                          'tarifa', a.tarifa_turbo,
                          'extra', pg_catalog.round(a.extra, 2)) order by a.extra desc)
                   from por_aluno a where a.teacher_id = p.teacher_id), '[]'::jsonb)
             ) order by p.extra desc)
        from por_prof p), '[]'::jsonb)
  )
$$;

-- Leitura para a tela: o próprio professor (só o dele) ou direção/coordenação
-- da escola. Mês no formato YYYY-MM; vazio = mês corrente em Brasília.
create or replace function public.teacher_turbo_earnings(p_teacher uuid, p_month text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text;
  v_month text := coalesce(nullif(pg_catalog.btrim(coalesce(p_month, '')), ''),
                           pg_catalog.to_char(pg_catalog.now() at time zone 'America/Sao_Paulo', 'YYYY-MM'));
  v_teacher jsonb;
begin
  if v_month !~ '^\d{4}-\d{2}$' then
    raise exception using errcode = '22023', message = 'mes_invalido';
  end if;
  select p.tenant_id into v_tenant from public.profiles p where p.id = p_teacher;
  if v_tenant is null then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if not (
    (auth.uid() = p_teacher and coalesce(public._my_role(), '') = 'TEACHER')
    or private.prepayment_caller_can_read(v_tenant)
  ) then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  select t into v_teacher
    from pg_catalog.jsonb_array_elements(
      private.turbo_month_summary(v_tenant, v_month, p_teacher) -> 'teachers') t
   limit 1;
  return pg_catalog.jsonb_build_object(
    'month', v_month,
    'turbo_active', public.teacher_turbo_on(p_teacher, (pg_catalog.now() at time zone 'America/Sao_Paulo')::date),
    'aulas', coalesce((v_teacher ->> 'aulas')::int, 0),
    'aulas_turbo', coalesce((v_teacher ->> 'aulas_turbo')::int, 0),
    'extra', coalesce((v_teacher ->> 'extra')::numeric, 0),
    'total', coalesce((v_teacher ->> 'total')::numeric, 0),
    'base_rate', coalesce((v_teacher ->> 'base_rate')::numeric, private.teacher_rate_without_turbo(p_teacher)),
    'students', coalesce(v_teacher -> 'students', '[]'::jsonb)
  );
end;
$$;

-- A folha (grupo e "Repasse a Profs") ganha o Turbo por professor sem recriar
-- payroll_month_rows: o embrulho acrescenta 'turbo' a cada linha.
create or replace function private.payroll_month_rows_with_turbo(p_tenant text, p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb := private.payroll_month_rows(p_tenant, p_month);
  v_turbo jsonb;
begin
  if coalesce((v_rows ->> 'ok')::boolean, false) is not true then
    return v_rows;
  end if;
  v_turbo := private.turbo_month_summary(p_tenant, v_rows ->> 'month');
  return v_rows
    || pg_catalog.jsonb_build_object(
         'total_turbo', coalesce((v_turbo ->> 'extra')::numeric, 0),
         'teachers', coalesce((
           select pg_catalog.jsonb_agg(
                    r || pg_catalog.jsonb_build_object('turbo', coalesce((
                      select pg_catalog.jsonb_build_object(
                               'aulas', (t ->> 'aulas_turbo')::int,
                               'extra', (t ->> 'extra')::numeric)
                        from pg_catalog.jsonb_array_elements(v_turbo -> 'teachers') t
                       where t ->> 'teacher_id' = r ->> 'teacher_id'
                         and (t ->> 'extra')::numeric > 0),
                      pg_catalog.jsonb_build_object('aulas', 0, 'extra', 0)))
                    order by ord)
             from pg_catalog.jsonb_array_elements(v_rows -> 'teachers') with ordinality as x(r, ord)),
           '[]'::jsonb));
end;
$$;

create or replace function public.gestao_payroll_summary(p_tenant text, p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  return private.payroll_month_rows_with_turbo(p_tenant, p_month);
end;
$$;

create or replace function public.payroll_month_preview(p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
begin
  if auth.uid() is null or v_tenant is null
     or coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  return private.payroll_month_rows_with_turbo(v_tenant, p_month);
end;
$$;

-- ─────────────────── 2. EXPERIMENTAL CONFERIDA PELO MEET ───────────────────

-- Liga por escola. Sem linha = desligado (o painel continua como antes).
create table if not exists private.trial_meet_settings (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default true,
  -- Minutos que professor E lead precisam ter ficado na sala para a aula valer.
  min_minutes integer not null default 10 check (min_minutes between 5 and 30),
  reason text not null,
  created_at timestamptz not null default pg_catalog.now()
);
alter table private.trial_meet_settings owner to postgres;
revoke all on private.trial_meet_settings from public, anon, authenticated, service_role;

-- Uma sala por experimental. Guarda só NÚMEROS da presença (segundos, horário
-- de entrada): nem planilha, nem nome, nem e-mail do lead.
create table if not exists private.trial_meet_rooms (
  appointment_id uuid primary key references public.appointments(id) on delete cascade,
  tenant_id text not null,
  teacher_id uuid not null,
  cohost_email text not null,
  state text not null check (state in ('CREATING', 'READY', 'FAILED')),
  claim_id uuid,
  space_name text,
  meeting_uri text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  error_code text,
  outcome text check (outcome in (
    'ATTENDED', 'NO_SHOW', 'TEACHER_ABSENT', 'NO_CONFERENCE', 'NO_REPORT',
    'UNCERTAIN', 'CONFLICT')),
  evidence jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);
alter table private.trial_meet_rooms owner to postgres;
revoke all on private.trial_meet_rooms from public, anon, authenticated, service_role;
create index if not exists trial_meet_rooms_ready_idx
  on private.trial_meet_rooms (state, outcome);

-- Liquidação pelo Meet. A mesma conta da liquidação do painel
-- (settle_trial_session_unchecked), sem exigir sessão de diretor: quem decide
-- aqui é a evidência do Google. Nunca desfaz o que o professor já lançou.
create or replace function private.trial_settle_from_meet(p_appointment uuid, p_attended boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record; v_teacher uuid; v_logged boolean;
begin
  select ap.id, ap.tenant_id, ap.type, ap.status, ap.start_time,
         coalesce(ap.teacher_id, o.winner_teacher_id) as teacher_id
    into a
    from public.appointments ap
    left join public.opportunities o on o.trial_appointment_id = ap.id
   where ap.id = p_appointment
   for update of ap;
  if a.id is null then return 'nao_encontrado'; end if;
  if pg_catalog.lower(coalesce(a.type, '')) <> 'experimental' then return 'nao_experimental'; end if;
  if a.teacher_id is null then return 'sem_professor'; end if;
  v_logged := exists (select 1 from public.class_logs cl where cl.appointment_id = p_appointment::text);

  if p_attended then
    if a.start_time + interval '30 minutes' > pg_catalog.now() then return 'aula_nao_terminou'; end if;
    if v_logged then
      -- O professor lançou: a aula só passa a pagar com o appointment concluído.
      update public.appointments set status = 'completed'
       where id = p_appointment and pg_catalog.lower(coalesce(status, '')) = 'scheduled';
      return 'ja_lancado';
    end if;
    if pg_catalog.lower(coalesce(a.status, '')) <> 'scheduled' then return 'ja_liquidado'; end if;
    insert into public.class_logs (tenant_id, teacher_id, appointment_id, presence, subtype, date, class_date, created_at)
    values (a.tenant_id, a.teacher_id, p_appointment::text, 'COMPLETED', 'AULA EXPERIMENTAL',
            (a.start_time at time zone 'America/Sao_Paulo')::date,
            (a.start_time at time zone 'America/Sao_Paulo')::date, pg_catalog.now());
    update public.appointments set status = 'completed' where id = p_appointment;
    return 'pago';
  end if;

  -- Lead não veio. Se o professor lançou a aula como dada, é divergência: fica
  -- para a direção, nada é mudado.
  if v_logged then return 'conflito'; end if;
  if pg_catalog.lower(coalesce(a.status, '')) <> 'scheduled' then return 'ja_liquidado'; end if;
  update public.appointments set status = 'no_show' where id = p_appointment;
  return 'nao_veio';
end;
$$;

-- Porta única da edge google-meet para as salas de experimental (só service_role).
create or replace function public.trial_meet_backend(p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt uuid := nullif(p_payload ->> 'appointment_id', '')::uuid;
  r private.trial_meet_rooms;
  v_claim uuid;
  v_result text;
  v_outcome text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;

  if p_action = 'due' then
    return pg_catalog.jsonb_build_object(
      -- Salas a criar: experimental aceita nas próximas 24 h, professor com a
      -- conta Google confirmada, escola conectada e com a conferência ligada.
      -- Experimental que já tem um link registrado (o professor mandou o dele)
      -- fica de fora: o lead entraria por lá e o Google não veria nada.
      'prepare', coalesce((
        select pg_catalog.jsonb_agg(x) from (
          select pg_catalog.jsonb_build_object(
                   'appointment_id', ap.id, 'tenant_id', ap.tenant_id,
                   'actor_id', c.connected_by, 'teacher_id', t.id,
                   'cohost_email', gi.google_email) as x
            from public.appointments ap
            join public.opportunities o on o.trial_appointment_id = ap.id and o.tenant_id = ap.tenant_id
            join public.profiles t on t.id = coalesce(o.winner_teacher_id, ap.teacher_id)
            join private.teacher_google_identities gi on gi.teacher_id = t.id and gi.tenant_id = ap.tenant_id
            join private.trial_meet_settings s on s.tenant_id = ap.tenant_id and s.enabled
            join private.google_workspace_connections c on c.tenant_id = ap.tenant_id and c.status = 'CONNECTED'
            left join private.trial_meet_rooms m on m.appointment_id = ap.id
           where pg_catalog.lower(coalesce(ap.type, '')) = 'experimental'
             and pg_catalog.lower(coalesce(ap.status, '')) in ('scheduled', 'confirmed')
             and o.kind = 'TRIAL' and o.status = 'CLAIMED'
             and not coalesce(o.is_test_fixture, false)
             and ap.start_time > pg_catalog.now()
             and ap.start_time <= pg_catalog.now() + interval '24 hours'
             and pg_catalog.lower(coalesce(t.lifecycle_status, 'active')) = 'active'
             and (nullif(pg_catalog.btrim(coalesce(ap.meeting_link, '')), '') is null
                  or ap.meeting_link = m.meeting_uri)
             and (m.appointment_id is null
                  or (m.state = 'FAILED' and m.attempts < 5 and coalesce(m.next_attempt_at, '-infinity') <= pg_catalog.now())
                  or (m.state = 'CREATING' and m.updated_at < pg_catalog.now() - interval '15 minutes')
                  or (m.state = 'READY' and m.cohost_email is distinct from gi.google_email))
           order by ap.start_time
           limit 10) q), '[]'::jsonb),
      -- Salas a conferir: 40 min depois do início (30 de aula + 10), até 6 h.
      'evaluate', coalesce((
        select pg_catalog.jsonb_agg(x) from (
          select pg_catalog.jsonb_build_object(
                   'appointment_id', m.appointment_id, 'tenant_id', m.tenant_id,
                   'actor_id', c.connected_by, 'space_name', m.space_name,
                   'meeting_uri', m.meeting_uri, 'cohost_email', m.cohost_email,
                   'organizer_email', c.organizer_email,
                   'start_time', ap.start_time, 'min_minutes', s.min_minutes,
                   'final', ap.start_time + interval '6 hours' <= pg_catalog.now()) as x
            from private.trial_meet_rooms m
            join public.appointments ap on ap.id = m.appointment_id
            join private.trial_meet_settings s on s.tenant_id = m.tenant_id and s.enabled
            join private.google_workspace_connections c on c.tenant_id = m.tenant_id and c.status = 'CONNECTED'
           where m.state = 'READY'
             and m.settled_at is null
             and (m.outcome is null or m.outcome in ('NO_CONFERENCE', 'NO_REPORT'))
             and ap.start_time + interval '40 minutes' <= pg_catalog.now()
             and ap.start_time + interval '6 hours 30 minutes' > pg_catalog.now()
             and (m.evaluated_at is null or m.evaluated_at < pg_catalog.now() - interval '10 minutes')
           order by ap.start_time
           limit 10) q), '[]'::jsonb));
  end if;

  if v_appt is null then
    raise exception using errcode = '22023', message = 'appointment_required';
  end if;

  if p_action = 'room_claim' then
    v_claim := pg_catalog.gen_random_uuid();
    insert into private.trial_meet_rooms as m
      (appointment_id, tenant_id, teacher_id, cohost_email, state, claim_id, attempts)
    values (v_appt, p_payload ->> 'tenant_id', (p_payload ->> 'teacher_id')::uuid,
            p_payload ->> 'cohost_email', 'CREATING', v_claim, 1)
    on conflict (appointment_id) do update
       set state = case when m.state = 'READY' then 'READY' else 'CREATING' end,
           claim_id = case when m.state = 'READY' then m.claim_id else v_claim end,
           attempts = m.attempts + case when m.state = 'READY' then 0 else 1 end,
           teacher_id = excluded.teacher_id,
           cohost_email = excluded.cohost_email,
           updated_at = pg_catalog.now()
     where m.state in ('FAILED', 'READY')
        or (m.state = 'CREATING' and m.updated_at < pg_catalog.now() - interval '15 minutes')
    returning * into r;
    if r.appointment_id is null then
      return pg_catalog.jsonb_build_object('claimed', false);
    end if;
    return pg_catalog.jsonb_build_object(
      'claimed', true, 'claim_id', r.claim_id, 'state', r.state,
      'space_name', r.space_name, 'cohost_email', r.cohost_email);
  end if;

  if p_action = 'room_save' then
    if p_payload ->> 'state' = 'READY' then
      update private.trial_meet_rooms
         set state = 'READY',
             space_name = coalesce(p_payload ->> 'space_name', space_name),
             meeting_uri = coalesce(p_payload ->> 'meeting_uri', meeting_uri),
             error_code = null, next_attempt_at = null, updated_at = pg_catalog.now()
       where appointment_id = v_appt
         and claim_id = (p_payload ->> 'claim_id')::uuid
      returning * into r;
      if r.appointment_id is null then
        raise exception using errcode = '40001', message = 'trial_room_claim_lost';
      end if;
      -- O link oficial vira o link da experimental: briefing do professor,
      -- painel e o atendimento ("qual o link?") passam a usar a sala da escola.
      update public.appointments
         set meeting_link = r.meeting_uri
       where id = v_appt
         and (nullif(pg_catalog.btrim(coalesce(meeting_link, '')), '') is null);
    else
      update private.trial_meet_rooms
         set state = 'FAILED',
             error_code = left(coalesce(p_payload ->> 'error_code', 'google_room_creation_failed'), 80),
             next_attempt_at = pg_catalog.now() + (interval '15 minutes' * attempts),
             updated_at = pg_catalog.now()
       where appointment_id = v_appt
         and claim_id = (p_payload ->> 'claim_id')::uuid
         and state = 'CREATING'
      returning * into r;
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'state', r.state, 'meeting_uri', r.meeting_uri);
  end if;

  if p_action = 'evaluate_save' then
    v_outcome := p_payload ->> 'outcome';
    if v_outcome not in ('ATTENDED', 'NO_SHOW', 'TEACHER_ABSENT', 'NO_CONFERENCE',
                         'NO_REPORT', 'UNCERTAIN') then
      raise exception using errcode = '22023', message = 'trial_outcome_invalid';
    end if;
    if v_outcome in ('ATTENDED', 'NO_SHOW') then
      v_result := private.trial_settle_from_meet(v_appt, v_outcome = 'ATTENDED');
      if v_result = 'conflito' then v_outcome := 'CONFLICT'; end if;
      -- Cedo demais: não grava resultado, a próxima rodada confere de novo.
      if v_result = 'aula_nao_terminou' then v_outcome := null; end if;
    end if;
    update private.trial_meet_rooms
       set outcome = v_outcome,
           evidence = coalesce(p_payload -> 'evidence', '{}'::jsonb)
                      || pg_catalog.jsonb_build_object('settle', v_result),
           evaluated_at = pg_catalog.now(),
           settled_at = case when v_result in ('pago', 'nao_veio', 'ja_lancado', 'ja_liquidado')
                             then pg_catalog.now() end,
           updated_at = pg_catalog.now()
     where appointment_id = v_appt
    returning * into r;
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', r.outcome, 'settle', v_result);
  end if;

  raise exception using errcode = '22023', message = 'trial_meet_action_invalid';
end;
$$;

-- Link da sala para o lead, pelo funnel-sweeper (6 h antes até a hora da aula).
create or replace function public.trial_meet_link_notices(p_limit integer default 20)
returns table (
  appointment_id uuid, tenant_id text, class_date date, when_text text,
  lead_name text, lead_phone text, teacher_name text, meeting_uri text
)
language sql
stable
security definer
set search_path = ''
as $$
  select ap.id, ap.tenant_id,
         (ap.start_time at time zone 'America/Sao_Paulo')::date,
         pg_catalog.to_char(ap.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI'),
         coalesce(nullif(pg_catalog.btrim(coalesce(o.student_name, '')), ''), ap.student_name),
         private.trial_closing_phone(coalesce(o.student_phone, ap.student_phone)),
         t.full_name, m.meeting_uri
    from private.trial_meet_rooms m
    join public.appointments ap on ap.id = m.appointment_id
    join public.opportunities o on o.trial_appointment_id = ap.id and o.tenant_id = ap.tenant_id
    join public.profiles t on t.id = m.teacher_id
    join private.trial_meet_settings s on s.tenant_id = m.tenant_id and s.enabled
   where m.state = 'READY'
     and ap.meeting_link = m.meeting_uri
     and pg_catalog.lower(coalesce(ap.status, '')) in ('scheduled', 'confirmed')
     and o.status = 'CLAIMED' and not coalesce(o.is_test_fixture, false)
     and ap.start_time > pg_catalog.now()
     and ap.start_time <= pg_catalog.now() + interval '6 hours'
   order by ap.start_time
   limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;

-- Briefing do professor: o link da experimental (a sala da escola, quando
-- existe) vem antes do link pessoal do perfil. Remendo por âncora.
do $patch$
declare v_def text;
begin
  v_def := pg_catalog.pg_get_functiondef('public.trial_teacher_briefings(integer)'::regprocedure);
  if v_def like '%teacher.full_name, teacher.meeting_link,%' then
    execute pg_catalog.replace(v_def, 'teacher.full_name, teacher.meeting_link,',
      'teacher.full_name, coalesce(nullif(pg_catalog.btrim(coalesce(appointment.meeting_link, '''')), ''''), teacher.meeting_link),');
  elsif v_def not like '%coalesce(nullif(pg_catalog.btrim(coalesce(appointment.meeting_link%' then
    raise exception 'trial_teacher_briefings: âncora do link não encontrada';
  end if;
end $patch$;

-- Painel do diretor: o que sobrar para decidir à mão mostra o que o Google viu.
create or replace function public.list_pending_trial_sessions_unchecked()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_role text; v_tenant text;
begin
  select role, tenant_id into v_role, v_tenant from profiles where id = auth.uid();
  if v_role not in ('SCHOOL_ADMIN','SUPER_ADMIN') then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'appointment_id', a.id,
      'type',           a.type,
      'start_time',     a.start_time,
      'student_name',   a.student_name,
      'teacher_id',     tch.id,
      'teacher_name',   tch.full_name,
      'hourly_rate',    coalesce(tch.hourly_rate, 0),
      'meet', case when m.appointment_id is null then null else jsonb_build_object(
                'state', m.state, 'outcome', m.outcome,
                'teacher_minutes', round(coalesce((m.evidence ->> 'teacher_seconds')::numeric, 0) / 60),
                'lead_minutes', round(coalesce((m.evidence ->> 'lead_seconds')::numeric, 0) / 60),
                'evaluated_at', m.evaluated_at) end
    ) order by a.start_time desc)
    from appointments a
    left join opportunities o on o.trial_appointment_id = a.id
    left join profiles tch on tch.id = coalesce(a.teacher_id, o.winner_teacher_id)
    left join private.trial_meet_rooms m on m.appointment_id = a.id
    where a.type in ('experimental','training')
      and a.tenant_id = v_tenant
      and a.status = 'scheduled'
      and a.start_time + interval '30 minutes' <= now()
      and a.start_time >= '2026-06-01'::timestamptz
      and tch.id is not null
      and not exists (select 1 from class_logs cl where cl.appointment_id = a.id::text)
  ), '[]'::jsonb);
end;
$function$;

-- Donos e privilégios: tudo do postgres; só as portas certas ficam abertas.
do $acl$
declare r record;
begin
  for r in select unnest(array[
    'private.teacher_rate_without_turbo(uuid)',
    'private.turbo_lessons(text,text)',
    'private.turbo_month_summary(text,text,uuid)',
    'private.payroll_month_rows_with_turbo(text,text)',
    'private.trial_settle_from_meet(uuid,boolean)',
    'public.teacher_turbo_earnings(uuid,text)',
    'public.gestao_payroll_summary(text,text)',
    'public.payroll_month_preview(text)',
    'public.trial_meet_backend(text,jsonb)',
    'public.trial_meet_link_notices(integer)',
    'public.list_pending_trial_sessions_unchecked()'
  ]) as sig loop
    execute format('alter function %s owner to postgres', r.sig);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $acl$;
grant execute on function public.teacher_turbo_earnings(uuid,text) to authenticated, service_role;
grant execute on function public.payroll_month_preview(text) to authenticated;
grant execute on function public.gestao_payroll_summary(text,text) to service_role;
grant execute on function public.trial_meet_backend(text,jsonb) to service_role;
grant execute on function public.trial_meet_link_notices(integer) to service_role;
-- list_pending_trial_sessions_unchecked é chamada pela fachada checada (dona
-- postgres); nenhum cliente a chama direto.

-- Wise Wolf liga a conferência pelo Meet (decisão da direção em 31/10/2026).
insert into private.trial_meet_settings (tenant_id, enabled, min_minutes, reason)
select 'school-wise-wolf', true, 10,
       'Direção autorizou em 31/10/2026: experimental conferida pela sala da escola no Meet (só presença, sem transcrição).'
 where exists (select 1 from public.tenants where id = 'school-wise-wolf')
on conflict (tenant_id) do nothing;
