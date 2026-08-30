begin;

-- A monthly close is deliberately stricter than the cash report. The cash
-- report says what entered the bank; the obligation roster says who had to pay
-- the competence. Missing invoices, card-only confirmation and unclassified
-- cash all block the celebratory "everyone paid" message.
create table if not exists public.monthly_payment_obligations (
  tenant_id text not null references public.tenants(id) on delete cascade,
  period_start date not null,
  student_id uuid not null references public.profiles(id) on delete restrict,
  roster_source text not null check (
    roster_source in ('ACTIVE_ROSTER', 'RECORDED_INVOICE')
  ),
  expected_amount numeric(12,2) not null default 0 check (expected_amount >= 0),
  billed_amount numeric(12,2) not null default 0 check (billed_amount >= 0),
  settled_amount numeric(12,2) not null default 0 check (settled_amount >= 0),
  status text not null default 'MISSING_BILL' check (
    status in (
      'MISSING_BILL', 'OPEN', 'WAITING_CREDIT', 'SETTLED', 'REVIEW',
      'EXCLUDED'
    )
  ),
  payment_ids uuid[] not null default '{}'::uuid[],
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (tenant_id, period_start, student_id),
  check (period_start = pg_catalog.date_trunc('month', period_start)::date)
);

create table if not exists public.monthly_payment_closures (
  tenant_id text not null references public.tenants(id) on delete cascade,
  period_start date not null,
  status text not null default 'OPEN' check (
    status in ('OPEN', 'BLOCKED', 'READY', 'SENT', 'REVIEW')
  ),
  expected_students integer not null default 0 check (expected_students >= 0),
  settled_students integer not null default 0 check (settled_students >= 0),
  blocked_students integer not null default 0 check (blocked_students >= 0),
  unclassified_cash_count integer not null default 0
    check (unclassified_cash_count >= 0),
  open_reconciliation_count integer not null default 0
    check (open_reconciliation_count >= 0),
  snapshot jsonb not null default '{}'::jsonb,
  snapshot_hash text,
  group_destination_snapshot text,
  ready_at timestamptz,
  sent_at timestamptz,
  sent_attempt_id uuid,
  review_reason text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (tenant_id, period_start),
  check (period_start = pg_catalog.date_trunc('month', period_start)::date),
  check (
    snapshot_hash is null
    or snapshot_hash ~ '^[0-9a-f]{64}$'
  )
);

alter table public.monthly_payment_obligations owner to postgres;
alter table public.monthly_payment_closures owner to postgres;
alter table public.monthly_payment_obligations enable row level security;
alter table public.monthly_payment_obligations force row level security;
alter table public.monthly_payment_closures enable row level security;
alter table public.monthly_payment_closures force row level security;
revoke all on table public.monthly_payment_obligations
  from public, anon, authenticated, service_role;
revoke all on table public.monthly_payment_closures
  from public, anon, authenticated, service_role;
grant select on table public.monthly_payment_obligations to service_role;
grant select on table public.monthly_payment_closures to service_role;

create index if not exists monthly_payment_obligations_open_idx
  on public.monthly_payment_obligations (tenant_id, period_start, status)
  where status <> 'SETTLED' and status <> 'EXCLUDED';
create index if not exists monthly_payment_closures_pending_idx
  on public.monthly_payment_closures (period_start, tenant_id)
  where sent_at is null and status in ('OPEN', 'BLOCKED', 'READY');

