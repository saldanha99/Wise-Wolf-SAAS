-- Scheduling, Vault contract and ACL regression coverage for
-- 20260825153000_schedule_asaas_auxiliary_automations.sql.

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

select pg_temp.assert_true(
  (
    select count(*) = 4
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
  ),
  'wrappers de cron nao estao SECURITY DEFINER com search_path vazio'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from (
        values
          ('private.trigger_reconcile_ledger()'),
          ('public.trigger_sync_plan_change_billing()'),
          ('public.trigger_sync_subscription_status()'),
          ('public.trigger_payment_split_sweep()')
      ) as expected(signature)
     where has_function_privilege('anon', expected.signature, 'EXECUTE')
        or has_function_privilege(
          'authenticated', expected.signature, 'EXECUTE'
        )
        or not has_function_privilege(
          'service_role', expected.signature, 'EXECUTE'
        )
  ),
  'wrapper de cron vazou para cliente ou deixou de aceitar service_role'
);

select pg_temp.assert_true(
  has_schema_privilege('service_role', 'private', 'USAGE'),
  'service_role nao consegue resolver o wrapper privado do ledger'
);

select pg_temp.assert_true(
  (
    select position('vault.decrypted_secrets' in definition) > 0
       and position('wisewolf_service_role_key' in definition) > 0
       and position('/functions/v1/reconcile-ledger' in definition) > 0
       and position('net.http_post' in definition) > 0
       and position('Authorization' in definition) > 0
       and position('apikey' in definition) > 0
       and position('batchSize' in definition) > 0
      from (
        select pg_get_functiondef(
          'private.trigger_reconcile_ledger()'::regprocedure
        ) as definition
      ) as wrapper
  ),
  'wrapper do ledger nao preserva POST autenticado por segredo do Vault'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
      from vault.decrypted_secrets as secret
     where secret.name = 'wisewolf_service_role_key'
       and nullif(pg_catalog.btrim(secret.decrypted_secret), '') is not null
  ),
  'segredo interno das automacoes deve existir exatamente uma vez no Vault'
);

select pg_temp.assert_true(
  not exists (
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
  ),
  'cron auxiliar ausente, duplicado, inativo ou com schedule/comando divergente'
);

rollback;
