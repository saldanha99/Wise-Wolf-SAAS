begin;

-- create_enrollment_offer(jsonb) is owned by postgres and writes its durable
-- idempotency receipt as SECURITY DEFINER.  The predecessor migration created
-- the private table under the migration runner, so postgres could receive a
-- permission_denied before the commercial offer was created.  Keep the table
-- completely outside the Data API while aligning its owner with the function.
do $required_objects$
begin
  if pg_catalog.to_regclass(
       'private.enrollment_offer_command_receipts'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.create_enrollment_offer(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.begin_student_offboarding_with_billing_policy(text,uuid,uuid,text,text,text,date,uuid,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.finalize_student_offboarding_with_billing_policy(uuid,uuid)'
     ) is null
  then
    raise exception
      'required enrollment/student lifecycle predecessor is missing';
  end if;
end;
$required_objects$;

alter table private.enrollment_offer_command_receipts owner to postgres;
alter table private.enrollment_offer_command_receipts enable row level security;
alter table private.enrollment_offer_command_receipts force row level security;
revoke all on table private.enrollment_offer_command_receipts
  from public, anon, authenticated, service_role;

-- Lifecycle mutations repeatedly freeze and revalidate the same student's
-- recurring charges.  Keep those scans bounded while the advisory lock is
-- held, including the fail-closed check for a charge created after begin.
create index if not exists student_payments_lifecycle_due_idx
  on public.student_payments (tenant_id, student_id, due_date, id)
  where payment_type = 'SUBSCRIPTION';

-- Preserve the reviewed offboarding implementation as the forward-only path
-- for definitive exits.  Suspension gets a narrower wrapper below because it
-- must preserve the current competence while cancelling only open recurring
-- charges from the following competence onward.
do $wrap_student_lifecycle_begin$
begin
  if pg_catalog.to_regprocedure(
       'public.begin_student_offboarding_pre_suspension_future_charge_impl(text,uuid,uuid,text,text,text,date,uuid,integer)'
     ) is null
  then
    alter function public.begin_student_offboarding_with_billing_policy(
      text, uuid, uuid, text, text, text, date, uuid, integer
    ) rename to
      begin_student_offboarding_pre_suspension_future_charge_impl;
  end if;
end;
$wrap_student_lifecycle_begin$;

alter function
  public.begin_student_offboarding_pre_suspension_future_charge_impl(
    text, uuid, uuid, text, text, text, date, uuid, integer
  ) owner to postgres;
revoke all on function
  public.begin_student_offboarding_pre_suspension_future_charge_impl(
    text, uuid, uuid, text, text, text, date, uuid, integer
  ) from public, anon, authenticated, service_role;

create or replace function public.begin_student_offboarding_with_billing_policy(
  p_tenant_id text,
  p_student_id uuid,
  p_requested_by uuid,
  p_target_status text,
  p_reason text,
  p_billing_policy text,
  p_effective_end_date date,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_target text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_target_status, ''))
  );
  normalized_policy text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_billing_policy, ''))
  );
  normalized_reason text := nullif(
    pg_catalog.btrim(coalesce(p_reason, '')),
    ''
  );
  business_today date := (
    pg_catalog.now() at time zone 'America/Sao_Paulo'
  )::date;
  business_period date;
  cancel_from date;
  base_result jsonb;
  operation_id uuid;
  operation_row public.student_offboarding_operations%rowtype;
  desired_payments jsonb := '[]'::jsonb;
  initialize_snapshot boolean := false;
