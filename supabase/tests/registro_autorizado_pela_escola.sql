-- Registro das aulas autorizado pela ESCOLA (migration 20260929100000).
--
-- Decisão da direção de 27/09/2026: a escola autoriza o registro das aulas; cada
-- pessoa pode pedir para não ser registrada. Este teste prova:
--
-- 0. O aviso v4 (aluno e professor) existe como AVISO (kind NOTICE), com os
--    marcadores do controlador, o mesmo conteúdo factual do v3 e o direito de
--    pedir para não ser registrado — sem "autorizo"; e ele NÃO vira o termo
--    vigente do aceite individual (a publicação não derruba aceite de ninguém).
-- 1. Modo individual (escola sem linha) idêntico ao anterior: sem aceite não
--    vale; aceite da versão vigente vale; link e envio seguem; desfazer não
--    existe ali.
-- 2. Só a direção troca o modo, com motivo e trilha; e a troca vale na hora.
-- 3. Modo da escola: aluno adulto, aluno MENOR (sem responsável) e professor
--    ativos valem sem link, sem código e sem versão; inativo não; o job marca a
--    aula das próximas 24 h dizendo que foi a escola; a IA (resumo e sugestões
--    do cartão) e o professor substituto seguem o modo; o menor continua com o
--    cartão restrito.
-- 4. O pedido para não registrar (direção, página pública, professor no app)
--    tira na hora: sala desligada (DISABLE_ARTIFACTS), fora do app, aula barrada,
--    IA e sugestões fora; a aula que terminou antes do pedido não é barrada; e o
--    "desfazer" devolve — só pela direção (a coordenação não), e o pedido que o
--    próprio professor fez no app só ele desfaz.
-- 5. No modo da escola não há link nem envio em lote (recusa no servidor), a
--    página pública mostra o aviso e só grava o pedido para não registrar, e o
--    pedido que estava na fila é cancelado na hora de sair.
-- 6. A escola voltando ao aceite individual: a aula futura marcada pelo padrão
--    cai com o motivo certo; a que terminou antes da troca segue importável.
-- 7. Central de Pendências: professor sem conta Google confirmada (só no modo
--    da escola).
-- Também: no modo da escola o job não marca (nem congela) a aula do professor
-- sem conta Google — marca depois que ele confirma; "Sala e resumo" da aula
-- passada a outro professor e a data de nascimento dizem o modo; o link
-- revogado diz o modo (a página não manda pedir link novo); a rota do modo
-- para os tours.
-- 8. One-shot da Wise Wolf com trilha (quem, quando, motivo, base).
--
-- Reprova contra o código anterior (sem o modo, o aluno sem aceite não vale; sem
-- a trava, o link sai; sem o aviso, o texto é o termo). Não depende de dado real
-- (as datas são relativas a now()); onde a Wise Wolf existe, confere só os
-- campos imutáveis da trilha do one-shot — nunca o papel ATUAL de quem decidiu.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.rad_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'registro autorizado pela escola: %', p_message;
  end if;
end;
$$;
grant execute on function pg_temp.rad_assert(boolean, text) to public;

create temp table rad_ids (key text primary key, id uuid not null) on commit drop;
grant all on rad_ids to public;
create or replace function pg_temp.rad(p_key text)
returns uuid language sql as $$ select id from rad_ids where key = p_key $$;
grant execute on function pg_temp.rad(text) to public;

-- Chama uma RPC como a pessoa logada e devolve o erro (texto) quando recusa.
create or replace function pg_temp.rad_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;
create or replace function pg_temp.rad_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;

