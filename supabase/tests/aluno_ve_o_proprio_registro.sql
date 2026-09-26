-- O aluno vê o próprio registro das aulas (migration 20260927140000).
-- Prova: só o próprio aluno lê (outro aluno, outra escola, professor e
-- direção não); só o resumo APROVADO mais recente de cada aula aparece
-- (rascunho, rejeição posterior e versão antiga não); nenhum texto bruto
-- (transcrição, notas, citações, dificuldades, narrativa) nem o cartão do
-- professor chega ao aluno; a validade da cópia bruta é a real; a situação do
-- termo segue a régua que marca as aulas; o link do termo sai sem token; o
-- contato da escola é o da instância central.
-- Contra o código anterior reprova no primeiro bloco: a RPC não existe.
-- Não depende de dado real nem do horário: tudo é fixture relativa a now().
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.rec_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'registro do aluno: %', p_message;
  end if;
end;
$$;

-- Chama a RPC como p_actor (ou sem ninguém) e devolve o jsonb, ou
-- {"error": "<mensagem>"} quando o servidor recusa.
create or replace function pg_temp.rec_read(p_actor uuid)
returns jsonb language plpgsql as $$
begin
  if p_actor is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  end if;
  return public.get_my_lesson_records();
exception when others then
  return jsonb_build_object('error', sqlerrm);
end;
$$;

do $privileges$
declare
  v_proc regprocedure := to_regprocedure('public.get_my_lesson_records()');
begin
  perform pg_temp.rec_assert(v_proc is not null, 'RPC get_my_lesson_records() não existe');
  perform pg_temp.rec_assert(
    (select prosecdef and pg_get_userbyid(proowner) = 'postgres'
            and proconfig @> array['search_path=""']
       from pg_proc where oid = v_proc),
    'RPC sem SECURITY DEFINER, dono postgres ou search_path vazio');
  perform pg_temp.rec_assert(
    has_function_privilege('authenticated', v_proc, 'EXECUTE')
    and not has_function_privilege('anon', v_proc, 'EXECUTE'),
    'RPC do aluno com permissão errada (anon alcança ou authenticated não)');
  perform pg_temp.rec_assert(
    not has_function_privilege('authenticated', 'private.lesson_record_text(jsonb,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.lesson_record_list(jsonb,integer,integer)', 'EXECUTE'),
    'função interna do registro exposta');
  -- O texto bruto continua fora do alcance do navegador.
  perform pg_temp.rec_assert(
    not has_table_privilege('authenticated', 'private.lesson_summary_versions', 'SELECT')
    and not has_table_privilege('authenticated', 'private.meeting_artifact_revisions', 'SELECT'),
    'o navegador lê resumo ou transcrição direto da tabela');
end
$privileges$;

do $test$
declare
  v_tid text := 'registro-aluno-fixture';
  v_other_tid text := 'registro-aluno-outra';
  v_admin uuid := gen_random_uuid();
  v_other_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_classmate uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_s1 uuid := gen_random_uuid();   -- aprovada, com rascunho posterior e cópias vivas
  v_s2 uuid := gen_random_uuid();   -- transcrição guardada, só rascunho
  v_s3 uuid := gen_random_uuid();   -- aprovada duas vezes e rejeitada depois
  v_s4 uuid := gen_random_uuid();   -- do colega de escola
  v_s5 uuid := gen_random_uuid();   -- do aluno, mas registrada em outra escola
  v_s6 uuid := gen_random_uuid();   -- do aluno da outra escola
  v_v1 uuid := gen_random_uuid();
  v_v3a uuid := gen_random_uuid();
  v_term_version text;
  v_token_hash text := encode(extensions.digest('token-fixture-registro-aluno', 'sha256'), 'hex');
  v_link_expires timestamptz := date_trunc('second', now() + interval '10 days');
  v_report_expires timestamptz := date_trunc('second', now() + interval '50 days');
  v_all uuid[];
  v_r jsonb;
  v_rec jsonb;
  v_text text;
  v_marker text;
