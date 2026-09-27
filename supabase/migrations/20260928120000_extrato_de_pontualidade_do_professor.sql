-- Extrato de pontualidade do professor (onda 3) — DESLIGADO por escola até o
-- jurídico liberar.
--
-- Decisão da direção: extrato de pontualidade por professor e mês, SEM ranking
-- nem nota, visível ao próprio professor, que não mexe em pagamento. O termo v3
-- do professor (20260927100000) promete exatamente isto: "Quando a escola ligar
-- este recurso, você verá um extrato com o horário em que entrou na sala em cada
-- aula. É para você acompanhar: sem nota, sem ranking e sem comparação com
-- outros professores. O extrato não altera o seu pagamento."
--
-- O que existe:
--   1. public.teacher_lesson_presence — só NÚMEROS do professor por aula: data,
--      início previsto, minutos previstos, primeira entrada, minutos na sala,
--      minutos de atraso, minutos de saída antecipada e o status da medição
--      (FOUND, NOT_FOUND, UNPARSED, NO_CONFERENCE, NO_ROOM). Nada de CSV, nome,
--      e-mail ou minutos do aluno. RLS ligada, sem policy e sem grant a
--      ninguém: a tabela não é exposta; a leitura é só pelas duas RPCs abaixo.
--   2. Alimentada pela avaliação de presença (google_meet_attendance_backend →
--      attendance_evaluate, remendo por âncora), inclusive quando o relatório
--      não é achado, a planilha não é lida ou a sala nem abriu — casos que hoje
--      não deixam rastro nenhum —, e por uma varredura de hora em hora
--      (private.teacher_lesson_presence_sweep) para a aula sem sala da escola
--      (NO_ROOM) e a sala cuja importação terminou sem avaliação (NOT_FOUND).
--      Os números do professor são recalculados das linhas da planilha guardada
--      com a conta de quem DÁ a aula hoje (session_state.attendance_identity,
--      20260928110000): troca que chega depois da aula não deixa o atraso do
--      titular na conta do substituto (nem o contrário).
--   3. Retenção: o termo v3 promete 90 dias para o relatório de presença e não
--      fala do extrato. O extrato vem do relatório e vive o mesmo prazo — 90 dias
--      depois da aula (private.teacher_punctuality_retention_days, amarrado a
--      raw_copies_days da política de retenção). Purga diária
--      (private.purge_teacher_lesson_presence).
--   4. DESLIGADO por configuração da escola (private.teacher_punctuality_settings,
--      sem linha = desligado). Desligado: nada é calculado nem gravado, as RPCs
--      devolvem só {enabled: false} e a tela da direção mostra que o extrato
--      existe e depende de liberação. Ligar é ato consciente, fora de qualquer
--      API: private.set_teacher_punctuality_enabled(escola, true, motivo), rodado
--      na VPS por quem publica, com a referência do parecer do jurídico no
--      motivo (trilha em private.teacher_punctuality_setting_events). O extrato
--      começa nas aulas que começam DEPOIS de ligar; desligar apaga o extrato da
--      escola.
--   5. Nada disto toca class_logs, folha, fechamento, confirmação de presença,
--      turbo ou pagamento. Os casos da Central de Qualidade (LATE_START etc.)
--      continuam como estavam — a tela só passa a dizer "Atraso detectado pelo
--      Meet" no caso automático, diferente do relato da família.
--
-- Falta do PROFESSOR lançada não entra: a aula não foi dele (e a falta tem
-- fluxo próprio). Sessão arquivada (SUPERSEDED) sai do extrato.
--
-- Re-executável: if not exists, create or replace, remendo idempotente (erro se
-- a âncora sumir), cron desagendado e agendado de novo.

-- 1. Configuração por escola (padrão: desligado) ---------------------------------
create table if not exists private.teacher_punctuality_settings (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  -- O extrato considera só as aulas que começam depois disto.
  enabled_at timestamptz,
  reason text not null,
  changed_by text not null,
  changed_at timestamptz not null default now(),
  constraint teacher_punctuality_settings_enabled_at_check
    check ((enabled and enabled_at is not null) or (not enabled and enabled_at is null)),
  constraint teacher_punctuality_settings_reason_check
    check (char_length(btrim(reason)) between 10 and 500)
);
alter table private.teacher_punctuality_settings owner to postgres;
revoke all on table private.teacher_punctuality_settings from public, anon, authenticated, service_role;

