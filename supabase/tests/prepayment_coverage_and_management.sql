-- Fixtures financeiras isoladas; nenhum identificador real, credencial ou envio.
begin;
create function pg_temp.assert_finance(ok boolean, message text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'finance coverage: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_finance(boolean,text) to authenticated;
create temporary table finance_period as select
  (now() at time zone 'America/Sao_Paulo')::date as today,
  date_trunc('month', now() at time zone 'America/Sao_Paulo')::date as month;

insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values
 ('finance-coverage-qa','Finance Coverage QA','finance-coverage-qa','active',false),
 ('finance-coverage-other','Finance Other QA','finance-coverage-other','active',false);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated',email,'{"provider":"email","providers":["email"]}'::jsonb,
 jsonb_build_object('full_name',name),now(),now()
from (values
 ('8e140000-0000-4000-8000-000000000001'::uuid,'finance-admin@example.invalid','Finance Admin QA'),
 ('8e140000-0000-4000-8000-000000000002'::uuid,'finance-other@example.invalid','Finance Other QA'),
 ('8e140000-0000-4000-8000-000000000011'::uuid,'finance-student@example.invalid','Finance Student QA'),
 ('8e140000-0000-4000-8000-000000000012'::uuid,'finance-external@example.invalid','Finance External QA')
) f(id,email,name);
set local app.enrollment_claim='1';
update public.profiles set
 tenant_id=case when id='8e140000-0000-4000-8000-000000000002' then 'finance-coverage-other' else 'finance-coverage-qa' end,
 role=case when id in ('8e140000-0000-4000-8000-000000000001','8e140000-0000-4000-8000-000000000002') then 'SCHOOL_ADMIN' else 'STUDENT' end,
 status='Ativo',lifecycle_status='active',status_financial='OVERDUE',monthly_fee=100,
 is_test_account=false,test_fixture_key=null,created_at='2026-01-01',due_day=10
where id::text like '8e140000-0000-4000-8000-%';
set local app.enrollment_claim='';
delete from public.tenant_memberships where user_id::text like '8e140000-0000-4000-8000-%';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
select id,tenant_id,role,'ACTIVE',true from public.profiles where id::text like '8e140000-0000-4000-8000-%';

insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,provider_status,
 due_date,payment_date,paid_at,payment_type,description)
select '8e140000-0000-4000-8000-0000000000a1','finance-coverage-qa','8e140000-0000-4000-8000-000000000011',
 'pay_finance_coverage_qa',300,'RECEIVED','RECEIVED',month,month,month::timestamp+interval '12 hours','SUBSCRIPTION','Mensalidades do pacote QA'
from finance_period;
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance((public.register_prepayment('8e140000-0000-4000-8000-0000000000a1',month,3,'MENSAL')->>'ok')::boolean,'register valid package') from finance_period;
select pg_temp.assert_finance((public.register_external_prepayment('8e140000-0000-4000-8000-000000000012',300,today,month,3,'LEGADO','Recebimento externo fictício para QA, sem lançamento de caixa')->>'ok')::boolean,'register external') from finance_period;
set local request.jwt.claims='';

insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,due_date,payment_type,description)
select id,'finance-coverage-qa','8e140000-0000-4000-8000-000000000011',provider,value,'OVERDUE',today,kind,description
from (values
 ('8e140000-0000-4000-8000-0000000000b1'::uuid,'pay_finance_month_qa',100::numeric,'SUBSCRIPTION','Mensalidade QA'),
 ('8e140000-0000-4000-8000-0000000000b2'::uuid,'pay_finance_enroll_qa',29.90::numeric,'ENROLLMENT','Taxa de matrícula QA'),
 ('8e140000-0000-4000-8000-0000000000b3'::uuid,'pay_finance_extra_qa',20::numeric,'SUBSCRIPTION','Aula extra QA')
) p(id,provider,value,kind,description) cross join finance_period;
select pg_temp.assert_finance(private.student_payment_is_covered('8e140000-0000-4000-8000-0000000000b1')
 and not private.student_payment_is_covered('8e140000-0000-4000-8000-0000000000b2')
 and not private.student_payment_is_covered('8e140000-0000-4000-8000-0000000000b3'), 'coverage swallowed fees/extras');
