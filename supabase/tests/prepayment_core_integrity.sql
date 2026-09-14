-- Run only in the isolated schema-only finance QA database. No provider calls,
-- no cron, no real identity, no permanent data: every fixture rolls back.
begin;

do $isolated_qa_only$ begin
  if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
     or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
     or exists(select 1 from vault.secrets) then
    raise exception 'isolated_empty_finance_qa_required' using errcode='55000';
  end if;
end $isolated_qa_only$;

create function pg_temp.assert_prepayment(ok boolean,message text)
returns void language plpgsql as $$
begin
  if not coalesce(ok,false) then raise exception 'prepayment assertion: %',message; end if;
end;
$$;
grant execute on function pg_temp.assert_prepayment(boolean,text) to authenticated;

insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values
 ('prepayment-core-qa','Prepayment Core QA','prepayment-core-qa','active',false),
 ('prepayment-core-other','Prepayment Other QA','prepayment-core-other','active',false);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated',email,'{"provider":"email","providers":["email"]}'::jsonb,
 jsonb_build_object('full_name',name),now(),now()
from (values
 ('7e140000-0000-4000-8000-000000000001'::uuid,'prepayment-admin@example.invalid','Prepayment Admin'),
 ('7e140000-0000-4000-8000-000000000002'::uuid,'prepayment-other@example.invalid','Other Admin'),
 ('7e140000-0000-4000-8000-000000000003'::uuid,'prepayment-coordinator@example.invalid','Coordinator'),
 ('7e140000-0000-4000-8000-000000000004'::uuid,'prepayment-teacher@example.invalid','Prepayment Teacher'),
 ('7e140000-0000-4000-8000-000000000011'::uuid,'prepayment-legacy@example.invalid','Legacy Student'),
 ('7e140000-0000-4000-8000-000000000012'::uuid,'prepayment-refund@example.invalid','Refund Student'),
 ('7e140000-0000-4000-8000-000000000013'::uuid,'prepayment-dispute@example.invalid','Dispute Student')
) f(id,email,name);

set local app.enrollment_claim = '1';
update public.profiles set
 tenant_id = case when id = '7e140000-0000-4000-8000-000000000002' then 'prepayment-core-other' else 'prepayment-core-qa' end,
 role = case when id in ('7e140000-0000-4000-8000-000000000001','7e140000-0000-4000-8000-000000000002') then 'SCHOOL_ADMIN'
             when id = '7e140000-0000-4000-8000-000000000003' then 'COORDINATOR'
             when id = '7e140000-0000-4000-8000-000000000004' then 'TEACHER' else 'STUDENT' end,
 status = 'Ativo',lifecycle_status = 'active',is_test_account = true,
 test_fixture_key = 'prepayment-core-qa-' || id::text,monthly_fee = 0,prepaid_months = 3,paid_through = date '2026-10-31'
where id::text like '7e140000-0000-4000-8000-%';
set local app.enrollment_claim = '';
delete from public.tenant_memberships where user_id::text like '7e140000-0000-4000-8000-%';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where id::text like '7e140000-0000-4000-8000-%';

insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,provider_status,due_date,payment_date,paid_at,payment_type,description)
values
 ('7e140000-0000-4000-8000-0000000000a1','prepayment-core-qa','7e140000-0000-4000-8000-000000000011','pay_prepayment_qa_1',1300,'RECEIVED','RECEIVED','2026-09-01','2026-09-01','2026-09-01 12:00:00+00','SUBSCRIPTION','Package QA'),
 ('7e140000-0000-4000-8000-0000000000a2','prepayment-core-qa','7e140000-0000-4000-8000-000000000012','pay_prepayment_qa_2',600,'RECEIVED','RECEIVED','2026-01-01','2026-01-01','2026-01-01 12:00:00+00','SUBSCRIPTION','Package QA'),
 ('7e140000-0000-4000-8000-0000000000a3','prepayment-core-qa','7e140000-0000-4000-8000-000000000013','pay_prepayment_qa_3',400,'RECEIVED','RECEIVED','2026-01-01','2026-01-01','2026-01-01 12:00:00+00','SUBSCRIPTION','Package QA'),
 ('7e140000-0000-4000-8000-0000000000a4','prepayment-core-qa','7e140000-0000-4000-8000-000000000013','pay_prepayment_qa_4',400,'RECEIVED','RECEIVED','2026-03-01','2026-03-01','2026-03-01 12:00:00+00','SUBSCRIPTION','Package QA'),
 ('7e140000-0000-4000-8000-0000000000a5','prepayment-core-qa','7e140000-0000-4000-8000-000000000012','pay_prepayment_qa_5',500,'RECEIVED','RECEIVED','2026-07-01','2026-07-01','2026-07-01 12:00:00+00','SUBSCRIPTION','Package QA');

