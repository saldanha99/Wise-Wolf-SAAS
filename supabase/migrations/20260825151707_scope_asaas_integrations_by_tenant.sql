-- Isola o uso da conta Asaas por tenant.
--
-- A conta raiz existente pertence operacionalmente ao tenant de referencia
-- school-wise-wolf. Nenhum outro tenant pode herdar essa credencial por
-- ausencia de configuracao. Como os IDs financeiros do aluno ainda sao
-- globais em profiles, subconta/BYOK permanecem bloqueados ate existir um
-- binding por (tenant, aluno, provedor).

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $guard$
begin
  if to_regclass('private.tenant_integration_connections') is null
    or to_regclass('private.tenant_secret_registry') is null
    or to_regprocedure(
      'public.resolve_tenant_integration_for_service(text,text,text,text)'
    ) is null
    or to_regprocedure('private.tenant_is_operational(text)') is null
  then
    raise exception 'tenant_integration_broker_foundation_is_required';
  end if;
end
$guard$;

-- A conta raiz compartilhada e uma excecao de compatibilidade estritamente
-- limitada ao tenant que ja concentra todos os pagamentos escolares atuais.
alter table private.tenant_integration_connections
  drop constraint if exists tenant_integration_connections_mode_check;

alter table private.tenant_integration_connections
  add constraint tenant_integration_connections_mode_check check (
    (provider = 'evolution' and mode in (
      'PLATFORM_MANAGED', 'TENANT_BYOK', 'DISABLED'
    ))
    or (
      provider = 'asaas'
      and (
        mode = 'DISABLED'
        or (mode = 'PLATFORM_MANAGED_ROOT' and tenant_id = 'school-wise-wolf')
      )
    )
    or (provider in ('openai', 'openrouter') and mode in (
      'PLATFORM_MANAGED', 'TENANT_BYOK', 'DISABLED'
    ))
  ) not valid;

-- Preserve configuration material for a future migration, but remove every
-- operational route that could combine a tenant credential with global IDs.
update private.tenant_integration_connections as connection
   set mode = case
         when connection.tenant_id = 'school-wise-wolf'
           then 'PLATFORM_MANAGED_ROOT'
         else 'DISABLED'
       end,
       status = case
         when connection.tenant_id = 'school-wise-wolf'
           and connection.status = 'healthy'
           and connection.last_verified_at is not null
         then 'healthy'
         when connection.tenant_id = 'school-wise-wolf' then 'configured'
         else 'disabled'
       end,
       last_verified_at = case
         when connection.tenant_id = 'school-wise-wolf'
           and connection.status = 'healthy'
         then connection.last_verified_at
         else null
       end,
       last_error_code = null,
       updated_at = pg_catalog.clock_timestamp()
 where connection.provider = 'asaas';

alter table private.tenant_integration_connections
  validate constraint tenant_integration_connections_mode_check;

insert into private.tenant_integration_connections as existing (
  tenant_id,
  provider,
  mode,
  status,
  connection_config,
  last_verified_at
)
select
  tenant.id,
  'asaas',
  case
    when tenant.id = 'school-wise-wolf' then 'PLATFORM_MANAGED_ROOT'
    else 'DISABLED'
  end,
  case
    when tenant.id = 'school-wise-wolf' then 'configured'
    else 'disabled'
  end,
  '{}'::jsonb,
  null
from public.tenants as tenant
on conflict (tenant_id, provider) do update
set mode = excluded.mode,
    status = case
      when excluded.tenant_id = 'school-wise-wolf'
        and existing.status = 'healthy'
        and existing.last_verified_at is not null
      then 'healthy'
      else excluded.status
    end,
    last_verified_at = case
      when excluded.tenant_id = 'school-wise-wolf'
        and existing.status = 'healthy'
      then existing.last_verified_at
      else null
    end,
    last_error_code = null,
    updated_at = pg_catalog.clock_timestamp();

