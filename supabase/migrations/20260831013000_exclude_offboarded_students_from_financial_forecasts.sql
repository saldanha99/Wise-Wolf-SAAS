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
          $old$           when invoice.live_count = 0 then 'MISSING_BILL'$old$,
          $new$           when invoice.live_count = 0
             and exists (
               select 1
                 from public.profiles as offboarded_profile
                where offboarded_profile.id = obligation.student_id
                  and offboarded_profile.tenant_id = obligation.tenant_id
                  and offboarded_profile.role = 'STUDENT'
                  and pg_catalog.lower(pg_catalog.btrim(coalesce(
                    offboarded_profile.lifecycle_status,
                    ''
                  ))) = 'offboarded'
             ) then 'EXCLUDED'
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

-- Exclude every already-frozen competence of an offboarded student that has
-- no live invoice. Historical OVERDUE/RECEIVED facts remain untouched.
do $lock_legacy_offboarded_months$
declare
  scope record;
begin
  for scope in
    select distinct obligation.tenant_id, obligation.period_start
      from public.monthly_payment_obligations as obligation
      join public.profiles as profile
        on profile.id = obligation.student_id
       and profile.tenant_id = obligation.tenant_id
     where profile.role = 'STUDENT'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
         profile.lifecycle_status,
         ''
       ))) = 'offboarded'
       and obligation.status <> 'EXCLUDED'
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'monthly-payment-closure:' || scope.tenant_id || ':' ||
          scope.period_start::text,
        0
      )
    );
  end loop;
end;
$lock_legacy_offboarded_months$;

with candidates as materialized (
  select
    obligation.tenant_id,
    obligation.period_start,
    obligation.student_id,
    obligation.status as previous_status,
    obligation.billed_amount as previous_billed_amount,
    obligation.settled_amount as previous_settled_amount,
    obligation.payment_ids as previous_payment_ids
  from public.monthly_payment_obligations as obligation
  join public.profiles as profile
    on profile.id = obligation.student_id
   and profile.tenant_id = obligation.tenant_id
  where profile.role = 'STUDENT'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(
      profile.lifecycle_status,
      ''
    ))) = 'offboarded'
    and obligation.status <> 'EXCLUDED'
    and not exists (
      select 1
        from public.student_payments as payment
       where payment.tenant_id = obligation.tenant_id
         and payment.student_id = obligation.student_id
         and payment.payment_type = 'SUBSCRIPTION'
         and payment.due_date >= obligation.period_start
         and payment.due_date <
           (obligation.period_start + interval '1 month')::date
         and pg_catalog.upper(pg_catalog.btrim(coalesce(
           payment.status,
           ''
         ))) not in ('CANCELLED', 'NAO_RECEITA')
    )
  for update of obligation
), repaired as (
  update public.monthly_payment_obligations as obligation
     set status = 'EXCLUDED',
         payment_ids = '{}',
         billed_amount = 0,
         settled_amount = 0,
         details = coalesce(obligation.details, '{}'::jsonb) ||
           pg_catalog.jsonb_build_object(
             'excluded_reason', 'OFFBOARDED_WITHOUT_LIVE_INVOICE',
             'legacy_reconciled_at', pg_catalog.now()
           ),
         updated_at = pg_catalog.now()
    from candidates
   where obligation.tenant_id = candidates.tenant_id
     and obligation.period_start = candidates.period_start
     and obligation.student_id = candidates.student_id
     and obligation.status = candidates.previous_status
     and obligation.billed_amount = candidates.previous_billed_amount
     and obligation.settled_amount = candidates.previous_settled_amount
     and obligation.payment_ids = candidates.previous_payment_ids
  returning
    obligation.tenant_id,
    obligation.period_start,
    obligation.student_id,
    candidates.previous_status,
    candidates.previous_billed_amount,
    candidates.previous_settled_amount,
    candidates.previous_payment_ids
)
insert into public.audit_logs (
  tenant_id, user_id, user_role, action, resource_type, resource_id,
  old_values, new_values, diff
)
select
  repaired.tenant_id,
  null,
  'SYSTEM',
  'legacy_offboarded_monthly_obligation_excluded',
  'monthly_payment_obligation',
  repaired.student_id::text || ':' || repaired.period_start::text,
  pg_catalog.jsonb_build_object(
    'status', repaired.previous_status,
    'billed_amount', repaired.previous_billed_amount,
    'settled_amount', repaired.previous_settled_amount,
    'payment_ids', repaired.previous_payment_ids
  ),
  pg_catalog.jsonb_build_object(
    'status', 'EXCLUDED',
    'billed_amount', 0,
    'settled_amount', 0,
    'payment_ids', pg_catalog.jsonb_build_array()
  ),
  pg_catalog.jsonb_build_object(
    'reason', 'offboarded_without_live_invoice'
  )
from repaired;

do $verify_legacy_offboarded_months$
begin
  if exists (
    select 1
      from public.monthly_payment_obligations as obligation
      join public.profiles as profile
        on profile.id = obligation.student_id
       and profile.tenant_id = obligation.tenant_id
     where profile.role = 'STUDENT'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
         profile.lifecycle_status,
         ''
       ))) = 'offboarded'
       and obligation.status <> 'EXCLUDED'
       and not exists (
         select 1
           from public.student_payments as payment
          where payment.tenant_id = obligation.tenant_id
            and payment.student_id = obligation.student_id
            and payment.payment_type = 'SUBSCRIPTION'
            and payment.due_date >= obligation.period_start
            and payment.due_date <
              (obligation.period_start + interval '1 month')::date
            and pg_catalog.upper(pg_catalog.btrim(coalesce(
              payment.status,
              ''
            ))) not in ('CANCELLED', 'NAO_RECEITA')
       )
  ) then
    raise exception 'offboarded monthly obligation repair incomplete';
  end if;
end;
$verify_legacy_offboarded_months$;

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
