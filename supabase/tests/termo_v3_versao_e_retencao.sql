-- Termo de registro das aulas v3, aceite por versão e retenção da memória das
-- aulas (migration 20260927100000).
--
-- 1. O texto v3 (aluno e professor) existe, identifica o controlador só por
--    marcadores ({escola_nome}, {escola_documento},
--    {escola_contato_privacidade}), não carrega dado da escola no código e diz
--    quem vê (inclusive o suporte técnico do fornecedor do sistema), quem
--    processa e por quanto tempo ficam os trechos da aula no resumo.
-- 2. O SERVIDOR preenche os marcadores com os dados da própria escola
--    (tenants.school_info), com texto neutro quando falta algo: nenhuma rota
--    pública devolve o texto com o marcador cru — nem a página, nem o cartão,
--    nem rota nova de outra frente (auditoria do código-fonte).
-- 3. Aceite por versão:
--    * aceite de versão anterior à vigente não vale (aluno E professor): a
--      página e o cartão dizem "o termo mudou", o painel mostra, o envio em
--      lote trata como pendente, o job desmarca a aula futura que ele tinha
--      marcado com o motivo certo — e o aceite da versão nova volta a marcar;
--    * o aceite grava a versão LIDA: a página e o cartão mandam a versão
--      exibida e o servidor recusa ("termo_mudou") a que não é a vigente — sem
--      gastar o código do WhatsApp; sem versão (PWA antigo), também recusa;
--      recusar vale sempre e guarda a versão lida;
--    * a versão é a que valia no FIM da aula: aula que terminou antes da
--      versão nova continua importável; a futura e a que estava em andamento
--      na publicação ficam barradas.
-- 4. Retenção: toda versão de resumo (rascunho E aprovada) perde os trechos
--    da aula (narrative, evidence) 90 dias depois dela; quem deixou a escola
--    há mais de 90 dias perde a memória MEET_SESSION, o cartão e o conteúdo dos
--    resumos; a trilha só tem contagens; a segunda rodada não apaga nada.
--
-- Reprova contra o código anterior: sem a v3 (bloco 1), sem o texto preenchido
-- no servidor (bloco 2), com o aceite de versão antiga valendo, com o aceite
-- gravando a versão do clique ou com a aula já dada barrada pela versão nova
-- (bloco 3), e com o resumo aprovado guardando os trechos para sempre (bloco
-- 4). Não depende de dado real, da fila global nem do horário do dia (as datas
-- são relativas a now()).
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.v3_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'termo v3: %', p_message;
  end if;
end;
$$;
grant execute on function pg_temp.v3_assert(boolean, text) to public;

-- Decisão do aluno como a página grava: link, código confirmado pelo WhatsApp.
create or replace function pg_temp.v3_student_decision(
  p_tenant text, p_student uuid, p_actor uuid, p_decision text, p_version text
) returns void language plpgsql as $$
declare
  v_link uuid;
  v_challenge uuid := gen_random_uuid();
begin
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values (p_tenant, p_student, encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), p_actor,
    now() + interval '1 day', now())
  returning id into v_link;
  insert into private.lesson_recording_consent_challenges (id, link_id, tenant_id, student_id, relation, destination,
    code_hash, delivery_status, expires_at, consumed_at)
  values (v_challenge, v_link, p_tenant, p_student, 'GUARDIAN', '5511900009999',
    encode(extensions.digest(v_challenge::text, 'sha256'), 'hex'), 'SENT', now() + interval '10 minutes', now());
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, link_id, verification, verified_phone,
    verification_challenge_id)
  values (p_tenant, p_student, 'STUDENT', p_decision, 'Responsavel Fixture', 'GUARDIAN', 'STUDENT', p_version,
    'LINK', v_link, 'WHATSAPP_CODE', '(11) •••••-9999', v_challenge);
end;
$$;

-- Decisão do professor pelo cartão (a RPC de verdade, como o professor logado).
-- Devolve o código do erro quando o servidor recusa.
create or replace function pg_temp.v3_teacher_rpc(p_teacher uuid, p_accept boolean, p_version text)
returns text language plpgsql as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_result jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_teacher, 'role', 'authenticated')::text, true);
  begin
    v_result := public.set_my_lesson_recording_consent(p_accept, p_version);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    return sqlerrm;
  end;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return (v_result ->> 'decision') || ':' || (v_result ->> 'term_version');
end;
$$;

-- Código do termo pelo fluxo real: emitido para a edge (service_role) e
-- "entregue". Devolve o código em claro (só o teste o conhece).
create or replace function pg_temp.v3_issue_code(p_token text, p_relation text)
returns jsonb language plpgsql as $$
declare
  v_issue jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(p_token, p_relation);
  if not coalesce((v_issue ->> 'ok')::boolean, false) then
    raise exception 'termo v3: código do termo não saiu: %', v_issue;
  end if;
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', null);
  return v_issue;
end;
$$;

-- O banco de teste pode vir só com a estrutura: versões antigas, mais velhas
-- que a v3 publicada pela migration (em produção elas já existem).
insert into private.lesson_recording_terms (audience, version, body, published_at) values
  ('STUDENT', 'v1', repeat('Termo antigo do aluno. ', 20), now() - interval '3 days'),
  ('TEACHER', 'v1', repeat('Termo antigo do professor. ', 20), now() - interval '3 days'),
  ('STUDENT', 'v2', repeat('Termo antigo do aluno v2. ', 20), now() - interval '2 days'),
  ('TEACHER', 'v2', repeat('Termo antigo do professor v2. ', 20), now() - interval '2 days')
on conflict (audience, version) do nothing;

-- 1. Texto v3 --------------------------------------------------------------
do $text$
declare
  v_row record;
  v_current private.lesson_recording_terms;
