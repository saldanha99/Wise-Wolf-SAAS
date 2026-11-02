-- Post-trial sales may continue without a complete pedagogical score, but an
-- offer requires explicit student terms and the teacher's slot confirmation.
-- The fee is waived at claim time if signing is within seven days of start.
begin;

do $patch_create_offer$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'private.trial_closing_create_offer(uuid,text)'::pg_catalog.regprocedure
  ) into v_definition;
  if pg_catalog.strpos(coalesce(v_definition, ''), 'teacher_confirmation_required') > 0
     and pg_catalog.strpos(v_definition, 'v_fee numeric') > 0
     and pg_catalog.strpos(v_definition, 'pg_catalog.least(v_due_day,') > 0 then
    return;
  end if;
  if pg_catalog.strpos(coalesce(v_definition, ''), 'teacher_confirmation_required') > 0
     and pg_catalog.strpos(v_definition, 'v_fee numeric') > 0 then
    v_definition := pg_catalog.replace(v_definition,
      $$extract(month from v_start)::integer, v_due_day$$,
      $$extract(month from v_start)::integer,
        pg_catalog.least(v_due_day, extract(day from
          (pg_catalog.date_trunc('month', v_start)::date + interval '1 month - 1 day')
        )::integer)$$
    );
    execute v_definition;
    return;
  end if;
  if v_definition is null
    or pg_catalog.strpos(v_definition, 'v_due_day integer := 10') = 0
    or pg_catalog.strpos(v_definition, 'v_start := private.trial_closing_start_date(v_slots);') = 0
    or pg_catalog.strpos(v_definition, $$'enrollmentFee', 0$$) = 0
  then
    raise exception 'trial_closing_create_offer_definition_changed';
  end if;
  v_definition := pg_catalog.replace(v_definition,
    'v_due_day integer := 10',
    'v_due_day integer; v_fee numeric; v_today date := (pg_catalog.clock_timestamp() at time zone ''America/Sao_Paulo'')::date'
  );
  v_definition := pg_catalog.replace(v_definition,
    'v_start := private.trial_closing_start_date(v_slots);',
    $replacement$
  if v_flow.tenant_id = 'school-wise-wolf' then
  if v_flow.outcome is distinct from 'DONE' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'trial_not_done');
  end if;
  if v_flow.plan -> 'teacher_confirmed_slots' is distinct from v_slots then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'teacher_confirmation_required');
  end if;
  if coalesce(v_flow.plan ->> 'start_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(v_flow.plan ->> 'due_day', '') !~ '^[0-9]{1,2}$' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'commercial_terms_incomplete');
  end if;
  begin
    v_start := (v_flow.plan ->> 'start_date')::date;
    v_due_day := (v_flow.plan ->> 'due_day')::integer;
  exception when others then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'commercial_terms_invalid');
  end;
  if v_start < v_today or v_start > v_today + 365 or v_due_day not between 1 and 31
     or not exists (
       select 1 from pg_catalog.jsonb_array_elements(v_slots) as chosen(slot)
       where public.dow_name_to_int(chosen.slot ->> 'day') = extract(isodow from v_start)::integer
     ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'commercial_terms_invalid');
  end if;
  v_fee := case when v_start <= v_today + 7 then 0 else 49.90 end;
  else
    v_start := private.trial_closing_start_date(v_slots);
    v_due_day := 10;
    v_fee := 0;
  end if;
    $replacement$
  );
  v_definition := pg_catalog.replace(v_definition,
    $$'enrollmentFee', 0$$, $$'enrollmentFee', v_fee$$);
  v_definition := pg_catalog.replace(v_definition,
    $$extract(month from v_start)::integer, v_due_day$$,
    $$extract(month from v_start)::integer,
      pg_catalog.least(v_due_day, extract(day from
        (pg_catalog.date_trunc('month', v_start)::date + interval '1 month - 1 day')
      )::integer)$$
  );
  v_definition := pg_catalog.replace(v_definition,
    $$'billingStartMonth', v_billing_month,$$,
    $$'billingStartMonth', v_billing_month,
      'module', v_flow.teacher_feedback ->> 'level',$$
  );
  v_definition := pg_catalog.replace(v_definition,
    $$v_duration::text || ':' || v_slots::text$$,
    $$v_duration::text || ':' || v_slots::text || ':' || v_start::text || ':' || v_due_day::text$$
  );
  v_definition := pg_catalog.replace(v_definition,
    $$'start_date', pg_catalog.to_char(v_start, 'DD/MM')$$,
    $$'start_date', pg_catalog.to_char(v_start, 'DD/MM'),
    'due_day', v_due_day, 'enrollment_fee', v_fee$$
  );
  execute v_definition;
end;
$patch_create_offer$;