create or replace function public.refresh_monthly_payment_closure(
  p_tenant_id text,
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  v_period_start date := pg_catalog.date_trunc('month', p_period_start)::date;
  v_period_end date := (pg_catalog.date_trunc('month', p_period_start) + interval '1 month')::date;
  business_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  closure_row public.monthly_payment_closures%rowtype;
  expected_count integer := 0;
  settled_count integer := 0;
  blocked_count integer := 0;
  missing_count integer := 0;
  open_count integer := 0;
  waiting_credit_count integer := 0;
  review_count integer := 0;
  unclassified_count integer := 0;
  reconciliation_count integer := 0;
  competence_billed numeric := 0;
  competence_settled numeric := 0;
  cash_report jsonb := '{}'::jsonb;
  cash_totals jsonb := '{}'::jsonb;
  rules_snapshot jsonb := '{}'::jsonb;
  blockers jsonb := '[]'::jsonb;
  obligation_states jsonb := '[]'::jsonb;
  next_snapshot jsonb;
  next_hash text;
  next_status text;
  destination text;
begin
  if normalized_tenant is null
     or p_period_start is null
     or v_period_start > pg_catalog.date_trunc(
       'month',
       pg_catalog.now() at time zone 'America/Sao_Paulo'
     )::date
     or v_period_start < date '2020-01-01'
     or not exists (
       select 1 from public.tenants as tenant
        where tenant.id = normalized_tenant
     )
  then
    raise exception using
      errcode = '22023',
      message = 'monthly_payment_closure_arguments_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'monthly-payment-closure:' || normalized_tenant || ':' || v_period_start::text,
      0
    )
  );

  insert into public.monthly_payment_closures (tenant_id, period_start)
  values (normalized_tenant, v_period_start)
  on conflict on constraint monthly_payment_closures_pkey do nothing;

  -- Freeze every student that was either billable when this month was first
  -- observed or already has a recurring invoice in the competence. Subsequent
  -- refreshes can add a newly enrolled student, but never remove a frozen row.
  insert into public.monthly_payment_obligations (
    tenant_id,
    period_start,
    student_id,
    roster_source,
    expected_amount
  )
  select
    normalized_tenant,
    v_period_start,
    candidate.student_id,
    case when candidate.active_roster then 'ACTIVE_ROSTER'
         else 'RECORDED_INVOICE' end,
    greatest(coalesce(profile.monthly_fee, candidate.invoice_amount, 0), 0)
  from (
    select
      profile.id as student_id,
      true as active_roster,
      null::numeric as invoice_amount
    from public.profiles as profile
    join public.tenant_memberships as membership
      on membership.user_id = profile.id
     and membership.tenant_id = normalized_tenant
     and membership.role = 'STUDENT'
     and membership.status = 'ACTIVE'
   where profile.tenant_id = normalized_tenant
     and profile.role = 'STUDENT'
     and profile.status = 'Ativo'
     and lower(pg_catalog.btrim(coalesce(profile.lifecycle_status, ''))) = 'active'
     and coalesce(profile.monthly_fee, 0) > 0
     and coalesce(profile.is_test_account, false) is false
     and profile.test_fixture_key is null
     and profile.created_at < v_period_end
     and (profile.start_date is null or profile.start_date < v_period_end)

    union

    select
      payment.student_id,
      false,
      max(payment.value)
    from public.student_payments as payment
    join public.profiles as profile on profile.id = payment.student_id
   where payment.tenant_id = normalized_tenant
     and payment.student_id is not null
     and payment.payment_type = 'SUBSCRIPTION'
     and payment.due_date >= v_period_start
     and payment.due_date < v_period_end
     and coalesce(payment.value, 0) > 0
     and coalesce(profile.is_test_account, false) is false
     and profile.test_fixture_key is null
   group by payment.student_id
  ) as candidate
  join public.profiles as profile on profile.id = candidate.student_id
  on conflict on constraint monthly_payment_obligations_pkey do nothing;

  with invoice_stats as (
    select
      obligation.tenant_id,
      obligation.period_start,
      obligation.student_id,
      count(payment.id) filter (
        where payment.id is not null
          and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
            'CANCELLED', 'NAO_RECEITA'
          )
      )::integer as live_count,
      count(payment.id) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
          'RECEIVED', 'RECEIVED_IN_CASH'
        )
          and coalesce(payment.refunded_amount, 0) = 0
      )::integer as settled_count,
      count(payment.id) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) = 'CONFIRMED'
      )::integer as confirmed_count,
      count(payment.id) filter (
        where coalesce(payment.refunded_amount, 0) > 0
          or upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
            'REFUNDED', 'PARTIALLY_REFUNDED'
          )
      )::integer as refunded_count,
      round(coalesce(sum(payment.value) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
          'CANCELLED', 'NAO_RECEITA'
        )
      ), 0), 2) as billed_amount,
      round(coalesce(sum(payment.value - coalesce(payment.refunded_amount, 0)) filter (
        where upper(pg_catalog.btrim(coalesce(payment.status, ''))) in (
          'RECEIVED', 'RECEIVED_IN_CASH'
        )
      ), 0), 2) as settled_amount,
      coalesce(array_agg(payment.id order by payment.id) filter (
        where payment.id is not null
          and upper(pg_catalog.btrim(coalesce(payment.status, ''))) not in (
            'CANCELLED', 'NAO_RECEITA'
          )
      ), '{}'::uuid[]) as payment_ids,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'payment_id', payment.id,
            'status', payment.status,
            'provider_status', payment.provider_status,
            'value', payment.value,
            'billing_type', payment.billing_type,
            'refunded_amount', payment.refunded_amount
          ) order by payment.id
        ) filter (where payment.id is not null),
        '[]'::jsonb
      ) as invoices
    from public.monthly_payment_obligations as obligation
    left join public.student_payments as payment
      on payment.tenant_id = obligation.tenant_id
     and payment.student_id = obligation.student_id
     and payment.payment_type = 'SUBSCRIPTION'
     and payment.due_date >= obligation.period_start
     and payment.due_date < (
       pg_catalog.date_trunc('month', obligation.period_start) + interval '1 month'
     )::date
   where obligation.tenant_id = normalized_tenant
     and obligation.period_start = v_period_start
   group by obligation.tenant_id, obligation.period_start, obligation.student_id
  )
  update public.monthly_payment_obligations as obligation
     set billed_amount = invoice.billed_amount,
         settled_amount = invoice.settled_amount,
         payment_ids = invoice.payment_ids,
         status = case
           when obligation.status = 'EXCLUDED' then 'EXCLUDED'
           when invoice.live_count = 0 then 'MISSING_BILL'
           when invoice.refunded_count > 0 then 'REVIEW'
           when invoice.live_count > 1 then 'REVIEW'
           when invoice.settled_count = invoice.live_count then 'SETTLED'
           when invoice.confirmed_count > 0 then 'WAITING_CREDIT'
           else 'OPEN'
         end,
         details = jsonb_build_object(
           'invoice_count', invoice.live_count,
           'settled_count', invoice.settled_count,
           'confirmed_count', invoice.confirmed_count,
           'refunded_count', invoice.refunded_count,
           'invoices', invoice.invoices
         ),
         updated_at = pg_catalog.now()
    from invoice_stats as invoice
   where obligation.tenant_id = invoice.tenant_id
     and obligation.period_start = invoice.period_start
     and obligation.student_id = invoice.student_id;

  select
    count(*)::integer,
    count(*) filter (where obligation.status in ('SETTLED', 'EXCLUDED'))::integer,
    count(*) filter (where obligation.status not in ('SETTLED', 'EXCLUDED'))::integer,
    count(*) filter (where obligation.status = 'MISSING_BILL')::integer,
    count(*) filter (where obligation.status = 'OPEN')::integer,
    count(*) filter (where obligation.status = 'WAITING_CREDIT')::integer,
    count(*) filter (where obligation.status = 'REVIEW')::integer,
    round(coalesce(sum(obligation.billed_amount), 0), 2),
    round(coalesce(sum(obligation.settled_amount), 0), 2),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'student_id', obligation.student_id,
          'student_name', profile.full_name,
          'status', obligation.status,
          'expected_amount', obligation.expected_amount,
          'billed_amount', obligation.billed_amount,
          'settled_amount', obligation.settled_amount
        ) order by profile.full_name
      ),
      '[]'::jsonb
    )
  into
    expected_count,
    settled_count,
    blocked_count,
    missing_count,
    open_count,
    waiting_credit_count,
    review_count,
    competence_billed,
    competence_settled,
    obligation_states
  from public.monthly_payment_obligations as obligation
  join public.profiles as profile on profile.id = obligation.student_id
  where obligation.tenant_id = normalized_tenant
    and obligation.period_start = v_period_start;

  select count(*)::integer
    into unclassified_count
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.student_id is null
     and payment.status in ('RECEIVED', 'RECEIVED_IN_CASH')
     and coalesce(payment.value, 0) > 0
     and payment.exclusion_reason is null
     and coalesce(
       payment.credited_at,
       payment.paid_at,
       payment.payment_date::timestamptz,
       payment.due_date::timestamptz
     ) >= v_period_start::timestamptz
     and coalesce(
       payment.credited_at,
       payment.paid_at,
       payment.payment_date::timestamptz,
       payment.due_date::timestamptz
     ) < v_period_end::timestamptz;

  select count(*)::integer
    into reconciliation_count
    from public.asaas_reconciliation_issues as issue
   where issue.tenant_id = normalized_tenant
     and issue.resolved_at is null
     and issue.severity in ('HIGH', 'CRITICAL')
     and (
       issue.local_entity_id in (
         select unnest(obligation.payment_ids)::text
           from public.monthly_payment_obligations as obligation
          where obligation.tenant_id = normalized_tenant
            and obligation.period_start = v_period_start
       )
       or issue.provider_entity_id in (
         select payment.asaas_payment_id
           from public.monthly_payment_obligations as obligation
           join public.student_payments as payment
             on payment.id = any(obligation.payment_ids)
          where obligation.tenant_id = normalized_tenant
            and obligation.period_start = v_period_start
       )
     );

  cash_report := public.payment_split_report(
    pg_catalog.to_char(v_period_start, 'YYYY-MM'),
    normalized_tenant
  );
  cash_totals := coalesce(cash_report -> 'totais', '{}'::jsonb);

  select jsonb_build_object(
           'direction', jsonb_build_object(
             'tithe_pct', setting.dizimo_pct,
             'investment_pct', setting.investimento_pct,
             'school_pct', setting.escola_pct
           ),
           'contracted_teacher', jsonb_build_object(
             'tithe_pct', setting.prof_dizimo_pct,
             'investment_pct', setting.prof_investimento_pct,
             'prolabore_pct', setting.prof_prolabore_pct
           ),
           'is_active', setting.is_active
         )
    into rules_snapshot
    from public.payment_split_settings as setting
   where setting.tenant_id = normalized_tenant;
  rules_snapshot := coalesce(rules_snapshot, '{}'::jsonb);

  select setting.destino
    into destination
    from public.dre_report_settings as setting
   where setting.tenant_id = normalized_tenant
     and setting.is_active;

  if business_today < v_period_end then
    blockers := blockers || jsonb_build_array('period_not_ended');
  end if;
  if expected_count = 0 then
    blockers := blockers || jsonb_build_array('no_expected_students');
  end if;
  if missing_count > 0 then
    blockers := blockers || jsonb_build_array('students_without_invoice');
  end if;
  if open_count > 0 then
    blockers := blockers || jsonb_build_array('open_invoices');
  end if;
  if waiting_credit_count > 0 then
    blockers := blockers || jsonb_build_array('card_confirmed_waiting_cash');
  end if;
  if review_count > 0 then
    blockers := blockers || jsonb_build_array('obligations_under_review');
  end if;
  if unclassified_count > 0 then
    blockers := blockers || jsonb_build_array('unclassified_cash');
  end if;
  if reconciliation_count > 0 then
    blockers := blockers || jsonb_build_array('open_reconciliation');
  end if;
  if destination is null then
    blockers := blockers || jsonb_build_array('management_group_inactive');
  end if;
  if coalesce((rules_snapshot ->> 'is_active')::boolean, false) is false then
    blockers := blockers || jsonb_build_array('payment_split_inactive');
  end if;

  next_status := case
    when jsonb_array_length(blockers) = 0 then 'READY'
    when business_today < v_period_end then 'OPEN'
    else 'BLOCKED'
  end;

  next_snapshot := jsonb_build_object(
    'tenant_id', normalized_tenant,
    'period_start', v_period_start,
    'period_end', v_period_end - 1,
    'timezone', 'America/Sao_Paulo',
    'status', next_status,
    'blockers', blockers,
    'roster', jsonb_build_object(
      'expected_students', expected_count,
      'settled_students', settled_count,
      'blocked_students', blocked_count,
      'missing_invoice_students', missing_count,
      'open_students', open_count,
      'waiting_credit_students', waiting_credit_count,
      'review_students', review_count,
      'items', obligation_states
    ),
    'competence', jsonb_build_object(
      'billed', competence_billed,
      'settled', competence_settled
    ),
    'cash', cash_totals,
    'rules', rules_snapshot,
    'unclassified_cash_count', unclassified_count,
    'open_reconciliation_count', reconciliation_count,
    'calculated_at', pg_catalog.now()
  );
  next_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to((next_snapshot - 'calculated_at')::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  select closure.*
    into closure_row
    from public.monthly_payment_closures as closure
   where closure.tenant_id = normalized_tenant
     and closure.period_start = v_period_start
   for update;

  if closure_row.sent_at is not null then
    if closure_row.snapshot_hash is distinct from next_hash then
      update public.monthly_payment_closures as target
         set status = 'REVIEW',
             review_reason = 'source_changed_after_monthly_close',
             updated_at = pg_catalog.now()
       where target.tenant_id = normalized_tenant
         and target.period_start = v_period_start;
    end if;
    return jsonb_build_object(
      'ok', true,
      'tenant_id', normalized_tenant,
      'period_start', v_period_start,
      'status', case when closure_row.snapshot_hash is distinct from next_hash
                     then 'REVIEW' else closure_row.status end,
      'already_sent', true,
      'snapshot', closure_row.snapshot
    );
  end if;

  -- A rejeição ou um timeout ambíguo do POST é terminal para esta competência:
  -- nunca tentamos um segundo envio irreversível. Preserve REVIEW nos sweeps
  -- seguintes até que um gestor faça a conciliação manual.
  if closure_row.status = 'REVIEW'
     and closure_row.review_reason in (
       'monthly_message_failed',
       'monthly_message_unknown',
       'monthly_message_suppressed'
     )
  then
    return jsonb_build_object(
      'ok', true,
      'tenant_id', normalized_tenant,
      'period_start', v_period_start,
      'status', 'REVIEW',
      'ready', false,
      'delivery_review', true,
      'review_reason', closure_row.review_reason,
      'snapshot', closure_row.snapshot
    );
  end if;

  update public.monthly_payment_closures as target
     set status = next_status,
         expected_students = expected_count,
         settled_students = settled_count,
         blocked_students = blocked_count,
         unclassified_cash_count = unclassified_count,
         open_reconciliation_count = reconciliation_count,
         snapshot = next_snapshot,
         snapshot_hash = next_hash,
         group_destination_snapshot = case
           when next_status = 'READY' then destination
           else null
         end,
         ready_at = case
           when next_status = 'READY' then coalesce(ready_at, pg_catalog.now())
           else null
         end,
         review_reason = null,
         updated_at = pg_catalog.now()
   where target.tenant_id = normalized_tenant
     and target.period_start = v_period_start;

  return jsonb_build_object(
    'ok', true,
    'tenant_id', normalized_tenant,
    'period_start', v_period_start,
    'status', next_status,
    'ready', next_status = 'READY',
    'snapshot_hash', next_hash,
    'snapshot', next_snapshot
  );
end;
$function$;

alter function public.refresh_monthly_payment_closure(text, date)
  owner to postgres;
revoke all on function public.refresh_monthly_payment_closure(text, date)
  from public, anon, authenticated;
grant execute on function public.refresh_monthly_payment_closure(text, date)
  to service_role;

create or replace function public.monthly_payment_closure_targets()
returns table (tenant_id text, period_start date)
language sql
stable
security definer
set search_path = ''
as $function$
  with periods as (
    select pg_catalog.date_trunc(
             'month',
             pg_catalog.now() at time zone 'America/Sao_Paulo'
           )::date as period_start
    union all
    select (
      pg_catalog.date_trunc(
        'month',
        pg_catalog.now() at time zone 'America/Sao_Paulo'
      ) - interval '1 month'
    )::date
  )
  select setting.tenant_id, periods.period_start
    from public.dre_report_settings as setting
    join public.payment_split_settings as split
      on split.tenant_id = setting.tenant_id
     and split.is_active
    cross join periods
   where setting.is_active
   order by periods.period_start, setting.tenant_id;
$function$;

alter function public.monthly_payment_closure_targets() owner to postgres;
revoke all on function public.monthly_payment_closure_targets()
  from public, anon, authenticated;
grant execute on function public.monthly_payment_closure_targets()
  to service_role;

create or replace function public.get_monthly_payment_closure_status(
  p_period_start date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller public.profiles%rowtype;
  target_period date := pg_catalog.date_trunc(
    'month',
    coalesce(
      p_period_start,
      pg_catalog.now() at time zone 'America/Sao_Paulo'
    )
  )::date;
  target_tenant text;
begin
  select profile.* into caller
    from public.profiles as profile
   where profile.id = (select auth.uid());
  if not found or caller.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'not_authorized';
  end if;
  target_tenant := caller.tenant_id;
  return coalesce(
    (
      select jsonb_build_object(
        'tenant_id', closure.tenant_id,
        'period_start', closure.period_start,
        'status', closure.status,
        'snapshot', closure.snapshot,
        'ready_at', closure.ready_at,
        'sent_at', closure.sent_at,
        'review_reason', closure.review_reason
      )
        from public.monthly_payment_closures as closure
       where closure.tenant_id = target_tenant
         and closure.period_start = target_period
    ),
    jsonb_build_object(
      'tenant_id', target_tenant,
      'period_start', target_period,
      'status', 'NOT_CALCULATED'
    )
  );
end;
$function$;

alter function public.get_monthly_payment_closure_status(date)
  owner to postgres;
revoke all on function public.get_monthly_payment_closure_status(date)
  from public, anon;
grant execute on function public.get_monthly_payment_closure_status(date)
  to authenticated;

-- The WhatsApp management agent runs with service_role, so the legacy
-- get_cashflow(text) facade cannot infer a tenant from auth.uid(). Keep the
-- public/admin facade unchanged and expose only this narrowly scoped, read-only
-- context to the trusted Edge Function. All totals are calculated in SQL and
-- the stored monthly-close snapshot is reduced to aggregates plus unresolved
-- students before it reaches the model.
create or replace function public.gestao_financial_context(
  p_tenant text,
  p_month text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant, '')), '');
  normalized_month text := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_month, '')), ''),
    pg_catalog.to_char(
      pg_catalog.now() at time zone 'America/Sao_Paulo',
      'YYYY-MM'
    )
  );
  month_start date;
  month_end date;
  receivables numeric := 0;
  delinquency jsonb := '{}'::jsonb;
  monthly_closures jsonb := '{}'::jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if normalized_tenant is null
     or not exists (
       select 1 from public.tenants as tenant
        where tenant.id = normalized_tenant
     )
     or normalized_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_management_financial_context_scope';
  end if;

  month_start := pg_catalog.to_date(normalized_month || '-01', 'YYYY-MM-DD');
  month_end := (month_start + interval '1 month')::date;
  if pg_catalog.to_char(month_start, 'YYYY-MM') <> normalized_month then
    raise exception using
      errcode = '22023',
      message = 'invalid_management_financial_context_scope';
  end if;

  -- These predicates deliberately mirror get_cashflow_unchecked(text). The
  -- only difference is that the trusted tenant is explicit instead of inferred
  -- from auth.uid(), which is null for a service_role Edge Function.
  select pg_catalog.jsonb_build_object(
           'total', pg_catalog.round(coalesce(sum(payment.value), 0), 2),
           'd1_30', pg_catalog.round(coalesce(sum(payment.value) filter (
             where current_date - payment.due_date between 1 and 30
           ), 0), 2),
           'd31_60', pg_catalog.round(coalesce(sum(payment.value) filter (
             where current_date - payment.due_date between 31 and 60
           ), 0), 2),
           'd60plus', pg_catalog.round(coalesce(sum(payment.value) filter (
             where current_date - payment.due_date > 60
           ), 0), 2),
           'count', count(*)::integer
         )
    into delinquency
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.status in ('OVERDUE', 'DUNNING_REQUESTED');

  select pg_catalog.round(coalesce(sum(payment.value), 0), 2)
    into receivables
    from public.student_payments as payment
   where payment.tenant_id = normalized_tenant
     and payment.status = 'PENDING'
     and payment.due_date >= month_start
     and payment.due_date < month_end;

  with requested_periods(label, period_start) as (
    values
      ('mes_consultado'::text, month_start),
      ('mes_anterior'::text, (month_start - interval '1 month')::date)
  )
  select coalesce(
           pg_catalog.jsonb_object_agg(
             period.label,
             case
               when closure.tenant_id is null then
                 pg_catalog.jsonb_build_object(
                   'mes', pg_catalog.to_char(period.period_start, 'YYYY-MM'),
                   'status', 'NOT_CALCULATED'
                 )
               else
                 pg_catalog.jsonb_build_object(
                   'mes', pg_catalog.to_char(period.period_start, 'YYYY-MM'),
                   'status', closure.status,
                   'atualizado_em', closure.updated_at,
                   'enviado_em', closure.sent_at,
                   'motivo_revisao', closure.review_reason,
                   'motivos_de_bloqueio', coalesce(
                     closure.snapshot -> 'blockers',
                     '[]'::jsonb
                   ),
                   'alunos', (
                     coalesce(closure.snapshot -> 'roster', '{}'::jsonb)
                       - 'items'
                   ) || pg_catalog.jsonb_build_object(
                     'pendentes', coalesce(
                       (
                         select pg_catalog.jsonb_agg(
                                  item.value order by item.value ->> 'student_name'
                                )
                           from pg_catalog.jsonb_array_elements(
                             coalesce(
                               closure.snapshot #> '{roster,items}',
                               '[]'::jsonb
                             )
                           ) as item(value)
                          where coalesce(item.value ->> 'status', '')
                                not in ('SETTLED', 'EXCLUDED')
                       ),
                       '[]'::jsonb
                     )
                   ),
                   'competencia', coalesce(
                     closure.snapshot -> 'competence',
                     '{}'::jsonb
                   ),
                   'caixa', coalesce(
                     closure.snapshot -> 'cash',
                     '{}'::jsonb
                   ),
                   'regras_rateio', coalesce(
                     closure.snapshot -> 'rules',
                     '{}'::jsonb
                   ),
                   'recebimentos_sem_aluno', coalesce(
                     (closure.snapshot ->> 'unclassified_cash_count')::integer,
                     0
                   ),
                   'conciliacoes_em_aberto', coalesce(
                     (closure.snapshot ->> 'open_reconciliation_count')::integer,
                     0
                   )
                 )
             end
           ),
           '{}'::jsonb
         )
    into monthly_closures
    from requested_periods as period
    left join public.monthly_payment_closures as closure
      on closure.tenant_id = normalized_tenant
     and closure.period_start = period.period_start;

  return pg_catalog.jsonb_build_object(
    'tenant_id', normalized_tenant,
    'mes', normalized_month,
    'inadimplencia', delinquency,
    'a_receber_no_mes', receivables,
    'fechamento_mensal', monthly_closures
  );
