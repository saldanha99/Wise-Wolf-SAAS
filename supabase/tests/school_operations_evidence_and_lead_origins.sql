\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_ok(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'operations assertion: %',m;end if;end$$;
do $$
declare t text:='operations-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();lead uuid:=gen_random_uuid();notice uuid:=gen_random_uuid();v_token uuid:=gen_random_uuid();r jsonb;v_original_source text;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.assert_ok(not has_function_privilege('anon','public.school_operation_notifications(text,uuid,uuid,jsonb)','EXECUTE'),'anonymous access to sender');
 perform pg_temp.assert_ok(not has_function_privilege('authenticated','public.school_operation_notifications(text,uuid,uuid,jsonb)','EXECUTE'),'browser access to sender');
 perform pg_temp.assert_ok(not has_table_privilege('authenticated','private.school_attendance_evidence','SELECT'),'raw evidence exposed');
 perform pg_temp.assert_ok(private.lead_origin_evidence('institutional_site',null)->>'channel'='DIRECT_UNKNOWN','unknown source invented');
 perform pg_temp.assert_ok(private.lead_origin_evidence('lp-ielts','UTMs: {"gclid":"private-click-id","utm_campaign":"fixture"}')->>'channel'='PAID','Google click not recognized');
 perform pg_temp.assert_ok(not(private.lead_origin_evidence('institutional_site','UTMs: {"gclid":"private-click-id","password":"secret"}')?'gclid'),'raw click id retained');
 perform pg_temp.assert_ok(not(private.lead_origin_evidence('institutional_site','UTMs: {"password":"secret","landing_path":"/auth/token"}')?'password'),'secret metadata retained');
 perform pg_temp.assert_ok(private.lead_origin_evidence('institutional_site','Origem: {"referrer_host":"www.google.com","landing_path":"/blog/fixture"}')->>'channel'='ORGANIC_SEARCH','organic reference not recognized');
 perform pg_temp.assert_ok(private.lead_origin_evidence('institutional_site','Origem: {"referrer_host":"www.google.com","landing_path":"/blog/fixture"}')->>'surface'='BLOG','surface conflated with channel');
 perform pg_temp.assert_ok(private.lead_origin_evidence('institutional_site','Origem: {"first_landing_path":"/blog/fixture","landing_path":"/curso"}')->>'surface'='BLOG','initial blog entry lost between pages');
 perform pg_temp.assert_ok(private.lead_origin_evidence('institutional_site','UTMs: {broken')->>'channel'='DIRECT_UNKNOWN','invalid JSON blocked intake');
 perform pg_temp.assert_ok(private.lead_origin_evidence('institutional_site','UTMs: {"utm_medium":"email"}\nOrigem: {"utm_medium":"cpc"}')->>'channel'='PAID','first party envelope must take precedence');
 insert into public.tenants(id,name,saas_status) values(t,'Operations transaction fixture','active');
 insert into auth.users(id,email,raw_user_meta_data) values(teacher,teacher||'@example.invalid','{"test_fixture":true}');
 update public.profiles set tenant_id=t,role='TEACHER',status='Ativo',lifecycle_status='active',is_test_account=true where id=teacher;
 -- Test identity remains excluded even when other eligibility facts are active.
 perform pg_temp.assert_ok(not public.teacher_opportunity_recipient_eligible(t,teacher),'fixture invitation not suppressed');
 update public.profiles set lifecycle_status='suspended' where id=teacher;
 perform pg_temp.assert_ok(not public.teacher_opportunity_recipient_eligible(t,teacher),'suspended teacher invited');
 update public.profiles set lifecycle_status='offboarded' where id=teacher;
 perform pg_temp.assert_ok(not public.teacher_opportunity_recipient_eligible(t,teacher),'offboarded teacher invited');
 insert into private.school_operation_channels(tenant_id,channel,group_jid,enabled,starts_at) values(t,'lead_source','120363000000000009@g.us',true,now()-interval '1 hour');
 insert into public.crm_leads(id,tenant_id,name,email,phone,status,source,notes,origin_evidence) values(lead,t,'Origin Fixture',teacher||'@example.invalid','', 'NEW','preview_fixture','UTMs: {"utm_medium":"cpc"}', '{"channel":"FORGED"}');
 perform pg_temp.assert_ok((select origin_evidence->>'channel'='PAID' from public.crm_leads where id=lead),'client forged origin evidence');
 perform pg_temp.assert_ok(not exists(select 1 from private.school_operation_outbox where source_id=lead),'fixture notification queued');
 update public.crm_leads set origin_evidence='{"channel":"FORGED"}' where id=lead;
 perform pg_temp.assert_ok((select origin_evidence->>'channel'='PAID' from public.crm_leads where id=lead),'origin evidence rewritten');
 insert into private.school_operation_outbox(id,tenant_id,channel,source_id,event_key) values(notice,t,'lead_source',lead,'fixture:'||lead);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 r:=public.school_operation_notifications('claim',notice,v_token);
 perform pg_temp.assert_ok(r->>'ok'='false','fixture source was claimable');
 perform pg_temp.assert_ok((select status='SUPPRESSED' from private.school_operation_outbox where id=notice),'ineligible source not suppressed');
 -- Isolate the delivery state machine from business-source queries, in the
 -- same rollback-only transaction. Concurrent production workers cannot see
 -- this uncommitted replacement; it is restored before leaving the fixture.
 v_original_source:=pg_get_functiondef('private.school_operation_source(uuid)'::regprocedure);
 execute $stub$create or replace function private.school_operation_source(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $body$ select '{"kind":"LEAD_ORIGIN","name":"Fixture"}'::jsonb $body$ $stub$;
 update private.school_operation_outbox set status='PENDING' where id=notice;
 r:=public.school_operation_notifications('claim',notice,v_token);
 perform pg_temp.assert_ok(r->>'ok'='true' and r->>'destination'='120363000000000009@g.us','approved source could not be claimed');
 r:=public.school_operation_notifications('submit',notice,gen_random_uuid(),jsonb_build_object('route_hash',repeat('a',64)));
 perform pg_temp.assert_ok(r->>'ok'='false','wrong token authorized a send');
 update private.school_operation_channels set group_jid='120363000000000008@g.us' where tenant_id=t and channel='lead_source';
 r:=public.school_operation_notifications('submit',notice,v_token,jsonb_build_object('route_hash',repeat('a',64)));
 perform pg_temp.assert_ok(r->>'ok'='false' and (select status='SUPPRESSED' from private.school_operation_outbox where id=notice),'changed group authorized a send');
 update private.school_operation_channels set group_jid='120363000000000009@g.us' where tenant_id=t and channel='lead_source';
 update private.school_operation_outbox set status='PENDING' where id=notice;
 r:=public.school_operation_notifications('claim',notice,v_token);
 perform pg_temp.assert_ok(r->>'ok'='true','source could not be claimed again');
 r:=public.school_operation_notifications('submit',notice,v_token,jsonb_build_object('route_hash',repeat('a',64)));
 perform pg_temp.assert_ok(r->>'ok'='true','exact source not authorized');
 execute v_original_source;
 -- An uncertain provider attempt can be recorded, never reclaimed/resubmitted.
 update private.school_operation_outbox set status='SUBMITTING',token=v_token,lease_until=now()-interval '1 hour' where id=notice;
 r:=public.school_operation_notifications('claim',notice,gen_random_uuid());
 perform pg_temp.assert_ok(r->>'ok'='false','uncertain POST was reclaimed');
 r:=public.school_operation_notifications('finish',notice,v_token,'{"outcome":"ambiguous"}');
 perform pg_temp.assert_ok(r->>'ok'='true' and (select status='UNKNOWN' from private.school_operation_outbox where id=notice),'uncertain outcome lost');
 r:=public.school_operation_notifications('claim',notice,gen_random_uuid());
 perform pg_temp.assert_ok(r->>'ok'='false','UNKNOWN was retried');
 perform set_config('request.jwt.claims','{}',true);
end$$;
rollback;
