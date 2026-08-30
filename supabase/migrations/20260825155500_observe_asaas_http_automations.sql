-- pg_cron enxerga apenas se o pedido foi enfileirado pelo pg_net. Este mapa
-- correlaciona cada request_id com a automacao que o originou e permite que o
-- health-check detecte HTTP 4xx/5xx, timeout e ausencia de resposta.

do $preconditions$
begin
  if to_regclass('net._http_response') is null then
    raise exception 'pg_net_http_response_table_is_required';
  end if;
  if to_regprocedure('private.notify_asaas_automation_health()') is null then
    raise exception 'asaas_health_notifier_is_required';
  end if;
end;
$preconditions$;

create table if not exists private.asaas_automation_http_requests (
  request_id bigint primary key,
  automation_name text not null check (
    automation_name in (
      'WEBHOOK_WORKER',
      'RECONCILIATION',
      'PLAN_CHANGE_BILLING',
      'LEDGER_RECONCILIATION',
      'SUBSCRIPTION_SYNC',
      'PAYMENT_SPLIT_SWEEP'
    )
  ),
  queued_at timestamptz not null default pg_catalog.now(),
  deadline_at timestamptz not null
    default (pg_catalog.now() + interval '5 minutes'),
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT')),
  http_status integer,
  outcome_summary text,
  response_checked_at timestamptz
);

-- Reexecucao segura caso uma validacao anterior tenha criado a primeira versao
-- da tabela antes das colunas de resultado duravel.
alter table private.asaas_automation_http_requests
  add column if not exists deadline_at timestamptz,
  add column if not exists status text,
  add column if not exists http_status integer,
  add column if not exists outcome_summary text,
  add column if not exists response_checked_at timestamptz;
update private.asaas_automation_http_requests
   set deadline_at = coalesce(
         deadline_at,
         queued_at + interval '5 minutes'
       ),
       status = coalesce(status, 'QUEUED');
alter table private.asaas_automation_http_requests
  alter column deadline_at
    set default (pg_catalog.now() + interval '5 minutes'),
  alter column deadline_at set not null,
  alter column status set default 'QUEUED',
  alter column status set not null;

do $request_constraints$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'private.asaas_automation_http_requests'::regclass
       and conname = 'asaas_automation_http_requests_status_check'
  ) then
    alter table private.asaas_automation_http_requests
      add constraint asaas_automation_http_requests_status_check
      check (status in ('QUEUED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'));
  end if;
end;
$request_constraints$;

alter table private.asaas_automation_http_requests owner to postgres;
revoke all on table private.asaas_automation_http_requests
  from public, anon, authenticated, service_role;

create index if not exists asaas_automation_http_requests_queued_idx
  on private.asaas_automation_http_requests (queued_at desc);

