-- Add WhatsApp configuration columns to tenants table
ALTER TABLE tenants 
ADD COLUMN IF NOT EXISTS whatsapp_api_url TEXT,
ADD COLUMN IF NOT EXISTS whatsapp_api_key TEXT,
ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT true;
