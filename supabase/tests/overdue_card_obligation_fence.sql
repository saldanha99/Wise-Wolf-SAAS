-- Isolated empty finance QA only; never a provider call or durable fixture.
begin;
do $$ begin
 if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
   or exists(select 1 from public.profiles) or exists(select 1 from auth.users) or exists(select 1 from vault.secrets)
 then raise exception 'isolated_empty_finance_qa_required'; end if;
end $$;
create function pg_temp.assert_card(v boolean,m text) returns void language plpgsql as $$
begin if not coalesce(v,false) then raise exception 'card obligation assertion: %',m; end if; end $$;
insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled)
 values('overdue-card-qa','Card QA','overdue-card-qa','active',false);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated',email,'{"provider":"email","providers":["email"]}'::jsonb,
 '{"full_name":"Synthetic Card QA"}'::jsonb,now(),now() from (values
 ('7e160000-0000-4000-8000-000000000001'::uuid,'card-admin@example.invalid'),
 ('7e160000-0000-4000-8000-000000000011'::uuid,'card-student@example.invalid')) f(id,email);
set local app.enrollment_claim='1';
update public.profiles set tenant_id='overdue-card-qa',status='Ativo',lifecycle_status='active',
 role=case when id='7e160000-0000-4000-8000-000000000001' then 'SCHOOL_ADMIN' else 'STUDENT' end,
 is_test_account=true,test_fixture_key='overdue-card-qa-'||id::text,
 asaas_customer_id=case when id='7e160000-0000-4000-8000-000000000011' then 'cus_card_qa' end,
 subscription_id=case when id='7e160000-0000-4000-8000-000000000011' then 'sub_card_qa' end
 where id in ('7e160000-0000-4000-8000-000000000001','7e160000-0000-4000-8000-000000000011');
set local app.enrollment_claim='';
delete from public.tenant_memberships where user_id in ('7e160000-0000-4000-8000-000000000001','7e160000-0000-4000-8000-000000000011');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id='overdue-card-qa';
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,provider_customer_id,value,status,provider_status,due_date,payment_type,description,raw_payload)
 values('7e160000-0000-4000-8000-0000000000a1','overdue-card-qa','7e160000-0000-4000-8000-000000000011',
 'pay_card_qa','cus_card_qa',100,'OVERDUE','OVERDUE','2026-07-10','SUBSCRIPTION','Mensalidade QA',
 '{"payment":{"subscription":"sub_card_qa"}}');
create temporary table card_state(k text primary key,v jsonb);
insert into card_state values('snapshot','{"id":"pay_card_qa","subscription":"sub_card_qa","status":"OVERDUE","value_cents":10000,"dueDate":"2026-07-10","billingType":"PIX"}');
set local request.jwt.claims='{"role":"service_role"}';
create function pg_temp.check_card(snapshot jsonb) returns jsonb language sql as $$
 select public.validate_student_overdue_card_obligations('overdue-card-qa','7e160000-0000-4000-8000-000000000011','sub_card_qa',jsonb_build_array(snapshot)); $$;
select pg_temp.assert_card((pg_temp.check_card(v)->>'ok')::boolean,'uncovered bound invoice rejected') from card_state where k='snapshot';
select pg_temp.assert_card((pg_temp.check_card(v||'{"id":"pay_missing"}')->>'ok')='false','provider proof without local obligation accepted') from card_state where k='snapshot';
select pg_temp.assert_card((pg_temp.check_card(v||'{"value_cents":10001}')->>'ok')='false','changed value accepted') from card_state where k='snapshot';
select pg_temp.assert_card((pg_temp.check_card(v||'{"dueDate":"2026-07-11"}')->>'ok')='false','changed due accepted') from card_state where k='snapshot';
select pg_temp.assert_card((pg_temp.check_card(v||'{"status":"CONFIRMED"}')->>'ok')='false','confirmed accepted') from card_state where k='snapshot';
select pg_temp.assert_card((public.validate_student_overdue_card_obligations('other','7e160000-0000-4000-8000-000000000011','sub_card_qa','[]')->>'ok')='false','wrong tenant accepted');
savepoint null_status;
update public.student_payments set status=null,provider_status=null where id='7e160000-0000-4000-8000-0000000000a1';
select pg_temp.assert_card(pg_temp.check_card(v)->>'ok'='false','NULL local status accepted') from card_state where k='snapshot';
rollback to savepoint null_status;
savepoint reversal_evidence;
insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash,status)
 values('evt_card_qa_reversal','PAYMENT_UPDATED','pay_card_qa',now(),
 '{"payment":{"id":"pay_card_qa","status":"OVERDUE","refundedValue":1}}','synthetic-card-refund','TRIAGE');
