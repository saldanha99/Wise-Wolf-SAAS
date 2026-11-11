-- IA fora do ar não é "humano assumiu" (11/11/2026).
--
-- Quando Gemini e OpenRouter falham, a atendente devolve a mensagem do lead à
-- fila para nova tentativa, em vez de dá-la como respondida e calar o contato
-- por 72 h. A mensagem segue pendente (completed_msg_id não muda), a rodada
-- volta a IDLE com as tentativas zeradas e o cron `wisewolf-sdr-work` a pega
-- quando `available_at` chegar. Se o lead escreveu de novo durante a rodada, o
-- prazo curto que o enqueue gravou é preservado.
create or replace function public.defer_sdr_work(
  p_tenant_id text,
  p_phone text,
  p_token uuid,
  p_delay_seconds integer
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_delay_seconds is null or p_delay_seconds < 30 or p_delay_seconds > 3600 then
    raise exception 'invalid_sdr_delay';
  end if;
  update public.sdr_conversation_work set
    phase = 'IDLE',
    attempts = 0,
    available_at = case
      when latest_msg_id is distinct from claimed_msg_id then available_at
      else now() + make_interval(secs => p_delay_seconds)
    end,
    lease_token = null,
    lease_until = null,
    updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone
    and lease_token = p_token and phase in ('GENERATING','APPLYING');
  return found;
end;
$$;

revoke all on function public.defer_sdr_work(text,text,uuid,integer) from public, anon, authenticated;
grant execute on function public.defer_sdr_work(text,text,uuid,integer) to service_role;
