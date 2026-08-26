-- Durable Asaas inbox: duplicate delivery, provider order, retry lease and ACL.

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
  (select column_default is null
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'student_payments'
      and column_name = 'tenant_id'),
  'student_payments.tenant_id voltou a adotar escola silenciosamente'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'anon',
    'public.enqueue_asaas_webhook_event(text,text,text,timestamptz,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.enqueue_asaas_webhook_event(text,text,text,timestamptz,jsonb,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.enqueue_asaas_webhook_event(text,text,text,timestamptz,jsonb,text)',
    'EXECUTE'
  ),
  'inbox Asaas nao ficou restrita ao service_role'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_index
     where indexrelid = 'public.idx_notif_queue_idemp'::regclass
       and indisunique
  ),
  'fila de confirmacao perdeu o indice idempotente'
);

select pg_temp.assert_true(
  position(
    'pg_advisory_xact_lock' in
    pg_get_functiondef(
      'public.generate_monthly_student_payments(text,date)'::regprocedure
    )
  ) > 0
  and position(
    'ON CONFLICT' in upper(pg_get_functiondef(
      'public.generate_monthly_student_payments(text,date)'::regprocedure
    ))
  ) > 0,
  'geracao mensal nao esta atomica e idempotente por competencia'
);

-- Isola somente fixtures desta verificacao. A prioridade -infinity garante
-- claims deterministicos sem alterar nem bloquear eventos reais da fila.
delete from public.asaas_webhook_inbox
 where provider_event_id in (
   'evt_asaas_test_later',
   'evt_asaas_test_first',
   'evt_asaas_test_same_entity_after_retry',
   'evt_asaas_test_other_entity_ready',
   'evt_asaas_test_conflict'
 );
update public.asaas_automation_worker_locks
   set lease_owner = null, lease_expires_at = null
 where worker_name = 'webhook';

select public.enqueue_asaas_webhook_event(
  'evt_asaas_test_later',
  'PAYMENT_RECEIVED',
  'pay_asaas_test',
  '2026-08-25 12:00:02+00',
  '{"id":"evt_asaas_test_later","event":"PAYMENT_RECEIVED","payment":{"id":"pay_asaas_test"}}'::jsonb,
  'hash-later'
);
select public.enqueue_asaas_webhook_event(
  'evt_asaas_test_first',
  'PAYMENT_CONFIRMED',
  'pay_asaas_test',
  '2026-08-25 12:00:01+00',
  '{"id":"evt_asaas_test_first","event":"PAYMENT_CONFIRMED","payment":{"id":"pay_asaas_test"}}'::jsonb,
  'hash-first'
);

update public.asaas_webhook_inbox
   set next_attempt_at = '-infinity'::timestamptz
 where provider_event_id in (
   'evt_asaas_test_later',
   'evt_asaas_test_first'
 );
select public.enqueue_asaas_webhook_event(
  'evt_asaas_test_first',
  'PAYMENT_CONFIRMED',
  'pay_asaas_test',
  '2026-08-25 12:00:01+00',
  '{"id":"evt_asaas_test_first","event":"PAYMENT_CONFIRMED","payment":{"id":"pay_asaas_test"}}'::jsonb,
  'hash-first'
);

select pg_temp.assert_true(
  (select count(*) = 1 and max(delivery_count) = 2
     from public.asaas_webhook_inbox
    where provider_event_id = 'evt_asaas_test_first'),
  'entrega duplicada criou mais de um evento ou nao contou redelivery'
);

create temporary table claimed_event(payload jsonb);
insert into claimed_event
select public.claim_next_asaas_webhook_event(
  '00000000-0000-4000-8000-00000000a501', 240
);
select pg_temp.assert_true(
  (select payload->>'provider_event_id' = 'evt_asaas_test_first'
     from claimed_event),
  'worker nao respeitou a ordem crescente do provedor'
);

select public.finish_asaas_webhook_event(
  'evt_asaas_test_first',
  '00000000-0000-4000-8000-00000000a501',
  'PROCESSED'
);
truncate claimed_event;
insert into claimed_event
select public.claim_next_asaas_webhook_event(
  '00000000-0000-4000-8000-00000000a501', 240
);
select pg_temp.assert_true(
  (select payload->>'provider_event_id' = 'evt_asaas_test_later'
     from claimed_event),
  'segundo evento nao foi liberado apos o primeiro concluir'
);

select public.finish_asaas_webhook_event(
  'evt_asaas_test_later',
  '00000000-0000-4000-8000-00000000a501',
  'RETRY',
  'transient_test'
);
select public.release_asaas_webhook_worker(
  '00000000-0000-4000-8000-00000000a501'
);

-- Um RETRY em backoff bloqueia somente eventos posteriores da mesma entidade.
-- Outra cobrança pronta deve continuar fluindo pela fila global.
select public.enqueue_asaas_webhook_event(
  'evt_asaas_test_same_entity_after_retry',
  'PAYMENT_RECEIVED',
  'pay_asaas_test',
  '2026-08-25 12:00:03+00',
  '{"id":"evt_asaas_test_same_entity_after_retry","event":"PAYMENT_RECEIVED","payment":{"id":"pay_asaas_test"}}'::jsonb,
  'hash-same-entity-after-retry'
);
select public.enqueue_asaas_webhook_event(
  'evt_asaas_test_other_entity_ready',
  'PAYMENT_RECEIVED',
  'pay_asaas_other',
  '2026-08-25 12:00:04+00',
  '{"id":"evt_asaas_test_other_entity_ready","event":"PAYMENT_RECEIVED","payment":{"id":"pay_asaas_other"}}'::jsonb,
  'hash-other-entity-ready'
);

