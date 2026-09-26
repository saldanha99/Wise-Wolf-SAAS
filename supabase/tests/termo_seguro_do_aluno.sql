-- Termo de registro das aulas, lado do aluno/responsável (migration
-- 20260926200000): idade desconhecida exige responsável (fail-closed), só a
-- escola atesta a data de nascimento, o professor não classifica o aluno como
-- infantil, e toda decisão pelo link exige o código de 6 dígitos do WhatsApp.
-- O telefone do código é o atestado pela escola (o próprio aluno não altera o
-- do responsável), congelado por trigger em qualquer link; os tetos por link
-- fecham o link vazado; e a página diz quando um aceite não vale mais.
--
-- Reprova contra a versão de 20260926120000 já no primeiro bloco (aluno sem
-- data de nascimento era tratado como adulto) e contra a primeira versão de
-- 20260926200000 nos blocos 4c, 4d, 5b, 5c, 5d e 6 (cada um conferido
-- sozinho contra ela).
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.sec_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'termo seguro: %', p_message;
  end if;
end;
$$;
grant execute on function pg_temp.sec_assert(boolean, text) to public;

-- Fixture: escola, direção, coordenação, dois professores, alunos e uma
-- escola de fora. Os ids ficam em configurações da transação para os blocos
-- seguintes (inclusive o que roda com o papel authenticated).
do $fixture$
declare
  v_admin uuid := gen_random_uuid();
  v_coord uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_other_teacher uuid := gen_random_uuid();
  v_adult uuid := gen_random_uuid();
  v_kid uuid := gen_random_uuid();
  v_nophone uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_kid2 uuid := gen_random_uuid();
  v_kid3 uuid := gen_random_uuid();
  v_parent uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name, saas_status) values
    ('sec-consent-fixture', 'Termo seguro fixture', 'active'),
    ('sec-consent-other', 'Termo seguro outra escola', 'active');
  -- Mudança feita por professor avisa a Coordenação (20260922024045).
  insert into public.tenant_notice_channels (tenant_id, channel, group_jid)
  values ('sec-consent-fixture', 'coordenacao', '120363000000000009@g.us');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'sec-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_coord, 'sec-coord@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'sec-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_other_teacher, 'sec-teacher2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_adult, 'sec-adult@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_kid, 'sec-kid@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_nophone, 'sec-nophone@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_outsider, 'sec-outsider@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_kid2, 'sec-kid2@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_kid3, 'sec-kid3@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_parent, 'sec-parent@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'sec-consent-fixture', lifecycle_status = 'active', is_test_account = true,
         status = 'Ativo',
         role = case
           when id = v_admin then 'SCHOOL_ADMIN'
           when id = v_coord then 'COORDINATOR'
           when id in (v_teacher, v_other_teacher) then 'TEACHER'
           else 'STUDENT' end,
         full_name = case
           when id = v_admin then 'Direcao Fixture'
           when id = v_coord then 'Coordenacao Fixture'
           when id = v_teacher then 'Professora Fixture'
           when id = v_other_teacher then 'Professor Dois Fixture'
           when id = v_adult then 'Adulta Sem Data Fixture'
           when id = v_kid then 'Crianca Fixture'
           when id = v_kid2 then 'Menor Dois Fixture'
           when id = v_kid3 then 'Menor Tres Fixture'
           when id = v_parent then 'Mae Titular Fixture'
           else 'Sem Telefone Fixture' end,
         professor_id = case when id in (v_adult, v_kid, v_nophone, v_kid2, v_kid3) then v_teacher end,
         is_kids = false,
         birth_date = null,
         guardian_name = case when id in (v_kid, v_kid2) then 'Responsavel Fixture' end,
         -- Gravado pelo servidor (sem usuário na sessão), como a matrícula:
         -- fica na trilha e vale como telefone atestado.
         guardian_phone = case when id = v_kid then '(11) 90000-0001' when id = v_kid2 then '11 90000-0004' end,
         guardian_id = case when id = v_kid3 then v_parent end,
         phone = case
           when id = v_adult then '11 90000-0002'
           when id = v_kid then '11900000003'
           when id = v_kid2 then '11 90000-0006'
           -- A criança usa o celular da mãe: mesmo número do responsável.
           when id = v_kid3 then '11 90000-0005'
           when id = v_parent then '11 90000-0005' end,
         attendance_phone = null
   where id in (v_admin, v_coord, v_teacher, v_other_teacher, v_adult, v_kid, v_nophone, v_kid2, v_kid3, v_parent);
  update public.profiles
     set tenant_id = 'sec-consent-other', lifecycle_status = 'active', is_test_account = true,
         role = 'SCHOOL_ADMIN', full_name = 'Diretor De Fora'
   where id = v_outsider;
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles
     where id in (v_admin, v_coord, v_teacher, v_other_teacher, v_adult, v_kid, v_nophone, v_outsider,
       v_kid2, v_kid3, v_parent)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  perform set_config('fx.admin', v_admin::text, true);
  perform set_config('fx.coord', v_coord::text, true);
  perform set_config('fx.teacher', v_teacher::text, true);
  perform set_config('fx.other_teacher', v_other_teacher::text, true);
  perform set_config('fx.adult', v_adult::text, true);
  perform set_config('fx.kid', v_kid::text, true);
  perform set_config('fx.nophone', v_nophone::text, true);
  perform set_config('fx.outsider', v_outsider::text, true);
  perform set_config('fx.kid2', v_kid2::text, true);
  perform set_config('fx.kid3', v_kid3::text, true);
  perform set_config('fx.parent', v_parent::text, true);
