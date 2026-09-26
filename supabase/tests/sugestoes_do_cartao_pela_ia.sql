-- Sugestões da IA para o cartão do aluno (migration 20260928130000). Reprova
-- contra o código anterior: não existiam as sugestões, o livro das leituras,
-- a porta da edge nem as RPCs de aceitar/descartar, e o teto do resumo não
-- contava o cartão.
--
-- Cobre: privilégios; lista de exclusão (saúde, religião, política, família,
-- dinheiro, terceiros, identificadores); aceite do termo que declara a IA (no
-- fim da aula E hoje, aluno e professor); regra de menor (só objetivo e temas,
-- também na gravação e ao virar menor); citação conferida contra a fonte;
-- reserva com hash, lease e o MESMO teto do resumo; aceitar grava pelo cartão
-- (versão, limites), descartar não mexe no cartão, texto some ao decidir;
-- repetida não volta; rejeição do resumo, exclusão a pedido e prazo de 90 dias
-- da citação.
--
-- Não depende de dado real nem da fila global: a fila é lida só para a escola
-- da fixture. Horários relativos a now(); o gasto do mês é conferido antes de
-- qualquer recuo de created_at (o recuo de 2 min só testa a espera do botão).
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.sug_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'sugestões do cartão: %', p_message;
  end if;
end;
$$;

create or replace function pg_temp.sug_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '{"role":"service_role"}'
      else jsonb_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
end;
$$;

-- Chama uma RPC da tela como a pessoa e devolve o resultado ou a mensagem de erro.
create or replace function pg_temp.sug_list(p_user uuid, p_student uuid)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.sug_as(p_user);
  return public.get_student_card_suggestions(p_student);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end;
$$;

create or replace function pg_temp.sug_decide(p_user uuid, p_id uuid, p_accept boolean, p_version integer)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.sug_as(p_user);
  return public.decide_student_card_suggestion(p_id, p_accept, p_version);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end;
$$;

create or replace function pg_temp.sug_backend(p_action text, p_tenant text, p_actor uuid, p_session uuid, p_payload jsonb)
returns jsonb language plpgsql as $$
begin
  perform pg_temp.sug_as(null);
  return public.student_card_suggestions_backend(p_action, p_tenant, p_actor, p_session, p_payload);
exception when others then
  return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end;
$$;