begin
  perform pg_temp.v3_assert(
    (select count(*) = 2 from private.lesson_recording_terms where version = 'v3'),
    'textos v3 do termo (aluno e professor) ausentes'
  );
  for v_row in select * from private.lesson_recording_terms where version = 'v3' loop
    perform pg_temp.v3_assert(
      v_row.body like '%{escola_nome}%' and v_row.body like '%{escola_documento}%'
        and v_row.body like '%{escola_contato_privacidade}%',
      v_row.audience || ' v3 sem os marcadores do controlador'
    );
    perform pg_temp.v3_assert(
      not exists (
        select 1 from regexp_matches(v_row.body, '\{([^}]*)\}', 'g') as marker(parts)
        where marker.parts[1] not in ('escola_nome', 'escola_documento', 'escola_contato_privacidade')
      ),
      v_row.audience || ' v3 tem marcador que o servidor não sabe preencher'
    );
    -- Dado da escola nunca no código: nem CNPJ, nem e-mail, nem telefone.
    perform pg_temp.v3_assert(
      v_row.body !~ '[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}'
        and v_row.body !~ '@' and v_row.body !~ '[0-9]{8,}',
      v_row.audience || ' v3 traz dado da escola escrito no texto'
    );
    perform pg_temp.v3_assert(
      v_row.body like '%não é gravada em vídeo%'
        and v_row.body like '%inteligência artificial (IA)%'
        and v_row.body like '%aprova%'
        and v_row.body like '%próxima aula e a tarefa de casa%'
        and v_row.body like '%link que só abre com login%'
        and v_row.body like '%saúde, religião, política, família ou dinheiro%'
        and v_row.body like '%só interesses pedagógicos%'
        and v_row.body like '%Google Workspace%'
        and v_row.body like '%Provedor de IA contratado pela escola (OpenRouter)%'
        and v_row.body like '%treinar modelos desligado%'
        and v_row.body like '%90 dias%'
        and v_row.body like '%lixeira%'
        and v_row.body like '%deixar a escola%'
        and v_row.body like '%WhatsApp da escola%',
      v_row.audience || ' v3 não cobre o que o sistema faz (IA, dossiê, cartão, fornecedores, prazos ou direitos)'
    );
    -- O suporte da plataforma lê resumo aprovado e cartão de qualquer escola
    -- (google_meet_backend, cartão do aluno): o termo diz, e lista o
    -- fornecedor do sistema entre quem processa.
    perform pg_temp.v3_assert(
      v_row.body like '%suporte técnico do fornecedor do sistema pode ver o resumo aprovado e o cartão do aluno%'
        and v_row.body like '%Fornecedor do sistema que a escola usa%',
      v_row.audience || ' v3 não diz que o suporte da plataforma vê o resumo aprovado e o cartão'
    );
    -- O resumo aprovado guarda trechos das anotações e da transcrição por até
    -- 90 dias (a retenção apaga), e o termo diz.
    perform pg_temp.v3_assert(
      v_row.body like '%trechos das anotações e da transcrição%'
        and v_row.body like '%apagados 90 dias depois da aula, no rascunho e no resumo aprovado%'
        and v_row.body like '%Quando este termo mudar%',
      v_row.audience || ' v3 não diz o prazo dos trechos da aula no resumo aprovado ou o que acontece quando o termo muda'
    );
  end loop;
  perform pg_temp.v3_assert(
    (select body like '%Menores de 18 anos%' and body like '%Revogar a autorização%'
      from private.lesson_recording_terms where audience = 'STUDENT' and version = 'v3'),
    'termo do aluno sem o responsável ou sem a revogação'
  );
  perform pg_temp.v3_assert(
    (select body like '%Extrato de pontualidade%' and body like '%sem nota, sem ranking%'
        and body like '%não altera o seu pagamento%'
      from private.lesson_recording_terms where audience = 'TEACHER' and version = 'v3'),
    'termo do professor sem o extrato de pontualidade (sem ranking, sem mexer no pagamento)'
  );
  -- Qualquer versão vigente identifica o controlador pelos marcadores.
  foreach v_current in array array[
    private.lesson_recording_current_term('STUDENT'), private.lesson_recording_current_term('TEACHER')
  ] loop
    perform pg_temp.v3_assert(
      substring(v_current.version from 2)::integer >= 3
        and v_current.body like '%{escola_nome}%' and v_current.body like '%{escola_documento}%'
        and v_current.body like '%{escola_contato_privacidade}%',
      'versão vigente anterior à v3 ou sem os marcadores: ' || coalesce(v_current.version, 'nenhuma')
    );
  end loop;
end
$text$;

-- 2. Quem é a escola no termo ----------------------------------------------
do $identity$
declare
  v_full jsonb;
  v_empty jsonb;
  v_markers text[];
  v_filled text;
  v_braces text;
  v_offenders text;
