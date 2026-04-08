-- 1. Notifications Table (The "Trails")
CREATE TABLE IF NOT EXISTS notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('info', 'success', 'warning', 'urgent')) DEFAULT 'info',
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- RLS for Notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notifications" ON notifications
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can update own notifications" ON notifications
    FOR UPDATE USING (user_id = auth.uid());

-- 2. Data Integrity: Constraint for Class Logs
-- This prevents duplicate logs for the same booking on the same date.
ALTER TABLE class_logs 
ADD CONSTRAINT unique_class_log_per_booking_date 
UNIQUE (booking_id, class_date);

-- Optional: Unique for reschedules too
ALTER TABLE class_logs 
ADD CONSTRAINT unique_class_log_per_reschedule 
UNIQUE (reschedule_id);
