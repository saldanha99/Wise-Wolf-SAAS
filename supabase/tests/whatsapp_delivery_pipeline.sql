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

-- Contrato estrutural e fronteira de privilegios.
select pg_temp.assert_true(
  to_regprocedure(
    'public.claim_notification_delivery_batch(integer,integer)'
  ) is not null
  and to_regprocedure(
    'public.mark_notification_delivery_submitting(uuid,uuid,text)'
  ) is not null
  and to_regprocedure(
    'public.finalize_notification_delivery(uuid,uuid,text,text,integer,text,integer)'
  ) is not null
  and to_regprocedure(
    'public.reconcile_whatsapp_provider_delivery(text,text,text,text,timestamptz)'
  ) is not null
  and to_regprocedure(
    'public.set_whatsapp_webhook_auth_version(text,text,smallint,uuid,bigint)'
  ) is not null
  and to_regprocedure(
    'public.set_whatsapp_webhook_auth_version(text,text,smallint)'
  ) is null
  and to_regprocedure(
    'public.begin_payment_confirmation_delivery_submission(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint)'
  ) is not null
  and to_regprocedure(
    'public.finalize_payment_confirmation_delivery(uuid,uuid,uuid,uuid,text,text,integer,text)'
  ) is not null
  and to_regprocedure('public.trigger_process_queue()') is not null
  and to_regprocedure(
    'private.trigger_reconcile_whatsapp_webhooks()'
  ) is not null,
  'RPCs canonicas de entrega WhatsApp estao ausentes'
);

select pg_temp.assert_true(
  has_function_privilege(
    'service_role',
    'public.claim_notification_delivery_batch(integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.mark_notification_delivery_submitting(uuid,uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finalize_notification_delivery(uuid,uuid,text,text,integer,text,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.reconcile_whatsapp_provider_delivery(text,text,text,text,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.set_whatsapp_webhook_auth_version(text,text,smallint,uuid,bigint)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.begin_payment_confirmation_delivery_submission(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finalize_payment_confirmation_delivery(uuid,uuid,uuid,uuid,text,text,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_notification_delivery_batch(integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.finalize_notification_delivery(uuid,uuid,text,text,integer,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.reconcile_whatsapp_provider_delivery(text,text,text,text,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.mark_notification_delivery_submitting(uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.set_whatsapp_webhook_auth_version(text,text,smallint,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.set_whatsapp_webhook_auth_version(text,text,smallint,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.begin_payment_confirmation_delivery_submission(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.finalize_payment_confirmation_delivery(uuid,uuid,uuid,uuid,text,text,integer,text)',
    'EXECUTE'
  ),
  'RPCs de entrega WhatsApp nao ficaram estritamente service-only'
);

select pg_temp.assert_true(
  to_regclass('private.whatsapp_provider_delivery_receipts') is not null
  and not has_table_privilege(
    'service_role',
    'private.whatsapp_provider_delivery_receipts',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'private.whatsapp_provider_delivery_receipts',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'private.whatsapp_provider_delivery_receipts',
    'SELECT'
  ),
  'ledger privado de recibos foi exposto diretamente'
);

select pg_temp.assert_true(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'whatsapp_instances'
      and column_name = 'webhook_auth_version'
      and data_type = 'smallint'
      and is_nullable = 'NO'
      and column_default = '1'
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.whatsapp_instances'::regclass
      and conname = 'whatsapp_instances_webhook_auth_version_check'
      and (
        pg_get_constraintdef(oid) ilike '%IN (1, 2, 3)%'
        or pg_get_constraintdef(oid) ilike '%ARRAY[1, 2, 3]%'
      )
  )
  and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'whatsapp_instances'
      and column_name = 'integration_id'
      and data_type = 'uuid'
      and is_nullable = 'NO'
  )
  and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'whatsapp_instances'
      and column_name = 'integration_version'
      and data_type = 'bigint'
      and is_nullable = 'NO'
  ),
  'auth/binding versionado da instancia nao esta protegido pelo schema'
);

select pg_temp.assert_true(
  (
    select procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
      and pg_get_userbyid(procedure.proowner) = 'postgres'
    from pg_catalog.pg_proc as procedure
    where procedure.oid = to_regprocedure(
      'public.set_whatsapp_webhook_auth_version(text,text,smallint,uuid,bigint)'
    )
  )
  and pg_get_function_arguments(
    'public.set_whatsapp_webhook_auth_version(text,text,smallint,uuid,bigint)'::regprocedure
  ) = 'p_tenant_id text, p_instance_name text, p_version smallint, p_integration_id uuid, p_integration_version bigint',
  'marker de auth webhook divergiu em owner/definer/search_path/assinatura'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from unnest(array[
      'idempotency_key', 'next_attempt_at', 'claim_token',
      'lease_expires_at', 'provider_instance_name', 'provider_integration_id',
      'provider_integration_version', 'provider_message_id',
      'provider_http_status', 'delivery_status', 'accepted_at', 'sent_at',
      'delivered_at', 'read_at', 'dead_letter_at', 'max_attempts'
    ]) as required(column_name)
    where not exists (
      select 1
      from information_schema.columns as definition
      where definition.table_schema = 'public'
        and definition.table_name = 'notification_queue'
        and definition.column_name = required.column_name
    )
  ),
  'colunas duraveis da fila de notificacao estao incompletas'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from unnest(array[
      'notification_queue_id', 'provider_instance_name',
      'provider_message_id', 'provider_delivery_status'
    ]) as required(column_name)
    where not exists (
      select 1
      from information_schema.columns as definition
      where definition.table_schema = 'public'
        and definition.table_name = 'asaas_outbound_message_attempts'
        and definition.column_name = required.column_name
    )
  )
  and exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'asaas_outbound_message_attempts_student_active_idx'
  ),
  'binding/indice do ledger financeiro esta incompleto'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from (
      values
        ('public.begin_payment_confirmation_delivery_submission(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint)'),
        ('public.finalize_payment_confirmation_delivery(uuid,uuid,uuid,uuid,text,text,integer,text)')
    ) as expected(signature)
    join pg_catalog.pg_proc as procedure
      on procedure.oid = to_regprocedure(expected.signature)
    where procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
      and pg_get_userbyid(procedure.proowner) = 'postgres'
  )
  and pg_get_function_arguments(
    'public.begin_payment_confirmation_delivery_submission(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint)'::regprocedure
  ) = 'p_notification_id uuid, p_notification_claim_token uuid, p_outbound_attempt_id uuid, p_outbound_claim_token uuid, p_provider_instance_name text, p_expected_destination text, p_provider_destination text, p_integration_id uuid, p_integration_version bigint'
  and pg_get_function_arguments(
    'public.finalize_payment_confirmation_delivery(uuid,uuid,uuid,uuid,text,text,integer,text)'::regprocedure
  ) = 'p_notification_id uuid, p_notification_claim_token uuid, p_outbound_attempt_id uuid, p_outbound_claim_token uuid, p_outcome text, p_provider_message_id text, p_provider_http_status integer, p_error text',
  'RPCs financeiras divergiram em owner/definer/search_path/assinatura'
);

