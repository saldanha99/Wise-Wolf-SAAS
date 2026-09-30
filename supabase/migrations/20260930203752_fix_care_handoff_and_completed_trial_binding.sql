-- Care escalation and the inbox fence change together, before external sends.
alter table public.whatsapp_conversations
  add column if not exists handoff_requires_release boolean not null default false;

create or replace function private.clear_care_handoff_release_flag()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not new.handoff_active then new.handoff_requires_release := false; end if;
  return new;
end;
$$;
drop trigger if exists clear_care_handoff_release_flag on public.whatsapp_conversations;
create trigger clear_care_handoff_release_flag before update of handoff_active
on public.whatsapp_conversations for each row
execute function private.clear_care_handoff_release_flag();
revoke all on function private.clear_care_handoff_release_flag() from public,anon,authenticated,service_role;

create or replace function private.care_handoff_inbox_fence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'HANDOFF' and new.subject_role = 'STUDENT' then
    update public.whatsapp_conversations as c
       set handoff_active = true, handoff_requires_release = true,
           human_handoff_until = pg_catalog.now() + interval '72 hours'
     where c.tenant_id = new.tenant_id and c.contact_kind <> 'group'
       and private.notification_phones_same_recipient(c.phone, new.phone);
  end if;
  return new;
end;
$$;
alter function private.care_handoff_inbox_fence() owner to postgres;
revoke all on function private.care_handoff_inbox_fence()
  from public, anon, authenticated, service_role;
drop trigger if exists care_handoff_inbox_fence on public.care_touchpoints;
create trigger care_handoff_inbox_fence after insert or update of status
on public.care_touchpoints for each row
execute function private.care_handoff_inbox_fence();

