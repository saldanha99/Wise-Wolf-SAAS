begin;

-- Queue kinds are part of security decisions. Persist one canonical spelling so
-- a producer cannot bypass the payment/lesson fences with whitespace or case.
create or replace function private.canonicalize_notification_queue_kind()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.notification_kind := nullif(
    upper(pg_catalog.btrim(coalesce(new.notification_kind, ''))),
    ''
  );
  return new;
end;
$function$;

alter function private.canonicalize_notification_queue_kind()
  owner to postgres;
revoke all on function private.canonicalize_notification_queue_kind()
  from public, anon, authenticated, service_role;

drop trigger if exists notification_queue_canonicalize_kind
  on public.notification_queue;
create trigger notification_queue_canonicalize_kind
before insert or update of notification_kind
on public.notification_queue
for each row execute function private.canonicalize_notification_queue_kind();

-- A legacy unique index compares the original spelling. Canonicalizing two
-- spellings of the same fully-bound occurrence would otherwise abort with an
-- opaque unique_violation. Never delete such history automatically: stop with
-- an actionable count so it can be reconciled deliberately.
do $notification_kind_collision_preflight$
declare
  v_collision_groups bigint;
begin
  select count(*)
  into v_collision_groups
  from (
    select
      notification.source_id,
      notification.source_type,
      notification.class_date,
      upper(pg_catalog.btrim(notification.notification_kind)) as canonical_kind
    from public.notification_queue as notification
    where notification.source_id is not null
      and notification.source_type is not null
      and notification.class_date is not null
      and nullif(pg_catalog.btrim(coalesce(
        notification.notification_kind,
        ''
      )), '') is not null
    group by
      notification.source_id,
      notification.source_type,
      notification.class_date,
      upper(pg_catalog.btrim(notification.notification_kind))
    having count(*) > 1
      and bool_or(
        notification.notification_kind is distinct from
          upper(pg_catalog.btrim(notification.notification_kind))
      )
  ) as collision;

  if v_collision_groups > 0 then
    raise exception 'notification_kind_canonical_collision_groups:%',
      v_collision_groups;
  end if;
end
$notification_kind_collision_preflight$;

update public.notification_queue
set notification_kind = nullif(
  upper(pg_catalog.btrim(coalesce(notification_kind, ''))),
  ''
)
where notification_kind is distinct from nullif(
  upper(pg_catalog.btrim(coalesce(notification_kind, ''))),
  ''
);

do $notification_kind_constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.notification_queue'::pg_catalog.regclass
      and conname = 'notification_queue_kind_canonical_check'
  ) then
    alter table public.notification_queue
      add constraint notification_queue_kind_canonical_check check (
        notification_kind is null
        or (
          notification_kind = upper(pg_catalog.btrim(notification_kind))
          and char_length(notification_kind) between 1 and 80
          and notification_kind !~ '[[:cntrl:]]'
        )
      ) not valid;
  end if;
end
$notification_kind_constraint$;

alter table public.notification_queue
  validate constraint notification_queue_kind_canonical_check;

-- A SEALED receipt means the provider boundary is about to be crossed. It is
-- committed on any accepted/ambiguous result and released only after a
-- definitive rejection. Legacy/manual receipts remain COMMITTED.
alter table public.automation_sent
  add column if not exists notification_id uuid,
  add column if not exists notification_claim_token uuid,
  add column if not exists receipt_state text not null default 'COMMITTED';

update public.automation_sent
set receipt_state = 'COMMITTED',
    notification_claim_token = null
where receipt_state is distinct from 'COMMITTED'
  and notification_id is null;

do $automation_receipt_constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.automation_sent'::pg_catalog.regclass
      and conname = 'automation_sent_receipt_state_check'
  ) then
    alter table public.automation_sent
      add constraint automation_sent_receipt_state_check
      check (receipt_state in ('SEALED', 'COMMITTED')) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.automation_sent'::pg_catalog.regclass
      and conname = 'automation_sent_receipt_fence_check'
  ) then
    alter table public.automation_sent
      add constraint automation_sent_receipt_fence_check check (
        (
          receipt_state = 'SEALED'
          and notification_id is not null
          and notification_claim_token is not null
        )
        or (
          receipt_state = 'COMMITTED'
          and notification_claim_token is null
        )
      ) not valid;
  end if;
end
$automation_receipt_constraints$;

alter table public.automation_sent
  validate constraint automation_sent_receipt_state_check;
alter table public.automation_sent
  validate constraint automation_sent_receipt_fence_check;

create index if not exists automation_sent_sealed_notification_idx
  on public.automation_sent (notification_id, notification_claim_token)
  where receipt_state = 'SEALED';

-- Old workers know only the pre-binding marker. Once this constraint exists,
-- they fail closed before a provider POST; the new worker uses the RPC below.
-- Rebuild by name so a partial/predecessor installation converges on the
-- destination-bound definition instead of preserving its narrower constraint.
alter table public.notification_queue
  drop constraint if exists notification_queue_submitting_binding_check;
