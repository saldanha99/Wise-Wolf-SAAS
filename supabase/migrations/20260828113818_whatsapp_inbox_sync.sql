begin;

-- Caixa de entrada institucional do WhatsApp.
--
-- A Evolution continua sendo apenas o transporte. O histórico exibido no
-- navegador mora no Postgres, sob RLS, e nenhuma credencial do provedor chega
-- ao cliente. Instâncias pessoais de professores permanecem fora da inbox: a
-- sincronização só começa depois de um opt-in explícito numa instância central
-- pertencente a um SCHOOL_ADMIN ativo.

do $guard$
begin
  if to_regclass('public.whatsapp_instances') is null
    or to_regclass('public.tenants') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.tenant_memberships') is null
    or to_regclass('public.crm_leads') is null
    or to_regclass('public.job_applications') is null
    or to_regclass('public.dre_report_settings') is null
    or to_regprocedure('private.active_tenant_id(uuid)') is null
    or to_regprocedure('private.active_tenant_role(uuid)') is null
    or to_regprocedure('private.tenant_is_operational(text)') is null
    or to_regprocedure('private.commercial_phones_match(text,text)') is null
  then
    raise exception 'whatsapp_inbox_tenant_foundation_is_required';
  end if;
end
$guard$;

alter table public.whatsapp_instances
  add column if not exists inbox_enabled boolean not null default false,
  add column if not exists inbox_enabled_at timestamptz,
  add column if not exists inbox_enabled_by uuid;

alter table public.whatsapp_instances
  drop constraint if exists whatsapp_instances_inbox_enabled_by_fkey;
alter table public.whatsapp_instances
  add constraint whatsapp_instances_inbox_enabled_by_fkey
  foreign key (inbox_enabled_by)
  references public.profiles(id)
  on delete set null
  not valid;
alter table public.whatsapp_instances
  validate constraint whatsapp_instances_inbox_enabled_by_fkey;

alter table public.whatsapp_instances
  drop constraint if exists whatsapp_instances_inbox_state_check;
alter table public.whatsapp_instances
  add constraint whatsapp_instances_inbox_state_check check (
    (
      inbox_enabled is false
      and inbox_enabled_at is null
      and inbox_enabled_by is null
    )
    or (
      inbox_enabled is true
      and inbox_enabled_at is not null
    )
  );

-- Permite FKs compostas que tornam tenant_id parte da integridade, em vez de
-- depender apenas de filtros nas queries.
create unique index if not exists whatsapp_instances_tenant_id_id_unique_idx
  on public.whatsapp_instances (tenant_id, id);
create unique index if not exists whatsapp_instances_tenant_id_id_name_unique_idx
  on public.whatsapp_instances (tenant_id, id, instance_name);
create index if not exists whatsapp_instances_inbox_enabled_idx
  on public.whatsapp_instances (tenant_id, updated_at desc)
  where inbox_enabled is true;

-- As colunas historicamente liberadas continuam intactas; a UI recebe apenas
-- o indicador adicional de opt-in, nunca credenciais ou campos de escrita.
grant select (tenant_id, inbox_enabled)
  on public.whatsapp_instances to authenticated;

alter table public.crm_leads
  add column if not exists ai_handoff boolean not null default false,
  add column if not exists ai_handoff_at timestamptz;
alter table public.job_applications
  add column if not exists ai_handoff boolean not null default false,
  add column if not exists ai_handoff_at timestamptz;

-- O sufixo de oito dígitos reduz o universo antes da comparação brasileira
-- canônica (que também valida DDD e a variação do nono dígito).
create index if not exists profiles_tenant_whatsapp_phone_suffix_idx
  on public.profiles (
    tenant_id,
    pg_catalog.right(
      pg_catalog.regexp_replace(coalesce(phone, ''), '\D', '', 'g'),
      8
    )
  )
  where role in ('STUDENT', 'TEACHER')
    and lower(pg_catalog.btrim(coalesce(lifecycle_status, ''))) = 'active';
create index if not exists crm_leads_tenant_whatsapp_phone_suffix_idx
  on public.crm_leads (
    tenant_id,
    pg_catalog.right(
      pg_catalog.regexp_replace(coalesce(phone, ''), '\D', '', 'g'),
      8
    )
  );
create index if not exists job_applications_tenant_whatsapp_phone_suffix_idx
  on public.job_applications (
    tenant_id,
    pg_catalog.right(
      pg_catalog.regexp_replace(coalesce(whatsapp, ''), '\D', '', 'g'),
      8
    )
  );

create or replace function private.whatsapp_inbox_actor_has_role(
  p_actor_id uuid,
  p_tenant_id text,
  p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_actor_id is not null
    and p_tenant_id is not null
    and p_roles is not null
    and private.tenant_is_operational(p_tenant_id)
    and private.active_tenant_id(p_actor_id) = p_tenant_id
    and private.active_tenant_role(p_actor_id) = any(p_roles)
    and exists (
      select 1
      from public.tenant_memberships as membership
      join public.profiles as profile
        on profile.id = membership.user_id
       and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, '')))
         = 'active'
      where membership.user_id = p_actor_id
        and membership.tenant_id = p_tenant_id
        and membership.status = 'ACTIVE'
    );
$function$;
revoke all on function private.whatsapp_inbox_actor_has_role(uuid,text,text[])
  from public, anon;
grant execute on function private.whatsapp_inbox_actor_has_role(uuid,text,text[])
  to authenticated, service_role;