select pg_temp.assert_true(
  pg_get_functiondef(
    'public.claim_notification_delivery_batch(integer,integer)'::regprocedure
  ) ilike '%FOR UPDATE SKIP LOCKED%'
  and pg_get_functiondef(
    'public.claim_notification_delivery_batch(integer,integer)'::regprocedure
  ) ilike '%delivery_status = ''submitting''%'
  and pg_get_functiondef(
    'public.finalize_notification_delivery(uuid,uuid,text,text,integer,text,integer)'::regprocedure
  ) ilike '%v_retry_delay > 0%'
  and pg_get_functiondef(
    'public.finalize_notification_delivery(uuid,uuid,text,text,integer,text,integer)'::regprocedure
  ) not ilike '%''retry''%'
  and pg_get_function_arguments(
    'public.mark_notification_delivery_submitting(uuid,uuid,text)'::regprocedure
  ) = 'p_notification_id uuid, p_claim_token uuid, p_provider_instance_name text',
  'contrato de claim/retry ou nomes dos argumentos RPC divergiu do worker'
);

select pg_temp.assert_true(
  private.merge_notification_delivery_status('accepted', 'failed') = 'failed'
  and private.merge_notification_delivery_status('delivered', 'failed') =
    'delivered'
  and private.merge_notification_delivery_status('failed', 'accepted') =
    'failed'
  and private.merge_notification_delivery_status('failed', 'sent') = 'sent',
  'precedencia accepted/failed permite falso positivo ou regressao de entrega'
);

-- Wrappers HTTP e jobs sao inspecionados sem executar net.http_post.
select pg_temp.assert_true(
  exists (
    select 1 from pg_catalog.pg_extension where extname = 'pg_cron'
  )
  and exists (
    select 1 from pg_catalog.pg_extension where extname = 'pg_net'
  )
  and to_regclass('vault.decrypted_secrets') is not null
  and (
    select count(*) = 1
      and count(*) filter (
        where nullif(btrim(secret.decrypted_secret), '') is not null
      ) = 1
    from vault.decrypted_secrets as secret
    where secret.name = 'wisewolf_service_role_key'
  ),
  'precondicoes pg_cron/pg_net/Vault nao estao satisfeitas'
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from (
      values
        ('public.trigger_process_queue()'),
        ('private.trigger_reconcile_whatsapp_webhooks()')
    ) as expected(signature)
    join pg_catalog.pg_proc as procedure
      on procedure.oid = to_regprocedure(expected.signature)
    where procedure.prosecdef
      and procedure.prorettype = 'bigint'::regtype
      and procedure.proconfig @> array['search_path=""']::text[]
      and pg_get_userbyid(procedure.proowner) = 'postgres'
  )
  and has_function_privilege(
    'service_role', 'public.trigger_process_queue()', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'private.trigger_reconcile_whatsapp_webhooks()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.trigger_process_queue()', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.trigger_process_queue()', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.trigger_reconcile_whatsapp_webhooks()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'private.trigger_reconcile_whatsapp_webhooks()',
    'EXECUTE'
  ),
  'wrappers HTTP nao ficaram bigint/definer/service-only/search_path vazio'
);

select pg_temp.assert_true(
  pg_get_functiondef(
    'public.trigger_process_queue()'::regprocedure
  ) ilike '%vault.decrypted_secrets%'
  and pg_get_functiondef(
    'public.trigger_process_queue()'::regprocedure
  ) ilike '%http://kong:8000/functions/v1/process-notification-queue%'
  and pg_get_functiondef(
    'public.trigger_process_queue()'::regprocedure
  ) ilike '%Authorization%'
  and pg_get_functiondef(
    'public.trigger_process_queue()'::regprocedure
  ) ilike '%apikey%'
  and pg_get_functiondef(
    'public.trigger_process_queue()'::regprocedure
  ) ilike '%timeout_milliseconds := 30000%'
  and pg_get_functiondef(
    'private.trigger_reconcile_whatsapp_webhooks()'::regprocedure
  ) ilike '%vault.decrypted_secrets%'
  and pg_get_functiondef(
    'private.trigger_reconcile_whatsapp_webhooks()'::regprocedure
  ) ilike '%http://kong:8000/functions/v1/reconcile-whatsapp-webhooks%'
  and pg_get_functiondef(
    'private.trigger_reconcile_whatsapp_webhooks()'::regprocedure
  ) ilike '%jsonb_build_object(''limit'', 100)%'
  and pg_get_functiondef(
    'private.trigger_reconcile_whatsapp_webhooks()'::regprocedure
  ) ilike '%timeout_milliseconds := 120000%',
  'wrappers divergem de URL, autenticacao, payload ou timeout esperados'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from (
      values
        (
          'wisewolf-process-queue',
          '* * * * *',
          'select public.trigger_process_queue();'
        ),
        (
          'wisewolf-reconcile-whatsapp-webhooks',
          '*/15 * * * *',
          'select private.trigger_reconcile_whatsapp_webhooks();'
        )
    ) as expected(jobname, schedule, command)
    left join lateral (
      select
        count(*) as total_count,
        count(*) filter (
          where job.active
            and job.schedule = expected.schedule
            and job.command = expected.command
        ) as exact_count
      from cron.job as job
      where job.jobname = expected.jobname
    ) as actual on true
    where actual.total_count <> 1
      or actual.exact_count <> 1
  ),
  'jobs WhatsApp nao ficaram unicos, ativos e com schedule/command exatos'
);

