-- O aluno vê o próprio registro das aulas (decisão da direção, onda 2 do Meet).
--
-- Até aqui o registro da aula (transcrição, anotações do Gemini, resumo) só
-- existia para o professor, a coordenação e a direção. A direção decidiu que o
-- aluno pode ver o PRÓPRIO registro — e só o que o professor aprovou:
--
--   * resumos APROVADOS (private.lesson_summary_versions, status VERIFIED — a
--     mesma versão que alimenta student_learning_memories) com data, objetivo,
--     conteúdo praticado, próximo passo e lição combinada. Rascunho (notas
--     nativas, IA) não aparece: memória do aluno só com resumo aprovado;
--   * nunca texto bruto: nem a transcrição, nem as notas do Google, nem as
--     citações de evidência, nem "dificuldades", nem o resumo narrativo do
--     professor. Transcrição bruta continua só com o professor da aula, a
--     coordenação e a direção (session_detail → raw_access);
--   * nada do cartão do aluno (student_learning_cards) nem das observações do
--     professor: o cartão é ferramenta de quem dá a aula;
--   * o que é guardado e por quanto tempo sai do próprio dado: para cada aula,
--     até quando CADA cópia bruta fica no sistema, com o nome certo
--     (`transcript_until`, `notes_until`, `attendance_until`: o maior
--     expires_at vivo de cada tipo; nulo = não há cópia daquele tipo) — um
--     prazo só misturava a presença (que pode durar mais) com a transcrição —,
--     e quantas aulas têm transcrição/anotações guardadas esperando a revisão
--     do professor (`pending_review`; aula cuja última versão foi REJEITADA já
--     foi revisada e fica fora). O texto do termo vigente vai junto — é ele
--     que diz os prazos que o aluno aceitou;
--   * os campos do resumo saem com os MESMOS tetos da aprovação (objetivo
--     2000, próximo passo e lição 3000, até 20 conteúdos de 1200 —
--     normalizeSummary da edge google-meet): o que o professor aprovou chega
--     inteiro; se algo escrito por fora passar do teto, o corte leva "…";
--   * como revogar: a situação do termo do próprio aluno (vale, não vale,
--     recusado, revogado) e a validade do link vivo — SEM o token (o banco só
--     guarda o hash; o link está no WhatsApp de quem responde). Só link que
--     se sabe ter CHEGADO: aberto pela família (first_opened_at) ou com a
--     mensagem aceita pelo provedor (notification_queue.accepted_at, o "SENT"
--     do painel). Link na fila, pedido que não saiu ou link gerado à mão que
--     ninguém abriu não viram "o link que a escola mandou";
--   * como pedir exclusão: o nome da escola e o WhatsApp da instância central,
--     pelo mesmo critério de teacher_support_contacts (SCHOOL_ADMIN ativo dono
--     da instância). Sem número, a tela diz "fale com a escola pelo WhatsApp".
--     ⚠️ Não há RPC de exclusão: o pedido se cumpre à mão (runbook do Meet,
--     "Pedido de exclusão"). Esta RPC lê lesson_summary_versions, não
--     student_learning_memories — apagar só a memória deixa o resumo aqui.
--
-- Só o próprio aluno (profiles.role = STUDENT, auth.uid()) e só as sessões dele
-- na escola dele. Professor, coordenação e direção recebem `somente_o_aluno`:
-- eles já têm o dossiê e a tela "Sala e resumo", com as regras deles.
--
-- Re-executável: create or replace; nada de begin/commit.

