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
  to_regprocedure(
    'public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'
  ) is not null
  and has_function_privilege(
    'service_role',
    'public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.mark_notification_delivery_submitting(uuid,uuid,text)',
    'EXECUTE'
  )
  and to_regprocedure(
    'public.recover_notification_delivery_submission(uuid,uuid,uuid,uuid,text,uuid,bigint)'
  ) is not null
  and has_function_privilege(
    'service_role',
    'public.recover_notification_delivery_submission(uuid,uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.recover_notification_delivery_submission(uuid,uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  )
  and (
    select procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']::text[]
      and pg_get_userbyid(procedure.proowner) = 'postgres'
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure
  ),
  'RPC atomica de submissao generica nao ficou service-only/definer'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from unnest(array[
      'notification_id', 'notification_claim_token', 'receipt_state'
    ]) as expected(column_name)
    where not exists (
      select 1
      from information_schema.columns as definition
      where definition.table_schema = 'public'
        and definition.table_name = 'automation_sent'
        and definition.column_name = expected.column_name
    )
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.notification_queue'::regclass
      and tgname = 'notification_queue_canonicalize_kind'
      and not tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.notification_queue'::regclass
      and tgname = 'notification_queue_sync_lesson_receipt'
      and not tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::regclass
      and conname = 'notification_queue_submitting_binding_check'
      and convalidated
      and pg_get_constraintdef(oid) like '%provider_destination%'
  ),
  'schema/trigger do receipt fence esta incompleto'
);

select pg_temp.assert_true(
  private.render_conflict_teacher_alert_message(
    'Ana Paula',
    'Bruno Souza',
    date '2026-08-28',
    '19:30:45'
  ) = E'Oi, Ana! Aqui é da coordenação da escola.\n\nRecebemos uma divergência sobre a aula de 28/08 às 19:30 com Bruno Souza.\nPode nos contar como foi essa aula? Enquanto analisamos, somente esta aula fica em revisão.',
  'renderer SQL do conflito divergiu do contrato TypeScript'
);

set local request.jwt.claims = '{"role":"service_role"}';

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values (
  'whatsapp-occurrence-test',
  'WhatsApp Occurrence Test',
  'whatsapp-occurrence-test',
  'active',
  true
);

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-00000000aa01',
  'authenticated', 'authenticated', 'wa-occurrence@example.invalid',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Occurrence Admin"}', now(), now()
);

update public.profiles
set tenant_id = 'whatsapp-occurrence-test',
    role = 'SCHOOL_ADMIN',
    lifecycle_status = 'active',
    full_name = 'Occurrence Admin',
    phone = '5511999990401'
where id = '00000000-0000-4000-8000-00000000aa01';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values (
  '00000000-0000-4000-8000-00000000aa01',
  'whatsapp-occurrence-test', 'SCHOOL_ADMIN', 'ACTIVE', true
)
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values (
  '00000000-0000-4000-8000-00000000aa01',
  'whatsapp-occurrence-test'
);

insert into public.whatsapp_instances (
  user_id, tenant_id, instance_name, instance_id, status
) values (
  '00000000-0000-4000-8000-00000000aa01',
  'whatsapp-occurrence-test',
  'wa-occurrence-instance', 'wa-occurrence-provider', 'connected'
);

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000aa02',
    'authenticated', 'authenticated', 'wa-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Occurrence Teacher"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-00000000aa03',
    'authenticated', 'authenticated', 'wa-student@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Occurrence Student"}', now(), now()
  );

update public.profiles
set tenant_id = 'whatsapp-occurrence-test',
    role = 'TEACHER',
    lifecycle_status = 'active',
    full_name = 'Occurrence Teacher',
    phone = '5511999990410',
    meeting_link = 'https://meet.example.invalid/occurrence',
    date_automation_enabled = true,
    lesson_reminder_template = null,
    is_test_account = false
where id = '00000000-0000-4000-8000-00000000aa02';

update public.profiles
set tenant_id = 'whatsapp-occurrence-test',
    role = 'STUDENT',
    lifecycle_status = 'active',
    full_name = 'Occurrence Student',
    phone = '5511988880490',
    attendance_phone = '5511988880490',
    is_test_account = false
where id = '00000000-0000-4000-8000-00000000aa03';

insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '00000000-0000-4000-8000-00000000aa02',
    'whatsapp-occurrence-test', 'TEACHER', 'ACTIVE', true
  ),
  (
    '00000000-0000-4000-8000-00000000aa03',
    'whatsapp-occurrence-test', 'STUDENT', 'ACTIVE', true
  )
on conflict (user_id, tenant_id) do update
set role = excluded.role,
    status = excluded.status,
    is_primary = excluded.is_primary;

insert into public.appointments (
  id, professor_id, teacher_id, student_name, student_phone,
  start_time, status, type, tenant_id
) values
  (
    '00000000-0000-4000-8000-00000000ac01',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa02',
    'Aluno Um', '5511988880401', now() + interval '30 minutes',
    'scheduled', 'experimental', 'whatsapp-occurrence-test'
  ),
  (
    '00000000-0000-4000-8000-00000000ac02',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa02',
    'Aluno Dois', '5511988880402', now() + interval '30 minutes',
    'scheduled', 'experimental', 'whatsapp-occurrence-test'
  ),
  (
    '00000000-0000-4000-8000-00000000ac03',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa02',
    'Aluno Tres', '5511988880403', now() + interval '30 minutes',
    'scheduled', 'experimental', 'whatsapp-occurrence-test'
  ),
  (
    '00000000-0000-4000-8000-00000000ac04',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa02',
    'Aluno Quatro', '5511988880404', now() + interval '30 minutes',
    'scheduled', 'experimental', 'whatsapp-occurrence-test'
  );

-- Wrong token is a no-op; the exact token seals one receipt and provider
-- binding before the POST. A definitive rejection releases that receipt.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, notification_kind,
  source_id, source_type, class_date, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ab01',
  'whatsapp-occurrence-test', '5511988880401', 'lesson one',
  ' lesson_reminder ', '00000000-0000-4000-8000-00000000ac01',
  'appointment',
  ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date,
  now(), 'pending', 0, now(), 'queued', 5,
  'occurrence-one'
);

select pg_temp.assert_true(
  (
    select notification_kind = 'LESSON_REMINDER'
    from public.notification_queue
    where id = '00000000-0000-4000-8000-00000000ab01'
  ),
  'trigger nao canonizou notification_kind misto'
);

do $lesson_rejected$
declare
  v_claim public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_message text;
  v_result jsonb;
begin
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab01';

  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'whatsapp-occurrence-test'
    and instance_name = 'wa-occurrence-instance';

  select private.render_lesson_notification_message(
    null,
    'Aluno',
    pg_catalog.to_char(
      appointment.start_time at time zone 'America/Sao_Paulo',
      'HH24:MI'
    ),
    'Occurrence Teacher',
    'WhatsApp Occurrence Test',
    'https://meet.example.invalid/occurrence'
  )
  into strict v_message
  from public.appointments as appointment
  where appointment.id = '00000000-0000-4000-8000-00000000ac01';

  v_result := public.begin_notification_delivery_submission(
    v_claim.id,
    '00000000-0000-4000-8000-00000000ffff',
    'wa-occurrence-instance',
    '5511988880401',
    '5511988880401',
    v_message,
    v_integration_id,
    v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'RETRY'
      and not exists (
        select 1 from public.automation_sent
        where notification_id = v_claim.id
      )
      and (
        select delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
      ),
    'token incorreto criou receipt ou atravessou a fronteira'
  );

  v_result := public.begin_notification_delivery_submission(
    v_claim.id,
    v_claim.claim_token,
    'wa-occurrence-instance',
    '5511988880401',
    '5511988880401',
    v_message,
    v_integration_id,
    v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is true
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and (
        select delivery_status = 'submitting'
          and provider_integration_id = v_integration_id
          and provider_integration_version = v_integration_version
        from public.notification_queue where id = v_claim.id
      )
      and (
        select count(*) = 1
          and bool_and(receipt_state = 'SEALED')
          and bool_and(notification_claim_token = v_claim.claim_token)
        from public.automation_sent
        where notification_id = v_claim.id
      ),
    'receipt e queue nao foram selados atomicamente'
  );

  v_result := public.finalize_notification_delivery(
    v_claim.id, v_claim.claim_token, 'failed', null, 400,
    'provider_rejected', 0
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is true
      and not exists (
        select 1 from public.automation_sent
        where notification_id = v_claim.id
      )
      and (
        select status = 'failed' and delivery_status = 'failed'
        from public.notification_queue where id = v_claim.id
      ),
    'rejeicao definitiva nao liberou o receipt na mesma transacao'
  );
