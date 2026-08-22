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

insert into public.tenants (id, name, slug, saas_status)
values
  ('settings-school-a', 'Settings School A', 'settings-school-a', 'active'),
  ('settings-school-b', 'Settings School B', 'settings-school-b', 'trial');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000a81', 'authenticated', 'authenticated', 'settings-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Admin A"}', now(), now()),
  ('00000000-0000-4000-8000-000000000a82', 'authenticated', 'authenticated', 'settings-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Admin B"}', now(), now()),
  ('00000000-0000-4000-8000-000000000a83', 'authenticated', 'authenticated', 'teacher-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher B"}', now(), now());

update public.profiles set tenant_id='settings-school-a', role='SCHOOL_ADMIN'
where id='00000000-0000-4000-8000-000000000a81';
update public.profiles set tenant_id='settings-school-b', role='SCHOOL_ADMIN'
where id='00000000-0000-4000-8000-000000000a82';
update public.profiles set tenant_id='settings-school-b', role='TEACHER'
where id='00000000-0000-4000-8000-000000000a83';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
values
  ('00000000-0000-4000-8000-000000000a81', 'settings-school-a', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000a82', 'settings-school-b', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-000000000a83', 'settings-school-b', 'TEACHER', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role=excluded.role, status=excluded.status, is_primary=excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  ('00000000-0000-4000-8000-000000000a81', 'settings-school-a'),
  ('00000000-0000-4000-8000-000000000a82', 'settings-school-b'),
  ('00000000-0000-4000-8000-000000000a83', 'settings-school-b')
on conflict (user_id) do update set tenant_id=excluded.tenant_id, updated_at=now();

select pg_temp.assert_true(
  (select count(*) = 2 from public.tenant_admin_settings
    where tenant_id in ('settings-school-a', 'settings-school-b')),
  'trigger nao criou settings para os dois tenants'
);

select pg_temp.assert_true(
  private.tenant_is_operational('settings-school-a')
  and private.tenant_is_operational('settings-school-b'),
  'tenant active/trial nao foi reconhecido como operacional'
);

select pg_temp.assert_true(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'teachers_group_id'
  )
  and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'hr_group_id'
  )
  and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'directors_group_id'
  ),
  'colunas institucionais de grupos WhatsApp nao foram provisionadas'
);

select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'public.tenant_admin_settings', 'SELECT')
  and not has_table_privilege('authenticated', 'public.tenant_admin_settings', 'UPDATE')
  and not has_table_privilege('anon', 'public.tenant_configuration_audit', 'SELECT')
  and exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname='public'
      and tablename='tenant_configuration_audit'
      and policyname='tenant_configuration_audit_admin_read'
      and position('_my_tenant_is_operational' in coalesce(qual, '')) > 0
  ),
  'tabelas internas de settings ficaram expostas ao cliente'
);

