-- ENFORCE SAAS LIMITS
-- This script creates triggers and functions to enforce SaaS plan limits.

-- 1. Helper function to get Tenant's Current Plan Limits
CREATE OR REPLACE FUNCTION get_tenant_plan_limits(target_tenant_id uuid)
RETURNS TABLE (
  storage_limit_gb numeric,
  max_students integer,
  max_users integer
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    sp.storage_limit_gb, 
    sp.max_students, 
    sp.max_users
  FROM tenants t
  JOIN saas_plans sp ON t.saas_plan_id = sp.id
  WHERE t.id = target_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Enforce Student Limit
-- Trigger on 'profiles' table (assuming students are profiles with role 'student')
CREATE OR REPLACE FUNCTION enforce_student_limit()
RETURNS TRIGGER AS $$
DECLARE
  current_count integer;
  limit_count integer;
  tenant_plan_id uuid;
BEGIN
  -- Only check on INSERT of a new student
  IF (NEW.role = 'student') THEN
    -- Get limit
    SELECT max_students INTO limit_count
    FROM tenants t
    JOIN saas_plans sp ON t.saas_plan_id = sp.id
    WHERE t.id = NEW.tenant_id;

    -- Get current count
    SELECT count(*) INTO current_count
    FROM profiles
    WHERE tenant_id = NEW.tenant_id AND role = 'student';

    -- Check
    IF (current_count >= limit_count) THEN
      RAISE EXCEPTION 'Limite de alunos atingido para o plano atual (Max: %). Faça upgrade para adicionar mais.', limit_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply Trigger
DROP TRIGGER IF EXISTS check_student_limit ON profiles;
CREATE TRIGGER check_student_limit
BEFORE INSERT ON profiles
FOR EACH ROW
EXECUTE FUNCTION enforce_student_limit();


-- 3. Enforce Storage Limit (Generalized via Policy or Trigger on storage.objects)
-- Note: Supabase Storage triggers are tricky as they are in 'storage' schema. 
-- We typically need to add this trigger on the storage.objects table.

CREATE OR REPLACE FUNCTION enforce_storage_limit()
RETURNS TRIGGER AS $$
DECLARE
  current_usage_bytes bigint;
  limit_gb numeric;
  limit_bytes bigint;
  owner_tenant_id uuid;
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
    WHERE t.id = owner_tenant_id;

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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger on storage.objects
-- Note: You might need superuser privs to add triggers to storage schema.
-- If this fails, user might need to run as postgres user or skip storage enforcement for now.
DROP TRIGGER IF EXISTS check_storage_limit ON storage.objects;
CREATE TRIGGER check_storage_limit
BEFORE INSERT ON storage.objects
FOR EACH ROW
EXECUTE FUNCTION enforce_storage_limit();