alter table public.notification_queue
  add constraint notification_queue_submitting_binding_check check (
    delivery_status <> 'submitting'
    or (
      provider_instance_name is not null
      and provider_destination is not null
      and provider_integration_id is not null
      and provider_integration_version is not null
      and provider_integration_version > 0
    )
  ) not valid;

alter table public.notification_queue
  validate constraint notification_queue_submitting_binding_check;

-- Retire the unbound RPC from the service surface. During the rolling window
-- an older worker receives a permission error and follows its pre-POST retry
-- path; only the binding-aware RPC below may authorize a provider call.
revoke all on function public.mark_notification_delivery_submitting(
  uuid,uuid,text
) from public, anon, authenticated, service_role;

create or replace function private.normalize_notification_destination(
  p_destination text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_destination text := pg_catalog.btrim(coalesce(p_destination, ''));
begin
  if v_destination ~ '^[0-9]{10,25}@g[.]us$' then
    return v_destination;
  end if;
  return private.normalize_notification_phone(v_destination);
end;
$function$;

alter function private.normalize_notification_destination(text)
  owner to postgres;
revoke all on function private.normalize_notification_destination(text)
  from public, anon, authenticated, service_role;

create or replace function private.safe_notification_text(
  p_value text,
  p_maximum_length integer
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.left(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          coalesce(p_value, ''),
          '[[:cntrl:]<>*_`~]',
          ' ',
          'g'
        ),
        '[[:space:]]+',
        ' ',
        'g'
      )
    ),
    greatest(0, least(
      coalesce(p_maximum_length, 0),
      4096
    ))
  )
$function$;

alter function private.safe_notification_text(text,integer)
  owner to postgres;
revoke all on function private.safe_notification_text(text,integer)
  from public, anon, authenticated, service_role;