create or replace function private.record_asaas_automation_http_request(
  p_automation_name text,
  p_request_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing_name text;
begin
  if p_request_id is null
     or p_request_id <= 0
     or p_automation_name not in (
       'WEBHOOK_WORKER',
       'RECONCILIATION',
       'PLAN_CHANGE_BILLING',
       'LEDGER_RECONCILIATION',
       'SUBSCRIPTION_SYNC',
       'PAYMENT_SPLIT_SWEEP'
     ) then
    raise exception 'invalid_asaas_automation_http_request';
  end if;

  insert into private.asaas_automation_http_requests (
    request_id,
    automation_name
  ) values (
    p_request_id,
    p_automation_name
  )
  on conflict (request_id) do nothing;

  select request.automation_name
    into v_existing_name
    from private.asaas_automation_http_requests as request
   where request.request_id = p_request_id;

  if v_existing_name is distinct from p_automation_name then
    raise exception 'asaas_automation_http_request_identity_conflict';
  end if;
  return p_request_id;
end;
$function$;

alter function private.record_asaas_automation_http_request(text,bigint)
  owner to postgres;
revoke all on function private.record_asaas_automation_http_request(text,bigint)
  from public, anon, authenticated, service_role;

create or replace function private.asaas_http_response_outcome(
  p_status_code integer,
  p_timed_out boolean,
  p_error_msg text,
  p_content text
)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_payload jsonb;
begin
  if coalesce(p_timed_out, false) then
    return 'TRANSPORT_TIMEOUT';
  end if;
  if p_error_msg is not null then
    return 'TRANSPORT_ERROR';
  end if;
  if p_status_code is null or p_status_code not between 200 and 299 then
    return 'HTTP_STATUS_FAILURE';
  end if;

  begin
    v_payload := p_content::jsonb;
  exception when others then
    return 'INVALID_JSON_RESPONSE';
  end;
  if pg_catalog.jsonb_typeof(v_payload) <> 'object' then
    return 'INVALID_JSON_RESPONSE';
  end if;

  if pg_catalog.lower(coalesce(v_payload ->> 'success', 'true')) = 'false'
     or pg_catalog.lower(coalesce(v_payload ->> 'ok', 'true')) = 'false'
     or (
       v_payload ? 'error'
       and v_payload -> 'error' <> 'null'::jsonb
       and nullif(pg_catalog.btrim(v_payload ->> 'error'), '') is not null
     )
     or (
       coalesce(v_payload ->> 'failed', '') ~ '^[0-9]+$'
       and (v_payload ->> 'failed')::integer > 0
     )
     or (
       coalesce(v_payload ->> 'falhas', '') ~ '^[0-9]+$'
       and (v_payload ->> 'falhas')::integer > 0
     )
     or (
       coalesce(v_payload ->> 'blocked', '') ~ '^[0-9]+$'
       and (v_payload ->> 'blocked')::integer > 0
     )
     or (
       coalesce(v_payload ->> 'bloqueados', '') ~ '^[0-9]+$'
       and (v_payload ->> 'bloqueados')::integer > 0
     )
     or (
       pg_catalog.jsonb_typeof(v_payload -> 'failures') = 'array'
       and pg_catalog.jsonb_array_length(v_payload -> 'failures') > 0
     ) then
    return 'APPLICATION_FAILURE';
  end if;
  return 'SUCCEEDED';
end;
$function$;

alter function private.asaas_http_response_outcome(integer,boolean,text,text)
  owner to postgres;
revoke all on function private.asaas_http_response_outcome(integer,boolean,text,text)
  from public, anon, authenticated, service_role;

create or replace function private.collect_asaas_http_failures()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_recorded integer := 0;
begin
  -- Persista o resultado antes que a tabela UNLOGGED do pg_net expire.
  update private.asaas_automation_http_requests as request
     set status = case
           when outcome.value = 'SUCCEEDED' then 'SUCCEEDED'
           else 'FAILED'
         end,
         http_status = response.status_code,
         outcome_summary = outcome.value,
         response_checked_at = pg_catalog.now()
    from net._http_response as response
    cross join lateral (
      select private.asaas_http_response_outcome(
        response.status_code,
        response.timed_out,
        response.error_msg,
        response.content
      ) as value
   ) as outcome
   where request.request_id = response.id
     and request.status in ('QUEUED', 'TIMED_OUT');

  update private.asaas_automation_http_requests as request
     set status = 'TIMED_OUT',
         outcome_summary = 'HTTP_RESPONSE_MISSING',
         response_checked_at = pg_catalog.now()
   where request.status = 'QUEUED'
     and request.deadline_at < pg_catalog.now()
     and not exists (
       select 1
         from net._http_response as response
        where response.id = request.request_id
     );

  -- Uma resposta 2xx valida encerra somente a issue "sem resposta". Uma
  -- resposta HTTP/aplicativa de erro e imutavel e requer revisao.
  update public.asaas_reconciliation_issues as issue
     set resolved_at = pg_catalog.now(),
         resolution_note = 'http_response_2xx_observed'
    from private.asaas_automation_http_requests as request
   where issue.source = 'AUTOMATION_HTTP'
     and issue.kind = 'HTTP_RESPONSE_MISSING'
     and issue.resolved_at is null
     and issue.provider_entity_id = request.request_id::text
     and request.status = 'SUCCEEDED';

  insert into public.asaas_reconciliation_issues (
    tenant_id,
    source,
    kind,
    severity,
    provider_entity_id,
    fingerprint,
    details,
    observed_at
  )
  select
    null,
    'AUTOMATION_HTTP',
    case when request.status = 'TIMED_OUT'
      then 'HTTP_RESPONSE_MISSING'
      else 'HTTP_RESPONSE_FAILED'
    end,
    case
      when request.automation_name in ('WEBHOOK_WORKER', 'RECONCILIATION')
        then 'CRITICAL'
      else 'HIGH'
    end,
    request.request_id::text,
    'automation-http:' || request.request_id::text,
    pg_catalog.jsonb_build_object(
      'automation', request.automation_name,
      'request_id', request.request_id,
      'queued_at', request.queued_at,
      'deadline_at', request.deadline_at,
      'response_observed', request.status = 'FAILED',
      'status_code', request.http_status,
      'outcome', request.outcome_summary
    ),
    coalesce(request.response_checked_at, pg_catalog.now())
  from private.asaas_automation_http_requests as request
  where request.queued_at > pg_catalog.now() - interval '24 hours'
    and request.status in ('FAILED', 'TIMED_OUT')
  on conflict (source, fingerprint)
    where run_id is null and resolved_at is null
  do update set
    kind = excluded.kind,
    severity = excluded.severity,
    details = excluded.details,
    observed_at = excluded.observed_at;

  get diagnostics v_recorded = row_count;
  return v_recorded;
end;
$function$;

alter function private.collect_asaas_http_failures() owner to postgres;
revoke all on function private.collect_asaas_http_failures()
  from public, anon, authenticated, service_role;

create or replace function private.trigger_asaas_automation_worker()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret into v_service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/asaas-webhook',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := '{"operation":"drain"}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request_id;

  perform private.record_asaas_automation_http_request(
    'WEBHOOK_WORKER', v_request_id
  );
end;
$function$;

alter function private.trigger_asaas_automation_worker() owner to postgres;
revoke all on function private.trigger_asaas_automation_worker()
  from public, anon, authenticated, service_role;

create or replace function private.trigger_asaas_reconciliation()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret into v_service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/asaas-reconcile',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := pg_catalog.jsonb_build_object('lookbackDays', 45),
    timeout_milliseconds := 120000
  ) into v_request_id;

  perform private.record_asaas_automation_http_request(
    'RECONCILIATION', v_request_id
  );
