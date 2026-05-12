-- Migration: Prevent duplicate class logs
-- This ensures that a teacher cannot log the same booking twice on the same day, 
-- and cannot log the same reschedule or appointment more than once.

-- 1. For regular bookings: unique (booking_id, class_date)
ALTER TABLE public.class_logs 
ADD CONSTRAINT class_logs_booking_date_unique UNIQUE (booking_id, class_date);

-- 2. For reschedules: unique (reschedule_id)
ALTER TABLE public.class_logs 
ADD CONSTRAINT class_logs_reschedule_unique UNIQUE (reschedule_id);

-- 3. For appointments (trials): unique (appointment_id)
ALTER TABLE public.class_logs 
ADD CONSTRAINT class_logs_appointment_unique UNIQUE (appointment_id);
