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
--      (FOUND, NOT_FOUND, UNPARSED, NO_CONFERENCE, NO_ROOM, TEACHER_NOT_READY).
--      Nada de CSV, nome,
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
-- O extrato nunca põe numa pessoa a aula ou os números de outra (revisão da
-- onda 3):
--   * Aula que NÃO é do professor da sessão fica fora (e sai, se já estava):
--     outro professor a dá pela régua única (lesson_session_taught_by_other —
--     dono ambíguo, cobertura de quem não é professor, troca ainda não feita),
--     outro professor LANÇOU uma ocorrência viva dela (a prova de quem deu, que
--     vale mesmo depois que a régua "segura para o passado" volta ao dono
--     antigo do agendamento), ou o agendamento/reposição hoje é de outro
--     professor e o da sessão não lançou a aula (agendamento transferido que a
--     escola não replanejou: sem prova de quem deu, a aula não entra em extrato
--     nenhum). private.teacher_lesson_presence_given_by_other.
--   * Professor sem conta Google confirmada, ou que recebeu a aula sem o aceite
--     do termo (lesson_session_handover_unconsented): o relatório não o
--     identifica, e os números gravados na importação eram de OUTRA conta (a do
--     titular). Status próprio TEACHER_NOT_READY, sem número nenhum. A
--     varredura refaz a linha quando a conta dele é confirmada depois.
--   * Sala retida pela troca de professor (teacher_handover_pending, 110000) no
--     início da aula: o sistema escondeu a sala de todos — NO_ROOM, e a
--     avaliação de presença não abre caso nenhum (nem OUTSIDE_ROOM contra quem
--     não recebeu o link, nem LATE_START pela entrada depois da liberação).
--     google_meet_rooms.teacher_handover_released_at guarda quando a sala foi
--     entregue; private.google_meet_room_withheld_at_lesson decide.
--   * Integração da onda 3: a avaliação de presença (os casos da Central de
--     Qualidade) segue a mesma régua — aula que não é do professor da sessão ou
--     com a documentação barrada não abre caso, e, depois de uma troca de
--     professor, atraso/professor ausente/aluno ausente saem da planilha com a
--     conta de quem dá a aula NA HORA DA AVALIAÇÃO (private.meet_attendance_numbers),
--     nunca dos números gravados na importação (que eram do titular). A tela "Sala
--     e resumo" mostra os mesmos números; o extrato tira na hora a aula que trocou
--     de professor depois da medição.
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
    check (status in ('FOUND', 'NOT_FOUND', 'UNPARSED', 'NO_CONFERENCE', 'NO_ROOM', 'TEACHER_NOT_READY')),
  constraint teacher_lesson_presence_numbers_check
    check (scheduled_minutes > 0
      and coalesce(minutes_in_room, 0) >= 0
      and coalesce(late_minutes, 0) >= 0
      and coalesce(left_early_minutes, 0) >= 0),
  constraint teacher_lesson_presence_measured_check
    check (status = 'FOUND' or (first_join_at is null and minutes_in_room is null
      and late_minutes is null and left_early_minutes is null))
);
-- TEACHER_NOT_READY: o relatório não identifica o professor da aula (sem conta
-- Google confirmada, ou recebeu a aula sem o aceite do termo). Refeita a cada
-- execução para valer também onde a tabela já existia.
alter table public.teacher_lesson_presence drop constraint if exists teacher_lesson_presence_status_check;
alter table public.teacher_lesson_presence add constraint teacher_lesson_presence_status_check
  check (status in ('FOUND', 'NOT_FOUND', 'UNPARSED', 'NO_CONFERENCE', 'NO_ROOM', 'TEACHER_NOT_READY'));
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

-- Quando a sala retida pela troca de professor (20260928110000) foi entregue:
-- gravado pelo gatilho que solta a retenção (remendo abaixo). Sala entregue
-- depois do início da aula não mede atraso de ninguém. A tabela é do
-- supabase_admin; quem escreve a coluna é o gatilho BEFORE (campo mudado por
-- gatilho não passa por checagem de privilégio de coluna).
alter table private.google_meet_rooms add column if not exists teacher_handover_released_at timestamptz;
comment on column private.google_meet_rooms.teacher_handover_released_at is
  'Quando a sala retida pela troca de professor foi entregue (a conta de quem dá a aula virou a coanfitriã). Depois do início da aula = sala indisponível no início: o extrato de pontualidade grava NO_ROOM e a avaliação de presença não abre caso (20260928120000).';

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

