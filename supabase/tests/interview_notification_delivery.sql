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
  pg_catalog.to_regprocedure(
    'public.enqueue_interview_notification(uuid,timestamp with time zone,text,text,text,text)'
  ) is not null
  and pg_catalog.to_regprocedure(
    'public.book_interview_slot_with_notifications(uuid,timestamp with time zone,text,text,text)'
  ) is not null,
  'interview notification RPCs are missing'
);

select pg_temp.assert_true(
  pg_catalog.has_function_privilege(
    'service_role',
    'public.enqueue_interview_notification(uuid,timestamp with time zone,text,text,text,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.book_interview_slot_with_notifications(uuid,timestamp with time zone,text,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.enqueue_interview_notification(uuid,timestamp with time zone,text,text,text,text)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.book_interview_slot_with_notifications(uuid,timestamp with time zone,text,text,text)',
    'EXECUTE'
  ),
  'interview outbox RPCs are not service-only'
);

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"00000000-0000-4000-8000-000000000001"}',
  true
);

insert into public.tenants (id, name, tenant_type)
values ('interview-notification-test', 'Interview Notification Test', 'school');

insert into public.job_applications (
  id,
  tenant_id,
  name,
  whatsapp,
  status,
  source,
  role,
  booking_token
) values
  (
    '10000000-0000-4000-8000-000000000001',
    'interview-notification-test',
    'Candidata Um',
    '11988887001',
    'Novo',
    'migration_test',
    'professor',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'interview-notification-test',
    'Candidato Dois',
    '5511988887002',
    'Novo',
    'migration_test',
    'professor',
    '20000000-0000-4000-8000-000000000002'
  );

set local role service_role;

select pg_temp.assert_true(
  (
    public.book_interview_slot_with_notifications(
      '20000000-0000-4000-8000-000000000001',
      pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 16 hours 17 minutes',
      'Confirmação para a candidata',
      '5511977777001',
      'Confirmação para a gestão'
    ) ->> 'ok'
  )::boolean,
  'booking and outbox were not persisted atomically'
);

select pg_temp.assert_true(
  (
    select application.interview_slot =
      pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 16 hours 17 minutes'
    from public.job_applications as application
    where application.id = '10000000-0000-4000-8000-000000000001'
  )
  and (
    select count(*) = 2
      and count(distinct queue.notification_kind) = 2
      and bool_and(queue.status = 'pending')
      and bool_and(queue.delivery_status = 'queued')
      and bool_and(queue.idempotency_key is not null)
      and bool_or(
        queue.notification_kind = 'INTERVIEW_BOOKED_CANDIDATE'
        and queue.student_phone = '5511988887001'
      )
    from public.notification_queue as queue
    where queue.source_id = '10000000-0000-4000-8000-000000000001'
      and queue.notification_kind in (
        'INTERVIEW_BOOKED_CANDIDATE',
        'INTERVIEW_BOOKED_MANAGEMENT'
      )
  ),
  'booking did not create one durable row per audience'
);

select pg_temp.assert_true(
  public.book_interview_slot_with_notifications(
    '20000000-0000-4000-8000-000000000001',
    pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 16 hours 17 minutes',
    'Confirmação para a candidata',
    '5511977777001',
    'Confirmação para a gestão'
  ) ->> 'reason' = 'already_booked'
  and (
    select count(*) = 2
    from public.notification_queue as queue
    where queue.source_id = '10000000-0000-4000-8000-000000000001'
      and queue.notification_kind like 'INTERVIEW_BOOKED_%'
  ),
  'booking retry duplicated its outbox'
);

select pg_temp.assert_true(
  public.book_interview_slot_with_notifications(
    '20000000-0000-4000-8000-000000000002',
    pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 16 hours 17 minutes',
    'Confirmação para o candidato',
    '5511977777001',
    'Confirmação para a gestão'
  ) ->> 'reason' = 'taken'
  and (
    select application.interview_slot is null
    from public.job_applications as application
    where application.id = '10000000-0000-4000-8000-000000000002'
  )
  and not exists (
    select 1
    from public.notification_queue as queue
    where queue.source_id = '10000000-0000-4000-8000-000000000002'
  ),
  'losing a slot race left a reservation or orphaned outbox'
);

do $$
begin
  perform public.book_interview_slot_with_notifications(
    '20000000-0000-4000-8000-000000000002',
    pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 17 hours 17 minutes',
    'Confirmação para o candidato',
    null,
    'Confirmação para a gestão'
  );
  raise exception 'assertion failed: booking without management outbox succeeded';
exception
  when check_violation then
    null;
end;
$$;

select pg_temp.assert_true(
  (
    select application.interview_slot is null
    from public.job_applications as application
    where application.id = '10000000-0000-4000-8000-000000000002'
  )
  and not exists (
    select 1
    from public.notification_queue as queue
    where queue.source_id = '10000000-0000-4000-8000-000000000002'
  ),
  'missing management destination left a partial booking or outbox'
);

select pg_temp.assert_true(
  (
    public.enqueue_interview_notification(
      '10000000-0000-4000-8000-000000000001',
      pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 16 hours 17 minutes',
      'REMINDER',
      'CANDIDATE',
      '5511988887001',
      'Lembrete para a candidata'
    ) ->> 'queued'
  )::boolean
  and (
    public.enqueue_interview_notification(
      '10000000-0000-4000-8000-000000000001',
      pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 16 hours 17 minutes',
      'REMINDER',
      'CANDIDATE',
      '5511988887001',
      'Lembrete para a candidata'
    ) ->> 'duplicate'
  )::boolean,
  'candidate reminder is not idempotent'
);

select pg_temp.assert_true(
  (
    public.enqueue_interview_notification(
      '10000000-0000-4000-8000-000000000001',
      pg_catalog.date_trunc('day', pg_catalog.now()) + interval '5 days 16 hours 17 minutes',
      'REMINDER',
      'MANAGEMENT',
      '5511977777001',
      'Lembrete para a gestão'
    ) ->> 'queued'
  )::boolean
  ,
  'management reminder was not queued'
);

select pg_temp.assert_true(
  (
    select count(*) = 4
      and count(distinct queue.notification_kind) = 4
      and count(distinct queue.idempotency_key) = 4
    from public.notification_queue as queue
    where queue.source_id = '10000000-0000-4000-8000-000000000001'
      and queue.notification_kind like 'INTERVIEW_%'
  ),
  'management reminder was conflated with the candidate audience'
);

reset role;
rollback;
