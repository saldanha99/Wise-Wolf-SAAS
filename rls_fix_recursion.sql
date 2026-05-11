
-- FIX RLS RECURSION AND RESTORE LOGIN ACCESS

-- 1. Create Security Definer functions to break recursion
-- These functions bypass RLS to get the context of the logged-in user
CREATE OR REPLACE FUNCTION get_auth_tenant_id()
RETURNS text AS $$
    SELECT tenant_id FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_auth_role()
RETURNS text AS $$
    SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER;

-- 2. Profiles Table: Hardened without recursion
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Profiles: Manage Own" ON public.profiles;
DROP POLICY IF EXISTS "Profiles: Staff view tenant students" ON public.profiles;
DROP POLICY IF EXISTS "Profiles: Admin full access" ON public.profiles;

-- Anyone can see and update their own profile (Critical for Login)
CREATE POLICY "Profiles: Self access" ON public.profiles
    FOR ALL USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- Staff can see other profiles within their tenant
CREATE POLICY "Profiles: Tenant isolation" ON public.profiles
    FOR SELECT USING (
        tenant_id = get_auth_tenant_id()
    );

-- 3. Bookings Table: Hardened
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Bookings: Admin full access" ON public.bookings;
DROP POLICY IF EXISTS "Bookings: Teacher view own" ON public.bookings;
DROP POLICY IF EXISTS "Bookings: Teacher manage own" ON public.bookings;

CREATE POLICY "Bookings: Access control" ON public.bookings
    FOR ALL USING (
        tenant_id = get_auth_tenant_id()
        AND (
            teacher_id = auth.uid()
            OR get_auth_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        )
    );

-- 4. Class Logs Table: Hardened
ALTER TABLE public.class_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Logs: Admin view all" ON public.class_logs;
DROP POLICY IF EXISTS "Logs: Teacher own classes" ON public.class_logs;

CREATE POLICY "Logs: Access control" ON public.class_logs
    FOR ALL USING (
        tenant_id = get_auth_tenant_id()
        AND (
            teacher_id = auth.uid()
            OR get_auth_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        )
    );

-- 5. Reschedules Table: Hardened
ALTER TABLE public.reschedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Reschedules: Staff isolation" ON public.reschedules;

CREATE POLICY "Reschedules: Access control" ON public.reschedules
    FOR ALL USING (
        tenant_id = get_auth_tenant_id()
        AND (
            teacher_id = auth.uid()
            OR get_auth_role() IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        )
    );
