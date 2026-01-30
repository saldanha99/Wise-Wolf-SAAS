-- Add Subscription fields to profiles table
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS monthly_fee NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS due_day INTEGER CHECK (due_day >= 1 AND due_day <= 31),
ADD COLUMN IF NOT EXISTS subscription_id TEXT,
ADD COLUMN IF NOT EXISTS status_financial TEXT DEFAULT 'ACTIVE'; -- 'ACTIVE', 'OVERDUE', 'CANCELLED'

-- Index for fast lookup by subscription_id
CREATE INDEX IF NOT EXISTS idx_profiles_subscription_id ON public.profiles(subscription_id);
