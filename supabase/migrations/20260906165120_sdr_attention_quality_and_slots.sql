-- Operational access follows active school memberships; no client gets raw queue payloads.
create or replace function private.can_manage_sdr(p_tenant_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p where p.id=auth.uid()
    and p.lifecycle_status='active' and (
      p.role='SUPER_ADMIN' or exists (
        select 1 from public.tenant_memberships m where m.user_id=p.id
        and m.tenant_id=p_tenant_id and m.status='ACTIVE'
        and m.role in ('SCHOOL_ADMIN','COORDINATOR','SALESPERSON','COMMERCIAL')
      )
    )
  );
$$;
revoke all on function private.can_manage_sdr(text) from public,anon;
grant execute on function private.can_manage_sdr(text) to authenticated,service_role;

create table if not exists private.sdr_attention_assignments (
  lead_id uuid primary key references public.crm_leads(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  assigned_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table private.sdr_attention_assignments enable row level security;
revoke all on private.sdr_attention_assignments from public,anon,authenticated;

-- The UI never clears an unfinished send, nor replays an uncertain old reply.
create or replace function public.manage_sdr_attention(p_tenant_id text,p_lead_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.crm_leads%rowtype; a private.sdr_attention_assignments%rowtype;
begin
  if not private.can_manage_sdr(p_tenant_id) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_action not in ('take','release') then raise exception 'invalid_action'; end if;
  select * into l from public.crm_leads where tenant_id=p_tenant_id and id=p_lead_id;
  if not found then raise exception 'lead_not_found'; end if;
  -- Same lock order as the worker: conversation first, lead second.
  if nullif(regexp_replace(l.phone,'[^0-9]','','g'),'') is not null then
    insert into public.sdr_conversation_work(tenant_id,phone,payload,latest_msg_id,completed_msg_id)
      values(l.tenant_id,regexp_replace(l.phone,'[^0-9]','','g'),'{}','','') on conflict do nothing;
  end if;
  perform 1 from public.sdr_conversation_work w where w.tenant_id=l.tenant_id
    and w.phone=regexp_replace(l.phone,'[^0-9]','','g') for update;
  select * into l from public.crm_leads where tenant_id=p_tenant_id and id=p_lead_id for update;
  if not found then raise exception 'lead_not_found'; end if;
  select * into a from private.sdr_attention_assignments where lead_id=l.id;
  if a.resolved_at is null and a.owner_id is not null and a.owner_id<>auth.uid() and a.assigned_at>now()-interval '72 hours' then
    return jsonb_build_object('ok',false,'error','already_assigned');
  end if;
  if p_action='take' then
    if exists(select 1 from public.sdr_conversation_work w where w.tenant_id=l.tenant_id
      and w.phone=regexp_replace(l.phone,'[^0-9]','','g') and w.phase='APPLYING' and w.lease_until>now()) then
      return jsonb_build_object('ok',false,'error','send_in_progress');
    end if;
    update public.sdr_conversation_work set phase='IDLE',lease_token=null,lease_until=null
      where tenant_id=l.tenant_id and phone=regexp_replace(l.phone,'[^0-9]','','g') and phase='GENERATING';
    insert into private.sdr_attention_assignments(lead_id,tenant_id,owner_id,assigned_at)
    values(l.id,l.tenant_id,auth.uid(),now()) on conflict(lead_id)
    do update set owner_id=excluded.owner_id,assigned_at=excluded.assigned_at,resolved_at=null;
    update public.crm_leads set ai_handoff=true,ai_handoff_at=now() where id=l.id;
  else
    if a.owner_id is null or a.resolved_at is not null then return jsonb_build_object('ok',false,'error','take_first'); end if;
    perform 1 from public.sdr_conversation_work w where w.tenant_id=l.tenant_id
      and w.phone=regexp_replace(l.phone,'[^0-9]','','g') for update;
    if exists(select 1 from public.sdr_conversation_work w where w.tenant_id=l.tenant_id
      and w.phone=regexp_replace(l.phone,'[^0-9]','','g') and w.lease_until>now()) then
      return jsonb_build_object('ok',false,'error','send_in_progress');
    end if;
    update public.sdr_conversation_work set phase='IDLE',completed_msg_id=latest_msg_id,
      claimed_msg_id=latest_msg_id,lease_token=null,lease_until=null,attempts=0,updated_at=now()
      where tenant_id=l.tenant_id and phone=regexp_replace(l.phone,'[^0-9]','','g');
    update public.crm_leads set ai_handoff=false,ai_handoff_at=null where id=l.id;
    update private.sdr_attention_assignments set resolved_at=now() where lead_id=l.id;
  end if;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.manage_sdr_attention(text,uuid,text) from public,anon,authenticated;
grant execute on function public.manage_sdr_attention(text,uuid,text) to authenticated;

create index if not exists ai_wa_sdr_quality_idx on public.ai_wa_messages(tenant_id,created_at,phone)
  where agent='sdr';

create or replace function public.sdr_operations_dashboard(p_tenant_id text,p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; since_at timestamptz;
begin
  if not private.can_manage_sdr(p_tenant_id) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_days not in (7,30) then raise exception 'invalid_period'; end if;
  since_at:=now()-make_interval(days=>p_days);
  with cohort as (
    select l.* from public.crm_leads l where l.tenant_id=p_tenant_id and l.ai_handled=true and l.created_at>=since_at
  ), messages as (
    select m.*,lag(m.content) over(partition by m.phone order by m.created_at,m.id) previous_content,
      lag(m.created_at) over(partition by m.phone order by m.created_at,m.id) previous_at
    from public.ai_wa_messages m where m.tenant_id=p_tenant_id and m.agent='sdr'
      and m.direction='out' and m.created_at>=since_at and m.meta->>'entregue'='true'
  ), queue as (
    select l.id,l.name,l.phone,l.status,
      case when w.phase='REVIEW' then 'delivery_review'
        when l.ai_handoff=true and (l.ai_handoff_at is null or l.ai_handoff_at>now()-interval '72 hours') then 'human_requested'
        when w.latest_msg_id is distinct from w.completed_msg_id and w.updated_at<now()-interval '10 minutes' then 'unanswered'
        when o.status='EXPIRED' and o.lost_reason is null and o.opened_at>now()-interval '3 days' then 'teacher_timeout'
        when r.status in ('DECLINED','CONFLICT') then 'teacher_declined'
        when l.status in ('SCHEDULED','TRIAL') and ap.start_time<now()-interval '2 hours'
          and not exists(select 1 from public.class_logs cl where cl.appointment_id=ap.id::text) then 'missing_class_result'
      end reason,
      case when w.phase='REVIEW' then w.updated_at
        when l.ai_handoff=true then coalesce(l.ai_handoff_at,l.last_status_change,l.created_at)
        when w.latest_msg_id is distinct from w.completed_msg_id then w.updated_at
        when o.status='EXPIRED' then o.opened_at+interval '60 minutes'
        when r.status in ('DECLINED','CONFLICT') then r.responded_at else ap.start_time end waiting_since,
      case when a.resolved_at is null and a.assigned_at>now()-interval '72 hours' then a.owner_id end owner_id,
      case when a.resolved_at is null and a.assigned_at>now()-interval '72 hours' then p.full_name end owner_name,a.resolved_at,
      case when w.phase='REVIEW' then 1 when l.ai_handoff=true then 2 else 3 end priority
    from public.crm_leads l
    left join public.sdr_conversation_work w on w.tenant_id=l.tenant_id and w.phone=regexp_replace(l.phone,'[^0-9]','','g')
    left join lateral (select oo.* from public.opportunities oo where oo.tenant_id=l.tenant_id and oo.kind='TRIAL' and not coalesce(oo.is_test_fixture,false)
      and (oo.id=l.opportunity_id or (l.opportunity_id is null and regexp_replace(oo.student_phone,'[^0-9]','','g')=regexp_replace(l.phone,'[^0-9]','','g')))
      and oo.created_at>now()-interval '30 days' order by oo.created_at desc limit 1) o on true
    left join public.appointments ap on ap.id=o.trial_appointment_id and ap.tenant_id=l.tenant_id
    left join lateral(select rr.status,rr.responded_at from public.trial_reschedule_requests rr
      where rr.tenant_id=l.tenant_id and rr.lead_id=l.id order by rr.created_at desc limit 1) r on true
    left join private.sdr_attention_assignments a on a.lead_id=l.id
    left join public.profiles p on p.id=a.owner_id
    where l.tenant_id=p_tenant_id and l.ai_handled=true and l.status not in ('WON','LOST')
  ), actionable as (select * from queue where reason is not null and (resolved_at is null or waiting_since>resolved_at)), acceptance as (
    select extract(epoch from(o.claimed_at-o.opened_at))/60 minutes from public.opportunities o
      where o.tenant_id=p_tenant_id and o.kind='TRIAL' and o.opened_at>=since_at and o.claimed_at>=o.opened_at and not coalesce(o.is_test_fixture,false)
      and exists(select 1 from public.crm_leads l where l.tenant_id=o.tenant_id and l.ai_handled=true
        and (l.opportunity_id=o.id or regexp_replace(l.phone,'[^0-9]','','g')=regexp_replace(o.student_phone,'[^0-9]','','g')))
    union all
    select extract(epoch from(r.responded_at-r.created_at))/60 from public.trial_reschedule_requests r
      where r.tenant_id=p_tenant_id and r.created_at>=since_at and r.status='ACCEPTED' and r.responded_at>=r.created_at
      and exists(select 1 from public.crm_leads l where l.id=r.lead_id and l.tenant_id=r.tenant_id and l.ai_handled=true)
  )
  select jsonb_build_object('generated_at',now(),'viewer_id',auth.uid(),'days',p_days,'metrics',jsonb_build_object(
    'leads', (select count(*) from cohort),
    'trials', (select count(*) from cohort c where exists(select 1 from public.opportunities o where o.id=c.opportunity_id and o.tenant_id=c.tenant_id and o.kind='TRIAL' and o.trial_appointment_id is not null)),
    'enrollments',(select count(*) from cohort where status='WON'),
    'unanswered',(select count(*) from actionable where reason='unanswered'),
    'attention',(select count(*) from actionable),
    'sent',(select count(*) from messages),
    'suspected_duplicates',(select count(*) from messages where previous_at>created_at-interval '5 minutes'
      and length(regexp_replace(content,'[^[:alnum:]]','','g'))>0
      and lower(regexp_replace(content,'[^[:alnum:]]','','g'))=lower(regexp_replace(previous_content,'[^[:alnum:]]','','g'))),
    'acceptance_minutes',(select round(avg(minutes)::numeric,1) from acceptance),
    'acceptance_samples',(select count(*) from acceptance),
    'delivery_failures',(select count(*) from public.ai_wa_messages m where m.tenant_id=p_tenant_id and m.agent='sdr'
      and m.direction='out' and m.created_at>=since_at and (m.meta->>'entregue'='false' or m.meta->>'delivery_outcome' in ('rejected','ambiguous')))
  ),'attention',coalesce((select jsonb_agg(to_jsonb(q) order by q.priority,q.waiting_since) from
      (select * from actionable order by priority,waiting_since limit 100) q),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.sdr_operations_dashboard(text,integer) from public,anon,authenticated;
grant execute on function public.sdr_operations_dashboard(text,integer) to authenticated;

-- Single availability source for conversational offers and teacher reminders.
-- Service-only wrapper is necessary to consult private financial slot reservations.
create or replace function public.sdr_available_trial_slots(p_tenant_id text,p_from date,p_days integer default 14,p_teacher_id uuid default null)
returns table("date" text,"time" text,teacher_id uuid,teacher_name text,phone text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_days not between 1 and 14 or p_from is null
    or p_from<(now() at time zone 'America/Sao_Paulo')::date
    or p_from>(now() at time zone 'America/Sao_Paulo')::date+90 then raise exception 'invalid_date_range'; end if;
  return query
  with candidates as (
    select distinct d::date as slot_date,a.start_time,p.id,p.full_name,p.phone,
      (d::date+a.start_time) at time zone 'America/Sao_Paulo' starts
    from generate_series(p_from::timestamp,(p_from+p_days-1)::timestamp,interval '1 day') d
    join public.teacher_availability a on a.tenant_id=p_tenant_id and a.day_of_week=extract(dow from d)::integer
    join public.profiles p on p.id=a.teacher_id and p.lifecycle_status='active'
    join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p_tenant_id and m.role='TEACHER' and m.status='ACTIVE'
    where (p_teacher_id is null or p.id=p_teacher_id) and nullif(trim(p.phone),'') is not null
      and coalesce(p.status,'') not in ('Inativo','INACTIVE','Inactive','Arquivado','Cancelado','Trancado')
      and a.day_of_week between 1 and 6 and a.start_time between time '07:00' and time '21:30'
  ) select to_char(c.slot_date,'YYYY-MM-DD'),to_char(c.start_time,'HH24:MI'),c.id,c.full_name,c.phone from candidates c
  where c.starts>now()
    and not private.secure_trial_schedule_conflict(p_tenant_id,c.id,c.starts,null,null)
    and not exists(select 1 from public.bookings b where b.tenant_id=p_tenant_id and b.teacher_id=c.id
      and b.date=c.slot_date and lower(coalesce(b.status,'scheduled')) not in ('cancelled','canceled','inactive')
      and left(b.time_slot,5)~'^[0-2][0-9]:[0-5][0-9]$'
      and abs(extract(epoch from (left(b.time_slot,5)::time-c.start_time)))<1800)
    and not exists(select 1 from private.enrollment_offer_schedule_slots s where s.tenant_id=p_tenant_id and s.teacher_id=c.id
      and s.status='RESERVED' and s.reservation_expires_at>now() and s.day_of_week=extract(dow from c.slot_date)::integer
      and s.start_date<=c.slot_date and abs(extract(epoch from (s.class_time-c.start_time)))<1800)
    and not exists(select 1 from public.reschedules r where r.tenant_id=p_tenant_id and r.teacher_id=c.id and r.used_at is null
      and r.date=c.slot_date::text and left(r.time,5)~'^[0-2][0-9]:[0-5][0-9]$'
      and abs(extract(epoch from (left(r.time,5)::time-c.start_time)))<1800)
    and not exists(select 1 from public.class_coverages cc where cc.tenant_id=p_tenant_id and cc.cover_teacher_id=c.id
      and cc.class_date=c.slot_date and upper(cc.status) in ('PENDING','CONFIRMED','ACCEPTED','COMPLETED')
      and left(cc.class_time,5)~'^[0-2][0-9]:[0-5][0-9]$'
      and abs(extract(epoch from (left(cc.class_time,5)::time-c.start_time)))<1800)
  order by 1,2,3;
end;
$$;
revoke all on function public.sdr_available_trial_slots(text,date,integer,uuid) from public,anon,authenticated;
grant execute on function public.sdr_available_trial_slots(text,date,integer,uuid) to service_role;

notify pgrst,'reload schema';
