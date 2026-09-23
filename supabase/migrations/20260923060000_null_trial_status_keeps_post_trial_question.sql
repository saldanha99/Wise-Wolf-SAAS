-- `trial_status` nulo sumia da pergunta pós-experimental, em silêncio.
--
-- A migration 20260922201500 filtra o RETORNO de trial_closing_teacher_asks por
-- `opportunity.trial_status not in (...)`, sem coalesce — enquanto o INSERT da
-- MESMA função usa `coalesce(trial_status, '') not in (...)`. Em SQL,
-- `null not in (...)` é NULL, não verdadeiro: a oportunidade entra na fila e
-- nunca aparece no retorno. Ninguém recebe erro; a professora simplesmente não
-- é perguntada e o fechamento da experimental não começa.
--
-- Não atinge ninguém hoje — medido em 23/09/2026, nas experimentais CLAIMED dos
-- últimos 90 dias: 34 DONE, 15 SCHEDULED, 3 NO_SHOW_STUDENT, 2 NO_SHOW_TEACHER,
-- ZERO com o campo nulo, e zero fluxos parados em ASK_TEACHER por causa disso.
-- Por isso esta migration é um no-op sobre os dados atuais: ela fecha a porta
-- antes de alguém entrar, e alinha o retorno ao insert que já estava certo.
--
-- Mesma família de `20260923050000_open_reschedule_keeps_student_access`: regra
-- de negócio que esquece que NULL não é falso.

create or replace function public.trial_closing_teacher_asks(p_limit integer default 10)
returns table(
  flow_id uuid, tenant_id text, teacher_id uuid, teacher_phone text,
  teacher_name text, lead_name text, when_text text
)
language plpgsql security definer set search_path = '' as $$
begin
  -- Se a mesma oportunidade foi reagendada e a nova aula ja terminou,
  -- reutiliza o fluxo antigo. Sem isso, o ON CONFLICT abaixo impediria o
  -- fechamento da experimental efetivamente realizada.
  update private.trial_closing_flows flow
     set stage = 'ASK_TEACHER', outcome = null, teacher_feedback = '{}'::jsonb,
         feedback_saved = false, plan = '{}'::jsonb, teacher_asked_at = null,
         teacher_alerted_at = null, teacher_answered_at = null,
         student_asked_at = null, last_error = null, updated_at = now()
  from public.opportunities opportunity
  join public.appointments appointment
    on appointment.id = opportunity.trial_appointment_id
  where flow.opportunity_id = opportunity.id
    and flow.stage = 'NO_SHOW'
    and flow.offer_id is null
    and opportunity.status = 'CLAIMED'
    and opportunity.trial_status = 'SCHEDULED'
    and lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed')
    and appointment.start_time > flow.updated_at
    and appointment.start_time + interval '40 minutes' <= now()
    and appointment.start_time >= now() - interval '7 days';

  insert into private.trial_closing_flows (
    tenant_id, opportunity_id, appointment_id, teacher_id, lead_phone, lead_name, stage
  )
  select opportunity.tenant_id, opportunity.id, appointment.id,
    coalesce(opportunity.winner_teacher_id, opportunity.professor_id),
    private.trial_closing_phone(coalesce(opportunity.student_phone, appointment.student_phone)),
    coalesce(nullif(btrim(coalesce(opportunity.student_name, '')), ''), appointment.student_name),
    case when opportunity.trial_status = 'DONE'
      and private.trial_feedback_is_complete(opportunity.id)
      then 'ASK_STUDENT' else 'ASK_TEACHER' end
  from public.opportunities as opportunity
  join public.appointments as appointment
    on appointment.id = opportunity.trial_appointment_id
   and appointment.tenant_id = opportunity.tenant_id
  where opportunity.kind = 'TRIAL'
    and opportunity.status = 'CLAIMED'
    and coalesce(opportunity.conversion_status, 'OPEN') = 'OPEN'
    and coalesce(opportunity.trial_status, '') not in
      ('NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'CANCELLED', 'CANCELED')
    and not coalesce(opportunity.is_test_fixture, false)
    and lower(coalesce(appointment.type, '')) = 'experimental'
    and lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed', 'completed')
    and (appointment.start_time + interval '40 minutes' <= now()
      or (opportunity.trial_status = 'DONE' and appointment.start_time <= now()))
    and appointment.start_time >= now() - interval '7 days'
    and coalesce(opportunity.winner_teacher_id, opportunity.professor_id) is not null
    and length(private.trial_closing_phone(coalesce(opportunity.student_phone, appointment.student_phone))) between 12 and 13
    and not exists (select 1 from public.enrollment_links link where link.opportunity_id = opportunity.id)
    and not exists (select 1 from public.offers offer where offer.opportunity_id = opportunity.id
      and offer.kind = 'ENROLLMENT' and offer.revoked_at is null)
  on conflict (opportunity_id) do nothing;

  return query
  select flow.id, flow.tenant_id, flow.teacher_id,
    private.trial_closing_phone(teacher.phone), teacher.full_name, flow.lead_name,
    to_char(appointment.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI')
  from private.trial_closing_flows flow
  join public.appointments appointment on appointment.id = flow.appointment_id
  join public.opportunities opportunity on opportunity.id = flow.opportunity_id
  join public.profiles teacher on teacher.id = flow.teacher_id
  where flow.stage = 'ASK_TEACHER' and flow.teacher_asked_at is null
    and coalesce(opportunity.trial_status, '') not in ('NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'CANCELLED', 'CANCELED')
    and lower(coalesce(appointment.status, '')) in ('scheduled', 'confirmed', 'completed')
    and length(private.trial_closing_phone(teacher.phone)) between 12 and 13
  order by appointment.start_time
  limit greatest(1, least(coalesce(p_limit, 10), 50));
end $$;

alter function public.trial_closing_teacher_asks(integer) owner to postgres;
revoke all on function public.trial_closing_teacher_asks(integer) from public, anon, authenticated;
grant execute on function public.trial_closing_teacher_asks(integer) to service_role;
