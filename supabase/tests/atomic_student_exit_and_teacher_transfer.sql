\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('app.reschedule_silent','on',true);
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'assertion: %',m;end if;end$$;
insert into public.tenants(id,name) values('transfer-exit-fixture','Transfer exit fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f9130000-0000-4000-8000-00000000000'||n)::uuid,'authenticated','authenticated','transfer-exit-'||n||'@example.invalid','{"provider":"email"}'::jsonb,'{"test_fixture":true}'::jsonb,now(),now() from generate_series(1,5) n;
update public.profiles set tenant_id='transfer-exit-fixture',lifecycle_status='active',status='Ativo',status_financial='ACTIVE',is_test_account=true,
 full_name='Transfer exit fixture '||right(id::text,1),role=case right(id::text,1) when '1' then 'SCHOOL_ADMIN' when '2' then 'STUDENT' when '5' then 'STUDENT' else 'TEACHER' end,
 phone=null where id::text like 'f9130000-0000-4000-8000-00000000000%';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id='transfer-exit-fixture' on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE',is_primary=true;
insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id='transfer-exit-fixture' on conflict(user_id) do update set tenant_id=excluded.tenant_id;
update public.profiles set professor_id='f9130000-0000-4000-8000-000000000003' where id='f9130000-0000-4000-8000-000000000002';
insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time) values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000004',1,'18:30');
insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date,status) values('f9131000-0000-4000-8000-000000000001','transfer-exit-fixture','f9130000-0000-4000-8000-000000000003','f9130000-0000-4000-8000-000000000002','Sexta','19:00',current_date-30,'SCHEDULED');
insert into public.class_logs(tenant_id,teacher_id,student_id,booking_id,class_date,date,presence) values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000003','f9130000-0000-4000-8000-000000000002','f9131000-0000-4000-8000-000000000001',current_date-3,current_date-3,'COMPLETED');
insert into public.notification_queue(tenant_id,student_id,student_phone,message_body,scheduled_for,status,delivery_status,notification_kind,provider_message_id,provider_instance_name)
 values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','5500000000000','fixture queued',now(),'pending','queued','LESSON_REMINDER',null,null),
 ('transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','5500000000000','fixture uncertain',now(),'processing','uncertain','LESSON_REMINDER',null,null),
 ('transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','5500000000000','fixture accepted',now(),'sent','accepted','LESSON_REMINDER','fixture-provider','fixture-instance');
update public.profiles set status='Inativo' where id='f9130000-0000-4000-8000-000000000002';
select pg_temp.assert_true((select delivery_status='skipped' from public.notification_queue where tenant_id='transfer-exit-fixture' and message_body='fixture queued'),'pending cancelled on academic exit');
select pg_temp.assert_true((select delivery_status='uncertain' from public.notification_queue where tenant_id='transfer-exit-fixture' and message_body='fixture uncertain'),'uncertain preserved');
select pg_temp.assert_true((select delivery_status='accepted' and provider_message_id='fixture-provider' from public.notification_queue where tenant_id='transfer-exit-fixture' and message_body='fixture accepted'),'provider receipt preserved');
insert into public.notification_queue(tenant_id,student_id,student_phone,message_body,scheduled_for) values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','5500000000000','fixture late',now());
select pg_temp.assert_true((select delivery_status='skipped' from public.notification_queue where tenant_id='transfer-exit-fixture' and message_body='fixture late'),'late producer stopped');
insert into public.notification_queue(tenant_id,student_id,student_phone,message_body,scheduled_for,notification_kind) values
 ('transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','5500000000000','fixture legacy activity',now(),'HEARTS_FULL'),
 ('transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','5500000000000','fixture future category',now(),'NEW_STUDENT_CATEGORY');
select pg_temp.assert_true((select count(*)=2 from public.notification_queue where tenant_id='transfer-exit-fixture' and message_body in ('fixture legacy activity','fixture future category') and delivery_status='skipped'),'legacy and future student categories stopped');
select pg_temp.assert_true(not private.student_notice_requires_active('STUDENT_OFFBOARDED') and not private.student_notice_requires_active('TEACHER_STUDENT_SUSPENDED'),'official exit notices remain in own workflow');
update public.profiles set status='Ativo' where id='f9130000-0000-4000-8000-000000000002';
insert into public.notification_queue(tenant_id,student_id,student_phone,message_body,scheduled_for) values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','5500000000000','fixture just before pause',now());
insert into public.student_offboarding_operations(id,tenant_id,student_id,source_lifecycle_status,target_lifecycle_status,status,claim_token,lease_expires_at,snapshot)
 values('f9132000-0000-4000-8000-000000000001','transfer-exit-fixture','f9130000-0000-4000-8000-000000000002','active','suspended','CLAIMED',gen_random_uuid(),now()+interval '5 minutes','{}');
