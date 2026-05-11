-- Fix: Add Unique Constraint for Upsert
ALTER TABLE teacher_closings
ADD CONSTRAINT teacher_closings_teacher_period_key UNIQUE (teacher_id, period_start);