create table if not exists private.teacher_punctuality_setting_events (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  enabled boolean not null,
  reason text not null,
  changed_by text not null,
  rows_deleted integer not null default 0,
  created_at timestamptz not null default now()
);
alter table private.teacher_punctuality_setting_events owner to postgres;
revoke all on table private.teacher_punctuality_setting_events from public, anon, authenticated, service_role;
create index if not exists teacher_punctuality_setting_events_tenant_idx
  on private.teacher_punctuality_setting_events (tenant_id, created_at desc);

-- 2. O extrato: só números do professor ----------------------------------------
create table if not exists public.teacher_lesson_presence (
  lesson_session_id uuid primary key references public.lesson_sessions(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  class_date date not null,
  scheduled_start_at timestamptz not null,
  scheduled_minutes integer not null,
  -- Só com status FOUND. first_join_at nulo em FOUND = o professor não aparece
  -- na planilha. Entrada depois do fim previsto (aula remarcada no dia) não é
  -- atraso: late_minutes fica nulo.
  first_join_at timestamptz,
  minutes_in_room integer,
  late_minutes integer,
  left_early_minutes integer,
  status text not null,
  measured_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint teacher_lesson_presence_status_check
    check (status in ('FOUND', 'NOT_FOUND', 'UNPARSED', 'NO_CONFERENCE', 'NO_ROOM')),
  constraint teacher_lesson_presence_numbers_check
    check (scheduled_minutes > 0
      and coalesce(minutes_in_room, 0) >= 0
      and coalesce(late_minutes, 0) >= 0
      and coalesce(left_early_minutes, 0) >= 0),
  constraint teacher_lesson_presence_measured_check
    check (status = 'FOUND' or (first_join_at is null and minutes_in_room is null
      and late_minutes is null and left_early_minutes is null))
);
create index if not exists teacher_lesson_presence_teacher_month_idx
  on public.teacher_lesson_presence (tenant_id, teacher_id, class_date);
create index if not exists teacher_lesson_presence_expires_idx
  on public.teacher_lesson_presence (expires_at);
comment on table public.teacher_lesson_presence is
  'Extrato de pontualidade do professor (20260928120000): só números do professor por aula, sem CSV e sem dado de aluno. '
  'Sem policy nem grant: leitura só por get_my_punctuality_extract / get_teacher_punctuality_extract, com o extrato ligado '
  'para a escola (private.teacher_punctuality_settings). 90 dias depois da aula. Não altera pagamento.';
alter table public.teacher_lesson_presence owner to postgres;
alter table public.teacher_lesson_presence enable row level security;
revoke all on table public.teacher_lesson_presence from public, anon, authenticated, service_role;

-- 3. Funções ---------------------------------------------------------------------

-- Ligado desde quando (nulo = desligado).
create or replace function private.teacher_punctuality_enabled_since(p_tenant text)
returns timestamptz
language sql stable security definer set search_path = '' as $$
  select setting.enabled_at
  from private.teacher_punctuality_settings as setting
  where setting.tenant_id = p_tenant and setting.enabled;
$$;

-- O extrato vive o prazo do relatório de presença de onde vem (termo v3: 90 dias).
create or replace function private.teacher_punctuality_retention_days()
returns integer
language sql stable security definer set search_path = '' as $$
  select least(90, greatest(1, (private.lesson_memory_retention_policy() ->> 'raw_copies_days')::integer));
$$;

-- Horário de uma linha da planilha guardada (ISO do attendance.ts); lixo vira nulo.
create or replace function private.teacher_presence_timestamp(p_value text)
returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' then
    return null;
  end if;
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

-- Grava (ou refaz) a linha do extrato de UMA aula. p_conference_count vem da
-- avaliação (conferências da sala no dia); nulo = varredura, sem avaliação agora.
-- Devolve o status gravado, ou DISABLED / SKIPPED / WAITING quando não grava.
create or replace function private.teacher_lesson_presence_record(
  p_session uuid,
  p_conference_count integer default null,
  p_conference_open boolean default false
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions;
  v_since timestamptz;
  v_presence text;
  v_report private.meeting_attendance_reports;
  v_existing text;
  v_status text;
  v_emails text[];
  v_first timestamptz;
  v_last timestamptz;
  v_seconds numeric;
  v_minutes integer;
  v_late integer;
  v_left_early integer;
  v_room_usable boolean;
begin
  select * into v_session from public.lesson_sessions where id = p_session;
  if not found then
    return null;
  end if;

  -- Desligado para a escola (ou aula de antes de ligar): nada é calculado.
  v_since := private.teacher_punctuality_enabled_since(v_session.tenant_id);
  if v_since is null or v_session.scheduled_start_at < v_since then
    return 'DISABLED';
  end if;

  -- Aula arquivada ou falta do professor lançada: não é aula dele no extrato.
  v_presence := private.lesson_session_logged_presence(v_session.id);
  if v_session.status = 'SUPERSEDED' or v_presence = 'TEACHER_ABSENCE' then
    delete from public.teacher_lesson_presence where lesson_session_id = v_session.id;
    return 'SKIPPED';
  end if;

  -- Antes do fim previsto, ou com a conferência ainda aberta, não há o que medir.
  if pg_catalog.now() < v_session.scheduled_end_at or coalesce(p_conference_open, false) then
    return 'WAITING';
  end if;

  select report.* into v_report
  from private.meeting_attendance_reports as report
  where report.lesson_session_id = v_session.id
    and report.tenant_id = v_session.tenant_id
    and report.parse_error is null
  order by report.imported_at desc
  limit 1;

  if v_report.id is not null then
    v_status := 'FOUND';
  elsif exists (
    select 1 from private.meeting_attendance_reports as report
    where report.lesson_session_id = v_session.id
      and report.tenant_id = v_session.tenant_id
      and report.parse_error is not null
  ) then
    v_status := 'UNPARSED';
  elsif p_conference_count = 0 then
    v_status := 'NO_CONFERENCE';
  elsif p_conference_count > 0 then
    v_status := 'NOT_FOUND';
  else
    -- Varredura: vale o que a última avaliação disse; senão, a sala existia?
    select presence.status into v_existing
    from public.teacher_lesson_presence as presence
    where presence.lesson_session_id = v_session.id;
    if v_existing in ('NOT_FOUND', 'NO_CONFERENCE') then
      v_status := v_existing;
    else
      v_room_usable := v_session.documentation_consent
        and not private.lesson_session_documentation_blocked(v_session.id)
        and exists (
          select 1 from private.google_meet_rooms as room
          where room.lesson_session_id = v_session.id
            and room.tenant_id = v_session.tenant_id
            and room.state = 'READY'
            and room.meeting_uri is not null
        );
      v_status := case when v_room_usable then 'NOT_FOUND' else 'NO_ROOM' end;
    end if;
  end if;

  if v_status = 'FOUND' then
    -- Quem é o professor da aula HOJE (conta confirmada de quem dá a aula e a
    -- coanfitriã quando é dele). Planilha guardada antes de uma troca tem os
    -- papéis da hora; o e-mail de cada linha decide de novo.
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(email.value)), '{}')
      into v_emails
    from pg_catalog.jsonb_array_elements_text(
      coalesce(private.lesson_session_attendance_identity(v_session.id) -> 'teacher_emails', '[]'::jsonb)
    ) as email(value);

    if pg_catalog.cardinality(v_emails) > 0 then
      select pg_catalog.min(private.teacher_presence_timestamp(row_data ->> 'joinedAt')),
             pg_catalog.max(private.teacher_presence_timestamp(row_data ->> 'leftAt')),
             coalesce(pg_catalog.sum(case
               when pg_catalog.jsonb_typeof(row_data -> 'durationSeconds') = 'number'
                 then greatest((row_data ->> 'durationSeconds')::numeric, 0)
               else 0 end), 0)
        into v_first, v_last, v_seconds
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(v_report.participants) = 'array'
          then v_report.participants else '[]'::jsonb end
      ) as participant(row_data)
      where pg_catalog.lower(participant.row_data ->> 'email') = any (v_emails);
    else
      -- Sem conta confirmada hoje: os números que a importação gravou.
      v_first := v_report.teacher_first_join_at;
      v_last := null;
      v_seconds := coalesce(v_report.teacher_seconds, 0);
    end if;

    v_minutes := pg_catalog.round(coalesce(v_seconds, 0) / 60.0)::integer;
    if v_first is null or v_first >= v_session.scheduled_end_at then
      -- Não aparece na planilha, ou entrou depois do fim previsto (aula
      -- remarcada no dia): nem pontual nem atraso.
      v_late := null;
      v_left_early := null;
    else
      v_late := greatest(0, pg_catalog.floor(
        extract(epoch from (v_first - v_session.scheduled_start_at)) / 60))::integer;
      v_left_early := case when v_last is null then null
        else greatest(0, pg_catalog.floor(
          extract(epoch from (v_session.scheduled_end_at - v_last)) / 60))::integer end;
    end if;
  end if;

  insert into public.teacher_lesson_presence as presence (
    lesson_session_id, tenant_id, teacher_id, class_date, scheduled_start_at, scheduled_minutes,
    first_join_at, minutes_in_room, late_minutes, left_early_minutes, status, measured_at, expires_at
  )
  values (
    v_session.id, v_session.tenant_id, v_session.teacher_id, v_session.class_date,
    v_session.scheduled_start_at,
    greatest(1, pg_catalog.round(
      extract(epoch from (v_session.scheduled_end_at - v_session.scheduled_start_at)) / 60)::integer),
    case when v_status = 'FOUND' then v_first end,
    case when v_status = 'FOUND' then v_minutes end,
    case when v_status = 'FOUND' then v_late end,
    case when v_status = 'FOUND' then v_left_early end,
    v_status,
    pg_catalog.now(),
    v_session.scheduled_end_at + pg_catalog.make_interval(days => private.teacher_punctuality_retention_days())
  )
  on conflict (lesson_session_id) do update
  set tenant_id = excluded.tenant_id,
      teacher_id = excluded.teacher_id,
      class_date = excluded.class_date,
      scheduled_start_at = excluded.scheduled_start_at,
      scheduled_minutes = excluded.scheduled_minutes,
      first_join_at = excluded.first_join_at,
      minutes_in_room = excluded.minutes_in_room,
      late_minutes = excluded.late_minutes,
      left_early_minutes = excluded.left_early_minutes,
      status = excluded.status,
      measured_at = excluded.measured_at,
      expires_at = excluded.expires_at;

  return v_status;