begin
  insert into public.tenants (id, name, saas_status, school_info) values
    ('v3-termo-fixture', 'Escola Fixture', 'active', jsonb_build_object(
      'name', 'Escola Fixture',
      'legalName', '  Escola Fixture   Idiomas LTDA ',
      'cnpj', '11222333000181',
      'privacyContactEmail', 'privacidade@escola-fixture.invalid',
      'privacyOfficerName', 'Encarregada Fixture')),
    ('v3-termo-vazia', 'Escola Sem Dados', 'active', null),
    ('v3-termo-chaves', 'Escola {escola_nome}', 'active', jsonb_build_object(
      'legalName', '{escola_documento} Idiomas {x}'));

  v_full := private.lesson_recording_school_identity('v3-termo-fixture');
  perform pg_temp.v3_assert(
    v_full ->> 'escola_nome' = 'Escola Fixture Idiomas LTDA'
      and v_full ->> 'escola_documento' = 'CNPJ 11.222.333/0001-81'
      and v_full ->> 'escola_contato_privacidade' = 'Encarregada Fixture — privacidade@escola-fixture.invalid'
      and v_full -> 'missing' = '[]'::jsonb,
    'identidade da escola completa saiu errada: ' || v_full::text
  );
  v_empty := private.lesson_recording_school_identity('v3-termo-vazia');
  perform pg_temp.v3_assert(
    v_empty ->> 'escola_nome' = 'Escola Sem Dados'
      and v_empty ->> 'escola_documento' = 'CNPJ não informado pela escola'
      and v_empty ->> 'escola_contato_privacidade' = 'a direção da escola, pelo WhatsApp da escola'
      and v_empty -> 'missing' = '["razao_social", "cnpj", "contato_privacidade"]'::jsonb,
    'escola sem dados não caiu no texto neutro ou não disse o que falta: ' || v_empty::text
  );
  -- Os valores cobrem exatamente os marcadores do texto.
  select array_agg(distinct marker.parts[1] order by marker.parts[1]) into v_markers
  from private.lesson_recording_terms as term
  cross join lateral regexp_matches(term.body, '\{([^}]*)\}', 'g') as marker(parts)
  where term.version = 'v3';
  perform pg_temp.v3_assert(
    v_markers = (select array_agg(key order by key) from jsonb_object_keys(v_full - 'missing') as key),
    'marcadores do texto e valores da escola não batem'
  );

  -- O servidor preenche o texto: nenhum marcador sobra, e sai o controlador.
  v_filled := private.lesson_recording_fill_term(
    (select body from private.lesson_recording_terms where audience = 'STUDENT' and version = 'v3'),
    'v3-termo-fixture');
  perform pg_temp.v3_assert(
    v_filled not like '%{escola_%'
      and v_filled like '%A escola: Escola Fixture Idiomas LTDA, CNPJ 11.222.333/0001-81. Contato para assuntos de privacidade: Encarregada Fixture — privacidade@escola-fixture.invalid.%',
    'texto do termo preenchido no servidor saiu com marcador ou sem o controlador'
  );
  -- Nome da escola com chaves não vira (nem parece) marcador.
  v_braces := private.lesson_recording_fill_term(
    (select body from private.lesson_recording_terms where audience = 'TEACHER' and version = 'v3'),
    'v3-termo-chaves');
  perform pg_temp.v3_assert(
    v_braces not like '%{%' and v_braces not like '%}%'
      and v_braces like '%A escola: escola_documento Idiomas x, CNPJ não informado pela escola.%',
    'dado da escola com chaves virou marcador no texto preenchido'
  );

  -- Auditoria: toda rota do app/página (schema public) que devolve o texto do
  -- termo passa por lesson_recording_fill_term. Rota nova que ler
  -- lesson_recording_current_term(...).body sem preencher (a tela do aluno com o
  -- próprio registro, por exemplo) reprova aqui — o aluno veria {escola_nome}
  -- no lugar do controlador.
  select string_agg(procedure.oid::regprocedure::text, ', ' order by procedure.oid::regprocedure::text)
    into v_offenders
  from pg_proc as procedure
  join pg_namespace as namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.prosrc ~ 'lesson_recording_(current_term|terms)'
    and procedure.prosrc ~ '\mbody\M'
    and procedure.prosrc !~ 'lesson_recording_fill_term';
  perform pg_temp.v3_assert(v_offenders is null,
    'rota devolve o texto do termo sem preencher a escola (use private.lesson_recording_fill_term): ' || coalesce(v_offenders, ''));

  -- Funções internas: navegador não chama.
  perform pg_temp.v3_assert(
    not has_function_privilege('anon', 'private.lesson_recording_school_identity(text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.lesson_recording_school_identity(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'private.lesson_recording_fill_term(text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.lesson_recording_fill_term(text,text)', 'EXECUTE'),
    'identidade da escola exposta como rota'
  );
end
$identity$;

-- 3. Aceite por versão -------------------------------------------------------
do $version$
declare
  v_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_refused uuid := gen_random_uuid();
  v_adult uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_past uuid := gen_random_uuid();
  v_ongoing uuid := gen_random_uuid();
  v_old_student text := (private.lesson_recording_current_term('STUDENT')).version;
  v_old_teacher text := (private.lesson_recording_current_term('TEACHER')).version;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_adult_token text;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_issue jsonb;
  v_row jsonb;
  v_roster record;
  v_reason text;
  v_consents integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'v3-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'v3-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student, 'v3-student@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_refused, 'v3-refused@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_adult, 'v3-adult@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'v3-termo-fixture', lifecycle_status = 'active', status = 'Ativo',
         is_test_account = false,
         role = case when id = v_admin then 'SCHOOL_ADMIN' when id = v_teacher then 'TEACHER' else 'STUDENT' end,
         full_name = case when id = v_admin then 'Direcao Fixture' when id = v_teacher then 'Professora Fixture'
           when id = v_student then 'Aluna Fixture' when id = v_adult then 'Adulta Fixture Silva'
           else 'Aluno Recusou Fixture' end,
         phone = case when id in (v_student, v_refused) then '5511977771234'
           when id = v_adult then '5511955550077' end,
         professor_id = case when id in (v_student, v_refused, v_adult) then v_teacher end,
         birth_date = null, is_kids = false
   where id in (v_admin, v_teacher, v_student, v_refused, v_adult);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id in (v_admin, v_teacher, v_student, v_refused, v_adult)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
  values ('v3-termo-fixture', 'v3-sub-central', 'central@escola-fixture.invalid', 'CONNECTED', v_admin);
  -- O professor só autoriza com a conta Google confirmada (20260926180000).
  insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
  values (v_teacher, 'v3-termo-fixture', 'v3-sub-professora', 'professora.fixture@example.com', true);
  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key) values
    (v_session, 'v3-termo-fixture', v_student, v_teacher, v_today,
      now() + interval '2 hours', now() + interval '150 minutes', 'v3-future'),
    -- Aula que já terminou (ainda não importada) e aula em andamento.
    (v_past, 'v3-termo-fixture', v_student, v_teacher, v_today,
      now() - interval '90 minutes', now() - interval '60 minutes', 'v3-past'),
    (v_ongoing, 'v3-termo-fixture', v_student, v_teacher, v_today,
      now() - interval '10 minutes', now() + interval '20 minutes', 'v3-ongoing');
  -- Link vivo para a página pública.
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at)
  values ('v3-termo-fixture', v_student, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_admin,
    now() + interval '30 days');

  -- O cartão manda a versão que mostrou: sem versão (PWA antigo) ou com uma
  -- que não é a vigente, o aceite é recusado e nada é gravado.
  perform pg_temp.v3_assert(pg_temp.v3_teacher_rpc(v_teacher, true, null) = 'termo_mudou',
    'aceite do professor sem a versão lida foi gravado');
  perform pg_temp.v3_assert(pg_temp.v3_teacher_rpc(v_teacher, true, 'v2') = 'termo_mudou',
    'aceite do professor de versão que não é a vigente foi gravado');
  perform pg_temp.v3_assert(
    not exists (select 1 from private.lesson_recording_consents where subject_id = v_teacher),
    'aceite recusado deixou decisão gravada');
  perform pg_temp.v3_assert(
    pg_temp.v3_teacher_rpc(v_teacher, true, v_old_teacher) = 'ACCEPTED:' || v_old_teacher,
    'aceite do professor com a versão vigente não gravou a versão lida');

  -- Aluno maior (data atestada pela escola) pela página: código de verdade.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_student_birth_date(v_adult, date '1990-05-10', 'Documento conferido (fixture)');
  v_adult_token := public.create_lesson_recording_consent_link(v_adult) ->> 'token';
  v_issue := pg_temp.v3_issue_code(v_adult_token, 'SELF');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.decide_lesson_recording_consent_public(v_adult_token, 'Adulta Fixture Silva', 'SELF', true,
    v_issue ->> 'code', 'v2');
  perform pg_temp.v3_assert(
    v_result ->> 'error' = 'termo_mudou' and v_result ->> 'term_version' = v_old_student,
    'aceite pela página de versão que não é a vigente não voltou "termo_mudou": ' || v_result::text);
  v_result := public.decide_lesson_recording_consent_public(v_adult_token, 'Adulta Fixture Silva', 'SELF', true,
    v_issue ->> 'code');
  perform pg_temp.v3_assert(v_result ->> 'error' = 'termo_mudou',
    'aceite pela página sem a versão lida (PWA antigo) não foi recusado: ' || v_result::text);
  perform pg_temp.v3_assert(
    not exists (select 1 from private.lesson_recording_consents where subject_id = v_adult)
      and (select consumed_at is null and attempts = 0 from private.lesson_recording_consent_challenges
        where id = (v_issue ->> 'challenge_id')::uuid),
    '"termo_mudou" gravou decisão, gastou o código ou contou tentativa');
  -- Relendo o texto vigente, o mesmo código confirma.
  v_result := public.decide_lesson_recording_consent_public(v_adult_token, 'Adulta Fixture Silva', 'SELF', true,
    v_issue ->> 'code', v_old_student);
  perform pg_temp.v3_assert(
    (v_result ->> 'ok')::boolean and v_result ->> 'term_version' = v_old_student
      and private.lesson_recording_decided_term_version(v_adult) = v_old_student
      and private.lesson_recording_student_consent_effective(v_adult),
    'aceite pela página com a versão vigente não valeu: ' || v_result::text);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Os dois aceitam a versão vigente: vale, e o job marca a aula futura. As
  -- aulas já em curso ou dadas são marcadas à parte (o job só marca as
  -- próximas 24 h), como o termo as teria marcado antes.
  perform pg_temp.v3_student_decision('v3-termo-fixture', v_student, v_admin, 'ACCEPTED', v_old_student);
  perform pg_temp.v3_student_decision('v3-termo-fixture', v_refused, v_admin, 'REFUSED', v_old_student);
  perform pg_temp.v3_assert(private.lesson_recording_active(v_student, v_teacher),
    'aceite da versão vigente não valeu');
  perform private.apply_standing_lesson_recording_consent('v3-termo-fixture');
  perform pg_temp.v3_assert((select documentation_consent from public.lesson_sessions where id = v_session),
    'os dois aceites não marcaram a aula');
  insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason, created_at)
  select session_id, v_admin, true,
    'Termo de registro das aulas: aluno (ou responsável) e professor aceitaram o registro permanente.',
    now() - interval '3 hours'
  from unnest(array[v_past, v_ongoing]) as marked(session_id);
  update public.lesson_sessions set documentation_consent = true where id in (v_past, v_ongoing);
  perform pg_temp.v3_assert(
    not private.lesson_session_documentation_blocked(v_past)
      and not private.lesson_session_documentation_blocked(v_ongoing)
      and not private.lesson_session_documentation_blocked(v_session),
    'aula marcada pelo termo barrada antes de a versão mudar');

  -- Sai uma versão nova (aluno e professor).
  insert into private.lesson_recording_terms (audience, version, body, published_at) values
    ('STUDENT', 'v98', repeat('Termo novo do aluno. ', 12)
      || '{escola_nome}, {escola_documento}. Contato: {escola_contato_privacidade}.', now() + interval '1 minute'),
    ('TEACHER', 'v98', repeat('Termo novo do professor. ', 12)
      || '{escola_nome}, {escola_documento}. Contato: {escola_contato_privacidade}.', now() + interval '1 minute');
  perform pg_temp.v3_assert(private.lesson_recording_current_version('STUDENT') = 'v98'
    and private.lesson_recording_current_version('TEACHER') = 'v98', 'versão nova não virou a vigente');

  -- O aceite da versão anterior não vale mais — nem do aluno, nem do professor.
  perform pg_temp.v3_assert(
    private.lesson_recording_consent_state(v_student) = 'ACCEPTED'
      and not private.lesson_recording_student_consent_effective(v_student),
    'aceite do aluno de versão anterior continuou valendo'
  );
  perform pg_temp.v3_assert(
    private.lesson_recording_consent_state(v_teacher) = 'ACCEPTED'
      and not private.lesson_recording_teacher_consent_effective(v_teacher),
    'aceite do professor de versão anterior continuou valendo'
  );
  perform pg_temp.v3_assert(
    not private.lesson_recording_active(v_student, v_teacher)
      and private.lesson_recording_accepted_outdated_term(v_student)
      and private.lesson_recording_accepted_outdated_term(v_teacher)
      and not private.lesson_recording_accepted_outdated_term(v_refused),
    'aula seguiu marcável com aceites de versão anterior'
  );
  -- Na hora, sem esperar o job: a aula futura e a que estava em andamento na
  -- publicação ficam sem aceite efetivo...
  perform pg_temp.v3_assert(
    private.lesson_session_documentation_blocked(v_session)
      and private.lesson_session_documentation_blocked(v_ongoing),
    'aula futura ou em andamento, marcada pelo termo antigo, seguiu com aceite efetivo');
  -- ...mas a que TERMINOU sob o aceite válido continua importável: a versão
  -- nova não cega a importação (transcrição, presença) da aula já dada.
  perform pg_temp.v3_assert(not private.lesson_session_documentation_blocked(v_past),
    'versão nova do termo barrou a importação de aula que terminou sob aceite válido');

  -- O cartão aberto na versão anterior não grava aceite da versão nova.
  select count(*) into v_consents from private.lesson_recording_consents where subject_id = v_teacher;
  v_reason := pg_temp.v3_teacher_rpc(v_teacher, true, v_old_teacher);
  perform pg_temp.v3_assert(v_reason = 'termo_mudou'
      and (select count(*) from private.lesson_recording_consents where subject_id = v_teacher) = v_consents,
    'aceite do cartão aberto na versão anterior foi gravado como aceite da versão nova: ' || coalesce(v_reason, ''));

  -- Página pública: "o termo mudou", a versão aceita e quem é a escola — com o
  -- texto já preenchido pelo servidor.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.get_lesson_recording_consent_public(v_token);
  perform pg_temp.v3_assert(
    v_result ->> 'term_version' = 'v98'
      and v_result ->> 'current_decision' = 'ACCEPTED'
      and not (v_result ->> 'current_effective')::boolean
      and v_result ->> 'current_not_effective_reason' = 'TERM_UPDATED'
      and v_result ->> 'decided_term_version' = v_old_student
      and v_result -> 'school_identity' ->> 'escola_documento' = 'CNPJ 11.222.333/0001-81',
    'página pública não disse que o termo mudou: ' || v_result::text
  );
  perform pg_temp.v3_assert(
    v_result ->> 'term_body' not like '%{escola_%'
      and v_result ->> 'term_body' like '%Escola Fixture Idiomas LTDA, CNPJ 11.222.333/0001-81. Contato: Encarregada Fixture%',
    'página pública devolveu o texto com marcador cru: ' || coalesce(v_result ->> 'term_body', 'sem texto')
  );

  -- Cartão do professor.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_result := public.get_my_lesson_recording_consent();
  perform pg_temp.v3_assert(
    v_result ->> 'decision' = 'ACCEPTED'
      and (v_result ->> 'term_updated')::boolean
      and not (v_result ->> 'effective')::boolean
      and v_result ->> 'decided_term_version' = v_old_teacher
      and v_result ->> 'term_version' = 'v98'
      and v_result -> 'school_identity' ->> 'escola_nome' = 'Escola Fixture Idiomas LTDA'
      and v_result ->> 'term_body' not like '%{escola_%'
      and v_result ->> 'term_body' like '%Escola Fixture Idiomas LTDA%',
    'cartão do professor não disse que o termo mudou ou devolveu marcador cru: ' || v_result::text
  );

  -- Painel da direção.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.list_lesson_recording_consents();
  select item into v_row from jsonb_array_elements(v_result -> 'students') as item
   where item ->> 'student_id' = v_student::text;
  perform pg_temp.v3_assert(
    v_row ->> 'decision' = 'ACCEPTED' and not (v_row ->> 'effective')::boolean
      and (v_row ->> 'term_updated')::boolean and v_row ->> 'decided_term_version' = v_old_student,
    'painel não mostrou o aceite do aluno de versão anterior: ' || coalesce(v_row::text, 'aluno ausente')
  );
  select item into v_row from jsonb_array_elements(v_result -> 'teachers') as item
   where item ->> 'teacher_id' = v_teacher::text;
  perform pg_temp.v3_assert(
    v_row ->> 'decision' = 'ACCEPTED' and not (v_row ->> 'effective')::boolean
      and (v_row ->> 'term_updated')::boolean,
    'painel contou o professor como autorizado com o termo antigo: ' || coalesce(v_row::text, 'professor ausente')
  );
  perform pg_temp.v3_assert(
    v_result -> 'term_versions' ->> 'STUDENT' = 'v98'
      and v_result -> 'term_identity' ->> 'escola_contato_privacidade' like 'Encarregada Fixture%',
    'painel sem o termo vigente ou sem a identidade da escola'
  );

  -- Envio em lote: quem aceitou a versão anterior está pendente ("termo
  -- atualizado"); quem recusou continua sem pedido novo (regra da onda 1).
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select * into v_roster from private.lesson_recording_request_roster('v3-termo-fixture') as roster
   where roster.student_id = v_student;
  perform pg_temp.v3_assert(v_roster.eligible and v_roster.term_updated and not v_roster.reconfirm,
    'envio em lote não tratou o aceite de versão anterior como pendente');
  select * into v_roster from private.lesson_recording_request_roster('v3-termo-fixture') as roster
   where roster.student_id = v_refused;
  perform pg_temp.v3_assert(v_roster.student_id is not null and not v_roster.eligible,
    'quem recusou a versão anterior voltou a receber pedido');

  -- O job desmarca o que ele tinha marcado e ainda não terminou, com o motivo
  -- certo; a aula já dada fica marcada (a importação dela segue).
  perform private.apply_standing_lesson_recording_consent('v3-termo-fixture');
  select event.reason into v_reason from private.lesson_documentation_consent_events as event
   where event.session_id = v_session order by event.created_at desc limit 1;
  perform pg_temp.v3_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session)
      and v_reason like 'Termo de registro das aulas: o termo mudou de versão e o aluno (ou o responsável) e o professor%',
    'o job não desmarcou a aula do termo antigo, ou registrou o motivo errado: ' || coalesce(v_reason, 'sem evento')
  );
  perform pg_temp.v3_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_ongoing)
      and (select documentation_consent from public.lesson_sessions where id = v_past),
    'o job não desmarcou a aula em andamento ou desmarcou a aula já dada');

  -- Aceitam a versão nova: vale de novo e o job remarca.
  perform pg_temp.v3_student_decision('v3-termo-fixture', v_student, v_admin, 'ACCEPTED', 'v98');
  perform pg_temp.v3_assert(pg_temp.v3_teacher_rpc(v_teacher, true, 'v98') = 'ACCEPTED:v98',
    'aceite do professor da versão nova não foi gravado');
  perform pg_temp.v3_assert(private.lesson_recording_active(v_student, v_teacher),
    'aceite da versão nova não valeu');
  perform private.apply_standing_lesson_recording_consent('v3-termo-fixture');
  perform pg_temp.v3_assert(
    (select documentation_consent from public.lesson_sessions where id = v_session)
      and not private.lesson_session_documentation_blocked(v_session)
      and not private.lesson_session_documentation_blocked(v_past),
    'aceite da versão nova não remarcou a aula (ou barrou a aula já dada)'
  );

  -- Só o termo do professor muda: o motivo diz que falta o professor.
  insert into private.lesson_recording_terms (audience, version, body, published_at) values
    ('TEACHER', 'v99', repeat('Termo novíssimo do professor. ', 10)
      || '{escola_nome}, {escola_documento}. Contato: {escola_contato_privacidade}.', now() + interval '2 minutes');
  perform pg_temp.v3_assert(private.lesson_recording_student_consent_effective(v_student)
    and not private.lesson_recording_active(v_student, v_teacher),
    'termo do professor mudou e a aula seguiu marcável');
  perform private.apply_standing_lesson_recording_consent('v3-termo-fixture');
  select event.reason into v_reason from private.lesson_documentation_consent_events as event
   where event.session_id = v_session order by event.created_at desc limit 1;
  perform pg_temp.v3_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session)
      and v_reason = 'Termo de registro das aulas: o termo mudou de versão e o professor ainda não aceitou a versão vigente.',
    'motivo do desmarque pela versão do professor errado: ' || coalesce(v_reason, 'sem evento')
  );

  -- Recusar vale sempre, mesmo da versão anterior, e guarda a versão lida.
  -- (A conferência vai noutro comando: o SELECT não enxerga o que a função
  -- chamada nele gravou.)
  v_reason := pg_temp.v3_teacher_rpc(v_teacher, false, 'v98');
  perform pg_temp.v3_assert(v_reason = 'REFUSED:v98'
      and private.lesson_recording_consent_state(v_teacher) = 'REFUSED'
      and private.lesson_recording_decided_term_version(v_teacher) = 'v98',
    'recusa do professor na versão anterior não foi gravada com a versão lida: ' || coalesce(v_reason, ''));
  v_issue := pg_temp.v3_issue_code(v_adult_token, 'SELF');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.decide_lesson_recording_consent_public(v_adult_token, 'Adulta Fixture Silva', 'SELF', false,
    v_issue ->> 'code', v_old_student);
  perform pg_temp.v3_assert(
    v_result ->> 'decision' = 'REFUSED' and v_result ->> 'term_version' = v_old_student
      and private.lesson_recording_consent_state(v_adult) = 'REFUSED',
    'recusa pela página na versão anterior não valeu: ' || v_result::text);

  -- A rota antiga, que gravava a versão do clique, não existe mais.
  perform pg_temp.v3_assert(
    to_regprocedure('public.set_my_lesson_recording_consent(boolean)') is null
      and to_regprocedure('public.decide_lesson_recording_consent_public(text,text,text,boolean,text)') is null
      and has_function_privilege('authenticated', 'public.set_my_lesson_recording_consent(boolean,text)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.set_my_lesson_recording_consent(boolean,text)', 'EXECUTE')
      and has_function_privilege('anon', 'public.decide_lesson_recording_consent_public(text,text,text,boolean,text,text)', 'EXECUTE'),
    'rotas de decisão com a assinatura antiga ainda existem, ou as novas sem os grants certos');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$version$;

