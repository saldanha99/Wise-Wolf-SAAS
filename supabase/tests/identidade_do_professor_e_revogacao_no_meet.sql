-- Núcleo do Meet, parte 2 (migration 20260926180000). Reprova contra o código
-- anterior: a sala nascia com o e-mail do cadastro (ou o que o chamador mandasse)
-- como coanfitrião, o professor autorizava o termo sem conta Google confirmada,
-- a revogação não desligava a sala já criada (nem tirava o link do app), outra
-- conta Google substituía a central com salas criadas, qualquer professor do aluno
-- e o suporte liam a transcrição bruta, a coordenação marcava documentação e a
-- marcação manual passava por cima de recusa/revogação.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.p2_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'Meet parte 2: %', p_message;
  end if;
end;
$$;

do $privileges$
begin
  perform pg_temp.p2_assert(
    not has_table_privilege('authenticated', 'private.teacher_google_identities', 'SELECT')
    and not has_table_privilege('anon', 'private.teacher_google_identities', 'SELECT')
    and not has_table_privilege('authenticated', 'private.teacher_google_identities', 'INSERT'),
    'identidade Google do professor legível ou gravável pelo navegador'
  );
  perform pg_temp.p2_assert(
    has_function_privilege('authenticated', 'public.get_my_google_identity()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_my_google_identity()', 'EXECUTE'),
    'get_my_google_identity com permissão errada'
  );
  perform pg_temp.p2_assert(
    (select pg_get_userbyid(proowner) = 'postgres' and prosecdef
       and coalesce(array_to_string(proconfig, ','), '') like '%search_path=%'
     from pg_proc where oid = 'public.get_my_google_identity()'::regprocedure),
    'get_my_google_identity sem dono postgres ou sem search_path'
  );
  perform pg_temp.p2_assert(
    not has_function_privilege('authenticated', 'public.google_meet_backend(text,text,uuid,uuid,jsonb)', 'EXECUTE'),
    'porta do servidor aberta ao navegador'
  );
end
$privileges$;

