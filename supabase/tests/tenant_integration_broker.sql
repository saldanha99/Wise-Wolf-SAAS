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

select pg_temp.assert_true(
  not exists (
    select 1
    from public.tenants as tenant
    where not exists (
      select 1
      from private.tenant_integration_connections as connection
      where connection.tenant_id = tenant.id
        and connection.provider = 'evolution'
        and connection.mode = 'PLATFORM_MANAGED'
        and connection.status = 'healthy'
    )
  ),
  'tenant existente nao recebeu Evolution gerenciada por padrao'
);

insert into public.tenants (
  id,
  name,
  slug,
  saas_status,
  whatsapp_enabled
)
values
  (
    'broker-school-a',
    'Broker School A',
    'broker-school-a',
    'active',
    true
  ),
  (
    'broker-school-b',
    'Broker School B',
    'broker-school-b',
    'trial',
    true
  );

select pg_temp.assert_true(
  (
    select count(*) = 2
    from private.tenant_integration_connections
    where tenant_id in ('broker-school-a', 'broker-school-b')
      and provider = 'evolution'
      and mode = 'PLATFORM_MANAGED'
      and status = 'healthy'
  ),
  'trigger nao criou conexao gerenciada para os dois tenants'
);

select pg_temp.assert_true(
  not has_table_privilege(
    'authenticated',
    'private.tenant_integration_connections',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'private.tenant_integration_connections',
    'SELECT'
  )
  and not has_function_privilege(
    'authenticated',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  ),
  'broker ou tabela privada ficaram expostos ao cliente'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  (
    public.resolve_tenant_integration_for_service(
      'broker-school-a',
      'evolution',
      'automation.whatsapp',
      'message.send_text'
    ) ->> 'mode'
  ) = 'PLATFORM_MANAGED'
  and (
    public.resolve_tenant_integration_for_service(
      'broker-school-b',
      'evolution',
      'automation.whatsapp',
      'message.send_text'
    ) ->> 'mode'
  ) = 'PLATFORM_MANAGED'
  and (
    public.resolve_tenant_integration_for_service(
      'broker-school-a',
      'evolution',
      'automation.whatsapp',
      'message.send_text'
    ) ->> 'integrationId'
  ) is distinct from (
    public.resolve_tenant_integration_for_service(
      'broker-school-b',
      'evolution',
      'automation.whatsapp',
      'message.send_text'
    ) ->> 'integrationId'
  ),
  'resolucao gerenciada nao isolou as conexoes A/B'
);

reset role;

select public.upsert_tenant_integration_secret(
  'broker-school-a',
  'evolution',
  'broker-secret-a-1234',
  'platform',
  null,
  'Broker A fixture'
);
select public.upsert_tenant_integration_secret(
  'broker-school-b',
  'evolution',
  'broker-secret-b-5678',
  'platform',
  null,
  'Broker B fixture'
);

update private.tenant_integration_connections
set mode = 'TENANT_BYOK',
    status = 'healthy',
    connection_config = '{"baseUrl":"https://evolution-a.example.com"}'::jsonb,
    version = version + 1,
    last_verified_at = now(),
    updated_at = now()
where tenant_id = 'broker-school-a'
  and provider = 'evolution';

update private.tenant_integration_connections
set mode = 'TENANT_BYOK',
    status = 'healthy',
    connection_config = '{"baseUrl":"https://evolution-b.example.com"}'::jsonb,
    version = version + 1,
    last_verified_at = now(),
    updated_at = now()
where tenant_id = 'broker-school-b'
  and provider = 'evolution';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  (
    public.resolve_tenant_integration_for_service(
      'broker-school-a',
      'evolution',
      'automation.whatsapp',
      'instance.connection_state'
    ) ->> 'apiKey'
  ) = 'broker-secret-a-1234'
  and (
    public.resolve_tenant_integration_for_service(
      'broker-school-a',
      'evolution',
      'automation.whatsapp',
      'instance.connection_state'
    ) ->> 'baseUrl'
  ) = 'https://evolution-a.example.com'
  and (
    public.resolve_tenant_integration_for_service(
      'broker-school-b',
      'evolution',
      'automation.whatsapp',
      'instance.connection_state'
    ) ->> 'apiKey'
  ) = 'broker-secret-b-5678',
  'BYOK retornou segredo ou endpoint de outro tenant'
);

do $$
begin
  perform public.resolve_tenant_integration_for_service(
    'broker-school-a',
    'evolution',
    'automation.whatsapp',
    'billing.charge'
  );
  raise exception 'assertion failed: broker aceitou finalidade desconhecida';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;

update public.tenants
set whatsapp_enabled = false
where id = 'broker-school-b';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
begin
  perform public.resolve_tenant_integration_for_service(
    'broker-school-b',
    'evolution',
    'automation.whatsapp',
    'message.send_text'
  );
  raise exception 'assertion failed: tenant B sem capacidade usou Evolution';
exception
  when insufficient_privilege then null;
end;
$$;

select pg_temp.assert_true(
  (
    public.resolve_tenant_integration_for_service(
      'broker-school-a',
      'evolution',
      'automation.whatsapp',
      'message.send_text'
    ) ->> 'apiKey'
  ) = 'broker-secret-a-1234',
  'bloqueio do tenant B afetou a conexao do tenant A'
);

reset role;

update private.tenant_integration_connections
set mode = 'DISABLED',
    status = 'disabled',
    connection_config = '{}'::jsonb,
    version = version + 1,
    updated_at = now()
where tenant_id = 'broker-school-a'
  and provider = 'evolution';

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
begin
  perform public.resolve_tenant_integration_for_service(
    'broker-school-a',
    'evolution',
    'automation.whatsapp',
    'message.send_text'
  );
  raise exception 'assertion failed: conexao desativada continuou operacional';
exception
  when sqlstate '55000' then null;
end;
$$;

reset role;

do $$
begin
  update private.tenant_integration_connections
  set mode = 'TENANT_BYOK',
      status = 'healthy',
      connection_config = '{"baseUrl":"http://127.0.0.1"}'::jsonb
  where tenant_id = 'broker-school-a'
    and provider = 'evolution';
  raise exception 'assertion failed: schema aceitou endpoint HTTP';
exception
  when check_violation then null;
end;
$$;

rollback;
