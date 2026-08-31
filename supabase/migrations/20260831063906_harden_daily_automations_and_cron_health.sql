-- Fecha duas classes de falha silenciosa:
--   1. o monitor antigo considerava somente jobs presentes porém desligados;
--      um job removido por engano desaparecia da vigilância;
--   2. o destinatário era o primeiro SCHOOL_ADMIN por tenant_id, mesmo inativo
--      ou sem vínculo primário, e ainda dependia da coluna legada de instância.

create or replace function public.teacher_agendas_today()
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'teacher_id', agenda.teacher_id,
        'name', agenda.teacher_name,
        'phone', agenda.teacher_phone,
        'tenant_id', agenda.tenant_id,
        'classes', agenda.classes
      )
    ),
    '[]'::jsonb
  )
  from (
    select
      upcoming.teacher_id,
      teacher.full_name as teacher_name,
      teacher.phone as teacher_phone,
      teacher.tenant_id,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'time', upcoming.time_text,
          'student', coalesce(student.full_name, upcoming.student_name_override)
        )
        order by upcoming.time_text
      ) as classes
    from public.upcoming_classes as upcoming
    join public.profiles as teacher on teacher.id = upcoming.teacher_id
    left join public.profiles as student on student.id = upcoming.student_id
    where upcoming.class_date =
        (now() at time zone 'America/Sao_Paulo')::date
      and nullif(pg_catalog.btrim(teacher.phone), '') is not null
      and upper(pg_catalog.btrim(coalesce(teacher.role, ''))) = 'TEACHER'
      and lower(pg_catalog.btrim(coalesce(
        teacher.lifecycle_status,
        ''
      ))) = 'active'
      and coalesce(teacher.is_test_account, false) is false
      and teacher.date_automation_enabled is distinct from false
      and exists (
        select 1
        from public.tenant_memberships as membership
        where membership.user_id = teacher.id
          and membership.tenant_id = teacher.tenant_id
          and membership.role = 'TEACHER'
          and membership.status = 'ACTIVE'
      )
    group by
      upcoming.teacher_id,
      teacher.full_name,
      teacher.phone,
      teacher.tenant_id
  ) as agenda;
$function$;

alter function public.teacher_agendas_today() owner to postgres;
revoke all on function public.teacher_agendas_today()
  from public, anon, authenticated;
grant execute on function public.teacher_agendas_today() to service_role;

create or replace function public.birthdays_today()
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', profile.id,
        'name', profile.full_name,
        'phone', profile.phone,
        'tenant_id', profile.tenant_id,
        'role', profile.role
      )
    ),
    '[]'::jsonb
  )
  from public.profiles as profile
  where upper(pg_catalog.btrim(coalesce(profile.role, ''))) in (
      'STUDENT', 'TEACHER'
    )
    and profile.birth_date is not null
    and pg_catalog.to_char(profile.birth_date, 'MM-DD') =
      pg_catalog.to_char(
        (now() at time zone 'America/Sao_Paulo')::date,
        'MM-DD'
      )
    and nullif(pg_catalog.btrim(profile.phone), '') is not null
    and lower(pg_catalog.btrim(coalesce(
      profile.lifecycle_status,
      ''
    ))) = 'active'
    and coalesce(profile.is_test_account, false) is false
    and profile.date_automation_enabled is distinct from false
    and exists (
      select 1
      from public.tenant_memberships as membership
      where membership.user_id = profile.id
        and membership.tenant_id = profile.tenant_id
        and membership.role = upper(pg_catalog.btrim(profile.role))
        and membership.status = 'ACTIVE'
    );
$function$;

alter function public.birthdays_today() owner to postgres;
revoke all on function public.birthdays_today()
  from public, anon, authenticated;
grant execute on function public.birthdays_today() to service_role;