end;
$lesson_rejected$;

-- Ambiguous provider outcome and an expired SUBMITTING lease must preserve a
-- committed receipt: neither path is allowed to retry blindly.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, notification_kind,
  source_id, source_type, class_date, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values
  (
    '00000000-0000-4000-8000-00000000ab02',
    'whatsapp-occurrence-test', '5511988880402', 'lesson ambiguous',
    'LESSON_REMINDER', '00000000-0000-4000-8000-00000000ac02',
    'appointment',
    ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date,
    now(), 'pending', 0, now(), 'queued', 5,
    'occurrence-ambiguous'
  ),
  (
    '00000000-0000-4000-8000-00000000ab03',
    'whatsapp-occurrence-test', '5511988880403', 'lesson crashed',
    'LESSON_REMINDER', '00000000-0000-4000-8000-00000000ac03',
    'appointment',
    ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date,
    now() + interval '1 day',
    'pending', 0, now() + interval '1 day', 'queued', 5,
    'occurrence-crashed'
  );

do $lesson_ambiguous_and_crash$
declare
  v_claim public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_message text;
  v_result jsonb;
begin
  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'whatsapp-occurrence-test'
    and instance_name = 'wa-occurrence-instance';

  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab02';
  select private.render_lesson_notification_message(
    null, 'Aluno',
    pg_catalog.to_char(
      appointment.start_time at time zone 'America/Sao_Paulo',
      'HH24:MI'
    ),
    'Occurrence Teacher', 'WhatsApp Occurrence Test',
    'https://meet.example.invalid/occurrence'
  ) into strict v_message
  from public.appointments as appointment
  where appointment.id = '00000000-0000-4000-8000-00000000ac02';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880402', '5511988880402', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true((v_result ->> 'ok')::boolean, 'begin falhou');

  -- Repetir o mesmo begin e consultar o recovery representam uma transacao que
  -- confirmou mas cuja resposta HTTP se perdeu. Ambos devem reutilizar o mesmo
  -- receipt/snapshot, sem criar uma segunda autorizacao material.
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880402', '5511988880402', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and (
        select count(*) = 1
        from public.automation_sent
        where notification_id = v_claim.id
      ),
    'replay idempotente do begin criou novo receipt ou perdeu autorizacao'
  );
  v_result := public.recover_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, null, null,
    'wa-occurrence-instance', v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and v_result ->> 'providerDestination' = '5511988880402'
      and v_result ->> 'messageBody' = v_message,
    'recovery nao recuperou o snapshot genericamente selado'
  );
  v_result := public.finalize_notification_delivery(
    v_claim.id, v_claim.claim_token, 'uncertain', null, 503,
    'provider_timeout_ambiguous', 0
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and (
        select receipt_state = 'COMMITTED'
          and notification_claim_token is null
        from public.automation_sent where notification_id = v_claim.id
      )
      and (
        select delivery_status = 'uncertain' and claim_token is null
        from public.notification_queue where id = v_claim.id
      ),
    'resultado ambiguo liberou ou deixou SEALED o receipt'
  );

  update public.notification_queue
  set scheduled_for = now(),
      next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ab03';

  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab03';
  select private.render_lesson_notification_message(
    null, 'Aluno',
    pg_catalog.to_char(
      appointment.start_time at time zone 'America/Sao_Paulo',
      'HH24:MI'
    ),
    'Occurrence Teacher', 'WhatsApp Occurrence Test',
    'https://meet.example.invalid/occurrence'
  ) into strict v_message
  from public.appointments as appointment
  where appointment.id = '00000000-0000-4000-8000-00000000ac03';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880403', '5511988880403', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true((v_result ->> 'ok')::boolean, 'begin falhou');
  update public.notification_queue
  set lease_expires_at = now() - interval '1 second'
  where id = v_claim.id;
  perform count(*) from public.claim_notification_delivery_batch(200, 300);
  perform pg_temp.assert_true(
    (
      select delivery_status = 'uncertain' and claim_token is null
      from public.notification_queue where id = v_claim.id
    )
      and (
        select receipt_state = 'COMMITTED'
          and notification_claim_token is null
        from public.automation_sent where notification_id = v_claim.id
      ),
    'crash apos SUBMITTING nao preservou receipt/estado incerto'
  );
end;
$lesson_ambiguous_and_crash$;

