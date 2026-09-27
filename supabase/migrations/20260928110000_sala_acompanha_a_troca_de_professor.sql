-- A sala acompanha a troca de professor (onda 3).
--
-- Antes: a sessão com aceite ou sala fica CONGELADA
-- (private.lesson_session_has_evidence). Cobertura confirmada, reposição com
-- professor trocado ou agendamento transferido depois disso não mudavam o
-- professor dela; a régua única da onda 1 (lesson_occurrence_giver /
-- lesson_session_taught_by_other) só tirava a sessão do app, do lembrete e da
-- preparação — a aula caía no link de sempre, sem transcrição, e:
--   * o lançamento do substituto nunca se ligava à sessão
--     (sync_lesson_quality_sessions liga só quando o teacher_id bate): a sessão
--     ficava SCHEDULED e virava pendência falsa de lançamento (MISSING_LOG);
--   * a transcrição continuava ligada na sala do titular e a importação da fila
--     não conferia quem dá a aula;
--   * aula congelada remarcada ou cancelada ficava como aula fantasma: link no
--     app, sala ligada e MISSING_LOG 24 h depois.
--
-- Decisão da direção (onda 3): a sessão passa a ser de quem DÁ a aula.
--   1. Troca de professor de UMA aula (cobertura confirmada — e a volta ao
--      titular quando ela é desfeita —, reposição, antecipação ou experimental
--      com outro professor): a sessão congelada passa para quem
--      dá a aula, com trilha (private.lesson_session_teacher_handovers + revisão
--      TEACHER_HANDOVER). Se ele tem a conta Google confirmada e o aceite do
--      termo que vale no fim da aula, a documentação segue: a fila põe a conta
--      dele como coanfitriã (room_claim → SYNC_COHOST → ensureCohost, que tira a
--      do titular), e até isso acontecer a sala NÃO é entregue
--      (google_meet_rooms.teacher_handover_pending) — senão o aluno esperaria
--      numa sala que só o ausente pode abrir. O lançamento do substituto se liga
--      à sessão e é ele quem revisa o resumo. Se ele NÃO é elegível, a sessão
--      passa assim mesmo (o lançamento dele fecha a aula), mas sem aceite
--      efetivo (private.lesson_session_handover_unconsented, na régua única): a
--      fila desliga a transcrição da sala (DISABLE_ARTIFACTS da onda 1), nada é
--      importado e a aula segue pelo link de sempre. Nunca transcrever sem o
--      aceite de quem dá a aula. Enquanto a troca não acontece (dono ambíguo,
--      sincronização ainda não rodou), a régua também barra
--      (lesson_session_taught_by_other).
--      Agendamento RECORRENTE transferido não troca a sessão sozinho: continua
--      o desenho de 12/09 (a escola replaneja a sessão futura, "Replanejar
--      sessão futura"), e até lá a régua barra a documentação dela.
--   2. Sessão congelada que sai da agenda (remarcada ou cancelada) antes de
--      virar pendência: SUPERSEDED, sem aceite (a fila desliga a sala) e com a
--      chave arquivada; o novo horário, se houver, ganha sessão própria (e sala
--      nova, pelo termo). Aula com lançamento, auditoria de presença ou
--      documentação importada não é arquivada — ela aconteceu.
--   3. Presença: o relatório reconhece como professor a conta confirmada de
--      quem dá a aula; a conta de quem passou a aula adiante é "outro
--      professor" (nem professor nem aluno) — session_state.attendance_identity.
--
-- Onde roda: dentro de private.sync_lesson_quality_sessions (remendo por
-- âncora: rodada de 15 min, lançamento de aula, telas), e na hora por gatilhos
-- em class_coverages, reschedules e lesson_advances. O gatilho nunca derruba a
-- escrita de origem (confirmar cobertura mexe em dinheiro): falha vira aviso no
-- log e a rodada de 15 min refaz.
--
-- Régua de quem dá a aula ficou segura para o passado: aula que já terminou não
-- muda de dono porque o agendamento recorrente foi transferido depois (o
-- professor ATUAL do agendamento não diz quem deu a aula da semana passada);
-- cobertura, reposição, antecipação e experimental são da ocorrência e valem.
--
-- Integração com o pacote da cobertura (20260928100000, seção 6.8): a previsão
-- de sala do pacote usa a régua desta troca (substituto pronto = conta Google
-- confirmada + aceite do termo que vale no fim da aula) e o aviso "sala pronta"
-- também sai quando a retenção da troca é solta — a sala retida nunca é
-- anunciada, e a de quem não está pronto nunca sai.
--
-- Remendos por âncora (pg_get_functiondef + erro se a âncora sumir): outras
-- frentes da onda 3 podem mexer nas mesmas funções. Re-executável: if not
-- exists, create or replace, drop trigger if exists, remendos idempotentes.

-- 1. Trilha da troca e sala retida até a conta nova ser a coanfitriã ------------
create table if not exists private.lesson_session_teacher_handovers (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  session_id uuid not null references public.lesson_sessions(id) on delete cascade,
  from_teacher_id uuid not null references public.profiles(id),
  to_teacher_id uuid not null references public.profiles(id),
  -- Contas confirmadas na hora da troca: a de quem passou a aula adiante não é
  -- reconhecida como "o professor" no relatório de presença.
  from_google_email text,
  to_google_email text,
  cause text not null,
  coverage_id uuid,
  -- Conta Google confirmada + aceite do termo que vale no fim da aula.
  documentation_ready boolean not null,
  -- A troca chegou depois do fim da aula (cobertura atestada depois).
  after_lesson boolean not null,
  room_withheld boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  check (from_teacher_id <> to_teacher_id)
);
alter table private.lesson_session_teacher_handovers drop constraint if exists lesson_session_teacher_handovers_cause_check;
alter table private.lesson_session_teacher_handovers add constraint lesson_session_teacher_handovers_cause_check
  check (cause in ('COVERAGE','COVERAGE_ENDED','RESCHEDULE','ADVANCE','APPOINTMENT'));
create index if not exists lesson_session_teacher_handovers_session_idx
  on private.lesson_session_teacher_handovers(session_id, created_at desc);
alter table private.lesson_session_teacher_handovers owner to postgres;
alter table private.lesson_session_teacher_handovers enable row level security;
revoke all on private.lesson_session_teacher_handovers from public, anon, authenticated, service_role;
comment on table private.lesson_session_teacher_handovers is
  'Trilha da troca de professor de uma sessão de aula congelada (cobertura confirmada ou desfeita, reposição, antecipação ou experimental com outro professor). Só referências e contas; nenhum conteúdo da aula.';

alter table private.google_meet_rooms add column if not exists teacher_handover_pending boolean not null default false;
comment on column private.google_meet_rooms.teacher_handover_pending is
  'A aula mudou de professor e a conta Google de quem dá a aula ainda não é a coanfitriã da sala: o link não é entregue (app e lembrete) até o acerto dos membros (20260928110000).';
-- A tabela é do supabase_admin; a troca (função do postgres) só liga esta marca.
grant update (teacher_handover_pending) on private.google_meet_rooms to postgres;

-- 2. Quem DÁ a aula da sessão ----------------------------------------------------
-- O único professor que dá todas as ocorrências vivas da sessão (null quando
-- elas discordam ou alguma não tem dono claro). Sem ocorrência viva, o professor
-- da sessão. Seguro para o passado: numa ocorrência de agendamento que já
-- terminou, o professor ATUAL do agendamento recorrente não conta (ele pode ter
-- sido transferido depois); só a antecipação daquela data e a cobertura.
create or replace function private.lesson_session_giver(p_session uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    when givers.occurrences = 0 then session.teacher_id
    when givers.without_giver = 0 and givers.distinct_givers = 1 then givers.giver
  end
  from public.lesson_sessions as session
  cross join lateral (
    select pg_catalog.count(*) as occurrences,
      pg_catalog.count(*) filter (where given.giver is null) as without_giver,
      pg_catalog.count(distinct given.giver) as distinct_givers,
      pg_catalog.min(given.giver::text)::uuid as giver
    from (
      select private.lesson_occurrence_giver(
        occurrence.tenant_id, occurrence.source_type, occurrence.source_id, occurrence.class_date,
        coalesce(
          case
            when occurrence.source_type = 'booking' and occurrence.scheduled_end_at <= pg_catalog.now() then (
              select advance.teacher_id
              from public.lesson_advances as advance
              where advance.booking_id::text = occurrence.source_id
                and advance.tenant_id = occurrence.tenant_id
                and advance.advance_date = occurrence.class_date
                and advance.advance_time = occurrence.start_time
                and advance.status <> 'CANCELLED'
              order by advance.created_at desc
              limit 1)
            else private.lesson_occurrence_scheduled_teacher(
              occurrence.tenant_id, occurrence.source_type, occurrence.source_id,
              occurrence.class_date, occurrence.start_time)
          end,
          session.teacher_id)
      ) as giver
      from public.lesson_occurrences as occurrence
      where occurrence.session_id = session.id
        and occurrence.tenant_id = session.tenant_id
        and occurrence.status <> 'SUPERSEDED'
    ) as given
  ) as givers
  where session.id = p_session;
$$;

-- A régua da onda 1, agora pela função acima (mesma assinatura e mesmo sentido:
-- alguma ocorrência viva é dada por outro professor, ou não tem dono claro).
create or replace function private.lesson_session_taught_by_other(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select private.lesson_session_giver(session.id) is distinct from session.teacher_id
    from public.lesson_sessions as session
    where session.id = p_session
  ), false);
$$;

-- Professor pronto para ter a aula documentada: conta Google confirmada por login
-- na escola e, como última decisão até o fim da aula, o "autorizo" de uma versão
-- do termo que cobre a exigida no fim da aula. Aula futura: vale a última decisão
-- até agora. Aula que já terminou (cobertura atestada depois): vale a que existia
-- no fim dela — aceitar depois não documenta a aula que ele deu sem aceite.
create or replace function private.lesson_teacher_documentation_ready(p_teacher uuid, p_tenant text, p_at timestamptz)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from private.teacher_google_identities as ident
      where ident.teacher_id = p_teacher and ident.tenant_id = p_tenant
    )
    and coalesce((
      select decision.decision = 'ACCEPTED'
        and private.lesson_recording_term_covers('TEACHER', decision.term_version, p_at)
      from private.lesson_recording_consents as decision
      where decision.subject_id = p_teacher
        and decision.decided_at <= p_at
      order by decision.decided_at desc, decision.seq desc
      limit 1
    ), false);