begin
  if normalized_target <> 'suspended' then
    return
      public.begin_student_offboarding_pre_suspension_future_charge_impl(
        p_tenant_id,
        p_student_id,
        p_requested_by,
        p_target_status,
        p_reason,
        p_billing_policy,
        p_effective_end_date,
        p_claim_token,
        p_lease_seconds
      );
  end if;

  if normalized_reason is null
     or pg_catalog.length(normalized_reason) > 500
  then
    raise exception using
      errcode = '22023', message = 'student_offboarding_reason_required';
  end if;
  if p_effective_end_date is null
     or p_effective_end_date < date '2020-01-01'
     or p_effective_end_date > business_today
  then
    raise exception using
      errcode = '22023',
      message = 'student_offboarding_effective_end_date_invalid';
  end if;
  if normalized_policy not in ('', 'KEEP_OPEN_INVOICES') then
    raise exception using
      errcode = '22023',
      message = 'student_offboarding_billing_policy_invalid';
  end if;

  normalized_policy := 'KEEP_OPEN_INVOICES';
  business_period := pg_catalog.date_trunc(
    'month', p_effective_end_date
  )::date;
  cancel_from := (business_period + interval '1 month')::date;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || p_tenant_id || ':' ||
        p_student_id::text,
      0
    )
  );

  -- A BLOCKED operation that never crossed Asaas is locally reversible.  The
  -- next begin can replace it under the same student advisory lock.
  update public.student_offboarding_operations as operation
     set status = 'ABORTED',
         lease_expires_at = pg_catalog.now(),
         completed_at = pg_catalog.now(),
         snapshot = operation.snapshot || pg_catalog.jsonb_build_object(
           'pre_provider_block_released_at', pg_catalog.now(),
           'pre_provider_block_last_error', operation.last_error
         ),
         updated_at = pg_catalog.now()
   where operation.tenant_id = p_tenant_id
     and operation.student_id = p_student_id
     and operation.status = 'BLOCKED'
     and operation.provider_started_at is null;

  perform 1
    from public.tenant_memberships as membership
   where membership.user_id = p_student_id
   for share;

  base_result := public.begin_student_offboarding(
    p_tenant_id,
    p_student_id,
    p_requested_by,
    'suspended',
    normalized_reason,
    p_claim_token,
    p_lease_seconds
  );

  if coalesce(base_result ->> 'action', '') in (
       'ALREADY_COMPLETED', 'IN_PROGRESS', 'REVIEW_REQUIRED'
     )
     or coalesce((base_result ->> 'ok')::boolean, false) is false
  then
    return base_result;
  end if;

  begin
    operation_id := (base_result ->> 'operation_id')::uuid;
  exception when invalid_text_representation then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'offboarding_operation_invalid'
    );
  end;

  select operation.*
    into operation_row
    from public.student_offboarding_operations as operation
   where operation.id = operation_id
     and operation.claim_token = p_claim_token
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'claim_lost'
    );
  end if;

  if operation_row.reason is distinct from normalized_reason then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'offboarding_reason_snapshot_mismatch',
           updated_at = pg_catalog.now()
     where id = operation_id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'offboarding_reason_snapshot_mismatch',
      'operation_id', operation_id
    );
  end if;

  initialize_snapshot := operation_row.billing_policy is null
    or (
      operation_row.target_lifecycle_status = 'suspended'
      and operation_row.billing_policy = 'KEEP_OPEN_INVOICES'
      and operation_row.billing_cancel_from_date is null
    );

  if initialize_snapshot and (
       operation_row.status <> 'CLAIMED'
       or operation_row.provider_started_at is not null
     )
  then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error =
             'suspension_billing_snapshot_missing_after_provider_start',
           updated_at = pg_catalog.now()
     where id = operation_id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'suspension_billing_snapshot_missing_after_provider_start',
      'operation_id', operation_id
    );
  end if;

  if initialize_snapshot
     or (
       operation_row.status = 'CLAIMED'
       and operation_row.provider_started_at is null
     )
  then
    -- A settled, credited or otherwise non-deletable future charge cannot be
    -- turned into a silent refund/cancellation by suspension.  Stop before
    -- crossing the provider boundary and require financial reconciliation.
    if exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = p_tenant_id
         and payment.student_id = p_student_id
         and payment.payment_type = 'SUBSCRIPTION'
         and payment.due_date >= cancel_from
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.status,
               ''
             ))) not in (
               'PENDING', 'OVERDUE', 'CANCELLED', 'DELETED',
               'REFUNDED', 'REVERSED', 'NAO_RECEITA'
             )
    ) then
      update public.student_offboarding_operations
         set status = 'BLOCKED',
             last_error = 'future_payment_not_safely_cancellable',
             updated_at = pg_catalog.now()
       where id = operation_id;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'future_payment_not_safely_cancellable',
        'operation_id', operation_id
      );
    end if;

    if exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = p_tenant_id
         and payment.student_id = p_student_id
         and payment.payment_type = 'SUBSCRIPTION'
         and payment.due_date >= cancel_from
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.status,
               ''
             ))) in ('PENDING', 'OVERDUE')
         and nullif(pg_catalog.btrim(coalesce(
               payment.asaas_payment_id,
               ''
             )), '') is not null
         and nullif(pg_catalog.btrim(coalesce(
               payment.asaas_id,
               ''
             )), '') is not null
         and pg_catalog.btrim(payment.asaas_payment_id) <>
               pg_catalog.btrim(payment.asaas_id)
    ) then
      update public.student_offboarding_operations
         set status = 'BLOCKED',
             last_error = 'payment_provider_binding_divergent',
             updated_at = pg_catalog.now()
       where id = operation_id;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'payment_provider_binding_divergent',
        'operation_id', operation_id
      );
    end if;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', payment.id,
          'asaas_payment_id', coalesce(
            nullif(pg_catalog.btrim(coalesce(
              payment.asaas_payment_id,
              ''
            )), ''),
            nullif(pg_catalog.btrim(coalesce(payment.asaas_id, '')), '')
          ),
          'status', payment.status,
          'due_date', payment.due_date,
          'value', payment.value
        ) order by payment.id
      ),
      '[]'::jsonb
    )
      into desired_payments
      from public.student_payments as payment
     where payment.tenant_id = p_tenant_id
       and payment.student_id = p_student_id
       and payment.payment_type = 'SUBSCRIPTION'
       and payment.due_date >= cancel_from
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             payment.status,
             ''
           ))) in ('PENDING', 'OVERDUE');

    if exists (
      select 1
        from pg_catalog.jsonb_array_elements(desired_payments) as entry
       where nullif(entry ->> 'asaas_payment_id', '') is not null
       group by entry ->> 'asaas_payment_id'
      having pg_catalog.count(*) > 1
    ) then
      update public.student_offboarding_operations
         set status = 'BLOCKED',
             last_error = 'payment_provider_binding_duplicate',
             updated_at = pg_catalog.now()
       where id = operation_id;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'payment_provider_binding_duplicate',
        'operation_id', operation_id
      );
    end if;
  end if;

  if initialize_snapshot then
    update public.student_offboarding_operations
       set billing_policy = 'KEEP_OPEN_INVOICES',
           billing_period_start = business_period,
           billing_cancel_from_date = cancel_from,
           effective_end_date = p_effective_end_date,
           payment_snapshot = desired_payments,
           preserved_payment_snapshot = '[]'::jsonb,
           provider_subscription_final_status = 'INACTIVE',
           snapshot = snapshot || pg_catalog.jsonb_build_object(
             'billing_policy', 'KEEP_OPEN_INVOICES',
             'billing_period_start', business_period,
             'billing_cancel_from_date', cancel_from,
             'effective_end_date', p_effective_end_date,
             'reason', normalized_reason,
             'payment_ids', desired_payments,
             'preserved_payment_ids', '[]'::jsonb,
             'provider_subscription_final_status', 'INACTIVE'
           ),
           updated_at = pg_catalog.now()
     where id = operation_id
     returning * into operation_row;
  elsif operation_row.billing_policy is distinct from 'KEEP_OPEN_INVOICES'
     or operation_row.billing_period_start is distinct from business_period
     or operation_row.billing_cancel_from_date is distinct from cancel_from
     or operation_row.effective_end_date is distinct from p_effective_end_date
     or operation_row.provider_subscription_final_status is distinct from
       'INACTIVE'
     or operation_row.preserved_payment_snapshot is distinct from '[]'::jsonb
     or (
       operation_row.status = 'CLAIMED'
       and operation_row.provider_started_at is null
       and operation_row.payment_snapshot is distinct from desired_payments
     )
  then
    update public.student_offboarding_operations
       set status = 'BLOCKED',
           last_error = 'offboarding_billing_snapshot_mismatch',
           updated_at = pg_catalog.now()
     where id = operation_id;
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'offboarding_billing_snapshot_mismatch',
      'operation_id', operation_id
    );
  end if;

  return base_result || pg_catalog.jsonb_build_object(
    'billing_policy', operation_row.billing_policy,
    'billing_period_start', operation_row.billing_period_start,
    'billing_cancel_from_date', operation_row.billing_cancel_from_date,
    'effective_end_date', operation_row.effective_end_date,
    'reason', operation_row.reason,
    'payment_snapshot', operation_row.payment_snapshot,
    'preserved_payment_snapshot', operation_row.preserved_payment_snapshot,
    'provider_subscription_final_status',
      operation_row.provider_subscription_final_status
  );
