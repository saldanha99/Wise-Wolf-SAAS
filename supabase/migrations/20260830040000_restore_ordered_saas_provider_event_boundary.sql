begin;

-- Restore the single ordered boundary introduced by
-- 20260825205500_serialize_saas_provider_events.sql. Later compatibility
-- migrations recreated an unordered 12-argument route and replaced the
-- ordered function with an adapter that discarded the provider ordering
-- identity. Both public overloads must be removed before recreating the
-- canonical signature because PostgreSQL does not allow CREATE OR REPLACE to
-- rename input parameters.

do $precheck$
begin
  if pg_catalog.to_regprocedure(
       'private.apply_saas_checkout_billing_event_unordered_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
     ) is null
  then
    raise exception 'private SaaS billing implementation is missing';
  end if;
end;
$precheck$;

drop function if exists public.apply_saas_checkout_billing_event(
  uuid, text, text, timestamptz, text, numeric, text, text, text, text,
  timestamptz, date, text, text
);
drop function if exists public.apply_saas_checkout_billing_event(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
);

create or replace function public.apply_saas_checkout_billing_event(
  p_checkout_id uuid,
  p_event_name text,
  p_provider_event_id text,
  p_event_created_at timestamptz,
  p_payment_id text default null,
  p_payment_value numeric default null,
  p_billing_type text default null,
  p_customer_id text default null,
  p_subscription_id text default null,
  p_billing_cycle text default null,
  p_paid_at timestamptz default null,
  p_due_date date default null,
  p_invoice_url text default null,
  p_bank_slip_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  checkout_row public.saas_checkout_intents%rowtype;
  checkout_watermark public.saas_checkout_event_watermarks%rowtype;
  entity_watermark public.saas_provider_entity_watermarks%rowtype;
  normalized_event text := upper(pg_catalog.btrim(coalesce(p_event_name, '')));
  normalized_event_id text := nullif(
    pg_catalog.btrim(coalesce(p_provider_event_id, '')),
    ''
  );
  normalized_payment_id text := nullif(
    pg_catalog.btrim(coalesce(p_payment_id, '')),
    ''
  );
  normalized_subscription_id text := nullif(
    pg_catalog.btrim(coalesce(p_subscription_id, '')),
    ''
  );
  normalized_customer_id text := nullif(
    pg_catalog.btrim(coalesce(p_customer_id, '')),
    ''
  );
  normalized_billing_type text := upper(
    pg_catalog.btrim(coalesce(p_billing_type, ''))
  );
  normalized_billing_cycle text := upper(
    pg_catalog.btrim(coalesce(p_billing_cycle, ''))
  );
  entity_kind text;
  entity_id text;
  event_rank integer;
  event_is_terminal boolean;
  event_terminates_checkout boolean;
  event_grants_access boolean;
  event_restricts_access boolean;
  replay_requires_provision boolean;
  checkout_event_is_stale boolean := false;
  terminal_checkout_blocks_global boolean := false;
  checkout_stale_reason text;
  entity_event_advances boolean;
  entity_event_ambiguous boolean;
  legacy_paid_anchor timestamptz;
  existing_invoice public.saas_invoices%rowtype;
  result jsonb;
begin
  if p_checkout_id is null
     or normalized_event_id is null
     or length(normalized_event_id) > 240
     or p_event_created_at is null
     or p_event_created_at < timestamptz '2000-01-01 00:00:00+00'
     or p_event_created_at > pg_catalog.now() + interval '1 day'
     or normalized_event not in (
       'PAYMENT_CONFIRMED',
       'PAYMENT_RECEIVED',
       'PAYMENT_RECEIVED_IN_CASH',
       'PAYMENT_OVERDUE',
       'PAYMENT_REFUND_IN_PROGRESS',
       'PAYMENT_BANK_SLIP_CANCELLED',
       'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
       'PAYMENT_REPROVED_BY_RISK_ANALYSIS',
       'PAYMENT_DELETED',
       'PAYMENT_REFUNDED',
       'PAYMENT_PARTIALLY_REFUNDED',
       'PAYMENT_RECEIVED_IN_CASH_UNDONE',
       'PAYMENT_CHARGEBACK_REQUESTED',
       'SUBSCRIPTION_INACTIVATED',
       'SUBSCRIPTION_DELETED'
     )
  then
    raise exception using
      errcode = '22023', message = 'invalid_ordered_saas_provider_event';
  end if;

  if normalized_event like 'SUBSCRIPTION_%' then
    entity_kind := 'SUBSCRIPTION';
    entity_id := normalized_subscription_id;
  else
    entity_kind := 'PAYMENT';
    entity_id := normalized_payment_id;
  end if;
  if entity_id is null or length(entity_id) > 240 then
    raise exception using
      errcode = '22023', message = 'saas_provider_entity_id_required';
  end if;

  event_rank := private.saas_provider_event_rank(normalized_event);
  event_is_terminal := private.saas_provider_event_is_terminal(normalized_event);
  event_terminates_checkout :=
    private.saas_provider_event_terminates_checkout(normalized_event);
  event_grants_access := normalized_event in (
    'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH'
  );
  event_restricts_access := event_terminates_checkout or normalized_event in (
    'PAYMENT_OVERDUE',
    'PAYMENT_REFUND_IN_PROGRESS',
    'PAYMENT_BANK_SLIP_CANCELLED',
    'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
    'PAYMENT_REPROVED_BY_RISK_ANALYSIS'
  );

  select checkout.* into checkout_row
    from public.saas_checkout_intents as checkout
   where checkout.id = p_checkout_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'saas_checkout_not_found';
  end if;
  if normalized_subscription_id is null
     or checkout_row.asaas_subscription_id is null
     or checkout_row.asaas_subscription_id <> normalized_subscription_id
  then
    raise exception using errcode = '42501', message = 'saas_subscription_mismatch';
  end if;
  if normalized_customer_id is null
     or checkout_row.asaas_customer_id is null
     or checkout_row.asaas_customer_id <> normalized_customer_id
  then
    raise exception using errcode = '42501', message = 'saas_customer_mismatch';
  end if;
  if p_payment_value is null
     or pg_catalog.abs(p_payment_value - checkout_row.amount) >= 0.005
  then
    raise exception using errcode = '42501', message = 'saas_amount_mismatch';
  end if;
  if normalized_billing_type = ''
     or normalized_billing_type <> upper(checkout_row.billing_type)
  then
    raise exception using errcode = '42501', message = 'saas_billing_type_mismatch';
  end if;
  if normalized_billing_cycle <> ''
     and normalized_billing_cycle <> upper(checkout_row.billing_cycle)
  then
    raise exception using errcode = '42501', message = 'saas_billing_cycle_mismatch';
  end if;

  replay_requires_provision := event_grants_access
    and upper(pg_catalog.btrim(coalesce(checkout_row.status, ''))) = 'PAID'
    and normalized_payment_id is not null
    and nullif(
      pg_catalog.btrim(coalesce(checkout_row.asaas_payment_id, '')),
      ''
    ) = normalized_payment_id
    and (
      checkout_row.tenant_id is null
      or checkout_row.provisioned_at is null
    );

  select watermark.* into checkout_watermark
    from public.saas_checkout_event_watermarks as watermark
   where watermark.checkout_id = p_checkout_id
   for update;

  select watermark.* into entity_watermark
    from public.saas_provider_entity_watermarks as watermark
   where watermark.checkout_id = p_checkout_id
     and watermark.provider_entity_kind = entity_kind
     and watermark.provider_entity_id = entity_id
   for update;

  if checkout_watermark.last_provider_event_id is not null
     and checkout_watermark.last_provider_event_id = normalized_event_id
  then
    if checkout_watermark.last_provider_event_at is distinct from p_event_created_at
       or checkout_watermark.last_provider_event_name is distinct from normalized_event
       or checkout_watermark.last_provider_entity_kind is distinct from entity_kind
       or checkout_watermark.last_provider_entity_id is distinct from entity_id
    then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'REVIEW_REQUIRED',
        'reason', 'saas_checkout_provider_event_id_collision',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', case
        when event_terminates_checkout then 'TERMINAL_REPLAY_IGNORED'
        when replay_requires_provision then 'PROVISION_REQUIRED'
        else 'ORDER_REPLAY'
      end,
      'reason', case
        when replay_requires_provision then 'saas_provision_resume_required'
        else 'saas_provider_event_replayed'
      end,
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;
  if entity_watermark.last_provider_event_id is not null
     and entity_watermark.last_provider_event_id = normalized_event_id
     and (
       entity_watermark.last_provider_event_at is distinct from p_event_created_at
       or entity_watermark.last_provider_event_name is distinct from normalized_event
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_provider_entity_event_id_collision',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;

  entity_event_advances := entity_watermark.last_provider_event_id is null
    or p_event_created_at > entity_watermark.last_provider_event_at
    or (
      p_event_created_at = entity_watermark.last_provider_event_at
      and event_rank > entity_watermark.last_provider_event_rank
    );
  entity_event_ambiguous :=
    entity_watermark.last_provider_event_id is not null
    and entity_watermark.last_provider_event_id <> normalized_event_id
    and p_event_created_at = entity_watermark.last_provider_event_at
    and event_rank = entity_watermark.last_provider_event_rank;

  if entity_kind = 'PAYMENT' then
    select invoice.*
      into existing_invoice
      from public.saas_invoices as invoice
     where invoice.asaas_payment_id = entity_id
     for update;
  end if;

  -- A provider payment id is global. If a historical local invoice already
  -- owns it, that exact tenant and amount must agree before either the normal
  -- billing implementation or the entity-only reconciliation may touch it.
  if existing_invoice.id is not null
     and (
       existing_invoice.tenant_id is distinct from checkout_row.tenant_id
       or existing_invoice.amount is null
       or pg_catalog.abs(existing_invoice.amount - checkout_row.amount) >= 0.005
     )
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_payment_invoice_binding_mismatch',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;

  -- Existing terminal invoices are authoritative even before this migration's
  -- watermark exists. Never turn the same refunded/reversed payment paid.
  if event_grants_access
     and upper(pg_catalog.btrim(coalesce(existing_invoice.status, ''))) in (
    'REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK', 'CANCELLED'
  ) then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'TERMINAL_IGNORED',
      'reason', 'saas_payment_invoice_is_terminal',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;

  if entity_watermark.terminal_event and not event_is_terminal then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'TERMINAL_IGNORED',
      'reason', 'saas_provider_entity_is_terminal',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;

  -- The checkout payment binding identifies the payment backing current
  -- access. An event for another already-existing invoice is historical and
  -- belongs to that entity only. A genuinely new recurring installment has no
  -- invoice yet: only settlement or OVERDUE may inaugurate it after the exact
  -- tuple above and an advancing checkout watermark below. An unbound refund,
  -- chargeback or cancellation remains ambiguous and is triaged entity-local.
  if entity_kind = 'PAYMENT'
     and checkout_row.asaas_payment_id is not null
     and pg_catalog.btrim(checkout_row.asaas_payment_id) <> entity_id
     and (event_restricts_access or event_grants_access)
     and (
       existing_invoice.id is not null
       or (
         event_restricts_access
         and normalized_event <> 'PAYMENT_OVERDUE'
       )
     )
  then
    checkout_event_is_stale := true;
    if checkout_watermark.terminal_event
       and (
         p_event_created_at > checkout_watermark.last_provider_event_at
         or (
           p_event_created_at = checkout_watermark.last_provider_event_at
           and event_rank >= checkout_watermark.last_provider_event_rank
         )
       )
    then
      terminal_checkout_blocks_global := true;
      checkout_stale_reason := 'saas_checkout_provider_lifecycle_is_terminal';
    else
      checkout_stale_reason := 'saas_payment_is_not_current_access_payment';
    end if;
  end if;

  -- A legacy cancelled checkout has no trustworthy event-time watermark. No
  -- non-terminal event may first rewrite it to OVERDUE and later open a paid
  -- restoration path. A new subscription needs a new checkout binding.
  if checkout_row.status = 'CANCELLED'
     and checkout_watermark.last_provider_event_id is null
     and not checkout_event_is_stale
     and not event_terminates_checkout
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'REVIEW_REQUIRED',
      'reason', 'cancelled_saas_checkout_cannot_auto_restore',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;

  -- Legacy OVERDUE rows have no trustworthy provider-time watermark. A paid
  -- event cannot be ordered against the event that suspended access, so it is
  -- deliberately triaged rather than guessed.
  if checkout_row.status = 'OVERDUE'
     and checkout_watermark.last_provider_event_id is null
     and not event_restricts_access
  then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'REVIEW_REQUIRED',
      'reason', 'legacy_saas_overdue_order_unknown',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;

  -- Legacy paid/provisioned checkouts have no trustworthy provider watermark.
  -- Restrictive events therefore cannot be trusted for deterministic global
  -- ordering. They must go to manual review, except for older historical
  -- overdue rows that are clearly stale for the same provisioned payment.
  -- provisioned_at is deliberately not an ordering anchor: local provisioning
  -- occurs after settlement, so a real reversal may fall between the two.
  if checkout_watermark.last_provider_event_id is null
     and not checkout_event_is_stale
     and checkout_row.status in (
       'PAID', 'PROVISIONING', 'PROVISIONING_FAILED', 'PROVISIONED'
     )
     and event_restricts_access
     and checkout_row.asaas_payment_id = normalized_payment_id
  then
    legacy_paid_anchor := checkout_row.paid_at;
    if legacy_paid_anchor is null then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'REVIEW_REQUIRED',
        'reason', 'legacy_saas_access_order_unknown',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;
    if normalized_event = 'PAYMENT_OVERDUE'
       and checkout_row.asaas_payment_id = normalized_payment_id
       and p_event_created_at < legacy_paid_anchor
    then
      checkout_event_is_stale := true;
      checkout_stale_reason := 'saas_event_predates_legacy_access';
    else
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'REVIEW_REQUIRED',
        'reason', 'legacy_saas_restrictive_order_unknown',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;
  end if;

  -- Every event is monotonic at checkout scope. A late refund for payment A
  -- must not revoke access already extended by a newer payment B. At the same
  -- provider timestamp the higher rank wins, so a terminal event still
  -- dominates a non-terminal event without relying on delivery order.
  if checkout_watermark.last_provider_event_id is not null then
    if p_event_created_at < checkout_watermark.last_provider_event_at
       or (
         p_event_created_at = checkout_watermark.last_provider_event_at
         and event_rank < checkout_watermark.last_provider_event_rank
       )
    then
      checkout_event_is_stale := true;
      checkout_stale_reason := 'saas_checkout_event_is_stale';
    end if;
    if not checkout_event_is_stale
       and p_event_created_at = checkout_watermark.last_provider_event_at
       and event_rank = checkout_watermark.last_provider_event_rank
    then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'REVIEW_REQUIRED',
        'reason', 'saas_checkout_event_order_ambiguous',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;
  end if;

  -- A terminal checkout still accepts an older, independently monotonic
  -- payment observation into the entity-only ledger path below. A same/newer
  -- non-terminal event can never mutate or reactivate the global lifecycle.
  if checkout_watermark.terminal_event
     and not event_terminates_checkout
     and not checkout_event_is_stale
  then
    if entity_kind = 'PAYMENT'
       and (event_grants_access or event_restricts_access)
    then
      checkout_event_is_stale := true;
      terminal_checkout_blocks_global := true;
      checkout_stale_reason := 'saas_checkout_provider_lifecycle_is_terminal';
    else
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'TERMINAL_IGNORED',
        'reason', 'saas_checkout_provider_lifecycle_is_terminal',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;
  end if;

  -- A stale event, or one blocked by a terminal checkout, must never rewrite
  -- current access. Its own payment observation is nevertheless durable
  -- accounting data: when it is strictly newer for that payment, record only
  -- invoice/entity state and leave the checkout watermark and tenant untouched.
  if checkout_event_is_stale then
    if (
      not event_restricts_access
      and not event_grants_access
    ) or entity_kind <> 'PAYMENT' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'STALE_IGNORED',
        'reason', checkout_stale_reason,
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;

    if entity_event_ambiguous then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'REVIEW_REQUIRED',
        'reason', 'saas_provider_entity_event_order_ambiguous',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;
    -- The first pass may have committed the exact entity observation and then
    -- crashed before the outer durable inbox persisted TRIAGE. Preserve that
    -- decision on exact replay: treating it as merely stale would strand real
    -- settled money behind a terminal checkout with no review issue.
    if terminal_checkout_blocks_global
       and entity_watermark.last_provider_event_id = normalized_event_id
    then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'REVIEW_REQUIRED',
        'reason', 'terminal_saas_checkout_payment_reconciled_for_review',
        'entity_observation_applied', true,
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id,
        'provider_entity_kind', entity_kind,
        'provider_entity_id', entity_id
      );
    end if;
    if not entity_event_advances
       or (
         event_restricts_access
         and
         existing_invoice.paid_at is not null
         and p_event_created_at < existing_invoice.paid_at
       )
    then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', case
          when event_is_terminal and entity_watermark.terminal_event
            then 'TERMINAL_REPLAY_IGNORED'
          else 'STALE_IGNORED'
        end,
        'reason', 'saas_payment_observation_is_stale',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;

    if existing_invoice.id is null
       or existing_invoice.tenant_id is distinct from checkout_row.tenant_id
       or existing_invoice.amount is null
       or pg_catalog.abs(existing_invoice.amount - checkout_row.amount) >= 0.005
    then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'action', 'REVIEW_REQUIRED',
        'reason', 'stale_saas_payment_invoice_binding_missing',
        'checkout_id', p_checkout_id,
        'provider_event_id', normalized_event_id
      );
    end if;

    update public.saas_invoices
       set status = case
         when event_grants_access then 'PAID'
         when normalized_event = 'PAYMENT_REFUNDED' then 'REFUNDED'
         when normalized_event = 'PAYMENT_PARTIALLY_REFUNDED'
           then 'PARTIALLY_REFUNDED'
         when normalized_event = 'PAYMENT_CHARGEBACK_REQUESTED'
           then 'CHARGEBACK'
         when normalized_event in (
           'PAYMENT_OVERDUE',
           'PAYMENT_REFUND_IN_PROGRESS',
           'PAYMENT_BANK_SLIP_CANCELLED',
           'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
           'PAYMENT_REPROVED_BY_RISK_ANALYSIS'
         ) then 'OVERDUE'
         else 'CANCELLED'
       end,
       paid_at = case
         when event_grants_access then coalesce(
           paid_at,
           p_paid_at,
           p_event_created_at
         )
         else paid_at
       end
     where id = existing_invoice.id;

    insert into public.saas_provider_entity_watermarks (
      checkout_id,
      provider_entity_kind,
      provider_entity_id,
      last_provider_event_id,
      last_provider_event_at,
      last_provider_event_rank,
      last_provider_event_name,
      terminal_event
    ) values (
      p_checkout_id,
      entity_kind,
      entity_id,
      normalized_event_id,
      p_event_created_at,
      event_rank,
      normalized_event,
      event_is_terminal
    ) on conflict (checkout_id, provider_entity_kind, provider_entity_id)
    do update set
      last_provider_event_id = excluded.last_provider_event_id,
      last_provider_event_at = excluded.last_provider_event_at,
      last_provider_event_rank = excluded.last_provider_event_rank,
      last_provider_event_name = excluded.last_provider_event_name,
      terminal_event = public.saas_provider_entity_watermarks.terminal_event
        or excluded.terminal_event,
      updated_at = pg_catalog.now();

    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', case
        when terminal_checkout_blocks_global then 'REVIEW_REQUIRED'
        else 'STALE_ENTITY_APPLIED'
      end,
      'reason', case
        when terminal_checkout_blocks_global
          then 'terminal_saas_checkout_payment_reconciled_for_review'
        else checkout_stale_reason
      end,
      'entity_observation_applied', true,
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id,
      'provider_entity_kind', entity_kind,
      'provider_entity_id', entity_id
    );
  end if;

  if entity_event_ambiguous then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', 'REVIEW_REQUIRED',
      'reason', 'saas_provider_entity_event_order_ambiguous',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;
  if not entity_event_advances then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'action', case
        when event_is_terminal and entity_watermark.terminal_event
          then 'TERMINAL_REPLAY_IGNORED'
        else 'STALE_IGNORED'
      end,
      'reason', 'saas_provider_entity_event_is_not_newer',
      'checkout_id', p_checkout_id,
      'provider_event_id', normalized_event_id
    );
  end if;

  result := private.apply_saas_checkout_billing_event_unordered_impl(
    p_checkout_id,
    normalized_event,
    normalized_payment_id,
    p_payment_value,
    p_billing_type,
    p_customer_id,
    normalized_subscription_id,
    p_billing_cycle,
    p_paid_at,
    p_due_date,
    p_invoice_url,
    p_bank_slip_url
  );

  insert into public.saas_provider_entity_watermarks (
    checkout_id,
    provider_entity_kind,
    provider_entity_id,
    last_provider_event_id,
    last_provider_event_at,
    last_provider_event_rank,
    last_provider_event_name,
    terminal_event
  ) values (
    p_checkout_id,
    entity_kind,
    entity_id,
    normalized_event_id,
    p_event_created_at,
    event_rank,
    normalized_event,
    event_is_terminal
  ) on conflict (checkout_id, provider_entity_kind, provider_entity_id)
  do update set
    last_provider_event_id = excluded.last_provider_event_id,
    last_provider_event_at = excluded.last_provider_event_at,
    last_provider_event_rank = excluded.last_provider_event_rank,
    last_provider_event_name = excluded.last_provider_event_name,
    terminal_event = public.saas_provider_entity_watermarks.terminal_event
      or excluded.terminal_event,
    updated_at = pg_catalog.now();

  insert into public.saas_checkout_event_watermarks (
    checkout_id,
    last_provider_event_id,
    last_provider_event_at,
    last_provider_event_rank,
    last_provider_event_name,
    last_provider_entity_kind,
    last_provider_entity_id,
    terminal_event
  ) values (
    p_checkout_id,
    normalized_event_id,
    p_event_created_at,
    event_rank,
    normalized_event,
    entity_kind,
    entity_id,
    event_terminates_checkout
  ) on conflict (checkout_id) do update set
    last_provider_event_id = case when (
      excluded.last_provider_event_at,
      excluded.last_provider_event_rank
    ) > (
      public.saas_checkout_event_watermarks.last_provider_event_at,
      public.saas_checkout_event_watermarks.last_provider_event_rank
    ) then excluded.last_provider_event_id
      else public.saas_checkout_event_watermarks.last_provider_event_id end,
    last_provider_event_at = greatest(
      excluded.last_provider_event_at,
      public.saas_checkout_event_watermarks.last_provider_event_at
    ),
    last_provider_event_rank = case when
      excluded.last_provider_event_at
        > public.saas_checkout_event_watermarks.last_provider_event_at
      then excluded.last_provider_event_rank
      when excluded.last_provider_event_at
        = public.saas_checkout_event_watermarks.last_provider_event_at
      then greatest(
        excluded.last_provider_event_rank,
        public.saas_checkout_event_watermarks.last_provider_event_rank
      ) else public.saas_checkout_event_watermarks.last_provider_event_rank end,
    last_provider_event_name = case when (
      excluded.last_provider_event_at,
      excluded.last_provider_event_rank
    ) > (
      public.saas_checkout_event_watermarks.last_provider_event_at,
      public.saas_checkout_event_watermarks.last_provider_event_rank
    ) then excluded.last_provider_event_name
      else public.saas_checkout_event_watermarks.last_provider_event_name end,
    last_provider_entity_kind = case when (
      excluded.last_provider_event_at,
      excluded.last_provider_event_rank
    ) > (
      public.saas_checkout_event_watermarks.last_provider_event_at,
      public.saas_checkout_event_watermarks.last_provider_event_rank
    ) then excluded.last_provider_entity_kind
      else public.saas_checkout_event_watermarks.last_provider_entity_kind end,
    last_provider_entity_id = case when (
      excluded.last_provider_event_at,
      excluded.last_provider_event_rank
    ) > (
      public.saas_checkout_event_watermarks.last_provider_event_at,
      public.saas_checkout_event_watermarks.last_provider_event_rank
    ) then excluded.last_provider_entity_id
      else public.saas_checkout_event_watermarks.last_provider_entity_id end,
    terminal_event = public.saas_checkout_event_watermarks.terminal_event
      or excluded.terminal_event,
    updated_at = pg_catalog.now();

  return coalesce(result, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'provider_event_id', normalized_event_id,
    'provider_event_at', p_event_created_at,
    'provider_event_rank', event_rank,
    'provider_entity_kind', entity_kind,
    'provider_entity_id', entity_id
  );
