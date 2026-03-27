
-- Add WhatsApp configuration fields to tenants
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS whatsapp_api_url TEXT,
ADD COLUMN IF NOT EXISTS whatsapp_api_key TEXT,
ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT FALSE;

-- Add WhatsApp instance name to profiles (for teachers)
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS whatsapp_instance TEXT;

-- Create a table for automation logs (optional but good for tracking)
CREATE TABLE IF NOT EXISTS automation_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT REFERENCES tenants(id),
    type TEXT, -- 'reminders_1h', 'reschedule_confirmation'
    status TEXT, -- 'success', 'error'
    message TEXT,
    payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
