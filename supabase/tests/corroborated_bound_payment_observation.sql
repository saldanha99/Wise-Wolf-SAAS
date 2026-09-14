-- Synthetic, transactional QA only. No provider requests and no worker sends.
begin;
do $isolated_qa_only$ begin
  if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
    or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
    or exists(select 1 from vault.secrets) then
    raise exception 'isolated_empty_finance_qa_required' using errcode='55000';
  end if;
end $isolated_qa_only$;
set local timezone='UTC';
create or replace function pg_temp.assert_true(value boolean,message text) returns void language plpgsql as $$
begin if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if; end $$;

select pg_temp.assert_true(
  has_function_privilege('service_role','public.apply_authoritative_bound_student_payment(jsonb,uuid,bigint,text,jsonb,jsonb,timestamptz,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.apply_authoritative_bound_student_payment(jsonb,uuid,bigint,text,jsonb,jsonb,timestamptz,text)','EXECUTE')
  and not has_function_privilege('anon','public.apply_authoritative_bound_student_payment(jsonb,uuid,bigint,text,jsonb,jsonb,timestamptz,text)','EXECUTE')
  and not has_table_privilege('authenticated','private.bound_payment_observations','SELECT')
  and not has_table_privilege('service_role','private.bound_payment_observations','INSERT'),
  'bound observation privilege boundary');

insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values
 ('school-wise-wolf','Synthetic Bound Observation School','school-wise-wolf','active',true),
 ('bound-observation-other','Synthetic Bound Observation Other','bound-observation-other','active',false)
on conflict(id) do nothing;
insert into private.tenant_integration_connections(id,tenant_id,provider,mode,status,version,connection_config)
values('96000000-0000-4000-8000-000000000090','school-wise-wolf','asaas','PLATFORM_MANAGED_ROOT','healthy',1,'{}')
on conflict(tenant_id,provider) do nothing;
-- New-tenant settings deliberately start Asaas DISABLED, including a newly
-- created reference tenant. Configure only this guarded, credential-free QA row.
update private.tenant_integration_connections set mode='PLATFORM_MANAGED_ROOT',status='healthy'
where tenant_id='school-wise-wolf' and provider='asaas';
update public.tenants set saas_status='active',whatsapp_enabled=true where id='school-wise-wolf';
create or replace function pg_temp.bound_connection_id() returns uuid language sql as $$
 select id from private.tenant_integration_connections where tenant_id='school-wise-wolf' and provider='asaas'; $$;
create or replace function pg_temp.bound_connection_version() returns bigint language sql as $$
 select version from private.tenant_integration_connections where tenant_id='school-wise-wolf' and provider='asaas'; $$;
insert into public.dre_report_settings(tenant_id,destino,cadencia,dia_semana,is_active)
values('school-wise-wolf','120363000000000960@g.us','diaria',1,true)
on conflict(tenant_id) do update set destino=excluded.destino,is_active=true;
insert into public.payment_split_settings(tenant_id,dizimo_pct,investimento_pct,escola_pct,prof_dizimo_pct,prof_investimento_pct,prof_prolabore_pct,is_active)
values('school-wise-wolf',10,10,0,10,70,20,false)
on conflict(tenant_id) do update set is_active=false;

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('96000000-0000-4000-8000-000000000001','authenticated','authenticated','bound-observation-student@example.invalid','{"provider":"email","providers":["email"]}','{"full_name":"Synthetic Bound Student"}',now(),now()),
 ('96000000-0000-4000-8000-000000000002','authenticated','authenticated','bound-observation-other@example.invalid','{"provider":"email","providers":["email"]}','{"full_name":"Synthetic Other Student"}',now(),now());
set local app.enrollment_claim='1';
update public.profiles set tenant_id='school-wise-wolf',role='STUDENT',lifecycle_status='active',
  asaas_customer_id='cus_boundfixture',subscription_id=null,monthly_fee=300,is_test_account=false,test_fixture_key=null
  where id='96000000-0000-4000-8000-000000000001';
update public.profiles set tenant_id='bound-observation-other',role='STUDENT',lifecycle_status='active',
  asaas_customer_id='cus_otherfixture',subscription_id=null,is_test_account=true,test_fixture_key='bound-observation-other'
  where id='96000000-0000-4000-8000-000000000002';