-- An old non-reversal observation does not override a now corroborated
-- RECEIVED source. Genuine refund/chargeback observations stay conservative.
insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash,received_at)
 values('evt_prepayment_qa_old_overdue','PAYMENT_OVERDUE','pay_prepayment_qa_1','2000-01-01 00:00:00+00',
 '{"payment":{"id":"pay_prepayment_qa_1","status":"OVERDUE"}}',repeat('a',64),'2000-01-01 00:00:00+00');
select pg_temp.assert_prepayment(private.prepayment_payment_review_reason('7e140000-0000-4000-8000-0000000000a1') is null,
 'old OVERDUE observation incorrectly invalidated RECEIVED source');

create temporary table prepayment_results(k text primary key,value jsonb);
create temporary table prepayment_profile_before as
 select id,paid_through,prepaid_months,monthly_fee,status_financial from public.profiles
 where id::text like '7e140000-0000-4000-8000-%';

-- Register, replay, cancel and change N: exact cents, new identities and the
-- old contract/profile survives each operation.
set local request.jwt.claims = '{"role":"authenticated","sub":"7e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_prepayment(public.register_prepayment('7e140000-0000-4000-8000-0000000000a1','2026-11-01',6,'MENSAL')->>'error'='mensal_deve_iniciar_no_mes_do_recebimento',
 'unsupported first monthly installment released future money');
insert into prepayment_results values('first',public.register_prepayment('7e140000-0000-4000-8000-0000000000a1','2026-09-01',6,'MENSAL'));
select pg_temp.assert_prepayment((select (value->>'ok')::boolean from prepayment_results where k='first'),'register');
create temporary table prepayment_first_allocations as select * from public.student_payment_allocations
 where payment_id='7e140000-0000-4000-8000-0000000000a1';
select pg_temp.assert_prepayment(
 (select count(*)=6 and sum(valor)=1300 and count(distinct registration_id)=1
    and array_agg(valor order by sequencia)=array[216.67,216.67,216.67,216.67,216.66,216.66]::numeric[]
    and bool_and(private.prepayment_allocation_is_valid(id)) from prepayment_first_allocations)
 and not private.student_month_covered('7e140000-0000-4000-8000-000000000011','2026-08-01'),
 'centavos/registration/gap');
insert into prepayment_results values('replay',public.register_prepayment('7e140000-0000-4000-8000-0000000000a1','2026-09-01',6,'MENSAL'));
select pg_temp.assert_prepayment((select (value->>'already_registered')::boolean from prepayment_results where k='replay')
 and (select count(*)=6 from private.prepayment_allocation_events where payment_id='7e140000-0000-4000-8000-0000000000a1'),
 'idempotent replay changed audit');
insert into prepayment_results values('cancel',public.cancel_prepayment_with_reason('7e140000-0000-4000-8000-0000000000a1','Correction requested in isolated QA',
 (select registration_id from prepayment_first_allocations limit 1)));
select pg_temp.assert_prepayment(public.payment_split_breakdown('7e140000-0000-4000-8000-0000000000a1')->>'error'='pagamento_completo_cancelado',
 'cancellation silently reclassified partial monthly reserve as full cash rateio');
insert into prepayment_results values('reregister',public.register_prepayment('7e140000-0000-4000-8000-0000000000a1','2026-09-01',5,'MENSAL'));
select pg_temp.assert_prepayment(
 (select count(*)=6 and bool_and(a.status='CANCELLED' and a.cancelled_at is not null
    and a.created_at=f.created_at and a.valor=f.valor and a.registration_id=f.registration_id)
  from public.student_payment_allocations a join prepayment_first_allocations f using(id))
 and (select count(*)=5 and sum(valor)=1300 and min(valor)=260 from public.student_payment_allocations
      where payment_id='7e140000-0000-4000-8000-0000000000a1' and status='ACTIVE')
 and (select count(*)=17 and bool_and(actor_id='7e140000-0000-4000-8000-000000000001')
      from private.prepayment_allocation_events where payment_id='7e140000-0000-4000-8000-0000000000a1'),
 'cancel/reregister rewrote history');