-- 3b. Marcação manual × versão do termo, e o teto das cópias brutas ---------
-- (correção da integração da onda 2). A direção marca à mão quem aceitou a
-- versão vigente e quem nunca respondeu no sistema (comprovante por outro
-- meio). Quando sai uma versão nova, a marcação manual de quem tinha aceitado a
-- anterior deixa de valer (o termo promete: até responder de novo, as próximas
-- aulas não são transcritas) e a direção não marca por cima; quem nunca
-- respondeu segue com a marcação — até o termo do PROFESSOR mudar. As cópias
-- brutas ficam no máximo 90 dias, qualquer que seja o prazo pedido pela edge.
do $manual$
declare
  v_tenant constant text := 'v3-manual-fixture';
  v_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_ok uuid := gen_random_uuid();
  v_none uuid := gen_random_uuid();
  v_ok_marked uuid := gen_random_uuid();
  v_none_marked uuid := gen_random_uuid();
  v_ok_later uuid := gen_random_uuid();
  v_none_later uuid := gen_random_uuid();
  v_student_version text := private.lesson_recording_current_version('STUDENT');
  v_teacher_version text := private.lesson_recording_current_version('TEACHER');
  v_result jsonb;
  v_error text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name) values (v_tenant, 'Marcação manual fixture');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'v3-manual-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'v3-manual-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_ok, 'v3-manual-ok@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_none, 'v3-manual-none@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = v_tenant, lifecycle_status = 'active', status = 'Ativo', is_test_account = true,
         role = case when id = v_admin then 'SCHOOL_ADMIN' when id = v_teacher then 'TEACHER' else 'STUDENT' end,
         full_name = case when id = v_admin then 'Direcao Manual Fixture' when id = v_teacher then 'Professor Manual Fixture'
           when id = v_ok then 'Aluno Aceitou Fixture' else 'Aluno Sem Resposta Fixture' end,
         professor_id = case when id in (v_ok, v_none) then v_teacher end
   where id in (v_admin, v_teacher, v_ok, v_none);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id in (v_admin, v_teacher, v_ok, v_none)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key)
  select fixture.id, v_tenant, fixture.student_id, v_teacher, ((now() + interval '2 hours') at time zone 'America/Sao_Paulo')::date,
    now() + interval '2 hours', now() + interval '150 minutes', fixture.source_key
  from (values (v_ok_marked, v_ok, 'v3-manual-ok'), (v_none_marked, v_none, 'v3-manual-none'),
    (v_ok_later, v_ok, 'v3-manual-ok-later'), (v_none_later, v_none, 'v3-manual-none-later'))
    as fixture(id, student_id, source_key);
  perform pg_temp.v3_student_decision(v_tenant, v_ok, v_admin, 'ACCEPTED', v_student_version);
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, recorded_by)
  values (v_tenant, v_teacher, 'TEACHER', 'ACCEPTED', 'Professor Manual Fixture', 'SELF', 'TEACHER',
    v_teacher_version, 'APP', v_teacher);

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_lesson_documentation_consent(v_ok_marked, true, 'Autorização conferida na secretaria.');
  perform public.set_lesson_documentation_consent(v_none_marked, true, 'Autorização em papel arquivada na secretaria.');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.v3_assert(
    (select bool_and(documentation_consent) from public.lesson_sessions where id in (v_ok_marked, v_none_marked))
      and not private.lesson_session_documentation_blocked(v_ok_marked)
      and not private.lesson_session_documentation_blocked(v_none_marked),
    'marcação manual da direção não valeu (aceite vigente ou comprovante por outro meio)');

  -- Teto das cópias brutas: a edge pede 365 dias, o banco guarda 90.
  v_result := public.google_meet_backend('artifact_save', v_tenant, v_admin, v_ok_marked, jsonb_build_object(
    'provider_name', 'conferenceRecords/v3m/transcripts/t1', 'kind', 'TRANSCRIPT', 'document_id', 'docV3Manual',
    'content_sha256', repeat('9', 64), 'source_text', 'Fala da aula.', 'retention_days', 365));
  perform public.google_meet_attendance_backend('attendance_save', v_tenant, v_ok_marked, jsonb_build_object(
    'document_id', 'sheetV3Manual', 'document_name', 'Planilha', 'source_csv', 'csv', 'content_sha256', repeat('8', 64),
    'retention_days', 365));
  perform pg_temp.v3_assert(
    (select expires_at <= now() + interval '90 days' from private.meeting_artifact_revisions
      where id = (v_result ->> 'id')::uuid)
    and (select expires_at <= now() + interval '90 days' from private.meeting_attendance_reports
      where lesson_session_id = v_ok_marked)
    and (private.lesson_memory_retention_policy() ->> 'raw_copies_days')::integer = 90,
    'cópia bruta guardada por mais de 90 dias (o termo promete 90)');

  -- Versão nova do termo do aluno.
  insert into private.lesson_recording_terms (audience, version, body, published_at) values
    ('STUDENT', 'v100', repeat('Termo do aluno da marcação manual. ', 10)
      || '{escola_nome}, {escola_documento}. Contato: {escola_contato_privacidade}.', now() + interval '3 minutes');
  perform pg_temp.v3_assert(private.lesson_session_documentation_blocked(v_ok_marked)
      and not private.lesson_session_documentation_blocked(v_none_marked),
    'marcação manual de quem aceitou a versão anterior continuou valendo (ou a de quem nunca respondeu caiu)');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_error := null;
  begin
    perform public.set_lesson_documentation_consent(v_ok_later, true, 'Autorização conferida na secretaria.');
  exception when others then v_error := sqlerrm; end;
  perform pg_temp.v3_assert(v_error = 'termo_mudou_aceite_do_aluno_pendente'
      and not (select documentation_consent from public.lesson_sessions where id = v_ok_later),
    'a direção marcou à mão por cima do aceite do aluno de versão anterior: ' || coalesce(v_error, 'sem erro'));

  -- Versão nova do termo do professor.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into private.lesson_recording_terms (audience, version, body, published_at) values
    ('TEACHER', 'v100', repeat('Termo do professor da marcação manual. ', 10)
      || '{escola_nome}, {escola_documento}. Contato: {escola_contato_privacidade}.', now() + interval '4 minutes');
  perform pg_temp.v3_assert(private.lesson_session_documentation_blocked(v_none_marked),
    'marcação manual continuou valendo com o aceite do professor de versão anterior');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_error := null;
  begin
    perform public.set_lesson_documentation_consent(v_none_later, true, 'Autorização em papel arquivada na secretaria.');
  exception when others then v_error := sqlerrm; end;
  perform pg_temp.v3_assert(v_error = 'termo_mudou_aceite_do_professor_pendente',
    'a direção marcou à mão por cima do aceite do professor de versão anterior: ' || coalesce(v_error, 'sem erro'));
  -- Desligar sempre pode.
  v_result := public.set_lesson_documentation_consent(v_ok_marked, false, 'Direção retirou a marcação manual.');
  perform pg_temp.v3_assert((v_result ->> 'ok')::boolean
      and not (select documentation_consent from public.lesson_sessions where id = v_ok_marked),
    'a direção não conseguiu desligar a marcação');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$manual$;

