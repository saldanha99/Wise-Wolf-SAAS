-- Synthetic, rollback-only, network-disabled QA. Never invoke the cron sender.
begin;
do $$ begin
  if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
    or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
    or exists(select 1 from vault.secrets) then raise exception 'isolated_empty_finance_qa_required'; end if;
end $$;
create function pg_temp.assert_true(v boolean,m text) returns void language plpgsql as $$
begin if not coalesce(v,false) then raise exception 'assertion failed: %',m; end if; end $$;
select pg_temp.assert_true(not has_function_privilege('authenticated','public.student_card_notification_pending(integer)','EXECUTE')
  and not has_function_privilege('anon','public.claim_student_card_notification(uuid)','EXECUTE')
  and has_function_privilege('service_role','public.finish_student_card_notification(uuid,uuid,text,text,integer)','EXECUTE')
  and not has_function_privilege('service_role','private.student_card_notification_now()','EXECUTE')
  and not has_table_privilege('service_role','public.student_card_notification_outbox','UPDATE')
  and not has_table_privilege('authenticated','public.student_card_notification_outbox','SELECT'),'service-only boundary and no clock override API');
select pg_temp.assert_true(not private.student_card_send_window('2026-09-15 11:59:59Z')
  and private.student_card_send_window('2026-09-15 12:00:00Z')
  and private.student_card_send_window('2026-09-15 20:59:59Z')
  and not private.student_card_send_window('2026-09-15 21:00:00Z'),'09 inclusive /18 exclusive Sao Paulo');
create temporary table card_clock as select (date_trunc('day',clock_timestamp())+interval '1 day 13 hours') as at;
-- Test-only replacement, rolled back with the entire suite. No production GUC.
create or replace function private.student_card_notification_now() returns timestamptz
language sql volatile set search_path='' as $$ select at from pg_temp.card_clock $$;
create temporary table card_cutover as select enabled_since from private.student_card_notification_settings;
insert into private.student_card_notification_settings(singleton) values(true) on conflict do nothing;
select pg_temp.assert_true((select enabled_since=(select enabled_since from card_cutover) from private.student_card_notification_settings),
  'rerun must preserve original cutover');

insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values
  ('school-wise-wolf','Synthetic Card QA','school-wise-wolf','active',true),
  ('card-qa-other','Synthetic Other','card-qa-other','active',true) on conflict(id) do nothing;
update public.tenants set saas_status='active',whatsapp_enabled=true where id='school-wise-wolf';
insert into public.tenant_admin_settings(tenant_id,student_notifications_enabled) values('school-wise-wolf',true)
on conflict(tenant_id) do update set student_notifications_enabled=true;
update private.tenant_integration_connections set mode='PLATFORM_MANAGED_ROOT',status='healthy'
  where tenant_id='school-wise-wolf' and provider='asaas';
update private.tenant_integration_connections set mode='PLATFORM_MANAGED',status='healthy'
  where tenant_id='school-wise-wolf' and provider='evolution';
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('97000000-0000-4000-8000-000000000001','authenticated','authenticated','card-admin@example.invalid','{"provider":"email"}','{"full_name":"Synthetic Card Admin"}',now(),now()),
 ('97000000-0000-4000-8000-000000000002','authenticated','authenticated','card-student@example.invalid','{"provider":"email"}','{"full_name":"Synthetic Card Student"}',now(),now());
set local app.enrollment_claim='1';
update public.profiles set tenant_id='school-wise-wolf',role=case when id='97000000-0000-4000-8000-000000000001' then 'SCHOOL_ADMIN' else 'STUDENT' end,
  status='Ativo',lifecycle_status='active',is_test_account=false,test_fixture_key=null
  where id in ('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002');
update public.profiles set asaas_customer_id='cus_card_qa',subscription_id='sub_card_qa',phone='11999990000',
  guardian_id='97000000-0000-4000-8000-000000000001',guardian_name='Synthetic Guardian',guardian_phone='11988880000'
  where id='97000000-0000-4000-8000-000000000002';
