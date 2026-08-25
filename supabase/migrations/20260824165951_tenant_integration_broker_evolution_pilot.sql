-- Broker interno de integracoes por tenant, com Evolution como consumidor piloto.
-- Segredos continuam no Vault e nunca ficam disponiveis para anon/authenticated.

do $guard$
begin
  if to_regclass('public.tenants') is null
    or to_regclass('private.tenant_secret_registry') is null
    or to_regprocedure('private.tenant_is_operational(text)') is null
  then
    raise exception 'tenant_security_center_is_required';
  end if;
end
$guard$;

create or replace function private.tenant_integration_config_is_valid(
  p_provider text,
  p_mode text,
  p_config jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_config is null
      or jsonb_typeof(p_config) <> 'object'
      or pg_catalog.pg_column_size(p_config) > 4096
    then false
    when p_provider = 'evolution' and p_mode = 'TENANT_BYOK'
    then
      p_config ? 'baseUrl'
      and p_config - 'baseUrl' = '{}'::jsonb
      and jsonb_typeof(p_config -> 'baseUrl') = 'string'
      and length(trim(p_config ->> 'baseUrl')) between 12 and 2048
      and trim(p_config ->> 'baseUrl') ~ '^https://'
    else p_config = '{}'::jsonb
  end;
$function$;
revoke all on function private.tenant_integration_config_is_valid(text,text,jsonb)
  from public, anon, authenticated;
grant execute on function private.tenant_integration_config_is_valid(text,text,jsonb)
  to postgres, supabase_admin, service_role;

create table if not exists private.tenant_integration_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  provider text not null
    check (provider in ('asaas', 'evolution', 'openai', 'openrouter')),
  mode text not null,
  status text not null default 'healthy'
    check (status in ('configured', 'healthy', 'error', 'disabled')),
  connection_config jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version > 0),
  last_verified_at timestamptz,
  last_error_code text
    check (last_error_code is null or length(last_error_code) between 2 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider),
  constraint tenant_integration_connections_mode_check check (
    (provider = 'evolution' and mode in (
      'PLATFORM_MANAGED', 'TENANT_BYOK', 'DISABLED'
    ))
    or (provider = 'asaas' and mode in (
      'PLATFORM_MANAGED_SUBACCOUNT', 'TENANT_BYOK', 'DISABLED'
    ))
    or (provider in ('openai', 'openrouter') and mode in (
      'PLATFORM_MANAGED', 'TENANT_BYOK', 'DISABLED'
    ))
  ),
  constraint tenant_integration_connections_mode_status_check check (
    (mode = 'DISABLED' and status = 'disabled')
    or (mode <> 'DISABLED' and status <> 'disabled')
  ),
  constraint tenant_integration_connections_config_check check (
    private.tenant_integration_config_is_valid(
      provider,
      mode,
      connection_config
    )
  )
);

alter table private.tenant_integration_connections enable row level security;
revoke all on table private.tenant_integration_connections
  from public, anon, authenticated;
grant all on table private.tenant_integration_connections to service_role;

create index if not exists tenant_integration_connections_operational_idx
  on private.tenant_integration_connections (tenant_id, provider, status)
  where mode <> 'DISABLED';

-- Compatibilidade segura: nenhuma credencial previamente cadastrada muda o
-- roteamento sozinha. Todos os tenants atuais continuam na conexao gerenciada.
insert into private.tenant_integration_connections (
  tenant_id,
  provider,
  mode,
  status,
  connection_config
)
select
  tenant.id,
  'evolution',
  'PLATFORM_MANAGED',
  'healthy',
  '{}'::jsonb
from public.tenants as tenant
on conflict (tenant_id, provider) do nothing;

create or replace function private.create_tenant_admin_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.tenant_admin_settings (tenant_id)
  values (new.id)
  on conflict (tenant_id) do nothing;

  insert into private.tenant_integration_connections (
    tenant_id,
    provider,
    mode,
    status,
    connection_config
  )
  values (
    new.id,
    'evolution',
    'PLATFORM_MANAGED',
    'healthy',
    '{}'::jsonb
  )
  on conflict (tenant_id, provider) do nothing;

  return new;
end;
$function$;
revoke all on function private.create_tenant_admin_settings()
  from public, anon, authenticated;

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
    or nullif(trim(p_tenant_id), '') is null
    or p_provider <> 'evolution'
    or p_capability <> 'automation.whatsapp'
    or p_purpose not in (
      'instance.create',
      'instance.connect',
      'instance.connection_state',
      'instance.logout',
      'instance.delete',
      'message.send_text',
      'group.list'
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

    if decrypted_api_key is null or nullif(trim(decrypted_api_key), '') is null then
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
