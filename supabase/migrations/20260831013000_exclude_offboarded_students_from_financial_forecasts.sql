-- A definitive offboarding is the source of truth for recurring revenue.
-- Legacy rows could keep status_financial=ACTIVE after lifecycle_status had
-- already become offboarded, which inflated active-student counts and MRR.

create or replace function public.get_authorized_student_billing_summary(
  p_tenant_id text
)
returns table (
  id uuid,
  monthly_fee numeric,
  status_financial text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role text := public._my_role();
  v_tenant text := public._my_tenant_id();
begin
  if auth.uid() is null
     or p_tenant_id is null
     or not (
       v_role = 'SUPER_ADMIN'
       or (v_role = 'SCHOOL_ADMIN' and v_tenant = p_tenant_id)
     ) then
    raise exception 'student billing summary is not authorized'
      using errcode = '42501';
  end if;

  return query
  select profile.id, profile.monthly_fee, profile.status_financial
  from public.profiles as profile
  where profile.tenant_id = p_tenant_id
    and profile.role = 'STUDENT'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(
      profile.lifecycle_status,
      ''
    ))) = 'active'
  order by profile.id;
end;
$function$;

alter function public.get_authorized_student_billing_summary(text)
  owner to postgres;
revoke all on function public.get_authorized_student_billing_summary(text)
  from public, anon;
grant execute on function public.get_authorized_student_billing_summary(text)
  to authenticated;

-- Keep every lifecycle writer atomic, including the legacy offboarding
-- finalizer which predates status_financial. A current-month charge is kept in
-- student_payments; SUSPENDED here only removes future recurring revenue.
create or replace function private.normalize_offboarded_student_financial_state()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.role = 'STUDENT'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
       new.lifecycle_status,
       ''
     ))) = 'offboarded'
     and pg_catalog.upper(pg_catalog.btrim(coalesce(
       new.status_financial,
       ''
     ))) not in ('SUSPENDED', 'ARCHIVED')
  then
    new.status_financial := 'SUSPENDED';
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
before insert or update of role, lifecycle_status, status_financial
on public.profiles
for each row
execute function private.normalize_offboarded_student_financial_state();

-- A cancelled legacy invoice must not create a new MISSING_BILL after the
-- student is already offboarded. Patch the reviewed monthly-close function
-- assertively: any drift aborts the migration instead of rewriting unknown SQL.
do $harden_offboarded_monthly_closure$
declare
  patch record;
  definition text;
  old_count integer;
  new_count integer;