create or replace function pg_temp.rad_error(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

-- O banco de teste pode vir só com a estrutura: termos antigos (em produção a
-- v1–v3 já existem) para o aceite individual ter uma versão vigente.
insert into private.lesson_recording_terms (audience, version, body, published_at) values
  ('STUDENT', 'v1', repeat('Termo antigo do aluno (teste do modo da escola). ', 10), now() - interval '5 days'),
  ('TEACHER', 'v1', repeat('Termo antigo do professor (teste do modo da escola). ', 10), now() - interval '5 days')
on conflict (audience, version) do nothing;

-- ===== 0. O aviso v4 =======================================================
do $notice$
declare
  v_row record;
begin
  perform pg_temp.rad_assert(
    (select count(*) = 2 from private.lesson_recording_terms where version = 'v4' and kind = 'NOTICE'),
    'aviso v4 (aluno e professor) ausente ou publicado como termo de aceite');
  for v_row in select * from private.lesson_recording_terms where version = 'v4' loop
    perform pg_temp.rad_assert(
      v_row.body like '%{escola_nome}%' and v_row.body like '%{escola_documento}%'
        and v_row.body like '%{escola_contato_privacidade}%'
        and not exists (
          select 1 from regexp_matches(v_row.body, '\{([^}]*)\}', 'g') as marker(parts)
          where marker.parts[1] not in ('escola_nome', 'escola_documento', 'escola_contato_privacidade')),
      v_row.audience || ' v4 sem os marcadores do controlador (ou com marcador desconhecido)');
    perform pg_temp.rad_assert(
      v_row.body !~ '[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}' and v_row.body !~ '@'
        and v_row.body !~ '[0-9]{8,}',
      v_row.audience || ' v4 traz dado da escola escrito no texto');
    -- Mesmo conteúdo factual do v3.
    perform pg_temp.rad_assert(
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
        and v_row.body like '%suporte técnico do fornecedor do sistema%',
      v_row.audience || ' v4 perdeu parte do conteúdo factual do v3');
    -- É aviso: faz parte das aulas, dá para pedir para não registrar, sem aceite.
    perform pg_temp.rad_assert(
      v_row.body like '%faz parte d%'
        and v_row.body like '%pedir para não ser registrado%'
        and v_row.body ilike '%a qualquer momento%'
        and v_row.body !~* 'autorizo' and v_row.body !~* 'li e ',
      v_row.audience || ' v4 não é aviso (pede aceite ou não diz como pedir para não registrar)');
  end loop;
  perform pg_temp.rad_assert(
    (select body like '%sem prejuízo das aulas%' and body like '%responsável legal%'
       from private.lesson_recording_terms where audience = 'STUDENT' and version = 'v4')
    and (select body like '%sem prejuízo das suas aulas nem do seu pagamento%'
           and body like '%confirma, por login, a conta Google%'
       from private.lesson_recording_terms where audience = 'TEACHER' and version = 'v4'),
    'aviso v4 sem o "sem prejuízo" (aluno/professor), o responsável do menor ou a conta Google do professor');

  -- O aviso não vira o termo vigente do aceite individual.
  perform pg_temp.rad_assert(
    (private.lesson_recording_current_term('STUDENT')).kind = 'TERM'
      and (private.lesson_recording_current_term('TEACHER')).kind = 'TERM'
      and (private.lesson_recording_current_term('STUDENT')).version <> 'v4'
      and (private.lesson_recording_current_notice('STUDENT')).version = 'v4'
      and (private.lesson_recording_current_notice('TEACHER')).version = 'v4'
      and not private.lesson_recording_term_covers('STUDENT', 'v4', now()),
    'o aviso virou o termo vigente do aceite individual (derrubaria os aceites)');

  -- Rotas: internas fechadas; as novas do app só para quem está logado.
  perform pg_temp.rad_assert(
    not has_function_privilege('anon', 'private.lesson_recording_authorization_mode(text)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.lesson_recording_authorization_mode(text)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.lesson_recording_school_default_at(uuid,timestamp with time zone)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.lesson_recording_school_default_decision_20260927(text)', 'EXECUTE')
      and not has_table_privilege('authenticated', 'private.lesson_recording_authorization_modes', 'SELECT')
      and has_function_privilege('authenticated', 'public.set_lesson_recording_authorization_mode(text,text)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.set_lesson_recording_authorization_mode(text,text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.withdraw_lesson_recording_objection(uuid,text)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.withdraw_lesson_recording_objection(uuid,text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.my_lesson_recording_authorization_mode()', 'EXECUTE')
      and not has_function_privilege('anon', 'public.my_lesson_recording_authorization_mode()', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.lesson_recording_objection_by_self(uuid)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'private.lesson_session_last_handover(uuid)', 'EXECUTE'),
    'permissões das rotas do modo da escola erradas');
  -- O job: no modo da escola só marca com a conta Google, e o motivo da aula
  -- passada a quem não está pronto não fala de aceite (remendos por âncora).
  perform pg_temp.rad_assert(
    pg_get_functiondef('private.apply_standing_lesson_recording_consent(text)'::regprocedure)
        like '%só marca com a conta Google (20260929100000)%'
      and pg_get_functiondef('private.apply_standing_lesson_recording_consent(text)'::regprocedure)
        like '%pediu para não ter as aulas registradas ou não está ativo na escola%'
      and pg_get_functiondef('private.apply_standing_lesson_recording_consent(text)'::regprocedure)
        like '%registro autorizado pela escola (ninguém da aula pediu para não ser registrado)%',
    'o job perdeu um dos remendos do modo da escola');
  -- Rota que devolve o texto (termo ou aviso) passa por fill_term.
  perform pg_temp.rad_assert(not exists (
      select 1 from pg_proc as procedure
      join pg_namespace as namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.prosrc ~ 'lesson_recording_(text_for|current_notice)'
        and procedure.prosrc ~ '\mbody\M'
        and procedure.prosrc !~ 'lesson_recording_fill_term'),
    'rota devolve o aviso sem preencher a escola');
end
$notice$;

-- ===== Fixture ===============================================================
do $fixture$
declare
  v_key text;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  foreach v_key in array array['admin', 'coord', 'teacher', 'sub', 'noid', 'adult', 'kid', 'inactive',
    'page', 'ind_admin', 'ind_teacher', 'ind_student',
    's_future', 's_past', 's_kid', 's_noid', 's_ind'] loop
    insert into rad_ids values (v_key, gen_random_uuid());
  end loop;

  perform pg_temp.rad_service();
  insert into public.tenants (id, name) values
    ('rad-escola', 'Escola Padrão Fixture'),
    ('rad-individual', 'Escola Individual Fixture');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  select id, 'rad-' || key || '@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'
  from rad_ids where key not like 's\_%';
  update public.profiles as profile
     set tenant_id = case when ids.key like 'ind\_%' then 'rad-individual' else 'rad-escola' end,
         lifecycle_status = case when ids.key = 'inactive' then 'suspended' else 'active' end,
         status = 'Ativo', is_test_account = false,
         role = case
           when ids.key in ('admin', 'ind_admin') then 'SCHOOL_ADMIN'
           when ids.key = 'coord' then 'COORDINATOR'
           when ids.key in ('teacher', 'sub', 'noid', 'ind_teacher') then 'TEACHER'
           else 'STUDENT' end,
         full_name = case ids.key
           when 'admin' then 'Direcao Padrao Fixture' when 'coord' then 'Coordenacao Fixture'
           when 'teacher' then 'Professora Padrao Fixture' when 'sub' then 'Substituta Padrao Fixture'
           when 'noid' then 'Professor Sem Conta Fixture' when 'adult' then 'Aluna Adulta Fixture'
           when 'kid' then 'Crianca Fixture' when 'inactive' then 'Aluno Inativo Fixture'
           when 'page' then 'Aluno Pagina Fixture' when 'ind_admin' then 'Direcao Individual Fixture'
           when 'ind_teacher' then 'Professor Individual Fixture' else 'Aluno Individual Fixture' end,
         phone = case ids.key when 'page' then '5511955550123' when 'adult' then '5511955550124' end,
         is_kids = (ids.key = 'kid'),
         birth_date = null
    from rad_ids as ids
   where profile.id = ids.id and ids.key not like 's\_%';
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
  select profile.tenant_id, profile.id, profile.role, 'ACTIVE'
  from public.profiles as profile join rad_ids as ids on ids.id = profile.id
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
  values ('rad-escola', 'rad-sub-central', 'central@escola-padrao.invalid', 'CONNECTED', pg_temp.rad('admin')),
         ('rad-individual', 'rad-sub-central-ind', 'central@escola-ind.invalid', 'CONNECTED', pg_temp.rad('ind_admin'));
  -- Conta Google confirmada: professora e substituta sim; "noid" não.
  insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified) values
    (pg_temp.rad('teacher'), 'rad-escola', 'rad-sub-prof', 'prof.padrao@example.com', true),
    (pg_temp.rad('sub'), 'rad-escola', 'rad-sub-subst', 'subst.padrao@example.com', true),
    (pg_temp.rad('ind_teacher'), 'rad-individual', 'rad-sub-ind', 'prof.ind@example.com', true);
  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key) values
    (pg_temp.rad('s_future'), 'rad-escola', pg_temp.rad('adult'), pg_temp.rad('teacher'), v_today,
      now() + interval '2 hours', now() + interval '150 minutes', 'rad-future'),
    (pg_temp.rad('s_past'), 'rad-escola', pg_temp.rad('adult'), pg_temp.rad('teacher'), v_today,
      now() - interval '90 minutes', now() - interval '60 minutes', 'rad-past'),
    (pg_temp.rad('s_kid'), 'rad-escola', pg_temp.rad('kid'), pg_temp.rad('teacher'), v_today,
      now() + interval '3 hours', now() + interval '210 minutes', 'rad-kid'),
    (pg_temp.rad('s_noid'), 'rad-escola', pg_temp.rad('page'), pg_temp.rad('noid'), v_today,
      now() + interval '4 hours', now() + interval '270 minutes', 'rad-noid'),
    (pg_temp.rad('s_ind'), 'rad-individual', pg_temp.rad('ind_student'), pg_temp.rad('ind_teacher'), v_today,
      now() + interval '2 hours', now() + interval '150 minutes', 'rad-ind');
end
$fixture$;

-- ===== 1. Modo individual: nada muda ========================================
do $individual$
declare
  v_student uuid := pg_temp.rad('ind_student');
  v_teacher uuid := pg_temp.rad('ind_teacher');
  v_term_student text := (private.lesson_recording_current_term('STUDENT')).version;
  v_term_teacher text := (private.lesson_recording_current_term('TEACHER')).version;
  v_link uuid;
  v_challenge uuid := gen_random_uuid();
  v_result jsonb;