-- ===== 0. Privilégios e remendos ==============================================
do $privileges$
begin
  perform pg_temp.sug_assert(
    not has_table_privilege('authenticated', 'private.student_card_suggestions', 'SELECT')
    and not has_table_privilege('anon', 'private.student_card_suggestions', 'SELECT')
    and not has_table_privilege('service_role', 'private.student_card_suggestions', 'SELECT')
    and not has_table_privilege('authenticated', 'private.student_card_suggestion_runs', 'SELECT')
    and not has_table_privilege('service_role', 'private.student_card_suggestion_runs', 'SELECT')
    and not has_table_privilege('service_role', 'private.student_card_suggestion_settings', 'SELECT'),
    'tabelas das sugestões legíveis fora das RPCs');
  perform pg_temp.sug_assert(
    has_function_privilege('service_role', 'public.student_card_suggestions_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.student_card_suggestions_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.student_card_suggestions_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE'),
    'porta da edge aberta ao navegador (ou fechada para a edge)');
  perform pg_temp.sug_assert(
    has_function_privilege('authenticated', 'public.get_student_card_suggestions(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.decide_student_card_suggestion(uuid,boolean,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_student_card_suggestions(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.decide_student_card_suggestion(uuid,boolean,integer)', 'EXECUTE'),
    'RPCs da tela com privilégio errado');
  perform pg_temp.sug_assert(
    not has_function_privilege('authenticated', 'private.student_card_suggestion_ai_allowed(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_card_suggestion_actor_can_edit(text,uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.student_card_suggestion_actor_can_edit(text,uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.purge_student_card_suggestions()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.trigger_student_card_suggestions()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.trigger_student_card_suggestions()', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.trigger_student_card_suggestions()', 'EXECUTE'),
    'régua interna ou gatilho da fila executável de fora');
  perform pg_temp.sug_assert(
    strpos(pg_get_functiondef('private.meet_summary_month_spend(text)'::regprocedure), 'student_card_suggestion_month_spend') > 0
    and strpos(pg_get_functiondef('public.get_meet_summary_budget()'::regprocedure), 'card_suggestion_count') > 0,
    'o teto do resumo não conta as leituras para o cartão');
end
$privileges$;

-- ===== 1. Lista de exclusão (a mesma da edge) ===================================
do $blocked$
begin
  perform pg_temp.sug_assert(
    private.student_card_suggestion_text_blocked('Minha mãe está doente')
    and private.student_card_suggestion_text_blocked('Conversar sobre religião')
    and private.student_card_suggestion_text_blocked('as eleições do ano')
    and private.student_card_suggestion_text_blocked('quer aumentar o salário')
    and private.student_card_suggestion_text_blocked('My mother is sick and I am worried.')
    and private.student_card_suggestion_text_blocked('I pray every day')
    and private.student_card_suggestion_text_blocked('ansiedade antes das provas')
    and private.student_card_suggestion_text_blocked('viajar com o namorado')
    and private.student_card_suggestion_text_blocked('meu amigo João gosta de rock')
    and private.student_card_suggestion_text_blocked('o chefe dele cobra inglês'),
    'termo sensível passou pela lista de exclusão');
  perform pg_temp.sug_assert(
    private.student_card_suggestion_text_blocked('ligar para 11 98765-4321')
    and private.student_card_suggestion_text_blocked('fulano@exemplo.com')
    and private.student_card_suggestion_text_blocked('custa R$ 200')
    and private.student_card_suggestion_text_blocked('veja em www.exemplo.com')
    and private.student_card_suggestion_text_blocked('Conversar com a Bruna', array['Bruna Souza']),
    'identificador (telefone, e-mail, dinheiro, site, nome) passou');
  perform pg_temp.sug_assert(
    not private.student_card_suggestion_text_blocked('Apresentar resultados em reuniões com o time dos EUA')
    and not private.student_card_suggestion_text_blocked('futebol')
    and not private.student_card_suggestion_text_blocked('séries de ficção científica')
    and not private.student_card_suggestion_text_blocked('[10:00:01] Aluno Adulto: I love football.')
    and not private.student_card_suggestion_text_blocked('motherboard e hardware')
    and not private.student_card_suggestion_text_blocked('painting and drawing')
    and not private.student_card_suggestion_text_blocked('professor pediu roleplay')
    and not private.student_card_suggestion_text_blocked('Conversar sobre futebol', array['Bruna Souza']),
    'a lista de exclusão derrubou texto pedagógico comum');
  perform pg_temp.sug_assert(
    private.student_card_suggestion_quote_in_source('correct me   only at the end',
      E'[10:00:40] Aluno: Please correct me\nonly at the end, I lose my train of thought.')
    and not private.student_card_suggestion_quote_in_source('I hate grammar drills',
      '[10:00:40] Aluno: Please correct me only at the end.'),
    'conferência da citação contra a fonte errada');
end
$blocked$;

do $test$
declare
  v_tid constant text := 'cartao-ia-fixture';
  v_admin uuid := gen_random_uuid();
  v_coord uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_teacher_none uuid := gen_random_uuid();
  v_other_teacher uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_adult uuid := gen_random_uuid();
  v_minor uuid := gen_random_uuid();
  v_v2 uuid := gen_random_uuid();
  v_revoked uuid := gen_random_uuid();
  v_turning uuid := gen_random_uuid();
  v_left uuid := gen_random_uuid();
  v_all uuid[];
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_adult_birth date := (now() at time zone 'America/Sao_Paulo')::date - interval '30 years';
  s_adult uuid := gen_random_uuid();
  s_adult_old uuid := gen_random_uuid();
  s_minor uuid := gen_random_uuid();
  s_v2 uuid := gen_random_uuid();
  s_teacher_none uuid := gen_random_uuid();
  s_revoked uuid := gen_random_uuid();
  s_rejected uuid := gen_random_uuid();
  s_turning uuid := gen_random_uuid();
  s_left uuid := gen_random_uuid();
  a_adult uuid; a_adult_old uuid; a_minor uuid; a_turning uuid; a_left uuid;
  v_text constant text := E'[10:00:01] Aluno Adulto: I want to present my results in meetings with the US team.\n'
    || E'[10:00:20] Aluno Adulto: I love talking about football and science fiction series.\n'
    || E'[10:00:40] Aluno Adulto: Please correct me only at the end, I lose my train of thought.\n'
    || E'[10:01:00] Aluno Adulto: My mother is sick and I am worried.\n'
    || E'[10:01:30] Aluno Adulto: Please do not spoil the series for me.\n'
    || E'[10:02:00] Aluno Adulto: I want to travel to Canada next year.';
  v_result jsonb; v_run uuid; v_run_old uuid; v_card jsonb; v_list jsonb;
  v_spent_before numeric; v_spent_after numeric;
  v_goal uuid; v_topic uuid; v_style uuid; v_avoid uuid;
  v_version integer;
  v_blocked boolean;
  v_count integer;
begin
  perform pg_temp.sug_as(null);
  v_all := array[v_admin, v_coord, v_teacher, v_teacher_none, v_other_teacher, v_outsider,
    v_adult, v_minor, v_v2, v_revoked, v_turning, v_left];
  insert into public.tenants (id, name) values (v_tid, 'Cartão IA fixture'), ('cartao-ia-outra', 'Outra escola');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  select id, 'cardia-' || replace(id::text, '-', '') || '@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'
    from unnest(v_all) as fixture(id);
  update public.profiles
     set tenant_id = case when id = v_outsider then 'cartao-ia-outra' else v_tid end,
         lifecycle_status = 'active', is_test_account = true,
         role = case when id in (v_admin, v_outsider) then 'SCHOOL_ADMIN' when id = v_coord then 'COORDINATOR'
           when id in (v_teacher, v_teacher_none, v_other_teacher) then 'TEACHER' else 'STUDENT' end,
         full_name = case when id = v_adult then 'Aluno Adulto' when id = v_minor then 'Aluna Menor'
           when id = v_teacher then 'Professora Cartao' when id = v_teacher_none then 'Professor Sem Termo'
           when id = v_other_teacher then 'Professor Outro' else 'Fixture Cartao IA' end,
         birth_date = case when id in (v_adult, v_v2, v_revoked, v_turning, v_left) then v_adult_birth end,
         professor_id = case when id in (v_adult, v_minor, v_v2, v_revoked, v_turning, v_left) then v_teacher end
   where id = any (v_all);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id = any (v_all)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  -- Adultos comprovados pela escola (a régua fail-closed do termo e do cartão).
  perform pg_temp.sug_as(v_admin);
  perform public.set_student_birth_date(student_id, v_adult_birth::date, 'fixture das sugestões do cartão')
    from unnest(array[v_adult, v_v2, v_revoked, v_turning, v_left]) as fixture(student_id);
  perform pg_temp.sug_as(null);
  perform pg_temp.sug_assert(not private.student_learning_card_minor(v_adult)
    and private.student_learning_card_minor(v_minor), 'fixture: régua de menor do cartão diferente do esperado');

  -- Aceites do termo, antes de todas as aulas (a mais antiga é de 20 dias
  -- atrás): v3 (declara a IA) para quase todos; v2 para um aluno; o menor pelo
  -- responsável; o professor sem termo não respondeu. Um aluno revoga DEPOIS
  -- da aula.
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, verification, verified_phone, recorded_by, decided_at)
  select v_tid, fixture.subject, 'STUDENT', 'ACCEPTED', 'Fixture', fixture.relation, 'STUDENT', fixture.version, 'APP',
    'WHATSAPP_CODE', '(11) •••••-3333', null, now() - interval '30 days'
  from (values (v_adult, 'SELF', 'v3'), (v_minor, 'GUARDIAN', 'v3'), (v_v2, 'SELF', 'v2'),
    (v_revoked, 'SELF', 'v3'), (v_turning, 'SELF', 'v3'), (v_left, 'SELF', 'v3')) as fixture(subject, relation, version);
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, recorded_by, decided_at) values
    (v_tid, v_teacher, 'TEACHER', 'ACCEPTED', 'Professora Cartao', 'SELF', 'TEACHER', 'v3', 'APP', v_teacher, now() - interval '30 days');
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, source, recorded_by, reason, decided_at) values
    (v_tid, v_revoked, 'STUDENT', 'REVOKED', 'Direcao Fixture', 'SCHOOL', 'SCHOOL', v_admin,
      'Família pediu para parar pelo WhatsApp.', now() - interval '1 hour');

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key, documentation_consent) values
    (s_adult, v_tid, v_adult, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'cardia-adult', true),
    (s_adult_old, v_tid, v_adult, v_teacher, v_today - 20, now() - interval '20 days' - interval '30 minutes', now() - interval '20 days', 'cardia-old', true),
    (s_minor, v_tid, v_minor, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'cardia-minor', true),
    (s_v2, v_tid, v_v2, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'cardia-v2', true),
    (s_teacher_none, v_tid, v_adult, v_teacher_none, v_today - 1, now() - interval '1 day' - interval '30 minutes', now() - interval '1 day', 'cardia-tnone', true),
    (s_revoked, v_tid, v_revoked, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'cardia-revoked', true),
    (s_rejected, v_tid, v_adult, v_teacher, v_today - 2, now() - interval '2 days' - interval '30 minutes', now() - interval '2 days', 'cardia-rejected', true),
    (s_turning, v_tid, v_turning, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'cardia-turning', true),
    (s_left, v_tid, v_left, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'cardia-left', true);
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at)
  select v_tid, fixture.session_id, 'conferenceRecords/' || fixture.tag || '/transcripts/t1', 'TRANSCRIPT', 'doc' || fixture.tag,
    encode(sha256(fixture.tag::bytea), 'hex'), v_text, now() - interval '100 minutes', now() + interval '60 days'
  from (values (s_adult, 'adult'), (s_adult_old, 'old'), (s_minor, 'minor'), (s_v2, 'v2'), (s_teacher_none, 'tnone'),
    (s_revoked, 'revoked'), (s_rejected, 'rejected'), (s_turning, 'turning'), (s_left, 'left')) as fixture(session_id, tag);
  select id into a_adult from private.meeting_artifact_revisions where lesson_session_id = s_adult;
  select id into a_adult_old from private.meeting_artifact_revisions where lesson_session_id = s_adult_old;
  select id into a_minor from private.meeting_artifact_revisions where lesson_session_id = s_minor;
  select id into a_turning from private.meeting_artifact_revisions where lesson_session_id = s_turning;
  select id into a_left from private.meeting_artifact_revisions where lesson_session_id = s_left;
  -- Resumos aprovados pelo professor (a aula antiga, há 20 dias: fora da janela
  -- da automática). A aula "rejeitada": aprovada e depois rejeitada.
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content,
    source_artifact_ids, created_at)
  select v_tid, fixture.session_id, 1, 'VERIFIED', 'HUMAN_REVIEW', '{"lesson_objective":"Reuniões"}'::jsonb,
    array[(select id from private.meeting_artifact_revisions where lesson_session_id = fixture.session_id)], fixture.approved
  from (values (s_adult, now() - interval '60 minutes'), (s_adult_old, now() - interval '20 days'),
    (s_minor, now() - interval '60 minutes'), (s_v2, now() - interval '60 minutes'),
    (s_teacher_none, now() - interval '20 hours'), (s_revoked, now() - interval '60 minutes'),
    (s_rejected, now() - interval '2 days'), (s_turning, now() - interval '60 minutes'),
    (s_left, now() - interval '60 minutes')) as fixture(session_id, approved);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content,
    source_artifact_ids, created_at) values
    (v_tid, s_rejected, 2, 'REJECTED', 'HUMAN_REVIEW', '{}'::jsonb,
      array[(select id from private.meeting_artifact_revisions where lesson_session_id = s_rejected)], now() - interval '1 day');

  -- ===== 2. Campos por idade e aceite da IA ======================================
  perform pg_temp.sug_assert(
    private.student_card_suggestion_fields(v_adult) = array['real_goal','engaging_topics','correction_style','avoid_topics']
    and private.student_card_suggestion_fields(v_minor) = array['real_goal','engaging_topics'],
    'campos permitidos por idade errados');
  perform pg_temp.sug_assert(private.student_card_suggestion_ai_allowed(s_adult)
    and private.student_card_suggestion_ai_allowed(s_minor), 'aula com aceite v3 dos dois não pôde ir à IA');
  perform pg_temp.sug_assert(not private.student_card_suggestion_ai_allowed(s_v2),
    'aula de aluno com aceite da v2 (que não declara a IA) foi à IA');
  perform pg_temp.sug_assert(not private.student_card_suggestion_ai_allowed(s_teacher_none),
    'aula de professor sem aceite do termo foi à IA');
  perform pg_temp.sug_assert(private.meet_summary_ai_consented(s_revoked)
    and not private.student_card_suggestion_ai_allowed(s_revoked),
    'aluno que revogou DEPOIS da aula teve a aula relida pela IA');
  perform pg_temp.sug_assert(private.student_card_suggestion_block(s_rejected) = 'sem_aula_aprovada'
    and private.student_card_suggestion_block(s_v2) = 'sem_aceite_da_ia'
    and private.student_card_suggestion_block(s_adult) is null,
    'motivos de bloqueio errados');

  -- ===== 3. Fila automática: só a escola da fixture, sem texto ===================
  v_result := pg_temp.sug_backend('due', v_tid, null, null, '{"limit":5}');
  perform pg_temp.sug_assert(
    (select count(*) from jsonb_array_elements(v_result -> 'items') as item
      where (item ->> 'session_id')::uuid in (s_adult, s_minor, s_turning, s_left)) = 4
    and (select count(*) from jsonb_array_elements(v_result -> 'items')) = 4
    and strpos(v_result::text, 'football') = 0,
    'fila automática errada (esperava as 4 aulas aprovadas e autorizadas, sem a antiga): ' || v_result::text);

  -- ===== 4. Fontes para a IA: campos, nomes, texto ===============================
  v_result := pg_temp.sug_backend('sources', v_tid, null, s_adult, '{"trigger":"AUTOMATIC"}');
  perform pg_temp.sug_assert((v_result ->> 'eligible')::boolean
    and jsonb_array_length(v_result -> 'fields') = 4 and not (v_result ->> 'minor')::boolean
    and v_result -> 'people_names' ? 'Aluno Adulto' and v_result -> 'people_names' ? 'Professora Cartao'
    and v_result -> 'sources' -> 0 ->> 'id' = a_adult::text,
    'fontes da aula do adulto erradas: ' || left(v_result::text, 300));
  v_result := pg_temp.sug_backend('sources', v_tid, null, s_minor, '{"trigger":"AUTOMATIC"}');
  perform pg_temp.sug_assert((v_result ->> 'eligible')::boolean and (v_result ->> 'minor')::boolean
    and v_result -> 'fields' = '["real_goal","engaging_topics"]'::jsonb,
    'menor recebeu campos pessoais para a IA sugerir');
  v_result := pg_temp.sug_backend('sources', v_tid, null, s_v2, '{"trigger":"AUTOMATIC"}');
  perform pg_temp.sug_assert(not (v_result ->> 'eligible')::boolean and v_result ->> 'reason' = 'sem_aceite_da_ia'
    and jsonb_array_length(v_result -> 'sources') = 0, 'texto de aula sem aceite da IA entregue à edge');
  v_result := pg_temp.sug_backend('sources', v_tid, v_other_teacher, s_adult, '{"trigger":"MANUAL"}');
  perform pg_temp.sug_assert(v_result ->> 'error' = 'sem_permissao',
    'professor sem vínculo leu a aula pelo botão: ' || v_result::text);

  -- ===== 5. Reserva: modelo, fontes, hash, uma por vez ============================
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_adult, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', '../../malicioso', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_adult)));
  perform pg_temp.sug_assert(v_result ->> 'error' = 'card_suggestions_model_invalid', 'modelo inválido foi aceito');
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_adult, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_adult, a_minor)));
  perform pg_temp.sug_assert(v_result ->> 'error' = 'suggestion_artifact_scope_mismatch', 'fonte de OUTRA aula entrou na reserva');
  v_spent_before := private.meet_summary_month_spend(v_tid);
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_adult, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_adult)));
  perform pg_temp.sug_assert((v_result ->> 'claimed')::boolean, 'reserva automática recusada: ' || v_result::text);
  v_run := (v_result ->> 'run_id')::uuid;
  perform pg_temp.sug_assert(v_result ->> 'sources_sha256' =
    (select encode(sha256(convert_to(r.id::text || ':' || r.content_sha256, 'UTF8')), 'hex')
       from private.meeting_artifact_revisions r where r.id = a_adult),
    'hash das fontes não é o do conteúdo guardado');
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_adult, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_adult)));
  perform pg_temp.sug_assert(not (v_result ->> 'claimed')::boolean and v_result ->> 'reason' = 'em_andamento',
    'duas leituras simultâneas da mesma aula');
  -- A estimativa reservada já conta no MESMO teto do resumo.
  perform pg_temp.sug_assert(private.meet_summary_month_spend(v_tid) = v_spent_before + 0.004,
    'a reserva não entrou no gasto do mês do resumo por IA');

  -- ===== 6. Gravação: cada sugestão conferida de novo no banco ====================
  v_result := pg_temp.sug_backend('finish', v_tid, null, s_adult, jsonb_build_object(
    'run_id', v_run, 'status', 'SUCCEEDED', 'dropped', 1,
    'cost_usd', 0.0012, 'cost_source', 'PROVIDER', 'input_tokens', 3000, 'output_tokens', 400, 'reasoning_tokens', 120,
    'suggestions', jsonb_build_array(
      jsonb_build_object('field', 'real_goal', 'value', '  Apresentar resultados em reuniões com o time dos EUA ',
        'artifact_id', a_adult, 'quote', 'I want to present my results in meetings with the US team.'),
      jsonb_build_object('field', 'engaging_topics', 'value', 'futebol',
        'artifact_id', a_adult, 'quote', 'I love talking about football and science fiction series.'),
      jsonb_build_object('field', 'correction_style', 'value', 'END',
        'artifact_id', a_adult, 'quote', 'Please correct me only at the end, I lose my train of thought.'),
      jsonb_build_object('field', 'avoid_topics', 'value', 'spoilers de séries',
        'artifact_id', a_adult, 'quote', 'Please do not spoil the series for me.'),
      -- Saúde e família: no valor e na citação.
      jsonb_build_object('field', 'avoid_topics', 'value', 'a doença da mãe',
        'artifact_id', a_adult, 'quote', 'My mother is sick and I am worried.'),
      -- Valor limpo, citação sensível: sai também.
      jsonb_build_object('field', 'engaging_topics', 'value', 'conversa livre',
        'artifact_id', a_adult, 'quote', 'My mother is sick and I am worried.'),
      -- Citação que não está na aula.
      jsonb_build_object('field', 'avoid_topics', 'value', 'exercícios de gramática',
        'artifact_id', a_adult, 'quote', 'I hate grammar drills so much.'),
      -- Nome de pessoa da aula no valor.
      jsonb_build_object('field', 'engaging_topics', 'value', 'aulas com a Professora Cartao',
        'artifact_id', a_adult, 'quote', 'I love talking about football and science fiction series.'),
      -- Estilo fora da lista.
      jsonb_build_object('field', 'correction_style', 'value', 'gentle',
        'artifact_id', a_adult, 'quote', 'Please correct me only at the end, I lose my train of thought.'),
      -- Repetida no mesmo lote.
      jsonb_build_object('field', 'engaging_topics', 'value', 'Futebol',
        'artifact_id', a_adult, 'quote', 'I love talking about football and science fiction series.'),
      -- Citação de outra aula (fonte fora da reserva).
      jsonb_build_object('field', 'engaging_topics', 'value', 'viagens',
        'artifact_id', a_minor, 'quote', 'I want to travel to Canada next year.'),
      -- Campo que não existe.
      jsonb_build_object('field', 'notes', 'value', 'observação livre',
        'artifact_id', a_adult, 'quote', 'Please do not spoil the series for me.'))));
  perform pg_temp.sug_assert(v_result ->> 'status' = 'SUCCEEDED' and (v_result ->> 'saved')::int = 4
    and (v_result ->> 'dropped')::int = 9, 'conferência das sugestões errada: ' || v_result::text);
  perform pg_temp.sug_assert(
    (select count(*) from private.student_card_suggestions where run_id = v_run and status = 'PENDING') = 4
    and (select bool_and(evidence_expires_at = now() - interval '120 minutes' + interval '90 days'
                  and evidence_artifact_id = a_adult and length(evidence_quote) >= 8)
           from private.student_card_suggestions where run_id = v_run)
    and exists (select 1 from private.student_card_suggestions where run_id = v_run and field = 'correction_style' and value = 'end')
    and exists (select 1 from private.student_card_suggestions where run_id = v_run and field = 'real_goal'
      and value = 'Apresentar resultados em reuniões com o time dos EUA'),
    'sugestões gravadas sem a evidência, sem o prazo ou sem normalizar');
  perform pg_temp.sug_assert(not exists (select 1 from private.student_card_suggestions
      where student_id = v_adult and (value ilike '%mãe%' or evidence_quote ilike '%mother%' or value ilike '%Cartao%')),
    'sugestão com família, saúde ou nome de pessoa foi gravada');
  perform pg_temp.sug_assert((select status = 'SUCCEEDED' and cost_usd = 0.0012 and suggestions_saved = 4
      and suggestions_dropped = 9 and reasoning_tokens = 120 from private.student_card_suggestion_runs where id = v_run),
    'livro da leitura sem custo ou contagens');
  -- Custo real no lugar da estimativa, no teto do resumo.
  v_spent_after := private.meet_summary_month_spend(v_tid);
  perform pg_temp.sug_assert(v_spent_after = v_spent_before + 0.0012
    and private.student_card_suggestion_month_spend(v_tid) = 0.0012,
    'gasto do mês não trocou a estimativa pelo custo real');
  perform pg_temp.sug_assert(private.student_card_suggestion_auto_block(s_adult) = 'ja_sugerido',
    'aula já lida continuou na fila automática');

  -- ===== 7. Menor: só objetivo e temas, também na gravação ========================
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_minor, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_minor)));
  v_result := pg_temp.sug_backend('finish', v_tid, null, s_minor, jsonb_build_object(
    'run_id', (v_result ->> 'run_id')::uuid, 'status', 'SUCCEEDED', 'cost_usd', 0.001, 'cost_source', 'PROVIDER',
    'suggestions', jsonb_build_array(
      jsonb_build_object('field', 'engaging_topics', 'value', 'futebol',
        'artifact_id', a_minor, 'quote', 'I love talking about football and science fiction series.'),
      jsonb_build_object('field', 'correction_style', 'value', 'end',
        'artifact_id', a_minor, 'quote', 'Please correct me only at the end, I lose my train of thought.'),
      jsonb_build_object('field', 'avoid_topics', 'value', 'spoilers',
        'artifact_id', a_minor, 'quote', 'Please do not spoil the series for me.'))));
  perform pg_temp.sug_assert((v_result ->> 'saved')::int = 1
    and not exists (select 1 from private.student_card_suggestions where student_id = v_minor
      and field in ('correction_style', 'avoid_topics')),
    'menor ganhou sugestão de estilo de correção ou do que evitar: ' || v_result::text);

  -- ===== 8. Tela: quem vê, o que vê ===============================================
  v_list := pg_temp.sug_list(v_teacher, v_adult);
  perform pg_temp.sug_assert((v_list ->> 'ok')::boolean and jsonb_array_length(v_list -> 'suggestions') = 4
    and (select bool_and(item ->> 'quote' <> '' and item ->> 'class_date' = v_today::text
           and item ->> 'teacher_name' = 'Professora Cartao' and not (item ->> 'already_in_card')::boolean)
           from jsonb_array_elements(v_list -> 'suggestions') as item)
    and v_list -> 'suggestions' -> 0 ->> 'field' = 'real_goal',
    'lista da professora errada: ' || left(v_list::text, 400));
  -- O botão lê a aula aprovada mais recente ainda não lida: a de 20 dias atrás.
  perform pg_temp.sug_assert((v_list ->> 'can_request')::boolean
    and v_list ->> 'request_class_date' = (v_today - 20)::text,
    'botão não apontou a aula aprovada ainda não lida: ' || left(v_list::text, 400));
  perform pg_temp.sug_assert(pg_temp.sug_list(v_other_teacher, v_adult) ->> 'error' = 'sem_permissao'
    and pg_temp.sug_list(v_outsider, v_adult) ->> 'error' = 'sem_permissao'
    and pg_temp.sug_list(v_adult, v_adult) ->> 'error' = 'sem_permissao',
    'quem não edita o cartão viu as sugestões (e as frases da aula)');
  perform pg_temp.sug_assert((pg_temp.sug_list(v_coord, v_adult) ->> 'ok')::boolean,
    'coordenação não viu as sugestões');
  v_list := pg_temp.sug_list(v_teacher, v_minor);
  perform pg_temp.sug_assert((v_list ->> 'is_minor')::boolean and jsonb_array_length(v_list -> 'suggestions') = 1
    and v_list -> 'suggestions' -> 0 ->> 'field' = 'engaging_topics', 'lista do menor errada');

  -- ===== 9. Aceitar grava pelo cartão; descartar não mexe ==========================
  select id into v_goal from private.student_card_suggestions where student_id = v_adult and field = 'real_goal' and status = 'PENDING';
  select id into v_topic from private.student_card_suggestions where student_id = v_adult and field = 'engaging_topics' and status = 'PENDING';
  select id into v_style from private.student_card_suggestions where student_id = v_adult and field = 'correction_style' and status = 'PENDING';
  select id into v_avoid from private.student_card_suggestions where student_id = v_adult and field = 'avoid_topics' and status = 'PENDING';
  perform pg_temp.sug_assert(pg_temp.sug_decide(v_other_teacher, v_goal, true, 0) ->> 'error' = 'sem_permissao',
    'professor sem vínculo aceitou sugestão');
  v_result := pg_temp.sug_decide(v_teacher, v_goal, true, 0);
  perform pg_temp.sug_assert((v_result ->> 'ok')::boolean
    and v_result -> 'learning_card' ->> 'real_goal' = 'Apresentar resultados em reuniões com o time dos EUA'
    and (v_result -> 'learning_card' ->> 'version')::int = 1, 'aceitar o objetivo não gravou o cartão: ' || v_result::text);
  v_result := pg_temp.sug_decide(v_teacher, v_topic, true, 1);
  perform pg_temp.sug_assert(v_result -> 'learning_card' -> 'engaging_topics' = '["futebol"]'::jsonb
    and (v_result -> 'learning_card' ->> 'version')::int = 2, 'aceitar o tema não entrou na lista');
  -- Versão velha: o cartão mudou desde que a tela carregou — nada muda.
  v_result := pg_temp.sug_decide(v_teacher, v_style, true, 1);
  perform pg_temp.sug_assert(v_result ->> 'error' like '%cartao_alterado_por_outra_pessoa%'
    and (select status = 'PENDING' and value = 'end' from private.student_card_suggestions where id = v_style),
    'aceite sobre versão velha sobrescreveu o cartão ou fechou a sugestão: ' || v_result::text);
  v_result := pg_temp.sug_decide(v_teacher, v_style, true, 2);
  perform pg_temp.sug_assert(v_result -> 'learning_card' ->> 'correction_style' = 'end'
    and (v_result -> 'learning_card' ->> 'version')::int = 3, 'aceitar o estilo de correção não gravou');
  v_result := pg_temp.sug_decide(v_teacher, v_avoid, false, 3);
  perform pg_temp.sug_assert(v_result ->> 'status' = 'DISCARDED'
    and (v_result -> 'learning_card' ->> 'version')::int = 3
    and v_result -> 'learning_card' -> 'avoid_topics' = '[]'::jsonb, 'descartar mexeu no cartão');
  perform pg_temp.sug_assert(pg_temp.sug_decide(v_teacher, v_avoid, true, 3) ->> 'error' = 'sugestao_ja_decidida',
    'sugestão decidida pôde ser decidida de novo');
  -- Fechada, a sugestão perde o texto (fica o hash e quem decidiu).
  perform pg_temp.sug_assert((select bool_and(value = '' and evidence_quote is null and evidence_artifact_id is null
      and closed_by = v_teacher and closed_at is not null)
      from private.student_card_suggestions where id in (v_goal, v_topic, v_style, v_avoid)),
    'sugestão decidida guardou o texto');
  perform pg_temp.sug_assert((select count(*) = 3 from private.student_learning_card_events
      where student_id = v_adult and actor_id = v_teacher),
    'aceite não passou pelo histórico do cartão');
  -- A tabela recusa texto em sugestão fechada.
  v_blocked := false;
  begin
    update private.student_card_suggestions set value = 'texto que não devia ficar' where id = v_goal;
  exception when check_violation then v_blocked := true; end;
  perform pg_temp.sug_assert(v_blocked, 'sugestão fechada aceitou texto');

  -- ===== 10. Botão do professor: permissão, espera, repetida não volta ============
  v_result := pg_temp.sug_backend('target', v_tid, v_other_teacher, null, jsonb_build_object('student_id', v_adult));
  perform pg_temp.sug_assert(v_result ->> 'error' = 'sem_permissao', 'professor sem vínculo usou o botão');
  v_result := pg_temp.sug_backend('target', v_tid, v_teacher, null, jsonb_build_object('student_id', v_adult));
  perform pg_temp.sug_assert(v_result ->> 'session_id' = s_adult_old::text and (v_result ->> 'budget_ok')::boolean,
    'botão não escolheu a aula aprovada ainda não lida: ' || v_result::text);
  -- A leitura automática acabou de sair para este aluno: o botão espera 1 min.
  v_result := pg_temp.sug_backend('claim', v_tid, v_teacher, s_adult_old, jsonb_build_object('trigger', 'MANUAL',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_adult_old)));
  perform pg_temp.sug_assert(not (v_result ->> 'claimed')::boolean and v_result ->> 'reason' = 'aguarde_um_minuto',
    'botão não esperou depois de uma leitura recente: ' || v_result::text);
  update private.student_card_suggestion_runs set created_at = created_at - interval '2 minutes'
   where student_id = v_adult;
  v_result := pg_temp.sug_backend('claim', v_tid, v_teacher, s_adult_old, jsonb_build_object('trigger', 'MANUAL',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_adult_old)));
  perform pg_temp.sug_assert((v_result ->> 'claimed')::boolean, 'botão da professora recusado: ' || v_result::text);
  v_run_old := (v_result ->> 'run_id')::uuid;
  perform pg_temp.sug_assert((select trigger = 'MANUAL' and requested_by = v_teacher
      from private.student_card_suggestion_runs where id = v_run_old), 'leitura manual sem autor');
  v_result := pg_temp.sug_backend('finish', v_tid, null, s_adult_old, jsonb_build_object(
    'run_id', v_run_old, 'status', 'SUCCEEDED', 'cost_usd', 0.001, 'cost_source', 'PROVIDER',
    'suggestions', jsonb_build_array(
      -- Descartada antes: não volta.
      jsonb_build_object('field', 'avoid_topics', 'value', 'Spoilers de séries',
        'artifact_id', a_adult_old, 'quote', 'Please do not spoil the series for me.'),
      -- Já está no cartão: não volta.
      jsonb_build_object('field', 'engaging_topics', 'value', 'futebol',
        'artifact_id', a_adult_old, 'quote', 'I love talking about football and science fiction series.'),
      jsonb_build_object('field', 'engaging_topics', 'value', 'viagens para o Canadá',
        'artifact_id', a_adult_old, 'quote', 'I want to travel to Canada next year.'))));
  perform pg_temp.sug_assert((v_result ->> 'saved')::int = 1 and (v_result ->> 'dropped')::int = 2,
    'sugestão já decidida ou já no cartão voltou: ' || v_result::text);
  v_result := pg_temp.sug_backend('target', v_tid, v_teacher, null, jsonb_build_object('student_id', v_adult));
  perform pg_temp.sug_assert(v_result -> 'session_id' = 'null'::jsonb and v_result ->> 'reason' = 'ja_sugerido',
    'botão ofereceu reler aula já lida: ' || v_result::text);

  -- ===== 11. Teto: o mesmo do resumo, para as duas portas ============================
  insert into private.google_meet_summary_settings (tenant_id, monthly_cap_usd) values (v_tid, 0)
  on conflict (tenant_id) do update set monthly_cap_usd = excluded.monthly_cap_usd;
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_turning, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_turning)));
  perform pg_temp.sug_assert(not (v_result ->> 'claimed')::boolean and v_result ->> 'reason' = 'teto_atingido',
    'leitura passou do teto do mês: ' || v_result::text);
  perform pg_temp.sug_assert(jsonb_array_length(pg_temp.sug_backend('due', v_tid, null, null, '{"limit":5}') -> 'items') = 0
    and (pg_temp.sug_list(v_teacher, v_adult) ->> 'budget_reached')::boolean,
    'fila ou tela ignoraram o teto atingido');
  update private.google_meet_summary_settings set monthly_cap_usd = 20 where tenant_id = v_tid;

  -- ===== 12. Aluno que passa a ser menor perde as sugestões pessoais ==================
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_turning, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_turning)));
  v_result := pg_temp.sug_backend('finish', v_tid, null, s_turning, jsonb_build_object(
    'run_id', (v_result ->> 'run_id')::uuid, 'status', 'SUCCEEDED', 'cost_usd', 0.001, 'cost_source', 'PROVIDER',
    'suggestions', jsonb_build_array(
      jsonb_build_object('field', 'engaging_topics', 'value', 'futebol',
        'artifact_id', a_turning, 'quote', 'I love talking about football and science fiction series.'),
      jsonb_build_object('field', 'correction_style', 'value', 'end',
        'artifact_id', a_turning, 'quote', 'Please correct me only at the end, I lose my train of thought.'))));
  perform pg_temp.sug_assert((v_result ->> 'saved')::int = 2, 'fixture: sugestões do aluno que vai virar menor');
  perform pg_temp.sug_as(null);
  update public.profiles set is_kids = true where id = v_turning;
  perform pg_temp.sug_assert(
    (select status = 'WITHDRAWN' and close_reason = 'minor_rule' and value = '' and evidence_quote is null
       from private.student_card_suggestions where student_id = v_turning and field = 'correction_style')
    and (select status = 'PENDING' from private.student_card_suggestions
       where student_id = v_turning and field = 'engaging_topics'),
    'aluno que virou menor manteve a sugestão pessoal (ou perdeu a de tema)');

  -- ===== 13. Rejeitar o resumo depois de aprovar retira as sugestões da aula =========
  perform pg_temp.sug_as(null);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content,
    source_artifact_ids, created_at) values
    (v_tid, s_minor, 2, 'REJECTED', 'HUMAN_REVIEW', '{}'::jsonb, array[a_minor], now());
  perform pg_temp.sug_assert((select bool_and(status = 'WITHDRAWN' and close_reason = 'summary_rejected' and value = '')
      from private.student_card_suggestions where lesson_session_id = s_minor)
    and jsonb_array_length(pg_temp.sug_list(v_teacher, v_minor) -> 'suggestions') = 0,
    'sugestões de aula com resumo rejeitado continuaram esperando decisão');

  -- ===== 14. Prazo da citação e aluno que saiu da escola =============================
  perform pg_temp.sug_as(null);
  v_result := pg_temp.sug_backend('claim', v_tid, null, s_left, jsonb_build_object('trigger', 'AUTOMATIC',
    'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.004, 'source_artifact_ids', jsonb_build_array(a_left)));
  v_result := pg_temp.sug_backend('finish', v_tid, null, s_left, jsonb_build_object(
    'run_id', (v_result ->> 'run_id')::uuid, 'status', 'SUCCEEDED', 'cost_usd', 0.001, 'cost_source', 'PROVIDER',
    'suggestions', jsonb_build_array(
      jsonb_build_object('field', 'engaging_topics', 'value', 'futebol',
        'artifact_id', a_left, 'quote', 'I love talking about football and science fiction series.'))));
  perform pg_temp.sug_assert((v_result ->> 'saved')::int = 1, 'fixture: sugestão do aluno que vai sair');
  -- Citação vencida (90 dias depois da aula) x ainda no prazo.
  update private.student_card_suggestions set evidence_expires_at = now() - interval '1 minute'
   where student_id = v_turning and field = 'engaging_topics';
  update public.profiles
     set lifecycle_status = 'offboarded', status = 'Inativo', offboarding_status = 'COMPLETED',
         offboarding_completed_at = now() - interval '100 days'
   where id = v_left;
  v_result := private.purge_student_card_suggestions();
  perform pg_temp.sug_assert(
    (select status = 'EXPIRED' and close_reason = 'evidence_retention' and value = '' and evidence_quote is null
       from private.student_card_suggestions where student_id = v_turning and field = 'engaging_topics')
    and not exists (select 1 from private.student_card_suggestions where student_id = v_left)
    and (select status = 'PENDING' and evidence_quote is not null from private.student_card_suggestions
       where student_id = v_adult and value = 'viagens para o Canadá'),
    'retenção errada (citação vencida, aluno que saiu, sugestão no prazo): ' || v_result::text);

  -- ===== 15. Exclusão a pedido apaga as sugestões das aulas do aluno ================
  perform pg_temp.sug_as(v_admin);
  v_result := public.erase_student_lesson_records(v_adult);
  perform pg_temp.sug_as(null);
  perform pg_temp.sug_assert((v_result ->> 'ok')::boolean
    and not exists (select 1 from private.student_card_suggestions where student_id = v_adult),
    'sugestões sobreviveram à exclusão a pedido');
end
$test$;

rollback;
