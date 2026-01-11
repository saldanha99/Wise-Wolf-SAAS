-- System 3: Teacher Training Area (White Label)

-- 1. Training Modules Table
CREATE TABLE IF NOT EXISTS training_modules (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    video_url TEXT NOT NULL, -- YouTube/Vimeo/S3 link
    category TEXT DEFAULT 'General', -- 'Onboarding', 'Methodology', 'Conduct'
    is_mandatory BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Training Progress Table (Tracks which teacher watched what)
CREATE TABLE IF NOT EXISTS training_progress (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    teacher_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    module_id UUID REFERENCES training_modules(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'COMPLETED', -- 'STARTED', 'COMPLETED'
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(teacher_id, module_id)
);

-- RLS Policies
ALTER TABLE training_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_progress ENABLE ROW LEVEL SECURITY;

-- Admin can manage modules
DROP POLICY IF EXISTS "Admins can manage training modules" ON training_modules;
CREATE POLICY "Admins can manage training modules" ON training_modules
    FOR ALL
    USING (auth.uid() IN (
        SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN') AND tenant_id = training_modules.tenant_id
    ));

-- Teachers can view modules
DROP POLICY IF EXISTS "Teachers can view training modules" ON training_modules;
CREATE POLICY "Teachers can view training modules" ON training_modules
    FOR SELECT
    USING (auth.uid() IN (
        SELECT id FROM profiles WHERE role = 'TEACHER' AND tenant_id = training_modules.tenant_id
    ));

-- Teachers can manage their own progress
DROP POLICY IF EXISTS "Teachers can manage their own progress" ON training_progress;
CREATE POLICY "Teachers can manage their own progress" ON training_progress
    FOR ALL
    USING (teacher_id = auth.uid());

-- Admins can view all progress
DROP POLICY IF EXISTS "Admins can view all progress" ON training_progress;
CREATE POLICY "Admins can view all progress" ON training_progress
    FOR SELECT
    USING (auth.uid() IN (
        SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN') AND tenant_id = training_progress.tenant_id
    ));
