-- Resumo por IA automático depois da aula (migration 20260927110000). Reprova
-- contra o código anterior: não existia fila GENERATE_SUMMARY, teto mensal, livro
-- das gerações (idempotência pelo hash das fontes), fila de revisão nem a
-- pendência resumos_para_revisar.
--
-- Não depende de dado real nem da fila global: as conexões reais saem do ar e as
-- outras escolas ficam pausadas só dentro desta transação (o rollback devolve).
-- Horários relativos a now(); o gasto do mês usa linhas criadas agora (sempre no
-- mês corrente) e uma linha no mês anterior (sempre fora).
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.resumo_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'resumo automático: %', p_message;
  end if;
end;
$$;

do $privileges$
begin
  perform pg_temp.resumo_assert(
    not has_table_privilege('authenticated', 'private.google_meet_summary_generations', 'SELECT')
    and not has_table_privilege('anon', 'private.google_meet_summary_generations', 'SELECT')
    and not has_table_privilege('authenticated', 'private.google_meet_summary_settings', 'SELECT')
    and not has_table_privilege('service_role', 'private.google_meet_summary_settings', 'SELECT'),
    'livro das gerações ou teto legível fora das RPCs');
  perform pg_temp.resumo_assert(
    not has_function_privilege('authenticated', 'public.google_meet_summary_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.google_meet_summary_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.google_meet_summary_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE'),
    'porta da edge aberta ao navegador (ou fechada para a edge)');
  perform pg_temp.resumo_assert(
    has_function_privilege('authenticated', 'public.get_meet_summary_budget()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.set_meet_summary_monthly_cap(numeric)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_meet_summary_review_queue()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_meet_summary_budget()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_meet_summary_monthly_cap(numeric)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_meet_summary_review_queue()', 'EXECUTE'),
    'RPCs da tela com privilégio errado');
  perform pg_temp.resumo_assert(
    not has_function_privilege('authenticated', 'private.meet_summary_auto_eligible(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.meet_summary_review_items(text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.meet_summary_month_spend(text)', 'EXECUTE'),
    'régua interna executável pelo navegador');
  perform pg_temp.resumo_assert(
    exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'ai_usage_events' and column_name = 'reasoning_tokens'),
    'ai_usage_events sem tokens de raciocínio');
  perform pg_temp.resumo_assert(
    strpos(pg_get_functiondef('public.get_pending_google_meet_sync_sessions()'::regprocedure), 'GENERATE_SUMMARY') > 0
    and strpos(pg_get_functiondef('public.director_pending_counts()'::regprocedure), 'resumos_para_revisar') > 0,
    'remendo por âncora não entrou na fila ou nas pendências');
end
$privileges$;

