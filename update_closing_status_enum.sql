-- Create new enum type if it doesn't exist, or alter it
DO $$
BEGIN
    -- Check if the type exists
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'closing_status') THEN
        CREATE TYPE closing_status AS ENUM (
            'PENDENTE', -- Maintaining legacy for migration safety
            'WAITING_PAYMENT',
            'PAID_WAITING_NF',
            'UNDER_REVIEW',
            'COMPLETED',
            'REJECTED'
        );
    ELSE
        -- If exists, we should add new values. Postgres doesn't support easy "Replace Enum", 
        -- so we often just add values.
        -- Note: running ALTER TYPE inside a block is tricky, usually done outside.
        -- We will output commands to be run manually if needed, but for now assuming we can add.
        NULL;
    END IF;
END$$;

-- Since we cannot run ALTER TYPE inside DO block easily for adding values conditionally without dynamic SQL,
-- We will just run ALTER TYPE commands blindly. ERRORs if exist is fine in this context (idempotent-ish).
-- Only run these if the type ALREADY exists and lacks these values.

ALTER TYPE closing_status ADD VALUE IF NOT EXISTS 'WAITING_PAYMENT';
ALTER TYPE closing_status ADD VALUE IF NOT EXISTS 'PAID_WAITING_NF';
ALTER TYPE closing_status ADD VALUE IF NOT EXISTS 'UNDER_REVIEW';
ALTER TYPE closing_status ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE closing_status ADD VALUE IF NOT EXISTS 'REJECTED';

-- Verify the new values
SELECT enum_range(NULL::closing_status);