select pg_temp.assert_prepayment(public.cancel_prepayment_with_reason('7e140000-0000-4000-8000-0000000000a1','Stale browser cancellation attempt',
 (select registration_id from prepayment_first_allocations limit 1))->>'error'='registro_alterado_recarregue','stale registration canceled current one');
select pg_temp.assert_prepayment(not exists(
 select 1 from prepayment_profile_before b join public.profiles p using(id)
 where (p.paid_through,p.prepaid_months,p.monthly_fee,p.status_financial)
       is distinct from (b.paid_through,b.prepaid_months,b.monthly_fee,b.status_financial)),
 'profile/legacy coverage/contract was mutated');

-- Audit and historical allocations are append-only even for the table owner.
do $$ begin
 begin
  update private.prepayment_allocation_events set reason='rewrite';
  raise exception 'audit update allowed';
 exception when sqlstate '55000' then null; end;
 begin
  delete from private.prepayment_allocation_events;
  raise exception 'audit delete allowed';
 exception when sqlstate '55000' then null; end;
 begin
  update public.student_payment_allocations set status='ACTIVE'
  where id=(select id from prepayment_first_allocations limit 1);
  raise exception 'history reactivation allowed';
 exception when sqlstate '55000' then null; end;
end $$;

-- Source payment facts may change after registration. They must succeed,
-- while allocations move to REVIEW, never settle or release nonexistent cash.
insert into prepayment_results values('partial-register',public.register_prepayment('7e140000-0000-4000-8000-0000000000a2','2026-01-01',3,'MENSAL'));
insert into prepayment_results values('dispute-register',public.register_prepayment('7e140000-0000-4000-8000-0000000000a3','2026-01-01',2,'MENSAL'));
insert into prepayment_results values('full-register',public.register_prepayment('7e140000-0000-4000-8000-0000000000a4','2026-03-01',2,'MENSAL'));
set local request.jwt.claims = '';
update public.student_payments set refunded_amount=50,last_provider_event_id='evt_prepayment_qa_partial',last_provider_event_at='2026-04-01 12:00:00+00'
 where id='7e140000-0000-4000-8000-0000000000a2';
update public.student_payments set provider_status='CHARGEBACK_REQUESTED'
 where id='7e140000-0000-4000-8000-0000000000a3';
update public.student_payments set status='REFUNDED',provider_status='REFUNDED',refunded_amount=400,
 last_provider_event_id='evt_prepayment_qa_full',last_provider_event_at='2026-04-01 12:00:00+00'
 where id='7e140000-0000-4000-8000-0000000000a4';
select pg_temp.assert_prepayment(
 (select count(*)=7 and bool_and(status='REVIEW' and not private.prepayment_allocation_is_valid(id))
  from public.student_payment_allocations where payment_id in
  ('7e140000-0000-4000-8000-0000000000a2','7e140000-0000-4000-8000-0000000000a3','7e140000-0000-4000-8000-0000000000a4'))
 and not private.student_month_covered('7e140000-0000-4000-8000-000000000012','2026-02-01')
 and private.student_month_prepayment_review('7e140000-0000-4000-8000-000000000012','2026-02-01')
 and (select count(*)=7 and bool_and(reason is not null and before_state->>'status'='ACTIVE' and after_state->>'status'='REVIEW')
      from private.prepayment_allocation_events where event_type='REVIEW'),
 'refund/dispute did not invalidate coverage with immutable review evidence');
select pg_temp.assert_prepayment(
 public.payment_split_installment((select id from public.student_payment_allocations where payment_id='7e140000-0000-4000-8000-0000000000a2' limit 1))->>'error'='parcela_em_revisao'
 and public.payment_split_breakdown('7e140000-0000-4000-8000-0000000000a2')->>'error'='pagamento_completo_em_revisao',
 'review still releases money');
-- Repeating the provider fact cannot duplicate review events.
update public.student_payments set refunded_amount=50 where id='7e140000-0000-4000-8000-0000000000a2';
select pg_temp.assert_prepayment((select count(*)=7 from private.prepayment_allocation_events where event_type='REVIEW'),'repeated fact duplicated audit');
-- A payment already partially refunded while status is RECEIVED cannot be registered.
update public.student_payments set refunded_amount=10,last_provider_event_id='evt_prepayment_qa_before',last_provider_event_at='2026-08-01 12:00:00+00'
 where id='7e140000-0000-4000-8000-0000000000a5';