set local app.enrollment_claim='';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) values
 ('96000000-0000-4000-8000-000000000001','school-wise-wolf','STUDENT','ACTIVE',true),
 ('96000000-0000-4000-8000-000000000002','bound-observation-other','STUDENT','ACTIVE',true)
on conflict(user_id,tenant_id) do update set role=excluded.role,status=excluded.status;

insert into public.student_payments(id,student_id,tenant_id,asaas_payment_id,provider_customer_id,value,status,provider_status,due_date,raw_payload)
values
 ('96000000-0000-4000-8000-000000000011','96000000-0000-4000-8000-000000000001','school-wise-wolf','pay_boundpositive','cus_boundfixture',300,'PENDING','PENDING','2026-08-01','{"legacyImport":true,"creditCardToken":"SECRET_MARKER_MUST_NOT_COPY"}'),
 ('96000000-0000-4000-8000-000000000012','96000000-0000-4000-8000-000000000001','school-wise-wolf','pay_boundnegative','cus_boundfixture',300,'PENDING','PENDING','2026-08-01','{}'),
 ('96000000-0000-4000-8000-000000000013','96000000-0000-4000-8000-000000000001','school-wise-wolf','pay_boundboundary','cus_boundfixture',300,'RECEIVED','RECEIVED','2026-08-01','{}'),
 ('96000000-0000-4000-8000-000000000014','96000000-0000-4000-8000-000000000001','school-wise-wolf','pay_boundprecise','cus_boundfixture',300,'RECEIVED','RECEIVED','2026-08-01','{}');
update public.student_payments set payment_date='2026-09-01',credited_at='2026-09-01 00:00:00+00',paid_at='2026-09-01 00:00:00+00'
where id='96000000-0000-4000-8000-000000000013';
update public.student_payments set payment_date='2026-09-01',credited_at='2026-09-01 18:34:56+00',paid_at='2026-09-01 18:34:56+00'
where id='96000000-0000-4000-8000-000000000014';

create or replace function pg_temp.proof(p_provider text,p_status text default 'CONFIRMED') returns jsonb language sql as $$
 select jsonb_build_object('id',p_provider,'customer','cus_boundfixture','subscription','sub_boundfixture',
   'externalReference',null,'value',300,'status',p_status,'dueDate','2026-09-01',
   'creditDate',case when p_status='RECEIVED' then '2026-09-01' else null end,
   'paymentDate',case when p_status in ('RECEIVED','RECEIVED_IN_CASH') then '2026-09-01' else null end,
   'deleted',false,'refundedValue',0,'creditCardToken','SECRET_MARKER_MUST_NOT_COPY',
   'creditCard',jsonb_build_object('holderName','SECRET_MARKER_MUST_NOT_COPY'));
$$;
create or replace function pg_temp.parent() returns jsonb language sql as $$
 select '{"id":"sub_boundfixture","customer":"cus_boundfixture","status":"ACTIVE","externalReference":null,"deleted":false,"creditCardToken":"SECRET_MARKER_MUST_NOT_COPY"}'::jsonb;
$$;
create or replace function pg_temp.observe(p_id uuid,p_proof jsonb,p_parent jsonb default pg_temp.parent(),p_event text default null,p_time timestamptz default clock_timestamp())
returns jsonb language sql as $$
 select public.apply_authoritative_bound_student_payment((select to_jsonb(p) from public.student_payments p where id=p_id),
   pg_temp.bound_connection_id(),pg_temp.bound_connection_version(),'PLATFORM_MANAGED_ROOT',p_proof,p_parent,p_time,p_event);
$$;

-- Even direct calls by a non-service JWT fail closed; no JWT user metadata authority.
set local request.jwt.claims='{"role":"authenticated","app_metadata":{"role":"SUPER_ADMIN"}}';
do $$ begin
  begin
    perform pg_temp.observe('96000000-0000-4000-8000-000000000011',pg_temp.proof('pay_boundpositive'));
    raise exception 'authenticated caller was accepted';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claims='{"role":"service_role"}';

select pg_temp.assert_true((pg_temp.observe('96000000-0000-4000-8000-000000000011',pg_temp.proof('pay_boundpositive'))->>'ok')::boolean,
 'exact legacy bound CONFIRMED invoice must not depend on profile.subscription_id');
