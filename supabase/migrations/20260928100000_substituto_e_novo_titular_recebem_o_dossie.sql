-- Substituto e novo titular recebem o que precisam (onda 3 do Meet, 28/09/2026).
--
-- Decisões da direção:
--   * o SUBSTITUTO recebe o dossiê do aluno por LINK COM LOGIN, válido do dia
--     anterior ao dia seguinte da aula coberta — nunca texto pessoal no
--     WhatsApp dele;
--   * na transferência DEFINITIVA o novo titular recebe o mesmo link.
--
-- O que muda:
--
-- 1. Acesso com prazo (private.pedagogy_temporary_access). O dossiê
--    (get_student_handover), a lista de sessões (get_lesson_sessions), a RLS de
--    lesson_sessions/lesson_occurrences e a leitura do resumo APROVADO da aula
--    (google_meet_backend → session_detail) passam a abrir o aluno também para
--      (a) o substituto de cobertura CONFIRMADA daquele aluno, e
--      (b) o professor da reposição COM DATA marcada com ele,
--    do dia anterior ao dia seguinte da aula. É a mesma janela que o Planner já
--    usa (private.planner_student_access, 20260927130000). Reposição parada em
--    'Pendente' não abre nada, nem reposição encerrada pela direção
--    (closed_reason) — o "acesso fantasma" de 20260923130000 não volta por
--    aqui. Cobertura pendente, recusada ou cancelada também não.
--    A transcrição bruta continua só com quem deu a aula (v_raw de
--    session_detail, regra da onda 1): o substituto de uma sessão que ficou com
--    o titular lê só o resumo aprovado. No google_meet_backend a janela vale
--    SÓ para session_detail — nenhuma outra ação (sala, importação, resumo) se
--    abre por ela — e quem entra SÓ pela janela (v_temporary_only) recebe o
--    detalhe sem a sala (link do Meet, conta Google do professor da aula, conta
--    central), sem a situação da importação e sem a contagem de planilhas de
--    presença: a janela é para ler o dossiê e o resumo aprovado, não para
--    entrar na sala do titular nem conhecer a conta Google dele.
--    O CARTÃO do aluno o substituto lê pelo dossiê, mas não escreve: escrever
--    continua com quem acompanha o aluno (titular, segundo professor, agenda
--    viva, transferência aceita, coordenação e direção) —
--    private.student_learning_card_can_edit usa o acesso SEM a janela.
--
-- 2. Pacote da cobertura (public.coverage_briefing_enqueue, recriada a partir
--    da definição viva — 20260917200000 + o remendo por âncora do canal de
--    coordenação de 20260918100000, mantido). Os quatro caminhos já passam por
--    ela ou passam a passar: accept-coverage e "consigo sim" pelo WhatsApp
--    (resolve_coverage_invite_and_brief), claim-coverage e, agora, o modo
--    "force" do coverage-admin. Além do contato e das últimas aulas:
--      (a) a DATA da ÚLTIMA aula com resumo APROVADO (student_learning_memories
--          MEET_SESSION VERIFIED — a memória que a última decisão humana deixa
--          valer, 20260927130000) e o aviso de que o próximo passo, os erros
--          recorrentes e a lição dela estão no dossiê. O TEXTO do resumo não vai
--          no WhatsApp (correção da revisão): o termo v3 que aluno e família
--          aceitaram diz que o substituto recebe o histórico "por um link que
--          só abre com login", o RIPD não põe o resumo no provedor do WhatsApp,
--          e toda mensagem enviada fica copiada na fila (notification_queue), no
--          espelho da inbox (whatsapp_messages), no provedor e no celular do
--          substituto — cópias que a exclusão a pedido
--          (erase_student_lesson_records), a retenção
--          (purge_lesson_memory_retention) e a rejeição posterior do resumo
--          (20260927130000) não alcançam;
--      (b) o link da SALA OFICIAL quando a aula tem sala pronta que vale para
--          quem dá a aula (public.official_lesson_link, régua única
--          private.lesson_occurrence_giver). A família recebe o mesmo link em
--          vez de "a substituta vai te chamar para combinar o link". Sem sala
--          pronta no aceite (as salas nascem nas 24 h antes da aula), o texto
--          sai pela previsão de private.coverage_school_room_expected (escola
--          conectada ao Google, conta Google confirmada do substituto, aceite
--          do termo do aluno e do substituto, aula não congelada com outro
--          professor): com sala prevista, substituto e família ouvem que o link
--          da escola chega por aqui e que não se manda outro — senão a aula
--          acabava dividida em duas salas; sem sala prevista, "combine e mande
--          o link" como antes. Quando a sala fica pronta depois do aceite, um
--          gatilho em private.google_meet_rooms manda o link a substituto e
--          família (private.coverage_room_notice_enqueue, uma vez por AULA e
--          substituto, com o horário da aula);
--      (c) o LINK COM LOGIN do dossiê: <portal>/dossie-do-aluno?aluno=<id> (o
--          portal é o de private.lesson_recording_portal_url; escola sem
--          portal conhecido recebe o caminho no app);
--      (d) AULA DE 1 H (correção da integração): são dois agendamentos de 30
--          min, cada um com a SUA cobertura (em produção, 16:30 e 17:00
--          confirmadas com a mesma substituta em 16/09 e 18/09). O pacote é
--          decidido pela aula (private.coverage_lesson_parts), não pela
--          cobertura: enquanto uma parte não está confirmada com o mesmo
--          substituto, o texto não promete nem nega a sala da escola (a sala
--          depende de a aula inteira ser dele) e diz qual parte é dele; quando a
--          última parte é confirmada, sai UMA mensagem da aula inteira
--          (coverage-lesson:<cobertura da 1ª parte>) — a atualização curta
--          quando uma parte já tinha sido avisada. Antes, cada metade mandava o
--          seu pacote: "combine e mande o link" numa e "o link chega por aqui"
--          na outra, e dois avisos de sala com horários diferentes.
--    Dado pessoal NÃO vai em texto: o cartão do aluno e o objetivo livre do
--    cadastro (learning_objective) saíram da mensagem — ficam no dossiê. Nome
--    do responsável também saiu (a mensagem só diz que há responsável).
--    A frase ao grupo deixa de dizer que o substituto "recebeu o contato"
--    quando ele não tem WhatsApp no cadastro e o pacote não sai.
--
-- 3. Transferência definitiva: gatilho em teacher_transfers. Quando a
--    transferência vira ACEITA ou APLICADA (o que vier primeiro), o novo
--    titular recebe pela instância central, na notification_queue (o teto e o
--    aquecimento do WhatsApp valem por cima), o link com login do dossiê —
--    idempotente por transferência (teacher-transfer:<id>:dossier). Cobre os
--    três caminhos: admin_transfer_student_teacher (nasce APPLIED), a
--    transferência com aceite do professor (create_teacher_transfer e o
--    "transferencia_professor" do grupo da Gestão → respond_teacher_transfer
--    → ACCEPTED → apply_teacher_transfer → APPLIED). É gatilho, e não remendo
--    em cada função, para valer para qualquer escritor. Falha no aviso nunca
--    derruba a transferência.
--    E conserta a transferência direta, que recusava toda chamada desde
--    22/09/2026 (o gatilho bookings_sync_student_primary_teacher de
--    20260922040028 já gravava o professor novo no perfil antes da trava da
--    função) — remendo por âncora em admin_transfer_student_teacher.
--
-- Re-executável: create or replace, drop trigger if exists, remendo por
-- âncora que se reconhece aplicado. Sem begin/commit.