create or replace function private.enqueue_cron_health_alert(
  p_kind text,
  p_subject text,
  p_message text,
  p_ref_date date
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_admin record;
  v_queue_id uuid;
  v_kind text := upper(pg_catalog.btrim(coalesce(p_kind, '')));
  v_subject text := pg_catalog.btrim(coalesce(p_subject, ''));
begin
  if v_kind = '' or v_subject = '' or p_ref_date is null
     or nullif(pg_catalog.btrim(coalesce(p_message, '')), '') is null
  then
    raise exception using errcode = '22023', message = 'invalid_cron_health_alert';
  end if;

  select
    profile.id,
    membership.tenant_id,
    coalesce(
      nullif(pg_catalog.btrim(profile.attendance_phone), ''),
      nullif(pg_catalog.btrim(profile.phone), '')
    ) as phone
  into v_admin
  from public.tenant_memberships as membership
  join public.profiles as profile on profile.id = membership.user_id
  where membership.tenant_id = 'school-wise-wolf'
    and membership.role = 'SCHOOL_ADMIN'
    and membership.status = 'ACTIVE'
    and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
    and coalesce(profile.is_test_account, false) is false
    and coalesce(
      nullif(pg_catalog.btrim(profile.attendance_phone), ''),
      nullif(pg_catalog.btrim(profile.phone), '')
    ) is not null
  order by
    membership.is_primary desc nulls last,
    membership.created_at,
    profile.id
  limit 1;

  if v_admin.id is null then
    raise exception using
      errcode = '55000',
      message = 'cron_health_recipient_unavailable';
  end if;

  insert into public.notification_queue (
    tenant_id,
    teacher_id,
    student_phone,
    message_body,
    scheduled_for,
    next_attempt_at,
    status,
    attempts,
    max_attempts,
    delivery_status,
    source_type,
    class_date,
    notification_kind,
    idempotency_key
  ) values (
    v_admin.tenant_id,
    v_admin.id,
    v_admin.phone,
    p_message,
    now(),
    now(),
    'pending',
    0,
    5,
    'queued',
    'CRON_HEALTH',
    p_ref_date,
    'CRON_ALERT',
    'cron-health:' || v_kind || ':' || v_subject || ':' || p_ref_date::text
  )
  on conflict (tenant_id, idempotency_key)
    where idempotency_key is not null
  do nothing
  returning id into v_queue_id;

  return v_queue_id is not null;
end;
$function$;

alter function private.enqueue_cron_health_alert(text,text,text,date)
  owner to postgres;
revoke all on function private.enqueue_cron_health_alert(text,text,text,date)
  from public, anon, authenticated, service_role;

create or replace function public.notify_cron_failures()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r record;
  v_sent integer := 0;
  v_message text;
  v_total_jobs integer;
  v_exact_jobs integer;
  v_failure_count integer;
  v_ref_date date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  -- Jobs ativos que falharam durante 24h sem nenhum sucesso.
  for r in
    select
      job.jobname,
      count(*) filter (where detail.status = 'failed') as failures,
      max(detail.return_message) filter (where detail.status = 'failed') as error
    from cron.job_run_details as detail
    join cron.job as job on job.jobid = detail.jobid
    where detail.start_time > now() - interval '24 hours'
      and job.active is true
    group by job.jobname
    having count(*) filter (where detail.status = 'failed') > 0
       and count(*) filter (where detail.status = 'succeeded') = 0
  loop
    v_message := '⚠️ *Alerta de automação Wise Wolf*' || E'\n\n' ||
      'O processo *' || r.jobname || '* falhou ' || r.failures ||
      'x nas últimas 24h e não teve nenhum sucesso.' || E'\n\n' ||
      'Erro: ' || left(coalesce(r.error, '(sem detalhe)'), 220) || E'\n\n' ||
      'Vale checar antes que afete alunos ou professores.';
    if private.enqueue_cron_health_alert(
      'CRON_ALERT', r.jobname, v_message, v_ref_date
    ) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  -- Registro canônico: nome, frequência e comando precisam coincidir. Apenas
  -- conferir active=true deixaria passar um job que executa a rotina errada.
  for r in
    select *
    from (
      values
        ('wisewolf-prepare-reminders', '*/5 * * * *', 'select trigger_prepare_reminders();'),
        ('wisewolf-cron-health', '30 11,21 * * *', 'select public.notify_cron_failures();'),
        ('wisewolf-process-queue', '* * * * *', 'select public.trigger_process_queue();'),
        ('wisewolf-reconcile-whatsapp-webhooks', '*/15 * * * *', 'select private.trigger_reconcile_whatsapp_webhooks();'),
        ('wisewolf-send-attendance-confirmations', '*/15 * * * *', 'select trigger_send_attendance_confirmations();'),
        ('wisewolf-sdr-followups', '20 12-22 * * *', 'select trigger_sdr_followups();'),
        ('wisewolf-funnel-sweeper', '*/15 * * * *', 'select trigger_funnel_sweeper();'),
        ('wisewolf-post-trial-pipeline', '*/30 * * * *', 'select trigger_post_trial_pipeline();'),
        ('wisewolf-daily-automations', '0 11 * * *', 'select public.trigger_daily_automations();'),
        ('wisewolf-school-ai-team', '0 10 * * *', 'select public.trigger_school_ai_team();'),
        ('wisewolf-notify-payment-due', '0 12 * * *', 'select trigger_notify_payment_due();'),
        ('wisewolf-apply-teacher-transfers', '0 9 * * *', 'select public.apply_due_teacher_transfers();'),
        ('wisewolf-closing-recalc', '30 11 * * *', 'select trigger_teacher_closing_recalc();'),
        ('wisewolf-monthly-closing', '30 6 1 * *', 'select trigger_monthly_teacher_closing();'),
        ('wisewolf-weekly-digest', '0 11 * * 1', 'select trigger_weekly_director_digest();'),
        ('wisewolf-dre-report', '20 11 * * *', 'select trigger_dre_report();'),
        ('wisewolf-nf-reminders', '0 13 * * *', 'select public.enqueue_nf_reminders();'),
        ('wisewolf-oral-test-scan', '30 12 * * *', 'select public.trigger_oral_test_scan();'),
        ('wisewolf-recurring-expenses', '10 6 1 * *', 'select public.run_recurring_expenses();'),
        ('wisewolf-suspend-students', '0 5 * * *', 'select suspend_overdue_students();'),
        ('wisewolf-asaas-webhook-worker', '* * * * *', 'select private.trigger_asaas_automation_worker();'),
        ('wisewolf-asaas-reconciliation', '17 6 * * *', 'select private.trigger_asaas_reconciliation();'),
        ('wisewolf-asaas-health', '*/15 * * * *', 'select private.notify_asaas_automation_health();'),
        ('wisewolf-sync-plan-change-billing', '*/15 * * * *', 'select public.trigger_sync_plan_change_billing();'),
        ('wisewolf-reconcile-ledger', '7 * * * *', 'select private.trigger_reconcile_ledger();'),
        ('wisewolf-sync-subscriptions', '40 6 * * *', 'select public.trigger_sync_subscription_status();'),
        ('wisewolf-payment-split-sweep', '*/15 * * * *', 'select public.trigger_payment_split_sweep();'),
        ('wisewolf-saas-billing', '0 13 * * *', 'select run_saas_billing();'),
        ('wisewolf-hub-fulfillment', '* * * * *', 'select public.trigger_hub_fulfillment_worker();'),
        ('wisewolf-expire-hub-core-cancellations', '*/5 * * * *', 'select private.expire_hub_core_cancellations_internal();'),
        ('wisewolf-expire-hub-trials', '*/15 * * * *', 'select private.expire_hub_trials_internal();'),
        ('wisewolf-wolfie-health', '7 * * * *', 'select public.trigger_wolfie_healthcheck();'),
        ('wisewolf-wolfie-health-collect', '9 * * * *', 'select public.collect_wolfie_healthcheck();'),
        ('wisewolf-live-grant-cleanup', '10 seconds', 'select public.trigger_wolfie_live_grant_cleanup();'),
        ('kids-weekly-report', '0 18 * * 1', 'select public.send_kids_weekly_report();'),
        ('notify-full-hearts-hourly', '0 * * * *', 'select public.notify_full_hearts();')
    ) as expected(jobname, schedule, command)
  loop
    select
      count(*),
      count(*) filter (
        where job.active is true
          and job.schedule = r.schedule
          and lower(pg_catalog.regexp_replace(
            pg_catalog.btrim(job.command),
            '[[:space:]]+',
            ' ',
            'g'
          )) = lower(r.command)
      )
    into v_total_jobs, v_exact_jobs
    from cron.job as job
    where job.jobname = r.jobname;

    if v_total_jobs <> 1 or v_exact_jobs <> 1 then
      v_message := '🔴 *Automação ausente ou divergente — Wise Wolf*' || E'\n\n' ||
        'O processo *' || r.jobname || '* não possui uma única agenda canônica ' ||
        '(registros: ' || v_total_jobs || '; definição correta: ' ||
        v_exact_jobs || ').' ||
        E'\n\nEnquanto isso persistir, a rotina pode ficar totalmente silenciosa. ' ||
        'A configuração do agendador precisa ser restaurada.';
      if private.enqueue_cron_health_alert(
        'CRON_INACTIVE', r.jobname, v_message, v_ref_date
      ) then
        v_sent := v_sent + 1;
      end if;
    end if;
  end loop;

  select count(*)
  into v_failure_count
  from public.notification_queue as notification
  where notification.status = 'failed'
    and notification.updated_at > now() - interval '24 hours';
  if v_failure_count > 0 then
    v_message := '⚠️ *Fila de WhatsApp com falhas — Wise Wolf*' || E'\n\n' ||
      v_failure_count || ' notificação(ões) falharam nas últimas 24h. ' ||
      'Confira a integração e a fila antes de reenviar manualmente.';
    if private.enqueue_cron_health_alert(
      'QUEUE_FAILURES', 'queue', v_message, v_ref_date
    ) then
      v_sent := v_sent + 1;
    end if;
  end if;

  select count(*)
  into v_failure_count
  from public.ai_wa_messages as message
  where message.meta->>'kind' = 'ai_down'
    and message.created_at > now() - interval '24 hours';
  if v_failure_count >= 3 then
    v_message := '🤖⚠️ *IA de atendimento instável — Wise Wolf*' || E'\n\n' ||
      'A atendente não conseguiu responder ' || v_failure_count ||
      ' mensagem(ns) nas últimas 24h. Leads podem estar sem retorno; ' ||
      'confira os provedores de IA.';
    if private.enqueue_cron_health_alert(
      'AI_DOWN', 'ai', v_message, v_ref_date
    ) then
      v_sent := v_sent + 1;
    end if;
  end if;

  -- Se justamente o agendamento do worker da fila sumiu, não basta deixar o
  -- alerta parado nela. Dispare também uma execução avulsa do worker. O pedido
  -- pg_net só cruza a rede depois do commit desta transação.
  if v_sent > 0
     and pg_catalog.to_regprocedure('public.trigger_process_queue()') is not null
  then
    begin
      perform public.trigger_process_queue();
    exception when others then
      raise warning 'cron_health_queue_wakeup_failed:%', sqlstate;
    end;
  end if;

  return v_sent;
end;
$function$;

alter function public.notify_cron_failures() owner to postgres;
revoke all on function public.notify_cron_failures()
  from public, anon, authenticated;
grant execute on function public.notify_cron_failures() to service_role;

do $schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(job.jobid)
    from cron.job as job
    where job.jobname in (
      'wisewolf-cron-health',
      'wisewolf-daily-automations',
      'wisewolf-teacher-daily-agenda',
      'wisewolf-plan-change-billing',
      'wisewolf-sync-plan-change-billing'
    );

    if pg_catalog.to_regprocedure(
      'public.trigger_daily_automations()'
    ) is null then
      raise exception 'daily_automations_trigger_missing';
    end if;
    if pg_catalog.to_regprocedure(
      'public.trigger_sync_plan_change_billing()'
    ) is null then
      raise exception 'plan_change_billing_trigger_missing';
    end if;

    perform cron.schedule(
      'wisewolf-cron-health',
      '30 11,21 * * *',
      'select public.notify_cron_failures();'
    );
    perform cron.schedule(
      'wisewolf-daily-automations',
      '0 11 * * *',
      'select public.trigger_daily_automations();'
    );
    perform cron.schedule(
      'wisewolf-sync-plan-change-billing',
      '*/15 * * * *',
      'select public.trigger_sync_plan_change_billing();'
    );
  end if;
end;
$schedule$;

do $postconditions$
begin
  if not pg_catalog.has_function_privilege(
       'service_role', 'public.notify_cron_failures()', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.notify_cron_failures()', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.notify_cron_failures()', 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'private.enqueue_cron_health_alert(text,text,text,date)',
       'EXECUTE'
     )
  then
    raise exception 'cron_health_acl_postcondition_failed';
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (
       select 1
       from (
         values
           (
             'wisewolf-cron-health',
             '30 11,21 * * *',
             'select public.notify_cron_failures();'
           ),
           (
             'wisewolf-daily-automations',
             '0 11 * * *',
             'select public.trigger_daily_automations();'
           ),
           (
             'wisewolf-sync-plan-change-billing',
             '*/15 * * * *',
             'select public.trigger_sync_plan_change_billing();'
           )
       ) as expected(jobname, schedule, command)
       left join lateral (
         select
           count(*) as total_count,
           count(*) filter (
             where job.active is true
               and job.schedule = expected.schedule
               and job.command = expected.command
           ) as exact_count
         from cron.job as job
         where job.jobname = expected.jobname
       ) as actual on true
       where actual.total_count <> 1 or actual.exact_count <> 1
     )
  then
    raise exception 'cron_health_schedule_postcondition_failed';
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (
       select 1 from cron.job as job
       where job.jobname in (
         'wisewolf-teacher-daily-agenda',
         'wisewolf-plan-change-billing'
       )
     )
  then
    raise exception 'retired_duplicate_cron_still_scheduled';
  end if;
end;
$postconditions$;
