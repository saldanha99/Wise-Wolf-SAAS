-- Keep the post-trial sales assistant grounded in the teacher's structured
-- assessment.  Before this change the context exposed the plan and calendar,
-- but not the B1/B2 result that was already stored in trial_feedback.  The
-- model therefore answered a direct level question with another price table.
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
      'recommended_level', feedback.recommended_level,
      'recommended_plan', feedback.recommended_plan,
      'interest_score', feedback.interest_score,
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