-- ---------------------------------------------------------------------------
-- 1. Acesso com prazo: cobertura confirmada e reposição com data
-- ---------------------------------------------------------------------------
create or replace function private.pedagogy_temporary_access(
  p_tenant text,
  p_teacher uuid,
  p_student uuid,
  p_local_date date
)
returns table (access_reason text, valid_from date, valid_until date)
language sql
stable
security definer
set search_path = ''
as $function$
  select grant_row.access_reason, grant_row.valid_from, grant_row.valid_until
  from (
    -- Substituto: cobertura CONFIRMADA deste aluno com este professor.
    select 'COVERAGE'::text as access_reason,
           coverage.class_date - 1 as valid_from,
           coverage.class_date + 1 as valid_until
    from public.class_coverages as coverage
    where coverage.tenant_id = p_tenant
      and coverage.student_id = p_student
      and coverage.cover_teacher_id = p_teacher
      and pg_catalog.lower(coalesce(coverage.status, '')) = 'confirmed'
      and coverage.class_date between p_local_date - 1 and p_local_date + 1

    union all
    -- Reposição COM DATA marcada com este professor. 'Pendente' (sem data) e
    -- data inválida viram nulo e ficam de fora; encerrada pela direção também.
    select 'RESCHEDULE'::text,
           dated.lesson_date - 1,
           dated.lesson_date + 1
    from (
      select public.parse_lesson_date(reschedule.date) as lesson_date
      from public.reschedules as reschedule
      where reschedule.tenant_id = p_tenant
        and reschedule.student_id = p_student
        and reschedule.teacher_id = p_teacher
        and reschedule.closed_reason is null
    ) as dated
    where dated.lesson_date between p_local_date - 1 and p_local_date + 1
  ) as grant_row
  where p_tenant is not null
    and p_teacher is not null
    and p_student is not null
    and p_local_date is not null
  order by grant_row.valid_until desc, grant_row.access_reason;
$function$;

alter function private.pedagogy_temporary_access(text, uuid, uuid, date) owner to postgres;
revoke all on function private.pedagogy_temporary_access(text, uuid, uuid, date)
  from public, anon, authenticated, service_role;

comment on function private.pedagogy_temporary_access(text, uuid, uuid, date) is
  'Dossiê/resumo aprovado com prazo: cobertura confirmada ou reposição com data do professor com o aluno, do dia anterior ao seguinte da aula (a mesma janela do Planner). Reposição sem data, encerrada, e cobertura não confirmada não abrem nada.';

-- A regra do dossiê num lugar só. p_include_temporary = false é o acesso de
-- quem acompanha o aluno (escreve o cartão); true soma a janela do substituto
-- e da reposição (lê o dossiê e o resumo aprovado).
create or replace function private.student_pedagogy_access(
  p_tenant text,
  p_student uuid,
  p_include_temporary boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null and p_tenant = public._my_tenant_id()
    and exists (
      select 1
      from public.profiles as actor
      join public.tenant_memberships as membership
        on membership.user_id = actor.id and membership.tenant_id = p_tenant
      where actor.id = auth.uid()
        and pg_catalog.lower(actor.lifecycle_status) = 'active'
        and membership.status = 'ACTIVE'
    )
    and exists (
      select 1 from public.profiles as subject
      where subject.id = p_student and subject.tenant_id = p_tenant and subject.role = 'STUDENT'
    )
    and (
      private.can_manage_lesson_quality(p_tenant)
      or exists (
        select 1 from public.profiles as p
        where p.id = p_student and p.tenant_id = p_tenant
          and (p.professor_id = auth.uid() or p.professor_id2 = auth.uid()
               or exists (
                 select 1 from public.bookings as b
                 where b.tenant_id = p_tenant and b.student_id = p_student
                   and b.teacher_id = auth.uid() and b.status = 'SCHEDULED'
               ))
          and public._my_role() = 'TEACHER'
      )
      or exists (
        select 1 from public.teacher_transfers as t
        where t.tenant_id = p_tenant and t.student_id = p_student
          and t.to_teacher_id = auth.uid() and t.status in ('PENDING', 'ACCEPTED')
      )
      or (
        coalesce(p_include_temporary, false)
        and public._my_role() = 'TEACHER'
        and exists (
          select 1
          from private.pedagogy_temporary_access(
            p_tenant, auth.uid(), p_student,
            (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
          )
        )
      )
    );
$function$;

alter function private.student_pedagogy_access(text, uuid, boolean) owner to postgres;
revoke all on function private.student_pedagogy_access(text, uuid, boolean)
  from public, anon, authenticated, service_role;

-- Mesma assinatura e mesmos privilégios: a RLS de lesson_sessions e de
-- lesson_occurrences, get_lesson_sessions, ensure_lesson_session e
-- get_student_handover passam a enxergar a janela sem serem recriadas.
create or replace function private.can_read_student_pedagogy(p_tenant text, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.student_pedagogy_access(p_tenant, p_student, true);
$function$;

alter function private.can_read_student_pedagogy(text, uuid) owner to postgres;
revoke all on function private.can_read_student_pedagogy(text, uuid) from public, anon;
grant execute on function private.can_read_student_pedagogy(text, uuid) to authenticated;

-- O substituto lê o cartão pelo dossiê, mas não o reescreve.
create or replace function private.student_learning_card_can_edit(p_tenant text, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null
    and coalesce(public._my_role(), '') in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR')
    and private.student_pedagogy_access(p_tenant, p_student, false);
$function$;

alter function private.student_learning_card_can_edit(text, uuid) owner to postgres;
revoke all on function private.student_learning_card_can_edit(text, uuid)
  from public, anon, authenticated, service_role;

-- session_detail (a tela "Sala e resumo"): o substituto e o professor da
-- reposição leem o resumo APROVADO das aulas do aluno na janela. Remendo por
-- âncora na definição viva (a função é grande e outras frentes a remendam),
-- em quatro pontos, todos conferidos antes de trocar qualquer um:
--   1. a declaração ganha v_temporary_only e v_session_detail;
--   2. o escopo do aluno: quem não alcança a sessão por vínculo permanente mas
--      tem a janela entra SÓ em session_detail, marcado v_temporary_only;
--   3. e 4. o retorno de session_detail passa por v_session_detail, e para
--      quem entrou só pela janela sai sem a sala (meeting_uri, space_name,
--      cohost_email = conta Google do professor da aula, organizer_sub = conta
--      central), sem a situação da importação e sem a contagem de planilhas de
--      presença. Correção da revisão: a janela abria a sala de QUALQUER sessão
--      do aluno — inclusive a próxima aula do titular — e a conta Google dele.
do $meet_session_detail$
declare
  v_def text;
  v_anchors text[] := array[
    $anchor$v_raw boolean := false;$anchor$,
    $anchor$    ) then raise exception 'google_meet_student_scope_required' using errcode='42501'; end if;$anchor$,
    $anchor$      return jsonb_build_object('session',to_jsonb(s)||jsonb_build_object('documentation_consent',v_consent,
          'documentation_blocked',s.documentation_consent and not v_consent),
        'raw_access',v_raw,$anchor$,
    $anchor$              and newer.status='REJECTED')))),'[]'::jsonb));
    else raise exception 'unknown_google_meet_action' using errcode='22023'; end if;$anchor$
  ];
  v_patches text[] := array[
    $patch$v_raw boolean := false; v_temporary_only boolean := false; v_session_detail jsonb;$patch$,
    $patch$    ) then
      -- Substituto de cobertura confirmada e professor da reposição com data
      -- (private.pedagogy_temporary_access, 20260928100000): do dia anterior ao
      -- seguinte da aula, SÓ a leitura do resumo aprovado (session_detail) — sem
      -- a sala, a importação e a presença de uma aula que não é dele
      -- (v_temporary_only). A transcrição segue com quem deu a aula (v_raw) e
      -- nenhuma outra ação se abre por aqui.
      if p_action = 'session_detail' and exists (
        select 1 from private.pedagogy_temporary_access(
          s.tenant_id, a.id, s.student_id, (now() at time zone 'America/Sao_Paulo')::date)) then
        v_temporary_only := true;
      else
        raise exception 'google_meet_student_scope_required' using errcode='42501';
      end if;
    end if;$patch$,
    $patch$      v_session_detail := jsonb_build_object('session',to_jsonb(s)||jsonb_build_object('documentation_consent',v_consent,
          'documentation_blocked',s.documentation_consent and not v_consent),
        'raw_access',v_raw,$patch$,
    $patch$              and newer.status='REJECTED')))),'[]'::jsonb));
      -- Leitor só pela janela temporária (20260928100000): a sala (link do Meet,
      -- conta Google do professor da aula, conta central), a situação da
      -- importação e as planilhas de presença são de quem dá aquela aula.
      if v_temporary_only then
        v_session_detail := v_session_detail || jsonb_build_object(
          'room', null, 'imports', '[]'::jsonb, 'attendance_saved_reports', 0);
      end if;
      return v_session_detail || jsonb_build_object('temporary_access', v_temporary_only);
    else raise exception 'unknown_google_meet_action' using errcode='22023'; end if;$patch$
  ];
  v_position integer;
