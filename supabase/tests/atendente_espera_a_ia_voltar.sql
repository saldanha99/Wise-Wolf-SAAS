\set ON_ERROR_STOP on
-- IA fora do ar: a mensagem do lead volta à fila, pendente, sem handoff.
-- Roda numa transação com contato de mentira que some no rollback.
begin;
create or replace function pg_temp.ia_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'atendente espera a IA: %',m;end if;end$$;
do $test$
declare
  v_tenant text;
  v_phone text := '5500000' || lpad((floor(random()*1000000))::int::text, 6, '0');
  v_claim jsonb;
  v_token uuid;
  w public.sdr_conversation_work%rowtype;
begin
  select id into v_tenant from public.tenants order by created_at limit 1;
  if v_tenant is null then raise notice 'sem tenant; pulado'; return; end if;

  perform public.enqueue_sdr_work(v_tenant, v_phone,
    jsonb_build_object('msgId','fixture-ia-1','text','oi','instance','x','pushName','','isMedia',false));
  update public.sdr_conversation_work set available_at = now() - interval '1 second'
    where tenant_id = v_tenant and phone = v_phone;

  v_claim := public.claim_sdr_work(v_tenant, v_phone);
  perform pg_temp.ia_assert((v_claim->>'claimed')::boolean, 'não pegou a rodada');
  v_token := (v_claim->>'token')::uuid;
  perform pg_temp.ia_assert(public.begin_sdr_effects(v_tenant, v_phone, v_token), 'não entrou em APPLYING');

  perform pg_temp.ia_assert(public.defer_sdr_work(v_tenant, v_phone, v_token, 120), 'defer recusado');
  select * into w from public.sdr_conversation_work where tenant_id = v_tenant and phone = v_phone;
  perform pg_temp.ia_assert(w.phase = 'IDLE', 'fase ' || w.phase);
  perform pg_temp.ia_assert(w.attempts = 0, 'tentativas não zeraram');
  perform pg_temp.ia_assert(w.completed_msg_id is distinct from w.latest_msg_id, 'mensagem dada como respondida');
  perform pg_temp.ia_assert(w.available_at > now() + interval '100 seconds', 'prazo de nova tentativa');
  perform pg_temp.ia_assert(w.lease_token is null, 'lease não liberada');

  -- Token velho não mexe na fila.
  perform pg_temp.ia_assert(not public.defer_sdr_work(v_tenant, v_phone, v_token, 120), 'token velho aceito');

  -- Prazo inválido é recusado.
  begin
    perform public.defer_sdr_work(v_tenant, v_phone, v_token, 5);
    raise exception 'atendente espera a IA: prazo de 5 s aceito';
  exception when raise_exception then
    if sqlerrm <> 'invalid_sdr_delay' then raise; end if;
  end;

  -- Volta a ser elegível quando o prazo chega, e não aparece antes.
  perform pg_temp.ia_assert(not exists(select 1 from public.list_pending_sdr_work() l
    where l.tenant_id = v_tenant and l.phone = v_phone), 'pendente antes do prazo');
  update public.sdr_conversation_work set available_at = now() - interval '1 second'
    where tenant_id = v_tenant and phone = v_phone;
  v_claim := public.claim_sdr_work(v_tenant, v_phone);
  perform pg_temp.ia_assert((v_claim->>'claimed')::boolean, 'não retomou depois do prazo');
end
$test$;
rollback;