create or replace function private.render_lesson_notification_message(
  p_template text,
  p_student_name text,
  p_class_time text,
  p_teacher_name text,
  p_tenant_name text,
  p_class_link text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_template text := private.safe_notification_text(p_template, 4096);
  v_message text;
begin
  if v_template = '' then
    v_template := $default_template$Oi {student_name}, tudo bem? 👋

Lembrando que nossa aula começa em 30 minutos, às *{class_time}*.

{class_link}

Te espero! 🐺$default_template$;
  end if;

  v_message := pg_catalog.replace(
    v_template,
    '{student_name}',
    coalesce(p_student_name, '')
  );
  v_message := pg_catalog.replace(
    v_message,
    '{class_time}',
    coalesce(p_class_time, '')
  );
  v_message := pg_catalog.replace(
    v_message,
    '{teacher_name}',
    coalesce(p_teacher_name, '')
  );
  v_message := pg_catalog.replace(
    v_message,
    '{tenant_name}',
    coalesce(p_tenant_name, '')
  );
  v_message := pg_catalog.replace(
    v_message,
    '{class_link}',
    coalesce(p_class_link, '')
  );
  v_message := pg_catalog.regexp_replace(
    v_message,
    '\{[A-Za-z0-9_]+\}',
    '',
    'g'
  );
  return pg_catalog.left(pg_catalog.btrim(v_message), 4096);
end;
$function$;

alter function private.render_lesson_notification_message(
  text,text,text,text,text,text
) owner to postgres;
revoke all on function private.render_lesson_notification_message(
  text,text,text,text,text,text
) from public, anon, authenticated, service_role;

-- Keep the database authorization snapshot byte-for-byte aligned with the
-- message prepared by process-notification-queue. This renderer intentionally
-- does not sanitize or truncate: the TypeScript renderer does neither.
create or replace function private.render_conflict_teacher_alert_message(
  p_teacher_name text,
  p_student_name text,
  p_class_date date,
  p_class_time text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_teacher_name text := pg_catalog.regexp_replace(
    coalesce(p_teacher_name, ''),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  );
  v_teacher_first_name text;
  v_student_name text := pg_catalog.regexp_replace(
    coalesce(p_student_name, ''),
    '^[[:space:]]+|[[:space:]]+$',
    '',
    'g'
  );
  v_class_date text := case
    when p_class_date is null then 'data informada'
    else pg_catalog.to_char(p_class_date, 'DD/MM')
  end;
  v_class_time text := pg_catalog.left(
    pg_catalog.regexp_replace(
      coalesce(p_class_time, ''),
      '^[[:space:]]+|[[:space:]]+$',
      '',
      'g'
    ),
    5
  );
begin
  v_teacher_first_name := nullif(pg_catalog.split_part(
    pg_catalog.regexp_replace(
      v_teacher_name,
      '[[:space:]]+',
      ' ',
      'g'
    ),
    ' ',
    1
  ), '');

  return
    'Oi, ' || coalesce(v_teacher_first_name, 'professor') ||
    '! Aqui é da coordenação da escola.' || E'\n\n' ||
    'Recebemos uma divergência sobre a aula de ' || v_class_date ||
    case
      when v_class_time = '' then ''
      else ' às ' || v_class_time
    end ||
    ' com ' || coalesce(nullif(v_student_name, ''), 'o(a) aluno(a)') ||
    '.' || E'\n' ||
    'Pode nos contar como foi essa aula? Enquanto analisamos, somente esta aula fica em revisão.';
end;
$function$;

alter function private.render_conflict_teacher_alert_message(
  text,text,date,text
) owner to postgres;
revoke all on function private.render_conflict_teacher_alert_message(
  text,text,date,text
) from public, anon, authenticated, service_role;

drop function if exists public.begin_notification_delivery_submission(
  uuid,uuid,text,uuid,bigint
);

create or replace function public.begin_notification_delivery_submission(
  p_notification_id uuid,
  p_claim_token uuid,
  p_provider_instance_name text,
  p_expected_destination text,
  p_provider_destination text,
  p_expected_message_body text,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.notification_queue%rowtype;
  v_instance public.whatsapp_instances%rowtype;
  v_connection private.tenant_integration_connections%rowtype;
  v_booking public.bookings%rowtype;
  v_reschedule public.reschedules%rowtype;
  v_appointment public.appointments%rowtype;
  v_conflict_requested public.attendance_confirmations%rowtype;
  v_conflict_canonical public.attendance_confirmations%rowtype;
  v_teacher public.profiles%rowtype;
  v_teacher_membership public.tenant_memberships%rowtype;
  v_student public.profiles%rowtype;
  v_tenant public.tenants%rowtype;
  v_instance_name text := pg_catalog.btrim(
    coalesce(p_provider_instance_name, '')
  );
  v_expected_destination text :=
    private.normalize_notification_destination(p_expected_destination);
  v_provider_destination text :=
    private.normalize_notification_destination(p_provider_destination);
  v_expected_message text := coalesce(p_expected_message_body, '');
  v_current_destination text;
  v_current_message text;
  v_kind text;
  v_source_type text;
  v_ref_date date;
  v_start_at timestamptz;
  v_class_time text;
  v_teacher_id uuid;
  v_student_id uuid;
  v_student_name text;
  v_class_link text;
  v_subject_id text;
  v_conflict_canonical_id uuid;
  v_is_conflict_replay boolean := false;
  v_receipt_id uuid;
  v_queue_result jsonb;
begin
  if p_notification_id is null
     or p_claim_token is null
     or p_integration_id is null
     or coalesce(p_integration_version, 0) < 1
     or v_expected_destination is null
     or v_provider_destination is null
     or char_length(v_expected_message) not between 1 and 4096
     or v_expected_message <> pg_catalog.btrim(v_expected_message)
     or (
       v_expected_destination like '%@g.us'
       and v_provider_destination <> v_expected_destination
     )
     or (
       v_expected_destination not like '%@g.us'
       and not private.notification_phones_same_recipient(
         v_expected_destination,
         v_provider_destination
       )
     )
     or char_length(v_instance_name) not between 3 and 120
     or v_instance_name <> pg_catalog.btrim(v_instance_name)
     or v_instance_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_notification_delivery_submission'
      using errcode = '22023';
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id
  for update;

  if not found
     or v_notification.claim_token is distinct from p_claim_token
     or v_notification.status <> 'processing' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'notification_delivery_claim_lost'
    );
  end if;

  v_kind := upper(pg_catalog.btrim(coalesce(
    v_notification.notification_kind,
    ''
  )));

  -- Payment confirmations are always paired with the financial outbound
  -- ledger. This guard must precede the idempotent generic replay too: a
  -- payment already in SUBMITTING is still not a generic authorization.
  if private.canonical_payment_notification_kind(v_kind) =
      'PAYMENT_CONFIRMED_WHATSAPP' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'USE_PAYMENT_BRIDGE',
      'reason', 'payment_confirmation_requires_paired_submission'
    );
  end if;

  -- Idempotent replay for a lost RPC response. The same claim and exact sealed
  -- snapshot may receive the same authorization again; no second receipt is
  -- created and no different destination/message can be substituted.
  if v_notification.delivery_status = 'submitting' then
    if lower(coalesce(v_notification.provider_instance_name, '')) =
         lower(v_instance_name)
       and v_notification.lease_expires_at > now()
       and v_notification.provider_integration_id = p_integration_id
       and v_notification.provider_integration_version =
         p_integration_version
       and v_notification.provider_destination = v_provider_destination
       and v_notification.student_phone = v_expected_destination
       and v_notification.message_body = v_expected_message
       and (
         v_kind <> 'LESSON_REMINDER'
         or exists (
           select 1
           from public.automation_sent as receipt
           where receipt.notification_id = v_notification.id
             and receipt.notification_claim_token = p_claim_token
             and receipt.receipt_state = 'SEALED'
         )
       ) then
      if v_kind = 'CONFLICT_TEACHER_ALERT' then
        -- A lost begin response is not authority to send a conflict that was
        -- resolved before the replay. Re-run the locked source authorization.
        v_is_conflict_replay := true;
      else
        return pg_catalog.jsonb_build_object(
          'ok', true,
          'action', 'SUBMIT_AUTHORIZED',
          'notificationId', v_notification.id,
          'providerDestination', v_notification.provider_destination,
          'messageBody', v_notification.message_body
        );
      end if;
    else
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'notification_submitting_snapshot_mismatch'
      );
    end if;
  end if;

  if not v_is_conflict_replay
     and v_notification.delivery_status <> 'preparing' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'notification_delivery_claim_lost'
    );
  end if;

  if not v_is_conflict_replay
     and v_notification.lease_expires_at <= now() then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'notification_delivery_claim_expired'
    );
  end if;

  select instance.*
  into v_instance
  from public.whatsapp_instances as instance
  where instance.tenant_id = v_notification.tenant_id
    and lower(instance.instance_name) = lower(v_instance_name)
  for share;

  select connection.*
  into v_connection
  from private.tenant_integration_connections as connection
  where connection.id = p_integration_id
    and connection.tenant_id = v_notification.tenant_id
    and connection.provider = 'evolution'
  for share;

  if v_instance.id is null
     or lower(pg_catalog.btrim(coalesce(v_instance.status, ''))) not in (
       'connected', 'open'
     )
     or v_instance.integration_id is distinct from p_integration_id
     or v_instance.integration_version is distinct from p_integration_version
     or v_connection.id is null
     or v_connection.version is distinct from p_integration_version
     or v_connection.mode = 'DISABLED'
     or v_connection.status <> 'healthy' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'notification_provider_binding_changed'
    );
  end if;

  if v_kind = 'LESSON_REMINDER' then
    v_source_type := upper(pg_catalog.btrim(coalesce(
      v_notification.source_type,
      ''
    )));
    if v_notification.tenant_id is null
       or v_notification.source_id is null
       or v_source_type not in ('BOOKING', 'RESCHEDULE', 'APPOINTMENT')
       or v_notification.class_date is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'invalid_occurrence_identity'
      );
    end if;

    if v_source_type = 'BOOKING' then
      select booking.*
      into v_booking
      from public.bookings as booking
      where booking.id = v_notification.source_id
        and booking.tenant_id = v_notification.tenant_id
      for share;

      if not found
         or upper(pg_catalog.btrim(coalesce(v_booking.status, ''))) <>
           'SCHEDULED'
         or v_booking.teacher_id is null
         or v_booking.student_id is null
         or pg_catalog.btrim(coalesce(v_booking.time_slot, '')) !~
           '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
         or not (
           (
             v_booking.date is not null
             and v_booking.date = v_notification.class_date
           )
           or (
             v_booking.date is null
             and (
               v_booking.start_date is null
               or v_booking.start_date <= v_notification.class_date
             )
             and public.dow_name_to_int(v_booking.day_of_week) =
               extract(dow from v_notification.class_date)::integer
           )
         ) then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'REVIEW_REQUIRED',
          'reason', 'booking_occurrence_changed'
        );
      end if;

      v_ref_date := v_notification.class_date;
      v_class_time := pg_catalog.left(
        pg_catalog.btrim(v_booking.time_slot),
        5
      );
      v_start_at := (
        v_ref_date::text || ' ' || v_class_time
      )::timestamp at time zone 'America/Sao_Paulo';
      v_teacher_id := v_booking.teacher_id;
      v_student_id := v_booking.student_id;
    elsif v_source_type = 'RESCHEDULE' then
      select reschedule.*
      into v_reschedule
      from public.reschedules as reschedule
      where reschedule.id = v_notification.source_id
        and reschedule.tenant_id = v_notification.tenant_id
      for share;

      if not found
         or v_reschedule.used_at is not null
         or pg_catalog.btrim(coalesce(v_reschedule.date, '')) !~
           '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or v_reschedule.date::date <> v_notification.class_date
         or pg_catalog.btrim(coalesce(v_reschedule.time, '')) !~
           '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
         or v_reschedule.teacher_id is null
         or v_reschedule.student_id is null
         or coalesce(v_reschedule.notification_revision, 0) < 1 then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'REVIEW_REQUIRED',
          'reason', 'reschedule_occurrence_changed'
        );
      end if;

      v_ref_date := v_notification.class_date;
      v_class_time := pg_catalog.left(
        pg_catalog.btrim(v_reschedule.time),
        5
      );
      v_start_at := (
        v_ref_date::text || ' ' || v_class_time
      )::timestamp at time zone 'America/Sao_Paulo';
      v_teacher_id := v_reschedule.teacher_id;
      v_student_id := v_reschedule.student_id;
    else
      select appointment.*
      into v_appointment
      from public.appointments as appointment
      where appointment.id = v_notification.source_id
        and appointment.tenant_id = v_notification.tenant_id
      for share;

      if not found
         or lower(pg_catalog.btrim(coalesce(v_appointment.status, ''))) <>
           'scheduled'
         or v_appointment.start_time is null
         or coalesce(v_appointment.teacher_id, v_appointment.professor_id)
           is null
         or (
           v_appointment.teacher_id is not null
           and v_appointment.professor_id is not null
           and v_appointment.teacher_id <> v_appointment.professor_id
         ) then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'REVIEW_REQUIRED',
          'reason', 'appointment_occurrence_changed'
        );
      end if;

      v_ref_date := (
        v_appointment.start_time at time zone 'America/Sao_Paulo'
      )::date;
      if v_notification.class_date not in (
        v_ref_date,
        v_appointment.start_time::date
      ) then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'REVIEW_REQUIRED',
          'reason', 'appointment_class_date_changed'
        );
      end if;
      v_class_time := pg_catalog.to_char(
        v_appointment.start_time at time zone 'America/Sao_Paulo',
        'HH24:MI'
      );
      v_start_at := v_appointment.start_time;
      v_teacher_id := coalesce(
        v_appointment.teacher_id,
        v_appointment.professor_id
      );
      v_student_id := null;
    end if;

    if v_start_at - now() < interval '15 minutes'
       or v_start_at - now() > interval '45 minutes'
       or now() - v_notification.scheduled_for > interval '15 minutes' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'lesson_reminder_outside_send_window'
      );
    end if;

    select profile.*
    into v_teacher
    from public.profiles as profile
    where profile.id = v_teacher_id
      and profile.tenant_id = v_notification.tenant_id
    for share;

    if not found
       or upper(pg_catalog.btrim(coalesce(v_teacher.role, ''))) <> 'TEACHER'
       or lower(pg_catalog.btrim(coalesce(
         v_teacher.lifecycle_status,
         ''
       ))) <> 'active'
       or coalesce(v_teacher.is_test_account, false)
       or coalesce(v_teacher.date_automation_enabled, false) is not true
       or not exists (
         select 1
         from public.tenant_memberships as membership
         where membership.user_id = v_teacher.id
           and membership.tenant_id = v_notification.tenant_id
           and membership.role = 'TEACHER'
           and membership.status = 'ACTIVE'
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'lesson_teacher_changed'
      );
    end if;

    v_class_link := private.safe_notification_text(
      v_teacher.meeting_link,
      300
    );
    if v_student_id is not null then
      select profile.*
      into v_student
      from public.profiles as profile
      where profile.id = v_student_id
        and profile.tenant_id = v_notification.tenant_id
      for share;

      if not found
         or upper(pg_catalog.btrim(coalesce(v_student.role, ''))) <> 'STUDENT'
         or lower(pg_catalog.btrim(coalesce(
           v_student.lifecycle_status,
           ''
         ))) <> 'active'
         or coalesce(v_student.is_test_account, false)
         or not exists (
           select 1
           from public.tenant_memberships as membership
           where membership.user_id = v_student.id
             and membership.tenant_id = v_notification.tenant_id
             and membership.role = 'STUDENT'
             and membership.status = 'ACTIVE'
         ) then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'REVIEW_REQUIRED',
          'reason', 'lesson_student_changed'
        );
      end if;

      v_student_name := private.safe_notification_text(
        v_student.full_name,
        180
      );
      v_current_destination := coalesce(
        private.normalize_notification_phone(v_student.attendance_phone),
        private.normalize_notification_phone(v_student.phone)
      );
      v_class_link := coalesce(
        nullif(private.safe_notification_text(
          v_student.meeting_link,
          300
        ), ''),
        v_class_link
      );
    else
      v_student_name := private.safe_notification_text(
        v_appointment.student_name,
        180
      );
      v_current_destination := private.normalize_notification_phone(
        v_appointment.student_phone
      );
    end if;

    select tenant.*
    into v_tenant
    from public.tenants as tenant
    where tenant.id = v_notification.tenant_id
    for share;

    if not found
       or v_student_name = ''
       or v_current_destination is null
       or private.safe_notification_text(v_teacher.full_name, 180) = ''
       or private.safe_notification_text(v_tenant.name, 180) = '' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'lesson_canonical_payload_unavailable'
      );
    end if;

    v_current_message := private.render_lesson_notification_message(
      v_teacher.lesson_reminder_template,
      pg_catalog.split_part(v_student_name, ' ', 1),
      v_class_time,
      private.safe_notification_text(v_teacher.full_name, 180),
      private.safe_notification_text(v_tenant.name, 180),
      v_class_link
    );

    if v_current_destination <> v_expected_destination
       or not private.notification_phones_same_recipient(
         v_current_destination,
         v_provider_destination
       )
       or v_current_message is distinct from v_expected_message then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'lesson_authorized_snapshot_changed'
      );
    end if;

    v_subject_id := v_notification.tenant_id || ':' || v_source_type || ':' ||
      v_notification.source_id::text;

    insert into public.automation_sent (
      kind,
      subject_id,
      ref_date,
      notification_id,
      notification_claim_token,
      receipt_state
    ) values (
      'CLASS_REMINDER',
      v_subject_id,
      v_ref_date,
      v_notification.id,
      p_claim_token,
      'SEALED'
    )
    on conflict (kind, subject_id, ref_date) do nothing
    returning id into v_receipt_id;

    if v_receipt_id is null then
      v_queue_result := public.finalize_notification_delivery(
        v_notification.id,
        p_claim_token,
        'skipped',
        null,
        null,
        'occurrence_already_notified',
        0
      );
      if coalesce((v_queue_result ->> 'ok')::boolean, false) is not true then
        raise exception 'occurrence_duplicate_queue_finalize_failed';
      end if;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'ALREADY_NOTIFIED',
        'reason', 'occurrence_already_notified'
      );
    end if;
  elsif v_kind = 'CONFLICT_TEACHER_ALERT' then
    v_source_type := upper(pg_catalog.btrim(coalesce(
      v_notification.source_type,
      ''
    )));
    if v_notification.tenant_id is null
       or v_notification.source_id is null
       or v_notification.class_date is null
       or v_source_type <> 'ATTENDANCE_CONFIRMATION' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'invalid_conflict_identity'
      );
    end if;

    -- Discover the root without waiting while the queue row is locked. The
    -- pointer is re-read and compared after every authoritative row is locked.
    select coalesce(
      confirmation.canonical_confirmation_id,
      confirmation.id
    )
    into v_conflict_canonical_id
    from public.attendance_confirmations as confirmation
    where confirmation.id = v_notification.source_id;

    if not found or v_conflict_canonical_id is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'attendance_conflict_changed'
      );
    end if;

    -- Conflict writers lock attendance rows before touching a pending queue.
    -- NOWAIT makes this inverse queue->source authorization fail closed instead
    -- of ever participating in a lock cycle; the worker retries from PREPARING.
    begin
      select confirmation.*
      into v_conflict_canonical
      from public.attendance_confirmations as confirmation
      where confirmation.id = v_conflict_canonical_id
      for share nowait;

      select confirmation.*
      into v_conflict_requested
      from public.attendance_confirmations as confirmation
      where confirmation.id = v_notification.source_id
      for share nowait;

      perform 1
      from public.attendance_confirmations as confirmation
      where coalesce(
        confirmation.canonical_confirmation_id,
        confirmation.id
      ) = v_conflict_canonical_id
      order by confirmation.id
      for share nowait;

      if v_conflict_canonical.teacher_id is not null then
        select profile.*
        into v_teacher
        from public.profiles as profile
        where profile.id = v_conflict_canonical.teacher_id
        for share nowait;

        select membership.*
        into v_teacher_membership
        from public.tenant_memberships as membership
        where membership.user_id = v_conflict_canonical.teacher_id
          and membership.tenant_id = v_notification.tenant_id
        for share nowait;
      end if;
    exception
      when lock_not_available then
        return pg_catalog.jsonb_build_object(
          'ok', false,
          'action', 'RETRY',
          'reason', 'attendance_conflict_revalidation_busy'
        );
    end;

    if v_conflict_requested.id is null
       or v_conflict_canonical.id is null
       or coalesce(
         v_conflict_requested.canonical_confirmation_id,
         v_conflict_requested.id
       ) is distinct from v_conflict_canonical_id
       or coalesce(
         v_conflict_canonical.canonical_confirmation_id,
         v_conflict_canonical.id
       ) is distinct from v_conflict_canonical.id
       or v_conflict_requested.tenant_id is distinct from
         v_notification.tenant_id
       or v_conflict_canonical.tenant_id is distinct from
         v_notification.tenant_id
       or v_conflict_requested.class_date is distinct from
         v_notification.class_date
       or v_conflict_canonical.class_date is distinct from
         v_notification.class_date
       or v_conflict_requested.teacher_id is distinct from
         v_conflict_canonical.teacher_id
       or v_conflict_canonical.teacher_id is null
       or exists (
         select 1
         from public.attendance_confirmations as member
         where coalesce(member.canonical_confirmation_id, member.id) =
             v_conflict_canonical_id
           and (
             member.tenant_id is distinct from v_conflict_canonical.tenant_id
             or member.class_date is distinct from
               v_conflict_canonical.class_date
             or member.teacher_id is distinct from
               v_conflict_canonical.teacher_id
             or member.student_id is distinct from
               v_conflict_canonical.student_id
             or upper(pg_catalog.btrim(coalesce(member.status, ''))) <>
               'CONFLICT'
             or upper(pg_catalog.btrim(coalesce(
               member.student_response,
               ''
             ))) <> 'TEACHER_NO_SHOW'
             or member.resolved_at is not null
             or member.resolution_verdict is not null
             or member.response_editable_until is null
             or member.response_editable_until > now()
           )
       ) then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'attendance_conflict_changed'
      );
    end if;

    if v_teacher.id is null
       or v_teacher.id is distinct from v_conflict_canonical.teacher_id
       or v_teacher.tenant_id is distinct from v_notification.tenant_id
       or upper(pg_catalog.btrim(coalesce(v_teacher.role, ''))) <> 'TEACHER'
       or lower(pg_catalog.btrim(coalesce(
         v_teacher.lifecycle_status,
         ''
       ))) <> 'active'
       or v_teacher.is_test_account is distinct from false
       or v_teacher_membership.user_id is distinct from v_teacher.id
       or v_teacher_membership.tenant_id is distinct from
         v_notification.tenant_id
       or v_teacher_membership.role is distinct from 'TEACHER'
       or v_teacher_membership.status is distinct from 'ACTIVE' then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'attendance_conflict_teacher_changed'
      );
    end if;

    v_current_destination := coalesce(
      private.normalize_notification_phone(v_teacher.phone),
      private.normalize_notification_phone(v_teacher.attendance_phone)
    );
    v_current_message := private.render_conflict_teacher_alert_message(
      v_teacher.full_name,
      v_conflict_canonical.student_name,
      v_conflict_canonical.class_date,
      v_conflict_canonical.class_time
    );

    if v_current_destination is null
       or v_current_destination <> v_expected_destination
       or not private.notification_phones_same_recipient(
         v_current_destination,
         v_provider_destination
       )
       or v_current_message is distinct from v_expected_message then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'attendance_conflict_authorized_snapshot_changed'
      );
    end if;
  else
    -- Other kinds already have purpose-specific TypeScript revalidation. Bind
    -- the exact prepared snapshot so response recovery cannot substitute it.
    v_current_destination := v_expected_destination;
    v_current_message := v_expected_message;
  end if;

  if v_is_conflict_replay then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'SUBMIT_AUTHORIZED',
      'notificationId', v_notification.id,
      'providerDestination', v_notification.provider_destination,
      'messageBody', v_notification.message_body
    );
  end if;

  update public.notification_queue as notification
  set delivery_status = 'submitting',
      provider_instance_name = v_instance.instance_name,
      provider_destination = v_provider_destination,
      provider_integration_id = p_integration_id,
      provider_integration_version = p_integration_version,
      student_phone = v_current_destination,
      message_body = v_current_message,
      lease_expires_at = now() + interval '10 minutes',
      last_error = null,
      updated_at = now()
  where notification.id = v_notification.id
    and notification.status = 'processing'
    and notification.delivery_status = 'preparing'
    and notification.claim_token = p_claim_token
    and notification.lease_expires_at > now()
  returning notification.* into v_notification;

  if not found then
    raise exception 'notification_submission_transition_failed';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_AUTHORIZED',
    'notificationId', v_notification.id,
    'status', v_notification.status,
    'deliveryStatus', v_notification.delivery_status,
    'providerInstanceName', v_notification.provider_instance_name,
    'providerDestination', v_notification.provider_destination,
    'messageBody', v_notification.message_body,
    'integrationId', v_notification.provider_integration_id,
    'integrationVersion', v_notification.provider_integration_version
  );
