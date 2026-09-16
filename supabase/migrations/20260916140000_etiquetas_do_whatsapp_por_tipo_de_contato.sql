-- ─────────────────────────────────────────────────────────────────────────────
-- Etiquetas do WhatsApp por tipo de contato (16/09/2026)
--
-- Pedido da direção: separar no WhatsApp quem é aluno, lead, professor e
-- candidato a professor. O sistema já sabe disso — `whatsapp_conversations.
-- contact_kind` classifica cada conversa —, e o WhatsApp Business da escola já
-- tem as etiquetas criadas no aplicativo (a API aplica etiqueta existente, mas
-- não cria).
--
-- Aqui fica só a memória do que já foi etiquetado, para não repetir chamada ao
-- provedor a cada rodada e para saber o que REMOVER quando a pessoa muda de
-- categoria — lead que vira aluno tem que perder a etiqueta de lead.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists private.whatsapp_conversation_labels (
  tenant_id text not null,
  remote_jid text not null,
  phone text,
  label_id text not null,
  label_kind text not null,
  applied_at timestamptz not null default now(),
  primary key (tenant_id, remote_jid)
);

alter table private.whatsapp_conversation_labels owner to postgres;
alter table private.whatsapp_conversation_labels enable row level security;

-- As conversas que precisam ganhar (ou trocar) etiqueta. `label_id_atual` é o
-- que está aplicado hoje: quando vem preenchido e o tipo mudou, quem chama
-- remove essa etiqueta antes de aplicar a nova.
create or replace function public.whatsapp_label_targets(
  p_tenant text, p_instance text, p_limit integer default 20
)
returns table(
  remote_jid text, phone text, contact_kind text,
  label_id_atual text, label_kind_atual text
)
language sql security definer set search_path = '' as $$
  select c.remote_jid,
    pg_catalog.regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'),
    c.contact_kind,
    aplicada.label_id,
    aplicada.label_kind
  from public.whatsapp_conversations as c
  left join private.whatsapp_conversation_labels as aplicada
    on aplicada.tenant_id = c.tenant_id and aplicada.remote_jid = c.remote_jid
  where c.tenant_id = p_tenant
    and c.instance_name = p_instance
    and c.contact_kind in ('student', 'lead', 'teacher', 'candidate')
    and c.remote_jid like '%@s.whatsapp.net'
    and coalesce(aplicada.label_kind, '') is distinct from c.contact_kind
  order by c.last_message_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 20), 60));
$$;

create or replace function public.whatsapp_label_marked(
  p_tenant text, p_remote_jid text, p_phone text, p_label_id text, p_label_kind text
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_tenant is null or coalesce(pg_catalog.btrim(coalesce(p_remote_jid, '')), '') = ''
     or coalesce(pg_catalog.btrim(coalesce(p_label_id, '')), '') = ''
     or p_label_kind not in ('student', 'lead', 'teacher', 'candidate') then
    return false;
  end if;
  insert into private.whatsapp_conversation_labels (
    tenant_id, remote_jid, phone, label_id, label_kind, applied_at
  ) values (
    p_tenant, p_remote_jid,
    pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'),
    p_label_id, p_label_kind, pg_catalog.now()
  )
  on conflict (tenant_id, remote_jid) do update
    set label_id = excluded.label_id,
        label_kind = excluded.label_kind,
        phone = excluded.phone,
        applied_at = excluded.applied_at;
  return true;
end $$;

alter function public.whatsapp_label_targets(text, text, integer) owner to postgres;
alter function public.whatsapp_label_marked(text, text, text, text, text) owner to postgres;
revoke all on function public.whatsapp_label_targets(text, text, integer) from public, anon, authenticated;
revoke all on function public.whatsapp_label_marked(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_label_targets(text, text, integer) to service_role;
grant execute on function public.whatsapp_label_marked(text, text, text, text, text) to service_role;

create or replace function public.trigger_whatsapp_label_sync()
returns bigint language plpgsql security definer set search_path = '' as $fn$
declare service_key text; request_id bigint;
begin
  select decrypted_secret into service_key
    from vault.decrypted_secrets where name = 'wisewolf_service_role_key' limit 1;
  if nullif(service_key, '') is null then return -1; end if;
  select net.http_post(
    url := 'http://kong:8000/functions/v1/whatsapp-inbound?worker=labels',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into request_id;
  return request_id;
end $fn$;

alter function public.trigger_whatsapp_label_sync() owner to postgres;
revoke all on function public.trigger_whatsapp_label_sync() from public, anon, authenticated;

do $cron$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('wisewolf-whatsapp-labels', '*/15 * * * *',
      'select public.trigger_whatsapp_label_sync();');
  end if;
end $cron$;