-- Fixtures isoladas por tenant. O trigger de whatsapp_instances exige um
-- membership ativo e um contexto canonico para cada proprietario.
set local request.jwt.claims = '{"role":"service_role"}';

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values
  (
    'whatsapp-delivery-test-a',
    'WhatsApp Delivery Test A',
    'whatsapp-delivery-test-a',
    'active',
    true
  ),
  (
    'whatsapp-delivery-test-b',
    'WhatsApp Delivery Test B',
    'whatsapp-delivery-test-b',
    'active',
    true
  );

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000ec01',
    'authenticated', 'authenticated', 'wa-delivery-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Admin Delivery A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000ed01',
    'authenticated', 'authenticated', 'wa-delivery-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Admin Delivery B"}', now(), now()
  );

update public.profiles
set tenant_id = 'whatsapp-delivery-test-a',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Admin Delivery A',
    phone = '5511999990301'
where id = '00000000-0000-4000-8000-00000000ec01';

update public.profiles
set tenant_id = 'whatsapp-delivery-test-b',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Admin Delivery B',
    phone = '5511999990302'
where id = '00000000-0000-4000-8000-00000000ed01';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values
  (
    '00000000-0000-4000-8000-00000000ec01',
    'whatsapp-delivery-test-a', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000ed01',
    'whatsapp-delivery-test-b', 'SCHOOL_ADMIN', 'ACTIVE', true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values
  (
    '00000000-0000-4000-8000-00000000ec01',
    'whatsapp-delivery-test-a'
  ),
  (
    '00000000-0000-4000-8000-00000000ed01',
    'whatsapp-delivery-test-b'
  )
on conflict (user_id) do update
set tenant_id = excluded.tenant_id,
    updated_at = now();

insert into public.whatsapp_instances (
  user_id, tenant_id, instance_name, instance_id, status
)
values
  (
    '00000000-0000-4000-8000-00000000ec01',
    'whatsapp-delivery-test-a',
    'wa-delivery-instance-a', 'wa-delivery-provider-a', 'connected'
  ),
  (
    '00000000-0000-4000-8000-00000000ed01',
    'whatsapp-delivery-test-b',
    'wa-delivery-instance-b', 'wa-delivery-provider-b', 'connected'
  );

select pg_temp.assert_true(
  (
    select bool_and(webhook_auth_version = 1)
    from public.whatsapp_instances
    where tenant_id in (
      'whatsapp-delivery-test-a', 'whatsapp-delivery-test-b'
    )
  )
  and not exists (
    select 1
    from public.whatsapp_instances as instance
    left join private.tenant_integration_connections as connection
      on connection.id = instance.integration_id
     and connection.tenant_id = instance.tenant_id
     and connection.provider = 'evolution'
     and connection.version = instance.integration_version
    where instance.tenant_id in (
      'whatsapp-delivery-test-a', 'whatsapp-delivery-test-b'
    )
      and connection.id is null
  ),
  'instancias novas nao iniciaram no auth v1/binding Evolution atual'
);

select pg_catalog.set_config(
  'wisewolf_test.webhook_integration_id',
  instance.integration_id::text,
  true
), pg_catalog.set_config(
  'wisewolf_test.webhook_integration_version',
  instance.integration_version::text,
  true
)
from public.whatsapp_instances as instance
where instance.tenant_id = 'whatsapp-delivery-test-a'
  and instance.instance_name = 'wa-delivery-instance-a';

set local role service_role;
select pg_temp.assert_true(
  (
    public.set_whatsapp_webhook_auth_version(
      'whatsapp-delivery-test-a',
      'wa-delivery-instance-a',
      2::smallint,
      pg_catalog.current_setting(
        'wisewolf_test.webhook_integration_id'
      )::uuid,
      pg_catalog.current_setting(
        'wisewolf_test.webhook_integration_version'
      )::bigint
    ) ->> 'webhookAuthVersion'
  ) = '2',
  'service_role nao conseguiu promover a instancia para webhook auth v2'
);
reset role;

select pg_temp.assert_true(
  (
    select webhook_auth_version = 2
    from public.whatsapp_instances
    where tenant_id = 'whatsapp-delivery-test-a'
      and instance_name = 'wa-delivery-instance-a'
  )
  and (
    select webhook_auth_version = 1
    from public.whatsapp_instances
    where tenant_id = 'whatsapp-delivery-test-b'
      and instance_name = 'wa-delivery-instance-b'
  ),
  'promocao v2 atravessou o escopo da instancia'
);

set local role service_role;
do $$
declare
  v_integration_id uuid := pg_catalog.current_setting(
    'wisewolf_test.webhook_integration_id'
  )::uuid;
  v_integration_version bigint := pg_catalog.current_setting(
    'wisewolf_test.webhook_integration_version'
  )::bigint;
begin
  begin
    perform public.set_whatsapp_webhook_auth_version(
      'whatsapp-delivery-test-a',
      'wa-delivery-instance-a',
      3::smallint,
      v_integration_id,
      v_integration_version + 1
    );
    raise exception 'expected stale webhook integration binding';
  exception
    when sqlstate '55000' then null;
  end;
end;
$$;
reset role;

select pg_temp.assert_true(
  (
    select webhook_auth_version = 2
    from public.whatsapp_instances
    where tenant_id = 'whatsapp-delivery-test-a'
      and instance_name = 'wa-delivery-instance-a'
  ),
  'binding obsoleto promoveu indevidamente o marker de auth'
);

set local role service_role;
select pg_temp.assert_true(
  (
    public.set_whatsapp_webhook_auth_version(
      'whatsapp-delivery-test-a',
      'wa-delivery-instance-a',
      3::smallint,
      pg_catalog.current_setting(
        'wisewolf_test.webhook_integration_id'
      )::uuid,
      pg_catalog.current_setting(
        'wisewolf_test.webhook_integration_version'
      )::bigint
    ) ->> 'webhookAuthVersion'
  ) = '3',
  'rollout v2 para v3 falhou com o binding Evolution atual'
);
reset role;

select pg_temp.assert_true(
  (
    select webhook_auth_version = 3
    from public.whatsapp_instances
    where tenant_id = 'whatsapp-delivery-test-a'
      and instance_name = 'wa-delivery-instance-a'
  )
  and (
    select webhook_auth_version = 1
    from public.whatsapp_instances
    where tenant_id = 'whatsapp-delivery-test-b'
      and instance_name = 'wa-delivery-instance-b'
  ),
  'rollout v2 para v3 atravessou o escopo da instancia'
);

set local role service_role;
do $$
declare
  v_integration_id uuid := pg_catalog.current_setting(
    'wisewolf_test.webhook_integration_id'
  )::uuid;
  v_integration_version bigint := pg_catalog.current_setting(
    'wisewolf_test.webhook_integration_version'
  )::bigint;
begin
  begin
    perform public.set_whatsapp_webhook_auth_version(
      'whatsapp-delivery-test-a',
      'wa-delivery-instance-a',
      4::smallint,
      v_integration_id,
      v_integration_version
    );
    raise exception 'expected invalid webhook auth version';
  exception
    when sqlstate '22023' then null;
  end;
end;
$$;
reset role;

-- Bridge atomica da confirmacao financeira: a fila e o ledger submit-once
-- cruzam o limite do provedor e terminalizam sempre na mesma transacao.
insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000ec11',
  'authenticated', 'authenticated', 'wa-delivery-student@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Student Delivery"}', now(), now()
);

