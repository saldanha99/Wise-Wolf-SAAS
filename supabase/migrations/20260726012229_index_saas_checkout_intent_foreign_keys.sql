-- PostgreSQL does not create indexes for referencing foreign-key columns.
-- These keep checkout reconciliation, plan joins and tenant cleanup efficient.
CREATE INDEX saas_checkout_intents_plan_idx
  ON public.saas_checkout_intents (plan_id);

CREATE INDEX saas_checkout_intents_lead_idx
  ON public.saas_checkout_intents (lead_id)
  WHERE lead_id IS NOT NULL;

CREATE INDEX saas_checkout_intents_tenant_idx
  ON public.saas_checkout_intents (tenant_id)
  WHERE tenant_id IS NOT NULL;