end
$fixture$;

-- 1. Idade desconhecida = responsável (fail-closed). Na versão anterior este
--    bloco reprova: sem data e sem is_kids o aluno respondia sozinho.
do $fail_closed$
declare
  v_adult uuid := current_setting('fx.adult')::uuid;
begin
  perform pg_temp.sec_assert(
    private.lesson_recording_requires_guardian(v_adult),
    'aluno sem data de nascimento cadastrada pela escola foi tratado como adulto'
  );
  perform pg_temp.sec_assert(
    private.lesson_recording_requires_guardian(gen_random_uuid()),
    'aluno inexistente não exigiu responsável'
  );
end
$fail_closed$;

-- 2. Permissões das rotas.
do $privileges$
begin
  perform pg_temp.sec_assert(
    to_regprocedure('public.decide_lesson_recording_consent_public(text,text,text,boolean)') is null,
    'a decisão sem código continua existindo'
  );
  perform pg_temp.sec_assert(
    has_function_privilege('anon', 'public.decide_lesson_recording_consent_public(text,text,text,boolean,text)', 'EXECUTE')
    and has_function_privilege('anon', 'public.get_lesson_recording_consent_public(text)', 'EXECUTE'),
    'a página pública perdeu a rota anônima'
  );
  perform pg_temp.sec_assert(
    not has_function_privilege('anon', 'public.issue_lesson_recording_consent_code(text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.issue_lesson_recording_consent_code(text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.settle_lesson_recording_consent_code(uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.settle_lesson_recording_consent_code(uuid,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.issue_lesson_recording_consent_code(text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.settle_lesson_recording_consent_code(uuid,text,text)', 'EXECUTE'),
    'emissão do código fora do service_role'
  );
  perform pg_temp.sec_assert(
    not has_function_privilege('anon', 'public.set_student_birth_date(uuid,date,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_student_birth_date_record(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.set_student_birth_date(uuid,date,text)', 'EXECUTE'),
    'rota da data de nascimento com permissão errada'
  );
  perform pg_temp.sec_assert(
    not has_table_privilege('authenticated', 'private.lesson_recording_consent_challenges', 'SELECT')
    and not has_table_privilege('service_role', 'private.lesson_recording_consent_challenges', 'SELECT')
    and not has_table_privilege('authenticated', 'private.student_birth_date_records', 'SELECT'),
    'tabela de código ou de nascimento acessível de fora'
  );
end
$privileges$;

-- 3. Data de nascimento: só a escola, com trilha.
do $birth_date$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_coord uuid := current_setting('fx.coord')::uuid;
  v_teacher uuid := current_setting('fx.teacher')::uuid;
  v_outsider uuid := current_setting('fx.outsider')::uuid;
  v_adult uuid := current_setting('fx.adult')::uuid;
  v_kid uuid := current_setting('fx.kid')::uuid;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_blocked boolean;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.set_student_birth_date(v_adult, date '1990-05-10', null);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.sec_assert(v_blocked, 'professor cadastrou data de nascimento');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.set_student_birth_date(v_adult, date '1990-05-10', null);
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.sec_assert(v_blocked, 'direção de outra escola cadastrou data de nascimento');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin perform public.set_student_birth_date(v_adult, v_today + 1, null);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.sec_assert(v_blocked, 'aceitou data de nascimento no futuro');

  v_result := public.set_student_birth_date(v_adult, date '1990-05-10', 'RG conferido na matrícula');
  perform pg_temp.sec_assert(v_result ->> 'guardian_reason' is null, 'adulto atestado seguiu exigindo responsável');
  perform pg_temp.sec_assert(not private.lesson_recording_requires_guardian(v_adult), 'adulto atestado exige responsável');
  perform pg_temp.sec_assert(
    exists (select 1 from public.profile_audit_log
      where profile_id = v_adult and field = 'birth_date' and new_value = '1990-05-10' and changed_by = v_admin),
    'mudança da data de nascimento sem trilha em profile_audit_log'
  );
  perform pg_temp.sec_assert(
    (select reason from private.student_birth_date_records where student_id = v_adult order by seq desc limit 1)
      = 'RG conferido na matrícula',
    'registro da escola sem o motivo'
  );
  perform pg_temp.sec_assert(
    (public.set_student_birth_date(v_adult, date '1990-05-10', null) ->> 'unchanged')::boolean,
    'repetir a mesma data criou registro novo'
  );

  -- Coordenação também cadastra; menor de idade continua com responsável.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_coord, 'role', 'authenticated')::text, true);
  v_result := public.set_student_birth_date(v_kid, (v_today - interval '10 years')::date, null);
  perform pg_temp.sec_assert(v_result ->> 'guardian_reason' = 'MINOR', 'menor atestado não exigiu responsável');
  v_result := public.get_student_birth_date_record(v_kid);
  perform pg_temp.sec_assert(v_result ->> 'recorded_by_name' = 'Coordenacao Fixture', 'ficha não mostrou quem cadastrou');
end
$birth_date$;

