begin;

-- The formatting repair from 20260828000000 was authored for the isolated
-- Wolfie release and can run after the main billing hardening. Recompose both
-- guarantees here: normalize harmless event formatting, but credit minutes
-- only after money is actually received. The verified eight-argument wrapper
-- remains the only worker entry point.
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
  v_event_name text := pg_catalog.upper(
    pg_catalog.btrim(coalesce(p_event, ''))
  );
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_is_paid boolean := v_event_name in (
    'PAYMENT_RECEIVED',
    'PAYMENT_RECEIVED_IN_CASH'
  );
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

alter function public.apply_wolfie_topup_payment(
  uuid, text, text, numeric, numeric
) owner to postgres;
alter function public.apply_wolfie_topup_payment(
  uuid, text, text, numeric, numeric
) set search_path = '';
revoke all on function public.apply_wolfie_topup_payment(
  uuid, text, text, numeric, numeric
) from public, anon, authenticated, service_role;

comment on function public.apply_wolfie_topup_payment(
  uuid, text, text, numeric, numeric
) is
  'Owner-only implementation for verified top-up events; normalizes formatting and credits only settled receipts.';

do $postcheck$
declare
  v_target regprocedure := to_regprocedure(
    'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)'
  );
  v_definition text;
begin
  if v_target is null then
    raise exception 'wolfie top-up implementation is missing';
  end if;

  select pg_catalog.pg_get_functiondef(v_target)
    into v_definition;

  if pg_catalog.strpos(
       pg_catalog.upper(v_definition), 'PAYMENT_CONFIRMED'
     ) > 0
     or pg_catalog.regexp_match(
       pg_catalog.lower(v_definition),
       'v_is_paid[[:space:]]+boolean[[:space:]]*:=[[:space:]]*v_event_name[[:space:]]+in[[:space:]]*[(][[:space:]]*''payment_received''[[:space:]]*,[[:space:]]*''payment_received_in_cash''[[:space:]]*[)]'
     ) is null
     or pg_catalog.strpos(
       pg_catalog.lower(v_definition), 'pg_catalog.btrim'
     ) = 0
     or not (
       select p.prosecdef
          and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
          and exists (
            select 1
              from unnest(coalesce(p.proconfig, array[]::text[])) setting
             where setting = 'search_path=""'
          )
         from pg_catalog.pg_proc as p
        where p.oid = v_target
     )
     or pg_catalog.has_function_privilege('anon', v_target, 'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated', v_target, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role', v_target, 'EXECUTE'
     )
  then
    raise exception 'wolfie top-up settled boundary is not fail-closed';
  end if;
end;
$postcheck$;

commit;