update public.profiles
set tenant_id = 'whatsapp-delivery-test-a',
    role = 'STUDENT',
    lifecycle_status = 'active',
    is_test_account = false,
    full_name = 'Student Delivery',
    phone = '5511988881234',
    guardian_id = null,
    guardian_cpf = null,
    guardian_phone = null
where id = '00000000-0000-4000-8000-00000000ec11';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '00000000-0000-4000-8000-00000000ec11',
  'whatsapp-delivery-test-a', 'STUDENT', 'ACTIVE', true
)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

update public.tenant_admin_settings
set student_notifications_enabled = true,
    updated_at = now()
where tenant_id = 'whatsapp-delivery-test-a';

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, status, due_date
) values
  (
    '00000000-0000-4000-8000-00000000fa01',
    '00000000-0000-4000-8000-00000000ec11',
    'whatsapp-delivery-test-a', 'pay-wa-delivery-success',
    'cus-wa-delivery', 100, 'RECEIVED', current_date
  ),
  (
    '00000000-0000-4000-8000-00000000fa02',
    '00000000-0000-4000-8000-00000000ec11',
    'whatsapp-delivery-test-a', 'pay-wa-delivery-stale',
    'cus-wa-delivery', 100, 'RECEIVED', current_date
  ),
  (
    '00000000-0000-4000-8000-00000000fa03',
    '00000000-0000-4000-8000-00000000ec11',
    'whatsapp-delivery-test-a', 'pay-wa-delivery-exhausted',
    'cus-wa-delivery', 100, 'RECEIVED', current_date
  ),
  (
    '00000000-0000-4000-8000-00000000fa04',
    '00000000-0000-4000-8000-00000000ec11',
    'whatsapp-delivery-test-a', 'pay-wa-delivery-suppressed',
    'cus-wa-delivery', 100, 'RECEIVED', current_date
  );

insert into public.notification_queue (
  id, tenant_id, student_id, student_phone, message_body,
  notification_kind, source_type, source_id, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000fb01',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '5511988881234', 'payment confirmation bridge',
  'PAYMENT_CONFIRMED', 'ASAAS_PAYMENT',
  '00000000-0000-4000-8000-00000000fa01',
  timestamptz '2000-01-01 00:00:00+00', 'pending', 0,
  timestamptz '2000-01-01 00:00:00+00', 'queued', 5,
  'payment-confirmation-bridge'
);

insert into public.asaas_outbound_message_attempts (
  id, tenant_id, student_id, provider_entity_id, notification_kind,
  status, claim_token, lease_expires_at, submit_attempt_count
) values (
  '00000000-0000-4000-8000-00000000fc01',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '00000000-0000-4000-8000-00000000fa01',
  'PAYMENT_CONFIRMED_WHATSAPP', 'CLAIMED',
  '00000000-0000-4000-8000-00000000fd01',
  now() + interval '5 minutes', 0
);

do $payment_confirmation_bridge$
declare
  v_claim public.notification_queue%rowtype;
  v_result jsonb;
  v_integration_id uuid;
  v_integration_version bigint;
  v_wrong_token uuid := '00000000-0000-4000-8000-00000000ffff';
