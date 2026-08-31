-- Suspension/offboarding provider-first snapshots, schedule release and
-- lifecycle notification outbox invariants.

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

grant execute on function pg_temp.assert_true(boolean, text)
  to authenticated, service_role;

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  false
);

select pg_temp.assert_true(
  (
    select pg_catalog.pg_get_userbyid(class.relowner) = 'postgres'
      from pg_catalog.pg_class as class
     where class.oid =
       'private.enrollment_offer_command_receipts'::pg_catalog.regclass
  )
  and not pg_catalog.has_table_privilege(
    'authenticated',
    'private.enrollment_offer_command_receipts',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    'service_role',
    'private.enrollment_offer_command_receipts',
    'INSERT'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.begin_student_offboarding_pre_suspension_future_charge_impl(text,uuid,uuid,text,text,text,date,uuid,integer)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.finalize_student_offboarding_pre_schedule_notification_impl(uuid,uuid)',
    'EXECUTE'
  )
  and exists (
    select 1
      from pg_catalog.pg_proc as proc
     where proc.oid =
       'public.is_student_notifiable(uuid)'::pg_catalog.regprocedure
       and proc.prosecdef
  )
  and pg_catalog.to_regclass(
    'public.student_payments_lifecycle_due_idx'
  ) is not null
  and exists (
    select 1
      from pg_catalog.pg_trigger as trigger
     where trigger.tgrelid = 'public.bookings'::pg_catalog.regclass
       and trigger.tgname = 'guard_active_student_scheduled_booking'
       and not trigger.tgisinternal
       and trigger.tgenabled <> 'D'
  )
  and pg_catalog.pg_get_functiondef(
    'private.guard_active_student_scheduled_booking()'::
      pg_catalog.regprocedure
  ) like '%pg_try_advisory_xact_lock%'
  and pg_catalog.pg_get_functiondef(
    'private.guard_active_student_scheduled_booking()'::
      pg_catalog.regprocedure
  ) not like '%perform pg_catalog.pg_advisory_xact_lock%',
  'lifecycle ACL, trigger or supporting index is not hardened'
);

create temporary table lifecycle_financial_transition_probe (
  id integer primary key,
  role text,
  lifecycle_status text,
  status text,
  status_financial text
);
create trigger normalize_lifecycle_financial_transition_probe
before insert or update of
  role, lifecycle_status, status, status_financial
on lifecycle_financial_transition_probe
for each row
execute function private.normalize_offboarded_student_financial_state();

insert into lifecycle_financial_transition_probe values
  (1, 'STUDENT', 'suspended', 'Ativo', 'SUSPENDED'),
  (2, 'STUDENT', 'suspended', 'Ativo', 'ARCHIVED');
update lifecycle_financial_transition_probe
   set lifecycle_status = 'active',
       status = 'Ativo';
select pg_temp.assert_true(
  (
    select pg_catalog.bool_and(
      probe.status = 'Ativo'
      and probe.status_financial = case probe.id
        when 1 then 'ACTIVE'
        else 'ARCHIVED'
      end
    )
      from lifecycle_financial_transition_probe as probe
  ),
  'suspended-to-active reset did not preserve terminal ARCHIVED state'
);

insert into public.tenants (
  id, name, slug, saas_status, whatsapp_enabled
) values
  (
    'student-lifecycle-hardening-school',
    'Student Lifecycle Hardening School',
    'student-lifecycle-hardening-school',
    'active',
    true
  ),
  (
    'student-lifecycle-hardening-other',
    'Student Lifecycle Other School',
    'student-lifecycle-hardening-other',
    'active',
    false
  );