-- 3b. Data de nascimento alterada por fora (o próprio aluno, um formulário)
--     não serve de prova de maioridade.
do $outside_change$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_adult uuid := current_setting('fx.adult')::uuid;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_adult, 'role', 'authenticated')::text, true);
  update public.profiles set birth_date = date '1985-01-01' where id = v_adult;
  perform pg_temp.sec_assert(
    private.lesson_recording_guardian_reason(v_adult) = 'AGE_UNKNOWN',
    'data trocada fora da escola continuou valendo como prova'
  );
  -- A escola confirma o valor que já está no cadastro: vale de novo e fica na trilha.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_student_birth_date(v_adult, date '1985-01-01', 'Aluno mostrou documento');
  perform pg_temp.sec_assert(
    private.lesson_recording_guardian_reason(v_adult) is null,
    'confirmação da escola não restabeleceu a prova'
  );
end
$outside_change$;

do $confirmed_audit$
begin
  perform pg_temp.sec_assert(
    exists (select 1 from public.profile_audit_log
      where profile_id = current_setting('fx.adult')::uuid and field = 'birth_date_confirmed'
        and new_value = '1985-01-01'),
    'confirmação da data existente sem trilha'
  );
end
$confirmed_audit$;

-- 4. Turma infantil: o professor não classifica, a direção sim.
do $kids_rpc$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_teacher uuid := current_setting('fx.teacher')::uuid;
  v_adult uuid := current_setting('fx.adult')::uuid;
  v_blocked boolean;
  v_message text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  v_blocked := false;
  begin
    perform public.update_student_pedagogical_profile(v_adult, jsonb_build_object('is_kids', true));
  exception when insufficient_privilege then
    v_blocked := true;
    get stacked diagnostics v_message = message_text;
  end;
  perform pg_temp.sec_assert(v_blocked and v_message = 'kids_classification_requires_direction',
    'professor marcou o aluno como infantil pela RPC');

  -- O formulário do professor manda o valor atual junto: continua salvando.
  perform public.update_student_pedagogical_profile(v_adult,
    jsonb_build_object('is_kids', false, 'occupation', 'Engenheira'));
  perform pg_temp.sec_assert(
    (select occupation = 'Engenheira' and not coalesce(is_kids, false) from public.profiles where id = v_adult),
    'formulário do professor com o mesmo is_kids deixou de salvar'
  );

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.update_student_pedagogical_profile(v_adult, jsonb_build_object('is_kids', true));
  perform pg_temp.sec_assert(
    (select is_kids from public.profiles where id = v_adult),
    'direção não conseguiu classificar como infantil'
  );
  perform pg_temp.sec_assert(
    private.lesson_recording_guardian_reason(v_adult) = 'KIDS',
    'turma infantil com data de adulto não exigiu responsável'
  );
  perform pg_temp.sec_assert(
    exists (select 1 from public.profile_audit_log
      where profile_id = v_adult and field = 'is_kids' and new_value = 'true' and changed_by = v_admin),
    'classificação infantil sem trilha'
  );
  perform public.update_student_pedagogical_profile(v_adult, jsonb_build_object('is_kids', false));
end
$kids_rpc$;

-- 4b. Pela API direta (papel authenticated, RLS e triggers de verdade).
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('fx.teacher'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $kids_api$
declare
  v_adult uuid := current_setting('fx.adult')::uuid;
  v_blocked boolean := false;
  v_rows integer;
begin
  update public.profiles set is_kids = true where id = v_adult;
  get diagnostics v_rows = row_count;
  -- Se a RLS escondesse a linha o teste não provaria nada: exige a tentativa.
  perform pg_temp.sec_assert(false, 'professor alterou is_kids direto pela API (linhas: ' || v_rows || ')');
exception
  when insufficient_privilege then
    v_blocked := sqlerrm like 'private profile fields cannot be changed by a teacher%';
    if not v_blocked then
      raise exception 'termo seguro: bloqueio inesperado: %', sqlerrm;
    end if;
end
$kids_api$;
reset role;

-- 4c. O próprio aluno não mexe, pela API, no que decide quem responde o
--     termo. Antes, um menor punha o próprio número em "telefone do
--     responsável" e o código de GUARDIAN ia para ele (este bloco reprova
--     contra a versão anterior: o update passava).
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('fx.kid2'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $student_api$
declare
  v_kid2 uuid := current_setting('fx.kid2')::uuid;
  v_parent uuid := current_setting('fx.parent')::uuid;
  v_statement text;
  v_rows integer;
begin
  foreach v_statement in array array[
    'update public.profiles set guardian_phone = ''11977776666'' where id = $1',
    'update public.profiles set guardian_id = $2 where id = $1',
    'update public.profiles set birth_date = date ''1990-01-01'' where id = $1',
    'update public.profiles set is_kids = true where id = $1'
  ] loop
    begin
      execute v_statement using v_kid2, v_parent;
      get diagnostics v_rows = row_count;
      -- Se a RLS escondesse a linha o teste não provaria nada: exige a tentativa.
      perform pg_temp.sec_assert(false, 'aluno alterou pela API (' || v_rows || ' linhas): ' || v_statement);
    exception when insufficient_privilege then
      if sqlerrm not like 'school-managed profile fields cannot be changed by the student%' then
        raise exception 'termo seguro: bloqueio inesperado (%): %', v_statement, sqlerrm;
      end if;
    end;
  end loop;
end
$student_api$;
reset role;

-- 4d. Telefone do responsável gravado pelo próprio aluno (por uma rota que
--     não passa pela trava acima, ex.: RPC antiga) não é atestado: o link não
--     congela esse número e o código não sai. Quando a escola corrige pela
--     ficha, o número dela vale.
do $unattested$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_kid2 uuid := current_setting('fx.kid2')::uuid;
  v_link jsonb;
begin
  -- Antes: telefone gravado pela matrícula (servidor) é atestado.
  perform pg_temp.sec_assert(
    private.lesson_recording_guardian_phone(v_kid2) = '5511900000004',
    'telefone do responsável gravado pela matrícula não foi aceito'
  );

  -- O aluno troca por uma rota privilegiada (a trilha registra que foi ele).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_kid2, 'role', 'authenticated')::text, true);
  update public.profiles set guardian_phone = '11977776666' where id = v_kid2;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_link := public.create_lesson_recording_consent_link(v_kid2);
  perform pg_temp.sec_assert(
    v_link ->> 'guardian_phone_masked' is null,
    'o link congelou o telefone que o próprio aluno pôs como do responsável: ' || coalesce(v_link ->> 'guardian_phone_masked', '')
  );
  perform pg_temp.sec_assert((v_link ->> 'guardian_phone_unconfirmed')::boolean,
    'o link não avisou que o telefone do responsável precisa da confirmação da escola');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.sec_assert(
    public.issue_lesson_recording_consent_code(v_link ->> 'token', 'GUARDIAN') ->> 'error' = 'telefone_nao_cadastrado',
    'código do responsável saiu para o número que o aluno gravou'
  );