begin
  v_all := array[v_admin, v_other_admin, v_teacher, v_student, v_classmate, v_outsider];
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- O texto do termo é dado de migration: numa cópia só-estrutura ele não
  -- existe, e o teste publica um provisório (desfeito no rollback).
  if (private.lesson_recording_current_term('STUDENT')).version is null then
    insert into private.lesson_recording_terms (audience, version, body)
    values ('STUDENT', 'v1', repeat('Termo provisório do teste do registro do aluno. ', 6));
  end if;
  v_term_version := (private.lesson_recording_current_term('STUDENT')).version;
  insert into public.tenants (id, name, school_info) values
    (v_tid, 'Registro fixture', '{"name":"Escola Registro Fixture"}'::jsonb),
    (v_other_tid, 'Registro outra escola', null);
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  select id, 'registro-' || replace(id::text, '-', '') || '@example.invalid',
         '{"provider":"email"}', '{"test_fixture":true}'
    from unnest(v_all) as fixture(id);
  update public.profiles
     set tenant_id = case when id in (v_other_admin, v_outsider) then v_other_tid else v_tid end,
         lifecycle_status = 'active', is_test_account = true,
         role = case
           when id in (v_admin, v_other_admin) then 'SCHOOL_ADMIN'
           when id = v_teacher then 'TEACHER'
           else 'STUDENT' end,
         full_name = case
           when id = v_teacher then 'Professora Registro'
           when id = v_student then 'Aluno Registro'
           else 'Fixture Registro' end,
         professor_id = case when id in (v_student, v_classmate) then v_teacher end,
         -- Só a direção da escola A tem a instância central do WhatsApp.
         whatsapp_instance = case when id = v_admin then 'registro-fixture-central' end,
         phone = case when id in (v_admin, v_other_admin) then '(11) 98888-7777' else phone end
   where id = any (v_all);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id = any (v_all)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key) values
    (v_s1, v_tid, v_student, v_teacher, ((now() - interval '3 days') at time zone 'America/Sao_Paulo')::date,
      now() - interval '3 days', now() - interval '3 days' + interval '30 minutes', 'registro-s1'),
    (v_s2, v_tid, v_student, v_teacher, ((now() - interval '2 days') at time zone 'America/Sao_Paulo')::date,
      now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'registro-s2'),
    (v_s3, v_tid, v_student, v_teacher, ((now() - interval '5 days') at time zone 'America/Sao_Paulo')::date,
      now() - interval '5 days', now() - interval '5 days' + interval '30 minutes', 'registro-s3'),
    (v_s4, v_tid, v_classmate, v_teacher, ((now() - interval '1 day') at time zone 'America/Sao_Paulo')::date,
      now() - interval '1 day', now() - interval '1 day' + interval '30 minutes', 'registro-s4'),
    (v_s5, v_other_tid, v_student, v_teacher, ((now() - interval '4 days') at time zone 'America/Sao_Paulo')::date,
      now() - interval '4 days', now() - interval '4 days' + interval '30 minutes', 'registro-s5'),
    (v_s6, v_other_tid, v_outsider, v_teacher, ((now() - interval '4 days') at time zone 'America/Sao_Paulo')::date,
      now() - interval '4 days', now() - interval '4 days' + interval '30 minutes', 'registro-s6');

  -- s1: notas nativas (rascunho) → aprovação do professor → rascunho novo da IA.
  insert into private.lesson_summary_versions (id, tenant_id, lesson_session_id, version, status, origin, content, created_by)
  values (v_v1, v_tid, v_s1, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES',
          '{"narrative":"RASCUNHO-NATIVO","lesson_objective":"RASCUNHO-NATIVO"}', v_teacher);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, parent_version_id, status, origin, content, created_by)
  values
    (v_tid, v_s1, 2, v_v1, 'VERIFIED', 'HUMAN_REVIEW', jsonb_build_object(
      'lesson_objective', '  Pedir comida no restaurante ',
      'content_practiced', jsonb_build_array('would like', '   ', 'menu vocabulary', 42),
      'recommended_next_step', 'Praticar reclamação educada',
      'homework_assigned', 'Gravar um áudio pedindo um prato',
      'narrative', 'NARRATIVA-DO-PROFESSOR',
      'recurring_errors', jsonb_build_array('ERRO-RECORRENTE'),
      'strengths_observed', jsonb_build_array('PONTO-FORTE'),
      'evidence', jsonb_build_array(jsonb_build_object('quote', 'CITACAO-DA-TRANSCRICAO')),
      'uncertainties', jsonb_build_array('INCERTEZA')), v_teacher),
    (v_tid, v_s1, 3, null, 'PROPOSED', 'GEMINI_API', '{"lesson_objective":"RASCUNHO-POSTERIOR"}', v_teacher);
  -- s2: só rascunho, com transcrição guardada.
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content, created_by)
  values (v_tid, v_s2, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES', '{"lesson_objective":"RASCUNHO-SEM-APROVACAO"}', v_teacher);
  -- s3: aprovada, reaprovada com correção, e um rascunho rejeitado depois.
  insert into private.lesson_summary_versions (id, tenant_id, lesson_session_id, version, status, origin, content, created_by)
  values (v_v3a, v_tid, v_s3, 1, 'VERIFIED', 'HUMAN_REVIEW',
          '{"lesson_objective":"OBJETIVO-ANTIGO","recommended_next_step":"PASSO-ANTIGO"}', v_teacher);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, parent_version_id, status, origin, content, created_by)
  values
    (v_tid, v_s3, 2, v_v3a, 'VERIFIED', 'HUMAN_REVIEW',
     '{"lesson_objective":"Objetivo revisado","content_practiced":"past simple","recommended_next_step":"Revisar verbos irregulares"}', v_teacher),
    (v_tid, v_s3, 3, v_v3a, 'REJECTED', 'HUMAN_REVIEW', '{"lesson_objective":"OBJETIVO-REJEITADO"}', v_teacher);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content, created_by)
  values
    (v_tid, v_s4, 1, 'VERIFIED', 'HUMAN_REVIEW',
     '{"lesson_objective":"OBJETIVO-DO-COLEGA","recommended_next_step":"Passo do colega"}', v_teacher),
    (v_other_tid, v_s5, 1, 'VERIFIED', 'HUMAN_REVIEW',
     '{"lesson_objective":"OBJETIVO-DE-OUTRA-ESCOLA","recommended_next_step":"x"}', v_teacher),
    (v_other_tid, v_s6, 1, 'VERIFIED', 'HUMAN_REVIEW',
     '{"lesson_objective":"Objetivo da escola B","recommended_next_step":"Passo da escola B"}', v_teacher);

  -- Cópias brutas: s1 com transcrição (40 dias) e presença (50 dias); s2 com
  -- transcrição viva; s3 só com cópia já vencida.
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind,
    document_id, content_sha256, source_text, expires_at) values
    (v_tid, v_s1, 'fixture-s1-transcript', 'TRANSCRIPT', 'docS1',
      encode(extensions.digest('s1', 'sha256'), 'hex'), 'TEXTO-BRUTO-DA-AULA', now() + interval '40 days'),
    (v_tid, v_s2, 'fixture-s2-transcript', 'TRANSCRIPT', 'docS2',
      encode(extensions.digest('s2', 'sha256'), 'hex'), 'TEXTO-BRUTO-SEM-RESUMO', now() + interval '40 days'),
    (v_tid, v_s3, 'fixture-s3-transcript', 'TRANSCRIPT', 'docS3',
      encode(extensions.digest('s3', 'sha256'), 'hex'), 'TEXTO-BRUTO-VENCIDO', now() - interval '1 day');
  insert into private.meeting_attendance_reports (tenant_id, lesson_session_id, document_id,
    content_sha256, source_csv, expires_at)
  values (v_tid, v_s1, 'presencaS1', encode(extensions.digest('p1', 'sha256'), 'hex'), 'CSV-BRUTO', v_report_expires);

  -- Cartão do aluno escrito pelo professor: nada dele chega ao aluno.
  insert into public.student_learning_cards (tenant_id, student_id, real_goal, engaging_topics, updated_by)
  values (v_tid, v_student, 'OBJETIVO-DO-CARTAO', array['TEMA-DO-CARTAO'], v_teacher);

  -- Termo: aluno com aceite válido (pelo responsável, com código); colega com
  -- aceite que não vale (sem código); o da outra escola nunca respondeu.
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision,
    signer_name, signer_relation, term_audience, term_version, source, verification, verified_phone)
  values
    (v_tid, v_student, 'STUDENT', 'ACCEPTED', 'Responsável Registro', 'GUARDIAN',
      'STUDENT', v_term_version, 'APP', 'WHATSAPP_CODE', '(11) •••••-7777'),
    (v_tid, v_classmate, 'STUDENT', 'ACCEPTED', 'Colega Registro', 'SELF',
      'STUDENT', v_term_version, 'SCHOOL', null, null);
  -- Um link revogado antigo e o link vivo do aluno.
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values
    (v_tid, v_student, encode(extensions.digest('link-antigo-registro', 'sha256'), 'hex'), v_admin,
      now() + interval '20 days', now() - interval '1 day'),
    (v_tid, v_student, v_token_hash, v_admin, v_link_expires, null);

  -- ---------------------------------------------------------------------
  -- O próprio aluno
  -- ---------------------------------------------------------------------
  v_r := pg_temp.rec_read(v_student);
  perform pg_temp.rec_assert(v_r ->> 'ok' = 'true', 'aluno não leu o próprio registro: ' || v_r::text);
  perform pg_temp.rec_assert(
    jsonb_array_length(v_r -> 'records') = 2
    and (v_r -> 'records' -> 0 ->> 'session_id')::uuid = v_s1
    and (v_r -> 'records' -> 1 ->> 'session_id')::uuid = v_s3,
    'aulas aprovadas erradas ou fora de ordem (mais recente primeiro): ' || (v_r -> 'records')::text);

  v_rec := v_r -> 'records' -> 0;
  perform pg_temp.rec_assert(
    (select array_agg(key order by key) from jsonb_object_keys(v_rec) as key)
    = array['approved_at', 'class_date', 'content_practiced', 'homework_assigned', 'lesson_objective',
            'raw_copy_until', 'recommended_next_step', 'scheduled_start_at', 'session_id', 'teacher_name'],
    'registro da aula com campo além do permitido: ' || v_rec::text);
  perform pg_temp.rec_assert(
    v_rec ->> 'lesson_objective' = 'Pedir comida no restaurante'
    and v_rec -> 'content_practiced' = '["would like", "menu vocabulary"]'::jsonb
    and v_rec ->> 'recommended_next_step' = 'Praticar reclamação educada'
    and v_rec ->> 'homework_assigned' = 'Gravar um áudio pedindo um prato'
    and v_rec ->> 'teacher_name' = 'Professora Registro',
    'resumo aprovado da aula saiu diferente: ' || v_rec::text);
  perform pg_temp.rec_assert(
    (v_rec ->> 'raw_copy_until')::timestamptz = v_report_expires,
    'validade da cópia bruta não é a mais longa das cópias vivas: ' || coalesce(v_rec ->> 'raw_copy_until', 'nulo'));

  v_rec := v_r -> 'records' -> 1;
  perform pg_temp.rec_assert(
    v_rec ->> 'lesson_objective' = 'Objetivo revisado'
    and v_rec ->> 'recommended_next_step' = 'Revisar verbos irregulares'
    and v_rec -> 'content_practiced' = '["past simple"]'::jsonb
    and v_rec ->> 'homework_assigned' is null
    and v_rec -> 'raw_copy_until' = 'null'::jsonb,
    'reaprovação/rejeição posterior ou cópia vencida tratadas errado: ' || v_rec::text);

  perform pg_temp.rec_assert((v_r ->> 'pending_review')::integer = 1,
    'aula com transcrição guardada sem resumo aprovado não foi contada');

  -- Nenhum texto bruto, rascunho, cartão, token ou aula alheia no retorno.
  v_text := v_r::text;
  foreach v_marker in array array[
    'RASCUNHO-NATIVO', 'RASCUNHO-POSTERIOR', 'RASCUNHO-SEM-APROVACAO', 'NARRATIVA-DO-PROFESSOR',
    'ERRO-RECORRENTE', 'PONTO-FORTE', 'CITACAO-DA-TRANSCRICAO', 'INCERTEZA',
    'TEXTO-BRUTO-DA-AULA', 'TEXTO-BRUTO-SEM-RESUMO', 'TEXTO-BRUTO-VENCIDO', 'CSV-BRUTO',
    'OBJETIVO-ANTIGO', 'PASSO-ANTIGO', 'OBJETIVO-REJEITADO', 'OBJETIVO-DO-COLEGA',
    'OBJETIVO-DE-OUTRA-ESCOLA', 'Objetivo da escola B', 'OBJETIVO-DO-CARTAO', 'TEMA-DO-CARTAO',
    v_token_hash, 'token-fixture-registro-aluno'
  ] loop
    perform pg_temp.rec_assert(position(v_marker in v_text) = 0,
      'o registro do aluno vazou "' || v_marker || '"');
  end loop;

  perform pg_temp.rec_assert(
    v_r -> 'consent' ->> 'status' = 'AUTHORIZED'
    and v_r -> 'consent' ->> 'signer_relation' = 'GUARDIAN'
    and (v_r -> 'consent' ->> 'requires_guardian')::boolean
    and v_r -> 'consent' ->> 'guardian_reason' = private.lesson_recording_guardian_reason(v_student)
    and (v_r -> 'consent' ->> 'link_expires_at')::timestamptz = v_link_expires,
    'situação do termo do aluno errada: ' || (v_r -> 'consent')::text);
  perform pg_temp.rec_assert(
    v_r -> 'term' ->> 'version' = v_term_version
    and length(v_r -> 'term' ->> 'body') > 100,
    'termo vigente não veio junto');
  perform pg_temp.rec_assert(
    v_r ->> 'school_name' = 'Escola Registro Fixture'
    and v_r ->> 'school_whatsapp' = '11988887777',
    'contato da escola errado: ' || coalesce(v_r ->> 'school_name', 'nulo') || ' / ' || coalesce(v_r ->> 'school_whatsapp', 'nulo'));

  -- Revogação pela escola: a tela passa a dizer que está revogado.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision,
    signer_name, signer_relation, source, recorded_by, reason)
  values (v_tid, v_student, 'STUDENT', 'REVOKED', 'Direção Registro', 'SCHOOL', 'SCHOOL', v_admin,
          'pedido do aluno pelo WhatsApp');
  v_r := pg_temp.rec_read(v_student);
  perform pg_temp.rec_assert(v_r -> 'consent' ->> 'status' = 'REVOKED',
    'revogação não aparece para o aluno: ' || (v_r -> 'consent')::text);
  perform pg_temp.rec_assert(jsonb_array_length(v_r -> 'records') = 2,
    'revogar apagou da tela o que já tinha sido aprovado');

  -- ---------------------------------------------------------------------
  -- Outro aluno da mesma escola: só o dele
  -- ---------------------------------------------------------------------
  v_r := pg_temp.rec_read(v_classmate);
  perform pg_temp.rec_assert(
    jsonb_array_length(v_r -> 'records') = 1
    and (v_r -> 'records' -> 0 ->> 'session_id')::uuid = v_s4
    and (v_r ->> 'pending_review')::integer = 0,
    'colega viu aula que não é dele: ' || v_r::text);
  perform pg_temp.rec_assert(
    position('Pedir comida' in v_r::text) = 0 and position('Objetivo revisado' in v_r::text) = 0,
    'colega viu o resumo do aluno');
  perform pg_temp.rec_assert(
    v_r -> 'consent' ->> 'status' = 'NOT_EFFECTIVE'
    and v_r -> 'consent' -> 'link_expires_at' = 'null'::jsonb,
    'aceite sem código apareceu como válido para o colega: ' || (v_r -> 'consent')::text);

  -- ---------------------------------------------------------------------
  -- Aluno de outra escola: só a escola dele, sem o WhatsApp da escola A
  -- ---------------------------------------------------------------------
  v_r := pg_temp.rec_read(v_outsider);
  perform pg_temp.rec_assert(
    jsonb_array_length(v_r -> 'records') = 1
    and (v_r -> 'records' -> 0 ->> 'session_id')::uuid = v_s6
    and v_r ->> 'school_name' = 'Registro outra escola'
    and v_r -> 'school_whatsapp' = 'null'::jsonb
    and v_r -> 'consent' ->> 'status' = 'NONE',
    'aluno de outra escola com registro ou contato errado: ' || v_r::text);

  -- ---------------------------------------------------------------------
  -- Professor, direção e visitante não usam a rota do aluno
  -- ---------------------------------------------------------------------
  v_r := pg_temp.rec_read(v_teacher);
  perform pg_temp.rec_assert(v_r ->> 'error' = 'somente_o_aluno', 'professor usou a RPC do aluno: ' || v_r::text);
  v_r := pg_temp.rec_read(v_admin);
  perform pg_temp.rec_assert(v_r ->> 'error' = 'somente_o_aluno', 'direção usou a RPC do aluno: ' || v_r::text);
  v_r := pg_temp.rec_read(null);
  perform pg_temp.rec_assert(v_r ->> 'error' = 'somente_o_aluno', 'sem login leu registro: ' || v_r::text);

  -- Pela porta do PostgREST (papel authenticated), o aluno lê; anon não chega.
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_student, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_r := public.get_my_lesson_records();
  execute 'reset role';
  perform pg_temp.rec_assert(jsonb_array_length(v_r -> 'records') = 2,
    'papel authenticated não alcança a RPC do aluno');
  begin
    execute 'set local role anon';
    v_r := public.get_my_lesson_records();
    execute 'reset role';
    raise exception 'anon executou a RPC do aluno';
  exception when insufficient_privilege then
    execute 'reset role';
    -- 'somente_o_aluno' também é 42501: tem de ser a falta do GRANT, não a
    -- recusa de dentro da função.
    perform pg_temp.rec_assert(sqlerrm like 'permission denied%',
      'anon executou a RPC do aluno (recusa veio de dentro dela): ' || sqlerrm);
  end;
end
$test$;

rollback;
