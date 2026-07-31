-- School multitenancy foundation.
-- profiles.tenant_id remains the primary/legacy tenant during the transition;
-- this membership table is the forward-compatible source for users who work
-- with more than one school.

CREATE TABLE public.tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
  is_primary boolean NOT NULL DEFAULT false,
  invited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

CREATE INDEX tenant_memberships_tenant_role_idx
  ON public.tenant_memberships (tenant_id, role)
  WHERE status = 'ACTIVE';
CREATE INDEX tenant_memberships_user_status_idx
  ON public.tenant_memberships (user_id, status);
CREATE UNIQUE INDEX tenant_memberships_one_primary_per_user_idx
  ON public.tenant_memberships (user_id)
  WHERE is_primary IS TRUE AND status = 'ACTIVE';

ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_memberships FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_memberships TO authenticated;
GRANT ALL ON TABLE public.tenant_memberships TO service_role;

CREATE POLICY tenant_memberships_read_scoped
ON public.tenant_memberships FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() = 'SCHOOL_ADMIN'
  )
);

CREATE POLICY tenant_memberships_admin_insert
ON public.tenant_memberships FOR INSERT TO authenticated
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() = 'SCHOOL_ADMIN'
  )
);

CREATE POLICY tenant_memberships_admin_update
ON public.tenant_memberships FOR UPDATE TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() = 'SCHOOL_ADMIN'
  )
)
WITH CHECK (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() = 'SCHOOL_ADMIN'
  )
);

CREATE POLICY tenant_memberships_admin_delete
ON public.tenant_memberships FOR DELETE TO authenticated
USING (
  public._my_role() = 'SUPER_ADMIN'
  OR (
    tenant_id = public._my_tenant_id()
    AND public._my_role() = 'SCHOOL_ADMIN'
  )
);

GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.has_tenant_membership(
  p_tenant_id text,
  p_roles text[] DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.user_id = (SELECT auth.uid())
      AND membership.tenant_id = p_tenant_id
      AND membership.status = 'ACTIVE'
      AND (p_roles IS NULL OR membership.role = ANY (p_roles))
  );
$function$;
REVOKE ALL ON FUNCTION private.has_tenant_membership(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.has_tenant_membership(text, text[])
  TO authenticated, service_role;

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
      AND is_primary IS TRUE;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.set_single_primary_tenant_membership()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_single_primary_tenant_membership
  ON public.tenant_memberships;
CREATE TRIGGER enforce_single_primary_tenant_membership
BEFORE INSERT OR UPDATE ON public.tenant_memberships
FOR EACH ROW EXECUTE FUNCTION private.set_single_primary_tenant_membership();

INSERT INTO public.tenant_memberships (
  user_id,
  tenant_id,
  role,
  status,
  is_primary,
  created_at,
  updated_at
)
SELECT
  profile.id,
  profile.tenant_id,
  profile.role,
  'ACTIVE',
  true,
  COALESCE(profile.created_at, now()),
  now()
FROM public.profiles AS profile
WHERE profile.tenant_id IS NOT NULL
ON CONFLICT (user_id, tenant_id) DO UPDATE
SET role = EXCLUDED.role,
    status = 'ACTIVE',
    is_primary = true,
    updated_at = now();

CREATE OR REPLACE FUNCTION private.sync_primary_tenant_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.tenant_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.tenant_memberships (
    user_id, tenant_id, role, status, is_primary
  )
  VALUES (NEW.id, NEW.tenant_id, NEW.role, 'ACTIVE', true)
  ON CONFLICT (user_id, tenant_id) DO UPDATE
  SET role = EXCLUDED.role,
      status = 'ACTIVE',
      is_primary = true,
      updated_at = now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.sync_primary_tenant_membership()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS sync_profile_primary_tenant_membership
  ON public.profiles;
CREATE TRIGGER sync_profile_primary_tenant_membership
AFTER INSERT OR UPDATE OF tenant_id, role ON public.profiles
FOR EACH ROW
WHEN (NEW.tenant_id IS NOT NULL)
EXECUTE FUNCTION private.sync_primary_tenant_membership();
