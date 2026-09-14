-- Empty network-isolated finance QA only. No real identities or provider calls.
begin;
do $$ begin
 if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
   or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
   or exists(select 1 from vault.secrets) then raise exception 'isolated_empty_finance_qa_required'; end if;
end $$;
create function pg_temp.assert_adj(ok boolean,message text) returns void language plpgsql as $$
 begin if not coalesce(ok,false) then raise exception 'adjudication QA: %',message; end if; end $$;
insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled)
 values('school-wise-wolf','Synthetic Adjudication QA','school-wise-wolf','active',false) on conflict(id) do nothing;
update public.tenants set saas_status='active',whatsapp_enabled=false where id='school-wise-wolf';
insert into private.tenant_integration_connections(id,tenant_id,provider,mode,status,version,connection_config)
 values('97000000-0000-4000-8000-000000000090','school-wise-wolf','asaas','PLATFORM_MANAGED_ROOT','healthy',1,'{}')
 on conflict(tenant_id,provider) do nothing;
update private.tenant_integration_connections set mode='PLATFORM_MANAGED_ROOT',status='healthy' where tenant_id='school-wise-wolf' and provider='asaas';
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('97000000-0000-4000-8000-00000000000'||k)::uuid,'authenticated','authenticated',
 'adjudication-qa-'||k||'@example.invalid','{"provider":"email","providers":["email"]}',
 jsonb_build_object('full_name','Synthetic adjudication student '||k),now(),now() from generate_series(1,3) k;
set local app.enrollment_claim='1';
update public.profiles set tenant_id='school-wise-wolf',role='STUDENT',lifecycle_status='active',status='Ativo',monthly_fee=100,
 asaas_customer_id=case when id='97000000-0000-4000-8000-000000000003' then 'cus_adjcanonical' else 'cus_adjstudent'||right(id::text,1) end,
 is_test_account=true,test_fixture_key='adjudication-qa-'||id::text
where id::text like '97000000-0000-4000-8000-%';
set local app.enrollment_claim='';
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
select id,tenant_id,'STUDENT','ACTIVE',true from public.profiles where id::text like '97000000-0000-4000-8000-%'
on conflict(user_id,tenant_id) do update set role='STUDENT',status='ACTIVE';
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,provider_customer_id,value,status,provider_status,
 due_date,payment_date,paid_at,payment_type,description,authoritative_subscription_id)
values('97000000-0000-4000-8000-000000000010','school-wise-wolf','97000000-0000-4000-8000-000000000003',
 'pay_adjcanonical','cus_adjcanonical',100,'RECEIVED_IN_CASH','RECEIVED_IN_CASH','2026-09-01','2026-09-01','2026-09-01 12:00Z',
 'SUBSCRIPTION','Synthetic canonical cash receipt','sub_adjcanonical');

create function pg_temp.manifest() returns jsonb language sql as $$
 select jsonb_build_object('version',1,'tenant_id','school-wise-wolf','batch_id','97000000-0000-4000-8000-000000000099',
 'operator','synthetic-qa-operator','approval_ref',repeat('a',64),'cases',jsonb_agg(
 jsonb_build_object('case_key','C0'||k,'disposition',case when k<=2 then 'IMPORT_STUDENT' when k=7 then 'DUPLICATE_OF' else 'IMPORT_UNASSIGNED' end,
 'student_id',case when k<=2 then '97000000-0000-4000-8000-00000000000'||k end,
 'reason','Explicit synthetic adjudication approval for isolated QA',
 'expected_payment',jsonb_build_object('id','pay_adjimport'||k,'customer',case when k<=2 then 'cus_adjstudent'||k
   when k=7 then 'cus_adjcanonical' else 'cus_adjunassigned'||k end,'value',case when k=2 then 1300 else 100 end,
   'dueDate','2026-09-01','paymentDate','2026-09-01','creditDate','2026-09-01'),
 'prepayment',case when k=2 then '{"mode":"MENSAL","months":6,"first_month":"2026-09-01"}'::jsonb end,
 'expected_canonical',case when k=7 then '{"id":"pay_adjcanonical","customer":"cus_adjcanonical","value":100,
   "dueDate":"2026-09-01","paymentDate":"2026-09-01","creditDate":null,"subscription":"sub_adjcanonical"}'::jsonb end
 ) order by k)) from generate_series(1,7) k;