end
$unattested$;

-- A escola corrige na ficha (update pela API, como a tela faz).
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('fx.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
update public.profiles set guardian_phone = '11966665555' where id = current_setting('fx.kid2')::uuid;
reset role;

do $school_fix$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_kid2 uuid := current_setting('fx.kid2')::uuid;
  v_link jsonb;
  v_record jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_link := public.create_lesson_recording_consent_link(v_kid2);
  perform pg_temp.sec_assert(v_link ->> 'guardian_phone_masked' = '(11) •••••-5555',
    'telefone gravado pela direção não foi aceito como do responsável');
  perform pg_temp.sec_assert(not (v_link ->> 'guardian_phone_unconfirmed')::boolean,
    'telefone confirmado pela direção seguiu como pendente');
  v_record := public.get_student_birth_date_record(v_kid2);
  perform pg_temp.sec_assert(v_record ->> 'guardian_code_phone_masked' = '(11) •••••-5555'
    and not (v_record ->> 'guardian_phone_unconfirmed')::boolean,
    'ficha não mostrou o telefone do responsável que recebe o código');

  -- Contato de responsável verificado pela escola vem antes do cadastro.
  insert into public.student_quality_contacts (tenant_id, student_id, name, phone, relationship, verified_at, verified_by)
  values ('sec-consent-fixture', v_kid2, 'Pai Fixture', '5511944443333', 'GUARDIAN', now(), v_admin);
  perform pg_temp.sec_assert(private.lesson_recording_guardian_phone(v_kid2) = '5511944443333',
    'contato de responsável verificado pela escola não teve prioridade');
end
$school_fix$;


-- 5. Código do WhatsApp.
do $otp$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_adult uuid := current_setting('fx.adult')::uuid;
  v_kid uuid := current_setting('fx.kid')::uuid;
  v_nophone uuid := current_setting('fx.nophone')::uuid;
  v_teacher uuid := current_setting('fx.teacher')::uuid;
  v_link jsonb;
  v_token text;
  v_kid_token text;
  v_nophone_token text;
  v_issue jsonb;
  v_result jsonb;
  v_code text;
  v_wrong text;
  v_blocked boolean;
  v_challenge uuid;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_link := public.create_lesson_recording_consent_link(v_adult);
  v_token := v_link ->> 'token';
  perform pg_temp.sec_assert(v_link ->> 'student_phone_masked' = '(11) •••••-0002', 'máscara do telefone do aluno');
  v_kid_token := public.create_lesson_recording_consent_link(v_kid) ->> 'token';
  v_nophone_token := public.create_lesson_recording_consent_link(v_nophone) ->> 'token';
  perform pg_temp.sec_assert(
    (select student_phone = '5511900000002' from private.lesson_recording_consent_links
      where student_id = v_adult and revoked_at is null),
    'telefone do aluno não foi guardado normalizado no link'
  );

  -- O "telefone do responsável" muda depois do link por uma rota que não é a
  -- API do aluno (a API recusa, bloco 4c): o código segue para o número
  -- atestado que o link congelou, e o painel deixa de usar o número novo.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_kid, 'role', 'authenticated')::text, true);
  update public.profiles set guardian_phone = '11988887777' where id = v_kid;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.get_lesson_recording_consent_public(v_kid_token);
  perform pg_temp.sec_assert(v_result ->> 'guardian_reason' = 'MINOR', 'página pública sem o motivo do responsável');
  perform pg_temp.sec_assert(v_result ->> 'guardian_phone_masked' = '(11) •••••-0001', 'página não mostrou o telefone do link');
  perform pg_temp.sec_assert(position('11900000001' in v_result::text) = 0, 'página pública vazou o telefone inteiro');

  -- Menor: o aluno não pede código para si nem decide sozinho.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.sec_assert(
    public.issue_lesson_recording_consent_code(v_kid_token, 'SELF') ->> 'error' = 'responsavel_obrigatorio',
    'menor recebeu código para responder sozinho'
  );
  v_issue := public.issue_lesson_recording_consent_code(v_kid_token, 'GUARDIAN');
  perform pg_temp.sec_assert(v_issue ->> 'destination' = '5511900000001', 'código foi para o telefone trocado depois do link');
  v_code := v_issue ->> 'code';
  perform pg_temp.sec_assert(v_code ~ '^[0-9]{6}$', 'código fora do formato');
  perform pg_temp.sec_assert(
    exists (
      select 1 from private.lesson_recording_consent_challenges as challenge
      where challenge.id = (v_issue ->> 'challenge_id')::uuid
        and challenge.code_hash <> v_code
        and challenge.code_hash <> encode(extensions.digest(v_code, 'sha256'), 'hex')
        and challenge.code_hash = encode(extensions.digest(challenge.id::text || ':' || v_code, 'sha256'), 'hex')
    ),
    'código guardado em claro ou com hash sem sal'
  );
  -- Enquanto o envio não é confirmado (ISSUED) o código não decide nada.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.sec_assert(
    public.decide_lesson_recording_consent_public(v_kid_token, 'Responsavel Fixture', 'GUARDIAN', true, v_code) ->> 'error'
      = 'codigo_expirado',
    'código ainda não enviado já decidiu'
  );
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', 'msg-fixture-1');

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_blocked := false;
  begin perform public.decide_lesson_recording_consent_public(v_kid_token, 'Crianca Fixture', 'SELF', true, v_code);
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.sec_assert(v_blocked, 'menor decidiu sozinho com o código do responsável');

  v_wrong := lpad(((v_code::integer + 1) % 1000000)::text, 6, '0');
  v_result := public.decide_lesson_recording_consent_public(v_kid_token, 'Responsavel Fixture', 'GUARDIAN', true, v_wrong);
  perform pg_temp.sec_assert(v_result ->> 'error' = 'codigo_incorreto' and (v_result ->> 'attempts_left')::integer = 4,
    'código errado não foi recusado com as tentativas restantes');
  perform pg_temp.sec_assert(
    (select attempts = 1 from private.lesson_recording_consent_challenges
      where id = (v_issue ->> 'challenge_id')::uuid),
    'tentativa errada não ficou gravada'
  );
  perform pg_temp.sec_assert(
    public.decide_lesson_recording_consent_public(v_kid_token, 'Responsavel Fixture', 'GUARDIAN', true, 'abc') ->> 'error'
      = 'codigo_invalido',
    'código fora do formato aceito'
  );
  perform pg_temp.sec_assert(
    not exists (select 1 from private.lesson_recording_consents where subject_id = v_kid),
    'decisão gravada sem código válido'
  );

  v_result := public.decide_lesson_recording_consent_public(v_kid_token, ' Responsavel   Fixture ', 'GUARDIAN', true, v_code);
  perform pg_temp.sec_assert(v_result ->> 'decision' = 'ACCEPTED', 'aceite do responsável com código certo falhou');
  perform pg_temp.sec_assert(v_result ->> 'verified_phone' = '(11) •••••-0001', 'resposta sem o telefone verificado');
  perform pg_temp.sec_assert(
    public.decide_lesson_recording_consent_public(v_kid_token, 'Responsavel Fixture', 'GUARDIAN', false, v_code) ->> 'error'
      = 'codigo_expirado',
    'o mesmo código foi usado duas vezes'
  );

  -- Aluno sem telefone no cadastro: a escola precisa cadastrar.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.sec_assert(
    public.issue_lesson_recording_consent_code(v_nophone_token, 'GUARDIAN') ->> 'error' = 'telefone_nao_cadastrado',
    'emitiu código sem telefone cadastrado'
  );

  -- Adulto atestado: código no telefone dele; expiração e bloqueio.
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'SELF');
  perform pg_temp.sec_assert(v_issue ->> 'destination' = '5511900000002', 'código do adulto foi para outro telefone');
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', null);
  update private.lesson_recording_consent_challenges
     set expires_at = now() - interval '1 second'
   where id = (v_issue ->> 'challenge_id')::uuid;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.sec_assert(
    public.decide_lesson_recording_consent_public(v_token, 'Adulta Sem Data Fixture', 'SELF', true, v_issue ->> 'code') ->> 'error'
      = 'codigo_expirado',
    'código vencido foi aceito'
  );

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'SELF');
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', null);
  v_code := v_issue ->> 'code';
  v_wrong := lpad(((v_code::integer + 7) % 1000000)::text, 6, '0');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  for i in 1..4 loop
    perform public.decide_lesson_recording_consent_public(v_token, 'Adulta Sem Data Fixture', 'SELF', true, v_wrong);
  end loop;
  v_result := public.decide_lesson_recording_consent_public(v_token, 'Adulta Sem Data Fixture', 'SELF', true, v_wrong);
  perform pg_temp.sec_assert(v_result ->> 'error' = 'codigo_bloqueado', 'quinta tentativa errada não bloqueou');
  perform pg_temp.sec_assert(
    public.decide_lesson_recording_consent_public(v_token, 'Adulta Sem Data Fixture', 'SELF', true, v_code) ->> 'ok'
      = 'false',
    'código certo passou depois do bloqueio'
  );

  -- Limite: 3 envios por hora por link (já saíram 2); envio que não saiu
  -- não conta — se contasse, o próximo pedido já seria barrado.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'SELF');
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'NOT_SENT', null);
  perform pg_temp.sec_assert(
    (select invalidated_at is not null from private.lesson_recording_consent_challenges
      where id = (v_issue ->> 'challenge_id')::uuid),
    'código que não saiu continuou válido'
  );
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'SELF');
  perform pg_temp.sec_assert((v_issue ->> 'ok')::boolean, 'envio que não saiu contou no limite');
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', null);
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'SELF');
  perform pg_temp.sec_assert(
    v_issue ->> 'error' = 'limite_de_envios' and (v_issue ->> 'retry_after_seconds')::integer >= 60,
    'quarto envio na mesma hora não foi barrado'
  );

  -- Link novo: limite zera, e o código do link antigo não serve mais.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_link := public.create_lesson_recording_consent_link(v_adult);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(v_link ->> 'token', 'SELF');
  perform pg_temp.sec_assert((v_issue ->> 'ok')::boolean, 'link novo não emitiu código');
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'AMBIGUOUS', null);
  -- Reenvio barrado pelo teto do WhatsApp não mata o código que já chegou.
  perform public.settle_lesson_recording_consent_code(
    (public.issue_lesson_recording_consent_code(v_link ->> 'token', 'SELF') ->> 'challenge_id')::uuid,
    'NOT_SENT', null);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_blocked := false;
  begin perform public.decide_lesson_recording_consent_public(v_token, 'Adulta Sem Data Fixture', 'SELF', true, v_issue ->> 'code');
  exception when invalid_parameter_value then v_blocked := true; end;
  perform pg_temp.sec_assert(v_blocked, 'link substituído ainda decidiu');
  v_result := public.decide_lesson_recording_consent_public(v_link ->> 'token', 'Adulta Sem Data Fixture', 'SELF', true, v_issue ->> 'code');
  perform pg_temp.sec_assert(v_result ->> 'decision' = 'ACCEPTED', 'aceite do adulto com código falhou');
  v_challenge := (v_issue ->> 'challenge_id')::uuid;

  perform set_config('fx.adult_challenge', v_challenge::text, true);
  perform set_config('fx.adult_token', v_link ->> 'token', true);
