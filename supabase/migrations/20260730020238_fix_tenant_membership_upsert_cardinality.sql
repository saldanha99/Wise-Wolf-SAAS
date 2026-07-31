-- A profile update that repeats role/tenant_id calls
-- sync_primary_tenant_membership(), which performs an INSERT ... ON CONFLICT.
-- The BEFORE INSERT trigger below used to demote the already-existing row for
-- the same (user_id, tenant_id) before ON CONFLICT could update it. PostgreSQL
-- then rejected the command because that target row had been affected twice.
--
-- Excluding the conflict target keeps the intended behavior:
-- - a genuinely different tenant becomes primary and demotes the previous one;
-- - an idempotent upsert of the current tenant updates that same membership.
CREATE OR REPLACE FUNCTION private.set_single_primary_tenant_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();

  IF NEW.is_primary IS TRUE AND NEW.status = 'ACTIVE' THEN
    UPDATE public.tenant_memberships
       SET is_primary = false,
           updated_at = now()
     WHERE user_id = NEW.user_id
       AND id <> NEW.id
       AND tenant_id IS DISTINCT FROM NEW.tenant_id
       AND is_primary IS TRUE;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.set_single_primary_tenant_membership()
  FROM PUBLIC, anon, authenticated;