create or replace function private.whatsapp_inbox_instance_is_eligible(
  p_tenant_id text,
  p_instance_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_tenant_id is not null
    and p_instance_id is not null
    and private.tenant_is_operational(p_tenant_id)
    and exists (
      select 1
      from public.whatsapp_instances as instance
      join public.tenant_memberships as membership
        on membership.user_id = instance.user_id
       and membership.tenant_id = instance.tenant_id
       and membership.role = 'SCHOOL_ADMIN'
       and membership.status = 'ACTIVE'
      join public.profiles as owner
        on owner.id = instance.user_id
       and lower(pg_catalog.btrim(coalesce(owner.lifecycle_status, '')))
         = 'active'
      where instance.id = p_instance_id
        and instance.tenant_id = p_tenant_id
        and instance.inbox_enabled is true
    );
$function$;
revoke all on function private.whatsapp_inbox_instance_is_eligible(text,uuid)
  from public, anon;
grant execute on function private.whatsapp_inbox_instance_is_eligible(text,uuid)
  to authenticated, service_role;

-- Conversas diretas usam o JID canonico da Evolution. Grupos sao mais
-- restritos: somente o destino gerencial atualmente ativo no mesmo tenant
-- pode receber novas mensagens. O historico de um grupo antigo continua
-- legivel, mas nao volta a ser um destino de envio por manter uma conversa.
create or replace function private.whatsapp_inbox_remote_jid_is_allowed(
  p_tenant_id text,
  p_remote_jid text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when nullif(pg_catalog.btrim(p_tenant_id), '') is null
      or nullif(pg_catalog.btrim(p_remote_jid), '') is null then false
    when lower(pg_catalog.btrim(p_remote_jid))
      ~ '^[0-9]{10,15}@s[.]whatsapp[.]net$'
      then true
    when lower(pg_catalog.btrim(p_remote_jid)) like '%@g.us' then exists (
      select 1
      from public.dre_report_settings as settings
      where settings.tenant_id = p_tenant_id
        and settings.is_active is true
        and lower(pg_catalog.btrim(settings.destino))
          = lower(pg_catalog.btrim(p_remote_jid))
    )
    else false
  end;
$function$;
revoke all on function private.whatsapp_inbox_remote_jid_is_allowed(text,text)
  from public, anon, authenticated;
grant execute on function private.whatsapp_inbox_remote_jid_is_allowed(text,text)
  to service_role;

create or replace function private.merge_whatsapp_message_status(
  p_current text,
  p_incoming text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_incoming is null or p_incoming = p_current then
    return p_current;
  end if;

  -- Confirmações do provedor são monotônicas. Um retry tardio de "sent" não
  -- pode rebaixar "delivered/read", e uma falha tardia não apaga uma entrega.
  if p_current = 'read' or p_incoming = 'read' then
    return 'read';
  end if;
  if p_current = 'delivered' or p_incoming = 'delivered' then
    return 'delivered';
  end if;
  if p_current = 'sent' or p_incoming = 'sent' then
    return 'sent';
  end if;
  if p_current = 'received' then
    return 'received';
  end if;
  if p_incoming = 'received' then
    return 'received';
  end if;
  -- Resultado ambiguo nunca volta para uma fila despachavel. Da mesma forma,
  -- um evento PENDING atrasado nao desfaz um dispatch que ja comecou.
  if p_current = 'uncertain'
     and p_incoming in ('queued', 'dispatching', 'uncertain') then
    return 'uncertain';
  end if;
  if p_current = 'dispatching' and p_incoming = 'queued' then
    return 'dispatching';
  end if;
  if p_current = 'failed'
     and p_incoming in ('queued', 'dispatching', 'uncertain', 'failed') then
    return 'failed';
  end if;
  if p_incoming = 'failed' then
    return 'failed';
  end if;
  if p_incoming = 'uncertain' then
    return 'uncertain';
  end if;
  return p_incoming;
end;
$function$;
revoke all on function private.merge_whatsapp_message_status(text,text)
  from public, anon, authenticated;
grant execute on function private.merge_whatsapp_message_status(text,text)
  to postgres, supabase_admin, service_role;

create or replace function private.resolve_whatsapp_contact(
  p_tenant_id text,
  p_phone text
)
returns table(contact_kind text, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_phone text := pg_catalog.regexp_replace(
    coalesce(p_phone, ''),
    '\D',
    '',
    'g'
  );
  v_suffix text;
  v_count bigint;
  v_kind text;
  v_name text;
begin
  if pg_catalog.char_length(v_phone) not between 10 and 15 then
    return query select 'unknown'::text, null::text;
    return;
  end if;
  v_suffix := pg_catalog.right(v_phone, 8);

  -- Um perfil ativo é a identidade mais forte: aluno/professor já pertence à
  -- escola. Mais de um perfil no mesmo telefone é ambíguo e não é adivinhado.
  select count(*), min(lower(profile.role)), min(
    nullif(pg_catalog.btrim(profile.full_name), '')
  )
  into v_count, v_kind, v_name
  from public.profiles as profile
  where profile.tenant_id = p_tenant_id
    and profile.role in ('STUDENT', 'TEACHER')
    and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
    and pg_catalog.right(
      pg_catalog.regexp_replace(coalesce(profile.phone, ''), '\D', '', 'g'),
      8
    ) = v_suffix
    and private.commercial_phones_match(profile.phone, v_phone);

  if v_count = 1 then
    return query select v_kind, v_name;
    return;
  elsif v_count > 1 then
    return query select 'unknown'::text, null::text;
    return;
  end if;

  select count(*), min(nullif(pg_catalog.btrim(lead.name), ''))
  into v_count, v_name
  from public.crm_leads as lead
  where lead.tenant_id = p_tenant_id
    and pg_catalog.right(
      pg_catalog.regexp_replace(coalesce(lead.phone, ''), '\D', '', 'g'),
      8
    ) = v_suffix
    and private.commercial_phones_match(lead.phone, v_phone);

  if v_count = 1 then
    return query select 'lead'::text, v_name;
    return;
  elsif v_count > 1 then
    return query select 'unknown'::text, null::text;
    return;
  end if;

  select count(*), min(nullif(pg_catalog.btrim(application.name), ''))
  into v_count, v_name
  from public.job_applications as application
  where application.tenant_id = p_tenant_id
    and pg_catalog.right(
      pg_catalog.regexp_replace(
        coalesce(application.whatsapp, ''),
        '\D',
        '',
        'g'
      ),
      8
    ) = v_suffix
    and private.commercial_phones_match(application.whatsapp, v_phone);

  if v_count = 1 then
    return query select 'candidate'::text, v_name;
  else
    return query select 'unknown'::text, null::text;
  end if;
end;
$function$;
revoke all on function private.resolve_whatsapp_contact(text,text)
  from public, anon, authenticated;
grant execute on function private.resolve_whatsapp_contact(text,text)
  to postgres, supabase_admin, service_role;

create or replace function private.apply_whatsapp_contact_handoff(
  p_tenant_id text,
  p_phone text,
  p_active boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_phone text := pg_catalog.regexp_replace(
    coalesce(p_phone, ''),
    '\D',
    '',
    'g'
  );
  v_suffix text;
  v_at timestamptz := pg_catalog.now();
  v_lead_count integer := 0;
  v_application_count integer := 0;
begin
  if p_active is null then
    raise exception 'invalid_whatsapp_contact_handoff' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_phone) not between 10 and 15 then
    return jsonb_build_object('leads', 0, 'applications', 0);
  end if;
  v_suffix := pg_catalog.right(v_phone, 8);

  -- Todos os registros inequívocos daquele telefone no MESMO tenant recebem o
  -- mesmo estado. Assim nenhum dos agentes comerciais continua respondendo.
  update public.crm_leads as lead
  set ai_handoff = p_active,
      ai_handoff_at = case when p_active then v_at else null end
  where lead.tenant_id = p_tenant_id
    and pg_catalog.right(
      pg_catalog.regexp_replace(coalesce(lead.phone, ''), '\D', '', 'g'),
      8
    ) = v_suffix
    and private.commercial_phones_match(lead.phone, v_phone);
  get diagnostics v_lead_count = row_count;

  update public.job_applications as application
  set ai_handoff = p_active,
      ai_handoff_at = case when p_active then v_at else null end
  where application.tenant_id = p_tenant_id
    and pg_catalog.right(
      pg_catalog.regexp_replace(
        coalesce(application.whatsapp, ''),
        '\D',
        '',
        'g'
      ),
      8
    ) = v_suffix
    and private.commercial_phones_match(application.whatsapp, v_phone);
  get diagnostics v_application_count = row_count;

  return jsonb_build_object(
    'leads', v_lead_count,
    'applications', v_application_count
  );
end;
$function$;
revoke all on function private.apply_whatsapp_contact_handoff(text,text,boolean)
  from public, anon, authenticated;
grant execute on function private.apply_whatsapp_contact_handoff(text,text,boolean)
  to postgres, supabase_admin, service_role;

create table public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null
    references public.tenants(id) on delete cascade,
  instance_id uuid not null,
  instance_name text not null,
  remote_jid text not null,
  contact_kind text not null default 'unknown'
    check (contact_kind in (
      'student', 'lead', 'candidate', 'teacher', 'group', 'unknown'
    )),
  display_name text,
  phone text,
  unread_count integer not null default 0,
  assigned_to uuid references public.profiles(id) on delete set null,
  handoff_active boolean not null default false,
  human_handoff_until timestamptz,
  archived boolean not null default false,
  last_message_at timestamptz,
  last_message_preview text,
  last_message_direction text
    check (last_message_direction is null or last_message_direction in ('in', 'out')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_conversations_tenant_instance_fkey
    foreign key (tenant_id, instance_id, instance_name)
    references public.whatsapp_instances(tenant_id, id, instance_name)
    on delete cascade,
  constraint whatsapp_conversations_instance_name_check check (
    char_length(instance_name) between 3 and 120
    and instance_name = pg_catalog.btrim(instance_name)
    and instance_name !~ '[[:cntrl:]]'
  ),
  constraint whatsapp_conversations_remote_jid_check check (
    char_length(remote_jid) between 3 and 255
    and remote_jid = pg_catalog.btrim(remote_jid)
    and remote_jid !~ '[[:cntrl:]]'
    and position('@' in remote_jid) > 1
  ),
  constraint whatsapp_conversations_display_name_check check (
    display_name is null
    or (
      char_length(display_name) between 1 and 160
      and display_name !~ '[[:cntrl:]]'
    )
  ),
  constraint whatsapp_conversations_phone_check check (
    phone is null or phone ~ '^[0-9]{10,15}$'
  ),
  constraint whatsapp_conversations_unread_count_check check (
    unread_count >= 0
  ),
  constraint whatsapp_conversations_handoff_check check (
    handoff_active is false or human_handoff_until is not null
  ),
  constraint whatsapp_conversations_preview_check check (
    last_message_preview is null
    or char_length(last_message_preview) <= 500
  ),
  unique (instance_id, remote_jid),
  unique (tenant_id, id),
  unique (tenant_id, id, instance_id)
);

create index whatsapp_conversations_tenant_recent_idx
  on public.whatsapp_conversations
    (tenant_id, last_message_at desc nulls last, id desc);
create index whatsapp_conversations_tenant_instance_recent_idx
  on public.whatsapp_conversations
    (tenant_id, instance_id, last_message_at desc nulls last, id desc);
create index whatsapp_conversations_active_handoff_idx
  on public.whatsapp_conversations (tenant_id, human_handoff_until)
  where handoff_active is true;
create index whatsapp_conversations_unread_idx
  on public.whatsapp_conversations (tenant_id, last_message_at desc, id desc)
  where unread_count > 0 and archived is false;

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null
    references public.tenants(id) on delete cascade,
  instance_id uuid not null,
  conversation_id uuid not null,
  provider_message_id text,
  client_request_id uuid,
  direction text not null check (direction in ('in', 'out')),
  sender_kind text not null check (
    sender_kind in ('contact', 'human', 'ai', 'automation', 'system')
  ),
  message_type text not null check (
    message_type in (
      'text', 'audio', 'image', 'video', 'document', 'sticker',
      'location', 'contact', 'reaction', 'poll', 'system', 'unknown'
    )
  ),
  body text not null default '',
  status text not null check (
    status in (
      'received', 'queued', 'dispatching', 'sent', 'delivered',
      'read', 'failed', 'uncertain'
    )
  ),
  occurred_at timestamptz not null default now(),
  sent_by_user_id uuid references public.profiles(id) on delete set null,
  reply_to_provider_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  dispatch_started_at timestamptz,
  error_code text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_messages_conversation_scope_fkey
    foreign key (tenant_id, conversation_id, instance_id)
    references public.whatsapp_conversations(tenant_id, id, instance_id)
    on delete cascade,
  constraint whatsapp_messages_provider_id_check check (
    provider_message_id is null
    or (
      char_length(provider_message_id) between 1 and 320
      and provider_message_id = pg_catalog.btrim(provider_message_id)
      and provider_message_id !~ '[[:cntrl:]]'
    )
  ),
  constraint whatsapp_messages_reply_id_check check (
    reply_to_provider_message_id is null
    or char_length(reply_to_provider_message_id) between 1 and 320
  ),
  constraint whatsapp_messages_body_check check (
    char_length(body) <= 16384
  ),
  constraint whatsapp_messages_metadata_check check (
    jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 32768
  ),
  constraint whatsapp_messages_attempt_count_check check (
    attempt_count between 0 and 20
  ),
  constraint whatsapp_messages_lease_check check (
    (status = 'dispatching') = (lease_until is not null)
  ),
  constraint whatsapp_messages_error_code_check check (
    error_code is null
    or char_length(error_code) between 1 and 160
  ),
  unique (tenant_id, id),
  unique (tenant_id, conversation_id, id)
);

create unique index whatsapp_messages_provider_unique_idx
  on public.whatsapp_messages (instance_id, provider_message_id)
  where provider_message_id is not null;
create unique index whatsapp_messages_client_request_unique_idx
  on public.whatsapp_messages (tenant_id, client_request_id)
  where client_request_id is not null;
create index whatsapp_messages_conversation_timeline_idx
  on public.whatsapp_messages
    (tenant_id, conversation_id, occurred_at desc, id desc);
create index whatsapp_messages_pending_outbound_idx
  on public.whatsapp_messages (next_attempt_at, created_at, id)
  where direction = 'out' and status = 'queued';
create index whatsapp_messages_stale_dispatch_idx
  on public.whatsapp_messages (lease_until, id)
  where direction = 'out' and status = 'dispatching';

create table public.whatsapp_webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null
    references public.tenants(id) on delete cascade,
  instance_id uuid not null,
  instance_name text not null,
  event_type text not null,
  event_key text not null,
  payload jsonb not null,
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed')),
  attempt_count integer not null default 0
    check (attempt_count between 0 and 100),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint whatsapp_webhook_inbox_tenant_instance_fkey
    foreign key (tenant_id, instance_id, instance_name)
    references public.whatsapp_instances(tenant_id, id, instance_name)
    on delete cascade,
  constraint whatsapp_webhook_inbox_instance_name_check check (
    char_length(instance_name) between 3 and 120
    and instance_name = pg_catalog.btrim(instance_name)
    and instance_name !~ '[[:cntrl:]]'
  ),
  constraint whatsapp_webhook_inbox_event_type_check check (
    char_length(event_type) between 1 and 120
    and event_type = pg_catalog.btrim(event_type)
    and event_type !~ '[[:cntrl:]]'
  ),
  constraint whatsapp_webhook_inbox_event_key_check check (
    char_length(event_key) between 1 and 500
    and event_key = pg_catalog.btrim(event_key)
    and event_key !~ '[[:cntrl:]]'
  ),
  constraint whatsapp_webhook_inbox_payload_check check (
    jsonb_typeof(payload) = 'object'
    and pg_column_size(payload) <= 1048576
  ),
  constraint whatsapp_webhook_inbox_processed_check check (
    status <> 'processed' or processed_at is not null
  ),
  unique (tenant_id, instance_name, event_key)
);

create index whatsapp_webhook_inbox_available_idx
  on public.whatsapp_webhook_inbox (available_at, created_at, id)
  where status in ('received', 'failed');
create index whatsapp_webhook_inbox_stale_lease_idx
  on public.whatsapp_webhook_inbox (lease_until, id)
  where lease_until is not null and status <> 'processed';

create table public.whatsapp_conversation_reads (
  tenant_id text not null
    references public.tenants(id) on delete cascade,
  conversation_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_message_id uuid,
  last_read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, conversation_id, user_id),
  constraint whatsapp_conversation_reads_conversation_fkey
    foreign key (tenant_id, conversation_id)
    references public.whatsapp_conversations(tenant_id, id)
    on delete cascade,
  constraint whatsapp_conversation_reads_message_fkey
    foreign key (tenant_id, conversation_id, last_read_message_id)
    references public.whatsapp_messages(tenant_id, conversation_id, id)
    on delete set null (last_read_message_id)
);

create index whatsapp_conversation_reads_user_idx
  on public.whatsapp_conversation_reads
    (tenant_id, user_id, last_read_at desc);

create or replace function private.touch_whatsapp_inbox_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;
revoke all on function private.touch_whatsapp_inbox_updated_at()
  from public, anon, authenticated;

create trigger whatsapp_conversations_touch_updated_at
before update on public.whatsapp_conversations
for each row execute function private.touch_whatsapp_inbox_updated_at();
create trigger whatsapp_messages_touch_updated_at
before update on public.whatsapp_messages
for each row execute function private.touch_whatsapp_inbox_updated_at();
create trigger whatsapp_webhook_inbox_touch_updated_at
before update on public.whatsapp_webhook_inbox
for each row execute function private.touch_whatsapp_inbox_updated_at();
create trigger whatsapp_conversation_reads_touch_updated_at
before update on public.whatsapp_conversation_reads
for each row execute function private.touch_whatsapp_inbox_updated_at();

alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_webhook_inbox enable row level security;
alter table public.whatsapp_conversation_reads enable row level security;

revoke all on table
  public.whatsapp_conversations,
  public.whatsapp_messages,
  public.whatsapp_webhook_inbox,
  public.whatsapp_conversation_reads
from public, anon, authenticated;

grant select on table
  public.whatsapp_conversations,
  public.whatsapp_messages,
  public.whatsapp_conversation_reads
to authenticated;

grant all on table
  public.whatsapp_conversations,
  public.whatsapp_messages,
  public.whatsapp_webhook_inbox,
  public.whatsapp_conversation_reads
to service_role;

-- Mantém a policy histórica (o dono continua vendo a própria conexão) e soma
-- apenas a visão da instância institucional habilitada para a equipe da inbox.
drop policy if exists whatsapp_instances_inbox_staff_read
  on public.whatsapp_instances;
create policy whatsapp_instances_inbox_staff_read
on public.whatsapp_instances
for select
to authenticated
using (
  private.whatsapp_inbox_instance_is_eligible(tenant_id, id)
  and private.whatsapp_inbox_actor_has_role(
    (select auth.uid()),
    tenant_id,
    array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  )
);

create policy whatsapp_conversations_staff_read
on public.whatsapp_conversations
for select
to authenticated
using (
  private.whatsapp_inbox_actor_has_role(
    (select auth.uid()),
    tenant_id,
    array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  )
);

create policy whatsapp_messages_staff_read
on public.whatsapp_messages
for select
to authenticated
using (
  private.whatsapp_inbox_actor_has_role(
    (select auth.uid()),
    tenant_id,
    array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  )
);

create policy whatsapp_conversation_reads_owner_read
on public.whatsapp_conversation_reads
for select
to authenticated
using (
  user_id = (select auth.uid())
  and private.whatsapp_inbox_actor_has_role(
    (select auth.uid()),
    tenant_id,
    array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  )
);

create or replace function public.enable_whatsapp_inbox(
  p_tenant_id text,
  p_instance_name text,
  p_actor_id uuid,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_instance public.whatsapp_instances%rowtype;
begin
  if p_enabled is null
     or nullif(pg_catalog.btrim(p_tenant_id), '') is null
     or nullif(pg_catalog.btrim(p_instance_name), '') is null then
    raise exception 'invalid_whatsapp_inbox_configuration'
      using errcode = '22023';
  end if;

  if not private.whatsapp_inbox_actor_has_role(
    p_actor_id,
    p_tenant_id,
    array['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) then
    raise exception 'whatsapp_inbox_configuration_forbidden'
      using errcode = '42501';
  end if;

  select instance.*
  into v_instance
  from public.whatsapp_instances as instance
  where instance.tenant_id = p_tenant_id
    and lower(instance.instance_name) = lower(pg_catalog.btrim(p_instance_name))
  for update;

  if not found then
    raise exception 'whatsapp_instance_not_found' using errcode = 'P0002';
  end if;

  if p_enabled and not exists (
    select 1
    from public.tenant_memberships as membership
    join public.profiles as owner
      on owner.id = membership.user_id
     and lower(pg_catalog.btrim(coalesce(owner.lifecycle_status, '')))
       = 'active'
    where membership.user_id = v_instance.user_id
      and membership.tenant_id = p_tenant_id
      and membership.role = 'SCHOOL_ADMIN'
      and membership.status = 'ACTIVE'
  ) then
    raise exception 'whatsapp_inbox_requires_school_admin_instance'
      using errcode = '42501';
  end if;

  update public.whatsapp_instances as instance
  set inbox_enabled = p_enabled,
      inbox_enabled_at = case when p_enabled then pg_catalog.now() else null end,
      inbox_enabled_by = case when p_enabled then p_actor_id else null end,
      updated_at = pg_catalog.now()
  where instance.id = v_instance.id
    and instance.tenant_id = p_tenant_id
  returning instance.* into v_instance;

  return jsonb_build_object(
    'ok', true,
    'tenantId', v_instance.tenant_id,
    'instanceId', v_instance.id,
    'instanceName', v_instance.instance_name,
    'inboxEnabled', v_instance.inbox_enabled,
    'inboxEnabledAt', v_instance.inbox_enabled_at
  );
end;
$function$;

create or replace function public.enqueue_whatsapp_webhook_event(
  p_tenant_id text,
  p_instance_name text,
  p_event_type text,
  p_event_key text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_instance_id uuid;
  v_instance_name text;
  v_event public.whatsapp_webhook_inbox%rowtype;
  v_inserted boolean := false;
begin
  if nullif(pg_catalog.btrim(p_tenant_id), '') is null
     or nullif(pg_catalog.btrim(p_instance_name), '') is null
     or nullif(pg_catalog.btrim(p_event_type), '') is null
     or nullif(pg_catalog.btrim(p_event_key), '') is null
     or p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or pg_column_size(p_payload) > 1048576 then
    raise exception 'invalid_whatsapp_webhook_event' using errcode = '22023';
  end if;

  select instance.id, instance.instance_name
  into v_instance_id, v_instance_name
  from public.whatsapp_instances as instance
  where instance.tenant_id = p_tenant_id
    and lower(instance.instance_name) = lower(pg_catalog.btrim(p_instance_name))
    and private.whatsapp_inbox_instance_is_eligible(
      instance.tenant_id,
      instance.id
    );

  if not found then
    raise exception 'whatsapp_inbox_unavailable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'wa-event:' || p_tenant_id || ':' || v_instance_id::text || ':' ||
      pg_catalog.btrim(p_event_key),
      0
    )
  );

  select event.*
  into v_event
  from public.whatsapp_webhook_inbox as event
  where event.tenant_id = p_tenant_id
    and event.instance_name = v_instance_name
    and event.event_key = pg_catalog.btrim(p_event_key)
  for update;

  if found then
    if v_event.status <> 'processed' then
      -- Falhas e entregas interrompidas voltam a received. O consumidor faz
      -- a conclusão com WHERE status = 'received', portanto não há janela em
      -- que um retry legítimo fique permanentemente órfão.
      update public.whatsapp_webhook_inbox as event
      set event_type = pg_catalog.btrim(p_event_type),
          payload = p_payload,
          status = 'received',
          attempt_count = event.attempt_count + 1,
          available_at = pg_catalog.now(),
          lease_until = null,
          last_error = null,
          processed_at = null
      where event.id = v_event.id
      returning event.* into v_event;
    end if;
  else
    insert into public.whatsapp_webhook_inbox (
      tenant_id,
      instance_id,
      instance_name,
      event_type,
      event_key,
      payload
    )
    values (
      p_tenant_id,
      v_instance_id,
      v_instance_name,
      pg_catalog.btrim(p_event_type),
      pg_catalog.btrim(p_event_key),
      p_payload
    )
    returning * into v_event;
    v_inserted := true;
  end if;

  -- Evento já processado é um no-op idempotente; seu payload e contador não
  -- são reabertos por redelivery tardia do provedor.
  if v_event.status = 'processed' then
    select event.*
    into strict v_event
    from public.whatsapp_webhook_inbox as event
    where event.id = v_event.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'eventId', v_event.id,
    'inserted', v_inserted,
    'status', v_event.status
  );
end;
$function$;

create or replace function public.store_whatsapp_provider_message(
  p_tenant_id text,
  p_instance_name text,
  p_remote_jid text,
  p_provider_message_id text,
  p_direction text,
  p_sender_kind text,
  p_message_type text,
  p_body text,
  p_occurred_at timestamptz,
  p_display_name text default null,
  p_phone text default null,
  p_status text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_instance_id uuid;
  v_instance_name text;
  v_remote_jid text := lower(pg_catalog.btrim(coalesce(p_remote_jid, '')));
  v_provider_message_id text := pg_catalog.btrim(
    coalesce(p_provider_message_id, '')
  );
  v_phone text := case
    when v_remote_jid like '%@g.us' then null
    else nullif(
      pg_catalog.regexp_replace(
        coalesce(
          nullif(p_phone, ''),
          pg_catalog.split_part(v_remote_jid, '@', 1)
        ),
        '[^0-9]',
        '',
        'g'
      ),
      ''
    )
  end;
  v_status text := coalesce(
    nullif(pg_catalog.btrim(p_status), ''),
    case when p_direction = 'in' then 'received' else 'sent' end
  );
  v_body text := coalesce(p_body, '');
  v_occurred_at timestamptz := coalesce(p_occurred_at, pg_catalog.now());
  v_conversation public.whatsapp_conversations%rowtype;
  v_message public.whatsapp_messages%rowtype;
  v_candidate_ids uuid[] := '{}'::uuid[];
  v_duplicate boolean := false;
  v_new_message boolean := false;
  v_status_only boolean;
  v_preview text;
  v_webhook_event_id uuid;
  v_contact_kind text := case
    when v_remote_jid like '%@g.us' then 'group' else 'unknown'
  end;
  v_contact_name text;
  v_display_name text;
begin
  if nullif(pg_catalog.btrim(p_tenant_id), '') is null
     or nullif(pg_catalog.btrim(p_instance_name), '') is null
     or v_remote_jid = ''
     or position('@' in v_remote_jid) <= 1
     or v_provider_message_id = ''
     or p_direction not in ('in', 'out')
     or p_sender_kind not in (
       'contact', 'human', 'ai', 'automation', 'system'
     )
     or p_message_type not in (
       'text', 'audio', 'image', 'video', 'document', 'sticker',
       'location', 'contact', 'reaction', 'poll', 'system', 'unknown'
     )
     or v_status not in (
       'received', 'queued', 'sent', 'delivered',
       'read', 'failed', 'uncertain'
     )
     or char_length(v_body) > 16384
     or p_metadata is null
     or jsonb_typeof(p_metadata) <> 'object'
     or pg_column_size(p_metadata) > 32768
     or (v_phone is not null and v_phone !~ '^[0-9]{10,15}$')
     or v_occurred_at < timestamptz '2000-01-01 00:00:00+00'
     or v_occurred_at > pg_catalog.now() + interval '1 day' then
    raise exception 'invalid_whatsapp_provider_message'
      using errcode = '22023';
  end if;

  select instance.id, instance.instance_name
  into v_instance_id, v_instance_name
  from public.whatsapp_instances as instance
  where instance.tenant_id = p_tenant_id
    and lower(instance.instance_name) = lower(pg_catalog.btrim(p_instance_name))
    and private.whatsapp_inbox_instance_is_eligible(
      instance.tenant_id,
      instance.id
    );

  if not found then
    raise exception 'whatsapp_inbox_unavailable' using errcode = '42501';
  end if;

  if not private.whatsapp_inbox_remote_jid_is_allowed(
    p_tenant_id,
    v_remote_jid
  ) then
    raise exception 'whatsapp_remote_jid_not_allowed'
      using errcode = '42501';
  end if;

  if v_contact_kind <> 'group' and v_phone is not null then
    select resolved.contact_kind, resolved.display_name
    into v_contact_kind, v_contact_name
    from private.resolve_whatsapp_contact(p_tenant_id, v_phone) as resolved;
  end if;
  v_display_name := nullif(
    left(
      pg_catalog.btrim(
        pg_catalog.regexp_replace(
          coalesce(v_contact_name, p_display_name, ''),
          '[[:cntrl:]]',
          ' ',
          'g'
        )
      ),
      160
    ),
    ''
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'wa-provider:' || v_instance_id::text || ':' || v_provider_message_id,
      0
    )
  );

  insert into public.whatsapp_conversations (
    tenant_id,
    instance_id,
    instance_name,
    remote_jid,
    contact_kind,
    display_name,
    phone
  )
  values (
    p_tenant_id,
    v_instance_id,
    v_instance_name,
    v_remote_jid,
    v_contact_kind,
    v_display_name,
    v_phone
  )
  on conflict (instance_id, remote_jid) do update
  set contact_kind = case
        when excluded.contact_kind <> 'unknown' then excluded.contact_kind
        else whatsapp_conversations.contact_kind
      end,
      display_name = coalesce(
        excluded.display_name,
        whatsapp_conversations.display_name
      ),
      phone = coalesce(excluded.phone, whatsapp_conversations.phone)
  returning * into v_conversation;

  select message.*
  into v_message
  from public.whatsapp_messages as message
  where message.instance_id = v_instance_id
    and message.provider_message_id = v_provider_message_id
  for update;

  if not found and p_direction = 'out' then
    -- O eco fromMe pode chegar antes da resposta HTTP do envio. Só vinculamos
    -- por corpo/tempo quando existe um único candidato; dois textos iguais
    -- ficam separados para nunca fundir mensagens por adivinhação.
    select coalesce(pg_catalog.array_agg(candidate.id), '{}'::uuid[])
    into v_candidate_ids
    from (
      select candidate_message.id
      from public.whatsapp_messages as candidate_message
      where candidate_message.tenant_id = p_tenant_id
        and candidate_message.instance_id = v_instance_id
        and candidate_message.conversation_id = v_conversation.id
        and candidate_message.direction = 'out'
        and candidate_message.provider_message_id is null
        and candidate_message.status in (
          'queued', 'dispatching', 'uncertain'
        )
        and candidate_message.body = v_body
        and candidate_message.created_at >= pg_catalog.now() - interval '10 minutes'
      order by candidate_message.created_at desc, candidate_message.id desc
      limit 2
      for update
    ) as candidate;

    if pg_catalog.cardinality(v_candidate_ids) = 1 then
      select message.*
      into v_message
      from public.whatsapp_messages as message
      where message.id = v_candidate_ids[1]
      for update;
    end if;
  end if;

  v_status_only := p_message_type = 'unknown'
    or pg_catalog.btrim(v_body) = ''
    or pg_catalog.btrim(v_body) = '[Mensagem não suportada]';

  if v_message.id is null then
    insert into public.whatsapp_messages (
      tenant_id,
      instance_id,
      conversation_id,
      provider_message_id,
      direction,
      sender_kind,
      message_type,
      body,
      status,
      occurred_at,
      metadata,
      sent_at,
      delivered_at,
      read_at
    )
    values (
      p_tenant_id,
      v_instance_id,
      v_conversation.id,
      v_provider_message_id,
      p_direction,
      p_sender_kind,
      p_message_type,
      v_body,
      v_status,
      v_occurred_at,
      p_metadata,
      case when v_status in ('sent', 'delivered', 'read')
        then v_occurred_at else null end,
      case when v_status in ('delivered', 'read')
        then v_occurred_at else null end,
      case when v_status = 'read' then v_occurred_at else null end
    )
    returning * into v_message;
    v_new_message := true;
  else
    v_duplicate := true;
    if v_message.tenant_id <> p_tenant_id
       or v_message.instance_id <> v_instance_id
       or v_message.conversation_id <> v_conversation.id
       or v_message.direction <> p_direction then
      raise exception 'whatsapp_provider_message_scope_conflict'
        using errcode = '23505';
    end if;

    update public.whatsapp_messages as message
    set provider_message_id = coalesce(
          message.provider_message_id,
          v_provider_message_id
        ),
        sender_kind = case
          when v_status_only then message.sender_kind
          else p_sender_kind
        end,
        message_type = case
          when v_status_only then message.message_type
          else p_message_type
        end,
        body = case
          when v_status_only then message.body
          else v_body
        end,
        status = private.merge_whatsapp_message_status(
          message.status,
          v_status
        ),
        occurred_at = least(
          message.occurred_at,
          v_occurred_at
        ),
        metadata = message.metadata || p_metadata,
        lease_until = case
          when private.merge_whatsapp_message_status(message.status, v_status)
            = 'dispatching'
          then message.lease_until
          else null
        end,
        error_code = case
          when v_status in ('sent', 'delivered', 'read', 'received') then null
          else message.error_code
        end,
        sent_at = case
          when v_status in ('sent', 'delivered', 'read')
          then coalesce(message.sent_at, v_occurred_at)
          else message.sent_at
        end,
        delivered_at = case
          when v_status in ('delivered', 'read')
          then coalesce(message.delivered_at, v_occurred_at)
          else message.delivered_at
        end,
        read_at = case
          when v_status = 'read'
          then coalesce(message.read_at, v_occurred_at)
          else message.read_at
        end
    where message.id = v_message.id
    returning message.* into v_message;
  end if;

  v_preview := left(
    case
      when nullif(pg_catalog.btrim(v_message.body), '') is not null
      then v_message.body
      else '[' || v_message.message_type || ']'
    end,
    500
  );

  update public.whatsapp_conversations as conversation
  set unread_count = conversation.unread_count + case
        when v_new_message
          and v_message.direction = 'in'
          and p_metadata ->> 'source' = 'webhook'
        then 1 else 0
      end,
      last_message_at = case
        when conversation.last_message_at is null
          or conversation.last_message_at <= v_message.occurred_at
        then v_message.occurred_at
        else conversation.last_message_at
      end,
      last_message_preview = case
        when conversation.last_message_at is null
          or conversation.last_message_at <= v_message.occurred_at
        then v_preview
        else conversation.last_message_preview
      end,
      last_message_direction = case
        when conversation.last_message_at is null
          or conversation.last_message_at <= v_message.occurred_at
        then v_message.direction
        else conversation.last_message_direction
      end
  where conversation.id = v_conversation.id
    and conversation.tenant_id = p_tenant_id
  returning conversation.* into v_conversation;

  if coalesce(p_metadata ->> 'webhookEventId', '') ~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    v_webhook_event_id := (p_metadata ->> 'webhookEventId')::uuid;
    update public.whatsapp_webhook_inbox as event
    set status = 'processed',
        processed_at = coalesce(event.processed_at, pg_catalog.now()),
        lease_until = null,
        last_error = null
    where event.id = v_webhook_event_id
      and event.tenant_id = p_tenant_id
      and event.instance_id = v_instance_id;
  elsif nullif(p_metadata ->> 'eventKey', '') is not null then
    update public.whatsapp_webhook_inbox as event
    set status = 'processed',
        processed_at = coalesce(event.processed_at, pg_catalog.now()),
        lease_until = null,
        last_error = null
    where event.tenant_id = p_tenant_id
      and event.instance_id = v_instance_id
      and event.event_key = p_metadata ->> 'eventKey';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'conversationId', v_conversation.id,
    'messageId', v_message.id,
    'status', v_message.status
  );
end;
$function$;

create or replace function public.store_whatsapp_provider_messages(
  p_tenant_id text,
  p_instance_name text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item jsonb;
  v_result jsonb;
  v_stored integer := 0;
  v_inserted integer := 0;
  v_duplicates integer := 0;
begin
  if p_messages is null
     or jsonb_typeof(p_messages) <> 'array'
     or pg_catalog.octet_length(p_messages::text) > 524288 then
    raise exception 'invalid_whatsapp_provider_message_batch'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_messages) not between 1 and 200 then
    raise exception 'invalid_whatsapp_provider_message_batch_size'
      using errcode = '22023';
  end if;

  for v_item in
    select item.value
    from jsonb_array_elements(p_messages) as item(value)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or nullif(v_item ->> 'remoteJid', '') is null
       or nullif(v_item ->> 'providerMessageId', '') is null
       or nullif(v_item ->> 'direction', '') is null
       or nullif(v_item ->> 'senderKind', '') is null
       or nullif(v_item ->> 'messageType', '') is null
       or nullif(v_item ->> 'occurredAt', '') is null
       or (
         v_item ? 'metadata'
         and jsonb_typeof(v_item -> 'metadata') <> 'object'
       ) then
      raise exception 'invalid_whatsapp_provider_message_batch_item'
        using errcode = '22023';
    end if;

    v_result := public.store_whatsapp_provider_message(
      p_tenant_id,
      p_instance_name,
      v_item ->> 'remoteJid',
      v_item ->> 'providerMessageId',
      v_item ->> 'direction',
      v_item ->> 'senderKind',
      v_item ->> 'messageType',
      coalesce(v_item ->> 'body', ''),
      (v_item ->> 'occurredAt')::timestamptz,
      v_item ->> 'displayName',
      v_item ->> 'phone',
      case
        when v_item ->> 'status' = 'unknown' then null
        else v_item ->> 'status'
      end,
      coalesce(v_item -> 'metadata', '{}'::jsonb)
        || '{"source":"sync"}'::jsonb
    );

    v_stored := v_stored + 1;
    if coalesce((v_result ->> 'duplicate')::boolean, false) then
      v_duplicates := v_duplicates + 1;
    else
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'stored', v_inserted,
    'processed', v_stored,
    'inserted', v_inserted,
    'duplicates', v_duplicates
  );