-- A receipt manual/legacy committed wins the unique occurrence identity and
-- atomically skips the queue without ever entering SUBMITTING.
insert into public.automation_sent (kind, subject_id, ref_date)
values (
  'CLASS_REMINDER',
  'whatsapp-occurrence-test:APPOINTMENT:00000000-0000-4000-8000-00000000ac04',
  ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date
);

insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, notification_kind,
  source_id, source_type, class_date, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ab04',
  'whatsapp-occurrence-test', '5511988880404', 'lesson duplicate',
  'LESSON_REMINDER', '00000000-0000-4000-8000-00000000ac04',
  'appointment',
  ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date,
  now(), 'pending', 0, now(), 'queued', 5,
  'occurrence-duplicate'
);

do $lesson_duplicate$
declare
  v_claim public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_message text;
  v_result jsonb;
begin
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab04';
  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'whatsapp-occurrence-test'
    and instance_name = 'wa-occurrence-instance';
  select private.render_lesson_notification_message(
    null, 'Aluno',
    pg_catalog.to_char(
      appointment.start_time at time zone 'America/Sao_Paulo',
      'HH24:MI'
    ),
    'Occurrence Teacher', 'WhatsApp Occurrence Test',
    'https://meet.example.invalid/occurrence'
  ) into strict v_message
  from public.appointments as appointment
  where appointment.id = '00000000-0000-4000-8000-00000000ac04';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880404', '5511988880404', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'ALREADY_NOTIFIED'
      and (
        select status = 'skipped'
          and delivery_status = 'skipped'
          and claim_token is null
        from public.notification_queue where id = v_claim.id
      )
      and (
        select count(*) = 1 and bool_and(receipt_state = 'COMMITTED')
        from public.automation_sent
        where kind = 'CLASS_REMINDER'
          and subject_id =
            'whatsapp-occurrence-test:APPOINTMENT:00000000-0000-4000-8000-00000000ac04'
          and ref_date = (
            (now() + interval '30 minutes') at time zone
              'America/Sao_Paulo'
          )::date
      ),
    'receipt legado nao suprimiu atomicamente a fila duplicada'
  );
end;
$lesson_duplicate$;

-- The legacy marker cannot cross the provider boundary because it does not
-- carry the immutable integration binding required by the schema.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, notification_kind,
  source_id, source_type, class_date, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ab05',
  'whatsapp-occurrence-test', '5511988880405', 'old worker fixture',
  'LESSON_REMINDER', '00000000-0000-4000-8000-00000000ac05',
  'booking', current_date, timestamptz '2000-01-01 00:00:00+00',
  'pending', 0, timestamptz '2000-01-01 00:00:00+00', 'queued', 5,
  'occurrence-old-worker'
);

set local role service_role;
do $old_worker_fails_closed$
declare
  v_claim public.notification_queue%rowtype;
begin
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab05';
  begin
    perform public.mark_notification_delivery_submitting(
      v_claim.id, v_claim.claim_token, 'wa-occurrence-instance'
    );
    raise exception 'expected old marker to fail closed';
  exception
    when insufficient_privilege then null;
  end;
  perform pg_temp.assert_true(
    (
      select delivery_status = 'preparing'
        and provider_integration_id is null
      from public.notification_queue where id = v_claim.id
    )
      and not exists (
        select 1 from public.automation_sent where notification_id = v_claim.id
      ),
    'worker antigo atravessou a fronteira sem binding/receipt'
  );
end;
$old_worker_fails_closed$;
reset role;

-- Payment confirmations are deliberately rejected by the generic RPC.
insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, notification_kind,
  scheduled_for, status, attempts, next_attempt_at, delivery_status,
  max_attempts, idempotency_key
) values (
  '00000000-0000-4000-8000-00000000ab06',
  'whatsapp-occurrence-test', '5511988880406', 'payment generic block',
  ' payment_confirmed ', timestamptz '2000-01-01 00:00:00+00',
  'pending', 0, timestamptz '2000-01-01 00:00:00+00', 'queued', 5,
  'payment-generic-block'
);

do $payment_generic_block$
declare
  v_claim public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_result jsonb;
