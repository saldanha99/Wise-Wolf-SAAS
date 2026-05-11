-- 1. Enable RLS on bookings table if not already enabled
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- 2. Create Policy for Reading Bookings
-- Allows any authenticated user to read bookings (filtered by tenant_id in the query usually)
DROP POLICY IF EXISTS "Bookings are viewable by authenticated users" ON bookings;
CREATE POLICY "Bookings are viewable by authenticated users" 
ON bookings FOR SELECT 
TO authenticated 
USING (true);

-- 3. Create Policy for Inserting/Updating (for Teachers/Admins)
DROP POLICY IF EXISTS "Bookings are editable by authenticated users" ON bookings;
CREATE POLICY "Bookings are editable by authenticated users" 
ON bookings FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);

-- 4. Verify columns (Optional debug output)
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'bookings';