end
$otp$;

-- 5b. Link criado por outro caminho (o envio em lote insere direto na
--     tabela, sem telefones): o trigger congela o telefone ATESTADO, ignora o
--     que o criador mandou, e a página devolve máscara e motivo.
do $any_creator$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_kid3 uuid := current_setting('fx.kid3')::uuid;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_link private.lesson_recording_consent_links;
  v_page jsonb;
  v_blocked boolean;
begin
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, guardian_phone)
  values ('sec-consent-fixture', v_kid3, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_admin,
    now() + interval '30 days', '5511911112222')
  returning * into v_link;
  perform pg_temp.sec_assert(v_link.guardian_phone = '5511900000005',
    'link criado fora da tela não congelou o telefone atestado (vínculo do responsável): ' || coalesce(v_link.guardian_phone, 'nulo'));
  perform pg_temp.sec_assert(v_link.student_phone = '5511900000005',
    'link criado fora da tela sem o telefone do aluno');

  v_blocked := false;
  begin
    update private.lesson_recording_consent_links set guardian_phone = '5511911112222' where id = v_link.id;
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.sec_assert(v_blocked, 'telefone congelado no link foi trocado depois');

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_page := public.get_lesson_recording_consent_public(v_token);
  perform pg_temp.sec_assert(
    v_page ->> 'guardian_phone_masked' = '(11) •••••-0005'
      and v_page ->> 'guardian_reason' = 'AGE_UNKNOWN'
      and (v_page ->> 'requires_guardian')::boolean
      and v_page ? 'current_effective',
    'página do link criado fora da tela sem máscara, motivo ou validade do aceite'
  );
  perform pg_temp.sec_assert(
    v_page = v_page || private.lesson_recording_public_link_fields(v_link.id),
    'página pública não inclui os campos de lesson_recording_public_link_fields'
  );
  perform set_config('fx.kid3_token', v_token, true);