select pg_temp.assert_true((select status='CONFIRMED' and provider_status='CONFIRMED' and due_date='2026-09-01' and paid_at is null and credited_at is null
 from public.student_payments where id='96000000-0000-4000-8000-000000000011'), 'CONFIRMED must remain non-cash and accept authoritative due date');
select pg_temp.assert_true(not exists(select 1 from public.financial_transactions where student_payment_id='96000000-0000-4000-8000-000000000011')
 and not exists(select 1 from public.management_payment_notification_outbox where payment_id='96000000-0000-4000-8000-000000000011'),
 'CONFIRMED may create neither cash nor payment notification');
select pg_temp.assert_true((select subscription_id is null from public.profiles where id='96000000-0000-4000-8000-000000000001'),
 'update-only must not invent a current profile subscription');

insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash,status)
values('evt_boundreceived','PAYMENT_RECEIVED','pay_boundpositive',now()-interval '1 minute',
 jsonb_build_object('id','evt_boundreceived','event','PAYMENT_RECEIVED','payment',pg_temp.proof('pay_boundpositive','RECEIVED')),'bound-received-synthetic-hash','PROCESSING');
select pg_temp.assert_true((pg_temp.observe('96000000-0000-4000-8000-000000000011',pg_temp.proof('pay_boundpositive','RECEIVED'),pg_temp.parent(),'evt_boundreceived')->>'ok')::boolean,
 'received event must update its exact invoice');
select pg_temp.assert_true((select status='RECEIVED' and last_provider_event_id='evt_boundreceived' and last_provider_event_rank=80
  and last_provider_event_at=(select event_created_at from public.asaas_webhook_inbox where provider_event_id='evt_boundreceived')
  from public.student_payments where id='96000000-0000-4000-8000-000000000011'), 'real provider metadata must remain distinct from observation timestamp');
select pg_temp.assert_true((select count(*)=1 from public.financial_transactions where student_payment_id='96000000-0000-4000-8000-000000000011')
 and (select count(*)=1 from public.management_payment_notification_outbox where payment_id='96000000-0000-4000-8000-000000000011'),
 'settlement must create exactly one ledger and native notification intent');

select pg_temp.assert_true(pg_temp.observe('96000000-0000-4000-8000-000000000011',pg_temp.proof('pay_boundpositive','RECEIVED'))->>'action'='ALREADY_APPLIED',
 'repeat GET must be idempotent');
select pg_temp.assert_true((select count(*)=2 from private.bound_payment_observations where payment_id='96000000-0000-4000-8000-000000000011')
 and (select count(*)=1 from public.financial_transactions where student_payment_id='96000000-0000-4000-8000-000000000011'), 'repeated proof duplicated immutable evidence or cash');
select pg_temp.assert_true(not exists(select 1 from private.bound_payment_observations where tenant_id='school-wise-wolf'
 and (provider_snapshot::text||coalesce(parent_snapshot::text,'')||before_state::text) like '%SECRET_MARKER%')
 and (select raw_payload::text not like '%SECRET_MARKER%' from public.student_payments where id='96000000-0000-4000-8000-000000000011'),
 'audit must minimize provider card and personal fields');

-- Only new provider evidence is ordered; ordinary administrative edits survive.
update public.student_payments set description='Administrative metadata preserved'
where id='96000000-0000-4000-8000-000000000011';
update public.student_payments set description='Full-row metadata preserved',raw_payload=raw_payload,last_provider_event_at=last_provider_event_at
where id='96000000-0000-4000-8000-000000000011';
select pg_temp.assert_true((select description='Full-row metadata preserved' from public.student_payments where id='96000000-0000-4000-8000-000000000011'),
 'ordering trigger swallowed non-provider metadata');
update public.student_payments set status='OVERDUE',provider_status='OVERDUE',last_provider_event_id='evt_boundstale',
 last_provider_event_at=now()-interval '30 seconds',last_provider_event_rank=40,
 raw_payload=jsonb_build_object('id','evt_boundstale','event','PAYMENT_OVERDUE','payment',jsonb_build_object('id','pay_boundpositive','customer','cus_boundfixture','status','OVERDUE'))