create or replace function public.trial_closing_student_terms(
  p_tenant text, p_phone text, p_frequency integer, p_duration integer,
  p_slots jsonb, p_start_date date, p_due_day integer, p_origin text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_plan jsonb;
  v_slots jsonb;
  v_need text[] := array[]::text[];
  v_offer jsonb;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  select * into v_flow from private.trial_closing_flows
   where tenant_id = p_tenant and p_tenant = 'school-wise-wolf'
     and stage in ('ASK_TEACHER', 'ASK_STUDENT')
     and outcome = 'DONE'
     and private.notification_phones_same_recipient(lead_phone, private.trial_closing_phone(p_phone))
   order by created_at desc limit 1 for update;
  if not found then return pg_catalog.jsonb_build_object('handled', false); end if;
  v_plan := coalesce(v_flow.plan, '{}'::jsonb);
  if pg_catalog.jsonb_typeof(p_slots) = 'array' and pg_catalog.jsonb_array_length(p_slots) > 0 then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'day', public.canonical_weekday_name(item.slot ->> 'day'),
      'time', item.slot ->> 'time'
    ) order by item.ordinality), '[]'::jsonb) into v_slots
    from pg_catalog.jsonb_array_elements(p_slots) with ordinality as item(slot, ordinality)
    where public.dow_name_to_int(item.slot ->> 'day') between 1 and 6
      and coalesce(item.slot ->> 'time', '') ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$';
    if pg_catalog.jsonb_array_length(v_slots) = pg_catalog.jsonb_array_length(p_slots) then
      if v_slots is distinct from v_plan -> 'slots' then
        v_plan := v_plan - 'teacher_confirmed_slots' - 'teacher_requested_slots' - 'teacher_rejected_slots';
      end if;
      v_plan := v_plan || pg_catalog.jsonb_build_object(
        'slots', v_slots, 'frequency', pg_catalog.jsonb_array_length(v_slots));
    end if;
  end if;
  if p_frequency between 1 and 6 and not (v_plan ? 'slots') then
    v_plan := v_plan || pg_catalog.jsonb_build_object('frequency', p_frequency);
  end if;
  if p_duration in (1, 6, 12) then
    v_plan := v_plan || pg_catalog.jsonb_build_object('duration', p_duration);
  end if;
  if p_start_date is not null and p_start_date between v_today and v_today + 365 then
    v_plan := v_plan || pg_catalog.jsonb_build_object('start_date', p_start_date);
  end if;
  if p_due_day between 1 and 31 then
    v_plan := v_plan || pg_catalog.jsonb_build_object('due_day', p_due_day);
  end if;
  update private.trial_closing_flows set plan = v_plan, updated_at = pg_catalog.now()
   where id = v_flow.id;

  if pg_catalog.jsonb_typeof(v_plan -> 'slots') is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_plan -> 'slots') <> coalesce((v_plan ->> 'frequency')::integer, -1)
     or v_plan -> 'teacher_rejected_slots' = v_plan -> 'slots'
  then v_need := pg_catalog.array_append(v_need, 'horarios'); end if;
  if not (v_plan ? 'duration') then v_need := pg_catalog.array_append(v_need, 'plano'); end if;
  if not (v_plan ? 'start_date') then v_need := pg_catalog.array_append(v_need, 'inicio'); end if;
  if not (v_plan ? 'due_day') then v_need := pg_catalog.array_append(v_need, 'vencimento'); end if;
  if (v_plan ? 'slots') and v_plan -> 'teacher_confirmed_slots' is distinct from v_plan -> 'slots'
     and v_plan -> 'teacher_rejected_slots' is distinct from v_plan -> 'slots' then
    v_need := pg_catalog.array_append(v_need, 'professora');
  end if;
  if pg_catalog.array_length(v_need, 1) > 0 then
    return pg_catalog.jsonb_build_object(
      'handled', true, 'flow_id', v_flow.id, 'lead_name', v_flow.lead_name,
      'need', pg_catalog.to_jsonb(v_need), 'frequency', v_plan -> 'frequency',
      'slots', v_plan -> 'slots', 'prices', private.trial_closing_prices(p_tenant),
      'teacher_id', v_flow.teacher_id,
      'teacher_request_needed', (v_plan ? 'slots') and
        v_plan -> 'teacher_requested_slots' is distinct from v_plan -> 'slots'
        and v_plan -> 'teacher_rejected_slots' is distinct from v_plan -> 'slots'
    );
  end if;
  v_offer := private.trial_closing_create_offer(v_flow.id, p_origin);
  return pg_catalog.jsonb_build_object(
    'handled', true, 'flow_id', v_flow.id, 'lead_name', v_flow.lead_name,
    'offer', v_offer
  );
end $function$;