begin
  if pg_catalog.to_regprocedure(
       'public.refresh_monthly_payment_closure(text,date)'
     ) is null
  then
    raise exception 'required monthly closure function is missing';
  end if;

  for patch in
    select *
      from (values
        (
          $old$     and payment.payment_type = 'SUBSCRIPTION'
     and payment.due_date >= v_period_start$old$,
          $new$     and payment.payment_type = 'SUBSCRIPTION'
     and pg_catalog.upper(pg_catalog.btrim(coalesce(
       payment.status,
       ''
     ))) not in ('CANCELLED', 'NAO_RECEITA')
     and payment.due_date >= v_period_start$new$
        ),
        (
          $old$           when obligation.status = 'EXCLUDED' then 'EXCLUDED'
           when invoice.live_count = 0 then 'MISSING_BILL'$old$,
          $new$           when coalesce(
               obligation.details ->> 'excluded_reason',
               ''
             ) = 'LEGACY_POST_OFFBOARDING_NO_LIVE_INVOICE'
             and invoice.live_count = 0
             then 'EXCLUDED'
           when obligation.status = 'EXCLUDED'
             and coalesce(
               obligation.details ->> 'excluded_reason',
               ''
             ) <> 'LEGACY_POST_OFFBOARDING_NO_LIVE_INVOICE'
             then 'EXCLUDED'
           when invoice.live_count = 0 then 'MISSING_BILL'$new$
        ),
        (
          $old$         details = jsonb_build_object($old$,
          $new$         details = coalesce(
           obligation.details,
           '{}'::jsonb
         ) || jsonb_build_object($new$
        )
      ) as replacements(old_sql, new_sql)
  loop
    select pg_catalog.pg_get_functiondef(
             'public.refresh_monthly_payment_closure(text,date)'::regprocedure
           )
      into definition;
    old_count := (
      pg_catalog.length(definition) -
      pg_catalog.length(pg_catalog.replace(definition, patch.old_sql, ''))
    ) / pg_catalog.length(patch.old_sql);
    new_count := (
      pg_catalog.length(definition) -
      pg_catalog.length(pg_catalog.replace(definition, patch.new_sql, ''))
    ) / pg_catalog.length(patch.new_sql);

    if new_count = 1 then
      null;
    elsif old_count = 1 then
      execute pg_catalog.replace(definition, patch.old_sql, patch.new_sql);
    else
      raise exception
        'monthly closure drift: expected one reviewed OLD or NEW fragment, found OLD=% NEW=%',
        old_count,
        new_count;
    end if;

    select pg_catalog.pg_get_functiondef(
             'public.refresh_monthly_payment_closure(text,date)'::regprocedure
           )
      into definition;
    new_count := (
      pg_catalog.length(definition) -
      pg_catalog.length(pg_catalog.replace(definition, patch.new_sql, ''))
    ) / pg_catalog.length(patch.new_sql);
    if new_count <> 1 then
      raise exception 'monthly closure patch postcondition failed';
    end if;
  end loop;
end;
$harden_offboarded_monthly_closure$;

-- Take the canonical lifecycle locks before this transaction locks any of the
-- exact production profiles below. Lifecycle writers use advisory -> profile;
-- preserving that order prevents a row-lock/advisory-lock deadlock at deploy.
do $lock_exact_legacy_student_lifecycles$
declare
  target record;
begin
  for target in
    select *
      from (values
        (
          'school-wise-wolf'::text,
          '2195b230-ca3d-45af-adaa-e4c3a9dd5f06'::uuid
        ),
        (
          'school-wise-wolf'::text,
          '53a103ff-d540-4b96-abe6-fff0a5632bf6'::uuid
        ),
        (
          'school-wise-wolf'::text,
          '8dfbe3c6-0b45-4881-9c57-6254287ddb78'::uuid
        )
      ) as targets(tenant_id, student_id)
     order by tenant_id, student_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || target.tenant_id || ':' ||
          target.student_id::text,
        0
      )
    );
  end loop;
end;
$lock_exact_legacy_student_lifecycles$;

-- Repair only the contradictory legacy state. Historical debt remains intact;
-- this update merely removes definitively offboarded students from recurring
-- forecasts. Keep one immutable audit row per repaired profile.
with candidates as materialized (
  select profile.id, profile.tenant_id,
         profile.status_financial as previous_status
    from public.profiles as profile
   where profile.role = 'STUDENT'
     and pg_catalog.lower(pg_catalog.btrim(coalesce(
       profile.lifecycle_status,
       ''
     ))) = 'offboarded'
     and pg_catalog.upper(pg_catalog.btrim(coalesce(
       profile.status_financial,
       ''
     ))) not in ('SUSPENDED', 'ARCHIVED')
   for update
), repaired as (
  update public.profiles as profile
     set status_financial = 'SUSPENDED'
    from candidates
   where profile.id = candidates.id
     and profile.tenant_id = candidates.tenant_id
     and profile.status_financial is not distinct from
       candidates.previous_status
  returning profile.id, profile.tenant_id, candidates.previous_status
)
insert into public.audit_logs (
  tenant_id,
  user_id,
  user_role,
  action,
  resource_type,
  resource_id,
  old_values,
  new_values,
  diff
)
select
  repaired.tenant_id,
  null,
  'SYSTEM',
  'legacy_offboarded_financial_state_repaired',
  'profile',
  repaired.id::text,
  pg_catalog.jsonb_build_object(
    'lifecycle_status', 'offboarded',
    'status_financial', repaired.previous_status
  ),
  pg_catalog.jsonb_build_object(
    'lifecycle_status', 'offboarded',
    'status_financial', 'SUSPENDED'
  ),
  pg_catalog.jsonb_build_object(
    'status_financial', pg_catalog.jsonb_build_array(
      repaired.previous_status,
      'SUSPENDED'
    ),
    'reason', 'definitive_offboarding_excludes_recurring_forecast'
  )
