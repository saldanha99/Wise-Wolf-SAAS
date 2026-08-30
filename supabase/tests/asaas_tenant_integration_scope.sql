-- A conta Asaas raiz nunca pode ser herdada por outro tenant.

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $function$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$function$;
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

select pg_temp.assert_true(
  exists (
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
  ),
  'tenant de referencia nao possui binding Asaas explicito e valido'
);

select pg_temp.assert_true(
  not exists (
    select 1
     from private.tenant_integration_connections as connection
     where connection.provider = 'asaas'
       and connection.tenant_id <> 'school-wise-wolf'
       and (
         connection.mode <> 'DISABLED'
         or connection.status <> 'disabled'
       )
  ),
  'tenant sem binding financeiro isolado ficou operacional no Asaas'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.resolve_tenant_integration_for_service(text,text,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.record_tenant_integration_verified(text,text,bigint)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.record_tenant_integration_verified(text,text,bigint)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.record_tenant_integration_verified(text,text,bigint)',
    'EXECUTE'
  ),
  'ACL do broker Asaas nao esta fail-closed'
);

grant execute on all functions in schema pg_temp
  to anon, authenticated, service_role;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  (
    with configured as (
      select connection.mode
        from private.tenant_integration_connections as connection
       where connection.tenant_id = 'school-wise-wolf'
         and connection.provider = 'asaas'
    ), resolved as (
      select public.resolve_tenant_integration_for_service(
        'school-wise-wolf',
        'asaas',
        'billing.school',
        'payment.read'
      ) as value
    )
    select resolved.value ->> 'tenantId' = 'school-wise-wolf'
       and resolved.value ->> 'mode' = configured.mode
       and configured.mode = 'PLATFORM_MANAGED_ROOT'
       and resolved.value ->> 'apiKey' is null
      from configured, resolved
  ),
  'resolver nao devolveu o binding Asaas explicito do tenant'
);

select pg_temp.assert_true(
  public.record_tenant_integration_verified(
    'school-wise-wolf',
    'asaas',
    (
      select connection.version
        from private.tenant_integration_connections as connection
       where connection.tenant_id = 'school-wise-wolf'
         and connection.provider = 'asaas'
    )
  ),
  'leitura autenticada nao conseguiu registrar verificacao da conexao'
);

select pg_temp.assert_true(
  exists (
    select 1
      from private.tenant_integration_connections as connection
     where connection.tenant_id = 'school-wise-wolf'
       and connection.provider = 'asaas'
       and connection.status = 'healthy'
       and connection.last_verified_at is not null
  ),
  'conexao verificada nao registrou saude e horario'
);

reset role;

insert into public.tenants (id, name, saas_status)
values ('asaas-scope-test', 'Asaas Scope Test', 'active');

select pg_temp.assert_true(
  exists (
    select 1
      from private.tenant_integration_connections as connection
     where connection.tenant_id = 'asaas-scope-test'
       and connection.provider = 'asaas'
       and connection.mode = 'DISABLED'
       and connection.status = 'disabled'
  ),
  'novo tenant nao nasceu com Asaas desabilitado'
);

do $root_scope_constraint$
begin
  begin
    update private.tenant_integration_connections
       set mode = 'PLATFORM_MANAGED_ROOT',
           status = 'healthy'
     where tenant_id = 'asaas-scope-test'
       and provider = 'asaas';
    raise exception 'assertion failed: outro tenant aceitou conta raiz';
  exception
    when check_violation then null;
  end;
end
$root_scope_constraint$;

do $unsupported_tenant_mode$
begin
  begin
    update private.tenant_integration_connections
       set mode = 'TENANT_BYOK',
           status = 'healthy'
     where tenant_id = 'asaas-scope-test'
       and provider = 'asaas';
    raise exception 'assertion failed: tenant nao migrado aceitou BYOK';
  exception
    when check_violation then null;
  end;
end
$unsupported_tenant_mode$;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $unsupported_tenant_resolution$
begin
  begin
    perform public.resolve_tenant_integration_for_service(
      'asaas-scope-test',
      'asaas',
      'billing.school',
      'payment.create'
    );
    raise exception 'assertion failed: tenant nao migrado resolveu Asaas';
  exception
    when insufficient_privilege then null;
  end;
end
$unsupported_tenant_resolution$;

do $invalid_capability$
begin
  begin
    perform public.resolve_tenant_integration_for_service(
      'school-wise-wolf',
      'asaas',
      'billing.school',
      'transfer.submit'
    );
    raise exception 'assertion failed: capability/purpose cruzados foram aceitos';
  exception
    when insufficient_privilege then null;
  end;
end
$invalid_capability$;

reset role;

rollback;
