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
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Wrong Name','2026-10-10')->>'ok'='false' from issued),'wrong signature accepted');
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
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Student Renewal Synthetic','2026-10-10')->>'ok'='true' from issued),'valid signature rejected');
select pg_temp.assert_r((select status='SIGNED' and billing_status='PENDING' and signed_at is not null from private.student_course_renewal_offers),'signature state incorrect');
select pg_temp.assert_r((select count(*)>0 and bool_and(status='SUPPRESSED' and submit_attempt_count=0)
 from public.student_course_renewal_notification_outbox),'future notice not suppressed');
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Student Renewal Synthetic','2026-10-10')->>'already'='true' from issued),'signature replay not idempotent');
select pg_temp.assert_r(not exists(select 1 from public.student_payments),'signature fabricated payment');
select pg_temp.assert_r(not exists(select 1 from net.http_request_queue),'signature made provider request');
-- The billing worker must claim the signed offer. An unqualified `id` inside
-- the RETURNS TABLE(id, ...) function made this raise "ambiguous" on 15/09/2026.
create temporary table billing_claim(id uuid, claim_token uuid);
insert into billing_claim select * from public.claim_student_course_renewal_billing(10);
select pg_temp.assert_r((select count(*)=1 from billing_claim),'signed renewal was not claimed for billing');
select pg_temp.assert_r((select o.billing_status='PROCESSING' and o.billing_claim_token=c.claim_token
 from private.student_course_renewal_offers o join billing_claim c on c.id=o.id),'billing claim state incorrect');
select pg_temp.assert_r(exists(select 1 from private.student_course_renewal_events where event_type='BILLING_CLAIMED'),'billing claim event missing');

-- Uma oferta que ficou para tras continua cobrindo o inicio das aulas, mas a
-- pagina mostra um vencimento valido e a assinatura confirma exatamente essa
-- data. O contrato termina um mes depois da sexta parcela.
create temporary table stale_dates(today_date date, expected_due date);
insert into stale_dates select (clock_timestamp() at time zone 'America/Sao_Paulo')::date,
  (clock_timestamp() at time zone 'America/Sao_Paulo')::date + 1;
create temporary table stale_issued(j jsonb);
insert into stale_issued select private.issue_student_course_renewal_offer(
 private.register_student_course_renewal_change_proposal(
  'renewal-sign-qa','7e180000-0000-4000-8000-000000000011',26100,3::smallint,10::smallint,
  'Synthetic approval for a renewal signed after classes already started',repeat('d',64)),
 (select today_date-2 from stale_dates),(select today_date-2 from stale_dates),
 (select today_date-3 from stale_dates),'CREATE_NEW','cus_synthetic',null,'PIX',clock_timestamp()+interval '30 days');
select pg_temp.assert_r((select (public.get_student_course_renewal_public(j->>'token')->'data'->>'first_due_date')::date=expected_due
 from stale_issued cross join stale_dates),'stale due date was exposed to the student');
select pg_temp.assert_r((select public.get_student_course_renewal_public(j->>'token')->'data'->>'dates_adjusted'='true'
 from stale_issued),'date adjustment was not disclosed');
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Student Renewal Synthetic',today_date)->>'ok'='false'
 from stale_issued cross join stale_dates),'signature accepted terms different from the page');
select pg_temp.assert_r((select public.sign_student_course_renewal(j->>'token','Student Renewal Synthetic',expected_due)->>'ok'='true'
 from stale_issued cross join stale_dates),'rolled-forward renewal was not signed');
select pg_temp.assert_r((select o.first_due_date=d.expected_due
  and o.last_due_date=public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(d.expected_due)))))
  and o.service_end_date=public.fim_do_servico(o.last_due_date)
 from private.student_course_renewal_offers o cross join stale_dates d
 where o.id=(select (j->>'id')::uuid from stale_issued)),'rolled-forward payment period incorrect');
select pg_temp.assert_r(exists(select 1 from private.student_course_renewal_events e
 where e.offer_id=(select (j->>'id')::uuid from stale_issued) and e.event_type='DUE_DATES_ROLLED_FORWARD'),
 'due date adjustment audit event missing');
select pg_temp.assert_r(not has_table_privilege('anon','private.student_course_renewal_offers','SELECT')
 and not has_table_privilege('service_role','private.student_course_renewal_offers','SELECT')
 and has_function_privilege('anon','public.get_student_course_renewal_public(text)','EXECUTE')
 and not has_function_privilege('anon','public.sign_student_course_renewal(text,text)','EXECUTE')
 and has_function_privilege('anon','public.sign_student_course_renewal(text,text,date)','EXECUTE')
 and not has_function_privilege('anon','private.issue_student_course_renewal_offer(uuid,date,date,text,text,text,text,timestamptz)','EXECUTE'),'least privilege failed');
rollback;
