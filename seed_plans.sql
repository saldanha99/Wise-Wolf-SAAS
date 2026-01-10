-- 1. Ensure saas_plan_id exists in tenants
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'saas_plan_id') THEN
        ALTER TABLE tenants ADD COLUMN saas_plan_id UUID REFERENCES saas_plans(id);
    END IF;
END $$;

-- 2. Populate Standard SaaS Plans (if empty)
INSERT INTO saas_plans (name, description, storage_limit_gb, max_students, max_users, price_monthly, price_yearly)
SELECT 'Start', 'Ideal para pequenas escolas', 5.0, 50, 2, 199.00, 1990.00
WHERE NOT EXISTS (SELECT 1 FROM saas_plans WHERE name = 'Start');

INSERT INTO saas_plans (name, description, storage_limit_gb, max_students, max_users, price_monthly, price_yearly)
SELECT 'Pro', 'Crescimento acelerado', 20.0, 200, 5, 399.00, 3990.00
WHERE NOT EXISTS (SELECT 1 FROM saas_plans WHERE name = 'Pro');

INSERT INTO saas_plans (name, description, storage_limit_gb, max_students, max_users, price_monthly, price_yearly)
SELECT 'Enterprise', 'Sem limites', 100.0, 1000, 20, 999.00, 9990.00
WHERE NOT EXISTS (SELECT 1 FROM saas_plans WHERE name = 'Enterprise');


-- 3. Populate Student Pricing Plans (Specific Request: 12-mo and 6-mo)
-- Plan 1: 12 Months Fidelity
INSERT INTO student_pricing_plans (name, description, classes_per_week, fidelity_months, monthly_price, original_price)
SELECT 'Wise Pack 12 Meses', 'Plano anual com maior desconto', 2, 12, 271.00, 338.00
WHERE NOT EXISTS (SELECT 1 FROM student_pricing_plans WHERE fidelity_months = 12);

-- Plan 2: 6 Months Fidelity
INSERT INTO student_pricing_plans (name, description, classes_per_week, fidelity_months, monthly_price, original_price)
SELECT 'Wise Pack 6 Meses', 'Flexibilidade semestral', 2, 6, 299.00, 338.00
WHERE NOT EXISTS (SELECT 1 FROM student_pricing_plans WHERE fidelity_months = 6);

