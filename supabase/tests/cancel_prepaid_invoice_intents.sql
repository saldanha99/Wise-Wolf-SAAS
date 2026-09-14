-- Isolated finance QA only; no real identity/provider call. Rolled back in full.
begin;
create function pg_temp.assert_cancel(ok boolean,msg text) returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'cancel prepaid invoice assertion: %',msg; end if; end;
$$;
insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values
 ('prepaid-cancel-qa','Prepaid Cancel QA','prepaid-cancel-qa','active',false),
 ('prepaid-cancel-other','Prepaid Other QA','prepaid-cancel-other','active',false);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated',email,'{"provider":"email","providers":["email"]}'::jsonb,
 jsonb_build_object('full_name',name),now(),now()
from (values
 ('7e150000-0000-4000-8000-000000000001'::uuid,'prepaid-cancel-admin@example.invalid','Cancel QA Admin'),
 ('7e150000-0000-4000-8000-000000000002'::uuid,'prepaid-cancel-other@example.invalid','Other QA Admin'),
 ('7e150000-0000-4000-8000-000000000011'::uuid,'prepaid-cancel-student@example.invalid','Cancel QA Student')
) f(id,email,name);
set local app.enrollment_claim='1';
update public.profiles set
 tenant_id=case when id='7e150000-0000-4000-8000-000000000002' then 'prepaid-cancel-other' else 'prepaid-cancel-qa' end,
 role=case when id='7e150000-0000-4000-8000-000000000011' then 'STUDENT' else 'SCHOOL_ADMIN' end,
 status='Ativo',lifecycle_status='active',is_test_account=true,test_fixture_key='prepaid-cancel-qa-'||id::text,
 asaas_customer_id=case when id='7e150000-0000-4000-8000-000000000011' then 'cus_prepaid_cancel_qa' end,
 subscription_id=case when id='7e150000-0000-4000-8000-000000000011' then 'sub_prepaid_cancel_qa' end
where id::text like '7e150000-0000-4000-8000-%';
set local app.enrollment_claim='';
delete from public.tenant_memberships where user_id::text like '7e150000-0000-4000-8000-%';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where id::text like '7e150000-0000-4000-8000-%';
set local request.jwt.claims='{"role":"authenticated","sub":"7e150000-0000-4000-8000-000000000001"}';
create temporary table cancel_results(k text primary key,v jsonb);
select pg_temp.assert_cancel(public.register_external_prepayment(
 '7e150000-0000-4000-8000-000000000011',400,'2026-01-01','2026-09-01',2,'MENSAL','Unsupported monthly external')->>'error'='modo_invalido',
 'external receipt accepted monthly rateio without economic dedupe');
insert into cancel_results values('coverage',public.register_external_prepayment(
 '7e150000-0000-4000-8000-000000000011',400,'2026-01-01','2026-09-01',2,'LEGADO','Isolated test receipt only'));
select pg_temp.assert_cancel((select (v->>'ok')::boolean from cancel_results where k='coverage'),'external coverage fixture');
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,provider_customer_id,value,status,provider_status,due_date,payment_type,description,raw_payload)
select id,'prepaid-cancel-qa','7e150000-0000-4000-8000-000000000011',provider_id,'cus_prepaid_cancel_qa',100,status,status,'2026-09-15',kind,description,
 jsonb_build_object('payment',jsonb_build_object('id',provider_id,'customer','cus_prepaid_cancel_qa','subscription','sub_prepaid_cancel_qa'))