$$;
create function pg_temp.proofs() returns jsonb language sql as $$
 select jsonb_agg(jsonb_build_object('case_key',c->>'case_key','observed_at',clock_timestamp(),
 'payment',(c->'expected_payment')||'{"status":"RECEIVED","deleted":false,"refundedValue":0,"creditCardToken":"SECRET_QA_MUST_NOT_COPY"}'::jsonb,
 'canonical_payment',case when c->>'disposition'='DUPLICATE_OF' then (c->'expected_canonical')||'{"status":"RECEIVED_IN_CASH","deleted":false,"refundedValue":0}'::jsonb end))
 from jsonb_array_elements(pg_temp.manifest()->'cases') c;
$$;
create function pg_temp.apply_adj(p_commit boolean default false,p_manifest jsonb default pg_temp.manifest(),p_proofs jsonb default pg_temp.proofs())
returns jsonb language sql as $$
 select private.apply_asaas_payment_adjudication_batch(p_manifest,p_proofs,c.id,c.version,p_commit)
 from private.tenant_integration_connections c where tenant_id='school-wise-wolf' and provider='asaas';
$$;
select pg_temp.assert_adj(not has_function_privilege('service_role','private.apply_asaas_payment_adjudication_batch(jsonb,jsonb,uuid,bigint,boolean)','EXECUTE')
 and not has_function_privilege('authenticated','private.apply_asaas_payment_adjudication_batch(jsonb,jsonb,uuid,bigint,boolean)','EXECUTE')
 and not has_table_privilege('service_role','private.asaas_payment_adjudications','INSERT')
 and not has_function_privilege('authenticated','public.get_asaas_payment_adjudications()','EXECUTE'),'write command exposed to API');
select pg_temp.assert_adj((pg_temp.apply_adj()->>'ok')::boolean and (select count(*)=1 from public.student_payments)
 and not exists(select 1 from private.asaas_payment_adjudications),'dry-run wrote cash/audit/payment');

-- The LAST case fails after six inserts. The function must throw, atomically
-- rolling back all six imports, allocations, ledger entries and outbox rows.
select pg_temp.assert_adj(private.asaas_adjudication_payment_matches(
 (pg_temp.proofs()->0->'payment')-'value',pg_temp.manifest()->'cases'->0->'expected_payment','RECEIVED') is false,
 'missing provider value must return false, never NULL');
select pg_temp.assert_adj(private.asaas_adjudication_payment_matches(
 pg_temp.proofs()->0->'payment',(pg_temp.manifest()->'cases'->0->'expected_payment')-'value','RECEIVED') is false,
 'missing expected value must return false, never NULL');
do $$ begin
 begin
   perform pg_temp.apply_adj(true,pg_temp.manifest(),jsonb_set(pg_temp.proofs(),'{6,payment,value}','101'));
   raise exception 'expected_last_case_failure_missing';
 exception when others then
   if sqlerrm<>'adjudication_payment_unproven_or_stale' then raise; end if;
 end;
end $$;
select pg_temp.assert_adj((select count(*)=1 from public.student_payments) and (select count(*)=1 from public.financial_transactions)
 and not exists(select 1 from public.student_payment_allocations) and not exists(select 1 from private.asaas_payment_adjudications),
 'late failure leaked partial cash/coverage/audit');

-- Any existing row using either provider alias is a hard conflict; do not
-- adopt/overwrite it even when the expected owner/value happen to match.
savepoint alias_conflict;
insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,asaas_id,value,status,due_date)
values('97000000-0000-4000-8000-000000000012','school-wise-wolf',null,'pay_adjimport1','pay_adjimport1',100,'PENDING','2026-09-01');
do $$ begin
 begin perform pg_temp.apply_adj(true); raise exception 'missing_conflict';
 exception when others then if sqlerrm<>'adjudication_payment_already_exists' then raise; end if; end;
end $$;
rollback to savepoint alias_conflict;

