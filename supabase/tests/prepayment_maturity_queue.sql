-- Isolated schema-only QA only. No provider calls, no real identities. The
-- private synthetic clock tests scheduling, never caller-controlled access.
begin;
create function pg_temp.assert_maturity(ok boolean,message text)
returns void language plpgsql as $$begin
  if not coalesce(ok,false) then raise exception 'maturity assertion: %',message; end if;
end$$;

-- This test invokes the real watchdog only when no HTTP credential can exist.
-- It intentionally does NOT belong in release-time SQL against production.
do $$begin
 if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
    or exists(select 1 from public.profiles)
    or exists(select 1 from auth.users)
    or exists(select 1 from vault.secrets) then
   raise exception 'prepayment_maturity_requires_empty_isolated_qa_with_cron_off' using errcode='55000';
 end if;
end$$;

insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled)
 values('prepayment-maturity-qa','Maturity QA','prepayment-maturity-qa','active',false);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select id,'authenticated','authenticated',email,'{"provider":"email","providers":["email"]}'::jsonb,
   '{"full_name":"Maturity Fixture"}'::jsonb,now(),now()
 from (values
 ('7e140002-0000-4000-8000-000000000011'::uuid,'prepayment-future@example.invalid'),
 ('7e140002-0000-4000-8000-000000000012'::uuid,'prepayment-current@example.invalid')) f(id,email);
set local app.enrollment_claim='1';
update public.profiles set tenant_id='prepayment-maturity-qa',role='STUDENT',status='Ativo',lifecycle_status='active',
 status_financial='PENDING',monthly_fee=0,is_test_account=true,test_fixture_key='prepayment-maturity-'||id::text
 where id in ('7e140002-0000-4000-8000-000000000011','7e140002-0000-4000-8000-000000000012');
set local app.enrollment_claim='';
delete from public.tenant_memberships where user_id in ('7e140002-0000-4000-8000-000000000011','7e140002-0000-4000-8000-000000000012');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,'STUDENT','ACTIVE',true from public.profiles where tenant_id='prepayment-maturity-qa';
create temporary table maturity_clock as select
 date_trunc('month',now() at time zone 'America/Sao_Paulo')::date as current_month,
 (date_trunc('month',now() at time zone 'America/Sao_Paulo')+interval '2 months')::date as future_month;
create temporary table maturity_results(k text primary key,v jsonb);

set local request.jwt.claims='{"role":"service_role"}';
insert into maturity_results select 'future',public.register_external_prepayment(
 '7e140002-0000-4000-8000-000000000011',400,current_date,future_month,2,'LEGADO','Future coverage isolated QA') from maturity_clock;
select pg_temp.assert_maturity((select v->>'ok'='true' from maturity_results where k='future'),'future register');
do $$declare item jsonb; result jsonb; begin
 for item in select * from jsonb_array_elements(public.claim_prepayment_financial_recomputations(25)) loop
   result:=public.recompute_student_financial_status(item->>'tenant_id',(item->>'student_id')::uuid);
   perform pg_temp.assert_maturity(result->>'status'='PENDING','future coverage granted access early');
   perform pg_temp.assert_maturity((public.complete_prepayment_financial_recompute(
     item->>'tenant_id',(item->>'student_id')::uuid,(item->>'claim_token')::uuid,(item->>'version')::bigint,null)->>'ok')::boolean,'initial ACK');
 end loop;
end$$;
set local request.jwt.claims='';
select pg_temp.assert_maturity((select version=processed_version from private.prepayment_financial_recompute_queue
 where student_id='7e140002-0000-4000-8000-000000000011'),'initial future registration must be fully ACKed');
create temporary table maturity_before as select version from private.prepayment_financial_recompute_queue
 where student_id='7e140002-0000-4000-8000-000000000011';

-- 02:59:59 UTC is still the PREVIOUS month in Sao Paulo; 03:00:00 UTC
-- is local midnight. The helper has no execute grant outside its owner.
select pg_temp.assert_maturity(private.enqueue_matured_prepayment_recomputations(
 (future_month::timestamp at time zone 'America/Sao_Paulo')-interval '1 second')=0,'matured before local month boundary') from maturity_clock;
select pg_temp.assert_maturity(private.enqueue_matured_prepayment_recomputations(
 future_month::timestamp at time zone 'America/Sao_Paulo')=1,'did not enqueue at local midnight') from maturity_clock;