update public.tenant_admin_settings
   set student_notifications_enabled = true,
       teacher_notifications_enabled = true
 where tenant_id = 'student-lifecycle-hardening-school';

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values
  (
    '6a000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated',
    'lifecycle-suspended@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Suspended Student"}', now(), now()
  ),
  (
    '6a000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated',
    'lifecycle-offboarded@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Offboarded Student"}', now(), now()
  ),
  (
    '6a000000-0000-4000-8000-000000000011',
    'authenticated', 'authenticated',
    'lifecycle-teacher-one@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Teacher One"}', now(), now()
  ),
  (
    '6a000000-0000-4000-8000-000000000012',
    'authenticated', 'authenticated',
    'lifecycle-teacher-two@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Teacher Two"}', now(), now()
  ),
  (
    '6a000000-0000-4000-8000-000000000021',
    'authenticated', 'authenticated',
    'lifecycle-other-admin@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Other School Admin"}', now(), now()
  ),
  (
    '6a000000-0000-4000-8000-000000000022',
    'authenticated', 'authenticated',
    'lifecycle-coordinator@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Lifecycle Coordinator"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'student-lifecycle-hardening-school',
       role = case
         when id in (
           '6a000000-0000-4000-8000-000000000001'::uuid,
           '6a000000-0000-4000-8000-000000000002'::uuid
         ) then 'STUDENT'
         else 'TEACHER'
       end,
       full_name = case id
         when '6a000000-0000-4000-8000-000000000001'::uuid
           then 'Aluno Pausa'
         when '6a000000-0000-4000-8000-000000000002'::uuid
           then 'Aluno Encerramento'
         when '6a000000-0000-4000-8000-000000000011'::uuid
           then 'Teacher Um'
         else 'Teacher Dois'
       end,
       phone = case id
         when '6a000000-0000-4000-8000-000000000001'::uuid
           then '5511999999001'
         when '6a000000-0000-4000-8000-000000000002'::uuid
           then '5511999999002'
         when '6a000000-0000-4000-8000-000000000011'::uuid
           then '5511999999011'
         else '5511999999012'
       end,
       status = 'Ativo',
       lifecycle_status = 'active',
       monthly_fee = case
         when id in (
           '6a000000-0000-4000-8000-000000000001'::uuid,
           '6a000000-0000-4000-8000-000000000002'::uuid
         ) then 250
         else monthly_fee
       end,
       due_day = case
         when id in (
           '6a000000-0000-4000-8000-000000000001'::uuid,
           '6a000000-0000-4000-8000-000000000002'::uuid
         ) then 15
         else due_day
       end,
       asaas_customer_id = case id
         when '6a000000-0000-4000-8000-000000000001'::uuid
           then 'cus_lifecycle_suspend'
         when '6a000000-0000-4000-8000-000000000002'::uuid
           then 'cus_lifecycle_offboard'
         else asaas_customer_id
       end,
       subscription_id = case id
         when '6a000000-0000-4000-8000-000000000001'::uuid
           then 'sub_lifecycle_suspend'
         when '6a000000-0000-4000-8000-000000000002'::uuid
           then 'sub_lifecycle_offboard'
         else subscription_id
       end
 where id in (
   '6a000000-0000-4000-8000-000000000001',
   '6a000000-0000-4000-8000-000000000002',
   '6a000000-0000-4000-8000-000000000011',
   '6a000000-0000-4000-8000-000000000012'
 );
update public.profiles
   set tenant_id = 'student-lifecycle-hardening-other',
       role = 'SCHOOL_ADMIN',
       full_name = 'Other School Admin',
       phone = '5511999999021',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '6a000000-0000-4000-8000-000000000021';
update public.profiles
   set tenant_id = 'student-lifecycle-hardening-school',
       role = 'COORDINATOR',
       full_name = 'Lifecycle Coordinator',
       phone = '5511999999022',
       status = 'Ativo',
       lifecycle_status = 'active'
 where id = '6a000000-0000-4000-8000-000000000022';
set local app.enrollment_claim = '';

delete from public.tenant_memberships
 where user_id in (
   '6a000000-0000-4000-8000-000000000001',
   '6a000000-0000-4000-8000-000000000002',
   '6a000000-0000-4000-8000-000000000011',
   '6a000000-0000-4000-8000-000000000012',
   '6a000000-0000-4000-8000-000000000021',
   '6a000000-0000-4000-8000-000000000022'
 );
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
) values
  (
    '6a000000-0000-4000-8000-000000000001',
    'student-lifecycle-hardening-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '6a000000-0000-4000-8000-000000000002',
    'student-lifecycle-hardening-school', 'STUDENT', 'ACTIVE', true
  ),
  (
    '6a000000-0000-4000-8000-000000000011',
    'student-lifecycle-hardening-school', 'TEACHER', 'ACTIVE', true
  ),
  (
    '6a000000-0000-4000-8000-000000000012',
    'student-lifecycle-hardening-school', 'TEACHER', 'ACTIVE', true
  ),
  (
    '6a000000-0000-4000-8000-000000000021',
    'student-lifecycle-hardening-other', 'SCHOOL_ADMIN', 'ACTIVE', true
  ),
  (
    '6a000000-0000-4000-8000-000000000022',
    'student-lifecycle-hardening-school', 'COORDINATOR', 'ACTIVE', true
  );

