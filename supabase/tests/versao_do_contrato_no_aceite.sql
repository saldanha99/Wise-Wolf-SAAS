-- Versão do texto do contrato gravada no aceite (migration 20260927150000).
-- Prova: as versões 1 (texto de antes) e 2 (com a cláusula do registro das
-- aulas) existem para aluno e professor; contrato sem versão gravada é lido
-- como "nada gravado" (a tela mostra o texto de antes); o aluno grava a versão
-- da própria matrícula depois do aceite de begin_enrollment_offer, uma vez só,
-- e ninguém grava pela oferta de outra pessoa nem depois da matrícula
-- concluída; só a própria pessoa e a direção/coordenação da escola leem a
-- versão; o registro é imutável; a auditoria de matrículas mostra a versão;
-- o professor regulariza o aceite (o digest volta a funcionar) e a versão
-- fica gravada — sem versão, é a 1.
-- Contra o código anterior reprova no primeiro bloco (sem tabelas, sem as
-- RPCs, e com a accept_teacher_contract(text) de 11/07 no ar). O aceite do
-- professor prova também o hash da assinatura: a versão de 11/07 morria com
-- "function digest(text, unknown) does not exist" (search_path = public e o
-- pgcrypto em "extensions" — conferido na produção em 27/09/2026).
-- Não depende de dado real nem do horário: tudo é fixture.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.ctr_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'versão do contrato: %', p_message;
  end if;
end;
$$;

-- Age como p_actor (nulo = sem ninguém).
create or replace function pg_temp.ctr_as(p_actor uuid)
returns void language plpgsql as $$
begin
  if p_actor is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  end if;
end;
$$;

do $privileges$
declare
  v_record regprocedure := to_regprocedure('public.record_enrollment_contract_terms(uuid,integer)');
  v_read regprocedure := to_regprocedure('public.get_contract_terms_version(uuid,text)');
  v_accept regprocedure := to_regprocedure('public.accept_teacher_contract(text,integer)');
  v_proc regprocedure;