where id='96000000-0000-4000-8000-000000000011';
select pg_temp.assert_true((select status='RECEIVED' and last_provider_event_id='evt_boundreceived' from public.student_payments where id='96000000-0000-4000-8000-000000000011'),
 'stale positive provider event regressed corroborated cash');
update public.student_payments set status='NAO_RECEITA' where id='96000000-0000-4000-8000-000000000011';
select pg_temp.assert_true((select status='NAO_RECEITA' from public.student_payments where id='96000000-0000-4000-8000-000000000011'),
 'explicit accounting classification must not be swallowed');

-- The watermark never hides a refund fact, even when the provider event is older.
update public.student_payments set status='REFUNDED',provider_status='REFUNDED',refunded_amount=300,
 last_provider_event_id='evt_boundrefund',last_provider_event_at=now()-interval '30 seconds',last_provider_event_rank=100,
 raw_payload=jsonb_build_object('id','evt_boundrefund','event','PAYMENT_REFUNDED','payment',jsonb_build_object('id','pay_boundpositive','customer','cus_boundfixture','status','REFUNDED','value',300,'refundedValue',300))
where id='96000000-0000-4000-8000-000000000011';
select pg_temp.assert_true((select status='REFUNDED' and refunded_amount=300 from public.student_payments where id='96000000-0000-4000-8000-000000000011')
 and (select count(*)=1 and min(type)='ENTRADA' and min(amount)=300 from public.financial_transactions
   where student_payment_id='96000000-0000-4000-8000-000000000011')
 and (select count(*)=1 and min(type)='SAIDA' and min(amount)=300 and min(provider_event_id)='evt_boundrefund'
   from public.financial_transactions where refund_student_payment_id='96000000-0000-4000-8000-000000000011'),
 'refund after GET must preserve gross cash and record reversal');
select pg_temp.assert_true(not (pg_temp.observe('96000000-0000-4000-8000-000000000011',pg_temp.proof('pay_boundpositive','RECEIVED'))->>'ok')::boolean,
 'positive GET must not erase a proven refund');

-- Existing timestamps are kept only when they represent the same business day.
select pg_temp.assert_true((pg_temp.observe('96000000-0000-4000-8000-000000000013',pg_temp.proof('pay_boundboundary','RECEIVED'))->>'ok')::boolean,'boundary GET');
select pg_temp.assert_true((select credited_at='2026-09-01 12:00:00+00' and (paid_at at time zone 'America/Sao_Paulo')::date='2026-09-01'
 from public.student_payments where id='96000000-0000-4000-8000-000000000013'), 'UTC-midnight legacy timestamp must not move cash into previous SP month');
select pg_temp.assert_true((pg_temp.observe('96000000-0000-4000-8000-000000000014',pg_temp.proof('pay_boundprecise','RECEIVED'))->>'ok')::boolean,'precise GET');
select pg_temp.assert_true((select credited_at='2026-09-01 18:34:56+00' and paid_at='2026-09-01 18:34:56+00'
 from public.student_payments where id='96000000-0000-4000-8000-000000000014'), 'same business-day precision must survive');
update public.student_payments set credited_at='2026-08-31 18:34:56+00',paid_at='2026-08-31 18:34:56+00'
where id='96000000-0000-4000-8000-000000000014';
select pg_temp.assert_true(pg_temp.observe('96000000-0000-4000-8000-000000000014',pg_temp.proof('pay_boundprecise','RECEIVED'))->>'reason'='bound_previous_proof_local_state_diverged',
 'same hash must not renew freshness while retaining a changed cash day');
update public.student_payments set provider_status='CHARGEBACK_REQUESTED' where id='96000000-0000-4000-8000-000000000013';
select pg_temp.assert_true(pg_temp.observe('96000000-0000-4000-8000-000000000013',pg_temp.proof('pay_boundboundary','RECEIVED'))->>'reason'='bound_local_financial_review_required',
 'positive GET must not erase local RECEIVED with provider chargeback warning');
select pg_temp.assert_true((select status='RECEIVED' and provider_status='CHARGEBACK_REQUESTED' and refunded_amount=0
 from public.student_payments where id='96000000-0000-4000-8000-000000000013'), 'dispute signal or cash incorrectly overwritten');