set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"6a000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  public.is_student_notifiable(
    '6a000000-0000-4000-8000-000000000001'
  )
  and not public.is_student_notifiable(
    '6a000000-0000-4000-8000-000000000002'
  ),
  'authenticated student visibility was not restricted to self'
);
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"6a000000-0000-4000-8000-000000000011","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  public.is_student_notifiable(
    '6a000000-0000-4000-8000-000000000001'
  ),
  'active same-tenant teacher lost authorized student visibility'
);
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"6a000000-0000-4000-8000-000000000022","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  public.is_student_notifiable(
    '6a000000-0000-4000-8000-000000000001'
  ),
  'active same-tenant coordinator lost authorized student visibility'
);
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"6a000000-0000-4000-8000-000000000021","role":"authenticated"}',
  true
);
select pg_temp.assert_true(
  not public.is_student_notifiable(
    '6a000000-0000-4000-8000-000000000001'
  ),
  'cross-tenant school administrator could inspect student eligibility'
);
reset role;
select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

create temporary table lifecycle_clock as
select
  (pg_catalog.now() at time zone 'America/Sao_Paulo')::date as today,
  pg_catalog.date_trunc(
    'month',
    pg_catalog.now() at time zone 'America/Sao_Paulo'
  )::date as period_start;

insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, amount_cents, status, provider_status, due_date,
  payment_type, billing_type
)
select
  fixture.id,
  '6a000000-0000-4000-8000-000000000001',
  'student-lifecycle-hardening-school',
  fixture.provider_id,
  'cus_lifecycle_suspend',
  250,
  25000,
  'PENDING',
  'PENDING',
  clock.period_start + fixture.month_offset * interval '1 month' +
    interval '14 days',
  'SUBSCRIPTION',
  'PIX'
from lifecycle_clock as clock
cross join lateral (
  values
    (
      '6a000000-0000-4000-8000-000000000101'::uuid,
      'pay_lifecycle_suspend_current',
      0
    ),
    (
      '6a000000-0000-4000-8000-000000000102'::uuid,
      'pay_lifecycle_suspend_future',
      1
    )
) as fixture(id, provider_id, month_offset);

insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
) values
  (
    '6a000000-0000-4000-8000-000000000201',
    'student-lifecycle-hardening-school',
    '6a000000-0000-4000-8000-000000000011',
    '6a000000-0000-4000-8000-000000000001',
    'Monday', '10:00', 'SCHEDULED', date '2026-01-01'
  ),
  (
    '6a000000-0000-4000-8000-000000000202',
    'student-lifecycle-hardening-school',
    '6a000000-0000-4000-8000-000000000012',
    '6a000000-0000-4000-8000-000000000001',
    'Tuesday', '11:00', 'SCHEDULED', date '2026-01-01'
  ),
  (
    '6a000000-0000-4000-8000-000000000203',
    'student-lifecycle-hardening-school',
    '6a000000-0000-4000-8000-000000000011',
    '6a000000-0000-4000-8000-000000000002',
    'Wednesday', '12:00', 'SCHEDULED', date '2026-01-01'
  );

select pg_temp.assert_true(
  public.is_student_notifiable(
    '6a000000-0000-4000-8000-000000000001'
  ),
  'active student was not notifiable before suspension'
);

create temporary table lifecycle_results (
  label text primary key,
  payload jsonb not null
);

