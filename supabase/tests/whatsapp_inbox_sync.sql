\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

-- Contrato estrutural consumido diretamente pela tela.
select pg_temp.assert_true(
  to_regclass('public.whatsapp_conversations') is not null
  and to_regclass('public.whatsapp_messages') is not null
  and to_regclass('public.whatsapp_webhook_inbox') is not null
  and to_regclass('public.whatsapp_conversation_reads') is not null,
  'tabelas canonicas da inbox estao ausentes'
);

select pg_temp.assert_true(
  (
    select pg_get_constraintdef(oid) ilike
      '%FOREIGN KEY (tenant_id, instance_id, instance_name)%'
    from pg_catalog.pg_constraint
    where conrelid = 'public.whatsapp_conversations'::regclass
      and conname = 'whatsapp_conversations_tenant_instance_fkey'
  )
  and (
    select pg_get_constraintdef(oid) ilike
      '%FOREIGN KEY (tenant_id, conversation_id, instance_id)%'
    from pg_catalog.pg_constraint
    where conrelid = 'public.whatsapp_messages'::regclass
      and conname = 'whatsapp_messages_conversation_scope_fkey'
  ),
  'FKs compostas nao garantem escopo tenant da inbox'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from unnest(array[
      'instance_name', 'remote_jid', 'phone', 'display_name', 'contact_kind',
      'last_message_at', 'last_message_preview', 'unread_count', 'assigned_to',
      'human_handoff_until', 'archived', 'updated_at'
    ]) as required(column_name)
    where not exists (
      select 1
      from information_schema.columns as column_definition
      where column_definition.table_schema = 'public'
        and column_definition.table_name = 'whatsapp_conversations'
        and column_definition.column_name = required.column_name
    )
  )
  and not exists (
    select 1
    from unnest(array[
      'provider_message_id', 'client_request_id', 'direction', 'sender_kind',
      'message_type', 'body', 'status', 'occurred_at', 'sent_by_user_id',
      'error_code', 'updated_at'
    ]) as required(column_name)
    where not exists (
      select 1
      from information_schema.columns as column_definition
      where column_definition.table_schema = 'public'
        and column_definition.table_name = 'whatsapp_messages'
        and column_definition.column_name = required.column_name
    )
  ),
  'colunas esperadas pelo cliente da inbox estao ausentes'
);

