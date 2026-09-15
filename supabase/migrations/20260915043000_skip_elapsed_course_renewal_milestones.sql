-- A reminder is not a backlog item.  If an offer is issued after D15/D0 has
-- elapsed, the missed milestone must not become an extra message at the next
-- sending window; the explicit INITIAL notice covers that late issuance.

create or replace function private.materialize_student_course_renewal_reminders(
  p_now timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.student_course_renewal_notification_outbox(
    offer_id,
    tenant_id,
    student_id,
    milestone,
    scheduled_at
  )
  select
    offer.id,
    offer.tenant_id,
    offer.student_id,
    milestone.milestone,
    (
      (offer.contract_start - milestone.days_before)::text
      || ' 06:00 America/Sao_Paulo'
    )::timestamptz
  from private.student_course_renewal_offers as offer
  cross join (values ('D15', 15), ('D0', 0)) as milestone(milestone, days_before)
  where offer.status = 'PENDING_SIGNATURE'
    and offer.expires_at >= p_now
    and offer.contract_start - milestone.days_before
        >= (p_now at time zone 'America/Sao_Paulo')::date
    and not (
      milestone.milestone = 'D0'
      and exists (
        select 1
        from public.student_course_renewal_notification_outbox as initial_notice
        where initial_notice.offer_id = offer.id
          and initial_notice.milestone = 'INITIAL'
          and (
            initial_notice.scheduled_at at time zone 'America/Sao_Paulo'
          )::date = offer.contract_start
      )
    )
  on conflict (offer_id, milestone) do nothing;

  update public.student_course_renewal_notification_outbox
     set status = 'PENDING',
         claim_token = null,
         lease_expires_at = null,
         last_error = 'lease_expired',
         updated_at = p_now
   where status = 'CLAIMED'
     and submit_attempt_count = 0
     and lease_expires_at < p_now;

  update public.student_course_renewal_notification_outbox
     set status = 'UNKNOWN',
         last_error = 'provider_result_unknown',
         updated_at = p_now
   where status = 'SUBMITTING'
     and lease_expires_at < p_now;
end;
$function$;

alter function private.materialize_student_course_renewal_reminders(timestamptz)
  owner to postgres;
revoke all on function private.materialize_student_course_renewal_reminders(timestamptz)
  from public, anon, authenticated, service_role;