end;
$function$;

alter function public.gestao_financial_context(text, text) owner to postgres;
revoke all on function public.gestao_financial_context(text, text)
  from public, anon, authenticated;
grant execute on function public.gestao_financial_context(text, text)
  to service_role;

-- Payment authorization and the monthly close have a separate irreversible
-- delivery fence. A timeout is never retried, and every source is revalidated
-- immediately before the single provider POST.
create table if not exists public.management_group_message_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  notification_kind text not null check (
    notification_kind in ('PAYMENT_CONFIRMED', 'MONTHLY_PAYMENT_CLOSE')
  ),
  subject_id text not null,
  ref_date date not null,
  status text not null default 'CLAIMED' check (
    status in ('CLAIMED', 'SUBMITTING', 'SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
  ),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  submit_attempt_count integer not null default 0 check (
    submit_attempt_count between 0 and 1
  ),
  provider_http_status integer,
  last_error text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (tenant_id, notification_kind, subject_id, ref_date)
);

alter table public.management_group_message_attempts owner to postgres;
alter table public.management_group_message_attempts enable row level security;
alter table public.management_group_message_attempts force row level security;
revoke all on table public.management_group_message_attempts
  from public, anon, authenticated, service_role;
grant select on table public.management_group_message_attempts to service_role;