set local app.enrollment_claim='';
delete from public.tenant_memberships where user_id in ('97000000-0000-4000-8000-000000000001','97000000-0000-4000-8000-000000000002');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) values
 ('97000000-0000-4000-8000-000000000001','school-wise-wolf','SCHOOL_ADMIN','ACTIVE',true),
 ('97000000-0000-4000-8000-000000000002','school-wise-wolf','STUDENT','ACTIVE',true);
insert into public.whatsapp_instances(user_id,tenant_id,instance_name,instance_id,status,inbox_enabled,inbox_enabled_at,webhook_auth_version)
values('97000000-0000-4000-8000-000000000001','school-wise-wolf','card-qa-instance','card-qa-instance','connected',true,now(),3);
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,provider_customer_id,value,status,provider_status,billing_type,payment_type,due_date)
select ('97000000-0000-4000-8000-00000000001'||n)::uuid,'school-wise-wolf','97000000-0000-4000-8000-000000000002',
  'pay_card_qa_'||n,'cus_card_qa',100,'PENDING','PENDING','CREDIT_CARD','SUBSCRIPTION',
  (date_trunc('month',private.student_card_notification_now())+(n-1)*interval '1 month')::date from generate_series(1,4) n;
create function pg_temp.failure(p_n integer,p_event text,p_at timestamptz,p_customer text default 'cus_card_qa') returns void language sql as $$
  insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,received_at,payload,payload_hash,status)
  select p_event,'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',p.asaas_payment_id,p_at,private.student_card_notification_now(),
    jsonb_build_object('id',p_event,'event','PAYMENT_CREDIT_CARD_CAPTURE_REFUSED','payment',jsonb_build_object(
      'id',p.asaas_payment_id,'customer',p_customer,'subscription','sub_card_qa','value',p.value,'status','PENDING',
      'dueDate',p.due_date,'billingType','CREDIT_CARD','creditCard',jsonb_build_object('creditCardNumber','1234','creditCardToken','MUST_NOT_PERSIST'))),
    encode(extensions.digest(p_event,'sha256'),'hex'),'TRIAGE'
  from public.student_payments p where p.asaas_payment_id='pay_card_qa_'||p_n;
$$;
select pg_temp.failure(1,'evt_card_old',(select enabled_since-interval '1 second' from card_cutover));
select private.materialize_student_card_notifications(private.student_card_notification_now());
select pg_temp.assert_true(not exists(select 1 from public.student_card_notification_outbox),'late old event must not seed backlog');
select pg_temp.failure(1,'evt_card_current',private.student_card_notification_now()-interval '2 minutes');
select pg_temp.failure(2,'evt_card_othermonth',private.student_card_notification_now()-interval '2 minutes');
select pg_temp.failure(3,'evt_card_bad_identity',private.student_card_notification_now()-interval '2 minutes','cus_other');
select pg_temp.failure(4,'evt_card_fourth',private.student_card_notification_now()-interval '2 minutes');
select private.materialize_student_card_notifications(private.student_card_notification_now());
select private.materialize_student_card_notifications(private.student_card_notification_now());
select pg_temp.assert_true((select count(*)=3 from public.student_card_notification_outbox),'idempotent materialization / cross customer blocked');
create temporary table card_ids as select o.id,o.payment_id,('0'||right(p.asaas_payment_id,1))::integer n
  from public.student_card_notification_outbox o join public.student_payments p on p.id=o.payment_id;
select pg_temp.assert_true((public.student_card_notification_source((select id from card_ids where n=1))->>'recipient_phone')='5511988880000',
  'guardian recipient must be selected, not student phone');
select pg_temp.assert_true(private.student_card_failure_source((select payment_id from card_ids where n=1),'evt_card_current',
  private.student_card_notification_now()+interval '36 days') is null,'failures older than35 days are not reusable');
