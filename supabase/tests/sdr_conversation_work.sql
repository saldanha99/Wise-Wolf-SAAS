\set ON_ERROR_STOP on
begin;
insert into public.tenants(id,name) values('sdr-queue-test','SDR test fixture');
set local role service_role;
do $$
declare
  p constant text := '5511999999901';
  t constant text := 'sdr-queue-test';
  a jsonb; b jsonb; old_token uuid;
begin
  perform public.enqueue_sdr_work(t,p,jsonb_build_object('msgId','m1','text','Quero uma aula','instance','test_fixture'));
  perform public.enqueue_sdr_work(t,p,jsonb_build_object('msgId','m1','text','Quero uma aula','instance','test_fixture'));
  if (select count(*) from public.ai_wa_messages where tenant_id=t)<>1 then raise exception 'duplicate input log'; end if;
  if (public.claim_sdr_work(t,p)->>'claimed')::boolean then raise exception 'debounce ignored'; end if;
  if (public.claim_sdr_notice(t,p)->>'claimed')::boolean then raise exception 'reminder stole a pending conversation'; end if;
  update public.sdr_conversation_work set available_at=now()-interval '1 second' where tenant_id=t;
  a:=public.claim_sdr_work(t,p);
  if not (a->>'claimed')::boolean then raise exception 'first claim failed'; end if;
  if (public.claim_sdr_work(t,p)->>'claimed')::boolean then raise exception 'concurrent claim allowed'; end if;
  perform public.enqueue_sdr_work(t,p,jsonb_build_object('msgId','m2','text','Pode ser às 18h?','instance','test_fixture'));
  if public.begin_sdr_effects(t,p,(a->>'token')::uuid) then raise exception 'obsolete response can send'; end if;
  perform public.finish_sdr_work(t,p,(a->>'token')::uuid,true);
  update public.sdr_conversation_work set available_at=now()-interval '1 second' where tenant_id=t;
  b:=public.claim_sdr_work(t,p);
  if b#>>'{payload,msgId}'<>'m2' then raise exception 'newer message lost'; end if;
  if not public.begin_sdr_effects(t,p,(b->>'token')::uuid) then raise exception 'latest response blocked'; end if;
  perform public.enqueue_sdr_work(t,p,jsonb_build_object('msgId','m3','text','Obrigado','instance','test_fixture'));
  if (public.claim_sdr_work(t,p)->>'claimed')::boolean then raise exception 'claim during sending allowed'; end if;
  perform public.finish_sdr_work(t,p,(b->>'token')::uuid,true);
  update public.sdr_conversation_work set available_at=now()-interval '1 second' where tenant_id=t;
  a:=public.claim_sdr_work(t,p);
  old_token:=(a->>'token')::uuid;
  update public.sdr_conversation_work set lease_until=now()-interval '1 second' where tenant_id=t;
  b:=public.claim_sdr_work(t,p);
  if not (b->>'claimed')::boolean then raise exception 'generation not recovered'; end if;
  if public.begin_sdr_effects(t,p,old_token) then raise exception 'stale worker can send'; end if;
  if not public.begin_sdr_effects(t,p,(b->>'token')::uuid) then raise exception 'recovery fence failed'; end if;
  update public.sdr_conversation_work set lease_until=now()-interval '1 second' where tenant_id=t;
  if (public.claim_sdr_work(t,p)->>'claimed')::boolean then raise exception 'uncertain effects replayed'; end if;
  if (select phase from public.sdr_conversation_work where tenant_id=t)<>'REVIEW' then raise exception 'uncertain turn not marked for review'; end if;
  if (select count(*) from public.ai_wa_messages where tenant_id=t)<>3 then raise exception 'burst history incomplete'; end if;
  a:=public.claim_sdr_notice(t,'5511999999902');
  if not (a->>'claimed')::boolean then raise exception 'idle conversation cannot receive notice'; end if;
  perform public.enqueue_sdr_work(t,'5511999999902',jsonb_build_object('msgId','n1','text','Outro horário','instance','test_fixture'));
  update public.sdr_conversation_work set available_at=now()-interval '1 second' where tenant_id=t and phone='5511999999902';
  if (public.claim_sdr_work(t,'5511999999902')->>'claimed')::boolean then raise exception 'response overlapped scheduled notice'; end if;
  perform public.finish_sdr_work(t,'5511999999902',(a->>'token')::uuid,true);
  b:=public.claim_sdr_work(t,'5511999999902');
  if b#>>'{payload,msgId}'<>'n1' then raise exception 'input arriving during notice lost'; end if;

end; $$;
reset role;
do $$ begin
  if has_table_privilege('anon','public.sdr_conversation_work','select') or
    has_function_privilege('authenticated','public.claim_sdr_work(text,text)','execute') or
    has_function_privilege('anon','public.trigger_sdr_work()','execute') then raise exception 'public queue access'; end if;
end; $$;
rollback;