$$;

-- A sessão foi passada a um professor que não está pronto: sem aceite efetivo.
-- Não vale quando a aula voltou para o professor original da sessão (a base do
-- aceite dele é a de antes) nem quando a direção marcou de novo, à mão e com
-- motivo, DEPOIS da troca (o comprovante agora é do professor novo).
create or replace function private.lesson_session_handover_unconsented(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not private.lesson_teacher_documentation_ready(session.teacher_id, session.tenant_id, session.scheduled_end_at)
      and session.teacher_id <> first_handover.from_teacher_id
      and not exists (
        select 1 from private.lesson_documentation_consent_events as event
        where event.session_id = session.id
          and event.allowed
          and event.reason not like 'Termo de registro das aulas%'
          and event.created_at > last_handover.created_at
      )
    from public.lesson_sessions as session
    cross join lateral (
      select handover.created_at, handover.to_teacher_id
      from private.lesson_session_teacher_handovers as handover
      where handover.session_id = session.id
      order by handover.created_at desc
      limit 1
    ) as last_handover
    cross join lateral (
      select handover.from_teacher_id
      from private.lesson_session_teacher_handovers as handover
      where handover.session_id = session.id
      order by handover.created_at
      limit 1
    ) as first_handover
    where session.id = p_session
      and last_handover.to_teacher_id = session.teacher_id
  ), false);
$$;

