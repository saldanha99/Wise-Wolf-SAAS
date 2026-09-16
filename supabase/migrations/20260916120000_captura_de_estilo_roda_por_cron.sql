-- ─────────────────────────────────────────────────────────────────────────────
-- A captura do jeito da direção roda por cron própria (16/09/2026)
--
-- Erro da primeira versão: a captura foi pendurada no worker do SDR, e
-- `trigger_sdr_work()` só chama a function quando existe lead esperando
-- resposta (`if not exists(select 1 from list_pending_sdr_work()) then return 0`).
-- Resultado: madrugada inteira sem capturar nada, com 135 áudios esperando.
--
-- Aprender não depende de ter lead escrevendo agora. Cron própria, a cada 5 min.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.trigger_sdr_style_capture()
returns bigint language plpgsql security definer set search_path = '' as $fn$
declare service_key text; request_id bigint;
begin
  select decrypted_secret into service_key
    from vault.decrypted_secrets where name = 'wisewolf_service_role_key' limit 1;
  if nullif(service_key, '') is null then return -1; end if;
  select net.http_post(
    url := 'http://kong:8000/functions/v1/whatsapp-inbound?worker=style',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into request_id;
  return request_id;
end $fn$;

alter function public.trigger_sdr_style_capture() owner to postgres;
revoke all on function public.trigger_sdr_style_capture() from public, anon, authenticated;

do $cron$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('wisewolf-sdr-style', '*/5 * * * *',
      'select public.trigger_sdr_style_capture();');
  end if;
end $cron$;
