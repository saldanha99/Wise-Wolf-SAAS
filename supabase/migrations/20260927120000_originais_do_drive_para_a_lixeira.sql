-- Originais das aulas no Google Drive vão para a LIXEIRA 90 dias depois da aula,
-- e a direção apaga os registros das aulas de um aluno a pedido dele (onda 2,
-- frente "retencao-drive", em cima do resumo automático 20260927110000).
--
-- Decisões da direção (26/09/2026):
--   * as cópias no sistema ficam 90 dias (retenção das cópias brutas, que já
--     existe em purge_expired_meet_artifacts — não mexida aqui);
--   * os ORIGINAIS no Google da escola — documento da transcrição, documento das
--     anotações do Gemini e planilha de presença — vão para a LIXEIRA do Drive da
--     conta central 90 dias depois da aula. Lixeira, não exclusão definitiva: o
--     Drive guarda 30 dias e a escola ainda recupera um arquivo apagado por engano;
--   * a direção pode apagar tudo de um aluno a pedido dele: cópias brutas,
--     rascunhos (e resumos), memória MEET_SESSION e o cartão do aluno, e os
--     originais entram na fila da lixeira na hora.
--
-- Regra de ouro: SÓ vai para a lixeira arquivo cujo id veio da Meet API
-- (docsDestination de transcrição e anotação) ou da planilha de presença que o
-- sistema guardou (meeting_attendance_reports). NUNCA se procura arquivo por NOME
-- para apagar. Antes de mover, a edge ainda confere arquivo a arquivo que ele é
-- da conta central (ownedByMe) e do tipo esperado (Documento/Planilha).
--
-- Peças:
--   1. private.google_meet_drive_originals — um registro por arquivo original
--      (só o id do Drive, nunca conteúdo), com prazo, resultado e tentativas;
--   2. private.google_meet_original_sessions — por aula: a lista dos documentos
--      já foi conferida na Meet API (discovered_at) e o pedido de exclusão
--      (records_erased_at bloqueia nova importação da aula);
--   3. private.student_lesson_record_erasures — trilha do pedido de exclusão:
--      quem, quando e contagens. Sem conteúdo;
--   4. registro dos originais: a planilha de presença por gatilho (qualquer
--      escritor), os documentos pela edge (register) e o que já existe no banco
--      (planilhas guardadas e revisões exportadas pelo Docs);
--   5. public.google_meet_originals_backend (só service_role, usado pela edge);
--   6. get_pending_google_meet_sync_sessions ganha a operação PURGE_ORIGINALS
--      (até 5 aulas por rodada) — remendo por ÂNCORA na definição viva, que
--      mantém a âncora para a próxima frente;
--   7. telas: situação da lixeira (direção, "Conta central Google") e o pedido
--      de exclusão na ficha do aluno (direção).
--
-- ⚠️ A Meet API guarda a conferência e os documentos dela por ~30 dias: a lista
-- de documentos de uma aula só pode ser conferida nesse prazo (28 dias, com
-- folga). A importação registra os documentos que vê; a fila confere de novo as
-- aulas que a importação não fechou (aceite revogado, importação vencida, pedido
-- de exclusão). Aula mais antiga que isso, sem registro, não é localizável — e
-- procurar por nome está proibido.
--
-- Re-executável: if not exists, drop/add constraint, create or replace, remendo
-- só quando a marca ainda não está na definição. Sem begin/commit. SECURITY
-- DEFINER nova: search_path = '' e dono postgres.

-- 1. Um registro por arquivo original ----------------------------------------------
create table if not exists private.google_meet_drive_originals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  lesson_session_id uuid not null,
  -- A conta Google que criou a sala: os documentos estão no Drive dela, e só
  -- ela consegue movê-los para a lixeira.
  organizer_sub text not null,
  file_id text not null,
  kind text not null,
  origin text not null,
  registered_at timestamptz not null default now(),
  trash_due_at timestamptz not null,
  status text not null default 'PENDING',
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  error_code text,
  finished_at timestamptz,
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id),
  unique (tenant_id, file_id)
);
alter table private.google_meet_drive_originals drop constraint if exists google_meet_drive_originals_file_check;
alter table private.google_meet_drive_originals add constraint google_meet_drive_originals_file_check
  check (file_id ~ '^[A-Za-z0-9_-]{1,200}$' and length(organizer_sub) between 1 and 255);
alter table private.google_meet_drive_originals drop constraint if exists google_meet_drive_originals_kind_check;
alter table private.google_meet_drive_originals add constraint google_meet_drive_originals_kind_check
  check (kind in ('TRANSCRIPT','SMART_NOTES','ATTENDANCE_REPORT')
    and origin in ('MEET_DOCS_DESTINATION','ATTENDANCE_REPORT_SAVED')
    and (origin = 'ATTENDANCE_REPORT_SAVED') = (kind = 'ATTENDANCE_REPORT'));
alter table private.google_meet_drive_originals drop constraint if exists google_meet_drive_originals_status_check;
alter table private.google_meet_drive_originals add constraint google_meet_drive_originals_status_check
  check (status in ('PENDING','TRASHED','GONE','REFUSED') and attempts >= 0
    and (status = 'PENDING') = (finished_at is null));
alter table private.google_meet_drive_originals drop constraint if exists google_meet_drive_originals_error_check;
alter table private.google_meet_drive_originals add constraint google_meet_drive_originals_error_check
  check (error_code is null or error_code ~ '^[a-z_]{1,80}$');
create index if not exists google_meet_drive_originals_session_idx
  on private.google_meet_drive_originals(lesson_session_id);
create index if not exists google_meet_drive_originals_due_idx
  on private.google_meet_drive_originals(trash_due_at) where status = 'PENDING';