-- Por que a sessão está sem aceite efetivo (tela da aula). Mesma ordem da régua;
-- null quando a régua ganhou um motivo que esta função não conhece.
create or replace function private.lesson_session_documentation_blocked_reason(p_session uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select case
    when private.lesson_recording_said_no_before(session.student_id, session.scheduled_end_at) then 'STUDENT_SAID_NO'
    when private.lesson_recording_said_no_before(session.teacher_id, session.scheduled_end_at) then 'TEACHER_SAID_NO'
    when private.lesson_session_term_consent_lapsed(session.id) then 'TERM_LAPSED'
    when private.lesson_session_manual_mark_outdated(session.id) then 'MANUAL_MARK_OUTDATED'
    when private.lesson_session_taught_by_other(session.id) then 'TAUGHT_BY_OTHER'
    when private.lesson_session_handover_unconsented(session.id) then 'HANDOVER_UNCONSENTED'
  end
  from public.lesson_sessions as session
  where session.id = p_session;
$$;

-- Quem o relatório de presença reconhece: teacher_emails = a conta confirmada de
-- quem dá a aula e a coanfitriã da sala quando ela não é de outro professor (conta
-- antiga do mesmo professor); other_teacher_emails = as contas de quem passou esta
-- aula adiante (nem professor nem aluno na planilha).
create or replace function private.lesson_session_attendance_identity(p_session uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with lesson as (
    select * from public.lesson_sessions where id = p_session
  ), own as (
    select ident.google_email as email
    from lesson
    join private.teacher_google_identities as ident
      on ident.teacher_id = lesson.teacher_id and ident.tenant_id = lesson.tenant_id
  ), others as (
    select pg_catalog.lower(handover.from_google_email) as email
    from lesson
    join private.lesson_session_teacher_handovers as handover on handover.session_id = lesson.id
    where handover.from_teacher_id <> lesson.teacher_id and handover.from_google_email is not null
    union
    select ident.google_email
    from lesson
    join private.lesson_session_teacher_handovers as handover on handover.session_id = lesson.id
    join private.teacher_google_identities as ident
      on ident.teacher_id = handover.from_teacher_id and ident.tenant_id = lesson.tenant_id
    where handover.from_teacher_id <> lesson.teacher_id
  ), cohost as (
    select pg_catalog.lower(room.cohost_email) as email
    from lesson
    join private.google_meet_rooms as room on room.lesson_session_id = lesson.id and room.tenant_id = lesson.tenant_id
    where room.cohost_email is not null
      and not exists (select 1 from others where others.email = pg_catalog.lower(room.cohost_email))
      and not exists (
        select 1 from private.teacher_google_identities as other_ident
        where other_ident.tenant_id = lesson.tenant_id
          and other_ident.teacher_id <> lesson.teacher_id
          and other_ident.google_email = pg_catalog.lower(room.cohost_email))
  )
  select pg_catalog.jsonb_build_object(
    'teacher_emails', coalesce((
      select pg_catalog.jsonb_agg(distinct teacher.email)
      from (select email from own union select email from cohost) as teacher
      where teacher.email is not null), '[]'::jsonb),
    'other_teacher_emails', coalesce((
      select pg_catalog.jsonb_agg(distinct others.email)
      from others
      where others.email is not null
        and not exists (select 1 from own where own.email = others.email)), '[]'::jsonb))
  where exists (select 1 from lesson);
$$;

-- A última troca (tela da aula): quem passou para quem, quando e por quê.
create or replace function private.lesson_session_last_handover(p_session uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'from_teacher_name', from_teacher.full_name,
    'to_teacher_name', to_teacher.full_name,
    'cause', handover.cause,
    'at', handover.created_at,
    'documentation_ready', handover.documentation_ready,
    'after_lesson', handover.after_lesson)
  from private.lesson_session_teacher_handovers as handover
  join public.profiles as from_teacher on from_teacher.id = handover.from_teacher_id
  join public.profiles as to_teacher on to_teacher.id = handover.to_teacher_id
  where handover.session_id = p_session
  order by handover.created_at desc
  limit 1;
$$;

-- 3. A troca ---------------------------------------------------------------------
create or replace function private.lesson_session_follow_giver(p_session uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions%rowtype;
  v_giver uuid;
  v_ready boolean;
  v_ended boolean;
  v_from_email text;
  v_to_email text;
  v_cause text;
  v_coverage uuid;
  v_withheld boolean := false;
  v_next jsonb;
  v_to_name text;
begin
  select * into v_session from public.lesson_sessions where id = p_session for update;
  if not found or v_session.status = 'SUPERSEDED' then
    return 'SKIPPED';
  end if;
  v_giver := private.lesson_session_giver(v_session.id);
  if v_giver is null then
    -- Dono ambíguo: fica como está, e a régua barra a documentação.
    return 'NO_SINGLE_GIVER';
  end if;
  if v_giver = v_session.teacher_id then
    return 'SAME_TEACHER';
  end if;
  if not exists (
    select 1 from public.profiles as teacher
    where teacher.id = v_giver and teacher.tenant_id = v_session.tenant_id and teacher.role = 'TEACHER'
  ) then
    return 'GIVER_NOT_TEACHER';
  end if;

  v_ended := v_session.scheduled_end_at <= pg_catalog.now();
  v_ready := private.lesson_teacher_documentation_ready(v_giver, v_session.tenant_id, v_session.scheduled_end_at);
  select ident.google_email into v_from_email from private.teacher_google_identities as ident
   where ident.teacher_id = v_session.teacher_id and ident.tenant_id = v_session.tenant_id;
  select ident.google_email into v_to_email from private.teacher_google_identities as ident
   where ident.teacher_id = v_giver and ident.tenant_id = v_session.tenant_id;

  select coverage.id into v_coverage
  from public.lesson_occurrences as occurrence
  join public.class_coverages as coverage
    on occurrence.source_type = 'booking'
   and coverage.booking_id::text = occurrence.source_id
   and coverage.tenant_id = occurrence.tenant_id
   and coverage.class_date = occurrence.class_date
   and pg_catalog.lower(coalesce(coverage.status, '')) in ('confirmed', 'scheduled', 'completed')
   and coverage.cover_teacher_id = v_giver
  where occurrence.session_id = v_session.id and occurrence.status <> 'SUPERSEDED'
  order by coverage.id
  limit 1;
  v_cause := case
    when v_coverage is not null then 'COVERAGE'
    when exists (select 1 from public.lesson_occurrences as occurrence
      where occurrence.session_id = v_session.id and occurrence.status <> 'SUPERSEDED'
        and occurrence.source_type = 'reschedule') then 'RESCHEDULE'
    when exists (select 1 from public.lesson_occurrences as occurrence
      where occurrence.session_id = v_session.id and occurrence.status <> 'SUPERSEDED'
        and occurrence.source_type = 'appointment') then 'APPOINTMENT'
    when exists (select 1 from public.lesson_occurrences as occurrence
      join public.lesson_advances as advance
        on advance.booking_id::text = occurrence.source_id and advance.tenant_id = occurrence.tenant_id
       and advance.advance_date = occurrence.class_date and advance.advance_time = occurrence.start_time
       and advance.status <> 'CANCELLED' and advance.teacher_id = v_giver
      where occurrence.session_id = v_session.id and occurrence.status <> 'SUPERSEDED'
        and occurrence.source_type = 'booking') then 'ADVANCE'
    -- Cobertura desfeita: a aula volta a quem a tinha antes da cobertura.
    when exists (
      select 1 from (
        select handover.cause, handover.from_teacher_id
        from private.lesson_session_teacher_handovers as handover
        where handover.session_id = v_session.id
        order by handover.created_at desc
        limit 1
      ) as last_handover
      where last_handover.cause = 'COVERAGE' and last_handover.from_teacher_id = v_giver
    ) then 'COVERAGE_ENDED'
  end;
  -- Agendamento recorrente transferido para outro professor: a sessão congelada
  -- NÃO muda sozinha (desenho de 12/09, lesson_quality_sessions_and_feedback: a
  -- escola replaneja a sessão futura — supersede_future_lesson_session — e a
  -- nova nasce sem aceite). Até lá a régua única barra a documentação
  -- (lesson_session_taught_by_other): sala desligada, fora do app e do lembrete.
  if v_cause is null then
    return 'BOOKING_TRANSFER_NEEDS_REPLAN';
  end if;

  update public.lesson_sessions set teacher_id = v_giver, updated_at = pg_catalog.now()
   where id = v_session.id
  returning to_jsonb(lesson_sessions.*) into v_next;
  select profile.full_name into v_to_name from public.profiles as profile where profile.id = v_giver;
  insert into private.lesson_session_revisions (session_id, previous_snapshot, next_snapshot, actor_id, action, reason)
  values (v_session.id, to_jsonb(v_session), v_next, null, 'TEACHER_HANDOVER',
    'A aula passou a ser dada por ' || coalesce(v_to_name, 'outro professor') || ' ('
      || case v_cause
        when 'COVERAGE' then 'cobertura confirmada'
        when 'COVERAGE_ENDED' then 'cobertura desfeita, a aula volta ao titular'
        when 'RESCHEDULE' then 'reposição com outro professor'
        when 'ADVANCE' then 'antecipação com outro professor'
        else 'aula experimental com outro professor' end
      || '). ' || case when v_ready
        then 'Conta Google confirmada e aceite do termo vigente: a documentação segue com ele.'
        else 'Sem conta Google confirmada ou sem aceite do termo vigente: a documentação desta aula fica desligada.' end);

  -- Sala de aula que ainda não terminou: não é entregue até a conta Google de
  -- quem dá a aula ser a coanfitriã (o gatilho da sala solta a retenção sozinho
  -- quando já está certa ou quando o acerto termina). Aula já terminada: nada a
  -- entregar nem a acertar no Google.
  if not v_ended then
    update private.google_meet_rooms as room
       set teacher_handover_pending = true
     where room.lesson_session_id = v_session.id and room.tenant_id = v_session.tenant_id;
    if found then
      select room.teacher_handover_pending into v_withheld
      from private.google_meet_rooms as room where room.lesson_session_id = v_session.id;
      insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
      values (v_session.tenant_id, null, v_session.id, 'ROOM_TEACHER_HANDOVER');
    end if;
  end if;

  insert into private.lesson_session_teacher_handovers (tenant_id, session_id, from_teacher_id, to_teacher_id,
    from_google_email, to_google_email, cause, coverage_id, documentation_ready, after_lesson, room_withheld)
  values (v_session.tenant_id, v_session.id, v_session.teacher_id, v_giver,
    v_from_email, v_to_email, v_cause, v_coverage, v_ready, v_ended, coalesce(v_withheld, false));

  return case when v_ready then 'HANDED_OVER' else 'HANDED_OVER_DOCUMENTATION_OFF' end;
end;
$$;

-- A sala retida pela troca é solta quando a conta de quem dá a aula já é a
-- coanfitriã configurada: sala pronta, sem acerto pendente, com o e-mail da conta
-- confirmada do professor da sessão.
create or replace function private.google_meet_room_release_handover()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.teacher_handover_pending
    and new.state = 'READY'
    and not new.cohost_sync_pending
    and new.cohost_email is not null
    and exists (
      select 1
      from public.lesson_sessions as session
      join private.teacher_google_identities as ident
        on ident.teacher_id = session.teacher_id and ident.tenant_id = session.tenant_id
      where session.id = new.lesson_session_id
        and ident.google_email = pg_catalog.lower(new.cohost_email)
    ) then
    new.teacher_handover_pending := false;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_zz_google_meet_rooms_release_handover on private.google_meet_rooms;
create trigger trg_zz_google_meet_rooms_release_handover
  before update on private.google_meet_rooms
  for each row when (new.teacher_handover_pending)
  execute function private.google_meet_room_release_handover();

-- 4. Aula congelada que saiu da agenda -------------------------------------------
create or replace function private.lesson_session_left_schedule(p_session uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions%rowtype;
  v_actor uuid;
  v_next jsonb;
  v_has_room boolean;
begin
  select * into v_session from public.lesson_sessions where id = p_session for update;
  if not found or v_session.status <> 'SCHEDULED' then
    return 'SKIPPED';
  end if;
  -- Evidência de que a aula aconteceu no horário antigo: não é fantasma.
  if exists (
    select 1 from public.class_logs as cl
    where cl.tenant_id = v_session.tenant_id
      and (cl.lesson_session_id = v_session.id or exists (
        select 1 from public.lesson_occurrences as o
        where o.session_id = v_session.id and cl.class_date = o.class_date and cl.start_time = o.start_time
          and (o.class_log_id = cl.id
            or (o.source_type = 'booking' and cl.booking_id::text = o.source_id)
            or (o.source_type = 'reschedule' and cl.reschedule_id::text = o.source_id)
            or (o.source_type = 'appointment' and cl.appointment_id::text = o.source_id))))
  ) then
    return 'LOGGED';
  end if;
  if exists (
    select 1 from public.attendance_confirmations as ac
    where ac.tenant_id = v_session.tenant_id
      and (ac.lesson_session_id = v_session.id or exists (
        select 1 from public.lesson_occurrences as o
        where o.session_id = v_session.id and ac.source_type = o.source_type
          and ac.source_id::text = o.source_id and ac.class_date = o.class_date
          and left(ac.class_time, 5) = to_char(o.start_time, 'HH24:MI')))
  ) then
    return 'ATTENDANCE_AUDIT';
  end if;
  if exists (select 1 from private.meeting_artifact_revisions as ar where ar.lesson_session_id = v_session.id)
    or exists (select 1 from private.google_meet_artifact_imports as imp where imp.lesson_session_id = v_session.id)
    or exists (select 1 from private.meeting_attendance_reports as rep where rep.lesson_session_id = v_session.id)
    or exists (select 1 from private.lesson_summary_versions as sv where sv.lesson_session_id = v_session.id) then
    return 'DOCUMENTED';
  end if;

  v_has_room := exists (select 1 from private.google_meet_rooms as room where room.lesson_session_id = v_session.id);
  v_actor := coalesce(auth.uid(), private.management_group_default_actor(v_session.tenant_id));
  if v_actor is not null and (v_session.documentation_consent or v_has_room) then
    insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason, created_at)
    values (v_session.id, v_actor, false,
      'Sessão arquivada: a aula saiu da agenda (remarcada ou cancelada). A transcrição da sala desta sessão é desligada; o novo horário, se houver, ganha sessão própria.',
      pg_catalog.clock_timestamp());
  end if;
  update public.lesson_occurrences set status = 'SUPERSEDED'
   where session_id = v_session.id and tenant_id = v_session.tenant_id and status <> 'SUPERSEDED';
  update public.lesson_sessions
     set status = 'SUPERSEDED', documentation_consent = false, updated_at = pg_catalog.now(),
         source_key = v_session.source_key || ':archived:' || v_session.id::text
   where id = v_session.id
  returning to_jsonb(lesson_sessions.*) into v_next;
  insert into private.lesson_session_revisions (session_id, previous_snapshot, next_snapshot, actor_id, action, reason)
  values (v_session.id, to_jsonb(v_session), v_next, auth.uid(), 'SUPERSEDE_LEFT_SCHEDULE',
    'A aula saiu da agenda (remarcada ou cancelada) antes de ser dada.');
  if v_has_room then
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (v_session.tenant_id, null, v_session.id, 'ROOM_SESSION_LEFT_SCHEDULE');
  end if;
  return 'SUPERSEDED';
end;
$$;

-- As duas coisas numa passada, para as sessões congeladas do intervalo. Roda
-- dentro de sync_lesson_quality_sessions, depois de ela arquivar as sessões sem
-- evidência e antes de montar as novas e de ligar os lançamentos.
create or replace function private.reconcile_frozen_lesson_sessions(
  p_tenant text, p_from date, p_to date, p_student uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_left integer := 0;
  v_handed integer := 0;
begin
  -- Saiu da agenda: só aula que ainda não passou do prazo da pendência de
  -- lançamento (24 h depois do fim). A mais antiga já virou caso na Central de
  -- Qualidade e é conferida por gente.
  if exists (
    select 1 from public.lesson_sessions as session
    where session.tenant_id = p_tenant and session.class_date between p_from and p_to
      and (p_student is null or session.student_id = p_student)
      and session.status = 'SCHEDULED'
      and session.scheduled_end_at > pg_catalog.now() - interval '24 hours'
  ) then
    for v_row in
      with src as materialized (
        select q.source_type, q.source_id, q.class_date, q.start_time
        from private.lesson_quality_sources(p_tenant, p_from, p_to, p_student) as q
      )
      select session.id
      from public.lesson_sessions as session
      where session.tenant_id = p_tenant and session.class_date between p_from and p_to
        and (p_student is null or session.student_id = p_student)
        and session.status = 'SCHEDULED'
        and session.scheduled_end_at > pg_catalog.now() - interval '24 hours'
        and exists (
          select 1 from public.lesson_occurrences as occurrence
          where occurrence.session_id = session.id and occurrence.tenant_id = session.tenant_id
            and occurrence.status <> 'SUPERSEDED'
            and not exists (
              select 1 from src
              where src.source_type = occurrence.source_type and src.source_id = occurrence.source_id
                and src.class_date = occurrence.class_date and src.start_time = occurrence.start_time))
    loop
      -- Uma sessão com problema não derruba a sincronização: ela roda no
      -- lançamento de aula (gatilho de class_logs) e na rodada de 15 min.
      begin
        if private.lesson_session_left_schedule(v_row.id) = 'SUPERSEDED' then
          v_left := v_left + 1;
        end if;
      exception when others then
        raise warning '[sala da troca] sessão % fora da agenda não foi arquivada: %', v_row.id, sqlerrm;
      end;
    end loop;
  end if;

  for v_row in
    select session.id
    from public.lesson_sessions as session
    where session.tenant_id = p_tenant and session.class_date between p_from and p_to
      and (p_student is null or session.student_id = p_student)
      and session.status <> 'SUPERSEDED'
      and private.lesson_session_taught_by_other(session.id)
  loop
    begin
      if private.lesson_session_follow_giver(v_row.id) like 'HANDED_OVER%' then
        v_handed := v_handed + 1;
      end if;
    exception when others then
      -- Sem a troca, a régua única segue barrando a documentação da sessão.
      raise warning '[sala da troca] sessão % não passou para quem dá a aula: %', v_row.id, sqlerrm;
    end;
  end loop;
  return pg_catalog.jsonb_build_object('left_schedule', v_left, 'handed_over', v_handed);
end;
$$;

-- 5. Gatilhos: cobertura, reposição e antecipação reconciliam na hora ------------
-- Nunca derrubam a escrita de origem (confirmar cobertura, remarcar reposição):
-- falha vira aviso no log do Postgres e a rodada de 15 min
-- (refresh_lesson_quality_queue) refaz.
create or replace function private.lesson_sessions_resync(p_tenant text, p_student uuid, p_dates date[])
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_date date;
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if p_tenant is null or p_student is null then
    return;
  end if;
  for v_date in
    select distinct listed.day from unnest(p_dates) as listed(day)
    where listed.day is not null and listed.day between v_today - 32 and v_today + 62
  loop
    begin
      perform private.sync_lesson_quality_sessions(p_tenant, v_date, v_date, p_student);
    exception when others then
      raise warning '[sala da troca] ressincronização das sessões de aula falhou (%, %): %', p_tenant, v_date, sqlerrm;
    end;
  end loop;
end;
$$;

create or replace function private.class_coverage_follow_lesson_session()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (old.class_date, old.booking_id, old.student_id, old.tenant_id)
      is distinct from (new.class_date, new.booking_id, new.student_id, new.tenant_id) then
    perform private.lesson_sessions_resync(old.tenant_id,
      coalesce(old.student_id, (select booking.student_id from public.bookings as booking where booking.id = old.booking_id)),
      array[old.class_date]);
  end if;
  perform private.lesson_sessions_resync(new.tenant_id,
    coalesce(new.student_id, (select booking.student_id from public.bookings as booking where booking.id = new.booking_id)),
    array[new.class_date]);
  return null;
end;
$$;
drop trigger if exists trg_zz_class_coverage_follow_lesson_session on public.class_coverages;
create trigger trg_zz_class_coverage_follow_lesson_session
  after insert or update of status, cover_teacher_id, booking_id, class_date, class_time, student_id, tenant_id
  on public.class_coverages
  for each row execute function private.class_coverage_follow_lesson_session();

create or replace function private.reschedule_follow_lesson_session()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.lesson_sessions_resync(old.tenant_id, old.student_id,
      array[public.parse_lesson_date(old.date)]);
  end if;
  if tg_op = 'UPDATE' then
    perform private.lesson_sessions_resync(new.tenant_id, new.student_id,
      array[public.parse_lesson_date(new.date)]);
  end if;
  return null;
end;
$$;
drop trigger if exists trg_zz_reschedule_follow_lesson_session on public.reschedules;
create trigger trg_zz_reschedule_follow_lesson_session
  after update of date, "time", teacher_id, student_id, closed_reason or delete
  on public.reschedules
  for each row execute function private.reschedule_follow_lesson_session();

create or replace function private.lesson_advance_follow_lesson_session()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.lesson_sessions_resync(old.tenant_id, old.student_id,
      array[old.original_date, old.advance_date]);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.lesson_sessions_resync(new.tenant_id, new.student_id,
      array[new.original_date, new.advance_date]);
  end if;
  return null;
end;
$$;
drop trigger if exists trg_zz_lesson_advance_follow_lesson_session on public.lesson_advances;
create trigger trg_zz_lesson_advance_follow_lesson_session
  after insert or update of original_date, advance_date, advance_time, status, teacher_id, student_id or delete
  on public.lesson_advances
  for each row execute function private.lesson_advance_follow_lesson_session();

-- 6. Remendos por âncora nas definições vivas ------------------------------------

-- 6.1 Régua única do aceite efetivo: quem dá a aula é outro (ainda sem troca, ou
-- sem dono claro) ou a aula passou para quem não está pronto.
do $patch_blocked$
declare
  v_def text;
  v_anchor constant text := 'or private.lesson_session_manual_mark_outdated(session.id)';
begin
  v_def := pg_catalog.pg_get_functiondef('private.lesson_session_documentation_blocked(uuid)'::regprocedure);
  if strpos(v_def, 'lesson_session_handover_unconsented') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'âncora da régua do aceite efetivo ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor, v_anchor
    || E'\n      -- 20260928110000: quem dá a aula é outro professor (troca ainda não feita,\n'
    || E'      -- ou sem dono claro), ou a aula passou para quem não está pronto.\n'
    || E'      or private.lesson_session_taught_by_other(session.id)\n'
    || E'      or private.lesson_session_handover_unconsented(session.id)');
end
$patch_blocked$;

-- 6.2 A materialização das sessões reconcilia as congeladas (troca de professor e
-- aula que saiu da agenda) antes de montar as novas e de ligar os lançamentos.
do $patch_sync$
declare
  v_def text;
  v_anchor constant text := E'(and not private\\.lesson_session_has_evidence\\(s\\.id\\);)(\\s+for g in)';
begin
  v_def := pg_catalog.pg_get_functiondef('private.sync_lesson_quality_sessions(text,date,date,uuid)'::regprocedure);
  if strpos(v_def, 'reconcile_frozen_lesson_sessions') > 0 then
    return;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.regexp_matches(v_def, v_anchor, 'g')) <> 1 then
    raise exception 'âncora de sync_lesson_quality_sessions (arquivamento das sessões sem evidência seguido do laço) não encontrada uma única vez';
  end if;
  execute pg_catalog.regexp_replace(v_def, v_anchor,
    E'\\1\n  -- Sessões congeladas: trocam de professor com a aula e saem da agenda com\n'
    || E'  -- ela (20260928110000).\n'
    || E'  perform private.reconcile_frozen_lesson_sessions(p_tenant,p_from,p_to,p_student);\\2');
end
$patch_sync$;

-- 6.3 Fontes das sessões: a cobertura segue a régua única (agendamento + data,
-- estados vivos — a de lesson_occurrence_giver; antes exigia o horário exato e só
-- 'confirmed') e a reposição encerrada pela direção (close_reschedule) não é aula.
do $patch_sources$
declare
  v_def text;
  v_closed_anchor constant text := E'and coalesce(upper(to_jsonb(r)->>''status''),'''') not in (''CANCELLED'',''CANCELED'')';
  v_coverage_anchor constant text := E'left join lateral \\(\\s*select \\(array_agg\\(cc\\.cover_teacher_id order by cc\\.id\\)\\)\\[1\\] as cover_teacher_id.*?having count\\(\\*\\)=1\\s*\\) c on true';
begin
  v_def := pg_catalog.pg_get_functiondef('private.lesson_quality_sources(text,date,date,uuid)'::regprocedure);
  if strpos(v_def, 'lesson_occurrence_giver') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_closed_anchor, ''))) / length(v_closed_anchor) <> 1 then
    raise exception 'âncora da reposição cancelada em lesson_quality_sources não encontrada uma única vez';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.regexp_matches(v_def, v_coverage_anchor, 'g')) <> 1 then
    raise exception 'âncora da cobertura em lesson_quality_sources não encontrada uma única vez';
  end if;
  v_def := replace(v_def, v_closed_anchor, v_closed_anchor || E'\n        and r.closed_reason is null');
  v_def := pg_catalog.regexp_replace(v_def, v_coverage_anchor,
    E'left join lateral (\n'
    || E'        select private.lesson_occurrence_giver(b.tenant_id,b.source_type,b.source_id,b.class_date,b.teacher_id) as cover_teacher_id\n'
    || E'      ) c on true');
  execute v_def;
end
$patch_sources$;

-- 6.4 Link do app: sala retida pela troca de professor não é entregue.
do $patch_rooms$
declare
  v_def text;
  v_anchor constant text := E'and coalesce(r.state,'''') not in (''FAILED'',''NEEDS_RECONCILIATION'')';
begin
  v_def := pg_catalog.pg_get_functiondef('public.get_my_lesson_rooms(date,date)'::regprocedure);
  if strpos(v_def, 'teacher_handover_pending') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'âncora de get_my_lesson_rooms ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor, v_anchor
    || E'\n      -- A aula mudou de professor e a conta dele ainda não é a coanfitriã.\n'
    || E'      and not coalesce(r.teacher_handover_pending,false)');
end
$patch_rooms$;

-- 6.5 Lembrete do WhatsApp: idem.
do $patch_link$
declare
  v_def text;
  v_anchor constant text := E'and room.state = ''READY''';
begin
  v_def := pg_catalog.pg_get_functiondef('public.official_lesson_link(text,text,text,date,uuid,time,uuid)'::regprocedure);
  if strpos(v_def, 'teacher_handover_pending') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'âncora de official_lesson_link ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor, v_anchor
    || E'\n    -- A aula mudou de professor e a conta dele ainda não é a coanfitriã.\n'
    || E'    and not room.teacher_handover_pending');