from repaired;

-- These two future invoices belonged to the same student, were created after
-- the recorded legacy offboarding, carry no cash/ledger fact, and returned an
-- exact HTTP 404 from the tenant's authoritative Asaas integration immediately
-- before this release. Keep the possible June historical debt untouched.
do $repair_legacy_post_offboarding_payments$
declare
  target record;
  profile_row public.profiles%rowtype;
  payment_row public.student_payments%rowtype;
begin
  for target in
    select *
      from (values
        (
          '71466e23-ce20-41fb-912f-24060c0bc99c'::uuid,
          '8dfbe3c6-0b45-4881-9c57-6254287ddb78'::uuid,
          'pay_e74a5k6qrh8l82f0'::text,
          date '2026-08-15'
        ),
        (
          '2705b40f-def2-4f66-99cf-4aa0092d337c'::uuid,
          '8dfbe3c6-0b45-4881-9c57-6254287ddb78'::uuid,
          'pay_vya6kxhaex0rpkou'::text,
          date '2026-09-15'
        )
      ) as targets(payment_id, student_id, provider_payment_id, due_date)
  loop
    select profile.*
      into profile_row
      from public.profiles as profile
     where profile.id = target.student_id
       and profile.tenant_id = 'school-wise-wolf'
       and profile.role = 'STUDENT'
     for update;
    if not found then
      continue;
    end if;
    if pg_catalog.lower(pg_catalog.btrim(coalesce(
            profile_row.lifecycle_status,
            ''
          ))) <> 'offboarded'
       or pg_catalog.upper(pg_catalog.btrim(coalesce(
            profile_row.status_financial,
            ''
          ))) = 'ACTIVE'
       or profile_row.offboarding_status is distinct from 'COMPLETED'
       or profile_row.offboarding_completed_at is null
       or profile_row.offboarding_completed_at::date > date '2026-06-16'
    then
      raise exception 'legacy post-offboarding profile snapshot mismatch';
    end if;

    select payment.*
      into payment_row
      from public.student_payments as payment
     where payment.id = target.payment_id
       and payment.tenant_id = profile_row.tenant_id
       and payment.student_id = target.student_id
     for update;
    if not found then
      raise exception 'legacy post-offboarding payment missing';
    end if;

    if pg_catalog.upper(pg_catalog.btrim(coalesce(
         payment_row.status,
         ''
       ))) = 'CANCELLED'
       and pg_catalog.upper(pg_catalog.btrim(coalesce(
         payment_row.provider_status,
         ''
       ))) = 'DELETED'
    then
      continue;
    end if;

    if not (
      (
        nullif(pg_catalog.btrim(coalesce(
          payment_row.asaas_payment_id,
          ''
        )), '') = target.provider_payment_id
        or nullif(pg_catalog.btrim(coalesce(
          payment_row.asaas_id,
          ''
        )), '') = target.provider_payment_id
      )
      and payment_row.due_date = target.due_date
      and pg_catalog.round(coalesce(payment_row.value, 0), 2) = 149.00
      and (
        payment_row.amount_cents is null
        or payment_row.amount_cents = 14900
      )
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
        payment_row.status,
        ''
      ))) = 'PENDING'
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
        payment_row.provider_status,
        ''
      ))) = 'PENDING'
      and payment_row.payment_date is null
      and payment_row.paid_at is null
      and payment_row.credited_at is null
      and coalesce(payment_row.refunded_amount, 0) = 0
      and coalesce(payment_row.ledger_entry_created, false) is false
      and not exists (
        select 1
          from public.financial_transactions as transaction
         where transaction.student_payment_id = target.payment_id
            or transaction.refund_student_payment_id = target.payment_id
      )
    ) then
      raise exception 'legacy post-offboarding payment snapshot mismatch';
    end if;

    update public.student_payments as payment
       set status = 'CANCELLED',
           provider_status = 'DELETED',
           exclusion_reason = coalesce(
             nullif(pg_catalog.btrim(coalesce(
               payment.exclusion_reason,
               ''
             )), ''),
             'provider_not_found_after_offboarding_reconciled'
           ),
           updated_at = pg_catalog.now()
     where payment.id = target.payment_id
       and payment.status = payment_row.status
       and payment.provider_status = payment_row.provider_status;
    if not found then
      raise exception 'legacy post-offboarding payment changed concurrently';
    end if;

    insert into public.audit_logs (
      tenant_id, user_id, user_role, action, resource_type, resource_id,
      old_values, new_values, diff
    ) values (
      profile_row.tenant_id,
      null,
      'SYSTEM',
      'legacy_post_offboarding_payment_reconciled',
      'student_payment',
      target.payment_id::text,
      pg_catalog.jsonb_build_object(
        'status', payment_row.status,
        'provider_status', payment_row.provider_status,
        'due_date', payment_row.due_date
      ),
      pg_catalog.jsonb_build_object(
        'status', 'CANCELLED',
        'provider_status', 'DELETED',
        'due_date', payment_row.due_date
      ),
      pg_catalog.jsonb_build_object(
        'reason', 'authoritative_provider_404_after_completed_offboarding'
      )
    );

    update public.asaas_reconciliation_issues as issue
       set resolved_at = coalesce(issue.resolved_at, pg_catalog.now()),
           resolution_note = coalesce(
             issue.resolution_note,
             'Resolved after exact provider 404 and completed offboarding proof'
           )
     where issue.provider_entity_id = target.provider_payment_id
       and issue.local_entity_id = target.payment_id::text
       and issue.resolved_at is null
       and issue.kind in (
         'PROVIDER_PAYMENT_DELETED_LOCAL_OPEN',
         'PAYMENT_STATUS_MISMATCH'
       );
  end loop;