savepoint observed_reversal;
insert into public.asaas_webhook_inbox(provider_event_id,event_name,provider_entity_id,event_created_at,payload,payload_hash)
values('evt_adjrefund','PAYMENT_REFUND_IN_PROGRESS','pay_adjimport1',now(),'{"payment":{"status":"REFUND_IN_PROGRESS"}}','synthetic-refund');
do $$ begin
 begin perform pg_temp.apply_adj(true); raise exception 'missing_reversal';
 exception when others then if sqlerrm<>'adjudication_payment_unproven_or_stale' then raise; end if; end;
end $$;
rollback to savepoint observed_reversal;

savepoint final_freshness;
create function pg_temp.delay_last_decision() returns trigger language plpgsql as $$
 begin if new.case_key='C07' then perform pg_sleep(3); end if; return new; end $$;
create trigger qa_delay_last_decision before insert on private.asaas_payment_adjudications
 for each row execute function pg_temp.delay_last_decision();
do $$ declare v_proofs jsonb; begin
 select jsonb_agg(p||jsonb_build_object('observed_at',clock_timestamp()-interval '43 seconds')) into v_proofs
 from jsonb_array_elements(pg_temp.proofs()) p;
 begin perform pg_temp.apply_adj(true,pg_temp.manifest(),v_proofs); raise exception 'missing_final_freshness';
 exception when others then if sqlerrm<>'adjudication_batch_proof_expired' then raise; end if; end;
 perform pg_temp.assert_adj((select count(*)=1 from public.student_payments)
   and not exists(select 1 from private.asaas_payment_adjudications),'final freshness leaked partial batch');
end $$;
rollback to savepoint final_freshness;

-- Successful batch: six actual imports, one durable duplicate decision, no
-- duplicate receipt for the same money and no forged director identity.
select pg_temp.assert_adj((pg_temp.apply_adj(true)->>'ok')::boolean,'batch failed');
select pg_temp.assert_adj((select count(*)=7 from public.student_payments) and (select count(*)=7 from public.financial_transactions)
 and (select count(*)=7 from private.asaas_payment_adjudications)
 and not exists(select 1 from public.student_payments where asaas_payment_id='pay_adjimport7'), 'duplicate created cash or import absent');
select pg_temp.assert_adj((select count(*)=4 and bool_and(f.amount=p.value and f.category='RECEBIMENTO_NAO_CLASSIFICADO' and f.type='ENTRADA')
 from public.student_payments p join public.financial_transactions f on f.student_payment_id=p.id
 where p.payment_type='UNASSIGNED_RECEIPT' and p.student_id is null), 'unassigned classified as tuition/contribution or amount changed');
select pg_temp.assert_adj((select count(*)=6 and sum(a.valor)=1300 and bool_and(a.modo='MENSAL' and a.created_by is null)
 from public.student_payment_allocations a join public.student_payments p on p.id=a.payment_id where p.asaas_payment_id='pay_adjimport2'),
 'six monthly cents or truthful operator identity missing');
select pg_temp.assert_adj((select private.payment_split_breakdown_unchecked(p.id)->>'modo'='MENSAL'
 and (private.payment_split_breakdown_unchecked(p.id)->>'parcela')::numeric=216.67
 and (private.payment_split_breakdown_unchecked(p.id)->>'reservado')::numeric=1083.33
 and (select count(*)=1 from public.management_payment_notification_outbox o where o.payment_id=p.id)
 from public.student_payments p where p.asaas_payment_id='pay_adjimport2'), 'first notice can see a full unallocated package');
select pg_temp.assert_adj(not exists(select 1 from private.asaas_payment_adjudications
 where expected_payment::text like '%SECRET_QA%' or expected_canonical::text like '%SECRET_QA%')
 and (select bool_and(operator_label='synthetic-qa-operator') from private.asaas_payment_adjudications), 'audit leaked PII or invented actor');
select pg_temp.assert_adj((pg_temp.apply_adj(true)->>'ok')::boolean and (select count(*)=7 from public.financial_transactions)
 and (select count(*)=6 from public.student_payment_allocations) and (select count(*)=7 from private.asaas_payment_adjudications), 'retry duplicated work');
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_adj((select count(*)=7 and bool_and((a->>'valid')::boolean) from jsonb_array_elements(public.get_asaas_payment_adjudications()) a),
 'service reader cannot validate committed cases');
set local request.jwt.claims='';