begin
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab06';
  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'whatsapp-occurrence-test'
    and instance_name = 'wa-occurrence-instance';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880406', '5511988880406', 'payment generic block',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'USE_PAYMENT_BRIDGE'
      and (
        select notification_kind = 'PAYMENT_CONFIRMED'
          and delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
    ),
    'confirmacao financeira atravessou a RPC generica'
  );

  update public.notification_queue
  set delivery_status = 'submitting',
      provider_instance_name = 'wa-occurrence-instance',
      provider_destination = '5511988880406',
      provider_integration_id = v_integration_id,
      provider_integration_version = v_integration_version,
      lease_expires_at = now() + interval '5 minutes'
  where id = v_claim.id;
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880406', '5511988880406', 'payment generic block',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'USE_PAYMENT_BRIDGE'
      and (
        select delivery_status = 'submitting'
        from public.notification_queue where id = v_claim.id
      ),
    'replay financeiro SUBMITTING atravessou a RPC generica'
  );
end;
$payment_generic_block$;

-- A preparacao fora da transacao nao e autoridade. Se a fonte ou o destino
-- mudar antes do begin, BOOKING, RESCHEDULE e APPOINTMENT devem falhar sem
-- selar receipt e sem entrar em SUBMITTING.
insert into public.bookings (
  id, tenant_id, teacher_id, student_id, day_of_week, time_slot,
  date, start_date, status
) values (
  '00000000-0000-4000-8000-00000000ac11',
  'whatsapp-occurrence-test',
  '00000000-0000-4000-8000-00000000aa02',
  '00000000-0000-4000-8000-00000000aa03',
  case extract(
    dow from ((now() + interval '30 minutes') at time zone
      'America/Sao_Paulo')::date
  )::integer
    when 0 then 'Domingo'
    when 1 then 'Segunda'
    when 2 then 'Terça'
    when 3 then 'Quarta'
    when 4 then 'Quinta'
    when 5 then 'Sexta'
    else 'Sábado'
  end,
  pg_catalog.to_char(
    (now() + interval '30 minutes') at time zone 'America/Sao_Paulo',
    'HH24:MI'
  ),
  ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date,
  ((now() + interval '30 minutes') at time zone 'America/Sao_Paulo')::date,
  'SCHEDULED'
);

insert into public.reschedules (
  id, tenant_id, teacher_id, student_id, date, time, used_at
) values (
  '00000000-0000-4000-8000-00000000ac12',
  'whatsapp-occurrence-test',
  '00000000-0000-4000-8000-00000000aa02',
  '00000000-0000-4000-8000-00000000aa03',
  ((now() + interval '30 minutes') at time zone
    'America/Sao_Paulo')::date::text,
  pg_catalog.to_char(
    (now() + interval '30 minutes') at time zone 'America/Sao_Paulo',
    'HH24:MI'
  ),
  null
);

insert into public.appointments (
  id, professor_id, teacher_id, student_name, student_phone,
  start_time, status, type, tenant_id
) values (
  '00000000-0000-4000-8000-00000000ac13',
  '00000000-0000-4000-8000-00000000aa02',
  '00000000-0000-4000-8000-00000000aa02',
  'Aluno Mutavel', '5511988880413', now() + interval '30 minutes',
  'scheduled', 'experimental', 'whatsapp-occurrence-test'
);

insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, notification_kind,
  source_id, source_type, class_date, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
) values
  (
    '00000000-0000-4000-8000-00000000ab11',
    'whatsapp-occurrence-test', '5511988880490', 'booking prepared',
    'LESSON_REMINDER', '00000000-0000-4000-8000-00000000ac11',
    'booking',
    ((now() + interval '30 minutes') at time zone
      'America/Sao_Paulo')::date,
    now(), 'pending', 0, now(), 'queued', 5, 'occurrence-stale-booking'
  ),
  (
    '00000000-0000-4000-8000-00000000ab12',
    'whatsapp-occurrence-test', '5511988880490', 'reschedule prepared',
    'LESSON_REMINDER', '00000000-0000-4000-8000-00000000ac12',
    'reschedule',
    ((now() + interval '30 minutes') at time zone
      'America/Sao_Paulo')::date,
    now() + interval '1 day', 'pending', 0, now() + interval '1 day',
    'queued', 5, 'occurrence-stale-reschedule'
  ),
  (
    '00000000-0000-4000-8000-00000000ab13',
    'whatsapp-occurrence-test', '5511988880413', 'appointment prepared',
    'LESSON_REMINDER', '00000000-0000-4000-8000-00000000ac13',
    'appointment',
    ((now() + interval '30 minutes') at time zone
      'America/Sao_Paulo')::date,
    now() + interval '1 day', 'pending', 0, now() + interval '1 day',
    'queued', 5, 'occurrence-stale-appointment'
  );