end
$any_creator$;

-- 5c. Dois pedidos de código ao mesmo tempo (duas abas, retry) que terminam
--     fora de ordem: o mais novo sobrevive. Antes, cada um derrubava o outro.
do $concurrent$
declare
  v_token text := current_setting('fx.kid3_token');
  v_first jsonb;
  v_second jsonb;
  v_result jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_first := public.issue_lesson_recording_consent_code(v_token, 'GUARDIAN');
  v_second := public.issue_lesson_recording_consent_code(v_token, 'GUARDIAN');
  perform public.settle_lesson_recording_consent_code((v_second ->> 'challenge_id')::uuid, 'SENT', 'msg-b');
  perform public.settle_lesson_recording_consent_code((v_first ->> 'challenge_id')::uuid, 'SENT', 'msg-a');
  perform pg_temp.sec_assert(
    (select invalidated_at is null from private.lesson_recording_consent_challenges
      where id = (v_second ->> 'challenge_id')::uuid),
    'o envio mais antigo, confirmado por último, derrubou o código mais novo'
  );
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.decide_lesson_recording_consent_public(v_token, 'Mae Titular Fixture', 'GUARDIAN', true, v_second ->> 'code');
  perform pg_temp.sec_assert(v_result ->> 'decision' = 'ACCEPTED',
    'código mais novo não valeu depois de dois pedidos simultâneos: ' || v_result::text);
end
$concurrent$;

