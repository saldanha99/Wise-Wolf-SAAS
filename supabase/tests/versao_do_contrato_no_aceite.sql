-- Versão do texto do contrato gravada no aceite (migration 20260927150000).
-- Prova: as versões 1 (texto de antes) e 2 (com a cláusula do registro das
-- aulas) existem para aluno e professor; cada escola oferece a sua versão
-- (sem decisão = 1, e a cláusula não aparece para escola que não grava aulas);
-- contrato sem versão gravada é lido como "nada gravado" (a tela mostra o
-- texto de antes); o aluno grava a versão da própria matrícula depois do
-- aceite de begin_enrollment_offer, uma vez só, só a versão que a escola
-- oferece, e ninguém grava pela oferta de outra pessoa nem depois da
-- matrícula concluída; o aceite guarda se quem assinou foi o responsável
-- (link de dependente, lido da oferta) e a data da assinatura DESTA matrícula
-- (rematrícula não herda a data da assinatura antiga do perfil); a base da
-- autorização futura não conta aceite do próprio aluno de quem a escola exige
-- responsável; só a própria pessoa e a direção/coordenação da escola leem; o
-- registro é imutável; a auditoria de matrículas mostra versão e data; o
-- professor regulariza o aceite (o digest volta a funcionar) com a versão que
-- a escola dele oferece — sem versão, é a 1.
-- Contra o código anterior reprova no primeiro bloco (sem tabelas, sem as
-- RPCs, e com a accept_teacher_contract(text) de 11/07 no ar); contra o
-- rascunho desta frente reprova também no primeiro bloco (sem
-- tenant_contract_terms nem get_contract_terms) e, isolando cada parte, na
-- versão desatualizada, no responsável, na rematrícula e no professor de
-- escola sem a cláusula. O aceite do professor prova também o hash da
-- assinatura: a versão de 11/07 morria com "function digest(text, unknown)
-- does not exist" (search_path = public e o pgcrypto em "extensions" —
-- conferido na produção em 27/09/2026).
-- Não depende de dado real nem do horário: tudo é fixture (a única leitura de
-- dado real — a Wise Wolf oferece a versão 2 — só roda onde a escola existe).
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
  v_read regprocedure := to_regprocedure('public.get_contract_terms(uuid,text)');
  v_accept regprocedure := to_regprocedure('public.accept_teacher_contract(text,integer)');
  v_offered regprocedure := to_regprocedure('public.contract_terms_offered_version(text,text)');
  v_proc regprocedure;
