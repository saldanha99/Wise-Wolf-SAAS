-- Originais do Drive para a lixeira e exclusão a pedido (migration
-- 20260927120000). Reprova contra o código anterior: não existia registro dos
-- originais, operação PURGE_ORIGINALS na fila, porta da edge, bloqueio de
-- aula apagada nem o pedido de exclusão da direção.
--
-- Não depende de dado real nem da fila global: as conexões reais saem do ar e as
-- outras escolas ficam pausadas para o resumo automático só dentro desta
-- transação (o rollback devolve). Horários relativos a now().
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.originais_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'originais no Drive: %', p_message;
  end if;
end;
$$;

-- Erro esperado: devolve a mensagem (ou 'sem_erro').
create or replace function pg_temp.originais_error(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'sem_erro';
exception when others then
  return sqlerrm;
end;
$$;

do $privileges$
begin
  perform pg_temp.originais_assert(
    not has_table_privilege('authenticated', 'private.google_meet_drive_originals', 'SELECT')
    and not has_table_privilege('anon', 'private.google_meet_drive_originals', 'SELECT')
    and not has_table_privilege('service_role', 'private.google_meet_drive_originals', 'SELECT')
    and not has_table_privilege('authenticated', 'private.google_meet_original_sessions', 'SELECT')
    and not has_table_privilege('authenticated', 'private.student_lesson_record_erasures', 'SELECT')
    and not has_table_privilege('service_role', 'private.student_lesson_record_erasures', 'SELECT'),
    'registro dos originais ou trilha da exclusão legível fora das RPCs');
  perform pg_temp.originais_assert(
    not has_function_privilege('authenticated', 'public.google_meet_originals_backend(text,text,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.google_meet_originals_backend(text,text,uuid,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.google_meet_originals_backend(text,text,uuid,jsonb)', 'EXECUTE'),
    'porta da edge aberta ao navegador (ou fechada para a edge)');
  perform pg_temp.originais_assert(
    has_function_privilege('authenticated', 'public.get_meet_originals_retention_status()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_student_lesson_records_erasure_preview(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.erase_student_lesson_records(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_meet_originals_retention_status()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_student_lesson_records_erasure_preview(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.erase_student_lesson_records(uuid)', 'EXECUTE'),
    'RPCs da tela com privilégio errado');
  perform pg_temp.originais_assert(
    not has_function_privilege('authenticated', 'private.google_meet_register_original(uuid,text,text,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.google_meet_original_discovery_due(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_lesson_records_counts(text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.lesson_records_erased_guard()', 'EXECUTE'),
    'régua interna executável pelo navegador');
  perform pg_temp.originais_assert(
    strpos(pg_get_functiondef('public.get_pending_google_meet_sync_sessions()'::regprocedure), 'PURGE_ORIGINALS') > 0
    and strpos(pg_get_functiondef('public.get_pending_google_meet_sync_sessions()'::regprocedure), 'GENERATE_SUMMARY') > 0,
    'remendo por âncora não entrou na fila (ou apagou o ramo do resumo)');
  -- A âncora continua valendo, uma vez, para a próxima frente que remendar a fila.
  perform pg_temp.originais_assert(
    (select count(*) from regexp_matches(pg_get_functiondef('public.get_pending_google_meet_sync_sessions()'::regprocedure),
      E'\\)\\s+jobs\\s+order\\s+by\\s+jobs\\.priority_group', 'g')) = 1,
    'o remendo quebrou a âncora da fila');
  perform pg_temp.originais_assert(
    (private.google_meet_originals_policy() ->> 'trash_after_days')::integer = 90,
    'prazo da lixeira diferente de 90 dias');
end
$privileges$;

do $test$
declare
  v_tenant constant text := 'meet-originais-fixture';
  v_other_tenant constant text := 'meet-originais-outra';
  v_drive constant text := 'https://www.googleapis.com/auth/drive';
  v_admin uuid := gen_random_uuid();
  v_coord uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();       -- pede a exclusão
  v_other_student uuid := gen_random_uuid(); -- não é tocado
  v_other_admin uuid := gen_random_uuid();   -- direção de outra escola
  v_old uuid := gen_random_uuid();       -- aula de 91 dias atrás: originais vencidos
  v_recent uuid := gen_random_uuid();    -- 10 dias atrás, importação EXPIRED: lista a conferir
  v_sync uuid := gen_random_uuid();      -- terminou há 1 h, importação pendente
  v_future uuid := gen_random_uuid();    -- amanhã: fora do pedido
  v_live uuid := gen_random_uuid();      -- outro aluno, 3 dias, importação em andamento
  v_blocked uuid := gen_random_uuid();   -- outro aluno, sem aceite, sala criada
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb; v_jobs jsonb; v_job jsonb; v_row record; v_error text;
  v_revision uuid; v_version uuid; v_other_revision uuid;
  v_before timestamptz; v_erased_at timestamptz;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Isola a fila global: sem conexões reais e com o resumo automático pausado
  -- para todas as escolas (a fila só enxerga esta fixture).
  update private.google_workspace_connections set status = 'REAUTH_REQUIRED' where status = 'CONNECTED';
  insert into private.google_meet_summary_settings (tenant_id, auto_paused_until, auto_pause_reason)
  select tenant.id, now() + interval '1 day', 'teste_isolado' from public.tenants as tenant
  on conflict (tenant_id) do update set auto_paused_until = excluded.auto_paused_until,
    auto_pause_reason = excluded.auto_pause_reason;

  insert into public.tenants (id, name) values (v_tenant, 'Originais fixture'), (v_other_tenant, 'Outra escola fixture');
  insert into private.google_meet_summary_settings (tenant_id, auto_paused_until, auto_pause_reason)
  values (v_tenant, now() + interval '1 day', 'teste_isolado'), (v_other_tenant, now() + interval '1 day', 'teste_isolado');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'originais-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_coord, 'originais-coord@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'originais-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student, 'originais-student@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_other_student, 'originais-student2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_other_admin, 'originais-admin2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = case when id = v_other_admin then v_other_tenant else v_tenant end,
         lifecycle_status = 'active', is_test_account = true,
         role = case when id in (v_admin, v_other_admin) then 'SCHOOL_ADMIN' when id = v_coord then 'COORDINATOR'
           when id = v_teacher then 'TEACHER' else 'STUDENT' end
   where id in (v_admin, v_coord, v_teacher, v_student, v_other_student, v_other_admin);
  update public.profiles set professor_id = v_teacher where id in (v_student, v_other_student);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles
     where id in (v_admin, v_coord, v_teacher, v_student, v_other_student, v_other_admin)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email,
    refresh_token_ciphertext, granted_scopes, status, connected_by) values
    (v_tenant, 'sub-central', 'central@example.invalid', 'v1.fixture.fixture',
      array['openid', 'email', 'https://www.googleapis.com/auth/meetings.space.created', v_drive], 'CONNECTED', v_admin);

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key, documentation_consent) values
    (v_old, v_tenant, v_student, v_teacher, v_today - 91, now() - interval '91 days' - interval '30 minutes',
      now() - interval '91 days', 'originais-old', true),
    (v_recent, v_tenant, v_student, v_teacher, v_today - 10, now() - interval '10 days' - interval '30 minutes',
      now() - interval '10 days', 'originais-recent', true),
    (v_sync, v_tenant, v_student, v_teacher, v_today, now() - interval '90 minutes', now() - interval '60 minutes',
      'originais-sync', true),
    (v_future, v_tenant, v_student, v_teacher, v_today + 1, now() + interval '1 day', now() + interval '1 day' + interval '30 minutes',
      'originais-future', true),
    (v_live, v_tenant, v_other_student, v_teacher, v_today - 3, now() - interval '3 days' - interval '30 minutes',
      now() - interval '3 days', 'originais-live', true),
    (v_blocked, v_tenant, v_other_student, v_teacher, v_today - 1, now() - interval '1 day' - interval '30 minutes',
      now() - interval '1 day', 'originais-blocked', false);
  insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
    cohost_email, state, created_by, sync_status, next_sync_at) values
    (v_old, v_tenant, 'spaces/originaisOld', 'https://meet.google.com/aaa-bbbb-ccc', 'sub-central',
      'prof@example.com', 'READY', v_admin, 'COMPLETE', null),
    (v_recent, v_tenant, 'spaces/originaisRecent', 'https://meet.google.com/aaa-bbbb-ccd', 'sub-central',
      'prof@example.com', 'READY', v_admin, 'EXPIRED', null),
    (v_sync, v_tenant, 'spaces/originaisSync', 'https://meet.google.com/aaa-bbbb-cce', 'sub-central',
      'prof@example.com', 'READY', v_admin, 'PENDING', now() - interval '1 minute'),
    (v_live, v_tenant, 'spaces/originaisLive', 'https://meet.google.com/aaa-bbbb-ccf', 'sub-central',
      'prof@example.com', 'READY', v_admin, 'PENDING', now() + interval '1 hour'),
    (v_blocked, v_tenant, 'spaces/originaisBlocked', 'https://meet.google.com/aaa-bbbb-ccg', 'sub-central',
      'prof@example.com', 'READY', v_admin, 'WAITING', null);

  -- 1. Registro: documentos pela porta da edge (id da Meet API), planilha de
  --    presença pelo gatilho. Só da conta que criou a sala; nada de planilha
  --    pela porta; o mesmo arquivo nunca entra duas vezes.
  v_result := public.google_meet_originals_backend('register', v_tenant, v_old, jsonb_build_object(
    'organizer_sub', 'sub-central', 'discovered', true, 'files', jsonb_build_array(
      jsonb_build_object('file_id', 'docOldTranscript', 'kind', 'TRANSCRIPT'),
      jsonb_build_object('file_id', 'docOldNotes', 'kind', 'SMART_NOTES'))));
  perform pg_temp.originais_assert((v_result ->> 'registered')::integer = 2, 'documentos da aula não registrados');
  v_result := public.google_meet_originals_backend('register', v_tenant, v_old, jsonb_build_object(
    'organizer_sub', 'sub-central', 'files', jsonb_build_array(jsonb_build_object('file_id', 'docOldNotes', 'kind', 'SMART_NOTES'))));
  perform pg_temp.originais_assert((v_result ->> 'registered')::integer = 0
    and (select count(*) from private.google_meet_drive_originals where file_id = 'docOldNotes') = 1,
    'o mesmo arquivo entrou duas vezes');
  v_error := pg_temp.originais_error(format($sql$select public.google_meet_originals_backend('register', %L, %L,
    '{"organizer_sub":"outra-conta","files":[{"file_id":"docIntruso","kind":"TRANSCRIPT"}]}'::jsonb)$sql$, v_tenant, v_old));
  perform pg_temp.originais_assert(v_error = 'google_organizer_changed', 'registrou documento de outra conta: ' || v_error);
  v_error := pg_temp.originais_error(format($sql$select public.google_meet_originals_backend('register', %L, %L,
    '{"organizer_sub":"sub-central","files":[{"file_id":"planilhaPorNome","kind":"ATTENDANCE_REPORT"}]}'::jsonb)$sql$, v_tenant, v_old));
  perform pg_temp.originais_assert(v_error = 'google_original_kind_invalid', 'planilha entrou pela porta dos documentos: ' || v_error);

  insert into private.meeting_attendance_reports (tenant_id, lesson_session_id, document_id, content_sha256, source_csv,
    expires_at, source_document_ids) values
    (v_tenant, v_old, 'sheetOld1', encode(sha256('csv-old'::bytea), 'hex'), 'Nome,E-mail', now() + interval '1 day',
      array['sheetOld1', 'sheetOld2']);
  perform pg_temp.originais_assert(
    (select count(*) from private.google_meet_drive_originals
      where lesson_session_id = v_old and kind = 'ATTENDANCE_REPORT' and origin = 'ATTENDANCE_REPORT_SAVED') = 2,
    'planilhas de presença guardadas não viraram originais');
  perform pg_temp.originais_assert(
    (select bool_and(trash_due_at = (select scheduled_end_at from public.lesson_sessions where id = v_old) + interval '90 days')
      from private.google_meet_drive_originals where lesson_session_id = v_old)
    and (select bool_and(trash_due_at <= now()) from private.google_meet_drive_originals where lesson_session_id = v_old),
    'prazo da lixeira não é 90 dias depois da aula');

  v_result := public.google_meet_originals_backend('register', v_tenant, v_recent, jsonb_build_object(
    'organizer_sub', 'sub-central', 'files', jsonb_build_array(jsonb_build_object('file_id', 'docRecentT', 'kind', 'TRANSCRIPT'))));
  perform pg_temp.originais_assert(jsonb_array_length(v_result -> 'files_due') = 0
    and (select trash_due_at > now() + interval '79 days' from private.google_meet_drive_originals where file_id = 'docRecentT'),
    'original de aula recente já venceu');

  -- 2. Fila: vencidos com escopo drive e listas a conferir; nada para a aula
  --    cuja importação ainda está em andamento.
  v_jobs := public.get_pending_google_meet_sync_sessions();
  select value into v_job from jsonb_array_elements(v_jobs)
   where value ->> 'lesson_session_id' = v_old::text and value ->> 'operation' = 'PURGE_ORIGINALS';
  perform pg_temp.originais_assert(v_job is not null and (v_job ->> 'actor_id')::uuid = v_admin
    and (v_job ->> 'priority_group')::integer = 4, 'originais vencidos fora da fila: ' || coalesce(v_jobs::text, 'null'));
  perform pg_temp.originais_assert(exists (select 1 from jsonb_array_elements(v_jobs) as job
    where job ->> 'lesson_session_id' = v_recent::text and job ->> 'operation' = 'PURGE_ORIGINALS'),
    'importação vencida (EXPIRED) sem conferência da lista');
  perform pg_temp.originais_assert(exists (select 1 from jsonb_array_elements(v_jobs) as job
    where job ->> 'lesson_session_id' = v_blocked::text and job ->> 'operation' = 'PURGE_ORIGINALS'),
    'aula sem aceite com sala criada sem conferência da lista');
  perform pg_temp.originais_assert(not exists (select 1 from jsonb_array_elements(v_jobs) as job
    where job ->> 'lesson_session_id' = v_live::text and job ->> 'operation' = 'PURGE_ORIGINALS'),
    'conferência atropelou a importação em andamento');
  perform pg_temp.originais_assert(exists (select 1 from jsonb_array_elements(v_jobs) as job
    where job ->> 'lesson_session_id' = v_sync::text and job ->> 'operation' = 'SYNC_ARTIFACTS'),
    'fixture: importação pendente deveria estar na fila');
  -- Sem a lixeira autorizada pela conta central (escopo drive): nada de
  -- PURGE_ORIGINALS, nem a conferência (ela só existe para alimentar a lixeira).
  update private.google_workspace_connections set granted_scopes = array_remove(granted_scopes, v_drive)
   where tenant_id = v_tenant;
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.originais_assert(not exists (select 1 from jsonb_array_elements(v_jobs) as job
    where job ->> 'operation' = 'PURGE_ORIGINALS'),
    'lixeira oferecida sem o escopo drive');
  update private.google_workspace_connections set granted_scopes = granted_scopes || array[v_drive]
   where tenant_id = v_tenant;

  -- 3. Porta da edge: estado, resultado por arquivo, espera e conferência.
  v_result := public.google_meet_originals_backend('session_state', v_tenant, v_old, '{}'::jsonb);
  perform pg_temp.originais_assert(jsonb_array_length(v_result -> 'files_due') = 4
    and (v_result ->> 'discovery_needed')::boolean = false
    and v_result #>> '{room,space_name}' = 'spaces/originaisOld'
    and (v_result ->> 'records_erased')::boolean = false, 'estado da aula errado: ' || v_result::text);
  v_result := public.google_meet_originals_backend('file_result', v_tenant, v_old,
    '{"file_id":"docOldTranscript","result":"TRASHED"}'::jsonb);
  perform pg_temp.originais_assert(v_result ->> 'status' = 'TRASHED'
    and (select finished_at is not null and error_code is null from private.google_meet_drive_originals
      where file_id = 'docOldTranscript'), 'lixeira não registrada');
  v_result := public.google_meet_originals_backend('file_result', v_tenant, v_old,
    '{"file_id":"docOldNotes","result":"GONE","error_code":"google_drive_file_not_found"}'::jsonb);
  perform pg_temp.originais_assert(v_result ->> 'status' = 'GONE', '404 não conta como já apagado');
  v_result := public.google_meet_originals_backend('file_result', v_tenant, v_old,
    '{"file_id":"sheetOld2","result":"REFUSED","error_code":"google_drive_not_owner"}'::jsonb);
  perform pg_temp.originais_assert(v_result ->> 'status' = 'REFUSED', 'arquivo de outra conta não ficou recusado');
  v_before := now();
  v_result := public.google_meet_originals_backend('file_result', v_tenant, v_old,
    '{"file_id":"sheetOld1","result":"FAILED","error_code":"google_permission_or_edition_required"}'::jsonb);
  perform pg_temp.originais_assert(v_result ->> 'status' = 'PENDING' and (v_result ->> 'attempts')::integer = 1
    and (v_result ->> 'next_attempt_at')::timestamptz between v_before + interval '59 minutes' and v_before + interval '61 minutes'
    and v_result ->> 'error_code' = 'google_permission_or_edition_required', 'falha sem nova tentativa em 1 h: ' || v_result::text);
  perform pg_temp.originais_assert(jsonb_array_length(public.google_meet_originals_backend('session_state', v_tenant, v_old,
    '{}'::jsonb) -> 'files_due') = 0, 'falha voltou antes da espera');
  update private.google_meet_drive_originals set next_attempt_at = now() - interval '1 second' where file_id = 'sheetOld1';
  v_result := public.google_meet_originals_backend('file_result', v_tenant, v_old,
    '{"file_id":"sheetOld1","result":"FAILED"}'::jsonb);
  perform pg_temp.originais_assert((v_result ->> 'attempts')::integer = 2
    and (v_result ->> 'next_attempt_at')::timestamptz > now() + interval '119 minutes'
    and v_result ->> 'error_code' = 'google_drive_trash_failed', 'espera não dobrou: ' || v_result::text);
  v_error := pg_temp.originais_error(format($sql$select public.google_meet_originals_backend('file_result', %L, %L,
    '{"file_id":"docOldTranscript","result":"TRASHED"}'::jsonb)$sql$, v_tenant, v_old));
  perform pg_temp.originais_assert(v_error = 'google_original_not_found', 'arquivo já resolvido aceitou outro resultado');
  v_error := pg_temp.originais_error(format($sql$select public.google_meet_originals_backend('file_result', %L, %L,
    '{"file_id":"docOldNotes","result":"DELETED"}'::jsonb)$sql$, v_tenant, v_old));
  perform pg_temp.originais_assert(v_error = 'invalid_original_result', 'resultado inventado aceito');

  v_result := public.google_meet_originals_backend('discovery_failed', v_tenant, v_recent,
    '{"error_code":"google_documents_still_generating"}'::jsonb);
  perform pg_temp.originais_assert(not private.google_meet_original_discovery_due(v_recent)
    and (select discovery_attempts = 1 and discovery_next_attempt_at > now() + interval '59 minutes'
      from private.google_meet_original_sessions where lesson_session_id = v_recent),
    'conferência que falhou voltou antes da espera');
  v_result := public.google_meet_originals_backend('register', v_tenant, v_blocked, jsonb_build_object(
    'organizer_sub', 'sub-central', 'discovered', true, 'files', '[]'::jsonb));
  perform pg_temp.originais_assert(not private.google_meet_original_discovery_due(v_blocked),
    'lista conferida continua pedindo conferência');

  -- 4. Exclusão a pedido do aluno. Dados de v_student (a apagar) e de
  --    v_other_student (fica).
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, expires_at) values
    (v_tenant, v_recent, 'conferenceRecords/o1/transcripts/t1', 'TRANSCRIPT', 'docRecentT',
      encode(sha256('recent-t'::bytea), 'hex'), '[10:00:01] Prof: turn left.', now() + interval '80 days')
  returning id into v_revision;
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
    content_sha256, source_text, expires_at) values
    (v_tenant, v_live, 'conferenceRecords/o2/transcripts/t1', 'TRANSCRIPT', 'docLiveT',
      encode(sha256('live-t'::bytea), 'hex'), '[10:00:01] Prof: hello.', now() + interval '80 days')
  returning id into v_other_revision;
  insert into private.google_meet_artifact_imports (lesson_session_id, tenant_id, provider_name, kind, status, revision_id)
  values (v_recent, v_tenant, 'conferenceRecords/o1/transcripts/t1', 'TRANSCRIPT', 'IMPORTED', v_revision);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content,
    source_artifact_ids) values
    (v_tenant, v_recent, 1, 'PROPOSED', 'GEMINI_API', '{"narrative":"Aula de direções."}'::jsonb, array[v_revision])
  returning id into v_version;
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, parent_version_id, status, origin,
    content, source_artifact_ids) values
    (v_tenant, v_recent, 2, v_version, 'VERIFIED', 'HUMAN_REVIEW', '{"lesson_objective":"Direções"}'::jsonb, array[v_revision]);
  insert into public.student_learning_memories (tenant_id, student_id, source_type, source_ref, lesson_objective) values
    (v_tenant, v_student, 'MEET_SESSION', v_recent::text, 'Direções'),
    (v_tenant, v_student, 'MEET_SESSION', v_old::text, 'Apresentação'),
    (v_tenant, v_student, 'CLASS_LOG', 'log-fixture', 'Relato do professor'),
    (v_tenant, v_other_student, 'MEET_SESSION', v_live::text, 'Outro aluno');
  insert into public.student_learning_cards (tenant_id, student_id, real_goal, engaging_topics)
  values (v_tenant, v_student, 'Viajar para Londres', array['viagem']);

  -- Só a direção DA ESCOLA do aluno.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_coord, 'role', 'authenticated')::text, true);
  v_error := pg_temp.originais_error(format('select public.erase_student_lesson_records(%L)', v_student));
  perform pg_temp.originais_assert(v_error = 'sem_permissao', 'coordenação apagou registros: ' || v_error);
  v_error := pg_temp.originais_error(format('select public.get_student_lesson_records_erasure_preview(%L)', v_student));
  perform pg_temp.originais_assert(v_error = 'sem_permissao', 'coordenação viu a prévia: ' || v_error);
  v_error := pg_temp.originais_error('select public.get_meet_originals_retention_status()');
  perform pg_temp.originais_assert(v_error = 'sem_permissao', 'coordenação viu a lixeira: ' || v_error);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_error := pg_temp.originais_error(format('select public.erase_student_lesson_records(%L)', v_student));
  perform pg_temp.originais_assert(v_error = 'sem_permissao', 'professor apagou registros: ' || v_error);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_other_admin, 'role', 'authenticated')::text, true);
  v_error := pg_temp.originais_error(format('select public.erase_student_lesson_records(%L)', v_student));
  perform pg_temp.originais_assert(v_error = 'aluno_nao_encontrado', 'outra escola apagou registros: ' || v_error);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_error := pg_temp.originais_error(format('select public.erase_student_lesson_records(%L)', v_teacher));
  perform pg_temp.originais_assert(v_error = 'aluno_nao_encontrado', 'apagou registros de quem não é aluno: ' || v_error);

  v_result := public.get_student_lesson_records_erasure_preview(v_student);
  perform pg_temp.originais_assert((v_result ->> 'ok')::boolean
    and (v_result ->> 'sessions')::integer = 3            -- old, recent, sync (a de amanhã não)
    and (v_result ->> 'raw_copies')::integer = 1
    and (v_result ->> 'attendance_reports')::integer = 1
    and (v_result ->> 'drafts')::integer = 1
    and (v_result ->> 'approved_summaries')::integer = 1
    and (v_result ->> 'memories')::integer = 2
    and (v_result ->> 'card')::boolean
    and (v_result ->> 'originals_pending')::integer = 2   -- sheetOld1 (falhou) e docRecentT
    and (v_result ->> 'originals_done')::integer = 2
    and (v_result ->> 'rooms_to_discover')::integer = 2   -- recent e sync
    and (v_result ->> 'rooms_beyond_window')::integer = 0
    and (v_result ->> 'drive_delete_ready')::boolean,
    'prévia errada: ' || v_result::text);

  v_erased_at := now();
  v_result := public.erase_student_lesson_records(v_student);
  perform pg_temp.originais_assert((v_result ->> 'sessions')::integer = 3
    and (v_result ->> 'raw_copies_deleted')::integer = 1
    and (v_result ->> 'attendance_reports_deleted')::integer = 1
    and (v_result ->> 'summary_versions_deleted')::integer = 2
    and (v_result ->> 'memories_deleted')::integer = 2
    and (v_result ->> 'card_deleted')::boolean
    and (v_result ->> 'originals_queued')::integer = 2
    and (v_result ->> 'sessions_to_discover')::integer = 2, 'exclusão com contagem errada: ' || v_result::text);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  perform pg_temp.originais_assert(
    not exists (select 1 from private.meeting_artifact_revisions where id = v_revision)
    and exists (select 1 from private.meeting_artifact_revisions where id = v_other_revision)
    and not exists (select 1 from private.google_meet_artifact_imports where lesson_session_id = v_recent)
    and not exists (select 1 from private.meeting_attendance_reports where lesson_session_id = v_old)
    and not exists (select 1 from private.lesson_summary_versions where lesson_session_id = v_recent),
    'cópias brutas, planilha ou rascunhos ficaram (ou o outro aluno perdeu dados)');
  perform pg_temp.originais_assert(
    not exists (select 1 from public.student_learning_memories where student_id = v_student and source_type = 'MEET_SESSION')
    and exists (select 1 from public.student_learning_memories where student_id = v_student and source_type = 'CLASS_LOG')
    and exists (select 1 from public.student_learning_memories where student_id = v_other_student and source_type = 'MEET_SESSION'),
    'memória errada apagada');
  perform pg_temp.originais_assert(
    not exists (select 1 from public.student_learning_cards where student_id = v_student)
    and exists (select 1 from private.student_learning_card_events where student_id = v_student
      and actor_role = 'DIRECTION_ERASURE' and actor_id = v_admin),
    'cartão não apagado ou sem histórico da remoção');
  perform pg_temp.originais_assert(
    (select bool_and(trash_due_at <= now() and next_attempt_at is null) from private.google_meet_drive_originals
      where file_id in ('docRecentT', 'sheetOld1')),
    'originais do aluno não venceram na hora');
  -- A importação da aula apagada acabou (sai da fila); a sala sem importação
  -- aberta não muda de estado.
  perform pg_temp.originais_assert(
    (select sync_status = 'EXPIRED' and next_sync_at is null and last_error_code = 'lesson_records_erased'
      from private.google_meet_rooms where lesson_session_id = v_sync)
    and (select sync_status = 'COMPLETE' from private.google_meet_rooms where lesson_session_id = v_old)
    and (select sync_status = 'PENDING' from private.google_meet_rooms where lesson_session_id = v_live),
    'importação da aula apagada continua aberta (ou mexeu na sala de outro aluno)');
  perform pg_temp.originais_assert(
    (select count(*) from private.google_meet_original_sessions where records_erased_at is not null
      and lesson_session_id in (v_old, v_recent, v_sync)) = 3
    and not exists (select 1 from private.google_meet_original_sessions where lesson_session_id in (v_future, v_live)
      and records_erased_at is not null),
    'aulas marcadas erradas (a de amanhã ou a do outro aluno)');
  perform pg_temp.originais_assert(
    (select sessions = 3 and raw_copies_deleted = 1 and summary_versions_deleted = 2 and memories_deleted = 2
      and card_deleted and requested_by = v_admin from private.student_lesson_record_erasures where student_id = v_student)
    and exists (select 1 from private.google_meet_access_events where tenant_id = v_tenant and actor_id = v_admin
      and action = 'STUDENT_LESSON_RECORDS_ERASED'),
    'trilha do pedido faltando');
  -- A trilha não guarda conteúdo: nenhuma coluna de texto livre (tenant_id é o
  -- slug da escola).
  perform pg_temp.originais_assert(not exists (select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'student_lesson_record_erasures'
      and column_name <> 'tenant_id' and data_type in ('text', 'jsonb', 'character varying', 'ARRAY')),
    'trilha da exclusão com coluna de texto');

  -- 5. Aula apagada não volta: importação, planilha e rascunho recusados; aula de
  --    outro aluno segue normal.
  v_error := pg_temp.originais_error(format($sql$insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id,
    provider_name, kind, document_id, content_sha256, source_text, expires_at) values (%L, %L,
    'conferenceRecords/o1/transcripts/t1', 'TRANSCRIPT', 'docRecentT', %L, 'de novo', now() + interval '1 day')$sql$,
    v_tenant, v_recent, encode(sha256('again'::bytea), 'hex')));
  perform pg_temp.originais_assert(v_error = 'lesson_records_erased', 'aula apagada voltou pela importação: ' || v_error);
  v_error := pg_temp.originais_error(format($sql$insert into private.lesson_summary_versions (tenant_id, lesson_session_id,
    version, status, origin, content) values (%L, %L, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES', '{}'::jsonb)$sql$, v_tenant, v_old));
  perform pg_temp.originais_assert(v_error = 'lesson_records_erased', 'aula apagada ganhou rascunho: ' || v_error);
  v_error := pg_temp.originais_error(format($sql$insert into private.meeting_attendance_reports (tenant_id, lesson_session_id,
    document_id, content_sha256, source_csv, expires_at) values (%L, %L, 'sheetSync', %L, 'x', now() + interval '1 day')$sql$,
    v_tenant, v_sync, encode(sha256('sync-csv'::bytea), 'hex')));
  perform pg_temp.originais_assert(v_error = 'lesson_records_erased', 'aula apagada ganhou planilha: ' || v_error);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content)
  values (v_tenant, v_live, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES', '{}'::jsonb);

  -- 6. Fila depois do pedido: importação e resumo da aula apagada saem; a lista
  --    da aula recente é conferida de novo na hora (prioridade do pedido).
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.originais_assert(not exists (select 1 from jsonb_array_elements(v_jobs) as job
    where job ->> 'lesson_session_id' = v_sync::text and job ->> 'operation' in ('SYNC_ARTIFACTS','GENERATE_SUMMARY')),
    'aula apagada continua na importação');
  select value into v_job from jsonb_array_elements(v_jobs)
   where value ->> 'lesson_session_id' = v_recent::text and value ->> 'operation' = 'PURGE_ORIGINALS';
  perform pg_temp.originais_assert(v_job is not null and (v_job ->> 'priority_group')::integer = 3,
    'pedido de exclusão não passou à frente: ' || coalesce(v_jobs::text, 'null'));
  v_result := public.google_meet_originals_backend('session_state', v_tenant, v_recent, '{}'::jsonb);
  perform pg_temp.originais_assert((v_result ->> 'discovery_needed')::boolean and (v_result ->> 'records_erased')::boolean
    and jsonb_array_length(v_result -> 'files_due') = 1, 'estado da aula apagada errado: ' || v_result::text);
  -- Documento achado agora na conferência vence na hora (pedido já feito).
  v_result := public.google_meet_originals_backend('register', v_tenant, v_recent, jsonb_build_object(
    'organizer_sub', 'sub-central', 'discovered', true,
    'files', jsonb_build_array(jsonb_build_object('file_id', 'docRecentNotes', 'kind', 'SMART_NOTES'))));
  perform pg_temp.originais_assert(jsonb_array_length(v_result -> 'files_due') = 2
    and (select trash_due_at <= v_erased_at + interval '1 second' from private.google_meet_drive_originals
      where file_id = 'docRecentNotes'), 'documento achado depois do pedido não venceu na hora');
  -- Lixeira desligada nesta instalação: espera 6 h sem gastar tentativa.
  v_before := now();
  v_result := public.google_meet_originals_backend('defer', v_tenant, v_recent,
    '{"error_code":"google_drive_delete_disabled","minutes":360}'::jsonb);
  perform pg_temp.originais_assert((v_result ->> 'deferred')::integer = 2
    and (select bool_and(attempts = 0 and error_code = 'google_drive_delete_disabled'
      and next_attempt_at between v_before + interval '359 minutes' and v_before + interval '361 minutes')
      from private.google_meet_drive_originals where file_id in ('docRecentT', 'docRecentNotes')),
    'espera da lixeira desligada errada');

  -- 7. Situação para a direção.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.get_meet_originals_retention_status();
  perform pg_temp.originais_assert((v_result ->> 'trashed')::integer = 1 and (v_result ->> 'gone')::integer = 1
    and (v_result ->> 'refused')::integer = 1 and (v_result ->> 'due')::integer = 3
    and (v_result ->> 'failing')::integer = 1 and (v_result ->> 'other_account')::integer = 0
    and (v_result ->> 'drive_delete_ready')::boolean and (v_result ->> 'erasures')::integer = 1
    and v_result ->> 'last_error_code' is not null, 'situação da lixeira errada: ' || v_result::text);
  -- Segundo pedido: nada mais a apagar, a trilha ganha outra linha.
  v_result := public.erase_student_lesson_records(v_student);
  perform pg_temp.originais_assert((v_result ->> 'raw_copies_deleted')::integer = 0
    and not (v_result ->> 'card_deleted')::boolean
    and (select count(*) from private.student_lesson_record_erasures where student_id = v_student) = 2,
    'segundo pedido errado: ' || v_result::text);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$test$;

rollback;