end;
$function$;

alter function public.begin_student_offboarding_with_billing_policy(
  text, uuid, uuid, text, text, text, date, uuid, integer
) owner to postgres;
revoke all on function public.begin_student_offboarding_with_billing_policy(
  text, uuid, uuid, text, text, text, date, uuid, integer
) from public, anon, authenticated;
grant execute on function public.begin_student_offboarding_with_billing_policy(
  text, uuid, uuid, text, text, text, date, uuid, integer
) to service_role;

do $wrap_student_lifecycle_finalize$
begin
  if pg_catalog.to_regprocedure(
       'public.finalize_student_offboarding_pre_schedule_notification_impl(uuid,uuid)'
     ) is null
  then
    alter function public.finalize_student_offboarding_with_billing_policy(
      uuid, uuid
    ) rename to
      finalize_student_offboarding_pre_schedule_notification_impl;
  end if;
end;
$wrap_student_lifecycle_finalize$;

alter function
  public.finalize_student_offboarding_pre_schedule_notification_impl(
    uuid, uuid
  ) owner to postgres;
revoke all on function
  public.finalize_student_offboarding_pre_schedule_notification_impl(
    uuid, uuid
  ) from public, anon, authenticated, service_role;

create or replace function public.finalize_student_offboarding_with_billing_policy(
  p_operation_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  operation_row public.student_offboarding_operations%rowtype;
  operation_tenant_id text;
  operation_student_id uuid;
  base_result jsonb;
  released_teacher_ids jsonb := '[]'::jsonb;
  newly_cancelled_schedules integer := 0;
  schedules_cancelled integer := 0;
  newly_cancelled_payments integer := 0;
  student_notification_enabled boolean := false;
  teacher_notification_enabled boolean := false;
  student_row public.profiles%rowtype;
  tenant_name text;
  student_destination text;
  student_kind text;
  teacher_kind text;
  student_message text;
  teacher_message text;
  teacher_row record;
  notifications_queued integer := 0;
  inserted_count integer := 0;
  completed_result jsonb;
  final_result jsonb;
begin
  select operation.tenant_id, operation.student_id
    into operation_tenant_id, operation_student_id
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'claim_lost'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || operation_tenant_id || ':' ||
        operation_student_id::text,
      0
    )
  );

  select operation.*
    into operation_row
    from public.student_offboarding_operations as operation
   where operation.id = p_operation_id
   for update;
  if not found
     or operation_row.tenant_id is distinct from operation_tenant_id
     or operation_row.student_id is distinct from operation_student_id
     or operation_row.claim_token is distinct from p_claim_token
     or operation_row.target_lifecycle_status not in (
       'suspended', 'offboarded'
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'claim_lost'
    );
  end if;

  if operation_row.status = 'COMPLETED' then
    completed_result := operation_row.snapshot ->
      'student_lifecycle_finalize_result';
    if pg_catalog.jsonb_typeof(completed_result) = 'object' then
      return completed_result || pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'ALREADY_COMPLETED'
      );
    end if;

    -- Operations completed before this migration have no persisted response.
    -- Their provider/local mutation is still authoritative; derive only the
    -- non-financial counters that can be proven from the durable snapshot.
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_COMPLETED',
      'provider_subscription_final_status',
        operation_row.provider_subscription_final_status,
      'payments_cancelled', 0,
      'billing_periods_exempted', 0,
      'schedules_cancelled', coalesce(
        nullif(operation_row.snapshot ->> 'released_booking_count', '')::integer,
        0
      ),
      'released_teacher_ids', coalesce(
        operation_row.snapshot -> 'released_teacher_ids',
        '[]'::jsonb
      ),
      'notifications_queued', 0
    );
  end if;

  if operation_row.status <> 'PROVIDER_COMPLETE' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', 'claim_lost'
    );
  end if;

  if operation_row.target_lifecycle_status = 'suspended' then
    if operation_row.billing_policy is distinct from 'KEEP_OPEN_INVOICES'
       or operation_row.billing_period_start is null
       or operation_row.billing_cancel_from_date is distinct from
         (operation_row.billing_period_start + interval '1 month')::date
       or operation_row.effective_end_date is null
       or operation_row.provider_subscription_final_status is distinct from
         'INACTIVE'
       or operation_row.preserved_payment_snapshot is distinct from
         '[]'::jsonb
       or exists (
         select 1
           from pg_catalog.jsonb_array_elements(
             operation_row.payment_snapshot
           ) as entry
           left join public.student_payments as payment
             on payment.id = (entry ->> 'id')::uuid
            and payment.tenant_id = operation_row.tenant_id
            and payment.student_id = operation_row.student_id
          where payment.id is null
             or payment.payment_type is distinct from 'SUBSCRIPTION'
             or payment.due_date is distinct from
               (entry ->> 'due_date')::date
             or payment.due_date <
               operation_row.billing_cancel_from_date
             or pg_catalog.round(coalesce(payment.value, 0), 2)
                  is distinct from
                pg_catalog.round((entry ->> 'value')::numeric, 2)
             or coalesce(
                  nullif(pg_catalog.btrim(coalesce(
                    payment.asaas_payment_id,
                    ''
                  )), ''),
                  nullif(pg_catalog.btrim(coalesce(
                    payment.asaas_id,
                    ''
                  )), '')
                ) is distinct from
                nullif(entry ->> 'asaas_payment_id', '')
             or pg_catalog.upper(pg_catalog.btrim(coalesce(
                  payment.status,
                  ''
                ))) not in ('PENDING', 'OVERDUE', 'CANCELLED')
       )
       or exists (
         select 1
           from public.student_payments as payment
          where payment.tenant_id = operation_row.tenant_id
            and payment.student_id = operation_row.student_id
            and payment.payment_type = 'SUBSCRIPTION'
            and payment.due_date >=
              operation_row.billing_cancel_from_date
            and pg_catalog.upper(pg_catalog.btrim(coalesce(
                  payment.status,
                  ''
                ))) not in (
                  'CANCELLED', 'DELETED', 'REFUNDED', 'REVERSED',
                  'NAO_RECEITA'
                )
            and not exists (
              select 1
                from pg_catalog.jsonb_array_elements(
                  operation_row.payment_snapshot
                ) as entry
               where (entry ->> 'id')::uuid = payment.id
            )
       )
    then
      update public.student_offboarding_operations
         set status = 'BLOCKED',
             last_error =
               'suspension_payment_snapshot_changed_before_finalize',
             updated_at = pg_catalog.now()
       where id = operation_row.id;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'reason', 'suspension_payment_snapshot_changed'
      );
    end if;
  end if;

  -- Capture all teachers before the predecessor cancels offboarded bookings.
  -- The stable list is used both for one-notice-per-teacher idempotency and for
  -- send-time revalidation by the notification worker.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(released.teacher_id)
      order by released.teacher_id
    ),
    '[]'::jsonb
  )
    into released_teacher_ids
    from (
      select distinct booking.teacher_id
        from public.bookings as booking
       where booking.tenant_id = operation_row.tenant_id
         and booking.student_id = operation_row.student_id
         and booking.teacher_id is not null
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               booking.status,
               ''
             ))) = 'SCHEDULED'
    ) as released;

  base_result :=
    public.finalize_student_offboarding_pre_schedule_notification_impl(
      p_operation_id,
      p_claim_token
    );
  if coalesce((base_result ->> 'ok')::boolean, false) is false
     or coalesce(base_result ->> 'action', '') <> 'COMPLETED'
  then
    return base_result;
  end if;

  with cancelled_bookings as (
    update public.bookings as booking
       set status = 'CANCELLED'
     where booking.tenant_id = operation_row.tenant_id
       and booking.student_id = operation_row.student_id
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
             booking.status,
             ''
           ))) = 'SCHEDULED'
     returning booking.id
  )
  select pg_catalog.count(*)
    into newly_cancelled_schedules
    from cancelled_bookings;

  schedules_cancelled := coalesce(
    nullif(base_result ->> 'schedules_cancelled', '')::integer,
    0
  ) + newly_cancelled_schedules;

  if operation_row.target_lifecycle_status = 'suspended' then
    with snapshot_ids as (
      select (entry ->> 'id')::uuid as id
        from pg_catalog.jsonb_array_elements(
          operation_row.payment_snapshot
        ) as entry
       where entry ? 'id'
    ), cancelled as (
      update public.student_payments as payment
         set status = 'CANCELLED',
             updated_at = pg_catalog.now()
       where payment.id in (select id from snapshot_ids)
         and payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.status,
               ''
             ))) in ('PENDING', 'OVERDUE')
       returning payment.id
    )
    select pg_catalog.count(*)
      into newly_cancelled_payments
      from cancelled;

    if exists (
      select 1
        from pg_catalog.jsonb_array_elements(
          operation_row.payment_snapshot
        ) as entry
        left join public.student_payments as payment
          on payment.id = (entry ->> 'id')::uuid
         and payment.tenant_id = operation_row.tenant_id
         and payment.student_id = operation_row.student_id
       where payment.id is null
          or pg_catalog.upper(pg_catalog.btrim(coalesce(
               payment.status,
               ''
             ))) <> 'CANCELLED'
    ) then
      raise exception using
        errcode = '40001',
        message = 'suspension_local_payment_cancellation_incomplete';
    end if;
  end if;

  update public.student_offboarding_operations
     set snapshot = snapshot || pg_catalog.jsonb_build_object(
           'released_teacher_ids', released_teacher_ids,
           'released_booking_count', schedules_cancelled,
           'schedule_released_at', pg_catalog.now()
         ),
         updated_at = pg_catalog.now()
   where id = operation_row.id;

  select
    settings.student_notifications_enabled,
    settings.teacher_notifications_enabled
    into student_notification_enabled, teacher_notification_enabled
    from public.tenant_admin_settings as settings
   where settings.tenant_id = operation_row.tenant_id;
  student_notification_enabled := coalesce(
    student_notification_enabled,
    false
  );
  teacher_notification_enabled := coalesce(
    teacher_notification_enabled,
    false
  );

  select profile.*
    into student_row
    from public.profiles as profile
   where profile.id = operation_row.student_id
     and profile.tenant_id = operation_row.tenant_id
     and profile.role = 'STUDENT';
  select tenant.name
    into tenant_name
    from public.tenants as tenant
   where tenant.id = operation_row.tenant_id;

  student_kind := case operation_row.target_lifecycle_status
    when 'suspended' then 'STUDENT_SUSPENDED'
    else 'STUDENT_OFFBOARDED'
  end;
  teacher_kind := case operation_row.target_lifecycle_status
    when 'suspended' then 'TEACHER_STUDENT_SUSPENDED'
    else 'TEACHER_STUDENT_OFFBOARDED'
  end;

  student_destination := coalesce(
    private.normalize_notification_phone(student_row.attendance_phone),
    private.normalize_notification_phone(student_row.phone),
    private.normalize_notification_phone(student_row.guardian_phone)
  );
  student_message := case operation_row.target_lifecycle_status
    when 'suspended' then
      'Oi, ' || private.safe_notification_text(
        pg_catalog.split_part(coalesce(student_row.full_name, 'tudo bem'), ' ', 1),
        80
      ) || '! Passando para confirmar que sua jornada com a ' ||
      private.safe_notification_text(coalesce(tenant_name, 'nossa escola'), 120) ||
      ' ficará em pausa. Seus horários fixos foram liberados por enquanto. ' ||
      'Quando for o momento de retomar, nossa equipe estará pronta para ' ||
      'organizar uma nova agenda com carinho. Se precisar, conte com a gente.'
    else
      'Oi, ' || private.safe_notification_text(
        pg_catalog.split_part(coalesce(student_row.full_name, 'tudo bem'), ' ', 1),
        80
      ) || '! Registramos o encerramento da sua matrícula na ' ||
      private.safe_notification_text(coalesce(tenant_name, 'nossa escola'), 120) ||
      ', conforme alinhado com a equipe. Agradecemos por ter feito parte da ' ||
      'nossa escola. Seus horários fixos foram liberados e, se quiser voltar ' ||
      'no futuro, será um prazer receber você novamente. Conte com a gente.'
  end;

  if student_notification_enabled
     and coalesce(student_row.is_test_account, false) is false
     and student_destination is not null
  then
    insert into public.notification_queue (
      tenant_id,
      teacher_id,
      student_id,
      student_name,
      student_phone,
      message_body,
      scheduled_for,
      status,
      attempts,
      next_attempt_at,
      delivery_status,
      notification_kind,
      source_id,
      source_type,
      class_date,
      idempotency_key
    ) values (
      operation_row.tenant_id,
      null,
      operation_row.student_id,
      student_row.full_name,
      student_destination,
      student_message,
      pg_catalog.now(),
      'pending',
      0,
      pg_catalog.now(),
      'queued',
      student_kind,
      operation_row.id,
      'STUDENT_LIFECYCLE',
      null,
      'student-lifecycle:' || operation_row.id::text || ':student:' ||
        operation_row.target_lifecycle_status
    )
    on conflict (tenant_id, idempotency_key)
      where idempotency_key is not null
    do nothing;
    get diagnostics inserted_count = row_count;
    notifications_queued := notifications_queued + inserted_count;
  end if;

  if teacher_notification_enabled then
    for teacher_row in
      select
        profile.id,
        profile.full_name,
        coalesce(
          private.normalize_notification_phone(profile.phone),
          private.normalize_notification_phone(profile.attendance_phone)
        ) as destination
      from public.profiles as profile
      join pg_catalog.jsonb_array_elements_text(
        released_teacher_ids
      ) as released(teacher_id)
        on profile.id = released.teacher_id::uuid
     where profile.tenant_id = operation_row.tenant_id
       and profile.role = 'TEACHER'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             profile.lifecycle_status,
             ''
           ))) = 'active'
       and coalesce(profile.is_test_account, false) is false
     order by profile.id
    loop
      if teacher_row.destination is null then
        continue;
      end if;

      teacher_message := case operation_row.target_lifecycle_status
        when 'suspended' then
          'Oi, ' || private.safe_notification_text(
            pg_catalog.split_part(
              coalesce(teacher_row.full_name, 'professor(a)'),
              ' ',
              1
            ),
            80
          ) || '! Atualização da coordenação: as aulas de ' ||
          private.safe_notification_text(
            coalesce(student_row.full_name, 'seu aluno'),
            120
          ) || ' ficarão em pausa, e os horários fixos já foram liberados ' ||
          'na sua agenda. Não é necessário manter esses slots reservados. ' ||
          'Se precisar de algum ajuste, fale com a coordenação.'
        else
          'Oi, ' || private.safe_notification_text(
            pg_catalog.split_part(
              coalesce(teacher_row.full_name, 'professor(a)'),
              ' ',
              1
            ),
            80
          ) || '! Atualização da coordenação: a matrícula de ' ||
          private.safe_notification_text(
            coalesce(student_row.full_name, 'seu aluno'),
            120
          ) || ' foi encerrada, e os horários fixos já foram liberados na ' ||
          'sua agenda. Obrigado por todo o acompanhamento. Se precisar de ' ||
          'algum ajuste, fale com a coordenação.'
      end;

      insert into public.notification_queue (
        tenant_id,
        teacher_id,
        student_id,
        student_name,
        student_phone,
        message_body,
        scheduled_for,
        status,
        attempts,
        next_attempt_at,
        delivery_status,
        notification_kind,
        source_id,
        source_type,
        class_date,
        idempotency_key
      ) values (
        operation_row.tenant_id,
        teacher_row.id,
        operation_row.student_id,
        student_row.full_name,
        teacher_row.destination,
        teacher_message,
        pg_catalog.now(),
        'pending',
        0,
        pg_catalog.now(),
        'queued',
        teacher_kind,
        operation_row.id,
        'STUDENT_LIFECYCLE',
        null,
        'student-lifecycle:' || operation_row.id::text || ':teacher:' ||
          teacher_row.id::text || ':' ||
          operation_row.target_lifecycle_status
      )
      on conflict (tenant_id, idempotency_key)
        where idempotency_key is not null
      do nothing;
      get diagnostics inserted_count = row_count;
      notifications_queued := notifications_queued + inserted_count;
    end loop;
  end if;

  final_result := base_result || pg_catalog.jsonb_build_object(
    'payments_cancelled', coalesce(
      nullif(base_result ->> 'payments_cancelled', '')::integer,
      0
    ) + newly_cancelled_payments,
    'schedules_cancelled', schedules_cancelled,
    'released_teacher_ids', released_teacher_ids,
    'notifications_queued', notifications_queued
  );

  update public.student_offboarding_operations
     set snapshot = snapshot || pg_catalog.jsonb_build_object(
           'student_lifecycle_finalize_result', final_result
         ),
         updated_at = pg_catalog.now()
   where id = operation_row.id;

  return final_result;