end
$patch_link$;

-- 6.6 Porta do Meet: presença reconhece quem dá a aula (session_state), a tela
-- diz por que a documentação está barrada e mostra a última troca.
do $patch_backend$
declare
  v_def text;
  v_identity_anchor constant text := E'(''teacher_google_email'',\\(select ident\\.google_email from private\\.teacher_google_identities ident\\s+where ident\\.teacher_id=s\\.teacher_id and ident\\.tenant_id=s\\.tenant_id\\))\\);';
  v_blocked_anchor constant text := E'''documentation_blocked'',s.documentation_consent and not v_consent)';
  v_raw_anchor constant text := E'''raw_access'',v_raw,';
begin
  v_def := pg_catalog.pg_get_functiondef('public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure);
  if strpos(v_def, 'attendance_identity') > 0 then
    return;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.regexp_matches(v_def, v_identity_anchor, 'g')) <> 1 then
    raise exception 'âncora de session_state (teacher_google_email) não encontrada uma única vez';
  end if;
  if (length(v_def) - length(replace(v_def, v_blocked_anchor, ''))) / length(v_blocked_anchor) <> 2 then
    raise exception 'âncora de documentation_blocked (session_state e session_detail) não encontrada duas vezes';
  end if;
  if (length(v_def) - length(replace(v_def, v_raw_anchor, ''))) / length(v_raw_anchor) <> 1 then
    raise exception 'âncora de session_detail (raw_access) não encontrada uma única vez';
  end if;
  v_def := pg_catalog.regexp_replace(v_def, v_identity_anchor,
    E'\\1,\n        -- Quem o relatório de presença reconhece como professor (e como outro\n'
    || E'        -- professor, quem passou a aula adiante) — 20260928110000.\n'
    || E'        ''attendance_identity'',private.lesson_session_attendance_identity(s.id));');
  v_def := replace(v_def, v_blocked_anchor,
    E'''documentation_blocked'',s.documentation_consent and not v_consent,\n'
    || E'          ''documentation_blocked_reason'',case when s.documentation_consent and not v_consent\n'
    || E'            then private.lesson_session_documentation_blocked_reason(s.id) end)');
  v_def := replace(v_def, v_raw_anchor,
    E'''raw_access'',v_raw,\n        ''teacher_handover'',private.lesson_session_last_handover(s.id),');
  execute v_def;
end
$patch_backend$;

-- 6.7 Job do termo: o desmarque de uma aula que passou para quem não aceitou o
-- termo diz isso, não "autorização revogada".
do $patch_standing$
declare
  v_def text;
  v_anchor constant text := E'v_marker || '': autorização revogada ou recusada depois da marcação.'',';
begin
  v_def := pg_catalog.pg_get_functiondef('private.apply_standing_lesson_recording_consent(text)'::regprocedure);
  if strpos(v_def, 'lesson_session_handover_unconsented') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'âncora do desmarque do job do termo ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor,
    E'v_marker || case when private.lesson_session_handover_unconsented(v_session.id)\n'
    || E'          then '': a aula passou para outro professor, que ainda não confirmou a conta Google ou não aceitou a versão vigente do termo.''\n'
    || E'          else '': autorização revogada ou recusada depois da marcação.'' end,');