begin
  perform pg_temp.rad_assert(
    private.lesson_recording_authorization_mode('rad-individual') = 'INDIVIDUAL_CONSENT'
      and private.lesson_recording_authorization_mode('rad-escola') = 'INDIVIDUAL_CONSENT',
    'escola sem decisão registrada não está no aceite individual');
  perform pg_temp.rad_assert(
    not private.lesson_recording_student_consent_effective(v_student)
      and not private.lesson_recording_teacher_consent_effective(v_teacher)
      and not private.lesson_recording_active(v_student, v_teacher)
      -- A escola ainda individual: ninguém vale sem aceite.
      and not private.lesson_recording_student_consent_effective(pg_temp.rad('adult'))
      and not private.lesson_recording_teacher_consent_effective(pg_temp.rad('teacher')),
    'sem aceite, o registro valeu no modelo individual');

  -- Professor aceita pelo cartão: a versão lida é o TERMO (não o aviso).
  perform pg_temp.rad_as(v_teacher);
  v_result := public.get_my_lesson_recording_consent();
  perform pg_temp.rad_assert(
    v_result ->> 'authorization_mode' = 'INDIVIDUAL_CONSENT' and v_result ->> 'term_version' = v_term_teacher
      and v_result ->> 'term_kind' = 'TERM',
    'o cartão do professor no modelo individual não mostra o termo vigente: ' || v_result::text);
  perform pg_temp.rad_assert(
    pg_temp.rad_error('select public.set_my_lesson_recording_consent(true, ''v4'')') like '%termo_mudou%',
    'aceite do aviso v4 valeu como aceite individual');
  v_result := public.set_my_lesson_recording_consent(true, v_term_teacher);
  perform pg_temp.rad_assert(v_result ->> 'decision' = 'ACCEPTED' and v_result ->> 'term_version' = v_term_teacher,
    'aceite do professor com o termo vigente não gravou: ' || v_result::text);

  -- Aluno aceita pelo link com o código (como a página grava).
  perform pg_temp.rad_service();
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values ('rad-individual', v_student, encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'),
    pg_temp.rad('ind_admin'), now() + interval '1 day', now())
  returning id into v_link;
  insert into private.lesson_recording_consent_challenges (id, link_id, tenant_id, student_id, relation, destination,
    code_hash, delivery_status, expires_at, consumed_at)
  values (v_challenge, v_link, 'rad-individual', v_student, 'GUARDIAN', '5511900008888',
    encode(extensions.digest(v_challenge::text, 'sha256'), 'hex'), 'SENT', now() + interval '10 minutes', now());
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, link_id, verification, verified_phone,
    verification_challenge_id)
  values ('rad-individual', v_student, 'STUDENT', 'ACCEPTED', 'Responsavel Individual', 'GUARDIAN', 'STUDENT',
    v_term_student, 'LINK', v_link, 'WHATSAPP_CODE', '(11) •••••-8888', v_challenge);
  perform pg_temp.rad_assert(
    private.lesson_recording_active(v_student, v_teacher)
      and not private.lesson_recording_accepted_outdated_term(v_student)
      and not private.lesson_recording_accepted_outdated_term(v_teacher),
    'aceite da versão vigente não valeu (ou o aviso v4 o derrubou)');
  perform private.apply_standing_lesson_recording_consent('rad-individual');
  perform pg_temp.rad_assert(
    (select documentation_consent from public.lesson_sessions where id = pg_temp.rad('s_ind'))
      and exists (select 1 from private.lesson_documentation_consent_events
        where session_id = pg_temp.rad('s_ind') and allowed
          and reason = 'Termo de registro das aulas: aluno (ou responsável) e professor aceitaram o registro permanente.'),
    'o job do modelo individual não marcou a aula (ou mudou o motivo)');

  -- Desfazer é só do modo da escola; link segue no individual.
  perform pg_temp.rad_as(pg_temp.rad('ind_admin'));
  perform pg_temp.rad_assert(
    public.my_lesson_recording_authorization_mode() = 'INDIVIDUAL_CONSENT'
      and public.get_student_birth_date_record(v_student) ->> 'authorization_mode' = 'INDIVIDUAL_CONSENT',
    'o modo individual não chega aos tours ou à data de nascimento');
  perform pg_temp.rad_assert(
    pg_temp.rad_error(format('select public.withdraw_lesson_recording_objection(%L, %L)', v_student,
      'Pedido da família pelo WhatsApp')) like '%so_no_registro_autorizado_pela_escola%',
    'desfazer pedido existiu no modelo individual');
  perform pg_temp.rad_assert(
    (public.create_lesson_recording_consent_link(v_student) ->> 'ok')::boolean,
    'o link do termo deixou de sair no modelo individual');
  perform pg_temp.rad_service();
end
$individual$;

-- ===== 2. Só a direção troca o modo, com trilha ==============================
do $switch$
declare
  v_result jsonb;
  v_row private.lesson_recording_authorization_modes;