begin
  select candidate.*
  into v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000fb01';

  select instance.integration_id, instance.integration_version
  into v_integration_id, v_integration_version
  from public.whatsapp_instances as instance
  where instance.tenant_id = 'whatsapp-delivery-test-a'
    and instance.instance_name = 'wa-delivery-instance-a';

  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_wrong_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'claim_lost'
      and (
        select delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
      )
      and (
        select status = 'CLAIMED'
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'token incorreto alterou metade do bridge financeiro'
  );

  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01', v_wrong_token,
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'claim_lost'
      and (
        select delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
      )
      and (
        select status = 'CLAIMED'
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'token financeiro incorreto alterou metade do bridge'
  );

  update public.notification_queue
  set lease_expires_at = now() - interval '1 second'
  where id = v_claim.id;
  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'claim_lost'
      and (
        select status = 'CLAIMED'
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'lease da fila vencido alterou o ledger financeiro'
  );
  update public.notification_queue
  set lease_expires_at = now() + interval '5 minutes'
  where id = v_claim.id;

  update public.asaas_outbound_message_attempts
  set lease_expires_at = now() - interval '1 second'
  where id = '00000000-0000-4000-8000-00000000fc01';
  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'claim_lost'
      and (
        select delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
      ),
    'lease financeiro vencido cruzou o limite do provedor'
  );
  update public.asaas_outbound_message_attempts
  set lease_expires_at = now() + interval '5 minutes'
  where id = '00000000-0000-4000-8000-00000000fc01';

  update public.notification_queue
  set source_type = 'OTHER_SOURCE'
  where id = v_claim.id;
  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'payment_confirmation_binding_mismatch'
      and (
        select status = 'CLAIMED'
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'source_type nao canonico foi aceito pelo bridge'
  );
  update public.notification_queue
  set source_type = 'ASAAS_PAYMENT'
  where id = v_claim.id;

  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    '00000000-0000-4000-8000-00000000ff01',
    v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' =
        'payment_confirmation_provider_binding_changed',
    'binding BYOK divergente foi aceito'
  );

  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMITTING'
      and (
        select delivery_status = 'submitting'
          and provider_integration_id = v_integration_id
          and provider_integration_version = v_integration_version
        from public.notification_queue where id = v_claim.id
      )
      and (
        select status = 'SUBMITTING'
          and notification_queue_id = v_claim.id
          and provider_instance_name = 'wa-delivery-instance-a'
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'bridge valido nao iniciou os dois ledgers atomicamente'
  );

  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', '5511988881234', '5511988881234',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMITTING'
      and (
        select submit_attempt_count = 1
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'replay idempotente do begin financeiro perdeu ou repetiu a submissao'
  );

  v_result := public.recover_notification_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'wa-delivery-instance-a', v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMITTING'
      and v_result ->> 'providerDestination' = '5511988881234'
      and v_result ->> 'messageBody' = 'payment confirmation bridge',
    'recovery nao recuperou o snapshot financeiro pareado'
  );

  v_result := public.finalize_payment_confirmation_delivery(
    v_claim.id, v_wrong_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'accepted', 'wa-payment-message-1', 200, null
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'claim_lost'
      and (
        select delivery_status = 'submitting'
        from public.notification_queue where id = v_claim.id
      )
      and (
        select status = 'SUBMITTING'
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'token final incorreto terminalizou apenas um ledger'
  );

  update public.asaas_outbound_message_attempts
  set provider_message_id = 'wa-payment-conflicting-id'
  where id = '00000000-0000-4000-8000-00000000fc01';
  v_result := public.finalize_payment_confirmation_delivery(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'accepted', 'wa-payment-message-1', 200, null
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'payment_confirmation_binding_mismatch'
      and (
        select delivery_status = 'submitting'
        from public.notification_queue where id = v_claim.id
      )
      and (
        select status = 'SUBMITTING'
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'conflito de provider_message_id terminalizou apenas um ledger'
  );
  update public.asaas_outbound_message_attempts
  set provider_message_id = null
  where id = '00000000-0000-4000-8000-00000000fc01';

  v_result := public.finalize_payment_confirmation_delivery(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc01',
    '00000000-0000-4000-8000-00000000fd01',
    'accepted', 'wa-payment-message-1', 200, null
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'deliveryStatus' = 'accepted'
      and v_result ->> 'financialStatus' = 'SENT'
      and (
        select status = 'sent' and delivery_status = 'accepted'
        from public.notification_queue where id = v_claim.id
      )
      and (
        select status = 'SENT'
          and provider_delivery_status = 'accepted'
          and provider_message_id = 'wa-payment-message-1'
          and provider_http_status = 200
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc01'
      ),
    'finalizacao aceita nao terminalizou fila+ledger juntos'
  );
end;
$payment_confirmation_bridge$;

select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a', 'wa-delivery-instance-a',
  'wa-payment-message-1', 'failed', now() + interval '1 minute'
);
select pg_temp.assert_true(
  (
    select status = 'failed' and delivery_status = 'failed'
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000fb01'
  )
  and (
    select status = 'FAILED' and provider_delivery_status = 'failed'
    from public.asaas_outbound_message_attempts
    where id = '00000000-0000-4000-8000-00000000fc01'
  ),
  'FAILED tardio nao corrigiu o mero aceite nos dois ledgers'
);

select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a', 'wa-delivery-instance-a',
  'wa-payment-message-1', 'delivered', now() + interval '2 minutes'
);
select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a', 'wa-delivery-instance-a',
  'wa-payment-message-1', 'failed', now() + interval '3 minutes'
);
select pg_temp.assert_true(
  (
    select status = 'sent' and delivery_status = 'delivered'
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000fb01'
  )
  and (
    select status = 'SENT' and provider_delivery_status = 'delivered'
    from public.asaas_outbound_message_attempts
    where id = '00000000-0000-4000-8000-00000000fc01'
  ),
  'FAILED tardio regrediu uma entrega comprovada'
);

insert into public.notification_queue (
  id, tenant_id, student_id, student_phone, message_body,
  notification_kind, source_type, source_id, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000fb04',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '5511988881234', 'destination suppression bridge',
  'PAYMENT_CONFIRMED', 'ASAAS_PAYMENT',
  '00000000-0000-4000-8000-00000000fa04',
  timestamptz '2000-01-01 00:00:00+00', 'pending', 0,
  timestamptz '2000-01-01 00:00:00+00', 'queued', 5,
  'payment-confirmation-destination-suppression'
);
insert into public.asaas_outbound_message_attempts (
  id, tenant_id, student_id, provider_entity_id, notification_kind,
  status, claim_token, lease_expires_at, submit_attempt_count
) values (
  '00000000-0000-4000-8000-00000000fc04',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '00000000-0000-4000-8000-00000000fa04',
  'PAYMENT_CONFIRMED_WHATSAPP', 'CLAIMED',
  '00000000-0000-4000-8000-00000000fd04',
  now() + interval '5 minutes', 0
);
do $payment_destination_suppression$
declare
  v_claim public.notification_queue%rowtype;
  v_result jsonb;
  v_integration_id uuid;
  v_integration_version bigint;
begin
  select candidate.* into v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000fb04';

  select integration_id, integration_version
  into v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'whatsapp-delivery-test-a'
    and instance_name = 'wa-delivery-instance-a';

  v_result := public.begin_payment_confirmation_delivery_submission(
    v_claim.id, v_claim.claim_token,
    '00000000-0000-4000-8000-00000000fc04',
    '00000000-0000-4000-8000-00000000fd04',
    'wa-delivery-instance-a', '5511977770000', '5511977770000',
    v_integration_id, v_integration_version
  );

  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'SUPPRESSED'
      and v_result ->> 'reason' =
        'payment_confirmation_destination_changed'
      and (
        select status = 'skipped' and delivery_status = 'skipped'
        from public.notification_queue where id = v_claim.id
      )
      and (
        select status = 'SUPPRESSED' and submit_attempt_count = 0
        from public.asaas_outbound_message_attempts
        where id = '00000000-0000-4000-8000-00000000fc04'
      ),
    'mudanca de destino nao suprimiu fila+ledger atomicamente'
  );