begin
  v_def := pg_catalog.pg_get_functiondef(
    'public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure);
  if pg_catalog.strpos(v_def, 'v_temporary_only') > 0 then
    return;
  end if;
  for i in 1 .. pg_catalog.array_length(v_anchors, 1) loop
    v_position := pg_catalog.strpos(v_def, v_anchors[i]);
    if v_position = 0 then
      raise exception 'google_meet_backend: âncora % da janela do substituto não encontrada', i;
    end if;
    if pg_catalog.strpos(pg_catalog.substr(v_def, v_position + 1), v_anchors[i]) > 0 then
      raise exception 'google_meet_backend: âncora % da janela do substituto repetida', i;
    end if;
  end loop;
  for i in 1 .. pg_catalog.array_length(v_anchors, 1) loop
    v_def := pg_catalog.replace(v_def, v_anchors[i], v_patches[i]);
  end loop;
  execute v_def;
end;
$meet_session_detail$;

-- ---------------------------------------------------------------------------
-- 2. Pacote da cobertura
-- ---------------------------------------------------------------------------
-- Texto de uma linha só (memória e lançamentos podem ter quebra de linha).
create or replace function private.briefing_line(p_text text, p_limit integer)
returns text
language sql
immutable
set search_path = ''
as $function$
  select nullif(
    pg_catalog.left(
      pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_text, '')), '\s+', ' ', 'g'),
      greatest(coalesce(p_limit, 0), 1)
    ),
    ''
  );
$function$;

alter function private.briefing_line(text, integer) owner to postgres;
revoke all on function private.briefing_line(text, integer) from public, anon, authenticated, service_role;

-- As partes da aula a que a cobertura pertence. Aula de 1 h são dois
-- agendamentos de 30 min seguidos do mesmo aluno com o mesmo professor, e cada
-- um tem a SUA cobertura. Partes = os agendamentos do aluno com o professor da
-- agenda da cobertura que valem na data (public.booking_schedule_on_date, a
-- régua das sessões), em sequência de 30 em 30 min com o da cobertura; para
-- cada parte, a cobertura viva dela com o MESMO substituto (ou null). O
-- agendamento da cobertura que não vale na data é uma aula de uma parte só.
create or replace function private.coverage_lesson_parts(p_coverage_id uuid)
returns table (part_booking_id uuid, part_start_time time, part_coverage_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  with coverage as (
    select c.id, c.tenant_id, c.student_id, c.booking_id, c.class_date, c.class_time, c.cover_teacher_id,
      booking.teacher_id as scheduled_teacher_id
      from public.class_coverages as c
      join public.bookings as booking on booking.id = c.booking_id and booking.tenant_id = c.tenant_id
     where c.id = p_coverage_id
  ), slots as (
    select distinct on (slot.start_time) booking.id as booking_id, slot.start_time
      from coverage
      join public.bookings as booking
        on booking.tenant_id = coverage.tenant_id
       and booking.student_id = coverage.student_id
       and booking.teacher_id = coverage.scheduled_teacher_id
       and pg_catalog.upper(coalesce(booking.status, 'SCHEDULED')) = 'SCHEDULED'
      cross join lateral (select public.booking_schedule_on_date(booking.id, coverage.class_date) as schedule) as day
      cross join lateral (
        select case when day.schedule ->> 'time_slot' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                    then (day.schedule ->> 'time_slot')::time end as start_time
      ) as slot
     where coalesce((day.schedule ->> 'valid')::boolean, false)
       and not coalesce((day.schedule ->> 'excluded')::boolean, false)
       and slot.start_time is not null
     order by slot.start_time, (booking.id = coverage.booking_id) desc, booking.id
  ), runs as (
    -- Ilhas de horários de 30 em 30 min (mesmo número = mesma aula).
    select slots.booking_id, slots.start_time,
      slots.start_time - interval '30 minutes' * pg_catalog.row_number() over (order by slots.start_time) as run
      from slots
  ), lesson as (
    select runs.booking_id, runs.start_time
      from runs
     where runs.run = (select mine.run from runs as mine join coverage on coverage.booking_id = mine.booking_id)
    union all
    select coverage.booking_id,
      case when pg_catalog.left(coalesce(coverage.class_time, ''), 5) ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           then pg_catalog.left(coverage.class_time, 5)::time end
      from coverage
     where not exists (select 1 from runs join coverage as own on own.booking_id = runs.booking_id)
  )
  select lesson.booking_id, lesson.start_time, mine.id
    from lesson
    cross join coverage
    left join lateral (
      select other.id
        from public.class_coverages as other
       where other.tenant_id = coverage.tenant_id
         and other.booking_id = lesson.booking_id
         and other.class_date = coverage.class_date
         and other.cover_teacher_id = coverage.cover_teacher_id
         and pg_catalog.lower(coalesce(other.status, '')) in ('confirmed', 'scheduled', 'completed')
       order by (other.id = coverage.id) desc, other.confirmed_at desc nulls last, other.id
       limit 1
    ) as mine on true;
$function$;

alter function private.coverage_lesson_parts(uuid) owner to postgres;
revoke all on function private.coverage_lesson_parts(uuid) from public, anon, authenticated, service_role;

-- A escola vai criar a sala do Meet desta aula coberta para o SUBSTITUTO?
-- Previsão para o texto do aceite quando a sala ainda não está pronta (ela
-- nasce nas 24 h antes da aula, depois que o job de 15 min marca o aceite
-- — private.apply_standing_lesson_recording_consent — e a fila cria a sala
-- com o professor da sessão de coanfitrião). As mesmas condições:
--   * escola com a conta central do Google conectada;
--   * substituto com a conta Google confirmada por login (sem ela, sem sala —
--     google_teacher_identity_required);
--   * aceite do termo do aluno E do substituto valendo
--     (private.lesson_recording_active, a régua do job);
--   * aula não congelada com OUTRO professor: sessão daquela ocorrência com
--     aceite ou sala (private.lesson_session_has_evidence) fica com quem ela
--     tinha, e a sala, se houver, é do titular — o substituto não entra nela
--     (private.lesson_session_taught_by_other), então ele manda o link dele.
-- Previsão errada para o lado do "vai ter sala" é coberta no texto (sem link até
-- 30 min antes, o substituto manda o dele); para o outro lado, pelo aviso de
-- sala pronta (private.coverage_room_notice_enqueue).
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
      and exists (
        select 1 from private.teacher_google_identities as google_identity
         where google_identity.teacher_id = coverage.cover_teacher_id
           and google_identity.tenant_id = coverage.tenant_id)
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
           and session.teacher_id is distinct from coverage.cover_teacher_id
           and private.lesson_session_has_evidence(session.id))
    from public.class_coverages as coverage
   where coverage.id = p_coverage_id
  ), false);
