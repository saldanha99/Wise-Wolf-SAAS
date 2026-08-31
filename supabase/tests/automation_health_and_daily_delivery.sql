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

select pg_temp.assert_true(
  pg_catalog.to_regprocedure('public.notify_cron_failures()') is not null
  and pg_catalog.to_regprocedure(
    'private.enqueue_cron_health_alert(text,text,text,date)'
  ) is not null,
  'cron health functions are missing'
);

select pg_temp.assert_true(
  pg_catalog.has_function_privilege(
    'service_role', 'public.notify_cron_failures()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon', 'public.notify_cron_failures()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated', 'public.notify_cron_failures()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'private.enqueue_cron_health_alert(text,text,text,date)',
    'EXECUTE'
  ),
  'cron health privilege boundary is not service-only'
);

select pg_temp.assert_true(
  pg_catalog.pg_get_functiondef(
    'public.teacher_agendas_today()'::pg_catalog.regprocedure
  ) like '%date_automation_enabled is distinct from false%'
  and pg_catalog.pg_get_functiondef(
    'public.birthdays_today()'::pg_catalog.regprocedure
  ) like '%date_automation_enabled is distinct from false%'
  and not pg_catalog.has_function_privilege(
    'authenticated', 'public.teacher_agendas_today()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated', 'public.birthdays_today()', 'EXECUTE'
  ),
  'daily RPCs ignore opt-out or remain browser-callable'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
      and bool_and(job.active)
      and min(job.schedule) = '0 11 * * *'
      and min(job.command) = 'select public.trigger_daily_automations();'
    from cron.job as job
    where job.jobname = 'wisewolf-daily-automations'
  )
  and not exists (
    select 1 from cron.job as job
    where job.jobname = 'wisewolf-teacher-daily-agenda'
  ),
  'teacher agenda still has two cron producers'
);

select pg_temp.assert_true(
  (
    select count(*) = 1
      and bool_and(job.active)
      and min(job.schedule) = '*/15 * * * *'
      and min(job.command) =
        'select public.trigger_sync_plan_change_billing();'
    from cron.job as job
    where job.jobname = 'wisewolf-sync-plan-change-billing'
  )
  and not exists (
    select 1 from cron.job as job
    where job.jobname = 'wisewolf-plan-change-billing'
  ),
  'plan change billing still has duplicate cron producers'
);

-- Prova de que um job ausente, e não apenas active=false, gera alerta. Tudo
-- ocorre dentro desta transação e é revertido antes de o worker voltar.
select pg_temp.assert_true(
  exists (
    select 1 from cron.job as job
    where job.jobname = 'wisewolf-post-trial-pipeline' and job.active is true
  ),
  'post-trial cron fixture is unavailable'
);

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname = 'wisewolf-post-trial-pipeline';

delete from public.notification_queue
where idempotency_key =
  'cron-health:CRON_INACTIVE:wisewolf-post-trial-pipeline:' ||
  ((now() at time zone 'America/Sao_Paulo')::date)::text;
select public.notify_cron_failures();
select public.notify_cron_failures();

select pg_temp.assert_true(
  (
    select count(*) = 1
      and bool_and(queue.notification_kind = 'CRON_ALERT')
      and bool_and(queue.status = 'pending')
      and bool_and(queue.delivery_status = 'queued')
      and bool_and(queue.teacher_id = expected.id)
    from public.notification_queue as queue
    cross join lateral (
      select profile.id
      from public.tenant_memberships as membership
      join public.profiles as profile on profile.id = membership.user_id
      where membership.tenant_id = 'school-wise-wolf'
        and membership.role = 'SCHOOL_ADMIN'
        and membership.status = 'ACTIVE'
        and lower(trim(coalesce(profile.lifecycle_status, ''))) = 'active'
        and coalesce(profile.is_test_account, false) is false
        and coalesce(
          nullif(trim(profile.attendance_phone), ''),
          nullif(trim(profile.phone), '')
        ) is not null
      order by
        membership.is_primary desc nulls last,
        membership.created_at,
        profile.id
      limit 1
    ) as expected
    where queue.idempotency_key =
      'cron-health:CRON_INACTIVE:wisewolf-post-trial-pipeline:' ||
      ((now() at time zone 'America/Sao_Paulo')::date)::text
  ),
  'missing cron was not queued idempotently for the primary director'
);

rollback;
