-- Add Pix Key columns to profiles
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'pix_key') THEN
        ALTER TABLE profiles ADD COLUMN pix_key TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pix_key_type') THEN
        CREATE TYPE pix_key_type AS ENUM ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'pix_key_type') THEN
        ALTER TABLE profiles ADD COLUMN pix_key_type pix_key_type;
    END IF;
END $$;

-- Add Asaas fields to teacher_closings
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'teacher_closings' AND column_name = 'asaas_transfer_id') THEN
        ALTER TABLE teacher_closings ADD COLUMN asaas_transfer_id TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'teacher_closings' AND column_name = 'transfer_status') THEN
        ALTER TABLE teacher_closings ADD COLUMN transfer_status TEXT;
    END IF;
END $$;
