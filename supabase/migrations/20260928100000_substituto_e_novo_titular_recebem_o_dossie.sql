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
--    abre por ela.
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
--      (a) próximo passo, erros recorrentes e lição da ÚLTIMA aula com resumo
--          APROVADO (student_learning_memories MEET_SESSION VERIFIED — a
--          memória que a última decisão humana deixa valer, 20260927130000);
--      (b) o link da SALA OFICIAL quando a aula tem sala pronta que vale para
--          quem dá a aula (public.official_lesson_link, régua única
--          private.lesson_occurrence_giver). A família recebe o mesmo link em
--          vez de "a substituta vai te chamar para combinar o link";
--      (c) o LINK COM LOGIN do dossiê: <portal>/dossie-do-aluno?aluno=<id> (o
--          portal é o de private.lesson_recording_portal_url; escola sem
--          portal conhecido recebe o caminho no app).
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
-- âncora na definição viva (a função é grande e outras frentes a remendam).
do $meet_session_detail$
declare
  v_def text;
  v_anchor text := $anchor$    ) then raise exception 'google_meet_student_scope_required' using errcode='42501'; end if;$anchor$;
  v_patch text := $patch$    )
    -- Substituto de cobertura confirmada e professor da reposição com data:
    -- só a LEITURA do resumo aprovado, do dia anterior ao seguinte da aula
    -- (private.pedagogy_temporary_access, 20260928100000). A transcrição segue
    -- com quem deu a aula (v_raw) e nenhuma outra ação se abre por aqui.
    and not (p_action = 'session_detail' and exists (
      select 1 from private.pedagogy_temporary_access(
        s.tenant_id, a.id, s.student_id, (now() at time zone 'America/Sao_Paulo')::date)))
    then raise exception 'google_meet_student_scope_required' using errcode='42501'; end if;$patch$;