create index if not exists google_meet_drive_originals_tenant_idx
  on private.google_meet_drive_originals(tenant_id, status);
alter table private.google_meet_drive_originals owner to postgres;
alter table private.google_meet_drive_originals enable row level security;
revoke all on private.google_meet_drive_originals from public, anon, authenticated, service_role;
comment on table private.google_meet_drive_originals is
  'Originais das aulas no Drive da conta central (transcrição, anotações, planilha de presença): só o id do arquivo, o prazo da lixeira (90 dias depois da aula, ou na hora num pedido de exclusão) e o resultado. PENDING → TRASHED | GONE (já não existia) | REFUSED (não é da conta central ou não é do tipo esperado).';

-- 2. Por aula: lista conferida e pedido de exclusão ----------------------------------
create table if not exists private.google_meet_original_sessions (
  lesson_session_id uuid primary key,
  tenant_id text not null references public.tenants(id),
  -- A lista de documentos da aula foi lida INTEIRA na Meet API e registrada.
  discovered_at timestamptz,
  discovery_attempts integer not null default 0,
  discovery_next_attempt_at timestamptz,
  discovery_error_code text,
  -- Pedido de exclusão da direção: os originais vencem na hora, e a aula não é
  -- mais importada nem resumida (gatilho lesson_records_erased).
  erasure_id uuid,
  erasure_requested_at timestamptz,
  records_erased_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id)
);
alter table private.google_meet_original_sessions drop constraint if exists google_meet_original_sessions_check;
alter table private.google_meet_original_sessions add constraint google_meet_original_sessions_check
  check (discovery_attempts >= 0
    and (discovery_error_code is null or discovery_error_code ~ '^[a-z_]{1,80}$'));
alter table private.google_meet_original_sessions owner to postgres;
alter table private.google_meet_original_sessions enable row level security;
revoke all on private.google_meet_original_sessions from public, anon, authenticated, service_role;
comment on table private.google_meet_original_sessions is
  'Por aula: a lista de documentos do Meet já foi conferida (discovered_at) e o pedido de exclusão da direção (records_erased_at bloqueia nova importação, rascunho e presença da aula).';

-- 3. Trilha do pedido de exclusão (sem conteúdo) ------------------------------------
create table if not exists private.student_lesson_record_erasures (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  -- Sem FK de propósito: a trilha sobrevive à remoção do perfil.
  student_id uuid not null,
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  sessions integer not null default 0,
  raw_copies_deleted integer not null default 0,
  attendance_reports_deleted integer not null default 0,
  summary_versions_deleted integer not null default 0,
  memories_deleted integer not null default 0,
  card_deleted boolean not null default false,
  originals_queued integer not null default 0,
  sessions_to_discover integer not null default 0
);
create index if not exists student_lesson_record_erasures_student_idx
  on private.student_lesson_record_erasures(tenant_id, student_id, requested_at desc);
alter table private.student_lesson_record_erasures owner to postgres;
alter table private.student_lesson_record_erasures enable row level security;
revoke all on private.student_lesson_record_erasures from public, anon, authenticated, service_role;
comment on table private.student_lesson_record_erasures is
  'Pedido de exclusão dos registros das aulas de um aluno (direção): quem pediu, quando e contagens do que foi apagado. Nunca conteúdo.';

-- A exclusão a pedido (dono postgres) apaga nas tabelas do Meet, que são do
-- supabase_admin. Só DELETE; a leitura o postgres já tem.
grant delete on private.meeting_artifact_revisions to postgres;
grant delete on private.lesson_summary_versions to postgres;
grant delete on private.google_meet_artifact_imports to postgres;
-- E encerra a importação da sala da aula apagada (sai da fila SYNC_ARTIFACTS).
grant update (sync_status, next_sync_at, sync_completed_at, last_error_code, updated_at)
  on private.google_meet_rooms to postgres;

-- 4. Réguas --------------------------------------------------------------------------
-- Prazos num lugar só.
create or replace function private.google_meet_originals_policy()
returns jsonb
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    -- Originais na lixeira: 90 dias depois do fim da aula (decisão da direção).
    'trash_after_days', 90,
    -- A Meet API guarda a conferência por ~30 dias: a lista dos documentos só é
    -- conferida até 28 dias depois da aula.
    'discovery_window_days', 28,
    -- Espera depois do fim da aula antes de conferir (o Google ainda gera).
    'discovery_delay_hours', 2
  );
$$;

create or replace function private.google_meet_session_records_erased(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.google_meet_original_sessions as state
    where state.lesson_session_id = p_session and state.records_erased_at is not null);
$$;