end;
$payment_destination_suppression$;

-- Crash total depois do begin, antes da finalize: a mesma varredura torna a
-- fila UNCERTAIN e o ledger UNKNOWN, sem deixar o lifecycle bloqueado.
insert into public.notification_queue (
  id, tenant_id, student_id, student_phone, message_body,
  notification_kind, source_type, source_id, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key,
  claim_token, lease_expires_at, provider_instance_name,
  provider_destination, provider_integration_id, provider_integration_version
)
select
  '00000000-0000-4000-8000-00000000fb02',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '5511988881234', 'stale paired payment confirmation',
  'PAYMENT_CONFIRMED', 'ASAAS_PAYMENT',
  '00000000-0000-4000-8000-00000000fa02',
  timestamptz '2000-01-01 00:00:00+00', 'processing', 1,
  timestamptz '2000-01-01 00:00:00+00', 'submitting', 5,
  'payment-confirmation-stale',
  '00000000-0000-4000-8000-00000000fe02',
  now() - interval '1 second', 'wa-delivery-instance-a',
  '5511988881234',
  instance.integration_id, instance.integration_version
from public.whatsapp_instances as instance
where instance.tenant_id = 'whatsapp-delivery-test-a'
  and instance.instance_name = 'wa-delivery-instance-a';

insert into public.asaas_outbound_message_attempts (
  id, tenant_id, student_id, provider_entity_id, notification_kind,
  status, claim_token, lease_expires_at, submit_attempt_count,
  notification_queue_id, provider_instance_name, provider_destination
) values (
  '00000000-0000-4000-8000-00000000fc02',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '00000000-0000-4000-8000-00000000fa02',
  'PAYMENT_CONFIRMED_WHATSAPP', 'SUBMITTING',
  '00000000-0000-4000-8000-00000000fd02',
  now() - interval '1 second', 1,
  '00000000-0000-4000-8000-00000000fb02',
  'wa-delivery-instance-a', '5511988881234'
);

select count(*) from public.claim_notification_delivery_batch(200, 30);
select pg_temp.assert_true(
  (
    select status = 'failed'
      and delivery_status = 'uncertain'
      and claim_token is null
      and lease_expires_at is null
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000fb02'
  )
  and (
    select status = 'UNKNOWN'
      and provider_delivery_status = 'uncertain'
      and submit_attempt_count = 1
    from public.asaas_outbound_message_attempts
    where id = '00000000-0000-4000-8000-00000000fc02'
  ),
  'sweep de crash deixou fila e ledger financeiro em estados diferentes'
);

insert into public.notification_queue (
  id, tenant_id, student_id, student_phone, message_body,
  notification_kind, source_type, source_id, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key,
  claim_token, lease_expires_at
) values (
  '00000000-0000-4000-8000-00000000fb03',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '5511988881234', 'exhausted pre-submit payment confirmation',
  'PAYMENT_CONFIRMED', 'ASAAS_PAYMENT',
  '00000000-0000-4000-8000-00000000fa03',
  timestamptz '2000-01-01 00:00:00+00', 'processing', 1,
  timestamptz '2000-01-01 00:00:00+00', 'preparing', 1,
  'payment-confirmation-exhausted',
  '00000000-0000-4000-8000-00000000fe03',
  now() - interval '1 second'
);

insert into public.asaas_outbound_message_attempts (
  id, tenant_id, student_id, provider_entity_id, notification_kind,
  status, claim_token, lease_expires_at, submit_attempt_count
) values (
  '00000000-0000-4000-8000-00000000fc03',
  'whatsapp-delivery-test-a',
  '00000000-0000-4000-8000-00000000ec11',
  '00000000-0000-4000-8000-00000000fa03',
  'PAYMENT_CONFIRMED_WHATSAPP', 'CLAIMED',
  '00000000-0000-4000-8000-00000000fd03',
  now() - interval '1 second', 0
);

select count(*) from public.claim_notification_delivery_batch(200, 30);
select pg_temp.assert_true(
  (
    select status = 'failed'
      and delivery_status = 'failed'
      and attempts = max_attempts
      and dead_letter_at is not null
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000fb03'
  )
  and (
    select status = 'SUPPRESSED'
      and submit_attempt_count = 0
      and notification_queue_id =
        '00000000-0000-4000-8000-00000000fb03'
    from public.asaas_outbound_message_attempts
    where id = '00000000-0000-4000-8000-00000000fc03'
  ),
  'max_attempts deixou um fence financeiro CLAIMED orfao'
);

-- Produtores antigos continuam inserindo sem idempotency_key nem os novos
-- campos de lease/recibo; defaults devem manter esse caminho valido.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, scheduled_for, status
) values (
  '00000000-0000-4000-8000-00000000ee00',
  'whatsapp-delivery-test-a',
  '5511999990399',
  'legacy producer compatibility',
  now() + interval '1 day',
  'pending'
);

select pg_temp.assert_true(
  (
    select next_attempt_at is not null
      and delivery_status = 'queued'
      and max_attempts = 5
      and idempotency_key is null
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000ee00'
  ),
  'defaults novos quebraram um produtor legado'
);

insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, scheduled_for, status,
  next_attempt_at, delivery_status, max_attempts, idempotency_key
)
values
  (
    '00000000-0000-4000-8000-00000000ee01',
    'whatsapp-delivery-test-a',
    '5511999990301', 'tenant idempotency A', now() + interval '1 day',
    'pending', now() + interval '1 day', 'queued', 5, 'same-logical-message'
  ),
  (
    '00000000-0000-4000-8000-00000000ee02',
    'whatsapp-delivery-test-b',
    '5511999990302', 'tenant idempotency B', now() + interval '1 day',
    'pending', now() + interval '1 day', 'queued', 5, 'same-logical-message'
  );

do $$
begin
  begin
    insert into public.notification_queue (
      tenant_id, student_phone, message_body, scheduled_for, status,
      next_attempt_at, delivery_status, max_attempts, idempotency_key
    ) values (
      'whatsapp-delivery-test-a',
      '5511999990303', 'duplicate tenant idempotency', now() + interval '1 day',
      'pending', now() + interval '1 day', 'queued', 5,
      'same-logical-message'
    );
    raise exception 'expected tenant idempotency violation';
  exception
    when unique_violation then null;
  end;