end
$patch_standing$;

-- 6.8 Pacote da cobertura × sala da troca (integração da onda 3) -----------------
-- O pacote da cobertura (20260928100000) promete ao substituto e à família "o link
-- da escola chega por aqui" quando prevê sala. Duas coisas precisam bater com a
-- troca desta migration:
--   a) a previsão usa a MESMA régua da troca: substituto elegível = conta Google
--      confirmada + aceite do termo que vale no fim da aula
--      (private.lesson_teacher_documentation_ready), mais o aceite do aluno. Aula
--      que já passou ao substituto com a documentação barrada (passou a quem não
--      está pronto, recusa antes do fim, termo que caiu) segue pelo link de sempre
--      — nada de "o link chega por aqui";
--   b) o aviso de sala pronta também sai quando a RETENÇÃO da troca é solta (a
--      conta do substituto virou a coanfitriã): a sala já estava READY e só
--      teacher_handover_pending mudou — e quem muda a marca é o gatilho BEFORE
--      (trg_zz_google_meet_rooms_release_handover), que um gatilho "update of
--      <coluna>" não enxerga. Antes, a promessa do pacote nunca se cumpria na
--      aula congelada que passou ao substituto pronto. Sala retida não é
--      entregue a ninguém, e a sala de quem não está pronto nunca sai
--      (official_lesson_link aplica a régua única).
create or replace function private.coverage_school_room_expected(p_coverage_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select coverage.booking_id is not null
      and pg_catalog.lower(coalesce(coverage.status, '')) = 'confirmed'
      and exists (
        select 1 from private.google_workspace_connections as connection
         where connection.tenant_id = coverage.tenant_id and connection.status = 'CONNECTED')
      -- A régua da troca (20260928110000): conta Google confirmada e o
      -- "autorizo" do termo que vale no fim da aula.
      and private.lesson_teacher_documentation_ready(coverage.cover_teacher_id, coverage.tenant_id, lesson_end.at)
      -- E o aceite do aluno com o substituto (a régua do job que marca a sessão).
      and private.lesson_recording_active(coverage.student_id, coverage.cover_teacher_id)
      and not exists (
        select 1
          from public.lesson_occurrences as occurrence
          join public.lesson_sessions as session
            on session.id = occurrence.session_id and session.tenant_id = occurrence.tenant_id
         where occurrence.tenant_id = coverage.tenant_id
           and occurrence.source_type = 'booking'
           and occurrence.source_id = coverage.booking_id::text
           and occurrence.class_date = coverage.class_date
           and occurrence.status <> 'SUPERSEDED'
           and session.status <> 'SUPERSEDED'
           and (
             -- Congelada com outro professor e a troca não aconteceu (dono ambíguo,
             -- rodada ainda não passou): a régua barra a sala dela.
             (session.teacher_id is distinct from coverage.cover_teacher_id
               and private.lesson_session_has_evidence(session.id))
             -- Já é do substituto, mas com a documentação barrada: link de sempre.
             or (session.teacher_id = coverage.cover_teacher_id
               and private.lesson_session_documentation_blocked(session.id))))
    from public.class_coverages as coverage
    cross join lateral (
      select coalesce(
        (select session.scheduled_end_at
           from public.lesson_occurrences as occurrence
           join public.lesson_sessions as session
             on session.id = occurrence.session_id and session.tenant_id = occurrence.tenant_id
          where occurrence.tenant_id = coverage.tenant_id
            and occurrence.source_type = 'booking'
            and occurrence.source_id = coverage.booking_id::text
            and occurrence.class_date = coverage.class_date
            and occurrence.status <> 'SUPERSEDED'
            and session.status <> 'SUPERSEDED'
          order by session.scheduled_end_at desc
          limit 1),
        (coverage.class_date
          + coalesce(case when pg_catalog.left(coalesce(coverage.class_time, ''), 5) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                          then pg_catalog.left(coverage.class_time, 5)::time end, time '23:29')
          + interval '30 minutes') at time zone 'America/Sao_Paulo'
      ) as at
    ) as lesson_end
   where coverage.id = p_coverage_id
  ), false);
