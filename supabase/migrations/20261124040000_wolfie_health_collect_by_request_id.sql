-- Wolfie healthcheck: collect the response of the healthcheck request itself.
--
-- Bug: collect_wolfie_healthcheck() read the newest row of net._http_response
-- from ANY request. pg_net also serves the wolfie-realtime-session sweeper
-- (every ~10 s), whose response has no "healthy" field, so every hourly check
-- since 2026-10-25 was stored as healthy=false (false alarm, daily WhatsApp).
--
-- Fix (additive): trigger_wolfie_healthcheck() stores the pg_net request id in
-- private.wolfie_healthcheck_requests; the collector reads only that id.
--
-- Rollback: restore both functions from the previous definitions
-- (supabase/migrations/20260831063906_harden_daily_automations_and_cron_health.sql
-- / backup in /opt/wisewolf/backup-wolfie-health-collector-*/). The table can stay.

create schema if not exists private;

create table if not exists private.wolfie_healthcheck_requests (
  request_id   bigint primary key,
  check_name   text not null default 'realtime',
  created_at   timestamptz not null default now(),
  collected_at timestamptz
);

-- The SECURITY DEFINER functions below run as their owner (postgres).
alter table private.wolfie_healthcheck_requests owner to postgres;
revoke all on table private.wolfie_healthcheck_requests from public, anon, authenticated;

create index if not exists wolfie_healthcheck_requests_created_idx
  on private.wolfie_healthcheck_requests (created_at desc);

create or replace function public.trigger_wolfie_healthcheck()
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key text;
  v_req bigint;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets
  where name = 'wisewolf_service_role_key' limit 1;
  if v_key is null then
    perform public.record_wolfie_health('realtime', false, 'service role key ausente no vault');
    return null;
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/wolfie-healthcheck',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_req;

  insert into private.wolfie_healthcheck_requests (request_id, check_name)
  values (v_req, 'realtime')
  on conflict (request_id) do nothing;

  -- Keep the bookkeeping table small (pg_net keeps responses ~6 h anyway).
  delete from private.wolfie_healthcheck_requests
  where created_at < now() - interval '30 days';

  return v_req;
end;
$function$;

create or replace function public.collect_wolfie_healthcheck()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req     bigint;
  v_resp    record;
  v_healthy boolean;
  v_reason  text;
begin
  select request_id into v_req
  from private.wolfie_healthcheck_requests
  where check_name = 'realtime'
    and collected_at is null
    and created_at > now() - interval '20 minutes'
  order by created_at desc, request_id desc
  limit 1;

  if v_req is null then
    -- Trigger did not run (or was already collected): nothing to judge.
    return jsonb_build_object('ok', false, 'reason', 'sem_requisicao');
  end if;

  update private.wolfie_healthcheck_requests
  set collected_at = now()
  where request_id = v_req;

  select status_code, content, error_msg, timed_out into v_resp
  from net._http_response
  where id = v_req;

  if not found then
    v_healthy := false;
    v_reason  := 'healthcheck sem resposta (pg_net)';
  elsif v_resp.status_code is null then
    v_healthy := false;
    v_reason  := 'healthcheck falhou no transporte: '
                 || coalesce(v_resp.error_msg, case when v_resp.timed_out then 'timeout' else 'sem detalhe' end);
  elsif v_resp.status_code <> 200 then
    v_healthy := false;
    v_reason  := 'healthcheck HTTP ' || v_resp.status_code;
  else
    begin
      v_healthy := (v_resp.content::jsonb ->> 'healthy')::boolean;
      v_reason  := coalesce(v_resp.content::jsonb ->> 'reason', '');
    exception when others then
      v_healthy := false;
      v_reason  := 'resposta ilegível do healthcheck';
    end;
  end if;

  return public.record_wolfie_health('realtime', coalesce(v_healthy, false), v_reason)
         || jsonb_build_object('request_id', v_req);
end;
$function$;

revoke all on function public.trigger_wolfie_healthcheck() from public, anon, authenticated;
revoke all on function public.collect_wolfie_healthcheck() from public, anon, authenticated;
grant execute on function public.trigger_wolfie_healthcheck() to service_role;
grant execute on function public.collect_wolfie_healthcheck() to service_role;