select pg_temp.assert_finance(private.student_payment_provider_block_reason('8e140000-0000-4000-8000-0000000000b1')='mes_coberto_por_pagamento_completo'
 and private.student_payment_provider_block_reason('8e140000-0000-4000-8000-0000000000b2') is null
 and private.student_payment_provider_block_reason('8e140000-0000-4000-8000-0000000000b3') is null,'collection blocked a non-tuition debt');

set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_finance(public.recompute_student_financial_status('finance-coverage-qa','8e140000-0000-4000-8000-000000000011')->>'status'='OVERDUE','other debt incorrectly settled');
select pg_temp.assert_finance(public.recompute_student_financial_status('finance-coverage-qa','8e140000-0000-4000-8000-000000000012')->>'status'='ACTIVE','external covered student remains blocked');
select public.generate_monthly_student_payments('finance-coverage-qa',(month+interval '1 month')::date) from finance_period;
select pg_temp.assert_finance(not exists(select 1 from public.student_payments where tenant_id='finance-coverage-qa' and asaas_payment_id like 'MANUAL_MONTHLY_%'),'generated invoice for covered month');

set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance((select overdue_count=2 and overdue_value=49.90 from public.list_students_overview()
 where student_id='8e140000-0000-4000-8000-000000000011'),'overview overdue/risk includes covered tuition');
select pg_temp.assert_finance(
 (public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null)->>'ok')::boolean
 and jsonb_array_length(public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null)->'allocations')=3
 and jsonb_array_length(public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null)->'history')=3,
 'management context lacks coverage/audit');
select pg_temp.assert_finance(public.get_prepayment_management_context('finance-coverage-other',null,null)->>'error'='sem_permissao','cross-tenant context');
set local role authenticated;
select pg_temp.assert_finance((public.get_prepayment_management_context('finance-coverage-qa',null,'Finance Student')->>'ok')::boolean,'context not executable as browser');
reset role;

-- O contexto nunca oferece recadastro de cobertura existente nem transforma
-- observação de estorno em "Ativa" enquanto a prova local aguarda conciliação.
select pg_temp.assert_finance(
 public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null)
 #>>'{payments,0,registration_block_reason}'='pagamento_ja_tem_parcelas', 'context permits existing coverage registration');
savepoint finance_review_context;
set local request.jwt.claims='';
insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash)
values('evt_finance_coverage_observed_refund','PAYMENT_PARTIALLY_REFUNDED','pay_finance_coverage_qa',now(),
 '{"payment":{"id":"pay_finance_coverage_qa","status":"REFUNDED"}}',repeat('e',64));
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance((
 select not (ctx#>>'{payments,0,registration_allowed}')::boolean
   and ctx#>>'{payments,0,registration_block_reason}'='pagamento_requer_revisao'
   and (select bool_and(a->>'status'='REVIEW' and a->>'stored_status'='ACTIVE'
     and not (a->>'is_valid')::boolean and a->>'status_reason'='PAYMENT_PROVIDER_OBSERVATION_REVIEW')
     from jsonb_array_elements(ctx->'allocations') a)
 from (select public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null) ctx) q),
 'context does not expose effective provider review');
select pg_temp.assert_finance((select bool_and(status='ACTIVE') from public.student_payment_allocations
 where payment_id='8e140000-0000-4000-8000-0000000000a1')
 and (select count(*)=3 from private.prepayment_allocation_events
 where payment_id='8e140000-0000-4000-8000-0000000000a1'), 'reader rewrote stored allocation/audit history');
rollback to savepoint finance_review_context;

