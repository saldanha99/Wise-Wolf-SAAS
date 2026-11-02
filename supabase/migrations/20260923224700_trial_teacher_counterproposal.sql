begin;

do $patch_terms$
declare v_definition text; v_old text; v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_student_terms(text,text,integer,integer,jsonb,date,integer,text)'::pg_catalog.regprocedure
  ) into v_definition;
  v_old := 'v_plan := v_plan - ''teacher_confirmed_slots'' - ''teacher_requested_slots'' - ''teacher_rejected_slots'';';
  v_new := 'v_plan := v_plan - ''teacher_confirmed_slots'' - ''teacher_requested_slots'' - ''teacher_rejected_slots'' - ''teacher_counterproposal_slots'' - ''teacher_counterproposal_at'' - ''teacher_counterproposal_student_claimed_at'';';
  if pg_catalog.strpos(v_definition,v_old) = 0 then raise exception 'student_terms_reset_definition_changed'; end if;
  execute pg_catalog.replace(v_definition,v_old,v_new);
end $patch_terms$;

create or replace function public.trial_closing_teacher_counterproposal_for_flow(
  p_tenant text, p_teacher uuid, p_flow uuid, p_slots jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_slots jsonb;
begin
  if pg_catalog.jsonb_typeof(p_slots) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('handled', false);
  end if;
  select * into v_flow from private.trial_closing_flows
   where id=p_flow and tenant_id=p_tenant and teacher_id=p_teacher
     and stage in ('ASK_TEACHER','ASK_STUDENT') and outcome='DONE'
     and plan ? 'teacher_requested_slots'
     and plan -> 'teacher_requested_slots' = plan -> 'slots'
     and plan -> 'teacher_confirmed_slots' is distinct from plan -> 'slots'
   for update;
  if not found then return pg_catalog.jsonb_build_object('handled', false); end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'day', public.canonical_weekday_name(item.slot ->> 'day'),
    'time', item.slot ->> 'time'
  ) order by item.ordinality), '[]'::jsonb) into v_slots
  from pg_catalog.jsonb_array_elements(p_slots) with ordinality as item(slot, ordinality)
  where public.dow_name_to_int(item.slot ->> 'day') between 1 and 6
    and coalesce(item.slot ->> 'time','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$';
  if pg_catalog.jsonb_array_length(v_slots) <> (v_flow.plan ->> 'frequency')::integer
     or v_slots = v_flow.plan -> 'slots' then
    return pg_catalog.jsonb_build_object('handled', false);
  end if;
  update private.trial_closing_flows
     set plan = (plan - 'teacher_requested_slots' - 'teacher_counterproposal_student_claimed_at') ||
       pg_catalog.jsonb_build_object(
         'teacher_counterproposal_slots', v_slots,
         'teacher_counterproposal_at', pg_catalog.clock_timestamp()
       ),
         updated_at = pg_catalog.now()
   where id=v_flow.id;
  return pg_catalog.jsonb_build_object(
    'handled',true,'flow_id',v_flow.id,'lead_phone',v_flow.lead_phone,
    'lead_name',v_flow.lead_name,'slots',v_slots
  );
end $function$;

create or replace function public.trial_closing_claim_teacher_counterproposal_student(
  p_flow uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_flow private.trial_closing_flows%rowtype;
begin
  select * into v_flow from private.trial_closing_flows as flow
  where flow.tenant_id='school-wise-wolf'
    and (p_flow is null or flow.id=p_flow)
    and flow.stage in ('ASK_TEACHER','ASK_STUDENT') and flow.outcome='DONE'
    and flow.link_url is null
    and flow.plan ? 'teacher_counterproposal_slots'
    and not flow.plan ? 'teacher_counterproposal_student_claimed_at'
    and not exists (
      select 1 from public.whatsapp_conversations as conversation
      where conversation.tenant_id=flow.tenant_id
        and private.notification_phones_same_recipient(conversation.phone,flow.lead_phone)
        and conversation.handoff_active
        and conversation.human_handoff_until > pg_catalog.now()
    )
    and not exists (
      select 1 from public.whatsapp_messages as msg
      join public.whatsapp_conversations as conversation on conversation.id=msg.conversation_id
      where conversation.tenant_id=flow.tenant_id
        and private.notification_phones_same_recipient(conversation.phone,flow.lead_phone)
        and msg.occurred_at > (flow.plan->>'teacher_counterproposal_at')::timestamptz
    )
  order by flow.updated_at limit 1 for update skip locked;
  if not found then return pg_catalog.jsonb_build_object('claimed',false); end if;
  update private.trial_closing_flows
    set plan=pg_catalog.jsonb_set(plan,'{teacher_counterproposal_student_claimed_at}',
      pg_catalog.to_jsonb(pg_catalog.clock_timestamp()::text),true),
        updated_at=pg_catalog.now()
    where id=v_flow.id;
  return pg_catalog.jsonb_build_object(
    'claimed',true,'flow_id',v_flow.id,'tenant_id',v_flow.tenant_id,
    'lead_phone',v_flow.lead_phone,'lead_name',v_flow.lead_name,
    'teacher_name',(select teacher.full_name from public.profiles as teacher where teacher.id=v_flow.teacher_id),
    'slots',v_flow.plan->'teacher_counterproposal_slots'
  );
end $function$;

create or replace function public.trial_closing_student_counterproposal_decision(
  p_tenant text, p_phone text, p_flow uuid, p_accept boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_plan jsonb;
  v_result jsonb;
begin
  select * into v_flow from private.trial_closing_flows
   where id=p_flow and tenant_id=p_tenant
     and stage in ('ASK_TEACHER','ASK_STUDENT') and outcome='DONE'
     and private.notification_phones_same_recipient(lead_phone,private.trial_closing_phone(p_phone))
     and plan ? 'teacher_counterproposal_slots'
   for update;
  if not found then return pg_catalog.jsonb_build_object('handled', false); end if;
  if p_accept then
    v_plan := (v_flow.plan - 'teacher_counterproposal_slots' - 'teacher_counterproposal_at' - 'teacher_counterproposal_student_claimed_at' - 'teacher_requested_slots' - 'teacher_rejected_slots') ||
      pg_catalog.jsonb_build_object(
        'slots', v_flow.plan -> 'teacher_counterproposal_slots',
        'teacher_confirmed_slots', v_flow.plan -> 'teacher_counterproposal_slots'
      );
  else
    v_plan := (v_flow.plan - 'teacher_counterproposal_slots' - 'teacher_counterproposal_at' - 'teacher_counterproposal_student_claimed_at' - 'teacher_requested_slots') ||
      pg_catalog.jsonb_build_object('teacher_rejected_slots',v_flow.plan -> 'slots');
  end if;
  update private.trial_closing_flows set plan=v_plan, updated_at=pg_catalog.now()
   where id=v_flow.id;
  if not p_accept then
    return pg_catalog.jsonb_build_object('handled',true,'accepted',false,'flow_id',v_flow.id);
  end if;
  v_result := public.trial_closing_student_terms(
    p_tenant,p_phone,null,null,null,null,null,null
  );
  return v_result || pg_catalog.jsonb_build_object('accepted',true);
end $function$;

alter function public.trial_closing_teacher_counterproposal_for_flow(text,uuid,uuid,jsonb) owner to postgres;
alter function public.trial_closing_student_counterproposal_decision(text,text,uuid,boolean) owner to postgres;
alter function public.trial_closing_claim_teacher_counterproposal_student(uuid) owner to postgres;
revoke all on function public.trial_closing_teacher_counterproposal_for_flow(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.trial_closing_student_counterproposal_decision(text,text,uuid,boolean) from public,anon,authenticated;
revoke all on function public.trial_closing_claim_teacher_counterproposal_student(uuid) from public,anon,authenticated;
grant execute on function public.trial_closing_teacher_counterproposal_for_flow(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.trial_closing_student_counterproposal_decision(text,text,uuid,boolean) to service_role;
grant execute on function public.trial_closing_claim_teacher_counterproposal_student(uuid) to service_role;

commit;
