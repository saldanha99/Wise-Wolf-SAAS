-- Ensure legacy DB schemas with the old 14-argument function can still satisfy
-- the 12-argument contract used by current SaaS checkout billing tests.
-- This is intentionally transitional and keeps behavior delegated to the
-- existing function implementation.

DO $$
DECLARE
  v_has_legacy_14 boolean;
  v_has_legacy_14_name boolean;
  v_has_compat_12 boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'apply_saas_checkout_billing_event'
      AND n.nspname = 'public'
      AND p.proargtypes::text = '2950 25 25 1184 25 1700 25 25 25 25 1184 1082 25 25'::text
  )
  INTO v_has_legacy_14;

  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'apply_saas_checkout_billing_event'
      AND n.nspname = 'public'
      AND p.proargtypes::text = '2283 25 25 1184 25 1700 25 25 25 25 1184 1082 25 25'::text
  )
  INTO v_has_legacy_14_name;

  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'apply_saas_checkout_billing_event'
      AND n.nspname = 'public'
      AND p.proargtypes::text = '2950 25 25 1700 25 25 25 25 1184 1082 25 25'::text
  )
  INTO v_has_compat_12;

  IF (v_has_legacy_14 OR v_has_legacy_14_name) AND NOT v_has_compat_12 THEN
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
    AS $compat_fn$
    DECLARE
      v_result jsonb;
      v_provider_event_at timestamptz := coalesce(p_paid_at, now());
      v_provider_event_id text := coalesce(
        nullif(trim(coalesce(p_payment_id, '')), ''),
        nullif(trim(coalesce(p_subscription_id, '')), ''),
        format(
          'compat:%s:%s:%s',
          coalesce(lower(trim(p_event_name)), 'event'),
          p_checkout_id::text,
          coalesce(p_due_date::text, 'nodate')
        )
      );
    BEGIN
      SELECT public.apply_saas_checkout_billing_event(
        p_checkout_id,
        p_event_name,
        v_provider_event_id,
        v_provider_event_at,
        p_payment_id,
        p_payment_value,
        p_billing_type,
        p_customer_id,
        p_subscription_id,
        p_billing_cycle,
        p_paid_at,
        p_due_date,
        p_invoice_url,
        p_bank_slip_url
      )
      INTO v_result;

      RETURN v_result;
    END;
    $compat_fn$;

    REVOKE ALL ON FUNCTION public.apply_saas_checkout_billing_event(
      uuid,
      text,
      text,
      numeric,
      text,
      text,
      text,
      text,
      timestamptz,
      date,
      text,
      text
    ) FROM PUBLIC, anon, authenticated;

    GRANT EXECUTE ON FUNCTION public.apply_saas_checkout_billing_event(
      uuid,
      text,
      text,
      numeric,
      text,
      text,
      text,
      text,
      timestamptz,
      date,
      text,
      text
    ) TO service_role;
  END IF;
END
$$;