begin
  -- Link criado ANTES da troca (a família ainda pode abri-lo depois).
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform public.set_student_birth_date(pg_temp.rad('page'), date '1990-05-10', 'Documento conferido (fixture)');
  perform set_config('rad.page_token', public.create_lesson_recording_consent_link(pg_temp.rad('page')) ->> 'token', true);

  perform pg_temp.rad_as(pg_temp.rad('teacher'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error('select public.set_lesson_recording_authorization_mode(''SCHOOL_DEFAULT'', ''A escola decidiu autorizar'')')
      like '%somente_a_direcao%', 'professor trocou o modo da escola');
  perform pg_temp.rad_as(pg_temp.rad('coord'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error('select public.set_lesson_recording_authorization_mode(''SCHOOL_DEFAULT'', ''A escola decidiu autorizar'')')
      like '%somente_a_direcao%', 'coordenação trocou o modo da escola');
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error('select public.set_lesson_recording_authorization_mode(''SCHOOL_DEFAULT'', ''curto'')')
      like '%informe_o_motivo%', 'troca de modo sem motivo passou');
  perform pg_temp.rad_assert(
    pg_temp.rad_error('select public.set_lesson_recording_authorization_mode(''QUALQUER'', ''Motivo longo o bastante'')')
      like '%modo_invalido%', 'modo inválido passou');
  v_result := public.set_lesson_recording_authorization_mode('SCHOOL_DEFAULT',
    'Contrato novo com cláusula do registro; decisão da direção de 27/09.');
  perform pg_temp.rad_assert((v_result ->> 'ok')::boolean and v_result ->> 'mode' = 'SCHOOL_DEFAULT',
    'a direção não trocou o modo: ' || v_result::text);
  v_result := public.set_lesson_recording_authorization_mode('SCHOOL_DEFAULT', 'Clique repetido da direção.');
  perform pg_temp.rad_assert((v_result ->> 'unchanged')::boolean, 'troca repetida gravou outra linha');
  perform pg_temp.rad_service();

  select * into v_row from private.lesson_recording_authorization_modes where tenant_id = 'rad-escola';
  perform pg_temp.rad_assert(
    (select count(*) = 1 from private.lesson_recording_authorization_modes where tenant_id = 'rad-escola')
      and v_row.mode = 'SCHOOL_DEFAULT' and v_row.decided_by = pg_temp.rad('admin')
      and v_row.decided_by_name = 'Direcao Padrao Fixture'
      and v_row.reason like 'Contrato novo com cláusula%'
      and v_row.legal_basis = 'SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT'
      and v_row.source = 'APP' and v_row.decided_on = (now() at time zone 'America/Sao_Paulo')::date,
    'trilha da troca de modo incompleta');
  perform pg_temp.rad_assert(
    private.lesson_recording_authorization_mode('rad-escola') = 'SCHOOL_DEFAULT'
      and private.lesson_recording_authorization_mode('rad-individual') = 'INDIVIDUAL_CONSENT',
    'a troca de modo vazou para outra escola');
  -- A troca vale na hora: o job rodou e marcou a aula das próximas 24 h.
  perform pg_temp.rad_assert(
    (select documentation_consent from public.lesson_sessions where id = pg_temp.rad('s_future'))
      and exists (select 1 from private.lesson_documentation_consent_events
        where session_id = pg_temp.rad('s_future') and allowed
          and reason like 'Termo de registro das aulas: registro autorizado pela escola%'),
    'a troca de modo não marcou a aula futura, ou o motivo não diz que foi a escola');
  -- Professor sem conta Google: a autorização da escola vale, mas sem conta não
  -- há sala — a aula dele não é marcada nem congelada (segue a agenda).
  perform pg_temp.rad_assert(
    private.lesson_recording_teacher_consent_effective(pg_temp.rad('noid'))
      and not (select documentation_consent from public.lesson_sessions where id = pg_temp.rad('s_noid'))
      and not exists (select 1 from private.lesson_documentation_consent_events
        where session_id = pg_temp.rad('s_noid'))
      and not private.lesson_session_has_evidence(pg_temp.rad('s_noid')),
    'o modo da escola marcou (e congelou) a aula do professor sem conta Google');
  -- Confirmada a conta, a rodada seguinte marca (desfeito ao fim do bloco).
  begin
    insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
    values (pg_temp.rad('noid'), 'rad-escola', 'rad-sub-noid', 'noid.padrao@example.com', true);
    perform private.apply_standing_lesson_recording_consent('rad-escola');
    perform pg_temp.rad_assert(
      (select documentation_consent from public.lesson_sessions where id = pg_temp.rad('s_noid'))
        and exists (select 1 from private.lesson_documentation_consent_events
          where session_id = pg_temp.rad('s_noid') and allowed
            and reason like 'Termo de registro das aulas: registro autorizado pela escola%'),
      'confirmada a conta Google, o job não marcou a aula do professor');
    raise exception 'rad_desfaz_conta_google';
  exception when others then
    if sqlerrm <> 'rad_desfaz_conta_google' then
      raise;
    end if;
  end;

  -- Para as aulas já dadas contarem no modo da escola, a decisão e o aviso
  -- ficam 3 dias para trás (como se a escola tivesse decidido e avisado antes
  -- delas; em produção os dois nascem juntos na migration).
  update private.lesson_recording_authorization_modes
     set effective_from = now() - interval '3 days' where tenant_id = 'rad-escola';
  update private.lesson_recording_terms
     set published_at = now() - interval '3 days' where kind = 'NOTICE';
end
$switch$;

-- ===== 3. Modo da escola: vale sem link, sem código, sem versão ===============
do $default$
declare
  v_result jsonb;
begin
  perform pg_temp.rad_assert(
    private.lesson_recording_student_consent_effective(pg_temp.rad('adult'))
      and private.lesson_recording_student_consent_effective(pg_temp.rad('kid'))
      and private.lesson_recording_teacher_consent_effective(pg_temp.rad('teacher'))
      and private.lesson_recording_teacher_consent_effective(pg_temp.rad('noid'))
      and private.lesson_recording_active(pg_temp.rad('adult'), pg_temp.rad('teacher'))
      and not exists (select 1 from private.lesson_recording_consents
        where subject_id in (pg_temp.rad('adult'), pg_temp.rad('kid'), pg_temp.rad('teacher'))),
    'no modo da escola aluno/menor/professor ativos não valeram sem link e sem aceite');
  -- Menor: autorizado pela escola, sem responsável — e o cartão continua restrito.
  perform pg_temp.rad_assert(
    private.lesson_recording_requires_guardian(pg_temp.rad('kid'))
      and private.lesson_recording_student_consent_effective(pg_temp.rad('kid'))
      and private.student_learning_card_minor(pg_temp.rad('kid'))
      and private.student_card_suggestion_fields(pg_temp.rad('kid')) = array['real_goal', 'engaging_topics']::text[],
    'menor no modo da escola sem o cartão restrito (ou sem a autorização)');
  perform pg_temp.rad_assert(
    not private.lesson_recording_student_consent_effective(pg_temp.rad('inactive')),
    'aluno inativo ficou autorizado pela escola');
  -- Aceite antigo não "cai" no modo da escola.
  perform pg_temp.rad_assert(
    not private.lesson_recording_accepted_outdated_term(pg_temp.rad('adult'))
      and not private.lesson_recording_acceptance_outdated_at(pg_temp.rad('adult'), now()),
    'aceite desatualizado apareceu no modo da escola');

  -- Aula já dada (dentro do modo da escola): IA do resumo e sugestões do cartão.
  insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason, created_at)
  values (pg_temp.rad('s_past'), pg_temp.rad('admin'), true,
    'Termo de registro das aulas: registro autorizado pela escola (ninguém da aula pediu para não ser registrado).',
    now() - interval '100 minutes');
  update public.lesson_sessions set documentation_consent = true where id = pg_temp.rad('s_past');
  perform pg_temp.rad_assert(
    private.meet_summary_ai_consented(pg_temp.rad('s_past'))
      and private.meet_summary_ai_consented(pg_temp.rad('s_future'))
      and private.student_card_suggestion_ai_allowed(pg_temp.rad('s_past'))
      and not private.lesson_session_documentation_blocked(pg_temp.rad('s_past')),
    'IA do resumo/sugestões não seguiu o modo da escola');
  -- Substituto: conta confirmada + modo da escola = pronto; sem conta, não.
  perform pg_temp.rad_assert(
    private.lesson_teacher_documentation_ready(pg_temp.rad('sub'), 'rad-escola', now() + interval '2 hours')
      and not private.lesson_teacher_documentation_ready(pg_temp.rad('noid'), 'rad-escola', now() + interval '2 hours'),
    'substituto não seguiu o modo da escola (ou ficou pronto sem conta Google)');

  -- Sala pronta da aula futura chega ao aluno.
  insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
    cohost_email, state, created_by) values
    (pg_temp.rad('s_future'), 'rad-escola', 'spaces/radfuture', 'https://meet.google.com/rad-fut-aaa', 'rad-sub-central',
      'prof.padrao@example.com', 'READY', pg_temp.rad('admin'));
  perform pg_temp.rad_as(pg_temp.rad('adult'));
  perform pg_temp.rad_assert(exists (
      select 1 from jsonb_array_elements(public.get_my_lesson_rooms(
        (now() at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date)) as room
      where room ->> 'session_id' = pg_temp.rad('s_future')::text
        and room ->> 'meeting_uri' = 'https://meet.google.com/rad-fut-aaa'),
    'a sala da escola não chegou ao aluno autorizado pela escola');

  -- Painel da direção: modo, trilha e conta Google do professor.
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  v_result := public.list_lesson_recording_consents();
  perform pg_temp.rad_assert(
    v_result -> 'authorization' ->> 'mode' = 'SCHOOL_DEFAULT'
      and v_result -> 'authorization' -> 'current' ->> 'decided_by_name' = 'Direcao Padrao Fixture'
      and (v_result -> 'authorization' ->> 'can_change')::boolean
      and v_result -> 'authorization' -> 'notice_versions' ->> 'STUDENT' = 'v4'
      and exists (select 1 from jsonb_array_elements(v_result -> 'students') as row
        where row ->> 'student_id' = pg_temp.rad('kid')::text and (row ->> 'effective')::boolean)
      and exists (select 1 from jsonb_array_elements(v_result -> 'teachers') as row
        where row ->> 'teacher_id' = pg_temp.rad('noid')::text
          and not (row ->> 'google_identity_confirmed')::boolean and (row ->> 'effective')::boolean)
      and exists (select 1 from jsonb_array_elements(v_result -> 'teachers') as row
        where row ->> 'teacher_id' = pg_temp.rad('teacher')::text and (row ->> 'google_identity_confirmed')::boolean),
    'painel de autorizações sem o modo, a trilha ou a conta Google: ' || v_result::text);
  perform pg_temp.rad_as(pg_temp.rad('coord'));
  perform pg_temp.rad_assert(
    not ((public.list_lesson_recording_consents() -> 'authorization' ->> 'can_change')::boolean),
    'coordenação aparece como quem troca o modo');

  -- Cartão do professor: aviso preenchido, sem aceite a dar.
  perform pg_temp.rad_as(pg_temp.rad('teacher'));
  v_result := public.get_my_lesson_recording_consent();
  perform pg_temp.rad_assert(
    v_result ->> 'authorization_mode' = 'SCHOOL_DEFAULT' and v_result ->> 'term_kind' = 'NOTICE'
      and v_result ->> 'term_version' = 'v4' and (v_result ->> 'effective')::boolean
      and not (v_result ->> 'objected')::boolean
      and v_result ->> 'term_body' not like '%{escola_%'
      and v_result ->> 'term_body' like '%pedir para não ser registrado%',
    'cartão do professor no modo da escola sem o aviso preenchido: ' || v_result::text);
  perform pg_temp.rad_assert(public.my_lesson_recording_authorization_mode() = 'SCHOOL_DEFAULT',
    'a rota do modo (tours) não diz que a escola autoriza o registro');
  perform pg_temp.rad_service();
  perform pg_temp.rad_assert(public.my_lesson_recording_authorization_mode() is null,
    'a rota do modo respondeu para quem não tem escola');

  -- Aula passada a professor sem conta Google: "Sala e resumo" recebe o modo e a
  -- conta de quem recebeu (o remédio é confirmar a conta, não um aceite).
  begin
    insert into private.lesson_session_teacher_handovers (tenant_id, session_id, from_teacher_id, to_teacher_id,
      cause, documentation_ready, after_lesson)
    values ('rad-escola', pg_temp.rad('s_noid'), pg_temp.rad('teacher'), pg_temp.rad('noid'), 'COVERAGE', false, false);
    v_result := private.lesson_session_last_handover(pg_temp.rad('s_noid'));
    perform pg_temp.rad_assert(
      v_result ->> 'authorization_mode' = 'SCHOOL_DEFAULT'
        and not (v_result ->> 'to_teacher_google_confirmed')::boolean
        and v_result ->> 'to_teacher_name' = 'Professor Sem Conta Fixture'
        and private.lesson_session_handover_unconsented(pg_temp.rad('s_noid')),
      '"Sala e resumo" sem o modo ou a conta Google de quem recebeu a aula: ' || coalesce(v_result::text, 'nulo'));
    raise exception 'rad_desfaz_troca';
  exception when others then
    if sqlerrm <> 'rad_desfaz_troca' then
      raise;
    end if;
  end;
end
$default$;

-- ===== 4. Pedido para não registrar tira na hora; desfazer devolve ===========
do $objection$
declare
  v_jobs jsonb;
  v_result jsonb;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  -- 4.1 A direção registra o pedido do aluno (chegou pelo WhatsApp).
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform public.revoke_lesson_recording_consent(pg_temp.rad('adult'), 'A aluna pediu pelo WhatsApp em 27/09 para não registrar.');
  perform pg_temp.rad_service();
  perform pg_temp.rad_assert(
    not private.lesson_recording_student_consent_effective(pg_temp.rad('adult'))
      and private.lesson_session_documentation_blocked(pg_temp.rad('s_future'))
      and private.lesson_session_documentation_blocked_reason(pg_temp.rad('s_future')) = 'STUDENT_SAID_NO'
      and not private.meet_summary_ai_consented(pg_temp.rad('s_future'))
      and not private.student_card_suggestion_ai_allowed(pg_temp.rad('s_past')),
    'o pedido para não registrar não tirou a autorização na hora');
  -- A aula que terminou antes do pedido não é barrada (mesma régua da revogação).
  perform pg_temp.rad_assert(not private.lesson_session_documentation_blocked(pg_temp.rad('s_past')),
    'o pedido barrou a aula que já tinha terminado');
  v_jobs := public.get_pending_google_meet_sync_sessions();
  perform pg_temp.rad_assert(exists (select 1 from jsonb_array_elements(v_jobs) as job
      where job ->> 'lesson_session_id' = pg_temp.rad('s_future')::text and job ->> 'operation' = 'DISABLE_ARTIFACTS'),
    'o pedido não pôs a sala da aula futura na fila para desligar');
  perform pg_temp.rad_as(pg_temp.rad('adult'));
  perform pg_temp.rad_assert(not exists (
      select 1 from jsonb_array_elements(public.get_my_lesson_rooms(v_today, v_today)) as room
      where room ->> 'session_id' = pg_temp.rad('s_future')::text),
    'a sala de quem pediu para não registrar continuou no app');
  -- "Minhas aulas registradas": aviso, modo e o pedido.
  v_result := public.get_my_lesson_records();
  perform pg_temp.rad_assert(
    v_result ->> 'authorization_mode' = 'SCHOOL_DEFAULT' and v_result -> 'consent' ->> 'status' = 'REVOKED'
      and v_result -> 'term' ->> 'version' = 'v4' and v_result -> 'term' ->> 'body' not like '%{escola_%',
    '"Minhas aulas registradas" não mostra o aviso e o pedido: ' || v_result::text);
  perform pg_temp.rad_service();
  perform private.apply_standing_lesson_recording_consent('rad-escola');
  perform pg_temp.rad_assert(
    not (select documentation_consent from public.lesson_sessions where id = pg_temp.rad('s_future')),
    'o job não desmarcou a aula de quem pediu para não registrar');

  -- 4.2 Desfazer (a aluna pediu para voltar): devolve e o job remarca.
  perform pg_temp.rad_as(pg_temp.rad('teacher'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error(format('select public.withdraw_lesson_recording_objection(%L, %L)', pg_temp.rad('adult'),
      'A aluna pediu para voltar a registrar')) like '%sem_permissao%',
    'professor desfez o pedido de um aluno');
  -- Desfazer religa sala, importação e IA: só a direção (a coordenação registra
  -- o pedido, não o desfaz).
  perform pg_temp.rad_as(pg_temp.rad('coord'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error(format('select public.withdraw_lesson_recording_objection(%L, %L)', pg_temp.rad('adult'),
      'Coordenação decidiu voltar a registrar')) like '%somente_a_direcao%',
    'a coordenação desfez o pedido para não registrar');
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error(format('select public.withdraw_lesson_recording_objection(%L, %L)', pg_temp.rad('adult'), 'curto'))
      like '%informe_o_motivo%', 'desfazer sem motivo passou');
  v_result := public.withdraw_lesson_recording_objection(pg_temp.rad('adult'),
    'A aluna pediu pelo WhatsApp em 28/09 para voltar a registrar.');
  perform pg_temp.rad_assert(v_result ->> 'decision' = 'OBJECTION_WITHDRAWN', 'desfazer não gravou');
  perform pg_temp.rad_assert(
    pg_temp.rad_error(format('select public.withdraw_lesson_recording_objection(%L, %L)', pg_temp.rad('adult'),
      'Clique repetido da direção')) like '%nao_ha_pedido_para_desfazer%',
    'desfazer sem pedido de pé passou');
  perform pg_temp.rad_service();
  perform pg_temp.rad_assert(
    private.lesson_recording_student_consent_effective(pg_temp.rad('adult'))
      and not private.lesson_session_documentation_blocked(pg_temp.rad('s_future'))
      and private.meet_summary_ai_consented(pg_temp.rad('s_future'))
      and (select recorded_by = pg_temp.rad('admin') and source = 'SCHOOL' and reason like 'A aluna pediu%'
             from private.lesson_recording_consents where subject_id = pg_temp.rad('adult') order by seq desc limit 1),
    'desfazer não devolveu a autorização (ou ficou sem trilha)');
  perform private.apply_standing_lesson_recording_consent('rad-escola');
  perform pg_temp.rad_assert(
    (select documentation_consent from public.lesson_sessions where id = pg_temp.rad('s_future')),
    'o job não remarcou a aula depois do desfazer');

  -- 4.3 O professor pede pelo app; volta pelo app.
  perform pg_temp.rad_as(pg_temp.rad('teacher'));
  v_result := public.set_my_lesson_recording_consent(false, 'v4');
  perform pg_temp.rad_assert(v_result ->> 'decision' = 'REFUSED' and v_result ->> 'term_version' = 'v4',
    'pedido do professor não gravou a versão do aviso: ' || v_result::text);
  perform pg_temp.rad_service();
  perform pg_temp.rad_assert(
    not private.lesson_recording_teacher_consent_effective(pg_temp.rad('teacher'))
      and private.lesson_session_documentation_blocked_reason(pg_temp.rad('s_future')) = 'TEACHER_SAID_NO'
      and not private.meet_summary_ai_consented(pg_temp.rad('s_kid'))
      and not private.lesson_teacher_documentation_ready(pg_temp.rad('teacher'), 'rad-escola', now() + interval '2 hours'),
    'o pedido do professor não tirou a autorização na hora');
  -- A direção não passa por cima do pedido que o professor fez no app; o
  -- painel diz que é dele. O pedido do professor que a DIREÇÃO registrou (veio
  -- pelo WhatsApp), ela desfaz.
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error(format('select public.withdraw_lesson_recording_objection(%L, %L)', pg_temp.rad('teacher'),
      'A direção quer voltar a registrar')) like '%pedido_do_proprio_professor%',
    'a direção desfez o pedido que o próprio professor fez no app');
  perform pg_temp.rad_assert(exists (
      select 1 from jsonb_array_elements(public.list_lesson_recording_consents() -> 'teachers') as row
      where row ->> 'teacher_id' = pg_temp.rad('teacher')::text and (row ->> 'objection_by_self')::boolean),
    'o painel não diz que o pedido é do próprio professor');
  perform public.revoke_lesson_recording_consent(pg_temp.rad('sub'), 'A professora pediu pelo WhatsApp para não registrar.');
  perform pg_temp.rad_assert(not private.lesson_recording_objection_by_self(pg_temp.rad('sub')),
    'pedido registrado pela direção contou como pedido do próprio professor');
  -- Grava num comando e confere no seguinte (a leitura STABLE do mesmo comando
  -- não enxerga o que a função gravou).
  v_result := public.withdraw_lesson_recording_objection(pg_temp.rad('sub'),
    'A professora pediu pelo WhatsApp para voltar a registrar.');
  perform pg_temp.rad_assert(
    (v_result ->> 'ok')::boolean and private.lesson_recording_teacher_consent_effective(pg_temp.rad('sub')),
    'a direção não desfez o pedido do professor que ela mesma registrou');
  perform pg_temp.rad_as(pg_temp.rad('teacher'));
  v_result := public.set_my_lesson_recording_consent(true, 'v4');
  perform pg_temp.rad_assert(v_result ->> 'decision' = 'OBJECTION_WITHDRAWN',
    'o professor não voltou a permitir o registro: ' || v_result::text);
  v_result := public.set_my_lesson_recording_consent(true, 'v4');
  perform pg_temp.rad_assert((v_result ->> 'unchanged')::boolean, 'voltar a permitir sem pedido gravou outra linha');
  perform pg_temp.rad_service();
  perform pg_temp.rad_assert(
    private.lesson_recording_teacher_consent_effective(pg_temp.rad('teacher'))
      and not private.lesson_session_documentation_blocked(pg_temp.rad('s_future')),
    'o professor voltou a permitir e a aula seguiu barrada');
end
$objection$;

-- ===== 5. Sem link nem lote; a página mostra o aviso e só recusa =============
do $page$
declare
  v_token text := current_setting('rad.page_token', true);
  v_issue jsonb;
  v_result jsonb;
  v_queue uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_link uuid;
begin
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform pg_temp.rad_assert(
    pg_temp.rad_error(format('select public.create_lesson_recording_consent_link(%L)', pg_temp.rad('kid')))
      like '%registro_autorizado_pela_escola%'
      and pg_temp.rad_error('select public.preview_lesson_recording_consent_batch()') like '%registro_autorizado_pela_escola%'
      and pg_temp.rad_error('select public.enqueue_lesson_recording_consent_batch(0)') like '%registro_autorizado_pela_escola%'
      and pg_temp.rad_error(format('select public.resend_lesson_recording_consent_request(%L)', pg_temp.rad('kid')))
        like '%registro_autorizado_pela_escola%',
    'link ou envio do termo saiu no modo da escola');
  v_result := public.list_lesson_recording_consent_requests();
  perform pg_temp.rad_assert(
    not (v_result ->> 'can_send')::boolean and v_result ->> 'authorization_mode' = 'SCHOOL_DEFAULT'
      and not exists (select 1 from jsonb_array_elements(v_result -> 'students') as row where (row ->> 'eligible')::boolean),
    'a lista do envio em lote ainda oferece envio no modo da escola');
  perform pg_temp.rad_service();

  -- Página pública pelo link criado antes da troca: aviso, sem aceite.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.get_lesson_recording_consent_public(v_token);
  perform pg_temp.rad_assert(
    (v_result ->> 'found')::boolean and v_result ->> 'authorization_mode' = 'SCHOOL_DEFAULT'
      and v_result ->> 'term_version' = 'v4' and v_result ->> 'term_body' not like '%{escola_%'
      and (v_result ->> 'current_effective')::boolean and v_result ->> 'current_not_effective_reason' is null,
    'a página pública não mostra o aviso do modo da escola: ' || v_result::text);
  perform pg_temp.rad_service();
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'SELF');
  perform pg_temp.rad_assert((v_issue ->> 'ok')::boolean, 'o código não saiu: ' || v_issue::text);
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', null);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.decide_lesson_recording_consent_public(v_token, 'Aluno Pagina Fixture', 'SELF', true,
    v_issue ->> 'code', 'v4');
  perform pg_temp.rad_assert(v_result ->> 'error' = 'registro_autorizado_pela_escola',
    'aceite pela página no modo da escola não foi recusado: ' || v_result::text);
  perform pg_temp.rad_assert(
    (select consumed_at is null and attempts = 0 from private.lesson_recording_consent_challenges
      where id = (v_issue ->> 'challenge_id')::uuid)
      and not exists (select 1 from private.lesson_recording_consents where subject_id = pg_temp.rad('page')),
    'a recusa do aceite gastou o código ou gravou decisão');
  v_result := public.decide_lesson_recording_consent_public(v_token, 'Aluno Pagina Fixture', 'SELF', false,
    v_issue ->> 'code', 'v4');
  perform pg_temp.rad_assert((v_result ->> 'ok')::boolean and v_result ->> 'decision' = 'REFUSED'
      and v_result ->> 'term_version' = 'v4',
    'o pedido para não registrar pela página não gravou: ' || v_result::text);
  perform pg_temp.rad_service();
  perform pg_temp.rad_assert(
    not private.lesson_recording_student_consent_effective(pg_temp.rad('page'))
      and private.lesson_session_documentation_blocked(pg_temp.rad('s_noid')),
    'o pedido pela página não tirou a autorização na hora');

  -- Data de nascimento (painel e ficha) no modo da escola; link revogado pela
  -- direção: a página recebe o modo e não manda pedir link novo.
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform pg_temp.rad_assert(
    public.get_student_birth_date_record(pg_temp.rad('kid')) ->> 'authorization_mode' = 'SCHOOL_DEFAULT',
    'a data de nascimento não diz que a escola autoriza o registro');
  perform public.revoke_lesson_recording_consent(pg_temp.rad('page'),
    'O aluno confirmou pelo WhatsApp o pedido feito na página.');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.get_lesson_recording_consent_public(v_token);
  perform pg_temp.rad_assert(
    not (v_result ->> 'found')::boolean and (v_result ->> 'expired')::boolean
      and v_result ->> 'authorization_mode' = 'SCHOOL_DEFAULT'
      and public.get_lesson_recording_consent_public(repeat('ab', 32)) -> 'authorization_mode' = 'null'::jsonb,
    'link revogado no modo da escola sem o modo (a página mandaria pedir link novo): ' || v_result::text);
  perform pg_temp.rad_service();

  -- Pedido do termo que estava na fila antes da troca: cancelado ao sair.
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at)
  values ('rad-escola', pg_temp.rad('kid'), encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'),
    pg_temp.rad('admin'), now() + interval '30 days')
  returning id into v_link;
  insert into public.notification_queue (id, tenant_id, teacher_id, student_id, student_name, student_phone,
    message_body, scheduled_for, next_attempt_at, status, source_id, source_type, notification_kind)
  values (v_queue, 'rad-escola', null, pg_temp.rad('kid'), 'Crianca Fixture', '5511900007777',
    'Mensagem do termo (fixture)', now(), now(), 'pending', v_request, 'LESSON_RECORDING_CONSENT',
    'LESSON_RECORDING_CONSENT_REQUEST');
  insert into private.lesson_recording_consent_requests (id, tenant_id, student_id, term_version, attempt, batch_id,
    link_id, notification_id, recipient, destination, message_sha256, requested_by, scheduled_for)
  values (v_request, 'rad-escola', pg_temp.rad('kid'), (private.lesson_recording_current_term('STUDENT')).version,
    1, gen_random_uuid(), v_link, v_queue, 'GUARDIAN', '5511900007777',
    encode(extensions.digest('Mensagem do termo (fixture)', 'sha256'), 'hex'), pg_temp.rad('admin'), now());
  v_result := private.lesson_recording_request_snapshot_at(v_queue, now());
  perform pg_temp.rad_assert(
    not (v_result ->> 'ok')::boolean and v_result ->> 'reason' = 'registro_autorizado_pela_escola'
      and not coalesce((v_result ->> 'retryable')::boolean, false),
    'o pedido do termo na fila não foi cancelado no modo da escola: ' || v_result::text);
