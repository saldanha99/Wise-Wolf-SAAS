\set ON_ERROR_STOP on
-- Origem dos leads (27/10/2026): pista do WhatsApp classificada e preservada na fila.
begin;
create or replace function pg_temp.origin_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'origem dos leads: %',m;end if;end$$;
do $test$
declare r jsonb;tenant text:='lead-origin-fixture-'||gen_random_uuid();v_phone text:='5500000'||lpad((floor(random()*900000)+100000)::int::text,6,'0');
begin
 -- WhatsApp: anúncio do Meta, link do número, busca direta, sem pista.
 r:=private.lead_origin_evidence('WhatsApp (IA)','Origem: {"whatsapp_entry":"ctwa_ad","whatsapp_ad":true,"whatsapp_ad_id":"1202","whatsapp_ad_title":"Inglês\nno trabalho","whatsapp_ad_host":"fb.me"}');
 perform pg_temp.origin_assert(r->>'channel'='PAID' and r->>'paid_platform'='META_WHATSAPP' and r->>'whatsapp_ad_title'='Inglês no trabalho' and r->>'whatsapp_ad_id'='1202','anuncio de WhatsApp: '||r::text);
 r:=private.lead_origin_evidence('WhatsApp (IA)','Origem: {"whatsapp_entry":"phone_number_hyperlink"}');
 perform pg_temp.origin_assert(r->>'channel'='WHATSAPP_LINK' and not r ? 'paid_platform','link do numero: '||r::text);
 r:=private.lead_origin_evidence('WhatsApp (IA)','Origem: {"whatsapp_entry":"global_search_new_chat","whatsapp_entry_app":"whatsapp"}');
 perform pg_temp.origin_assert(r->>'channel'='WHATSAPP_DIRECT','busca direta: '||r::text);
 r:=private.lead_origin_evidence('WhatsApp (IA)',null);
 perform pg_temp.origin_assert(r->>'channel'='WHATSAPP_UNKNOWN','sem pista: '||r::text);
 r:=private.lead_origin_evidence('WhatsApp (IA)','Origem: {"whatsapp_entry":"x;drop","whatsapp_ad_id":"abc"}');
 perform pg_temp.origin_assert(r->>'channel'='WHATSAPP_UNKNOWN' and not r ? 'whatsapp_entry' and not r ? 'whatsapp_ad_id','valor estranho aceito: '||r::text);
 -- Site: a 1ª página decide a origem; fbclid sozinho não é anúncio; Google Ads é.
 r:=private.lead_origin_evidence('level_quiz','Origem: {"first_referrer_host":"www.google.com","referrer_host":"wisewolflanguage.com.br","first_landing_path":"/blog/x","last_landing_path":"/"}');
 perform pg_temp.origin_assert(r->>'channel'='ORGANIC_SEARCH' and r->>'surface'='BLOG','busca organica pela 1a pagina: '||r::text);
 r:=private.lead_origin_evidence('institutional_site','Origem: {"referrer_host":"l.instagram.com","fbclid":"abc"}');
 perform pg_temp.origin_assert(r->>'channel'='SOCIAL' and not r ? 'fbclid','rede social: '||r::text);
 r:=private.lead_origin_evidence('lp-ielts','Origem: {"gclid":"xyz","utm_campaign":"ielts"}');
 perform pg_temp.origin_assert(r->>'channel'='PAID' and r->>'paid_platform'='GOOGLE' and not r ? 'gclid','google ads: '||r::text);
 r:=private.lead_origin_evidence('lp-ielts','Origem: {"utm_source":"instagram","utm_medium":"paid_social"}');
 perform pg_temp.origin_assert(r->>'paid_platform'='META','meta ads por utm: '||r::text);

 -- A fila guarda a pista da 1ª mensagem mesmo quando a seguinte chega sem ela.
 insert into public.tenants(id,name,slug,saas_status) values(tenant,'Lead origin fixture',tenant,'active');
 perform public.enqueue_sdr_work(tenant,v_phone,jsonb_build_object('msgId','m1','text','Oi','instance','x','pushName','F','isMedia',false,'entry',jsonb_build_object('whatsapp_entry','phone_number_hyperlink')));
 perform public.enqueue_sdr_work(tenant,v_phone,jsonb_build_object('msgId','m2','text','quero saber preço','instance','x','pushName','F','isMedia',false));
 perform pg_temp.origin_assert((select payload->'entry'->>'whatsapp_entry'='phone_number_hyperlink' and payload->>'msgId'='m2' from public.sdr_conversation_work where tenant_id=tenant and phone=v_phone),'pista perdida na 2a mensagem');
end;$test$;
rollback;