select pg_temp.assert_true(
  has_table_privilege('authenticated', 'public.whatsapp_conversations', 'SELECT')
  and has_table_privilege('authenticated', 'public.whatsapp_messages', 'SELECT')
  and not has_table_privilege('authenticated', 'public.whatsapp_conversations', 'INSERT')
  and not has_table_privilege('authenticated', 'public.whatsapp_conversations', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.whatsapp_conversations', 'DELETE')
  and not has_table_privilege('authenticated', 'public.whatsapp_messages', 'INSERT')
  and not has_table_privilege('authenticated', 'public.whatsapp_messages', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.whatsapp_messages', 'DELETE')
  and not has_table_privilege('authenticated', 'public.whatsapp_webhook_inbox', 'SELECT')
  and not has_table_privilege('anon', 'public.whatsapp_conversations', 'SELECT'),
  'browser recebeu escrita ou acesso ao webhook service-only'
);

select pg_temp.assert_true(
  has_column_privilege(
    'authenticated', 'public.whatsapp_instances', 'tenant_id', 'SELECT'
  )
  and has_column_privilege(
    'authenticated', 'public.whatsapp_instances', 'inbox_enabled', 'SELECT'
  )
  and not has_column_privilege(
    'authenticated', 'public.whatsapp_instances', 'api_key', 'SELECT'
  ),
  'filtro tenant/opt-in da instancia nao e legivel ou segredo foi exposto'
);

select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.enable_whatsapp_inbox(text,text,uuid,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.enqueue_whatsapp_webhook_event(text,text,text,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.store_whatsapp_provider_message(text,text,text,text,text,text,text,text,timestamptz,text,text,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.store_whatsapp_provider_messages(text,text,jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.prepare_whatsapp_outbound(text,text,uuid,uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.prepare_whatsapp_outbound(text,text,uuid,uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.store_whatsapp_provider_messages(text,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.enqueue_whatsapp_webhook_event(text,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'RPCs da inbox nao ficaram estritamente service-only'
);

select pg_temp.assert_true(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'whatsapp_conversations'
  )
  and exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'whatsapp_messages'
  ),
  'tabelas da inbox nao foram publicadas no Supabase Realtime'
);

select pg_temp.assert_true(
  pg_get_functiondef(
    'public.resolve_tenant_integration_for_service(text,text,text,text)'::regprocedure
  ) ilike '%''chat.list''%'
  and pg_get_functiondef(
    'public.resolve_tenant_integration_for_service(text,text,text,text)'::regprocedure
  ) ilike '%''chat.history''%'
  and pg_get_functiondef(
    'public.resolve_tenant_integration_for_service(text,text,text,text)'::regprocedure
  ) ilike '%''webhook.configure''%',
  'allowlist do broker nao cobre leitura e configuracao segura da inbox'
);

select pg_temp.assert_true(
  private.merge_whatsapp_message_status('uncertain', 'queued') = 'uncertain'
  and private.merge_whatsapp_message_status('uncertain', 'dispatching') = 'uncertain'
  and private.merge_whatsapp_message_status('dispatching', 'queued') = 'dispatching'
  and private.merge_whatsapp_message_status('uncertain', 'sent') = 'sent',
  'maquina de status permite retry cego ou bloqueia confirmacao posterior'
);

-- Fixtures isoladas; o JWT service_role evita os guards de intake publico.
set local request.jwt.claims = '{"role":"service_role"}';

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values
  (
    'whatsapp-inbox-test-a',
    'WhatsApp Inbox Test A',
    'whatsapp-inbox-test-a',
    'active',
    true
  ),
  (
    'whatsapp-inbox-test-b',
    'WhatsApp Inbox Test B',
    'whatsapp-inbox-test-b',
    'active',
    true
  );

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000da01',
    'authenticated', 'authenticated', 'wa-inbox-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Admin Inbox A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000db01',
    'authenticated', 'authenticated', 'wa-inbox-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Admin Inbox B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000da02',
    'authenticated', 'authenticated', 'wa-inbox-coord@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Coordinator Inbox A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000da03',
    'authenticated', 'authenticated', 'wa-inbox-super@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Global Super Inbox"}', now(), now()
  );

update public.profiles
set tenant_id = 'whatsapp-inbox-test-a',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Admin Inbox A',
    phone = '5511999990101'
where id = '00000000-0000-4000-8000-00000000da01';

update public.profiles
set tenant_id = 'whatsapp-inbox-test-b',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Admin Inbox B',
    phone = '5511999990202'
where id = '00000000-0000-4000-8000-00000000db01';

update public.profiles
set tenant_id = 'whatsapp-inbox-test-a',
    role = 'COORDINATOR',
    lifecycle_status = 'active',
    full_name = 'Coordinator Inbox A',
    phone = '5511999990102'
where id = '00000000-0000-4000-8000-00000000da02';

-- SUPER_ADMIN global: a autoridade vem do perfil canonico, enquanto o tenant
-- corrente vem somente de membership/context ativos.
update public.profiles
set tenant_id = null,
    role = 'SUPER_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Global Super Inbox',
    phone = '5511999990103'
where id = '00000000-0000-4000-8000-00000000da03';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  (
    '00000000-0000-4000-8000-00000000da01',
    'whatsapp-inbox-test-a', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000db01',
    'whatsapp-inbox-test-b', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000da02',
    'whatsapp-inbox-test-a', 'COORDINATOR', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000da03',
    'whatsapp-inbox-test-a', 'SCHOOL_ADMIN', 'ACTIVE', true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  (
    '00000000-0000-4000-8000-00000000da01',
    'whatsapp-inbox-test-a'
  ),
  (
    '00000000-0000-4000-8000-00000000db01',
    'whatsapp-inbox-test-b'
  ),
  (
    '00000000-0000-4000-8000-00000000da02',
    'whatsapp-inbox-test-a'
  ),
  (
    '00000000-0000-4000-8000-00000000da03',
    'whatsapp-inbox-test-a'
  )
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.whatsapp_instances (
  user_id, instance_name, instance_id, status
)
values
  (
    '00000000-0000-4000-8000-00000000da01',
    'wa-inbox-instance-a', 'provider-instance-a', 'connected'
  ),
  (
    '00000000-0000-4000-8000-00000000db01',
    'wa-inbox-instance-b', 'provider-instance-b', 'connected'
  );

insert into public.dre_report_settings (
  tenant_id, destino, cadencia, dia_semana, is_active
)
values (
  'whatsapp-inbox-test-a',
  '120363000000001@g.us',
  'semanal',
  1,
  true
);

insert into public.crm_leads (
  tenant_id, name, phone, status, source
)
values
  (
    'whatsapp-inbox-test-a', 'Lead Inbox A',
    '(11) 98888-7701', 'CONTACTED', 'migration_test'
  ),
  (
    'whatsapp-inbox-test-b', 'Lead Inbox B',
    '(11) 98888-7701', 'CONTACTED', 'migration_test'
  );

insert into public.job_applications (
  tenant_id, name, whatsapp, status, source, role
)
values
  (
    'whatsapp-inbox-test-a', 'Candidate Inbox A',
    '5511988887701', 'Novo', 'migration_test', 'professor'
  ),
  (
    'whatsapp-inbox-test-b', 'Candidate Inbox B',
    '5511988887701', 'Novo', 'migration_test', 'professor'
  );

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
begin
  perform public.store_whatsapp_provider_message(
    'whatsapp-inbox-test-a',
    'wa-inbox-instance-a',
    '5511988887701@s.whatsapp.net',
    'disabled-message',
    'in', 'contact', 'text', 'Nao deve persistir', now(),
    null, null, 'received', '{"source":"webhook"}'::jsonb
  );
  raise exception 'assertion failed: instancia sem opt-in persistiu mensagem';
exception
  when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  (
    public.enable_whatsapp_inbox(
      'whatsapp-inbox-test-a',
      'WA-INBOX-INSTANCE-A',
      '00000000-0000-4000-8000-00000000da01',
      true
    ) ->> 'inboxEnabled'
  )::boolean
  and (
    public.enable_whatsapp_inbox(
      'whatsapp-inbox-test-b',
      'wa-inbox-instance-b',
      '00000000-0000-4000-8000-00000000db01',
      true
    ) ->> 'inboxEnabled'
  )::boolean,
  'opt-in explicito nao habilitou as instancias institucionais'
);

select pg_temp.assert_true(
  not (
    public.enable_whatsapp_inbox(
      'whatsapp-inbox-test-a',
      'wa-inbox-instance-a',
      '00000000-0000-4000-8000-00000000da03',
      false
    ) ->> 'inboxEnabled'
  )::boolean
  and (
    public.enable_whatsapp_inbox(
      'whatsapp-inbox-test-a',
      'wa-inbox-instance-a',
      '00000000-0000-4000-8000-00000000da03',
      true
    ) ->> 'inboxEnabled'
  )::boolean,
  'SUPER_ADMIN global nao conseguiu administrar o opt-in do tenant corrente'
);

-- Inbox duravel: retry de received/failed reabre; processed e no-op.
select pg_temp.assert_true(
  (
    public.enqueue_whatsapp_webhook_event(
      'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
      'messages.upsert', 'event-a-1', '{"attempt":1}'::jsonb
    ) ->> 'inserted'
  )::boolean,
  'primeiro webhook nao foi enfileirado'
);

select public.enqueue_whatsapp_webhook_event(
  'whatsapp-inbox-test-a', 'WA-INBOX-INSTANCE-A',
  'messages.upsert', 'event-a-1', '{"attempt":2}'::jsonb
);

select pg_temp.assert_true(
  (
    select status = 'received' and attempt_count = 1
    from public.whatsapp_webhook_inbox
    where tenant_id = 'whatsapp-inbox-test-a'
      and event_key = 'event-a-1'
  ),
  'retry de webhook recebido nao incrementou tentativa/normalizou estado'
);

update public.whatsapp_webhook_inbox
set status = 'processed', processed_at = now()
where tenant_id = 'whatsapp-inbox-test-a'
  and event_key = 'event-a-1';

select pg_temp.assert_true(
  (
    public.enqueue_whatsapp_webhook_event(
      'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
      'messages.upsert', 'event-a-1', '{"attempt":3}'::jsonb
    ) ->> 'status'
  ) = 'processed'
  and (
    select attempt_count = 1 and payload = '{"attempt":2}'::jsonb
    from public.whatsapp_webhook_inbox
    where tenant_id = 'whatsapp-inbox-test-a'
      and event_key = 'event-a-1'
  ),
  'redelivery processada foi reaberta ou sobrescrita'
);

update public.whatsapp_webhook_inbox
set status = 'failed', processed_at = null, last_error = 'fixture'
where tenant_id = 'whatsapp-inbox-test-a'
  and event_key = 'event-a-1';

select public.enqueue_whatsapp_webhook_event(
  'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
  'messages.upsert', 'event-a-1', '{"attempt":4}'::jsonb
);

select pg_temp.assert_true(
  (
    select status = 'received'
      and attempt_count = 2
      and processed_at is null
      and last_error is null
    from public.whatsapp_webhook_inbox
    where tenant_id = 'whatsapp-inbox-test-a'
      and event_key = 'event-a-1'
  ),
  'retry de webhook falho nao voltou atomicamente para received'
);

-- Baseline sync nao nasce como nao lido; somente inbound novo do webhook conta.
select public.store_whatsapp_provider_message(
  'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
  '5511988887701@s.whatsapp.net', 'provider-a-sync-1',
  'in', 'contact', 'text', 'Historico antigo', now() - interval '2 hours',
  null, null, 'received', '{"source":"sync"}'::jsonb
);

select public.store_whatsapp_provider_message(
  'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
  '5511988887701@s.whatsapp.net', 'provider-a-webhook-1',
  'in', 'contact', 'text', 'Preciso de ajuda', now() - interval '1 minute',
  null, null, 'received', '{"source":"webhook"}'::jsonb
);

-- Evento status-only preserva conteudo e tipo já conhecidos.
select public.store_whatsapp_provider_message(
  'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
  '5511988887701@s.whatsapp.net', 'provider-a-webhook-1',
  'in', 'system', 'unknown', '[Mensagem não suportada]', now(),
  null, null, 'read', '{"source":"webhook","ack":true}'::jsonb
);

select pg_temp.assert_true(
  (
    select contact_kind = 'lead'
      and display_name = 'Lead Inbox A'
      and phone = '5511988887701'
      and unread_count = 1
    from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
  )
  and (
    select message_type = 'text'
      and body = 'Preciso de ajuda'
      and status = 'read'
      and metadata ->> 'ack' = 'true'
    from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-a'
      and provider_message_id = 'provider-a-webhook-1'
  ),
  'enriquecimento, unread ou preservacao de status-only divergiu'
);

-- Batch camelCase e atomico; a RPC força source=sync.
select pg_temp.assert_true(
  (
    public.store_whatsapp_provider_messages(
      'whatsapp-inbox-test-a',
      'wa-inbox-instance-a',
      jsonb_build_array(
        jsonb_build_object(
          'remoteJid', '5511988887701@s.whatsapp.net',
          'providerMessageId', 'provider-a-batch-1',
          'direction', 'in', 'senderKind', 'contact',
          'messageType', 'text', 'body', 'Historico lote 1',
          'occurredAt', now() - interval '90 minutes',
          'displayName', null, 'phone', null, 'status', 'received',
          'metadata', jsonb_build_object('source', 'webhook')
        ),
        jsonb_build_object(
          'remoteJid', '5511988887701@s.whatsapp.net',
          'providerMessageId', 'provider-a-batch-2',
          'direction', 'in', 'senderKind', 'contact',
          'messageType', 'text', 'body', 'Historico lote 2',
          'occurredAt', now() - interval '80 minutes',
          'displayName', null, 'phone', null, 'status', 'received',
          'metadata', '{}'::jsonb
        )
      )
    ) ->> 'stored'
  )::integer = 2,
  'batch inicial nao persistiu duas mensagens'
);

select pg_temp.assert_true(
  (
    public.store_whatsapp_provider_messages(
      'whatsapp-inbox-test-a',
      'wa-inbox-instance-a',
      jsonb_build_array(
        jsonb_build_object(
          'remoteJid', '5511988887701@s.whatsapp.net',
          'providerMessageId', 'provider-a-batch-1',
          'direction', 'in', 'senderKind', 'contact',
          'messageType', 'text', 'body', 'Historico lote 1',
          'occurredAt', now() - interval '90 minutes',
          'status', 'received', 'metadata', '{}'::jsonb
        ),
        jsonb_build_object(
          'remoteJid', '5511988887701@s.whatsapp.net',
          'providerMessageId', 'provider-a-batch-2',
          'direction', 'in', 'senderKind', 'contact',
          'messageType', 'text', 'body', 'Historico lote 2',
          'occurredAt', now() - interval '80 minutes',
          'status', 'received', 'metadata', '{}'::jsonb
        )
      )
    ) ->> 'stored'
  )::integer = 0
  and (
    select unread_count = 1
    from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
  ),
  'batch duplicado criou linhas ou baseline incrementou unread'
);

do $$
begin
  perform public.store_whatsapp_provider_messages(
    'whatsapp-inbox-test-a',
    'wa-inbox-instance-a',
    jsonb_build_array(
      jsonb_build_object(
        'remoteJid', '5511988887701@s.whatsapp.net',
        'providerMessageId', 'provider-a-atomic-good',
        'direction', 'in', 'senderKind', 'contact',
        'messageType', 'text', 'body', 'Deve sofrer rollback',
        'occurredAt', now(), 'status', 'received', 'metadata', '{}'::jsonb
      ),
      jsonb_build_object(
        'remoteJid', '5511988887701@s.whatsapp.net',
        'providerMessageId', 'provider-a-atomic-bad',
        'direction', 'sideways', 'senderKind', 'contact',
        'messageType', 'text', 'body', 'Invalida',
        'occurredAt', now(), 'status', 'received', 'metadata', '{}'::jsonb
      )
    )
  );
  raise exception 'assertion failed: batch aceitou item invalido';
exception
  when invalid_parameter_value then null;
end;
$$;

select pg_temp.assert_true(
  not exists (
    select 1
    from public.whatsapp_messages
    where provider_message_id = 'provider-a-atomic-good'
  ),
  'falha no meio do batch deixou gravacao parcial'
);

-- Segundo tenant usa o mesmo telefone sem contaminar identidade nem RLS.
select public.store_whatsapp_provider_message(
  'whatsapp-inbox-test-b', 'wa-inbox-instance-b',
  '5511988887701@s.whatsapp.net', 'provider-b-webhook-1',
  'in', 'contact', 'text', 'Mensagem tenant B', now(),
  null, null, 'received', '{"source":"webhook"}'::jsonb
);

-- Envio manual liga o handoff da conversa e dos dois agentes legados somente
-- no tenant A. client_request_id torna o prepare idempotente.
select public.prepare_whatsapp_outbound(
  'whatsapp-inbox-test-a',
  'wa-inbox-instance-a',
  (
    select id from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
  ),
  '00000000-0000-4000-8000-00000000da01',
  '00000000-0000-4000-8000-00000000dc01',
  'Resposta humana'
);

reset role;

select pg_temp.assert_true(
  (
    select ai_handoff and ai_handoff_at is not null
    from public.crm_leads
    where tenant_id = 'whatsapp-inbox-test-a'
  )
  and (
    select ai_handoff and ai_handoff_at is not null
    from public.job_applications
    where tenant_id = 'whatsapp-inbox-test-a'
  )
  and not (
    select ai_handoff
    from public.crm_leads
    where tenant_id = 'whatsapp-inbox-test-b'
  )
  and not (
    select ai_handoff
    from public.job_applications
    where tenant_id = 'whatsapp-inbox-test-b'
  ),
  'handoff humano nao silenciou Bia/Michelle ou vazou para outro tenant'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select public.set_whatsapp_conversation_handoff(
  'whatsapp-inbox-test-a',
  (
    select id from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
  ),
  '00000000-0000-4000-8000-00000000da01',
  false
);

reset role;

select pg_temp.assert_true(
  not (
    select ai_handoff from public.crm_leads
    where tenant_id = 'whatsapp-inbox-test-a'
  )
  and (
    select ai_handoff_at is null from public.crm_leads
    where tenant_id = 'whatsapp-inbox-test-a'
  )
  and not (
    select ai_handoff from public.job_applications
    where tenant_id = 'whatsapp-inbox-test-a'
  )
  and (
    select ai_handoff_at is null from public.job_applications
    where tenant_id = 'whatsapp-inbox-test-a'
  ),
  'desativar handoff nao devolveu o contato aos agentes'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  (
    public.prepare_whatsapp_outbound(
      'whatsapp-inbox-test-a',
      'wa-inbox-instance-a',
      (
        select id from public.whatsapp_conversations
        where tenant_id = 'whatsapp-inbox-test-a'
      ),
      '00000000-0000-4000-8000-00000000da01',
      '00000000-0000-4000-8000-00000000dc01',
      'Resposta humana'
    ) ->> 'duplicate'
  )::boolean
  and (
    select count(*) = 1
    from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-a'
      and client_request_id = '00000000-0000-4000-8000-00000000dc01'
  ),
  'retry do client_request_id duplicou o envio manual'
);

select pg_temp.assert_true(
  (
    public.claim_whatsapp_outbound(
      'whatsapp-inbox-test-a',
      (
        select id from public.whatsapp_messages
        where tenant_id = 'whatsapp-inbox-test-a'
          and client_request_id = '00000000-0000-4000-8000-00000000dc01'
      ),
      '00000000-0000-4000-8000-00000000da01'
    ) ->> 'claimed'
  )::boolean,
  'outbox enfileirada nao recebeu lease atomica'
);

update public.whatsapp_messages
set lease_until = now() - interval '1 second'
where tenant_id = 'whatsapp-inbox-test-a'
  and client_request_id = '00000000-0000-4000-8000-00000000dc01';

select pg_temp.assert_true(
  (
    public.claim_whatsapp_outbound(
      'whatsapp-inbox-test-a',
      (
        select id from public.whatsapp_messages
        where tenant_id = 'whatsapp-inbox-test-a'
          and client_request_id = '00000000-0000-4000-8000-00000000dc01'
      ),
      '00000000-0000-4000-8000-00000000da01'
    ) ->> 'status'
  ) = 'uncertain',
  'lease expirada causou retry cego em vez de estado uncertain'
);

select public.finalize_whatsapp_outbound(
  'whatsapp-inbox-test-a',
  (
    select id from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-a'
      and client_request_id = '00000000-0000-4000-8000-00000000dc01'
  ),
  'uncertain', 'provider-a-outbound-1', 'provider_timeout'
);

select pg_temp.assert_true(
  (
    public.store_whatsapp_provider_message(
      'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
      '5511988887701@s.whatsapp.net', 'provider-a-outbound-1',
      'out', 'system', 'text', 'Resposta humana', now(),
      null, null, 'queued', '{"source":"webhook"}'::jsonb
    ) ->> 'status'
  ) = 'uncertain'
  and not (
    public.claim_whatsapp_outbound(
      'whatsapp-inbox-test-a',
      (
        select id from public.whatsapp_messages
        where tenant_id = 'whatsapp-inbox-test-a'
          and client_request_id = '00000000-0000-4000-8000-00000000dc01'
      ),
      '00000000-0000-4000-8000-00000000da01'
    ) ->> 'claimed'
  )::boolean,
  'PENDING tardio reabriu mensagem uncertain para novo despacho'
);

select public.finalize_whatsapp_outbound(
  'whatsapp-inbox-test-a',
  (
    select id from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-a'
      and client_request_id = '00000000-0000-4000-8000-00000000dc01'
  ),
  'sent', 'provider-a-outbound-1', null
);

select pg_temp.assert_true(
  (
    select status = 'sent'
      and provider_message_id = 'provider-a-outbound-1'
      and lease_until is null
      and error_code is null
    from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-a'
      and client_request_id = '00000000-0000-4000-8000-00000000dc01'
  ),
  'finalizacao nao reconciliou resultado posterior ao uncertain'
);

select public.mark_whatsapp_conversation_read(
  'whatsapp-inbox-test-a',
  (
    select id from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
  ),
  '00000000-0000-4000-8000-00000000da01'
);

select pg_temp.assert_true(
  (
    select unread_count = 0
    from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
  )
  and exists (
    select 1
    from public.whatsapp_conversation_reads
    where tenant_id = 'whatsapp-inbox-test-a'
      and user_id = '00000000-0000-4000-8000-00000000da01'
      and last_read_message_id is not null
  ),
  'mark-read nao zerou unread nem gravou cursor do usuario'
);

select pg_temp.assert_true(
  (
    public.resolve_tenant_integration_for_service(
      'whatsapp-inbox-test-a', 'evolution',
      'automation.whatsapp', 'chat.list'
    ) ->> 'mode'
  ) = 'PLATFORM_MANAGED'
  and (
    public.resolve_tenant_integration_for_service(
      'whatsapp-inbox-test-a', 'evolution',
      'automation.whatsapp', 'chat.history'
    ) ->> 'mode'
  ) = 'PLATFORM_MANAGED'
  and (
    public.resolve_tenant_integration_for_service(
      'whatsapp-inbox-test-a', 'evolution',
      'automation.whatsapp', 'webhook.configure'
    ) ->> 'mode'
  ) = 'PLATFORM_MANAGED',
  'broker recusou finalidade segura usada pela inbox'
);

-- Grupos nao sao destinos gerais da inbox: somente o grupo gerencial exato,
-- ativo e do mesmo tenant pode receber novas mensagens ou envios.
select public.store_whatsapp_provider_message(
  'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
  '120363000000001@g.us', 'provider-a-group-current',
  'in', 'contact', 'text', 'Historico do grupo atual', now(),
  'Gestao A', null, 'received', '{"source":"webhook"}'::jsonb
);

do $$
begin
  perform public.store_whatsapp_provider_message(
    'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
    '120363000000003@g.us', 'provider-a-group-never-allowed',
    'in', 'contact', 'text', 'Grupo nao configurado', now(),
    null, null, 'received', '{"source":"webhook"}'::jsonb
  );
  raise exception 'assertion failed: grupo nao configurado foi persistido';
exception
  when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  (
    public.set_whatsapp_conversation_handoff(
      'whatsapp-inbox-test-a',
      (
        select id from public.whatsapp_conversations
        where tenant_id = 'whatsapp-inbox-test-a'
          and remote_jid = '120363000000001@g.us'
      ),
      '00000000-0000-4000-8000-00000000da03',
      true
    ) ->> 'handoffActive'
  )::boolean
  and (
    public.mark_whatsapp_conversation_read(
      'whatsapp-inbox-test-a',
      (
        select id from public.whatsapp_conversations
        where tenant_id = 'whatsapp-inbox-test-a'
          and remote_jid = '120363000000001@g.us'
      ),
      '00000000-0000-4000-8000-00000000da03'
    ) ->> 'ok'
  )::boolean
  and (
    public.prepare_whatsapp_outbound(
      'whatsapp-inbox-test-a',
      'wa-inbox-instance-a',
      (
        select id from public.whatsapp_conversations
        where tenant_id = 'whatsapp-inbox-test-a'
          and remote_jid = '120363000000001@g.us'
      ),
      '00000000-0000-4000-8000-00000000da03',
      '00000000-0000-4000-8000-00000000dc04',
      'Resposta global no grupo atual'
    ) ->> 'status'
  ) = 'queued',
  'SUPER_ADMIN global nao conseguiu handoff, mark-read ou envio no tenant ativo'
);

select public.set_whatsapp_conversation_handoff(
  'whatsapp-inbox-test-a',
  (
    select id from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
      and remote_jid = '120363000000001@g.us'
  ),
  '00000000-0000-4000-8000-00000000da03',
  false
);

-- O grupo salvo vira historico assim que a direcao troca o destino.
reset role;
update public.dre_report_settings
set destino = '120363000000002@g.us', updated_at = now()
where tenant_id = 'whatsapp-inbox-test-a';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  not (
    public.claim_whatsapp_outbound(
      'whatsapp-inbox-test-a',
      (
        select id from public.whatsapp_messages
        where client_request_id = '00000000-0000-4000-8000-00000000dc04'
      ),
      '00000000-0000-4000-8000-00000000da03'
    ) ->> 'claimed'
  )::boolean
  and (
    select status = 'queued'
    from public.whatsapp_messages
    where client_request_id = '00000000-0000-4000-8000-00000000dc04'
  ),
  'claim despachou mensagem preparada para grupo que deixou de ser o destino'
);

do $$
begin
  perform public.prepare_whatsapp_outbound(
    'whatsapp-inbox-test-a',
    'wa-inbox-instance-a',
    (
      select id from public.whatsapp_conversations
      where tenant_id = 'whatsapp-inbox-test-a'
        and remote_jid = '120363000000001@g.us'
    ),
    '00000000-0000-4000-8000-00000000da03',
    '00000000-0000-4000-8000-00000000dc05',
    'Nao pode sair para grupo antigo'
  );
  raise exception 'assertion failed: conversa de grupo antiga aceitou envio';
exception
  when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.store_whatsapp_provider_message(
    'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
    '120363000000001@g.us', 'provider-a-group-stale',
    'in', 'contact', 'text', 'Nao deve entrar no grupo antigo', now(),
    null, null, 'received', '{"source":"webhook"}'::jsonb
  );
  raise exception 'assertion failed: grupo antigo recebeu nova mensagem';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;
update public.dre_report_settings
set is_active = false, updated_at = now()
where tenant_id = 'whatsapp-inbox-test-a';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
begin
  perform public.store_whatsapp_provider_message(
    'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
    '120363000000002@g.us', 'provider-a-group-disabled',
    'in', 'contact', 'text', 'Nao deve entrar com destino desligado', now(),
    null, null, 'received', '{"source":"webhook"}'::jsonb
  );
  raise exception 'assertion failed: grupo desativado recebeu nova mensagem';
exception
  when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  (
    select contact_kind = 'group'
      and display_name = 'Gestao A'
      and unread_count = 0
      and handoff_active is false
    from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
      and remote_jid = '120363000000001@g.us'
  )
  and exists (
    select 1 from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-a'
      and provider_message_id = 'provider-a-group-current'
  )
  and exists (
    select 1 from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-a'
      and client_request_id = '00000000-0000-4000-8000-00000000dc04'
      and sent_by_user_id = '00000000-0000-4000-8000-00000000da03'
  )
  and not exists (
    select 1 from public.whatsapp_messages
    where provider_message_id in (
      'provider-a-group-never-allowed',
      'provider-a-group-stale',
      'provider-a-group-disabled'
    )
      or client_request_id = '00000000-0000-4000-8000-00000000dc05'
  ),
  'grupo historico foi apagado ou destinos antigo/desativado gravaram dados'
);

select public.prepare_whatsapp_outbound(
  'whatsapp-inbox-test-a',
  'wa-inbox-instance-a',
  (
    select id from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-a'
      and remote_jid = '5511988887701@s.whatsapp.net'
  ),
  '00000000-0000-4000-8000-00000000da02',
  '00000000-0000-4000-8000-00000000dc02',
  'Mensagem que nao pode sair apos perda do owner'
);

reset role;

-- RLS le apenas o tenant corrente; nenhum filtro passado pelo browser decide
-- isolamento por si só.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000da01","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 2
    from public.whatsapp_conversations
    where tenant_id in ('whatsapp-inbox-test-a', 'whatsapp-inbox-test-b')
  )
  and not exists (
    select 1
    from public.whatsapp_conversations
    where tenant_id = 'whatsapp-inbox-test-b'
  )
  and not exists (
    select 1
    from public.whatsapp_messages
    where tenant_id = 'whatsapp-inbox-test-b'
  ),
  'RLS permitiu leitura cross-tenant na inbox'
);

reset role;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-00000000da02","role":"authenticated"}';

select pg_temp.assert_true(
  (
    select count(*) = 1
    from public.whatsapp_instances
    where tenant_id in ('whatsapp-inbox-test-a', 'whatsapp-inbox-test-b')
      and inbox_enabled is true
  )
  and exists (
    select 1
    from public.whatsapp_instances
    where tenant_id = 'whatsapp-inbox-test-a'
      and instance_name = 'wa-inbox-instance-a'
      and inbox_enabled is true
  )
  and not exists (
    select 1
    from public.whatsapp_instances
    where tenant_id = 'whatsapp-inbox-test-b'
  ),
  'coordenador nao viu a instancia institucional ou atravessou tenant'
);

reset role;

-- O opt-in nao sobrevive operacionalmente a owner suspenso ou sem a funcao
-- institucional, mesmo que a coluna inbox_enabled ainda esteja true.
update public.tenant_memberships
set role = 'TEACHER', updated_at = now()
where user_id = '00000000-0000-4000-8000-00000000da01'
  and tenant_id = 'whatsapp-inbox-test-a';

select pg_temp.assert_true(
  not private.whatsapp_inbox_instance_is_eligible(
    'whatsapp-inbox-test-a',
    (
      select id from public.whatsapp_instances
      where instance_name = 'wa-inbox-instance-a'
    )
  ),
  'instancia continuou elegivel depois que owner perdeu SCHOOL_ADMIN'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
begin
  perform public.enqueue_whatsapp_webhook_event(
    'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
    'messages.upsert', 'event-owner-invalid', '{"fixture":true}'::jsonb
  );
  raise exception 'assertion failed: webhook entrou com owner inelegivel';
exception
  when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.store_whatsapp_provider_message(
    'whatsapp-inbox-test-a', 'wa-inbox-instance-a',
    '5511988887701@s.whatsapp.net', 'provider-owner-invalid',
    'in', 'contact', 'text', 'Nao deve entrar', now(),
    null, null, 'received', '{"source":"webhook"}'::jsonb
  );
  raise exception 'assertion failed: mensagem entrou com owner inelegivel';
exception
  when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.store_whatsapp_provider_messages(
    'whatsapp-inbox-test-a',
    'wa-inbox-instance-a',
    jsonb_build_array(jsonb_build_object(
      'remoteJid', '5511988887701@s.whatsapp.net',
      'providerMessageId', 'provider-owner-invalid-batch',
      'direction', 'in', 'senderKind', 'contact',
      'messageType', 'text', 'body', 'Nao deve sincronizar',
      'occurredAt', now(), 'status', 'received', 'metadata', '{}'::jsonb
    ))
  );
  raise exception 'assertion failed: sync entrou com owner inelegivel';
exception
  when insufficient_privilege then null;
end;
$$;

do $$
begin
  perform public.prepare_whatsapp_outbound(
    'whatsapp-inbox-test-a',
    'wa-inbox-instance-a',
    (
      select id from public.whatsapp_conversations
      where tenant_id = 'whatsapp-inbox-test-a'
        and remote_jid = '5511988887701@s.whatsapp.net'
    ),
    '00000000-0000-4000-8000-00000000da02',
    '00000000-0000-4000-8000-00000000dc03',
    'Nao deve preparar'
  );
  raise exception 'assertion failed: outbox preparada com owner inelegivel';
exception
  when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  not (
    public.claim_whatsapp_outbound(
      'whatsapp-inbox-test-a',
      (
        select id from public.whatsapp_messages
        where client_request_id = '00000000-0000-4000-8000-00000000dc02'
      ),
      '00000000-0000-4000-8000-00000000da02'
    ) ->> 'claimed'
  )::boolean
  and (
    select status = 'queued'
    from public.whatsapp_messages
    where client_request_id = '00000000-0000-4000-8000-00000000dc02'
  ),
  'claim despachou outbox depois que owner perdeu elegibilidade'
);

reset role;

update public.tenant_memberships
set role = 'SCHOOL_ADMIN', updated_at = now()
where user_id = '00000000-0000-4000-8000-00000000da01'
  and tenant_id = 'whatsapp-inbox-test-a';
update public.profiles
set lifecycle_status = 'suspended'
where id = '00000000-0000-4000-8000-00000000da01';

select pg_temp.assert_true(
  not private.whatsapp_inbox_instance_is_eligible(
    'whatsapp-inbox-test-a',
    (
      select id from public.whatsapp_instances
      where instance_name = 'wa-inbox-instance-a'
    )
  ),
  'instancia continuou elegivel depois que owner foi suspenso'
);

rollback;
