-- Retoma somente WhatsApps adiados antes de qualquer POST ao provedor.
-- O endpoint oficial revalida Asaas, destinatário e a intenção durável do dia.
create or replace function private.daily_collection_retry_candidates()
returns table(tenant_id text, student_id uuid)
language sql stable security definer set search_path = ''
as $function$
  select distinct notice.tenant_id, notice.student_id
    from public.asaas_outbound_message_attempts as notice
    join public.student_payments as payment
      on payment.id::text = notice.provider_entity_id
     and payment.tenant_id = notice.tenant_id
     and payment.student_id = notice.student_id
   where notice.notification_kind = 'PAYMENT_OVERDUE_DAILY_' ||
         pg_catalog.to_char(pg_catalog.now() at time zone 'America/Sao_Paulo', 'YYYYMMDD')
     and notice.status = 'CLAIMED'
     and notice.submit_attempt_count = 0
     and notice.lease_expires_at <= pg_catalog.now()
     and notice.last_error like 'throttled\_%' escape '\'
     and private.daily_collection_allowed(payment.id, payment.tenant_id, payment.student_id);
$function$;
alter function private.daily_collection_retry_candidates() owner to postgres;
revoke all on function private.daily_collection_retry_candidates()
  from public, anon, authenticated, service_role;

create table if not exists private.daily_collection_retry_requests (
  request_id bigint primary key,
  tenant_id text not null,
  campaign_date date not null,
  student_count integer not null check(student_count between 1 and 100),
  queued_at timestamptz not null default pg_catalog.now()
);
alter table private.daily_collection_retry_requests owner to postgres;
revoke all on table private.daily_collection_retry_requests
  from public, anon, authenticated, service_role;

create or replace function private.trigger_retry_daily_payment_collections()
returns integer language plpgsql security definer set search_path = ''
as $function$
declare
  batch record;
  service_key text;
  request_id bigint;
  requests integer := 0;
begin
  -- Sem pendência segura, nenhum segredo é lido e nenhum HTTP é enfileirado.
  for batch in
    select candidates.tenant_id, pg_catalog.array_agg(candidates.student_id order by candidates.student_id) as student_ids
      from (
        select candidate.*, (pg_catalog.row_number() over (
          partition by candidate.tenant_id order by candidate.student_id
        ) - 1) / 100 as batch_number
          from private.daily_collection_retry_candidates() as candidate
      ) as candidates
     group by candidates.tenant_id, candidates.batch_number
  loop
    if service_key is null then
      select secret.decrypted_secret into service_key
        from vault.decrypted_secrets as secret
       where secret.name = 'wisewolf_service_role_key' limit 1;
      if nullif(pg_catalog.btrim(service_key), '') is null then
        raise exception 'wisewolf_service_role_key_is_not_configured';
      end if;
    end if;
    select net.http_post(
      url := 'http://kong:8000/functions/v1/notify-payment-due',
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || service_key, 'apikey', service_key,
        'Content-Type', 'application/json'
      ),
      body := pg_catalog.jsonb_build_object(
        'mode', 'DAILY_COLLECTION',
        'campaign_date', (pg_catalog.now() at time zone 'America/Sao_Paulo')::date,
        'tenant_id', batch.tenant_id, 'student_ids', pg_catalog.to_jsonb(batch.student_ids)
      ),
      timeout_milliseconds := 120000
    ) into request_id;
    insert into private.daily_collection_retry_requests(request_id,tenant_id,campaign_date,student_count)
    values(request_id,batch.tenant_id,(pg_catalog.now() at time zone 'America/Sao_Paulo')::date,pg_catalog.cardinality(batch.student_ids));
    requests := requests + 1;
  end loop;
  return requests;
end;
$function$;
alter function private.trigger_retry_daily_payment_collections() owner to postgres;
revoke all on function private.trigger_retry_daily_payment_collections()
  from public, anon, authenticated, service_role;

do $schedule$
begin
  if exists(select 1 from cron.job where jobname='wisewolf-retry-daily-payment-collections') then
    perform cron.unschedule('wisewolf-retry-daily-payment-collections');
  end if;
  perform cron.schedule(
    'wisewolf-retry-daily-payment-collections', '*/2 12-22 * * *',
    'select private.trigger_retry_daily_payment_collections();'
  );
end;
$schedule$;
