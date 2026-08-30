-- O cron nao pode ser considerado saudavel apenas porque o pg_net aceitou a
-- fila. Cada request_id precisa ser correlacionado a uma resposta HTTP real.

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
  to_regclass('private.asaas_automation_http_requests') is not null
  and not has_table_privilege(
    'anon', 'private.asaas_automation_http_requests', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'private.asaas_automation_http_requests', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'private.asaas_automation_http_requests', 'SELECT'
  ),
  'mapa request_id/automacao esta ausente ou exposto'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from (
        values
          ('private.trigger_asaas_automation_worker()'),
          ('private.trigger_asaas_reconciliation()'),
          ('private.trigger_reconcile_ledger()'),
          ('public.trigger_sync_plan_change_billing()'),
          ('public.trigger_sync_subscription_status()'),
          ('public.trigger_payment_split_sweep()')
      ) as expected(signature)
     where position(
       'record_asaas_automation_http_request' in
       pg_get_functiondef(expected.signature::regprocedure)
     ) = 0
  ),
  'wrapper HTTP nao registra o request_id duravel'
);

select pg_temp.assert_true(
  position(
    'collect_asaas_http_failures' in pg_get_functiondef(
      'private.notify_asaas_automation_health()'::regprocedure
    )
  ) > 0
  and position(
    'AUTOMATION_HTTP' in pg_get_functiondef(
      'private.notify_asaas_automation_health()'::regprocedure
    )
  ) > 0,
  'health-check nao confronta fila pg_net com resposta HTTP'
);

insert into private.asaas_automation_http_requests (
  request_id,
  automation_name,
  queued_at,
  deadline_at
) values (
  9223372036854775000,
  'WEBHOOK_WORKER',
  pg_catalog.now() - interval '10 minutes',
  pg_catalog.now() - interval '5 minutes'
);

select private.collect_asaas_http_failures();

select pg_temp.assert_true(
  exists (
    select 1
      from public.asaas_reconciliation_issues as issue
     where issue.source = 'AUTOMATION_HTTP'
       and issue.kind = 'HTTP_RESPONSE_MISSING'
       and issue.severity = 'CRITICAL'
       and issue.provider_entity_id = '9223372036854775000'
       and issue.resolved_at is null
       and issue.details ->> 'automation' = 'WEBHOOK_WORKER'
       and not (issue.details ->> 'response_observed')::boolean
       and issue.details ->> 'outcome' = 'HTTP_RESPONSE_MISSING'
  ),
  'ausencia de resposta HTTP nao virou alerta critico observavel'
);

insert into net._http_response (
  id, status_code, content_type, headers, content,
  timed_out, error_msg, created
) values (
  9223372036854775000,
  200,
  'application/json',
  '{}'::jsonb,
  '{"success":true,"processed":1}',
  false,
  null,
  pg_catalog.now()
);

select private.collect_asaas_http_failures();

select pg_temp.assert_true(
  exists (
    select 1
      from private.asaas_automation_http_requests as request
     where request.request_id = 9223372036854775000
       and request.status = 'SUCCEEDED'
       and request.http_status = 200
       and request.outcome_summary = 'SUCCEEDED'
       and request.response_checked_at is not null
  )
  and exists (
    select 1
      from public.asaas_reconciliation_issues as issue
     where issue.source = 'AUTOMATION_HTTP'
       and issue.kind = 'HTTP_RESPONSE_MISSING'
       and issue.provider_entity_id = '9223372036854775000'
       and issue.resolved_at is not null
       and issue.resolution_note = 'http_response_2xx_observed'
  ),
  'resposta 2xx tardia nao resolveu o falso timeout observavel'
);

insert into private.asaas_automation_http_requests (
  request_id,
  automation_name,
  queued_at,
  deadline_at
) values (
  9223372036854775001,
  'RECONCILIATION',
  pg_catalog.now() - interval '10 minutes',
  pg_catalog.now() - interval '5 minutes'
);

select private.collect_asaas_http_failures();

insert into net._http_response (
  id, status_code, content_type, headers, content,
  timed_out, error_msg, created
) values (
  9223372036854775001,
  503,
  'application/json',
  '{}'::jsonb,
  '{"error":"unavailable"}',
  false,
  null,
  pg_catalog.now()
);

select private.collect_asaas_http_failures();

select pg_temp.assert_true(
  exists (
    select 1
      from private.asaas_automation_http_requests as request
     where request.request_id = 9223372036854775001
       and request.status = 'FAILED'
       and request.http_status = 503
       and request.outcome_summary = 'HTTP_STATUS_FAILURE'
  )
  and exists (
    select 1
      from public.asaas_reconciliation_issues as issue
     where issue.source = 'AUTOMATION_HTTP'
       and issue.kind = 'HTTP_RESPONSE_FAILED'
       and issue.severity = 'CRITICAL'
       and issue.provider_entity_id = '9223372036854775001'
       and issue.resolved_at is null
       and (issue.details ->> 'response_observed')::boolean
       and issue.details ->> 'outcome' = 'HTTP_STATUS_FAILURE'
  ),
  'resposta HTTP tardia com falha nao substituiu o alerta de ausencia'
);

select pg_temp.assert_true(
  private.asaas_http_response_outcome(
    200,
    false,
    null,
    '{"ok":false,"failed":1}'
  ) = 'APPLICATION_FAILURE'
  and private.asaas_http_response_outcome(
    200,
    false,
    null,
    '{"success":true,"processed":1}'
  ) = 'SUCCEEDED',
  'HTTP 200 com falha aplicativa voltou a parecer saudavel'
);

rollback;
