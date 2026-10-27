\set ON_ERROR_STOP on
-- Decisões de 27/10/2026: professor sem CNPJ assina o contrato geral v2 (pessoa
-- física) e o termo individual como autônomo; cobertura pontual de aluno atual
-- dispensa termo quando o substituto tem contrato geral aceito.
begin;
create or replace function pg_temp.pf_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'professor autonomo: %',m;end if;end$$;
do $test$
declare tenant text:='pf-teacher-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();cover uuid:=gen_random_uuid();pending_cover uuid:=gen_random_uuid();student uuid:=gen_random_uuid();new_student uuid:=gen_random_uuid();director uuid:=gen_random_uuid();
 today date:=(now() at time zone 'America/Sao_Paulo')::date;original_eligibility text;r jsonb;term uuid;body text;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status,school_info) values(tenant,'PF teacher fixture',tenant,'active',jsonb_build_object('legalName','Escola Fixture Ltda','cnpj','11222333000181','address','Rua Fixture, 1','email','legal@example.invalid','phone','5511999999999','city','Cidade Fixture','state','SP','legalRepresentativeName','Diretor Fixture','legalRepresentativeSignaturePath',tenant||'/legal-representative-signature/00000000-0000-4000-8000-000000000001.png'));
 insert into public.tenant_contract_terms(tenant_id,contract_kind,terms_version,note) values(tenant,'TEACHER',3,'fixture');
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,cover,pending_cover,student,new_student,director]) f(id);
 update public.profiles set tenant_id=tenant,full_name=case id when teacher then 'Professor Fixture' when cover then 'Substituto Fixture' when pending_cover then 'Pendente Fixture' when director then 'Diretor Fixture' when student then 'Aluno Antigo' else 'Aluno Novo' end,
  role=case when id in(teacher,cover,pending_cover) then 'TEACHER' when id=director then 'SCHOOL_ADMIN' else 'STUDENT' end,is_test_account=true,phone=null,status='Ativo',lifecycle_status='active',
  contract_accepted=(id not in(teacher,pending_cover)),accepted_at=null,hourly_rate=8 where id=any(array[teacher,cover,pending_cover,student,new_student,director]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id=tenant on conflict(user_id) do update set tenant_id=excluded.tenant_id;
 -- Aluno antigo do professor, anterior à política.
 update public.profiles set created_at=now()-interval '60 days',professor_id=teacher where id=student;
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id and m.status='ACTIVE' and m.role='TEACHER' where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and p.lifecycle_status='active' and p.status='Ativo') $body$ $stub$;

 -- 1. Contrato geral: sem CNPJ, o professor assina a v2 mesmo com a v3 oferecida.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.accept_teacher_contract('Professor Fixture',3);
 perform pg_temp.pf_assert(r->>'error'='versao_invalida','v3 sem CNPJ pela API antiga');
 r:=public.accept_teacher_contract('Professor Fixture',1);
 perform pg_temp.pf_assert(r->>'ok' is distinct from 'true','v1 aceita com v3 oferecida');
 r:=public.accept_teacher_contract('Professor Fixture',2);
 perform pg_temp.pf_assert(r->>'ok'='true' and r->>'terms_version'='2','contrato PF recusado: '||r::text);
 perform pg_temp.pf_assert((select contract_accepted and nullif(cnpj,'') is null from public.profiles where id=teacher),'aceite PF nao registrado ou CNPJ inventado');
 perform pg_temp.pf_assert(exists(select 1 from public.tenant_contract_records where user_id=teacher and contract_kind='TEACHER' and (commercial_snapshot->>'contractTermsVersion')='2'),'copia da v2 ausente');
 perform pg_temp.pf_assert(coalesce(current_setting('app.teacher_pf_contract',true),'')='','marca do caminho PF vazou');

 -- 2. Termo individual com prestador pessoa física.
 begin perform public.teacher_student_terms('identity',null,'{"kind":"INDIVIDUAL","representativeCpf":"11111111111","companyAddress":"Rua do Professor, 10","representativeHasAuthority":true}'::jsonb);raise exception 'CPF invalido aceito';exception when raise_exception then if sqlerrm='CPF invalido aceito' then raise;end if;end;
 r:=public.teacher_student_terms('identity',null,'{"kind":"INDIVIDUAL","representativeCpf":"529.982.247-25","companyAddress":"Rua do Professor, 10","representativeHasAuthority":true}'::jsonb);
 perform pg_temp.pf_assert((select identity->>'kind'='INDIVIDUAL' and identity->>'representativeCpf'='52998224725' from private.teacher_service_identities where teacher_id=teacher),'identidade PF nao gravada');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 insert into private.teacher_student_term_policy(tenant_id,enabled,starts_at) values(tenant,true,now()-interval '1 day');
 r:=public.teacher_student_terms('prepare',gen_random_uuid(),jsonb_build_object('student_id',new_student,'teacher_id',teacher,'mode','RECURRING','starts_on',today+3,'slots','[{"day":2,"time":"18:00"}]'::jsonb));term:=(r->>'id')::uuid;
 select t.body into body from private.teacher_student_terms t where t.id=term;
 perform pg_temp.pf_assert(position('Prestador pessoa física' in body)>0 and position('CPF 52998224725' in body)>0 and position('pessoa física, autônomo' in body)>0,'via PF sem identificacao correta');
 r:=public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',(select content_hash from private.teacher_student_terms where id=term),'typed_name','Diretor Fixture','accepted',true,'has_authority',true));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',(select content_hash from private.teacher_student_terms where id=term),'typed_name','Professor Fixture','accepted',true,'has_authority',true));
 perform pg_temp.pf_assert(r->>'phase'='FAMILY_PENDING','professor PF nao conseguiu assinar: '||r::text);

 -- 3. Cobertura pontual de aluno atual.
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.pf_assert(private.student_term_coverage_exempt(tenant,student,teacher,cover),'cobertura pontual de aluno atual exigiu termo');
 perform pg_temp.pf_assert(not private.student_term_coverage_exempt(tenant,student,teacher,pending_cover),'substituto sem contrato geral dispensado');
 perform pg_temp.pf_assert(not private.student_term_coverage_exempt(tenant,new_student,cover,teacher),'aluno sem vinculo com o titular dispensado');

 execute original_eligibility;
end;$test$;
rollback;