select pg_temp.assert_prepayment(public.register_prepayment('7e140000-0000-4000-8000-0000000000a5','2026-07-01',2,'LEGADO')->>'error'='pagamento_requer_revisao',
 'accepted money already refunded');
update public.student_payments set description='Taxa de cancelamento' where id='7e140000-0000-4000-8000-0000000000a5';
select pg_temp.assert_prepayment(public.register_prepayment('7e140000-0000-4000-8000-0000000000a5','2026-07-01',2,'LEGADO')->>'error'='pagamento_nao_e_mensalidade',
 'non-tuition payment became tuition coverage');
select pg_temp.assert_prepayment(public.register_external_prepayment('7e140000-0000-4000-8000-000000000012',400,'2026-01-01','2026-01-01',2,'LEGADO','isolated test')->>'error'='mes_ja_coberto',
 'REVIEW silently permitted replacement entitlement');
select pg_temp.assert_prepayment(public.register_external_prepayment('7e140000-0000-4000-8000-000000000012',0.01,'2026-01-01','2027-01-01',2,'LEGADO','isolated test')->>'error'='valor_invalido',
 'sub-cent allocation accepted');

-- The financial-status queue is transactionally produced, claimed in a short
-- separate transaction, then acknowledged by generation. A new registration
-- while an older generation is being processed cannot be lost by its ACK.
set local request.jwt.claims = '{"role":"service_role"}';
create temporary table prepayment_queue_claims as
 select c->>'tenant_id' as tenant_id,(c->>'student_id')::uuid as student_id,
        (c->>'version')::bigint as version,(c->>'claim_token')::uuid as claim_token
 from jsonb_array_elements(public.claim_prepayment_financial_recomputations(25)) c;
select pg_temp.assert_prepayment((select count(*)=3 from prepayment_queue_claims),'missing queue producer');
insert into prepayment_results values('queue-next-generation',public.register_external_prepayment(
 '7e140000-0000-4000-8000-000000000011',400,'2026-01-01','2030-05-01',2,'LEGADO','Queue generation isolated QA'));
select pg_temp.assert_prepayment((select (public.complete_prepayment_financial_recompute(
 tenant_id,student_id,gen_random_uuid(),version,null)->>'stale_claim')::boolean
 from prepayment_queue_claims where student_id='7e140000-0000-4000-8000-000000000011'),
 'wrong claim token acknowledged work');
insert into prepayment_results select 'queue-ack',public.complete_prepayment_financial_recompute(
 tenant_id,student_id,claim_token,version,null) from prepayment_queue_claims
 where student_id='7e140000-0000-4000-8000-000000000011';
select pg_temp.assert_prepayment((select q.version>q.processed_version and q.processed_version=c.version
 from private.prepayment_financial_recompute_queue q join prepayment_queue_claims c using(tenant_id,student_id)
 where student_id='7e140000-0000-4000-8000-000000000011')
 and jsonb_array_length(public.claim_prepayment_financial_recomputations(25))=1,
 'old ACK lost a new generation or other active claims were stolen');
insert into prepayment_results select 'queue-retry',public.complete_prepayment_financial_recompute(
 tenant_id,student_id,claim_token,version,'RECOMPUTE_TEMPORARY_FAILURE') from prepayment_queue_claims
 where student_id='7e140000-0000-4000-8000-000000000012';
select pg_temp.assert_prepayment((select processed_version=0 and next_attempt_at>now() and claim_token is null
 from private.prepayment_financial_recompute_queue where student_id='7e140000-0000-4000-8000-000000000012'),
 'failed recompute lost retry');
set local request.jwt.claims = '';

-- Cancel before any native/reserve notice, then re-register as LEGADO. Its
-- subsequently delivered FULL source notice must remain visible in caixinha;
-- the unsent historical monthly cycle is not proof that any slice was sent.
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,provider_status,
 due_date,payment_date,paid_at,payment_type,description) values
 ('7e140000-0000-4000-8000-0000000000a6','prepayment-core-qa','7e140000-0000-4000-8000-000000000011',
 'pay_prepayment_qa_6',600,'RECEIVED','RECEIVED','2026-06-01','2026-06-01','2026-06-01 12:00:00+00','SUBSCRIPTION','Package transition QA');