-- Reproduz o mesmo gate do core: cancelamento não desfaz preparo/tentativa
-- mensal. Já um aviso integral permite LEGADO, sem redividir o mesmo dinheiro.
savepoint finance_frozen_notice_context;
select pg_temp.assert_finance((public.cancel_prepayment_with_reason(
 '8e140000-0000-4000-8000-0000000000a1','Cancelamento fictício para validar trava de aviso')->>'ok')::boolean,'cancel fixture before frozen notice');
set local request.jwt.claims='';
insert into public.management_payment_notification_outbox(
 tenant_id,payment_id,notification_kind,status,claim_token,lease_expires_at,submit_attempt_count,
 configured_destination_snapshot,provider_destination,provider_instance_name,provider_integration_id,provider_integration_version,
 message_body,source_snapshot,source_snapshot_hash)
values('finance-coverage-qa','8e140000-0000-4000-8000-0000000000a1','PAYMENT_SPLIT','PREPARED',gen_random_uuid(),now()+interval '5 minutes',0,
 '120363000000000997@g.us','120363000000000997@g.us','finance-context-qa',gen_random_uuid(),1,
 'Isolated context fixture',jsonb_build_object('modo','MENSAL'),repeat('c',64))
on conflict(tenant_id,payment_id) do update set
 notification_kind=excluded.notification_kind,status=excluded.status,claim_token=excluded.claim_token,
 lease_expires_at=excluded.lease_expires_at,submit_attempt_count=excluded.submit_attempt_count,
 configured_destination_snapshot=excluded.configured_destination_snapshot,provider_destination=excluded.provider_destination,
 provider_instance_name=excluded.provider_instance_name,provider_integration_id=excluded.provider_integration_id,
 provider_integration_version=excluded.provider_integration_version,message_body=excluded.message_body,
 source_snapshot=excluded.source_snapshot,source_snapshot_hash=excluded.source_snapshot_hash,
 provider_endpoint_hash=null,provider_credential_hash=null,snapshot_hash=null;
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance((
 select not (ctx#>>'{payments,0,registration_allowed}')::boolean and not (ctx#>>'{payments,0,monthly_allowed}')::boolean
   and ctx#>>'{payments,0,registration_block_reason}'='parcelamento_mensal_ja_avisado_requer_reconciliacao'
 from (select public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null) ctx) q)
 and public.register_prepayment('8e140000-0000-4000-8000-0000000000a1',month,3,'LEGADO')->>'error'='parcelamento_mensal_ja_avisado_requer_reconciliacao'
 and public.register_prepayment('8e140000-0000-4000-8000-0000000000a1',month,3,'MENSAL')->>'error'='parcelamento_mensal_ja_avisado_requer_reconciliacao',
 'context/core disagree on prepared monthly recadastro') from finance_period;
set local request.jwt.claims='';
update public.management_payment_notification_outbox set status='FAILED',submit_attempt_count=1,
 provider_endpoint_hash=repeat('a',64),provider_credential_hash=repeat('b',64),snapshot_hash=repeat('d',64)
where tenant_id='finance-coverage-qa' and payment_id='8e140000-0000-4000-8000-0000000000a1';
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance(public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null)
 #>>'{payments,0,registration_block_reason}'='parcelamento_mensal_ja_avisado_requer_reconciliacao','failed attempted monthly notice permits recadastro');
set local request.jwt.claims='';
update public.management_payment_notification_outbox set status='SENT',source_snapshot='{"modo":"LEGADO"}',
 provider_message_id='qa-context-delivery',provider_delivery_status='delivered',delivered_at=now()
where tenant_id='finance-coverage-qa' and payment_id='8e140000-0000-4000-8000-0000000000a1';
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance((
 select (ctx#>>'{payments,0,registration_allowed}')::boolean and not (ctx#>>'{payments,0,monthly_allowed}')::boolean
   and ctx#>>'{payments,0,monthly_block_reason}'='aviso_do_rateio_ja_saiu'
 from (select public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null) ctx) q),
 'context incorrectly blocks LEGADO after full original notice');
set local request.jwt.claims='';
insert into public.management_reserve_notification_outbox(
 tenant_id,notification_kind,allocation_id,period_start,subject_key,status,submit_attempt_count)
