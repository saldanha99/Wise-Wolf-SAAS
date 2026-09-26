-- PostgreSQL interpreted text[] || 'interesse' as an array literal and
-- rejected partial teacher feedback. Preserve the existing security-definer
-- body and grants while replacing only the three faulty array appends.
do $migration$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_teacher_reply(text,uuid,text,text,integer,text)'::pg_catalog.regprocedure
  ) into v_definition;
  if v_definition is null then
    raise exception 'trial_closing_teacher_reply_missing';
  end if;
  if pg_catalog.strpos(v_definition, $needle$v_missing := pg_catalog.array_append(v_missing, 'nivel')$needle$) > 0
    and pg_catalog.strpos(v_definition, $needle$v_missing := pg_catalog.array_append(v_missing, 'interesse')$needle$) > 0
    and pg_catalog.strpos(v_definition, $needle$v_missing := pg_catalog.array_append(v_missing, 'frequencia')$needle$) > 0
  then
    return;
  end if;
  if pg_catalog.strpos(v_definition, $needle$v_missing := v_missing || 'nivel'$needle$) = 0
    or pg_catalog.strpos(v_definition, $needle$v_missing := v_missing || 'interesse'$needle$) = 0
    or pg_catalog.strpos(v_definition, $needle$v_missing := v_missing || 'frequencia'$needle$) = 0
  then
    raise exception 'trial_closing_teacher_reply_definition_changed';
  end if;

  v_definition := pg_catalog.replace(
    v_definition,
    $needle$v_missing := v_missing || 'nivel'$needle$,
    $needle$v_missing := pg_catalog.array_append(v_missing, 'nivel')$needle$
  );
  v_definition := pg_catalog.replace(
    v_definition,
    $needle$v_missing := v_missing || 'interesse'$needle$,
    $needle$v_missing := pg_catalog.array_append(v_missing, 'interesse')$needle$
  );
  v_definition := pg_catalog.replace(
    v_definition,
    $needle$v_missing := v_missing || 'frequencia'$needle$,
    $needle$v_missing := pg_catalog.array_append(v_missing, 'frequencia')$needle$
  );
  execute v_definition;
end;
$migration$;

-- Partial teacher observations may be shared in the sales conversation even
-- while the interest score is missing. They do not count as complete feedback
-- and cannot unlock an offer or enrollment link.
create or replace function public.trial_closing_student_context(
  p_tenant text,
  p_phone text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'flow_id', flow.id,
    'stage', flow.stage,
    'outcome', flow.outcome,
    'teacher_id', flow.teacher_id,
    'teacher_name', teacher.full_name,
    'when_text', pg_catalog.to_char(
      appointment.start_time at time zone 'America/Sao_Paulo',
      'DD/MM às HH24:MI'
    ),
    'class_logged', coalesce(opportunity.trial_status, '') = 'DONE',
    'student_asked_at', flow.student_asked_at,
    'teacher_answered_at', flow.teacher_answered_at,
    'offer_sent', flow.stage = 'OFFER_SENT' or flow.link_url is not null,
    'plan', flow.plan,
    'feedback', pg_catalog.jsonb_build_object(
      'recommended_level', coalesce(
        feedback.recommended_level,
        flow.teacher_feedback ->> 'level'
      ),
      'recommended_plan', coalesce(
        feedback.recommended_plan,
        flow.teacher_feedback ->> 'plan'
      ),
      'interest_score', coalesce(
        feedback.interest_score,
        (flow.teacher_feedback ->> 'interest')::integer
      ),
      'notes', feedback.notes
    ),
    'free_slots', private.trial_closing_free_slots(
      flow.tenant_id,
      flow.teacher_id
    ),
    'prices', private.trial_closing_prices(flow.tenant_id)
  )
  from private.trial_closing_flows as flow
  join public.appointments as appointment
    on appointment.id = flow.appointment_id
  join public.opportunities as opportunity
    on opportunity.id = flow.opportunity_id
  join public.profiles as teacher
    on teacher.id = flow.teacher_id
  left join lateral (
    select assessment.recommended_level,
      assessment.recommended_plan,
      assessment.interest_score,
      assessment.notes
    from public.trial_feedback as assessment
    where assessment.opportunity_id = flow.opportunity_id
      and assessment.tenant_id = flow.tenant_id
    order by assessment.created_at desc
    limit 1
  ) as feedback on true
  where flow.tenant_id = p_tenant
    and flow.created_at >= pg_catalog.now() - interval '14 days'
    and private.notification_phones_same_recipient(
      flow.lead_phone,
      private.trial_closing_phone(p_phone)
    )
  order by flow.created_at desc
  limit 1;
$function$;

alter function public.trial_closing_student_context(text, text)
  owner to postgres;
revoke all on function public.trial_closing_student_context(text, text)
  from public, anon, authenticated;
grant execute on function public.trial_closing_student_context(text, text)
  to service_role;

-- The student can choose frequency, plan and days while the teacher's score is
-- pending. The existing complete-feedback fence below still blocks offer/link.
do $migration$
declare
  v_definition text;
  v_old text := $needle$where tenant_id = p_tenant and stage = 'ASK_STUDENT'$needle$;
  v_new text := $needle$where tenant_id = p_tenant and stage in ('ASK_TEACHER', 'ASK_STUDENT')$needle$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_student_plan(text,text,integer,integer,jsonb,text)'::pg_catalog.regprocedure
  ) into v_definition;
  if v_definition is null then
    raise exception 'trial_closing_student_plan_missing';
  end if;
  if pg_catalog.strpos(v_definition, 'private.trial_feedback_is_complete') = 0 then
    raise exception 'trial_closing_student_plan_definition_changed';
  end if;
  if pg_catalog.strpos(v_definition, v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  elsif pg_catalog.strpos(v_definition, v_new) = 0 then
    raise exception 'trial_closing_student_plan_stage_guard_changed';
  end if;
  if pg_catalog.strpos(v_definition, $needle$v_need := v_need || 'horarios'$needle$) > 0 then
    v_definition := pg_catalog.replace(v_definition,
      $needle$v_need := v_need || 'horarios'$needle$,
      $needle$v_need := pg_catalog.array_append(v_need, 'horarios')$needle$);
  end if;
  if pg_catalog.strpos(v_definition, $needle$v_need := v_need || 'plano'$needle$) > 0 then
    v_definition := pg_catalog.replace(v_definition,
      $needle$v_need := v_need || 'plano'$needle$,
      $needle$v_need := pg_catalog.array_append(v_need, 'plano')$needle$);
  end if;
  if pg_catalog.strpos(v_definition, $needle$v_need := pg_catalog.array_append(v_need, 'horarios')$needle$) = 0
    or pg_catalog.strpos(v_definition, $needle$v_need := pg_catalog.array_append(v_need, 'plano')$needle$) = 0
  then
    raise exception 'trial_closing_student_plan_missing_fields_changed';
  end if;
  execute v_definition;
end;
$migration$;