end;
$$;

-- Porta da avaliação de presença (google_meet_attendance_backend): nunca derruba
-- a avaliação nem a importação da sala.
create or replace function private.teacher_lesson_presence_from_evaluation(p_session uuid, p_payload jsonb)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_count text := nullif(p_payload ->> 'conference_count', '');
begin
  return private.teacher_lesson_presence_record(
    p_session,
    case when v_count ~ '^\d{1,6}$' then v_count::integer end,
    coalesce(p_payload -> 'conference_open' = 'true'::jsonb, false));
exception when others then
  raise warning '[extrato de pontualidade] sessão %: % (%)', p_session, sqlerrm, sqlstate;
  return 'ERROR';
end;
$$;

-- Varredura (de hora em hora): aula sem sala da escola (NO_ROOM), sala cuja
-- importação terminou sem avaliação (NOT_FOUND), aula que mudou de professor
-- depois de medida (refaz com a conta de quem a dá) e o que saiu do extrato
-- (arquivada, falta do professor, escola desligada).
create or replace function private.teacher_lesson_presence_sweep(p_limit integer default 500)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_candidate record;
  v_status text;
  v_recorded integer := 0;
  v_removed integer := 0;
  v_failed integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher-punctuality-sweep', 0));

  with gone as (
    delete from public.teacher_lesson_presence as presence
    using public.lesson_sessions as session
    where session.id = presence.lesson_session_id
      and (session.status = 'SUPERSEDED'
        or private.teacher_punctuality_enabled_since(presence.tenant_id) is null
        or private.lesson_session_logged_presence(session.id) = 'TEACHER_ABSENCE')
    returning 1
  )
  select pg_catalog.count(*)::integer into v_removed from gone;

  for v_candidate in
    select session.id
    from private.teacher_punctuality_settings as setting
    join public.lesson_sessions as session on session.tenant_id = setting.tenant_id
    left join public.teacher_lesson_presence as presence on presence.lesson_session_id = session.id
    left join private.google_meet_rooms as room
      on room.lesson_session_id = session.id and room.tenant_id = session.tenant_id
    where setting.enabled
      and session.status <> 'SUPERSEDED'
      and session.scheduled_start_at >= setting.enabled_at
      and session.scheduled_end_at < pg_catalog.now() - interval '2 hours'
      and session.scheduled_end_at > pg_catalog.now()
        - pg_catalog.make_interval(days => private.teacher_punctuality_retention_days())
      and coalesce(private.lesson_session_logged_presence(session.id), '') <> 'TEACHER_ABSENCE'
      and (
        -- Medida com outro professor (troca depois da medição): refaz.
        (presence.lesson_session_id is not null and presence.teacher_id is distinct from session.teacher_id)
        or (presence.lesson_session_id is null and (
          -- Sem sala da escola utilizável: a aula foi pelo link de sempre.
          room.lesson_session_id is null
          or room.state is distinct from 'READY'
          or room.meeting_uri is null
          or not session.documentation_consent
          -- Sala da escola: a avaliação da importação grava antes; aqui só quando
          -- a importação terminou (ou passou da janela de 7 dias) sem avaliação.
          or room.sync_status in ('COMPLETE', 'EXPIRED')
          or session.scheduled_end_at < pg_catalog.now() - interval '8 days'
          or private.lesson_session_documentation_blocked(session.id)))
      )
    order by session.scheduled_end_at
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
  loop
    begin
      v_status := private.teacher_lesson_presence_record(v_candidate.id, null, false);
      if v_status in ('FOUND', 'NOT_FOUND', 'UNPARSED', 'NO_CONFERENCE', 'NO_ROOM') then
        v_recorded := v_recorded + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      raise warning '[extrato de pontualidade] varredura, sessão %: % (%)', v_candidate.id, sqlerrm, sqlstate;
    end;
  end loop;

  return pg_catalog.jsonb_build_object('recorded', v_recorded, 'removed', v_removed, 'failed', v_failed);