end
$page$;

-- ===== 6. A escola volta ao aceite individual ================================
do $back$
declare
  v_result jsonb;
begin
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  v_result := public.set_lesson_recording_authorization_mode('INDIVIDUAL_CONSENT',
    'O jurídico pediu o aceite individual até revisar a cláusula.');
  perform pg_temp.rad_service();
  perform pg_temp.rad_assert(
    (select count(*) = 2 from private.lesson_recording_authorization_modes where tenant_id = 'rad-escola')
      and private.lesson_recording_authorization_mode('rad-escola') = 'INDIVIDUAL_CONSENT'
      and (select legal_basis = 'INDIVIDUAL_CONSENT' and source = 'APP'
             from private.lesson_recording_authorization_modes where tenant_id = 'rad-escola'
             order by effective_from desc, id desc limit 1),
    'a volta ao aceite individual ficou sem trilha');
  -- Ninguém mais vale sem aceite; a aula futura marcada pelo padrão caiu na hora,
  -- com o motivo certo.
  perform pg_temp.rad_assert(
    not private.lesson_recording_student_consent_effective(pg_temp.rad('kid'))
      and not private.lesson_recording_teacher_consent_effective(pg_temp.rad('teacher'))
      and not (select documentation_consent from public.lesson_sessions where id = pg_temp.rad('s_kid'))
      and exists (select 1 from private.lesson_documentation_consent_events
        where session_id = pg_temp.rad('s_kid') and not allowed
          and reason like 'Termo de registro das aulas: a escola passou a pedir o aceite individual%'),
    'a volta ao aceite individual não desmarcou a aula futura (ou o motivo não diz)');
  -- A aula que terminou antes da troca segue importável e com a IA.
  perform pg_temp.rad_assert(
    not private.lesson_session_documentation_blocked(pg_temp.rad('s_past'))
      and private.meet_summary_ai_consented(pg_temp.rad('s_past')),
    'a aula já dada sob o modo da escola ficou barrada pela troca posterior');
  -- O desfazer de antes não é aceite no modelo individual.
  perform pg_temp.rad_as(pg_temp.rad('adult'));
  v_result := public.get_my_lesson_records();
  perform pg_temp.rad_assert(
    v_result ->> 'authorization_mode' = 'INDIVIDUAL_CONSENT' and v_result -> 'consent' ->> 'status' = 'NONE'
      and v_result -> 'term' ->> 'version' <> 'v4',
    'desfazer o pedido virou aceite no modelo individual: ' || v_result::text);
  perform pg_temp.rad_service();

  -- No aceite individual a conta Google não é a pendência (a sala depende também
  -- dos aceites): a Central não mostra o item.
  perform pg_temp.rad_assert(private.lesson_recording_teachers_without_google_identity('rad-escola') = 0,
    'professor sem conta Google virou pendência no aceite individual');
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform pg_temp.rad_assert(
    coalesce((public.director_pending_counts() ->> 'professores_sem_conta_google')::integer, 0) = 0
      and public.my_lesson_recording_authorization_mode() = 'INDIVIDUAL_CONSENT',
    'Central de Pendências com professores sem conta Google no aceite individual (ou a rota do modo não mudou)');
  perform pg_temp.rad_service();

  -- De novo o modo da escola (para a pendência abaixo).
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  perform public.set_lesson_recording_authorization_mode('SCHOOL_DEFAULT', 'A direção confirmou o registro pela escola.');
  perform pg_temp.rad_service();