end;
$function$;

create or replace function public.prepare_whatsapp_outbound(
  p_tenant_id text,
  p_instance_name text,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_client_request_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_instance public.whatsapp_instances%rowtype;
  v_conversation public.whatsapp_conversations%rowtype;
  v_message public.whatsapp_messages%rowtype;
  v_body text := pg_catalog.btrim(coalesce(p_body, ''));
  v_duplicate boolean := false;
begin
  if p_conversation_id is null
     or p_client_request_id is null
     or nullif(pg_catalog.btrim(p_tenant_id), '') is null
     or nullif(pg_catalog.btrim(p_instance_name), '') is null
     or v_body = ''
     or char_length(v_body) > 4096 then
    raise exception 'invalid_whatsapp_outbound' using errcode = '22023';
  end if;

  if not private.whatsapp_inbox_actor_has_role(
    p_actor_id,
    p_tenant_id,
    array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
  ) then
    raise exception 'whatsapp_outbound_forbidden' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'wa-client-request:' || p_tenant_id || ':' || p_client_request_id::text,
      0
    )
  );

  select instance.*
  into v_instance
  from public.whatsapp_instances as instance
  where instance.tenant_id = p_tenant_id
    and lower(instance.instance_name) = lower(pg_catalog.btrim(p_instance_name))
    and private.whatsapp_inbox_instance_is_eligible(
      instance.tenant_id,
      instance.id
    )
  for share;

  if not found then
    raise exception 'whatsapp_inbox_unavailable' using errcode = '42501';
  end if;

  select conversation.*
  into v_conversation
  from public.whatsapp_conversations as conversation
  where conversation.id = p_conversation_id
    and conversation.tenant_id = p_tenant_id
    and conversation.instance_id = v_instance.id
  for update;

  if not found then
    raise exception 'whatsapp_conversation_not_found' using errcode = 'P0002';
  end if;

  -- Revalida o destino depois de travar a conversa e antes de qualquer
  -- handoff ou INSERT. Assim, uma conversa de grupo preservada no historico
  -- nao autoriza envio depois que a direcao troca ou desliga o grupo.
  if not private.whatsapp_inbox_remote_jid_is_allowed(
    p_tenant_id,
    v_conversation.remote_jid
  ) then
    raise exception 'whatsapp_conversation_destination_unavailable'
      using errcode = '42501';
  end if;

  select message.*
  into v_message
  from public.whatsapp_messages as message
  where message.tenant_id = p_tenant_id
    and message.client_request_id = p_client_request_id
  for update;

  if found then
    if v_message.conversation_id <> v_conversation.id
       or v_message.instance_id <> v_instance.id
       or v_message.sent_by_user_id is distinct from p_actor_id
       or v_message.direction <> 'out'
       or v_message.sender_kind <> 'human'
       or v_message.body <> v_body then
      raise exception 'whatsapp_client_request_reused'
        using errcode = '22023';
    end if;
    v_duplicate := true;
  else
    update public.whatsapp_conversations as conversation
    set handoff_active = true,
        human_handoff_until = pg_catalog.now() + interval '72 hours',
        assigned_to = p_actor_id
    where conversation.id = v_conversation.id
      and conversation.tenant_id = p_tenant_id
    returning conversation.* into v_conversation;

    perform private.apply_whatsapp_contact_handoff(
      p_tenant_id,
      v_conversation.phone,
      true
    );

    insert into public.whatsapp_messages (
      tenant_id,
      instance_id,
      conversation_id,
      client_request_id,
      direction,
      sender_kind,
      message_type,
      body,
      status,
      occurred_at,
      sent_by_user_id,
      metadata
    )
    values (
      p_tenant_id,
      v_instance.id,
      v_conversation.id,
      p_client_request_id,
      'out',
      'human',
      'text',
      v_body,
      'queued',
      pg_catalog.now(),
      p_actor_id,
      '{"source":"web_inbox"}'::jsonb
    )
    returning * into v_message;

    update public.whatsapp_conversations as conversation
    set last_message_at = v_message.occurred_at,
        last_message_preview = left(v_body, 500),
        last_message_direction = 'out'
    where conversation.id = v_conversation.id
      and conversation.tenant_id = p_tenant_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'messageId', v_message.id,
    'conversationId', v_conversation.id,
    'instanceId', v_instance.id,
    'instanceName', v_instance.instance_name,
    'remoteJid', v_conversation.remote_jid,
    'status', v_message.status
  );