end;
$function$;

alter function public.finalize_student_offboarding_with_billing_policy(
  uuid, uuid
) owner to postgres;
revoke all on function public.finalize_student_offboarding_with_billing_policy(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.finalize_student_offboarding_with_billing_policy(
  uuid, uuid
) to service_role;

-- lifecycle_status is the canonical roster state.  Keep the historical status
-- label and financial roster synchronized whenever a lifecycle writer runs;
-- ARCHIVED remains terminal and is never downgraded to SUSPENDED.
create or replace function private.normalize_offboarded_student_financial_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  canonical_lifecycle text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(new.lifecycle_status, ''))
  );
begin
  if new.role = 'STUDENT' then
    if canonical_lifecycle in ('suspended', 'offboarded') then
      new.status := 'Inativo';
      if pg_catalog.upper(pg_catalog.btrim(coalesce(
           new.status_financial,
           ''
         ))) <> 'ARCHIVED'
      then
        new.status_financial := 'SUSPENDED';
      end if;
    elsif canonical_lifecycle = 'active'
          and pg_catalog.lower(pg_catalog.btrim(coalesce(
                new.status,
                ''
              ))) in ('active', 'ativo')
    then
      new.status := 'Ativo';
      -- Suspension is a forecast fence, not a permanent financial verdict.
      -- Reset only the SUSPENDED marker introduced by the pause so the
      -- reactivation finalizer's following aggregate recompute can retain
      -- ACTIVE when there is no decisive competence or derive OVERDUE/PENDING
      -- from payment truth. ARCHIVED remains terminal and is never reopened.
      if tg_op = 'UPDATE'
         and pg_catalog.lower(pg_catalog.btrim(coalesce(
               old.lifecycle_status,
               ''
             ))) = 'suspended'
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               old.status_financial,
               ''
             ))) <> 'ARCHIVED'
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
               new.status_financial,
               ''
             ))) = 'SUSPENDED'
      then
        new.status_financial := 'ACTIVE';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

