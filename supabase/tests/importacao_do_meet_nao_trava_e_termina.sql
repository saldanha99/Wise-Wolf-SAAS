-- Núcleo do Meet, parte 1 (migration 20260926170000): a importação não trava e
-- termina. Reprova contra o código anterior: FAILED nem existia, room_save gravava
-- link sem reserva, a fila nunca acabava, get_my_lesson_rooms tirava o link de
-- sempre de aula com sala que não ia sair, e "fora da sala" disparava no mesmo dia.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.fila_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'importação do Meet: %', p_message;
  end if;
end;
$$;

do $privileges$
begin
  perform pg_temp.fila_assert(
    not has_table_privilege('authenticated', 'private.google_meet_artifact_imports', 'SELECT')
    and not has_table_privilege('anon', 'private.google_meet_artifact_imports', 'SELECT'),
    'situação dos documentos legível pelo navegador'
  );
  perform pg_temp.fila_assert(
    not has_function_privilege('authenticated', 'public.google_meet_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_pending_google_meet_sync_sessions()', 'EXECUTE'),
    'porta do servidor aberta ao navegador'
  );
end
$privileges$;

do $test$
declare
  v_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_soon uuid := gen_random_uuid();        -- aula daqui a 1 h (sala urgente)
  v_far uuid := gen_random_uuid();         -- aula daqui a 10 h
  v_imminent uuid := gen_random_uuid();    -- aula daqui a 10 min, sem sala
  v_first uuid := gen_random_uuid();       -- acabou há 20 min, nunca importada
  v_repoll uuid := gen_random_uuid();      -- já importada, voltando
  v_done uuid := gen_random_uuid();        -- importação concluída
  v_old uuid := gen_random_uuid();         -- acabou há 8 dias
  v_closing uuid := gen_random_uuid();     -- acabou há 6 dias e 22 h
  v_today_room uuid := gen_random_uuid();  -- aula de hoje sem sala usada
  v_yesterday uuid := gen_random_uuid();   -- aula de ontem sem sala usada
  v_moved uuid := gen_random_uuid();       -- professor entrou depois do fim previsto
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_claim text;
  v_old_claim text;
  v_blocked boolean;
  v_jobs jsonb;
  v_revision uuid;
  v_foreign_revision uuid;
  v_room private.google_meet_rooms;
  v_pos_first integer;
  v_pos_repoll integer;
  v_pos_soon integer;
  v_attempt integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name) values ('meet-fila-fixture', 'Fila do Meet fixture');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'fila-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'fila-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student, 'fila-student@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'meet-fila-fixture', lifecycle_status = 'active', is_test_account = true,
         role = case when id = v_admin then 'SCHOOL_ADMIN' when id = v_teacher then 'TEACHER' else 'STUDENT' end
   where id in (v_admin, v_teacher, v_student);
  update public.profiles set professor_id = v_teacher where id = v_student;
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id in (v_admin, v_teacher, v_student)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  -- Conta Google confirmada pelo professor (20260926180000): sem ela não há sala.
  insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
  values (v_teacher, 'meet-fila-fixture', 'fila-teacher-sub', 'prof@example.invalid', true);

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key, documentation_consent) values
    (v_soon, 'meet-fila-fixture', v_student, v_teacher, v_today, now() + interval '1 hour', now() + interval '90 minutes', 'fila-soon', true),
    (v_far, 'meet-fila-fixture', v_student, v_teacher, v_today, now() + interval '10 hours', now() + interval '630 minutes', 'fila-far', true),
    (v_imminent, 'meet-fila-fixture', v_student, v_teacher, v_today, now() + interval '10 minutes', now() + interval '40 minutes', 'fila-imminent', true),
    (v_first, 'meet-fila-fixture', v_student, v_teacher, v_today, now() - interval '50 minutes', now() - interval '20 minutes', 'fila-first', true),
    (v_repoll, 'meet-fila-fixture', v_student, v_teacher, v_today, now() - interval '4 hours', now() - interval '210 minutes', 'fila-repoll', true),
    (v_done, 'meet-fila-fixture', v_student, v_teacher, v_today, now() - interval '5 hours', now() - interval '270 minutes', 'fila-done', true),
    (v_old, 'meet-fila-fixture', v_student, v_teacher, v_today - 8, now() - interval '8 days', now() - interval '8 days' + interval '30 minutes', 'fila-old', true),
    (v_closing, 'meet-fila-fixture', v_student, v_teacher, v_today - 7, now() - interval '167 hours', now() - interval '166 hours', 'fila-closing', true),
    (v_today_room, 'meet-fila-fixture', v_student, v_teacher, v_today, now() - interval '3 hours', now() - interval '150 minutes', 'fila-today-room', true),
    (v_yesterday, 'meet-fila-fixture', v_student, v_teacher, v_today - 1, now() - interval '30 hours', now() - interval '1770 minutes', 'fila-yesterday', true),
    (v_moved, 'meet-fila-fixture', v_student, v_teacher, v_today - 1, now() - interval '28 hours', now() - interval '1650 minutes', 'fila-moved', true);

  perform public.google_meet_backend('connection_save', 'meet-fila-fixture', v_admin, null, jsonb_build_object(
    'organizer_sub', 'fila-sub', 'organizer_email', 'escola@example.invalid',
    'refresh_token_ciphertext', 'synthetic-protected-token', 'granted_scopes', jsonb_build_array('fixture')));

  -- ===== Sala recusada vira FAILED e tenta de novo sozinha, com espera crescente =====
  v_result := public.google_meet_backend('room_claim', 'meet-fila-fixture', v_admin, v_soon,
    jsonb_build_object('organizer_sub', 'fila-sub', 'cohost_email', 'prof@example.invalid', 'automatic', true));
  perform pg_temp.fila_assert((v_result ->> 'claimed')::boolean and (v_result -> 'room' ->> 'creation_attempts')::int = 1,
    'primeira reserva não registrou a tentativa');
  v_claim := v_result -> 'room' ->> 'claim_id';
  v_blocked := false;
  begin
    perform public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_soon,
      jsonb_build_object('state', 'FAILED', 'claim_id', gen_random_uuid(), 'error_code', 'google_permission_or_edition_required'));
  exception when object_not_in_prerequisite_state then v_blocked := true; end;
  perform pg_temp.fila_assert(v_blocked, 'reserva alheia marcou a sala como falha');
  v_result := public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_soon,
    jsonb_build_object('state', 'FAILED', 'claim_id', v_claim, 'error_code', 'google_permission_or_edition_required'));
  perform pg_temp.fila_assert(v_result ->> 'state' = 'FAILED'
    and (v_result ->> 'next_attempt_at')::timestamptz between now() + interval '29 minutes' and now() + interval '31 minutes'
    and not (v_result ? 'claim_id'),
    'primeira falha não agendou nova tentativa em 30 min');
  v_result := public.google_meet_backend('room_claim', 'meet-fila-fixture', v_admin, v_soon,
    jsonb_build_object('organizer_sub', 'fila-sub', 'cohost_email', 'prof@example.invalid', 'automatic', true));
  perform pg_temp.fila_assert(not (v_result ->> 'claimed')::boolean, 'rodada automática tentou antes da espera');
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'lesson_session_id' = v_soon::text),
    'sala com espera em curso voltou para a fila');
  update private.google_meet_rooms set next_attempt_at = now() - interval '1 minute' where lesson_session_id = v_soon;
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.fila_assert(exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'lesson_session_id' = v_soon::text and j ->> 'operation' = 'PREPARE_ROOM' and (j ->> 'priority_group')::int = 0),
    'sala FAILED vencida não voltou para a fila como urgente');
  v_old_claim := v_claim;
  v_result := public.google_meet_backend('room_claim', 'meet-fila-fixture', v_admin, v_soon,
    jsonb_build_object('organizer_sub', 'fila-sub', 'cohost_email', 'prof@example.invalid', 'automatic', true));
  v_claim := v_result -> 'room' ->> 'claim_id';
  perform pg_temp.fila_assert((v_result ->> 'claimed')::boolean and (v_result -> 'room' ->> 'creation_attempts')::int = 2
    and v_claim is distinct from v_old_claim, 'nova tentativa não trocou a reserva');
  v_blocked := false;
  begin
    perform public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_soon,
      jsonb_build_object('state', 'COHOST_PENDING', 'claim_id', v_old_claim,
        'space_name', 'spaces/filaorphan', 'meeting_uri', 'https://meet.google.com/aaa-bbbb-ccc'));
  exception when object_not_in_prerequisite_state then v_blocked := true; end;
  perform pg_temp.fila_assert(v_blocked, 'worker atrasado gravou link com reserva vencida');
  v_result := public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_soon,
    jsonb_build_object('state', 'FAILED', 'claim_id', v_claim, 'error_code', 'google_room_creation_uncertain'));
  perform pg_temp.fila_assert((v_result ->> 'next_attempt_at')::timestamptz between now() + interval '119 minutes' and now() + interval '121 minutes',
    'segunda falha não esperou 2 h');
  -- Clique manual não espera; na 5ª falha a rodada automática desiste.
  for v_attempt in 3..5 loop
    v_result := public.google_meet_backend('room_claim', 'meet-fila-fixture', v_teacher, v_soon,
      jsonb_build_object('organizer_sub', 'fila-sub', 'cohost_email', 'prof@example.invalid'));
    perform pg_temp.fila_assert((v_result ->> 'claimed')::boolean, 'clique manual não tentou na hora');
    v_result := public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_soon,
      jsonb_build_object('state', 'FAILED', 'claim_id', v_result -> 'room' ->> 'claim_id', 'error_code', 'google_room_creation_uncertain'));
    if v_attempt < 5 then
      perform pg_temp.fila_assert((v_result ->> 'next_attempt_at')::timestamptz between now() + interval '359 minutes' and now() + interval '361 minutes',
        'terceira/quarta falha não esperou 6 h');
    end if;
  end loop;
  perform pg_temp.fila_assert(v_result ->> 'next_attempt_at' is null and (v_result ->> 'creation_attempts')::int = 5,
    'quinta falha ainda agendou tentativa automática');

  -- Sala que falhou não tira o link de sempre.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_student, 'role', 'authenticated')::text, true);
  v_result := public.get_my_lesson_rooms(v_today, v_today);
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(v_result) x where x ->> 'session_id' = v_soon::text),
    'sala FAILED escondeu o link de sempre');
  -- Aula em 10 min sem sala pronta: cai no link de sempre.
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(v_result) x where x ->> 'session_id' = v_imminent::text),
    'aula a 10 min sem sala ficou sem link');
  -- Aula em 10 h com aceite e sem sala: ainda espera a sala da escola.
  perform pg_temp.fila_assert(exists (select 1 from jsonb_array_elements(v_result) x
    where x ->> 'session_id' = v_far::text and x ->> 'meeting_uri' is null),
    'aula distante com aceite abriu a sala pessoal');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ===== Reserva órfã (CREATING há mais de 15 min) é tentada de novo =====
  v_result := public.google_meet_backend('room_claim', 'meet-fila-fixture', v_admin, v_far,
    jsonb_build_object('organizer_sub', 'fila-sub', 'cohost_email', 'prof@example.invalid', 'automatic', true));
  v_old_claim := v_result -> 'room' ->> 'claim_id';
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'lesson_session_id' = v_far::text),
    'criação em andamento foi reservada de novo');
  update private.google_meet_rooms set updated_at = now() - interval '20 minutes' where lesson_session_id = v_far;
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.fila_assert(exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'lesson_session_id' = v_far::text and (j ->> 'priority_group')::int = 2),
    'sala presa em CREATING não voltou para a fila');
  v_result := public.google_meet_backend('room_claim', 'meet-fila-fixture', v_admin, v_far,
    jsonb_build_object('organizer_sub', 'fila-sub', 'cohost_email', 'prof@example.invalid', 'automatic', true));
  v_claim := v_result -> 'room' ->> 'claim_id';
  perform pg_temp.fila_assert((v_result ->> 'claimed')::boolean and v_claim <> v_old_claim, 'reserva órfã não foi retomada');
  v_result := public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_far,
    jsonb_build_object('state', 'COHOST_PENDING', 'claim_id', v_claim,
      'space_name', 'spaces/filafar', 'meeting_uri', 'https://meet.google.com/far-fila-roo'));
  v_result := public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_far, jsonb_build_object('state', 'READY'));
  perform pg_temp.fila_assert(v_result ->> 'state' = 'READY', 'sala retomada não ficou pronta');
  v_blocked := false;
  begin
    perform public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_far,
      jsonb_build_object('state', 'FAILED', 'claim_id', v_claim));
  exception when object_not_in_prerequisite_state then v_blocked := true; end;
  perform pg_temp.fila_assert(v_blocked, 'sala com link salvo voltou para FAILED');
  -- Dois links para a mesma aula: não escolhe sozinho.
  v_result := public.google_meet_backend('room_save', 'meet-fila-fixture', v_admin, v_far,
    jsonb_build_object('state', 'COHOST_PENDING', 'claim_id', v_claim,
      'space_name', 'spaces/filaother', 'meeting_uri', 'https://meet.google.com/oth-fila-roo'));
  perform pg_temp.fila_assert(v_result ->> 'state' = 'NEEDS_RECONCILIATION' and v_result ->> 'space_name' = 'spaces/filafar',
    'segundo link sobrescreveu o primeiro');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_student, 'role', 'authenticated')::text, true);
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(public.get_my_lesson_rooms(v_today, v_today)) x
    where x ->> 'session_id' = v_far::text), 'sala para reconciliar escondeu o link de sempre');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ===== A fila de importação tem prioridade e fim =====
  insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
    cohost_email, state, created_by, last_synced_at, next_sync_at, sync_status) values
    (v_first, 'meet-fila-fixture', 'spaces/filafirst', 'https://meet.google.com/fir-fila-sss', 'fila-sub', 'prof@example.invalid', 'READY', v_admin, null, null, 'WAITING'),
    (v_repoll, 'meet-fila-fixture', 'spaces/filarepoll', 'https://meet.google.com/rep-fila-sss', 'fila-sub', 'prof@example.invalid', 'READY', v_admin, now() - interval '3 hours', now() - interval '1 hour', 'PENDING'),
    (v_done, 'meet-fila-fixture', 'spaces/filadone', 'https://meet.google.com/don-fila-sss', 'fila-sub', 'prof@example.invalid', 'READY', v_admin, now() - interval '4 hours', null, 'COMPLETE'),
    (v_old, 'meet-fila-fixture', 'spaces/filaold', 'https://meet.google.com/old-fila-sss', 'fila-sub', 'prof@example.invalid', 'READY', v_admin, null, null, 'WAITING'),
    (v_closing, 'meet-fila-fixture', 'spaces/filaclosing', 'https://meet.google.com/clo-fila-sss', 'fila-sub', 'prof@example.invalid', 'READY', v_admin, now() - interval '7 hours', now() - interval '1 hour', 'PENDING');
  v_jobs := public.get_pending_google_meet_sync_sessions();
  select min(ord) filter (where j ->> 'lesson_session_id' = v_first::text),
         min(ord) filter (where j ->> 'lesson_session_id' = v_repoll::text),
         min(ord) filter (where j ->> 'lesson_session_id' = v_soon::text)
    into v_pos_first, v_pos_repoll, v_pos_soon
    from jsonb_array_elements(v_jobs) with ordinality as t(j, ord);
  perform pg_temp.fila_assert(v_pos_first is not null and v_pos_repoll is not null and v_pos_first < v_pos_repoll,
    'primeira importação depois da aula não veio antes da re-consulta');
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'lesson_session_id' in (v_done::text, v_old::text)),
    'importação concluída ou fora da janela voltou para a fila');
  -- Sala da aula em 10 min + primeira importação + duas re-consultas: mais de 3.
  perform pg_temp.fila_assert(jsonb_array_length(v_jobs) >= 4, 'lote ainda limitado a 3 trabalhos');
  perform pg_temp.fila_assert(v_pos_soon is null, 'sala com 5 tentativas voltou para a rodada automática');

  perform public.google_meet_backend('sync_complete', 'meet-fila-fixture', v_admin, v_first,
    jsonb_build_object('error_code', 'ARTIFACTS_PENDING', 'complete', false));
  select * into v_room from private.google_meet_rooms where lesson_session_id = v_first;
  perform pg_temp.fila_assert(v_room.sync_status = 'PENDING'
    and v_room.next_sync_at between now() + interval '9 minutes' and now() + interval '11 minutes',
    'importação pendente logo depois da aula não voltou em 10 min');
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_first::text), 'importação voltou antes da hora marcada');
  perform public.google_meet_backend('sync_complete', 'meet-fila-fixture', v_admin, v_repoll,
    jsonb_build_object('error_code', null, 'complete', true));
  select * into v_room from private.google_meet_rooms where lesson_session_id = v_repoll;
  perform pg_temp.fila_assert(v_room.sync_status = 'COMPLETE' and v_room.next_sync_at is null and v_room.sync_completed_at is not null,
    'importação concluída não saiu da fila');
  update private.google_meet_rooms set next_sync_at = now() - interval '1 minute' where lesson_session_id = v_repoll;
  perform pg_temp.fila_assert(not exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_repoll::text), 'sessão concluída voltou para a fila');
  perform public.google_meet_backend('sync_complete', 'meet-fila-fixture', v_admin, v_closing,
    jsonb_build_object('error_code', 'ARTIFACTS_NOT_AVAILABLE', 'complete', false));
  select * into v_room from private.google_meet_rooms where lesson_session_id = v_closing;
  perform pg_temp.fila_assert(v_room.sync_status = 'EXPIRED' and v_room.next_sync_at is null,
    'última consulta da janela não encerrou a importação');

  -- ===== Erro por documento, vazio final, plano B da transcrição =====
  perform public.google_meet_backend('artifact_status', 'meet-fila-fixture', v_admin, v_first, jsonb_build_object(
    'provider_name', 'conferenceRecords/c1/transcripts/t1', 'kind', 'TRANSCRIPT', 'provider_state', 'FILE_GENERATED',
    'status', 'FAILED', 'error_code', 'google_document_permission_required'));
  perform public.google_meet_backend('artifact_status', 'meet-fila-fixture', v_admin, v_first, jsonb_build_object(
    'provider_name', 'conferenceRecords/c1/transcripts/t1', 'kind', 'TRANSCRIPT', 'provider_state', 'FILE_GENERATED',
    'status', 'FAILED', 'error_code', 'google_document_permission_required'));
  v_result := public.google_meet_backend('artifact_save', 'meet-fila-fixture', v_admin, v_first, jsonb_build_object(
    'provider_name', 'conferenceRecords/c1/transcripts/t1', 'kind', 'TRANSCRIPT', 'document_id', 't1',
    'source', 'MEET_ENTRIES', 'content_sha256', repeat('e', 64),
    'source_text', '[10:01:02] Ana: Hello teacher', 'retention_days', 90));
  v_revision := (v_result ->> 'id')::uuid;
  perform pg_temp.fila_assert((select source = 'MEET_ENTRIES' from private.meeting_artifact_revisions where id = v_revision),
    'transcrição pelas falas não ficou marcada como tal');
  v_result := public.google_meet_backend('artifact_status', 'meet-fila-fixture', v_admin, v_first, jsonb_build_object(
    'provider_name', 'conferenceRecords/c1/transcripts/t1', 'kind', 'TRANSCRIPT', 'provider_state', 'FILE_GENERATED',
    'status', 'IMPORTED', 'source', 'MEET_ENTRIES', 'error_code', 'google_document_permission_required',
    'revision_id', v_revision));
  perform pg_temp.fila_assert(v_result ->> 'status' = 'IMPORTED' and (v_result ->> 'failed_attempts')::int = 2
    and v_result ->> 'last_error_code' = 'google_document_permission_required' and v_result ->> 'source' = 'MEET_ENTRIES',
    'situação do documento não guardou falhas, origem e motivo');
  perform public.google_meet_backend('artifact_status', 'meet-fila-fixture', v_admin, v_first, jsonb_build_object(
    'provider_name', 'conferenceRecords/c1/smartNotes/n1', 'kind', 'SMART_NOTES', 'provider_state', 'FILE_GENERATED',
    'status', 'EMPTY', 'source', 'DRIVE_EXPORT'));
  v_result := public.google_meet_backend('session_detail', 'meet-fila-fixture', v_admin, v_first);
  perform pg_temp.fila_assert(jsonb_array_length(v_result -> 'imports') = 2
    and exists (select 1 from jsonb_array_elements(v_result -> 'imports') x where x ->> 'status' = 'EMPTY')
    and not (v_result -> 'room' ? 'claim_id'),
    'tela da sala não mostra a situação de cada documento (ou expõe a reserva)');
  -- Revisão de outra sessão não é aceita como fonte.
  v_result := public.google_meet_backend('artifact_save', 'meet-fila-fixture', v_admin, v_repoll, jsonb_build_object(
    'provider_name', 'conferenceRecords/c9/smartNotes/n9', 'kind', 'SMART_NOTES', 'document_id', 'n9',
    'content_sha256', repeat('f', 64), 'source_text', 'Notas de outra aula', 'retention_days', 90));
  v_foreign_revision := (v_result ->> 'id')::uuid;
  perform pg_temp.fila_assert((select source = 'DRIVE_EXPORT' from private.meeting_artifact_revisions where id = v_foreign_revision),
    'origem padrão do documento não é o Drive');
  v_blocked := false;
  begin
    perform public.google_meet_backend('artifact_status', 'meet-fila-fixture', v_admin, v_first, jsonb_build_object(
      'provider_name', 'conferenceRecords/c1/smartNotes/n1', 'kind', 'SMART_NOTES', 'status', 'IMPORTED',
      'revision_id', v_foreign_revision));
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.fila_assert(v_blocked, 'documento apontou revisão de outra sessão');

  -- ===== Presença: várias planilhas; remarcada por fora não vira caso falso =====
  v_result := public.google_meet_attendance_backend('attendance_save', 'meet-fila-fixture', v_first, jsonb_build_object(
    'document_id', 'sheet_a', 'document_name', 'Relatório de participação em fir-fila-sss (1) + (2)',
    'source_document_ids', jsonb_build_array('sheet_a', 'sheet_b'), 'conference_name', 'conferenceRecords/c1',
    'source_csv', 'csv-a' || chr(10) || chr(10) || 'csv-b', 'content_sha256', repeat('1', 64), 'retention_days', 90,
    'teacher_first_join_at', now() - interval '50 minutes', 'teacher_seconds', 1500,
    'student_first_join_at', now() - interval '48 minutes', 'student_seconds', 1400));
  perform pg_temp.fila_assert((select source_document_ids = array['sheet_a', 'sheet_b']
    from private.meeting_attendance_reports where id = (v_result ->> 'id')::uuid),
    'as planilhas da queda e reentrada não ficaram registradas');
  v_result := public.google_meet_backend('session_detail', 'meet-fila-fixture', v_admin, v_first);
  perform pg_temp.fila_assert((v_result ->> 'attendance_saved_reports')::int = 2,
    'a importação não sabe quantas planilhas já guardou');
  -- Aula de HOJE, lançada, sem conferência na sala: pode ter sido remarcada para
  -- mais tarde no mesmo dia. Ainda não é "fora da sala".
  v_result := private.meet_attendance_evaluate(v_today_room, 'COMPLETED', 0);
  perform pg_temp.fila_assert(not (v_result -> 'opened' ? 'outside-room'),
    'aula de hoje virou "fora da sala" antes de o dia acabar');
  -- O dia acabou: agora sinaliza.
  v_result := private.meet_attendance_evaluate(v_yesterday, 'COMPLETED', 0);
  perform pg_temp.fila_assert(v_result -> 'opened' ? 'outside-room', 'aula de ontem fora da sala não foi sinalizada');
  -- Professor entrou depois do FIM previsto: é outro horário, não atraso.
  perform public.google_meet_attendance_backend('attendance_save', 'meet-fila-fixture', v_moved, jsonb_build_object(
    'document_id', 'sheet_moved', 'document_name', 'moved', 'conference_name', 'conferenceRecords/c2',
    'source_csv', 'csv-moved', 'content_sha256', repeat('2', 64), 'retention_days', 90,
    'teacher_first_join_at', now() - interval '20 hours', 'teacher_seconds', 1800,
    'student_first_join_at', now() - interval '20 hours', 'student_seconds', 1700));
  v_result := private.meet_attendance_evaluate(v_moved, 'COMPLETED', 1);
  perform pg_temp.fila_assert(not (v_result -> 'opened' ? 'late'),
    'aula remarcada por fora virou atraso do professor');
  perform pg_temp.fila_assert(
    (select source_document_ids = array['sheet_moved'] from private.meeting_attendance_reports where lesson_session_id = v_moved),
    'planilha única sem lista de origem');
end
$test$;

rollback;