select pg_temp.assert_true(not public.is_student_notifiable('f9130000-0000-4000-8000-000000000002'),'pause fences before provider completion');
select pg_temp.assert_true((select delivery_status='skipped' from public.notification_queue where tenant_id='transfer-exit-fixture' and message_body='fixture just before pause'),'begin pause retires unsent messages immediately');
update public.student_offboarding_operations set status='ABORTED' where id='f9132000-0000-4000-8000-000000000001';
select pg_temp.assert_true(public.is_student_notifiable('f9130000-0000-4000-8000-000000000002'),'aborted operation restores future eligibility');
select pg_temp.assert_true((select delivery_status='skipped' from public.notification_queue where tenant_id='transfer-exit-fixture' and message_body='fixture late'),'no resurrection of skipped messages');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"f9130000-0000-4000-8000-000000000001"}',true);
do $$declare result jsonb;again jsonb;slots jsonb:='[{"day_of_week":"Segunda","time_slot":"18:30"}]';begin
 result:=public.get_student_transfer_options('f9130000-0000-4000-8000-000000000002',current_date+1);
 perform pg_temp.assert_true(result->'teachers' @> '[{"id":"f9130000-0000-4000-8000-000000000004","slots":[{"day_of_week":"Segunda","time_slot":"18:30"}]}]','discrete availability with null end_time');
 begin perform public.admin_schedule_student_transfer('f9130000-0000-4000-8000-000000000002','f9130000-0000-4000-8000-000000000004','[{"day_of_week":"Segunda","time_slot":"19:00"}]',current_date+1,'Unavailable fixture slot',gen_random_uuid());raise exception 'unavailable accepted';exception when exclusion_violation then null;end;
 result:=public.admin_schedule_student_transfer('f9130000-0000-4000-8000-000000000002','f9130000-0000-4000-8000-000000000004',slots,current_date+1,'Direction confirmed fixture','f9133000-0000-4000-8000-000000000001');
 again:=public.admin_schedule_student_transfer('f9130000-0000-4000-8000-000000000002','f9130000-0000-4000-8000-000000000004',slots,current_date+1,'Direction confirmed fixture','f9133000-0000-4000-8000-000000000001');
 perform pg_temp.assert_true(result->>'status'='ACCEPTED' and again->>'idempotent'='true' and result->>'transfer_id'=again->>'transfer_id','one future transfer durable retry');
 perform pg_temp.assert_true((select professor_id='f9130000-0000-4000-8000-000000000003' from public.profiles where id='f9130000-0000-4000-8000-000000000002'),'no early switch');
 begin insert into public.bookings(tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date,status) values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000004','f9130000-0000-4000-8000-000000000005','Segunda','18:30',current_date+1,'SCHEDULED');raise exception 'competing booking allowed';exception when exclusion_violation then null;end;
 begin insert into public.reschedules(tenant_id,teacher_id,student_id,date,time) values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000004','f9130000-0000-4000-8000-000000000005',(current_date+((8-extract(dow from current_date)::int)%7)+7)::text,'18:30');raise exception 'competing reschedule allowed';exception when exclusion_violation then null;end;
 begin insert into public.bookings(tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date,status) values('transfer-exit-fixture','f9130000-0000-4000-8000-000000000004','f9130000-0000-4000-8000-000000000002','Segunda','18:30',current_date+1,'SCHEDULED');
 -- Same student is intentionally allowed during materialization; remove this probe inside its subtransaction.
 raise exception 'rollback same student probe';exception when raise_exception then if sqlerrm<>'rollback same student probe' then raise;end if;end;
 update public.teacher_transfers set cutover_date=current_date where id=(result->>'transfer_id')::uuid;
 perform public.apply_teacher_transfer((result->>'transfer_id')::uuid);
 perform pg_temp.assert_true((select status='CANCELLED' from public.bookings where id='f9131000-0000-4000-8000-000000000001'),'old booking preserved, not deleted');
 perform pg_temp.assert_true((select count(*)=1 from public.class_logs where booking_id='f9131000-0000-4000-8000-000000000001'),'old log remains linked');
 perform pg_temp.assert_true((select professor_id='f9130000-0000-4000-8000-000000000004' from public.profiles where id='f9130000-0000-4000-8000-000000000002'),'new teacher applied');
 perform pg_temp.assert_true((select count(*)=1 from public.bookings where tenant_id='transfer-exit-fixture' and status='SCHEDULED' and day_of_week='Segunda' and time_slot='18:30'),'new schedule exactly once');
 perform public.apply_teacher_transfer((result->>'transfer_id')::uuid);
 perform pg_temp.assert_true((select count(*)=1 from public.bookings where tenant_id='transfer-exit-fixture' and status='SCHEDULED'),'application retry idempotent');
end $$;
select pg_temp.assert_true(not has_function_privilege('anon','public.admin_schedule_student_transfer(uuid,uuid,jsonb,date,text,uuid)','execute'),'anonymous cannot transfer');
rollback;