create or replace function private.management_group_message_exact_scope_active(
  p_tenant_id text,
  p_notification_kind text,
  p_subject_id text,
  p_ref_date date
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.tenants as tenant
      join public.dre_report_settings as setting
        on setting.tenant_id = tenant.id
       and setting.is_active
       and nullif(pg_catalog.btrim(setting.destino), '') is not null
     where tenant.id = p_tenant_id
       and tenant.whatsapp_enabled is true
       and lower(pg_catalog.btrim(coalesce(tenant.saas_status, ''))) in (
         'active', 'trial', 'trialing'
       )
  ) and (
    (
      p_notification_kind = 'PAYMENT_CONFIRMED'
      and exists (
        select 1
          from public.student_payments as payment
          join public.profiles as student
            on student.id = payment.student_id
           and student.tenant_id = payment.tenant_id
           and student.role = 'STUDENT'
           and coalesce(student.is_test_account, false) is false
           and student.test_fixture_key is null
         where payment.id::text = p_subject_id
           and payment.tenant_id = p_tenant_id
           and payment.status = 'CONFIRMED'
           and coalesce(payment.value, 0) > 0
           and p_ref_date = coalesce(payment.due_date, payment.created_at::date)
      )
    )
    or (
      p_notification_kind = 'MONTHLY_PAYMENT_CLOSE'
      and p_subject_id = p_tenant_id
      and exists (
        select 1
          from public.monthly_payment_closures as closure
          join public.payment_split_settings as split
            on split.tenant_id = closure.tenant_id
           and split.is_active
         where closure.tenant_id = p_tenant_id
           and closure.period_start = p_ref_date
           and closure.status = 'READY'
           and closure.sent_at is null
           and closure.snapshot_hash is not null
           and closure.group_destination_snapshot = (
             select setting.destino
               from public.dre_report_settings as setting
              where setting.tenant_id = p_tenant_id
                and setting.is_active
           )
      )
    )
  );