-- Todo tenant criado depois deste rollout nasce com Asaas bloqueado. Ativar
-- exige primeiro uma migration de binding financeiro tenant-scoped e nunca
-- acontece por configuracao ou fallback isolados.
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

  insert into private.tenant_integration_connections (
    tenant_id,
    provider,
    mode,
    status,
    connection_config
  )
  values (
    new.id,
    'asaas',
    'DISABLED',
    'disabled',
    '{}'::jsonb
  )
  on conflict (tenant_id, provider) do nothing;

  return new;
end;
$function$;

alter function private.create_tenant_admin_settings() owner to postgres;
revoke all on function private.create_tenant_admin_settings()
  from public, anon, authenticated, service_role;
grant execute on function private.create_tenant_admin_settings()
  to postgres, supabase_admin;

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
  credential_environment text;
begin
  if p_tenant_id is null
    or nullif(pg_catalog.btrim(p_tenant_id), '') is null
    or p_provider is null
    or p_capability is null
    or p_purpose is null
    or p_provider not in ('evolution', 'asaas')
  then
    raise exception 'integration_request_not_allowed' using errcode = '42501';
  end if;

  if not private.tenant_is_operational(p_tenant_id) then
    raise exception 'integration_capability_unavailable' using errcode = '42501';
  end if;

  if p_provider = 'asaas' and p_tenant_id <> 'school-wise-wolf' then
    raise exception 'integration_capability_unavailable' using errcode = '42501';
  end if;

  if p_provider = 'evolution' then
    if not coalesce(
      p_capability = 'automation.whatsapp'
      and p_purpose in (
        'instance.create',
        'instance.connect',
        'instance.connection_state',
        'instance.logout',
        'instance.delete',
        'message.send_text',
        'group.list'
      ),
      false
    )
    then
      raise exception 'integration_request_not_allowed' using errcode = '42501';
    end if;

    select tenant.whatsapp_enabled
      into tenant_whatsapp_enabled
      from public.tenants as tenant
     where tenant.id = p_tenant_id;
    if tenant_whatsapp_enabled is not true then
      raise exception 'integration_capability_unavailable' using errcode = '42501';
    end if;
  elsif not coalesce((
    (p_capability = 'billing.school' and p_purpose in (
      'customer.create',
      'customer.read',
      'customer.update',
      'customer.delete',
      'payment.create',
      'payment.read',
      'payment.update',
      'payment.delete',
      'subscription.create',
      'subscription.read',
      'subscription.update',
      'subscription.delete',
      'dunning.create'
    ))
    or (p_capability = 'webhook.consume' and p_purpose = 'payment.event')
    or (
      p_capability = 'reconciliation.read'
      and p_purpose in ('payment.list', 'transfer.list')
    )
    or (
      p_capability = 'payout.teacher'
      and p_purpose in ('transfer.submit', 'transfer.read')
    )
  ), false) then
    raise exception 'integration_request_not_allowed' using errcode = '42501';
  end if;

  select connection.*
    into connection_record
    from private.tenant_integration_connections as connection
   where connection.tenant_id = p_tenant_id
     and connection.provider = p_provider;

  if not found
    or connection_record.mode = 'DISABLED'
    or (
      connection_record.status <> 'healthy'
      and not (
        connection_record.provider = 'asaas'
        and connection_record.mode = 'PLATFORM_MANAGED_ROOT'
        and connection_record.tenant_id = 'school-wise-wolf'
        and connection_record.status = 'configured'
      )
    )
  then
    raise exception 'integration_connection_unavailable' using errcode = '55000';
  end if;

  if p_provider = 'evolution' then
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
      if nullif(pg_catalog.btrim(decrypted_api_key), '') is null then
        raise exception 'integration_credential_unavailable' using errcode = '55000';
      end if;
    elsif connection_record.mode <> 'PLATFORM_MANAGED' then
      raise exception 'integration_mode_not_supported' using errcode = '55000';
    end if;
  elsif connection_record.mode = 'PLATFORM_MANAGED_ROOT'
    and connection_record.tenant_id = 'school-wise-wolf'
  then
    credential_environment := 'platform';
  else
    raise exception 'integration_mode_not_supported' using errcode = '55000';
  end if;

  return pg_catalog.jsonb_build_object(
    'integrationId', connection_record.id,
    'tenantId', connection_record.tenant_id,
    'provider', connection_record.provider,
    'mode', connection_record.mode,
    'version', connection_record.version,
    'baseUrl', case
      when connection_record.provider = 'evolution'
        and connection_record.mode = 'TENANT_BYOK'
      then connection_record.connection_config ->> 'baseUrl'
      else null
    end,
    'apiKey', case
      when connection_record.mode in (
        'TENANT_BYOK', 'PLATFORM_MANAGED_SUBACCOUNT'
      )
      then decrypted_api_key
      else null
    end,
    'environment', credential_environment
  );