$function$;

alter function private.coverage_school_room_expected(uuid) owner to postgres;
revoke all on function private.coverage_school_room_expected(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.coverage_briefing_enqueue(p_coverage_id uuid, p_notify_group boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c public.class_coverages%rowtype;
  v_student public.profiles%rowtype;
  v_cover public.profiles%rowtype;
  v_original public.profiles%rowtype;
  v_director uuid;
  v_time text;
  v_when text;
  v_duration int := 30;
  v_student_phone text;
  v_cover_phone text;
  v_lessons text := '';
  v_level text;
  v_line text;
  v_r record;
  v_briefing text;
  v_family text;
  v_group text;
  v_group_jid text;
  v_first_cover text;
  v_first_original text;
  v_first_student text;
  v_queued jsonb := '[]'::jsonb;
  v_id uuid;
  v_scheduled_teacher uuid;
  v_room text;
  v_room_expected boolean := false;
  v_portal text;
  v_dossier text;
  v_window text;
  v_memory_at timestamptz;
  v_approved text := '';
  v_day text;
  v_parts integer;
  v_mine integer;
  v_lesson_start time;
  v_lesson_end time;
  v_first_part_coverage uuid;
  v_multi boolean := false;
  v_complete boolean := true;
  v_update boolean := false;
  v_room_undecided boolean := false;
  v_key text;
  v_range text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select * into c from public.class_coverages where id = p_coverage_id;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'cobertura_nao_encontrada'); end if;
  if lower(coalesce(c.status, '')) <> 'confirmed' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'cobertura_nao_confirmada', 'status', c.status);
  end if;
  select * into v_student from public.profiles where id = c.student_id;
  select * into v_cover from public.profiles where id = c.cover_teacher_id;
  select * into v_original from public.profiles where id = c.original_teacher_id;
  v_director := private.management_group_default_actor(c.tenant_id);
  if v_director is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_diretor_ativo');
  end if;

  v_time := left(coalesce(c.class_time, ''), 5);
  v_day := format('%s %s', private.weekday_label_pt(c.class_date), to_char(c.class_date, 'DD/MM'));
  v_when := format('%s às %s', v_day, v_time);
  v_first_cover := split_part(btrim(coalesce(v_cover.full_name, 'Professor')), ' ', 1);
  v_first_original := split_part(btrim(coalesce(v_original.full_name, 'professor')), ' ', 1);
  v_first_student := split_part(btrim(coalesce(v_student.full_name, 'aluno')), ' ', 1);

  -- A aula, não a cobertura (correção da integração): aula de 1 h são dois
  -- agendamentos de 30 min, cada um com a sua cobertura. Enquanto uma parte
  -- não está com este substituto, o pacote fala só da parte dele e não decide a
  -- sala; confirmada a última parte, sai uma mensagem da aula inteira.
  select pg_catalog.count(*)::integer, pg_catalog.count(part.part_coverage_id)::integer,
         pg_catalog.min(part.part_start_time), pg_catalog.max(part.part_start_time) + interval '30 minutes',
         (pg_catalog.array_agg(part.part_coverage_id order by part.part_start_time))[1]
    into v_parts, v_mine, v_lesson_start, v_lesson_end, v_first_part_coverage
    from private.coverage_lesson_parts(c.id) as part;
  v_multi := coalesce(v_parts, 0) > 1;
  v_complete := not v_multi or v_mine = v_parts;
  v_key := format('coverage:%s', c.id);
  if v_multi then
    v_range := format('%s–%s', to_char(v_lesson_start, 'HH24:MI'), to_char(v_lesson_end, 'HH24:MI'));
  end if;
  if v_multi and v_complete then
    v_key := format('coverage-lesson:%s', v_first_part_coverage);
    v_when := format('%s às %s', v_day, to_char(v_lesson_start, 'HH24:MI'));
    v_duration := v_parts * 30;
    -- Uma parte já tinha sido avisada quando a aula ainda não era toda dele:
    -- sai só a atualização (contato, últimas aulas e dossiê já foram).
    v_update := exists (
      select 1
        from private.coverage_lesson_parts(c.id) as part
        join public.notification_queue as q
          on q.tenant_id = c.tenant_id
         and q.idempotency_key = format('coverage:%s:briefing', part.part_coverage_id));
  end if;

  -- Nível: `profiles.level` é o da gamificação (XP), não serve. O que vale é
  -- a última avaliação que um professor registrou na aula.
  select l.assessment_level into v_level from public.class_logs l
   where l.student_id = c.student_id and nullif(btrim(l.assessment_level), '') is not null
   order by l.class_date desc nulls last, l.created_at desc limit 1;

  -- Últimas aulas registradas (o que foi feito e o que ficou para a próxima).
  -- Aula de 1 h vira dois lançamentos iguais (dois bookings): linha repetida
  -- é pulada.
  for v_r in
    select l.class_date, l.content, l.next_content, l.content_covered, l.homework_assigned, l.recommended_next_step
      from public.class_logs l
     where l.student_id = c.student_id
       and coalesce(l.content, l.content_covered, l.next_content, l.recommended_next_step) is not null
     order by l.class_date desc nulls last, l.created_at desc
     limit 3
  loop
    v_line := format('• %s: %s', to_char(v_r.class_date, 'DD/MM'),
      coalesce(private.briefing_line(coalesce(nullif(v_r.content, ''), nullif(v_r.content_covered, '')), 160), '—'));
    if coalesce(nullif(v_r.next_content, ''), nullif(v_r.recommended_next_step, '')) is not null then
      v_line := v_line || format(' → próx.: %s', private.briefing_line(coalesce(nullif(v_r.next_content, ''), v_r.recommended_next_step), 120));
    end if;
    if nullif(v_r.homework_assigned, '') is not null then
      v_line := v_line || format(' (lição: %s)', private.briefing_line(v_r.homework_assigned, 80));
    end if;
    if v_lessons not like '%' || v_line || '%' then
      v_lessons := v_lessons || v_line || E'\n';
    end if;
  end loop;

  -- (a) A última aula com resumo APROVADO pelo professor (memória MEET_SESSION
  -- VERIFIED — aprovado e depois rejeitado já saiu daqui, 20260927130000).
  -- Só a DATA vai no texto; o próximo passo, os erros recorrentes e a lição
  -- ficam no dossiê, atrás do login. O termo v3 promete o histórico ao
  -- substituto "por um link que só abre com login", e o que sai no WhatsApp
  -- fica na fila, no espelho da inbox, no provedor e no celular dele — cópias
  -- que a exclusão a pedido, a retenção e a rejeição posterior do resumo não
  -- alcançam (correção da revisão).
  select m.occurred_at into v_memory_at
    from public.student_learning_memories m
   where m.tenant_id = c.tenant_id and m.student_id = c.student_id
     and m.source_type = 'MEET_SESSION' and m.verification_status = 'VERIFIED'
     and (nullif(pg_catalog.btrim(coalesce(m.recommended_next_step, '')), '') is not null
       or nullif(pg_catalog.btrim(coalesce(m.homework_assigned, '')), '') is not null
       or coalesce(pg_catalog.cardinality(m.recurring_errors), 0) > 0)
   order by m.occurred_at desc nulls last, m.updated_at desc
   limit 1;
  if found then
    v_approved := format(E'📝 Última aula com resumo aprovado: %s — o próximo passo, os erros recorrentes e a lição estão no dossiê do aluno (abaixo).\n',
      coalesce(to_char(v_memory_at at time zone 'America/Sao_Paulo', 'DD/MM'), 'sem data'));
  end if;

  -- (b) Sala oficial: só a que vale para QUEM DÁ a aula (a régua única de
  -- official_lesson_link / private.lesson_occurrence_giver). O professor da
  -- agenda é o do agendamento hoje; sessão congelada com o titular não vale.
  if c.booking_id is not null then
    select b.teacher_id into v_scheduled_teacher
      from public.bookings b where b.id = c.booking_id and b.tenant_id = c.tenant_id;
    begin
      v_room := public.official_lesson_link(
        c.tenant_id, 'booking', c.booking_id::text, c.class_date,
        coalesce(v_scheduled_teacher, c.original_teacher_id),
        case when v_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_time::time end,
        c.student_id);
    exception when others then v_room := null; end;
  end if;
  -- Sem sala pronta ainda (ela nasce nas 24 h antes da aula): se a escola vai
  -- criar uma para quem dá a aula, substituto e família não combinam outro
  -- link — senão a aula acaba em duas salas. O link chega depois, pelo gatilho
  -- de private.google_meet_rooms (private.coverage_room_notice_enqueue).
  -- Aula de mais de uma parte com parte que não é deste substituto: a sala
  -- depende do resto (aula dividida entre professores não tem sala da escola;
  -- toda dele, tem) — o texto não promete nem nega.
  if v_room is null then
    if v_multi and not v_complete then
      v_room_undecided := true;
    else
      begin
        v_room_expected := private.coverage_school_room_expected(c.id);
      exception when others then v_room_expected := false; end;
    end if;
  end if;

  -- (c) Dossiê por link com login (nunca o conteúdo no WhatsApp).
  v_portal := private.lesson_recording_portal_url(c.tenant_id);
  if v_portal is not null then
    v_dossier := v_portal || '/dossie-do-aluno?aluno=' || c.student_id::text;
  end if;
  v_window := format('de %s a %s', to_char(c.class_date - 1, 'DD/MM'), to_char(c.class_date + 1, 'DD/MM'));

  v_student_phone := private.whatsapp_digits(coalesce(nullif(v_student.attendance_phone, ''), nullif(v_student.phone, ''), nullif(v_student.guardian_phone, '')));
  v_cover_phone := private.whatsapp_digits(coalesce(nullif(v_cover.attendance_phone, ''), nullif(v_cover.phone, '')));

  if v_update then
    -- Última parte de uma aula de que uma parte já foi avisada: só o que mudou.
    v_briefing := format(E'Olá %s! 🐺 Cobertura confirmada também para a parte das %s: a aula de *%s* de %s (%s, %s min) agora é toda sua.\n',
        v_first_cover, v_time, btrim(coalesce(v_student.full_name, 'Aluno')), v_day, v_range, v_duration)
      || case when v_room is not null
           then format(E'🎥 Sala da escola no Google Meet: %s — a aula é nela, não mande outro link.\n', v_room)
           when v_room_expected
           then E'🎥 A aula terá sala da escola no Google Meet: o link chega por aqui quando a sala ficar pronta (até 24 h antes da aula) e aparece no app. Não mande outro link; se ele não chegar até 30 min antes da aula, combine com o aluno e mande o seu.\n'
           else E'🎥 A aula não terá sala da escola: combine com o aluno e mande o link da aula.\n' end
      || E'📂 Contato do aluno, últimas aulas e dossiê: na mensagem anterior sobre esta aula.\n'
      || format(E'\nA aula conta no seu pagamento: depois de dar, lance as %s partes em *Lançar Aula*. Dúvida, responda por aqui.', v_parts);
  else
    v_briefing := format(E'Olá %s! 🐺 Cobertura confirmada:\n\n👤 *%s* (aluno de %s)\n', v_first_cover,
        btrim(coalesce(v_student.full_name, 'Aluno')), v_first_original)
      || case when v_multi and not v_complete
           then format(E'📅 %s · 30 min — esta parte é sua; a aula completa é de %s min (%s) e o restante ainda não está confirmado com você.\n',
                  v_when, v_parts * 30, v_range)
           else format(E'📅 %s · %s min\n', v_when, v_duration) end
      || case when v_room is not null
           then format(E'🎥 Sala da escola no Google Meet: %s — a aula é nela, não mande outro link.\n', v_room)
           when v_room_expected
           then E'🎥 A aula terá sala da escola no Google Meet: o link chega por aqui quando a sala ficar pronta (até 24 h antes da aula) e aparece no app. Não mande outro link; se ele não chegar até 30 min antes da aula, combine com o aluno e mande o seu.\n'
           when v_room_undecided
           then E'🎥 Link da aula: enquanto o restante da aula não estiver confirmado com você, não dá para saber se ela será na sala da escola. Se o link da escola não chegar por aqui até 30 min antes da aula, combine com o aluno e mande o seu.\n'
           else '' end
      || case when v_student_phone is not null
           then format(E'📱 Contato: wa.me/%s%s — %s\n', v_student_phone,
                       case when v_student.guardian_id is not null or nullif(btrim(coalesce(v_student.guardian_name, '')), '') is not null
                            then ' (aluno com responsável)' else '' end,
                       case when v_room is not null or v_room_expected or v_room_undecided then 'se precisar combinar algo antes da aula.'
                            else 'combine direto e mande o link da aula.' end)
           else E'📱 Contato: sem WhatsApp no cadastro — peça à coordenação.\n' end
      || case when v_level is not null then format(E'🎯 Nível: %s\n', btrim(v_level)) else '' end
      || case when v_student.is_kids then E'🧒 Aluno kids — material Kids na biblioteca.\n' else '' end
      || v_approved
      || case when v_lessons <> '' then E'📚 Últimas aulas:\n' || v_lessons else E'📚 Sem registro de aula anterior — comece por diagnóstico e conversa.\n' end
      || case when v_dossier is not null
           then format(E'📂 Dossiê do aluno (objetivo, cartão e histórico) — entre com o seu login: %s\nO link vale %s.\n', v_dossier, v_window)
           else format(E'📂 Dossiê do aluno (objetivo, cartão e histórico): no app, em *Salas e continuidade* → *Dossiê do aluno*, %s.\n', v_window) end
      || E'\nA aula conta no seu pagamento: depois de dar, lance em *Lançar Aula*. Dúvida, responda por aqui.';
  end if;

  v_family := case
      when v_multi and not v_complete
      then format('Oi, %s! 🐺 Na aula de %s, a parte das %s será com a Teacher %s, no lugar de %s. ',
             v_first_student, v_day, v_time, v_first_cover, v_first_original)
      when v_multi
      then format('Oi, %s! 🐺 A aula de %s (%s min) será com a Teacher %s, no lugar de %s. ',
             v_first_student, v_when, v_duration, v_first_cover, v_first_original)
      else format('Oi, %s! 🐺 A aula de %s será com a Teacher %s, no lugar de %s. ',
             v_first_student, v_when, v_first_cover, v_first_original) end
    || case when v_room is not null
         then format('A aula continua na sala da escola no Google Meet: %s', v_room)
         when v_room_expected
         then format('A aula será na sala da escola no Google Meet: o link chega por aqui antes do horário. Se ele não chegar até 30 min antes, %s te chama pelo WhatsApp.', v_first_cover)
         when v_room_undecided
         then format('O link da aula chega por aqui antes do horário; se não chegar até 30 min antes, %s te chama pelo WhatsApp.', v_first_cover)
         else format('%s vai te chamar pelo WhatsApp para combinar o link.', v_first_cover) end
    || ' Qualquer dúvida, é só responder aqui.';

  v_group := case
      when v_multi and not v_complete
      then format('✅ *Cobertura aceita:* %s dá a parte das %s da aula de *%s* em %s (de %s); a aula vai de %s e o restante ainda não está com %s. ',
             v_first_cover, v_time, btrim(coalesce(v_student.full_name, 'aluno')), v_day, v_first_original, v_range, v_first_cover)
      when v_multi
      then format('✅ *Cobertura aceita:* %s dá a aula inteira de *%s* em %s · %s min (de %s). ',
             v_first_cover, btrim(coalesce(v_student.full_name, 'aluno')), v_when, v_duration, v_first_original)
      else format('✅ *Cobertura aceita:* %s dá a aula de *%s* em %s (de %s). ',
             v_first_cover, btrim(coalesce(v_student.full_name, 'aluno')), v_when, v_first_original) end
    || case when v_cover_phone is not null
         then format('%s recebe no WhatsApp o pacote da aula (contato, últimas aulas e link do dossiê)', v_first_cover)
         else format('⚠️ %s NÃO recebe o pacote (sem WhatsApp no cadastro): mande o contato do aluno e peça para abrir o dossiê em Salas e continuidade', v_first_cover) end
    || case when v_student_phone is not null then '; a família foi avisada.'
            else '; a família NÃO foi avisada (sem WhatsApp no cadastro).' end;

  if v_cover_phone is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
        source_type, class_date, notification_kind, idempotency_key)
    values (c.tenant_id, v_director, v_cover.full_name, v_cover_phone, v_briefing, pg_catalog.now(), 'pending',
        'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', v_key || ':briefing')
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into v_id;
    if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('briefing'::text); end if;
  end if;
  v_id := null;
  if v_student_phone is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
        source_type, class_date, notification_kind, idempotency_key)
    values (c.tenant_id, v_director, v_student.full_name, v_student_phone, v_family, pg_catalog.now(), 'pending',
        'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', v_key || ':family')
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into v_id;
    if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('family'::text); end if;
  end if;
  v_id := null;
  if p_notify_group then
    v_group_jid := private.tenant_notice_destination(c.tenant_id, 'coordenacao');
    if v_group_jid is not null then
      insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
          source_type, class_date, notification_kind, idempotency_key)
      values (c.tenant_id, v_director, 'Gestão', v_group_jid, v_group, pg_catalog.now(), 'pending',
          'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', v_key || ':group')
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
      returning id into v_id;
      if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('group'::text); end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'queued', v_queued, 'student_phone_known', v_student_phone is not null,
    'cover_phone_known', v_cover_phone is not null, 'briefing', v_briefing,
    'approved_lesson', v_approved <> '', 'official_room', v_room is not null,
    'school_room_expected', v_room_expected, 'dossier_url', v_dossier,
    'lesson_parts', greatest(coalesce(v_parts, 0), 1), 'lesson_complete', v_complete,
    'room_undecided', v_room_undecided, 'lesson_update', v_update, 'idempotency_prefix', v_key);