do $occurrence_snapshot_revalidation$
declare
  v_claim public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_message text;
  v_result jsonb;
begin
  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'whatsapp-occurrence-test'
    and instance_name = 'wa-occurrence-instance';

  v_message := private.render_lesson_notification_message(
    null, 'Occurrence',
    pg_catalog.to_char(
      (now() + interval '30 minutes') at time zone 'America/Sao_Paulo',
      'HH24:MI'
    ),
    'Occurrence Teacher', 'WhatsApp Occurrence Test',
    'https://meet.example.invalid/occurrence'
  );
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab11';
  update public.bookings set status = 'CANCELLED'
  where id = '00000000-0000-4000-8000-00000000ac11';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880490', '5511988880490', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'booking_occurrence_changed'
      and not exists (
        select 1 from public.automation_sent
        where notification_id = v_claim.id
      ),
    'booking cancelado entre prepare/begin foi autorizado'
  );

  update public.notification_queue
  set scheduled_for = now(), next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ab12';
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab12';
  update public.reschedules set used_at = now()
  where id = '00000000-0000-4000-8000-00000000ac12';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880490', '5511988880490', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'reschedule_occurrence_changed'
      and not exists (
        select 1 from public.automation_sent
        where notification_id = v_claim.id
      ),
    'reposicao usada entre prepare/begin foi autorizada'
  );

  update public.notification_queue
  set scheduled_for = now(), next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ab13';
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ab13';
  select private.render_lesson_notification_message(
    null, 'Aluno',
    pg_catalog.to_char(
      appointment.start_time at time zone 'America/Sao_Paulo',
      'HH24:MI'
    ),
    'Occurrence Teacher', 'WhatsApp Occurrence Test',
    'https://meet.example.invalid/occurrence'
  ) into strict v_message
  from public.appointments as appointment
  where appointment.id = '00000000-0000-4000-8000-00000000ac13';
  update public.appointments
  set start_time = start_time + interval '5 minutes',
      student_phone = '5511988880999'
  where id = '00000000-0000-4000-8000-00000000ac13';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511988880413', '5511988880413', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'lesson_authorized_snapshot_changed'
      and not exists (
        select 1 from public.automation_sent
        where notification_id = v_claim.id
      ),
    'appointment alterado entre prepare/begin foi autorizado'
  );
end;
$occurrence_snapshot_revalidation$;

-- A conflict alert is authorized from the locked attendance/profile snapshot,
-- never from the mutable payload prepared by the Edge worker. These fixtures
-- model a resolver or editor committing after PREPARING was claimed but before
-- the atomic begin RPC reaches the provider boundary.
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name, student_phone,
  teacher_name, class_date, class_time, token, token_expires_at,
  status, student_response, responded_at, response_updated_at,
  response_editable_until
)
values
  (
    '00000000-0000-4000-8000-00000000ad01',
    'whatsapp-occurrence-test',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa03',
    'Aluno Conflito Valido', '5511988880490', 'Occurrence Teacher',
    current_date, '18:01', 'occurrence-conflict-token-01',
    now() + interval '7 days', 'CONFLICT', 'TEACHER_NO_SHOW',
    now() - interval '31 minutes', now() - interval '31 minutes',
    now() - interval '1 minute'
  ),
  (
    '00000000-0000-4000-8000-00000000ad02',
    'whatsapp-occurrence-test',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa03',
    'Aluno Conflito Resolvido', '5511988880490', 'Occurrence Teacher',
    current_date, '18:02', 'occurrence-conflict-token-02',
    now() + interval '7 days', 'CONFLICT', 'TEACHER_NO_SHOW',
    now() - interval '31 minutes', now() - interval '31 minutes',
    now() - interval '1 minute'
  ),
  (
    '00000000-0000-4000-8000-00000000ad03',
    'whatsapp-occurrence-test',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa03',
    'Aluno Antes da Edicao', '5511988880490', 'Occurrence Teacher',
    current_date, '18:03', 'occurrence-conflict-token-03',
    now() + interval '7 days', 'CONFLICT', 'TEACHER_NO_SHOW',
    now() - interval '31 minutes', now() - interval '31 minutes',
    now() - interval '1 minute'
  ),
  (
    '00000000-0000-4000-8000-00000000ad04',
    'whatsapp-occurrence-test',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa03',
    'Aluno Destino Alterado', '5511988880490', 'Occurrence Teacher',
    current_date, '18:04', 'occurrence-conflict-token-04',
    now() + interval '7 days', 'CONFLICT', 'TEACHER_NO_SHOW',
    now() - interval '31 minutes', now() - interval '31 minutes',
    now() - interval '1 minute'
  ),
  (
    '00000000-0000-4000-8000-00000000ad05',
    'whatsapp-occurrence-test',
    '00000000-0000-4000-8000-00000000aa02',
    '00000000-0000-4000-8000-00000000aa03',
    'Aluno Janela Aberta', '5511988880490', 'Occurrence Teacher',
    current_date, '18:05', 'occurrence-conflict-token-05',
    now() + interval '7 days', 'CONFLICT', 'TEACHER_NO_SHOW',
    now() - interval '1 minute', now() - interval '1 minute',
    now() + interval '29 minutes'
  );

