-- An explicit change from 3x to 4x must win over the earlier 3-slot choice.
-- Never ask the teacher about, or confirm, an incomplete recurring schedule.
begin;

do $patch$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_student_terms(text,text,integer,integer,jsonb,date,integer,text)'::pg_catalog.regprocedure
  ) into v_definition;
  v_old := 'if p_frequency between 1 and 6 and not (v_plan ? ''slots'') then
    v_plan := v_plan || pg_catalog.jsonb_build_object(''frequency'', p_frequency);
  end if;';
  v_new := 'if p_frequency between 1 and 6 then
    if nullif(v_plan ->> ''frequency'', '''')::integer is distinct from p_frequency then
      v_plan := v_plan - ''teacher_confirmed_slots'' - ''teacher_requested_slots'' - ''teacher_rejected_slots'';
    end if;
    v_plan := v_plan || pg_catalog.jsonb_build_object(''frequency'', p_frequency);
  end if;';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_student_terms frequency definition changed';
    end if;
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  end if;
  v_old := '''teacher_request_needed'', (v_plan ? ''slots'') and';
  v_new := '''teacher_request_needed'', (v_plan ? ''slots'') and
        pg_catalog.jsonb_array_length(v_plan -> ''slots'') = (v_plan ->> ''frequency'')::integer and';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_student_terms teacher request definition changed';
    end if;
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  end if;
  execute v_definition;

  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_mark_teacher_slots_asked(uuid)'::pg_catalog.regprocedure
  ) into v_definition;
  v_old := 'where id = p_flow and plan ? ''slots'' and stage in';
  v_new := 'where id = p_flow and plan ? ''slots''
     and pg_catalog.jsonb_array_length(plan -> ''slots'') = (plan ->> ''frequency'')::integer
     and stage in';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_mark_teacher_slots_asked definition changed';
    end if;
    execute pg_catalog.replace(v_definition, v_old, v_new);
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_pending_teacher_slots(integer)'::pg_catalog.regprocedure
  ) into v_definition;
  v_old := 'and flow.plan ? ''slots''
      and flow.plan -> ''teacher_confirmed_slots''';
  v_new := 'and flow.plan ? ''slots''
      and pg_catalog.jsonb_array_length(flow.plan -> ''slots'') = (flow.plan ->> ''frequency'')::integer
      and flow.plan -> ''teacher_confirmed_slots''';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_pending_teacher_slots definition changed';
    end if;
    execute pg_catalog.replace(v_definition, v_old, v_new);
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_teacher_slots_reply(text,uuid,boolean,text)'::pg_catalog.regprocedure
  ) into v_definition;
  v_old := 'and plan -> ''teacher_requested_slots'' = plan -> ''slots''
     and plan -> ''teacher_confirmed_slots''';
  v_new := 'and plan -> ''teacher_requested_slots'' = plan -> ''slots''
     and pg_catalog.jsonb_array_length(plan -> ''slots'') = (plan ->> ''frequency'')::integer
     and plan -> ''teacher_confirmed_slots''';
  if pg_catalog.strpos(v_definition, v_new) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'trial_closing_teacher_slots_reply definition changed';
    end if;
    execute pg_catalog.replace(v_definition, v_old, v_new);
  end if;
end;
$patch$;

-- Bind a teacher answer to the exact question the school sent. Another
-- student may have an open question with the same teacher at the same time.
create or replace function public.trial_closing_teacher_slots_reply_for_flow(
  p_tenant text, p_teacher uuid, p_flow uuid, p_confirmed boolean,
  p_origin text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_offer jsonb;
  v_plan jsonb;
begin
  select * into v_flow from private.trial_closing_flows
   where id = p_flow and tenant_id = p_tenant and teacher_id = p_teacher
     and stage in ('ASK_TEACHER', 'ASK_STUDENT') and outcome = 'DONE'
     and plan ? 'slots' and plan ? 'teacher_requested_slots'
     and plan -> 'teacher_requested_slots' = plan -> 'slots'
     and pg_catalog.jsonb_array_length(plan -> 'slots') = (plan ->> 'frequency')::integer
     and plan -> 'teacher_confirmed_slots' is distinct from plan -> 'slots'
   for update;
  if not found then return pg_catalog.jsonb_build_object('handled', false); end if;
  v_plan := v_flow.plan - 'teacher_requested_slots';
  if p_confirmed then
    v_plan := v_plan || pg_catalog.jsonb_build_object('teacher_confirmed_slots', v_flow.plan -> 'slots');
  else
    v_plan := v_plan || pg_catalog.jsonb_build_object('teacher_rejected_slots', v_flow.plan -> 'slots');
  end if;
  update private.trial_closing_flows set plan = v_plan, updated_at = pg_catalog.now()
   where id = v_flow.id;
  if p_confirmed and v_plan ? 'duration' and v_plan ? 'start_date' and v_plan ? 'due_day' then
    v_offer := private.trial_closing_create_offer(v_flow.id, p_origin);
  end if;
  return pg_catalog.jsonb_build_object(
    'handled', true, 'confirmed', p_confirmed, 'flow_id', v_flow.id,
    'lead_phone', v_flow.lead_phone, 'lead_name', v_flow.lead_name,
    'slots', v_flow.plan -> 'slots', 'offer', v_offer
  );
end $function$;

alter function public.trial_closing_teacher_slots_reply_for_flow(text,uuid,uuid,boolean,text) owner to postgres;
revoke all on function public.trial_closing_teacher_slots_reply_for_flow(text,uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.trial_closing_teacher_slots_reply_for_flow(text,uuid,uuid,boolean,text) to service_role;

commit;