-- 4. Retenção ------------------------------------------------------------------
do $retention$
declare
  v_admin uuid := (select id from public.profiles where tenant_id = 'v3-termo-fixture' and role = 'SCHOOL_ADMIN' limit 1);
  v_teacher uuid := (select id from public.profiles where tenant_id = 'v3-termo-fixture' and role = 'TEACHER' limit 1);
  v_keep uuid := gen_random_uuid();
  v_gone uuid := gen_random_uuid();
  v_recent uuid := gen_random_uuid();
  v_keep_old uuid := gen_random_uuid();
  v_keep_new uuid := gen_random_uuid();
  v_gone_old uuid := gen_random_uuid();
  v_recent_old uuid := gen_random_uuid();
  v_keep_old_draft uuid := gen_random_uuid();
  v_keep_old_verified uuid := gen_random_uuid();
  v_keep_new_draft uuid := gen_random_uuid();
  v_gone_draft uuid := gen_random_uuid();
  v_gone_verified uuid := gen_random_uuid();
  v_recent_verified uuid := gen_random_uuid();
  v_content jsonb := jsonb_build_object(
    'narrative', 'Texto copiado da transcrição da aula.',
    'evidence', jsonb_build_array(jsonb_build_object('artifact_id', 'x', 'quote', 'trecho literal')),
    'lesson_objective', 'Present perfect',
    'content_practiced', jsonb_build_array('have been'),
    'recommended_next_step', 'Revisar os verbos');
  v_left timestamptz := now() - interval '100 days';
  v_run_basis uuid := gen_random_uuid();
  v_run_plain uuid := gen_random_uuid();
  v_keep_memory uuid;
  v_snapshot jsonb;
  v_result jsonb;
  v_trail private.lesson_memory_retention_runs;
  v_trails integer;
  v_scheduled boolean;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_keep, 'v3-keep@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_gone, 'v3-gone@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_recent, 'v3-recent@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'v3-termo-fixture', role = 'STUDENT', status = 'Ativo', lifecycle_status = 'active',
         full_name = 'Aluno Retencao Fixture', professor_id = v_teacher
   where id in (v_keep, v_gone, v_recent);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id in (v_keep, v_gone, v_recent)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key, status) values
    (v_keep_old, 'v3-termo-fixture', v_keep, v_teacher, (now() - interval '100 days')::date,
      now() - interval '100 days', now() - interval '100 days' + interval '30 minutes', 'v3-keep-old', 'LOGGED'),
    (v_keep_new, 'v3-termo-fixture', v_keep, v_teacher, (now() - interval '10 days')::date,
      now() - interval '10 days', now() - interval '10 days' + interval '30 minutes', 'v3-keep-new', 'LOGGED'),
    (v_gone_old, 'v3-termo-fixture', v_gone, v_teacher, (now() - interval '120 days')::date,
      now() - interval '120 days', now() - interval '120 days' + interval '30 minutes', 'v3-gone-old', 'LOGGED'),
    (v_recent_old, 'v3-termo-fixture', v_recent, v_teacher, (now() - interval '60 days')::date,
      now() - interval '60 days', now() - interval '60 days' + interval '30 minutes', 'v3-recent-old', 'LOGGED');

  insert into private.lesson_summary_versions (id, tenant_id, lesson_session_id, version, parent_version_id,
    status, origin, content, created_by) values
    (v_keep_old_draft, 'v3-termo-fixture', v_keep_old, 1, null, 'PROPOSED', 'GOOGLE_SMART_NOTES', v_content, null),
    (v_keep_old_verified, 'v3-termo-fixture', v_keep_old, 2, v_keep_old_draft, 'VERIFIED', 'HUMAN_REVIEW', v_content, v_teacher),
    (v_keep_new_draft, 'v3-termo-fixture', v_keep_new, 1, null, 'PROPOSED', 'GOOGLE_SMART_NOTES', v_content, null),
    (v_gone_draft, 'v3-termo-fixture', v_gone_old, 1, null, 'PROPOSED', 'GOOGLE_SMART_NOTES', v_content, null),
    (v_gone_verified, 'v3-termo-fixture', v_gone_old, 2, v_gone_draft, 'VERIFIED', 'HUMAN_REVIEW', v_content, v_teacher),
    (v_recent_verified, 'v3-termo-fixture', v_recent_old, 1, null, 'VERIFIED', 'HUMAN_REVIEW', v_content, v_teacher);

  insert into public.student_learning_memories (tenant_id, student_id, source_type, source_ref, occurred_at,
    lesson_objective, verification_status) values
    ('v3-termo-fixture', v_keep, 'MEET_SESSION', v_keep_old::text, now() - interval '100 days', 'Present perfect', 'VERIFIED'),
    ('v3-termo-fixture', v_gone, 'MEET_SESSION', v_gone_old::text, now() - interval '120 days', 'Past simple', 'VERIFIED'),
    ('v3-termo-fixture', v_gone, 'MANUAL', 'v3-manual', now() - interval '120 days', 'Anotação manual', 'VERIFIED'),
    ('v3-termo-fixture', v_recent, 'MEET_SESSION', v_recent_old::text, now() - interval '60 days', 'Futuro', 'VERIFIED');

  -- Planos do Planner com a base das aulas aprovadas (20260927130000): a base
  -- copia o próximo passo do resumo aprovado — sai 90 dias depois de o aluno
  -- deixar a escola, como o resumo; o plano fica. Quem continua não perde.
  -- A memória que o Planner propôs com as aulas aprovadas na entrada (a linha
  -- PLANNER_AI da geração com lesson_basis e o student_memory_update do plano)
  -- copia erros e próximo passo delas: sai junto. A de geração sem aula
  -- aprovada fica.
  insert into public.planner_ai_runs (id, tenant_id, teacher_id, student_id, task_mode, model_id, prompt_version, result, status) values
    (v_run_basis, 'v3-termo-fixture', v_teacher, v_gone, 'progress_report', 'fixture/modelo', 'fixture',
      jsonb_build_object('lesson_basis', jsonb_build_object('lesson_dates', jsonb_build_array('2026-06-01')),
        'student_memory_update', jsonb_build_object('recurring_errors', jsonb_build_array('ERRO-DA-AULA-APROVADA'))), 'SAVED'),
    (v_run_plain, 'v3-termo-fixture', v_teacher, v_gone, 'lesson_plan', 'fixture/modelo', 'fixture',
      jsonb_build_object('lesson_basis', null,
        'student_memory_update', jsonb_build_object('lesson_objective', 'Objetivo do Wolfie')), 'SAVED');
  insert into public.lesson_plans (tenant_id, teacher_id, student_id, structured_plan, student_memory_update, planner_run_id) values
    ('v3-termo-fixture', v_teacher, v_gone, jsonb_build_object('title', 'Plano do que saiu',
      'lesson_basis', jsonb_build_object('continued_from', jsonb_build_object('recommended_next_step', 'Revisar os verbos')),
      'student_memory_update', jsonb_build_object('recurring_errors', jsonb_build_array('ERRO-DA-AULA-APROVADA'))),
      jsonb_build_object('recurring_errors', jsonb_build_array('ERRO-DA-AULA-APROVADA')), v_run_basis),
    ('v3-termo-fixture', v_teacher, v_keep, jsonb_build_object('title', 'Plano do que ficou',
      'lesson_basis', jsonb_build_object('continued_from', jsonb_build_object('recommended_next_step', 'Revisar os verbos'))),
      '{}'::jsonb, null);
  insert into public.student_learning_memories (tenant_id, student_id, source_type, source_ref, occurred_at,
    lesson_objective, recurring_errors, verification_status) values
    ('v3-termo-fixture', v_gone, 'PLANNER_AI', v_run_basis::text, now() - interval '110 days', '',
      array['ERRO-DA-AULA-APROVADA'], 'PROPOSED'),
    ('v3-termo-fixture', v_gone, 'PLANNER_AI', v_run_plain::text, now() - interval '110 days', 'Objetivo do Wolfie',
      '{}'::text[], 'PROPOSED');

  -- Confirmação de leitura do dossiê: guarda o que foi lido por referência,
  -- nunca o texto (nem a retenção nem a exclusão alcançam essa tabela).
  select id into v_keep_memory from public.student_learning_memories
   where student_id = v_keep and source_type = 'MEET_SESSION';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_result := public.get_student_handover(v_keep, true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select snapshot into v_snapshot from private.student_handover_reads
   where student_id = v_keep order by created_at desc limit 1;
  perform pg_temp.v3_assert(
    v_result -> 'memories' -> 0 ->> 'lesson_objective' = 'Present perfect'
      and v_snapshot::text not like '%Present perfect%'
      and jsonb_array_length(v_snapshot -> 'memories') = 1
      and v_snapshot -> 'memories' -> 0 ->> 'id' = v_keep_memory::text
      and v_snapshot -> 'memories' -> 0 ->> 'source_type' = 'MEET_SESSION'
      and v_snapshot ? 'learning_card_version',
    'confirmação de leitura do dossiê copiou o texto da memória (ou perdeu a referência): ' || coalesce(v_snapshot::text, 'sem linha'));

  -- Idade não comprovada = menor para o cartão: só objetivo e temas.
  insert into public.student_learning_cards (tenant_id, student_id, real_goal, engaging_topics) values
    ('v3-termo-fixture', v_keep, 'Viajar a trabalho', array['futebol']),
    ('v3-termo-fixture', v_gone, 'Entrevista de emprego', array['música']),
    ('v3-termo-fixture', v_recent, 'Intercâmbio', array['filmes']);

  -- Dois deixaram a escola: um há 100 dias, outro há 30. O último dia de aula
  -- conta quando é depois da conclusão do desligamento.
  update public.profiles
     set lifecycle_status = 'offboarded', status = 'Inativo', offboarding_status = 'COMPLETED',
         offboarding_completed_at = case when id = v_gone then v_left else now() - interval '30 days' end,
         offboarding_last_day = case when id = v_recent
           then ((now() - interval '40 days') at time zone 'America/Sao_Paulo')::date end
   where id in (v_gone, v_recent);

  perform pg_temp.v3_assert(
    private.student_left_school_at(v_keep) is null
      and private.student_left_school_at(v_gone) = v_left
      and private.student_left_school_at(v_recent) = now() - interval '30 days'
      and private.student_left_school_at(v_admin) is null,
    'data em que o aluno deixou a escola saiu errada'
  );
  update public.profiles set offboarding_last_day = ((now() - interval '10 days') at time zone 'America/Sao_Paulo')::date
   where id = v_recent;
  perform pg_temp.v3_assert(
    private.student_left_school_at(v_recent)
      = ((((now() - interval '10 days') at time zone 'America/Sao_Paulo')::date + 1)::timestamp at time zone 'America/Sao_Paulo'),
    'último dia de aula depois da conclusão não contou'
  );

  v_result := private.purge_lesson_memory_retention();

  -- (a) Aula com mais de 90 dias: o rascunho perde os trechos da aula...
  perform pg_temp.v3_assert(
    (select not (content ? 'narrative') and not (content ? 'evidence')
        and content ->> 'lesson_objective' = 'Present perfect'
        and content ? 'retention_raw_text_removed_at'
      from private.lesson_summary_versions where id = v_keep_old_draft),
    'rascunho não aprovado de aula antiga manteve o texto copiado da aula'
  );
  -- ...e o resumo APROVADO também (as anotações do Google na íntegra e as
  -- citações da transcrição), mesmo com o aluno ainda na escola; objetivo,
  -- conteúdos e próximo passo ficam.
  perform pg_temp.v3_assert(
    (select not (content ? 'narrative') and not (content ? 'evidence')
        and content ->> 'lesson_objective' = 'Present perfect'
        and content ->> 'recommended_next_step' = 'Revisar os verbos'
        and content -> 'content_practiced' = '["have been"]'::jsonb
        and content ? 'retention_raw_text_removed_at'
      from private.lesson_summary_versions where id = v_keep_old_verified),
    'resumo aprovado de aula com mais de 90 dias guardou os trechos da aula para sempre'
  );
  perform pg_temp.v3_assert(
    (select content = v_content from private.lesson_summary_versions where id = v_keep_new_draft)
      and (select content = v_content from private.lesson_summary_versions where id = v_recent_verified),
    'retenção mexeu em resumo de aula com menos de 90 dias'
  );
  perform pg_temp.v3_assert(
    exists (select 1 from public.student_learning_memories
      where student_id = v_keep and source_type = 'MEET_SESSION' and lesson_objective = 'Present perfect'),
    'retenção dos trechos apagou a memória do aluno que continua na escola'
  );
  -- (b) Quem deixou a escola há mais de 90 dias.
  perform pg_temp.v3_assert(
    (select bool_and(content = jsonb_build_object('retention_cleared_at', content -> 'retention_cleared_at',
        'retention_reason', 'student_left_school'))
      from private.lesson_summary_versions where id in (v_gone_draft, v_gone_verified)),
    'resumos das aulas de quem deixou a escola mantiveram conteúdo'
  );
  perform pg_temp.v3_assert(
    not exists (select 1 from public.student_learning_memories where student_id = v_gone and source_type = 'MEET_SESSION')
      and not exists (select 1 from public.student_learning_memories where student_id = v_gone
        and source_type = 'PLANNER_AI' and source_ref = v_run_basis::text)
      and exists (select 1 from public.student_learning_memories where student_id = v_gone
        and source_type = 'PLANNER_AI' and source_ref = v_run_plain::text)
      and exists (select 1 from public.student_learning_memories where student_id = v_gone and source_type = 'MANUAL')
      and exists (select 1 from public.student_learning_memories where student_id = v_keep and source_type = 'MEET_SESSION')
      and exists (select 1 from public.student_learning_memories where student_id = v_recent and source_type = 'MEET_SESSION'),
    'memória MEET_SESSION apagada de quem não devia, mantida de quem devia, ou memória de outra origem apagada'
  );
  perform pg_temp.v3_assert(
    not exists (select 1 from public.student_learning_cards where student_id = v_gone)
      and exists (select 1 from public.student_learning_cards where student_id = v_keep)
      and exists (select 1 from public.student_learning_cards where student_id = v_recent),
    'cartão do aluno apagado de quem não devia ou mantido de quem deixou a escola há mais de 90 dias'
  );
  perform pg_temp.v3_assert(
    exists (select 1 from private.student_learning_card_events
      where student_id = v_gone and actor_role = 'SYSTEM_RETENTION'),
    'histórico do cartão sem a remoção pela retenção'
  );
  perform pg_temp.v3_assert(
    (select not (structured_plan ? 'lesson_basis') and structured_plan ->> 'title' = 'Plano do que saiu'
        and not (structured_plan ? 'student_memory_update') and student_memory_update = '{}'::jsonb
        and structured_plan ? 'approved_lessons_removed_at'
        and position('ERRO-DA-AULA-APROVADA' in structured_plan::text || student_memory_update::text) = 0
      from public.lesson_plans where student_id = v_gone)
    and (select not (result ? 'lesson_basis') and not (result ? 'student_memory_update')
        and result ? 'approved_lessons_removed_at'
      from public.planner_ai_runs where id = v_run_basis)
    and (select result -> 'student_memory_update' ->> 'lesson_objective' = 'Objetivo do Wolfie'
      from public.planner_ai_runs where id = v_run_plain)
    and (select structured_plan ? 'lesson_basis' from public.lesson_plans where student_id = v_keep)
    and (v_result ->> 'planner_basis_cleared')::integer >= 1,
    'base das aulas aprovadas ficou no plano de quem deixou a escola (ou saiu do plano de quem ficou): ' || v_result::text
  );

  -- (c) Trilha só com contagens, uma linha por escola.
  select * into v_trail from private.lesson_memory_retention_runs
   where tenant_id = 'v3-termo-fixture' and run_id = (v_result ->> 'run_id')::uuid;
  perform pg_temp.v3_assert(
    v_trail.drafts_cleared = 2 and v_trail.approved_excerpts_cleared = 2 and v_trail.summaries_cleared = 2
      and v_trail.memories_deleted = 2 and v_trail.cards_deleted = 1 and v_trail.planner_basis_cleared = 1,
    'trilha da retenção com contagem errada: ' || coalesce(to_jsonb(v_trail)::text, 'sem linha')
  );
  perform pg_temp.v3_assert(
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'private' and table_name = 'lesson_memory_retention_runs'
        and data_type in ('text', 'jsonb', 'json', 'character varying', 'ARRAY')
        and column_name <> 'tenant_id'
    ),
    'trilha da retenção guarda texto além da escola'
  );

  -- Segunda rodada: nada a apagar, nenhuma linha nova.
  select count(*) into v_trails from private.lesson_memory_retention_runs where tenant_id = 'v3-termo-fixture';
  v_result := private.purge_lesson_memory_retention();
  perform pg_temp.v3_assert(
    (v_result ->> 'drafts_cleared')::integer = 0 and (v_result ->> 'approved_excerpts_cleared')::integer = 0
      and (v_result ->> 'summaries_cleared')::integer = 0
      and (v_result ->> 'memories_deleted')::integer = 0 and (v_result ->> 'cards_deleted')::integer = 0
      and (v_result ->> 'planner_basis_cleared')::integer = 0
      and (select count(*) from private.lesson_memory_retention_runs where tenant_id = 'v3-termo-fixture') = v_trails,
    'segunda rodada da retenção apagou de novo: ' || v_result::text
  );

  -- Navegador e service role não chamam a retenção nem leem a trilha.
  perform pg_temp.v3_assert(
    not has_function_privilege('anon', 'private.purge_lesson_memory_retention()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.purge_lesson_memory_retention()', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.purge_lesson_memory_retention()', 'EXECUTE')
    and not has_table_privilege('authenticated', 'private.lesson_memory_retention_runs', 'SELECT')
    and not has_table_privilege('service_role', 'private.lesson_memory_retention_runs', 'SELECT'),
    'retenção ou trilha expostas'
  );
  -- Com pg_cron (produção), a rodada diária está agendada.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cron$select exists (select 1 from cron.job
      where jobname = 'wisewolf-lesson-memory-retention'
        and command like '%private.purge_lesson_memory_retention()%')$cron$ into v_scheduled;
    perform pg_temp.v3_assert(v_scheduled, 'retenção diária não agendada');
  end if;
end
$retention$;

rollback;