end
$function$;

alter function public.coverage_briefing_enqueue(uuid, boolean) owner to postgres;
revoke all on function public.coverage_briefing_enqueue(uuid, boolean) from public, anon, authenticated;
grant execute on function public.coverage_briefing_enqueue(uuid, boolean) to service_role;

-- A sala da escola ficou pronta DEPOIS do aceite: o link vai ao substituto e à
-- família (instância central, notification_queue — o teto do WhatsApp vale por
-- cima), UMA vez por aula e substituto. A aula é a sessão da ocorrência (aula de
-- 1 h = uma sessão com as duas partes, cada uma com a sua cobertura): a chave é
-- a da cobertura da primeira parte que é dele (coverage:<id>:room e
-- coverage:<id>:room-family) e o horário é o do início da aula — antes saía um
-- aviso por cobertura, com o horário de cada metade. Só a sala que vale para
-- quem dá a aula (official_lesson_link: régua única, aceite efetivo), só para
-- aula que ainda não começou, e só a quem recebeu um pacote desta aula sem esse
-- link — quem aceitou com a sala pronta, ou já recebeu o aviso, já a tem.
create or replace function private.coverage_room_notice_enqueue(p_coverage_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  c public.class_coverages%rowtype;
  v_student public.profiles%rowtype;
  v_cover public.profiles%rowtype;
  v_session public.lesson_sessions%rowtype;
  v_director uuid;
  v_scheduled_teacher uuid;
  v_time text;
  v_start_time time;
  v_when text;
  v_room text;
  v_coverages uuid[];
  v_first uuid;
  v_cover_packaged boolean := false;
  v_cover_has_link boolean := false;
  v_family_packaged boolean := false;
  v_family_informed boolean := false;
  v_family_phone text;
  v_family_has_link boolean;
  v_phone text;
  v_first_cover text;
  v_first_student text;
  v_queued jsonb := '[]'::jsonb;
  v_id uuid;
begin
  select * into c from public.class_coverages where id = p_coverage_id;
  if not found or pg_catalog.lower(coalesce(c.status, '')) <> 'confirmed' or c.booking_id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'cobertura_sem_sala');
  end if;
  v_time := pg_catalog.left(coalesce(c.class_time, ''), 5);
  if v_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    v_start_time := v_time::time;
  end if;

  select b.teacher_id into v_scheduled_teacher
    from public.bookings b where b.id = c.booking_id and b.tenant_id = c.tenant_id;
  v_room := public.official_lesson_link(
    c.tenant_id, 'booking', c.booking_id::text, c.class_date,
    coalesce(v_scheduled_teacher, c.original_teacher_id), v_start_time, c.student_id);
  if v_room is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_sala_para_quem_da_a_aula');
  end if;

  -- A aula (sessão) desta parte.
  select session.* into v_session
    from public.lesson_occurrences as occurrence
    join public.lesson_sessions as session
      on session.id = occurrence.session_id and session.tenant_id = occurrence.tenant_id
   where occurrence.tenant_id = c.tenant_id
     and occurrence.source_type = 'booking'
     and occurrence.source_id = c.booking_id::text
     and occurrence.class_date = c.class_date
     and occurrence.status <> 'SUPERSEDED'
     and session.status <> 'SUPERSEDED'
     and (v_start_time is null or occurrence.start_time = v_start_time)
   order by session.scheduled_start_at
   limit 1;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_sala_para_quem_da_a_aula');
  end if;
  if v_session.scheduled_start_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'aula_ja_comecou');
  end if;

  v_director := private.management_group_default_actor(c.tenant_id);
  if v_director is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_diretor_ativo');
  end if;

  -- As coberturas deste substituto nas partes desta aula, pela ordem do horário.
  select pg_catalog.array_agg(part.id order by part.start_time, part.id) into v_coverages
    from (
      select distinct on (coverage.id) coverage.id, occurrence.start_time
        from public.lesson_occurrences as occurrence
        join public.class_coverages as coverage
          on coverage.tenant_id = occurrence.tenant_id
         and coverage.booking_id::text = occurrence.source_id
         and coverage.class_date = occurrence.class_date
       where occurrence.session_id = v_session.id
         and occurrence.tenant_id = v_session.tenant_id
         and occurrence.source_type = 'booking'
         and occurrence.status <> 'SUPERSEDED'
         and pg_catalog.lower(coalesce(coverage.status, '')) = 'confirmed'
         and coverage.cover_teacher_id = c.cover_teacher_id
       order by coverage.id, occurrence.start_time
    ) as part;
  if v_coverages is null or not (c.id = any(v_coverages)) then
    v_coverages := coalesce(v_coverages, array[]::uuid[]) || c.id;
  end if;
  v_first := v_coverages[1];

  -- O que substituto e família já receberam sobre esta aula: o pacote de cada
  -- parte, o da aula inteira e o aviso de sala de antes.
  select coalesce(pg_catalog.bool_or(q.idempotency_key like '%:briefing'), false),
         coalesce(pg_catalog.bool_or(pg_catalog.strpos(q.message_body, v_room) > 0), false)
    into v_cover_packaged, v_cover_has_link
    from public.notification_queue as q
   where q.tenant_id = c.tenant_id
     and q.idempotency_key in (
       select pg_catalog.format(pattern, id)
         from pg_catalog.unnest(v_coverages) as id
        cross join (values ('coverage:%s:briefing'), ('coverage-lesson:%s:briefing'), ('coverage:%s:room')) as keys(pattern));
  select coalesce(pg_catalog.bool_or(q.idempotency_key like '%:family'), false),
         coalesce(pg_catalog.bool_or(pg_catalog.strpos(q.message_body, v_room) > 0), false)
    into v_family_packaged, v_family_informed
    from public.notification_queue as q
   where q.tenant_id = c.tenant_id
     and q.idempotency_key in (
       select pg_catalog.format(pattern, id)
         from pg_catalog.unnest(v_coverages) as id
        cross join (values ('coverage:%s:family'), ('coverage-lesson:%s:family'), ('coverage:%s:room-family')) as keys(pattern));

  select * into v_student from public.profiles where id = c.student_id;
  select * into v_cover from public.profiles where id = c.cover_teacher_id;
  v_first_cover := pg_catalog.split_part(pg_catalog.btrim(coalesce(v_cover.full_name, 'Professor')), ' ', 1);
  v_first_student := pg_catalog.split_part(pg_catalog.btrim(coalesce(v_student.full_name, 'aluno')), ' ', 1);
  v_when := format('%s %s às %s', private.weekday_label_pt(v_session.class_date),
    pg_catalog.to_char(v_session.class_date, 'DD/MM'),
    pg_catalog.to_char(v_session.scheduled_start_at at time zone 'America/Sao_Paulo', 'HH24:MI'));
  v_family_phone := private.whatsapp_digits(coalesce(nullif(v_student.attendance_phone, ''), nullif(v_student.phone, ''), nullif(v_student.guardian_phone, '')));
  -- A família fica com o link se um aviso dela já o tinha ou se ele vai agora.
  v_family_has_link := v_family_packaged and (v_family_informed or v_family_phone is not null);

  if v_cover_packaged and not v_cover_has_link then
    v_phone := private.whatsapp_digits(coalesce(nullif(v_cover.attendance_phone, ''), nullif(v_cover.phone, '')));
    if v_phone is not null then
      insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
          source_type, class_date, notification_kind, idempotency_key)
      values (c.tenant_id, v_director, v_cover.full_name, v_phone,
          format(E'🎥 Sala da escola pronta para a aula de *%s* (%s): %s\nA aula é nela — não mande outro link.%s',
            pg_catalog.btrim(coalesce(v_student.full_name, 'aluno')), v_when, v_room,
            case when v_family_has_link then ' A família recebe o mesmo link.'
                 else ' A família não tem WhatsApp no cadastro: mande a ela este mesmo link.' end),
          pg_catalog.now(), 'pending', 'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE',
          format('coverage:%s:room', v_first))
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
      returning id into v_id;
      if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('room'::text); end if;
    end if;
  end if;
  v_id := null;
  if v_family_packaged and not v_family_informed then
    v_phone := v_family_phone;
    if v_phone is not null then
      insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
          source_type, class_date, notification_kind, idempotency_key)
      values (c.tenant_id, v_director, v_student.full_name, v_phone,
          format('Oi, %s! 🐺 O link da aula de %s com a Teacher %s, na sala da escola no Google Meet: %s Qualquer dúvida, é só responder aqui.',
            v_first_student, v_when, v_first_cover, v_room),
          pg_catalog.now(), 'pending', 'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE',
          format('coverage:%s:room-family', v_first))
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
      returning id into v_id;
      if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('room-family'::text); end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'queued', v_queued, 'official_room', v_room,
    'lesson_session_id', v_session.id, 'notice_coverage_id', v_first);
