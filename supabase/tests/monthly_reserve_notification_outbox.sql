-- Isolated SQL only: fictitious identities, no net.http_post/cron invocation.
-- Public registration/settings RPCs construct the source. Direct outbox state
-- fixtures model the irreversible HTTP boundary; no provider is contacted.
begin;
do $isolated_qa_only$ begin
  if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
     or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
     or exists(select 1 from vault.secrets) then
    raise exception 'isolated_empty_finance_qa_required' using errcode='55000';
  end if;
end $isolated_qa_only$;
create or replace function pg_temp.assert_true(value boolean,message text)
returns void language plpgsql as $$begin
  if not coalesce(value,false) then raise exception 'assertion failed: %',message; end if;
end$$;
grant execute on function pg_temp.assert_true(boolean,text) to authenticated,service_role;

select pg_temp.assert_true(
  not has_function_privilege('anon','public.monthly_reserve_notification_pending(integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.authorize_monthly_reserve_notification(uuid,uuid,uuid,bigint,text,text)','EXECUTE')
  and has_function_privilege('service_role','public.finish_monthly_reserve_notification(uuid,uuid,text,text,integer)','EXECUTE')
  and not has_table_privilege('authenticated','public.management_reserve_notification_outbox','INSERT')
  and not has_table_privilege('service_role','public.management_reserve_notification_outbox','UPDATE')
  and not has_function_privilege('service_role','private.monthly_reserve_notification_source_at(uuid,timestamptz)','EXECUTE'),
  'worker mutations must be service-only RPCs; clock override must remain private');

select pg_temp.assert_true(private.monthly_reserve_dispatch_month('2026-10-01 11:59:59+00') is null,
  'maturity must be 09:00 Sao Paulo, not UTC');
select pg_temp.assert_true(private.monthly_reserve_dispatch_month('2026-10-01 12:00:00+00')=date '2026-10-01',
  'first day 09:00 Sao Paulo is due');
select pg_temp.assert_true(private.monthly_reserve_dispatch_month('2026-10-08 02:59:59+00')=date '2026-10-01'
  and private.monthly_reserve_dispatch_month('2026-10-08 03:00:00+00') is null,
  'seven-day bounded catch-up must respect local midnight');

insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled) values
 ('reserve-qa-school','Reserve QA School','reserve-qa-school','active',false),
 ('reserve-qa-other','Reserve QA Other','reserve-qa-other','active',false);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('5f000000-0000-4000-8000-000000000001','authenticated','authenticated','reserve-admin@example.invalid','{"provider":"email"}','{"full_name":"Reserve Admin"}',now(),now()),
 ('5f000000-0000-4000-8000-000000000002','authenticated','authenticated','reserve-other@example.invalid','{"provider":"email"}','{"full_name":"Reserve Other"}',now(),now()),
 ('5f000000-0000-4000-8000-000000000003','authenticated','authenticated','reserve-student@example.invalid','{"provider":"email"}','{"full_name":"Reserve Student"}',now(),now());
set local app.enrollment_claim='1';
update public.profiles set tenant_id=case when id='5f000000-0000-4000-8000-000000000002'::uuid then 'reserve-qa-other' else 'reserve-qa-school' end,
  role=case when id='5f000000-0000-4000-8000-000000000003'::uuid then 'STUDENT' else 'SCHOOL_ADMIN' end,
  status='Ativo',lifecycle_status='active',is_test_account=false,test_fixture_key=null
  where id in ('5f000000-0000-4000-8000-000000000001','5f000000-0000-4000-8000-000000000002','5f000000-0000-4000-8000-000000000003');
set local app.enrollment_claim='';
delete from public.tenant_memberships where user_id in
 ('5f000000-0000-4000-8000-000000000001','5f000000-0000-4000-8000-000000000002','5f000000-0000-4000-8000-000000000003');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) values
 ('5f000000-0000-4000-8000-000000000001','reserve-qa-school','SCHOOL_ADMIN','ACTIVE',true),
 ('5f000000-0000-4000-8000-000000000002','reserve-qa-other','SCHOOL_ADMIN','ACTIVE',true),
 ('5f000000-0000-4000-8000-000000000003','reserve-qa-school','STUDENT','ACTIVE',true);
