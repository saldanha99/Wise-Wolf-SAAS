-- FIX TRIGGER FUNCTION enforce_storage_limit (FINAL)
-- Corrected column name: plan_id
-- Corrected type: owner_tenant_id TEXT

CREATE OR REPLACE FUNCTION public.enforce_storage_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  current_usage_bytes bigint;
  limit_gb numeric;
  limit_bytes bigint;
  owner_tenant_id text; -- CHANGED FROM UUID TO TEXT
BEGIN
  -- Attempt to resolve tenant_id from the owner (user)
  -- This assumes table 'profiles' links auth.users to tenants
  SELECT tenant_id INTO owner_tenant_id
  FROM profiles
  WHERE id = NEW.owner; -- NEW.owner is auth.uid() in storage.objects

  IF (owner_tenant_id IS NOT NULL) THEN
    -- Get Limit
    -- Using LEFT JOIN to avoid crashing if plan doesn't exist
    SELECT sp.storage_limit_gb INTO limit_gb
    FROM tenants t
    LEFT JOIN saas_plans sp ON t.plan_id = sp.id -- CORRECTED COLUMN NAME
    WHERE t.id = owner_tenant_id; 

    -- If no plan found (limit_gb is null), set a generous default for now
    IF limit_gb IS NULL THEN
        limit_gb := 10; -- 10GB Default
    END IF;

    limit_bytes := limit_gb * 1024 * 1024 * 1024;

    -- Get Usage (Sum of size in storage.objects for this tenant's users)
    SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) INTO current_usage_bytes
    FROM storage.objects sobj
    JOIN profiles p ON sobj.owner = p.id
    WHERE p.tenant_id = owner_tenant_id;

    IF (current_usage_bytes + (NEW.metadata->>'size')::bigint > limit_bytes) THEN
        RAISE EXCEPTION 'Limite de armazenamento excedido (Max: % GB). Faça upgrade.', limit_gb;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