update public.profiles set guardian_phone=null where id='97000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(public.student_card_notification_source((select id from card_ids where n=1)) is null,'missing guardian phone cannot fall back to child');
update public.profiles set guardian_phone='11988880000' where id='97000000-0000-4000-8000-000000000002';
update public.tenant_admin_settings set student_notifications_enabled=false where tenant_id='school-wise-wolf';
select pg_temp.assert_true(public.student_card_notification_source((select id from card_ids where n=1)) is null,'tenant student notices disabled');
update public.tenant_admin_settings set student_notifications_enabled=true where tenant_id='school-wise-wolf';
select pg_temp.failure(1,'evt_card_latest',private.student_card_notification_now()-interval '1 minute');
select pg_temp.assert_true(public.student_card_notification_source((select id from card_ids where n=1)) is null,'old failure invalidated by newer event');
select private.materialize_student_card_notifications(private.student_card_notification_now());
select pg_temp.assert_true((select event_id='evt_card_latest' from public.student_card_notification_outbox where id=(select id from card_ids where n=1)),
  'unsent dedupe row follows latest failure');

create function pg_temp.prepare(p_n integer) returns jsonb language plpgsql as $$
declare v_id uuid; v_claim jsonb; v_i public.whatsapp_instances%rowtype; v_a private.tenant_integration_connections%rowtype; v_source jsonb;
begin
 select id into v_id from card_ids where n=p_n;
 v_claim:=public.claim_student_card_notification(v_id);
 if v_claim->>'ok'<>'true' then return v_claim; end if;
 select * into v_i from public.whatsapp_instances where instance_name='card-qa-instance';
 select * into v_a from private.tenant_integration_connections where tenant_id='school-wise-wolf' and provider='asaas';
 v_source:=public.student_card_notification_source(v_id);
 return public.prepare_student_card_notification(v_id,(v_claim->>'claim_token')::uuid,v_source,'Synthetic card warning',
   v_i.instance_name,v_source->>'recipient_phone',v_i.integration_id,v_i.integration_version,v_a.id,v_a.version,'platform','PLATFORM_MANAGED_ROOT');
end $$;
create function pg_temp.authorize(p_n integer,p_status text default 'PENDING') returns jsonb language plpgsql as $$
declare o public.student_card_notification_outbox%rowtype;
begin
 select * into o from public.student_card_notification_outbox where id=(select id from card_ids where n=p_n);
 return public.authorize_student_card_notification(o.id,o.claim_token,o.provider_integration_id,o.provider_integration_version,
   repeat('a',64),repeat('b',64),o.source_snapshot,
   jsonb_build_object('id',o.source_snapshot->>'provider_payment_id','customer','cus_card_qa','subscription','sub_card_qa',
     'status',p_status,'billingType','CREDIT_CARD','value',100,'dueDate',o.source_snapshot->>'due_date','deleted',false,
     'creditCardLast4','1234','creditCardToken','MUST_NOT_PERSIST'),
   jsonb_build_object('id','sub_card_qa','customer','cus_card_qa','status','ACTIVE','billingType','CREDIT_CARD','deleted',false,'creditCardLast4','1234'));
end $$;
select pg_temp.assert_true(pg_temp.prepare(1)->>'ok'='true' and pg_temp.prepare(2)->>'ok'='true','real claim+prepare work');
savepoint null_status_gate;
update public.student_payments set status=null where id=(select payment_id from card_ids where n=1);
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='false','NULL local status is not eligible');
rollback to savepoint null_status_gate;
savepoint tuition_gate;
update public.student_payments set payment_type='ENROLLMENT' where id=(select payment_id from card_ids where n=1);
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='false','enrollment cannot be called a recurring tuition failure');
rollback to savepoint tuition_gate;
savepoint changed_card_gate;
insert into public.student_billing_method_operations(tenant_id,student_id,customer_id,subscription_id,source_billing_type,target_billing_type,
 card_last4,integration_snapshot,status,claim_token,lease_expires_at,completed_at)
