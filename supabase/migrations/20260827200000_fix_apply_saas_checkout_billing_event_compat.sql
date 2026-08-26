-- Ensure the 12-argument compatibility function always drives billing lifecycle.
-- Previous compatibility wrapper could dispatch to legacy signatures with
-- different terminal handling, which made replay-after-refund fail tests.
CREATE OR REPLACE FUNCTION public.apply_saas_checkout_billing_event(
  p_checkout_id uuid,
  p_event_name text,
  p_payment_id text DEFAULT NULL,
  p_payment_value numeric DEFAULT NULL,
  p_billing_type text DEFAULT NULL,
  p_customer_id text DEFAULT NULL,
  p_subscription_id text DEFAULT NULL,
  p_billing_cycle text DEFAULT NULL,
  p_paid_at timestamptz DEFAULT NULL,
  p_due_date date DEFAULT NULL,
  p_invoice_url text DEFAULT NULL,
  p_bank_slip_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  checkout public.saas_checkout_intents%ROWTYPE;
  selected_plan public.saas_plans%ROWTYPE;
  tenant public.tenants%ROWTYPE;
  existing_invoice public.saas_invoices%ROWTYPE;
  event_name text := upper(trim(coalesce(p_event_name, '')));
  payment_id text := nullif(trim(coalesce(p_payment_id, '')), '');
  customer_id text := nullif(trim(coalesce(p_customer_id, '')), '');
  subscription_id text := nullif(trim(coalesce(p_subscription_id, '')), '');
  billing_type text := upper(trim(coalesce(p_billing_type, '')));
  billing_cycle text := upper(trim(coalesce(p_billing_cycle, '')));
  period_anchor timestamptz;
  period_end timestamptz;
  invoice_was_paid boolean := false;
  is_paid_event boolean := event_name IN (
    'PAYMENT_CONFIRMED',
    'PAYMENT_RECEIVED'
  );
  is_overdue_event boolean := event_name IN (
    'PAYMENT_OVERDUE',
    'PAYMENT_REFUND_IN_PROGRESS',
    'PAYMENT_BANK_SLIP_CANCELLED',
    'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
    'PAYMENT_REPROVED_BY_RISK_ANALYSIS'
  );
  is_terminal_event boolean := event_name IN (
    'PAYMENT_DELETED',
    'PAYMENT_REFUNDED',
    'PAYMENT_PARTIALLY_REFUNDED',
    'PAYMENT_RECEIVED_IN_CASH_UNDONE',
    'PAYMENT_CHARGEBACK_REQUESTED',
    'SUBSCRIPTION_INACTIVATED',
    'SUBSCRIPTION_DELETED'
  );
BEGIN
  IF p_checkout_id IS NULL OR event_name = '' THEN
    RAISE EXCEPTION 'saas_billing_event_invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO checkout
  FROM public.saas_checkout_intents AS candidate
  WHERE candidate.id = p_checkout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'saas_checkout_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF subscription_id IS NULL
     OR checkout.asaas_subscription_id IS NULL
     OR subscription_id <> checkout.asaas_subscription_id THEN
    RAISE EXCEPTION 'saas_subscription_mismatch' USING ERRCODE = '42501';
  END IF;
  IF customer_id IS NULL
     OR checkout.asaas_customer_id IS NULL
     OR customer_id <> checkout.asaas_customer_id THEN
    RAISE EXCEPTION 'saas_customer_mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_payment_value IS NULL
     OR abs(p_payment_value - checkout.amount) >= 0.005 THEN
    RAISE EXCEPTION 'saas_amount_mismatch' USING ERRCODE = '42501';
  END IF;
  IF billing_type = '' OR billing_type <> upper(checkout.billing_type) THEN
    RAISE EXCEPTION 'saas_billing_type_mismatch' USING ERRCODE = '42501';
  END IF;
  IF billing_cycle <> ''
     AND billing_cycle <> upper(checkout.billing_cycle) THEN
    RAISE EXCEPTION 'saas_billing_cycle_mismatch' USING ERRCODE = '42501';
  END IF;
  IF event_name LIKE 'PAYMENT_%' AND payment_id IS NULL THEN
    RAISE EXCEPTION 'saas_payment_id_required' USING ERRCODE = '22023';
  END IF;

  IF NOT is_paid_event AND NOT is_overdue_event AND NOT is_terminal_event THEN
    UPDATE public.saas_checkout_intents
    SET invoice_url = coalesce(p_invoice_url, invoice_url),
        bank_slip_url = coalesce(p_bank_slip_url, bank_slip_url),
        due_date = coalesce(p_due_date, due_date),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'lastBillingEvent', event_name,
          'lastBillingEventAt', pg_catalog.now()
        ),
        updated_at = pg_catalog.now()
    WHERE id = checkout.id;

    RETURN jsonb_build_object(
      'ok', true,
      'action', 'IGNORED',
      'checkout_id', checkout.id
    );
  END IF;

  IF is_paid_event
     AND (checkout.tenant_id IS NULL OR checkout.provisioned_at IS NULL) THEN
    UPDATE public.saas_checkout_intents
    SET status = 'PAID',
        asaas_payment_id = payment_id,
        invoice_url = coalesce(p_invoice_url, invoice_url),
        bank_slip_url = coalesce(p_bank_slip_url, bank_slip_url),
        due_date = coalesce(p_due_date, due_date),
        paid_at = coalesce(p_paid_at, paid_at, pg_catalog.now()),
        last_error = NULL,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'lastBillingEvent', event_name,
          'lastBillingEventAt', pg_catalog.now()
        ),
        updated_at = pg_catalog.now()
    WHERE id = checkout.id;

    RETURN jsonb_build_object(
      'ok', true,
      'action', 'PROVISION_REQUIRED',
      'checkout_id', checkout.id
    );
  END IF;

  IF checkout.tenant_id IS NOT NULL THEN
    SELECT *
    INTO tenant
    FROM public.tenants AS candidate
    WHERE candidate.id = checkout.tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'saas_tenant_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF is_overdue_event OR is_terminal_event THEN
    IF payment_id IS NOT NULL THEN
      UPDATE public.saas_invoices
      SET status = CASE
            WHEN is_overdue_event THEN 'OVERDUE'
            WHEN event_name = 'PAYMENT_REFUNDED' THEN 'REFUNDED'
            WHEN event_name = 'PAYMENT_PARTIALLY_REFUNDED' THEN 'PARTIALLY_REFUNDED'
            WHEN event_name = 'PAYMENT_CHARGEBACK_REQUESTED' THEN 'CHARGEBACK'
            ELSE 'CANCELLED'
          END
      WHERE asaas_payment_id = payment_id
        AND tenant_id IS NOT DISTINCT FROM checkout.tenant_id;
    END IF;

    IF checkout.tenant_id IS NOT NULL THEN
      UPDATE public.tenants
      SET saas_status = CASE
            WHEN is_overdue_event THEN 'past_due'
            ELSE 'blocked'
          END,
          current_period_end = least(
            coalesce(current_period_end, pg_catalog.now()),
            pg_catalog.now()
          )
      WHERE id = checkout.tenant_id;
    END IF;

    UPDATE public.saas_checkout_intents
    SET status = CASE
          WHEN is_overdue_event THEN 'OVERDUE'
          ELSE 'CANCELLED'
        END,
        asaas_payment_id = coalesce(payment_id, asaas_payment_id),
        invoice_url = coalesce(p_invoice_url, invoice_url),
        bank_slip_url = coalesce(p_bank_slip_url, bank_slip_url),
        due_date = coalesce(p_due_date, due_date),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'lastBillingEvent', event_name,
          'lastBillingEventAt', pg_catalog.now(),
          'accessRevokedAt', pg_catalog.now()
        ),
        updated_at = pg_catalog.now()
    WHERE id = checkout.id;

    RETURN jsonb_build_object(
      'ok', true,
      'action', CASE WHEN is_overdue_event THEN 'SUSPENDED' ELSE 'REVOKED' END,
      'checkout_id', checkout.id,
      'tenant_id', checkout.tenant_id
    );
  END IF;

  IF checkout.tenant_id IS NULL THEN
    RAISE EXCEPTION 'saas_tenant_required_for_renewal'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO selected_plan
  FROM public.saas_plans AS plan
  WHERE plan.id = checkout.plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'saas_plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT *
  INTO existing_invoice
  FROM public.saas_invoices AS invoice
  WHERE invoice.asaas_payment_id = payment_id
  FOR UPDATE;
  invoice_was_paid := FOUND AND upper(coalesce(existing_invoice.status, '')) = 'PAID';

  IF checkout.status = 'CANCELLED'
     AND (NOT FOUND OR invoice_was_paid) THEN
    RAISE EXCEPTION 'saas_checkout_terminal'
      USING ERRCODE = '55000';
  END IF;

  IF FOUND THEN
    UPDATE public.saas_invoices
    SET status = 'PAID',
        paid_at = coalesce(paid_at, p_paid_at, pg_catalog.now())
    WHERE id = existing_invoice.id;

    IF invoice_was_paid THEN
      UPDATE public.saas_checkout_intents
      SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'lastBillingEvent', event_name,
            'lastBillingEventAt', pg_catalog.now(),
            'lastBillingReplayPaymentId', payment_id
          ),
          updated_at = pg_catalog.now()
      WHERE id = checkout.id;

      RETURN jsonb_build_object(
        'ok', true,
        'action', 'REPLAY',
        'checkout_id', checkout.id,
        'tenant_id', checkout.tenant_id
      );
    END IF;

    period_end := existing_invoice.billing_period_end::timestamptz;
  ELSE
    period_anchor := greatest(
      coalesce(
        tenant.current_period_end,
        p_due_date::timestamptz,
        p_paid_at,
        pg_catalog.now()
      ),
      coalesce(p_due_date::timestamptz, p_paid_at, pg_catalog.now())
    );
    period_end := CASE
      WHEN checkout.billing_cycle = 'YEARLY'
        THEN period_anchor + interval '1 year'
      ELSE period_anchor + interval '1 month'
    END;

    INSERT INTO public.saas_invoices (
      tenant_id,
      amount,
      status,
      due_date,
      paid_at,
      asaas_payment_id,
      invoice_number,
      plan_snapshot,
      billing_period_start,
      billing_period_end,
      period_month
    ) VALUES (
      checkout.tenant_id,
      checkout.amount,
      'PAID',
      coalesce(p_due_date::timestamptz, p_paid_at, pg_catalog.now()),
      coalesce(p_paid_at, pg_catalog.now()),
      payment_id,
      'WW-' || to_char(pg_catalog.now(), 'YYYYMM') || '-' || left(md5(payment_id), 8),
      to_jsonb(selected_plan),
      period_anchor::date,
      period_end::date,
      to_char(period_anchor, 'YYYY-MM')
    );
  END IF;

  UPDATE public.tenants
  SET saas_status = 'active',
      current_period_end = greatest(
        coalesce(current_period_end, period_end),
        period_end
      )
  WHERE id = checkout.tenant_id;

  UPDATE public.saas_checkout_intents
  SET status = 'PROVISIONED',
      asaas_payment_id = payment_id,
      invoice_url = coalesce(p_invoice_url, invoice_url),
      bank_slip_url = coalesce(p_bank_slip_url, bank_slip_url),
      due_date = coalesce(p_due_date, due_date),
      paid_at = coalesce(p_paid_at, paid_at, pg_catalog.now()),
      last_error = NULL,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'lastBillingEvent', event_name,
        'lastBillingEventAt', pg_catalog.now(),
        'lastPaidPaymentId', payment_id
      ),
      updated_at = pg_catalog.now()
  WHERE id = checkout.id;

  RETURN jsonb_build_object(
    'ok', true,
    'action', CASE
      WHEN existing_invoice.id IS NULL THEN 'RENEWED'
      ELSE 'RESTORED'
    END,
    'checkout_id', checkout.id,
    'tenant_id', checkout.tenant_id,
    'current_period_end', period_end
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_saas_checkout_billing_event(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_saas_checkout_billing_event(
  uuid, text, text, numeric, text, text, text, text,
  timestamptz, date, text, text
) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'apply_saas_checkout_billing_event'
      AND n.nspname = 'public'
      AND p.proargtypes::text = '2950 25 25 1184 25 1700 25 25 25 25 1184 1082 25 25'
  ) THEN
    DROP FUNCTION public.apply_saas_checkout_billing_event(
      uuid, text, text, timestamptz, text, numeric, text, text, text, text,
      timestamptz, date, text, text
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.apply_saas_checkout_billing_event(
  p_checkout_id uuid,
  p_event_name text,
  p_legacy_provider_event_id text DEFAULT NULL,
  p_legacy_provider_event_at timestamptz DEFAULT NULL,
  p_legacy_payment_id text DEFAULT NULL,
  p_legacy_payment_value numeric DEFAULT NULL,
  p_legacy_billing_type text DEFAULT NULL,
  p_legacy_customer_id text DEFAULT NULL,
  p_legacy_subscription_id text DEFAULT NULL,
  p_legacy_billing_cycle text DEFAULT NULL,
  p_legacy_paid_at timestamptz DEFAULT NULL,
  p_legacy_due_date date DEFAULT NULL,
  p_legacy_invoice_url text DEFAULT NULL,
  p_legacy_bank_slip_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $compat_fn$
DECLARE
  v_payment_id text := coalesce(
    nullif(trim(coalesce(p_legacy_payment_id, '')), ''),
    nullif(trim(coalesce(p_legacy_provider_event_id, '')), '')
  );
  v_paid_at timestamptz :=
    coalesce(p_legacy_paid_at, p_legacy_provider_event_at, pg_catalog.now());
BEGIN
  RETURN public.apply_saas_checkout_billing_event(
    p_checkout_id,
    p_event_name,
    v_payment_id,
    p_legacy_payment_value,
    p_legacy_billing_type,
    p_legacy_customer_id,
    p_legacy_subscription_id,
    p_legacy_billing_cycle,
    v_paid_at,
    p_legacy_due_date,
    p_legacy_invoice_url,
    p_legacy_bank_slip_url
  );
END;
$compat_fn$;

REVOKE ALL ON FUNCTION public.apply_saas_checkout_billing_event(
  uuid, text, text, timestamptz, text, numeric, text, text, text, text, timestamptz,
  date, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_saas_checkout_billing_event(
  uuid, text, text, timestamptz, text, numeric, text, text, text, text, timestamptz,
  date, text, text
) TO service_role;