end;
$function$;

alter function public.begin_notification_delivery_submission(
  uuid,uuid,text,text,text,text,uuid,bigint
) owner to postgres;
revoke all on function public.begin_notification_delivery_submission(
  uuid,uuid,text,text,text,text,uuid,bigint
) from public, anon, authenticated, service_role;
grant execute on function public.begin_notification_delivery_submission(
  uuid,uuid,text,text,text,text,uuid,bigint
) to service_role;

-- Resolve an ambiguous RPC response without changing state. A worker may only
-- resume the exact snapshot sealed by its own claim; PREPARING remains safe for
-- lease recovery, while SUBMITTING is never pushed through a generic finalizer.
create or replace function public.recover_notification_delivery_submission(
  p_notification_id uuid,
  p_notification_claim_token uuid,
  p_outbound_attempt_id uuid,
  p_outbound_claim_token uuid,
  p_provider_instance_name text,
  p_integration_id uuid,
  p_integration_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.notification_queue%rowtype;
  v_outbound public.asaas_outbound_message_attempts%rowtype;
  v_instance_name text := pg_catalog.btrim(coalesce(
    p_provider_instance_name,
    ''
  ));
  v_is_payment boolean;
begin
  if p_notification_id is null
     or p_notification_claim_token is null
     or p_integration_id is null
     or coalesce(p_integration_version, 0) < 1
     or char_length(v_instance_name) not between 3 and 120 then
    raise exception 'invalid_notification_submission_recovery'
      using errcode = '22023';
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'notification_not_found'
    );
  end if;

  v_is_payment := private.canonical_payment_notification_kind(
    v_notification.notification_kind
  ) = 'PAYMENT_CONFIRMED_WHATSAPP';

  if v_notification.claim_token is null
     and v_notification.status = 'skipped'
     and v_notification.last_error = 'occurrence_already_notified' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'ALREADY_NOTIFIED',
      'reason', v_notification.last_error
    );
  end if;

  if v_is_payment and p_outbound_attempt_id is not null then
    select outbound.*
    into v_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = p_outbound_attempt_id
      and outbound.claim_token = p_outbound_claim_token;

    if found
       and v_notification.claim_token is null
       and v_notification.status = 'skipped'
       and v_outbound.status = 'SUPPRESSED'
       and v_outbound.notification_queue_id = v_notification.id then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'SUPPRESSED',
        'reason', coalesce(
          v_notification.last_error,
          v_outbound.last_error,
          'payment_confirmation_suppressed'
        )
      );
    end if;
  end if;

  if v_notification.claim_token is distinct from
       p_notification_claim_token
     or v_notification.status <> 'processing' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'notification_claim_changed'
    );
  end if;

  if v_notification.delivery_status = 'preparing' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY_BEGIN',
      'reason', 'notification_begin_not_committed'
    );
  end if;

  if v_notification.delivery_status <> 'submitting'
     or v_notification.lease_expires_at <= now()
     or lower(coalesce(v_notification.provider_instance_name, '')) <>
       lower(v_instance_name)
     or v_notification.provider_destination is null
     or v_notification.provider_integration_id <> p_integration_id
     or v_notification.provider_integration_version <>
       p_integration_version then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'notification_submission_snapshot_changed'
    );
  end if;

  if v_is_payment then
    if p_outbound_attempt_id is null or p_outbound_claim_token is null then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'payment_submission_claim_missing'
      );
    end if;

    select outbound.*
    into v_outbound
    from public.asaas_outbound_message_attempts as outbound
    where outbound.id = p_outbound_attempt_id
      and outbound.claim_token = p_outbound_claim_token
      and outbound.notification_queue_id = v_notification.id;

    if not found
       or v_outbound.status <> 'SUBMITTING'
       or v_outbound.submit_attempt_count <> 1
       or v_outbound.lease_expires_at <= now()
       or lower(coalesce(v_outbound.provider_instance_name, '')) <>
         lower(v_instance_name)
       or v_outbound.provider_destination is distinct from
         v_notification.provider_destination then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'payment_submission_snapshot_changed'
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'SUBMITTING',
      'providerDestination', v_notification.provider_destination,
      'messageBody', v_notification.message_body
    );
  end if;

  if p_outbound_attempt_id is not null
     or p_outbound_claim_token is not null
     or (
       upper(pg_catalog.btrim(coalesce(
         v_notification.notification_kind,
         ''
       ))) = 'LESSON_REMINDER'
       and not exists (
         select 1
         from public.automation_sent as receipt
         where receipt.notification_id = v_notification.id
           and receipt.notification_claim_token =
             p_notification_claim_token
           and receipt.receipt_state = 'SEALED'
       )
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'generic_submission_receipt_changed'
    );
  end if;

  if upper(pg_catalog.btrim(coalesce(
       v_notification.notification_kind,
       ''
     ))) = 'CONFLICT_TEACHER_ALERT' then
    -- Reuse the exact locked authorization path. The begin RPC recognizes the
    -- sealed snapshot as an idempotent replay and does not mutate it, but it
    -- does re-lock and revalidate the conflict before authorizing the POST.
    return public.begin_notification_delivery_submission(
      v_notification.id,
      p_notification_claim_token,
      v_instance_name,
      v_notification.student_phone,
      v_notification.provider_destination,
      v_notification.message_body,
      p_integration_id,
      p_integration_version
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_AUTHORIZED',
    'providerDestination', v_notification.provider_destination,
    'messageBody', v_notification.message_body
  );
