-- Add invoice_url to teacher_closings
ALTER TABLE teacher_closings ADD COLUMN IF NOT EXISTS invoice_url TEXT;

-- Create storage bucket for invoices if not exists
INSERT INTO storage.buckets (id, name, public)
VALUES ('invoices', 'invoices', true)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies for Invoices
CREATE POLICY "Give public access to invoices" ON storage.objects
  FOR SELECT USING (bucket_id = 'invoices');

CREATE POLICY "Allow authenticated uploads to invoices" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'invoices' 
    AND auth.role() = 'authenticated'
  );
