
-- HARDENING RLS POLICIES FOR DATA ISOLATION

-- 1. Profiles Table: Prevent Cross-Tenant Leaks
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Pedagogical view access" ON public.profiles;
DROP POLICY IF EXISTS "Users can manage own profile" ON public.profiles;

-- Anyone can see their own profile
CREATE POLICY "Profiles: Manage Own" ON public.profiles
    FOR ALL USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- Staff can see students in their own tenant
CREATE POLICY "Profiles: Staff view tenant students" ON public.profiles
    FOR SELECT USING (
        tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
        AND role = 'STUDENT'
    );

-- 2. Bookings Table: Strict Teacher Isolation
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Bookings are viewable by authenticated users" ON public.bookings;
DROP POLICY IF EXISTS "Bookings are editable by authenticated users" ON public.bookings;

-- Admins see all in tenant
CREATE POLICY "Bookings: Admin full access" ON public.bookings
    FOR ALL USING (
        tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
        AND (SELECT p.role FROM profiles p WHERE p.id = auth.uid()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    );

-- Teachers ONLY see their own
CREATE POLICY "Bookings: Teacher view own" ON public.bookings
    FOR SELECT USING (
        teacher_id = auth.uid()
        AND tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
    );

-- Teachers ONLY edit their own
CREATE POLICY "Bookings: Teacher manage own" ON public.bookings
    FOR ALL USING (
        teacher_id = auth.uid()
        AND tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
    );

-- 3. Class Logs: Prevent Recording for Others
ALTER TABLE public.class_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Teachers can insert logs for their students" ON public.class_logs;

-- Admins see all logs
CREATE POLICY "Logs: Admin view all" ON public.class_logs
    FOR SELECT USING (
        tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
        AND (SELECT p.role FROM profiles p WHERE p.id = auth.uid()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    );

-- Teachers only manage logs where they are the teacher
CREATE POLICY "Logs: Teacher own classes" ON public.class_logs
    FOR ALL USING (
        teacher_id = auth.uid()
        AND tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
    )
    WITH CHECK (
        teacher_id = auth.uid()
        AND tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
    );

-- 4. Reschedules: Hardened
ALTER TABLE public.reschedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view reschedules in their tenant" ON public.reschedules;
DROP POLICY IF EXISTS "Teachers can insert reschedules" ON public.reschedules;

CREATE POLICY "Reschedules: Staff isolation" ON public.reschedules
    FOR ALL USING (
        tenant_id = (SELECT p.tenant_id FROM profiles p WHERE p.id = auth.uid())
        AND (
            teacher_id = auth.uid() 
            OR (SELECT p.role FROM profiles p WHERE p.id = auth.uid()) IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
        )
    );