end;
$$;

-- Claim, token fence, accepted-vs-delivered e recibos monotonicos.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ef01',
  'whatsapp-delivery-test-a',
  '5511999990311', 'accepted fixture', timestamptz '2000-01-01 00:00:00+00',
  'pending', 0, timestamptz '2000-01-01 00:00:00+00', 'queued', 5,
  'accepted-fixture'
);

do $$
declare
  claimed public.notification_queue%rowtype;
  result jsonb;
  wrong_token uuid := '00000000-0000-4000-8000-00000000ffff';
  v_integration_id uuid;
  v_integration_version bigint;
begin
  select candidate.*
  into claimed
  from public.claim_notification_delivery_batch(200, 30) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ef01';

  perform pg_temp.assert_true(
    claimed.id is not null
    and claimed.status = 'processing'
    and claimed.delivery_status = 'preparing'
    and claimed.attempts = 1
    and claimed.claim_token is not null,
    'claim atomico nao preparou a notificacao esperada'
  );

  select instance.integration_id, instance.integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances as instance
  where instance.tenant_id = 'whatsapp-delivery-test-a'
    and instance.instance_name = 'wa-delivery-instance-a';

  result := public.begin_notification_delivery_submission(
    claimed.id,
    wrong_token,
    'wa-delivery-instance-a',
    '5511999990311',
    '5511999990311',
    'accepted fixture',
    v_integration_id,
    v_integration_version
  );
  perform pg_temp.assert_true(
    (result ->> 'ok')::boolean is false
    and result ->> 'reason' = 'notification_delivery_claim_lost',
    'token incorreto conseguiu iniciar a submissao'
  );

  result := public.finalize_notification_delivery(
    claimed.id,
    wrong_token,
    'accepted',
    'wa-delivery-message-a',
    200,
    null,
    null
  );
  perform pg_temp.assert_true(
    (result ->> 'ok')::boolean is false
    and result ->> 'reason' = 'notification_delivery_claim_lost',
    'token incorreto conseguiu finalizar a entrega'
  );

  result := public.begin_notification_delivery_submission(
    claimed.id,
    claimed.claim_token,
    'wa-delivery-instance-a',
    '5511999990311',
    '5511999990311',
    'accepted fixture',
    v_integration_id,
    v_integration_version
  );
  perform pg_temp.assert_true(
    (result ->> 'ok')::boolean is true
    and result ->> 'action' = 'SUBMIT_AUTHORIZED'
    and result ->> 'deliveryStatus' = 'submitting',
    'token valido nao iniciou a submissao'
  );

  result := public.finalize_notification_delivery(
    claimed.id,
    claimed.claim_token,
    'accepted',
    'wa-delivery-message-a',
    200,
    null,
    null
  );
  perform pg_temp.assert_true(
    (result ->> 'ok')::boolean is true
    and result ->> 'deliveryStatus' = 'accepted',
    'aceite do provedor nao foi persistido'
  );
end;
$$;

select pg_temp.assert_true(
  (
    select status = 'sent'
      and delivery_status = 'accepted'
      and provider_instance_name = 'wa-delivery-instance-a'
      and provider_message_id = 'wa-delivery-message-a'
      and provider_http_status = 200
      and accepted_at is not null
      and delivered_at is null
      and read_at is null
      and claim_token is null
      and lease_expires_at is null
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000ef01'
  ),
  'accepted foi confundido com delivered/read ou perdeu identidade do provedor'
);

select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a',
  'wa-delivery-instance-a',
  'wa-delivery-message-a',
  'failed',
  now() + interval '1 minute'
);

select pg_temp.assert_true(
  (
    select status = 'failed'
      and delivery_status = 'failed'
      and accepted_at is not null
      and delivered_at is null
      and dead_letter_at is not null
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000ef01'
  )
  and (
    select delivery_status = 'failed'
    from private.whatsapp_provider_delivery_receipts
    where tenant_id = 'whatsapp-delivery-test-a'
      and provider_instance_name = 'wa-delivery-instance-a'
      and provider_message_id = 'wa-delivery-message-a'
  ),
  'FAILED posterior nao encerrou um mero ACCEPTED'
);

select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a',
  'wa-delivery-instance-a',
  'wa-delivery-message-a',
  'delivered',
  now() + interval '2 minutes'
);
select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a',
  'wa-delivery-instance-a',
  'wa-delivery-message-a',
  'read',
  now() + interval '3 minutes'
);
select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a',
  'wa-delivery-instance-a',
  'wa-delivery-message-a',
  'sent',
  now() + interval '4 minutes'
);
select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-a',
  'wa-delivery-instance-a',
  'wa-delivery-message-a',
  'failed',
  now() + interval '5 minutes'
);

select pg_temp.assert_true(
  (
    select status = 'sent'
      and delivery_status = 'read'
      and accepted_at is not null
      and sent_at is not null
      and delivered_at is not null
      and read_at is not null
      and dead_letter_at is null
      and last_error is null
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000ef01'
  )
  and (
    select delivery_status = 'read'
      and notification_id = '00000000-0000-4000-8000-00000000ef01'
    from private.whatsapp_provider_delivery_receipts
    where tenant_id = 'whatsapp-delivery-test-a'
      and provider_instance_name = 'wa-delivery-instance-a'
      and provider_message_id = 'wa-delivery-message-a'
  ),
  'recibo tardio regrediu read ou falha tardia apagou entrega comprovada'
);

-- A mesma identidade do provedor pertence ao par tenant+instancia, nunca a
-- um namespace global compartilhado.
select public.reconcile_whatsapp_provider_delivery(
  'whatsapp-delivery-test-b',
  'wa-delivery-instance-b',
  'wa-delivery-message-a',
  'delivered',
  now()
);

select pg_temp.assert_true(
  (
    select count(*) = 2
    from private.whatsapp_provider_delivery_receipts
    where provider_message_id = 'wa-delivery-message-a'
  )
  and (
    select delivery_status = 'read'
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000ef01'
  ),
  'recibo de outro tenant colidiu com a entrega original'
);