do $test$
declare
  v_admin uuid := gen_random_uuid();
  v_coord uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();      -- dá as aulas, confirma a conta Google
  v_teacher2 uuid := gen_random_uuid();     -- outro professor do mesmo aluno
  v_noid uuid := gen_random_uuid();         -- professor sem conta Google confirmada
  v_sub_teacher uuid := gen_random_uuid();  -- substituto: dá a aula sem ser do aluno
  v_super uuid := gen_random_uuid();        -- suporte da plataforma
  v_student uuid := gen_random_uuid();
  v_student2 uuid := gen_random_uuid();
  v_student3 uuid := gen_random_uuid();
  v_room_session uuid := gen_random_uuid(); -- aula daqui a 2 h, com sala
  v_noid_session uuid := gen_random_uuid(); -- aula daqui a 2 h do professor sem conta
  v_started uuid := gen_random_uuid();      -- aula que começou há 10 min
  v_past uuid := gen_random_uuid();         -- aula que acabou há 1 h (documentos)
  v_manual uuid := gen_random_uuid();       -- marcada à mão, aluno revoga depois
  v_manual_ok uuid := gen_random_uuid();    -- marcada à mão, aluno sem decisão
  v_sub_session uuid := gen_random_uuid();  -- aula dada pelo substituto
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_jobs jsonb;
  v_claim text;
  v_blocked boolean;
  v_message text;
  v_artifact uuid;
  v_draft uuid;
  v_room private.google_meet_rooms;
  v_changed integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- Textos do termo (a cópia só-estrutura não tem os dados; na produção já existem).
  insert into private.lesson_recording_terms (audience, version, body) values
    ('STUDENT', 'v1', repeat('Termo de registro do aluno fixture. ', 10)),
    ('TEACHER', 'v1', repeat('Termo de registro do professor fixture. ', 10))
  on conflict (audience, version) do nothing;
  insert into public.tenants (id, name) values
    ('meet-p2-fixture', 'Meet parte 2 fixture'), ('meet-p2-platform', 'Plataforma fixture');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'p2-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_coord, 'p2-coord@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'p2-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher2, 'p2-teacher2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_noid, 'p2-noid@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_sub_teacher, 'p2-sub@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_super, 'p2-super@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student, 'p2-student@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student2, 'p2-student2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student3, 'p2-student3@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'meet-p2-fixture', lifecycle_status = 'active', is_test_account = true,
         role = case when id = v_admin then 'SCHOOL_ADMIN' when id = v_coord then 'COORDINATOR'
           when id in (v_teacher, v_teacher2, v_noid, v_sub_teacher) then 'TEACHER' else 'STUDENT' end,
         full_name = case when id = v_admin then 'Direcao Fixture' when id = v_coord then 'Coordenacao Fixture'
           when id = v_teacher then 'Professora Fixture' when id = v_teacher2 then 'Professor Dois Fixture'
           when id = v_noid then 'Professor Sem Conta' when id = v_sub_teacher then 'Substituta Fixture'
           else 'Aluno Fixture' end
   where id in (v_admin, v_coord, v_teacher, v_teacher2, v_noid, v_sub_teacher, v_student, v_student2, v_student3);
  update public.profiles set tenant_id = 'meet-p2-platform', lifecycle_status = 'active', is_test_account = true,
    role = 'SUPER_ADMIN', full_name = 'Suporte Fixture' where id = v_super;
  update public.profiles set professor_id = v_teacher, professor_id2 = v_teacher2 where id = v_student;
  update public.profiles set professor_id = v_noid where id = v_student2;
  update public.profiles set professor_id = v_teacher where id = v_student3;
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles
     where id in (v_admin, v_coord, v_teacher, v_teacher2, v_noid, v_sub_teacher, v_student, v_student2, v_student3)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key, documentation_consent) values
    (v_room_session, 'meet-p2-fixture', v_student, v_teacher, v_today, now() + interval '2 hours', now() + interval '150 minutes', 'p2-room', true),
    (v_noid_session, 'meet-p2-fixture', v_student2, v_noid, v_today, now() + interval '2 hours', now() + interval '150 minutes', 'p2-noid', true),
    (v_started, 'meet-p2-fixture', v_student, v_teacher, v_today, now() - interval '10 minutes', now() + interval '20 minutes', 'p2-started', true),
    (v_past, 'meet-p2-fixture', v_student, v_teacher, v_today, now() - interval '90 minutes', now() - interval '1 hour', 'p2-past', true),
    (v_manual, 'meet-p2-fixture', v_student3, v_teacher, v_today, now() + interval '5 hours', now() + interval '330 minutes', 'p2-manual', false),
    (v_manual_ok, 'meet-p2-fixture', v_student, v_teacher, v_today, now() + interval '6 hours', now() + interval '390 minutes', 'p2-manual-ok', false),
    (v_sub_session, 'meet-p2-fixture', v_student, v_sub_teacher, v_today, now() - interval '3 hours', now() - interval '150 minutes', 'p2-sub', true);

  perform public.google_meet_backend('connection_save', 'meet-p2-fixture', v_admin, null, jsonb_build_object(
    'organizer_sub', 'p2-sub-central', 'organizer_email', 'escola@example.com',
    'refresh_token_ciphertext', 'synthetic-protected-token', 'granted_scopes', jsonb_build_array('fixture')));

  -- ===== 1. Identidade Google confirmada pelo PRÓPRIO professor ===============
  v_blocked := false;
  begin
    perform public.google_meet_backend('identity_nonce_create', 'meet-p2-fixture', v_admin, null,
      jsonb_build_object('state_hash', repeat('1', 64), 'verifier_ciphertext', 'synthetic'));
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'direção abriu o login de identidade de professor');
  perform public.google_meet_backend('identity_nonce_create', 'meet-p2-fixture', v_teacher, null,
    jsonb_build_object('state_hash', repeat('2', 64), 'verifier_ciphertext', 'synthetic'));
  v_result := public.google_meet_backend('nonce_consume', null, null, null, jsonb_build_object('state_hash', repeat('2', 64)));
  perform pg_temp.p2_assert(v_result ->> 'flow' = 'teacher_identity' and v_result ->> 'actor_id' = v_teacher::text
    and not (v_result ->> 'allow_replace')::boolean, 'nonce do professor sem o fluxo de identidade');
  perform public.google_meet_backend('nonce_create', 'meet-p2-fixture', v_admin, null,
    jsonb_build_object('state_hash', repeat('3', 64), 'verifier_ciphertext', 'synthetic', 'allow_replace', true));
  v_result := public.google_meet_backend('nonce_consume', null, null, null, jsonb_build_object('state_hash', repeat('3', 64)));
  perform pg_temp.p2_assert(v_result ->> 'flow' = 'organizer' and (v_result ->> 'allow_replace')::boolean,
    'pedido de troca de conta não ficou no nonce');
  v_blocked := false;
  begin
    perform public.google_meet_backend('nonce_create', 'meet-p2-fixture', v_teacher, null,
      jsonb_build_object('state_hash', repeat('4', 64), 'verifier_ciphertext', 'synthetic'));
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'professor abriu o login da conta central');

  v_blocked := false;
  begin
    perform public.google_meet_backend('identity_save', 'meet-p2-fixture', v_admin, null,
      jsonb_build_object('google_sub', '1001', 'google_email', 'direcao@example.com', 'email_verified', true));
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'identidade de professor gravada pela direção');
  v_blocked := false;
  begin
    perform public.google_meet_backend('identity_save', 'meet-p2-fixture', v_teacher, null,
      jsonb_build_object('google_sub', '1002', 'google_email', 'prof@example.com', 'email_verified', false));
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'conta com e-mail não verificado aceita');
  v_result := public.google_meet_backend('identity_save', 'meet-p2-fixture', v_teacher, null,
    jsonb_build_object('google_sub', '1002', 'google_email', 'Prof.Pessoal@Example.com', 'email_verified', true));
  perform pg_temp.p2_assert(v_result ->> 'email' = 'prof.pessoal@example.com' and v_result ->> 'verified_at' is not null,
    'identidade confirmada não gravada (ou sem normalizar o e-mail)');
  v_blocked := false;
  begin
    perform public.google_meet_backend('identity_save', 'meet-p2-fixture', v_noid, null,
      jsonb_build_object('google_sub', '1002', 'google_email', 'prof.pessoal@example.com', 'email_verified', true));
  exception when unique_violation then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'mesma conta Google confirmada para dois professores ativos');
  perform public.google_meet_backend('identity_save', 'meet-p2-fixture', v_sub_teacher, null,
    jsonb_build_object('google_sub', '1003', 'google_email', 'substituta@example.com', 'email_verified', true));

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_result := public.get_my_google_identity();
  perform pg_temp.p2_assert(v_result ->> 'email' = 'prof.pessoal@example.com' and v_result ? 'verified_at'
    and not (v_result ? 'google_sub'), 'get_my_google_identity não devolve só e-mail e data');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_noid, 'role', 'authenticated')::text, true);
  perform pg_temp.p2_assert(public.get_my_google_identity() is null, 'professor sem conta recebeu identidade');

  -- ===== 2. Aceite do termo pelo professor exige a conta confirmada ===========
  v_blocked := false;
  begin perform public.set_my_lesson_recording_consent(true);
  exception when others then v_message := sqlerrm; v_blocked := v_message = 'teacher_google_identity_required'; end;
  perform pg_temp.p2_assert(v_blocked, 'professor autorizou o termo sem conta Google confirmada');
  perform pg_temp.p2_assert(public.set_my_lesson_recording_consent(false) ->> 'decision' = 'REFUSED',
    'recusar exigiu conta Google');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  perform pg_temp.p2_assert(public.set_my_lesson_recording_consent(true) ->> 'decision' = 'ACCEPTED',
    'professor com conta confirmada não conseguiu autorizar');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ===== 3. Sala: coanfitrião é a conta confirmada; sem ela, não há sala =======
  v_blocked := false;
  begin
    perform public.google_meet_backend('room_claim', 'meet-p2-fixture', v_admin, v_noid_session,
      jsonb_build_object('organizer_sub', 'p2-sub-central', 'cohost_email', 'cadastro@example.com'));
  exception when insufficient_privilege then v_message := sqlerrm; v_blocked := v_message = 'google_teacher_identity_required'; end;
  perform pg_temp.p2_assert(v_blocked, 'sala criada para professor sem conta Google confirmada');
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.p2_assert(not exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'lesson_session_id' = v_noid_session::text), 'sala impossível entrou na fila');
  perform pg_temp.p2_assert(exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'lesson_session_id' = v_room_session::text and j ->> 'operation' = 'PREPARE_ROOM'),
    'sala do professor com conta confirmada fora da fila');
  -- Sem sala possível, o app usa o link de sempre (antes: link nulo até 15 min antes).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_student2, 'role', 'authenticated')::text, true);
  perform pg_temp.p2_assert(not exists (select 1 from jsonb_array_elements(public.get_my_lesson_rooms(v_today, v_today)) x
    where x ->> 'session_id' = v_noid_session::text), 'aula sem sala possível segurou o link de sempre');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_result := public.google_meet_backend('room_claim', 'meet-p2-fixture', v_admin, v_room_session,
    jsonb_build_object('organizer_sub', 'p2-sub-central', 'cohost_email', 'atacante@example.com'));
  v_claim := v_result -> 'room' ->> 'claim_id';
  perform pg_temp.p2_assert((v_result ->> 'claimed')::boolean and v_result -> 'room' ->> 'cohost_email' = 'prof.pessoal@example.com',
    'coanfitrião não veio da conta confirmada pelo professor');
  perform public.google_meet_backend('room_save', 'meet-p2-fixture', v_admin, v_room_session, jsonb_build_object(
    'state', 'COHOST_PENDING', 'claim_id', v_claim, 'space_name', 'spaces/p2room', 'meeting_uri', 'https://meet.google.com/pdo-isal-aaa'));
  v_result := public.google_meet_backend('room_save', 'meet-p2-fixture', v_admin, v_room_session, jsonb_build_object('state', 'READY'));
  perform pg_temp.p2_assert(v_result ->> 'artifacts_state' = 'ENABLED', 'sala nasceu sem a documentação ligada');

  -- O professor confirma OUTRA conta: a sala pronta volta para configurar o novo coanfitrião.
  perform public.google_meet_backend('identity_save', 'meet-p2-fixture', v_teacher, null,
    jsonb_build_object('google_sub', '1004', 'google_email', 'prof.nova@example.com', 'email_verified', true));
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.p2_assert(exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'lesson_session_id' = v_room_session::text and j ->> 'operation' = 'PREPARE_ROOM'),
    'sala com coanfitrião antigo não voltou para a fila');
  v_result := public.google_meet_backend('room_claim', 'meet-p2-fixture', v_admin, v_room_session,
    jsonb_build_object('organizer_sub', 'p2-sub-central', 'automatic', true));
  perform pg_temp.p2_assert(not (v_result ->> 'claimed')::boolean and v_result -> 'room' ->> 'state' = 'COHOST_PENDING'
    and v_result -> 'room' ->> 'cohost_email' = 'prof.nova@example.com' and v_result -> 'room' ->> 'space_name' = 'spaces/p2room',
    'troca de conta do professor não atualizou o coanfitrião da sala');
  perform public.google_meet_backend('room_save', 'meet-p2-fixture', v_admin, v_room_session, jsonb_build_object('state', 'READY'));

  -- ===== 4. Revogação desliga a documentação da sala já criada ================
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_student, 'role', 'authenticated')::text, true);
  perform pg_temp.p2_assert(exists (select 1 from jsonb_array_elements(public.get_my_lesson_rooms(v_today, v_today)) x
    where x ->> 'session_id' = v_room_session::text and x ->> 'meeting_uri' = 'https://meet.google.com/pdo-isal-aaa'),
    'sala pronta com aceite não chegou ao aluno');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_lesson_documentation_consent(v_room_session, false, 'Família pediu por WhatsApp para parar o registro.');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.p2_assert(exists (select 1 from jsonb_array_elements(v_jobs) j
    where j ->> 'lesson_session_id' = v_room_session::text and j ->> 'operation' = 'DISABLE_ARTIFACTS'
      and (j ->> 'priority_group')::int = 0), 'revogação não pôs a sala na fila para desligar');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_student, 'role', 'authenticated')::text, true);
  perform pg_temp.p2_assert(not exists (select 1 from jsonb_array_elements(public.get_my_lesson_rooms(v_today, v_today)) x
    where x ->> 'session_id' = v_room_session::text), 'sala de quem revogou continuou entregue no app');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_result := public.google_meet_backend('room_artifacts_save', 'meet-p2-fixture', v_admin, v_room_session,
    jsonb_build_object('result', 'FAILED', 'error_code', 'google_permission_or_edition_required'));
  perform pg_temp.p2_assert(v_result ->> 'artifacts_state' = 'ENABLED' and (v_result ->> 'artifacts_attempts')::int = 1
    and (v_result ->> 'artifacts_next_attempt_at')::timestamptz between now() + interval '14 minutes' and now() + interval '16 minutes'
    and v_result ->> 'artifacts_error_code' = 'google_permission_or_edition_required' and not (v_result ? 'claim_id'),
    'falha ao desligar não ficou registrada com nova tentativa em 15 min');
  perform pg_temp.p2_assert(not exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_room_session::text), 'desligar voltou antes da espera');
  v_result := public.google_meet_backend('room_artifacts_save', 'meet-p2-fixture', v_admin, v_room_session,
    jsonb_build_object('result', 'FAILED', 'error_code', 'google_rate_limited'));
  perform pg_temp.p2_assert((v_result ->> 'artifacts_next_attempt_at')::timestamptz between now() + interval '29 minutes' and now() + interval '31 minutes',
    'segunda falha não dobrou a espera');
  update private.google_meet_rooms set artifacts_next_attempt_at = now() - interval '1 minute' where lesson_session_id = v_room_session;
  perform pg_temp.p2_assert(exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_room_session::text and j ->> 'operation' = 'DISABLE_ARTIFACTS'),
    'desligar não voltou depois da espera');
  v_result := public.google_meet_backend('room_artifacts_save', 'meet-p2-fixture', v_admin, v_room_session,
    jsonb_build_object('result', 'DISABLED'));
  perform pg_temp.p2_assert(v_result ->> 'artifacts_state' = 'DISABLED' and (v_result ->> 'artifacts_attempts')::int = 0
    and v_result ->> 'artifacts_next_attempt_at' is null and v_result ->> 'artifacts_changed_at' is not null,
    'sala desligada não ficou registrada');
  perform pg_temp.p2_assert(not exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_room_session::text), 'sala já desligada continuou na fila');
  -- O aceite volta antes da aula: religa.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_lesson_documentation_consent(v_room_session, true, 'Família autorizou de novo pelo link, conferido.');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.p2_assert(exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_room_session::text and j ->> 'operation' = 'ENABLE_ARTIFACTS'),
    'aceite de volta antes da aula não religou a sala');
  perform public.google_meet_backend('room_artifacts_save', 'meet-p2-fixture', v_admin, v_room_session,
    jsonb_build_object('result', 'ENABLED'));
  perform pg_temp.p2_assert(not exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_room_session::text), 'sala religada continuou na fila');
  -- Aceite de volta com a aula em andamento: não religa.
  insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
    cohost_email, state, created_by, artifacts_state) values
    (v_started, 'meet-p2-fixture', 'spaces/p2started', 'https://meet.google.com/sta-rted-aaa', 'p2-sub-central',
      'prof.nova@example.com', 'READY', v_admin, 'DISABLED');
  perform pg_temp.p2_assert(not exists (select 1 from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) j
    where j ->> 'lesson_session_id' = v_started::text), 'religou sala de aula já começada');
  v_blocked := false;
  begin
    perform public.google_meet_backend('room_artifacts_save', 'meet-p2-fixture', v_admin, v_room_session,
      jsonb_build_object('result', 'ON'));
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'estado inventado da documentação aceito');

  -- ===== 5. Transcrição bruta só para o professor da aula, coordenação e direção =
  v_result := public.google_meet_backend('artifact_save', 'meet-p2-fixture', v_admin, v_past, jsonb_build_object(
    'provider_name', 'conferenceRecords/p2/smartNotes/n1', 'kind', 'SMART_NOTES', 'document_id', 'n1',
    'content_sha256', repeat('a', 64), 'source_text', 'FALA-BRUTA-DA-AULA: aluno praticou pedidos.', 'retention_days', 90));
  v_artifact := (v_result ->> 'id')::uuid;
  -- A importação grava o rascunho das notas nativas com a conta que conectou,
  -- que pode ser o suporte: permitido.
  v_result := public.google_meet_backend('summary_save', 'meet-p2-fixture', v_super, v_past, jsonb_build_object(
    'status', 'PROPOSED', 'origin', 'GOOGLE_SMART_NOTES', 'content', jsonb_build_object('narrative', 'FALA-BRUTA-DA-AULA: aluno praticou pedidos.'),
    'source_artifact_ids', jsonb_build_array(v_artifact)));
  v_draft := (v_result ->> 'id')::uuid;
  perform public.google_meet_backend('summary_save', 'meet-p2-fixture', v_teacher, v_past, jsonb_build_object(
    'status', 'VERIFIED', 'origin', 'HUMAN_REVIEW', 'parent_version_id', v_draft,
    'content', jsonb_build_object('lesson_objective', 'Pedidos no restaurante', 'recommended_next_step', 'Reservar mesa',
      'narrative', 'Resumo aprovado da aula.'), 'source_artifact_ids', jsonb_build_array(v_artifact)));
  perform public.google_meet_attendance_backend('attendance_save', 'meet-p2-fixture', v_past, jsonb_build_object(
    'document_id', 'sheet_p2', 'document_name', 'Relatório de participação em pdo-isal-aaa', 'conference_name', 'conferenceRecords/p2',
    'source_csv', 'PLANILHA-BRUTA', 'content_sha256', repeat('b', 64), 'retention_days', 90,
    'participants', jsonb_build_array(jsonb_build_object('name', 'Aluno', 'email', 'aluno.pessoal@example.com', 'role', 'STUDENT')),
    'teacher_first_join_at', now() - interval '90 minutes', 'teacher_seconds', 1700,
    'student_first_join_at', now() - interval '88 minutes', 'student_seconds', 1600));

  v_result := public.google_meet_backend('session_detail', 'meet-p2-fixture', v_teacher, v_past);
  perform pg_temp.p2_assert((v_result ->> 'raw_access')::boolean and jsonb_array_length(v_result -> 'artifacts') = 1
    and jsonb_array_length(v_result -> 'summaries') = 2 and (v_result -> 'attendance' ->> 'student_seconds')::int = 1600
    and not (v_result::text like '%PLANILHA-BRUTA%'),
    'professor da aula não viu a fonte, os rascunhos e a presença (ou viu o CSV)');
  v_result := public.google_meet_backend('session_detail', 'meet-p2-fixture', v_coord, v_past);
  perform pg_temp.p2_assert((v_result ->> 'raw_access')::boolean and jsonb_array_length(v_result -> 'artifacts') = 1,
    'coordenação não viu a transcrição');
  v_result := public.google_meet_backend('session_detail', 'meet-p2-fixture', v_admin, v_past);
  perform pg_temp.p2_assert((v_result ->> 'raw_access')::boolean and jsonb_array_length(v_result -> 'artifacts') = 1,
    'direção não viu a transcrição');
  v_result := public.google_meet_backend('session_detail', 'meet-p2-fixture', v_teacher2, v_past);
  perform pg_temp.p2_assert(not (v_result ->> 'raw_access')::boolean and jsonb_array_length(v_result -> 'artifacts') = 0
    and jsonb_array_length(v_result -> 'summaries') = 1 and v_result -> 'summaries' -> 0 ->> 'status' = 'VERIFIED'
    and v_result -> 'attendance' = 'null'::jsonb and not (v_result::text like '%FALA-BRUTA-DA-AULA%')
    and not (v_result::text like '%aluno.pessoal@example.com%'),
    'outro professor do aluno leu transcrição, rascunho ou presença');
  v_result := public.google_meet_backend('session_detail', 'meet-p2-fixture', v_super, v_past);
  perform pg_temp.p2_assert(not (v_result ->> 'raw_access')::boolean and not (v_result::text like '%FALA-BRUTA-DA-AULA%'),
    'suporte da plataforma leu a transcrição bruta');
  perform pg_temp.p2_assert(exists (select 1 from private.google_meet_access_events
    where lesson_session_id = v_past and actor_id = v_teacher2 and action = 'READ_APPROVED_SUMMARIES'),
    'leitura restrita sem registro próprio');
  v_blocked := false;
  begin
    perform public.google_meet_backend('summary_save', 'meet-p2-fixture', v_teacher2, v_past, jsonb_build_object(
      'status', 'VERIFIED', 'origin', 'HUMAN_REVIEW', 'parent_version_id', v_draft,
      'content', jsonb_build_object('lesson_objective', 'Outro', 'recommended_next_step', 'Outro'),
      'source_artifact_ids', jsonb_build_array(v_artifact)));
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'quem não vê a fonte aprovou resumo');
  v_blocked := false;
  begin perform public.google_meet_backend('summary_claim', 'meet-p2-fixture', v_teacher2, v_past);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'quem não vê a fonte pediu resumo pago');
  -- Estado interno da edge: sem texto bruto, com o que a fila precisa.
  v_result := public.google_meet_backend('session_state', 'meet-p2-fixture', v_super, v_past);
  perform pg_temp.p2_assert(jsonb_array_length(v_result -> 'summaries') = 2 and not (v_result -> 'summaries' -> 0 ? 'content')
    and v_result ->> 'teacher_google_email' = 'prof.nova@example.com' and not (v_result::text like '%FALA-BRUTA-DA-AULA%'),
    'estado interno trouxe texto bruto ou perdeu a identidade do professor');
  -- Substituto que deu a aula (sem ser professor do aluno) vê a própria aula.
  v_result := public.google_meet_backend('session_detail', 'meet-p2-fixture', v_sub_teacher, v_sub_session);
  perform pg_temp.p2_assert((v_result ->> 'raw_access')::boolean, 'substituto não alcançou a aula que deu');

  -- ===== 6. Marcação manual: só a direção, sem passar por cima de quem disse não =
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_coord, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.set_lesson_documentation_consent(v_manual_ok, true, 'Coordenação tentando marcar a aula.');
  exception when insufficient_privilege then v_message := sqlerrm; v_blocked := v_message = 'somente_a_direcao'; end;
  perform pg_temp.p2_assert(v_blocked, 'coordenação marcou documentação');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.set_lesson_documentation_consent(v_manual_ok, true, 'curto');
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.p2_assert(v_blocked, 'marcação sem motivo aceita');
  perform public.set_lesson_documentation_consent(v_manual_ok, true, 'Autorização em papel, arquivo da secretaria.');
  perform public.set_lesson_documentation_consent(v_manual, true, 'Autorização em papel, arquivo da secretaria.');
  perform pg_temp.p2_assert(exists (select 1 from private.lesson_documentation_consent_events
    where session_id = v_manual and allowed and actor_id = v_admin and reason like 'Autorização em papel%'),
    'marcação manual sem registro do motivo e de quem marcou');
  -- O professor sem conta RECUSOU o termo: a escola não liga por cima.
  v_blocked := false;
  begin perform public.set_lesson_documentation_consent(v_noid_session, true, 'Tentando ligar por cima da recusa do professor.');
  exception when insufficient_privilege then v_message := sqlerrm; v_blocked := v_message = 'termo_recusado_ou_revogado_pelo_professor'; end;
  perform pg_temp.p2_assert(v_blocked, 'marcação manual passou por cima da recusa do professor');
  -- O aluno revoga (pedido à escola): ligar por cima é recusado; desligar sempre pode.
  perform public.revoke_lesson_recording_consent(v_student3, 'Família pediu para parar pelo WhatsApp.');
  v_blocked := false;
  begin perform public.set_lesson_documentation_consent(v_manual, true, 'Tentando ligar por cima da revogação.');
  exception when insufficient_privilege then v_message := sqlerrm; v_blocked := v_message = 'termo_recusado_ou_revogado_pelo_aluno'; end;
  perform pg_temp.p2_assert(v_blocked, 'marcação manual passou por cima da revogação do aluno');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- A revogação que chegou DEPOIS da marcação manual desmarca a sessão no job.
  v_changed := private.apply_standing_lesson_recording_consent('meet-p2-fixture');
  perform pg_temp.p2_assert(not (select documentation_consent from public.lesson_sessions where id = v_manual),
    'revogação não desfez a marcação manual');
  perform pg_temp.p2_assert(exists (select 1 from private.lesson_documentation_consent_events
    where session_id = v_manual and not allowed and reason like '%marcação manual não passa por cima%'),
    'desmarcação sem motivo registrado');
  perform pg_temp.p2_assert((select documentation_consent from public.lesson_sessions where id = v_manual_ok),
    'marcação manual de aluno sem decisão foi desfeita');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_lesson_documentation_consent(v_manual, false, 'Confirmando a retirada pedida pela família.');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- ===== 7. Troca de conta central com salas criadas pede confirmação ==========
  v_result := public.google_meet_backend('status', 'meet-p2-fixture', v_admin);
  perform pg_temp.p2_assert((v_result ->> 'rooms_count')::int = 2, 'status não conta as salas da conta atual');
  v_blocked := false;
  begin
    perform public.google_meet_backend('connection_save', 'meet-p2-fixture', v_admin, null, jsonb_build_object(
      'organizer_sub', 'p2-outra-conta', 'organizer_email', 'outra@example.com',
      'refresh_token_ciphertext', 'synthetic-protected-token-2', 'granted_scopes', jsonb_build_array('fixture')));
  exception when object_not_in_prerequisite_state then v_message := sqlerrm;
    v_blocked := v_message = 'google_organizer_change_requires_confirmation'; end;
  perform pg_temp.p2_assert(v_blocked, 'outra conta Google substituiu a central com salas criadas');
  perform pg_temp.p2_assert((select organizer_sub = 'p2-sub-central' from private.google_workspace_connections
    where tenant_id = 'meet-p2-fixture'), 'conexão mudou apesar da recusa');
  -- A mesma conta reconecta sem pedir nada.
  perform public.google_meet_backend('connection_save', 'meet-p2-fixture', v_admin, null, jsonb_build_object(
    'organizer_sub', 'p2-sub-central', 'organizer_email', 'escola@example.com',
    'refresh_token_ciphertext', 'synthetic-protected-token-3', 'granted_scopes', jsonb_build_array('fixture')));
  -- Troca pedida pela direção: aceita e registrada.
  perform public.google_meet_backend('connection_save', 'meet-p2-fixture', v_admin, null, jsonb_build_object(
    'organizer_sub', 'p2-outra-conta', 'organizer_email', 'outra@example.com', 'allow_replace', true,
    'refresh_token_ciphertext', 'synthetic-protected-token-4', 'granted_scopes', jsonb_build_array('fixture')));
  perform pg_temp.p2_assert(exists (select 1 from private.google_meet_access_events
    where tenant_id = 'meet-p2-fixture' and action = 'ORGANIZER_REPLACED'), 'troca de conta central sem registro');
  v_result := public.google_meet_backend('status', 'meet-p2-fixture', v_admin);
  perform pg_temp.p2_assert((v_result ->> 'rooms_count')::int = 0 and v_result -> 'connection' ->> 'organizer_email' = 'outra@example.com',
    'status depois da troca');
end
$test$;

rollback;
