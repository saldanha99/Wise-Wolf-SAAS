-- Add billing_type to student_payments if it doesn't exist
ALTER TABLE public.student_payments
ADD COLUMN IF NOT EXISTS billing_type TEXT; -- 'PIX', 'BOLETO', 'CREDIT_CARD'

-- Add index for status to speed up financial queries in dashboard
CREATE INDEX IF NOT EXISTS idx_student_payments_status ON public.student_payments(status);
CREATE INDEX IF NOT EXISTS idx_student_payments_created_at ON public.student_payments(created_at);
