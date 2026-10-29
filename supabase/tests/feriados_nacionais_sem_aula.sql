\set ON_ERROR_STOP on
-- Feriado nacional: calendário (sem ponto facultativo), aviso de 7 dias e de
-- véspera só para quem tem aula no dia, idempotente, e pop-up por escola.
begin;
create or replace function pg_temp.fn_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'feriados nacionais: %',m;end if;end$$;
do $test$
declare tenant text:='fn-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();student uuid:=gen_random_uuid();other uuid:=gen_random_uuid();
 today date:=(now() at time zone 'America/Sao_Paulo')::date;d7 date;d1 date;original_eligibility text;n int;h jsonb;
 dow text[]:=array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
begin
 -- Calendário: Paixão de Cristo pela Páscoa; Carnaval e Corpus Christi ficam fora.
 perform pg_temp.fn_assert(exists(select 1 from private.brazil_national_holidays_for(2026) where holiday_date='2026-04-03'),'paixao 2026');
 perform pg_temp.fn_assert(exists(select 1 from private.brazil_national_holidays_for(2027) where holiday_date='2027-03-26'),'paixao 2027');
 perform pg_temp.fn_assert(exists(select 1 from private.brazil_national_holidays_for(2025) where holiday_date='2025-04-18'),'paixao 2025');
 perform pg_temp.fn_assert((select count(*) from private.brazil_national_holidays_for(2026))=10,'dez feriados nacionais');
 perform pg_temp.fn_assert(not exists(select 1 from private.brazil_national_holidays_for(2026) where holiday_date in('2026-02-16','2026-02-17','2026-06-04')),'ponto facultativo virou feriado');
 perform pg_temp.fn_assert(exists(select 1 from public.national_holidays where holiday_date=make_date(extract(year from today)::int,12,25)),'calendario do ano nao semeado');
 perform pg_temp.fn_assert(strpos(pg_get_functiondef('public.enqueue_attendance_confirmations()'::regprocedure),'national_holidays')>0,'confirmacao de presenca sem a trava do feriado');
 perform pg_temp.fn_assert(not has_function_privilege('anon','public.my_upcoming_national_holiday()','EXECUTE'),'pop-up aberto para anon');

 -- Feriados de mentira só nesta transação; escolas reais fora da rodada.
 d7:=today+7; d1:=today+1;
 delete from public.national_holidays where holiday_date between today+1 and today+7;
 insert into public.national_holidays(holiday_date,name) values(d7,'Feriado de teste'),(d1,'Véspera de teste');
 update private.national_holiday_notice_settings set enabled=false;

 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status) values(tenant,'FN fixture',tenant,'active');
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,student,other]) f(id);
 update public.profiles set tenant_id=tenant,full_name='Fixture '||left(id::text,6),role=case when id=teacher then 'TEACHER' else 'STUDENT' end,is_test_account=true,
  phone='1199'||lpad((abs(hashtext(id::text))%10000000)::text,7,'0'),status='Ativo',lifecycle_status='active',status_financial=null where id=any(array[teacher,student,other]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER') $body$ $stub$;
 -- O aluno tem aula nos dois feriados; o outro aluno tinha no dia, mas a aula foi cancelada.
 insert into public.bookings(tenant_id,student_id,teacher_id,day_of_week,time_slot,status) values
  (tenant,student,teacher,dow[extract(dow from d7)::int+1],'10:00','SCHEDULED'),
  (tenant,student,teacher,dow[extract(dow from d1)::int+1],'11:00','SCHEDULED'),
  (tenant,other,teacher,dow[extract(dow from d7)::int+1],'12:00','CANCELLED');

 -- Escola sem adesão não recebe nada.
 perform private.queue_national_holiday_notices();
 perform pg_temp.fn_assert(not exists(select 1 from public.notification_queue where tenant_id=tenant),'escola sem adesao recebeu aviso');

 insert into private.national_holiday_notice_settings(tenant_id,enabled,decided_by) values(tenant,true,'teste');
 perform private.queue_national_holiday_notices();
 select count(*) into n from public.notification_queue where tenant_id=tenant;
 perform pg_temp.fn_assert(n=4,'esperava aluno e professor em D7 e D1, veio '||n);
 perform pg_temp.fn_assert(exists(select 1 from public.notification_queue where tenant_id=tenant and idempotency_key=format('national-holiday:%s:D7:%s',d7,student)
   and student_id=student and message_body like '%não haverá aula%' and notification_kind='MANAGEMENT_NOTICE'),'aviso D7 do aluno');
 perform pg_temp.fn_assert(exists(select 1 from public.notification_queue where tenant_id=tenant and idempotency_key=format('national-holiday:%s:D1:%s',d1,teacher)
   and student_id is null and message_body like '%amanhã%'),'aviso D1 do professor');
 perform pg_temp.fn_assert(not exists(select 1 from public.notification_queue where tenant_id=tenant and student_id=other),'aluno sem aula no feriado foi avisado');

 perform private.queue_national_holiday_notices();
 perform pg_temp.fn_assert((select count(*) from public.notification_queue where tenant_id=tenant)=4,'aviso repetido');

 -- Aluno inativo não recebe.
 delete from public.notification_queue where tenant_id=tenant;
 update public.profiles set status='Inativo' where id=student;
 perform private.queue_national_holiday_notices();
 perform pg_temp.fn_assert(not exists(select 1 from public.notification_queue where tenant_id=tenant and student_id=student),'aluno inativo avisado');
 update public.profiles set status='Ativo' where id=student;

 -- Pop-up: próximo feriado para a escola que adotou; nada para quem não adotou.
 perform set_config('request.jwt.claims',json_build_object('sub',student,'role','authenticated')::text,true);
 h:=public.my_upcoming_national_holiday();
 perform pg_temp.fn_assert(h->>'date'=d1::text and (h->>'days_until')::int=1,'pop-up sem o proximo feriado');
 update private.national_holiday_notice_settings set enabled=false where tenant_id=tenant;
 perform pg_temp.fn_assert(public.my_upcoming_national_holiday() is null,'pop-up para escola sem adesao');

 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 execute original_eligibility;
end;$test$;
rollback;
