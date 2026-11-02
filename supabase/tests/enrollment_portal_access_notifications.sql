\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end; $$;
set local app.enrollment_claim='1';
set local request.jwt.claims='{"role":"service_role"}';
insert into public.tenants(id,name,slug,saas_status,custom_domain,custom_domain_verified)
values('enrollment-access-test','Enrollment Access Test','enrollment-access-test','active','enrollment-access.example.invalid',true);
insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-4000-8000-00000000ea01','authenticated','authenticated',
 'student-enrollment-access@example.invalid',now(),'{"provider":"email"}',
 '{"full_name":"Student Enrollment Access"}',now(),now());
update public.profiles set role='STUDENT',tenant_id='enrollment-access-test',
 full_name='Student Enrollment Access',email='student-enrollment-access@example.invalid',phone='11999999999',
 lifecycle_status='active',status='Ativo',contract_accepted=true,is_test_account=false,wa_welcome_sent=false
where id='00000000-0000-4000-8000-00000000ea01';
insert into public.offers(id,kind,tenant_id,payload,expires_at,requires_enrollment,enrollment_fee,
 processing_state,processing_by,consumed_by,invite_security_version,created_by)
values('10000000-0000-4000-8000-00000000ea01','ENROLLMENT','enrollment-access-test',
 '{"value":198,"planDuration":6,"startDate":"2026-10-05"}',now()+interval '1 day',true,49.90,
 'COMPLETED','00000000-0000-4000-8000-00000000ea01','00000000-0000-4000-8000-00000000ea01',1,'00000000-0000-4000-8000-00000000ea01');

select private.enqueue_enrollment_completion_notifications('10000000-0000-4000-8000-00000000ea01','00000000-0000-4000-8000-00000000ea01');
select private.enqueue_enrollment_completion_notifications('10000000-0000-4000-8000-00000000ea01','00000000-0000-4000-8000-00000000ea01');
select pg_temp.assert_true((select count(*)=1 from notification_queue where tenant_id='enrollment-access-test'
 and notification_kind='ENROLLMENT_STUDENT_CONFIRMED'),'completion retry duplicated welcome');
select pg_temp.assert_true((select message_body like '%student-enrollment-access@example.invalid%'
 and message_body like '%https://enrollment-access.example.invalid%' and message_body like '%Esqueci minha senha%'
 and (public.get_enrollment_access_notice_snapshot(id)->>'ok')::boolean
 from notification_queue where tenant_id='enrollment-access-test' and notification_kind='ENROLLMENT_STUDENT_CONFIRMED'),
 'durable completion did not prepare verified portal access');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.get_enrollment_access_notice_snapshot(uuid)','EXECUTE')
 and not has_function_privilege('anon','public.get_enrollment_access_notice_snapshot(uuid)','EXECUTE'), 'snapshot exposed');

update profiles set phone='11988888888' where id='00000000-0000-4000-8000-00000000ea01';
select pg_temp.assert_true((select public.get_enrollment_access_notice_snapshot(id)->>'reason'='enrollment_access_identity_changed'
 from notification_queue where tenant_id='enrollment-access-test' and notification_kind='ENROLLMENT_STUDENT_CONFIRMED'),
 'changed contact did not invalidate welcome');
select pg_temp.assert_true((select public.begin_notification_delivery_submission(id,null,'fixture-central',
 '5511999999999','5511999999999',message_body,null,null)->>'action'='REVIEW_REQUIRED'
 from notification_queue where tenant_id='enrollment-access-test' and notification_kind='ENROLLMENT_STUDENT_CONFIRMED'),
 'final provider boundary did not revalidate changed contact');
update profiles set phone='11999999999' where id='00000000-0000-4000-8000-00000000ea01';
update profiles set is_test_account=true where id='00000000-0000-4000-8000-00000000ea01';
select pg_temp.assert_true((select public.get_enrollment_access_notice_snapshot(id)->>'ok'='false'
 from notification_queue where tenant_id='enrollment-access-test' and notification_kind='ENROLLMENT_STUDENT_CONFIRMED'), 'fixture could receive access');
update profiles set is_test_account=false where id='00000000-0000-4000-8000-00000000ea01';

-- Só recibo positivo com ID do provedor marca enviado. Nunca marca ao enfileirar.
select pg_temp.assert_true((select not wa_welcome_sent from profiles where id='00000000-0000-4000-8000-00000000ea01'), 'queued welcome marked sent');
update notification_queue set status='sent',accepted_at=now(),provider_message_id='fixture-welcome-accepted',provider_instance_name='fixture-central',delivery_status='accepted'
where tenant_id='enrollment-access-test' and notification_kind='ENROLLMENT_STUDENT_CONFIRMED';
select pg_temp.assert_true((select wa_welcome_sent and contract_sent_at is null from profiles where id='00000000-0000-4000-8000-00000000ea01'),
 'acceptance marker absent or signature history overwritten');
select pg_temp.assert_true((select public.get_enrollment_access_notice_snapshot(id)->>'reason'='enrollment_access_already_sent'
 from notification_queue where tenant_id='enrollment-access-test' and notification_kind='ENROLLMENT_STUDENT_CONFIRMED'), 'accepted welcome allowed duplicate');
rollback;
