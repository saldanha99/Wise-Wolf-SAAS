-- Add wolfie_settings to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS wolfie_settings JSONB;

-- Add new columns to wolfie_sessions if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wolfie_sessions' AND column_name = 'avatar_id') THEN
        ALTER TABLE public.wolfie_sessions ADD COLUMN avatar_id TEXT;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wolfie_sessions' AND column_name = 'scenario_id') THEN
        ALTER TABLE public.wolfie_sessions ADD COLUMN scenario_id TEXT;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wolfie_sessions' AND column_name = 'scenario_step') THEN
        ALTER TABLE public.wolfie_sessions ADD COLUMN scenario_step INTEGER DEFAULT 1;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wolfie_sessions' AND column_name = 'summary_json') THEN
        ALTER TABLE public.wolfie_sessions ADD COLUMN summary_json JSONB;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wolfie_sessions' AND column_name = 'finished_at') THEN
        ALTER TABLE public.wolfie_sessions ADD COLUMN finished_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;
