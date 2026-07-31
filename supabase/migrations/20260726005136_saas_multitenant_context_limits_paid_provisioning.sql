-- Multi-school active context, plan seat enforcement and paid SaaS provisioning.
-- The legacy profiles.tenant_id / profiles.role pair remains the primary
-- membership, while the active context becomes the authorization source.

CREATE TABLE public.tenant_user_contexts (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_user_contexts_tenant_idx
  ON public.tenant_user_contexts (tenant_id);

ALTER TABLE public.tenant_user_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_user_contexts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tenant_user_contexts TO service_role;

INSERT INTO public.tenant_user_contexts (user_id, tenant_id)
SELECT membership.user_id, membership.tenant_id
FROM public.tenant_memberships AS membership
WHERE membership.status = 'ACTIVE'
  AND membership.is_primary IS TRUE
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION private.active_tenant_id(p_user_id uuid DEFAULT auth.uid())
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    (
      SELECT context.tenant_id
      FROM public.tenant_user_contexts AS context
      JOIN public.tenant_memberships AS membership
        ON membership.user_id = context.user_id
       AND membership.tenant_id = context.tenant_id
       AND membership.status = 'ACTIVE'
      WHERE context.user_id = p_user_id
      LIMIT 1
    ),
    (
      SELECT membership.tenant_id
      FROM public.tenant_memberships AS membership
      WHERE membership.user_id = p_user_id
        AND membership.status = 'ACTIVE'
      ORDER BY membership.is_primary DESC, membership.created_at, membership.id
      LIMIT 1
    ),
    (
      SELECT profile.tenant_id
      FROM public.profiles AS profile
      WHERE profile.id = p_user_id
    )
  );
