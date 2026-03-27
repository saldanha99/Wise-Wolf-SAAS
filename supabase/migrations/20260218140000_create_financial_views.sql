-- Migration: Financial Dashboard Views

-- 1. v_teacher_payables
-- Aggregates teacher closings and estimates for current month if no closing exists? 
-- Actually, let's just make it a clean view of 'teacher_closings' joined with profiles.
-- For the dashboard, we want to see WHO we need to pay.
CREATE OR REPLACE VIEW v_teacher_payables AS
SELECT 
    tc.id as closing_id,
    tc.tenant_id,
    tc.teacher_id,
    p.full_name as teacher_name,
    p.avatar_url,
    tc.period_start,
    tc.period_end,
    tc.total_lessons_count,
    tc.total_amount_cents,
    tc.status,
    tc.updated_at
FROM teacher_closings tc
JOIN profiles p ON tc.teacher_id = p.id;

-- 2. v_dashboard_stats (Optional helper, but maybe overkill if we filter by month in UI)
-- Let's stick to the existing v_school_cashflow_summary for the charts.
