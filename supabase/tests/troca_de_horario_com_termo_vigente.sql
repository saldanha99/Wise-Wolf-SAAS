\set ON_ERROR_STOP on
-- Troca de horário de aula fixa com o mesmo professor e termo assinado não abre
-- termo novo; aula fixa NOVA continua exigindo termo.
begin;
create or replace function pg_temp.tv_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'troca com termo vigente: %',m;end if;end$$;
do $test$
declare tenant text:='tv-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();student uuid:=gen_random_uuid();
 booking uuid:=gen_random_uuid();extra uuid:=gen_random_uuid();tomorrow date:=(now() at time zone 'America/Sao_Paulo')::date+1;
 staged jsonb;blocked boolean:=false;
begin
 perform pg_temp.tv_assert(strpos(pg_get_functiondef('private.guard_student_individual_term()'::regprocedure),'troca_de_horario_com_termo_vigente')>0,'guarda sem o remendo');
 perform pg_temp.tv_assert(strpos(pg_get_functiondef('private.student_term_stage_schedule(uuid,jsonb,date,text)'::regprocedure),'troca_de_horario_com_termo_vigente')>0,'editor sem o remendo');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status) values(tenant,'TV fixture',tenant,'active');
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,student]) f(id);
 update public.profiles set tenant_id=tenant,full_name='Fixture '||left(id::text,6),role=case when id=student then 'STUDENT' else 'TEACHER' end,is_test_account=true,phone=null,
  status='Ativo',lifecycle_status='active',contract_accepted=true where id=any(array[teacher,student]);
 update public.profiles set professor_id=teacher where id=student;
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 -- A aula fixa já existe; a política liga depois, e o aluno é posterior a ela.
 insert into public.bookings(id,tenant_id,student_id,teacher_id,day_of_week,time_slot,status,start_date) values(booking,tenant,student,teacher,'Quarta','17:00','SCHEDULED',tomorrow-7);
 insert into public.booking_schedule_versions(tenant_id,booking_id,valid_from,day_of_week,time_slot) values(tenant,booking,tomorrow-7,'Quarta','17:00');
 insert into private.teacher_student_term_policy(tenant_id,enabled,starts_at) values(tenant,true,now()-interval '1 day');
 update public.profiles set created_at=now() where id=student;
 insert into private.teacher_student_terms(tenant_id,student_id,teacher_id,source_kind,source_id,source_key,source_hash,mode,starts_on,slots,unit_rate,school_snapshot,student_name,teacher_name,status,
   school_signed_by,school_signed_at,teacher_signed_by,teacher_signed_at,family_confirmed_at)
 values(tenant,student,teacher,'MANUAL',gen_random_uuid(),'tv','tv','RECURRING',tomorrow-7,'[{"day":3,"date":null,"time":"17:00"}]',8,'{}','Aluno','Prof','EXECUTED',teacher,now(),teacher,now(),now());
 -- Troca pela função oficial do editor de agenda, como a professora.
 perform set_config('request.jwt.claims',json_build_object('sub',teacher,'role','authenticated')::text,true);
 staged:=public.teacher_apply_student_schedule_change(student,jsonb_build_array(jsonb_build_object('booking_id',booking,'new_day','Quarta','new_time','18:00')),tomorrow,'pedido da professora');
 perform pg_temp.tv_assert(coalesce((staged->>'pending_terms')::boolean,false)=false and (staged->>'changed')::int=1,'troca nao aplicada: '||coalesce(staged::text,''));
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.tv_assert((select time_slot from public.bookings where id=booking)='18:00','horario nao mudou');
 perform pg_temp.tv_assert(not exists(select 1 from private.teacher_student_terms where student_id=student and status='PROPOSED'),'termo novo aberto');
 -- Aula fixa NOVA fora do termo continua barrada.
 begin insert into public.bookings(id,tenant_id,student_id,teacher_id,day_of_week,time_slot,status,start_date) values(extra,tenant,student,teacher,'Sexta','10:00','SCHEDULED',tomorrow);
 exception when sqlstate 'PT412' then blocked:=true;end;
 perform pg_temp.tv_assert(blocked,'aula nova sem termo passou');
end;$test$;
rollback;