do $$
begin
  begin
    perform public.reconcile_whatsapp_provider_delivery(
      'whatsapp-delivery-test-a',
      'wa-delivery-instance-b',
      'wa-delivery-message-cross-tenant',
      'delivered',
      now()
    );
    raise exception 'expected provider instance scope rejection';
  exception
    when sqlstate 'P0002' then null;
  end;
end;
$$;

-- Antes do POST: lease PREPARING vencido volta para fila, e falha explicita
-- com delay agenda retry. Depois de SUBMITTING: lease vencido e terminalmente
-- UNCERTAIN para impedir um segundo POST cego.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ef02',
  'whatsapp-delivery-test-a',
  '5511999990312', 'retry fixture', timestamptz '2000-01-01 00:00:00+00',
  'pending', 0, timestamptz '2000-01-01 00:00:00+00', 'queued', 4,
  'retry-fixture'
);

do $$
declare
  first_claim public.notification_queue%rowtype;
  second_claim public.notification_queue%rowtype;
  third_claim public.notification_queue%rowtype;
  result jsonb;
  v_integration_id uuid;
  v_integration_version bigint;
begin
  select candidate.* into first_claim
  from public.claim_notification_delivery_batch(200, 30) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ef02';

  update public.notification_queue
  set lease_expires_at = now() - interval '1 second'
  where id = first_claim.id;

  select candidate.* into second_claim
  from public.claim_notification_delivery_batch(200, 30) as candidate
  where candidate.id = first_claim.id;

  perform pg_temp.assert_true(
    second_claim.id = first_claim.id
    and second_claim.attempts = 2
    and second_claim.claim_token is distinct from first_claim.claim_token
    and second_claim.delivery_status = 'preparing',
    'lease PREPARING vencido nao foi recuperado com um claim novo'
  );

  result := public.finalize_notification_delivery(
    second_claim.id,
    second_claim.claim_token,
    'failed',
    null,
    null,
    'dependency_unavailable_before_post',
    60
  );
  perform pg_temp.assert_true(
    (result ->> 'ok')::boolean is true
    and result ->> 'action' = 'RETRY_SCHEDULED',
    'falha pre-POST nao agendou retry duravel'
  );

  update public.notification_queue
  set next_attempt_at = timestamptz '2000-01-01 00:00:00+00'
  where id = second_claim.id;

  select candidate.* into third_claim
  from public.claim_notification_delivery_batch(200, 30) as candidate
  where candidate.id = second_claim.id;

  perform pg_temp.assert_true(
    third_claim.attempts = 3
    and third_claim.delivery_status = 'preparing',
    'retry agendado nao voltou a ser elegivel'
  );

  select instance.integration_id, instance.integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances as instance
  where instance.tenant_id = 'whatsapp-delivery-test-a'
    and instance.instance_name = 'wa-delivery-instance-a';

  result := public.begin_notification_delivery_submission(
    third_claim.id,
    third_claim.claim_token,
    'wa-delivery-instance-a',
    '5511999990312',
    '5511999990312',
    'retry fixture',
    v_integration_id,
    v_integration_version
  );
  perform pg_temp.assert_true(
    (result ->> 'ok')::boolean is true
      and result ->> 'action' = 'SUBMIT_AUTHORIZED',
    'fixture pos-POST nao entrou em SUBMITTING'
  );

  update public.notification_queue
  set lease_expires_at = now() - interval '1 second'
  where id = third_claim.id;

  perform count(*)
  from public.claim_notification_delivery_batch(200, 30) as candidate;

  perform pg_temp.assert_true(
    (
      select status = 'failed'
        and delivery_status = 'uncertain'
        and dead_letter_at is not null
        and claim_token is null
        and lease_expires_at is null
      from public.notification_queue
      where id = third_claim.id
    ),
    'lease SUBMITTING vencido foi reenfileirado em vez de ficar UNCERTAIN'
  );
end;
$$;

-- Janela de cutover: worker legado pode gravar apenas PROCESSING/QUEUED sem
-- token. Depois do limite conservador esse estado e ambiguo, nunca retryable.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts,
  claim_token, lease_expires_at, updated_at, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ef04',
  'whatsapp-delivery-test-a',
  '5511999990314', 'legacy cutover fixture',
  timestamptz '2000-01-01 00:00:00+00',
  'processing', 1, timestamptz '2000-01-01 00:00:00+00', 'queued', 5,
  null, null, now() - interval '11 minutes', 'legacy-cutover-fixture'
);

select count(*)
from public.claim_notification_delivery_batch(200, 30);

select pg_temp.assert_true(
  (
    select status = 'failed'
      and delivery_status = 'uncertain'
      and attempts = 1
      and dead_letter_at is not null
      and last_error = 'legacy_worker_delivery_state_uncertain'
      and claim_token is null
      and lease_expires_at is null
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000ef04'
  ),
  'estado PROCESSING/QUEUED legado ficou preso ou foi reenfileirado'
);

-- A ultima tentativa nunca e reenfileirada, mesmo quando o chamador fornece
-- um delay de retry.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ef03',
  'whatsapp-delivery-test-a',
  '5511999990313', 'dead letter fixture',
  timestamptz '2000-01-01 00:00:00+00',
  'pending', 0, timestamptz '2000-01-01 00:00:00+00', 'queued', 1,
  'dead-letter-fixture'
);

do $$
declare
  claimed public.notification_queue%rowtype;
  result jsonb;
begin
  select candidate.* into claimed
  from public.claim_notification_delivery_batch(200, 30) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ef03';

  result := public.finalize_notification_delivery(
    claimed.id,
    claimed.claim_token,
    'failed',
    null,
    503,
    'retryable_provider_unavailable',
    60
  );

  perform pg_temp.assert_true(
    (result ->> 'ok')::boolean is true
    and result ->> 'action' = 'TERMINAL'
    and (
      select status = 'failed'
        and delivery_status = 'failed'
        and attempts = max_attempts
        and dead_letter_at is not null
        and claim_token is null
        and lease_expires_at is null
      from public.notification_queue
      where id = claimed.id
    ),
    'fila reenfileirou uma entrega que atingiu max_attempts'
  );
end;
$$;

rollback;