create or replace function public.care_begin_handoff(
  p_id uuid, p_sentiment text, p_summary text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select c.id into v_id from public.care_touchpoints c
   where c.id = p_id and c.subject_role = 'STUDENT'
     and c.status in ('SENT','REPLIED') for update;
  if v_id is null then return false; end if;
  perform public.care_touchpoint_reply(p_id,'HANDOFF',p_sentiment,p_summary);
  return true;
end;
$$;
alter function public.care_begin_handoff(uuid,text,text) owner to postgres;
revoke all on function public.care_begin_handoff(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.care_begin_handoff(uuid,text,text) to service_role;

-- Proactive care must honor the same inbox fence, including after 72 hours.
create or replace function public.care_touchpoint_open(
  p_tenant text, p_role text, p_subject uuid, p_phone text, p_kind text,
  p_trigger text, p_context jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if exists (
    select 1 from public.whatsapp_conversations c
     where c.tenant_id=p_tenant and c.contact_kind<>'group'
       and private.notification_phones_same_recipient(c.phone,p_phone)
       and c.handoff_active
       and (c.handoff_requires_release or c.human_handoff_until>pg_catalog.now())
  ) then return null; end if;
  insert into public.care_touchpoints
    (tenant_id,subject_role,subject_id,phone,kind,trigger_ref,context,status)
  values(p_tenant,p_role,p_subject,p_phone,p_kind,p_trigger,coalesce(p_context,'{}'::jsonb),'SENT')
  on conflict(tenant_id,subject_role,subject_id,kind,trigger_ref) do nothing
  returning id into v_id;
  return v_id;
end;
$$;


-- Reconcile only an unambiguous, completed, same-tenant lesson. Terminal leads
-- and existing bindings are preserved. Never manufacture an appointment/outcome.
create or replace function public.reconcile_completed_trial_lead(p_tenant text,p_lead uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  l public.crm_leads%rowtype;
  o public.opportunities%rowtype;
  a public.appointments%rowtype;
  candidates uuid[];
  old_values jsonb;
begin
  select * into l from public.crm_leads where id=p_lead and tenant_id=p_tenant;
  if not found then return '{"completed":false}'::jsonb; end if;
  select pg_catalog.array_agg(x.id) into candidates
    from public.opportunities x join public.appointments y on y.id=x.trial_appointment_id
   where x.tenant_id=p_tenant and x.kind='TRIAL' and x.trial_status='DONE'
     and not coalesce(x.is_test_fixture,false)
     and y.tenant_id=p_tenant and y.type='experimental' and y.status='completed'
     and y.start_time < pg_catalog.now()
     and y.teacher_id=coalesce(x.winner_teacher_id,x.professor_id)
     and private.notification_phones_same_recipient(x.student_phone,l.phone)
     and private.notification_phones_same_recipient(y.student_phone,l.phone);
  if coalesce(pg_catalog.cardinality(candidates),0)=0 then
    return '{"completed":false}'::jsonb;
  end if;
  if pg_catalog.cardinality(candidates)<>1 then
    return '{"completed":true,"ambiguous":true}'::jsonb;
  end if;
  perform private.lock_trial_conversion_graph(candidates[1]);
  select * into l from public.crm_leads where id=p_lead and tenant_id=p_tenant for update;
  select * into o from public.opportunities where id=candidates[1];
  select * into a from public.appointments where id=o.trial_appointment_id for share;
  if l.id is null or o.tenant_id<>p_tenant or a.tenant_id<>p_tenant
     or o.trial_status<>'DONE' or a.status<>'completed'
     or a.type<>'experimental' or a.start_time>=pg_catalog.now()
     or coalesce(o.is_test_fixture,false)
     or a.teacher_id<>coalesce(o.winner_teacher_id,o.professor_id)
     or not private.notification_phones_same_recipient(o.student_phone,l.phone)
     or not private.notification_phones_same_recipient(a.student_phone,l.phone) then
    raise exception 'completed_trial_changed';
  end if;
  if l.status in ('WON','LOST') or l.student_id is not null
     or (l.opportunity_id is not null and l.opportunity_id<>o.id)
     or exists (select 1 from public.crm_leads other where other.id<>l.id
       and (other.opportunity_id=o.id or (other.tenant_id=p_tenant
         and private.notification_phones_same_recipient(other.phone,l.phone)))) then
    return '{"completed":true,"preserved":true}'::jsonb;
  end if;
  if l.opportunity_id=o.id and l.trial_lesson_id=a.id and l.status='TRIAL_DONE'
     and l.assigned_teacher_id=a.teacher_id then
    return pg_catalog.jsonb_build_object('completed',true,'changed',false);
  end if;
  old_values:=pg_catalog.jsonb_build_object('opportunity_id',l.opportunity_id,
    'trial_lesson_id',l.trial_lesson_id,'status',l.status,
    'assigned_teacher_id',l.assigned_teacher_id,'scheduled_at',l.scheduled_at);
  perform pg_catalog.set_config('app.crm_trial_binding_lead',l.id::text,true);
  perform pg_catalog.set_config('app.crm_trial_binding_opportunity',o.id::text,true);
  update public.crm_leads set opportunity_id=o.id,trial_lesson_id=a.id,
    assigned_teacher_id=a.teacher_id,scheduled_at=a.start_time,status='TRIAL_DONE'
    where id=l.id;
  perform pg_catalog.set_config('app.crm_trial_binding_lead','',true);
  perform pg_catalog.set_config('app.crm_trial_binding_opportunity','',true);
  insert into public.audit_logs(tenant_id,user_role,action,resource_type,resource_id,old_values,new_values)
    values(p_tenant,'SYSTEM','reconcile_completed_trial_lead','crm_lead',l.id::text,old_values,
      pg_catalog.jsonb_build_object('opportunity_id',o.id,'trial_lesson_id',a.id,
        'status','TRIAL_DONE','assigned_teacher_id',a.teacher_id,'scheduled_at',a.start_time));
  return pg_catalog.jsonb_build_object('completed',true,'changed',true);
end;
$$;
alter function public.reconcile_completed_trial_lead(text,uuid) owner to postgres;
revoke all on function public.reconcile_completed_trial_lead(text,uuid)
  from public,anon,authenticated;
grant execute on function public.reconcile_completed_trial_lead(text,uuid) to service_role;

-- One-time repairs requested by the direction; re-running is a no-op.
do $$
begin
  if exists (select 1 from public.crm_leads where id='61152580-1f3a-4976-af45-87b121263a98'
    and tenant_id='school-wise-wolf' and phone='5511981094481') then
    perform public.reconcile_completed_trial_lead('school-wise-wolf','61152580-1f3a-4976-af45-87b121263a98');
  end if;
  if exists (select 1 from public.care_touchpoints where id='955e5c13-a0df-436c-9ebb-5020307c15d7'
    and tenant_id='school-wise-wolf' and status='HANDOFF') then
    with prior as (
      select c.id,pg_catalog.to_jsonb(c) as old_values from public.whatsapp_conversations c
       where c.id='5a99b49c-21eb-443c-ae4e-9ac4b6550c39' and c.tenant_id='school-wise-wolf'
         and c.handoff_active=false for update
    ), repaired as (
      update public.whatsapp_conversations c set handoff_active=true,handoff_requires_release=true,
        human_handoff_until=pg_catalog.now()+interval '72 hours'
       from prior where c.id=prior.id returning c.id
    )
    insert into public.audit_logs(tenant_id,user_role,action,resource_type,resource_id,old_values,new_values)
      select 'school-wise-wolf','SYSTEM','repair_care_handoff_fence','whatsapp_conversation',r.id::text,
        p.old_values,'{"handoff_active":true,"handoff_requires_release":true}'::jsonb
        from repaired r join prior p on p.id=r.id;
  end if;
end;
$$;
