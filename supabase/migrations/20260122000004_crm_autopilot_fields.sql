-- Add automation flags to bookings table (for CRM Autopilot) - FIXED VERSION

DO $$
BEGIN
    -- Flag to track if pre-class reminder was sent
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'reminder_sent') THEN
        ALTER TABLE public.bookings ADD COLUMN reminder_sent BOOLEAN DEFAULT FALSE;
    END IF;

    -- Flag to track if post-class feedback was requested
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'feedback_sent') THEN
        ALTER TABLE public.bookings ADD COLUMN feedback_sent BOOLEAN DEFAULT FALSE;
    END IF;

    -- NOTE: We removed the index on start_time because the column name varies (it might be 'date' or 'start_date').
    -- We can verify the schema later, but these two flags are essential for the Autopilot.

END $$;