-- Prazo da lixeira de um original da aula: 90 dias depois do fim, ou o pedido de
-- exclusão, o que vier antes.
create or replace function private.google_meet_original_due_at(p_session uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
  select least(
    session.scheduled_end_at + pg_catalog.make_interval(
      days => (private.google_meet_originals_policy() ->> 'trash_after_days')::integer),
    state.erasure_requested_at)
  from public.lesson_sessions as session
  left join private.google_meet_original_sessions as state on state.lesson_session_id = session.id
  where session.id = p_session;
$$;

-- Registra UM original da aula. O mesmo arquivo nunca entra duas vezes (vale o
-- primeiro registro); um prazo mais cedo (pedido de exclusão) vence o anterior.
create or replace function private.google_meet_register_original(
  p_session uuid, p_file_id text, p_kind text, p_origin text, p_organizer_sub text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions%rowtype;
  v_existed boolean;
  v_due timestamptz;
begin
  select * into v_session from public.lesson_sessions where id = p_session;
  if v_session.id is null then
    raise exception 'lesson_session_not_found' using errcode = '22023';
  end if;
  if coalesce(p_file_id, '') !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'google_resource_invalid' using errcode = '22023';
  end if;
  if coalesce(p_organizer_sub, '') = '' then
    raise exception 'google_organizer_required' using errcode = '22023';
  end if;
  v_due := private.google_meet_original_due_at(v_session.id);
  select true into v_existed from private.google_meet_drive_originals as original
   where original.tenant_id = v_session.tenant_id and original.file_id = p_file_id;
  insert into private.google_meet_drive_originals as original
    (tenant_id, lesson_session_id, organizer_sub, file_id, kind, origin, trash_due_at)
  values (v_session.tenant_id, v_session.id, p_organizer_sub, p_file_id, p_kind, p_origin, v_due)
  on conflict (tenant_id, file_id) do update set trash_due_at = excluded.trash_due_at
    where original.status = 'PENDING' and excluded.trash_due_at < original.trash_due_at;
  return not coalesce(v_existed, false);
end;
$$;

-- A lista de documentos da aula precisa ser conferida na Meet API agora:
--   * a sala existe no Google (space_name) e a lista ainda não foi fechada;
--   * a aula acabou há 2+ h e há menos de 28 dias (a Meet API guarda ~30);
--   * a importação não vai fazer isso: terminou sem fechar (EXPIRED), a aula já
--     passou da janela de 7 dias, a aula está sem aceite efetivo (revogação:
--     o que o Google gerou antes nunca é importado), ou a direção pediu a
--     exclusão. Importação COMPLETE fecha a lista ela mesma (register).
create or replace function private.google_meet_original_discovery_due(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select room.space_name is not null
      and state.discovered_at is null
      and coalesce(state.discovery_next_attempt_at, '-infinity'::timestamptz) <= pg_catalog.now()
      and session.scheduled_end_at < pg_catalog.now()
        - pg_catalog.make_interval(hours => (config.policy ->> 'discovery_delay_hours')::integer)
      and session.scheduled_end_at > pg_catalog.now()
        - pg_catalog.make_interval(days => (config.policy ->> 'discovery_window_days')::integer)
      and (room.sync_status in ('COMPLETE','EXPIRED')
        or session.scheduled_end_at < pg_catalog.now() - interval '7 days'
        or not session.documentation_consent
        or private.lesson_session_documentation_blocked(session.id)
        or state.erasure_requested_at is not null)
    from public.lesson_sessions as session
    join private.google_meet_rooms as room
      on room.lesson_session_id = session.id and room.tenant_id = session.tenant_id
    left join private.google_meet_original_sessions as state on state.lesson_session_id = session.id
    cross join (select private.google_meet_originals_policy() as policy) as config
    where session.id = p_session
  ), false);
$$;

-- Originais da aula que já venceram e podem ser tentados agora (até 20).
create or replace function private.google_meet_original_files_due(p_session uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('file_id', due.file_id, 'kind', due.kind)
      order by due.trash_due_at, due.file_id), '[]'::jsonb)
  from (
    select original.file_id, original.kind, original.trash_due_at
    from private.google_meet_drive_originals as original
    where original.lesson_session_id = p_session and original.status = 'PENDING'
      and original.trash_due_at <= pg_catalog.now()
      and coalesce(original.next_attempt_at, '-infinity'::timestamptz) <= pg_catalog.now()
    order by original.trash_due_at, original.file_id
    limit 20
  ) as due;
$$;

