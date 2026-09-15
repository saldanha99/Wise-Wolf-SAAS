-- Network-less empty finance QA only. All records below are synthetic.
begin;
do $$ begin
 if current_setting('cron.launch_active_jobs',true) is distinct from 'off'
   or exists(select 1 from public.profiles) or exists(select 1 from auth.users)
   or exists(select 1 from vault.secrets) then raise exception 'isolated_empty_finance_qa_required'; end if;
end $$;
create function pg_temp.assert_renewal(v boolean,m text) returns void language plpgsql as $$
begin if not coalesce(v,false) then raise exception 'renewal assertion: %',m; end if; end $$;
grant execute on function pg_temp.assert_renewal(boolean,text) to authenticated;
insert into public.tenants(id,name,slug,saas_status,whatsapp_enabled)
 values('renewal-qa','Renewal QA','renewal-qa','active',false);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select id,'authenticated','authenticated',email,'{"provider":"email","providers":["email"]}'::jsonb,
 '{"full_name":"Synthetic Renewal QA"}'::jsonb,now(),now() from (values
 ('7e170000-0000-4000-8000-000000000001'::uuid,'renewal-admin@example.invalid'),
 ('7e170000-0000-4000-8000-000000000011'::uuid,'renewal-student@example.invalid')) f(id,email);
set local app.enrollment_claim='1';
update public.profiles set tenant_id='renewal-qa',status='Ativo',lifecycle_status='active',
 role=case when id='7e170000-0000-4000-8000-000000000001' then 'SCHOOL_ADMIN' else 'STUDENT' end,
 is_test_account=true,test_fixture_key='renewal-qa-'||id::text,
 monthly_fee=261,class_frequency='3x',due_day=10,contract_accepted=true
 where id in ('7e170000-0000-4000-8000-000000000001','7e170000-0000-4000-8000-000000000011');
set local app.enrollment_claim='';
delete from public.tenant_memberships where user_id in ('7e170000-0000-4000-8000-000000000001','7e170000-0000-4000-8000-000000000011');
insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary)
 select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id='renewal-qa';
create temporary table renewal_before as select id,to_jsonb(p) as snapshot from public.profiles p;
create function pg_temp.propose(fee bigint default 26100,freq smallint default 3,day smallint default 10,note text default 'Synthetic owner approval with contract evidence') returns uuid language sql as $$
 select private.register_student_course_renewal_proposal('renewal-qa','7e170000-0000-4000-8000-000000000011',fee,freq,day,note,repeat('a',64)); $$;
select pg_temp.assert_renewal(pg_temp.propose()=pg_temp.propose(),'idempotent proposal duplicated');
select pg_temp.assert_renewal((select count(*)=1 and min(term_months)=6 and min(monthly_fee_cents)=26100 and min(classes_per_week)=3
 from private.student_course_renewal_proposals),'wrong approved conditions');
select pg_temp.assert_renewal(not exists(select 1 from public.profiles p join renewal_before b using(id) where to_jsonb(p)<>b.snapshot),'profile was changed');
select pg_temp.assert_renewal(not exists(select 1 from public.student_payments),'draft created a payment');
select pg_temp.assert_renewal(not exists(select 1 from net.http_request_queue),'draft called an external service');
do $$ begin
 begin perform pg_temp.propose(26200); raise exception 'test_expected_price_block'; exception when others then if sqlerrm<>'renewal_price_changed' then raise; end if; end;
 begin perform pg_temp.propose(26100,4::smallint); raise exception 'test_expected_frequency_block'; exception when others then if sqlerrm<>'renewal_frequency_changed' then raise; end if; end;
 begin perform pg_temp.propose(26100,3::smallint,12::smallint); raise exception 'test_expected_due_block'; exception when others then if sqlerrm<>'renewal_due_day_changed' then raise; end if; end;
 begin perform pg_temp.propose(26100,3::smallint,10::smallint,'Different synthetic provenance approval'); raise exception 'test_expected_replay_block'; exception when others then if sqlerrm<>'renewal_proposal_replay_conflict' then raise; end if; end;
 begin update private.student_course_renewal_proposals set status='DRAFT'; raise exception 'test_expected_immutable_block'; exception when others then if sqlerrm='test_expected_immutable_block' then raise; end if; end;
end $$;
select pg_temp.assert_renewal(not has_table_privilege('authenticated','private.student_course_renewal_proposals','SELECT')
 and not has_table_privilege('service_role','private.student_course_renewal_proposals','INSERT')
 and not has_function_privilege('authenticated','private.register_student_course_renewal_proposal(text,uuid,bigint,smallint,smallint,text,text)','EXECUTE')
 and not has_function_privilege('service_role','private.register_student_course_renewal_proposal(text,uuid,bigint,smallint,smallint,text,text)','EXECUTE')
 and not has_function_privilege('anon','public.list_student_course_renewal_proposals(text)','EXECUTE'),'privileges too broad');
set local request.jwt.claims='{"role":"authenticated","sub":"7e170000-0000-4000-8000-000000000001"}';
set local role authenticated;
select pg_temp.assert_renewal(jsonb_array_length(public.list_student_course_renewal_proposals('renewal-qa')->'items')=1,'admin cannot view draft');
do $$ begin
 begin perform public.list_student_course_renewal_proposals('other-tenant'); raise exception 'test_expected_scope_block'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local request.jwt.claims='{"role":"authenticated","sub":"7e170000-0000-4000-8000-000000000011"}';
set local role authenticated;
do $$ begin
 begin perform public.list_student_course_renewal_proposals('renewal-qa'); raise exception 'test_expected_student_block'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local request.jwt.claims='{}';
set local app.enrollment_claim='1';
update public.profiles set class_frequency=null,due_day=null,lifecycle_status='suspended'
 where id='7e170000-0000-4000-8000-000000000011';
set local app.enrollment_claim='';
select private.register_student_course_renewal_proposal('renewal-qa','7e170000-0000-4000-8000-000000000011',26100,3::smallint,10::smallint,
 'Legacy contract and owner approval document missing profile conditions',repeat('b',64));
select pg_temp.assert_renewal((select count(*)=2 from private.student_course_renewal_proposals),'legacy evidence not accepted');
select pg_temp.assert_renewal((select lifecycle_status='suspended' and class_frequency is null and due_day is null from public.profiles
 where id='7e170000-0000-4000-8000-000000000011'),'draft changed access or missing legacy fields');
rollback;
