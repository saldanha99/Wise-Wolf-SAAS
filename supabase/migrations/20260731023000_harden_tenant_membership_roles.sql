-- A tenant membership is school-scoped authority. Global SUPER_ADMIN access
-- may only come from the canonical profiles row.

DO $guard$
BEGIN
  IF to_regclass('public.tenant_memberships') IS NULL
  THEN
    RAISE EXCEPTION 'tenant_membership_foundation_is_required';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.tenant_user_contexts (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_user_contexts_tenant_idx
  ON public.tenant_user_contexts (tenant_id);
ALTER TABLE public.tenant_user_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_user_contexts
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tenant_user_contexts TO service_role;

INSERT INTO public.tenant_user_contexts (user_id, tenant_id)
SELECT membership.user_id, membership.tenant_id
FROM public.tenant_memberships AS membership
WHERE membership.status = 'ACTIVE'
  AND membership.is_primary IS TRUE
ON CONFLICT (user_id) DO NOTHING;

UPDATE public.tenant_memberships AS membership
SET role = CASE
      WHEN profile.role IN (
        'STUDENT',
        'TEACHER',
        'SCHOOL_ADMIN',
        'COORDINATOR',
        'COMMERCIAL',
        'SALESPERSON',
        'NON_STUDENT'
      )
      THEN profile.role
      ELSE 'SCHOOL_ADMIN'
    END,
    updated_at = now()
FROM public.profiles AS profile
WHERE profile.id = membership.user_id
  AND membership.role NOT IN (
    'STUDENT',
    'TEACHER',
    'SCHOOL_ADMIN',
    'COORDINATOR',
    'COMMERCIAL',
    'SALESPERSON',
    'NON_STUDENT'
  );

ALTER TABLE public.tenant_memberships
  DROP CONSTRAINT IF EXISTS tenant_memberships_role_check;
ALTER TABLE public.tenant_memberships
  ADD CONSTRAINT tenant_memberships_role_check
  CHECK (role IN (
    'STUDENT',
    'TEACHER',
    'SCHOOL_ADMIN',
    'COORDINATOR',
    'COMMERCIAL',
    'SALESPERSON',
    'NON_STUDENT'
  ));

CREATE OR REPLACE FUNCTION private.active_tenant_id(
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN profile.role = 'SUPER_ADMIN' THEN COALESCE(
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
        ORDER BY
          membership.is_primary DESC,
          membership.created_at,
          membership.id
        LIMIT 1
      ),
      profile.tenant_id
    )
    ELSE COALESCE(
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
        ORDER BY
          membership.is_primary DESC,
          membership.created_at,
          membership.id
        LIMIT 1
      )
    )
  END
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id;
$function$;
REVOKE ALL ON FUNCTION private.active_tenant_id(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.active_tenant_id(uuid)
  TO postgres, supabase_admin, service_role;

CREATE OR REPLACE FUNCTION private.active_tenant_role(
  p_user_id uuid DEFAULT auth.uid()
)
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
      CASE
        WHEN profile.role = 'NON_STUDENT'
          AND profile.tenant_id IS NULL
        THEN 'NON_STUDENT'
        ELSE NULL
      END
    )
  END
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id;
$function$;
REVOKE ALL ON FUNCTION private.active_tenant_role(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.active_tenant_role(uuid)
  TO postgres, supabase_admin, service_role;

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

CREATE OR REPLACE FUNCTION private.sync_primary_tenant_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  membership_role text;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  membership_role := CASE
    WHEN NEW.role = 'SUPER_ADMIN' THEN 'SCHOOL_ADMIN'
    ELSE NEW.role
  END;

  INSERT INTO public.tenant_memberships (
    user_id,
    tenant_id,
    role,
    status,
    is_primary
  )
  VALUES (
    NEW.id,
    NEW.tenant_id,
    membership_role,
    'ACTIVE',
    true
  )
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
