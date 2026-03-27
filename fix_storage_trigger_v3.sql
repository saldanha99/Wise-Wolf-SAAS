-- FIX TRIGGER FUNCTION enforce_storage_limit (V3 - JSONB & TEXT FIX)
-- 1. Uses TEXT for owner_tenant_id (Fixes 'wise-wolf-school' uuid error)
-- 2. Uses 'plan_id' column for join (Fixes 'saas_plan_id' error)
-- 3. Reads storage limit from 'features' JSONB column (Fixes 'storage_limit_gb' error)
-- 4. Defaults to 10GB if plan or limit is missing (Safety net)

CREATE OR REPLACE FUNCTION public.enforce_storage_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  current_usage_bytes bigint;
  limit_gb numeric;
  limit_bytes bigint;
  owner_tenant_id text;
BEGIN
  -- 1. Resolve tenant_id (TEXT)
  SELECT tenant_id INTO owner_tenant_id
  FROM profiles
  WHERE id = NEW.owner; 

  IF (owner_tenant_id IS NOT NULL) THEN
    -- 2. Get Limit from JSONB or Default
    -- We try to find 'storage_limit' inside the 'features' JSON column.
    SELECT COALESCE((sp.features->>'storage_limit')::numeric, 10) INTO limit_gb
    FROM tenants t
    LEFT JOIN saas_plans sp ON t.plan_id = sp.id
    WHERE t.id = owner_tenant_id;

    -- Double safety: if join fails entirely, limit_gb is null
    IF limit_gb IS NULL THEN
        limit_gb := 10;
    END IF;

    limit_bytes := limit_gb * 1024 * 1024 * 1024;

    -- 3. Check Usage
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