end
$function$;

alter function private.coverage_room_notice_enqueue(uuid) owner to postgres;
revoke all on function private.coverage_room_notice_enqueue(uuid)
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
  if new.state is distinct from 'READY' or new.meeting_uri is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.state is not distinct from new.state
     and old.meeting_uri is not distinct from new.meeting_uri then
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

drop trigger if exists trg_zz_google_meet_room_ready_coverage_notice on private.google_meet_rooms;
create trigger trg_zz_google_meet_room_ready_coverage_notice
  after insert or update of state, meeting_uri on private.google_meet_rooms
  for each row when (new.state = 'READY')
  execute function private.google_meet_room_ready_coverage_notice();

-- ---------------------------------------------------------------------------
-- 3. Transferência definitiva: o novo titular recebe o link do dossiê
-- ---------------------------------------------------------------------------
create or replace function private.teacher_transfer_dossier_enqueue(p_transfer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  t public.teacher_transfers%rowtype;
  v_teacher public.profiles%rowtype;
  v_student public.profiles%rowtype;
  v_from_name text;
  v_director uuid;
  v_phone text;
  v_portal text;
  v_first text;
  v_message text;
  v_id uuid;
begin
  select * into t from public.teacher_transfers where id = p_transfer_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'transferencia_nao_encontrada');
  end if;
  if upper(coalesce(t.status, '')) not in ('ACCEPTED', 'APPLIED') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'transferencia_nao_aceita', 'status', t.status);
  end if;
  select * into v_teacher from public.profiles
   where id = t.to_teacher_id and tenant_id = t.tenant_id and role = 'TEACHER'
     and lower(coalesce(lifecycle_status, 'active')) = 'active';
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'professor_destino_invalido');
  end if;
  select * into v_student from public.profiles
   where id = t.student_id and tenant_id = t.tenant_id and role = 'STUDENT';
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'aluno_nao_encontrado');
  end if;
  v_director := private.management_group_default_actor(t.tenant_id);
  if v_director is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_diretor_ativo');
  end if;
  v_phone := private.whatsapp_digits(coalesce(nullif(v_teacher.attendance_phone, ''), nullif(v_teacher.phone, '')));
  if v_phone is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'professor_sem_whatsapp');
  end if;
  select split_part(btrim(coalesce(p.full_name, '')), ' ', 1) into v_from_name
    from public.profiles p where p.id = t.from_teacher_id;
  v_first := split_part(btrim(coalesce(v_teacher.full_name, 'Professor')), ' ', 1);
  v_portal := private.lesson_recording_portal_url(t.tenant_id);

  -- Só o que ele precisa para chegar ao dossiê: nome do aluno, data e o link.
  -- O conteúdo (histórico, última aula aprovada, cartão) fica atrás do login.
  v_message := format('Olá %s! 🐺 *%s* passa a ser seu aluno a partir de %s%s. ',
      v_first, btrim(coalesce(v_student.full_name, 'Aluno')), to_char(t.cutover_date, 'DD/MM'),
      case when nullif(v_from_name, '') is not null then format(' (antes com %s)', v_from_name) else '' end)
    || case when v_portal is not null
         then format(E'Antes da primeira aula, leia o dossiê do aluno — histórico das aulas, o que ficou da última aula aprovada e o cartão do aluno. Entre com o seu login: %s/dossie-do-aluno?aluno=%s',
                     v_portal, t.student_id::text)
         else 'Antes da primeira aula, leia o dossiê do aluno no app — *Salas e continuidade* → *Dossiê do aluno* (ou *Alunos* → ficha → *Continuidade pedagógica*).'
       end
    || E'\nDúvida, responda por aqui.';

  insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
      source_type, class_date, notification_kind, idempotency_key)
  values (t.tenant_id, v_director, v_teacher.full_name, v_phone, v_message, pg_catalog.now(), 'pending',
      'MANAGEMENT_NOTICE', t.cutover_date, 'MANAGEMENT_NOTICE', format('teacher-transfer:%s:dossier', t.id))
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  return pg_catalog.jsonb_build_object('ok', true, 'queued', v_id is not null, 'message', v_message);
end
$function$;

