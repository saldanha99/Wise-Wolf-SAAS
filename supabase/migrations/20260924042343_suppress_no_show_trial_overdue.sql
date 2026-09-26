-- Uma falta já registrada no agendamento não é ausência de resposta da teacher.
-- Caso de uma lead em 23/09/2026: a mensagem da professora confirmou falta/remarcação,
-- mas o alerta antigo olhava apenas o estado do fluxo de fechamento.
create or replace function public.trial_closing_overdue()
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_flow record; v_count integer := 0;
begin
  for v_flow in
    select flow.id, flow.tenant_id, flow.teacher_id, flow.lead_name,
      teacher.full_name as teacher_name, appointment.start_time
    from private.trial_closing_flows as flow
    join public.profiles as teacher on teacher.id = flow.teacher_id
    join public.appointments as appointment on appointment.id = flow.appointment_id
    join public.opportunities as opportunity on opportunity.id = flow.opportunity_id
    where flow.stage = 'ASK_TEACHER'
      and flow.teacher_asked_at is not null
      and flow.teacher_asked_at < pg_catalog.now() - interval '6 hours'
      and flow.teacher_alerted_at is null
      and pg_catalog.lower(pg_catalog.coalesce(appointment.status, '')) in
        ('scheduled', 'confirmed', 'completed')
      and pg_catalog.coalesce(opportunity.trial_status, '') not in
        ('NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'CANCELLED', 'CANCELED')
    order by flow.teacher_asked_at
    limit 20
  loop
    perform private.notify_management_group(
      v_flow.tenant_id, null, v_flow.teacher_id, v_flow.id,
      'trial-closing-overdue:' || v_flow.id::text,
      '⏰ A experimental de ' || pg_catalog.coalesce(v_flow.lead_name, 'um lead') || ' (' ||
      pg_catalog.to_char(v_flow.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI') ||
      ') está sem resposta de ' || pg_catalog.coalesce(v_flow.teacher_name, 'a professora') ||
      '. Enquanto ela não disser se a aula aconteceu, o link de matrícula não sai.'
    );
    update private.trial_closing_flows
       set teacher_alerted_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where id = v_flow.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $function$;

alter function public.trial_closing_overdue() owner to postgres;
revoke all on function public.trial_closing_overdue() from public, anon, authenticated;
grant execute on function public.trial_closing_overdue() to service_role;
