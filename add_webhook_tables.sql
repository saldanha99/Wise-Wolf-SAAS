-- Create table for storing individual payments from Asaas
CREATE TABLE IF NOT EXISTS public.student_payments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    asaas_payment_id TEXT UNIQUE NOT NULL,
    value NUMERIC(10, 2),
    status TEXT, -- 'PENDING', 'RECEIVED', 'CONFIRMED', 'OVERDUE'
    due_date DATE,
    payment_date DATE,
    invoice_url TEXT,
    pix_code TEXT, -- New column for Pix Copy/Paste
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookup by Asaas Payment ID (Crucial for Webhook)
CREATE INDEX IF NOT EXISTS idx_student_payments_asaas_id ON public.student_payments(asaas_payment_id);

-- Optional: Index on student_id for listing payments
CREATE INDEX IF NOT EXISTS idx_student_payments_student_id ON public.student_payments(student_id);
