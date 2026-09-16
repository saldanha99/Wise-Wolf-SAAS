-- Cron: dia 1º, 07:00 UTC (04:00 BRT), depois do fechamento das 06:30 —
-- a folha do mês anterior por professor vai para o grupo da Gestão.
-- Mesmo padrão de `trigger_monthly_teacher_closing` (vault + net.http_post).
-- Re-executável: `cron.schedule` com o mesmo nome substitui o agendamento.

create or replace function public.trigger_management_payroll_report()
returns bigint
language plpgsql
security definer
set search_path to 'public', 'vault'
as $$
declare request_id bigint; service_key text;
begin
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'wisewolf_service_role_key' limit 1;
  if service_key is null or service_key = '' then raise warning 'service key ausente'; return -1; end if;
  select net.http_post(
    url := 'http://kong:8000/functions/v1/management-payroll-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || service_key),
    body := '{}'::jsonb, timeout_milliseconds := 120000
  ) into request_id;
  return request_id;
end;
$$;
revoke all on function public.trigger_management_payroll_report() from public, anon, authenticated;
grant execute on function public.trigger_management_payroll_report() to service_role;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('wisewolf-monthly-payroll-gestao', '0 7 1 * *', 'select public.trigger_management_payroll_report();');
  end if;
end; $$;