-- A sala da escola estava retida pela troca de professor no início da aula: a
-- sala ainda retida (a aula já terminou e a conta de quem a deu nunca virou a
-- coanfitriã), ou entregue só depois do início. Liberação sem hora gravada (sala
-- solta antes desta migration) conta como retida: na dúvida, o sistema não
-- culpa ninguém pela sala que ele mesmo escondeu.
create or replace function private.google_meet_room_withheld_at_lesson(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select room.teacher_handover_pending
      or (exists (
            select 1 from private.lesson_session_teacher_handovers as handover
            where handover.session_id = session.id
              and handover.room_withheld
              and handover.created_at < session.scheduled_end_at)
          and (room.teacher_handover_released_at is null
            or room.teacher_handover_released_at > session.scheduled_start_at))
    from public.lesson_sessions as session
    join private.google_meet_rooms as room
      on room.lesson_session_id = session.id and room.tenant_id = session.tenant_id
    where session.id = p_session
  ), false);
$$;

-- A aula NÃO é do professor da sessão para o extrato (não grava; apaga o que
-- houver). Três provas, qualquer uma basta:
--   1. a régua única diz que outro professor a dá, ou que não há dono claro
--      (cobertura de quem não é professor, troca que ainda não rodou);
--   2. outro professor lançou uma ocorrência viva da sessão como dada ou como
--      falta do aluno — vale depois que a régua "segura para o passado" volta ao
--      dono antigo de um agendamento transferido;
--   3. o agendamento (ou a reposição, ou a experimental) hoje é de outro
--      professor, sem cobertura/antecipação que devolva a aula ao da sessão, e o
--      professor da sessão não lançou a aula: agendamento transferido que a
--      escola não replanejou. Sem prova de quem deu, a aula não entra em
--      extrato nenhum (a do professor que a lançar volta pela varredura).
create or replace function private.teacher_lesson_presence_given_by_other(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.lesson_session_taught_by_other(session.id)
      or exists (
        select 1
        from public.lesson_occurrences as occurrence
        join public.class_logs as log
          on log.tenant_id = occurrence.tenant_id
         and log.teacher_id is distinct from session.teacher_id
         and log.presence in ('COMPLETED', 'STUDENT_ABSENCE')
         and (log.id = occurrence.class_log_id
           or (log.class_date = occurrence.class_date and (
                (occurrence.source_type = 'booking' and log.booking_id = occurrence.source_id)
             or (occurrence.source_type = 'reschedule' and log.reschedule_id = occurrence.source_id)
             or (occurrence.source_type = 'appointment' and log.appointment_id = occurrence.source_id))))
        where occurrence.session_id = session.id
          and occurrence.tenant_id = session.tenant_id
          and occurrence.status <> 'SUPERSEDED')
      or (exists (
            select 1
            from public.lesson_occurrences as occurrence
            where occurrence.session_id = session.id
              and occurrence.tenant_id = session.tenant_id
              and occurrence.status <> 'SUPERSEDED'
              and private.lesson_occurrence_giver(
                    occurrence.tenant_id, occurrence.source_type, occurrence.source_id, occurrence.class_date,
                    coalesce(private.lesson_occurrence_scheduled_teacher(
                      occurrence.tenant_id, occurrence.source_type, occurrence.source_id,
                      occurrence.class_date, occurrence.start_time), session.teacher_id))
                  is distinct from session.teacher_id)
          and not exists (
            select 1 from public.class_logs as log
            where log.tenant_id = session.tenant_id
              and log.teacher_id = session.teacher_id
              and (log.lesson_session_id = session.id
                or log.id in (
                  select occurrence.class_log_id from public.lesson_occurrences as occurrence
                  where occurrence.session_id = session.id and occurrence.class_log_id is not null))))
    from public.lesson_sessions as session
    where session.id = p_session
  ), false);
$$;

