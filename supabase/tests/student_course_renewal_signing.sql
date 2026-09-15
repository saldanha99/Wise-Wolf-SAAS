begin;
do $$ begin if current_setting('cron.launch_active_jobs',true) is distinct from 'off' or exists(select 1 from public.profiles)
  or exists(select 1 from auth.users) or exists(select 1 from vault.secrets) then raise exception 'isolated_empty_finance_qa_required'; end if; end $$;
create function pg_temp.assert_r(v boolean,m text) returns void language plpgsql as $$ begin if not coalesce(v,false) then raise exception 'renewal signing assertion: %',m; end if; end $$;
insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values('renewal-sign-qa','Renewal Sign QA','renewal-sign-qa','active',true);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('7e180000-0000-4000-8000-000000000011','authenticated','authenticated','renewal-sign@example.invalid','{"provider":"email","providers":["email"]}','{"full_name":"Student Renewal Synthetic"}',now(),now());
set local app.enrollment_claim='1';
update public.profiles set tenant_id='renewal-sign-qa',status='Ativo',lifecycle_status='active',role='STUDENT',
 is_test_account=true,test_fixture_key='renewal-signing-qa',full_name='Student Renewal Synthetic',monthly_fee=261,
 class_frequency='3x',due_day=10,contract_accepted=true,asaas_customer_id='cus_synthetic'
where id='7e180000-0000-4000-8000-000000000011';
set local app.enrollment_claim='';
create temporary table issued(j jsonb);
insert into issued select private.issue_student_course_renewal_offer(
 private.register_student_course_renewal_proposal('renewal-sign-qa','7e180000-0000-4000-8000-000000000011',26100,3::smallint,10::smallint,
 'Synthetic explicit owner approval for six month renewal',repeat('c',64)),
 '2026-10-10','2026-10-10','CREATE_NEW','cus_synthetic',null,'PIX','2026-11-09');
select pg_temp.assert_r((select j->>'token'~'^[a-f0-9]{64}$' from issued),'token invalid');
select pg_temp.assert_r((select contract_start='2026-10-10' and first_due_date='2026-10-10' and last_due_date='2027-03-10'
 and service_end_date='2027-04-10' and term_months=6 and monthly_fee_cents=26100 and classes_per_week=3
 from private.student_course_renewal_offers),'frozen period incorrect');
select pg_temp.assert_r((select public.get_student_course_renewal_public(j->>'token')->>'ok'='true' from issued),'public link cannot be resolved');
select pg_temp.assert_r(public.get_student_course_renewal_public('bad')->>'ok'='false','malformed token accepted');
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Wrong Name')->>'ok'='false' from issued),'wrong signature accepted');
insert into public.student_course_renewal_notification_outbox(offer_id,tenant_id,student_id,milestone,scheduled_at)
select (j->>'id')::uuid,'renewal-sign-qa','7e180000-0000-4000-8000-000000000011','INITIAL',now() from issued;
set local app.enrollment_claim='1';
update public.profiles set status='Inativo',lifecycle_status='suspended',status_financial='SUSPENDED',
 is_test_account=false,test_fixture_key=null,phone='11999999999'
where id='7e180000-0000-4000-8000-000000000011';
set local app.enrollment_claim='';
select pg_temp.assert_r(not public.is_student_notifiable('7e180000-0000-4000-8000-000000000011'),
 'suspended fixture unexpectedly passed the general notification fence');
create temporary table notice_claim(j jsonb);
insert into notice_claim select public.claim_student_course_renewal_notification(id)
from public.student_course_renewal_notification_outbox;
select pg_temp.assert_r((select public.student_course_renewal_notification_source(
 (j->>'id')::uuid,(j->>'claim_token')::uuid) is not null from notice_claim),
 'an explicitly issued renewal could not reach a suspended student');
select private.materialize_student_course_renewal_reminders('2026-10-01 06:00 America/Sao_Paulo');
select pg_temp.assert_r(not exists(select 1 from public.student_course_renewal_notification_outbox where milestone='D15'),
 'an elapsed D15 milestone was materialized as a late duplicate');
select pg_temp.assert_r(exists(select 1 from public.student_course_renewal_notification_outbox where milestone='D0' and scheduled_at='2026-10-10 06:00 America/Sao_Paulo'),
 'the future D0 milestone was not materialized');
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Student Renewal Synthetic')->>'ok'='true' from issued),'valid signature rejected');
select pg_temp.assert_r((select status='SIGNED' and billing_status='PENDING' and signed_at is not null from private.student_course_renewal_offers),'signature state incorrect');
select pg_temp.assert_r((select status='SUPPRESSED' and submit_attempt_count=0 from public.student_course_renewal_notification_outbox),'future notice not suppressed');
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Student Renewal Synthetic')->>'already'='true' from issued),'signature replay not idempotent');
select pg_temp.assert_r(not exists(select 1 from public.student_payments),'signature fabricated payment');
select pg_temp.assert_r(not exists(select 1 from net.http_request_queue),'signature made provider request');
select pg_temp.assert_r(not has_table_privilege('anon','private.student_course_renewal_offers','SELECT')
 and not has_table_privilege('service_role','private.student_course_renewal_offers','SELECT')
 and has_function_privilege('anon','public.get_student_course_renewal_public(text)','EXECUTE')
 and has_function_privilege('anon','public.sign_student_course_renewal(text,text)','EXECUTE')
 and not has_function_privilege('anon','private.issue_student_course_renewal_offer(uuid,date,date,text,text,text,text,timestamptz)','EXECUTE'),'least privilege failed');
rollback;