end;
$function$;


alter function public.apply_saas_checkout_billing_event(
  uuid, text, text, timestamptz, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) owner to postgres;
revoke all on function public.apply_saas_checkout_billing_event(
  uuid, text, text, timestamptz, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.apply_saas_checkout_billing_event(
  uuid, text, text, timestamptz, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) to service_role;

alter function private.apply_saas_checkout_billing_event_unordered_impl(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) owner to postgres;
revoke all on function private.apply_saas_checkout_billing_event_unordered_impl(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) from public, anon, authenticated, service_role;

do $postcheck$
declare
  ordered_oid regprocedure := pg_catalog.to_regprocedure(
    'public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text)'
  );
  private_oid regprocedure := pg_catalog.to_regprocedure(
    'private.apply_saas_checkout_billing_event_unordered_impl(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
  );
begin
  if pg_catalog.to_regprocedure(
       'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
     ) is not null
     or ordered_oid is null
     or private_oid is null
     or exists (
       select 1
       from pg_catalog.pg_proc as procedure
       where procedure.oid in (ordered_oid, private_oid)
         and (
           not procedure.prosecdef
           or pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
           or not coalesce(
             procedure.proconfig @> array['search_path=""']::text[],
             false
           )
         )
     )
     or pg_catalog.has_function_privilege('anon', ordered_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated', ordered_oid, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', ordered_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role', private_oid, 'EXECUTE'
     )
  then
    raise exception 'ordered SaaS provider event boundary is not fail-closed';
  end if;
end;
$postcheck$;

notify pgrst, 'reload schema';

commit;
