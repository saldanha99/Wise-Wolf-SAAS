-- Nenhuma automacao pode converter mera confirmacao da Asaas em dinheiro,
-- acesso ou comunicacao. Somente saldo efetivamente recebido liquida top-up e
-- entra na varredura de rateio.

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
  v_payment_id text := nullif(pg_catalog.btrim(p_payment_id), '');
  v_is_paid boolean := p_event in (
    'PAYMENT_RECEIVED',
    'PAYMENT_RECEIVED_IN_CASH'
  );
  v_is_reversal boolean := p_event in (
    'PAYMENT_DELETED',
    'PAYMENT_REFUNDED',
    'PAYMENT_CHARGEBACK_REQUESTED',
    'PAYMENT_RECEIVED_IN_CASH_UNDONE'
  );
  v_is_freeze boolean := p_event in (
    'PAYMENT_PARTIALLY_REFUNDED',
    'PAYMENT_REFUND_IN_PROGRESS'
  );
begin
  if p_order_id is null
     or v_payment_id is null
     or pg_catalog.char_length(v_payment_id) > 200
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
           reversal_event = p_event
     where order_id = v_order.id
       and status = 'PAID';
    update public.wolfie_topup_orders
       set status = 'SUSPENDED',
           provider_payment_id = coalesce(provider_payment_id, v_payment_id),
           reversal_event = p_event,
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
           reversal_event = p_event
     where order_id = v_order.id
       and status <> 'REVERSED';
    update public.wolfie_topup_orders
       set status = 'REVERSED',
           provider_payment_id = coalesce(provider_payment_id, v_payment_id),
           reversed_at = coalesce(reversed_at, pg_catalog.now()),
           reversal_event = p_event,
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

  -- Evento liquidado atrasado nunca reativa credito congelado ou revertido.
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
  uuid,
  text,
  text,
  numeric,
  numeric
) owner to postgres;
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

create or replace function public.payment_split_pending()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return coalesce((
    select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'payment_id', candidate.id,
               'tenant_id', candidate.tenant_id
             )
             order by candidate.cash_at desc, candidate.id
           )
      from (
        select
          payment.id,
          payment.tenant_id,
          coalesce(payment.credited_at, payment.paid_at) as cash_at
        from public.student_payments as payment
        join public.payment_split_settings as setting
          on setting.tenant_id = payment.tenant_id
         and setting.is_active
        where payment.status in ('RECEIVED', 'RECEIVED_IN_CASH')
          and coalesce(payment.value, 0) > 0
          and coalesce(payment.credited_at, payment.paid_at)
                >= (pg_catalog.now() - interval '2 days')
          and not exists (
            select 1
              from public.automation_sent as sent
             where sent.kind = 'PAYMENT_SPLIT'
               and sent.subject_id = payment.id::text
          )
        order by coalesce(payment.credited_at, payment.paid_at) desc, payment.id
        limit 30
      ) as candidate
  ), '[]'::jsonb);
end;
$function$;

alter function public.payment_split_pending() owner to postgres;
revoke all on function public.payment_split_pending()
  from public, anon, authenticated;
grant execute on function public.payment_split_pending() to service_role;

comment on function public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric) is
  'Liquida top-up somente em PAYMENT_RECEIVED/PAYMENT_RECEIVED_IN_CASH; confirmacao sem saldo falha fechada.';
comment on function public.payment_split_pending() is
  'Seleciona para rateio apenas pagamentos efetivamente recebidos, usando data real de credito/recebimento.';

do $postcheck$
declare
  v_topup_definition text;
  v_split_definition text;
begin
  select pg_catalog.pg_get_functiondef(
           'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)'::regprocedure
         )
    into v_topup_definition;
  select pg_catalog.pg_get_functiondef(
           'public.payment_split_pending()'::regprocedure
         )
    into v_split_definition;

  if pg_catalog.upper(v_topup_definition) like '%PAYMENT_CONFIRMED%'
     or pg_catalog.upper(v_topup_definition) not like '%PAYMENT_RECEIVED_IN_CASH%'
     or pg_catalog.upper(v_split_definition) like '%PAYMENT_CONFIRMED%'
     or pg_catalog.upper(v_split_definition) like '%''CONFIRMED''%'
     or pg_catalog.lower(v_split_definition)
          not like '%payment.status in (''received'', ''received_in_cash'')%'
     or pg_catalog.has_function_privilege(
       'anon',
       'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.apply_wolfie_topup_payment(uuid,text,text,numeric,numeric)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.payment_split_pending()',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.payment_split_pending()',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.payment_split_pending()',
       'EXECUTE'
     ) then
    raise exception 'settled_payment_automation_contract_invalid';
  end if;
end
$postcheck$;