insert into public.dre_report_settings(tenant_id,destino,cadencia,dia_semana,is_active)
  values('reserve-qa-school','120363000000000999@g.us','diaria',1,true);
insert into public.payment_split_settings(tenant_id,dizimo_pct,investimento_pct,escola_pct,prof_dizimo_pct,prof_investimento_pct,prof_prolabore_pct,is_active)
  values('reserve-qa-school',10,10,0,10,70,20,true);
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,value,status,due_date,payment_date,paid_at,payment_type,billing_type,description)
  values('5f000000-0000-4000-8000-000000000010','reserve-qa-school','5f000000-0000-4000-8000-000000000003',
  'pay_reserve_qa',600,'RECEIVED',date_trunc('month',now())::date,current_date,now(),'SUBSCRIPTION','PIX','Mensalidade ficticia QA');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"5f000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select pg_temp.assert_true((public.register_prepayment('5f000000-0000-4000-8000-000000000010',
  date_trunc('month',now() at time zone 'America/Sao_Paulo')::date,3,'MENSAL')->>'ok')::boolean,
  'public prepayment registration must succeed');
select pg_temp.assert_true((public.configure_monthly_reserve_notifications('reserve-qa-school',true,
  (date_trunc('month',now() at time zone 'America/Sao_Paulo')+interval '1 month')::date)->>'ok')::boolean,
  'active director can opt in next month');
select pg_temp.assert_true(public.configure_monthly_reserve_notifications('reserve-qa-other',true,null)->>'error'='sem_permissao',
  'director cannot opt in another tenant');
select pg_temp.assert_true(public.configure_monthly_reserve_notifications('reserve-qa-school',true,date '2000-01-01')->>'error'='inicio_deve_ser_competencia_futura',
  'historical opt-in must be rejected');
select pg_temp.assert_true((select count(*)=1 from public.monthly_reserve_notification_settings),
  'settings read should see own school only');
reset role;
select set_config('request.jwt.claims','{}',true);
update public.tenants set whatsapp_enabled=true where id='reserve-qa-school';

-- Exercise the actual service-only data worker contract before the notification
-- source becomes eligible. Runtime executes these as three separate RPCs.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$declare v_item jsonb; v_result jsonb;
begin
  for v_item in select * from jsonb_array_elements(public.claim_prepayment_financial_recomputations(25)) loop
    v_result:=public.recompute_student_financial_status(v_item->>'tenant_id',(v_item->>'student_id')::uuid);
    perform pg_temp.assert_true((v_result->>'ok')::boolean,'financial lifecycle recompute must confirm success');
    v_result:=public.complete_prepayment_financial_recompute(v_item->>'tenant_id',(v_item->>'student_id')::uuid,
      (v_item->>'claim_token')::uuid,(v_item->>'version')::bigint,null);
    perform pg_temp.assert_true((v_result->>'ok')::boolean,'recompute acknowledgement must preserve version');
  end loop;
end$$;
select set_config('request.jwt.claims','{}',true);

do $$declare v_month date := (date_trunc('month',now() at time zone 'America/Sao_Paulo')+interval '1 month')::date;
  v_now timestamptz; v_id uuid; v_count integer; v_snapshot jsonb;
