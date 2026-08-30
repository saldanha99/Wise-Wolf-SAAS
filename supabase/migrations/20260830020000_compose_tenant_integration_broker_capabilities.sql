begin;

-- The WhatsApp inbox extends the shared tenant integration broker. Keep the
-- existing Asaas capability matrix (including the narrow, secret-free
-- historical reversal receipt) while adding only the three inbox purposes.
-- Replacing the broker with an Evolution-only implementation would make every
-- school billing automation fail closed after the inbox migration.
do $preconditions$
begin
  if to_regprocedure(
    'public.resolve_tenant_integration_for_service(text,text,text,text)'
  ) is null
    or to_regprocedure('private.tenant_is_operational(text)') is null
    or to_regclass('private.tenant_integration_connections') is null
  then
    raise exception 'tenant integration broker prerequisites are missing';
  end if;
end
$preconditions$;

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
  historical_reversal boolean := false;
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

  historical_reversal := p_provider = 'asaas'
    and p_capability = 'webhook.consume'
    and p_purpose = 'payment.reversal';

  if not private.tenant_is_operational(p_tenant_id)
    and not historical_reversal
  then
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
        'group.list',
        'chat.list',
        'chat.history',
        'webhook.configure'
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
    or (
      p_capability = 'webhook.consume'
      and p_purpose in ('payment.event', 'payment.reversal')
    )
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

  if not found then
    raise exception 'integration_connection_unavailable' using errcode = '55000';
  end if;

  -- This receipt authorizes only an already authenticated historical provider
  -- reversal. It intentionally contains no endpoint or credential and may
  -- survive tenant suspension or integration offboarding.
  if historical_reversal then
    if connection_record.tenant_id <> 'school-wise-wolf'
      or connection_record.provider <> 'asaas'
    then
      raise exception 'integration_capability_unavailable' using errcode = '42501';
    end if;

    return pg_catalog.jsonb_build_object(
      'integrationId', connection_record.id,
      'tenantId', connection_record.tenant_id,
      'provider', connection_record.provider,
      'mode', 'HISTORICAL_WEBHOOK',
      'version', connection_record.version,
      'baseUrl', null,
      'apiKey', null,
      'environment', null
    );
  end if;

  if connection_record.mode = 'DISABLED'
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

comment on function public.resolve_tenant_integration_for_service(
  text, text, text, text
) is
  'Fail-closed tenant integration broker composing Evolution WhatsApp and scoped Asaas capabilities; historical reversals receive only a secret-free authorization receipt.';

do $postcheck$
declare
  broker_oid regprocedure :=
    'public.resolve_tenant_integration_for_service(text,text,text,text)'::regprocedure;
  definition text;
  required_token text;
begin
  select pg_catalog.pg_get_functiondef(broker_oid)
    into definition;

  foreach required_token in array array[
    '''chat.list''',
    '''chat.history''',
    '''webhook.configure''',
    '''billing.school''',
    '''webhook.consume''',
    '''reconciliation.read''',
    '''payout.teacher''',
    '''payment.reversal''',
    '''HISTORICAL_WEBHOOK'''
  ]::text[]
  loop
    if pg_catalog.strpos(definition, required_token) = 0 then
      raise exception 'tenant integration broker lost capability %', required_token;
    end if;
  end loop;

  if exists (
    select 1
      from pg_catalog.pg_proc as procedure
     where procedure.oid = broker_oid
       and (
         not procedure.prosecdef
         or pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
         or not coalesce(
           procedure.proconfig @> array['search_path=""']::text[],
           false
         )
       )
  )
    or pg_catalog.has_function_privilege('anon', broker_oid, 'EXECUTE')
    or pg_catalog.has_function_privilege(
      'authenticated', broker_oid, 'EXECUTE'
    )
    or not pg_catalog.has_function_privilege(
      'service_role', broker_oid, 'EXECUTE'
    )
  then
    raise exception 'tenant integration broker hardening failed';
  end if;
end;
$postcheck$;

commit;
