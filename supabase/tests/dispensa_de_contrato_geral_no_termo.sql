\set ON_ERROR_STOP on
-- Professor sem contrato geral: sem dispensa o termo recusa com o motivo real; com a
-- dispensa assina, sem que o contrato vire aceito; dispensa retirada volta a recusar.
begin;
create or replace function pg_temp.dc_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'dispensa de contrato: %',m;end if;end$$;
do $test$
declare tenant text:='waiver-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();student uuid:=gen_random_uuid();director uuid:=gen_random_uuid();
 today date:=(now() at time zone 'America/Sao_Paulo')::date;original_eligibility text;r jsonb;term uuid;t private.teacher_student_terms;refused text;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status,custom_domain,custom_domain_verified,school_info) values(tenant,'Waiver fixture',tenant,'active','waiver.example.com',true,jsonb_build_object('legalName','Escola Dispensa Ltda','cnpj','11222333000181','address','Rua Fixture, 1','email','legal@example.invalid','phone','5511999999999','city','Cidade Fixture','state','SP','legalRepresentativeName','Diretor Dispensa','legalRepresentativeSignaturePath',tenant||'/legal-representative-signature/00000000-0000-4000-8000-000000000001.png'));
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,student,director]) f(id);
 update public.profiles set tenant_id=tenant,full_name=case id when teacher then 'Professor Dispensa' when director then 'Diretor Dispensa' else 'Aluna Dispensa' end,
  role=case id when teacher then 'TEACHER' when director then 'SCHOOL_ADMIN' else 'STUDENT' end,is_test_account=true,
  phone=case id when teacher then '11988887781' when director then '11988887783' else null end,
  status='Ativo',lifecycle_status='active',contract_accepted=(id<>teacher),hourly_rate=8,monthly_fee=777 where id=any(array[teacher,student,director]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id=tenant on conflict(user_id) do update set tenant_id=excluded.tenant_id;
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id and m.status='ACTIVE' and m.role='TEACHER' where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and p.lifecycle_status='active' and p.status='Ativo') $body$ $stub$;
 insert into private.teacher_service_identities(tenant_id,teacher_id,identity) values(tenant,teacher,'{"kind":"INDIVIDUAL","companyName":"Professor Dispensa (pessoa física, autônomo)","cnpj":"não se aplica (pessoa física)","companyAddress":"Rua do Professor, 10","representativeCpf":"52998224725","representativeHasAuthority":true}');
 insert into private.teacher_student_term_policy(tenant_id,enabled,starts_at) values(tenant,true,now()-interval '1 day');

 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('prepare',gen_random_uuid(),jsonb_build_object('student_id',student,'teacher_id',teacher,'mode','RECURRING','starts_on',today+3,'slots','[{"day":2,"time":"18:00"}]'::jsonb));term:=(r->>'id')::uuid;
 select * into t from private.teacher_student_terms where id=term;

 -- 1. Sem dispensa: recusa dizendo o motivo real.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 begin
  r:=public.teacher_student_terms('sign',term,jsonb_build_object('typed_name','Professor Dispensa','content_hash',t.content_hash,'accepted',true,'has_authority',true));
 exception when others then refused:=sqlerrm;end;
 perform pg_temp.dc_assert(refused like 'O contrato geral do professor está pendente%','motivo real nao apareceu: '||coalesce(refused,'assinou sem dispensa'));
 perform pg_temp.dc_assert(not private.student_term_source_valid(t),'termo valido sem contrato nem dispensa');

 -- 2. A dispensa exige motivo e autor da direção da escola.
 refused:=null;
 begin perform private.set_teacher_general_contract_waiver(tenant,teacher,director,true,'curto');exception when others then refused:=sqlerrm;end;
 perform pg_temp.dc_assert(refused='dispensa_motivo_obrigatorio','motivo curto aceito');
 refused:=null;
 begin perform private.set_teacher_general_contract_waiver(tenant,teacher,teacher,true,'Decisão de teste da direção');exception when others then refused:=sqlerrm;end;
 perform pg_temp.dc_assert(refused='dispensa_autor_invalido','professor dispensou a si mesmo');

 -- 3. Com a dispensa: assina, e o contrato continua NÃO aceito.
 perform private.set_teacher_general_contract_waiver(tenant,teacher,director,true,'Decisão de teste da direção');
 perform private.set_teacher_general_contract_waiver(tenant,teacher,director,true,'Decisão de teste da direção');
 perform pg_temp.dc_assert((select count(*) from private.teacher_general_contract_waivers where tenant_id=tenant)=1,'dispensa duplicada');
 perform pg_temp.dc_assert(private.student_term_source_valid(t),'dispensa nao liberou o termo');
 r:=public.teacher_student_terms('list',null,'{}');
 perform pg_temp.dc_assert(r->>'general_contract_waived'='true' and r->>'general_contract_accepted'='false','lista nao informa a dispensa');
 r:=public.teacher_student_terms('sign',term,jsonb_build_object('typed_name','Professor Dispensa','content_hash',t.content_hash,'accepted',true,'has_authority',true));
 perform pg_temp.dc_assert(r->>'ok'='true','assinatura com dispensa falhou');
 perform pg_temp.dc_assert((select teacher_signed_at is not null from private.teacher_student_terms where id=term),'assinatura nao gravada');
 perform pg_temp.dc_assert(not (select contract_accepted from public.profiles where id=teacher),'dispensa marcou contrato como aceito');

 -- 4. Retirada: volta a recusar, e a trilha fica.
 perform private.set_teacher_general_contract_waiver(tenant,teacher,director,false,'Retirada de teste da direção');
 perform pg_temp.dc_assert(not private.student_term_source_valid(t),'dispensa retirada ainda libera');
 perform pg_temp.dc_assert((select revoked_at is not null from private.teacher_general_contract_waivers where tenant_id=tenant),'trilha da retirada perdida');

 -- 5. O navegador não alcança a dispensa.
 perform pg_temp.dc_assert(not has_table_privilege('authenticated','private.teacher_general_contract_waivers','SELECT'),'tabela exposta');
 perform pg_temp.dc_assert(not has_function_privilege('authenticated','private.set_teacher_general_contract_waiver(text,uuid,uuid,boolean,text)','EXECUTE') and not has_function_privilege('anon','private.set_teacher_general_contract_waiver(text,uuid,uuid,boolean,text)','EXECUTE'),'dispensa exposta');

 execute original_eligibility;
end;$test$;
rollback;