end;
$$;

-- Purga diária: 90 dias depois da aula (o prazo do relatório de presença).
create or replace function private.purge_teacher_lesson_presence()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from public.teacher_lesson_presence where expires_at < pg_catalog.now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Ligar/desligar: fora de qualquer API (sem grant a ninguém; roda na VPS por
-- quem publica, com a referência do parecer do jurídico no motivo). Desligar
-- apaga o extrato da escola; religar começa do zero.
create or replace function private.set_teacher_punctuality_enabled(p_tenant text, p_enabled boolean, p_reason text)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_deleted integer := 0;
  v_enabled_at timestamptz;
begin
  if p_tenant is null or not exists (select 1 from public.tenants as tenant where tenant.id = p_tenant) then
    raise exception 'escola_nao_encontrada' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'decisao_obrigatoria' using errcode = '22023';
  end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'motivo_obrigatorio' using errcode = '22023';
  end if;

  if p_enabled then
    insert into private.teacher_punctuality_settings as setting
      (tenant_id, enabled, enabled_at, reason, changed_by, changed_at)
    values (p_tenant, true, pg_catalog.now(), v_reason, session_user, pg_catalog.now())
    on conflict (tenant_id) do update
    set enabled = true,
        -- Ligar de novo o que já está ligado não apaga o começo do extrato.
        enabled_at = case when setting.enabled then setting.enabled_at else excluded.enabled_at end,
        reason = excluded.reason,
        changed_by = excluded.changed_by,
        changed_at = excluded.changed_at
    returning setting.enabled_at into v_enabled_at;
  else
    insert into private.teacher_punctuality_settings as setting
      (tenant_id, enabled, enabled_at, reason, changed_by, changed_at)
    values (p_tenant, false, null, v_reason, session_user, pg_catalog.now())
    on conflict (tenant_id) do update
    set enabled = false,
        enabled_at = null,
        reason = excluded.reason,
        changed_by = excluded.changed_by,
        changed_at = excluded.changed_at;
    delete from public.teacher_lesson_presence where tenant_id = p_tenant;
    get diagnostics v_deleted = row_count;
  end if;

  insert into private.teacher_punctuality_setting_events (tenant_id, enabled, reason, changed_by, rows_deleted)
  values (p_tenant, p_enabled, v_reason, session_user, v_deleted);

  return pg_catalog.jsonb_build_object('tenant_id', p_tenant, 'enabled', p_enabled,
    'enabled_at', v_enabled_at, 'rows_deleted', v_deleted);
