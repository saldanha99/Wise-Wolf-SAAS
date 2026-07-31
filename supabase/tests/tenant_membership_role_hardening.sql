BEGIN;

DO $test$
DECLARE
  candidate_user_id uuid;
  candidate_membership_id uuid;
  hub_user_id uuid;
  super_admin_user_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tenant_memberships
    WHERE role NOT IN (
      'STUDENT',
      'TEACHER',
      'SCHOOL_ADMIN',
      'COORDINATOR',
      'COMMERCIAL',
      'SALESPERSON',
      'NON_STUDENT'
    )
  ) THEN
    RAISE EXCEPTION 'invalid_tenant_membership_role_remains';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.tenant_memberships'::regclass
      AND conname = 'tenant_memberships_role_check'
      AND contype = 'c'
      AND convalidated IS TRUE
  ) THEN
    RAISE EXCEPTION 'tenant_memberships_role_check_missing';
  END IF;

  SELECT membership.user_id, membership.id
  INTO candidate_user_id, candidate_membership_id
  FROM public.tenant_memberships AS membership
  JOIN public.profiles AS profile
    ON profile.id = membership.user_id
  WHERE membership.status = 'ACTIVE'
    AND profile.role IN (
      'STUDENT',
      'TEACHER',
      'SCHOOL_ADMIN',
      'COORDINATOR',
      'COMMERCIAL',
      'SALESPERSON'
    )
  ORDER BY membership.created_at, membership.id
  LIMIT 1;

  IF candidate_user_id IS NULL OR candidate_membership_id IS NULL THEN
    RAISE EXCEPTION 'tenant_membership_test_fixture_missing';
  END IF;

  UPDATE public.tenant_memberships
  SET status = 'SUSPENDED',
      is_primary = false
  WHERE user_id = candidate_user_id;

  IF private.active_tenant_id(candidate_user_id) IS NOT NULL
    OR private.active_tenant_role(candidate_user_id) IS NOT NULL
  THEN
    RAISE EXCEPTION 'suspended_membership_retained_tenant_authority';
  END IF;

  BEGIN
    UPDATE public.tenant_memberships
    SET role = 'SUPER_ADMIN'
    WHERE id = candidate_membership_id;
    RAISE EXCEPTION 'tenant_membership_accepted_super_admin';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  SELECT profile.id
  INTO super_admin_user_id
  FROM public.profiles AS profile
  WHERE profile.role = 'SUPER_ADMIN'
  ORDER BY profile.created_at, profile.id
  LIMIT 1;

  IF super_admin_user_id IS NOT NULL
    AND private.active_tenant_role(super_admin_user_id)
      IS DISTINCT FROM 'SUPER_ADMIN'
  THEN
    RAISE EXCEPTION 'canonical_super_admin_lost_global_authority';
  END IF;

  SELECT profile.id
  INTO hub_user_id
  FROM public.profiles AS profile
  WHERE profile.role = 'NON_STUDENT'
    AND profile.tenant_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.tenant_memberships AS membership
      WHERE membership.user_id = profile.id
        AND membership.status = 'ACTIVE'
    )
  ORDER BY profile.created_at, profile.id
  LIMIT 1;

  IF hub_user_id IS NOT NULL
    AND (
      private.active_tenant_id(hub_user_id) IS NOT NULL
      OR private.active_tenant_role(hub_user_id)
        IS DISTINCT FROM 'NON_STUDENT'
    )
  THEN
    RAISE EXCEPTION 'tenantless_hub_access_was_not_preserved';
  END IF;
END
$test$;

ROLLBACK;
