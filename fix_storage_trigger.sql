-- FIX TRIGGER FUNCTION enforce_storage_limit
-- The issue is that owner_tenant_id was defined as UUID, but our tenant IDs are TEXT (e.g. 'wise-wolf-school').

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
    SELECT sp.storage_limit_gb INTO limit_gb
    FROM tenants t
    JOIN saas_plans sp ON t.saas_plan_id = sp.id
    WHERE t.id = owner_tenant_id; -- Now comparing text to text (assuming tenants.id is text)

    -- If no plan found (limit_gb is null), assume infinite or default? 
    -- Let's set a default if null to match original logic (or lack thereof)
    -- If null, likely infinite for now to avoid blocking.
    IF limit_gb IS NULL THEN
        limit_gb := 10; -- Default fallback
    END IF;

    limit_bytes := limit_gb * 1024 * 1024 * 1024;

    -- Get Usage (Sum of size in storage.objects for this tenant's users)
    -- This query might be slow for massive dbs, but fine for MVP
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
