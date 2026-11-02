\set ON_ERROR_STOP on
-- Tela de alunos: o professor vê só os alunos que dá aula hoje (a régua da
-- leitura de perfis) e nunca o financeiro; a direção continua vendo tudo.
begin;
create or replace function pg_temp.vp_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'visao do professor: %',m;end if;end$$;
do $test$
declare tenant text:='vp-fixture-'||gen_random_uuid();director uuid:=gen_random_uuid();teacher uuid:=gen_random_uuid();
 mine uuid:=gen_random_uuid();ghost uuid:=gen_random_uuid();r record;n int;
begin
 perform pg_temp.vp_assert(not has_function_privilege('anon','public.list_students_overview()','EXECUTE'),'aberta para anon');

 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status) values(tenant,'VP fixture',tenant,'active');
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[director,teacher,mine,ghost]) f(id);
 update public.profiles set tenant_id=tenant,full_name='Fixture '||left(id::text,6),is_test_account=true,status='Ativo',lifecycle_status='active',
  role=case when id=director then 'SCHOOL_ADMIN' when id=teacher then 'TEACHER' else 'STUDENT' end,
  monthly_fee=case when id in(mine,ghost) then 199 end,professor_id=case when id in(mine,ghost) then teacher end
  where id=any(array[director,teacher,mine,ghost]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant
  on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 -- O aluno dele tem aula viva e uma fatura em atraso; o "fantasma" saiu da escola
 -- e só sobrou um agendamento antigo cancelado.
 insert into public.bookings(tenant_id,student_id,teacher_id,day_of_week,time_slot,status) values
  (tenant,mine,teacher,'Segunda','10:00','SCHEDULED'),(tenant,ghost,teacher,'Terça','10:00','CANCELLED');
 update public.profiles set status='Inativo',lifecycle_status='offboarded' where id=ghost;
 insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,due_date,description)
  values(gen_random_uuid(),tenant,mine,'pay_vp_'||left(gen_random_uuid()::text,8),199,'OVERDUE',current_date-20,'Mensalidade fixture');

 -- Professor: só o aluno dele, sem dinheiro e sem "Pagamento em atraso".
 perform set_config('request.jwt.claims',json_build_object('sub',teacher,'role','authenticated')::text,true);
 select count(*) into n from public.list_students_overview() o where o.student_id in(mine,ghost);
 perform pg_temp.vp_assert(n=1,'professor deveria ver 1 aluno, viu '||n);
 select * into r from public.list_students_overview() o where o.student_id=mine;
 perform pg_temp.vp_assert(r.monthly_fee is null and r.status_financial is null,'mensalidade/status financeiro para o professor');
 perform pg_temp.vp_assert(r.overdue_count=0 and r.overdue_value=0,'atraso para o professor');
 perform pg_temp.vp_assert(not ('Pagamento em atraso'=any(r.risk_reasons)),'motivo financeiro para o professor');

 -- Direção: vê os dois, com o atraso.
 perform set_config('request.jwt.claims',json_build_object('sub',director,'role','authenticated')::text,true);
 select * into r from public.list_students_overview() o where o.student_id=mine;
 perform pg_temp.vp_assert(r.overdue_count=1 and r.monthly_fee=199,'direcao perdeu o financeiro');
 perform pg_temp.vp_assert('Pagamento em atraso'=any(r.risk_reasons),'direcao sem o motivo financeiro');
 perform pg_temp.vp_assert(exists(select 1 from public.list_students_overview() o where o.student_id=ghost),'direcao perdeu o aluno encerrado');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
end;$test$;
rollback;
