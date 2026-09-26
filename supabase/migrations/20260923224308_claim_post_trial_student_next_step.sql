-- One authorized post-handoff next step. Claim before the external send so
-- retries cannot duplicate it, even if the provider result is ambiguous.
begin;

create or replace function public.trial_closing_claim_authorized_student_followup()
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_flow private.trial_closing_flows%rowtype;
  v_authorized_at timestamptz;
begin
  select flow.* into v_flow
  from private.trial_closing_flows as flow
  where flow.tenant_id = 'school-wise-wolf'
    and flow.stage in ('ASK_TEACHER', 'ASK_STUDENT') and flow.outcome = 'DONE'
    and flow.link_url is null
    and flow.plan ? 'ai_resumption_authorized_at'
    and not flow.plan ? 'student_terms_followup_claimed_at'
    and flow.plan ? 'frequency' and flow.plan ? 'duration'
    and (not flow.plan ? 'slots' or
      pg_catalog.jsonb_array_length(flow.plan -> 'slots') <> (flow.plan ->> 'frequency')::integer)
    and (flow.plan ->> 'ai_resumption_authorized_at')::timestamptz <= pg_catalog.now()
    and not exists (
      select 1 from public.crm_leads as lead
      where lead.tenant_id = flow.tenant_id
        and private.notification_phones_same_recipient(lead.phone, flow.lead_phone)
        and lead.ai_handoff_at > (flow.plan ->> 'ai_resumption_authorized_at')::timestamptz
    )
    and not exists (
      select 1 from public.whatsapp_messages as msg
      join public.whatsapp_conversations as conversation on conversation.id = msg.conversation_id
      where conversation.tenant_id = flow.tenant_id
        and private.notification_phones_same_recipient(conversation.phone, flow.lead_phone)
        and msg.occurred_at > (flow.plan ->> 'ai_resumption_authorized_at')::timestamptz
    )
  order by flow.updated_at
  limit 1 for update skip locked;
  if not found then return pg_catalog.jsonb_build_object('claimed', false); end if;
  v_authorized_at := (v_flow.plan ->> 'ai_resumption_authorized_at')::timestamptz;
  update private.trial_closing_flows
     set plan = pg_catalog.jsonb_set(plan, '{student_terms_followup_claimed_at}',
       pg_catalog.to_jsonb(pg_catalog.clock_timestamp()::text), true),
         updated_at = pg_catalog.now()
   where id = v_flow.id;
  return pg_catalog.jsonb_build_object(
    'claimed', true, 'flow_id', v_flow.id, 'tenant_id', v_flow.tenant_id,
    'lead_phone', v_flow.lead_phone, 'lead_name', v_flow.lead_name,
    'frequency', (v_flow.plan ->> 'frequency')::integer,
    'duration', (v_flow.plan ->> 'duration')::integer,
    'authorized_at', v_authorized_at
  );
end $function$;

alter function public.trial_closing_claim_authorized_student_followup() owner to postgres;
revoke all on function public.trial_closing_claim_authorized_student_followup() from public, anon, authenticated;
grant execute on function public.trial_closing_claim_authorized_student_followup() to service_role;

commit;
