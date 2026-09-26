-- Termo de registro das aulas v3, aceite por versão e retenção da memória das
-- aulas (migration 20260927100000).
--
-- 1. O texto v3 (aluno e professor) existe, identifica o controlador só por
--    marcadores ({escola_nome}, {escola_documento},
--    {escola_contato_privacidade}) e não carrega dado da escola no código.
-- 2. Os marcadores são preenchidos com os dados da própria escola
--    (tenants.school_info), com texto neutro quando falta algo, e chegam à
--    página pública, ao cartão do professor e ao painel da direção.
-- 3. Aceite de versão anterior à vigente não vale (aluno E professor): a
--    página e o cartão dizem "o termo mudou", o painel mostra, o envio em lote
--    trata como pendente, o job desmarca a aula que ele tinha marcado com o
--    motivo certo — e o aceite da versão nova volta a marcar.
-- 4. Retenção: rascunho não aprovado perde o texto bruto 90 dias depois da
--    aula; quem deixou a escola há mais de 90 dias perde a memória
--    MEET_SESSION, o cartão e o conteúdo dos resumos; a trilha só tem
--    contagens; a segunda rodada não apaga nada.
--
-- Reprova contra o código anterior: sem a v3 (bloco 1), sem a identidade da
-- escola (bloco 2), com o aceite de versão antiga ainda valendo (bloco 3) e sem
-- a função de retenção (bloco 4). Não depende de dado real, da fila global nem
-- do horário do dia (as datas são relativas a now()).
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