insert into public.notification_queue (
  id, tenant_id, student_id, student_phone, message_body,
  notification_kind, source_id, source_type, class_date,
  scheduled_for, status, attempts, next_attempt_at, delivery_status,
  max_attempts, idempotency_key
)
select
  fixture.queue_id,
  'whatsapp-occurrence-test',
  '00000000-0000-4000-8000-00000000aa03',
  '5511999990410',
  private.render_conflict_teacher_alert_message(
    'Occurrence Teacher',
    confirmation.student_name,
    confirmation.class_date,
    confirmation.class_time
  ),
  'CONFLICT_TEACHER_ALERT', confirmation.id,
  'attendance_confirmation', confirmation.class_date,
  now() + interval '1 day', 'pending', 0, now() + interval '1 day',
  'queued', 5, fixture.idempotency_key
from (values
  (
    '00000000-0000-4000-8000-00000000ae01'::uuid,
    '00000000-0000-4000-8000-00000000ad01'::uuid,
    'occurrence-conflict-valid'
  ),
  (
    '00000000-0000-4000-8000-00000000ae02'::uuid,
    '00000000-0000-4000-8000-00000000ad02'::uuid,
    'occurrence-conflict-resolved'
  ),
  (
    '00000000-0000-4000-8000-00000000ae03'::uuid,
    '00000000-0000-4000-8000-00000000ad03'::uuid,
    'occurrence-conflict-message-edited'
  ),
  (
    '00000000-0000-4000-8000-00000000ae04'::uuid,
    '00000000-0000-4000-8000-00000000ad04'::uuid,
    'occurrence-conflict-destination-edited'
  ),
  (
    '00000000-0000-4000-8000-00000000ae05'::uuid,
    '00000000-0000-4000-8000-00000000ad05'::uuid,
    'occurrence-conflict-window-open'
  )
) as fixture(queue_id, confirmation_id, idempotency_key)
join public.attendance_confirmations as confirmation
  on confirmation.id = fixture.confirmation_id;

do $conflict_snapshot_revalidation$
declare
  v_claim public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_message text;
  v_result jsonb;
