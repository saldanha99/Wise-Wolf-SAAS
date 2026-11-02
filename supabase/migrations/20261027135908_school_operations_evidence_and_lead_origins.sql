-- Operational evidence and private management notices. No payroll, debt,
-- historical contract, consent decision or old message is rewritten.
create table if not exists private.school_operation_channels(
 tenant_id text not null references public.tenants(id),channel text not null check(channel in('teacher_attendance','student_attendance','lead_source')),
 group_jid text not null check(group_jid ~ '^[0-9]{10,25}@g\.us$'),enabled boolean not null default false,
 starts_at timestamptz not null default now(),late_minutes integer not null default 5 check(late_minutes between 1 and 60),primary key(tenant_id,channel));
alter table private.school_operation_channels owner to postgres;
alter table private.school_operation_channels enable row level security;
revoke all on private.school_operation_channels from public,anon,authenticated,service_role;
create table if not exists private.school_attendance_evidence(
 id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),session_id uuid not null references public.lesson_sessions(id),
 subject_role text not null check(subject_role in('TEACHER','STUDENT')),subject_id uuid not null,report_id uuid not null,
 scheduled_start_at timestamptz not null,first_join_at timestamptz,late_minutes integer,
 evidence_status text not null check(evidence_status in('MEASURED','UNVERIFIED')),measured_at timestamptz not null default now(),expires_at timestamptz not null,
 unique(session_id,subject_role,subject_id));
alter table private.school_attendance_evidence owner to postgres;
alter table private.school_attendance_evidence enable row level security;
revoke all on private.school_attendance_evidence from public,anon,authenticated,service_role;
-- Corrections remain traceable without retaining raw classroom content.
create table if not exists private.school_attendance_evidence_revisions(
 id uuid primary key default gen_random_uuid(),evidence_id uuid not null references private.school_attendance_evidence(id) on delete cascade,
 tenant_id text not null,snapshot jsonb not null,created_at timestamptz not null default now(),expires_at timestamptz not null);
alter table private.school_attendance_evidence_revisions owner to postgres;
alter table private.school_attendance_evidence_revisions enable row level security;
revoke all on private.school_attendance_evidence_revisions from public,anon,authenticated,service_role;
create or replace function private.record_school_attendance_revision()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or (to_jsonb(new)-'measured_at') is distinct from (to_jsonb(old)-'measured_at') then
  insert into private.school_attendance_evidence_revisions(evidence_id,tenant_id,snapshot,expires_at)
  values(new.id,new.tenant_id,jsonb_build_object('report_id',new.report_id,'first_join_at',new.first_join_at,'late_minutes',new.late_minutes,'status',new.evidence_status),new.expires_at);
 end if;
 return new;
end;$$;
alter function private.record_school_attendance_revision() owner to postgres;
revoke all on function private.record_school_attendance_revision() from public,anon,authenticated,service_role;
drop trigger if exists record_school_attendance_revision on private.school_attendance_evidence;
create trigger record_school_attendance_revision after insert or update on private.school_attendance_evidence for each row execute function private.record_school_attendance_revision();

create table if not exists private.school_operation_outbox(
 id uuid primary key default gen_random_uuid(),tenant_id text not null references public.tenants(id),channel text not null,
 source_id uuid not null,event_key text not null,status text not null default 'PENDING' check(status in('PENDING','CLAIMED','SUBMITTING','ACCEPTED','UNKNOWN','REJECTED','SUPPRESSED')),
 token uuid,lease_until timestamptz,snapshot jsonb,destination text,route_hash text,provider_message_id text,last_error text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(tenant_id,event_key),
 foreign key(tenant_id,channel) references private.school_operation_channels(tenant_id,channel));
alter table private.school_operation_outbox owner to postgres;
alter table private.school_operation_outbox enable row level security;
revoke all on private.school_operation_outbox from public,anon,authenticated,service_role;
create index if not exists school_operation_pending on private.school_operation_outbox(created_at) where status in('PENDING','CLAIMED');
create index if not exists school_attendance_evidence_tenant_date on private.school_attendance_evidence(tenant_id,scheduled_start_at desc);