select pg_temp.assert_prepayment((public.register_prepayment(
 '7e140000-0000-4000-8000-0000000000a6','2026-06-01',2,'MENSAL')->>'ok')::boolean,'transition monthly register');
select pg_temp.assert_prepayment((public.cancel_prepayment_with_reason(
 '7e140000-0000-4000-8000-0000000000a6','Unsent monthly cycle corrected in isolated QA')->>'ok')::boolean,'transition cancel');
select pg_temp.assert_prepayment((public.register_prepayment(
 '7e140000-0000-4000-8000-0000000000a6','2026-06-01',2,'LEGADO')->>'ok')::boolean,'transition legacy register');
-- Only this isolated provider-boundary fixture is synthetic; no message is sent.
insert into public.management_payment_notification_outbox(
 tenant_id,payment_id,notification_kind,status,claim_token,lease_expires_at,submit_attempt_count,
 configured_destination_snapshot,provider_destination,provider_instance_name,provider_integration_id,provider_integration_version,
 provider_endpoint_hash,provider_credential_hash,message_body,source_snapshot,source_snapshot_hash,snapshot_hash,
 provider_message_id,provider_delivery_status,delivered_at)
values('prepayment-core-qa','7e140000-0000-4000-8000-0000000000a6','PAYMENT_SPLIT','SENT',gen_random_uuid(),now()+interval '5 minutes',1,
 '120363000000000997@g.us','120363000000000997@g.us','prepayment-qa',gen_random_uuid(),1,
 repeat('a',64),repeat('b',64),'Isolated notice fixture',
 jsonb_build_object('tenant_id','prepayment-core-qa','month','2026-06','modo','LEGADO','recebido_total',600,
   'professores',jsonb_build_array(jsonb_build_object('teacher_id','7e140000-0000-4000-8000-000000000004','aulas',10,'custo',80,'descontado',true))),
 repeat('c',64),repeat('d',64),'qa-prepayment-native-delivery','delivered',now())
on conflict(tenant_id,payment_id) do update set
 notification_kind=excluded.notification_kind,status=excluded.status,claim_token=excluded.claim_token,
 lease_expires_at=excluded.lease_expires_at,submit_attempt_count=excluded.submit_attempt_count,
 configured_destination_snapshot=excluded.configured_destination_snapshot,provider_destination=excluded.provider_destination,
 provider_instance_name=excluded.provider_instance_name,provider_integration_id=excluded.provider_integration_id,
 provider_integration_version=excluded.provider_integration_version,provider_endpoint_hash=excluded.provider_endpoint_hash,
 provider_credential_hash=excluded.provider_credential_hash,message_body=excluded.message_body,
 source_snapshot=excluded.source_snapshot,source_snapshot_hash=excluded.source_snapshot_hash,snapshot_hash=excluded.snapshot_hash,
 provider_message_id=excluded.provider_message_id,provider_delivery_status=excluded.provider_delivery_status,delivered_at=excluded.delivered_at;
select pg_temp.assert_prepayment(
 (public.caixinha_fechamento('2026-06','prepayment-core-qa')#>>'{totais,caixinha}')::numeric=80,
 'delivered full LEGADO notice disappeared behind cancelled, never sent MENSAL history');

-- Real auth roles: active membership required for read AND write. Browser has
-- no direct write privilege, and guessed roles/empty claims cannot bypass it.
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"7e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_prepayment((select count(*)>0 from public.student_payment_allocations)
 and not (public.payment_split_report('2026-09','prepayment-core-qa') ? 'error'),'active admin cannot read');
set local request.jwt.claims = '{"role":"authenticated","sub":"7e140000-0000-4000-8000-000000000002"}';
select pg_temp.assert_prepayment((select count(*)=0 from public.student_payment_allocations)
 and public.payment_split_breakdown('7e140000-0000-4000-8000-0000000000a1')->>'error'='sem_permissao'
 and public.payment_split_report('2026-09','prepayment-core-qa')->>'error'='sem_permissao'
 and public.cancel_prepayment('7e140000-0000-4000-8000-0000000000a1')->>'error'='sem_permissao', 'cross-tenant access');
set local request.jwt.claims = '{"role":"authenticated","sub":"7e140000-0000-4000-8000-000000000003"}';
select pg_temp.assert_prepayment((select count(*)>0 from public.student_payment_allocations)
 and not (public.payment_split_breakdown('7e140000-0000-4000-8000-0000000000a1') ? 'error')
 and public.cancel_prepayment('7e140000-0000-4000-8000-0000000000a1')->>'error'='sem_permissao', 'coordinator read-only contract');
