-- Fixtures isoladas, sem contatos e com rollback obrigatório. Nenhum envio externo.
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.pj_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if not coalesce(p_ok,false) then raise exception 'contrato PJ: %',p_message; end if; end;
$$;
do $$
declare
  v_tid text := 'contrato-pj-fixture-'||replace(gen_random_uuid()::text,'-','');
  v_other text := v_tid||'-outra';
  v_teacher uuid := gen_random_uuid();
  v_legacy uuid := gen_random_uuid();
  v_bad uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_identity jsonb := '{"companyName":"Empresa Fixture Ltda.","cnpj":"12.ABC.345/01DE-35","companyAddress":"Rua da Empresa Fixture, 1","representativeCpf":"529.982.247-25","representativeHasAuthority":true}';
  v_result jsonb;
  v_snapshot jsonb;
begin
  perform pg_temp.pj_assert(not has_function_privilege('anon','public.accept_teacher_pj_contract(text,integer,jsonb)','EXECUTE'), 'anon consegue assinar');
  perform pg_temp.pj_assert(not has_function_privilege('authenticated','private.accept_teacher_contract_v2(text,integer)','EXECUTE'), 'corpo legado acessível ao navegador');
  perform pg_temp.pj_assert(has_function_privilege('authenticated','public.accept_teacher_pj_contract(text,integer,jsonb)','EXECUTE'), 'próprio professor não pode chamar a RPC');
  perform pg_temp.pj_assert(private.teacher_provider_cnpj_valid('12.ABC.345/01DE-35') and private.teacher_provider_cnpj_valid('11.222.333/0001-81')
    and not private.teacher_provider_cnpj_valid('12ABC34501DE36') and not private.teacher_provider_cnpj_valid(null), 'validação CNPJ diverge dos exemplos e limites');
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.tenants(id,name,slug,saas_status,school_info) values
    (v_tid,'Escola PJ Fixture',v_tid,'active','{"legalName":"Escola Fixture Ltda.","cnpj":"11.222.333/0001-81","address":"Rua Escola, 1","city":"Cidade Fixture","state":"SP"}'),
    (v_other,'Outra Escola PJ Fixture',v_other,'active','{}');
  insert into public.tenant_contract_terms(tenant_id,contract_kind,terms_version) values(v_tid,'TEACHER',3),(v_other,'TEACHER',2);
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
  select id,'pj-fixture-'||id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}'
    from unnest(array[v_teacher,v_legacy,v_bad,v_student]) as fixture(id);
  update public.profiles set tenant_id=v_tid,role=case when id=v_student then 'STUDENT' else 'TEACHER' end,
    full_name='Representante Fixture',is_test_account=true,phone=null,status='Ativo',hourly_rate=8,
    contract_accepted=false,accepted_at=null where id=any(array[v_teacher,v_legacy,v_bad,v_student]);
  update public.tenants set school_info = school_info || jsonb_build_object('email','juridico@example.invalid','phone','5511999999999', 'legalRepresentativeName','Direção Fixture', 'legalRepresentativeSignaturePath',v_tid||'/legal-representative-signature/00000000-0000-4000-8000-000000000001.png') where id=v_tid;
  -- Escola antiga continua com a versão 2, sem reescrever o contrato aceito.
  update public.profiles set tenant_id=v_other where id=v_legacy;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_legacy,'role','authenticated')::text,true);
  v_result := public.accept_teacher_contract('Representante Fixture',2);
  perform pg_temp.pj_assert(v_result->>'ok'='true','aceite legado foi quebrado: '||v_result::text);
  select party_snapshot into v_snapshot from public.tenant_contract_records where user_id=v_legacy;
  v_result := public.accept_teacher_pj_contract('Representante Fixture',3,v_identity);
  perform pg_temp.pj_assert(v_result->>'error'='contrato_ja_assinado','nova RPC substituiu contrato assinado');
  perform pg_temp.pj_assert((select party_snapshot=v_snapshot from public.tenant_contract_records where user_id=v_legacy),'snapshot anterior mudou');

  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  v_result := public.accept_teacher_pj_contract('Representante Fixture',3,v_identity);
  perform pg_temp.pj_assert(v_result->>'error'='nao_autenticado','aceite sem identidade');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_student,'role','authenticated')::text,true);
  v_result := public.accept_teacher_pj_contract('Representante Fixture',3,v_identity);
  perform pg_temp.pj_assert(v_result->>'error'='contexto_invalido','aluno assinou como professor');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_teacher,'role','authenticated')::text,true);
  v_result := public.accept_teacher_contract('Representante Fixture',null);
  perform pg_temp.pj_assert(v_result->>'error'='versao_invalida','API antiga contornou PJ com versão omitida');
  v_result := public.accept_teacher_contract('Representante Fixture',3);
  perform pg_temp.pj_assert(v_result->>'error'='versao_invalida','API antiga aceitou v3 sem empresa');
  v_result := public.accept_teacher_pj_contract('Representante Fixture',2,v_identity);
  perform pg_temp.pj_assert(v_result->>'error'='versao_invalida','v2 entrou na RPC v3');
  v_result := public.accept_teacher_pj_contract('Outro nome',3,v_identity);
  perform pg_temp.pj_assert(v_result->>'error'='assinatura_invalida','assinatura não corresponde à conta');
  for v_snapshot in select x from jsonb_array_elements(jsonb_build_array(null,'{}'::jsonb,
    v_identity-'cnpj',jsonb_set(v_identity,'{cnpj}','"00000000000000"'),jsonb_set(v_identity,'{representativeHasAuthority}','false'),
    jsonb_set(v_identity,'{representativeCpf}','"529A98224725"'),jsonb_set(v_identity,'{companyName}','123'))) x loop
    v_result := public.accept_teacher_pj_contract('Representante Fixture',3,v_snapshot);
    perform pg_temp.pj_assert(v_result->>'error'='empresa_invalida','empresa inválida aceita: '||coalesce(v_snapshot::text,'null'));
  end loop;
  perform pg_temp.pj_assert(not exists(select 1 from public.tenant_contract_records where user_id=v_teacher),'falha parcial deixou cópia');
  -- Uma página aberta antes da troca de versão não pode assinar depois dela.
  update public.tenant_contract_terms set terms_version=2 where tenant_id=v_tid and contract_kind='TEACHER';
  v_result := public.accept_teacher_pj_contract('Representante Fixture',3,v_identity);
  perform pg_temp.pj_assert(v_result->>'error'='versao_invalida','página desatualizada foi aceita');
  update public.tenant_contract_terms set terms_version=3 where tenant_id=v_tid and contract_kind='TEACHER';
  v_result := public.accept_teacher_pj_contract('Representante Fixture',3,v_identity);
  perform pg_temp.pj_assert(v_result->>'ok'='true','v3 válida foi recusada: '||v_result::text);
  select party_snapshot into v_snapshot from public.tenant_contract_records where user_id=v_teacher;
  perform pg_temp.pj_assert(v_snapshot#>>'{providerIdentity,cnpj}'='12ABC34501DE35'
    and v_snapshot#>>'{providerIdentity,companyName}'='Empresa Fixture Ltda.','empresa não foi congelada');
  perform pg_temp.pj_assert((select commercial_snapshot->>'contractTermsVersion'='3' and not commercial_snapshot?'rateUnit'
    from public.tenant_contract_records where user_id=v_teacher),'aceite alterou régua financeira');
  v_result := public.accept_teacher_pj_contract('Representante Fixture',3,jsonb_set(v_identity,'{companyName}','"Outra Empresa"'));
  perform pg_temp.pj_assert(v_result->>'already'='true' and (select party_snapshot=v_snapshot from public.tenant_contract_records where user_id=v_teacher),'repetição reescreveu prova');
  perform pg_temp.pj_assert((select count(*)=1 from public.contract_terms_acceptances where user_id=v_teacher),'aceite duplicado');
  -- Suspensão e contexto de outra escola não autorizam usar o perfil principal.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_bad,'role','authenticated')::text,true);
  update public.tenant_memberships set status='SUSPENDED' where user_id=v_bad;
  v_result := public.accept_teacher_pj_contract('Representante Fixture',3,v_identity);
  perform pg_temp.pj_assert(v_result->>'error'='contexto_invalido','membership suspensa assinou');
end;
$$;
rollback;
