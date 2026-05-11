-- Adiciona coluna para armazenar o token individual da instância do WhatsApp
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS whatsapp_token TEXT;

RAISE NOTICE 'Coluna whatsapp_token adicionada com sucesso.';
