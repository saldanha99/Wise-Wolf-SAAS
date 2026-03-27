-- Migration: Refactor Teacher Closings for Manual Payouts

-- 1. Refactor teacher_closings
-- Ensure existing table exists or create it
CREATE TABLE IF NOT EXISTS teacher_closings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL DEFAULT 'school-wise-wolf',
    teacher_id UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    status TEXT DEFAULT 'PENDING_TEACHER' -- PENDING_TEACHER, CONFIRMED_TEACHER, APPROVED_ADMIN, PAID, DISPUTED
);

ALTER TABLE teacher_closings
ADD COLUMN IF NOT EXISTS period_start DATE,
ADD COLUMN IF NOT EXISTS period_end DATE,
ADD COLUMN IF NOT EXISTS total_lessons_count INTEGER,
ADD COLUMN IF NOT EXISTS total_amount_cents INTEGER,
ADD COLUMN IF NOT EXISTS class_log_ids UUID[], -- Snapshot of included classes
ADD COLUMN IF NOT EXISTS notes_teacher TEXT,
ADD COLUMN IF NOT EXISTS notes_admin TEXT,
ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS payment_method TEXT,
ADD COLUMN IF NOT EXISTS payment_reference TEXT;

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_teacher_closings_teacher_status ON teacher_closings(teacher_id, status);
CREATE INDEX IF NOT EXISTS idx_teacher_closings_period ON teacher_closings(period_start, period_end);

-- 3. RLS
ALTER TABLE teacher_closings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Teachers view own closings" ON teacher_closings
    FOR SELECT USING (auth.uid() = teacher_id);

CREATE POLICY "Admins manage all closings" ON teacher_closings
    FOR ALL TO authenticated USING (auth.jwt() ->> 'email' LIKE '%admin%'); -- Placeholder logic

-- 4. Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_teacher_closings_modtime ON teacher_closings;
CREATE TRIGGER update_teacher_closings_modtime
    BEFORE UPDATE ON teacher_closings
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();