select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.apply_tenant_admin_settings(text,uuid,bigint,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.upsert_tenant_integration_secret(text,text,text,text,uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_tenant_secret_status(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._my_tenant_is_operational()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public._my_tenant_is_operational()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.verify_custom_domain()', 'EXECUTE'),
  'RPC interna/legada ficou executavel pelo cliente'
);

select pg_temp.assert_true(
  position(
    'pg_advisory_xact_lock' in pg_get_functiondef(
      'public.upsert_tenant_integration_secret(text,text,text,text,uuid,text)'::regprocedure
    )
  ) > 0,
  'upsert de segredo nao esta serializado por tenant/provedor'
);

do $$
begin
  perform public.upsert_tenant_integration_secret(
    'settings-school-a',
    'asaas',
    'invalid-environment-secret',
    'platform',
    '00000000-0000-4000-8000-000000000a81',
    'Invalid environment'
  );
  raise exception 'assertion failed: Asaas aceitou ambiente fora do enum';
exception when invalid_parameter_value then null;
end;
$$;

select public.apply_tenant_admin_settings(
  'settings-school-a',
  '00000000-0000-4000-8000-000000000a81',
  1,
  jsonb_build_object(
    'name', 'Settings School A Updated',
    'slug', 'settings-school-a-updated',
    'branding', jsonb_build_object(
      'primaryColor', '#123456',
      'secondaryColor', '#ABCDEF',
      'logoPath', '',
      'faviconPath', '',
      'logoUrl', '',
      'faviconUrl', ''
    ),
    'schoolInfo', jsonb_build_object('legalName', 'School A LTDA'),
    'whatsappEnabled', true,
    'financialCutoffDay', 5,
    'locale', 'pt-BR',
    'timezone', 'America/Sao_Paulo',
    'currency', 'BRL',
    'weekStartsOn', 1,
    'defaultLessonDurationMinutes', 60,
    'studentNotificationsEnabled', true,
    'teacherNotificationsEnabled', true
  )
);

select pg_temp.assert_true(
  (select version = 2 from public.tenant_admin_settings where tenant_id='settings-school-a')
  and (select name='Settings School A Updated' from public.tenants where id='settings-school-a')
  and (select count(*)=1 from public.tenant_configuration_audit
       where tenant_id='settings-school-a' and action='settings_published'),
  'publicacao atomica/versionada nao persistiu corretamente'
);

do $$
begin
  perform public.apply_tenant_admin_settings(
    'settings-school-b',
    '00000000-0000-4000-8000-000000000a81',
    1,
    '{}'::jsonb
  );
  raise exception 'assertion failed: admin A alterou settings do tenant B';
exception when insufficient_privilege then null;
end;
$$;

select public.upsert_tenant_integration_secret(
  'settings-school-a',
  'openai',
  'sk-test-only-never-real-1234',
  'production',
  '00000000-0000-4000-8000-000000000a81',
  'Test account'
);

select pg_temp.assert_true(
  (select secret_last_four='1234' and status='healthy'
     from public.get_tenant_secret_status('settings-school-a')
    where provider='openai')
  and not exists (
    select 1 from information_schema.columns
    where table_schema='private'
      and table_name='tenant_integration_secrets'
      and column_name in ('whatsapp_api_key', 'asaas_api_key')
  ),
  'credencial nao foi mascarada no Vault ou plaintext legado permaneceu'
);

select pg_temp.assert_true(
  (
    select school_info is null
    from public.resolve_public_tenant(
      'settings-school-a-updated.wisewolflanguage.com.br'
    )
    limit 1
  ),
  'resolver anonimo devolveu identidade juridica'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000a81","role":"authenticated"}';

do $$
begin
  perform public.complete_teacher_offboarding('00000000-0000-4000-8000-000000000a83');
  raise exception 'assertion failed: admin A desligou professor do tenant B';
exception when insufficient_privilege then null;
end;
$$;

reset role;

insert into public.whatsapp_instances (user_id, instance_name, instance_id, api_key)
values ('00000000-0000-4000-8000-000000000a81', 'settings-instance-a', 'instance-a', 'must-not-persist');

select pg_temp.assert_true(
  (select tenant_id='settings-school-a' and api_key is null
     from public.whatsapp_instances where instance_name='settings-instance-a'),
  'instancia WhatsApp nao foi vinculada ao tenant ou guardou chave plaintext'
);

do $$
begin
  insert into public.whatsapp_instances (user_id, instance_name, instance_id)
  values ('00000000-0000-4000-8000-000000000a82', 'SETTINGS-INSTANCE-A', 'instance-b');
  raise exception 'assertion failed: colisao global de instancia WhatsApp foi aceita';
exception when unique_violation then null;
end;
$$;

select pg_temp.assert_true(
  (select not public and file_size_limit=2097152
     from storage.buckets where id='tenant-branding')
  and (select public and file_size_limit=2097152
       from storage.buckets where id='tenant-public-branding')
  and (select not public and file_size_limit=1048576
       from storage.buckets where id='tenant-legal-assets')
  and (select allowed_mime_types <@ array['image/png','image/jpeg','image/webp']::text[]
       from storage.buckets where id='tenant-legal-assets'),
  'separacao entre branding publico e assinatura privada nao foi aplicada'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname='storage'
      and tablename='objects'
      and policyname='tenant_branding_public_read'
  )
  and exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname='storage'
      and tablename='objects'
      and policyname='tenant_branding_admin_read'
      and roles::text='{authenticated}'
      and position('_my_tenant_id' in coalesce(qual, '')) > 0
      and position('_my_tenant_is_operational' in coalesce(qual, '')) > 0
  )
  and (
    select count(*) = 2
    from pg_catalog.pg_policies
    where schemaname='storage'
      and tablename='objects'
      and policyname in (
        'tenant_branding_admin_read',
        'tenant_branding_admin_delete'
      )
      and position(
        '_my_tenant_is_operational' in
        coalesce(qual, '') || coalesce(with_check, '')
      ) > 0
  )
  and (
    select count(*) = 4
    from pg_catalog.pg_policies
    where schemaname='storage'
      and tablename='objects'
      and policyname in (
        'tenant_public_branding_admin_read',
        'tenant_public_branding_admin_insert',
        'tenant_public_branding_admin_update',
        'tenant_public_branding_admin_delete'
      )
      and position(
        '_my_tenant_is_operational' in
        coalesce(qual, '') || coalesce(with_check, '')
      ) > 0
  )
  and (
    select count(*) = 4
    from pg_catalog.pg_policies
    where schemaname='storage'
      and tablename='objects'
      and policyname in (
        'tenant_legal_assets_admin_read',
        'tenant_legal_assets_admin_insert',
        'tenant_legal_assets_admin_update',
        'tenant_legal_assets_admin_delete'
      )
      and position(
        '_my_tenant_is_operational' in
        coalesce(qual, '') || coalesce(with_check, '')
      ) > 0
  ),
  'buckets permitem enumeracao publica ou gestao sem escopo de tenant'
);

update public.tenants
set saas_status = 'blocked'
where id = 'settings-school-b';

select pg_temp.assert_true(
  not private.tenant_is_operational('settings-school-b')
  and not exists (
    select 1
    from public.resolve_public_tenant(
      'settings-school-b.wisewolflanguage.com.br'
    )
  ),
  'tenant bloqueado continuou operacional ou publico'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000a82","role":"authenticated"}';
select pg_temp.assert_true(
  not public._my_tenant_is_operational(),
  'helper RLS considerou tenant bloqueado operacional'
);
reset role;

do $$
begin
  perform public.apply_tenant_admin_settings(
    'settings-school-b',
    '00000000-0000-4000-8000-000000000a82',
    1,
    '{}'::jsonb
  );
  raise exception 'assertion failed: tenant bloqueado alterou settings';
exception when sqlstate '55000' then null;
end;
$$;

do $$
begin
  perform public.delete_tenant_integration_secret(
    'settings-school-b',
    'asaas',
    '00000000-0000-4000-8000-000000000a82'
  );
  raise exception 'assertion failed: tenant bloqueado removeu segredo';
exception when sqlstate '55000' then null;
end;
$$;

do $$
begin
  perform public.upsert_tenant_integration_secret(
    'settings-school-b',
    'asaas',
    'blocked-test-secret',
    'sandbox',
    '00000000-0000-4000-8000-000000000a82',
    'Blocked account'
  );
  raise exception 'assertion failed: tenant bloqueado gravou segredo';
exception when sqlstate '55000' then null;
end;
$$;

do $$
begin
  perform public.verify_tenant_custom_domain_server(
    'settings-school-b',
    '00000000-0000-4000-8000-000000000a82',
    'wwv-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  raise exception 'assertion failed: tenant bloqueado verificou dominio';
exception when sqlstate '55000' then null;
end;
$$;

do $$
begin
  perform public.request_tenant_custom_domain_server(
    'settings-school-b',
    '00000000-0000-4000-8000-000000000a82',
    'blocked.example.invalid',
    'wwv-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  raise exception 'assertion failed: tenant bloqueado reservou dominio';
exception when sqlstate '55000' then null;
end;
$$;

update public.tenant_memberships
set status = 'SUSPENDED', updated_at = now()
where user_id = '00000000-0000-4000-8000-000000000a82'
  and tenant_id = 'settings-school-b';

select pg_temp.assert_true(
  private.active_tenant_id('00000000-0000-4000-8000-000000000a82') is null
  and private.active_tenant_role('00000000-0000-4000-8000-000000000a82') is null,
  'perfil legado manteve autoridade depois da suspensao da membership'
);

update public.tenant_memberships
set status = 'ACTIVE', updated_at = now()
where user_id = '00000000-0000-4000-8000-000000000a82'
  and tenant_id = 'settings-school-b';
update public.profiles
set lifecycle_status = 'suspended'
where id = '00000000-0000-4000-8000-000000000a82';

select pg_temp.assert_true(
  private.active_tenant_id('00000000-0000-4000-8000-000000000a82') is null
  and private.active_tenant_role('00000000-0000-4000-8000-000000000a82') is null,
  'perfil suspenso manteve autoridade com membership ainda ativa'
);

rollback;
