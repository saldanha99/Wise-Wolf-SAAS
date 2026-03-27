-- Enable RLS on class_logs
ALTER TABLE class_logs ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts
DROP POLICY IF EXISTS "Teachers can view own class logs" ON class_logs;
DROP POLICY IF EXISTS "Teachers can insert own class logs" ON class_logs;
DROP POLICY IF EXISTS "Teachers can update own class logs" ON class_logs;
DROP POLICY IF EXISTS "Admins can manage all class logs" ON class_logs;

-- Teacher Policies
CREATE POLICY "Teachers can view own class logs" ON class_logs
    FOR SELECT
    USING (auth.uid() = teacher_id);

CREATE POLICY "Teachers can insert own class logs" ON class_logs
    FOR INSERT
    WITH CHECK (auth.uid() = teacher_id);

CREATE POLICY "Teachers can update own class logs" ON class_logs
    FOR UPDATE
    USING (auth.uid() = teacher_id);

-- Admin Policies
CREATE POLICY "Admins can manage all class logs" ON class_logs
    FOR ALL
    USING (
        auth.jwt() ->> 'email' LIKE '%admin%' 
        OR 
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE id = auth.uid() AND role IN ('ADMIN', 'COORDINATOR', 'SCHOOL_ADMIN')
        )
    );
