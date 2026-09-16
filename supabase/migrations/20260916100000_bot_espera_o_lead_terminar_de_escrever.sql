-- ─────────────────────────────────────────────────────────────────────────────
-- O bot espera o lead terminar de escrever (16/09/2026)
--
-- No WhatsApp as pessoas escrevem em rajada. Em 15/09/2026 um lead mandou o
-- objetivo e, no mesmo minuto, o período que preferia; a atendente respondeu à
-- primeira mensagem ignorando a segunda — perguntou o nível e não registrou a
-- preferência de horário que ele tinha acabado de dar.
--
-- A fila já tinha o mecanismo certo: cada mensagem nova adia `available_at` e
-- só a última é respondida. O prazo era de 2 segundos, curto demais para quem
-- ainda está digitando a frase seguinte. Passa para 12 segundos — contados
-- SEMPRE da última mensagem, então quem escreve quatro seguidas continua
-- recebendo uma resposta só, já com tudo lido.
--
-- Só muda o intervalo; o resto da função é o que já estava no banco.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.enqueue_sdr_work(
  p_tenant_id text, p_phone text, p_payload jsonb
)
returns void language plpgsql set search_path = '' as $function$
declare v_id text := p_payload->>'msgId';
begin
  if coalesce(v_id,'')='' or p_phone !~ '^[0-9]{10,15}$' or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>20000 then raise exception 'invalid_sdr_input'; end if;
  if exists(select 1 from public.ai_wa_messages where tenant_id=p_tenant_id and phone=p_phone
    and agent='sdr' and direction='in' and meta->>'msg_id'=v_id) then return; end if;
  insert into public.sdr_conversation_work(tenant_id,phone,payload,latest_msg_id,available_at)
  values(p_tenant_id,p_phone,p_payload,v_id,now()+interval '12 seconds')
  on conflict(tenant_id,phone) do nothing;
  perform 1 from public.sdr_conversation_work where tenant_id=p_tenant_id and phone=p_phone for update;
  if exists(select 1 from public.ai_wa_messages where tenant_id=p_tenant_id and phone=p_phone
    and agent='sdr' and direction='in' and meta->>'msg_id'=v_id) then return; end if;
  insert into public.ai_wa_messages(tenant_id,phone,agent,direction,content,meta)
  values(p_tenant_id,p_phone,'sdr','in',left(coalesce(p_payload->>'text','[mídia]'),4000),
    jsonb_build_object('msg_id',v_id,'kind','sdr_queued'));
  update public.sdr_conversation_work set payload=p_payload,latest_msg_id=v_id,attempts=0,
    available_at=now()+interval '12 seconds',updated_at=now(),
    phase=case when phase='REVIEW' and not exists(
      select 1 from public.crm_leads l where l.tenant_id=p_tenant_id
        and regexp_replace(l.phone,'[^0-9]','','g')=p_phone
        and l.ai_handoff=true and l.ai_handoff_at>now()-interval '72 hours'
    ) then 'IDLE' else phase end
  where tenant_id=p_tenant_id and phone=p_phone;
end;
$function$;