end;
$function$;

alter function private.trigger_asaas_reconciliation() owner to postgres;
revoke all on function private.trigger_asaas_reconciliation()
  from public, anon, authenticated, service_role;

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
  select secret.decrypted_secret into v_service_key
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

  return private.record_asaas_automation_http_request(
    'LEDGER_RECONCILIATION', v_request_id
  );
end;
$function$;

alter function private.trigger_reconcile_ledger() owner to postgres;
revoke all on function private.trigger_reconcile_ledger()
  from public, anon, authenticated, service_role;
grant execute on function private.trigger_reconcile_ledger() to service_role;

create or replace function public.trigger_sync_plan_change_billing()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret into v_service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/sync-plan-change-billing',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_request_id;

  return private.record_asaas_automation_http_request(
    'PLAN_CHANGE_BILLING', v_request_id
  );
end;
$function$;

alter function public.trigger_sync_plan_change_billing() owner to postgres;
revoke all on function public.trigger_sync_plan_change_billing()
  from public, anon, authenticated, service_role;
grant execute on function public.trigger_sync_plan_change_billing()
  to service_role;

create or replace function public.trigger_sync_subscription_status()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret into v_service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/sync-subscription-status',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return private.record_asaas_automation_http_request(
    'SUBSCRIPTION_SYNC', v_request_id
  );
end;
$function$;

alter function public.trigger_sync_subscription_status() owner to postgres;
revoke all on function public.trigger_sync_subscription_status()
  from public, anon, authenticated, service_role;
grant execute on function public.trigger_sync_subscription_status()
  to service_role;

create or replace function public.trigger_payment_split_sweep()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_key text;
  v_request_id bigint;
begin
  select secret.decrypted_secret into v_service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(pg_catalog.btrim(v_service_key), '') is null then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/payment-split-notify',
    headers := pg_catalog.jsonb_build_object(
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key,
      'Content-Type', 'application/json'
    ),
    body := '{"sweep":true}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_request_id;

  return private.record_asaas_automation_http_request(
    'PAYMENT_SPLIT_SWEEP', v_request_id
  );
end;
$function$;

alter function public.trigger_payment_split_sweep() owner to postgres;
revoke all on function public.trigger_payment_split_sweep()
  from public, anon, authenticated, service_role;
grant execute on function public.trigger_payment_split_sweep() to service_role;

do $postconditions$
declare
  v_signature text;
  v_definition text;
begin
  if pg_catalog.has_table_privilege(
       'anon', 'private.asaas_automation_http_requests', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'private.asaas_automation_http_requests', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'private.asaas_automation_http_requests', 'SELECT'
     ) then
    raise exception 'asaas_http_request_map_acl_invalid';
  end if;

  if private.asaas_http_response_outcome(
       200, false, null, '{"ok":false,"falhas":1}'
     ) <> 'APPLICATION_FAILURE'
     or private.asaas_http_response_outcome(
       200, false, null, '{"success":true,"processed":1}'
     ) <> 'SUCCEEDED'
     or private.asaas_http_response_outcome(
       503, false, null, '{"error":"unavailable"}'
     ) <> 'HTTP_STATUS_FAILURE' then
    raise exception 'asaas_http_response_contract_invalid';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.collect_asaas_http_failures()'::regprocedure
  );
  if pg_catalog.strpos(
       pg_catalog.lower(v_definition),
       'request.status in (''queued'', ''timed_out'')'
     ) = 0 then
    raise exception 'asaas_late_http_response_reconciliation_missing';
  end if;

  for v_signature in
    select signature
      from (
        values
          ('private.trigger_asaas_automation_worker()'),
          ('private.trigger_asaas_reconciliation()'),
          ('private.trigger_reconcile_ledger()'),
          ('public.trigger_sync_plan_change_billing()'),
          ('public.trigger_sync_subscription_status()'),
          ('public.trigger_payment_split_sweep()')
      ) as expected(signature)
  loop
    v_definition := pg_catalog.pg_get_functiondef(
      v_signature::regprocedure
    );
    if pg_catalog.strpos(
         v_definition,
         'record_asaas_automation_http_request'
       ) = 0 then
      raise exception 'asaas_http_request_not_recorded_by_%', v_signature;
    end if;
  end loop;

  v_definition := pg_catalog.pg_get_functiondef(
    'private.notify_asaas_automation_health()'::regprocedure
  );
  if pg_catalog.strpos(v_definition, 'collect_asaas_http_failures') = 0
     or pg_catalog.strpos(v_definition, 'AUTOMATION_HTTP') = 0 then
    raise exception 'asaas_health_does_not_collect_http_outcomes';
  end if;
end;
$postconditions$;
