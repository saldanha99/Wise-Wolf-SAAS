-- FIX: Sync Tenant ID for Bookings and Reschedules
-- This script ensures all bookings belong to the same tenant as the student
-- Run this in Supabase SQL Editor

-- 1. Fix Bookings
UPDATE bookings b
SET tenant_id = p.tenant_id
FROM profiles p
WHERE b.student_id = p.id
AND (b.tenant_id IS NULL OR b.tenant_id != p.tenant_id);

-- 2. Fix Reschedules
UPDATE reschedules r
SET tenant_id = p.tenant_id
FROM profiles p
WHERE r.student_id = p.id
AND (r.tenant_id IS NULL OR r.tenant_id != p.tenant_id);

-- 3. Verify Results
SELECT COUNT(*) as fixed_bookings 
FROM bookings b
JOIN profiles p ON b.student_id = p.id
WHERE b.tenant_id = p.tenant_id;