$function$;

alter function private.management_group_message_exact_scope_active(
  text, text, text, date
) owner to postgres;
revoke all on function private.management_group_message_exact_scope_active(
  text, text, text, date
) from public, anon, authenticated, service_role;

create or replace function public.claim_management_group_message(
  p_tenant_id text,
  p_notification_kind text,
  p_subject_id text,
  p_ref_date date,
  p_claim_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.management_group_message_attempts%rowtype;
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  normalized_kind text := upper(pg_catalog.btrim(coalesce(p_notification_kind, '')));
  normalized_subject text := nullif(pg_catalog.btrim(coalesce(p_subject_id, '')), '');
  safe_lease integer := greatest(60, least(coalesce(p_lease_seconds, 300), 600));
begin
  if normalized_tenant is null
     or normalized_kind not in ('PAYMENT_CONFIRMED', 'MONTHLY_PAYMENT_CLOSE')
     or normalized_subject is null
     or pg_catalog.length(normalized_subject) > 240
     or p_ref_date is null
     or p_claim_token is null
     or (
       normalized_kind = 'MONTHLY_PAYMENT_CLOSE'
       and normalized_subject <> normalized_tenant
     )
     or (
       normalized_kind = 'PAYMENT_CONFIRMED'
       and normalized_subject !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     )
  then
    raise exception using
      errcode = '22023',
      message = 'invalid_management_group_message_claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'management-group-message:' || normalized_tenant || ':' ||
        normalized_kind || ':' || normalized_subject || ':' || p_ref_date::text,
      0
    )
  );

  if not private.management_group_message_exact_scope_active(
    normalized_tenant,
    normalized_kind,
    normalized_subject,
    p_ref_date
  ) then
    return jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'management_message_scope_inactive'
    );
  end if;

  insert into public.management_group_message_attempts (
    tenant_id,
    notification_kind,
    subject_id,
    ref_date,
    claim_token,
    lease_expires_at
  ) values (
    normalized_tenant,
    normalized_kind,
    normalized_subject,
    p_ref_date,
    p_claim_token,
    pg_catalog.now() + pg_catalog.make_interval(secs => safe_lease)
  ) on conflict (tenant_id, notification_kind, subject_id, ref_date) do nothing;

  select attempt.*
    into attempt_row
    from public.management_group_message_attempts as attempt
   where attempt.tenant_id = normalized_tenant
     and attempt.notification_kind = normalized_kind
     and attempt.subject_id = normalized_subject
     and attempt.ref_date = p_ref_date
   for update;

  if attempt_row.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
     or attempt_row.submit_attempt_count > 0
  then
    return jsonb_build_object(
      'ok', true,
      'action', 'ALREADY_FINAL',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status
    );
  end if;
  if attempt_row.claim_token is distinct from p_claim_token
     and attempt_row.lease_expires_at > pg_catalog.now()
  then
    return jsonb_build_object(
      'ok', true,
      'action', 'IN_PROGRESS',
      'attempt_id', attempt_row.id,
      'status', attempt_row.status
    );
  end if;

  update public.management_group_message_attempts
     set claim_token = p_claim_token,
         lease_expires_at = pg_catalog.now()
           + pg_catalog.make_interval(secs => safe_lease),
         updated_at = pg_catalog.now()
   where id = attempt_row.id
   returning * into attempt_row;

  return jsonb_build_object(
    'ok', true,
    'action', 'SUBMIT_ONCE',
    'attempt_id', attempt_row.id,
    'claim_token', attempt_row.claim_token,
    'status', attempt_row.status
  );
