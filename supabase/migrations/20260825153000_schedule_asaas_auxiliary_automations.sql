-- Schedule the auxiliary Asaas automations that were left outside the durable
-- inbox release. Cron catalog changes use only pg_cron APIs: Supabase no longer
-- permits direct writes to cron.job.

do $preconditions$
begin
  if not exists (
    select 1 from pg_extension where extname = 'pg_cron'
  ) then
    raise exception 'pg_cron_is_required_for_asaas_auxiliary_automations';
  end if;
  if not exists (
    select 1 from pg_extension where extname = 'pg_net'
  ) then
    raise exception 'pg_net_is_required_for_asaas_auxiliary_automations';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'supabase_vault_is_required_for_asaas_auxiliary_automations';
  end if;
  if to_regnamespace('private') is null then
    raise exception 'private_schema_is_required_for_asaas_auxiliary_automations';
  end if;
  if not exists (
    select 1 from pg_roles where rolname = 'service_role'
  ) then
    raise exception 'service_role_is_required_for_asaas_auxiliary_automations';
  end if;
  if (
    select count(*)
      from vault.decrypted_secrets as secret
     where secret.name = 'wisewolf_service_role_key'
       and nullif(pg_catalog.btrim(secret.decrypted_secret), '') is not null
  ) <> 1 then
    raise exception 'wisewolf_service_role_key_must_exist_exactly_once';
  end if;
  if to_regprocedure('public.trigger_sync_plan_change_billing()') is null
     or to_regprocedure('public.trigger_sync_subscription_status()') is null
     or to_regprocedure('public.trigger_payment_split_sweep()') is null
  then
    raise exception 'asaas_auxiliary_cron_dependency_is_missing';
  end if;
end;
$preconditions$;

-- The Edge handler accepts only POST and validates the exact service key via
-- authorizeRequest. Both accepted service headers are sent so this remains
-- compatible with the gateway and with direct Edge Runtime traffic.
create or replace function private.trigger_reconcile_ledger()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret
    into v_service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;

  if nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/reconcile-ledger',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := pg_catalog.jsonb_build_object('batchSize', 500),
    timeout_milliseconds := 120000
  ) into v_request_id;

  if v_request_id is null then
    raise exception 'reconcile_ledger_http_request_was_not_queued';
  end if;
  return v_request_id;
end;
$function$;

alter function private.trigger_reconcile_ledger() owner to postgres;
comment on function private.trigger_reconcile_ledger() is
  'Service-only Vault-authenticated POST that asks the Edge Runtime to reconcile the local payment ledger.';

-- All four cron entry points are SECURITY DEFINER. Empty search_path plus an
-- explicit allowlist prevents PUBLIC/anon/authenticated from turning Vault
-- access into an arbitrary internal HTTP primitive.
alter function public.trigger_sync_plan_change_billing()
  set search_path = '';
alter function public.trigger_sync_subscription_status()
  set search_path = '';
alter function public.trigger_payment_split_sweep()
  set search_path = '';

revoke all on function private.trigger_reconcile_ledger()
  from public, anon, authenticated, service_role;
revoke all on function public.trigger_sync_plan_change_billing()
  from public, anon, authenticated, service_role;
revoke all on function public.trigger_sync_subscription_status()
  from public, anon, authenticated, service_role;
revoke all on function public.trigger_payment_split_sweep()
  from public, anon, authenticated, service_role;

grant usage on schema private to service_role;
grant execute on function private.trigger_reconcile_ledger()
  to service_role;
grant execute on function public.trigger_sync_plan_change_billing()
  to service_role;
grant execute on function public.trigger_sync_subscription_status()
  to service_role;
grant execute on function public.trigger_payment_split_sweep()
  to service_role;

-- Unschedule by jobid so a historical duplicate cannot survive. All four
-- replacements are transactional: if any schedule fails, the previous set is
-- restored with the migration rollback.
do $schedule$
begin
  perform cron.unschedule(job.jobid)
    from cron.job as job
   where job.jobname in (
     'wisewolf-sync-plan-change-billing',
     'wisewolf-reconcile-ledger',
     'wisewolf-sync-subscriptions',
     'wisewolf-payment-split-sweep'
   );

  perform cron.schedule(
    'wisewolf-sync-plan-change-billing',
    '*/15 * * * *',
    'select public.trigger_sync_plan_change_billing();'
  );
  perform cron.schedule(
    'wisewolf-reconcile-ledger',
    -- Once per hour, staggered away from the minute-zero 15-minute sweeps.
    '7 * * * *',
    'select private.trigger_reconcile_ledger();'
  );
  perform cron.schedule(
    'wisewolf-sync-subscriptions',
    '40 6 * * *',
    'select public.trigger_sync_subscription_status();'
  );
  perform cron.schedule(
    'wisewolf-payment-split-sweep',
    '*/15 * * * *',
    'select public.trigger_payment_split_sweep();'
  );
end;
$schedule$;

do $postconditions$
declare
  v_signature text;
  v_ledger_definition text;
begin
  if (
    select count(*)
      from (
        values
          ('private.trigger_reconcile_ledger()'),
          ('public.trigger_sync_plan_change_billing()'),
          ('public.trigger_sync_subscription_status()'),
          ('public.trigger_payment_split_sweep()')
      ) as expected(signature)
      join pg_proc as procedure
        on procedure.oid = to_regprocedure(expected.signature)
     where procedure.prosecdef
       and procedure.proconfig @> array['search_path=""']::text[]
       and pg_get_userbyid(procedure.proowner) = 'postgres'
  ) <> 4 then
    raise exception 'asaas_auxiliary_wrapper_security_postcondition_failed';
  end if;

  for v_signature in
    select signature
      from (
        values
          ('private.trigger_reconcile_ledger()'),
          ('public.trigger_sync_plan_change_billing()'),
          ('public.trigger_sync_subscription_status()'),
          ('public.trigger_payment_split_sweep()')
      ) as expected(signature)
  loop
    if has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not has_function_privilege(
         'service_role', v_signature, 'EXECUTE'
       )
    then
      raise exception 'asaas_auxiliary_wrapper_acl_postcondition_failed: %',
        v_signature;
    end if;
  end loop;

  v_ledger_definition := pg_get_functiondef(
    'private.trigger_reconcile_ledger()'::regprocedure
  );
  if position('vault.decrypted_secrets' in v_ledger_definition) = 0
     or position('/functions/v1/reconcile-ledger' in v_ledger_definition) = 0
     or position('Authorization' in v_ledger_definition) = 0
     or position('apikey' in v_ledger_definition) = 0
     or position('batchSize' in v_ledger_definition) = 0
  then
    raise exception 'reconcile_ledger_wrapper_contract_postcondition_failed';
  end if;

  if exists (
    select 1
      from (
        values
          (
            'wisewolf-sync-plan-change-billing',
            '*/15 * * * *',
            'select public.trigger_sync_plan_change_billing();'
          ),
          (
            'wisewolf-reconcile-ledger',
            '7 * * * *',
            'select private.trigger_reconcile_ledger();'
          ),
          (
            'wisewolf-sync-subscriptions',
            '40 6 * * *',
            'select public.trigger_sync_subscription_status();'
          ),
          (
            'wisewolf-payment-split-sweep',
            '*/15 * * * *',
            'select public.trigger_payment_split_sweep();'
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
  ) then
    raise exception 'asaas_auxiliary_cron_postcondition_failed';
  end if;
end;
$postconditions$;
