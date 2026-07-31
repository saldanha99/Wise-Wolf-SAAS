-- Keep the commercial promise and the database-enforced limits aligned.
-- Enterprise uses the same high-water mark already adopted for its students,
-- which behaves as unlimited for the current product scale.
UPDATE public.saas_plans
SET max_teachers = CASE name
  WHEN 'Starter' THEN 5
  WHEN 'Pro' THEN 25
  WHEN 'Enterprise' THEN 99999
  ELSE max_teachers
END
WHERE active IS TRUE
  AND plan_type = 'school'
  AND name IN ('Starter', 'Pro', 'Enterprise');