end;
$function$;

create or replace function public.mark_management_group_message_submitting(
  p_attempt_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.management_group_message_attempts%rowtype;
  source_locked boolean := false;
begin
  select attempt.* into attempt_row
    from public.management_group_message_attempts as attempt
   where attempt.id = p_attempt_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'management-group-message:' || attempt_row.tenant_id || ':' ||
        attempt_row.notification_kind || ':' || attempt_row.subject_id || ':' ||
        attempt_row.ref_date::text,
      0
    )
  );

  if attempt_row.notification_kind = 'PAYMENT_CONFIRMED' then
    perform 1
      from public.student_payments as payment
     where payment.id::text = attempt_row.subject_id
       and payment.tenant_id = attempt_row.tenant_id
     for update;
    source_locked := found;
  elsif attempt_row.notification_kind = 'MONTHLY_PAYMENT_CLOSE' then
    perform 1
      from public.monthly_payment_closures as closure
     where closure.tenant_id = attempt_row.tenant_id
       and closure.period_start = attempt_row.ref_date
     for update;
    source_locked := found;
  end if;

  select attempt.* into attempt_row
    from public.management_group_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found
     or attempt_row.status <> 'CLAIMED'
     or attempt_row.claim_token is distinct from p_claim_token
     or attempt_row.lease_expires_at <= pg_catalog.now()
     or attempt_row.submit_attempt_count <> 0
  then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;

  if not source_locked
     or not private.management_group_message_exact_scope_active(
       attempt_row.tenant_id,
       attempt_row.notification_kind,
       attempt_row.subject_id,
       attempt_row.ref_date
     )
  then
    update public.management_group_message_attempts
       set status = 'SUPPRESSED',
           lease_expires_at = pg_catalog.now(),
           last_error = 'management_message_scope_changed_before_send',
           updated_at = pg_catalog.now()
     where id = attempt_row.id;
    return jsonb_build_object(
      'ok', false,
      'action', 'SUPPRESSED',
      'status', 'SUPPRESSED',
      'reason', 'management_message_scope_changed_before_send'
    );
  end if;

  update public.management_group_message_attempts
     set status = 'SUBMITTING',
         submit_attempt_count = 1,
         lease_expires_at = pg_catalog.now() + interval '10 minutes',
         updated_at = pg_catalog.now()
   where id = attempt_row.id;
  return jsonb_build_object('ok', true, 'status', 'SUBMITTING');