-- Contagens do que existe hoje dos registros das aulas de um aluno (as aulas que
-- já começaram). A prévia da tela e a exclusão usam a mesma conta.
create or replace function private.student_lesson_records_counts(p_tenant text, p_student uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with scope as (
    select session.id, session.scheduled_end_at
    from public.lesson_sessions as session
    where session.tenant_id = p_tenant and session.student_id = p_student
      and session.scheduled_start_at <= pg_catalog.now()
  ), window_limit as (
    select pg_catalog.now() - pg_catalog.make_interval(
      days => (private.google_meet_originals_policy() ->> 'discovery_window_days')::integer) as since
  )
  select pg_catalog.jsonb_build_object(
    'sessions', (select pg_catalog.count(*) from scope),
    'raw_copies', (select pg_catalog.count(*) from private.meeting_artifact_revisions as revision
      join scope on scope.id = revision.lesson_session_id where revision.tenant_id = p_tenant),
    'attendance_reports', (select pg_catalog.count(*) from private.meeting_attendance_reports as report
      join scope on scope.id = report.lesson_session_id where report.tenant_id = p_tenant),
    'drafts', (select pg_catalog.count(*) from private.lesson_summary_versions as version
      join scope on scope.id = version.lesson_session_id
      where version.tenant_id = p_tenant and version.status <> 'VERIFIED'),
    'approved_summaries', (select pg_catalog.count(*) from private.lesson_summary_versions as version
      join scope on scope.id = version.lesson_session_id
      where version.tenant_id = p_tenant and version.status = 'VERIFIED'),
    'memories', (select pg_catalog.count(*) from public.student_learning_memories as memory
      where memory.tenant_id = p_tenant and memory.student_id = p_student and memory.source_type = 'MEET_SESSION'),
    'card', exists (select 1 from public.student_learning_cards as card
      where card.tenant_id = p_tenant and card.student_id = p_student),
    'originals_pending', (select pg_catalog.count(*) from private.google_meet_drive_originals as original
      join scope on scope.id = original.lesson_session_id where original.status = 'PENDING'),
    'originals_done', (select pg_catalog.count(*) from private.google_meet_drive_originals as original
      join scope on scope.id = original.lesson_session_id where original.status in ('TRASHED','GONE')),
    -- Salas cuja lista de documentos ainda não foi conferida: dentro da janela da
    -- Meet API a fila confere e manda para a lixeira; fora dela, não há como
    -- localizar sem procurar por nome (proibido) — a tela pede conferência manual.
    'rooms_to_discover', (select pg_catalog.count(*) from scope
      join private.google_meet_rooms as room on room.lesson_session_id = scope.id
      left join private.google_meet_original_sessions as state on state.lesson_session_id = scope.id
      where room.space_name is not null and state.discovered_at is null
        and scope.scheduled_end_at > (select since from window_limit)),
    'rooms_beyond_window', (select pg_catalog.count(*) from scope
      join private.google_meet_rooms as room on room.lesson_session_id = scope.id
      left join private.google_meet_original_sessions as state on state.lesson_session_id = scope.id
      where room.space_name is not null and state.discovered_at is null
        and scope.scheduled_end_at <= (select since from window_limit))
  );
$$;

-- 5. Gatilhos --------------------------------------------------------------------------
-- Planilha de presença guardada pelo sistema = original registrado, venha de onde
-- vier a gravação. O dono é a conta que criou a sala (a importação só lê a
-- planilha com a conta central que criou a sala).
create or replace function private.meeting_attendance_reports_register_originals()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sub text;
  v_file text;
begin
  select room.organizer_sub into v_sub from private.google_meet_rooms as room
   where room.lesson_session_id = new.lesson_session_id and room.tenant_id = new.tenant_id;
  if v_sub is null then
    return null;
  end if;
  for v_file in
    select distinct candidate.file_id
    from pg_catalog.unnest(array[new.document_id] || coalesce(new.source_document_ids, '{}'::text[])) as candidate(file_id)
    where coalesce(candidate.file_id, '') <> ''
  loop
    perform private.google_meet_register_original(new.lesson_session_id, v_file, 'ATTENDANCE_REPORT',
      'ATTENDANCE_REPORT_SAVED', v_sub);
  end loop;
  return null;
end;
$$;
drop trigger if exists trg_zz_meeting_attendance_reports_originals on private.meeting_attendance_reports;
create trigger trg_zz_meeting_attendance_reports_originals
  after insert on private.meeting_attendance_reports
  for each row execute function private.meeting_attendance_reports_register_originals();

-- Aula apagada a pedido não volta: nem cópia bruta, nem planilha de presença,
-- nem rascunho/resumo — venha da fila, do botão "Importar" ou do resumo por IA.
create or replace function private.lesson_records_erased_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.google_meet_session_records_erased(new.lesson_session_id) then
    raise exception 'lesson_records_erased' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_aa_lesson_records_erased_guard on private.meeting_artifact_revisions;
create trigger trg_aa_lesson_records_erased_guard
  before insert on private.meeting_artifact_revisions
  for each row execute function private.lesson_records_erased_guard();
drop trigger if exists trg_aa_lesson_records_erased_guard on private.meeting_attendance_reports;
create trigger trg_aa_lesson_records_erased_guard
  before insert on private.meeting_attendance_reports
  for each row execute function private.lesson_records_erased_guard();
drop trigger if exists trg_aa_lesson_records_erased_guard on private.lesson_summary_versions;
create trigger trg_aa_lesson_records_erased_guard
  before insert on private.lesson_summary_versions
  for each row execute function private.lesson_records_erased_guard();

-- 6. Porta da edge (só service_role) ----------------------------------------------------
-- Ações:
--   session_state   — sala, se a lista precisa ser conferida, se a aula foi
--                     apagada a pedido e os originais vencidos (até 20);
--   register        — documentos com id da Meet API (docsDestination), SÓ da
--                     conta que criou a sala; discovered = lista fechada;
--   discovery_failed — a conferência falhou ou o Google ainda gera: nova
--                     tentativa em 1 h, dobrando até 24 h;
--   defer           — a lixeira está desligada nesta instalação: os vencidos
--                     esperam sem gastar tentativa;
--   file_result     — resultado de UM arquivo: TRASHED, GONE (404 ou já na
--                     lixeira), REFUSED (não é da conta central / tipo errado) ou
--                     FAILED (tenta de novo em 1 h, dobrando até 24 h; não desiste).
create or replace function public.google_meet_originals_backend(
  p_action text, p_tenant_id text, p_session_id uuid, p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.lesson_sessions%rowtype;
  r private.google_meet_rooms%rowtype;
  o private.google_meet_drive_originals%rowtype;
  v_file jsonb;
  v_count integer := 0;
  v_result text;
  v_code text;
  v_minutes integer;
begin
  if coalesce(p_tenant_id, '') = '' then
    raise exception 'tenant_scope_required' using errcode = '22023';
  end if;
  select * into s from public.lesson_sessions where id = p_session_id and tenant_id = p_tenant_id;
  if s.id is null then
    raise exception 'lesson_session_not_found' using errcode = '22023';
  end if;
  select * into r from private.google_meet_rooms where lesson_session_id = s.id and tenant_id = s.tenant_id;
  v_code := case when coalesce(p_payload ->> 'error_code', '') ~ '^[a-z_]{1,80}$' then p_payload ->> 'error_code' end;

  if p_action = 'session_state' then
    return pg_catalog.jsonb_build_object(
      'session', pg_catalog.jsonb_build_object('class_date', s.class_date, 'scheduled_end_at', s.scheduled_end_at),
      'room', case when r.lesson_session_id is null then null
        else pg_catalog.jsonb_build_object('space_name', r.space_name, 'organizer_sub', r.organizer_sub) end,
      'discovery_needed', private.google_meet_original_discovery_due(s.id),
      'records_erased', private.google_meet_session_records_erased(s.id),
      'files_due', private.google_meet_original_files_due(s.id));

  elsif p_action = 'register' then
    if r.lesson_session_id is null or r.space_name is null then
      raise exception 'google_room_not_found' using errcode = '22023';
    end if;
    -- Os documentos da sala estão no Drive da conta que a criou: registro vindo
    -- de outra conta não é desta sala.
    if (p_payload ->> 'organizer_sub') is distinct from r.organizer_sub then
      raise exception 'google_organizer_changed' using errcode = '42501';
    end if;
    if pg_catalog.jsonb_typeof(coalesce(p_payload -> 'files', '[]'::jsonb)) <> 'array'
      or pg_catalog.jsonb_array_length(coalesce(p_payload -> 'files', '[]'::jsonb)) > 50 then
      raise exception 'invalid_request' using errcode = '22023';
    end if;
    for v_file in select value from pg_catalog.jsonb_array_elements(coalesce(p_payload -> 'files', '[]'::jsonb)) loop
      -- Planilha de presença entra só pelo registro guardado (gatilho acima).
      if (v_file ->> 'kind') is null or (v_file ->> 'kind') not in ('TRANSCRIPT','SMART_NOTES') then
        raise exception 'google_original_kind_invalid' using errcode = '22023';
      end if;
      if private.google_meet_register_original(s.id, v_file ->> 'file_id', v_file ->> 'kind',
        'MEET_DOCS_DESTINATION', r.organizer_sub) then
        v_count := v_count + 1;
      end if;
    end loop;
    if coalesce((p_payload ->> 'discovered')::boolean, false) then
      insert into private.google_meet_original_sessions as state
        (lesson_session_id, tenant_id, discovered_at, updated_at)
      values (s.id, s.tenant_id, pg_catalog.now(), pg_catalog.now())
      on conflict (lesson_session_id) do update set discovered_at = pg_catalog.now(),
        discovery_error_code = null, discovery_next_attempt_at = null, updated_at = pg_catalog.now();
    end if;
    return pg_catalog.jsonb_build_object('registered', v_count,
      'files_due', private.google_meet_original_files_due(s.id));

  elsif p_action = 'discovery_failed' then
    insert into private.google_meet_original_sessions as state
      (lesson_session_id, tenant_id, discovery_attempts, discovery_error_code, discovery_next_attempt_at, updated_at)
    values (s.id, s.tenant_id, 1, coalesce(v_code, 'google_original_discovery_failed'),
      pg_catalog.now() + interval '1 hour', pg_catalog.now())
    on conflict (lesson_session_id) do update set
      discovery_attempts = state.discovery_attempts + 1,
      discovery_error_code = coalesce(v_code, 'google_original_discovery_failed'),
      discovery_next_attempt_at = pg_catalog.now()
        + least(interval '24 hours', interval '1 hour' * pg_catalog.power(2, least(state.discovery_attempts, 5))::integer),
      updated_at = pg_catalog.now();
    return pg_catalog.jsonb_build_object('ok', true);

  elsif p_action = 'defer' then
    v_minutes := greatest(15, least(1440, coalesce(nullif(p_payload ->> 'minutes', '')::integer, 360)));
    update private.google_meet_drive_originals as original
       set next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(mins => v_minutes),
           error_code = coalesce(v_code, original.error_code)
     where original.lesson_session_id = s.id and original.tenant_id = s.tenant_id
       and original.status = 'PENDING' and original.trash_due_at <= pg_catalog.now();
    get diagnostics v_count = row_count;
    return pg_catalog.jsonb_build_object('deferred', v_count);

  elsif p_action = 'file_result' then
    v_result := p_payload ->> 'result';
    if v_result is null or v_result not in ('TRASHED','GONE','REFUSED','FAILED') then
      raise exception 'invalid_original_result' using errcode = '22023';
    end if;
    update private.google_meet_drive_originals as original set
      status = case when v_result = 'FAILED' then 'PENDING' else v_result end,
      attempts = original.attempts + 1,
      last_attempt_at = pg_catalog.now(),
      error_code = case when v_result = 'TRASHED' then null
        else coalesce(v_code, case when v_result = 'FAILED' then 'google_drive_trash_failed' end) end,
      next_attempt_at = case when v_result = 'FAILED'
        then pg_catalog.now() + least(interval '24 hours', interval '1 hour' * pg_catalog.power(2, least(original.attempts, 5))::integer)
        else null end,
      finished_at = case when v_result = 'FAILED' then null else pg_catalog.now() end
    where original.lesson_session_id = s.id and original.tenant_id = s.tenant_id
      and original.file_id = p_payload ->> 'file_id' and original.status = 'PENDING'
    returning * into o;
    if o.id is null then
      raise exception 'google_original_not_found' using errcode = '22023';
    end if;
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (s.tenant_id, null, s.id, 'DRIVE_ORIGINAL_' || v_result);
    return pg_catalog.jsonb_build_object('status', o.status, 'attempts', o.attempts,
      'next_attempt_at', o.next_attempt_at, 'error_code', o.error_code);
  end if;
  raise exception 'unknown_originals_action' using errcode = '22023';
end;
$$;

-- 7. Telas -------------------------------------------------------------------------------
-- Situação da lixeira dos originais, para a direção ("Conta central Google").
create or replace function public.get_meet_originals_retention_status()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_connection private.google_workspace_connections%rowtype;
begin
  if (select auth.uid()) is null or v_tenant is null or public._my_role() is distinct from 'SCHOOL_ADMIN' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into v_connection from private.google_workspace_connections where tenant_id = v_tenant;
  return (
    select pg_catalog.jsonb_build_object(
      'ok', true,
      'trash_after_days', (private.google_meet_originals_policy() ->> 'trash_after_days')::integer,
      -- A conta central autorizou mover para a lixeira (escopo drive).
      'drive_delete_ready', coalesce(v_connection.status = 'CONNECTED'
        and 'https://www.googleapis.com/auth/drive' = any (v_connection.granted_scopes), false),
      'waiting', pg_catalog.count(*) filter (where original.status = 'PENDING' and original.trash_due_at > pg_catalog.now()),
      'next_due_at', pg_catalog.min(original.trash_due_at)
        filter (where original.status = 'PENDING' and original.trash_due_at > pg_catalog.now()),
      'due', pg_catalog.count(*) filter (where original.status = 'PENDING' and original.trash_due_at <= pg_catalog.now()),
      'failing', pg_catalog.count(*) filter (where original.status = 'PENDING' and original.attempts > 0),
      'last_error_code', (select latest.error_code from private.google_meet_drive_originals as latest
        where latest.tenant_id = v_tenant and latest.status = 'PENDING' and latest.error_code is not null
        order by coalesce(latest.last_attempt_at, latest.registered_at) desc limit 1),
      -- Originais de uma conta central anterior: só ela consegue movê-los.
      'other_account', pg_catalog.count(*) filter (where original.status = 'PENDING'
        and v_connection.tenant_id is not null
        and original.organizer_sub is distinct from v_connection.organizer_sub),
      'trashed', pg_catalog.count(*) filter (where original.status = 'TRASHED'),
      'gone', pg_catalog.count(*) filter (where original.status = 'GONE'),
      'refused', pg_catalog.count(*) filter (where original.status = 'REFUSED'),
      'last_trashed_at', pg_catalog.max(original.finished_at) filter (where original.status = 'TRASHED'),
      'erasures', (select pg_catalog.count(*) from private.student_lesson_record_erasures as erasure
        where erasure.tenant_id = v_tenant),
      'last_erasure_at', (select pg_catalog.max(erasure.requested_at) from private.student_lesson_record_erasures as erasure
        where erasure.tenant_id = v_tenant))
    from private.google_meet_drive_originals as original
    where original.tenant_id = v_tenant
  );
end;
$$;

-- Prévia do pedido de exclusão: o que existe hoje e o que vai acontecer.
create or replace function public.get_student_lesson_records_erasure_preview(p_student_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_student public.profiles%rowtype;
begin
  if (select auth.uid()) is null or v_tenant is null or public._my_role() is distinct from 'SCHOOL_ADMIN' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into v_student from public.profiles where id = p_student_id;
  if v_student.id is null or v_student.role is distinct from 'STUDENT' or v_student.tenant_id is distinct from v_tenant then
    raise exception 'aluno_nao_encontrado' using errcode = '22023';
  end if;
  return private.student_lesson_records_counts(v_tenant, v_student.id) || pg_catalog.jsonb_build_object(
    'ok', true,
    'drive_delete_ready', exists (select 1 from private.google_workspace_connections as connection
      where connection.tenant_id = v_tenant and connection.status = 'CONNECTED'
        and 'https://www.googleapis.com/auth/drive' = any (connection.granted_scopes)),
    'last_erasure_at', (select pg_catalog.max(erasure.requested_at) from private.student_lesson_record_erasures as erasure
      where erasure.tenant_id = v_tenant and erasure.student_id = v_student.id));
end;
$$;

-- Apaga os registros das aulas do aluno (as que já começaram), a pedido dele:
--   * cópias brutas (transcrição e anotações importadas), planilhas de presença
--     guardadas e a situação de cada documento;
--   * rascunhos e resumos de todas as versões (o aprovado também: é o mesmo
--     texto que alimentava a memória);
--   * memória de origem MEET_SESSION e o cartão do aluno (o histórico do cartão
--     ganha a linha da remoção, sem texto, com o papel DIRECTION_ERASURE);
--   * os originais no Drive vencem NA HORA (a fila manda para a lixeira) e as
--     salas ainda na janela da Meet API têm a lista de documentos conferida;
--   * as aulas ficam marcadas: nada delas volta a ser importado nem resumido.
-- Não mexe em presença lançada, pagamento, casos de qualidade nem na trilha do
-- aceite (é registro legal da decisão). Aulas futuras seguem o aceite vigente.
create or replace function public.erase_student_lesson_records(p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_tenant text := public._my_tenant_id();
  v_student public.profiles%rowtype;
  v_erasure uuid := gen_random_uuid();
  v_now timestamptz := pg_catalog.now();
  v_sessions uuid[];
  v_raw integer := 0;
  v_attendance integer := 0;
  v_versions integer := 0;
  v_memories integer := 0;
  v_card_version integer;
  v_queued integer := 0;
  v_discover integer := 0;
begin
  if v_uid is null or v_tenant is null or public._my_role() is distinct from 'SCHOOL_ADMIN' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into v_student from public.profiles where id = p_student_id;
  if v_student.id is null or v_student.role is distinct from 'STUDENT' or v_student.tenant_id is distinct from v_tenant then
    raise exception 'aluno_nao_encontrado' using errcode = '22023';
  end if;
  -- Dois cliques simultâneos não se atropelam.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('student-lesson-records-erasure:' || v_student.id::text, 0));

  select coalesce(pg_catalog.array_agg(session.id), '{}'::uuid[]) into v_sessions
  from public.lesson_sessions as session
  where session.tenant_id = v_tenant and session.student_id = v_student.id
    and session.scheduled_start_at <= v_now;

  -- Marca antes de apagar: nada dessas aulas volta pela importação.
  insert into private.google_meet_original_sessions as state
    (lesson_session_id, tenant_id, erasure_id, erasure_requested_at, records_erased_at, updated_at)
  select session_id, v_tenant, v_erasure, v_now, v_now, v_now
  from pg_catalog.unnest(v_sessions) as session_id
  on conflict (lesson_session_id) do update set erasure_id = excluded.erasure_id,
    erasure_requested_at = excluded.erasure_requested_at, records_erased_at = excluded.records_erased_at,
    -- Conferência que estava esperando nova tentativa roda já.
    discovery_next_attempt_at = null, updated_at = excluded.updated_at;
  -- A importação dessas aulas acaba aqui: a sala sai da fila SYNC_ARTIFACTS (e
  -- do "Importar documentos pendentes"). Sem fonte, o resumo automático também
  -- não é oferecido. O gatilho lesson_records_erased barra o que escapar.
  update private.google_meet_rooms as room
     set sync_status = 'EXPIRED', next_sync_at = null,
         sync_completed_at = coalesce(room.sync_completed_at, v_now),
         last_error_code = 'lesson_records_erased', updated_at = v_now
   where room.lesson_session_id = any (v_sessions) and room.tenant_id = v_tenant
     and room.sync_status in ('WAITING','PENDING');

  delete from private.meeting_artifact_revisions as revision
   where revision.tenant_id = v_tenant and revision.lesson_session_id = any (v_sessions);
  get diagnostics v_raw = row_count;
  delete from private.google_meet_artifact_imports as import
   where import.tenant_id = v_tenant and import.lesson_session_id = any (v_sessions);
  delete from private.meeting_attendance_reports as report
   where report.tenant_id = v_tenant and report.lesson_session_id = any (v_sessions);
  get diagnostics v_attendance = row_count;
  delete from private.lesson_summary_versions as version
   where version.tenant_id = v_tenant and version.lesson_session_id = any (v_sessions);
  get diagnostics v_versions = row_count;
  delete from public.student_learning_memories as memory
   where memory.tenant_id = v_tenant and memory.student_id = v_student.id and memory.source_type = 'MEET_SESSION';
  get diagnostics v_memories = row_count;
  delete from public.student_learning_cards as card
   where card.tenant_id = v_tenant and card.student_id = v_student.id
  returning card.version into v_card_version;
  if v_card_version is not null then
    insert into private.student_learning_card_events
      (tenant_id, student_id, actor_id, actor_role, card_version, changed_fields)
    values (v_tenant, v_student.id, v_uid, 'DIRECTION_ERASURE', v_card_version,
      array['real_goal', 'engaging_topics', 'correction_style', 'avoid_topics', 'notes']::text[]);
  end if;

  -- Originais já registrados: vencem agora (a fila manda para a lixeira).
  update private.google_meet_drive_originals as original
     set trash_due_at = least(original.trash_due_at, v_now), next_attempt_at = null
   where original.tenant_id = v_tenant and original.lesson_session_id = any (v_sessions)
     and original.status = 'PENDING';
  get diagnostics v_queued = row_count;
  -- Salas cuja lista ainda será conferida na Meet API (dentro da janela).
  select pg_catalog.count(*)::integer into v_discover
  from private.google_meet_rooms as room
  join public.lesson_sessions as session on session.id = room.lesson_session_id
  left join private.google_meet_original_sessions as state on state.lesson_session_id = room.lesson_session_id
  where room.lesson_session_id = any (v_sessions) and room.space_name is not null
    and state.discovered_at is null
    and session.scheduled_end_at > v_now - pg_catalog.make_interval(
      days => (private.google_meet_originals_policy() ->> 'discovery_window_days')::integer);

  insert into private.student_lesson_record_erasures (id, tenant_id, student_id, requested_by, requested_at,
    sessions, raw_copies_deleted, attendance_reports_deleted, summary_versions_deleted, memories_deleted,
    card_deleted, originals_queued, sessions_to_discover)
  values (v_erasure, v_tenant, v_student.id, v_uid, v_now, pg_catalog.cardinality(v_sessions), v_raw, v_attendance,
    v_versions, v_memories, v_card_version is not null, v_queued, v_discover);
  insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
  values (v_tenant, v_uid, null, 'STUDENT_LESSON_RECORDS_ERASED');

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'erasure_id', v_erasure,
    'sessions', pg_catalog.cardinality(v_sessions),
    'raw_copies_deleted', v_raw,
    'attendance_reports_deleted', v_attendance,
    'summary_versions_deleted', v_versions,
    'memories_deleted', v_memories,
    'card_deleted', v_card_version is not null,
    'originals_queued', v_queued,
    'sessions_to_discover', v_discover);
end;
$$;

-- 8. Donos e permissões ------------------------------------------------------------------
do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.google_meet_originals_policy()',
    'private.google_meet_session_records_erased(uuid)',
    'private.google_meet_original_due_at(uuid)',
    'private.google_meet_register_original(uuid,text,text,text,text)',
    'private.google_meet_original_discovery_due(uuid)',
    'private.google_meet_original_files_due(uuid)',
    'private.student_lesson_records_counts(text,uuid)',
    'private.meeting_attendance_reports_register_originals()',
    'private.lesson_records_erased_guard()'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  alter function public.google_meet_originals_backend(text, text, uuid, jsonb) owner to postgres;
  revoke all on function public.google_meet_originals_backend(text, text, uuid, jsonb) from public, anon, authenticated;
  grant execute on function public.google_meet_originals_backend(text, text, uuid, jsonb) to service_role;
  foreach v_signature in array array[
    'public.get_meet_originals_retention_status()',
    'public.get_student_lesson_records_erasure_preview(uuid)',
    'public.erase_student_lesson_records(uuid)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end
$owners$;

-- 9. O que já está no banco vira registro ----------------------------------------------
-- Planilhas de presença guardadas e documentos exportados pelo Docs (source
-- DRIVE_EXPORT: o document_id É o docsDestination). Transcrição montada pelas
-- falas (MEET_ENTRIES) fica de fora: sem documento, o document_id é o nome do
-- artefato, não um arquivo do Drive — a conferência da fila acha o documento, se
-- houver. Re-executável: arquivo já registrado não muda.
do $backfill$
declare
  v_row record;
begin
  for v_row in
    select distinct report.lesson_session_id, candidate.file_id, room.organizer_sub
    from private.meeting_attendance_reports as report
    join private.google_meet_rooms as room
      on room.lesson_session_id = report.lesson_session_id and room.tenant_id = report.tenant_id
    cross join lateral pg_catalog.unnest(array[report.document_id] || coalesce(report.source_document_ids, '{}'::text[]))
      as candidate(file_id)
    where coalesce(candidate.file_id, '') <> ''
  loop
    perform private.google_meet_register_original(v_row.lesson_session_id, v_row.file_id, 'ATTENDANCE_REPORT',
      'ATTENDANCE_REPORT_SAVED', v_row.organizer_sub);
  end loop;
  for v_row in
    select distinct on (revision.document_id) revision.lesson_session_id, revision.document_id, revision.kind,
      room.organizer_sub
    from private.meeting_artifact_revisions as revision
    join private.google_meet_rooms as room
      on room.lesson_session_id = revision.lesson_session_id and room.tenant_id = revision.tenant_id
    where revision.source = 'DRIVE_EXPORT'
    order by revision.document_id, revision.imported_at
  loop
    perform private.google_meet_register_original(v_row.lesson_session_id, v_row.document_id, v_row.kind,
      'MEET_DOCS_DESTINATION', v_row.organizer_sub);
  end loop;
end
$backfill$;

-- 10. Fila: PURGE_ORIGINALS ------------------------------------------------------------
-- Remendo por âncora na definição viva (a de 20260926180000 com o ramo
-- GENERATE_SUMMARY de 20260927110000, e o que outras frentes acrescentarem),
-- com a MESMA âncora do resumo, que continua valendo depois deste remendo para a
-- próxima frente: PURGE_ORIGINALS — até 5 aulas por rodada, grupo 4 (3 quando é
-- pedido de exclusão), da conta central que criou a sala e SÓ quando ela
-- autorizou a lixeira (escopo drive; a flag GOOGLE_MEET_DELETE_ORIGINALS_ENABLED
-- é que pede esse escopo): originais vencidos ou lista de documentos a conferir
-- na Meet API. Sem a lixeira ligada, nada disso chama o Google.
-- (Aula apagada a pedido sai de SYNC_ARTIFACTS porque a exclusão encerra a
-- importação da sala — sync_status EXPIRED —, e de GENERATE_SUMMARY porque fica
-- sem fonte; o gatilho lesson_records_erased barra o resto.)
do $patch_queue$
declare
  v_def text;
  v_anchor constant text := E'(\\)\\s+jobs\\s+order\\s+by\\s+jobs\\.priority_group)';
  v_branch constant text := E'union all\n'
    || E'      -- Originais no Drive da conta central (20260927120000): lixeira dos\n'
    || E'      -- vencidos (90 dias depois da aula ou pedido de exclusão) e conferência\n'
    || E'      -- da lista de documentos na Meet API. Até 5 aulas por rodada.\n'
    || E'      (select room.tenant_id,conn.connected_by,room.lesson_session_id,''PURGE_ORIGINALS'',\n'
    || E'         case when state.erasure_requested_at is not null then 3 else 4 end,\n'
    || E'         coalesce(due.first_due,sess.scheduled_end_at)\n'
    || E'       from private.google_meet_rooms room\n'
    || E'       join public.lesson_sessions sess on sess.id=room.lesson_session_id and sess.tenant_id=room.tenant_id\n'
    || E'       join private.google_workspace_connections conn on conn.tenant_id=room.tenant_id and conn.organizer_sub=room.organizer_sub\n'
    || E'       join public.profiles adm on adm.id=conn.connected_by\n'
    || E'       left join private.google_meet_original_sessions state on state.lesson_session_id=room.lesson_session_id\n'
    || E'       left join lateral (select min(original.trash_due_at) as first_due\n'
    || E'         from private.google_meet_drive_originals original\n'
    || E'         where original.lesson_session_id=room.lesson_session_id and original.status=''PENDING''\n'
    || E'           and original.trash_due_at<=now()\n'
    || E'           and coalesce(original.next_attempt_at,''-infinity''::timestamptz)<=now()) due on true\n'
    || E'       where conn.status=''CONNECTED''\n'
    || E'         -- Só com a lixeira autorizada pela conta central (escopo drive).\n'
    || E'         and ''https://www.googleapis.com/auth/drive''=any(conn.granted_scopes)\n'
    || E'         and lower(coalesce(adm.lifecycle_status,''''))=''active'' and adm.role in (''SCHOOL_ADMIN'',''SUPER_ADMIN'')\n'
    || E'         and (adm.tenant_id=conn.tenant_id or adm.role=''SUPER_ADMIN'')\n'
    || E'         and (due.first_due is not null\n'
    || E'           -- pré-filtro barato (a régua é a função): sala no Google e aula\n'
    || E'           -- dentro da janela da Meet API.\n'
    || E'           or (room.space_name is not null and sess.scheduled_end_at>now()-interval ''28 days''\n'
    || E'             and private.google_meet_original_discovery_due(room.lesson_session_id)))\n'
    || E'       order by 5,6 limit 5)\n    ';
begin
  v_def := pg_catalog.pg_get_functiondef('public.get_pending_google_meet_sync_sessions()'::regprocedure);
  if strpos(v_def, 'PURGE_ORIGINALS') > 0 then
    return;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.regexp_matches(v_def, v_anchor, 'g')) <> 1 then
    raise exception 'âncora da fila do Meet (") jobs order by jobs.priority_group") não encontrada uma única vez';
  end if;
  execute pg_catalog.regexp_replace(v_def, v_anchor, v_branch || E'\\1');
end
$patch_queue$;