-- A retry must not claim success once cash dates, aliases, or coverage drift.
savepoint replay_cash_date;
-- The legacy BEFORE trigger derives paid_at from credited_at when available.
update public.student_payments set paid_at='2026-08-31 12:00Z',credited_at='2026-08-31 12:00Z'
 where asaas_payment_id='pay_adjimport1';
do $$ begin
 begin perform pg_temp.apply_adj(true); raise exception 'missing_cash_drift';
 exception when others then if sqlerrm<>'adjudication_imported_payment_changed' then raise; end if; end;
end $$;
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_adj((select not (a->>'valid')::boolean from jsonb_array_elements(public.get_asaas_payment_adjudications()) a
 where a->>'provider_payment_id'='pay_adjimport1'),'changed paid_at still valid');
rollback to savepoint replay_cash_date;
savepoint replay_alias;
update public.student_payments set asaas_payment_id='pay_adjdetached',asaas_id=null,
 raw_payload=jsonb_set(raw_payload,'{payment,id}','"pay_adjdetached"') where asaas_payment_id='pay_adjimport1';
do $$ begin
 begin perform pg_temp.apply_adj(true); raise exception 'missing_alias_drift';
 exception when others then if sqlerrm<>'adjudication_imported_payment_changed' then raise; end if; end;
end $$;
rollback to savepoint replay_alias;
savepoint canonical_cash_date;
update public.student_payments set paid_at='2026-08-31 12:00Z' where asaas_payment_id='pay_adjcanonical';
do $$ begin
 begin perform pg_temp.apply_adj(true); raise exception 'missing_canonical_cash_drift';
 exception when others then if sqlerrm<>'adjudication_duplicate_canonical_changed' then raise; end if; end;
end $$;
rollback to savepoint canonical_cash_date;

-- Normal importers may not create a new receipt for an acknowledged duplicate.
do $$ begin
 begin
   insert into public.student_payments(tenant_id,asaas_payment_id,value,status,due_date)
   values('school-wise-wolf','pay_adjimport7',100,'RECEIVED','2026-09-01');
   raise exception 'duplicate_guard_missing';
 exception when others then if sqlerrm<>'adjudicated_duplicate_cannot_create_receipt' then raise; end if; end;
end $$;

-- A webhook replacing raw_payload retains only durable origin, and a real
-- refund preserves the gross neutral receipt plus one neutral contra-entry.
savepoint neutral_refund;
update public.student_payments set status='REFUNDED',provider_status='REFUNDED',refunded_amount=100,
 last_provider_event_id='evt_adjneutralrefund',last_provider_event_at='2026-09-02 12:00Z',last_provider_event_rank=100,
 raw_payload='{"event":"PAYMENT_REFUNDED","payment":{"id":"pay_adjimport3","status":"REFUNDED","value":100,"refundedValue":100}}'
 where asaas_payment_id='pay_adjimport3';
select pg_temp.assert_adj((select raw_payload->>'source'='OPERATOR_ADJUDICATION' and raw_payload#>>'{payment,status}'='REFUNDED'
 from public.student_payments where asaas_payment_id='pay_adjimport3') and
 (select count(*)=1 and min(category)='ESTORNO_RECEBIMENTO_NAO_CLASSIFICADO' and min(amount)=100 and min(type)='SAIDA'
 from public.financial_transactions where provider_event_id='evt_adjneutralrefund') and
 (select count(*)=1 and min(f.category)='RECEBIMENTO_NAO_CLASSIFICADO' and min(f.amount)=100
 from public.financial_transactions f join public.student_payments p on p.id=f.student_payment_id where p.asaas_payment_id='pay_adjimport3'),
 'neutral refund lost gross cash, double-counted or became tuition/contribution');
rollback to savepoint neutral_refund;
do $$ begin
 begin update private.asaas_payment_adjudications set reason='Attempted history rewrite'; raise exception 'immutable_missing';
 exception when others then if sqlerrm='immutable_missing' then raise; end if; end;
end $$;
update public.student_payments set provider_status='CHARGEBACK_REQUESTED' where asaas_payment_id='pay_adjcanonical';
set local request.jwt.claims='{"role":"service_role"}';
select pg_temp.assert_adj((select not (a->>'valid')::boolean from jsonb_array_elements(public.get_asaas_payment_adjudications()) a
 where a->>'disposition'='DUPLICATE_OF'),'canonical dispute still suppressed');
rollback;