end
$back$;

-- ===== 7. Central de Pendências: professor sem conta Google ==================
do $pending$
declare
  v_counts jsonb;
begin
  perform pg_temp.rad_assert(
    private.lesson_recording_teachers_without_google_identity('rad-escola') = 1
      and private.lesson_recording_teachers_without_google_identity(null) = 0,
    'contagem de professores sem conta Google errada');
  perform pg_temp.rad_as(pg_temp.rad('admin'));
  v_counts := public.director_pending_counts();
  perform pg_temp.rad_assert(
    (v_counts ->> 'professores_sem_conta_google')::integer = 1 and v_counts ? 'resumos_para_revisar',
    'Central de Pendências sem os professores sem conta Google (ou perdeu os resumos): ' || v_counts::text);
  perform pg_temp.rad_service();
  -- Quem pediu para não registrar não precisa de sala.
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, recorded_by)
  values ('rad-escola', pg_temp.rad('noid'), 'TEACHER', 'REFUSED', 'Professor Sem Conta Fixture', 'SELF',
    'TEACHER', 'v4', 'APP', pg_temp.rad('noid'));
  perform pg_temp.rad_assert(private.lesson_recording_teachers_without_google_identity('rad-escola') = 0,
    'professor que pediu para não registrar contou como pendência de conta Google');