create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select p.role='TEACHER' and p.tenant_id=p_tenant and p.lifecycle_status='active'
  and lower(btrim(coalesce(p.status,'')))='ativo' and p.is_test_account is not true
  and exists(select 1 from public.tenant_memberships m where m.user_id=p.id and m.tenant_id=p_tenant and m.role='TEACHER' and m.status='ACTIVE')
  and private.tenant_is_operational(p_tenant) from public.profiles p where p.id=p_teacher),false);
$$;
alter function public.teacher_opportunity_recipient_eligible(text,uuid) owner to postgres;
revoke all on function public.teacher_opportunity_recipient_eligible(text,uuid) from public,anon,authenticated;
grant execute on function public.teacher_opportunity_recipient_eligible(text,uuid) to service_role;

alter table public.crm_leads add column if not exists origin_evidence jsonb not null default '{}'::jsonb;
-- Public intake sends only its existing notes field. Never widen the anonymous
-- column allowlist or let the client override the server-normalized evidence.
create or replace function private.lead_origin_evidence(p_source text,p_notes text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v jsonb:='{}';clean jsonb:='{}';s text:=coalesce(p_source,'');key text;raw text;channel text;surface text;
begin
 begin
  raw:=substring(coalesce(p_notes,'') from 'Origem: (\{[^\n]*\})');
  if raw is null then raw:=substring(coalesce(p_notes,'') from 'UTMs: (\{[^\n]*\})');end if;
  if length(raw)<=5000 then v:=raw::jsonb;end if;
 exception when others then v:='{}';end;
 if jsonb_typeof(v) is distinct from 'object' then v:='{}';end if;
 foreach key in array array['utm_source','utm_medium','utm_campaign','utm_content','utm_term','landing_path','referrer_host','first_landing_path','last_landing_path','first_referrer_host'] loop
  if jsonb_typeof(v->key)='string' then
   raw:=left(regexp_replace(v->>key,'[[:cntrl:]]',' ','g'),240);
   if key like '%path' and (raw !~ '^/[A-Za-z0-9/_%.~-]*$' or raw ~* '(token|convite|auth|senha|contrato|matricula|confirmar)') then continue;end if;
   if key like '%host' and raw !~ '^[A-Za-z0-9.-]+$' then continue;end if;
   clean:=clean||jsonb_build_object(key,raw);
  end if;
 end loop;
 -- Persist the presence of a click marker, never the raw advertising identifier.
 if nullif(v->>'gclid','') is not null or nullif(v->>'wbraid','') is not null or nullif(v->>'gbraid','') is not null then
  clean:=clean||'{"google_click":true}';
 end if;
 if nullif(v->>'fbclid','') is not null then clean:=clean||'{"meta_click":true}';end if;
 channel:=case
  when clean->>'google_click'='true' or lower(coalesce(clean->>'utm_medium','')) in('cpc','ppc','paid','paid_social','paid_search','cpm','display') then 'PAID'
  when lower(coalesce(clean->>'utm_medium',''))='organic' or coalesce(clean->>'referrer_host','') ~* '(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$' then 'ORGANIC_SEARCH'
  when coalesce(clean->>'referrer_host','')<>'' and clean->>'referrer_host' !~* '(^|\.)wisewolflanguage\.com\.br$' then 'REFERRAL'
  when nullif(clean->>'utm_source','') is not null then 'TAGGED'
  when s ilike '%whatsapp%' then 'WHATSAPP_UNKNOWN'
  else 'DIRECT_UNKNOWN' end;
 surface:=case when s ilike '%blog%' or (coalesce(clean->>'landing_path','') ~ '^/(blog|glossario)(/|$)' or coalesce(clean->>'first_landing_path','') ~ '^/(blog|glossario)(/|$)') then 'BLOG' when s ilike 'lp-%' or s ilike '%landing%' then 'LANDING' when s ilike '%whatsapp%' then 'WHATSAPP' else 'SITE_OR_FORM' end;
 return clean||jsonb_build_object('channel',channel,'surface',surface,'form_source',left(s,120),'confidence','OBSERVED_CLIENT_METADATA');
end;
$$;
alter function private.lead_origin_evidence(text,text) owner to postgres;
revoke all on function private.lead_origin_evidence(text,text) from public,anon,authenticated,service_role;
create or replace function private.capture_lead_origin_evidence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then new.origin_evidence:=private.lead_origin_evidence(new.source,new.notes);
 else new.origin_evidence:=old.origin_evidence;end if;
 return new;
end;$$;
alter function private.capture_lead_origin_evidence() owner to postgres;
revoke all on function private.capture_lead_origin_evidence() from public,anon,authenticated,service_role;
drop trigger if exists capture_lead_origin_evidence on public.crm_leads;
create trigger capture_lead_origin_evidence before insert or update of origin_evidence on public.crm_leads for each row execute function private.capture_lead_origin_evidence();

create or replace function private.queue_school_lead_origin()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.source like 'preview_%' or new.source like '%test%' or coalesce(new.email,'') like '%@example.invalid' then return new;end if;
 insert into private.school_operation_outbox(tenant_id,channel,source_id,event_key)
 select new.tenant_id,'lead_source',new.id,'lead:'||new.id from private.school_operation_channels c
 where c.tenant_id=new.tenant_id and c.channel='lead_source' and c.enabled and new.created_at>=c.starts_at
 on conflict(tenant_id,event_key) do nothing;
 return new;
end;$$;
alter function private.queue_school_lead_origin() owner to postgres;
revoke all on function private.queue_school_lead_origin() from public,anon,authenticated,service_role;
drop trigger if exists queue_school_lead_origin on public.crm_leads;
create trigger queue_school_lead_origin after insert on public.crm_leads for each row execute function private.queue_school_lead_origin();

create or replace function private.capture_school_meet_evidence(p_session uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare s public.lesson_sessions%rowtype;r private.meeting_attendance_reports%rowtype;n jsonb;c private.school_operation_channels%rowtype;
 role_name text;sid uuid;joined timestamptz;known boolean;identity text;eid uuid;minutes integer;row_item jsonb;
begin
 if p_payload->>'conference_open' is distinct from 'false' then return;end if;
 select * into s from public.lesson_sessions where id=p_session;
 if not found or s.scheduled_end_at>now() or s.documentation_consent is not true or s.status='SUPERSEDED'
  or private.lesson_session_documentation_blocked(s.id) or private.teacher_lesson_presence_given_by_other(s.id)
  or private.google_meet_room_withheld_at_lesson(s.id) then return;end if;
 if exists(select 1 from public.profiles p where p.id in(s.student_id,s.teacher_id) and (p.is_test_account is true or coalesce(p.email,'') like '%@example.invalid')) then return;end if;
 select * into r from private.meeting_attendance_reports where lesson_session_id=s.id and parse_error is null and expires_at>now() order by imported_at desc limit 1;
 if r.id is null then return;end if;
 n:=private.meet_attendance_numbers(s.id,r.id);
 foreach role_name in array array['TEACHER','STUDENT'] loop
  select * into c from private.school_operation_channels where tenant_id=s.tenant_id and channel=case role_name when 'TEACHER' then 'teacher_attendance' else 'student_attendance' end and enabled;
  if not found or s.scheduled_start_at<c.starts_at then continue;end if;
  if role_name='TEACHER' then sid:=s.teacher_id;known:=coalesce((n->>'teacher_identified')::boolean,false);joined:=nullif(n->>'teacher_first_join_at','')::timestamptz;
  else
   sid:=s.student_id;select lower(btrim(email)) into identity from public.profiles where id=sid and tenant_id=s.tenant_id and role='STUDENT';
   -- A guest is never silently assumed to be the student. The native report
   -- must identify the student's registered email; ambiguous rows stay unknown.
   select min(private.teacher_presence_timestamp(x->>'joinedAt')),count(*)>0 into joined,known
   from jsonb_array_elements(coalesce(n->'participants','[]')) x where lower(btrim(x->>'email'))=identity and nullif(identity,'') is not null and x->>'role'='STUDENT';
  end if;
  minutes:=case when known and joined>=s.scheduled_start_at and joined<s.scheduled_end_at then floor(extract(epoch from(joined-s.scheduled_start_at))/60)::int when known and joined<s.scheduled_start_at then 0 else null end;
  insert into private.school_attendance_evidence(tenant_id,session_id,subject_role,subject_id,report_id,scheduled_start_at,first_join_at,late_minutes,evidence_status,expires_at)
  values(s.tenant_id,s.id,role_name,sid,r.id,s.scheduled_start_at,case when known then joined end,minutes,case when minutes is not null then 'MEASURED' else 'UNVERIFIED' end,least(r.expires_at,s.scheduled_end_at+interval '90 days'))
  on conflict(session_id,subject_role,subject_id) do update set report_id=excluded.report_id,first_join_at=excluded.first_join_at,late_minutes=excluded.late_minutes,evidence_status=excluded.evidence_status,measured_at=now(),expires_at=excluded.expires_at
  returning id into eid;
  if minutes>=c.late_minutes then
   insert into private.school_operation_outbox(tenant_id,channel,source_id,event_key) values(s.tenant_id,c.channel,eid,'meet:'||s.id||':'||role_name||':'||sid)
   on conflict(tenant_id,event_key) do nothing;
  end if;
 end loop;
end;$$;
alter function private.capture_school_meet_evidence(uuid,jsonb) owner to postgres;
revoke all on function private.capture_school_meet_evidence(uuid,jsonb) from public,anon,authenticated,service_role;
-- Preserve every prior attendance/consent/retention patch. Add one fail-isolated
-- hook, only for completed conference evaluation, with no change to payroll.
do $patch$
declare body text;anchor text:='return private.meet_attendance_evaluate(';
begin
 body:=pg_get_functiondef('public.google_meet_attendance_backend(text,text,uuid,jsonb)'::regprocedure);
 if strpos(body,'capture_school_meet_evidence')=0 then
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'attendance evaluation anchor changed';end if;
  body:=replace(body,anchor,E'begin\n      perform private.capture_school_meet_evidence(v_session.id,p_payload);\n    exception when others then\n      raise warning ''school_meet_evidence_capture_failed'';\n    end;\n    '||anchor);
  execute body;
 end if;
end;$patch$;

create or replace function private.school_operation_source(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o private.school_operation_outbox%rowtype;c private.school_operation_channels%rowtype;e private.school_attendance_evidence%rowtype;s public.lesson_sessions%rowtype;l public.crm_leads%rowtype;n text;other_name text;
begin
 select * into o from private.school_operation_outbox where id=p_id;
 select * into c from private.school_operation_channels where tenant_id=o.tenant_id and channel=o.channel and enabled;
 if c.tenant_id is null or not private.tenant_is_operational(o.tenant_id) then return null;end if;
 if o.channel='lead_source' then
  select * into l from public.crm_leads where id=o.source_id and tenant_id=o.tenant_id and created_at>=c.starts_at;
  if l.id is null or l.created_at<now()-interval '2 days' or coalesce(l.email,'') like '%@example.invalid' or l.source like 'preview_%' or l.source like '%test%' then return null;end if;
  return jsonb_build_object('kind','LEAD_ORIGIN','name',left(l.name,120),'phone',left(l.phone,30),'origin',l.origin_evidence,'lead_id',l.id,'created_at',l.created_at);
 end if;
 select * into e from private.school_attendance_evidence where id=o.source_id and tenant_id=o.tenant_id and expires_at>now() and evidence_status='MEASURED' and late_minutes>=c.late_minutes;
 if e.id is null then return null;end if;
 select * into s from public.lesson_sessions where id=e.session_id and teacher_id=case when e.subject_role='TEACHER' then e.subject_id else teacher_id end and scheduled_start_at=e.scheduled_start_at;
 if s.id is null or s.tenant_id<>e.tenant_id or (e.subject_role='STUDENT' and s.student_id is distinct from e.subject_id) or s.documentation_consent is not true or s.status='SUPERSEDED' or private.lesson_session_documentation_blocked(s.id) or private.teacher_lesson_presence_given_by_other(s.id) or private.google_meet_room_withheld_at_lesson(s.id) then return null;end if;
 if not exists(select 1 from private.meeting_attendance_reports where id=e.report_id and expires_at>now() and parse_error is null) then return null;end if;
 select full_name into n from public.profiles where id=e.subject_id and tenant_id=e.tenant_id and is_test_account is not true;
 select full_name into other_name from public.profiles where id=case when e.subject_role='TEACHER' then s.student_id else s.teacher_id end and tenant_id=e.tenant_id;
 if n is null then return null;end if;
 return jsonb_build_object('kind',e.subject_role||'_LATE','name',left(n,120),'counterpart',left(other_name,120),'scheduled_start_at',e.scheduled_start_at,'first_join_at',e.first_join_at,'late_minutes',e.late_minutes,'report_id',e.report_id,'session_id',s.id,'evidence_id',e.id);
end;$$;
alter function private.school_operation_source(uuid) owner to postgres;
revoke all on function private.school_operation_source(uuid) from public,anon,authenticated,service_role;

create or replace function public.school_operation_notifications(p_action text,p_id uuid default null,p_token uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare o private.school_operation_outbox%rowtype;v jsonb;v_destination text;
begin
 if (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'service_required' using errcode='42501';end if;
 if p_action='pending' then
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'tenant_id',tenant_id,'channel',channel) order by created_at) from(select * from private.school_operation_outbox where status='PENDING' or(status='CLAIMED' and lease_until<now()) order by created_at limit 20) q),'[]');
 end if;
 select * into o from private.school_operation_outbox where id=p_id for update;
 if o.id is null then return jsonb_build_object('ok',false);end if;
 if p_action='claim' then
  if p_token is null then raise exception 'claim_token_required';end if;
  if not(o.status='PENDING' or(o.status='CLAIMED' and o.lease_until<now())) then return jsonb_build_object('ok',false);end if;
  v:=private.school_operation_source(o.id);
  if v is null then update private.school_operation_outbox set status='SUPPRESSED',last_error='source_not_eligible',updated_at=now() where id=o.id;return jsonb_build_object('ok',false);end if;
  select group_jid into v_destination from private.school_operation_channels where tenant_id=o.tenant_id and channel=o.channel and enabled;
  update private.school_operation_outbox set status='CLAIMED',token=p_token,lease_until=now()+interval '2 minutes',snapshot=v,destination=v_destination,updated_at=now() where id=o.id;
  return jsonb_build_object('ok',true,'source',v,'destination',v_destination);
 end if;
 if o.token is distinct from p_token then return jsonb_build_object('ok',false);end if;
 if p_action='submit' then
  if o.status<>'CLAIMED' or o.lease_until<now() then return jsonb_build_object('ok',false);end if;
  v:=private.school_operation_source(o.id);
  if v is null or v is distinct from o.snapshot or not exists(select 1 from private.school_operation_channels c where c.tenant_id=o.tenant_id and c.channel=o.channel and c.enabled and c.group_jid=o.destination) then
   update private.school_operation_outbox set status='SUPPRESSED',last_error='source_changed',updated_at=now() where id=o.id;return jsonb_build_object('ok',false);end if;
  if coalesce(p_payload->>'route_hash','') !~ '^[a-f0-9]{64}$' then raise exception 'route_hash_required';end if;
  update private.school_operation_outbox set status='SUBMITTING',route_hash=p_payload->>'route_hash',updated_at=now() where id=o.id;
  return jsonb_build_object('ok',true);
 elsif p_action='finish' then
  if o.status<>'SUBMITTING' then return jsonb_build_object('ok',false);end if;
  if p_payload->>'outcome' not in('accepted','ambiguous','rejected') then raise exception 'outcome_invalid';end if;
  update private.school_operation_outbox set status=case p_payload->>'outcome' when 'accepted' then 'ACCEPTED' when 'rejected' then 'REJECTED' else 'UNKNOWN' end,provider_message_id=left(p_payload->>'messageId',200),last_error=case when p_payload->>'outcome'='accepted' then null else 'provider_'||(p_payload->>'outcome') end,updated_at=now() where id=o.id;
  return jsonb_build_object('ok',true);
 end if;
 raise exception 'action_invalid';
end;$$;
alter function public.school_operation_notifications(text,uuid,uuid,jsonb) owner to postgres;
revoke all on function public.school_operation_notifications(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.school_operation_notifications(text,uuid,uuid,jsonb) to service_role;

create or replace function public.school_operations_evidence_log(p_from date default current_date-7,p_to date default current_date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t text:=private.active_tenant_id(auth.uid());r text:=private.active_tenant_role(auth.uid());
begin
 if auth.uid() is null or coalesce(r,'') not in('SCHOOL_ADMIN','COORDINATOR') or p_to<p_from or p_to-p_from>31 then raise exception 'not_authorized_or_invalid_range' using errcode='42501';end if;
 return jsonb_build_object('channels',coalesce((select jsonb_agg(jsonb_build_object('channel',channel,'enabled',enabled,'starts_at',starts_at,'late_minutes',late_minutes)) from private.school_operation_channels where tenant_id=t),'[]'),
 'attendance',coalesce((select jsonb_agg(to_jsonb(q) order by scheduled_start_at desc) from(select e.id,e.session_id,e.subject_role,p.full_name,e.scheduled_start_at,e.first_join_at,e.late_minutes,e.evidence_status,e.report_id,e.measured_at from private.school_attendance_evidence e join public.profiles p on p.id=e.subject_id where e.tenant_id=t and (e.scheduled_start_at at time zone 'America/Sao_Paulo')::date between p_from and p_to and e.expires_at>now() order by e.scheduled_start_at desc limit 300) q),'[]'),
 'origins',coalesce((select jsonb_agg(to_jsonb(q) order by created_at desc) from(select id,name,source,created_at,case when origin_evidence='{}'::jsonb then private.lead_origin_evidence(source,notes) else origin_evidence end origin from public.crm_leads where tenant_id=t and (created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to order by created_at desc limit 100) q),'[]'),
 'notifications',coalesce((select jsonb_agg(to_jsonb(q) order by created_at desc) from(select id,channel,status,last_error,created_at,provider_message_id from private.school_operation_outbox where tenant_id=t and (created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to order by created_at desc limit 100) q),'[]'));
end;$$;
alter function public.school_operations_evidence_log(date,date) owner to postgres;
revoke all on function public.school_operations_evidence_log(date,date) from public,anon;
grant execute on function public.school_operations_evidence_log(date,date) to authenticated;

create or replace function public.trigger_school_operations_notifications()
returns bigint language plpgsql security definer set search_path='' as $$
declare k text;v bigint;
begin
 delete from private.school_operation_outbox where created_at<now()-interval '90 days';
 delete from private.school_attendance_evidence_revisions where expires_at<=now();
 delete from private.school_attendance_evidence where expires_at<=now();
 if not exists(select 1 from private.school_operation_outbox where status='PENDING' or(status='CLAIMED' and lease_until<now())) then return 0;end if;
 select decrypted_secret into k from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
 if nullif(k,'') is null then return -1;end if;
 select net.http_post(url:='http://kong:8000/functions/v1/school-operations-notify',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||k),body:='{"sweep":true}',timeout_milliseconds:=120000) into v;
 return v;
end;$$;
alter function public.trigger_school_operations_notifications() owner to postgres;
revoke all on function public.trigger_school_operations_notifications() from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from cron.job where jobname='wisewolf-school-operations-notices') then perform cron.unschedule('wisewolf-school-operations-notices');end if;
 perform cron.schedule('wisewolf-school-operations-notices','*/2 * * * *','select public.trigger_school_operations_notifications();');
end $$;
notify pgrst,'reload schema';