end;
$repair_legacy_post_offboarding_payments$;

-- Repair only the three proven post-offboarding forecast rows observed in the
-- production audit. The completed offboarding predates each competence, every
-- retained invoice is cancelled (or was reconciled to DELETED above), and no
-- cash fact exists. Never infer forgiveness for an arbitrary historical month.
do $repair_exact_legacy_post_offboarding_months$
declare
  target record;
  profile_row public.profiles%rowtype;
  obligation_row public.monthly_payment_obligations%rowtype;
  changed_count integer;
begin
  for target in
    select *
      from (values
        (
          'school-wise-wolf'::text,
          '2195b230-ca3d-45af-adaa-e4c3a9dd5f06'::uuid,
          date '2026-07-01',
          'MISSING_BILL'::text,
          188.00::numeric,
          0.00::numeric,
          0.00::numeric,
          '{}'::uuid[]
        ),
        (
          'school-wise-wolf'::text,
          '8dfbe3c6-0b45-4881-9c57-6254287ddb78'::uuid,
          date '2026-07-01',
          'MISSING_BILL'::text,
          149.00::numeric,
          0.00::numeric,
          0.00::numeric,
          '{}'::uuid[]
        ),
        (
          'school-wise-wolf'::text,
          '8dfbe3c6-0b45-4881-9c57-6254287ddb78'::uuid,
          date '2026-08-01',
          'OPEN'::text,
          149.00::numeric,
          149.00::numeric,
          0.00::numeric,
          array['71466e23-ce20-41fb-912f-24060c0bc99c'::uuid]
        )
      ) as targets(
        tenant_id,
        student_id,
        period_start,
        expected_status,
        expected_amount,
        expected_billed_amount,
        expected_settled_amount,
        expected_payment_ids
      )
     order by period_start, student_id
  loop
    -- Follow the lifecycle writer's lock order before fencing the monthly
    -- refresher. A later live invoice still reopens this exact legacy reason.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'student-billing-lifecycle:' || target.tenant_id || ':' ||
          target.student_id::text,
        0
      )
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'monthly-payment-closure:' || target.tenant_id || ':' ||
          target.period_start::text,
        0
      )
    );

    select profile.*
      into profile_row
      from public.profiles as profile
     where profile.id = target.student_id
     for update;
    if not found then
      continue;
    end if;
    if profile_row.tenant_id is distinct from target.tenant_id
       or profile_row.role is distinct from 'STUDENT'
       or pg_catalog.lower(pg_catalog.btrim(coalesce(
            profile_row.lifecycle_status,
            ''
          ))) <> 'offboarded'
       or profile_row.offboarding_status is distinct from 'COMPLETED'
       or profile_row.offboarding_completed_at is null
       or profile_row.offboarding_completed_at::date >= target.period_start
       or pg_catalog.upper(pg_catalog.btrim(coalesce(
            profile_row.status_financial,
            ''
          ))) = 'ACTIVE'
    then
      raise exception 'target post-offboarding profile snapshot mismatch';
    end if;

    -- FOR UPDATE on the referenced profile blocks new payment inserts through
    -- the FK. Locking every existing row for this student also blocks status,
    -- due-date, reassignment and deletion races before the live-invoice check.
    perform 1
      from public.student_payments as payment
     where payment.student_id = target.student_id
     order by payment.id
     for update;

    select obligation.*
      into obligation_row
      from public.monthly_payment_obligations as obligation
     where obligation.tenant_id = target.tenant_id
       and obligation.period_start = target.period_start
       and obligation.student_id = target.student_id
     for update;
    if not found then
      raise exception 'target post-offboarding obligation is missing';
    end if;

    if obligation_row.status = 'EXCLUDED'
       and obligation_row.billed_amount = 0
       and obligation_row.settled_amount = 0
       and obligation_row.payment_ids = '{}'::uuid[]
       and obligation_row.details ->> 'excluded_reason' =
         'LEGACY_POST_OFFBOARDING_NO_LIVE_INVOICE'
    then
      continue;
    end if;

    if obligation_row.roster_source is distinct from 'RECORDED_INVOICE'
       or obligation_row.status is distinct from target.expected_status
       or obligation_row.expected_amount is distinct from target.expected_amount
       or obligation_row.billed_amount is distinct from
         target.expected_billed_amount
       or obligation_row.settled_amount is distinct from
         target.expected_settled_amount
       or obligation_row.payment_ids is distinct from
         target.expected_payment_ids
    then
      raise exception 'target post-offboarding obligation snapshot mismatch';
    end if;

    if exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = target.tenant_id
         and payment.student_id = target.student_id
         and payment.payment_type = 'SUBSCRIPTION'
         and payment.due_date >= target.period_start
         and payment.due_date <
           (target.period_start + interval '1 month')::date
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
           payment.status,
           ''
         ))) not in ('CANCELLED', 'NAO_RECEITA')
    ) then
      raise exception 'target post-offboarding obligation has a live invoice';
    end if;

    update public.monthly_payment_obligations as obligation
       set status = 'EXCLUDED',
           payment_ids = '{}',
           billed_amount = 0,
           settled_amount = 0,
           details = coalesce(obligation.details, '{}'::jsonb) ||
             pg_catalog.jsonb_build_object(
               'excluded_reason',
                 'LEGACY_POST_OFFBOARDING_NO_LIVE_INVOICE',
               'legacy_reconciled_at', pg_catalog.now()
             ),
           updated_at = pg_catalog.now()
     where obligation.tenant_id = target.tenant_id
       and obligation.period_start = target.period_start
       and obligation.student_id = target.student_id
       and obligation.roster_source = obligation_row.roster_source
       and obligation.status = obligation_row.status
       and obligation.expected_amount = obligation_row.expected_amount
       and obligation.billed_amount = obligation_row.billed_amount
       and obligation.settled_amount = obligation_row.settled_amount
       and obligation.payment_ids = obligation_row.payment_ids;
    get diagnostics changed_count = row_count;
    if changed_count <> 1 then
      raise exception 'target post-offboarding obligation changed concurrently';
    end if;

    insert into public.audit_logs (
      tenant_id, user_id, user_role, action, resource_type, resource_id,
      old_values, new_values, diff
    ) values (
      target.tenant_id,
      null,
      'SYSTEM',
      'legacy_post_offboarding_monthly_obligation_excluded',
      'monthly_payment_obligation',
      target.student_id::text || ':' || target.period_start::text,
      pg_catalog.jsonb_build_object(
        'status', obligation_row.status,
        'expected_amount', obligation_row.expected_amount,
        'billed_amount', obligation_row.billed_amount,
        'settled_amount', obligation_row.settled_amount,
        'payment_ids', obligation_row.payment_ids
      ),
      pg_catalog.jsonb_build_object(
        'status', 'EXCLUDED',
        'expected_amount', obligation_row.expected_amount,
        'billed_amount', 0,
        'settled_amount', 0,
        'payment_ids', pg_catalog.jsonb_build_array()
      ),
      pg_catalog.jsonb_build_object(
        'reason', 'completed_offboarding_before_period_without_live_invoice',
        'offboarding_completed_at', profile_row.offboarding_completed_at
      )
    );
  end loop;