begin
  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'whatsapp-occurrence-test'
    and instance_name = 'wa-occurrence-instance';

  -- A mature, unresolved canonical conflict proves the positive path and the
  -- exact accented message shared with the TypeScript renderer.
  update public.notification_queue
  set scheduled_for = now(), next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ae01';
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ae01';
  select message_body into strict v_message
  from public.notification_queue where id = v_claim.id;
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511999990410', '5511999990410', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and v_result ->> 'messageBody' = v_message
      and v_message like '%Aqui é da coordenação%'
      and v_message like '% às 18:01%'
      and (
        select delivery_status = 'submitting'
          and student_phone = '5511999990410'
          and message_body = v_message
        from public.notification_queue where id = v_claim.id
      ),
    'conflito valido nao preservou destino/mensagem canonicos'
  );

  -- If the first begin committed but its response was lost, an exact replay
  -- must still observe a resolution committed before the provider POST.
  update public.attendance_confirmations
  set status = 'RESOLVED_PAID',
      resolution_verdict = 'TEACHER_PRESENT',
      resolved_at = now()
  where id = '00000000-0000-4000-8000-00000000ad01';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511999990410', '5511999990410', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'REVIEW_REQUIRED'
      and v_result ->> 'reason' = 'attendance_conflict_changed'
      and (
        select delivery_status = 'submitting'
        from public.notification_queue where id = v_claim.id
    ),
    'replay do begin autorizou conflito resolvido apos resposta perdida'
  );
  v_result := public.recover_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, null, null,
    'wa-occurrence-instance', v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'REVIEW_REQUIRED'
      and v_result ->> 'reason' = 'attendance_conflict_changed',
    'recovery autorizou conflito resolvido apos respostas perdidas'
  );

  -- Restoring the same authoritative state proves an unchanged exact replay
  -- remains idempotent and does not create a second material authorization.
  update public.attendance_confirmations
  set status = 'CONFLICT', resolution_verdict = null, resolved_at = null
  where id = '00000000-0000-4000-8000-00000000ad01';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511999990410', '5511999990410', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and v_result ->> 'messageBody' = v_message,
    'replay idempotente do conflito inalterado deixou de ser autorizado'
  );
  v_result := public.recover_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, null, null,
    'wa-occurrence-instance', v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and v_result ->> 'messageBody' = v_message,
    'recovery do conflito inalterado deixou de ser autorizado'
  );
  v_result := public.finalize_notification_delivery(
    v_claim.id, v_claim.claim_token, 'failed', null, 400,
    'provider_rejected', 0
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean,
    'fixture de conflito valido nao foi finalizada'
  );

  -- A resolver wins after PREPARING. The stale alert must remain before the
  -- provider boundary even though pending-only cancellation can no longer see it.
  update public.notification_queue
  set scheduled_for = now(), next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ae02';
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ae02';
  select message_body into strict v_message
  from public.notification_queue where id = v_claim.id;
  update public.attendance_confirmations
  set status = 'RESOLVED_PAID',
      resolution_verdict = 'TEACHER_PRESENT',
      resolved_at = now()
  where id = '00000000-0000-4000-8000-00000000ad02';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511999990410', '5511999990410', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'REVIEW_REQUIRED'
      and v_result ->> 'reason' = 'attendance_conflict_changed'
      and (
        select delivery_status = 'preparing'
          and provider_instance_name is null
          and provider_destination is null
        from public.notification_queue where id = v_claim.id
      ),
    'conflito resolvido entre claim/begin atravessou a fronteira'
  );

  -- Mutable source text cannot make a stale, materially different message pass.
  update public.notification_queue
  set scheduled_for = now(), next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ae03';
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ae03';
  select message_body into strict v_message
  from public.notification_queue where id = v_claim.id;
  update public.attendance_confirmations
  set student_name = 'Aluno Depois da Edicao'
  where id = '00000000-0000-4000-8000-00000000ad03';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511999990410', '5511999990410', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' =
        'attendance_conflict_authorized_snapshot_changed'
      and (
        select delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
      ),
    'mensagem de conflito alterada entre claim/begin foi autorizada'
  );

  -- The current teacher destination is authoritative, not the prepared copy.
  update public.notification_queue
  set scheduled_for = now(), next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ae04';
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ae04';
  select message_body into strict v_message
  from public.notification_queue where id = v_claim.id;
  update public.profiles set phone = '5511999990499'
  where id = '00000000-0000-4000-8000-00000000aa02';
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511999990410', '5511999990410', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' =
        'attendance_conflict_authorized_snapshot_changed'
      and (
        select delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
      ),
    'destino do professor alterado entre claim/begin foi autorizado'
  );
  update public.profiles set phone = '5511999990410'
  where id = '00000000-0000-4000-8000-00000000aa02';

  -- An unresolved answer is still ineligible until its correction window ends.
  update public.notification_queue
  set scheduled_for = now(), next_attempt_at = now()
  where id = '00000000-0000-4000-8000-00000000ae05';
  select candidate.* into strict v_claim
  from public.claim_notification_delivery_batch(200, 300) as candidate
  where candidate.id = '00000000-0000-4000-8000-00000000ae05';
  select message_body into strict v_message
  from public.notification_queue where id = v_claim.id;
  v_result := public.begin_notification_delivery_submission(
    v_claim.id, v_claim.claim_token, 'wa-occurrence-instance',
    '5511999990410', '5511999990410', v_message,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'attendance_conflict_changed'
      and (
        select delivery_status = 'preparing'
        from public.notification_queue where id = v_claim.id
      ),
    'conflito com janela de correcao aberta foi autorizado'
  );
end;
$conflict_snapshot_revalidation$;

rollback;