end;
$function$;

create or replace function public.finish_management_group_message(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_status text,
  p_provider_http_status integer default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_row public.management_group_message_attempts%rowtype;
  normalized_status text := upper(pg_catalog.btrim(coalesce(p_status, '')));
begin
  if normalized_status not in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    raise exception using
      errcode = '22023',
      message = 'invalid_management_group_message_state';
  end if;

  select attempt.* into attempt_row
    from public.management_group_message_attempts as attempt
   where attempt.id = p_attempt_id
   for update;
  if not found or attempt_row.claim_token is distinct from p_claim_token then
    return jsonb_build_object('ok', false, 'reason', 'claim_lost');
  end if;
  if attempt_row.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED') then
    return jsonb_build_object(
      'ok', attempt_row.status = normalized_status,
      'status', attempt_row.status,
      'ignored_regression', attempt_row.status <> normalized_status
    );
  end if;
  if normalized_status = 'SUPPRESSED' then
    if attempt_row.status <> 'CLAIMED' or attempt_row.submit_attempt_count <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_suppression_transition');
    end if;
  elsif attempt_row.status <> 'SUBMITTING'
     or attempt_row.submit_attempt_count <> 1
  then
    return jsonb_build_object('ok', false, 'reason', 'submit_not_started');
  end if;

  update public.management_group_message_attempts
     set status = normalized_status,
         provider_http_status = p_provider_http_status,
         last_error = nullif(pg_catalog.left(coalesce(p_error, ''), 500), ''),
         lease_expires_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where id = attempt_row.id;
  return jsonb_build_object('ok', true, 'status', normalized_status);
end;
$function$;

alter function public.claim_management_group_message(
  text, text, text, date, uuid, integer
) owner to postgres;
alter function public.mark_management_group_message_submitting(uuid, uuid)
  owner to postgres;
alter function public.finish_management_group_message(
  uuid, uuid, text, integer, text
) owner to postgres;
revoke all on function public.claim_management_group_message(
  text, text, text, date, uuid, integer
) from public, anon, authenticated;
revoke all on function public.mark_management_group_message_submitting(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_management_group_message(
  uuid, uuid, text, integer, text
) from public, anon, authenticated;
grant execute on function public.claim_management_group_message(
  text, text, text, date, uuid, integer
) to service_role;
grant execute on function public.mark_management_group_message_submitting(uuid, uuid)
  to service_role;
grant execute on function public.finish_management_group_message(
  uuid, uuid, text, integer, text
) to service_role;

create or replace function public.management_payment_confirmation_pending()
returns table (payment_id uuid)
language sql
stable
security definer
set search_path = ''
as $function$
  select payment.id
    from public.student_payments as payment
    join public.profiles as student
      on student.id = payment.student_id
     and student.tenant_id = payment.tenant_id
     and student.role = 'STUDENT'
     and coalesce(student.is_test_account, false) is false
     and student.test_fixture_key is null
    join public.dre_report_settings as setting
      on setting.tenant_id = payment.tenant_id
     and setting.is_active
   where payment.status = 'CONFIRMED'
     and coalesce(payment.value, 0) > 0
     and payment.updated_at >= pg_catalog.now() - interval '7 days'
     and not exists (
       select 1
         from public.management_group_message_attempts as attempt
        where attempt.tenant_id = payment.tenant_id
          and attempt.notification_kind = 'PAYMENT_CONFIRMED'
          and attempt.subject_id = payment.id::text
          and attempt.ref_date = coalesce(payment.due_date, payment.created_at::date)
     )
   order by payment.updated_at, payment.id
   limit 30;
$function$;

alter function public.management_payment_confirmation_pending()
  owner to postgres;
revoke all on function public.management_payment_confirmation_pending()
  from public, anon, authenticated;
grant execute on function public.management_payment_confirmation_pending()
  to service_role;

create or replace function public.notify_management_payment_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  service_key text;
  request_id bigint;
begin
  if new.status <> 'CONFIRMED'
     or coalesce(new.value, 0) <= 0
     or (tg_op = 'UPDATE' and old.status is not distinct from new.status)
     or not exists (
       select 1
         from public.dre_report_settings as setting
        where setting.tenant_id = new.tenant_id
          and setting.is_active
     )
  then
    return new;
  end if;

  select secret.decrypted_secret
    into service_key
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
   limit 1;
  if nullif(pg_catalog.btrim(service_key), '') is null then
    raise warning 'notify_management_payment_confirmation: service key missing';
    return new;
  end if;

  select net.http_post(
    url := 'http://kong:8000/functions/v1/payment-split-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'apikey', service_key
    ),
    body := jsonb_build_object('management_payment_id', new.id),
    timeout_milliseconds := 20000
  ) into request_id;
  return new;
exception when others then
  raise warning 'notify_management_payment_confirmation failed (payment preserved): %', sqlerrm;
  return new;
end;
$function$;

alter function public.notify_management_payment_confirmation()
  owner to postgres;
revoke all on function public.notify_management_payment_confirmation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_notify_management_payment_confirmation
  on public.student_payments;
create trigger trg_notify_management_payment_confirmation
  after insert or update of status on public.student_payments
  for each row execute function public.notify_management_payment_confirmation();

create or replace function public.mark_monthly_payment_closure_sent(
  p_tenant_id text,
  p_period_start date,
  p_attempt_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  normalized_period date := pg_catalog.date_trunc('month', p_period_start)::date;
begin
  if normalized_tenant is null or p_period_start is null or p_attempt_id is null then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'monthly-payment-closure:' || normalized_tenant || ':' || normalized_period::text,
      0
    )
  );
  if not exists (
    select 1
      from public.management_group_message_attempts as attempt
     where attempt.id = p_attempt_id
       and attempt.tenant_id = normalized_tenant
       and attempt.notification_kind = 'MONTHLY_PAYMENT_CLOSE'
       and attempt.subject_id = normalized_tenant
       and attempt.ref_date = normalized_period
       and attempt.status = 'SENT'
  ) then
    return false;
  end if;
  update public.monthly_payment_closures as closure
     set status = 'SENT',
         sent_at = coalesce(closure.sent_at, pg_catalog.now()),
         sent_attempt_id = p_attempt_id,
         updated_at = pg_catalog.now()
   where closure.tenant_id = normalized_tenant
     and closure.period_start = normalized_period
     and closure.snapshot_hash is not null;
  return found;