-- 5d. Tetos acumulados por link: 6 envios por dia, 10 no total, 15
--     tentativas erradas somando todos os códigos. Batido o total, o link é
--     bloqueado e a escola precisa gerar outro.
do $caps$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_kid3 uuid := current_setting('fx.kid3')::uuid;
  v_token text;
  v_link_id uuid;
  v_issue jsonb;
  v_result jsonb;
  v_blocked boolean;
begin
  -- Dia: 6 códigos saíram entre 2 e 7 horas atrás (fora da janela de 1 hora).
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_token := public.create_lesson_recording_consent_link(v_kid3) ->> 'token';
  select id into v_link_id from private.lesson_recording_consent_links
   where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');
  insert into private.lesson_recording_consent_challenges (
    id, link_id, tenant_id, student_id, relation, destination, code_hash, delivery_status, created_at, expires_at)
  select gen_random_uuid(), v_link_id, 'sec-consent-fixture', v_kid3, 'GUARDIAN', '5511900000005',
         encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), 'SENT',
         now() - make_interval(hours => hours), now() - make_interval(hours => hours) + interval '10 minutes'
  from generate_series(2, 7) as hours;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'GUARDIAN');
  perform pg_temp.sec_assert(
    v_issue ->> 'error' = 'limite_diario' and (v_issue ->> 'retry_after_seconds')::integer > 3600,
    'sétimo código em 24 horas não foi barrado: ' || v_issue::text
  );

  -- Total: 10 códigos ao longo da vida do link (dias atrás) fecham o link.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_token := public.create_lesson_recording_consent_link(v_kid3) ->> 'token';
  select id into v_link_id from private.lesson_recording_consent_links
   where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');
  insert into private.lesson_recording_consent_challenges (
    id, link_id, tenant_id, student_id, relation, destination, code_hash, delivery_status, created_at, expires_at)
  select gen_random_uuid(), v_link_id, 'sec-consent-fixture', v_kid3, 'GUARDIAN', '5511900000005',
         encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), 'SENT',
         now() - make_interval(days => days), now() - make_interval(days => days) + interval '10 minutes'
  from generate_series(2, 11) as days;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'GUARDIAN');
  perform pg_temp.sec_assert(v_issue ->> 'error' = 'link_bloqueado', 'décimo primeiro código do link não fechou o link: ' || v_issue::text);
  perform pg_temp.sec_assert(
    (select blocked_reason = 'CODE_SENDS' and blocked_at is not null and revoked_at is not null
       from private.lesson_recording_consent_links where id = v_link_id),
    'link não ficou bloqueado com o motivo'
  );
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.sec_assert(
    (public.get_lesson_recording_consent_public(v_token) ->> 'blocked')::boolean,
    'página não disse que o link foi bloqueado'
  );
  v_blocked := false;
  begin perform public.decide_lesson_recording_consent_public(v_token, 'Mae Titular Fixture', 'GUARDIAN', true, '123456');
  exception when invalid_parameter_value then v_blocked := sqlerrm = 'link_bloqueado'; end;
  perform pg_temp.sec_assert(v_blocked, 'link bloqueado ainda aceitou decisão');

  -- Tentativas: 14 erradas em códigos anteriores + 1 no código vivo = 15.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_token := public.create_lesson_recording_consent_link(v_kid3) ->> 'token';
  select id into v_link_id from private.lesson_recording_consent_links
   where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');
  insert into private.lesson_recording_consent_challenges (
    id, link_id, tenant_id, student_id, relation, destination, code_hash, delivery_status, attempts,
    created_at, expires_at, invalidated_at)
  select gen_random_uuid(), v_link_id, 'sec-consent-fixture', v_kid3, 'GUARDIAN', '5511900000005',
         encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), 'SENT', tries,
         now() - interval '2 days', now() - interval '2 days' + interval '10 minutes', now() - interval '2 days'
  from unnest(array[5, 5, 4]) as tries;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_issue := public.issue_lesson_recording_consent_code(v_token, 'GUARDIAN');
  perform public.settle_lesson_recording_consent_code((v_issue ->> 'challenge_id')::uuid, 'SENT', null);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.decide_lesson_recording_consent_public(v_token, 'Mae Titular Fixture', 'GUARDIAN', true,
    lpad((((v_issue ->> 'code')::integer + 1) % 1000000)::text, 6, '0'));
  perform pg_temp.sec_assert(v_result ->> 'error' = 'link_bloqueado',
    'décima quinta tentativa errada no link não fechou o link: ' || v_result::text);
  perform pg_temp.sec_assert(
    (select blocked_reason = 'CODE_ATTEMPTS' from private.lesson_recording_consent_links where id = v_link_id),
    'link fechado sem o motivo das tentativas'
  );
  -- Os links anteriores do aluno ficam para trás no painel (todos nasceram
  -- nesta transação, com o mesmo created_at).
  update private.lesson_recording_consent_links set created_at = now() - interval '1 day'
   where student_id = v_kid3 and id <> v_link_id;
end
$caps$;


-- 6. O que fica registrado e o que vale.
do $recorded$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_adult uuid := current_setting('fx.adult')::uuid;
  v_kid uuid := current_setting('fx.kid')::uuid;
  v_teacher uuid := current_setting('fx.teacher')::uuid;
  v_blocked boolean;
  v_result jsonb;