begin
  perform pg_temp.ctr_assert(to_regclass('public.contract_terms_versions') is not null
    and to_regclass('public.contract_terms_acceptances') is not null
    and to_regclass('public.tenant_contract_terms') is not null,
    'tabelas de versão, de aceite e da versão de cada escola não existem');
  perform pg_temp.ctr_assert(v_record is not null and v_read is not null
    and v_accept is not null and v_offered is not null,
    'RPCs de versão do contrato não existem');
  perform pg_temp.ctr_assert(to_regprocedure('public.accept_teacher_contract(text)') is null,
    'a assinatura antiga de accept_teacher_contract continua no ar (ambiguidade no PostgREST)');
  perform pg_temp.ctr_assert(to_regprocedure('public.get_contract_terms_version(uuid,text)') is null,
    'a leitura do rascunho (só a versão, sem a data) continua no ar');

  foreach v_proc in array array[v_record, v_read, v_accept, v_offered] loop
    perform pg_temp.ctr_assert(
      (select prosecdef and pg_get_userbyid(proowner) = 'postgres'
              and proconfig @> array['search_path=""']
         from pg_proc where oid = v_proc),
      v_proc::text || ' sem SECURITY DEFINER, dono postgres ou search_path vazio');
    perform pg_temp.ctr_assert(not has_function_privilege('anon', v_proc, 'EXECUTE'),
      v_proc::text || ' alcançável sem login');
  end loop;
  foreach v_proc in array array[v_record, v_read, v_accept] loop
    perform pg_temp.ctr_assert(has_function_privilege('authenticated', v_proc, 'EXECUTE'),
      v_proc::text || ' fora do alcance do navegador');
  end loop;
  -- A versão oferecida por uma escola qualquer é das edges, não do navegador.
  perform pg_temp.ctr_assert(
    not has_function_privilege('authenticated', v_offered, 'EXECUTE')
    and has_function_privilege('service_role', v_offered, 'EXECUTE'),
    'versão oferecida por escola exposta ao navegador ou fora do alcance das edges');

  perform pg_temp.ctr_assert(
    not has_function_privilege('authenticated', 'private.contract_terms_offered_version(text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.contract_lesson_recording_accepted_at(uuid,text,text)', 'EXECUTE'),
    'função interna da versão do contrato exposta ao navegador');
  perform pg_temp.ctr_assert(
    (select relrowsecurity from pg_class where oid = 'public.contract_terms_acceptances'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.contract_terms_versions'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.tenant_contract_terms'::regclass),
    'tabelas sem RLS');
  perform pg_temp.ctr_assert(
    not has_table_privilege('authenticated', 'public.contract_terms_acceptances', 'SELECT')
    and not has_table_privilege('authenticated', 'public.contract_terms_acceptances', 'INSERT')
    and not has_table_privilege('anon', 'public.contract_terms_acceptances', 'SELECT')
    and not has_table_privilege('authenticated', 'public.contract_terms_versions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.tenant_contract_terms', 'SELECT')
    and not has_table_privilege('authenticated', 'public.tenant_contract_terms', 'INSERT'),
    'o navegador lê ou grava os aceites (ou a versão da escola) direto na tabela');
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

  -- Decisão da direção da Wise Wolf (27/09/2026): só confere onde a escola
  -- existe (no clone só de estrutura ela não existe e a semente não roda).
  if exists (select 1 from public.tenants where id = 'school-wise-wolf') then
    perform pg_temp.ctr_assert(
      private.contract_terms_offered_version('school-wise-wolf', 'STUDENT') = 2
      and private.contract_terms_offered_version('school-wise-wolf', 'TEACHER') = 2,
      'a Wise Wolf não oferece a versão com o registro das aulas nos contratos novos');
  end if;
end
$privileges$;

do $test$
declare
  v_tid text := 'versao-contrato-fixture';
  v_plain_tid text := 'versao-contrato-outra';
  v_admin uuid := gen_random_uuid();
  v_coordinator uuid := gen_random_uuid();
  v_other_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_teacher_old_app uuid := gen_random_uuid();
  v_teacher_bad uuid := gen_random_uuid();
  v_plain_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_adult_student uuid := gen_random_uuid();
  v_dependent_student uuid := gen_random_uuid();
  v_returning_student uuid := gen_random_uuid();
  v_plain_student uuid := gen_random_uuid();
  v_legacy_student uuid := gen_random_uuid();
  v_intruder uuid := gen_random_uuid();
  v_offer uuid := gen_random_uuid();
  v_done_offer uuid := gen_random_uuid();
  v_adult_offer uuid := gen_random_uuid();
  v_dependent_offer uuid := gen_random_uuid();
  v_return_offer uuid := gen_random_uuid();
  v_plain_offer uuid := gen_random_uuid();
  v_old_signature timestamptz := now() - interval '200 days';
  v_all uuid[];
  v_r jsonb;
  v_version integer;
  v_accepted_at timestamptz;
  v_failed boolean;
  v_count integer;
  v_hash text;