insert into lifecycle_results (label, payload)
select 'suspend_begin', public.begin_student_offboarding_with_billing_policy(
  'student-lifecycle-hardening-school',
  '6a000000-0000-4000-8000-000000000001',
  null,
  'suspended',
  'Fixture suspension',
  'KEEP_OPEN_INVOICES',
  clock.today,
  '6a000000-0000-4000-8000-000000000301',
  300
)
from lifecycle_clock as clock;

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PROCEED'
       and payload ->> 'billing_policy' = 'KEEP_OPEN_INVOICES'
       and (payload ->> 'billing_cancel_from_date')::date =
         (
           select (period_start + interval '1 month')::date
             from lifecycle_clock
         )
       and pg_catalog.jsonb_array_length(
         payload -> 'payment_snapshot'
       ) = 1
       and payload #>> '{payment_snapshot,0,asaas_payment_id}' =
         'pay_lifecycle_suspend_future'
      from lifecycle_results
     where label = 'suspend_begin'
  ),
  'suspension did not freeze exactly the future open charge'
);

insert into lifecycle_results (label, payload)
select 'suspend_bind', public.bind_student_offboarding_integrations(
  (payload ->> 'operation_id')::uuid,
  '6a000000-0000-4000-8000-000000000301',
  'integration_lifecycle_subscription',
  1,
  'production',
  'TENANT_BYOK',
  'integration_lifecycle_payment',
  1,
  'production',
  'TENANT_BYOK'
)
from lifecycle_results
where label = 'suspend_begin';

update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE',
       provider_started_at = pg_catalog.now(),
       provider_completed_at = pg_catalog.now()
 where id = (
   select (payload ->> 'operation_id')::uuid
     from lifecycle_results
    where label = 'suspend_begin'
 );

-- A charge that appeared after the provider snapshot must not be hidden by a
-- lifecycle transition, including a future charge already marked settled.
insert into public.student_payments (
  id, student_id, tenant_id, asaas_payment_id, provider_customer_id,
  value, amount_cents, status, provider_status, due_date,
  payment_type, billing_type
)
select
  '6a000000-0000-4000-8000-000000000103',
  '6a000000-0000-4000-8000-000000000001',
  'student-lifecycle-hardening-school',
  'pay_lifecycle_suspend_late_settled',
  'cus_lifecycle_suspend',
  250,
  25000,
  'CONFIRMED',
  'CONFIRMED',
  clock.period_start + interval '1 month' + interval '20 days',
  'SUBSCRIPTION',
  'PIX'
from lifecycle_clock as clock;

insert into lifecycle_results (label, payload)
select 'suspend_finalize_late_charge',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '6a000000-0000-4000-8000-000000000301'
       )
  from lifecycle_results
 where label = 'suspend_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'ok' = 'false'
       and payload ->> 'reason' =
         'suspension_payment_snapshot_changed'
      from lifecycle_results
     where label = 'suspend_finalize_late_charge'
  )
  and (
    select operation.status = 'BLOCKED'
      from public.student_offboarding_operations as operation
     where operation.id = (
       select (payload ->> 'operation_id')::uuid
         from lifecycle_results
        where label = 'suspend_begin'
     )
  ),
  'a future settled charge created after begin did not fail closed'
);

-- Simulate the explicit reconciliation required after the blocked attempt.
update public.student_payments
   set status = 'CANCELLED',
       provider_status = 'DELETED'
 where id = '6a000000-0000-4000-8000-000000000103';
update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE',
       last_error = null
 where id = (
   select (payload ->> 'operation_id')::uuid
     from lifecycle_results
    where label = 'suspend_begin'
 );

insert into lifecycle_results (label, payload)
select 'suspend_finalize',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '6a000000-0000-4000-8000-000000000301'
       )
  from lifecycle_results
 where label = 'suspend_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'COMPLETED'
       and (payload ->> 'payments_cancelled')::integer = 1
       and (payload ->> 'schedules_cancelled')::integer = 2
       and (payload ->> 'notifications_queued')::integer = 3
      from lifecycle_results
     where label = 'suspend_finalize'
  )
  and (
    select lifecycle_status = 'suspended'
       and status = 'Inativo'
       and status_financial = 'SUSPENDED'
      from public.profiles
     where id = '6a000000-0000-4000-8000-000000000001'
  )
  and not public.is_student_notifiable(
    '6a000000-0000-4000-8000-000000000001'
  )
  and (
    select pg_catalog.bool_and(
             payment.status = expected.expected_status
           )
      from (
        values
          (
            '6a000000-0000-4000-8000-000000000101'::uuid,
            'PENDING'::text
          ),
          (
            '6a000000-0000-4000-8000-000000000102'::uuid,
            'CANCELLED'::text
          )
      ) as expected(id, expected_status)
      join public.student_payments as payment using (id)
  )
  and (
    select pg_catalog.count(*) = 2
       and pg_catalog.bool_and(booking.status = 'CANCELLED')
      from public.bookings as booking
     where booking.student_id =
       '6a000000-0000-4000-8000-000000000001'
  ),
  'suspension did not converge roster, future billing and both teacher slots'
);