end;
$$;

-- Extrato de um professor num mês: resumo (sem nota, sem média, sem posição) e
-- as aulas, só com números do professor.
create or replace function private.teacher_punctuality_extract(p_tenant text, p_teacher uuid, p_month date)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with bounds as (
    select pg_catalog.date_trunc('month', p_month::timestamp)::date as first_day,
           (pg_catalog.date_trunc('month', p_month::timestamp) + interval '1 month - 1 day')::date as last_day
  ), lessons as (
    select presence.*
    from public.teacher_lesson_presence as presence, bounds
    where presence.tenant_id = p_tenant
      and presence.teacher_id = p_teacher
      and presence.class_date between bounds.first_day and bounds.last_day
      and presence.expires_at > pg_catalog.now()
  )
  select pg_catalog.jsonb_build_object(
    'month', pg_catalog.to_char(bounds.first_day, 'YYYY-MM'),
    'summary', (
      select pg_catalog.jsonb_build_object(
        'planned', pg_catalog.count(*),
        'in_school_room', pg_catalog.count(*) filter (where lessons.status <> 'NO_ROOM'),
        'measured', pg_catalog.count(*) filter (where lessons.status = 'FOUND'),
        'on_time', pg_catalog.count(*) filter (where lessons.status = 'FOUND' and lessons.late_minutes < 5),
        'late_5', pg_catalog.count(*) filter (where lessons.status = 'FOUND' and lessons.late_minutes >= 5),
        'late_10', pg_catalog.count(*) filter (where lessons.status = 'FOUND' and lessons.late_minutes >= 10),
        'not_in_report', pg_catalog.count(*) filter (where lessons.status = 'FOUND' and lessons.first_join_at is null),
        'joined_after_end', pg_catalog.count(*) filter (
          where lessons.status = 'FOUND' and lessons.first_join_at is not null and lessons.late_minutes is null),
        'minutes_in_room', coalesce(pg_catalog.sum(lessons.minutes_in_room) filter (where lessons.status = 'FOUND'), 0),
        'scheduled_minutes', coalesce(pg_catalog.sum(lessons.scheduled_minutes) filter (where lessons.status = 'FOUND'), 0),
        'left_early', pg_catalog.count(*) filter (where lessons.status = 'FOUND' and lessons.left_early_minutes >= 5),
        'not_measured', pg_catalog.jsonb_build_object(
          'NOT_FOUND', pg_catalog.count(*) filter (where lessons.status = 'NOT_FOUND'),
          'UNPARSED', pg_catalog.count(*) filter (where lessons.status = 'UNPARSED'),
          'NO_CONFERENCE', pg_catalog.count(*) filter (where lessons.status = 'NO_CONFERENCE'),
          'NO_ROOM', pg_catalog.count(*) filter (where lessons.status = 'NO_ROOM')))
      from lessons),
    'lessons', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'class_date', lessons.class_date,
        'scheduled_start_at', lessons.scheduled_start_at,
        'scheduled_minutes', lessons.scheduled_minutes,
        'first_join_at', lessons.first_join_at,
        'late_minutes', lessons.late_minutes,
        'minutes_in_room', lessons.minutes_in_room,
        'left_early_minutes', lessons.left_early_minutes,
        'status', lessons.status) order by lessons.scheduled_start_at)
      from lessons), '[]'::jsonb))
  from bounds;