select pg_temp.assert_card(pg_temp.check_card(v)->>'reason'='provider_reversal_requires_review','nonterminal inbox refund ignored') from card_state where k='snapshot';
rollback to savepoint reversal_evidence;
insert into card_state values('claim',public.claim_student_overdue_card_charge('overdue-card-qa','7e160000-0000-4000-8000-000000000011',
 'sub_card_qa','pay_card_qa','7e160000-0000-4000-8000-000000000001','7e160000-0000-4000-8000-0000000000f1',300));
select pg_temp.assert_card(v->>'action'='SUBMIT_ONCE','claim fixture failed') from card_state where k='claim';
set local request.jwt.claims='{"role":"authenticated","sub":"7e160000-0000-4000-8000-000000000001"}';
insert into card_state values('coverage',public.register_external_prepayment('7e160000-0000-4000-8000-000000000011',200,'2026-06-01','2026-07-01',2,'LEGADO','Synthetic prior receipt'));
select pg_temp.assert_card((v->>'ok')::boolean,'coverage fixture failed: '||v::text) from card_state where k='coverage';
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_card(pg_temp.check_card(v)->>'reason'='financial_recompute_pending','dirty financial queue ignored') from card_state where k='snapshot';
-- Simulate the isolated worker acknowledgement, never a global queue claim.
update private.prepayment_financial_recompute_queue set processed_version=version where tenant_id='overdue-card-qa';
select pg_temp.assert_card(pg_temp.check_card(v)->>'reason'='mes_coberto_por_pagamento_completo','valid prepaid month charged') from card_state where k='snapshot';
select pg_temp.assert_card(public.mark_student_overdue_card_charge_submitting_v2((select (v->>'claim_id')::uuid from card_state where k='claim'),
 '7e160000-0000-4000-8000-0000000000f1',(select v from card_state where k='snapshot'))->>'ok'='false','coverage added after claim ignored');
update public.student_payment_allocations set status='REVIEW' where tenant_id='overdue-card-qa';
update private.prepayment_financial_recompute_queue set processed_version=version where tenant_id='overdue-card-qa';
select pg_temp.assert_card(pg_temp.check_card(v)->>'reason'='pagamento_completo_em_revisao','review month charged') from card_state where k='snapshot';
set local request.jwt.claims='{"role":"authenticated","sub":"7e160000-0000-4000-8000-000000000001"}';
select public.cancel_prepayment_with_reason((select (v->>'grupo_id')::uuid from card_state where k='coverage'),'Synthetic cancellation for positive case',
 (select registration_id from public.student_payment_allocations where tenant_id='overdue-card-qa' limit 1));
set local request.jwt.claims='{"role":"service_role"}';
update private.prepayment_financial_recompute_queue set processed_version=version where tenant_id='overdue-card-qa';
update public.student_payments set value=101 where id='7e160000-0000-4000-8000-0000000000a1';
select pg_temp.assert_card(public.mark_student_overdue_card_charge_submitting_v2((select (v->>'claim_id')::uuid from card_state where k='claim'),
 '7e160000-0000-4000-8000-0000000000f1',(select v from card_state where k='snapshot'))->>'ok'='false','changed value after claim ignored');
update public.student_payments set value=100 where id='7e160000-0000-4000-8000-0000000000a1';
select pg_temp.assert_card(public.mark_student_overdue_card_charge_submitting_v2((select (v->>'claim_id')::uuid from card_state where k='claim'),
 '7e160000-0000-4000-8000-0000000000f1',(select v from card_state where k='snapshot'))->>'ok'='true','valid final fence failed');
select pg_temp.assert_card(public.mark_student_overdue_card_charge_submitting_v2((select (v->>'claim_id')::uuid from card_state where k='claim'),
 '7e160000-0000-4000-8000-0000000000f1',(select v from card_state where k='snapshot'))->>'ok'='false','repeat submit accepted');
select pg_temp.assert_card(not has_function_privilege('service_role','public.mark_student_overdue_card_charge_submitting(uuid,uuid)','EXECUTE')
 and not has_function_privilege('authenticated','public.mark_student_overdue_card_charge_submitting_v2(uuid,uuid,jsonb)','EXECUTE')
 and has_function_privilege('service_role','public.mark_student_overdue_card_charge_submitting_v2(uuid,uuid,jsonb)','EXECUTE'),'unsafe final fence ACL');
select pg_temp.assert_card(not exists(select 1 from public.financial_transactions where tenant_id='overdue-card-qa'),'guard created cash');
rollback;