-- Números e papéis da planilha guardada com a conta de quem DÁ a aula HOJE
-- (integração da onda 3). A importação grava teacher_*/student_* e o papel de
-- cada linha com a conta de quem era o professor NAQUELA hora (a edge soma as
-- linhas por papel — attendance.ts, summarizeAttendance). Sem troca de professor
-- na sessão, essa conta é a de hoje: valem os números da importação
-- (source = IMPORT). Depois de uma troca (cobertura atestada depois da aula,
-- 20260928110000) eles são do titular — e o substituto aparece como "aluno": cada
-- linha é classificada de novo pelo e-mail (source = REPORT_ROWS): professor =
-- teacher_emails de session_state.attendance_identity; quem passou a aula adiante
-- (ou linha que a importação marcou como professor e hoje não é) não conta como
-- professor nem como aluno; a conta da escola segue ORGANIZER; o resto é o aluno.
-- Troca de professor e planilha guardada sem as linhas: não há como saber quem é
-- quem — números nulos e source = UNKNOWN_AFTER_HANDOVER.
create or replace function private.meet_attendance_numbers(p_session uuid, p_report uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_report private.meeting_attendance_reports;
  v_identity jsonb;
  v_teacher text[];
  v_other text[];
  v_result jsonb;
begin
  select report.* into v_report
  from private.meeting_attendance_reports as report
  where report.id = p_report and report.lesson_session_id = p_session;
  if not found then
    return null;
  end if;

  if not exists (
    select 1 from private.lesson_session_teacher_handovers as handover where handover.session_id = p_session
  ) then
    return pg_catalog.jsonb_build_object(
      'source', 'IMPORT',
      'teacher_identified', true,
      'teacher_first_join_at', v_report.teacher_first_join_at,
      'teacher_seconds', v_report.teacher_seconds,
      'student_first_join_at', v_report.student_first_join_at,
      'student_seconds', v_report.student_seconds,
      'participants', coalesce(v_report.participants, '[]'::jsonb));
  end if;

  if pg_catalog.jsonb_typeof(v_report.participants) = 'array'
    and pg_catalog.jsonb_array_length(v_report.participants) > 0 then
    v_identity := private.lesson_session_attendance_identity(p_session);
    select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(pg_catalog.btrim(email.value))), '{}')
      into v_teacher
    from pg_catalog.jsonb_array_elements_text(coalesce(v_identity -> 'teacher_emails', '[]'::jsonb)) as email(value)
    where pg_catalog.btrim(email.value) <> '';
    select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(pg_catalog.btrim(email.value))), '{}')
      into v_other
    from pg_catalog.jsonb_array_elements_text(coalesce(v_identity -> 'other_teacher_emails', '[]'::jsonb)) as email(value)
    where pg_catalog.btrim(email.value) <> '';

    with rows as (
      select participant.value as row_data, participant.ordinality,
        case
          when participant.value ->> 'role' = 'ORGANIZER' then 'ORGANIZER'
          when nullif(pg_catalog.lower(pg_catalog.btrim(participant.value ->> 'email')), '') = any (v_teacher)
            then 'TEACHER'
          when nullif(pg_catalog.lower(pg_catalog.btrim(participant.value ->> 'email')), '') = any (v_other)
            then 'OTHER_TEACHER'
          -- Conta que a importação marcou como professor e que hoje não é a de
          -- quem dá a aula: nunca vira minutos do aluno.
          when participant.value ->> 'role' in ('TEACHER', 'OTHER_TEACHER') then 'OTHER_TEACHER'
          else 'STUDENT'
        end as role,
        private.teacher_presence_timestamp(participant.value ->> 'joinedAt') as joined_at,
        case when pg_catalog.jsonb_typeof(participant.value -> 'durationSeconds') = 'number'
          then greatest((participant.value ->> 'durationSeconds')::numeric, 0) else 0 end as seconds
      from pg_catalog.jsonb_array_elements(v_report.participants) with ordinality as participant(value, ordinality)
    )
    select pg_catalog.jsonb_build_object(
      'source', 'REPORT_ROWS',
      'teacher_identified', pg_catalog.cardinality(v_teacher) > 0,
      'teacher_first_join_at', (select pg_catalog.min(rows.joined_at) from rows where rows.role = 'TEACHER'),
      'teacher_seconds', case when pg_catalog.cardinality(v_teacher) > 0 then
        (select pg_catalog.round(coalesce(pg_catalog.sum(rows.seconds), 0))::integer from rows where rows.role = 'TEACHER') end,
      'student_first_join_at', (select pg_catalog.min(rows.joined_at) from rows where rows.role = 'STUDENT'),
      'student_seconds',
        (select pg_catalog.round(coalesce(pg_catalog.sum(rows.seconds), 0))::integer from rows where rows.role = 'STUDENT'),
      'participants', (select pg_catalog.jsonb_agg(rows.row_data || pg_catalog.jsonb_build_object('role', rows.role)
        order by rows.ordinality) from rows))
      into v_result;
    return v_result;
  end if;

  return pg_catalog.jsonb_build_object(
    'source', 'UNKNOWN_AFTER_HANDOVER',
    'teacher_identified', false,
    'teacher_first_join_at', null,
    'teacher_seconds', null,
    'student_first_join_at', null,
    'student_seconds', null,
    'participants', coalesce(v_report.participants, '[]'::jsonb));
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

  -- Aula arquivada, falta do professor lançada ou aula dada por outro professor:
  -- não é aula dele no extrato (e não vira aula de ninguém sem prova).
  v_presence := private.lesson_session_logged_presence(v_session.id);
  if v_session.status = 'SUPERSEDED' or v_presence = 'TEACHER_ABSENCE'
    or private.teacher_lesson_presence_given_by_other(v_session.id) then
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

  if private.google_meet_room_withheld_at_lesson(v_session.id) then
    -- A troca de professor reteve a sala no início da aula: ninguém recebeu o
    -- link a tempo. O que houver na planilha não mede a pontualidade de ninguém.
    v_status := 'NO_ROOM';
  elsif v_report.id is not null then
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

    -- Sem conta que o identifique na planilha, ou com a aula recebida sem o
    -- aceite do termo: não há número dele. Os campos teacher_* da importação
    -- NUNCA entram — eles foram calculados com a conta de quem era o professor
    -- na hora (o titular, numa troca depois da aula).
    if pg_catalog.cardinality(v_emails) = 0
      or private.lesson_session_handover_unconsented(v_session.id) then
      v_status := 'TEACHER_NOT_READY';
    end if;
  end if;

  if v_status = 'FOUND' then
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
-- depois de medida (refaz com a conta de quem a dá), professor que confirmou a
-- conta Google depois da medição (refaz TEACHER_NOT_READY) e o que saiu do
-- extrato (arquivada, falta do professor, aula dada ou lançada por outro
-- professor, escola desligada).
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
        or private.lesson_session_logged_presence(session.id) = 'TEACHER_ABSENCE'
        -- O lançamento de outro professor (ou a troca) chegou depois da medição.
        or private.teacher_lesson_presence_given_by_other(session.id))
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
        -- Sem conta que o identificasse na medição, e a conta foi confirmada
        -- depois: refaz (a planilha guardada tem o e-mail dele).
        or (presence.status = 'TEACHER_NOT_READY' and exists (
          select 1 from private.teacher_google_identities as ident
          where ident.teacher_id = session.teacher_id
            and ident.tenant_id = session.tenant_id
            and greatest(ident.updated_at, ident.verified_at) > presence.measured_at))
        or (presence.lesson_session_id is null and (
          -- Sem sala da escola utilizável: a aula foi pelo link de sempre.
          room.lesson_session_id is null
          or room.state is distinct from 'READY'
          or room.meeting_uri is null
          or not session.documentation_consent
          -- Sala retida pela troca de professor até depois da aula.
          or coalesce(room.teacher_handover_pending, false)
          -- Sala da escola: a avaliação da importação grava antes; aqui só quando
          -- a importação terminou (ou passou da janela de 7 dias) sem avaliação.
          or room.sync_status in ('COMPLETE', 'EXPIRED')
          or session.scheduled_end_at < pg_catalog.now() - interval '8 days'
          or private.lesson_session_documentation_blocked(session.id)))
      )
      -- Aula de outro professor não vira candidata (nem ocupa a vez das outras).
      and not private.teacher_lesson_presence_given_by_other(session.id)
    order by session.scheduled_end_at
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
  loop
    begin
      v_status := private.teacher_lesson_presence_record(v_candidate.id, null, false);
      if v_status in ('FOUND', 'NOT_FOUND', 'UNPARSED', 'NO_CONFERENCE', 'NO_ROOM', 'TEACHER_NOT_READY') then
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
    from public.teacher_lesson_presence as presence
    join public.lesson_sessions as session on session.id = presence.lesson_session_id
    cross join bounds
    where presence.tenant_id = p_tenant
      and presence.teacher_id = p_teacher
      and presence.class_date between bounds.first_day and bounds.last_day
      and presence.expires_at > pg_catalog.now()
      -- Troca de professor depois da medição (cobertura atestada depois da aula,
      -- lançamento de outro professor): a aula sai do extrato de quem NÃO a deu
      -- na hora, sem esperar a varredura de hora em hora — que refaz a linha para
      -- quem deu (integração da onda 3).
      and session.teacher_id = presence.teacher_id
      and session.status <> 'SUPERSEDED'
      and not private.teacher_lesson_presence_given_by_other(session.id)
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
          'NO_ROOM', pg_catalog.count(*) filter (where lessons.status = 'NO_ROOM'),
          'TEACHER_NOT_READY', pg_catalog.count(*) filter (where lessons.status = 'TEACHER_NOT_READY')))
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