values('school-wise-wolf','97000000-0000-4000-8000-000000000002','cus_card_qa','sub_card_qa','CREDIT_CARD','CREDIT_CARD',
 '5678','{}','COMPLETED',gen_random_uuid(),private.student_card_notification_now(),private.student_card_notification_now());
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='false','completed card replacement after failure suppresses stale notice');
rollback to savepoint changed_card_gate;
savepoint integration_gate;
update private.tenant_integration_connections set version=version+1 where tenant_id='school-wise-wolf' and provider='asaas';
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='false','integration rotation invalidates frozen authority');
rollback to savepoint integration_gate;
savepoint coverage_gate;
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,provider_customer_id,value,status,provider_status,
  billing_type,payment_type,due_date,payment_date,paid_at)
values('97000000-0000-4000-8000-000000000099','school-wise-wolf','97000000-0000-4000-8000-000000000002',
  'pay_card_qa_prepaid','cus_card_qa',600,'RECEIVED','RECEIVED','PIX','SUBSCRIPTION',current_date,current_date,now());
set local request.jwt.claims='{"sub":"97000000-0000-4000-8000-000000000001","role":"authenticated"}';
select pg_temp.assert_true(public.register_prepayment('97000000-0000-4000-8000-000000000099',
  date_trunc('month',private.student_card_notification_now())::date,6,'MENSAL')->>'ok'='true','real complete payment registration between prepare and send');
set local request.jwt.claims='{}';
select pg_temp.assert_true(private.student_payment_is_covered((select payment_id from card_ids where n=1))
  and pg_temp.authorize(1)->>'ok'='false','new complete payment coverage fences old notification');
rollback to savepoint coverage_gate;
-- Verify the same allocation advisory is actually held before reading the
-- source; another registration must finish before authorization can proceed.
select private.lock_student_card_notification((select id from card_ids where n=1));
select pg_temp.assert_true(exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted
  and classid=((hashtextextended('student-payment-allocation:97000000-0000-4000-8000-000000000002',0)>>32)&4294967295)::oid
  and objid=(hashtextextended('student-payment-allocation:97000000-0000-4000-8000-000000000002',0)&4294967295)::oid),
  'authorization lock protocol includes prepayment allocation fence');
select pg_temp.assert_true(pg_temp.authorize(1,'CONFIRMED')->>'ok'='false','settled authoritative invoice cannot send');
update public.profiles set guardian_phone='11977770000' where id='97000000-0000-4000-8000-000000000002';
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='false','recipient race must invalidate frozen snapshot');
update public.profiles set guardian_phone='11988880000' where id='97000000-0000-4000-8000-000000000002';
update public.whatsapp_instances set webhook_auth_version=2 where instance_name='card-qa-instance';
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='false','unauthenticated receipt route is ineligible');
update public.whatsapp_instances set webhook_auth_version=3 where instance_name='card-qa-instance';
update public.whatsapp_instances set instance_name='Card-QA-Instance' where instance_name='card-qa-instance';
update public.student_card_notification_outbox set provider_instance_name='Card-QA-Instance' where id=(select id from card_ids where n=1);
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='true','exact current source authorizes one attempt');
select pg_temp.assert_true((select provider_instance_name='Card-QA-Instance' from public.student_card_notification_outbox
  where id=(select id from card_ids where n=1)),'provider instance case is preserved for transport');
select pg_temp.assert_true(pg_temp.authorize(1)->>'ok'='false' and pg_temp.authorize(2)->>'ok'='false','retry and second invoice within24h blocked');
select pg_temp.assert_true((select provider_payment_snapshot::text not like '%MUST_NOT_PERSIST%' and source_snapshot::text not like '%Token%'
  from public.student_card_notification_outbox where id=(select id from card_ids where n=1)),'whitelisted provider proof only');
select pg_temp.assert_true(public.defer_student_card_notification((select id from card_ids where n=1),
  (select claim_token from public.student_card_notification_outbox where id=(select id from card_ids where n=1)),'provider_unavailable')->>'ok'='false',
  'no defer after irreversible boundary');
