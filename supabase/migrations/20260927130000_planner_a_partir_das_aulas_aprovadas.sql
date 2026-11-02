-- Planner a partir das aulas aprovadas: quem pode planejar para qual aluno.
--
-- Até aqui a edge lesson-planner recusava todo professor sem agendamento
-- próprio (`bookings` do professor com o aluno). Ficavam de fora três pessoas
-- que dão aula de verdade para o aluno:
--   * o SEGUNDO professor do aluno (`profiles.professor_id2`, campo que só a
--     direção grava — 20260922042641 — e que a transferência limpa);
--   * o SUBSTITUTO com cobertura confirmada daquele aluno;
--   * o professor da REPOSIÇÃO marcada com ele (com data).
-- E o botão "Planejar" de Aulas de Hoje, que já aparece na aula coberta,
-- abria o Planner com um aluno que não estava na lista.
--
-- A regra nova é uma VARIANTE com p_teacher_id da regra de acesso existente
-- (public._teacher_can_access_student, 20260923130000), e não uma porta ao
-- lado: mesmo contexto (professor ativo na escola, aluno ativo e não suspenso
-- nem desligado), mesmo agendamento vivo, mesmo fallback do professor titular
-- sem agenda. O que muda é o tempo:
--   * cobertura e reposição valem do DIA ANTERIOR ao DIA SEGUINTE da aula — a
--     mesma janela do dossiê do substituto (decisão da direção). A regra de
--     leitura de perfis aceita cobertura de até 7 dias atrás e QUALQUER data
--     futura; aqui não: planejar é preparar a aula, e acesso tem de acabar;
--   * reposição sem data ("Pendente") não abre nada, e reposição encerrada
--     pela direção (closed_reason) também não — é o "acesso fantasma" de
--     20260923130000, que não volta por aqui;
--   * reposição dada (used_at por lançamento) continua valendo até o dia
--     seguinte: o professor pode querer o feedback daquela aula. A janela é
--     que limita.
--
-- NÃO mexe em public._teacher_can_access_student: ela decide RLS de perfis e
-- de outras tabelas, e alargá-la abriria leitura e escrita — não só o Planner.
--
-- Duas portas, uma regra (private.planner_student_access):
--   * public.planner_teacher_can_access_student(professor, aluno, escola) —
--     só service_role; é o que a edge consulta antes de gerar ou salvar;
--   * public.my_planner_students() — o professor logado lista para quem pode
--     planejar agora, com o motivo e até quando vale.
--
-- E (seção 2, no fim) a última decisão humana sobre o resumo da aula vale:
-- resumo aprovado e depois REJEITADO sai da memória do aluno — o Planner, o
-- dossiê do substituto e o segundo professor liam só o status da memória, que
-- ficava VERIFIED para sempre. A seção 3 (correção da integração) leva a mesma
-- régua à tela "Sala e resumo" de quem não vê a fonte: versão aprovada e
-- depois rejeitada deixa de ser servida como resumo aprovado.