$$;

-- Professor: o próprio extrato, e só com o extrato ligado para a escola.
create or replace function public.get_my_punctuality_extract(p_month date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_tenant text := public._my_tenant_id();
begin
  select * into v_me from public.profiles where id = auth.uid();
  if not found or v_me.role <> 'TEACHER' or v_tenant is null or v_me.tenant_id is distinct from v_tenant
    or pg_catalog.lower(coalesce(v_me.lifecycle_status, 'active')) <> 'active' then
    raise exception 'somente_o_professor' using errcode = '42501';
  end if;
  if private.teacher_punctuality_enabled_since(v_tenant) is null then
    return pg_catalog.jsonb_build_object('ok', true, 'enabled', false);
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'enabled', true)
    || private.teacher_punctuality_extract(v_tenant, v_me.id,
      coalesce(p_month, (pg_catalog.now() at time zone 'America/Sao_Paulo')::date));
end;
$$;

-- Direção e coordenação da escola: um professor por vez, escolhido numa lista
-- em ordem alfabética (sem contagem ao lado — nada de comparação).
create or replace function public.get_teacher_punctuality_extract(p_teacher_id uuid default null, p_month date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_month date := coalesce(p_month, (pg_catalog.now() at time zone 'America/Sao_Paulo')::date);
  v_since timestamptz;
  v_teachers jsonb;
begin
  if v_tenant is null or not private.can_manage_lesson_quality(v_tenant)
    or coalesce(public._my_role(), '') not in ('SCHOOL_ADMIN', 'COORDINATOR') then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  v_since := private.teacher_punctuality_enabled_since(v_tenant);
  if v_since is null then
    return pg_catalog.jsonb_build_object('ok', true, 'enabled', false);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', teacher.id, 'name', teacher.full_name)
      order by pg_catalog.lower(coalesce(teacher.full_name, '')), teacher.id), '[]'::jsonb)
    into v_teachers
  from public.profiles as teacher
  where teacher.tenant_id = v_tenant
    and teacher.role = 'TEACHER'
    and (pg_catalog.lower(coalesce(teacher.lifecycle_status, 'active')) = 'active'
      or exists (select 1 from public.teacher_lesson_presence as presence
                 where presence.tenant_id = v_tenant and presence.teacher_id = teacher.id));

  if p_teacher_id is not null and not exists (
    select 1 from public.profiles as teacher
    where teacher.id = p_teacher_id and teacher.tenant_id = v_tenant and teacher.role = 'TEACHER'
  ) then
    raise exception 'professor_nao_encontrado' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'enabled', true, 'enabled_at', v_since,
    'teachers', v_teachers, 'teacher_id', p_teacher_id,
    'extract', case when p_teacher_id is null then null
      else private.teacher_punctuality_extract(v_tenant, p_teacher_id, v_month) end);
