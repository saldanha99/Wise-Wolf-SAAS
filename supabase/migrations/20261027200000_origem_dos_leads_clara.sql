-- Reexecutável. A direção achou a origem dos leads pouco clara (27/10/2026):
-- o lead do WhatsApp (o maior volume) chegava sempre como "campanha não
-- identificada", embora o próprio WhatsApp informe na 1ª mensagem se a pessoa
-- veio de anúncio do Meta, de um link do número ou de busca direta.
-- Nenhuma evidência já gravada é reescrita; vale para os leads novos.

create or replace function private.lead_origin_evidence(p_source text,p_notes text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v jsonb:='{}';clean jsonb:='{}';s text:=coalesce(p_source,'');key text;raw text;channel text;surface text;
 v_entry text;v_referrer text;v_platform text;
begin
 begin
  raw:=substring(coalesce(p_notes,'') from 'Origem: (\{[^\n]*\})');
  if raw is null then raw:=substring(coalesce(p_notes,'') from 'UTMs: (\{[^\n]*\})');end if;
  if length(raw)<=5000 then v:=raw::jsonb;end if;
 exception when others then v:='{}';end;
 if jsonb_typeof(v) is distinct from 'object' then v:='{}';end if;
 foreach key in array array['utm_source','utm_medium','utm_campaign','utm_content','utm_term','landing_path','referrer_host','first_landing_path','last_landing_path','first_referrer_host'] loop
  if jsonb_typeof(v->key)='string' then
   raw:=left(regexp_replace(v->>key,'[[:cntrl:]]',' ','g'),240);
   if key like '%path' and (raw !~ '^/[A-Za-z0-9/_%.~-]*$' or raw ~* '(token|convite|auth|senha|contrato|matricula|confirmar)') then continue;end if;
   if key like '%host' and raw !~ '^[A-Za-z0-9.-]+$' then continue;end if;
   clean:=clean||jsonb_build_object(key,raw);
  end if;
 end loop;
 -- Pista do próprio WhatsApp (whatsapp-inbound/lead-entry.ts), validada aqui de novo.
 if v->>'whatsapp_entry' ~ '^[a-z_]{1,60}$' then clean:=clean||jsonb_build_object('whatsapp_entry',v->>'whatsapp_entry');end if;
 if v->>'whatsapp_entry_app' ~ '^[a-z_]{1,30}$' then clean:=clean||jsonb_build_object('whatsapp_entry_app',v->>'whatsapp_entry_app');end if;
 if v->>'whatsapp_ad_id' ~ '^[0-9]{1,30}$' then clean:=clean||jsonb_build_object('whatsapp_ad_id',v->>'whatsapp_ad_id');end if;
 if v->>'whatsapp_ad_host' ~ '^[A-Za-z0-9.-]{1,120}$' then clean:=clean||jsonb_build_object('whatsapp_ad_host',v->>'whatsapp_ad_host');end if;
 if jsonb_typeof(v->'whatsapp_ad_title')='string' and btrim(v->>'whatsapp_ad_title')<>'' then
  clean:=clean||jsonb_build_object('whatsapp_ad_title',left(btrim(regexp_replace(v->>'whatsapp_ad_title','[[:cntrl:]]',' ','g')),120));
 end if;
 if v->'whatsapp_ad'='true'::jsonb or clean ? 'whatsapp_ad_id' or coalesce(clean->>'whatsapp_entry','') like 'ctwa%' then clean:=clean||'{"whatsapp_ad":true}';end if;
 -- Persist the presence of a click marker, never the raw advertising identifier.
 if nullif(v->>'gclid','') is not null or nullif(v->>'wbraid','') is not null or nullif(v->>'gbraid','') is not null then
  clean:=clean||'{"google_click":true}';
 end if;
 if nullif(v->>'fbclid','') is not null then clean:=clean||'{"meta_click":true}';end if;
 v_entry:=coalesce(clean->>'whatsapp_entry','');
 -- A 1ª página vista diz de onde a pessoa veio; a última só onde pediu contato.
 v_referrer:=coalesce(nullif(clean->>'first_referrer_host',''),clean->>'referrer_host','');
 channel:=case
  when clean->>'whatsapp_ad'='true' or clean->>'google_click'='true' or lower(coalesce(clean->>'utm_medium','')) in('cpc','ppc','paid','paid_social','paid_search','cpm','display') then 'PAID'
  when lower(coalesce(clean->>'utm_medium',''))='organic' or v_referrer ~* '(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com)$' then 'ORGANIC_SEARCH'
  -- fbclid sozinho não prova anúncio: aparece em qualquer link aberto no Instagram/Facebook.
  when v_referrer ~* '(^|\.)(instagram\.com|facebook\.com|fb\.com|youtube\.com|tiktok\.com|linkedin\.com|t\.co)$' or clean->>'meta_click'='true' then 'SOCIAL'
  when v_referrer<>'' and v_referrer !~* '(^|\.)wisewolflanguage\.com\.br$' then 'REFERRAL'
  when nullif(clean->>'utm_source','') is not null then 'TAGGED'
  when v_entry in('phone_number_hyperlink','click_to_chat_link','deeplink','wa_me_link','url') then 'WHATSAPP_LINK'
  when v_entry like 'global_search%' or v_entry like 'contact%' or v_entry like 'chat_list%' then 'WHATSAPP_DIRECT'
  when s ilike '%whatsapp%' then 'WHATSAPP_UNKNOWN'
  else 'DIRECT_UNKNOWN' end;
 if channel='PAID' then
  v_platform:=case
   when clean->>'whatsapp_ad'='true' then 'META_WHATSAPP'
   when clean->>'google_click'='true' or lower(coalesce(clean->>'utm_source','')) in('google','google_ads','adwords') then 'GOOGLE'
   when lower(coalesce(clean->>'utm_source','')) ~ '^(facebook|instagram|meta|fb|ig)' then 'META'
   else 'OTHER' end;
  clean:=clean||jsonb_build_object('paid_platform',v_platform);
 end if;
 surface:=case when s ilike '%blog%' or (coalesce(clean->>'landing_path','') ~ '^/(blog|glossario)(/|$)' or coalesce(clean->>'first_landing_path','') ~ '^/(blog|glossario)(/|$)') then 'BLOG' when s ilike 'lp-%' or s ilike '%landing%' then 'LANDING' when s ilike '%whatsapp%' then 'WHATSAPP' else 'SITE_OR_FORM' end;
 return clean||jsonb_build_object('channel',channel,'surface',surface,'form_source',left(s,120),'confidence','OBSERVED_CLIENT_METADATA');
end;
$$;
alter function private.lead_origin_evidence(text,text) owner to postgres;
revoke all on function private.lead_origin_evidence(text,text) from public,anon,authenticated,service_role;

-- A fila do atendimento guarda só a última mensagem do contato; a pista de
-- origem vem na primeira. Mensagem sem pista herda a que já estava na fila.
create or replace function public.enqueue_sdr_work(p_tenant_id text, p_phone text, p_payload jsonb)
 returns void
 language plpgsql
 set search_path to ''
as $function$
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
  update public.sdr_conversation_work set
    payload=case when jsonb_typeof(p_payload->'entry')='object' or jsonb_typeof(sdr_conversation_work.payload->'entry') is distinct from 'object'
      then p_payload else p_payload||jsonb_build_object('entry',sdr_conversation_work.payload->'entry') end,
    latest_msg_id=v_id,attempts=0,
    available_at=now()+interval '12 seconds',updated_at=now(),
    phase=case when phase='REVIEW' and not exists(
      select 1 from public.crm_leads l where l.tenant_id=p_tenant_id
        and regexp_replace(l.phone,'[^0-9]','','g')=p_phone
        and l.ai_handoff=true and l.ai_handoff_at>now()-interval '72 hours'
    ) then 'IDLE' else phase end
  where tenant_id=p_tenant_id and phone=p_phone;
end;
$function$;