create or replace function private.planner_student_access(
  p_teacher_id uuid,
  p_tenant_id text,
  p_local_date date
)
returns table (student_id uuid, access_reason text, valid_until date)
language sql
stable
security definer
set search_path = ''
as $function$
  with teacher as (
    select caller.id
    from public.profiles as caller
    where caller.id = p_teacher_id
      and caller.role = 'TEACHER'
      and caller.status = 'Ativo'
      and caller.tenant_id = p_tenant_id
      and p_local_date is not null
  ),
  students as (
    select student.id, student.professor_id, student.professor_id2
    from public.profiles as student
    where student.tenant_id = p_tenant_id
      and student.role = 'STUDENT'
      and lower(coalesce(student.status, '')) in ('ativo', 'active')
      and lower(coalesce(student.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
  ),
  grants as (
    -- Agenda viva com este professor (a mesma de _teacher_can_access_student).
    select booking.student_id, 'BOOKING'::text as access_reason,
           null::date as valid_until, 1 as priority
    from public.bookings as booking
    join teacher on teacher.id = booking.teacher_id
    where booking.tenant_id = p_tenant_id
      and upper(coalesce(booking.status, '')) = 'SCHEDULED'
      and (booking.date is null or booking.date >= p_local_date - 7)

    union all
    -- Segundo professor do aluno: atribuição da direção, vale enquanto ela
    -- não tirar (a transferência limpa o campo).
    select student.id, 'SECOND_TEACHER', null::date, 2
    from students as student
    join teacher on teacher.id = student.professor_id2

    union all
    -- Titular sem agenda nenhuma (o mesmo fallback da regra existente).
    select student.id, 'PRIMARY_TEACHER', null::date, 3
    from students as student
    join teacher on teacher.id = student.professor_id
    where not exists (
      select 1
      from public.bookings as live_booking
      where live_booking.student_id = student.id
        and live_booking.tenant_id = p_tenant_id
        and upper(coalesce(live_booking.status, '')) = 'SCHEDULED'
        and (live_booking.date is null or live_booking.date >= p_local_date - 7)
    )

    union all
    -- Substituto: cobertura CONFIRMADA, do dia anterior ao seguinte da aula.
    select coverage.student_id, 'COVERAGE', coverage.class_date + 1, 4
    from public.class_coverages as coverage
    join teacher on teacher.id = coverage.cover_teacher_id
    where coverage.tenant_id = p_tenant_id
      and lower(coalesce(coverage.status, '')) = 'confirmed'
      and coverage.class_date between p_local_date - 1 and p_local_date + 1

    union all
    -- Reposição COM DATA marcada com este professor, na mesma janela.
    select reschedule.student_id, 'RESCHEDULE', reschedule.lesson_date + 1, 5
    from (
      select dated.student_id, dated.teacher_id, dated.tenant_id, dated.closed_reason,
             case
               when dated.date ~ '^\d{4}-\d{2}-\d{2}$' then dated.date::date
               else null
             end as lesson_date
      from public.reschedules as dated
      where dated.tenant_id = p_tenant_id
        and dated.date ~ '^\d{4}-\d{2}-\d{2}$'
    ) as reschedule
    join teacher on teacher.id = reschedule.teacher_id
    where reschedule.closed_reason is null
      and reschedule.lesson_date between p_local_date - 1 and p_local_date + 1
  )
  -- Um motivo por aluno: o permanente vence o temporário; entre temporários,
  -- o que vale até mais tarde.
  select distinct on (grant_row.student_id)
         grant_row.student_id, grant_row.access_reason, grant_row.valid_until
  from grants as grant_row
  join students on students.id = grant_row.student_id
  order by grant_row.student_id, grant_row.priority,
           grant_row.valid_until desc nulls first;
$function$;

alter function private.planner_student_access(uuid, text, date) owner to postgres;
revoke all on function private.planner_student_access(uuid, text, date)
  from public, anon, authenticated, service_role;

comment on function private.planner_student_access(uuid, text, date) is
  'Planner IA: alunos para quem o professor pode planejar na data local (agenda viva, segundo professor, titular sem agenda, cobertura confirmada ou reposição com data do dia anterior ao seguinte da aula).';

-- Porta da edge (service_role): o professor pode planejar para este aluno hoje?
-- Devolve o motivo (BOOKING | SECOND_TEACHER | PRIMARY_TEACHER | COVERAGE |
-- RESCHEDULE) ou nulo.
create or replace function public.planner_teacher_can_access_student(
  p_teacher_id uuid,
  p_student_id uuid,
  p_tenant_id text
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select access.access_reason
  from private.planner_student_access(
    p_teacher_id,
    p_tenant_id,
    (now() at time zone 'America/Sao_Paulo')::date
  ) as access
  where access.student_id = p_student_id
  limit 1;
$function$;

alter function public.planner_teacher_can_access_student(uuid, uuid, text) owner to postgres;
revoke all on function public.planner_teacher_can_access_student(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.planner_teacher_can_access_student(uuid, uuid, text)
  to service_role;

-- Porta da tela: a lista de alunos do Planner para o professor logado. Só
-- professor recebe linhas; a direção lista os alunos da escola pela ficha.
create or replace function public.my_planner_students()
returns table (
  id uuid,
  full_name text,
  module text,
  access_reason text,
  valid_until date
)
language sql
stable
security definer
set search_path = ''
as $function$
  select student.id, student.full_name, student.module,
         access.access_reason, access.valid_until
  from public.profiles as caller
  cross join lateral private.planner_student_access(
    caller.id,
    caller.tenant_id,
    (now() at time zone 'America/Sao_Paulo')::date
  ) as access
  join public.profiles as student on student.id = access.student_id
  where caller.id = (select auth.uid())
    and caller.role = 'TEACHER'
  order by student.full_name nulls last, student.id;
$function$;

alter function public.my_planner_students() owner to postgres;
revoke all on function public.my_planner_students() from public, anon;
grant execute on function public.my_planner_students() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Resumo aprovado e depois REJEITADO sai da memória do aluno
-- ---------------------------------------------------------------------------
-- google_meet_backend('summary_save') grava a memória MEET_SESSION VERIFIED
-- quando o professor aprova uma versão do resumo, e não mexia nela quando uma
-- versão POSTERIOR era rejeitada ("Registrar rejeição" — o professor viu um erro
-- ou um dado pessoal que o Gemini pôs no resumo). A memória seguia VERIFIED e ia
-- ao Planner (agora também do substituto e do segundo professor) e ao dossiê da
-- cobertura como a evidência de maior peso.
--
-- Regra: a última decisão humana vale. Versão REJECTED gravada → a memória
-- daquela aula vira REJECTED (com a versão rejeitada no metadata; o conteúdo
-- fica, como a trilha das versões). Rascunho novo (PROPOSED) não é decisão e
-- não mexe em nada. Aprovou de novo → o summary_save faz o upsert de sempre e a
-- memória volta a VERIFIED.
--
-- É gatilho na tabela das versões, e não remendo no google_meet_backend: vale
-- para qualquer escritor, inclusive uma recriação futura da função (a onda 1
-- recriou-a inteira; a próxima não precisa lembrar desta regra).

create or replace function private.meet_summary_rejection_revokes_memory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Decisão gravada DEPOIS desta (versão maior) manda. Com o lock da sessão no
  -- summary_save a rejeição é sempre a versão mais nova; a guarda é para
  -- escritor que não segue o lock.
  if exists (
    select 1
      from private.lesson_summary_versions as newer
     where newer.lesson_session_id = new.lesson_session_id
       and newer.version > new.version
       and newer.status in ('VERIFIED', 'REJECTED')
  ) then
    return null;
  end if;

  update public.student_learning_memories as memory
     set verification_status = 'REJECTED',
         metadata = memory.metadata || pg_catalog.jsonb_build_object(
           'rejected_summary_version_id', new.id,
           'rejected_at', pg_catalog.now()),
         updated_at = pg_catalog.now()
   where memory.tenant_id = new.tenant_id
     and memory.source_type = 'MEET_SESSION'
     and memory.source_ref = new.lesson_session_id::text
     and memory.verification_status <> 'REJECTED';
  return null;
end
$function$;

alter function private.meet_summary_rejection_revokes_memory() owner to postgres;
revoke all on function private.meet_summary_rejection_revokes_memory()
  from public, anon, authenticated, service_role;

comment on function private.meet_summary_rejection_revokes_memory() is
  'Resumo do Meet rejeitado depois de aprovado: a memória MEET_SESSION da aula vira REJECTED (a última decisão humana vale).';

drop trigger if exists trg_zz_meet_summary_rejection_revokes_memory
  on private.lesson_summary_versions;
create trigger trg_zz_meet_summary_rejection_revokes_memory
  after insert on private.lesson_summary_versions
  for each row
  when (new.status = 'REJECTED')
  execute function private.meet_summary_rejection_revokes_memory();

-- Memórias que já estão VERIFIED com a última decisão da aula sendo REJECTED
-- (rejeitadas antes do gatilho existir). Uma vez só: a trava é o
-- schema_one_shots, como todo ajuste de dado em migration.
do $oneshot$
begin
  if exists (select 1 from public.schema_one_shots
              where key = 'meet_memoria_de_resumo_rejeitado_20260927') then
    return;
  end if;

  update public.student_learning_memories as memory
     set verification_status = 'REJECTED',
         metadata = memory.metadata || pg_catalog.jsonb_build_object(
           'rejected_summary_version_id', last_review.id,
           'rejected_at', pg_catalog.now()),
         updated_at = pg_catalog.now()
    from (
      select distinct on (version.lesson_session_id)
             version.lesson_session_id, version.tenant_id, version.id, version.status
        from private.lesson_summary_versions as version
       where version.status in ('VERIFIED', 'REJECTED')
       order by version.lesson_session_id, version.version desc
    ) as last_review
   where last_review.status = 'REJECTED'
     and memory.tenant_id = last_review.tenant_id
     and memory.source_type = 'MEET_SESSION'
     and memory.source_ref = last_review.lesson_session_id::text
     and memory.verification_status <> 'REJECTED';

  insert into public.schema_one_shots (key, nota)
  values ('meet_memoria_de_resumo_rejeitado_20260927',
          'memória MEET_SESSION VERIFIED cuja última revisão do resumo foi REJECTED virou REJECTED');
end
$oneshot$;

-- ---------------------------------------------------------------------------
-- 3. A mesma régua na leitura do resumo aprovado (correção da integração)
-- ---------------------------------------------------------------------------
-- A memória segue a última decisão humana, mas a tela "Sala e resumo" de quem
-- não vê a fonte (outros professores do aluno e o suporte da plataforma —
-- session_detail do google_meet_backend, caminho sem raw_access) continuava
-- servindo TODA versão VERIFIED, com narrative e evidence. O professor rejeita a
-- versão aprovada porque ela cita a saúde do aluno, e os outros continuam lendo
-- aquele texto como "resumo aprovado". Agora quem não vê a fonte recebe só a
-- versão VERIFIED sem rejeição posterior. Quem vê a fonte (professor da aula,
-- coordenação e direção) continua com o histórico inteiro, com o status de cada
-- versão. A tela do aluno (get_my_lesson_records, 20260927140000) usa a mesma
-- régua. Remendo por âncora na definição viva (20260926180000): âncora uma vez
-- só, pula se já aplicado, para com erro se sumiu.
do $approved_read$
declare
  v_definition text;
  v_occurrences integer;
  v_anchor constant text := $anchor$and (v_raw or sv.status='VERIFIED')),'[]'::jsonb));$anchor$;
  v_done constant text := $done$and newer.status='REJECTED'$done$;
begin
  v_definition := pg_catalog.pg_get_functiondef(
    'public.google_meet_backend(text,text,uuid,uuid,jsonb)'::pg_catalog.regprocedure);
  if pg_catalog.strpos(v_definition, v_done) > 0 then
    return;
  end if;
  v_occurrences := (pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_anchor, '')))
    / pg_catalog.length(v_anchor);
  if v_occurrences <> 1 then
    raise exception 'planner_aulas_aprovadas_ancora_mudou: google_meet_backend session_detail (% ocorrências)',
      v_occurrences;
  end if;
  execute pg_catalog.replace(v_definition, v_anchor,
    $new$and (v_raw or (sv.status='VERIFIED' and not exists (select 1 from private.lesson_summary_versions newer
            where newer.lesson_session_id=sv.lesson_session_id and newer.version>sv.version
              and newer.status='REJECTED')))),'[]'::jsonb));$new$);
end
$approved_read$;

notify pgrst, 'reload schema';