$function$;

alter function private.coverage_school_room_expected(uuid) owner to postgres;
revoke all on function private.coverage_school_room_expected(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.google_meet_room_ready_coverage_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_coverage uuid;
begin
  -- Sala retida pela troca de professor não é entregue a ninguém.
  if new.state is distinct from 'READY' or new.meeting_uri is null
     or coalesce(new.teacher_handover_pending, false) then
    return null;
  end if;
  -- Só quando a sala FICA pronta para quem dá a aula: nasceu pronta, ficou
  -- pronta, mudou de link, ou a retenção da troca acabou de ser solta.
  if tg_op = 'UPDATE' and old.state is not distinct from new.state
     and old.meeting_uri is not distinct from new.meeting_uri
     and not coalesce(old.teacher_handover_pending, false) then
    return null;
  end if;
  for v_coverage in
    select distinct coverage.id
      from public.lesson_occurrences as occurrence
      join public.class_coverages as coverage
        on coverage.tenant_id = occurrence.tenant_id
       and coverage.booking_id::text = occurrence.source_id
       and coverage.class_date = occurrence.class_date
     where occurrence.session_id = new.lesson_session_id
       and occurrence.tenant_id = new.tenant_id
       and occurrence.source_type = 'booking'
       and occurrence.status <> 'SUPERSEDED'
       and pg_catalog.lower(coalesce(coverage.status, '')) = 'confirmed'
  loop
    begin
      -- A sala só sai se valer para quem dá a aula (official_lesson_link: régua
      -- única, aceite efetivo, sem retenção) — nunca ao substituto sem aceite.
      perform private.coverage_room_notice_enqueue(v_coverage);
    exception when others then
      -- O aviso nunca derruba a gravação da sala.
      raise warning 'google_meet_room_ready_coverage_notice: % (%)', sqlerrm, sqlstate;
    end;
  end loop;
  return null;
end
$function$;

alter function private.google_meet_room_ready_coverage_notice() owner to postgres;
revoke all on function private.google_meet_room_ready_coverage_notice()
  from public, anon, authenticated, service_role;

-- Sem lista de colunas: a retenção é solta por gatilho BEFORE, e mudança feita
-- por gatilho BEFORE não aciona gatilho "update of <coluna>".
drop trigger if exists trg_zz_google_meet_room_ready_coverage_notice on private.google_meet_rooms;
create trigger trg_zz_google_meet_room_ready_coverage_notice
  after insert or update on private.google_meet_rooms
  for each row when (new.state = 'READY')
  execute function private.google_meet_room_ready_coverage_notice();

-- 7. Dono e permissões -------------------------------------------------------------
do $grants$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_session_giver(uuid)',
    'private.lesson_session_taught_by_other(uuid)',
    'private.lesson_teacher_documentation_ready(uuid,text,timestamptz)',
    'private.lesson_session_handover_unconsented(uuid)',
    'private.lesson_session_documentation_blocked_reason(uuid)',
    'private.lesson_session_attendance_identity(uuid)',
    'private.lesson_session_last_handover(uuid)',
    'private.lesson_session_follow_giver(uuid)',
    'private.google_meet_room_release_handover()',
    'private.lesson_session_left_schedule(uuid)',
    'private.reconcile_frozen_lesson_sessions(text,date,date,uuid)',
    'private.lesson_sessions_resync(text,uuid,date[])',
    'private.class_coverage_follow_lesson_session()',
    'private.reschedule_follow_lesson_session()',
    'private.lesson_advance_follow_lesson_session()'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
end
$grants$;
