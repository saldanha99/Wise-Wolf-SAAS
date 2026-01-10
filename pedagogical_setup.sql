-- Create table for storing book metadata
-- FIX: tenant_id changed from UUID to TEXT to match existing schema
CREATE TABLE IF NOT EXISTS pedagogical_books (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL, 
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  module TEXT NOT NULL, -- A1, A2, B1, etc.
  uploaded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE pedagogical_books ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Enable read for authenticated users" ON pedagogical_books
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Enable insert for teachers and admins" ON pedagogical_books
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT id FROM profiles 
      WHERE role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
    )
  );

CREATE POLICY "Enable delete for admins" ON pedagogical_books
  FOR DELETE USING (
    auth.uid() IN (
      SELECT id FROM profiles 
      WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    )
  );

-- Storage Bucket for Materials (if not exists)
INSERT INTO storage.buckets (id, name, public)
VALUES ('materials', 'materials', true)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies
CREATE POLICY "Give public access to materials" ON storage.objects
  FOR SELECT USING (bucket_id = 'materials');

CREATE POLICY "Allow authenticated uploads" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'materials' 
    AND auth.role() = 'authenticated'
  );
