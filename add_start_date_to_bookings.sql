
-- Add start_date to bookings to prevent pending lessons before the student actually starts
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS start_date DATE;

-- Update existing bookings to have a start_date (optional, but good for consistency)
UPDATE public.bookings SET start_date = created_at::date WHERE start_date IS NULL;