end;
$function$;

alter function public.mark_monthly_payment_closure_sent(text, date, uuid)
  owner to postgres;
revoke all on function public.mark_monthly_payment_closure_sent(text, date, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_monthly_payment_closure_sent(text, date, uuid)
  to service_role;

-- Reconciles every terminal provider outcome with the source closure. In
-- particular, FAILED/UNKNOWN must not leave the source in READY: the durable
-- attempt has already consumed its single allowed provider submission.
create or replace function public.apply_monthly_payment_closure_delivery_result(
  p_tenant_id text,
  p_period_start date,
  p_attempt_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_tenant text := nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '');
  normalized_period date := pg_catalog.date_trunc('month', p_period_start)::date;
  delivery_status text;
begin
  if normalized_tenant is null or p_period_start is null or p_attempt_id is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'monthly-payment-closure:' || normalized_tenant || ':' || normalized_period::text,
      0
    )
  );

  select attempt.status
    into delivery_status
    from public.management_group_message_attempts as attempt
   where attempt.id = p_attempt_id
     and attempt.tenant_id = normalized_tenant
     and attempt.notification_kind = 'MONTHLY_PAYMENT_CLOSE'
     and attempt.subject_id = normalized_tenant
     and attempt.ref_date = normalized_period
     and attempt.status in ('SENT', 'FAILED', 'UNKNOWN', 'SUPPRESSED')
   for update;
  if not found then
    return false;
  end if;

  if delivery_status = 'SENT' then
    update public.monthly_payment_closures as closure
       set status = 'SENT',
           sent_at = coalesce(closure.sent_at, pg_catalog.now()),
           sent_attempt_id = p_attempt_id,
           review_reason = null,
           updated_at = pg_catalog.now()
     where closure.tenant_id = normalized_tenant
       and closure.period_start = normalized_period
       and closure.snapshot_hash is not null
       and (
         closure.sent_at is null
         or closure.sent_attempt_id = p_attempt_id
       );
  else
    update public.monthly_payment_closures as closure
       set status = 'REVIEW',
           review_reason = case delivery_status
             when 'FAILED' then 'monthly_message_failed'
             when 'UNKNOWN' then 'monthly_message_unknown'
             else 'monthly_message_suppressed'
           end,
           updated_at = pg_catalog.now()
     where closure.tenant_id = normalized_tenant
       and closure.period_start = normalized_period
       and closure.sent_at is null
       and closure.snapshot_hash is not null;
  end if;

  return found;
end;
$function$;

alter function public.apply_monthly_payment_closure_delivery_result(
  text, date, uuid
) owner to postgres;
revoke all on function public.apply_monthly_payment_closure_delivery_result(
  text, date, uuid
) from public, anon, authenticated;
grant execute on function public.apply_monthly_payment_closure_delivery_result(
  text, date, uuid
) to service_role;

do $postcheck$
begin
  if pg_catalog.to_regclass('public.monthly_payment_closures') is null
     or pg_catalog.to_regclass('public.management_group_message_attempts') is null
     or pg_catalog.to_regprocedure(
       'public.refresh_monthly_payment_closure(text,date)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.apply_monthly_payment_closure_delivery_result(text,date,uuid)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.gestao_financial_context(text,text)'
     ) is null
     or pg_catalog.has_table_privilege(
       'authenticated',
       'public.monthly_payment_closures',
       'SELECT'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.gestao_financial_context(text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_management_group_message(text,text,text,date,uuid,integer)',
       'EXECUTE'
     )
  then
    raise exception 'monthly payment closure was not installed safely';
  end if;
end;
$postcheck$;

commit;