end;
$$;

-- 4. Remendo por âncora: a avaliação de presença alimenta o extrato ---------------
do $patch_attendance$
declare
  v_def text;
  v_anchor constant text := E'elsif p_action = ''attendance_evaluate'' then';
begin
  v_def := pg_catalog.pg_get_functiondef('public.google_meet_attendance_backend(text,text,uuid,jsonb)'::regprocedure);
  if strpos(v_def, 'teacher_lesson_presence_from_evaluation') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'âncora da avaliação de presença ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor, v_anchor
    || E'\n    -- Extrato de pontualidade (20260928120000): números do professor, desligado\n'
    || E'    -- por escola até o jurídico liberar. Nunca derruba a avaliação.\n'
    || E'    perform private.teacher_lesson_presence_from_evaluation(v_session.id, p_payload);');
end
$patch_attendance$;

-- 5. Dono e permissões -------------------------------------------------------------
do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.teacher_punctuality_enabled_since(text)',
    'private.teacher_punctuality_retention_days()',
    'private.teacher_presence_timestamp(text)',
    'private.teacher_lesson_presence_record(uuid,integer,boolean)',
    'private.teacher_lesson_presence_from_evaluation(uuid,jsonb)',
    'private.teacher_lesson_presence_sweep(integer)',
    'private.purge_teacher_lesson_presence()',
    'private.set_teacher_punctuality_enabled(text,boolean,text)',
    'private.teacher_punctuality_extract(text,uuid,date)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  foreach v_signature in array array[
    'public.get_my_punctuality_extract(date)',
    'public.get_teacher_punctuality_extract(uuid,date)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
  -- A porta da edge continua só do service_role (presenca_pelo_relatorio_do_meet.sql).
  alter function public.google_meet_attendance_backend(text,text,uuid,jsonb) owner to postgres;
  revoke all on function public.google_meet_attendance_backend(text,text,uuid,jsonb) from public, anon, authenticated;
  grant execute on function public.google_meet_attendance_backend(text,text,uuid,jsonb) to service_role;
end
$grants$;

-- 6. Varredura de hora em hora e purga diária --------------------------------------
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job
    where jobname in ('wisewolf-teacher-punctuality-sweep', 'wisewolf-teacher-punctuality-purge');
    perform cron.schedule('wisewolf-teacher-punctuality-sweep', '37 * * * *',
      'select private.teacher_lesson_presence_sweep();');
    perform cron.schedule('wisewolf-teacher-punctuality-purge', '47 6 * * *',
      'select private.purge_teacher_lesson_presence();');
  end if;
end
$cron$;