select pg_temp.assert_true(
  (
    select operation.snapshot -> 'released_teacher_ids' =
      pg_catalog.jsonb_build_array(
        '6a000000-0000-4000-8000-000000000011',
        '6a000000-0000-4000-8000-000000000012'
      )
      from public.student_offboarding_operations as operation
     where operation.id = (
       select (payload ->> 'operation_id')::uuid
         from lifecycle_results
        where label = 'suspend_begin'
     )
  )
  and (
    select pg_catalog.count(*) = 3
       and pg_catalog.count(distinct queue.idempotency_key) = 3
       and pg_catalog.bool_and(queue.source_type = 'STUDENT_LIFECYCLE')
       and pg_catalog.bool_and(queue.source_id = (
         select (payload ->> 'operation_id')::uuid
           from lifecycle_results
          where label = 'suspend_begin'
       ))
       and pg_catalog.bool_and(queue.student_id =
         '6a000000-0000-4000-8000-000000000001')
       and pg_catalog.bool_and(queue.class_date is null)
      from public.notification_queue as queue
     where queue.source_id = (
       select (payload ->> 'operation_id')::uuid
         from lifecycle_results
        where label = 'suspend_begin'
     )
       and queue.notification_kind in (
         'STUDENT_SUSPENDED',
         'TEACHER_STUDENT_SUSPENDED'
       )
  ),
  'released teachers or idempotent lifecycle outbox bindings are incomplete'
);

insert into lifecycle_results (label, payload)
select 'suspend_finalize_retry',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '6a000000-0000-4000-8000-000000000301'
       )
  from lifecycle_results
 where label = 'suspend_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'ok' = 'true'
       and payload ->> 'action' = 'ALREADY_COMPLETED'
       and (payload ->> 'payments_cancelled')::integer = 1
       and (payload ->> 'schedules_cancelled')::integer = 2
       and (payload ->> 'notifications_queued')::integer = 3
      from lifecycle_results
     where label = 'suspend_finalize_retry'
  )
  and (
    select pg_catalog.count(*) = 3
      from public.notification_queue as queue
     where queue.source_id = (
       select (payload ->> 'operation_id')::uuid
         from lifecycle_results
        where label = 'suspend_begin'
     )
       and queue.source_type = 'STUDENT_LIFECYCLE'
  ),
  'a retry after committed finalization was not idempotent'
);

do $inactive_booking_guard$
begin
  begin
    insert into public.bookings (
      id, tenant_id, teacher_id, student_id,
      day_of_week, time_slot, status, start_date
    ) values (
      '6a000000-0000-4000-8000-000000000204',
      'student-lifecycle-hardening-school',
      '6a000000-0000-4000-8000-000000000011',
      '6a000000-0000-4000-8000-000000000001',
      'Thursday', '13:00', 'SCHEDULED', date '2026-01-01'
    );
    raise exception 'assertion failed: inactive student recovered a slot';
  exception when check_violation then
    if sqlerrm <> 'inactive_student_scheduled_booking_forbidden' then
      raise;
    end if;
  end;
end;
$inactive_booking_guard$;

insert into lifecycle_results (label, payload)
select 'reactivate_begin', public.begin_student_reactivation(
  'student-lifecycle-hardening-school',
  '6a000000-0000-4000-8000-000000000001',
  null,
  '6a000000-0000-4000-8000-000000000303',
  300
);

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'PROCEED'
       and payload ->> 'provider_subscription_final_status' = 'ACTIVE'
      from lifecycle_results
     where label = 'reactivate_begin'
  ),
  'reactivation did not freeze the paused subscription terms'
);

update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE',
       provider_started_at = pg_catalog.now(),
       provider_completed_at = pg_catalog.now()
 where id = (
   select (payload ->> 'operation_id')::uuid
     from lifecycle_results
    where label = 'reactivate_begin'
 );