-- Decisão do professor como o cartão grava.
create or replace function pg_temp.v3_teacher_decision(
  p_tenant text, p_teacher uuid, p_decision text, p_version text
) returns void language plpgsql as $$
begin
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, recorded_by)
  values (p_tenant, p_teacher, 'TEACHER', p_decision, 'Professora Fixture', 'SELF', 'TEACHER', p_version, 'APP', p_teacher);
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
      v_row.audience || ' v3 tem marcador que a página não sabe preencher'
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
begin
  insert into public.tenants (id, name, saas_status, school_info) values
    ('v3-termo-fixture', 'Escola Fixture', 'active', jsonb_build_object(
      'name', 'Escola Fixture',
      'legalName', '  Escola Fixture   Idiomas LTDA ',
      'cnpj', '11222333000181',
      'privacyContactEmail', 'privacidade@escola-fixture.invalid',
      'privacyOfficerName', 'Encarregada Fixture')),
    ('v3-termo-vazia', 'Escola Sem Dados', 'active', null);

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
  -- Função interna: navegador não chama.
  perform pg_temp.v3_assert(
    not has_function_privilege('anon', 'private.lesson_recording_school_identity(text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.lesson_recording_school_identity(text)', 'EXECUTE'),
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
  v_session uuid := gen_random_uuid();
  v_old_student text := (private.lesson_recording_current_term('STUDENT')).version;
  v_old_teacher text := (private.lesson_recording_current_term('TEACHER')).version;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_row jsonb;
  v_roster record;
  v_reason text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'v3-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'v3-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student, 'v3-student@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_refused, 'v3-refused@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'v3-termo-fixture', lifecycle_status = 'active', status = 'Ativo',
         is_test_account = false,
         role = case when id = v_admin then 'SCHOOL_ADMIN' when id = v_teacher then 'TEACHER' else 'STUDENT' end,
         full_name = case when id = v_admin then 'Direcao Fixture' when id = v_teacher then 'Professora Fixture'
           when id = v_student then 'Aluna Fixture' else 'Aluno Recusou Fixture' end,
         phone = case when id in (v_student, v_refused) then '5511977771234' end,
         professor_id = case when id in (v_student, v_refused) then v_teacher end,
         birth_date = null, is_kids = false
   where id in (v_admin, v_teacher, v_student, v_refused);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id in (v_admin, v_teacher, v_student, v_refused)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
  values ('v3-termo-fixture', 'v3-sub-central', 'central@escola-fixture.invalid', 'CONNECTED', v_admin);
  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key) values
    (v_session, 'v3-termo-fixture', v_student, v_teacher, v_today,
      now() + interval '2 hours', now() + interval '150 minutes', 'v3-future');
  -- Link vivo para a página pública.
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at)
  values ('v3-termo-fixture', v_student, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_admin,
    now() + interval '30 days');

  -- Os dois aceitam a versão vigente: vale, e o job marca a aula.
  perform pg_temp.v3_student_decision('v3-termo-fixture', v_student, v_admin, 'ACCEPTED', v_old_student);
  perform pg_temp.v3_student_decision('v3-termo-fixture', v_refused, v_admin, 'REFUSED', v_old_student);
  perform pg_temp.v3_teacher_decision('v3-termo-fixture', v_teacher, 'ACCEPTED', v_old_teacher);
  perform pg_temp.v3_assert(private.lesson_recording_active(v_student, v_teacher),
    'aceite da versão vigente não valeu');
  perform private.apply_standing_lesson_recording_consent('v3-termo-fixture');
  perform pg_temp.v3_assert((select documentation_consent from public.lesson_sessions where id = v_session),
    'os dois aceites não marcaram a aula');

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
  -- Na hora, sem esperar o job: a sessão marcada pelo termo fica sem aceite efetivo.
  perform pg_temp.v3_assert(private.lesson_session_documentation_blocked(v_session),
    'sessão marcada pelo termo antigo seguiu com aceite efetivo');

  -- Página pública: "o termo mudou", a versão aceita e quem é a escola.
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

  -- Cartão do professor.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_result := public.get_my_lesson_recording_consent();
  perform pg_temp.v3_assert(
    v_result ->> 'decision' = 'ACCEPTED'
      and (v_result ->> 'term_updated')::boolean
      and not (v_result ->> 'effective')::boolean
      and v_result ->> 'decided_term_version' = v_old_teacher
      and v_result ->> 'term_version' = 'v98'
      and v_result -> 'school_identity' ->> 'escola_nome' = 'Escola Fixture Idiomas LTDA',
    'cartão do professor não disse que o termo mudou: ' || v_result::text
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

  -- O job desmarca o que ele tinha marcado, com o motivo certo.
  perform private.apply_standing_lesson_recording_consent('v3-termo-fixture');
  select event.reason into v_reason from private.lesson_documentation_consent_events as event
   where event.session_id = v_session order by event.created_at desc limit 1;
  perform pg_temp.v3_assert(
    not (select documentation_consent from public.lesson_sessions where id = v_session)
      and v_reason like 'Termo de registro das aulas: o termo mudou de versão e o aluno (ou o responsável) e o professor%',
    'o job não desmarcou a aula do termo antigo, ou registrou o motivo errado: ' || coalesce(v_reason, 'sem evento')
  );

  -- Aceitam a versão nova: vale de novo e o job remarca.
  perform pg_temp.v3_student_decision('v3-termo-fixture', v_student, v_admin, 'ACCEPTED', 'v98');
  perform pg_temp.v3_teacher_decision('v3-termo-fixture', v_teacher, 'ACCEPTED', 'v98');
  perform pg_temp.v3_assert(private.lesson_recording_active(v_student, v_teacher),
    'aceite da versão nova não valeu');
  perform private.apply_standing_lesson_recording_consent('v3-termo-fixture');
  perform pg_temp.v3_assert(
    (select documentation_consent from public.lesson_sessions where id = v_session)
      and not private.lesson_session_documentation_blocked(v_session),
    'aceite da versão nova não remarcou a aula'
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
end
$version$;

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
    'recommended_next_step', 'Revisar os verbos');
  v_left timestamptz := now() - interval '100 days';
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

  -- (a) Rascunho não aprovado de aula com mais de 90 dias perde o texto bruto.
  perform pg_temp.v3_assert(
    (select not (content ? 'narrative') and not (content ? 'evidence')
        and content ->> 'lesson_objective' = 'Present perfect'
        and content ? 'retention_raw_text_removed_at'
      from private.lesson_summary_versions where id = v_keep_old_draft),
    'rascunho não aprovado de aula antiga manteve o texto copiado da aula'
  );
  perform pg_temp.v3_assert(
    (select content = v_content from private.lesson_summary_versions where id = v_keep_old_verified)
      and (select content = v_content from private.lesson_summary_versions where id = v_keep_new_draft),
    'retenção mexeu no resumo aprovado de aluno ativo ou no rascunho de aula recente'
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
    (select content = v_content from private.lesson_summary_versions where id = v_recent_verified),
    'resumo de quem saiu há menos de 90 dias foi apagado'
  );
  perform pg_temp.v3_assert(
    exists (select 1 from private.student_learning_card_events
      where student_id = v_gone and actor_role = 'SYSTEM_RETENTION'),
    'histórico do cartão sem a remoção pela retenção'
  );

  -- (c) Trilha só com contagens, uma linha por escola.
  select * into v_trail from private.lesson_memory_retention_runs
   where tenant_id = 'v3-termo-fixture' and run_id = (v_result ->> 'run_id')::uuid;
  perform pg_temp.v3_assert(
    v_trail.drafts_cleared = 2 and v_trail.summaries_cleared = 2
      and v_trail.memories_deleted = 1 and v_trail.cards_deleted = 1,
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
    (v_result ->> 'drafts_cleared')::integer = 0 and (v_result ->> 'summaries_cleared')::integer = 0
      and (v_result ->> 'memories_deleted')::integer = 0 and (v_result ->> 'cards_deleted')::integer = 0
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
