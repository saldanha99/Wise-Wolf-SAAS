-- Whatsapp Instances (One per user)
CREATE TABLE IF NOT EXISTS whatsapp_instances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES profiles(id),
    instance_name TEXT NOT NULL,
    instance_id TEXT NOT NULL, -- The ID in Evolution API
    status TEXT DEFAULT 'disconnected', -- disconnected, connecting, connected
    api_key TEXT, -- Instance specific API key if needed
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Whatsapp Templates
CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES profiles(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    trigger_type TEXT DEFAULT 'MANUAL', -- LESSON_REMINDER, MANUAL, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Whatsapp Logs
CREATE TABLE IF NOT EXISTS whatsapp_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES profiles(id),
    destination TEXT NOT NULL,
    message TEXT,
    status TEXT, -- sent, error
    response_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- RLS Policies
ALTER TABLE whatsapp_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own instances" ON whatsapp_instances
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own templates" ON whatsapp_templates
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own logs" ON whatsapp_logs
    FOR ALL USING (auth.uid() = user_id);

-- Ensure profiles has whatsapp_instance column for easy lookup (cache)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS whatsapp_instance_id TEXT;
