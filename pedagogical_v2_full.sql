-- Pedagogical System V2 - Full Setup
-- Combines Schema Creation and Audit System

-- 1. Pedagogical Materials (Consolidated Library)
CREATE TABLE IF NOT EXISTS pedagogical_materials (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT, -- Null if Global
    title TEXT NOT NULL,
    file_url TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('PDF', 'VIDEO', 'LINK', 'IMAGE')),
    level_tag TEXT, -- A1, A2, B1...
    category TEXT, -- Grammar, Business, etc.
    is_global BOOLEAN DEFAULT false, -- Deprecated in favor of scope, kept for compatibility
    scope TEXT CHECK (scope IN ('GLOBAL', 'TENANT', 'PRIVATE')) DEFAULT 'TENANT',
    uploaded_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- RLS for Materials
ALTER TABLE pedagogical_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read materials: Own Tenant or Global" ON pedagogical_materials;
DROP POLICY IF EXISTS "Read materials: Scoped Access" ON pedagogical_materials;

CREATE POLICY "Read materials: Scoped Access" ON pedagogical_materials
    FOR SELECT USING (
        scope = 'GLOBAL' 
        OR (scope = 'TENANT' AND tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
        OR (scope = 'PRIVATE' AND uploaded_by = auth.uid())
        OR is_global = true -- Fallback
    );

CREATE POLICY "Insert materials: Managers and Teachers" ON pedagogical_materials
    FOR INSERT WITH CHECK (
        auth.role() = 'authenticated'
    );

-- 2. Course Modules (The "Course Structure")
CREATE TABLE IF NOT EXISTS course_modules (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL, -- e.g. "English B1"
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE course_modules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read modules: Own Tenant" ON course_modules;
CREATE POLICY "Read modules: Own Tenant" ON course_modules
    FOR SELECT USING (tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Manage modules: Admins" ON course_modules;
CREATE POLICY "Manage modules: Admins" ON course_modules
    FOR ALL USING (
        tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid())
        AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
    );

-- 3. Module Topics (The "Syllabus" / Lesson Sequence)
CREATE TABLE IF NOT EXISTS module_topics (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    module_id UUID REFERENCES course_modules(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL, -- 1, 2, 3...
    title TEXT NOT NULL,
    description TEXT,
    base_material_id UUID REFERENCES pedagogical_materials(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE module_topics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read topics: Own Tenant" ON module_topics;
CREATE POLICY "Read topics: Own Tenant" ON module_topics
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM course_modules cm WHERE cm.id = module_topics.module_id AND cm.tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
    );

DROP POLICY IF EXISTS "Manage topics: Admins" ON module_topics;
CREATE POLICY "Manage topics: Admins" ON module_topics
    FOR ALL USING (
        EXISTS (SELECT 1 FROM course_modules cm WHERE cm.id = module_topics.module_id AND cm.tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()) AND auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')))
    );

-- 4. Class Logs Updates (Detailed Observations & Audit)
ALTER TABLE class_logs 
ADD COLUMN IF NOT EXISTS topic_id UUID REFERENCES module_topics(id),
ADD COLUMN IF NOT EXISTS content_covered TEXT,
ADD COLUMN IF NOT EXISTS student_difficulties TEXT,
ADD COLUMN IF NOT EXISTS homework_assigned TEXT,
ADD COLUMN IF NOT EXISTS approval_status TEXT CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')) DEFAULT 'APPROVED',
ADD COLUMN IF NOT EXISTS requires_review BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- 5. Class Materials (Extra materials uploaded during lesson)
CREATE TABLE IF NOT EXISTS class_materials (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    class_log_id UUID REFERENCES class_logs(id) ON DELETE CASCADE,
    material_id UUID REFERENCES pedagogical_materials(id) ON DELETE CASCADE,
    is_extra BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE class_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read class materials: Own Tenant" ON class_materials;
CREATE POLICY "Read class materials: Own Tenant" ON class_materials
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM class_logs cl WHERE cl.id = class_materials.class_log_id AND cl.tenant_id = (SELECT tenant_id::text FROM profiles WHERE id = auth.uid()))
    );

-- 6. Add "current_topic_id" to Profiles (to track progress)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS current_topic_id UUID REFERENCES module_topics(id);