do $$ declare o public.student_card_notification_outbox%rowtype; r jsonb; begin
 select * into o from public.student_card_notification_outbox where id=(select id from card_ids where n=1);
 perform pg_temp.assert_true(public.finish_student_card_notification(o.id,gen_random_uuid(),'accepted','qa-card-message',200)->>'ok'='false','wrong claim');
 r:=public.finish_student_card_notification(o.id,o.claim_token,'accepted','qa-card-message',200);
 perform pg_temp.assert_true(r->>'status'='SUBMITTING','HTTP acceptance is not delivery');
 insert into private.whatsapp_provider_delivery_receipts(tenant_id,provider_instance_name,provider_message_id,delivery_status,delivered_at)
 values('card-qa-other','card-qa-instance','qa-card-message','delivered',now());
 perform pg_temp.assert_true((select status='SUBMITTING' from public.student_card_notification_outbox where id=o.id),'cross tenant ACK rejected');
 insert into private.whatsapp_provider_delivery_receipts(tenant_id,provider_instance_name,provider_message_id,delivery_status,delivered_at)
 values('school-wise-wolf','card-qa-instance','qa-card-message','delivered',now());
 perform pg_temp.assert_true((select status='SENT' from public.student_card_notification_outbox where id=o.id),'matching ACK delivers');
 update private.whatsapp_provider_delivery_receipts set delivery_status='failed' where tenant_id='school-wise-wolf' and provider_message_id='qa-card-message';
 perform pg_temp.assert_true((select status='SENT' and provider_delivery_status='delivered' from public.student_card_notification_outbox where id=o.id),'late failure cannot regress delivery');
end $$;
-- Payment truth remains writable after notification. No notification FK/trigger veto.
update public.student_payments set status='CONFIRMED',provider_status='CONFIRMED' where id=(select payment_id from card_ids where n=1);
select pg_temp.assert_true((select status='CONFIRMED' from public.student_payments where id=(select payment_id from card_ids where n=1)),
  'financial truth not blocked by notification');
select pg_temp.assert_true(not exists(select 1 from public.financial_transactions where student_payment_id in(select payment_id from card_ids)),
  'notification and CONFIRMED create no cash');

-- Exercise early receipt and unknown watchdog with transport-only fixtures.
update public.student_card_notification_outbox set status='SUBMITTING',submit_attempt_count=1,
  claim_token=gen_random_uuid(),provider_instance_name='card-qa-instance',lease_expires_at=private.student_card_notification_now()+interval '30 minutes'
  where id=(select id from card_ids where n=2);
insert into private.whatsapp_provider_delivery_receipts(tenant_id,provider_instance_name,provider_message_id,delivery_status,read_at,delivered_at)
values('school-wise-wolf','card-qa-instance','qa-card-early','read',now(),now());
select pg_temp.assert_true((select public.finish_student_card_notification(id,claim_token,'accepted','qa-card-early',200)->>'status'='SENT'
  from public.student_card_notification_outbox where id=(select id from card_ids where n=2)),'early ACK reconciles without second POST');
update public.student_card_notification_outbox set status='SUBMITTING',submit_attempt_count=1,
  claim_token=gen_random_uuid(),lease_expires_at=private.student_card_notification_now()-interval '1 minute'
  where id=(select id from card_ids where n=4);
select private.materialize_student_card_notifications(private.student_card_notification_now());
select pg_temp.assert_true((select status='UNKNOWN' and submit_attempt_count=1 from public.student_card_notification_outbox
  where id=(select id from card_ids where n=4)),'timeout becomes UNKNOWN');
select pg_temp.assert_true(public.claim_student_card_notification((select id from card_ids where n=4))->>'ok'='false','UNKNOWN cannot be retried');
do $$ begin
 begin update private.student_card_notification_events set event_type='REWRITTEN'; raise exception 'audit mutable';
 exception when others then if sqlerrm<>'prepayment_audit_is_immutable' then raise; end if; end;
end $$;
rollback;