alter function private.teacher_transfer_dossier_enqueue(uuid) owner to postgres;
revoke all on function private.teacher_transfer_dossier_enqueue(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.teacher_transfer_dossier_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if upper(coalesce(new.status, '')) in ('ACCEPTED', 'APPLIED')
     and (tg_op = 'INSERT' or upper(coalesce(old.status, '')) not in ('ACCEPTED', 'APPLIED')) then
    begin
      perform private.teacher_transfer_dossier_enqueue(new.id);
    exception when others then
      -- O aviso nunca derruba a transferência.
      raise warning 'teacher_transfer_dossier_notice: % (%)', sqlerrm, sqlstate;
    end;
  end if;
  return null;
end
$function$;

alter function private.teacher_transfer_dossier_notice() owner to postgres;
revoke all on function private.teacher_transfer_dossier_notice()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_zz_teacher_transfer_dossier_notice on public.teacher_transfers;
create trigger trg_zz_teacher_transfer_dossier_notice
  after insert or update of status on public.teacher_transfers
  for each row execute function private.teacher_transfer_dossier_notice();

-- A transferência direta da Gestão estava quebrada desde 22/09/2026.
-- admin_transfer_student_teacher (20260922021857) troca o professor dos
-- agendamentos fixos e DEPOIS atualiza o perfil "onde o professor ainda é o
-- antigo" — a trava contra corrida. Duas horas depois, 20260922040028 pôs em
-- bookings o gatilho bookings_sync_student_primary_teacher, que ao ver todos os
-- agendamentos fixos com o professor novo já grava professor_id = novo. O
-- UPDATE do perfil não achava mais a linha e a função recusava TODA
-- transferência direta com "O professor do aluno mudou durante a
-- transferência". (Em produção só houve uma, às 02:31 de 22/09, antes do
-- gatilho.) O perfil está travado (FOR UPDATE) desde o início da função: o
-- professor novo no perfil é a consequência do próprio UPDATE dos agendamentos,
-- não uma corrida — o perfil com o antigo OU já com o novo segue.
do $direct_transfer$
declare
  v_def text;
  v_anchor text := $anchor$     and student.professor_id = v_from_teacher;$anchor$;
  v_patch text := $patch$     -- O gatilho de bookings pode já ter posto o professor novo (20260928100000).
     and student.professor_id in (v_from_teacher, p_to_teacher);$patch$;
begin
  v_def := pg_catalog.pg_get_functiondef(
    'public.admin_transfer_student_teacher(uuid,uuid,text)'::regprocedure);
  if pg_catalog.strpos(v_def, 'student.professor_id in (v_from_teacher, p_to_teacher)') > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_def, v_anchor) = 0 then
    raise exception 'admin_transfer_student_teacher: âncora do perfil não encontrada';
  end if;
  if pg_catalog.strpos(
       pg_catalog.substr(v_def, pg_catalog.strpos(v_def, v_anchor) + 1), v_anchor) > 0 then
    raise exception 'admin_transfer_student_teacher: âncora do perfil repetida';
  end if;
  execute pg_catalog.replace(v_def, v_anchor, v_patch);
end;
$direct_transfer$;