alter function private.normalize_offboarded_student_financial_state()
  owner to postgres;
revoke all on function private.normalize_offboarded_student_financial_state()
  from public, anon, authenticated, service_role;

drop trigger if exists normalize_offboarded_student_financial_state
  on public.profiles;
create trigger normalize_offboarded_student_financial_state
before insert or update of
  role, lifecycle_status, status, status_financial
on public.profiles
for each row
execute function private.normalize_offboarded_student_financial_state();

-- Repair only the safe direction in legacy data: an explicitly inactive
-- lifecycle can never remain active in the legacy roster or in forecasts.
-- We intentionally do not convert a legacy Inativo/active mismatch to active;
-- doing so could re-enable communication before billing is reconciled.
update public.profiles as profile
   set status = 'Inativo',
       status_financial = case
         when pg_catalog.upper(pg_catalog.btrim(coalesce(
                profile.status_financial,
                ''
              ))) = 'ARCHIVED'
           then profile.status_financial
         else 'SUSPENDED'
       end
 where profile.role = 'STUDENT'
   and pg_catalog.lower(pg_catalog.btrim(coalesce(
         profile.lifecycle_status,
         ''
       ))) in ('suspended', 'offboarded')
   and (
     profile.status is distinct from 'Inativo'
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
          profile.status_financial,
          ''
        ))) not in ('SUSPENDED', 'ARCHIVED')
   );