end;
$function$;

create or replace function public.claim_whatsapp_outbound(
  p_tenant_id text,
  p_message_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_message public.whatsapp_messages%rowtype;
  v_conversation public.whatsapp_conversations%rowtype;
  v_instance public.whatsapp_instances%rowtype;
begin
  if p_message_id is null
     or not private.whatsapp_inbox_actor_has_role(
       p_actor_id,
       p_tenant_id,
       array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
     ) then
    raise exception 'whatsapp_outbound_claim_forbidden'
      using errcode = '42501';
  end if;

  select message.*
  into v_message
  from public.whatsapp_messages as message
  where message.id = p_message_id
    and message.tenant_id = p_tenant_id
    and message.direction = 'out'
    and message.sent_by_user_id = p_actor_id
  for update;

  if not found then
    raise exception 'whatsapp_outbound_not_found' using errcode = 'P0002';
  end if;

  select conversation.*
  into strict v_conversation
  from public.whatsapp_conversations as conversation
  where conversation.id = v_message.conversation_id
    and conversation.tenant_id = p_tenant_id;

  select instance.*
  into strict v_instance
  from public.whatsapp_instances as instance
  where instance.id = v_message.instance_id
    and instance.tenant_id = p_tenant_id;

  if not private.whatsapp_inbox_instance_is_eligible(
    p_tenant_id,
    v_instance.id
  ) then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'messageId', v_message.id,
      'status', v_message.status,
      'error', 'inbox_unavailable'
    );
  end if;

  if not private.whatsapp_inbox_remote_jid_is_allowed(
    p_tenant_id,
    v_conversation.remote_jid
  ) then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'messageId', v_message.id,
      'status', v_message.status,
      'error', 'destination_unavailable'
    );
  end if;

  if v_message.status = 'dispatching' then
    if v_message.lease_until <= pg_catalog.now() then
      -- Não há idempotency-key garantida pelo provedor. Depois que um envio
      -- começou, lease vencida significa resultado ambíguo, nunca retry cego.
      update public.whatsapp_messages as message
      set status = 'uncertain',
          lease_until = null,
          error_code = 'dispatch_lease_expired'
      where message.id = v_message.id
      returning message.* into v_message;
    end if;

    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'messageId', v_message.id,
      'status', v_message.status,
      'leaseUntil', v_message.lease_until
    );
  end if;

  if v_message.status <> 'queued'
     or v_message.next_attempt_at > pg_catalog.now() then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'messageId', v_message.id,
      'status', v_message.status,
      'error', null
    );
  end if;

  update public.whatsapp_messages as message
  set status = 'dispatching',
      attempt_count = message.attempt_count + 1,
      lease_until = pg_catalog.now() + interval '2 minutes',
      dispatch_started_at = coalesce(
        message.dispatch_started_at,
        pg_catalog.now()
      ),
      error_code = null
  where message.id = v_message.id
    and message.status = 'queued'
  returning message.* into v_message;

  return jsonb_build_object(
    'ok', true,
    'claimed', true,
    'messageId', v_message.id,
    'conversationId', v_message.conversation_id,
    'instanceId', v_instance.id,
    'instanceName', v_instance.instance_name,
    'remoteJid', v_conversation.remote_jid,
    'body', v_message.body,
    'status', v_message.status,
    'attemptCount', v_message.attempt_count,
    'leaseUntil', v_message.lease_until
  );