-- 4b. Remendo por âncora: o gatilho que solta a sala retida pela troca de
-- professor (20260928110000) grava QUANDO a soltou.
do $patch_release$
declare
  v_def text;
  v_anchor constant text := 'new.teacher_handover_pending := false;';
begin
  v_def := pg_catalog.pg_get_functiondef('private.google_meet_room_release_handover()'::regprocedure);
  if strpos(v_def, 'teacher_handover_released_at') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'âncora da sala retida pela troca ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor, v_anchor
    || E'\n    -- Quando a sala foi entregue (20260928120000): depois do início da aula,\n'
    || E'    -- o extrato de pontualidade e a avaliação de presença não medem ninguém.\n'
    || E'    new.teacher_handover_released_at := pg_catalog.now();');
end
$patch_release$;

-- 4c. Avaliação de presença com a régua de quem DEU a aula (definição inteira,
-- a partir da viva de 20260926170000 — conferida igual à de produção em 27/09).
-- Muda três coisas, todas para não pôr numa pessoa o caso de outra:
--   * sala retida pela troca no início da aula não abre caso (nem OUTSIDE_ROOM
--     contra quem não recebeu o link, nem LATE_START pela entrada depois da
--     entrega, nem os de minutos na sala) — google_meet_room_withheld_at_lesson;
--   * aula que NÃO é do professor da sessão (régua única, lançamento de outro
--     professor, agendamento transferido sem lançamento dele —
--     teacher_lesson_presence_given_by_other) ou com a documentação barrada
--     (lesson_session_documentation_blocked: inclusive a que passou a quem não
--     está pronto) não é avaliada: o caso cairia no professor errado, e a sala
--     não foi entregue;
--   * os números do professor e do aluno vêm de private.meet_attendance_numbers:
--     sem troca de professor na sessão, os da importação (calculados com a conta
--     de quem dá a aula, a mesma de hoje); depois de uma troca, a planilha guardada
--     é reclassificada linha a linha com a conta de quem dá a aula NA HORA DA
--     AVALIAÇÃO — os teacher_*/student_* da importação eram do titular, e o
--     substituto, "aluno". Sem conta que identifique o professor de hoje, as regras
--     do professor (atraso, professor ausente) não disparam; sem as linhas da
--     planilha depois de uma troca, nenhuma regra de minutos dispara;
--   * o caso é de UM professor: a chave de dedupe leva o professor
--     (meet:<sessão>:<regra>:<professor>) — o caso aberto antes de a aula trocar
--     de professor não impede o do professor que a deu — e o caso antigo, de
--     outro professor, ganha uma anotação da troca (MEET_TEACHER_HANDOVER) para a
--     direção conferir; o status dele continua com ela.
create or replace function private.meet_attendance_evaluate(
  p_session uuid,
  p_presence text,
  p_conference_count integer
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions;
  v_report private.meeting_attendance_reports;
  v_numbers jsonb;
  v_teacher_known boolean := false;
  v_student_known boolean := false;
  v_teacher_first_join_at timestamptz;
  v_teacher_seconds integer;
  v_student_first_join_at timestamptz;
  v_student_seconds integer;
  v_opened text[] := '{}';
  v_flag record;
  v_case uuid;
  v_late_minutes integer;
begin
  select * into v_session from public.lesson_sessions where id = p_session;
  if not found or not v_session.documentation_consent then
    return jsonb_build_object('evaluated', false);
  end if;
  -- A aula não é do professor da sessão (ainda sem troca, ou lançada por outro)
  -- ou a documentação dela está barrada: nenhum caso — ele cairia em quem não
  -- deu a aula, ou mediria uma sala que não foi entregue.
  if private.lesson_session_documentation_blocked(v_session.id)
    or private.teacher_lesson_presence_given_by_other(v_session.id) then
    return jsonb_build_object('evaluated', false, 'reason', 'not_this_teacher_or_blocked');
  end if;
  -- Caso que o sistema abriu nesta aula para OUTRO professor (a aula trocou de
  -- professor depois — cobertura atestada): fica com a direção, com a troca
  -- anotada uma vez por professor novo.
  insert into public.lesson_quality_case_events (tenant_id, case_id, actor_id, event_type, details)
  select q.tenant_id, q.id, null, 'MEET_TEACHER_HANDOVER', jsonb_build_object(
      'teacher_id', v_session.teacher_id,
      'case_teacher_id', q.teacher_id,
      'note', 'A aula passou para outro professor depois deste caso (troca de professor). '
        || 'Confira quem deu a aula antes de conversar com o professor do caso.')
  from public.lesson_quality_cases as q
  where q.tenant_id = v_session.tenant_id
    and q.session_id = v_session.id
    and q.source = 'SYSTEM'
    and q.dedupe_key like 'meet:%'
    and q.teacher_id is distinct from v_session.teacher_id
    and q.status <> 'RESOLVED'
    and not exists (
      select 1 from public.lesson_quality_case_events as e
      where e.case_id = q.id and e.event_type = 'MEET_TEACHER_HANDOVER'
        and e.details ->> 'teacher_id' = v_session.teacher_id::text);
  select * into v_report from private.meeting_attendance_reports
   where lesson_session_id = v_session.id and parse_error is null
   order by imported_at desc limit 1;

  if v_report.id is not null then
    v_numbers := private.meet_attendance_numbers(v_session.id, v_report.id);
    v_student_known := v_numbers ->> 'source' in ('REPORT_ROWS', 'IMPORT');
    v_teacher_known := v_student_known and coalesce((v_numbers ->> 'teacher_identified')::boolean, false);
    v_teacher_first_join_at := (v_numbers ->> 'teacher_first_join_at')::timestamptz;
    v_teacher_seconds := (v_numbers ->> 'teacher_seconds')::integer;
    v_student_first_join_at := (v_numbers ->> 'student_first_join_at')::timestamptz;
    v_student_seconds := (v_numbers ->> 'student_seconds')::integer;
  end if;

  for v_flag in
    select * from (values
      ('late', 'LATE_START', 'NORMAL',
        v_teacher_known and v_teacher_first_join_at is not null
          and v_teacher_first_join_at > v_session.scheduled_start_at + interval '10 minutes'
          and v_teacher_first_join_at < v_session.scheduled_end_at),
      ('no-student', 'MEET_ATTENDANCE', 'HIGH',
        v_student_known and p_presence = 'COMPLETED' and coalesce(v_student_seconds, 0) < 300),
      ('absence-mismatch', 'MEET_ATTENDANCE', 'HIGH',
        v_student_known and p_presence = 'STUDENT_ABSENCE' and coalesce(v_student_seconds, 0) >= 600),
      ('no-teacher', 'MEET_ATTENDANCE', 'HIGH',
        v_teacher_known and p_presence in ('COMPLETED', 'STUDENT_ABSENCE')
          and coalesce(v_teacher_seconds, 0) < 300),
      ('outside-room', 'OUTSIDE_ROOM', 'LOW',
        coalesce(p_conference_count, -1) = 0 and p_presence in ('COMPLETED', 'STUDENT_ABSENCE')
          and v_session.scheduled_end_at < now() - interval '2 hours'
          and now() >= ((v_session.class_date + 1)::timestamp at time zone 'America/Sao_Paulo'))
    ) as rule(slug, category, severity, fires)
    where fires
      -- Sala retida pela troca de professor no início da aula (20260928120000):
      -- ninguém recebeu o link a tempo, o relatório não mede a aula.
      and not private.google_meet_room_withheld_at_lesson(v_session.id)
  loop
    v_late_minutes := case when v_teacher_first_join_at is null then null
      else floor(extract(epoch from (v_teacher_first_join_at - v_session.scheduled_start_at)) / 60)::integer end;
    insert into public.lesson_quality_cases (tenant_id, session_id, student_id, teacher_id,
      category, source, severity, description, dedupe_key)
    values (v_session.tenant_id, v_session.id, v_session.student_id, v_session.teacher_id,
      v_flag.category, 'SYSTEM', v_flag.severity,
      case v_flag.slug
        when 'late' then 'Relatório de presença do Meet: o professor entrou ' || v_late_minutes
          || ' min depois do horário da aula.'
        when 'no-student' then 'Aula lançada como dada, mas o relatório de presença do Meet mostra o aluno por '
          || round(coalesce(v_student_seconds, 0) / 60.0) || ' min na sala da escola.'
        when 'absence-mismatch' then 'Aula lançada como falta do aluno, mas o relatório de presença do Meet mostra o aluno por '
          || round(v_student_seconds / 60.0) || ' min na sala da escola.'
        when 'no-teacher' then 'Aula lançada, mas o relatório de presença do Meet mostra o professor por '
          || round(coalesce(v_teacher_seconds, 0) / 60.0) || ' min na sala da escola.'
        else 'Aula lançada sem uso da sala da escola no Meet. Combine com o professor o uso da sala oficial.'
      end || ' Isto é um aviso para conversar com o professor: não altera o pagamento.',
      'meet:' || v_session.id || ':' || v_flag.slug || ':' || v_session.teacher_id)
    on conflict (tenant_id, dedupe_key) do nothing
    returning id into v_case;
    if v_case is not null then
      insert into public.lesson_quality_case_events (tenant_id, case_id, actor_id, event_type, details)
      values (v_session.tenant_id, v_case, null, 'MEET_ATTENDANCE_REPORT', jsonb_build_object(
        'rule', v_flag.slug,
        'logged_presence', p_presence,
        'scheduled_start_at', v_session.scheduled_start_at,
        'teacher_id', v_session.teacher_id,
        'teacher_first_join_at', v_teacher_first_join_at,
        'teacher_minutes', round(coalesce(v_teacher_seconds, 0) / 60.0),
        'student_first_join_at', v_student_first_join_at,
        'student_minutes', round(coalesce(v_student_seconds, 0) / 60.0),
        'numbers_source', v_numbers ->> 'source',
        'conference_count', p_conference_count,
        'report_id', v_report.id));
      v_opened := v_opened || v_flag.slug;
    end if;
    v_case := null;
  end loop;

  return jsonb_build_object('evaluated', true, 'presence', p_presence,
    'report_id', v_report.id, 'opened', to_jsonb(v_opened));
end;
$$;

-- 4d. Remendo por âncora: a planilha que "Sala e resumo" mostra (session_detail,
-- só para quem vê a fonte) tem os números e os papéis de cada linha com a conta de
-- quem dá a aula hoje — os mesmos da avaliação acima. Antes a tela mostrava o
-- substituto como "Aluno/convidado" e o professor com os minutos do titular.
do $patch_detail_attendance$
declare
  v_def text;
  v_anchor constant text := E'''participants'',rep.participants)';
begin
  v_def := pg_catalog.pg_get_functiondef('public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure);
  if strpos(v_def, 'meet_attendance_numbers') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'âncora da planilha de presença em session_detail ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor, v_anchor
    || E'\n            -- Números e papéis com a conta de quem dá a aula hoje (20260928120000).\n'
    || E'            || coalesce(private.meet_attendance_numbers(s.id, rep.id) - ''source'', ''{}''::jsonb)');
end
$patch_detail_attendance$;

-- 5. Dono e permissões -------------------------------------------------------------
do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.teacher_punctuality_enabled_since(text)',
    'private.teacher_punctuality_retention_days()',
    'private.teacher_presence_timestamp(text)',
    'private.google_meet_room_withheld_at_lesson(uuid)',
    'private.teacher_lesson_presence_given_by_other(uuid)',
    'private.meet_attendance_numbers(uuid,uuid)',
    'private.google_meet_room_release_handover()',
    'private.meet_attendance_evaluate(uuid,text,integer)',
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
