\set ON_ERROR_STOP on
-- Reposição de aluno atual dada por substituto com contrato geral não exige
-- termo individual; substituto sem contrato geral continua barrado.
begin;
create or replace function pg_temp.rs_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'reposicao por substituto: %',m;end if;end$$;
do $test$
declare tenant text:='rs-sub-fixture-'||gen_random_uuid();titular uuid:=gen_random_uuid();cover uuid:=gen_random_uuid();no_contract uuid:=gen_random_uuid();student uuid:=gen_random_uuid();
 ok_id uuid:=gen_random_uuid();bad_id uuid:=gen_random_uuid();future text:=to_char((now() at time zone 'America/Sao_Paulo')::date+5,'YYYY-MM-DD');blocked boolean:=false;original_eligibility text;
begin
 perform pg_temp.rs_assert(strpos(pg_get_functiondef('private.guard_student_individual_term()'::regprocedure),'reposicao_por_substituto')>0,'guarda sem o remendo');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform set_config('app.reschedule_silent','on',true);
 insert into public.tenants(id,name,slug,saas_status) values(tenant,'RS fixture',tenant,'active');
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[titular,cover,no_contract,student]) f(id);
 update public.profiles set tenant_id=tenant,full_name='Fixture '||left(id::text,6),role=case when id=student then 'STUDENT' else 'TEACHER' end,is_test_account=true,phone=null,
  status='Ativo',lifecycle_status='active',contract_accepted=(id<>no_contract) where id=any(array[titular,cover,no_contract,student]);
 update public.profiles set created_at=now()-interval '60 days',professor_id=titular where id=student;
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id and m.status='ACTIVE' and m.role='TEACHER' where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and p.lifecycle_status='active' and p.status='Ativo') $body$ $stub$;
 insert into private.teacher_student_term_policy(tenant_id,enabled,starts_at) values(tenant,true,now()-interval '1 day');
 insert into public.reschedules(id,tenant_id,student_id,teacher_id,date,time,fault_type) values(ok_id,tenant,student,cover,'Pendente','Pendente','STUDENT'),(bad_id,tenant,student,no_contract,'Pendente','Pendente','STUDENT');
 perform pg_temp.rs_assert(public.teacher_opportunity_recipient_eligible(tenant,cover),'fixture: substituto inelegivel');
 update public.reschedules set date=future,time='10:00' where id=ok_id;
 perform pg_temp.rs_assert((select date from public.reschedules where id=ok_id)=future,'reposicao do substituto nao marcada');
 begin update public.reschedules set date=future,time='11:00' where id=bad_id;exception when sqlstate 'PT412' then blocked:=true;end;
 perform pg_temp.rs_assert(blocked,'substituto sem contrato geral marcou reposicao sem termo');
 execute original_eligibility;
end;$test$;
rollback;