end;
$function$;

create or replace function public.finalize_whatsapp_outbound(
  p_tenant_id text,
  p_message_id uuid,
  p_status text,
  p_provider_message_id text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_message public.whatsapp_messages%rowtype;
  v_provider_echo public.whatsapp_messages%rowtype;
  v_requested_provider_message_id text := nullif(
    pg_catalog.btrim(coalesce(p_provider_message_id, '')),
    ''
  );
  v_provider_message_id text;
  v_error_code text := nullif(
    left(pg_catalog.btrim(coalesce(p_error_code, '')), 160),
    ''
  );
  v_next_status text;
  v_metadata jsonb;
begin
  if p_message_id is null
     or nullif(pg_catalog.btrim(p_tenant_id), '') is null
     or p_status not in ('sent', 'delivered', 'read', 'failed', 'uncertain')
     or (
       v_requested_provider_message_id is not null
       and char_length(v_requested_provider_message_id) > 320
     ) then
    raise exception 'invalid_whatsapp_outbound_result'
      using errcode = '22023';
  end if;

  select message.*
  into v_message
  from public.whatsapp_messages as message
  where message.id = p_message_id
    and message.tenant_id = p_tenant_id
    and message.direction = 'out';

  if not found then
    raise exception 'whatsapp_outbound_not_found' using errcode = 'P0002';
  end if;

  if v_message.provider_message_id is not null
     and v_requested_provider_message_id is not null
     and v_message.provider_message_id <> v_requested_provider_message_id then
    raise exception 'whatsapp_provider_message_id_is_immutable'
      using errcode = '22023';
  end if;

  v_provider_message_id := coalesce(
    v_requested_provider_message_id,
    v_message.provider_message_id
  );

  -- A ordem global é advisory(provider) -> linha da mensagem. O store usa a
  -- mesma ordem, evitando deadlock entre o eco do webhook e a resposta HTTP.
  if v_provider_message_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'wa-provider:' || v_message.instance_id::text || ':' ||
        v_provider_message_id,
        0
      )
    );
  end if;

  select message.*
  into v_message
  from public.whatsapp_messages as message
  where message.id = p_message_id
    and message.tenant_id = p_tenant_id
    and message.direction = 'out'
  for update;

  if not found then
    raise exception 'whatsapp_outbound_not_found' using errcode = 'P0002';
  end if;

  if v_message.status = 'queued' then
    raise exception 'whatsapp_outbound_was_not_claimed'
      using errcode = '55000';
  end if;

  if v_message.provider_message_id is not null
     and v_provider_message_id is not null
     and v_message.provider_message_id <> v_provider_message_id then
    raise exception 'whatsapp_provider_message_id_is_immutable'
      using errcode = '22023';
  end if;

  v_metadata := v_message.metadata;
  if v_provider_message_id is not null then

    select echo.*
    into v_provider_echo
    from public.whatsapp_messages as echo
    where echo.instance_id = v_message.instance_id
      and echo.provider_message_id = v_provider_message_id
      and echo.id <> v_message.id
    for update;

    if found then
      if v_provider_echo.tenant_id <> p_tenant_id
         or v_provider_echo.conversation_id <> v_message.conversation_id
         or v_provider_echo.direction <> 'out'
         or v_provider_echo.client_request_id is not null
         or v_provider_echo.body <> v_message.body then
        raise exception 'whatsapp_provider_message_scope_conflict'
          using errcode = '23505';
      end if;
      v_metadata := v_metadata || v_provider_echo.metadata;
      delete from public.whatsapp_messages
      where id = v_provider_echo.id;
    end if;
  end if;

  v_next_status := private.merge_whatsapp_message_status(
    v_message.status,
    p_status
  );

  update public.whatsapp_messages as message
  set status = v_next_status,
      provider_message_id = coalesce(
        message.provider_message_id,
        v_provider_message_id
      ),
      metadata = v_metadata,
      lease_until = null,
      error_code = case
        when v_next_status in ('failed', 'uncertain')
        then coalesce(v_error_code, lower(v_next_status))
        else null
      end,
      sent_at = case
        when v_next_status in ('sent', 'delivered', 'read')
        then coalesce(message.sent_at, pg_catalog.now())
        else message.sent_at
      end,
      delivered_at = case
        when v_next_status in ('delivered', 'read')
        then coalesce(message.delivered_at, pg_catalog.now())
        else message.delivered_at
      end,
      read_at = case
        when v_next_status = 'read'
        then coalesce(message.read_at, pg_catalog.now())
        else message.read_at
      end
  where message.id = v_message.id
  returning message.* into v_message;

  return jsonb_build_object(
    'ok', true,
    'messageId', v_message.id,
    'status', v_message.status,
    'providerMessageId', v_message.provider_message_id
  );