insert into lifecycle_results (label, payload)
select 'reactivate_finalize', public.finalize_student_reactivation(
  (payload ->> 'operation_id')::uuid,
  '6a000000-0000-4000-8000-000000000303'
)
from lifecycle_results
where label = 'reactivate_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'COMPLETED'
      from lifecycle_results
     where label = 'reactivate_finalize'
  )
  and (
    select profile.lifecycle_status = 'active'
       and profile.status = 'Ativo'
       and profile.status_financial = 'ACTIVE'
       and profile.asaas_subscription_status = 'ACTIVE'
      from public.profiles as profile
     where profile.id = '6a000000-0000-4000-8000-000000000001'
  ),
  'pause-to-reactivate kept the transient SUSPENDED financial marker'
);

-- Once active again, payment truth must remain authoritative over the reset.
update public.student_payments
   set status = 'OVERDUE',
       provider_status = 'OVERDUE'
 where id = '6a000000-0000-4000-8000-000000000101';
insert into lifecycle_results (label, payload)
select 'reactivate_overdue_recompute',
       public.recompute_student_financial_status(
         'student-lifecycle-hardening-school',
         '6a000000-0000-4000-8000-000000000001'
       );

select pg_temp.assert_true(
  (
    select payload ->> 'ok' = 'true'
       and payload ->> 'status' = 'OVERDUE'
      from lifecycle_results
     where label = 'reactivate_overdue_recompute'
  )
  and (
    select profile.status_financial = 'OVERDUE'
      from public.profiles as profile
     where profile.id = '6a000000-0000-4000-8000-000000000001'
  ),
  'reactivation reset prevented aggregate OVERDUE derivation'
);

insert into lifecycle_results (label, payload)
select 'offboard_begin', public.begin_student_offboarding_with_billing_policy(
  'student-lifecycle-hardening-school',
  '6a000000-0000-4000-8000-000000000002',
  null,
  'offboarded',
  'Fixture offboarding',
  'WAIVE_CURRENT_MONTH',
  clock.today,
  '6a000000-0000-4000-8000-000000000302',
  300
)
from lifecycle_clock as clock;

insert into lifecycle_results (label, payload)
select 'offboard_bind', public.bind_student_offboarding_integrations(
  (payload ->> 'operation_id')::uuid,
  '6a000000-0000-4000-8000-000000000302',
  'integration_lifecycle_subscription',
  1,
  'production',
  'TENANT_BYOK',
  null,
  null,
  null,
  null
)
from lifecycle_results
where label = 'offboard_begin';

update public.student_offboarding_operations
   set status = 'PROVIDER_COMPLETE',
       provider_started_at = pg_catalog.now(),
       provider_completed_at = pg_catalog.now()
 where id = (
   select (payload ->> 'operation_id')::uuid
     from lifecycle_results
    where label = 'offboard_begin'
 );

insert into lifecycle_results (label, payload)
select 'offboard_finalize',
       public.finalize_student_offboarding_with_billing_policy(
         (payload ->> 'operation_id')::uuid,
         '6a000000-0000-4000-8000-000000000302'
       )
  from lifecycle_results
 where label = 'offboard_begin';

select pg_temp.assert_true(
  (
    select payload ->> 'action' = 'COMPLETED'
       and (payload ->> 'schedules_cancelled')::integer = 1
       and (payload ->> 'notifications_queued')::integer = 2
      from lifecycle_results
     where label = 'offboard_finalize'
  )
  and (
    select lifecycle_status = 'offboarded'
       and status = 'Inativo'
       and status_financial = 'SUSPENDED'
      from public.profiles
     where id = '6a000000-0000-4000-8000-000000000002'
  )
  and (
    select status = 'CANCELLED'
      from public.bookings
     where id = '6a000000-0000-4000-8000-000000000203'
  )
  and (
    select pg_catalog.count(*) = 2
      from public.notification_queue as queue
     where queue.source_id = (
       select (payload ->> 'operation_id')::uuid
         from lifecycle_results
        where label = 'offboard_begin'
     )
       and queue.notification_kind in (
         'STUDENT_OFFBOARDED',
         'TEACHER_STUDENT_OFFBOARDED'
       )
  ),
  'definitive offboarding did not release its slot or queue both audiences'
);

rollback;