begin
  v_def := pg_catalog.pg_get_functiondef(
    'public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure);
  if pg_catalog.strpos(v_def, 'private.pedagogy_temporary_access(') > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_def, v_anchor) = 0 then
    raise exception 'google_meet_backend: âncora do escopo do aluno não encontrada';
  end if;
  if pg_catalog.strpos(
       pg_catalog.substr(v_def, pg_catalog.strpos(v_def, v_anchor) + 1), v_anchor) > 0 then
    raise exception 'google_meet_backend: âncora do escopo do aluno repetida';
  end if;
  execute pg_catalog.replace(v_def, v_anchor, v_patch);
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
  v_dow_name text;
  v_slot time;
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
  v_portal text;
  v_dossier text;
  v_window text;
  v_memory_at timestamptz;
  v_memory_next text;
  v_memory_errors text;
  v_memory_homework text;
  v_approved text := '';
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
  v_when := format('%s %s às %s', private.weekday_label_pt(c.class_date), to_char(c.class_date, 'DD/MM'), v_time);
  v_first_cover := split_part(btrim(coalesce(v_cover.full_name, 'Professor')), ' ', 1);
  v_first_original := split_part(btrim(coalesce(v_original.full_name, 'professor')), ' ', 1);
  v_first_student := split_part(btrim(coalesce(v_student.full_name, 'aluno')), ' ', 1);

  -- Duração: aulas de 1 h são dois bookings de 30 min seguidos do mesmo aluno.
  v_dow_name := (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.class_date)::int + 1];
  begin
    v_slot := v_time::time;
    for i in 1..3 loop
      exit when not exists (
        select 1 from public.bookings b
         where b.tenant_id = c.tenant_id and b.student_id = c.student_id
           and b.teacher_id = c.original_teacher_id
           and upper(coalesce(b.status, '')) = 'SCHEDULED' and b.date is null
           and public.fold_accents(b.day_of_week) = public.fold_accents(v_dow_name)
           and left(b.time_slot, 5) = left((v_slot + (i * interval '30 minutes'))::text, 5));
      v_duration := v_duration + 30;
    end loop;
  exception when others then v_duration := 30; end;

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
  -- VERIFIED — aprovado e depois rejeitado já saiu daqui, 20260927130000). Só
  -- os campos pedagógicos: próximo passo, erros recorrentes e lição.
  select m.occurred_at,
         private.briefing_line(m.recommended_next_step, 300),
         (select pg_catalog.string_agg(private.briefing_line(err.item, 80), '; ' order by err.ord)
            from unnest(coalesce(m.recurring_errors, '{}'::text[])) with ordinality as err(item, ord)
           where err.ord <= 3 and private.briefing_line(err.item, 80) is not null),
         private.briefing_line(m.homework_assigned, 200)
    into v_memory_at, v_memory_next, v_memory_errors, v_memory_homework
    from public.student_learning_memories m
   where m.tenant_id = c.tenant_id and m.student_id = c.student_id
     and m.source_type = 'MEET_SESSION' and m.verification_status = 'VERIFIED'
   order by m.occurred_at desc nulls last, m.updated_at desc
   limit 1;
  if coalesce(v_memory_next, v_memory_errors, v_memory_homework) is not null then
    v_approved := format(E'📝 Última aula com resumo aprovado (%s):\n',
        coalesce(to_char(v_memory_at at time zone 'America/Sao_Paulo', 'DD/MM'), '—'))
      || case when v_memory_next is not null then format(E'• Próximo passo: %s\n', v_memory_next) else '' end
      || case when v_memory_errors is not null then format(E'• Erros recorrentes: %s\n', v_memory_errors) else '' end
      || case when v_memory_homework is not null then format(E'• Lição: %s\n', v_memory_homework) else '' end;
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

  -- (c) Dossiê por link com login (nunca o conteúdo no WhatsApp).
  v_portal := private.lesson_recording_portal_url(c.tenant_id);
  if v_portal is not null then
    v_dossier := v_portal || '/dossie-do-aluno?aluno=' || c.student_id::text;
  end if;
  v_window := format('de %s a %s', to_char(c.class_date - 1, 'DD/MM'), to_char(c.class_date + 1, 'DD/MM'));

  v_student_phone := private.whatsapp_digits(coalesce(nullif(v_student.attendance_phone, ''), nullif(v_student.phone, ''), nullif(v_student.guardian_phone, '')));
  v_cover_phone := private.whatsapp_digits(coalesce(nullif(v_cover.attendance_phone, ''), nullif(v_cover.phone, '')));

  v_briefing := format(E'Olá %s! 🐺 Cobertura confirmada:\n\n👤 *%s* (aluno de %s)\n📅 %s · %s min\n', v_first_cover,
      btrim(coalesce(v_student.full_name, 'Aluno')), v_first_original, v_when, v_duration)
    || case when v_room is not null
         then format(E'🎥 Sala da escola no Google Meet: %s — a aula é nela, não mande outro link.\n', v_room)
         else '' end
    || case when v_student_phone is not null
         then format(E'📱 Contato: wa.me/%s%s — %s\n', v_student_phone,
                     case when v_student.guardian_id is not null or nullif(btrim(coalesce(v_student.guardian_name, '')), '') is not null
                          then ' (aluno com responsável)' else '' end,
                     case when v_room is not null then 'se precisar combinar algo antes da aula.'
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

  v_family := format('Oi, %s! 🐺 A aula de %s será com a Teacher %s, no lugar de %s. ',
      v_first_student, v_when, v_first_cover, v_first_original)
    || case when v_room is not null
         then format('A aula continua na sala da escola no Google Meet: %s', v_room)
         else format('%s vai te chamar pelo WhatsApp para combinar o link.', v_first_cover) end
    || ' Qualquer dúvida, é só responder aqui.';

  v_group := format('✅ *Cobertura aceita:* %s dá a aula de *%s* em %s (de %s). ',
      v_first_cover, btrim(coalesce(v_student.full_name, 'aluno')), v_when, v_first_original)
    || case when v_cover_phone is not null
         then format('%s recebe no WhatsApp o pacote da aula (contato, últimas aulas e link do dossiê)', v_first_cover)
         else format('⚠️ %s NÃO recebe o pacote (sem WhatsApp no cadastro): mande o contato do aluno e peça para abrir o dossiê em Salas e continuidade', v_first_cover) end
    || case when v_student_phone is not null then '; a família foi avisada.'
            else '; a família NÃO foi avisada (sem WhatsApp no cadastro).' end;

  if v_cover_phone is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
        source_type, class_date, notification_kind, idempotency_key)
    values (c.tenant_id, v_director, v_cover.full_name, v_cover_phone, v_briefing, pg_catalog.now(), 'pending',
        'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', format('coverage:%s:briefing', c.id))
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into v_id;
    if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('briefing'::text); end if;
  end if;
  v_id := null;
  if v_student_phone is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_name, student_phone, message_body, scheduled_for, status,
        source_type, class_date, notification_kind, idempotency_key)
    values (c.tenant_id, v_director, v_student.full_name, v_student_phone, v_family, pg_catalog.now(), 'pending',
        'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', format('coverage:%s:family', c.id))
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
          'MANAGEMENT_NOTICE', c.class_date, 'MANAGEMENT_NOTICE', format('coverage:%s:group', c.id))
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
      returning id into v_id;
      if v_id is not null then v_queued := v_queued || pg_catalog.to_jsonb('group'::text); end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'queued', v_queued, 'student_phone_known', v_student_phone is not null,
    'cover_phone_known', v_cover_phone is not null, 'briefing', v_briefing,
    'approved_lesson', v_approved <> '', 'official_room', v_room is not null, 'dossier_url', v_dossier);
end
$function$;

alter function public.coverage_briefing_enqueue(uuid, boolean) owner to postgres;
revoke all on function public.coverage_briefing_enqueue(uuid, boolean) from public, anon, authenticated;
grant execute on function public.coverage_briefing_enqueue(uuid, boolean) to service_role;

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