begin
  v_all := array[v_admin, v_coordinator, v_other_admin, v_teacher, v_teacher_old_app,
                 v_teacher_bad, v_plain_teacher, v_student, v_adult_student,
                 v_dependent_student, v_returning_student, v_plain_student,
                 v_legacy_student, v_intruder];
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name, slug, saas_status) values
    (v_tid, 'Versão do contrato fixture', v_tid, 'active'),
    (v_plain_tid, 'Versão do contrato outra escola', v_plain_tid, 'active');
  -- A escola da fixture decidiu o registro das aulas; a outra não decidiu nada.
  insert into public.tenant_contract_terms (tenant_id, contract_kind, terms_version)
  values (v_tid, 'STUDENT', 2), (v_tid, 'TEACHER', 2);
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  select id, 'versao-contrato-' || replace(id::text, '-', '') || '@example.invalid',
         '{"provider":"email"}', '{"test_fixture":true}'
    from unnest(v_all) as fixture(id);
  update public.profiles
     set tenant_id = case
           when id in (v_other_admin, v_plain_teacher, v_plain_student) then v_plain_tid
           else v_tid end,
         is_test_account = true,
         phone = null,
         role = case
           when id in (v_admin, v_other_admin) then 'SCHOOL_ADMIN'
           when id = v_coordinator then 'COORDINATOR'
           when id in (v_teacher, v_teacher_old_app, v_teacher_bad, v_plain_teacher) then 'TEACHER'
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
     set contract_accepted = true, accepted_at = v_old_signature
   where id = v_legacy_student;
  -- Ex-aluno que volta: assinou o texto de antes há 200 dias.
  update public.profiles
     set contract_accepted = true, accepted_at = v_old_signature,
         typed_signature = 'Fixture Versao Contrato'
   where id = v_returning_student;

  insert into public.offers (id, tenant_id, kind, expires_at, payload, requires_enrollment,
                             enrollment_fee, created_by)
  select offer_id, tenant_id, 'ENROLLMENT', now() + interval '2 days',
         jsonb_build_object('value', 261, 'dueDay', 10, 'classesPerWeek', '2', 'planDuration', 6)
           || extra,
         false, 0, creator
    from (values
      (v_offer, v_tid, '{}'::jsonb, v_admin),
      (v_done_offer, v_tid, '{}'::jsonb, v_admin),
      (v_adult_offer, v_tid, '{}'::jsonb, v_admin),
      (v_dependent_offer, v_tid,
       '{"isDependent": true, "guardianName": "Responsavel Fixture"}'::jsonb, v_admin),
      (v_return_offer, v_tid, '{}'::jsonb, v_admin),
      (v_plain_offer, v_plain_tid, '{}'::jsonb, v_other_admin)
    ) as fixture(offer_id, tenant_id, extra, creator);

  -- O que begin_enrollment_offer deixa gravado e a porta confere
  -- (begin_enrollment_offer_authoritative_impl): a oferta em andamento com
  -- processing_by = o aluno e o perfil STUDENT da escola da oferta com o
  -- contrato aceito. Assinatura nova: accepted_at = o momento do begin, depois
  -- de processing_started_at. Rematrícula: o perfil MANTÉM a assinatura antiga
  -- (coalesce). A cadeia inteira de begin tem teste próprio; aqui só importa o
  -- estado que ela entrega.
  update public.offers as offer
     set processing_by = fixture.student, processing_state = 'PROFILE_READY',
         processing_started_at = now()
    from (values
      (v_offer, v_student), (v_adult_offer, v_adult_student),
      (v_dependent_offer, v_dependent_student), (v_return_offer, v_returning_student),
      (v_plain_offer, v_plain_student)
    ) as fixture(offer_id, student)
   where offer.id = fixture.offer_id;
  update public.profiles
     set contract_accepted = true, accepted_at = now(),
         typed_signature = full_name
   where id in (v_student, v_adult_student, v_dependent_student, v_plain_student);

  -- 1. Antes de qualquer gravação: nada gravado (a tela mostra o texto de antes),
  -- e cada escola oferece a sua versão aos contratos novos.
  perform pg_temp.ctr_as(v_legacy_student);
  v_r := public.get_contract_terms(v_legacy_student, 'STUDENT');
  perform pg_temp.ctr_assert(v_r ->> 'recorded_version' is null and v_r ->> 'accepted_at' is null,
    'contrato assinado antes da migration ganhou versão sem ninguém gravar: ' || v_r::text);
  perform pg_temp.ctr_assert((v_r ->> 'offered_version')::int = 2,
    'a escola que decidiu o registro das aulas não oferece a versão 2: ' || v_r::text);
  perform pg_temp.ctr_as(v_plain_student);
  perform pg_temp.ctr_assert(
    (public.get_contract_terms(v_plain_student, 'STUDENT') ->> 'offered_version')::int = 1,
    'escola sem a decisão oferece a cláusula do registro das aulas');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.ctr_assert(
    public.contract_terms_offered_version(v_tid, 'TEACHER') = 2
    and public.contract_terms_offered_version(v_plain_tid, 'TEACHER') = 1
    and public.contract_terms_offered_version(v_plain_tid, 'OUTRO') is null,
    'a versão oferecida às edges não segue a escola');

  -- 2. Sem ninguém, pela oferta de outra pessoa, com versão desconhecida: recusa.
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
  -- Página aberta com o texto que a escola não oferece (desatualizada): recusa
  -- antes da cobrança.
  v_r := public.record_enrollment_contract_terms(v_offer, 1);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_desatualizada',
    'versão diferente da que a escola oferece foi gravada: ' || v_r::text);
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
  -- Assinatura nova: a data do aceite é a do perfil (a do hash), e quem assinou
  -- foi o próprio aluno.
  perform pg_temp.ctr_assert(exists (
      select 1 from public.contract_terms_acceptances as acceptance
        join public.profiles as profile on profile.id = acceptance.user_id
       where acceptance.user_id = v_student and acceptance.tenant_id = v_tid
         and acceptance.source = 'ENROLLMENT_OFFER' and acceptance.source_id = v_offer
         and acceptance.terms_version = 2
         and acceptance.accepted_at = profile.accepted_at
         and not acceptance.signed_as_guardian),
    'registro sem a escola, a origem, a oferta, a data da assinatura ou quem assinou');

  -- Escola sem a decisão: a página mostra e grava a versão 1; a 2 é recusada.
  perform pg_temp.ctr_as(v_plain_student);
  v_r := public.record_enrollment_contract_terms(v_plain_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_desatualizada',
    'escola sem a decisão gravou a cláusula do registro das aulas: ' || v_r::text);
  v_r := public.record_enrollment_contract_terms(v_plain_offer, 1);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true' and (v_r ->> 'terms_version')::int = 1,
    'escola sem a decisão não gravou a versão 1: ' || v_r::text);

  -- 3. Link de dependente: quem assinou foi o responsável (lido da oferta).
  perform pg_temp.ctr_as(v_dependent_student);
  v_r := public.record_enrollment_contract_terms(v_dependent_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true', 'matrícula de dependente não gravou: ' || v_r::text);
  perform pg_temp.ctr_assert(exists (
      select 1 from public.contract_terms_acceptances
       where user_id = v_dependent_student and signed_as_guardian),
    'matrícula de dependente sem a marca do responsável');

  -- 4. Rematrícula: o perfil guarda a assinatura de 200 dias atrás, o contrato
  -- novo não pode aparecer com ela.
  perform pg_temp.ctr_as(v_returning_student);
  v_r := public.record_enrollment_contract_terms(v_return_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true', 'rematrícula não gravou: ' || v_r::text);
  v_r := public.get_contract_terms(v_returning_student, 'STUDENT');
  perform pg_temp.ctr_assert((v_r ->> 'recorded_version')::int = 2
    and (v_r ->> 'accepted_at')::timestamptz = now()
    and (v_r ->> 'accepted_at')::timestamptz > v_old_signature,
    'rematrícula aparece com a data da assinatura antiga: ' || v_r::text);

  -- 5. Matrícula concluída sem versão gravada terminou com o texto de antes.
  perform pg_temp.ctr_as(v_student);
  update public.offers
     set processing_by = v_student, processing_state = 'COMPLETED',
         consumed_at = now(), consumed_by = v_student
   where id = v_done_offer;
  v_r := public.record_enrollment_contract_terms(v_done_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'matricula_concluida',
    'versão gravada depois da matrícula concluída: ' || v_r::text);

  -- 6. Quem lê: a própria aluna, direção e coordenação da escola.
  v_r := public.get_contract_terms(v_student, 'STUDENT');
  perform pg_temp.ctr_assert((v_r ->> 'recorded_version')::int = 2
    and (v_r ->> 'accepted_at') is not null,
    'a aluna não lê a versão do próprio contrato: ' || coalesce(v_r::text, 'null'));
  perform pg_temp.ctr_as(v_admin);
  perform pg_temp.ctr_assert(
    (public.get_contract_terms(v_student, 'STUDENT') ->> 'recorded_version')::int = 2,
    'a direção da escola não lê a versão');
  perform pg_temp.ctr_as(v_coordinator);
  perform pg_temp.ctr_assert(
    (public.get_contract_terms(v_student, 'STUDENT') ->> 'recorded_version')::int = 2,
    'a coordenação da escola não lê a versão');
  perform pg_temp.ctr_as(v_other_admin);
  perform pg_temp.ctr_assert(public.get_contract_terms(v_student, 'STUDENT') is null,
    'direção de outra escola leu a versão');
  perform pg_temp.ctr_as(v_intruder);
  perform pg_temp.ctr_assert(public.get_contract_terms(v_student, 'STUDENT') is null,
    'outro aluno leu a versão');
  perform pg_temp.ctr_as(v_teacher);
  perform pg_temp.ctr_assert(public.get_contract_terms(v_student, 'STUDENT') is null,
    'professor leu a versão do contrato do aluno');
  perform pg_temp.ctr_as(v_student);
  perform pg_temp.ctr_assert(public.get_contract_terms(v_student, null) is null
    and (public.get_contract_terms(v_student, 'TEACHER') ->> 'recorded_version') is null,
    'tipo de contrato nulo ou trocado devolveu versão');

  -- 7. A auditoria de matrículas da direção mostra versão e data de cada contrato.
  perform pg_temp.ctr_as(v_admin);
  select contract_terms_version into v_version
    from public.vw_student_contracts where user_id = v_student;
  perform pg_temp.ctr_assert(v_version = 2, 'auditoria de matrículas sem a versão 2');
  perform pg_temp.ctr_assert(exists (select 1 from public.vw_student_contracts
      where user_id = v_legacy_student and contract_terms_version is null
        and contract_terms_accepted_at is null),
    'contrato de antes apareceu com versão na auditoria');
  select contract_terms_accepted_at into v_accepted_at
    from public.vw_student_contracts where user_id = v_returning_student;
  perform pg_temp.ctr_assert(v_accepted_at = now()
    and exists (select 1 from public.vw_student_contracts
                 where user_id = v_returning_student and accepted_at = v_old_signature),
    'a auditoria não separa a data da versão assinada da assinatura antiga do perfil');
  perform pg_temp.ctr_as(v_other_admin);
  perform pg_temp.ctr_assert(not exists (select 1 from public.vw_student_contracts where user_id = v_student),
    'a auditoria de outra escola vê a aluna');

  -- 8. Base da autorização futura: aceite com a cláusula, e do responsável
  -- quando a escola exige responsável. Nenhum aluno da fixture tem data de
  -- nascimento atestada: idade desconhecida = responsável (a régua do termo).
  perform pg_temp.ctr_assert(
    private.contract_lesson_recording_accepted_at(v_student, 'STUDENT', v_tid) is null,
    'aluno de idade não comprovada autorizou pelo próprio aceite, sem o responsável');
  perform pg_temp.ctr_assert(
    private.contract_lesson_recording_accepted_at(v_dependent_student, 'STUDENT', v_tid) is not null,
    'contrato assinado pelo responsável não conta como aceite da cláusula');
  perform pg_temp.ctr_assert(
    private.contract_lesson_recording_accepted_at(v_legacy_student, 'STUDENT', v_tid) is null
    and private.contract_lesson_recording_accepted_at(v_plain_student, 'STUDENT', v_plain_tid) is null,
    'contrato sem a cláusula conta como aceite dela');
  -- Adulto atestado pela escola: o próprio aceite vale.
  perform pg_temp.ctr_as(v_adult_student);
  v_r := public.record_enrollment_contract_terms(v_adult_offer, 2);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true', 'aluno adulto não gravou: ' || v_r::text);
  perform pg_temp.ctr_assert(
    private.contract_lesson_recording_accepted_at(v_adult_student, 'STUDENT', v_tid) is null,
    'idade ainda não atestada e o próprio aceite já valeu');
  perform pg_temp.ctr_as(v_admin);
  perform public.set_student_birth_date(v_adult_student, date '1990-05-10',
    'Documento conferido na matrícula (fixture)');
  perform pg_temp.ctr_assert(
    private.contract_lesson_recording_accepted_at(v_adult_student, 'STUDENT', v_tid) is not null,
    'adulto atestado pela escola não conta com o próprio aceite da cláusula');

  -- 9. O registro é prova: não muda depois de gravado.
  v_failed := false;
  begin
    update public.contract_terms_acceptances set terms_version = 1 where user_id = v_student;
  exception when others then
    v_failed := sqlerrm like '%contract_terms_acceptance_is_immutable%';
  end;
  perform pg_temp.ctr_assert(v_failed, 'o aceite gravado pôde ser alterado');

  -- 10. Professor regulariza o aceite pelo app, lendo a versão da escola dele.
  perform pg_temp.ctr_as(v_student);
  v_r := public.accept_teacher_contract('Aluna Versao Contrato', 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'apenas_professor', 'aluno aceitou contrato de professor');

  perform pg_temp.ctr_as(v_teacher_bad);
  v_r := public.accept_teacher_contract('Fixture Versao Contrato', 7);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_invalida', 'versão desconhecida aceita: ' || v_r::text);
  -- A tela mostrou a versão 1 numa escola que oferece a 2: recarregar.
  v_r := public.accept_teacher_contract('Fixture Versao Contrato', 1);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_invalida',
    'versão diferente da que a escola oferece foi aceita: ' || v_r::text);
  perform pg_temp.ctr_assert(
    (select not coalesce(contract_accepted, false) from public.profiles where id = v_teacher_bad),
    'versão recusada e mesmo assim o aceite ficou gravado');

  perform pg_temp.ctr_as(v_teacher);
  perform pg_temp.ctr_assert(
    (public.get_contract_terms(v_teacher, 'TEACHER') ->> 'offered_version')::int = 2,
    'o professor não lê a versão que a escola dele oferece');
  v_r := public.accept_teacher_contract('Professora Versao Contrato', 2);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true' and (v_r ->> 'terms_version')::int = 2,
    'o professor não conseguiu aceitar o contrato: ' || v_r::text);
  select signature_hash into v_hash from public.profiles
   where id = v_teacher and contract_accepted and accepted_at is not null
     and typed_signature = 'Professora Versao Contrato';
  perform pg_temp.ctr_assert(v_hash ~ '^[0-9a-f]{64}$', 'aceite do professor sem assinatura/hash');
  v_r := public.get_contract_terms(v_teacher, 'TEACHER');
  perform pg_temp.ctr_assert((v_r ->> 'recorded_version')::int = 2
    and (v_r ->> 'accepted_at')::timestamptz = (select accepted_at from public.profiles where id = v_teacher)
    and exists (select 1 from public.contract_terms_acceptances
                 where user_id = v_teacher and source = 'TEACHER_CONTRACT_ACCEPT'
                   and source_id is null and tenant_id = v_tid and not signed_as_guardian),
    'a versão do aceite do professor não foi gravada: ' || v_r::text);
  v_r := public.accept_teacher_contract('Professora Versao Contrato', 2);
  perform pg_temp.ctr_assert(v_r ->> 'already' = 'true', 'segundo aceite do professor não foi idempotente');
  select count(*) into v_count from public.contract_terms_acceptances where user_id = v_teacher;
  perform pg_temp.ctr_assert(v_count = 1, 'segundo aceite do professor criou outro registro');

  -- Professor de escola sem a decisão: a versão 2 é recusada, a 1 vale.
  perform pg_temp.ctr_as(v_plain_teacher);
  v_r := public.accept_teacher_contract('Fixture Versao Contrato', 2);
  perform pg_temp.ctr_assert(v_r ->> 'error' = 'versao_invalida',
    'professor de escola sem a decisão assinou a cláusula do registro das aulas: ' || v_r::text);
  v_r := public.accept_teacher_contract('Fixture Versao Contrato', 1);
  perform pg_temp.ctr_assert(v_r ->> 'ok' = 'true' and (v_r ->> 'terms_version')::int = 1,
    'professor de escola sem a decisão não aceitou a versão 1: ' || v_r::text);

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
