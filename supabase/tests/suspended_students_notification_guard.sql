\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.tenants(id,name) values('notification-guard-fixture','Notification guard fixture');
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('f9120000-0000-4000-8000-000000000001','authenticated','authenticated',
 'notification-guard@example.invalid','{"provider":"email"}','{"test_fixture":true}',now(),now());
update public.profiles set tenant_id='notification-guard-fixture',role='STUDENT',
 status='Ativo',lifecycle_status='active',status_financial='ACTIVE',is_test_account=true
where id='f9120000-0000-4000-8000-000000000001';
do $$
declare student uuid:='f9120000-0000-4000-8000-000000000001'; state text;
begin
 if not public.is_student_notifiable(student) then raise exception 'active student lost eligibility'; end if;
 foreach state in array array['Inativo','INACTIVE','Suspenso','SUSPENDED','Pausado','Cancelado','Trancado'] loop
  update public.profiles set status=state where id=student;
  if public.is_student_notifiable(student) then raise exception 'academic state bypass: %',state; end if;
 end loop;
 update public.profiles set status='Ativo',status_financial='SUSPENDED' where id=student;
 if public.is_student_notifiable(student) then raise exception 'financial suspension bypass'; end if;
 update public.profiles set status_financial='ACTIVE',lifecycle_status='suspended' where id=student;
 if public.is_student_notifiable(student) then raise exception 'lifecycle suspension bypass'; end if;
 if public.is_student_notifiable(gen_random_uuid()) then raise exception 'unknown identity allowed'; end if;
 if position('public.is_student_notifiable(ac.student_id)' in pg_get_functiondef('public.claim_attendance_confirmation_deliveries(integer)'::regprocedure))=0
 or position('public.is_student_notifiable(student_id)' in pg_get_functiondef('public.bind_attendance_quality_delivery(uuid,uuid,text,text,boolean)'::regprocedure))=0
 or position('student_notifications_suppressed' in pg_get_functiondef('public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure))=0
 then raise exception 'delivery fence missing'; end if;
 if has_function_privilege('anon','public.is_student_notifiable(uuid)','execute') then raise exception 'anonymous eligibility exposed'; end if;
end $$;
rollback;