end;
$function$;

create or replace function public.mark_whatsapp_conversation_read(
  p_tenant_id text,
  p_conversation_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_latest_message_id uuid;
  v_read_at timestamptz := pg_catalog.now();
begin
  if p_conversation_id is null
     or not private.whatsapp_inbox_actor_has_role(
       p_actor_id,
       p_tenant_id,
       array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
     ) then
    raise exception 'whatsapp_conversation_read_forbidden'
      using errcode = '42501';
  end if;

  update public.whatsapp_conversations as conversation
  set unread_count = 0
  where conversation.id = p_conversation_id
    and conversation.tenant_id = p_tenant_id;

  if not found then
    raise exception 'whatsapp_conversation_not_found' using errcode = 'P0002';
  end if;

  select message.id
  into v_latest_message_id
  from public.whatsapp_messages as message
  where message.tenant_id = p_tenant_id
    and message.conversation_id = p_conversation_id
  order by message.occurred_at desc, message.id desc
  limit 1;

  insert into public.whatsapp_conversation_reads (
    tenant_id,
    conversation_id,
    user_id,
    last_read_message_id,
    last_read_at
  )
  values (
    p_tenant_id,
    p_conversation_id,
    p_actor_id,
    v_latest_message_id,
    v_read_at
  )
  on conflict (tenant_id, conversation_id, user_id) do update
  set last_read_message_id = excluded.last_read_message_id,
      last_read_at = greatest(
        whatsapp_conversation_reads.last_read_at,
        excluded.last_read_at
      );

  return jsonb_build_object(
    'ok', true,
    'conversationId', p_conversation_id,
    'lastReadMessageId', v_latest_message_id,
    'lastReadAt', v_read_at
  );
end;
$function$;

create or replace function public.set_whatsapp_conversation_handoff(
  p_tenant_id text,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_conversation public.whatsapp_conversations%rowtype;
begin
  if p_conversation_id is null
     or p_active is null
     or not private.whatsapp_inbox_actor_has_role(
       p_actor_id,
       p_tenant_id,
       array['SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR']::text[]
     ) then
    raise exception 'whatsapp_conversation_handoff_forbidden'
      using errcode = '42501';
  end if;

  update public.whatsapp_conversations as conversation
  set handoff_active = p_active,
      human_handoff_until = case
        when p_active then pg_catalog.now() + interval '72 hours'
        else null
      end,
      assigned_to = case when p_active then p_actor_id else null end
  where conversation.id = p_conversation_id
    and conversation.tenant_id = p_tenant_id
  returning conversation.* into v_conversation;

  if not found then
    raise exception 'whatsapp_conversation_not_found' using errcode = 'P0002';
  end if;

  perform private.apply_whatsapp_contact_handoff(
    p_tenant_id,
    v_conversation.phone,
    p_active
  );

  return jsonb_build_object(
    'ok', true,
    'conversationId', v_conversation.id,
    'handoffActive', v_conversation.handoff_active,
    'handoffUntil', v_conversation.human_handoff_until
  );
end;
$function$;

-- O proxy da inbox usa o mesmo broker tenant-aware das ações legadas. A
-- allowlist é recriada integralmente para liberar só leitura de chats e a
-- configuração do webhook, sem transformar o broker num proxy genérico.
create or replace function public.resolve_tenant_integration_for_service(
  p_tenant_id text,
  p_provider text,
  p_capability text,
  p_purpose text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  connection_record private.tenant_integration_connections%rowtype;
  tenant_whatsapp_enabled boolean;
  decrypted_api_key text;
begin
  if p_tenant_id is null
    or nullif(pg_catalog.btrim(p_tenant_id), '') is null
    or p_provider <> 'evolution'
    or p_capability <> 'automation.whatsapp'
    or p_purpose not in (
      'instance.create',
      'instance.connect',
      'instance.connection_state',
      'instance.logout',
      'instance.delete',
      'message.send_text',
      'group.list',
      'chat.list',
      'chat.history',
      'webhook.configure'
    )
  then
    raise exception 'integration_request_not_allowed' using errcode = '42501';
  end if;

  select tenant.whatsapp_enabled
  into tenant_whatsapp_enabled
  from public.tenants as tenant
  where tenant.id = p_tenant_id
    and private.tenant_is_operational(tenant.id);

  if not found or tenant_whatsapp_enabled is not true then
    raise exception 'integration_capability_unavailable' using errcode = '42501';
  end if;

  select connection.*
  into connection_record
  from private.tenant_integration_connections as connection
  where connection.tenant_id = p_tenant_id
    and connection.provider = p_provider;

  if not found
    or connection_record.mode = 'DISABLED'
    or connection_record.status <> 'healthy'
  then
    raise exception 'integration_connection_unavailable' using errcode = '55000';
  end if;

  if connection_record.mode = 'TENANT_BYOK' then
    select decrypted_secret.decrypted_secret
    into decrypted_api_key
    from private.tenant_secret_registry as registry
    join vault.decrypted_secrets as decrypted_secret
      on decrypted_secret.id = registry.vault_secret_id
    where registry.tenant_id = p_tenant_id
      and registry.provider = p_provider
      and registry.status = 'healthy'
      and registry.last_validated_at is not null;

    if decrypted_api_key is null
       or nullif(pg_catalog.btrim(decrypted_api_key), '') is null then
      raise exception 'integration_credential_unavailable' using errcode = '55000';
    end if;
  elsif connection_record.mode <> 'PLATFORM_MANAGED' then
    raise exception 'integration_mode_not_supported' using errcode = '55000';
  end if;

  return jsonb_build_object(
    'integrationId', connection_record.id,
    'tenantId', connection_record.tenant_id,
    'provider', connection_record.provider,
    'mode', connection_record.mode,
    'version', connection_record.version,
    'baseUrl', case
      when connection_record.mode = 'TENANT_BYOK'
      then connection_record.connection_config ->> 'baseUrl'
      else null
    end,
    'apiKey', case
      when connection_record.mode = 'TENANT_BYOK' then decrypted_api_key
      else null
    end
  );
end;
$function$;
revoke all on function public.resolve_tenant_integration_for_service(text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.resolve_tenant_integration_for_service(text,text,text,text)
  to service_role;

revoke all on function public.enable_whatsapp_inbox(text,text,uuid,boolean)
  from public, anon, authenticated;
revoke all on function public.enqueue_whatsapp_webhook_event(text,text,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.store_whatsapp_provider_message(text,text,text,text,text,text,text,text,timestamptz,text,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.store_whatsapp_provider_messages(text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.prepare_whatsapp_outbound(text,text,uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke all on function public.claim_whatsapp_outbound(text,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_whatsapp_outbound(text,uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.mark_whatsapp_conversation_read(text,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.set_whatsapp_conversation_handoff(text,uuid,uuid,boolean)
  from public, anon, authenticated;

grant execute on function public.enable_whatsapp_inbox(text,text,uuid,boolean)
  to service_role;
grant execute on function public.enqueue_whatsapp_webhook_event(text,text,text,text,jsonb)
  to service_role;
grant execute on function public.store_whatsapp_provider_message(text,text,text,text,text,text,text,text,timestamptz,text,text,text,jsonb)
  to service_role;
grant execute on function public.store_whatsapp_provider_messages(text,text,jsonb)
  to service_role;
grant execute on function public.prepare_whatsapp_outbound(text,text,uuid,uuid,uuid,text)
  to service_role;
grant execute on function public.claim_whatsapp_outbound(text,uuid,uuid)
  to service_role;
grant execute on function public.finalize_whatsapp_outbound(text,uuid,text,text,text)
  to service_role;
grant execute on function public.mark_whatsapp_conversation_read(text,uuid,uuid)
  to service_role;
grant execute on function public.set_whatsapp_conversation_handoff(text,uuid,uuid,boolean)
  to service_role;

-- Publicação, não schema realtime: desde julho/2026 o schema interno do
-- Realtime é bloqueado. A publicação oficial é o ponto suportado para CDC.
do $realtime_publication$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'whatsapp_conversations'
    ) then
      alter publication supabase_realtime
        add table public.whatsapp_conversations;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'whatsapp_messages'
    ) then
      alter publication supabase_realtime
        add table public.whatsapp_messages;
    end if;
  end if;
end
$realtime_publication$;

comment on table public.whatsapp_conversations is
  'Tenant-scoped canonical WhatsApp conversations for explicitly enabled institutional instances.';
comment on table public.whatsapp_messages is
  'Canonical WhatsApp timeline and safe manual-send outbox. Ambiguous dispatches are never retried blindly.';
comment on table public.whatsapp_webhook_inbox is
  'Service-only durable inbox for Evolution webhook events before automation processing.';
comment on table public.whatsapp_conversation_reads is
  'Per-user read cursor for the tenant-scoped WhatsApp inbox.';

commit;