create or replace function public.is_student_notifiable(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select
      profile.role = 'STUDENT'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(
            profile.lifecycle_status,
            ''
          ))) = 'active'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(
            profile.status,
            'Ativo'
          ))) not in (
            'inativo', 'inactive', 'arquivado', 'cancelado', 'trancado'
          )
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
            profile.status_financial,
            'ACTIVE'
          ))) <> 'ARCHIVED'
    from public.profiles as profile
    where profile.id = p_id
      and (
        coalesce(auth.jwt() ->> 'role', '') = 'service_role'
        or auth.uid() = profile.id
        or (
          auth.uid() is null
          and session_user in ('postgres', 'supabase_admin')
        )
        or exists (
          select 1
            from public.profiles as actor
           where actor.id = auth.uid()
             and pg_catalog.upper(pg_catalog.btrim(coalesce(
                   actor.role,
                   ''
                 ))) = 'SUPER_ADMIN'
             and pg_catalog.lower(pg_catalog.btrim(coalesce(
                   actor.lifecycle_status,
                   ''
                 ))) = 'active'
        )
        or exists (
          select 1
            from public.profiles as actor
            join public.tenant_memberships as membership
              on membership.user_id = actor.id
             and membership.tenant_id = profile.tenant_id
             and membership.status = 'ACTIVE'
             and membership.role in (
               'SUPER_ADMIN', 'SCHOOL_ADMIN', 'ADMIN', 'COORDINATOR',
               'TEACHER'
             )
           where actor.id = auth.uid()
             and actor.tenant_id = profile.tenant_id
             and pg_catalog.upper(pg_catalog.btrim(coalesce(
                   actor.role,
                   ''
                 ))) in (
                   'SUPER_ADMIN', 'SCHOOL_ADMIN', 'ADMIN', 'COORDINATOR',
                   'TEACHER'
                 )
             and pg_catalog.lower(pg_catalog.btrim(coalesce(
                   actor.lifecycle_status,
                   ''
                 ))) = 'active'
        )
      )
  ), false);
