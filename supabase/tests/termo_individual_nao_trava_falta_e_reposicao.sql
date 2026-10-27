\set ON_ERROR_STOP on
-- Regressão de 27/10/2026: com o termo individual ligado, lançar falta (reposição
-- 'Pendente') e marcar reposição de aluno antigo eram recusados. Professor novo
-- continua exigindo termo; proposta nova avisa a direção e, assinada pela escola,
-- o professor.
begin;
create or replace function pg_temp.fix_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'termo nao trava falta: %',m;end if;end$$;
do $test$
declare tenant text:='term-pending-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();other_teacher uuid:=gen_random_uuid();old_student uuid:=gen_random_uuid();new_student uuid:=gen_random_uuid();director uuid:=gen_random_uuid();
 booking uuid:=gen_random_uuid();resched uuid:=gen_random_uuid();today date:=(now() at time zone 'America/Sao_Paulo')::date;original_eligibility text;r jsonb;term uuid;v_hash text;group_jid text:='120363999999999999@g.us';
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status,school_info) values(tenant,'Term pending fixture',tenant,'active',jsonb_build_object('legalName','Escola Fixture Ltda','cnpj','11222333000181','address','Rua Fixture, 1','email','legal@example.invalid','phone','5511999999999','city','Cidade Fixture','state','SP','legalRepresentativeName','Diretor Fixture','legalRepresentativeSignaturePath',tenant||'/legal-representative-signature/00000000-0000-4000-8000-000000000001.png'));
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,other_teacher,old_student,new_student,director]) f(id);
 update public.profiles set tenant_id=tenant,full_name=case id when teacher then 'Professor Fixture' when other_teacher then 'Outro Fixture' when director then 'Diretor Fixture' when old_student then 'Aluno Antigo' else 'Aluno Novo' end,
  role=case when id in(teacher,other_teacher) then 'TEACHER' when id=director then 'SCHOOL_ADMIN' else 'STUDENT' end,is_test_account=true,phone=case when id=teacher then '5511988887777' end,status='Ativo',lifecycle_status='active',contract_accepted=true,hourly_rate=8
  where id=any(array[teacher,other_teacher,old_student,new_student,director]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id=tenant on conflict(user_id) do update set tenant_id=excluded.tenant_id;
 insert into public.tenant_notice_channels(tenant_id,channel,group_jid,enabled) values(tenant,'direcao',group_jid,true);
 -- Fixtures nunca são elegíveis a mensagens; a decisão é trocada só nesta transação.
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id and m.status='ACTIVE' and m.role='TEACHER' where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and p.lifecycle_status='active' and p.status='Ativo') $body$ $stub$;

 -- Aluno antigo: cadastro e agenda anteriores à política.
 update public.profiles set created_at=now()-interval '60 days',professor_id=teacher where id=old_student;
 insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date,created_at) values(booking,tenant,teacher,old_student,'Segunda','18:00',today-50,now()-interval '50 days');
 insert into private.teacher_student_term_policy(tenant_id,enabled,starts_at) values(tenant,true,now()-interval '1 day');

 -- 1. Falta lançada: reposição 'Pendente' nunca derruba o lançamento, para ninguém.
 insert into public.reschedules(id,tenant_id,teacher_id,student_id,date,time,fault_type) values(resched,tenant,teacher,old_student,'Pendente','Pendente','STUDENT');
 insert into public.reschedules(tenant_id,teacher_id,student_id,date,time,fault_type) values(tenant,teacher,new_student,'Pendente','Pendente','TEACHER');
 insert into public.reschedules(tenant_id,teacher_id,student_id,date,time,fault_type) values(tenant,other_teacher,old_student,'Pendente',null,'TEACHER');

 -- 2. Reposição marcada com o professor de sempre do aluno antigo: sem termo.
 update public.reschedules set date=(today+3)::text,time='15:00' where id=resched;
 -- 3. Troca de horário do aluno antigo com o mesmo professor: sem termo.
 update public.bookings set time_slot='18:30' where id=booking;
 insert into public.booking_schedule_versions(booking_id,tenant_id,day_of_week,time_slot,valid_from) values(booking,tenant,'Terça','19:00',today+7);

 -- 4. Professor novo continua exigindo termo, para aluno antigo ou novo.
 begin insert into public.reschedules(tenant_id,teacher_id,student_id,date,time) values(tenant,other_teacher,old_student,(today+4)::text,'19:00');raise exception 'outro professor sem termo';exception when sqlstate 'PT412' then null;end;
 begin insert into public.reschedules(tenant_id,teacher_id,student_id,date,time) values(tenant,teacher,new_student,(today+4)::text,'19:00');raise exception 'aluno novo sem termo';exception when sqlstate 'PT412' then null;end;
 begin insert into public.bookings(tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date) values(tenant,other_teacher,old_student,'Quarta','18:00',today+3);raise exception 'agenda com outro professor sem termo';exception when sqlstate 'PT412' then null;end;
 perform pg_temp.fix_assert(private.student_term_legacy_relationship(tenant,old_student,teacher) and not private.student_term_legacy_relationship(tenant,old_student,other_teacher) and not private.student_term_legacy_relationship(tenant,new_student,teacher),'regra do vinculo antigo');

 -- 5. Proposta avisa a direção; assinatura da escola avisa o professor.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('prepare',gen_random_uuid(),jsonb_build_object('student_id',new_student,'teacher_id',teacher,'mode','RECURRING','starts_on',today+3,'slots','[{"day":1,"time":"18:00"}]'::jsonb));term:=(r->>'id')::uuid;
 perform pg_temp.fix_assert(exists(select 1 from public.notification_queue where tenant_id=tenant and idempotency_key='student-term:'||term||':proposed' and student_phone=group_jid and status='pending'),'aviso a direcao ausente');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 perform public.teacher_student_terms('identity',null,'{"companyName":"Empresa Fixture Ltda","cnpj":"12.ABC.345/01DE-35","companyAddress":"Rua Fixture, 1","representativeCpf":"52998224725","representativeHasAuthority":true}'::jsonb);
 select content_hash into v_hash from private.teacher_student_terms where id=term;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 perform public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',v_hash,'typed_name','Diretor Fixture','accepted',true,'has_authority',true));
 perform pg_temp.fix_assert(exists(select 1 from public.notification_queue where tenant_id=tenant and idempotency_key='student-term:'||term||':school-signed' and student_phone like '5511988887777%'),'aviso ao professor ausente');
 perform pg_temp.fix_assert((select count(*)=2 from public.notification_queue where tenant_id=tenant and idempotency_key like 'student-term:%'),'aviso duplicado');

 -- 6. Fachada antiga não muda status sem o financeiro.
 begin perform public.set_student_status(old_student,'Inativo');raise exception 'set_student_status mudou status';exception when insufficient_privilege then null;end;
 perform pg_temp.fix_assert((select lifecycle_status='active' and status='Ativo' from public.profiles where id=old_student),'status alterado pela fachada antiga');

 execute original_eligibility;
end;$test$;
rollback;
