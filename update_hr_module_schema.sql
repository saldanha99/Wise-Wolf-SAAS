-- Create job_applications table
CREATE TABLE IF NOT EXISTS public.job_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    whatsapp TEXT NOT NULL,
    resume_url TEXT,
    status TEXT NOT NULL DEFAULT 'Novo',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Basic indexes
CREATE INDEX IF NOT EXISTS idx_job_applications_tenant ON public.job_applications(tenant_id);

-- Enable RLS
ALTER TABLE public.job_applications ENABLE ROW LEVEL SECURITY;

-- Allow Public Inserts (For the institutional website form)
CREATE POLICY "Public can insert job applications"
    ON public.job_applications
    FOR INSERT
    TO public
    WITH CHECK (true);

-- Allow Authenticated Users Full Access
CREATE POLICY "Enable select access for authenticated users" 
    ON public.job_applications FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable update access for authenticated users" 
    ON public.job_applications FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Enable delete access for authenticated users" 
    ON public.job_applications FOR DELETE TO authenticated USING (true);

-- Storage bucket for resumes (Requires Supabase Storage)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('resumes', 'resumes', true)
ON CONFLICT (id) DO NOTHING;

-- Storage Policy: Public can upload resumes
CREATE POLICY "Public Upload Resumes"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'resumes');

-- Storage Policy: Public can read resumes
CREATE POLICY "Public Read Resumes"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'resumes');