from (values
 ('7e150000-0000-4000-8000-0000000000a1'::uuid,'pay_prepaid_cancel_qa_a','PENDING','SUBSCRIPTION','Mensalidade'),
 ('7e150000-0000-4000-8000-0000000000a2'::uuid,'pay_prepaid_cancel_qa_b','OVERDUE','SUBSCRIPTION','Mensalidade'),
 ('7e150000-0000-4000-8000-0000000000a3'::uuid,'pay_prepaid_cancel_qa_c','CONFIRMED','SUBSCRIPTION','Mensalidade'),
 ('7e150000-0000-4000-8000-0000000000a4'::uuid,'pay_prepaid_cancel_qa_d','RECEIVED','SUBSCRIPTION','Mensalidade'),
 ('7e150000-0000-4000-8000-0000000000a5'::uuid,'pay_prepaid_cancel_qa_e','PENDING','ENROLLMENT','Taxa de matrícula'),
 ('7e150000-0000-4000-8000-0000000000a6'::uuid,'pay_prepaid_cancel_qa_f','PENDING','SUBSCRIPTION','Aula extra')
) f(id,provider_id,status,kind,description);
insert into cancel_results values('list',public.get_prepaid_invoice_cancellations('prepaid-cancel-qa','7e150000-0000-4000-8000-000000000011'));
select pg_temp.assert_cancel((select jsonb_array_length(v->'invoices')=2 from cancel_results where k='list'),'reader exposed paid/confirmed/fee/extra');
select pg_temp.assert_cancel(public.request_prepaid_invoice_cancellation('7e150000-0000-4000-8000-0000000000a1','Invoice duplicate in test','2026-09-16',100)->>'error'='cobranca_alterada_recarregue','stale due accepted');
insert into cancel_results values('request',public.request_prepaid_invoice_cancellation('7e150000-0000-4000-8000-0000000000a1','Invoice duplicate in test','2026-09-15',100));
insert into cancel_results values('replay',public.request_prepaid_invoice_cancellation('7e150000-0000-4000-8000-0000000000a1','Invoice duplicate in test','2026-09-15',100));
select pg_temp.assert_cancel((select v->>'operation_id' from cancel_results where k='request')=(select v->>'operation_id' from cancel_results where k='replay')
 and (select count(*)=1 from private.prepaid_invoice_cancellation_intents),'duplicate intent');
select pg_temp.assert_cancel(not has_function_privilege('authenticated','public.begin_prepaid_invoice_delete(uuid,uuid,uuid,jsonb,jsonb)','EXECUTE')
 and not has_function_privilege('authenticated','public.finish_prepaid_invoice_cancellation(uuid,uuid,uuid,text,jsonb)','EXECUTE')
 and not has_table_privilege('service_role','private.prepaid_invoice_cancellation_intents','UPDATE'),'unsafe direct writes');
set local request.jwt.claims='{"role":"authenticated","sub":"7e150000-0000-4000-8000-000000000002"}';
select pg_temp.assert_cancel(public.get_prepaid_invoice_cancellations('prepaid-cancel-qa','7e150000-0000-4000-8000-000000000011')->>'error'='sem_permissao','cross tenant read');
select pg_temp.assert_cancel(public.request_prepaid_invoice_cancellation('7e150000-0000-4000-8000-0000000000a2','Other school attempt','2026-09-15',100)->>'error'='sem_permissao','cross tenant intent');
set local request.jwt.claims='{"role":"service_role"}';
insert into cancel_results values('claim',public.claim_prepaid_invoice_cancellation(
 (select (v->>'operation_id')::uuid from cancel_results where k='request'),'7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f1'));
