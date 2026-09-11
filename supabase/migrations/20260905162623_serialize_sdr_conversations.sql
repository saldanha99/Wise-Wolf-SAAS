-- Internal durable conversation cursor. Raw message text stays in the existing
-- conversation log; payload holds only the latest unprocessed input, no secrets.
create table if not exists public.sdr_conversation_work (
  tenant_id text not null references public.tenants(id) on delete cascade,
  phone text not null,
  payload jsonb not null,
  latest_msg_id text not null,
  completed_msg_id text,
  claimed_msg_id text,
  attempts integer not null default 0,
  phase text not null default 'IDLE' check (phase in ('IDLE','GENERATING','APPLYING','REVIEW')),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,phone)
);
alter table public.sdr_conversation_work enable row level security;
revoke all on public.sdr_conversation_work from public,anon,authenticated;
grant select,insert,update on public.sdr_conversation_work to service_role;
create index if not exists sdr_input_message_idx on public.ai_wa_messages(tenant_id,phone,(meta->>'msg_id'))
  where agent='sdr' and direction='in';
create index if not exists sdr_work_due_idx on public.sdr_conversation_work(available_at)
  where phase <> 'REVIEW' and latest_msg_id is distinct from completed_msg_id;

create or replace function public.enqueue_sdr_work(p_tenant_id text,p_phone text,p_payload jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_id text := p_payload->>'msgId';
begin
  if coalesce(v_id,'')='' or p_phone !~ '^[0-9]{10,15}$' or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>20000 then raise exception 'invalid_sdr_input'; end if;
  if exists(select 1 from public.ai_wa_messages where tenant_id=p_tenant_id and phone=p_phone
    and agent='sdr' and direction='in' and meta->>'msg_id'=v_id) then return; end if;
  insert into public.sdr_conversation_work(tenant_id,phone,payload,latest_msg_id,available_at)
  values(p_tenant_id,p_phone,p_payload,v_id,now()+interval '2 seconds')
  on conflict(tenant_id,phone) do nothing;
  perform 1 from public.sdr_conversation_work where tenant_id=p_tenant_id and phone=p_phone for update;
  if exists(select 1 from public.ai_wa_messages where tenant_id=p_tenant_id and phone=p_phone
    and agent='sdr' and direction='in' and meta->>'msg_id'=v_id) then return; end if;
  insert into public.ai_wa_messages(tenant_id,phone,agent,direction,content,meta)
  values(p_tenant_id,p_phone,'sdr','in',left(coalesce(p_payload->>'text','[mídia]'),4000),
    jsonb_build_object('msg_id',v_id,'kind','sdr_queued'));
  update public.sdr_conversation_work set payload=p_payload,latest_msg_id=v_id,attempts=0,
    available_at=now()+interval '2 seconds',updated_at=now(),
    phase=case when phase='REVIEW' and not exists(
      select 1 from public.crm_leads l where l.tenant_id=p_tenant_id
        and regexp_replace(l.phone,'[^0-9]','','g')=p_phone
        and l.ai_handoff=true and l.ai_handoff_at>now()-interval '72 hours'
    ) then 'IDLE' else phase end
  where tenant_id=p_tenant_id and phone=p_phone;
end;
$$;

create or replace function public.claim_sdr_work(p_tenant_id text,p_phone text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare w public.sdr_conversation_work%rowtype; token uuid := gen_random_uuid();
begin
  select * into w from public.sdr_conversation_work where tenant_id=p_tenant_id and phone=p_phone for update;
  if not found or w.phase='REVIEW' or (w.latest_msg_id is not distinct from w.completed_msg_id and w.phase<>'APPLYING')
    or w.available_at>now() or w.lease_until>now() then return jsonb_build_object('claimed',false); end if;
  if w.phase='APPLYING' or w.attempts>=3 then
    update public.sdr_conversation_work set phase='REVIEW',updated_at=now() where tenant_id=p_tenant_id and phone=p_phone;
    update public.crm_leads set ai_handoff=true,ai_handoff_at=now()
      where tenant_id=p_tenant_id and regexp_replace(phone,'[^0-9]','','g')=p_phone;
    return jsonb_build_object('claimed',false,'review',true);
  end if;
  update public.sdr_conversation_work set phase='GENERATING',lease_token=token,attempts=attempts+1,
    lease_until=now()+interval '3 minutes',claimed_msg_id=latest_msg_id,updated_at=now()
    where tenant_id=p_tenant_id and phone=p_phone;
  return jsonb_build_object('claimed',true,'token',token,'payload',w.payload);
end;
$$;

create or replace function public.begin_sdr_effects(p_tenant_id text,p_phone text,p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.sdr_conversation_work set phase='APPLYING',lease_until=now()+interval '10 minutes',updated_at=now()
  where tenant_id=p_tenant_id and phone=p_phone and lease_token=p_token and lease_until>now()
    and phase='GENERATING' and latest_msg_id=claimed_msg_id;
  return found;
end;
$$;

create or replace function public.finish_sdr_work(p_tenant_id text,p_phone text,p_token uuid,p_success boolean)
returns void language plpgsql security invoker set search_path = '' as $$
declare w public.sdr_conversation_work%rowtype;
begin
  select * into w from public.sdr_conversation_work where tenant_id=p_tenant_id and phone=p_phone for update;
  if not found or w.lease_token is distinct from p_token then return; end if;
  update public.sdr_conversation_work set
    completed_msg_id=case when p_success then claimed_msg_id else completed_msg_id end,
    phase=case when not p_success and phase='APPLYING' then 'REVIEW' else 'IDLE' end,
    available_at=case when p_success then available_at else now()+interval '1 minute' end,
    lease_token=null,lease_until=null,updated_at=now()
    where tenant_id=p_tenant_id and phone=p_phone;
  if not p_success and w.phase='APPLYING' then
    update public.crm_leads set ai_handoff=true,ai_handoff_at=now()
      where tenant_id=p_tenant_id and regexp_replace(phone,'[^0-9]','','g')=p_phone;
  end if;
end;
$$;

create or replace function public.list_pending_sdr_work()
returns table(tenant_id text,phone text) language sql security invoker set search_path = '' as $$
  select w.tenant_id,w.phone from public.sdr_conversation_work w
  where w.phase<>'REVIEW' and (w.latest_msg_id is distinct from w.completed_msg_id or w.phase='APPLYING')
    and w.available_at<=now() and (w.lease_until is null or w.lease_until<=now())
  order by w.available_at limit 5;
$$;

revoke all on function public.enqueue_sdr_work(text,text,jsonb),public.claim_sdr_work(text,text),
  public.begin_sdr_effects(text,text,uuid),public.finish_sdr_work(text,text,uuid,boolean),public.list_pending_sdr_work()
  from public,anon,authenticated;
grant execute on function public.enqueue_sdr_work(text,text,jsonb),public.claim_sdr_work(text,text),
  public.begin_sdr_effects(text,text,uuid),public.finish_sdr_work(text,text,uuid,boolean),public.list_pending_sdr_work()
  to service_role;

-- Recovery after an interrupted webhook. Empty queues do not invoke the runtime.
create or replace function public.trigger_sdr_work()
returns bigint language plpgsql security definer set search_path = '' as $$
declare service_key text; request_id bigint;
begin
  if not exists(select 1 from public.list_pending_sdr_work()) then return 0; end if;
  select decrypted_secret into service_key from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
  if nullif(service_key,'') is null then return -1; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/whatsapp-inbound?worker=sdr',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||service_key),
    body:='{}'::jsonb,timeout_milliseconds:=55000) into request_id;
  return request_id;
end;
$$;
revoke all on function public.trigger_sdr_work() from public,anon,authenticated;
grant execute on function public.trigger_sdr_work() to service_role;
do $$ begin
  if exists(select 1 from pg_namespace where nspname='cron') then
    perform cron.schedule('wisewolf-sdr-work','* * * * *','select public.trigger_sdr_work();');
  end if;
end; $$;

-- Scheduled notices use the same lease as reactive responses. A pending student
-- input always takes priority over reminders/timeout messages.
create or replace function public.claim_sdr_notice(p_tenant_id text,p_phone text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare w public.sdr_conversation_work%rowtype; token uuid:=gen_random_uuid();
begin
  insert into public.sdr_conversation_work(tenant_id,phone,payload,latest_msg_id,completed_msg_id)
  values(p_tenant_id,p_phone,'{}'::jsonb,'','') on conflict(tenant_id,phone) do nothing;
  select * into w from public.sdr_conversation_work where tenant_id=p_tenant_id and phone=p_phone for update;
  if w.phase<>'IDLE' or w.latest_msg_id is distinct from w.completed_msg_id then
    return jsonb_build_object('claimed',false);
  end if;
  update public.sdr_conversation_work set phase='APPLYING',lease_token=token,
    claimed_msg_id=latest_msg_id,lease_until=now()+interval '10 minutes',updated_at=now()
    where tenant_id=p_tenant_id and phone=p_phone;
  return jsonb_build_object('claimed',true,'token',token);
end; $$;
revoke all on function public.claim_sdr_notice(text,text) from public,anon,authenticated;
grant execute on function public.claim_sdr_notice(text,text) to service_role;