update public.asaas_webhook_inbox
   set next_attempt_at = '-infinity'::timestamptz
 where provider_event_id in (
   'evt_asaas_test_same_entity_after_retry',
   'evt_asaas_test_other_entity_ready'
 );

truncate claimed_event;
insert into claimed_event
select public.claim_next_asaas_webhook_event(
  '00000000-0000-4000-8000-00000000a502', 240
);
select pg_temp.assert_true(
  (select payload->>'provider_event_id' = 'evt_asaas_test_other_entity_ready'
     from claimed_event),
  'retry de uma entidade bloqueou a fila global'
);
select public.finish_asaas_webhook_event(
  'evt_asaas_test_other_entity_ready',
  '00000000-0000-4000-8000-00000000a502',
  'PROCESSED'
);
select public.release_asaas_webhook_worker(
  '00000000-0000-4000-8000-00000000a502'
);

select pg_temp.assert_true(
  (select status = 'RECEIVED'
     from public.asaas_webhook_inbox
    where provider_event_id = 'evt_asaas_test_same_entity_after_retry'),
  'evento posterior da mesma entidade ultrapassou o predecessor em backoff'
);

select public.enqueue_asaas_webhook_event(
  'evt_asaas_test_conflict',
  'PAYMENT_CREATED',
  'pay_conflict',
  now(),
  '{"id":"evt_asaas_test_conflict","event":"PAYMENT_CREATED","payment":{"id":"pay_conflict","value":10}}'::jsonb,
  'hash-a'
);
select public.enqueue_asaas_webhook_event(
  'evt_asaas_test_conflict',
  'PAYMENT_CREATED',
  'pay_conflict',
  now(),
  '{"id":"evt_asaas_test_conflict","event":"PAYMENT_CREATED","payment":{"id":"pay_conflict","value":999}}'::jsonb,
  'hash-b'
);
select pg_temp.assert_true(
  (select status = 'TRIAGE' and last_error = 'duplicate_event_id_payload_mismatch'
     from public.asaas_webhook_inbox
    where provider_event_id = 'evt_asaas_test_conflict'),
  'mesmo event.id com payload divergente nao foi isolado para triagem'
);

-- Health alerts are daily and transactionally deduplicated.
insert into public.automation_sent (kind, subject_id, ref_date)
values ('ASAAS_HEALTH_TEST', 'school-wise-wolf', current_date)
on conflict (kind, subject_id, ref_date) do nothing;
insert into public.automation_sent (kind, subject_id, ref_date)
values ('ASAAS_HEALTH_TEST', 'school-wise-wolf', current_date)
on conflict (kind, subject_id, ref_date) do nothing;
select pg_temp.assert_true(
  (select count(*) = 1
     from public.automation_sent
    where kind = 'ASAAS_HEALTH_TEST'
      and subject_id = 'school-wise-wolf'
      and ref_date = current_date),
  'alerta de saude Asaas nao ficou deduplicado por dia'
);

select pg_temp.assert_true(
  position(
    'pg_try_advisory_xact_lock' in
    pg_get_functiondef('private.notify_asaas_automation_health()'::regprocedure)
  ) > 0,
  'notificador de saude Asaas nao possui advisory lock'
);

-- O POST PIX precisa nascer exclusivamente do snapshot imutavel retornado
-- pelo claim; a chave bruta nao pode ser lida diretamente pelo service_role.
select pg_temp.assert_true(
  exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'asaas_teacher_transfer_attempts'
       and column_name = 'destination_pix_key'
  )
  and exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'asaas_teacher_transfer_attempts'
       and column_name = 'destination_pix_key_type'
  )
  and exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'asaas_teacher_transfer_attempts'
       and column_name = 'destination_fingerprint'
  )
  and exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'asaas_teacher_transfer_attempts'
       and column_name = 'transfer_description'
  ),
  'tentativa PIX nao possui snapshot duravel completo do destino'
);

select pg_temp.assert_true(
  not has_column_privilege(
    'service_role',
    'public.asaas_teacher_transfer_attempts',
    'destination_pix_key',
    'SELECT'
  )
  and has_column_privilege(
    'service_role',
    'public.asaas_teacher_transfer_attempts',
    'destination_fingerprint',
    'SELECT'
  ),
  'chave PIX bruta vazou na leitura direta ou fingerprint ficou indisponivel'
);

select pg_temp.assert_true(
  position(
    '''expected_amount'', attempt_row.expected_amount' in
    pg_get_functiondef(
      'public.claim_asaas_teacher_transfer(uuid,uuid,uuid)'::regprocedure
    )
  ) > 0
  and position(
    '''destination_pix_key'', attempt_row.destination_pix_key' in
    pg_get_functiondef(
      'public.claim_asaas_teacher_transfer(uuid,uuid,uuid)'::regprocedure
    )
  ) > 0
  and position(
    '''destination_fingerprint'', attempt_row.destination_fingerprint' in
    pg_get_functiondef(
      'public.claim_asaas_teacher_transfer(uuid,uuid,uuid)'::regprocedure
    )
  ) > 0,
  'claim PIX nao retorna exclusivamente o snapshot duravel esperado'
);

select pg_temp.assert_true(
  not exists (select 1 from pg_extension where extname = 'pg_cron')
  or not exists (
    select 1
      from (
        values
          (
            'wisewolf-asaas-webhook-worker',
            '* * * * *',
            'select private.trigger_asaas_automation_worker();'
          ),
          (
            'wisewolf-asaas-reconciliation',
            '17 6 * * *',
            'select private.trigger_asaas_reconciliation();'
          ),
          (
            'wisewolf-asaas-health',
            '*/15 * * * *',
            'select private.notify_asaas_automation_health();'
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
  'cron Asaas central ausente, duplicado, inativo ou com schedule/comando divergente'
);

rollback;