-- Negative proof matrix must leave invoice, ledger, outbox and audit untouched.
do $$ declare v_proof jsonb; v_result jsonb; v_before jsonb; v_candidate jsonb; begin
 select to_jsonb(p) into v_before from public.student_payments p where id='96000000-0000-4000-8000-000000000012';
 for v_proof in select x from jsonb_array_elements(jsonb_build_array(
   pg_temp.proof('pay_other'),
   pg_temp.proof('pay_boundnegative')||'{"customer":"cus_otherfixture"}',
   pg_temp.proof('pay_boundnegative')||'{"value":301}',
   pg_temp.proof('pay_boundnegative')||'{"deleted":true}',
   pg_temp.proof('pay_boundnegative')||'{"refundedValue":1}',
   pg_temp.proof('pay_boundnegative')||'{"chargeback":{"status":"REQUESTED","reason":"PROCESS_ERROR"}}',
   pg_temp.proof('pay_boundnegative')||'{"refunds":[{"status":"REQUESTED","value":1}]}',
   pg_temp.proof('pay_boundnegative')||'{"externalReference":"96000000-0000-4000-8000-000000000002"}',
   pg_temp.proof('pay_boundnegative')||'{"subscription":"sub_changed"}',
   pg_temp.proof('pay_boundnegative','RECEIVED')||'{"creditDate":null}'
 )) x loop
   v_result:=pg_temp.observe('96000000-0000-4000-8000-000000000012',v_proof);
   perform pg_temp.assert_true(not (v_result->>'ok')::boolean,'negative financial proof accepted: '||v_result::text);
 end loop;
 for v_candidate in select x from jsonb_array_elements(jsonb_build_array(
   v_before||'{"tenant_id":"bound-observation-other"}',v_before||'{"student_id":"96000000-0000-4000-8000-000000000002"}',
   v_before||'{"value":301}',v_before||'{"id":"96000000-0000-4000-8000-000000000099"}'
 )) x loop
   v_result:=public.apply_authoritative_bound_student_payment(v_candidate,pg_temp.bound_connection_id(),pg_temp.bound_connection_version(),'PLATFORM_MANAGED_ROOT',
     pg_temp.proof('pay_boundnegative'),pg_temp.parent(),clock_timestamp());
   perform pg_temp.assert_true(not (v_result->>'ok')::boolean,'cross identity or stale snapshot accepted');
 end loop;
 perform pg_temp.assert_true(not (pg_temp.observe('96000000-0000-4000-8000-000000000012',pg_temp.proof('pay_boundnegative'),pg_temp.parent()||'{"customer":"cus_otherfixture"}')->>'ok')::boolean,'cross-customer parent accepted');
 perform pg_temp.assert_true(not (pg_temp.observe('96000000-0000-4000-8000-000000000012',pg_temp.proof('pay_boundnegative'),pg_temp.parent()||'{"externalReference":"96000000-0000-4000-8000-000000000002"}')->>'ok')::boolean,'cross-student canonical parent accepted');
 perform pg_temp.assert_true(not (pg_temp.observe('96000000-0000-4000-8000-000000000012',pg_temp.proof('pay_boundnegative'),pg_temp.parent(),null,clock_timestamp()-interval '46 seconds')->>'ok')::boolean,'stale GET accepted');
 perform pg_temp.assert_true(not (public.apply_authoritative_bound_student_payment(v_before,pg_temp.bound_connection_id(),pg_temp.bound_connection_version()+1,'PLATFORM_MANAGED_ROOT',
     pg_temp.proof('pay_boundnegative'),pg_temp.parent(),clock_timestamp())->>'ok')::boolean,'rotated integration accepted');
 perform pg_temp.assert_true((select to_jsonb(p)=v_before from public.student_payments p where id='96000000-0000-4000-8000-000000000012'),'negative proof changed local invoice');
end $$;
select pg_temp.assert_true(not exists(select 1 from private.bound_payment_observations where payment_id='96000000-0000-4000-8000-000000000012')
 and not exists(select 1 from public.financial_transactions where student_payment_id='96000000-0000-4000-8000-000000000012')
 and not exists(select 1 from public.management_payment_notification_outbox where payment_id='96000000-0000-4000-8000-000000000012'),
 'rejected proof produced financial effects');