$function$;

alter function public.is_student_notifiable(uuid) owner to postgres;
revoke all on function public.is_student_notifiable(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.is_student_notifiable(uuid)
  to authenticated, service_role;

-- A released slot must not be recreated after the lifecycle commits.  The
-- same student-scoped advisory lock closes the race in both directions:
-- either this booking is committed first and the finalizer cancels it, or the
-- lifecycle commits first and this trigger rejects the stale schedule write.
create or replace function private.guard_active_student_scheduled_booking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.student_id is null
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
          new.status,
          ''
        ))) <> 'SCHEDULED'
  then
    return new;
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || coalesce(new.tenant_id, '') || ':' ||
        new.student_id::text,
      0
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'student_lifecycle_operation_in_flight';
  end if;

  perform 1
    from public.profiles as student
   where student.id = new.student_id
     and student.tenant_id = new.tenant_id
     and student.role = 'STUDENT'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
           student.lifecycle_status,
           ''
         ))) = 'active'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
           student.status,
           'Ativo'
         ))) not in (
           'inativo', 'inactive', 'arquivado', 'cancelado', 'trancado'
         )
   for key share;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'inactive_student_scheduled_booking_forbidden';
  end if;

  return new;
end;
$function$;

alter function private.guard_active_student_scheduled_booking()
  owner to postgres;