end
$pending$;

-- ===== 8. Wise Wolf: one-shot com trilha =====================================
do $wise_wolf$
declare
  v_admin uuid := gen_random_uuid();
  v_row private.lesson_recording_authorization_modes;
begin
  if exists (select 1 from public.schema_one_shots
             where key = 'registro_das_aulas_autorizado_pela_escola_wise_wolf_20260927') then
    -- Banco com a escola (produção): a trilha da migration está lá. Só os
    -- campos IMUTÁVEIS da linha (a trilha nunca é atualizada): o papel e a
    -- escola ATUAIS de quem decidiu mudam com o tempo (diretor que sai, vira
    -- outro papel, é substituído) e travariam todo release sem que a trilha
    -- tivesse mudado. Que decided_by era a direção no momento da decisão é
    -- provado no ramo de baixo (fixture), contra a função do one-shot.
    select * into v_row from private.lesson_recording_authorization_modes
    where tenant_id = 'school-wise-wolf' and source = 'MIGRATION';
    perform pg_temp.rad_assert(
      (select count(*) = 1 from private.lesson_recording_authorization_modes
        where tenant_id = 'school-wise-wolf' and source = 'MIGRATION')
        and v_row.mode = 'SCHOOL_DEFAULT' and v_row.decided_on = date '2026-09-27'
        and v_row.legal_basis = 'SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT'
        and v_row.reason like '%Não quero ter que gerar link%'
        and v_row.reason like '%pedir para não ser registrada%'
        and length(btrim(coalesce(v_row.decided_by_name, ''))) >= 2,
      'trilha do one-shot da Wise Wolf incompleta');
  else
    -- Clone só-estrutura: a escola não existe; reproduz o one-shot aqui.
    perform pg_temp.rad_service();
    insert into public.tenants (id, name) values ('school-wise-wolf', 'Wise Wolf') on conflict (id) do nothing;
    insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
    values (v_admin, 'rad-ww-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
    update public.profiles set tenant_id = 'school-wise-wolf', role = 'SCHOOL_ADMIN', lifecycle_status = 'active',
      full_name = 'Diretor Wise Wolf Fixture' where id = v_admin;
    insert into public.tenant_memberships (tenant_id, user_id, role, status)
    values ('school-wise-wolf', v_admin, 'SCHOOL_ADMIN', 'ACTIVE')
    on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
    delete from private.lesson_recording_authorization_modes where tenant_id = 'school-wise-wolf';
    perform pg_temp.rad_assert(
      private.lesson_recording_school_default_decision_20260927('rad-nao-existe') = 'tenant_absent',
      'one-shot gravou decisão para escola que não existe');
    perform pg_temp.rad_assert(
      private.lesson_recording_school_default_decision_20260927('school-wise-wolf') = 'applied'
        and private.lesson_recording_school_default_decision_20260927('school-wise-wolf') = 'already',
      'one-shot da Wise Wolf não é idempotente');
    select * into v_row from private.lesson_recording_authorization_modes where tenant_id = 'school-wise-wolf';
    perform pg_temp.rad_assert(
      (select count(*) = 1 from private.lesson_recording_authorization_modes where tenant_id = 'school-wise-wolf')
        and v_row.mode = 'SCHOOL_DEFAULT' and v_row.source = 'MIGRATION'
        and v_row.decided_by = v_admin
        and (private.management_group_default_actor('school-wise-wolf') = v_admin)
        and v_row.decided_by_name = 'Diretor Wise Wolf Fixture'
        and v_row.decided_on = date '2026-09-27'
        and v_row.legal_basis = 'SCHOOL_CONTRACT_OR_DECISION_WITH_OPT_OUT'
        and v_row.reason like '%Não quero ter que gerar link para aluno ou professor consentir%'
        and private.lesson_recording_authorization_mode('school-wise-wolf') = 'SCHOOL_DEFAULT',
      'trilha do one-shot da Wise Wolf incompleta (clone)');
  end if;
end
$wise_wolf$;

rollback;
