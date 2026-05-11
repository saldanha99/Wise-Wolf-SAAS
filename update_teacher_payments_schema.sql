-- Add confirmation columns to teacher_closings
ALTER TABLE teacher_closings ADD COLUMN IF NOT EXISTS teacher_confirmation_status TEXT DEFAULT 'PENDENTE';
ALTER TABLE teacher_closings ADD COLUMN IF NOT EXISTS teacher_confirmation_date TIMESTAMP WITH TIME ZONE;

-- Ensure invoice_url exists (redundancy check)
ALTER TABLE teacher_closings ADD COLUMN IF NOT EXISTS invoice_url TEXT;
