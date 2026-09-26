-- O aluno vê o próprio registro das aulas (migration 20260927140000).
-- Prova: só o próprio aluno lê (outro aluno, outra escola, professor e
-- direção não); só o resumo APROVADO mais recente de cada aula aparece
-- (rascunho, rejeição posterior e versão antiga não), inteiro até os tetos da
-- aprovação; nenhum texto bruto (transcrição, notas, citações, dificuldades,
-- narrativa) nem o cartão do professor chega ao aluno; a validade de cada
-- cópia bruta sai com o nome certo (transcrição, anotações, presença); aula
-- cuja última palavra do professor foi REJEITAR não "espera revisão"; a
-- situação do termo segue a régua que marca as aulas; a validade do link só
-- aparece quando o link CHEGOU (aberto ou mensagem aceita), sem token; o
-- contato da escola é o da instância central.
-- Contra o código anterior reprova: sem a RPC, no primeiro bloco; com a
-- versão de 26/09 (raw_copy_until único, cortes de 600/12/300, rejeitada
-- contada como pendente, link na fila mostrado como enviado), nas asserções
-- de chaves, tetos, pendentes e link.
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
  v_s1 uuid := gen_random_uuid();   -- aprovada, com rascunho posterior; transcrição e presença vivas
  v_s2 uuid := gen_random_uuid();   -- transcrição guardada, só rascunho (espera revisão)
  v_s3 uuid := gen_random_uuid();   -- aprovada duas vezes e rejeitada depois; cópia vencida
  v_s4 uuid := gen_random_uuid();   -- do colega de escola
  v_s5 uuid := gen_random_uuid();   -- do aluno, mas registrada em outra escola
  v_s6 uuid := gen_random_uuid();   -- do aluno da outra escola
  v_s7 uuid := gen_random_uuid();   -- aprovada a partir só das anotações, com resumo longo
  v_s8 uuid := gen_random_uuid();   -- rascunho e depois REJEIÇÃO: revisada, nada a esperar
  v_s9 uuid := gen_random_uuid();   -- rejeitada e depois rascunho novo: volta a esperar
  v_s10 uuid := gen_random_uuid();  -- documento importado, rascunho ainda não gerado
  v_v1 uuid := gen_random_uuid();
  v_v3a uuid := gen_random_uuid();
  v_v8 uuid := gen_random_uuid();
  v_v9 uuid := gen_random_uuid();
  v_term_version text;
  v_token_hash text := encode(extensions.digest('token-fixture-registro-aluno', 'sha256'), 'hex');
  v_manual_link uuid := gen_random_uuid();
  v_batch_link uuid := gen_random_uuid();
  v_notification uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_link_expires timestamptz := date_trunc('second', now() + interval '10 days');
  v_batch_expires timestamptz := date_trunc('second', now() + interval '30 days');
  v_transcript_expires timestamptz := date_trunc('second', now() + interval '40 days');
  v_notes_expires timestamptz := date_trunc('second', now() + interval '30 days');
  v_report_expires timestamptz := date_trunc('second', now() + interval '50 days');
  v_long_objective text := repeat('Objetivo longo aprovado. ', 60);      -- 1500 caracteres
  v_long_next text := repeat('Proximo passo detalhado. ', 32);           -- 800 caracteres
  v_long_homework text := repeat('Licao combinada em detalhe. ', 89);    -- 2492 caracteres
  v_practiced jsonb;
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
    scheduled_start_at, scheduled_end_at, source_key)
  select fixture.id, fixture.tenant_id, fixture.student_id, v_teacher,
         ((now() - fixture.ago) at time zone 'America/Sao_Paulo')::date,
         now() - fixture.ago, now() - fixture.ago + interval '30 minutes', fixture.source_key
  from (values
    (v_s1, v_tid, v_student, interval '3 days', 'registro-s1'),
    (v_s2, v_tid, v_student, interval '2 days', 'registro-s2'),
    (v_s3, v_tid, v_student, interval '5 days', 'registro-s3'),
    (v_s4, v_tid, v_classmate, interval '1 day', 'registro-s4'),
    (v_s5, v_other_tid, v_student, interval '4 days', 'registro-s5'),
    (v_s6, v_other_tid, v_outsider, interval '4 days', 'registro-s6'),
    (v_s7, v_tid, v_student, interval '6 days', 'registro-s7'),
    (v_s8, v_tid, v_student, interval '7 days', 'registro-s8'),
    (v_s9, v_tid, v_student, interval '8 days', 'registro-s9'),
    (v_s10, v_tid, v_student, interval '9 days', 'registro-s10')
  ) as fixture(id, tenant_id, student_id, ago, source_key);

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
  -- s7: aprovada com resumo longo — até os tetos da aprovação (objetivo 2000,
  -- próximo passo/lição 3000, 20 conteúdos de 1200) nada pode ser cortado.
  -- O 16º conteúdo passa do teto de 1200 (só escrito por fora da aprovação):
  -- sai cortado COM reticências.
  select jsonb_agg(item order by position) into v_practiced
  from (
    select 'Conteúdo praticado número ' || n || ' — ' || repeat('detalhe ', 20) as item, n as position
    from generate_series(1, 15) as n
    union all
    select repeat('y', 1300), 16
  ) as items;
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content, created_by)
  values (v_tid, v_s7, 1, 'VERIFIED', 'HUMAN_REVIEW', jsonb_build_object(
    'lesson_objective', v_long_objective,
    'content_practiced', v_practiced,
    'recommended_next_step', v_long_next,
    'homework_assigned', v_long_homework,
    'narrative', 'TEXTO-DAS-ANOTACOES-REVISADO'), v_teacher);
  -- s8: rascunho e REJEIÇÃO como última palavra; s9: rejeição e rascunho novo.
  insert into private.lesson_summary_versions (id, tenant_id, lesson_session_id, version, status, origin, content, created_by)
  values
    (v_v8, v_tid, v_s8, 1, 'PROPOSED', 'GOOGLE_SMART_NOTES', '{"lesson_objective":"RASCUNHO-REJEITADO"}', v_teacher),
    (v_v9, v_tid, v_s9, 1, 'REJECTED', 'HUMAN_REVIEW', '{"lesson_objective":"REJEITADO-ANTES"}', v_teacher);
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, parent_version_id, status, origin, content, created_by)
  values
    (v_tid, v_s8, 2, v_v8, 'REJECTED', 'HUMAN_REVIEW', '{"lesson_objective":"RASCUNHO-REJEITADO"}', v_teacher),
    (v_tid, v_s9, 2, null, 'PROPOSED', 'GEMINI_API', '{"lesson_objective":"RASCUNHO-DEPOIS-DA-REJEICAO"}', v_teacher);

  -- Cópias brutas: s1 com transcrição (40 dias) e presença (50 dias); s2 com
  -- transcrição viva; s3 só com cópia já vencida; s7 só com anotações (30
  -- dias); s8, s9 e s10 com documento vivo.
  insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind,
    document_id, content_sha256, source_text, expires_at) values
    (v_tid, v_s1, 'fixture-s1-transcript', 'TRANSCRIPT', 'docS1',
      encode(extensions.digest('s1', 'sha256'), 'hex'), 'TEXTO-BRUTO-DA-AULA', v_transcript_expires),
    (v_tid, v_s2, 'fixture-s2-transcript', 'TRANSCRIPT', 'docS2',
      encode(extensions.digest('s2', 'sha256'), 'hex'), 'TEXTO-BRUTO-SEM-RESUMO', now() + interval '40 days'),
    (v_tid, v_s3, 'fixture-s3-transcript', 'TRANSCRIPT', 'docS3',
      encode(extensions.digest('s3', 'sha256'), 'hex'), 'TEXTO-BRUTO-VENCIDO', now() - interval '1 day'),
    (v_tid, v_s7, 'fixture-s7-notes', 'SMART_NOTES', 'docS7',
      encode(extensions.digest('s7', 'sha256'), 'hex'), 'ANOTACOES-BRUTAS-DO-GOOGLE', v_notes_expires),
    (v_tid, v_s8, 'fixture-s8-transcript', 'TRANSCRIPT', 'docS8',
      encode(extensions.digest('s8', 'sha256'), 'hex'), 'TEXTO-BRUTO-REJEITADO', now() + interval '40 days'),
    (v_tid, v_s9, 'fixture-s9-notes', 'SMART_NOTES', 'docS9',
      encode(extensions.digest('s9', 'sha256'), 'hex'), 'NOTAS-BRUTAS-S9', now() + interval '40 days'),
    (v_tid, v_s10, 'fixture-s10-transcript', 'TRANSCRIPT', 'docS10',
      encode(extensions.digest('s10', 'sha256'), 'hex'), 'TEXTO-BRUTO-SEM-RASCUNHO', now() + interval '40 days');
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
  -- Um link revogado antigo e o link vivo do aluno, gerado à mão pela direção
  -- (ninguém sabe ainda se ele foi mandado).
  insert into private.lesson_recording_consent_links (id, tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values
    (gen_random_uuid(), v_tid, v_student, encode(extensions.digest('link-antigo-registro', 'sha256'), 'hex'), v_admin,
      now() + interval '20 days', now() - interval '1 day'),
    (v_manual_link, v_tid, v_student, v_token_hash, v_admin, v_link_expires, null);

  -- ---------------------------------------------------------------------
  -- O próprio aluno
  -- ---------------------------------------------------------------------
  v_r := pg_temp.rec_read(v_student);
  perform pg_temp.rec_assert(v_r ->> 'ok' = 'true', 'aluno não leu o próprio registro: ' || v_r::text);
  perform pg_temp.rec_assert(
    jsonb_array_length(v_r -> 'records') = 3
    and (v_r -> 'records' -> 0 ->> 'session_id')::uuid = v_s1
    and (v_r -> 'records' -> 1 ->> 'session_id')::uuid = v_s3
    and (v_r -> 'records' -> 2 ->> 'session_id')::uuid = v_s7,
    'aulas aprovadas erradas ou fora de ordem (mais recente primeiro): ' || (v_r -> 'records')::text);

  v_rec := v_r -> 'records' -> 0;
  perform pg_temp.rec_assert(
    (select array_agg(key order by key) from jsonb_object_keys(v_rec) as key)
    = array['approved_at', 'attendance_until', 'class_date', 'content_practiced', 'homework_assigned',
            'lesson_objective', 'notes_until', 'recommended_next_step', 'scheduled_start_at', 'session_id',
            'teacher_name', 'transcript_until'],
    'registro da aula com campo além (ou aquém) do permitido: ' || v_rec::text);
  perform pg_temp.rec_assert(
    v_rec ->> 'lesson_objective' = 'Pedir comida no restaurante'
    and v_rec -> 'content_practiced' = '["would like", "menu vocabulary"]'::jsonb
    and v_rec ->> 'recommended_next_step' = 'Praticar reclamação educada'
    and v_rec ->> 'homework_assigned' = 'Gravar um áudio pedindo um prato'
    and v_rec ->> 'teacher_name' = 'Professora Registro',
    'resumo aprovado da aula saiu diferente: ' || v_rec::text);
  -- Cada cópia com o próprio prazo: a presença (50 dias) não passa por
  -- validade da transcrição (40 dias).
  perform pg_temp.rec_assert(
    (v_rec ->> 'transcript_until')::timestamptz = v_transcript_expires
    and v_rec -> 'notes_until' = 'null'::jsonb
    and (v_rec ->> 'attendance_until')::timestamptz = v_report_expires,
    'validade das cópias brutas misturada ou errada: ' || v_rec::text);

  v_rec := v_r -> 'records' -> 1;
  perform pg_temp.rec_assert(
    v_rec ->> 'lesson_objective' = 'Objetivo revisado'
    and v_rec ->> 'recommended_next_step' = 'Revisar verbos irregulares'
    and v_rec -> 'content_practiced' = '["past simple"]'::jsonb
    and v_rec ->> 'homework_assigned' is null
    and v_rec -> 'transcript_until' = 'null'::jsonb
    and v_rec -> 'notes_until' = 'null'::jsonb
    and v_rec -> 'attendance_until' = 'null'::jsonb,
    'reaprovação/rejeição posterior ou cópia vencida tratadas errado: ' || v_rec::text);

  -- Resumo longo aprovado chega inteiro; o que passa do teto sai com "…".
  v_rec := v_r -> 'records' -> 2;
  perform pg_temp.rec_assert(
    v_rec ->> 'lesson_objective' = btrim(v_long_objective)
    and v_rec ->> 'recommended_next_step' = btrim(v_long_next)
    and v_rec ->> 'homework_assigned' = btrim(v_long_homework),
    'resumo aprovado chegou cortado ao aluno: objetivo ' || length(v_rec ->> 'lesson_objective')
      || ', próximo passo ' || length(v_rec ->> 'recommended_next_step')
      || ', lição ' || coalesce(length(v_rec ->> 'homework_assigned'), 0));
  perform pg_temp.rec_assert(
    jsonb_array_length(v_rec -> 'content_practiced') = 16
    and v_rec -> 'content_practiced' ->> 14 = btrim(v_practiced ->> 14)
    and length(v_rec -> 'content_practiced' ->> 15) = 1200
    and right(v_rec -> 'content_practiced' ->> 15, 1) = '…',
    'conteúdos praticados cortados sem aviso ou abaixo do teto da aprovação: '
      || jsonb_array_length(v_rec -> 'content_practiced') || ' itens');
  perform pg_temp.rec_assert(
    v_rec -> 'transcript_until' = 'null'::jsonb
    and (v_rec ->> 'notes_until')::timestamptz = v_notes_expires
    and v_rec -> 'attendance_until' = 'null'::jsonb,
    'aula aprovada só das anotações apareceu com validade de transcrição: ' || v_rec::text);

  -- Esperam revisão: s2 (rascunho), s9 (rascunho novo depois da rejeição) e
  -- s10 (documento sem rascunho). s8 foi REJEITADA pelo professor: fora.
  perform pg_temp.rec_assert((v_r ->> 'pending_review')::integer = 3,
    'aulas esperando revisão contadas errado (rejeitada conta? rascunho não conta?): '
      || coalesce(v_r ->> 'pending_review', 'nulo'));

  -- Nenhum texto bruto, rascunho, cartão, token ou aula alheia no retorno.
  v_text := v_r::text;
  foreach v_marker in array array[
    'RASCUNHO-NATIVO', 'RASCUNHO-POSTERIOR', 'RASCUNHO-SEM-APROVACAO', 'NARRATIVA-DO-PROFESSOR',
    'ERRO-RECORRENTE', 'PONTO-FORTE', 'CITACAO-DA-TRANSCRICAO', 'INCERTEZA',
    'TEXTO-BRUTO-DA-AULA', 'TEXTO-BRUTO-SEM-RESUMO', 'TEXTO-BRUTO-VENCIDO', 'CSV-BRUTO',
    'ANOTACOES-BRUTAS-DO-GOOGLE', 'TEXTO-DAS-ANOTACOES-REVISADO', 'TEXTO-BRUTO-REJEITADO',
    'NOTAS-BRUTAS-S9', 'TEXTO-BRUTO-SEM-RASCUNHO', 'RASCUNHO-REJEITADO', 'REJEITADO-ANTES',
    'RASCUNHO-DEPOIS-DA-REJEICAO',
    'OBJETIVO-ANTIGO', 'PASSO-ANTIGO', 'OBJETIVO-REJEITADO', 'OBJETIVO-DO-COLEGA',
    'OBJETIVO-DE-OUTRA-ESCOLA', 'Objetivo da escola B', 'OBJETIVO-DO-CARTAO', 'TEMA-DO-CARTAO',
    v_token_hash, 'token-fixture-registro-aluno'
  ] loop
    perform pg_temp.rec_assert(position(v_marker in v_text) = 0,
      'o registro do aluno vazou "' || v_marker || '"');
  end loop;

  -- Link gerado à mão que ninguém abriu: não se sabe se chegou → sem validade
  -- (a tela manda pedir à escola, em vez de falar de um link que talvez não exista).
  perform pg_temp.rec_assert(
    v_r -> 'consent' ->> 'status' = 'AUTHORIZED'
    and v_r -> 'consent' ->> 'signer_relation' = 'GUARDIAN'
    and (v_r -> 'consent' ->> 'requires_guardian')::boolean
    and v_r -> 'consent' ->> 'guardian_reason' = private.lesson_recording_guardian_reason(v_student)
    and v_r -> 'consent' -> 'link_expires_at' = 'null'::jsonb,
    'situação do termo do aluno errada (link não aberto apareceu como enviado?): ' || (v_r -> 'consent')::text);
  perform pg_temp.rec_assert(
    v_r -> 'term' ->> 'version' = v_term_version
    and length(v_r -> 'term' ->> 'body') > 100,
    'termo vigente não veio junto');
  perform pg_temp.rec_assert(
    v_r ->> 'school_name' = 'Escola Registro Fixture'
    and v_r ->> 'school_whatsapp' = '11988887777',
    'contato da escola errado: ' || coalesce(v_r ->> 'school_name', 'nulo') || ' / ' || coalesce(v_r ->> 'school_whatsapp', 'nulo'));

  -- A família abriu o link: agora se sabe que chegou.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update private.lesson_recording_consent_links
     set first_opened_at = now(), last_opened_at = now()
   where id = v_manual_link;
  v_r := pg_temp.rec_read(v_student);
  perform pg_temp.rec_assert(
    (v_r -> 'consent' ->> 'link_expires_at')::timestamptz = v_link_expires,
    'link aberto pela família não apareceu: ' || (v_r -> 'consent')::text);

  -- Revogação pela escola: a tela passa a dizer que está revogado.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision,
    signer_name, signer_relation, source, recorded_by, reason)
  values (v_tid, v_student, 'STUDENT', 'REVOKED', 'Direção Registro', 'SCHOOL', 'SCHOOL', v_admin,
          'pedido do aluno pelo WhatsApp');
  v_r := pg_temp.rec_read(v_student);
  perform pg_temp.rec_assert(v_r -> 'consent' ->> 'status' = 'REVOKED',
    'revogação não aparece para o aluno: ' || (v_r -> 'consent')::text);
  perform pg_temp.rec_assert(jsonb_array_length(v_r -> 'records') = 3,
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
    position('Pedir comida' in v_r::text) = 0 and position('Objetivo revisado' in v_r::text) = 0
    and position('Objetivo longo aprovado' in v_r::text) = 0,
    'colega viu o resumo do aluno');
  perform pg_temp.rec_assert(
    v_r -> 'consent' ->> 'status' = 'NOT_EFFECTIVE'
    and v_r -> 'consent' -> 'link_expires_at' = 'null'::jsonb,
    'aceite sem código apareceu como válido para o colega: ' || (v_r -> 'consent')::text);

  -- Envio em lote para o colega: o link nasce quando a mensagem ENTRA na fila.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into private.lesson_recording_consent_links (id, tenant_id, student_id, token_hash, created_by, expires_at)
  values (v_batch_link, v_tid, v_classmate, encode(extensions.digest('link-lote-registro', 'sha256'), 'hex'),
          v_admin, v_batch_expires);
  insert into public.notification_queue (id, tenant_id, student_id, student_name, student_phone, message_body,
    scheduled_for, next_attempt_at, status, source_id, source_type, notification_kind, idempotency_key)
  values (v_notification, v_tid, v_classmate, 'Fixture Registro', '5511977776666', 'Mensagem do termo (fixture)',
          now() + interval '12 hours', now() + interval '12 hours', 'pending', v_request,
          'LESSON_RECORDING_CONSENT', 'LESSON_RECORDING_CONSENT_REQUEST',
          'lesson-recording-consent:' || v_classmate::text || ':' || v_term_version || ':1');
  insert into private.lesson_recording_consent_requests (id, tenant_id, student_id, term_version, attempt,
    batch_id, link_id, notification_id, recipient, destination, message_sha256, requested_by, scheduled_for)
  values (v_request, v_tid, v_classmate, v_term_version, 1, gen_random_uuid(), v_batch_link, v_notification,
          'STUDENT', '5511977776666', encode(extensions.digest('Mensagem do termo (fixture)', 'sha256'), 'hex'),
          v_admin, now() + interval '12 hours');
  v_r := pg_temp.rec_read(v_classmate);
  perform pg_temp.rec_assert(v_r -> 'consent' -> 'link_expires_at' = 'null'::jsonb,
    'link ainda na fila apareceu como "o link que a escola mandou": ' || (v_r -> 'consent')::text);

  -- A mensagem não saiu (NOT_SENT): o link continua vivo, mas não chegou.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.notification_queue
     set status = 'skipped', delivery_status = 'skipped', last_error = 'contato_mudou'
   where id = v_notification;
  v_r := pg_temp.rec_read(v_classmate);
  perform pg_temp.rec_assert(v_r -> 'consent' -> 'link_expires_at' = 'null'::jsonb,
    'link de mensagem que não saiu apareceu como enviado: ' || (v_r -> 'consent')::text);

  -- O provedor aceitou a mensagem: chegou.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.notification_queue
     set status = 'sent', delivery_status = 'accepted', accepted_at = now(), last_error = null
   where id = v_notification;
  v_r := pg_temp.rec_read(v_classmate);
  perform pg_temp.rec_assert(
    (v_r -> 'consent' ->> 'link_expires_at')::timestamptz = v_batch_expires,
    'link de mensagem aceita pelo provedor não apareceu: ' || (v_r -> 'consent')::text);

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
  perform pg_temp.rec_assert(jsonb_array_length(v_r -> 'records') = 3,
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
