-- Migration: Setup Phase 1 RLS (Tenant Isolation & RBAC)
-- Created: 2026-02-17
-- Description: Implements strict Row-Level Security, Multi-Tenant isolation, and Role-Based Access Control.

-- 1. Helper Function: get_current_tenant_id()
-- Returns the tenant_id of the currently logged-in user by looking up their profile.
-- This is cleaner and more secure than trusting JWT metadata strictly.
CREATE OR REPLACE FUNCTION public.get_current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id 
  FROM profiles 
  WHERE id = auth.uid();
$$;

-- 2. Data Integrity & Constraints
-- 2.1. Backfill null tenant_ids to prevent errors (Defaulting to 'wise-wolf-school')
UPDATE public.profiles
SET tenant_id = 'wise-wolf-school'
WHERE tenant_id IS NULL;

-- 2.2. Enforce NOT NULL on tenant_id
ALTER TABLE public.profiles 
ALTER COLUMN tenant_id SET NOT NULL;

-- 2.3. Create Performance Index for RLS lookups
CREATE INDEX IF NOT EXISTS idx_profiles_tenant_role 
ON public.profiles(tenant_id, role);

CREATE INDEX IF NOT EXISTS idx_profiles_professor 
ON public.profiles(professor_id);

-- 3. RLS Implementation
-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Reset existing policies to avoid conflicts
DROP POLICY IF EXISTS "Enable read access for all users" ON public.profiles;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.profiles;
DROP POLICY IF EXISTS "Enable update for users based on email" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "SCHOOL_ADMIN: Manage entire tenant" ON public.profiles;
DROP POLICY IF EXISTS "TEACHER: View self and students" ON public.profiles;
DROP POLICY IF EXISTS "STUDENT: View self" ON public.profiles;

-- 3.1. SCHOOL_ADMIN Policy (Power User within Tenant)
-- Can SELECT, INSERT, UPDATE, DELETE anyone in their own tenant.
CREATE POLICY "SCHOOL_ADMIN: Manage entire tenant"
ON public.profiles
FOR ALL
TO authenticated
USING (
  tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()) 
  AND 
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
);

-- 3.2. TEACHER Policy (Escoped View)
-- SELECT: Self + Assigned Students
CREATE POLICY "TEACHER: View self and assigned students"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  -- Schema 1: View Self
  id = auth.uid()
  OR
  -- Schema 2: View Assigned Students
  (
    tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()) -- Same Tenant
    AND
    professor_id = auth.uid() -- Assigned to this teacher
  )
);

-- UPDATE: Self Only (Teachers cannot edit student profiles, only Directors can)
CREATE POLICY "TEACHER: Update self"
ON public.profiles
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- 3.3. STUDENT Policy (Self View Only)
-- SELECT: Self Only
CREATE POLICY "STUDENT: View self"
ON public.profiles
FOR SELECT
TO authenticated
USING (id = auth.uid());

-- UPDATE: Self Only (e.g. avatar, phone)
CREATE POLICY "STUDENT: Update self"
ON public.profiles
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- 4. SUPER_ADMIN Bypass (Optional, if using service_role this isn't needed, but good for app-level admins)
CREATE POLICY "SUPER_ADMIN: Bypass RLS"
ON public.profiles
FOR ALL
TO authenticated
USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'SUPER_ADMIN')
);