-- Corte com aviso: acima do teto o texto termina em "…", para o aluno não ler
-- uma frase cortada no meio como se fosse o texto aprovado. Vazio vira nulo.
create or replace function private.lesson_record_clip(p_text text, p_limit integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_text is null or p_text = '' then null
    when pg_catalog.length(p_text) <= p_limit then p_text
    else pg_catalog.rtrim(pg_catalog.left(p_text, greatest(p_limit - 1, 1))) || '…'
  end;
$$;

-- Texto de um campo do resumo: string aparada, com teto, vazia vira nulo.
-- Objeto, número ou lista no lugar de texto não vaza para a tela do aluno.
create or replace function private.lesson_record_text(p_value jsonb, p_limit integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'string' then null
    else private.lesson_record_clip(pg_catalog.btrim(p_value #>> '{}'), p_limit)
  end;
$$;

-- Lista de um campo do resumo: só itens de texto não vazios, na ordem, com
-- teto de itens e de tamanho. Texto solto (em vez de lista) vira um item.
create or replace function private.lesson_record_list(p_value jsonb, p_items integer, p_limit integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'array' then coalesce((
      select pg_catalog.jsonb_agg(item.text_value order by item.position)
      from (
        select private.lesson_record_clip(pg_catalog.btrim(element.value #>> '{}'), p_limit) as text_value,
               element.position
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as element(value, position)
        where pg_catalog.jsonb_typeof(element.value) = 'string'
          and pg_catalog.btrim(element.value #>> '{}') <> ''
        order by element.position
        limit p_items
      ) as item
    ), '[]'::jsonb)
    when 'string' then case
      when pg_catalog.btrim(p_value #>> '{}') = '' then '[]'::jsonb
      else pg_catalog.jsonb_build_array(private.lesson_record_clip(pg_catalog.btrim(p_value #>> '{}'), p_limit))
    end
    else '[]'::jsonb
  end;
$$;

alter function private.lesson_record_clip(text, integer) owner to postgres;
alter function private.lesson_record_text(jsonb, integer) owner to postgres;
alter function private.lesson_record_list(jsonb, integer, integer) owner to postgres;
revoke all on function private.lesson_record_clip(text, integer) from public, anon, authenticated, service_role;
revoke all on function private.lesson_record_text(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function private.lesson_record_list(jsonb, integer, integer) from public, anon, authenticated, service_role;

create or replace function public.get_my_lesson_records()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.profiles;
  v_term private.lesson_recording_terms;
  v_decision text;
  v_relation text;
  v_decided_at timestamptz;
  v_status text;
  v_reason text;
  v_link_expires timestamptz;
  v_records jsonb;
  v_pending integer;
  v_school_name text;
  v_school_whatsapp text;
begin
  select * into v_me from public.profiles where id = (select auth.uid());
  if v_me.id is null or upper(coalesce(v_me.role, '')) <> 'STUDENT' then
    raise exception 'somente_o_aluno' using errcode = '42501';
  end if;

  -- Resumos aprovados: a última versão VERIFIED de cada sessão do aluno (a
  -- mesma que está em student_learning_memories). Rejeição ou rascunho
  -- posteriores não apagam o aprovado — o upsert da memória também não.
  with approved as (
    select distinct on (sess.id)
      sess.id as session_id,
      sess.class_date,
      sess.scheduled_start_at,
      sess.teacher_id,
      sv.created_at as approved_at,
      sv.content
    from public.lesson_sessions as sess
    join private.lesson_summary_versions as sv
      on sv.lesson_session_id = sess.id
     and sv.tenant_id = sess.tenant_id
     and sv.status = 'VERIFIED'
    where sess.student_id = v_me.id
      and sess.tenant_id = v_me.tenant_id
    order by sess.id, sv.version desc
  ), recent as (
    select * from approved order by scheduled_start_at desc limit 300
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'session_id', recent.session_id,
      'class_date', recent.class_date,
      'scheduled_start_at', recent.scheduled_start_at,
      'teacher_name', nullif(pg_catalog.btrim(coalesce(teacher.full_name, '')), ''),
      'approved_at', recent.approved_at,
      -- Tetos iguais aos da aprovação (normalizeSummary): nada do que o
      -- professor aprovou chega cortado.
      'lesson_objective', private.lesson_record_text(recent.content -> 'lesson_objective', 2000),
      'content_practiced', private.lesson_record_list(recent.content -> 'content_practiced', 20, 1200),
      'recommended_next_step', private.lesson_record_text(recent.content -> 'recommended_next_step', 3000),
      'homework_assigned', private.lesson_record_text(recent.content -> 'homework_assigned', 3000),
      -- Até quando CADA cópia bruta desta aula continua no sistema, pelo tipo
      -- (a tela diz "transcrição", "anotações" ou "presença" com o prazo de
      -- cada uma); nulo = nenhuma cópia viva daquele tipo.
      'transcript_until', (
        select max(artifact.expires_at)
        from private.meeting_artifact_revisions as artifact
        where artifact.tenant_id = v_me.tenant_id
          and artifact.lesson_session_id = recent.session_id
          and artifact.kind = 'TRANSCRIPT'
          and artifact.expires_at > pg_catalog.now()
      ),
      'notes_until', (
        select max(artifact.expires_at)
        from private.meeting_artifact_revisions as artifact
        where artifact.tenant_id = v_me.tenant_id
          and artifact.lesson_session_id = recent.session_id
          and artifact.kind = 'SMART_NOTES'
          and artifact.expires_at > pg_catalog.now()
      ),
      'attendance_until', (
        select max(report.expires_at)
        from private.meeting_attendance_reports as report
        where report.tenant_id = v_me.tenant_id
          and report.lesson_session_id = recent.session_id
          and report.expires_at > pg_catalog.now()
      )
    ) order by recent.scheduled_start_at desc), '[]'::jsonb)
  into v_records
  from recent
  left join public.profiles as teacher on teacher.id = recent.teacher_id;

  -- Aulas com transcrição/anotações guardadas esperando a revisão do
  -- professor: o aluno sabe que existem, sem ver o texto. Sem resumo aprovado
  -- E sem rejeição como última palavra: aula cuja versão mais recente foi
  -- REJEITADA já foi revisada e não vai ganhar resumo (rascunho novo depois
  -- da rejeição volta a contar).
  select count(*)::integer into v_pending
  from public.lesson_sessions as sess
  where sess.student_id = v_me.id
    and sess.tenant_id = v_me.tenant_id
    and exists (
      select 1 from private.meeting_artifact_revisions as artifact
      where artifact.tenant_id = sess.tenant_id
        and artifact.lesson_session_id = sess.id
        and artifact.expires_at > pg_catalog.now()
    )
    and not exists (
      select 1 from private.lesson_summary_versions as sv
      where sv.tenant_id = sess.tenant_id
        and sv.lesson_session_id = sess.id
        and sv.status = 'VERIFIED'
    )
    and coalesce((
      select latest.status
      from private.lesson_summary_versions as latest
      where latest.tenant_id = sess.tenant_id
        and latest.lesson_session_id = sess.id
      order by latest.version desc
      limit 1
    ), '') <> 'REJECTED';

  -- Situação do termo do próprio aluno (a mesma régua que marca as aulas).
  select consent.decision, consent.signer_relation, consent.decided_at
    into v_decision, v_relation, v_decided_at
  from private.lesson_recording_consents as consent
  where consent.subject_id = v_me.id
  order by consent.seq desc
  limit 1;
  v_status := case
    when v_decision is null then 'NONE'
    when v_decision = 'ACCEPTED' and private.lesson_recording_student_consent_effective(v_me.id) then 'AUTHORIZED'
    when v_decision = 'ACCEPTED' then 'NOT_EFFECTIVE'
    else v_decision
  end;
  v_reason := private.lesson_recording_guardian_reason(v_me.id);

  -- Link vivo do termo (é por ele que se revoga sem falar com ninguém). Só a
  -- validade: o token não existe no banco, e o link fica no WhatsApp de quem
  -- responde (o responsável, quando o cadastro exige). E só link que se sabe
  -- ter CHEGADO, porque a tela diz "o link que a escola mandou para o
  -- WhatsApp":
  --   * aberto pela família (first_opened_at, gravado pela página pública); ou
  --   * mensagem do envio em lote aceita pelo provedor (accepted_at, o "SENT"
  --     da lista da direção).
  -- O lote cria o link quando ENFILEIRA (vale 30 dias a partir do horário
  -- marcado), a mensagem pode nem sair (NOT_SENT não revoga o link) e o link
  -- gerado à mão pode nunca ter sido mandado: nesses casos, nulo, e a tela
  -- manda pedir à escola.
  select link.expires_at into v_link_expires
  from private.lesson_recording_consent_links as link
  where link.student_id = v_me.id
    and link.tenant_id = v_me.tenant_id
    and link.revoked_at is null
    and link.blocked_at is null
    and link.expires_at > pg_catalog.now()
    and (
      link.first_opened_at is not null
      or exists (
        select 1
        from private.lesson_recording_consent_requests as request
        join public.notification_queue as queue on queue.id = request.notification_id
        where request.link_id = link.id
          and request.student_id = v_me.id
          and queue.accepted_at is not null
      )
    )
  order by link.created_at desc
  limit 1;

  v_term := private.lesson_recording_current_term('STUDENT');

  -- Contato para pedir exclusão: o critério de teacher_support_contacts (o
  -- número da instância central é o telefone do SCHOOL_ADMIN dono dela).
  select coalesce(nullif(pg_catalog.btrim(tenant.school_info ->> 'name'), ''), tenant.name)
    into v_school_name
  from public.tenants as tenant
  where tenant.id = v_me.tenant_id;

  select pg_catalog.regexp_replace(coalesce(admin.phone, ''), '\D', '', 'g')
    into v_school_whatsapp
  from public.profiles as admin
  join public.tenant_memberships as membership
    on membership.user_id = admin.id
   and membership.tenant_id = v_me.tenant_id
   and membership.role = 'SCHOOL_ADMIN'
   and membership.status = 'ACTIVE'
  where nullif(pg_catalog.btrim(coalesce(admin.whatsapp_instance, '')), '') is not null
    and pg_catalog.length(pg_catalog.regexp_replace(coalesce(admin.phone, ''), '\D', '', 'g')) >= 10
  order by membership.created_at
  limit 1;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'school_name', v_school_name,
    'school_whatsapp', v_school_whatsapp,
    'consent', pg_catalog.jsonb_build_object(
      'status', v_status,
      'decided_at', v_decided_at,
      'signer_relation', v_relation,
      'requires_guardian', v_reason is not null,
      'guardian_reason', v_reason,
      'link_expires_at', v_link_expires
    ),
    'term', case when v_term.version is null then null
      else pg_catalog.jsonb_build_object('version', v_term.version, 'body', v_term.body) end,
    'pending_review', coalesce(v_pending, 0),
    'records', v_records
  );
end;
$$;

alter function public.get_my_lesson_records() owner to postgres;
revoke all on function public.get_my_lesson_records() from public, anon, service_role;
grant execute on function public.get_my_lesson_records() to authenticated;

comment on function public.get_my_lesson_records() is
  'Aluno autenticado: os próprios resumos APROVADOS do registro das aulas (sem texto bruto, sem cartão), até quando cada cópia bruta (transcrição, anotações, presença) fica no sistema, a situação do próprio termo (validade do link só se ele chegou) e o contato da escola. Outros papéis: somente_o_aluno.';