begin
  v_now := (v_month::timestamp+interval '9 hours') at time zone 'America/Sao_Paulo';
  perform private.materialize_monthly_reserve_notifications(v_now-interval '1 second');
  perform pg_temp.assert_true(not exists(select 1 from public.management_reserve_notification_outbox where tenant_id='reserve-qa-school'),'nothing is produced before maturity');
  perform private.materialize_monthly_reserve_notifications(v_now);
  perform private.materialize_monthly_reserve_notifications(v_now);
  select count(*) into v_count from public.management_reserve_notification_outbox where tenant_id='reserve-qa-school';
  perform pg_temp.assert_true(v_count=2,'exactly one second installment and one prior-month close; sweep is idempotent');
  select id into v_id from public.management_reserve_notification_outbox where tenant_id='reserve-qa-school' and notification_kind='INSTALLMENT_SPLIT';
  v_snapshot:=private.monthly_reserve_notification_source_at(v_id,v_now);
  perform pg_temp.assert_true((v_snapshot->>'sequencia')::int=2 and (v_snapshot->>'parcela')::numeric=200,
    'source snapshot must release only installment 2, never the full receipt again');
  perform pg_temp.assert_true(private.monthly_reserve_notification_source_at(v_id,v_now-interval '1 day') is null,
    'source itself must enforce dispatch window');
  -- Real wall clock is before this future dispatch. An unavailable source
  -- backs off; it must not monopolize the first batch on every cron run.
  perform pg_temp.assert_true(public.claim_monthly_reserve_notification(v_id)->>'ok'='false',
    'future fixture cannot be authorized using caller-selected time');
  perform pg_temp.assert_true((select status='PENDING' and next_attempt_at>now()
    from public.management_reserve_notification_outbox where id=v_id),
    'pre-submission unavailability must back off without becoming ambiguous');
  perform pg_temp.assert_true(not exists(select 1 from public.management_reserve_notification_outbox where tenant_id='reserve-qa-other'),
    'disabled tenant has no generated work');
  -- Transport state fixture after a successful provider authorization. Financial
  -- source is real public-RPC output; only the external boundary is simulated.
  update public.management_reserve_notification_outbox set status='SUBMITTING',claim_token='5f000000-0000-4000-8000-000000000099',
    source_snapshot=v_snapshot,message_body='Fictitious reserve fixture',submit_attempt_count=1,
    provider_instance_name='reserve-qa-instance',lease_expires_at=now()+interval '30 minutes',submitted_at=now()
    where id=v_id;
end$$;

-- HTTP acceptance is not a delivery proof. Wrong token and wrong tenant receipt
-- cannot promote the reserve. Actual receipt-table trigger supplies the proof.
do $$declare v_id uuid; v_result jsonb; v_before jsonb;
begin
  select id,source_snapshot into v_id,v_before from public.management_reserve_notification_outbox
    where tenant_id='reserve-qa-school' and notification_kind='INSTALLMENT_SPLIT';
  v_result:=public.finish_monthly_reserve_notification(v_id,gen_random_uuid(),'accepted','qa-provider-id',200);
  perform pg_temp.assert_true(v_result->>'ok'='false','wrong claim token must fail');
  v_result:=public.finish_monthly_reserve_notification(v_id,'5f000000-0000-4000-8000-000000000099','accepted','qa-provider-id',200);
  perform pg_temp.assert_true(v_result->>'status'='SUBMITTING','HTTP accepted must remain unconfirmed');
  insert into private.whatsapp_provider_delivery_receipts(tenant_id,provider_instance_name,provider_message_id,delivery_status,delivered_at)
    values('reserve-qa-other','reserve-qa-instance','qa-provider-id','delivered',now());
  perform pg_temp.assert_true((select status='SUBMITTING' from public.management_reserve_notification_outbox where id=v_id),
    'same provider id from another tenant must not promote delivery');
  insert into private.whatsapp_provider_delivery_receipts(tenant_id,provider_instance_name,provider_message_id,delivery_status,delivered_at)
    values('reserve-qa-school','reserve-qa-instance','qa-provider-id','delivered',now());
  perform pg_temp.assert_true((select status='SENT' and delivered_at is not null from public.management_reserve_notification_outbox where id=v_id),
    'authenticated ledger receipt bridge must confirm delivery');
  update private.whatsapp_provider_delivery_receipts set delivery_status='failed'
    where tenant_id='reserve-qa-school' and provider_message_id='qa-provider-id';
  perform pg_temp.assert_true((select status='SENT' and provider_delivery_status='delivered' and source_snapshot=v_before
    from public.management_reserve_notification_outbox where id=v_id),'late failure must not erase delivered truth or snapshot');
  perform pg_temp.assert_true(public.claim_monthly_reserve_notification(v_id)->>'ok'='false','delivered must never be re-claimed');