select tenant_id,'INSTALLMENT_SPLIT',id,competencia,id::text,'UNKNOWN',1
from public.student_payment_allocations where payment_id='8e140000-0000-4000-8000-0000000000a1' and sequencia=2;
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance(public.get_prepayment_management_context('finance-coverage-qa','8e140000-0000-4000-8000-000000000011',null)
 #>>'{payments,0,registration_block_reason}'='parcelamento_mensal_ja_avisado_requer_reconciliacao'
 and public.register_prepayment('8e140000-0000-4000-8000-0000000000a1',month,3,'LEGADO')->>'error'='parcelamento_mensal_ja_avisado_requer_reconciliacao',
 'future installment attempted notice is not reflected by context') from finance_period;
rollback to savepoint finance_frozen_notice_context;

-- Quitada a dívida extra, só a mensalidade coberta não mantém atraso.
set local request.jwt.claims='';
update public.student_payments set status='CANCELLED' where id in
 ('8e140000-0000-4000-8000-0000000000b2','8e140000-0000-4000-8000-0000000000b3');
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_finance(public.recompute_student_financial_status('finance-coverage-qa','8e140000-0000-4000-8000-000000000011')->>'status'='ACTIVE','covered tuition still overdue');

-- Estorno parcial: sem quitação e sem cobrança automática até revisão.
set local request.jwt.claims='';
update public.student_payments set refunded_amount=10 where id='8e140000-0000-4000-8000-0000000000a1';
select pg_temp.assert_finance(private.student_payment_prepayment_state('8e140000-0000-4000-8000-0000000000b1')='REVIEW'
 and private.student_payment_provider_block_reason('8e140000-0000-4000-8000-0000000000b1')='pagamento_completo_em_revisao','refund not surfaced as review');
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_finance(public.recompute_student_financial_status('finance-coverage-qa','8e140000-0000-4000-8000-000000000011')->>'status'='PENDING','refund still grants settled access');
select public.refresh_monthly_payment_closure('finance-coverage-qa',month) from finance_period;
select pg_temp.assert_finance((select status='REVIEW' and details#>>'{prepaid_coverage,reason}'='PREPAID_COVERAGE_REVIEW'
 from public.monthly_payment_obligations where tenant_id='finance-coverage-qa' and student_id='8e140000-0000-4000-8000-000000000011'),'monthly closure marks refunded package SETTLED');
select public.generate_monthly_student_payments('finance-coverage-qa',(month+interval '2 months')::date) from finance_period;
select pg_temp.assert_finance(not exists(select 1 from public.student_payments where tenant_id='finance-coverage-qa' and asaas_payment_id like 'MANUAL_MONTHLY_%'),'generated invoice while coverage under review');

-- Cancelar a única prova externa revoga apenas o ACTIVE derivado dela.
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance((public.cancel_prepayment_with_reason(grupo_id,
 'Cancelamento fictício do recebimento externo para QA',registration_id)->>'ok')::boolean,
 'external cancellation') from public.student_payment_allocations
where student_id='8e140000-0000-4000-8000-000000000012' order by sequencia limit 1;
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_finance(public.recompute_student_financial_status('finance-coverage-qa',
 '8e140000-0000-4000-8000-000000000012')->>'status'='PENDING',
 'cancelled sole external coverage preserved derived ACTIVE');
select pg_temp.assert_finance(public.recompute_student_financial_status('finance-coverage-qa',
 '8e140000-0000-4000-8000-000000000012')->>'status'='PENDING',
 'repeat recompute changed cancelled coverage status');

set local request.jwt.claims='';
update public.tenant_memberships set status='REVOKED' where user_id='8e140000-0000-4000-8000-000000000001';
set local request.jwt.claims='{"role":"authenticated","sub":"8e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_finance(public.get_prepayment_management_context('finance-coverage-qa',null,null)->>'error'='sem_permissao','removed director reads financial data');
select pg_temp.assert_finance((select count(*)=0 from public.list_students_overview()),'removed director reads overview');
rollback;
