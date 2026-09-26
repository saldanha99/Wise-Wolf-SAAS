begin;

-- A disponibilidade alternativa pertence à professora, não à escolha do aluno.
-- As três transições são atômicas e restritas ao service_role.
create or replace function public.trial_closing_prepare_teacher_alternative(
  p_flow uuid, p_slots jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_flow private.trial_closing_flows%rowtype; v_slots jsonb;
begin
  if pg_catalog.jsonb_typeof(p_slots) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('handled',false);
  end if;
  select * into v_flow from private.trial_closing_flows
   where id=p_flow and tenant_id='school-wise-wolf' and outcome='DONE'
     and stage in ('ASK_TEACHER','ASK_STUDENT') and link_url is null
     and plan ? 'teacher_counterproposal_slots'
     and not plan ? 'teacher_alternative_requested_slots'
   for update;
  if not found then return pg_catalog.jsonb_build_object('handled',false); end if;
  select pg_catalog.coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'day',public.canonical_weekday_name(item.slot->>'day'),
    'time',item.slot->>'time') order by item.ordinality),'[]'::jsonb)
    into v_slots
    from pg_catalog.jsonb_array_elements(p_slots) with ordinality as item(slot,ordinality)
    where public.dow_name_to_int(item.slot->>'day') between 1 and 6
      and pg_catalog.coalesce(item.slot->>'time','') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$';
  if pg_catalog.jsonb_array_length(v_slots) <> (v_flow.plan->>'frequency')::integer
     or v_slots = v_flow.plan->'teacher_counterproposal_slots' then
    return pg_catalog.jsonb_build_object('handled',false);
  end if;
  update private.trial_closing_flows
    set plan=plan || pg_catalog.jsonb_build_object(
      'teacher_alternative_requested_slots',v_slots,
      'teacher_alternative_asked_at',pg_catalog.clock_timestamp()),
      updated_at=pg_catalog.now()
    where id=v_flow.id;
  return pg_catalog.jsonb_build_object('handled',true,'flow_id',v_flow.id,
    'lead_phone',v_flow.lead_phone,'lead_name',v_flow.lead_name);
end $function$;

create or replace function public.trial_closing_expire_teacher_alternatives()
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_count integer;
begin
  update private.trial_closing_flows
    set plan=plan || pg_catalog.jsonb_build_object(
      'teacher_alternative_resolved_at',pg_catalog.clock_timestamp(),
      'teacher_alternative_timed_out',true),
      updated_at=pg_catalog.now()
    where tenant_id='school-wise-wolf' and stage in ('ASK_TEACHER','ASK_STUDENT')
      and outcome='DONE' and link_url is null
      and plan ? 'teacher_counterproposal_slots'
      and plan ? 'teacher_alternative_requested_slots'
      and not plan ? 'teacher_alternative_resolved_at'
      and (plan->>'teacher_alternative_asked_at')::timestamptz
        < pg_catalog.now() - interval '2 hours';
  get diagnostics v_count = row_count;
  return v_count;
end $function$;

