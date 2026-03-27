-- Create student_pricing_plans table
create table if not exists student_pricing_plans (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  classes_per_week integer not null default 1,
  fidelity_months integer not null default 0,
  monthly_price numeric not null default 0,
  original_price numeric,
  active boolean default true,
  created_at timestamptz default now()
);

-- Enable RLS
alter table student_pricing_plans enable row level security;

-- Policies for student_pricing_plans
create policy "Authenticated Read student_pricing_plans"
on student_pricing_plans for select
to authenticated
using (true);

create policy "Authenticated Full Access student_pricing_plans"
on student_pricing_plans for all
to authenticated
using (true)
with check (true);

-- Add Tenant ID to Student Pricing Plans to allow schools to have their own plans
ALTER TABLE student_pricing_plans ADD COLUMN IF NOT EXISTS tenant_id TEXT;  -- Using TEXT assuming tenant_id is text based on other tables, possibly default 'master'.

-- CRM Updates
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS trial_lesson_id UUID;
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS assigned_teacher_id UUID;

-- Class Logs Updates
ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS assessment_level TEXT; 
ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS psychological_profile TEXT;
ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS teacher_verdict TEXT;

-- Student Subscriptions Table
CREATE TABLE IF NOT EXISTS student_subscriptions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    student_id UUID NOT NULL REFERENCES profiles(id),
    plan_id UUID NOT NULL REFERENCES student_pricing_plans(id),
    asaas_id TEXT, -- Asaas Subscription ID
    status TEXT DEFAULT 'ACTIVE', -- ACTIVE, OVERDUE, CANCELED
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS for subscriptions
ALTER TABLE student_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own subscriptions" 
    ON student_subscriptions FOR SELECT 
    USING (student_id = auth.uid());

CREATE POLICY "Admins can manage subscriptions in their tenant"
    ON student_subscriptions FOR ALL
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));

-- Add/Verify Columns in Tenants for Asaas
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS asaas_api_key TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS asaas_wallet_id TEXT;