do $test$
declare
  v_tenant constant text := 'meet-resumo-fixture';
  v_admin uuid := gen_random_uuid();
  v_coord uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_other_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_revoker uuid := gen_random_uuid();       -- aluno que revogou antes do fim da aula
  v_older uuid := gen_random_uuid();         -- terminou há 3 h: primeira da fila
  v_ready uuid := gen_random_uuid();         -- terminou há 2 h: elegível
  v_fresh uuid := gen_random_uuid();         -- fonte chegou há 5 min
  v_pending_doc uuid := gen_random_uuid();   -- Google ainda gerando um documento
  v_no_consent uuid := gen_random_uuid();    -- sem aceite
  v_blocked uuid := gen_random_uuid();       -- aluno revogou antes do fim
  v_has_ai uuid := gen_random_uuid();        -- já tem resumo de IA
  v_verified uuid := gen_random_uuid();      -- professor já aprovou
  v_week_old uuid := gen_random_uuid();      -- terminou há 8 dias
  v_stale uuid := gen_random_uuid();         -- rascunho parado há 4 dias
  v_expired_src uuid := gen_random_uuid();   -- rascunho cuja fonte venceu
  v_other_class uuid := gen_random_uuid();   -- aula do outro professor
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_older_transcript uuid; v_older_notes uuid; v_older_notes_old uuid;
  v_ready_transcript uuid; v_foreign uuid; v_stale_src uuid; v_other_src uuid;
  v_result jsonb; v_jobs jsonb; v_gen uuid; v_gen2 uuid; v_blocked_flag boolean;
  v_hash text;
  v_evidence jsonb := jsonb_build_object('narrative', 'Aula de direções.', 'lesson_objective', 'Pedir direções',
    'recommended_next_step', 'Praticar mapa', 'content_practiced', jsonb_build_array('directions'),
    'recurring_errors', '[]'::jsonb, 'strengths_observed', '[]'::jsonb, 'homework_assigned', '',
    'uncertainties', '[]'::jsonb, 'evidence', jsonb_build_array(jsonb_build_object('artifact_id', 'x', 'quote', 'turn left')));
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Isola a fila global: sem conexões reais (sem SYNC/PREPARE/ARTIFACTS) e com as
  -- outras escolas pausadas para o resumo automático.
  update private.google_workspace_connections set status = 'REAUTH_REQUIRED' where status = 'CONNECTED';
  insert into private.google_meet_summary_settings (tenant_id, auto_paused_until, auto_pause_reason)
  select tenant.id, now() + interval '1 day', 'teste_isolado' from public.tenants as tenant
  on conflict (tenant_id) do update set auto_paused_until = excluded.auto_paused_until,
    auto_pause_reason = excluded.auto_pause_reason;

  insert into public.tenants (id, name) values (v_tenant, 'Resumo automático fixture');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'resumo-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_coord, 'resumo-coord@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'resumo-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_other_teacher, 'resumo-teacher2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student, 'resumo-student@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_revoker, 'resumo-revoker@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = v_tenant, lifecycle_status = 'active', is_test_account = true,
         full_name = case when id = v_student then 'Aluna Resumo' when id = v_revoker then 'Aluno Revogou'
           when id = v_teacher then 'Prof Resumo' when id = v_other_teacher then 'Prof Outro' else full_name end,
         role = case when id = v_admin then 'SCHOOL_ADMIN' when id = v_coord then 'COORDINATOR'
           when id in (v_teacher, v_other_teacher) then 'TEACHER' else 'STUDENT' end
   where id in (v_admin, v_coord, v_teacher, v_other_teacher, v_student, v_revoker);
  update public.profiles set professor_id = v_teacher where id in (v_student, v_revoker);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles
     where id in (v_admin, v_coord, v_teacher, v_other_teacher, v_student, v_revoker)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  -- Aluno que revogou há 3 h (antes do fim das aulas que terminaram há 2 h).
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, source, recorded_by, reason, decided_at) values
    (v_tenant, v_revoker, 'STUDENT', 'REVOKED', 'Direcao Fixture', 'SCHOOL', 'SCHOOL', v_admin,
      'Família pediu para parar pelo WhatsApp.', now() - interval '3 hours');

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key, documentation_consent) values
    (v_older, v_tenant, v_student, v_teacher, v_today, now() - interval '210 minutes', now() - interval '180 minutes', 'resumo-older', true),
    (v_ready, v_tenant, v_student, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'resumo-ready', true),
    (v_fresh, v_tenant, v_student, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'resumo-fresh', true),
    (v_pending_doc, v_tenant, v_student, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'resumo-pending', true),
    (v_no_consent, v_tenant, v_student, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'resumo-noconsent', false),
    (v_blocked, v_tenant, v_revoker, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'resumo-blocked', true),
    (v_has_ai, v_tenant, v_student, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'resumo-hasai', true),
    (v_verified, v_tenant, v_student, v_teacher, v_today, now() - interval '150 minutes', now() - interval '120 minutes', 'resumo-verified', true),
    (v_week_old, v_tenant, v_student, v_teacher, v_today - 8, now() - interval '8 days', now() - interval '8 days' + interval '30 minutes', 'resumo-weekold', true),
    -- Rascunhos parados: a revisão não depende do aceite (a autorização pode ter
    -- saído depois da aula); sem aceite elas também não disputam a fila automática.
    (v_stale, v_tenant, v_student, v_teacher, v_today - 4, now() - interval '4 days' - interval '30 minutes', now() - interval '4 days', 'resumo-stale', false),
    (v_expired_src, v_tenant, v_student, v_teacher, v_today - 5, now() - interval '5 days' - interval '30 minutes', now() - interval '5 days', 'resumo-expired', false),
    (v_other_class, v_tenant, v_student, v_other_teacher, v_today - 4, now() - interval '4 days' - interval '90 minutes', now() - interval '4 days' - interval '60 minutes', 'resumo-other', false);

  -- Fontes: transcrição e anotações importadas há 1 h (a anotação teve uma
  -- revisão antiga, que não deve ser usada).
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at) values
    (v_tenant, v_older, 'conferenceRecords/r1/transcripts/t1', 'TRANSCRIPT', 'docOlderT', encode(sha256('older-t'::bytea), 'hex'),
      '[10:00:01] Prof: turn left at the bank.', now() - interval '60 minutes', now() + interval '90 days')
  returning id into v_older_transcript;
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at) values
    (v_tenant, v_older, 'conferenceRecords/r1/smartNotes/n1', 'SMART_NOTES', 'docOlderN', encode(sha256('older-n-old'::bytea), 'hex'),
      'Resumo antigo.', now() - interval '100 minutes', now() + interval '90 days')
  returning id into v_older_notes_old;
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at) values
    (v_tenant, v_older, 'conferenceRecords/r1/smartNotes/n1', 'SMART_NOTES', 'docOlderN', encode(sha256('older-n'::bytea), 'hex'),
      'Resumo: direções. Próximas etapas: revisar o mapa.', now() - interval '60 minutes', now() + interval '90 days')
  returning id into v_older_notes;
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at) values
    (v_tenant, v_ready, 'conferenceRecords/r2/transcripts/t1', 'TRANSCRIPT', 'docReadyT', encode(sha256('ready-t'::bytea), 'hex'),
      '[11:00:01] Prof: go straight.', now() - interval '60 minutes', now() + interval '90 days')
  returning id into v_ready_transcript;
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at)
  select v_tenant, session_id, 'conferenceRecords/' || tag || '/transcripts/t1', 'TRANSCRIPT', 'doc' || tag,
    encode(sha256(tag::bytea), 'hex'), 'fala da aula ' || tag, imported, now() + interval '90 days'
  from (values (v_fresh, 'fresh', now() - interval '5 minutes'), (v_pending_doc, 'pending', now() - interval '60 minutes'),
    (v_no_consent, 'noconsent', now() - interval '60 minutes'), (v_blocked, 'blocked', now() - interval '60 minutes'),
    (v_has_ai, 'hasai', now() - interval '60 minutes'), (v_verified, 'verified', now() - interval '60 minutes'),
    (v_week_old, 'weekold', now() - interval '8 days')) as fixture(session_id, tag, imported);
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at) values
    (v_tenant, v_stale, 'conferenceRecords/r9/smartNotes/n1', 'SMART_NOTES', 'docStaleN', encode(sha256('stale-n'::bytea), 'hex'),
      'Notas da aula parada.', now() - interval '4 days', now() + interval '10 days')
  returning id into v_stale_src;
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at) values
    (v_tenant, v_other_class, 'conferenceRecords/r8/smartNotes/n1', 'SMART_NOTES', 'docOtherN', encode(sha256('other-n'::bytea), 'hex'),
      'Notas do outro professor.', now() - interval '4 days', now() + interval '20 days')
  returning id into v_other_src;
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, imported_at, expires_at) values
    (v_tenant, v_expired_src, 'conferenceRecords/r7/smartNotes/n1', 'SMART_NOTES', 'docExpiredN', encode(sha256('expired-n'::bytea), 'hex'),
      'Notas vencidas.', now() - interval '5 days', now() - interval '1 minute');
  insert into private.google_meet_artifact_imports (lesson_session_id, tenant_id, provider_name, kind, status, updated_at) values
    (v_pending_doc, v_tenant, 'conferenceRecords/pending/smartNotes/n1', 'SMART_NOTES', 'PENDING', now() - interval '10 minutes');
  -- Resumo de IA já existente, versão aprovada já existente, rascunhos parados.
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content, source_artifact_ids, created_at)
  select v_tenant, v_has_ai, 1, 'PROPOSED', 'GEMINI_API', '{}'::jsonb,
    array[(select id from private.meeting_artifact_revisions where lesson_session_id = v_has_ai)], now() - interval '30 minutes';
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content, source_artifact_ids, created_at)
  select v_tenant, v_verified, 1, 'VERIFIED', 'HUMAN_REVIEW', '{}'::jsonb,
    array[(select id from private.meeting_artifact_revisions where lesson_session_id = v_verified)], now() - interval '30 minutes';
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content, source_artifact_ids, created_at) values
    (v_tenant, v_stale, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES', '{"narrative":"Notas da aula parada."}'::jsonb, array[v_stale_src], now() - interval '4 days'),
    (v_tenant, v_other_class, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES', '{"narrative":"Notas do outro professor."}'::jsonb, array[v_other_src], now() - interval '4 days'),
    (v_tenant, v_expired_src, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES', '{"narrative":"Notas vencidas."}'::jsonb,
      array[(select id from private.meeting_artifact_revisions where lesson_session_id = v_expired_src)], now() - interval '5 days');

  -- ===== 1. Elegibilidade: aceite efetivo, fontes paradas, sem resumo de IA ===========
  perform pg_temp.resumo_assert(private.meet_summary_auto_eligible(v_older) and private.meet_summary_auto_eligible(v_ready),
    'aula pronta não ficou elegível');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_fresh), 'fonte de 5 min atrás já gerou resumo');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_pending_doc), 'documento ainda sendo gerado não segurou o resumo');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_no_consent), 'aula sem aceite ficou elegível');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_blocked), 'aluno que revogou antes do fim teve resumo');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_has_ai), 'aula com resumo de IA ganharia outro');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_verified), 'aula já aprovada ganharia rascunho');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_week_old), 'aula de 8 dias atrás na fila');
  -- Documento "sendo gerado" há mais de 6 h não segura mais.
  update private.google_meet_artifact_imports set updated_at = now() - interval '7 hours' where lesson_session_id = v_pending_doc;
  perform pg_temp.resumo_assert(private.meet_summary_auto_eligible(v_pending_doc), 'documento travado no Google segurou o resumo para sempre');
  update private.google_meet_artifact_imports set updated_at = now() - interval '10 minutes' where lesson_session_id = v_pending_doc;

  -- ===== 2. Fila: UMA por rodada, a aula mais antiga, sem conta central =================
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.resumo_assert((select count(*) from jsonb_array_elements(v_jobs) j where j ->> 'operation' = 'GENERATE_SUMMARY') = 1,
    'fila não trouxe exatamente uma geração: ' || v_jobs::text);
  perform pg_temp.resumo_assert(exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'operation' = 'GENERATE_SUMMARY' and j ->> 'lesson_session_id' = v_older::text
      and j ->> 'tenant_id' = v_tenant and (j ->> 'priority_group')::int = 1 and j -> 'actor_id' = 'null'::jsonb),
    'a geração da fila não é a aula mais antiga do grupo 1: ' || v_jobs::text);

  -- Fontes: revisão mais recente de cada documento, transcrição primeiro.
  v_result := public.google_meet_summary_backend('auto_sources', v_tenant, null, v_older);
  perform pg_temp.resumo_assert((v_result ->> 'eligible')::boolean and jsonb_array_length(v_result -> 'sources') = 2
    and v_result -> 'sources' -> 0 ->> 'id' = v_older_transcript::text
    and v_result -> 'sources' -> 1 ->> 'id' = v_older_notes::text
    and v_result -> 'sources' -> 1 ->> 'source_text' like 'Resumo: direções%',
    'fontes erradas para o resumo: ' || v_result::text);
  v_result := public.google_meet_summary_backend('auto_sources', v_tenant, null, v_blocked);
  perform pg_temp.resumo_assert(not (v_result ->> 'eligible')::boolean and jsonb_array_length(v_result -> 'sources') = 0,
    'fontes de aula revogada foram entregues à IA');

  -- ===== 3. Reserva: hash das fontes calculado no banco, lease, idempotência =============
  v_blocked_flag := false;
  begin
    perform public.google_meet_summary_backend('claim', v_tenant, null, v_older, jsonb_build_object(
      'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.03,
      'source_artifact_ids', jsonb_build_array(v_older_transcript, v_ready_transcript)));
  exception when insufficient_privilege then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'fonte de OUTRA aula entrou na reserva');
  v_blocked_flag := false;
  begin
    perform public.google_meet_summary_backend('claim', v_tenant, null, v_older, jsonb_build_object(
      'trigger', 'AUTOMATIC', 'model_id', '../../malicioso', 'estimated_usd', 0.03,
      'source_artifact_ids', jsonb_build_array(v_older_transcript)));
  exception when invalid_parameter_value then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'modelo inválido foi aceito');

  v_result := public.google_meet_summary_backend('claim', v_tenant, null, v_older, jsonb_build_object(
    'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.03,
    'source_artifact_ids', jsonb_build_array(v_older_notes, v_older_transcript)));
  perform pg_temp.resumo_assert((v_result ->> 'claimed')::boolean, 'reserva automática recusada: ' || v_result::text);
  v_gen := (v_result ->> 'generation_id')::uuid;
  select encode(sha256(convert_to(string_agg(r.id::text || ':' || r.content_sha256, ',' order by r.id), 'UTF8')), 'hex')
    into v_hash from private.meeting_artifact_revisions r where r.id in (v_older_notes, v_older_transcript);
  perform pg_temp.resumo_assert(v_result ->> 'sources_sha256' = v_hash, 'hash das fontes não é o do conteúdo guardado');
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_older), 'aula em geração continuou elegível');
  v_result := public.google_meet_summary_backend('claim', v_tenant, null, v_older, jsonb_build_object(
    'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.03,
    'source_artifact_ids', jsonb_build_array(v_older_transcript, v_older_notes)));
  perform pg_temp.resumo_assert(not (v_result ->> 'claimed')::boolean
    and v_result ->> 'reason' = 'google_summary_generation_rate_limited', 'duas gerações simultâneas da mesma aula');
  -- Com esta em andamento, a fila passa para a próxima aula.
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.resumo_assert(exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'operation' = 'GENERATE_SUMMARY' and j ->> 'lesson_session_id' = v_ready::text),
    'a fila não seguiu para a próxima aula');
  perform pg_temp.resumo_assert(round(private.meet_summary_month_spend(v_tenant), 2) = 0.03,
    'a estimativa em andamento não entrou no gasto do mês');

  -- Rascunho sem evidência é recusado; com evidência vira PROPOSED de IA, sem autor.
  v_blocked_flag := false;
  begin
    perform public.google_meet_summary_backend('finish', v_tenant, null, v_older, jsonb_build_object(
      'generation_id', v_gen, 'status', 'SUCCEEDED', 'content', v_evidence || '{"evidence":[]}'::jsonb));
  exception when invalid_parameter_value then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'rascunho sem evidência foi gravado');
  v_result := public.google_meet_summary_backend('finish', v_tenant, null, v_older, jsonb_build_object(
    'generation_id', v_gen, 'status', 'SUCCEEDED', 'content', v_evidence, 'prompt_version', 'meet-pedagogical-v2',
    'cost_usd', 0.012, 'cost_source', 'PROVIDER', 'input_tokens', 9000, 'output_tokens', 1800,
    'reasoning_tokens', 700, 'cached_tokens', 0));
  perform pg_temp.resumo_assert(v_result ->> 'status' = 'SUCCEEDED'
    and v_result -> 'summary' ->> 'status' = 'PROPOSED' and v_result -> 'summary' ->> 'origin' = 'GEMINI_API'
    and v_result -> 'summary' ->> 'created_by' is null
    and v_result -> 'summary' ->> 'prompt_version' = 'meet-pedagogical-v2',
    'rascunho de IA não foi gravado como PROPOSED do sistema: ' || v_result::text);
  perform pg_temp.resumo_assert(exists (select 1 from private.google_meet_summary_generations g
    where g.id = v_gen and g.status = 'SUCCEEDED' and g.cost_usd = 0.012 and g.reasoning_tokens = 700
      and g.summary_version_id = (v_result -> 'summary' ->> 'id')::uuid), 'livro sem custo, tokens ou versão');
  perform pg_temp.resumo_assert(not exists (select 1 from public.student_learning_memories m
    where m.source_type = 'MEET_SESSION' and m.source_ref = v_older::text),
    'rascunho da IA foi para a memória do aluno sem aprovação');
  perform pg_temp.resumo_assert(round(private.meet_summary_month_spend(v_tenant), 3) = 0.012,
    'o custo real não substituiu a estimativa');
  v_blocked_flag := false;
  begin
    perform public.google_meet_summary_backend('finish', v_tenant, null, v_older, jsonb_build_object(
      'generation_id', v_gen, 'status', 'FAILED', 'error_code', 'x'));
  exception when object_not_in_prerequisite_state then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'geração terminada foi terminada de novo');

  -- O MESMO conteúdo nunca é pago duas vezes, nem pelo botão manual.
  v_result := public.google_meet_summary_backend('claim', v_tenant, v_teacher, v_older, jsonb_build_object(
    'trigger', 'MANUAL', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.03,
    'source_artifact_ids', jsonb_build_array(v_older_transcript, v_older_notes)));
  perform pg_temp.resumo_assert(not (v_result ->> 'claimed')::boolean and v_result ->> 'reason' = 'google_summary_already_generated',
    'o mesmo conteúdo foi gerado (e cobrado) de novo: ' || v_result::text);
  -- Manual só para quem vê a fonte.
  v_blocked_flag := false;
  begin
    perform public.google_meet_summary_backend('claim', v_tenant, v_other_teacher, v_ready, jsonb_build_object(
      'trigger', 'MANUAL', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.03,
      'source_artifact_ids', jsonb_build_array(v_ready_transcript)));
  exception when insufficient_privilege then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'professor de outra aula pediu o resumo à mão');

  -- ===== 4. Teto mensal ===========================================================
  -- Gasto de outro mês não conta.
  insert into private.google_meet_summary_generations (tenant_id, lesson_session_id, trigger, status, sources_sha256,
    source_artifact_ids, model_id, estimated_usd, cost_usd, lease_expires_at, created_at, finished_at)
  values (v_tenant, v_week_old, 'AUTOMATIC', 'FAILED', encode(sha256('mes-passado'::bytea), 'hex'),
    array[(select id from private.meeting_artifact_revisions where lesson_session_id = v_week_old)], 'google/gemini-3.6-flash',
    0.03, 4.5, private.meet_summary_month_start() - interval '1 day', private.meet_summary_month_start() - interval '1 day',
    private.meet_summary_month_start() - interval '1 day');
  perform pg_temp.resumo_assert(round(private.meet_summary_month_spend(v_tenant), 3) = 0.012, 'gasto do mês passado entrou no teto');

  -- Só a direção muda o teto.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_blocked_flag := false;
  begin perform public.set_meet_summary_monthly_cap(1); exception when insufficient_privilege then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'professor mudou o teto');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_coord, 'role', 'authenticated')::text, true);
  v_blocked_flag := false;
  begin perform public.get_meet_summary_budget(); exception when insufficient_privilege then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'coordenação leu o gasto da direção');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.get_meet_summary_budget();
  perform pg_temp.resumo_assert((v_result ->> 'cap_usd')::numeric = 20 and (v_result ->> 'default_cap')::boolean
    and (v_result ->> 'spent_usd')::numeric = 0.012 and (v_result ->> 'automatic_count')::int = 1
    and not (v_result ->> 'cap_reached')::boolean, 'teto padrão de US$ 20 ou gasto errado: ' || v_result::text);
  v_blocked_flag := false;
  begin perform public.set_meet_summary_monthly_cap(600); exception when invalid_parameter_value then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'teto acima do limite foi aceito');
  v_result := public.set_meet_summary_monthly_cap(0.04);
  perform pg_temp.resumo_assert((v_result ->> 'cap_usd')::numeric = 0.04 and not (v_result ->> 'default_cap')::boolean,
    'teto novo não gravou');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Atingido o teto, a automática para (a claim recusa e a fila não oferece).
  v_result := public.google_meet_summary_backend('claim', v_tenant, null, v_ready, jsonb_build_object(
    'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.03,
    'source_artifact_ids', jsonb_build_array(v_ready_transcript)));
  perform pg_temp.resumo_assert(not (v_result ->> 'claimed')::boolean and v_result ->> 'reason' = 'google_summary_budget_exhausted',
    'geração automática passou do teto: ' || v_result::text);
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.resumo_assert(not exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'operation' = 'GENERATE_SUMMARY'),
    'fila ofereceu geração com o teto estourado');
  v_result := public.google_meet_summary_backend('budget', v_tenant, null, v_older);
  perform pg_temp.resumo_assert((v_result ->> 'cap_reached')::boolean and v_result -> 'last_generation' ->> 'status' = 'SUCCEEDED',
    'a porta da edge não disse que o teto foi atingido: ' || v_result::text);
  -- O manual continua (com o aceite de custo, que é da tela).
  v_result := public.google_meet_summary_backend('claim', v_tenant, v_teacher, v_ready, jsonb_build_object(
    'trigger', 'MANUAL', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.03,
    'source_artifact_ids', jsonb_build_array(v_ready_transcript)));
  perform pg_temp.resumo_assert((v_result ->> 'claimed')::boolean, 'teto bloqueou o pedido manual');
  v_gen2 := (v_result ->> 'generation_id')::uuid;
  -- A escola retirou a autorização durante a geração: custo registrado, rascunho não.
  update public.lesson_sessions set documentation_consent = false where id = v_ready;
  v_result := public.google_meet_summary_backend('finish', v_tenant, null, v_ready, jsonb_build_object(
    'generation_id', v_gen2, 'status', 'SUCCEEDED', 'content', v_evidence, 'cost_usd', 0.01, 'cost_source', 'PROVIDER'));
  perform pg_temp.resumo_assert(v_result ->> 'status' = 'FAILED' and v_result ->> 'error_code' = 'documentation_consent_required'
    and v_result -> 'summary' = 'null'::jsonb
    and not exists (select 1 from private.lesson_summary_versions v where v.lesson_session_id = v_ready),
    'rascunho gravado depois de a autorização sair: ' || v_result::text);
  update public.lesson_sessions set documentation_consent = true where id = v_ready;

  -- ===== 5. Lease vencida: ABANDONED conta a estimativa; 2 falhas encerram ===========
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_meet_summary_monthly_cap(20);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update private.google_meet_summary_generations set created_at = now() - interval '2 hours' where id = v_gen2;
  v_result := public.google_meet_summary_backend('claim', v_tenant, null, v_pending_doc, jsonb_build_object(
    'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.05,
    'source_artifact_ids', jsonb_build_array((select id from private.meeting_artifact_revisions where lesson_session_id = v_pending_doc))));
  perform pg_temp.resumo_assert(not (v_result ->> 'claimed')::boolean and v_result ->> 'reason' = 'google_summary_not_eligible',
    'documento ainda sendo gerado passou pela reserva');
  update private.google_meet_artifact_imports set updated_at = now() - interval '7 hours' where lesson_session_id = v_pending_doc;
  v_result := public.google_meet_summary_backend('claim', v_tenant, null, v_pending_doc, jsonb_build_object(
    'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.05,
    'source_artifact_ids', jsonb_build_array((select id from private.meeting_artifact_revisions where lesson_session_id = v_pending_doc))));
  perform pg_temp.resumo_assert((v_result ->> 'claimed')::boolean, 'reserva recusada: ' || v_result::text);
  update private.google_meet_summary_generations set lease_expires_at = now() - interval '1 minute'
   where id = (v_result ->> 'generation_id')::uuid;
  v_result := public.google_meet_summary_backend('claim', v_tenant, null, v_pending_doc, jsonb_build_object(
    'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.05,
    'source_artifact_ids', jsonb_build_array((select id from private.meeting_artifact_revisions where lesson_session_id = v_pending_doc))));
  perform pg_temp.resumo_assert(not (v_result ->> 'claimed')::boolean, 'reserva logo depois de o worker morrer (espera de 1 h)');
  perform pg_temp.resumo_assert(exists (select 1 from private.google_meet_summary_generations g
    where g.lesson_session_id = v_pending_doc and g.status = 'ABANDONED' and g.cost_usd is null
      and g.error_code = 'google_summary_worker_lost'), 'lease vencida não virou ABANDONED');
  perform pg_temp.resumo_assert(round(private.meet_summary_month_spend(v_tenant), 3) = 0.072,
    'geração abandonada não contou a estimativa (' || private.meet_summary_month_spend(v_tenant) || ')');
  -- Segunda falha automática encerra a aula na fila.
  update private.google_meet_summary_generations set finished_at = now() - interval '2 hours'
   where lesson_session_id = v_pending_doc;
  v_result := public.google_meet_summary_backend('claim', v_tenant, null, v_pending_doc, jsonb_build_object(
    'trigger', 'AUTOMATIC', 'model_id', 'google/gemini-3.6-flash', 'estimated_usd', 0.05,
    'source_artifact_ids', jsonb_build_array((select id from private.meeting_artifact_revisions where lesson_session_id = v_pending_doc))));
  perform public.google_meet_summary_backend('finish', v_tenant, null, v_pending_doc, jsonb_build_object(
    'generation_id', v_result ->> 'generation_id', 'status', 'FAILED', 'error_code', 'google_summary_response_invalid',
    'cost_usd', 0.002, 'cost_source', 'PROVIDER'));
  update private.google_meet_summary_generations set finished_at = now() - interval '2 hours'
   where lesson_session_id = v_pending_doc;
  perform pg_temp.resumo_assert(not private.meet_summary_auto_eligible(v_pending_doc), 'aula com 2 falhas automáticas continuou na fila');

  -- ===== 6. Pausa quando a IA não está configurada no servidor ========================
  perform public.google_meet_summary_backend('auto_pause', v_tenant, null, null,
    jsonb_build_object('reason', 'google_summary_ai_not_configured', 'minutes', 60));
  perform pg_temp.resumo_assert(not private.meet_summary_auto_budget_ok(v_tenant), 'pausa não tirou a escola da fila');
  v_result := public.google_meet_summary_backend('budget', v_tenant);
  perform pg_temp.resumo_assert(v_result ->> 'pause_reason' = 'google_summary_ai_not_configured'
    and not (v_result ->> 'cap_reached')::boolean, 'pausa aparece como teto atingido');
  update private.google_meet_summary_settings set auto_paused_until = null, auto_pause_reason = null where tenant_id = v_tenant;

  -- ===== 7. Aulas para revisar ==========================================================
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_result := public.get_meet_summary_review_queue();
  perform pg_temp.resumo_assert(exists (select 1 from jsonb_array_elements(v_result -> 'items') i
      where i ->> 'session_id' = v_older::text and i ->> 'origin' = 'GEMINI_API' and not (i ->> 'stale')::boolean
        and (i ->> 'approvable_until')::timestamptz = (select min(expires_at) from private.meeting_artifact_revisions
          where id in (v_older_transcript, v_older_notes)))
    and exists (select 1 from jsonb_array_elements(v_result -> 'items') i
      where i ->> 'session_id' = v_stale::text and (i ->> 'stale')::boolean and i ->> 'student_name' = 'Aluna Resumo')
    and not exists (select 1 from jsonb_array_elements(v_result -> 'items') i where i ->> 'session_id' = v_other_class::text)
    and not exists (select 1 from jsonb_array_elements(v_result -> 'items') i where i ->> 'session_id' = v_expired_src::text)
    and not exists (select 1 from jsonb_array_elements(v_result -> 'items') i where i ->> 'session_id' = v_verified::text),
    'fila do professor errada: ' || v_result::text);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_coord, 'role', 'authenticated')::text, true);
  v_result := public.get_meet_summary_review_queue();
  perform pg_temp.resumo_assert(exists (select 1 from jsonb_array_elements(v_result -> 'items') i
    where i ->> 'session_id' = v_other_class::text and i ->> 'teacher_name' = 'Prof Outro'),
    'coordenação não vê a fila da escola inteira');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_student, 'role', 'authenticated')::text, true);
  v_blocked_flag := false;
  begin perform public.get_meet_summary_review_queue(); exception when insufficient_privilege then v_blocked_flag := true; end;
  perform pg_temp.resumo_assert(v_blocked_flag, 'aluno leu a fila de revisão');

  -- Pendência da direção: parados há 3+ dias (v_stale e v_other_class).
  perform pg_temp.resumo_assert(private.meet_summary_review_stale_count(v_tenant) = 2, 'contagem de resumos parados errada');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.director_pending_counts();
  perform pg_temp.resumo_assert((v_result ->> 'resumos_para_revisar')::int = 2,
    'director_pending_counts sem resumos_para_revisar: ' || coalesce(v_result::text, 'null'));

  -- Aprovar tira da fila (e só então alimenta a memória).
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_result := public.google_meet_backend('summary_save', v_tenant, v_teacher, v_stale, jsonb_build_object(
    'status', 'VERIFIED', 'origin', 'HUMAN_REVIEW',
    'parent_version_id', (select id from private.lesson_summary_versions where lesson_session_id = v_stale and version = 1),
    'content', jsonb_build_object('lesson_objective', 'Revisar', 'recommended_next_step', 'Mapa'),
    'source_artifact_ids', jsonb_build_array(v_stale_src)));
  perform pg_temp.resumo_assert(private.meet_summary_review_stale_count(v_tenant) = 1
    and not exists (select 1 from private.meet_summary_review_items(v_tenant, null) i where i.lesson_session_id = v_stale),
    'aula aprovada continuou para revisar');
  -- Rascunho novo depois da revisão volta, contando a partir dele.
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content, source_artifact_ids, created_at)
  values (v_tenant, v_stale, 3, 'PROPOSED', 'GEMINI_API', '{}'::jsonb, array[v_stale_src], now() - interval '1 hour');
  perform pg_temp.resumo_assert(exists (select 1 from private.meet_summary_review_items(v_tenant, v_teacher) i
    where i.lesson_session_id = v_stale and i.pending_since > now() - interval '2 hours'),
    'rascunho novo depois da aprovação não voltou para a fila com a data dele');
end
$test$;

rollback;