end$$;

-- Existing webhook/outbox path may deliver receipt before HTTP result persists.
do $$declare v_id uuid; v_result jsonb;
begin
  select id into v_id from public.management_reserve_notification_outbox where tenant_id='reserve-qa-school' and notification_kind='CAIXINHA_CLOSE';
  update public.management_reserve_notification_outbox set status='SUBMITTING',claim_token='5f000000-0000-4000-8000-000000000098',
    source_snapshot='{"fixture":"close"}',submit_attempt_count=1,provider_instance_name='reserve-qa-instance',
    lease_expires_at=now()+interval '30 minutes',submitted_at=now() where id=v_id;
  insert into private.whatsapp_provider_delivery_receipts(tenant_id,provider_instance_name,provider_message_id,delivery_status,read_at,delivered_at)
    values('reserve-qa-school','reserve-qa-instance','qa-early-receipt','read',now(),now());
  v_result:=public.finish_monthly_reserve_notification(v_id,'5f000000-0000-4000-8000-000000000098','accepted','qa-early-receipt',200);
  perform pg_temp.assert_true(v_result->>'status'='SENT' and v_result->>'delivery_status'='read',
    'receipt-before-HTTP-response must be reconciled without another send');
end$$;

-- Financial facts remain writable after delivery and do not rewrite history.
update public.student_payments set status='REFUNDED',refunded_amount=600 where id='5f000000-0000-4000-8000-000000000010';
select pg_temp.assert_true((select bool_and(status='REVIEW') from public.student_payment_allocations where payment_id='5f000000-0000-4000-8000-000000000010'),
  'refund must still transition source to REVIEW');
select pg_temp.assert_true((select status='SENT' and reconciliation_required and source_snapshot is not null
  from public.management_reserve_notification_outbox where tenant_id='reserve-qa-school' and notification_kind='INSTALLMENT_SPLIT'),
  'refund preserves delivered reserve, flags adjustment, never suppresses historical proof');
select pg_temp.assert_true(exists(select 1 from private.monthly_reserve_notification_events where tenant_id='reserve-qa-school'
  and event_type='ALLOCATION_STATE_CHANGED'),'financial review must have append-only evidence');

-- An ambiguous or abandoned submission cannot be retried, including on a later
-- cron run. Only a newly correlated receipt may resolve its delivery status.
insert into public.management_reserve_notification_outbox(id,tenant_id,notification_kind,period_start,subject_key,status,
  claim_token,submit_attempt_count,lease_expires_at,provider_instance_name,source_snapshot)
  values('5f000000-0000-4000-8000-000000000090','reserve-qa-school','CAIXINHA_CLOSE',date '2001-01-01','2001-01-01',
  'SUBMITTING','5f000000-0000-4000-8000-000000000097',1,now()-interval '1 minute','reserve-qa-instance','{}');
select private.materialize_monthly_reserve_notifications(now());
select pg_temp.assert_true((select status='UNKNOWN' from public.management_reserve_notification_outbox where id='5f000000-0000-4000-8000-000000000090'),
  'watchdog must conservatively mark lost submission UNKNOWN');
select pg_temp.assert_true(public.claim_monthly_reserve_notification('5f000000-0000-4000-8000-000000000090')->>'ok'='false',
  'UNKNOWN must never become a new provider attempt');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"5f000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select pg_temp.assert_true((select count(*)=0 from public.management_reserve_notification_outbox),'other school must not read snapshots');
select set_config('request.jwt.claims','{"sub":"5f000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select pg_temp.assert_true((select count(*)=0 from public.monthly_reserve_notification_settings)
  and public.configure_monthly_reserve_notifications('reserve-qa-school',false,null)->>'error'='sem_permissao',
  'student must neither read financial configuration nor activate sender');
reset role;
select set_config('request.jwt.claims','{}',true);
rollback;
