-- Add financial_cutoff_day to tenants table
ALTER TABLE public.tenants 
ADD COLUMN IF NOT EXISTS financial_cutoff_day INTEGER DEFAULT 5;

-- Comment on column
COMMENT ON COLUMN public.tenants.financial_cutoff_day IS 'Day of the month (1-31) when financial records for the previous month are locked/expired.';