-- PAYMENT_UPDATED can retain status RECEIVED while its payload already proves
-- a refund. A contradictory fresh GET cannot hide that pending financial fact.
do $$ declare v_refund jsonb; v_before jsonb; v_result jsonb; begin
 select to_jsonb(p) into v_before from public.student_payments p where id='96000000-0000-4000-8000-000000000012';
 insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash,status) values
 ('evt_boundupdatedrefund','PAYMENT_UPDATED','pay_boundnegative',now()-interval '3 minutes',
   jsonb_build_object('payment',pg_temp.proof('pay_boundnegative','RECEIVED')),'bound-updated-refund-hash','TRIAGE'),
 ('evt_boundupdatedlater','PAYMENT_RECEIVED','pay_boundnegative',now()-interval '2 minutes',
   jsonb_build_object('payment',pg_temp.proof('pay_boundnegative','RECEIVED')),'bound-updated-later-hash','PROCESSING');
 for v_refund in select value from jsonb_array_elements('[{"refundedValue":1},{"refunds":[{"status":"DONE","value":1}]}]'::jsonb) loop
   update public.asaas_webhook_inbox set payload=jsonb_build_object('payment',pg_temp.proof('pay_boundnegative','RECEIVED')||v_refund),status='TRIAGE'
   where provider_event_id='evt_boundupdatedrefund';
   v_result:=pg_temp.observe('96000000-0000-4000-8000-000000000012',pg_temp.proof('pay_boundnegative','RECEIVED'));
   perform pg_temp.assert_true(v_result->>'reason'='bound_local_financial_review_required',
     'PAYMENT_UPDATED pending refund evidence accepted contradictory GET: '||v_result::text);
   perform pg_temp.assert_true((select to_jsonb(p)=v_before from public.student_payments p where id='96000000-0000-4000-8000-000000000012'),
     'refund evidence changed local payment instead of leaving review');
 end loop;
 update public.asaas_webhook_inbox set status='PROCESSED' where provider_event_id='evt_boundupdatedrefund';
end $$;

update public.student_payments set authoritative_subscription_id='sub_original' where id='96000000-0000-4000-8000-000000000012';
select pg_temp.assert_true(not (pg_temp.observe('96000000-0000-4000-8000-000000000012',pg_temp.proof('pay_boundnegative'))->>'ok')::boolean,
 'remembered canonical subscription may not change silently');

-- A pending or triaged dispute must not disappear merely because a later
-- positive inbox event arrives before the financial-review worker catches up.
insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash,status) values
 ('evt_bounddispute','PAYMENT_CHARGEBACK_DISPUTE','pay_boundnegative',now()-interval '2 minutes',
   jsonb_build_object('payment',pg_temp.proof('pay_boundnegative','RECEIVED')||'{"status":"CHARGEBACK_DISPUTE"}'),'bound-dispute-hash','TRIAGE'),
 ('evt_boundlaterpositive','PAYMENT_RECEIVED','pay_boundnegative',now()-interval '1 minute',
   jsonb_build_object('payment',pg_temp.proof('pay_boundnegative','RECEIVED')),'bound-later-positive-hash','PROCESSING');
select pg_temp.assert_true(pg_temp.observe('96000000-0000-4000-8000-000000000012',pg_temp.proof('pay_boundnegative','RECEIVED'))->>'reason'='bound_local_financial_review_required',
 'unprocessed/triaged inbox reversal must block positive repair even on PENDING');
update public.asaas_webhook_inbox set status='PROCESSED' where provider_event_id='evt_bounddispute';
insert into public.asaas_reconciliation_issues(tenant_id,source,kind,severity,provider_entity_id,local_entity_id,fingerprint,details)
values('school-wise-wolf','asaas-webhook','NON_FINAL_FINANCIAL_EVENT','HIGH','pay_boundnegative','96000000-0000-4000-8000-000000000012','bound-fixture-open-dispute','{"reason":"chargeback_not_final"}');
select pg_temp.assert_true(pg_temp.observe('96000000-0000-4000-8000-000000000012',pg_temp.proof('pay_boundnegative','RECEIVED'))->>'reason'='bound_local_financial_review_required',
 'open financial review issue must not be automatically resolved by GET');
do $$ begin
 begin
   update private.bound_payment_observations set proof_hash='changed' where tenant_id='school-wise-wolf';
   raise exception 'private audit was mutable';
 exception when sqlstate '55000' then null; end;
end $$;
rollback;
