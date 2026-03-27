-- Delete student Veronica and cascade to bookings
DELETE FROM profiles 
WHERE full_name ILIKE '%Veronica%' 
AND role = 'STUDENT';