create or replace function public.trial_closing_teacher_alternative_reply(
  p_tenant text, p_teacher uuid, p_flow uuid, p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_flow private.trial_closing_flows%rowtype;
begin
  select * into v_flow from private.trial_closing_flows
    where id=p_flow and tenant_id=p_tenant and p_tenant='school-wise-wolf'
      and teacher_id=p_teacher and outcome='DONE'
      and stage in ('ASK_TEACHER','ASK_STUDENT') and link_url is null
      and plan ? 'teacher_counterproposal_slots'
      and plan ? 'teacher_alternative_requested_slots'
      and not plan ? 'teacher_alternative_resolved_at'
    for update;
  if not found then return pg_catalog.jsonb_build_object('handled',false); end if;
  update private.trial_closing_flows
    set plan=(case when p_confirmed then plan || pg_catalog.jsonb_build_object(
      'teacher_alternative_confirmed_slots',plan->'teacher_alternative_requested_slots')
      else plan end) || pg_catalog.jsonb_build_object(
      'teacher_alternative_resolved_at',pg_catalog.clock_timestamp()),
      updated_at=pg_catalog.now()
    where id=v_flow.id;
  return pg_catalog.jsonb_build_object('handled',true,'flow_id',v_flow.id,
    'lead_phone',v_flow.lead_phone,'lead_name',v_flow.lead_name,
    'primary_slots',v_flow.plan->'teacher_counterproposal_slots',
    'alternative_slots',case when p_confirmed then v_flow.plan->'teacher_alternative_requested_slots' else null end,
    'requested_slots',v_flow.plan->'slots');
end $function$;

create or replace function public.trial_closing_student_select_teacher_option(
  p_tenant text, p_phone text, p_flow uuid, p_choice text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_flow private.trial_closing_flows%rowtype; v_slots jsonb; v_plan jsonb; v_result jsonb;
begin
  if p_choice not in ('primary','alternative') then
    return pg_catalog.jsonb_build_object('handled',false);
  end if;
  select * into v_flow from private.trial_closing_flows
    where id=p_flow and tenant_id=p_tenant and p_tenant='school-wise-wolf'
      and private.notification_phones_same_recipient(lead_phone,private.trial_closing_phone(p_phone))
      and outcome='DONE' and stage in ('ASK_TEACHER','ASK_STUDENT')
      and link_url is null and plan ? 'teacher_counterproposal_slots'
      and plan ? 'teacher_alternative_resolved_at'
    for update;
  if not found then return pg_catalog.jsonb_build_object('handled',false); end if;
  v_slots := case p_choice when 'primary' then v_flow.plan->'teacher_counterproposal_slots'
    else v_flow.plan->'teacher_alternative_confirmed_slots' end;
  if pg_catalog.jsonb_typeof(v_slots) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('handled',false);
  end if;
  v_plan := (v_flow.plan - 'teacher_counterproposal_slots' - 'teacher_counterproposal_at'
    - 'teacher_counterproposal_student_claimed_at' - 'teacher_requested_slots'
    - 'teacher_alternative_requested_slots' - 'teacher_alternative_confirmed_slots'
    - 'teacher_alternative_asked_at' - 'teacher_alternative_resolved_at') ||
    pg_catalog.jsonb_build_object('slots',v_slots,'teacher_confirmed_slots',v_slots);
  update private.trial_closing_flows set plan=v_plan,updated_at=pg_catalog.now()
    where id=v_flow.id;
  v_result := public.trial_closing_student_terms(
    p_tenant,p_phone,null,null,null,null,null,null);
  return v_result || pg_catalog.jsonb_build_object('selected_option',p_choice);
end $function$;

alter function public.trial_closing_prepare_teacher_alternative(uuid,jsonb) owner to postgres;
alter function public.trial_closing_expire_teacher_alternatives() owner to postgres;
alter function public.trial_closing_teacher_alternative_reply(text,uuid,uuid,boolean) owner to postgres;
alter function public.trial_closing_student_select_teacher_option(text,text,uuid,text) owner to postgres;
revoke all on function public.trial_closing_prepare_teacher_alternative(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.trial_closing_expire_teacher_alternatives() from public,anon,authenticated;
revoke all on function public.trial_closing_teacher_alternative_reply(text,uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.trial_closing_student_select_teacher_option(text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.trial_closing_prepare_teacher_alternative(uuid,jsonb) to service_role;
grant execute on function public.trial_closing_expire_teacher_alternatives() to service_role;
grant execute on function public.trial_closing_teacher_alternative_reply(text,uuid,uuid,boolean) to service_role;
grant execute on function public.trial_closing_student_select_teacher_option(text,text,uuid,text) to service_role;

-- Enquanto a pergunta alternativa estiver pendente, não ofereça só a opção
-- primária. Depois da resposta, o claim existente entrega uma única proposta.
do $patch_claim$
declare v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_claim_teacher_counterproposal_student(uuid)'::pg_catalog.regprocedure
  ) into v_definition;
  -- A produção pode receber este patch por operação controlada antes de a
  -- migração entrar no histórico da CLI. Reaplicar não deve duplicar filtros.
  if pg_catalog.strpos(v_definition, 'teacher_alternative_resolved_at') > 0
     and pg_catalog.strpos(v_definition, 'teacher_alternative_confirmed_slots') > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_definition,
    'and not flow.plan ? ''teacher_counterproposal_student_claimed_at''') = 0 then
    raise exception 'teacher_counterproposal_claim_definition_changed';
  end if;
  v_definition := pg_catalog.replace(v_definition,
    'and not flow.plan ? ''teacher_counterproposal_student_claimed_at''',
    'and not flow.plan ? ''teacher_counterproposal_student_claimed_at''
    and (not flow.plan ? ''teacher_alternative_requested_slots''
      or flow.plan ? ''teacher_alternative_resolved_at'')');
  v_definition := pg_catalog.replace(v_definition,
    '''slots'',v_flow.plan->''teacher_counterproposal_slots''',
    '''alternative_slots'',v_flow.plan->''teacher_alternative_confirmed_slots'',
    ''slots'',v_flow.plan->''teacher_counterproposal_slots''');
  execute v_definition;
end $patch_claim$;

commit;