reset role;
set local request.jwt.claims = '';
update public.tenant_memberships set status='REVOKED' where user_id='7e140000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"7e140000-0000-4000-8000-000000000001"}';
select pg_temp.assert_prepayment((select count(*)=0 from public.student_payment_allocations)
 and public.payment_split_breakdown('7e140000-0000-4000-8000-0000000000a1')->>'error'='sem_permissao'
 and public.payment_split_report('2026-09','prepayment-core-qa')->>'error'='sem_permissao'
 and public.register_prepayment('7e140000-0000-4000-8000-0000000000a1','2026-09-01',5,'MENSAL')->>'error'='sem_permissao', 'revoked membership retained finance access');
reset role;
set local request.jwt.claims = '';
select pg_temp.assert_prepayment(
 not has_table_privilege('authenticated','public.student_payment_allocations','INSERT')
 and not has_table_privilege('authenticated','public.student_payment_allocations','UPDATE')
 and not has_table_privilege('authenticated','private.prepayment_allocation_events','SELECT')
 and not has_function_privilege('anon','public.cancel_prepayment_with_reason(uuid,text,uuid)','EXECUTE'), 'least privilege');

-- Inbox evidence is authoritative for blocking coverage even before the
-- financial worker changes the local RECEIVED source row. Its producer must
-- queue recomputation without mutating money, allocations or audit history.
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_prepayment(public.recompute_student_financial_status(
 'prepayment-core-qa','7e140000-0000-4000-8000-000000000011')->>'status'='ACTIVE','valid coverage must initially grant access');
set local request.jwt.claims = '';
create temporary table prepayment_observation_before as select
 (select version from private.prepayment_financial_recompute_queue
  where tenant_id='prepayment-core-qa' and student_id='7e140000-0000-4000-8000-000000000011') as queue_version,
 (select count(*) from private.prepayment_allocation_events) as audit_count;
insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash)
 values('evt_prepayment_qa_observed_refund','PAYMENT_PARTIALLY_REFUNDED','pay_prepayment_qa_1',now(),
 '{"payment":{"id":"pay_prepayment_qa_1","status":"REFUNDED"}}',repeat('e',64));
select pg_temp.assert_prepayment(
 (select q.version=b.queue_version+1 from private.prepayment_financial_recompute_queue q cross join prepayment_observation_before b
  where q.tenant_id='prepayment-core-qa' and q.student_id='7e140000-0000-4000-8000-000000000011')
 and not private.student_month_covered('7e140000-0000-4000-8000-000000000011','2026-09-01')
 and private.student_month_prepayment_review('7e140000-0000-4000-8000-000000000011','2026-09-01')
 and (select status='RECEIVED' and coalesce(refunded_amount,0)=0 from public.student_payments where id='7e140000-0000-4000-8000-0000000000a1')
 and (select bool_and(status='ACTIVE') from public.student_payment_allocations where payment_id='7e140000-0000-4000-8000-0000000000a1' and status<>'CANCELLED')
 and (select count(*)=(select audit_count from prepayment_observation_before) from private.prepayment_allocation_events),
 'provider observation did not queue review or mutated a financial source/history');
update public.asaas_webhook_inbox set delivery_count=delivery_count+1,status='RETRY',payload=payload
 where provider_event_id='evt_prepayment_qa_observed_refund';
insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash)
 values('evt_prepayment_qa_unmatched','PAYMENT_REFUNDED','pay_prepayment_qa_unmatched',now(),
 '{"payment":{"id":"pay_prepayment_qa_unmatched","status":"REFUNDED"}}',repeat('f',64));
select pg_temp.assert_prepayment(
 (select q.version=b.queue_version+1 from private.prepayment_financial_recompute_queue q cross join prepayment_observation_before b
  where q.tenant_id='prepayment-core-qa' and q.student_id='7e140000-0000-4000-8000-000000000011'),
 'delivery-only retry or unrelated provider entity generated financial work');
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_prepayment(public.recompute_student_financial_status(
 'prepayment-core-qa','7e140000-0000-4000-8000-000000000011')->>'status'='PENDING',
 'observed refund left stale ACTIVE access before local payment processing');
set local request.jwt.claims = '';
rollback;