begin
  perform pg_temp.sec_assert(
    exists (select 1 from private.lesson_recording_consents
      where subject_id = v_adult and decision = 'ACCEPTED' and verification = 'WHATSAPP_CODE'
        and verified_phone = '(11) •••••-0002'
        and verification_challenge_id = current_setting('fx.adult_challenge')::uuid),
    'decisão sem a marca de verificação por código'
  );

  -- Decisão pelo link sem código não entra nem por SQL.
  v_blocked := false;
  begin
    insert into private.lesson_recording_consents (
      tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
      term_audience, term_version, source
    ) values ('sec-consent-fixture', v_kid, 'STUDENT', 'ACCEPTED', 'Sem Codigo', 'GUARDIAN',
      'STUDENT', (private.lesson_recording_current_term('STUDENT')).version, 'LINK');
  exception when check_violation then v_blocked := true; end;
  perform pg_temp.sec_assert(v_blocked, 'decisão pelo link sem código foi aceita pela tabela');

  -- Aceite do professor gravado direto: a rota dele é de outra frente.
  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, recorded_by
  ) values ('sec-consent-fixture', v_teacher, 'TEACHER', 'ACCEPTED', 'Professora Fixture', 'SELF',
    'TEACHER', (private.lesson_recording_current_term('TEACHER')).version, 'APP', v_teacher);
  perform pg_temp.sec_assert(private.lesson_recording_active(v_adult, v_teacher), 'aceite verificado do adulto não valeu');
  perform pg_temp.sec_assert(private.lesson_recording_active(v_kid, v_teacher), 'aceite do responsável não valeu');

  -- A escola descobre que o "adulto" é menor: o aceite como aluno perde a validade.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.set_student_birth_date(v_adult, ((now() at time zone 'America/Sao_Paulo')::date - interval '15 years')::date,
    'Correção: aluno tem 15 anos');
  perform pg_temp.sec_assert(not private.lesson_recording_active(v_adult, v_teacher),
    'aceite do próprio aluno seguiu valendo depois de a escola registrar que é menor');

  -- E a página pública não mostra esse aceite como resolvido.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_result := public.get_lesson_recording_consent_public(current_setting('fx.adult_token'));
  perform pg_temp.sec_assert(
    v_result ->> 'current_decision' = 'ACCEPTED'
      and not (v_result ->> 'current_effective')::boolean
      and v_result ->> 'current_not_effective_reason' = 'GUARDIAN_REQUIRED'
      and v_result ->> 'guardian_reason' = 'MINOR',
    'página pública mostrou como resolvido um aceite que não vale mais: ' || v_result::text
  );

end
$recorded$;

-- 7. Painel da escola (com aula no período para aparecer na lista).
do $panel$
declare
  v_admin uuid := current_setting('fx.admin')::uuid;
  v_adult uuid := current_setting('fx.adult')::uuid;
  v_kid uuid := current_setting('fx.kid')::uuid;
  v_nophone uuid := current_setting('fx.nophone')::uuid;
  v_kid3 uuid := current_setting('fx.kid3')::uuid;
  v_teacher uuid := current_setting('fx.teacher')::uuid;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key) values
    (gen_random_uuid(), 'sec-consent-fixture', v_adult, v_teacher, v_today, now() + interval '1 hour', now() + interval '90 minutes', 'sec-adult'),
    (gen_random_uuid(), 'sec-consent-fixture', v_kid, v_teacher, v_today, now() + interval '2 hours', now() + interval '150 minutes', 'sec-kid'),
    (gen_random_uuid(), 'sec-consent-fixture', v_nophone, v_teacher, v_today, now() + interval '3 hours', now() + interval '210 minutes', 'sec-nophone'),
    (gen_random_uuid(), 'sec-consent-fixture', v_kid3, v_teacher, v_today, now() + interval '4 hours', now() + interval '270 minutes', 'sec-kid3');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_result := public.list_lesson_recording_consents();
  perform pg_temp.sec_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_kid::text and item ->> 'guardian_reason' = 'MINOR'
        and item ->> 'contact_phone' is null
        and (item ->> 'guardian_phone_unconfirmed')::boolean
        and item ->> 'link_code_phone_masked' = '(11) •••••-0001'
        and item ->> 'verified_phone' = '(11) •••••-0001'
        and (item ->> 'effective')::boolean),
    'painel usou o telefone que o próprio aluno gravou, ou perdeu o telefone do link e a verificação do menor'
  );
  perform pg_temp.sec_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_kid3::text
        and item ->> 'contact_phone' = '5511900000005'
        and (item ->> 'guardian_phone_same_as_student')::boolean
        and not (item ->> 'guardian_phone_unconfirmed')::boolean
        and item ->> 'link_blocked_reason' = 'CODE_ATTEMPTS'),
    'painel não mostrou o link bloqueado por tentativas nem o aviso de número igual ao do aluno'
  );
  perform pg_temp.sec_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_nophone::text and item ->> 'guardian_reason' = 'AGE_UNKNOWN'
        and item ->> 'contact_phone' is null),
    'painel não sinalizou idade desconhecida sem telefone'
  );
  perform pg_temp.sec_assert(
    exists (select 1 from jsonb_array_elements(v_result -> 'students') as item
      where item ->> 'student_id' = v_adult::text and item ->> 'guardian_reason' = 'MINOR'
        and item ->> 'decision' = 'ACCEPTED' and not (item ->> 'effective')::boolean
        and item ->> 'verification' = 'WHATSAPP_CODE'),
    'painel não mostrou que o aceite do aluno perdeu a validade'
  );
end
$panel$;

rollback;