revoke all on function private.guard_active_student_scheduled_booking()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_active_student_scheduled_booking
  on public.bookings;
create trigger guard_active_student_scheduled_booking
before insert or update of tenant_id, student_id, status
on public.bookings
for each row
execute function private.guard_active_student_scheduled_booking();

-- Release stale recurring slots that predate the durable lifecycle operation.
-- This is deliberately a direct roster repair: it does not create an operation
-- or enqueue a retroactive student/teacher notice.
update public.bookings as booking
   set status = 'CANCELLED'
  from public.profiles as student
 where student.id = booking.student_id
   and student.tenant_id = booking.tenant_id
   and student.role = 'STUDENT'
   and pg_catalog.lower(pg_catalog.btrim(coalesce(
         student.lifecycle_status,
         ''
       ))) in ('suspended', 'offboarded')
   and pg_catalog.upper(pg_catalog.btrim(coalesce(
         booking.status,
         ''
       ))) = 'SCHEDULED';

do $postcheck$
declare
  receipt_owner text;
begin
  select pg_catalog.pg_get_userbyid(class.relowner)
    into receipt_owner
    from pg_catalog.pg_class as class
   where class.oid =
     'private.enrollment_offer_command_receipts'::pg_catalog.regclass;

  if receipt_owner is distinct from 'postgres'
     or pg_catalog.has_table_privilege(
       'authenticated',
       'private.enrollment_offer_command_receipts',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'private.enrollment_offer_command_receipts',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'private.enrollment_offer_command_receipts',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'private.enrollment_offer_command_receipts',
       'DELETE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'private.enrollment_offer_command_receipts',
       'SELECT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'private.enrollment_offer_command_receipts',
       'INSERT'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'private.enrollment_offer_command_receipts',
       'UPDATE'
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'private.enrollment_offer_command_receipts',
       'DELETE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.begin_student_offboarding_with_billing_policy(text,uuid,uuid,text,text,text,date,uuid,integer)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.finalize_student_offboarding_with_billing_policy(uuid,uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.begin_student_offboarding_with_billing_policy(text,uuid,uuid,text,text,text,date,uuid,integer)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.finalize_student_offboarding_with_billing_policy(uuid,uuid)',
       'EXECUTE'
     )
     or pg_catalog.to_regclass(
       'public.student_payments_lifecycle_due_idx'
     ) is null
     or not exists (
       select 1
         from pg_catalog.pg_proc as proc
        where proc.oid =
          'public.is_student_notifiable(uuid)'::pg_catalog.regprocedure
          and proc.prosecdef
     )
     or pg_catalog.pg_get_functiondef(
       'private.guard_active_student_scheduled_booking()'::
         pg_catalog.regprocedure
     ) not like '%pg_try_advisory_xact_lock%'
     or not exists (
       select 1
         from pg_catalog.pg_trigger as trigger
        where trigger.tgrelid = 'public.bookings'::pg_catalog.regclass
          and trigger.tgname = 'guard_active_student_scheduled_booking'
          and not trigger.tgisinternal
          and trigger.tgenabled <> 'D'
     )
     or exists (
       select 1
         from public.profiles as profile
        where profile.role = 'STUDENT'
          and pg_catalog.lower(pg_catalog.btrim(coalesce(
                profile.lifecycle_status,
                ''
              ))) in ('suspended', 'offboarded')
          and (
            profile.status is distinct from 'Inativo'
            or pg_catalog.upper(pg_catalog.btrim(coalesce(
                 profile.status_financial,
                 ''
               ))) not in ('SUSPENDED', 'ARCHIVED')
          )
     )
     or exists (
       select 1
         from public.bookings as booking
         join public.profiles as student
           on student.id = booking.student_id
          and student.tenant_id = booking.tenant_id
        where student.role = 'STUDENT'
          and pg_catalog.lower(pg_catalog.btrim(coalesce(
                student.lifecycle_status,
                ''
              ))) in ('suspended', 'offboarded')
          and pg_catalog.upper(pg_catalog.btrim(coalesce(
                booking.status,
                ''
              ))) = 'SCHEDULED'
     )
  then
    raise exception
      'enrollment offer/student lifecycle hardening was not installed safely';
  end if;
end;
$postcheck$;

commit;
