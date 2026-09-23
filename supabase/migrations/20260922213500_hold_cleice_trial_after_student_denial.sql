-- A aluna disse no WhatsApp central em 22/09/2026 20:54 UTC que a aula nao
-- aconteceu. O atendimento humano esta negociando novo horario; interrompe
-- apenas a cadencia de fechamento ate a situacao ser conciliada.
update private.trial_closing_flows flow
set stage = 'NO_SHOW', outcome = 'NOT_HELD',
    last_error = 'student_reports_trial_not_held', updated_at = now()
where flow.id = '7d73ecd7-4c3d-4138-92c7-dfe9a32faac4'::uuid
  and flow.opportunity_id = '7d913d00-b70b-43f3-a01b-975c3fd08cca'::uuid
  and flow.stage in ('ASK_TEACHER', 'ASK_STUDENT')
  and exists (
    select 1 from public.whatsapp_messages message
    join public.whatsapp_conversations conversation
      on conversation.id = message.conversation_id
    where message.tenant_id = flow.tenant_id
      and conversation.tenant_id = flow.tenant_id
      and private.notification_phones_same_recipient(conversation.phone, flow.lead_phone)
      and message.direction = 'in'
      and message.body = 'A aula não aconteceu'
      and message.occurred_at >= '2026-09-22 20:50:00+00'::timestamptz
  );
