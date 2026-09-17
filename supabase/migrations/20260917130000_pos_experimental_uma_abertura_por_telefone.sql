-- Um aluno que fez DUAS experimentais (Matheus: 15/09 com a Juliana e 16/09 com
-- a Lais) recebeu dois "como foi a aula?" no mesmo segundo na primeira rodada
-- (17/09/2026 11:05) — cada fluxo abriu a sua conversa. A conversa é com a
-- pessoa, não com o fluxo: só a experimental MAIS RECENTE do telefone abre;
-- fluxo mais antigo do mesmo número fica quieto (a coordenação já foi cobrada
-- dele pelo `trial_closing_overdue`).
create or replace function public.trial_closing_student_openers(p_limit integer default 10)
returns table(
  flow_id uuid, tenant_id text, lead_phone text, lead_name text,
  teacher_name text, when_text text, class_logged boolean
)
language sql security definer set search_path = '' as $$
  select flow.id, flow.tenant_id, flow.lead_phone, flow.lead_name,
    teacher.full_name,
    pg_catalog.to_char(appointment.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI'),
    coalesce(opportunity.trial_status, '') = 'DONE'
  from private.trial_closing_flows as flow
  join public.appointments as appointment on appointment.id = flow.appointment_id
  join public.opportunities as opportunity on opportunity.id = flow.opportunity_id
  join public.profiles as teacher on teacher.id = flow.teacher_id
  where flow.stage in ('ASK_TEACHER', 'ASK_STUDENT')
    and flow.student_asked_at is null
    and flow.outcome is distinct from 'NO_SHOW'
    and (
      appointment.start_time + interval '40 minutes' <= pg_catalog.now()
      or coalesce(opportunity.trial_status, '') = 'DONE'
    )
    and appointment.start_time >= pg_catalog.now() - interval '3 days'
    -- Só a experimental mais recente deste telefone abre conversa.
    and not exists (
      select 1
      from private.trial_closing_flows as newer
      join public.appointments as newer_appointment on newer_appointment.id = newer.appointment_id
      where newer.tenant_id = flow.tenant_id
        and newer.id <> flow.id
        and private.notification_phones_same_recipient(newer.lead_phone, flow.lead_phone)
        and newer_appointment.start_time > appointment.start_time
    )
  order by appointment.start_time
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

alter function public.trial_closing_student_openers(integer) owner to postgres;
revoke all on function public.trial_closing_student_openers(integer) from public, anon, authenticated;
grant execute on function public.trial_closing_student_openers(integer) to service_role;