create or replace function public.trial_closing_mark_teacher_slots_asked(p_flow uuid)
returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  update private.trial_closing_flows
     set plan = plan || pg_catalog.jsonb_build_object('teacher_requested_slots', plan -> 'slots'),
         updated_at = pg_catalog.now()
   where id = p_flow and plan ? 'slots' and stage in ('ASK_TEACHER', 'ASK_STUDENT')
     and plan -> 'teacher_confirmed_slots' is distinct from plan -> 'slots';
  return found;
end $function$;

create or replace function public.trial_closing_pending_teacher_slots(p_limit integer default 10)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'flow_id', pending.id,
    'tenant_id', pending.tenant_id,
    'teacher_phone', teacher.phone,
    'teacher_name', teacher.full_name,
    'lead_name', pending.lead_name,
    'slots', pending.plan -> 'slots'
  )), '[]'::jsonb)
  from (
    select flow.* from private.trial_closing_flows as flow
    where flow.tenant_id = 'school-wise-wolf'
      and flow.stage in ('ASK_TEACHER', 'ASK_STUDENT') and flow.outcome = 'DONE'
      and flow.plan ? 'slots'
      and flow.plan -> 'teacher_confirmed_slots' is distinct from flow.plan -> 'slots'
      and flow.plan -> 'teacher_requested_slots' is distinct from flow.plan -> 'slots'
      and flow.plan -> 'teacher_rejected_slots' is distinct from flow.plan -> 'slots'
    order by flow.updated_at
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
  ) as pending
  join public.profiles as teacher on teacher.id = pending.teacher_id
  where teacher.phone is not null;
$function$;

create or replace function public.trial_closing_teacher_slots_reply(
  p_tenant text, p_teacher uuid, p_confirmed boolean, p_origin text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_flow private.trial_closing_flows%rowtype; v_offer jsonb; v_plan jsonb;
begin
  select * into v_flow from private.trial_closing_flows
   where tenant_id = p_tenant and teacher_id = p_teacher
     and stage in ('ASK_TEACHER', 'ASK_STUDENT')
     and outcome = 'DONE'
     and plan ? 'teacher_requested_slots'
     and plan -> 'teacher_requested_slots' = plan -> 'slots'
     and plan -> 'teacher_confirmed_slots' is distinct from plan -> 'slots'
   order by updated_at desc limit 1 for update;
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

-- Retry only a provider-rejected delivery. An absent log is ambiguous, so it
-- is deliberately not retried automatically (avoids a duplicate link).
create or replace function public.trial_closing_failed_offer_deliveries(p_limit integer default 10)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'tenant_id', candidate.tenant_id,
    'lead_phone', candidate.lead_phone,
    'lead_name', candidate.lead_name,
    'flow_id', candidate.id,
    'offer', pg_catalog.jsonb_build_object(
      'offer_id', candidate.offer_id,
      'url', candidate.link_url,
      'value', offer.payload -> 'value',
      'frequency', candidate.plan -> 'frequency',
      'duration', candidate.plan -> 'duration',
      'slots', candidate.plan -> 'slots',
      'start_date', pg_catalog.to_char((candidate.plan ->> 'start_date')::date, 'DD/MM'),
      'due_day', candidate.plan -> 'due_day',
      'enrollment_fee', offer.enrollment_fee
    )
  )), '[]'::jsonb)
  from (
    select flow.* from private.trial_closing_flows as flow
    where flow.tenant_id = 'school-wise-wolf' and flow.stage = 'OFFER_SENT'
      and flow.offer_id is not null and flow.link_url is not null
      and not exists (
        select 1 from public.ai_wa_messages as sent
        where sent.tenant_id = flow.tenant_id
          and sent.meta ->> 'offer_id' = flow.offer_id::text
          and sent.meta ->> 'entregue' = 'true'
      )
      and not exists (
        select 1 from public.ai_wa_messages as uncertain
        where uncertain.tenant_id = flow.tenant_id
          and uncertain.meta ->> 'offer_id' = flow.offer_id::text
          and uncertain.meta ->> 'delivery_outcome' = 'ambiguous'
      )
      and exists (
        select 1 from public.ai_wa_messages as failed
        where failed.tenant_id = flow.tenant_id
          and failed.meta ->> 'offer_id' = flow.offer_id::text
          and failed.meta ->> 'entregue' = 'false'
          and failed.meta ->> 'delivery_outcome' = 'rejected'
        group by failed.meta ->> 'offer_id'
        having pg_catalog.count(*) < 3
          and pg_catalog.max(failed.created_at) < pg_catalog.now() - interval '5 minutes'
      )
    order by flow.updated_at
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
  ) as candidate
  join public.offers as offer on offer.id = candidate.offer_id
  where offer.revoked_at is null and offer.consumed_at is null
    and offer.expires_at > pg_catalog.now();
$function$;