begin
  perform pg_temp.ctr_assert(to_regclass('public.contract_terms_versions') is not null
    and to_regclass('public.contract_terms_acceptances') is not null,
    'tabelas de versão e de aceite não existem');
  perform pg_temp.ctr_assert(v_record is not null and v_read is not null and v_accept is not null,
    'RPCs de versão do contrato não existem');
  perform pg_temp.ctr_assert(to_regprocedure('public.accept_teacher_contract(text)') is null,
    'a assinatura antiga de accept_teacher_contract continua no ar (ambiguidade no PostgREST)');

  foreach v_proc in array array[v_record, v_read, v_accept] loop
    perform pg_temp.ctr_assert(
      (select prosecdef and pg_get_userbyid(proowner) = 'postgres'
              and proconfig @> array['search_path=""']
         from pg_proc where oid = v_proc),
      v_proc::text || ' sem SECURITY DEFINER, dono postgres ou search_path vazio');
    perform pg_temp.ctr_assert(
      has_function_privilege('authenticated', v_proc, 'EXECUTE')
      and not has_function_privilege('anon', v_proc, 'EXECUTE'),
      v_proc::text || ' com permissão errada (anon alcança ou authenticated não)');
  end loop;

  perform pg_temp.ctr_assert(
    not has_function_privilege('authenticated', 'private.contract_terms_version_for(uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.contract_lesson_recording_accepted_at(uuid,text,text)', 'EXECUTE'),
    'função interna da versão do contrato exposta ao navegador');
  perform pg_temp.ctr_assert(
    (select relrowsecurity from pg_class where oid = 'public.contract_terms_acceptances'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.contract_terms_versions'::regclass),
    'tabelas sem RLS');
  perform pg_temp.ctr_assert(
    not has_table_privilege('authenticated', 'public.contract_terms_acceptances', 'SELECT')
    and not has_table_privilege('authenticated', 'public.contract_terms_acceptances', 'INSERT')
    and not has_table_privilege('anon', 'public.contract_terms_acceptances', 'SELECT')
    and not has_table_privilege('authenticated', 'public.contract_terms_versions', 'SELECT'),
    'o navegador lê ou grava os aceites direto na tabela');
  perform pg_temp.ctr_assert(
    has_table_privilege('service_role', 'public.contract_terms_acceptances', 'INSERT'),
    'a edge register-teacher (service_role) não consegue gravar o aceite do convite');

  -- As versões que a tela conhece (lib/contractTerms.ts).
  perform pg_temp.ctr_assert(
    (select count(*) from public.contract_terms_versions
      where (contract_kind, version, includes_lesson_recording) in (
        ('STUDENT', 1, false), ('STUDENT', 2, true),
        ('TEACHER', 1, false), ('TEACHER', 2, true))) = 4,
    'versões 1 (sem cláusula) e 2 (com a cláusula do registro das aulas) não estão cadastradas');
end
$privileges$;

do $test$
declare
  v_tid text := 'versao-contrato-fixture';
  v_other_tid text := 'versao-contrato-outra';
  v_admin uuid := gen_random_uuid();
  v_coordinator uuid := gen_random_uuid();
  v_other_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_teacher_old_app uuid := gen_random_uuid();
  v_teacher_bad uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_legacy_student uuid := gen_random_uuid();
  v_intruder uuid := gen_random_uuid();
  v_offer uuid := gen_random_uuid();
  v_done_offer uuid := gen_random_uuid();
  v_all uuid[];
  v_r jsonb;
  v_version integer;
  v_failed boolean;
  v_count integer;
  v_hash text;
begin
  v_all := array[v_admin, v_coordinator, v_other_admin, v_teacher, v_teacher_old_app,
                 v_teacher_bad, v_student, v_legacy_student, v_intruder];
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name, slug, saas_status) values
    (v_tid, 'Versão do contrato fixture', v_tid, 'active'),
    (v_other_tid, 'Versão do contrato outra escola', v_other_tid, 'active');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  select id, 'versao-contrato-' || replace(id::text, '-', '') || '@example.invalid',
         '{"provider":"email"}', '{"test_fixture":true}'
    from unnest(v_all) as fixture(id);
  update public.profiles
     set tenant_id = case when id = v_other_admin then v_other_tid else v_tid end,
         is_test_account = true,
         phone = null,
         role = case
           when id in (v_admin, v_other_admin) then 'SCHOOL_ADMIN'
           when id = v_coordinator then 'COORDINATOR'
           when id in (v_teacher, v_teacher_old_app, v_teacher_bad) then 'TEACHER'
           else 'STUDENT' end,
         full_name = case
           when id = v_teacher then 'Professora Versao Contrato'
           when id = v_student then 'Aluna Versao Contrato'
           else 'Fixture Versao Contrato' end
   where id = any (v_all);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id = any (v_all)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  -- Aluna que já assinou antes desta migration: aceite no perfil, versão nenhuma.
  update public.profiles
     set contract_accepted = true, accepted_at = now() - interval '200 days'
   where id = v_legacy_student;

  insert into public.offers (id, tenant_id, kind, expires_at, payload, requires_enrollment,
                             enrollment_fee, created_by)
  values
    (v_offer, v_tid, 'ENROLLMENT', now() + interval '2 days',
     jsonb_build_object('value', 261, 'dueDay', 10, 'classesPerWeek', '2', 'planDuration', 6),
     false, 0, v_admin),
    (v_done_offer, v_tid, 'ENROLLMENT', now() + interval '2 days',
     jsonb_build_object('value', 261, 'dueDay', 10, 'classesPerWeek', '2', 'planDuration', 6),
     false, 0, v_admin);

  -- 1. Antes de qualquer gravação: nada gravado (a tela mostra o texto de antes).
  perform pg_temp.ctr_as(v_legacy_student);
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_legacy_student, 'STUDENT') is null,
    'contrato assinado antes da migration ganhou versão sem ninguém gravar');

  -- 2. A aluna assina. O que begin_enrollment_offer deixa gravado e esta porta
  -- confere (begin_enrollment_offer_authoritative_impl): a oferta em
  -- andamento com processing_by = a aluna e o perfil STUDENT da escola da
  -- oferta com o contrato aceito. A cadeia inteira de begin (grade relacional,
  -- escopo financeiro) tem teste próprio; aqui só importa o estado que ela
  -- entrega.
  update public.offers
     set processing_by = v_student, processing_state = 'PROFILE_READY',
         processing_started_at = now()
   where id = v_offer;
  update public.profiles
     set contract_accepted = true, accepted_at = now(),
         typed_signature = 'Aluna Versao Contrato'
   where id = v_student;

  -- Sem ninguém, pela oferta de outra pessoa, com versão desconhecida: recusa.
  perform pg_temp.ctr_as(null);
  v_r := public.record_enrollment_contract_terms(v_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'nao_autenticado', 'anônimo gravou versão: ' || v_r::text);
  perform pg_temp.ctr_as(v_intruder);
  v_r := public.record_enrollment_contract_terms(v_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'oferta_de_outra_pessoa',
    'outra pessoa gravou versão na matrícula alheia: ' || v_r::text);
  perform pg_temp.ctr_as(v_student);
  v_r := public.record_enrollment_contract_terms(v_offer, 99);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_invalida', 'versão desconhecida aceita: ' || v_r::text);
  v_r := public.record_enrollment_contract_terms(v_offer, null);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_invalida', 'versão nula aceita: ' || v_r::text);
  perform pg_temp.ctr_assert(
    not exists (select 1 from public.contract_terms_acceptances where user_id in (v_student, v_intruder)),
    'recusa deixou registro para trás');

  v_r := public.record_enrollment_contract_terms(v_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true' and (v_r ->> 'terms_version')::int = 2
    and v_r ->> 'already' = 'false', 'a aluna não gravou a versão 2: ' || v_r::text);

  -- Repetir (outra aba, nova tentativa) não cria outro registro nem troca a versão.
  v_r := public.record_enrollment_contract_terms(v_offer, 1);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true' and (v_r ->> 'terms_version')::int = 2
    and v_r ->> 'already' = 'true', 'segunda gravação trocou a versão: ' || v_r::text);
  select count(*) into v_count from public.contract_terms_acceptances
   where user_id = v_student and contract_kind = 'STUDENT';
  perform pg_temp.ctr_assert(v_count = 1, 'mais de um registro para a mesma matrícula');
  perform pg_temp.ctr_assert(exists (
      select 1 from public.contract_terms_acceptances
       where user_id = v_student and tenant_id = v_tid and source = 'ENROLLMENT_OFFER'
         and source_id = v_offer and terms_version = 2),
    'registro sem a escola, a origem ou a oferta certas');

  -- 3. Matrícula concluída sem versão gravada terminou com o texto de antes.
  update public.offers
     set processing_by = v_student, processing_state = 'COMPLETED',
         consumed_at = now(), consumed_by = v_student
   where id = v_done_offer;
  v_r := public.record_enrollment_contract_terms(v_done_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'matricula_concluida',
    'versão gravada depois da matrícula concluída: ' || v_r::text);

  -- 4. Quem lê a versão: a própria aluna, direção e coordenação da escola.
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_student, 'STUDENT') = 2,
    'a aluna não lê a versão do próprio contrato');
  perform pg_temp.ctr_as(v_admin);
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_student, 'STUDENT') = 2,
    'a direção da escola não lê a versão');
  perform pg_temp.ctr_as(v_coordinator);
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_student, 'STUDENT') = 2,
    'a coordenação da escola não lê a versão');
  perform pg_temp.ctr_as(v_other_admin);
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_student, 'STUDENT') is null,
    'direção de outra escola leu a versão');
  perform pg_temp.ctr_as(v_intruder);
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_student, 'STUDENT') is null,
    'outro aluno leu a versão');
  perform pg_temp.ctr_as(v_teacher);
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_student, 'STUDENT') is null,
    'professor leu a versão do contrato do aluno');
  perform pg_temp.ctr_as(v_student);
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_student, null) is null
    and public.get_contract_terms_version(v_student, 'TEACHER') is null,
    'tipo de contrato nulo ou trocado devolveu versão');

  -- 5. A auditoria de matrículas da direção mostra a versão de cada contrato.
  perform pg_temp.ctr_as(v_admin);
  select contract_terms_version into v_version
    from public.vw_student_contracts where user_id = v_student;
  perform pg_temp.ctr_assert(v_version = 2, 'auditoria de matrículas sem a versão 2');
  perform pg_temp.ctr_assert(exists (select 1 from public.vw_student_contracts
      where user_id = v_legacy_student and contract_terms_version is null),
    'contrato de antes apareceu com versão na auditoria');
  perform pg_temp.ctr_as(v_other_admin);
  perform pg_temp.ctr_assert(not exists (select 1 from public.vw_student_contracts where user_id = v_student),
    'a auditoria de outra escola vê a aluna');

  -- 6. Base da autorização futura: aceite com a cláusula do registro das aulas.
  perform pg_temp.ctr_assert(
    private.contract_lesson_recording_accepted_at(v_student, 'STUDENT', v_tid) is not null
    and private.contract_lesson_recording_accepted_at(v_legacy_student, 'STUDENT', v_tid) is null,
    'a base do aceite da cláusula não distingue versão 2 de contrato antigo');

  -- 7. O registro é prova: não muda depois de gravado.
  v_failed := false;
  begin
    update public.contract_terms_acceptances set terms_version = 1 where user_id = v_student;
  exception when others then
    v_failed := sqlerrm like '%contract_terms_acceptance_is_immutable%';
  end;
  perform pg_temp.ctr_assert(v_failed, 'o aceite gravado pôde ser alterado');

  -- 8. Professor regulariza o aceite pelo app, lendo a versão 2.
  perform pg_temp.ctr_as(v_student);
  v_r := public.accept_teacher_contract('Aluna Versao Contrato', 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'apenas_professor', 'aluno aceitou contrato de professor');

  perform pg_temp.ctr_as(v_teacher_bad);
  v_r := public.accept_teacher_contract('Fixture Versao Contrato', 7);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_invalida', 'versão desconhecida aceita: ' || v_r::text);
  perform pg_temp.ctr_assert(
    (select not coalesce(contract_accepted, false) from public.profiles where id = v_teacher_bad),
    'versão recusada e mesmo assim o aceite ficou gravado');

  perform pg_temp.ctr_as(v_teacher);
  v_r := public.accept_teacher_contract('Professora Versao Contrato', 2);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true' and (v_r ->> 'terms_version')::int = 2,
    'o professor não conseguiu aceitar o contrato: ' || v_r::text);
  select signature_hash into v_hash from public.profiles
   where id = v_teacher and contract_accepted and accepted_at is not null
     and typed_signature = 'Professora Versao Contrato';
  perform pg_temp.ctr_assert(v_hash ~ '^[0-9a-f]{64}$', 'aceite do professor sem assinatura/hash');
  perform pg_temp.ctr_assert(public.get_contract_terms_version(v_teacher, 'TEACHER') = 2
    and exists (select 1 from public.contract_terms_acceptances
                 where user_id = v_teacher and source = 'TEACHER_CONTRACT_ACCEPT'
                   and source_id is null and tenant_id = v_tid),
    'a versão do aceite do professor não foi gravada');
  v_r := public.accept_teacher_contract('Professora Versao Contrato', 2);
  perform pg_temp.ctr_assert(v_r ->> 'already' = 'true', 'segundo aceite do professor não foi idempotente');
  select count(*) into v_count from public.contract_terms_acceptances where user_id = v_teacher;
  perform pg_temp.ctr_assert(v_count = 1, 'segundo aceite do professor criou outro registro');

  -- App antigo (sem a versão) mostrava o texto de antes: fica gravado como 1.
  perform pg_temp.ctr_as(v_teacher_old_app);
  v_r := public.accept_teacher_contract('Fixture Versao Contrato');
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true' and (v_r ->> 'terms_version')::int = 1,
    'aceite do app antigo não virou versão 1: ' || v_r::text);
  perform pg_temp.ctr_assert(
    private.contract_lesson_recording_accepted_at(v_teacher_old_app, 'TEACHER', v_tid) is null
    and private.contract_lesson_recording_accepted_at(v_teacher, 'TEACHER', v_tid) is not null,
    'a base do aceite da cláusula não distingue o professor da versão 1');
end
$test$;

rollback;