end;
$function$;

alter function public.resolve_tenant_integration_for_service(
  text, text, text, text
) owner to postgres;
revoke all on function public.resolve_tenant_integration_for_service(
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_tenant_integration_for_service(
  text, text, text, text
) to service_role;

-- O binding raiz nasce apenas configurado. Somente uma leitura autenticada e
-- bem-sucedida do provedor pode registrar que a conexao foi verificada. A
-- versao impede que uma resposta atrasada valide uma credencial ja trocada.
create or replace function public.record_tenant_integration_verified(
  p_tenant_id text,
  p_provider text,
  p_expected_version bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_updated boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  if p_tenant_id is null
    or nullif(pg_catalog.btrim(p_tenant_id), '') is null
    or p_provider <> 'asaas'
    or p_expected_version is null
    or p_expected_version <= 0
  then
    raise exception 'invalid_integration_verification' using errcode = '22023';
  end if;

  update private.tenant_integration_connections as connection
     set status = 'healthy',
         last_verified_at = pg_catalog.clock_timestamp(),
         last_error_code = null,
         updated_at = pg_catalog.clock_timestamp()
   where connection.tenant_id = p_tenant_id
     and connection.provider = p_provider
     and connection.tenant_id = 'school-wise-wolf'
     and connection.mode = 'PLATFORM_MANAGED_ROOT'
     and connection.version = p_expected_version
     and connection.mode <> 'DISABLED'
     and connection.status in ('configured', 'healthy')
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$function$;

alter function public.record_tenant_integration_verified(text, text, bigint)
  owner to postgres;
revoke all on function public.record_tenant_integration_verified(
  text, text, bigint
) from public, anon, authenticated;
grant execute on function public.record_tenant_integration_verified(
  text, text, bigint
) to service_role;

do $postconditions$
begin
  if not exists (
    select 1
     from private.tenant_integration_connections as connection
     where connection.tenant_id = 'school-wise-wolf'
       and connection.provider = 'asaas'
       and connection.mode = 'PLATFORM_MANAGED_ROOT'
       and (
         (
           connection.mode = 'PLATFORM_MANAGED_ROOT'
           and connection.status = 'configured'
           and connection.last_verified_at is null
         )
         or
         (connection.status = 'healthy' and connection.last_verified_at is not null)
       )
  ) then
    raise exception 'reference_tenant_asaas_binding_missing_or_invalid';
  end if;

  if exists (
    select 1
     from private.tenant_integration_connections as connection
     where connection.provider = 'asaas'
       and connection.tenant_id <> 'school-wise-wolf'
       and (
         connection.mode <> 'DISABLED'
         or connection.status <> 'disabled'
       )
  ) then
    raise exception 'non_reference_tenant_asaas_not_disabled';
  end if;

  if exists (
    select 1
      from public.tenants as tenant
     where not exists (
       select 1
         from private.tenant_integration_connections as connection
        where connection.tenant_id = tenant.id
          and connection.provider = 'asaas'
     )
  ) then
    raise exception 'tenant_without_explicit_asaas_connection';
  end if;

  if pg_catalog.has_function_privilege(
    'anon',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  ) or not pg_catalog.has_function_privilege(
    'service_role',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'anon',
    'public.record_tenant_integration_verified(text,text,bigint)',
    'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.record_tenant_integration_verified(text,text,bigint)',
    'EXECUTE'
  ) or not pg_catalog.has_function_privilege(
    'service_role',
    'public.record_tenant_integration_verified(text,text,bigint)',
    'EXECUTE'
  ) then
    raise exception 'tenant_integration_resolver_acl_invalid';
  end if;
end
$postconditions$;

notify pgrst, 'reload schema';