alter function public.trial_closing_student_terms(text,text,integer,integer,jsonb,date,integer,text) owner to postgres;
alter function public.trial_closing_mark_teacher_slots_asked(uuid) owner to postgres;
alter function public.trial_closing_pending_teacher_slots(integer) owner to postgres;
alter function public.trial_closing_teacher_slots_reply(text,uuid,boolean,text) owner to postgres;
alter function public.trial_closing_failed_offer_deliveries(integer) owner to postgres;
revoke all on function public.trial_closing_student_terms(text,text,integer,integer,jsonb,date,integer,text) from public, anon, authenticated;
revoke all on function public.trial_closing_mark_teacher_slots_asked(uuid) from public, anon, authenticated;
revoke all on function public.trial_closing_pending_teacher_slots(integer) from public, anon, authenticated;
revoke all on function public.trial_closing_teacher_slots_reply(text,uuid,boolean,text) from public, anon, authenticated;
revoke all on function public.trial_closing_failed_offer_deliveries(integer) from public, anon, authenticated;
grant execute on function public.trial_closing_student_terms(text,text,integer,integer,jsonb,date,integer,text) to service_role;
grant execute on function public.trial_closing_mark_teacher_slots_asked(uuid) to service_role;
grant execute on function public.trial_closing_pending_teacher_slots(integer) to service_role;
grant execute on function public.trial_closing_teacher_slots_reply(text,uuid,boolean,text) to service_role;
grant execute on function public.trial_closing_failed_offer_deliveries(integer) to service_role;

-- The offer is displayed before the student signs. Show the fee that would
-- apply today, and apply the same rule authoritatively at claim/signature.
do $rename_public_offer$
begin
  if pg_catalog.to_regprocedure('public.get_offer_public_pre_trial_fee_impl(uuid)') is null then
    alter function public.get_offer_public(uuid) rename to get_offer_public_pre_trial_fee_impl;
  end if;
  if pg_catalog.to_regprocedure('public.claim_enrollment_offer_pre_trial_fee_impl(uuid,jsonb)') is null then
    alter function public.claim_enrollment_offer(uuid,jsonb) rename to claim_enrollment_offer_pre_trial_fee_impl;
  end if;
end;
$rename_public_offer$;

revoke all on function public.get_offer_public_pre_trial_fee_impl(uuid) from public, anon, authenticated;
revoke all on function public.claim_enrollment_offer_pre_trial_fee_impl(uuid,jsonb) from public, anon, authenticated;

create or replace function public.get_offer_public(p_offer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_result jsonb;
  v_start date;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  v_result := public.get_offer_public_pre_trial_fee_impl(p_offer_id);
  if v_result ? 'error' then return v_result; end if;
  select (flow.plan ->> 'start_date')::date into v_start
    from private.trial_closing_flows as flow
   where flow.offer_id = p_offer_id and flow.plan ? 'start_date'
   limit 1;
  if v_start is not null and v_start <= v_today + 7 then
    return v_result || pg_catalog.jsonb_build_object('enrollmentFee', 0);
  end if;
  return v_result;
end $function$;

create or replace function public.claim_enrollment_offer(p_offer_id uuid, p_profile jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_opportunity uuid;
  v_start date;
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
  if (select auth.uid()) is null then
    return pg_catalog.jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  end if;
  select offer.opportunity_id into v_opportunity from public.offers as offer where offer.id = p_offer_id;
  if v_opportunity is not null then
    perform 1 from public.opportunities as opportunity where opportunity.id = v_opportunity for update;
  end if;
  perform 1 from public.offers as offer where offer.id = p_offer_id for update;
  select (flow.plan ->> 'start_date')::date into v_start
    from private.trial_closing_flows as flow
   where flow.offer_id = p_offer_id and flow.plan ? 'start_date'
   limit 1;
  if v_start is not null and v_start <= v_today + 7 then
    update public.offers as offer
       set enrollment_fee = 0,
           payload = pg_catalog.jsonb_set(coalesce(offer.payload, '{}'::jsonb),
             '{enrollmentFee}', '0'::jsonb, true)
     where offer.id = p_offer_id and offer.enrollment_fee > 0
       and offer.consumed_at is null and offer.revoked_at is null;
  end if;
  return public.claim_enrollment_offer_pre_trial_fee_impl(p_offer_id, p_profile);
end $function$;

alter function public.get_offer_public(uuid) owner to postgres;
alter function public.claim_enrollment_offer(uuid,jsonb) owner to postgres;
revoke all on function public.get_offer_public(uuid) from public, anon, authenticated;
revoke all on function public.claim_enrollment_offer(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.get_offer_public(uuid) to anon, authenticated;
grant execute on function public.claim_enrollment_offer(uuid,jsonb) to authenticated;

commit;
