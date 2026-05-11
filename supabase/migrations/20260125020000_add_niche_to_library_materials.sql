-- Safely add column if table exists
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'library_materials') THEN
        ALTER TABLE public.library_materials 
        ADD COLUMN IF NOT EXISTS niche text DEFAULT 'GENERAL';

        ALTER TABLE public.library_materials DROP CONSTRAINT IF EXISTS check_niche;
        
        ALTER TABLE public.library_materials
        ADD CONSTRAINT check_niche CHECK (niche IN ('GENERAL', 'MEDICINE', 'TECH', 'TRAVEL', 'BUSINESS'));
    END IF;
END $$;