end;
$repair_exact_legacy_post_offboarding_months$;

-- Both remaining subscription identifiers are local orphans. Exact GETs on
-- the authoritative tenant integration returned 404, while local status was
-- already INACTIVE and the students were definitively offboarded.
do $clear_legacy_offboarded_subscription_orphans$
declare
  target record;
  profile_row public.profiles%rowtype;
begin
  for target in
    select *
      from (values
        (
          '2195b230-ca3d-45af-adaa-e4c3a9dd5f06'::uuid,
          'sub_jpy4vwr800cr3uos'::text
        ),
        (
          '53a103ff-d540-4b96-abe6-fff0a5632bf6'::uuid,
          'sub_u7j5s111dxqn8xnv'::text
        )
      ) as targets(student_id, subscription_id)
  loop
    select profile.*
      into profile_row
      from public.profiles as profile
     where profile.id = target.student_id
       and profile.tenant_id = 'school-wise-wolf'
       and profile.role = 'STUDENT'
     for update;
    if not found then
      continue;
    end if;
    if profile_row.subscription_id is null
       and profile_row.asaas_subscription_status = 'NOT_FOUND'
    then
      continue;
    end if;
    if profile_row.subscription_id is distinct from target.subscription_id
       or pg_catalog.upper(pg_catalog.btrim(coalesce(
            profile_row.asaas_subscription_status,
            ''
          ))) <> 'INACTIVE'
       or pg_catalog.lower(pg_catalog.btrim(coalesce(
            profile_row.lifecycle_status,
            ''
          ))) <> 'offboarded'
       or pg_catalog.upper(pg_catalog.btrim(coalesce(
            profile_row.status_financial,
            ''
          ))) = 'ACTIVE'
    then
      raise exception 'legacy subscription profile snapshot mismatch';
    end if;

    update public.profiles as profile
       set subscription_id = null,
           asaas_subscription_status = 'NOT_FOUND',
           asaas_subscription_synced_at = pg_catalog.now()
     where profile.id = target.student_id
       and profile.subscription_id = target.subscription_id
       and profile.asaas_subscription_status = profile_row.asaas_subscription_status;
    if not found then
      raise exception 'legacy subscription profile changed concurrently';
    end if;

    insert into public.audit_logs (
      tenant_id, user_id, user_role, action, resource_type, resource_id,
      old_values, new_values, diff
    ) values (
      profile_row.tenant_id,
      null,
      'SYSTEM',
      'legacy_offboarded_subscription_orphan_cleared',
      'profile',
      target.student_id::text,
      pg_catalog.jsonb_build_object(
        'subscription_id', target.subscription_id,
        'asaas_subscription_status', profile_row.asaas_subscription_status
      ),
      pg_catalog.jsonb_build_object(
        'subscription_id', null,
        'asaas_subscription_status', 'NOT_FOUND'
      ),
      pg_catalog.jsonb_build_object(
        'reason', 'authoritative_provider_404_after_completed_offboarding'
      )
    );
  end loop;
end;
$clear_legacy_offboarded_subscription_orphans$;

alter table public.profiles
  drop constraint if exists profiles_offboarded_student_not_financially_active;

alter table public.profiles
  add constraint profiles_offboarded_student_not_financially_active
  check (
    not (
      role = 'STUDENT'
      and pg_catalog.lower(pg_catalog.btrim(coalesce(
        lifecycle_status,
        ''
      ))) = 'offboarded'
      and pg_catalog.upper(pg_catalog.btrim(coalesce(
        status_financial,
        ''
      ))) not in ('SUSPENDED', 'ARCHIVED')
    )
  );

comment on constraint profiles_offboarded_student_not_financially_active
  on public.profiles is
  'A definitively offboarded student must be SUSPENDED (or historically ARCHIVED) and cannot contribute recurring revenue.';