end;
$function$;

alter function public.recover_notification_delivery_submission(
  uuid,uuid,uuid,uuid,text,uuid,bigint
) owner to postgres;
revoke all on function public.recover_notification_delivery_submission(
  uuid,uuid,uuid,uuid,text,uuid,bigint
) from public, anon, authenticated, service_role;
grant execute on function public.recover_notification_delivery_submission(
  uuid,uuid,uuid,uuid,text,uuid,bigint
) to service_role;

-- Keep the occurrence fence and the queue terminal transition in the same
-- transaction, including lease expiry and asynchronous provider receipts.
create or replace function private.sync_lesson_notification_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_changed integer := 0;
begin
  if upper(pg_catalog.btrim(coalesce(old.notification_kind, ''))) <>
      'LESSON_REMINDER'
     or old.delivery_status <> 'submitting'
     or old.claim_token is null
     or new.claim_token is not null then
    return new;
  end if;

  if new.delivery_status in (
    'accepted', 'sent', 'delivered', 'read', 'uncertain'
  ) then
    update public.automation_sent as receipt
    set receipt_state = 'COMMITTED',
        notification_claim_token = null
    where receipt.notification_id = old.id
      and receipt.notification_claim_token = old.claim_token
      and receipt.receipt_state = 'SEALED';
    get diagnostics v_changed = row_count;
  elsif new.delivery_status = 'failed' then
    delete from public.automation_sent as receipt
    where receipt.notification_id = old.id
      and receipt.notification_claim_token = old.claim_token
      and receipt.receipt_state = 'SEALED';
    get diagnostics v_changed = row_count;
  else
    raise exception 'invalid_lesson_receipt_terminal_transition'
      using errcode = '23514';
  end if;

  if v_changed <> 1 then
    raise exception 'lesson_receipt_fence_missing'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

alter function private.sync_lesson_notification_receipt() owner to postgres;
revoke all on function private.sync_lesson_notification_receipt()
  from public, anon, authenticated, service_role;

drop trigger if exists notification_queue_sync_lesson_receipt
  on public.notification_queue;
create trigger notification_queue_sync_lesson_receipt
after update of delivery_status, claim_token
on public.notification_queue
for each row execute function private.sync_lesson_notification_receipt();

do $occurrence_delivery_fence_verify$
begin
  if pg_catalog.to_regprocedure(
    'public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'
  ) is null
     or pg_catalog.to_regprocedure(
       'public.begin_notification_delivery_submission(uuid,uuid,text,uuid,bigint)'
     ) is not null
     or pg_catalog.to_regprocedure(
       'public.recover_notification_delivery_submission(uuid,uuid,uuid,uuid,text,uuid,bigint)'
     ) is null
     or not exists (
       select 1
       from information_schema.columns as definition
       where definition.table_schema = 'public'
         and definition.table_name = 'notification_queue'
         and definition.column_name = 'provider_destination'
     ) then
    raise exception 'occurrence_delivery_fence_installation_failed';
  end if;
end
$occurrence_delivery_fence_verify$;

commit;