select pg_temp.assert_cancel((select v->>'action'='SUBMIT_ONCE' from cancel_results where k='claim'),'initial claim');
select pg_temp.assert_cancel(public.claim_prepaid_invoice_cancellation((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f2')->>'action'='IN_PROGRESS','duplicate worker');
insert into cancel_results values('provider',jsonb_build_object('id','pay_prepaid_cancel_qa_a','customer','cus_prepaid_cancel_qa',
 'subscription','sub_prepaid_cancel_qa','dueDate','2026-09-15','value',100,'status','PENDING','deleted',false));
select pg_temp.assert_cancel(public.begin_prepaid_invoice_delete((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f1',
 (select v||'{"status":"CONFIRMED"}' from cancel_results where k='provider'),'{"tenant_id":"prepaid-cancel-qa"}')->>'error'='source_or_provider_changed','confirmed provider deleted');
insert into cancel_results values('begin',public.begin_prepaid_invoice_delete((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f1',
 (select v from cancel_results where k='provider'),'{"tenant_id":"prepaid-cancel-qa"}'));
select pg_temp.assert_cancel((select (v->>'ok')::boolean from cancel_results where k='begin'),'valid boundary');
select pg_temp.assert_cancel(public.finish_prepaid_invoice_cancellation((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f1','DELETE_CONFIRMED','{"id":"pay_other","deleted":true}')->>'error'='deletion_not_proven','wrong receipt accepted');
insert into cancel_results values('unknown',public.finish_prepaid_invoice_cancellation((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f1','UNKNOWN','{"reason":"timeout"}'));
select pg_temp.assert_cancel((select status='PENDING' from public.student_payments where id='7e150000-0000-4000-8000-0000000000a1'),'unknown mutated payment');
insert into cancel_results values('reconcile',public.claim_prepaid_invoice_cancellation(
 (select (v->>'operation_id')::uuid from cancel_results where k='request'),'7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f2'));
select pg_temp.assert_cancel((select v->>'action'='RECONCILE_ONLY' from cancel_results where k='reconcile'),'unknown can resubmit');
select pg_temp.assert_cancel(public.begin_prepaid_invoice_delete((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f2',
 (select v from cancel_results where k='provider'),'{"tenant_id":"prepaid-cancel-qa"}')->>'error'='claim_changed','reconcile opened DELETE');
select pg_temp.assert_cancel(public.finish_prepaid_invoice_cancellation((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f2','GET_DELETED',
 (select v||'{"deleted":true,"status":"RECEIVED"}' from cancel_results where k='provider'))->>'error'='deletion_not_proven',
 'deleted flag overrode provider financial settlement');
insert into cancel_results values('confirmed',public.finish_prepaid_invoice_cancellation((select (v->>'operation_id')::uuid from cancel_results where k='request'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f2','GET_DELETED',
 (select v||'{"deleted":true}' from cancel_results where k='provider')));
select pg_temp.assert_cancel((select status='CANCELLED' from public.student_payments where id='7e150000-0000-4000-8000-0000000000a1')
 and (select v->>'status'='CONFIRMED' from cancel_results where k='confirmed'),'confirmed deletion not applied');
select pg_temp.assert_cancel((select subscription_id='sub_prepaid_cancel_qa' from public.profiles where id='7e150000-0000-4000-8000-000000000011')
 and (select status='OVERDUE' from public.student_payments where id='7e150000-0000-4000-8000-0000000000a2'),'subscription or other invoice changed');

-- Coverage canceled after intent: final submit fence refuses the DELETE.
set local request.jwt.claims='{"role":"authenticated","sub":"7e150000-0000-4000-8000-000000000001"}';
insert into cancel_results values('request_b',public.request_prepaid_invoice_cancellation('7e150000-0000-4000-8000-0000000000a2','Second duplicate in isolated test','2026-09-15',100));
set local request.jwt.claims='{"role":"service_role"}';
insert into cancel_results values('claim_b',public.claim_prepaid_invoice_cancellation(
 (select (v->>'operation_id')::uuid from cancel_results where k='request_b'),'7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f3'));
set local request.jwt.claims='{"role":"authenticated","sub":"7e150000-0000-4000-8000-000000000001"}';
select public.cancel_prepayment_with_reason((select (v->>'grupo_id')::uuid from cancel_results where k='coverage'),'Cancel test coverage after intent',
 (select registration_id from public.student_payment_allocations where student_id='7e150000-0000-4000-8000-000000000011' limit 1));
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_cancel(public.begin_prepaid_invoice_delete((select (v->>'operation_id')::uuid from cancel_results where k='request_b'),
 '7e150000-0000-4000-8000-000000000001','7e150000-0000-4000-8000-0000000000f3',
 (select v||'{"id":"pay_prepaid_cancel_qa_b","status":"OVERDUE"}' from cancel_results where k='provider'),
 '{"tenant_id":"prepaid-cancel-qa"}')->>'error'='source_or_provider_changed','lost coverage passed boundary');
do $$ begin
 begin update private.prepaid_invoice_cancellation_events set event_type='rewrite';
   raise exception 'history rewrite allowed'; exception when sqlstate '55000' then null; end;
end $$;
select pg_temp.assert_cancel((select count(*)>=5 from private.prepaid_invoice_cancellation_events),'missing audit trail');
rollback;