select pg_temp.assert_maturity(private.enqueue_matured_prepayment_recomputations(
 (future_month::timestamp at time zone 'America/Sao_Paulo')+interval '1 minute')=0,'minute sweep duplicated generation') from maturity_clock;
select pg_temp.assert_maturity((select q.version=b.version+1 and q.version>q.processed_version
 from private.prepayment_financial_recompute_queue q cross join maturity_before b
 where q.student_id='7e140002-0000-4000-8000-000000000011'),'maturity lost after earlier ACK');
select pg_temp.assert_maturity(private.enqueue_matured_prepayment_recomputations(
 (future_month+interval '1 month')::timestamp at time zone 'America/Sao_Paulo')=1,'second competence did not generate its own event') from maturity_clock;
select pg_temp.assert_maturity((select count(*)=2 from private.prepayment_financial_maturity_markers
 where student_id='7e140002-0000-4000-8000-000000000011'),'wrong maturity marker cardinality');
select pg_temp.assert_maturity((select status_financial='PENDING' from public.profiles where id='7e140002-0000-4000-8000-000000000011'),
 'synthetic test clock changed access or money directly');
do $$begin
 begin perform private.enqueue_matured_prepayment_recomputations(null); raise exception 'null clock accepted'; exception when sqlstate '22023' then null; end;
 begin perform private.enqueue_matured_prepayment_recomputations('infinity'); raise exception 'infinite clock accepted'; exception when sqlstate '22023' then null; end;
end$$;
select pg_temp.assert_maturity(
 not has_function_privilege('authenticated','private.enqueue_matured_prepayment_recomputations(timestamptz)','EXECUTE')
 and not has_function_privilege('service_role','private.enqueue_matured_prepayment_recomputations(timestamptz)','EXECUTE')
 and not has_table_privilege('service_role','private.prepayment_financial_maturity_markers','INSERT'),
 'caller can choose maturity clock or manufacture marker');

-- Simulate the previously-ACKed queue at an actual current-month rollover.
-- No billing generator, WhatsApp opt-in, destination, or secret is present.
insert into maturity_results select 'current',public.register_external_prepayment(
 '7e140002-0000-4000-8000-000000000012',400,current_date,current_month,2,'LEGADO','Current maturity isolated QA') from maturity_clock;
select pg_temp.assert_maturity((select v->>'ok'='true' from maturity_results where k='current'),'current register');
update private.prepayment_financial_recompute_queue set processed_version=version,claimed_version=null,
 claim_token=null,lease_expires_at=null where tenant_id='prepayment-maturity-qa';
select pg_temp.assert_maturity(not exists(select 1 from public.monthly_reserve_notification_settings where tenant_id='prepayment-maturity-qa')
 and not exists(select 1 from vault.secrets),'test must never contain an opt-in or HTTP credential');
select pg_temp.assert_maturity(public.trigger_monthly_reserve_notifications()=-1,
 'cron returned early for opt-in disabled instead of detecting newly matured access (HTTP must be skipped without key)');
select pg_temp.assert_maturity((select count(*)=1 from private.prepayment_financial_maturity_markers
 where student_id='7e140002-0000-4000-8000-000000000012')
 and (select version=processed_version+1 from private.prepayment_financial_recompute_queue
 where student_id='7e140002-0000-4000-8000-000000000012'),'cron failed to enqueue current competence');
select pg_temp.assert_maturity(public.trigger_monthly_reserve_notifications()=-1
 and (select version=processed_version+1 from private.prepayment_financial_recompute_queue
 where student_id='7e140002-0000-4000-8000-000000000012'),'repeated cron duplicated month work');
set local request.jwt.claims='{"role":"service_role"}';
do $$declare item jsonb; result jsonb; begin
 for item in select * from jsonb_array_elements(public.claim_prepayment_financial_recomputations(25)) loop
   result:=public.recompute_student_financial_status(item->>'tenant_id',(item->>'student_id')::uuid);
   perform pg_temp.assert_maturity(result->>'status'='ACTIVE','current external coverage remained indefinitely PENDING');
   perform pg_temp.assert_maturity((public.complete_prepayment_financial_recompute(
     item->>'tenant_id',(item->>'student_id')::uuid,(item->>'claim_token')::uuid,(item->>'version')::bigint,null)->>'ok')::boolean,'matured ACK');
 end loop;
end$$;
select pg_temp.assert_maturity(public.trigger_monthly_reserve_notifications()=0,'completed maturity kept waking worker forever');
rollback;
