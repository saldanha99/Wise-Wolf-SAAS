-- Termo de registro das aulas (migration 20260926120000): link do aluno ou do
-- responsável, aceite do professor no app, e aplicação automática às sessões
-- das próximas 24 h só com a conta Google conectada e os dois lados aceitos.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.rec_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'termo de registro: %', p_message;
  end if;
end;
$$;

do $privileges$
begin
  perform pg_temp.rec_assert(
    has_function_privilege('anon', 'public.get_lesson_recording_consent_public(text)', 'EXECUTE')
    and has_function_privilege('anon', 'public.decide_lesson_recording_consent_public(text,text,text,boolean)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_lesson_recording_consent_public(text)', 'EXECUTE'),
    'o link público perdeu a rota anônima'
  );
  perform pg_temp.rec_assert(
    not has_function_privilege('anon', 'public.create_lesson_recording_consent_link(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.list_lesson_recording_consents()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.revoke_lesson_recording_consent(uuid,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_my_lesson_recording_consent(boolean)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_my_lesson_recording_consent()', 'EXECUTE'),
    'anon alcança rota da escola ou do professor'
  );
  perform pg_temp.rec_assert(
    not has_function_privilege('authenticated', 'private.apply_standing_lesson_recording_consent(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'private.apply_standing_lesson_recording_consent(text)', 'EXECUTE'),
    'aplicação do termo exposta ao navegador'
  );
  perform pg_temp.rec_assert(
    not has_table_privilege('authenticated', 'private.lesson_recording_consents', 'SELECT')
    and not has_table_privilege('authenticated', 'private.lesson_recording_consent_links', 'SELECT')
    and not has_table_privilege('anon', 'private.lesson_recording_consents', 'INSERT'),
    'tabela do termo acessível pelo navegador'
  );
  perform pg_temp.rec_assert(
    pg_catalog.pg_get_functiondef('public.trigger_sync_google_meet_artifacts()'::regprocedure)
      like '%apply_standing_lesson_recording_consent%',
    'o job de 15 minutos não aplica o termo'
  );
  perform pg_temp.rec_assert(
    (select count(*) = 2 from private.lesson_recording_terms where version = 'v1'),
    'textos v1 do termo ausentes'
  );
end
$privileges$;

do $test$
declare
  v_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_teacher_no uuid := gen_random_uuid();
  v_adult uuid := gen_random_uuid();
  v_kid uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_session_soon uuid := gen_random_uuid();
  v_session_later uuid := gen_random_uuid();
  v_session_kid uuid := gen_random_uuid();
  v_session_manual uuid := gen_random_uuid();
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_first_token text;
  v_token text;
  v_kid_token text;
  v_blocked boolean;
  v_changed integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name) values
    ('rec-consent-fixture', 'Termo fixture'),
    ('rec-consent-other', 'Termo outra escola');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'rec-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'rec-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher_no, 'rec-teacher-no@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_adult, 'rec-adult@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_kid, 'rec-kid@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_outsider, 'rec-outsider@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'rec-consent-fixture', lifecycle_status = 'active', is_test_account = true,
         role = case
           when id = v_admin then 'SCHOOL_ADMIN'
           when id in (v_teacher, v_teacher_no) then 'TEACHER'
           else 'STUDENT' end,
         full_name = case
           when id = v_admin then 'Direcao Fixture'
           when id = v_teacher then 'Professora Aceita'
           when id = v_teacher_no then 'Professor Sem Aceite'
           when id = v_adult then 'Aluno Adulto Fixture'
           else 'Crianca Fixture' end,
         is_kids = (id = v_kid),
         guardian_name = case when id = v_kid then 'Responsavel Fixture' end,
         guardian_phone = case when id = v_kid then '5511900000001' end,
         phone = case when id = v_adult then '5511900000002' end
   where id in (v_admin, v_teacher, v_teacher_no, v_adult, v_kid);
  update public.profiles
     set tenant_id = 'rec-consent-other', lifecycle_status = 'active', is_test_account = true,
         role = 'SCHOOL_ADMIN'
   where id = v_outsider;
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles
     where id in (v_admin, v_teacher, v_teacher_no, v_adult, v_kid, v_outsider)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key) values
    (v_session_soon, 'rec-consent-fixture', v_adult, v_teacher, v_today,
      now() + interval '2 hours', now() + interval '150 minutes', 'rec-soon'),
    (v_session_later, 'rec-consent-fixture', v_adult, v_teacher, v_today + 2,
      now() + interval '30 hours', now() + interval '1830 minutes', 'rec-later'),
    (v_session_kid, 'rec-consent-fixture', v_kid, v_teacher_no, v_today,
      now() + interval '3 hours', now() + interval '210 minutes', 'rec-kid'),
    (v_session_manual, 'rec-consent-fixture', v_adult, v_teacher, v_today,
      now() + interval '4 hours', now() + interval '270 minutes', 'rec-manual');
  insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason)
  values (v_session_manual, v_admin, false, 'Decisão manual da escola para esta aula.');

  -- Link: só a escola do aluno gera.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.create_lesson_recording_consent_link(v_adult);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.rec_assert(v_blocked, 'professor gerou link de autorização');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.create_lesson_recording_consent_link(v_adult);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.rec_assert(v_blocked, 'outra escola gerou link para o aluno');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_first_token := public.create_lesson_recording_consent_link(v_adult) ->> 'token';
  perform pg_temp.rec_assert(v_first_token ~ '^[a-f0-9]{64}$', 'token fora do formato');
  v_token := public.create_lesson_recording_consent_link(v_adult) ->> 'token';
  v_kid_token := public.create_lesson_recording_consent_link(v_kid) ->> 'token';
  perform pg_temp.rec_assert(
    not (public.get_lesson_recording_consent_public(v_first_token) ->> 'found')::boolean,
    'link antigo continuou valendo depois de gerar outro'
  );
  perform pg_temp.rec_assert(
    not exists (select 1 from private.lesson_recording_consent_links where token_hash = v_token),
    'token guardado sem hash'
  );

  -- Página pública (anon).
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.get_lesson_recording_consent_public(v_token);
  perform pg_temp.rec_assert((v_result ->> 'found')::boolean, 'link válido não abriu');
  perform pg_temp.rec_assert(v_result ->> 'student_first_name' = 'Aluno', 'devolveu mais que o primeiro nome');
  perform pg_temp.rec_assert(not (v_result ->> 'requires_guardian')::boolean, 'adulto tratado como menor');
  perform pg_temp.rec_assert(v_result ->> 'current_decision' = 'NONE', 'decisão inicial errada');
  perform pg_temp.rec_assert(length(v_result ->> 'term_body') > 200, 'texto do termo ausente');
  perform pg_temp.rec_assert(
    not (public.get_lesson_recording_consent_public(repeat('0', 64)) ->> 'found')::boolean,
    'token inexistente abriu'
  );

  v_blocked := false;
  begin perform public.decide_lesson_recording_consent_public(v_token, 'Aluno', 'SELF', true);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.rec_assert(v_blocked, 'aceitou sem nome completo');

  v_result := public.decide_lesson_recording_consent_public(v_token, '  Aluno   Adulto  Fixture ', 'SELF', true);
  perform pg_temp.rec_assert(v_result ->> 'decision' = 'ACCEPTED', 'aceite do adulto não registrado');
  perform pg_temp.rec_assert(
    (select signer_name from private.lesson_recording_consents where subject_id = v_adult order by seq desc limit 1)
      = 'Aluno Adulto Fixture',
    'nome não foi normalizado'
  );

  v_result := public.get_lesson_recording_consent_public(v_kid_token);
  perform pg_temp.rec_assert((v_result ->> 'requires_guardian')::boolean, 'menor sem exigência de responsável');
  v_blocked := false;
  begin perform public.decide_lesson_recording_consent_public(v_kid_token, 'Crianca Fixture', 'SELF', true);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.rec_assert(v_blocked, 'menor aceitou sozinho');
  v_result := public.decide_lesson_recording_consent_public(v_kid_token, 'Responsavel Fixture', 'GUARDIAN', true);
  perform pg_temp.rec_assert(v_result ->> 'decision' = 'ACCEPTED', 'aceite do responsável não registrado');

  -- Professor no app. Autorizar exige a conta Google confirmada por login
  -- (20260926180000); a identidade vem pela edge, aqui direto na tabela.
  insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
  values (v_teacher, 'rec-consent-fixture', 'rec-teacher-sub', 'rec-teacher@example.com', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  perform pg_temp.rec_assert(public.get_my_lesson_recording_consent() ->> 'decision' = 'NONE', 'professor começou com decisão');
  perform pg_temp.rec_assert(public.set_my_lesson_recording_consent(true) ->> 'decision' = 'ACCEPTED', 'aceite do professor falhou');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_adult, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.set_my_lesson_recording_consent(true);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.rec_assert(v_blocked, 'aluno usou a rota do professor');

  -- Sem conta Google conectada nada é marcado.
  v_changed := private.apply_standing_lesson_recording_consent('rec-consent-fixture');
  perform pg_temp.rec_assert(v_changed = 0, 'marcou sessão sem conta Google conectada');

  insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
  values ('rec-consent-fixture', 'synthetic-sub', 'organizer@example.invalid', 'CONNECTED', v_admin);

  v_changed := private.apply_standing_lesson_recording_consent('rec-consent-fixture');
  perform pg_temp.rec_assert(v_changed = 1, 'deveria marcar só a sessão das próximas 24 h com os dois aceites');
  perform pg_temp.rec_assert(
    (select documentation_consent from public.lesson_sessions where id = v_session_soon),
    'sessão com os dois aceites não foi marcada'
  );
  perform pg_temp.rec_assert(
    exists (select 1 from private.lesson_documentation_consent_events
      where session_id = v_session_soon and allowed and reason like 'Termo de registro das aulas%'
        and actor_id = v_admin),
    'marcação sem evento que cite o termo'
  );
  perform pg_temp.rec_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session_later),
    'marcou sessão fora da janela de 24 h'
  );
  perform pg_temp.rec_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session_kid),
    'marcou sessão de professor que não aceitou'
  );
  perform pg_temp.rec_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session_manual),
    'o termo passou por cima da decisão manual da escola'
  );
  perform pg_temp.rec_assert(
    private.apply_standing_lesson_recording_consent('rec-consent-fixture') = 0,
    'segunda rodada repetiu a marcação'
  );

  -- Painel e revogação pela escola.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.list_lesson_recording_consents();
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.rec_assert(v_blocked, 'professor abriu o painel da escola');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.list_lesson_recording_consents();
  perform pg_temp.rec_assert((v_result ->> 'google_connected')::boolean, 'painel não viu a conta conectada');
  perform pg_temp.rec_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_kid::text and item ->> 'contact_phone' = '5511900000001'
        and (item ->> 'requires_guardian')::boolean and item ->> 'decision' = 'ACCEPTED'),
    'painel não mandou o link do menor para o responsável'
  );
  perform pg_temp.rec_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'teachers') as item
      where item ->> 'teacher_id' = v_teacher_no::text and item ->> 'decision' = 'NONE'),
    'painel não listou o professor sem aceite'
  );

  v_blocked := false;
  begin perform public.revoke_lesson_recording_consent(v_adult, 'curto');
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.rec_assert(v_blocked, 'revogou sem motivo');
  perform public.revoke_lesson_recording_consent(v_adult, 'A família pediu pelo WhatsApp para parar.');

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.rec_assert(
    not (public.get_lesson_recording_consent_public(v_token) ->> 'found')::boolean,
    'link continuou aberto depois da revogação pela escola'
  );

  v_changed := private.apply_standing_lesson_recording_consent('rec-consent-fixture');
  perform pg_temp.rec_assert(v_changed = 1, 'revogação não desmarcou a sessão marcada pelo termo');
  perform pg_temp.rec_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session_soon),
    'sessão seguiu marcada depois da revogação'
  );
  perform pg_temp.rec_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session_manual),
    'revogação mexeu na decisão manual'
  );
end
$test$;

rollback;
