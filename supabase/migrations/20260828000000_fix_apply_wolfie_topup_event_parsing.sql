-- Align Wolfie top-up event handling with incoming webhook formats.
--
-- The function needs to tolerate harmless formatting variation in event values
-- (leading/trailing spaces, mixed case) while preserving strict validation
-- for truly invalid payloads.

drop function if exists public.apply_wolfie_topup_payment(
  uuid,
  text,
  text,
  numeric,
  numeric
);

create or replace function public.apply_wolfie_topup_payment(
  p_order_id uuid,
  p_payment_id text,
  p_event text,
  p_amount_brl numeric,
  p_refunded_amount_brl numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.wolfie_topup_orders%rowtype;
  v_event_name text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_event, '')));
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_is_paid boolean := v_event_name in ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED');
  v_is_reversal boolean := v_event_name in (
    'PAYMENT_DELETED',
    'PAYMENT_REFUNDED',
    'PAYMENT_CHARGEBACK_REQUESTED',
    'PAYMENT_RECEIVED_IN_CASH_UNDONE'
  );
  v_is_freeze boolean := v_event_name in (
    'PAYMENT_PARTIALLY_REFUNDED',
    'PAYMENT_REFUND_IN_PROGRESS'
  );
begin
  if p_order_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200
     or v_event_name = ''
     or (not v_is_paid and not v_is_reversal and not v_is_freeze)
     or p_amount_brl is null
     or (
       p_refunded_amount_brl is not null
       and p_refunded_amount_brl < 0
     ) then
    raise exception 'invalid_wolfie_topup_event';
  end if;

  select *
    into v_order
    from public.wolfie_topup_orders
   where id = p_order_id
   for update;
  if not found then
    raise exception 'wolfie_topup_order_not_found';
  end if;
  if pg_catalog.round(v_order.amount_brl, 2)
       is distinct from pg_catalog.round(p_amount_brl, 2) then
    raise exception 'wolfie_topup_amount_mismatch';
  end if;
  if v_order.provider_payment_id is not null
     and v_order.provider_payment_id <> v_payment_id then
    raise exception 'wolfie_topup_payment_mismatch';
  end if;
  if p_refunded_amount_brl is not null
     and pg_catalog.round(p_refunded_amount_brl, 2)
       > pg_catalog.round(v_order.amount_brl, 2) then
    raise exception 'wolfie_topup_refund_amount_mismatch';
  end if;

  if v_is_freeze then
    update public.student_minute_credits
       set status = 'SUSPENDED',
           reversal_event = v_event_name
     where order_id = v_order.id
       and status = 'PAID';
    update public.wolfie_topup_orders
       set status = 'SUSPENDED',
           provider_payment_id = coalesce(provider_payment_id, v_payment_id),
           reversal_event = v_event_name,
           refunded_amount_brl = coalesce(
             p_refunded_amount_brl,
             refunded_amount_brl
           ),
           reconciliation_required = true,
           updated_at = pg_catalog.now()
     where id = v_order.id
       and status <> 'REVERSED';
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'suspended', true,
      'reconciliationRequired', true,
      'tenantId', v_order.tenant_id,
      'studentId', v_order.student_id
    );
  end if;

  if v_is_reversal then
    update public.student_minute_credits
       set status = 'REVERSED',
           reversed_at = coalesce(reversed_at, pg_catalog.now()),
           reversal_event = v_event_name
     where order_id = v_order.id
       and status <> 'REVERSED';
    update public.wolfie_topup_orders
       set status = 'REVERSED',
           provider_payment_id = coalesce(provider_payment_id, v_payment_id),
           reversed_at = coalesce(reversed_at, pg_catalog.now()),
           reversal_event = v_event_name,
           refunded_amount_brl = coalesce(
             p_refunded_amount_brl,
             refunded_amount_brl,
             amount_brl
           ),
           reconciliation_required = false,
           updated_at = pg_catalog.now()
     where id = v_order.id;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'reversed', true,
      'tenantId', v_order.tenant_id,
      'studentId', v_order.student_id
    );
  end if;

  -- A paid event arriving after a refund/chargeback must never recreate the
  -- lifetime credit, even if Asaas delivers events out of order.
  if v_order.status in (
    'SUSPENDED',
    'REVERSED',
    'RECONCILIATION_REQUIRED'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'suspended', v_order.status <> 'REVERSED',
      'reversed', v_order.status = 'REVERSED',
      'idempotent', true
    );
  end if;

  insert into public.student_minute_credits (
    tenant_id,
    student_id,
    minutes,
    payment_id,
    order_id,
    status
  ) values (
    v_order.tenant_id,
    v_order.student_id,
    v_order.minutes,
    v_payment_id,
    v_order.id,
    'PAID'
  )
  on conflict (order_id) where order_id is not null do nothing;

  update public.wolfie_topup_orders
     set status = 'PAID',
         provider_payment_id = coalesce(provider_payment_id, v_payment_id),
         paid_at = coalesce(paid_at, pg_catalog.now()),
         creation_lease_expires_at = null,
         updated_at = pg_catalog.now()
   where id = v_order.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'paid', true,
    'tenantId', v_order.tenant_id,
    'studentId', v_order.student_id,
    'minutes', v_order.minutes
  );
end;
$function$;

revoke all on function public.apply_wolfie_topup_payment(
  uuid,
  text,
  text,
  numeric,
  numeric
) from public, anon, authenticated;
grant execute on function public.apply_wolfie_topup_payment(
  uuid,
  text,
  text,
  numeric,
  numeric
) to service_role;