$function$;
REVOKE ALL ON FUNCTION private.active_tenant_id(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.active_tenant_id(uuid)
  TO postgres, supabase_admin, service_role;

CREATE OR REPLACE FUNCTION private.active_tenant_role(p_user_id uuid DEFAULT auth.uid())
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN profile.role = 'SUPER_ADMIN' THEN 'SUPER_ADMIN'
    ELSE COALESCE(
      (
        SELECT membership.role
        FROM public.tenant_memberships AS membership
        WHERE membership.user_id = p_user_id
          AND membership.tenant_id = private.active_tenant_id(p_user_id)
          AND membership.status = 'ACTIVE'
        LIMIT 1
      ),
      profile.role
    )
  END
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id;
$function$;
REVOKE ALL ON FUNCTION private.active_tenant_role(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.active_tenant_role(uuid)
  TO postgres, supabase_admin, service_role;

CREATE OR REPLACE FUNCTION public._my_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT private.active_tenant_id((SELECT auth.uid()));
$function$;
REVOKE ALL ON FUNCTION public._my_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._my_tenant_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT private.active_tenant_role((SELECT auth.uid()));
$function$;
REVOKE ALL ON FUNCTION public._my_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._my_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_my_access_context()
RETURNS TABLE (tenant_id text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    private.active_tenant_id((SELECT auth.uid())),
    private.active_tenant_role((SELECT auth.uid()))
  WHERE (SELECT auth.uid()) IS NOT NULL;
$function$;
REVOKE ALL ON FUNCTION public.get_my_access_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_access_context() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_tenant_memberships()
RETURNS TABLE (
  tenant_id text,
  tenant_name text,
  domain text,
  branding jsonb,
  role text,
  is_primary boolean,
  is_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    tenant.id,
    tenant.name,
    tenant.domain,
    tenant.branding,
    membership.role,
    membership.is_primary,
    tenant.id = private.active_tenant_id((SELECT auth.uid()))
  FROM public.tenant_memberships AS membership
  JOIN public.tenants AS tenant ON tenant.id = membership.tenant_id
  WHERE membership.user_id = (SELECT auth.uid())
    AND membership.status = 'ACTIVE'
  ORDER BY
    (tenant.id = private.active_tenant_id((SELECT auth.uid()))) DESC,
    membership.is_primary DESC,
    tenant.name,
    tenant.id;
$function$;
REVOKE ALL ON FUNCTION public.get_my_tenant_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_tenant_memberships() TO authenticated;

CREATE OR REPLACE FUNCTION public.switch_my_tenant(p_tenant_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  selected_role text;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
  END IF;

  SELECT membership.role
  INTO selected_role
  FROM public.tenant_memberships AS membership
  WHERE membership.user_id = caller_id
    AND membership.tenant_id = p_tenant_id
    AND membership.status = 'ACTIVE';

  IF selected_role IS NULL THEN
    RAISE EXCEPTION 'tenant_membership_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.tenant_user_contexts (user_id, tenant_id)
  VALUES (caller_id, p_tenant_id)
  ON CONFLICT (user_id) DO UPDATE
  SET tenant_id = EXCLUDED.tenant_id,
      updated_at = now();

  RETURN jsonb_build_object(
    'ok', true,
    'tenant_id', p_tenant_id,
    'role', selected_role
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.switch_my_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_my_tenant(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_tenant_config()
RETURNS TABLE (
  id text,
  name text,
  domain text,
  branding jsonb,
  student_limit integer,
  teacher_limit integer,
  whatsapp_enabled boolean,
  school_info jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    tenant.id,
    tenant.name,
    tenant.domain,
    tenant.branding,
    tenant.student_limit,
    tenant.teacher_limit,
    tenant.whatsapp_enabled,
    tenant.school_info
  FROM public.tenants AS tenant
  WHERE tenant.id = private.active_tenant_id((SELECT auth.uid()))
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.get_my_tenant_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_tenant_config() TO authenticated;

-- Seat limits are enforced on the membership source of truth. An advisory
-- transaction lock serializes simultaneous invitations for the same role.
CREATE OR REPLACE FUNCTION private.enforce_tenant_membership_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  seat_limit integer;
  seats_in_use integer;
  limit_code text;
BEGIN
  IF NEW.status <> 'ACTIVE' OR NEW.role NOT IN ('STUDENT', 'TEACHER') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('tenant-seat:' || NEW.tenant_id || ':' || NEW.role, 0)
  );

  SELECT CASE
    WHEN NEW.role = 'STUDENT' THEN tenant.student_limit
    ELSE tenant.teacher_limit
  END
  INTO seat_limit
  FROM public.tenants AS tenant
  WHERE tenant.id = NEW.tenant_id;

  -- NULL and non-positive values keep compatibility with legacy "unlimited".
  IF seat_limit IS NULL OR seat_limit <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
  INTO seats_in_use
  FROM public.tenant_memberships AS membership
  WHERE membership.tenant_id = NEW.tenant_id
    AND membership.role = NEW.role
    AND membership.status = 'ACTIVE'
    AND membership.id <> NEW.id;

  IF seats_in_use >= seat_limit THEN
    limit_code := CASE
      WHEN NEW.role = 'STUDENT' THEN 'tenant_student_limit_reached'
      ELSE 'tenant_teacher_limit_reached'
    END;
    RAISE EXCEPTION '%', limit_code
      USING
        ERRCODE = 'P0001',
        DETAIL = format(
          'tenant_id=%s role=%s limit=%s',
          NEW.tenant_id,
          NEW.role,
          seat_limit
        );
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.enforce_tenant_membership_limit()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_tenant_membership_limit
  ON public.tenant_memberships;
CREATE TRIGGER enforce_tenant_membership_limit
BEFORE INSERT OR UPDATE OF tenant_id, role, status
ON public.tenant_memberships
FOR EACH ROW EXECUTE FUNCTION private.enforce_tenant_membership_limit();

CREATE OR REPLACE FUNCTION private.apply_tenant_plan_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  selected_plan public.saas_plans%ROWTYPE;
BEGIN
  IF NEW.plan_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO selected_plan
  FROM public.saas_plans AS plan
  WHERE plan.id = NEW.plan_id
    AND plan.active IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_saas_plan_required' USING ERRCODE = '23503';
  END IF;

  NEW.student_limit := selected_plan.max_students;
  NEW.teacher_limit := COALESCE(selected_plan.max_teachers, selected_plan.max_users);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.apply_tenant_plan_limits()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS apply_tenant_plan_limits ON public.tenants;
CREATE TRIGGER apply_tenant_plan_limits
BEFORE INSERT OR UPDATE OF plan_id ON public.tenants
FOR EACH ROW EXECUTE FUNCTION private.apply_tenant_plan_limits();

-- Public-schema storage is deny-by-default and service-only. Keeping the
-- intent in one durable row makes retries idempotent without storing card data.
CREATE TABLE public.saas_checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'PROVISIONING',
      'PROVISIONING_FAILED',
      'PROVISIONED',
      'CANCELLED',
      'OVERDUE'
    )),
  school_name text NOT NULL,
  tenant_slug text NOT NULL UNIQUE,
  owner_name text NOT NULL,
  owner_email text NOT NULL,
  owner_phone text,
  owner_cpf_cnpj text NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.saas_plans(id),
  billing_cycle text NOT NULL
    CHECK (billing_cycle IN ('MONTHLY', 'YEARLY')),
  billing_type text NOT NULL
    CHECK (billing_type IN ('PIX', 'BOLETO', 'CREDIT_CARD')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  lead_id uuid REFERENCES public.saas_leads(id) ON DELETE SET NULL,
  tenant_id text REFERENCES public.tenants(id) ON DELETE SET NULL,
  asaas_customer_id text,
  asaas_subscription_id text,
  asaas_payment_id text,
  invoice_url text,
  bank_slip_url text,
  pix_payload text,
  pix_encoded_image text,
  due_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  paid_at timestamptz,
  provisioned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX saas_checkout_intents_subscription_uidx
  ON public.saas_checkout_intents (asaas_subscription_id)
  WHERE asaas_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX saas_checkout_intents_payment_uidx
  ON public.saas_checkout_intents (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;
CREATE INDEX saas_checkout_intents_status_created_idx
  ON public.saas_checkout_intents (status, created_at);
CREATE INDEX saas_checkout_intents_owner_email_idx
  ON public.saas_checkout_intents (lower(owner_email));

ALTER TABLE public.saas_checkout_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.saas_checkout_intents FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.saas_checkout_intents TO service_role;

CREATE TABLE public.saas_checkout_rate_limits (
  rate_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.saas_checkout_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.saas_checkout_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.saas_checkout_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.consume_saas_checkout_rate_limit(
  p_rate_key text,
  p_max_requests integer DEFAULT 5,
  p_window interval DEFAULT interval '1 hour'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_row public.saas_checkout_rate_limits%ROWTYPE;
BEGIN
  IF nullif(trim(p_rate_key), '') IS NULL
     OR p_max_requests < 1
     OR p_window <= interval '0 seconds' THEN
    RETURN false;
  END IF;

  INSERT INTO public.saas_checkout_rate_limits (rate_key)
  VALUES (p_rate_key)
  ON CONFLICT (rate_key) DO NOTHING;

  SELECT *
  INTO current_row
  FROM public.saas_checkout_rate_limits
  WHERE rate_key = p_rate_key
  FOR UPDATE;

  IF current_row.window_started_at + p_window <= now() THEN
    UPDATE public.saas_checkout_rate_limits
    SET window_started_at = now(),
        request_count = 1,
        updated_at = now()
    WHERE rate_key = p_rate_key;
    RETURN true;
  END IF;

  IF current_row.request_count >= p_max_requests THEN
    RETURN false;
  END IF;

  UPDATE public.saas_checkout_rate_limits
  SET request_count = request_count + 1,
      updated_at = now()
  WHERE rate_key = p_rate_key;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.consume_saas_checkout_rate_limit(text, integer, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_saas_checkout_rate_limit(text, integer, interval)
  TO service_role;

-- Bring the legacy invoice table up to the fields already expected by the SaaS
-- checkout code, while keeping every new column nullable for old records.
ALTER TABLE public.saas_invoices
  ADD COLUMN IF NOT EXISTS asaas_payment_id text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS billing_period_start date,
  ADD COLUMN IF NOT EXISTS billing_period_end date;

CREATE UNIQUE INDEX IF NOT EXISTS saas_invoices_asaas_payment_uidx
  ON public.saas_invoices (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS saas_invoices_tenant_idx
  ON public.saas_invoices (tenant_id);

CREATE OR REPLACE FUNCTION public.provision_paid_saas_checkout(
  p_checkout_id uuid,
  p_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  checkout public.saas_checkout_intents%ROWTYPE;
  selected_plan public.saas_plans%ROWTYPE;
  provisioned_tenant_id text;
  period_end timestamptz;
BEGIN
  SELECT *
  INTO checkout
  FROM public.saas_checkout_intents
  WHERE id = p_checkout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'saas_checkout_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF checkout.asaas_payment_id IS NOT NULL
     AND nullif(p_payment_id, '') IS NOT NULL
     AND checkout.asaas_payment_id <> p_payment_id THEN
    RAISE EXCEPTION 'saas_checkout_payment_mismatch' USING ERRCODE = '42501';
  END IF;

  IF checkout.status = 'PROVISIONED' AND checkout.tenant_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_provisioned', true,
      'checkout_id', checkout.id,
      'tenant_id', checkout.tenant_id,
      'owner_name', checkout.owner_name,
      'owner_email', checkout.owner_email
    );
  END IF;

  IF checkout.status NOT IN (
    'PAID',
    'PROVISIONING',
    'PROVISIONING_FAILED'
  ) THEN
    RAISE EXCEPTION 'saas_checkout_payment_not_confirmed'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO selected_plan
  FROM public.saas_plans AS plan
  WHERE plan.id = checkout.plan_id
    AND plan.active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_saas_plan_required' USING ERRCODE = '55000';
  END IF;

  UPDATE public.saas_checkout_intents
  SET status = 'PROVISIONING',
      asaas_payment_id = COALESCE(nullif(p_payment_id, ''), asaas_payment_id),
      last_error = NULL,
      updated_at = now()
  WHERE id = checkout.id;

  provisioned_tenant_id := COALESCE(checkout.tenant_id, checkout.tenant_slug);
  period_end := CASE
    WHEN checkout.billing_cycle = 'YEARLY' THEN now() + interval '1 year'
    ELSE now() + interval '1 month'
  END;

  IF checkout.tenant_id IS NULL THEN
    INSERT INTO public.tenants (
      id,
      name,
      slug,
      owner_email,
      owner_phone,
      owner_cpf_cnpj,
      saas_status,
      plan_id,
      current_period_end,
      branding,
      tenant_type
    )
    VALUES (
      provisioned_tenant_id,
      checkout.school_name,
      checkout.tenant_slug,
      checkout.owner_email,
      checkout.owner_phone,
      checkout.owner_cpf_cnpj,
      'active',
      selected_plan.id,
      period_end,
      jsonb_build_object(
        'primaryColor', '#081a33',
        'secondaryColor', '#d5a94e'
      ),
      selected_plan.plan_type
    );
  END IF;

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
  )
  VALUES (
    provisioned_tenant_id,
    checkout.amount,
    'PAID',
    COALESCE(checkout.due_date::timestamptz, now()),
    COALESCE(checkout.paid_at, now()),
    COALESCE(nullif(p_payment_id, ''), checkout.asaas_payment_id),
    'WW-' || to_char(now(), 'YYYYMM') || '-' || left(checkout.id::text, 8),
    to_jsonb(selected_plan),
    current_date,
    period_end::date,
    to_char(current_date, 'YYYY-MM')
  )
  ON CONFLICT (asaas_payment_id) WHERE asaas_payment_id IS NOT NULL
  DO UPDATE SET
    status = 'PAID',
    paid_at = COALESCE(public.saas_invoices.paid_at, EXCLUDED.paid_at),
    tenant_id = EXCLUDED.tenant_id;

  IF checkout.lead_id IS NOT NULL THEN
    UPDATE public.saas_leads
    SET status = 'CONVERTED',
        converted_tenant_id = provisioned_tenant_id,
        updated_at = now()
    WHERE id = checkout.lead_id;
  END IF;

  UPDATE public.saas_checkout_intents
  SET tenant_id = provisioned_tenant_id,
      paid_at = COALESCE(paid_at, now()),
      updated_at = now()
  WHERE id = checkout.id;

  RETURN jsonb_build_object(
    'ok', true,
    'already_provisioned', false,
    'checkout_id', checkout.id,
    'tenant_id', provisioned_tenant_id,
    'owner_name', checkout.owner_name,
    'owner_email', checkout.owner_email
  );
EXCEPTION
  WHEN OTHERS THEN
    IF checkout.id IS NOT NULL THEN
      UPDATE public.saas_checkout_intents
      SET status = 'PROVISIONING_FAILED',
          last_error = left(SQLERRM, 500),
          updated_at = now()
      WHERE id = checkout.id;
    END IF;
    RAISE;
END;
$function$;
REVOKE ALL ON FUNCTION public.provision_paid_saas_checkout(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_paid_saas_checkout(uuid, text)
  TO service_role;
