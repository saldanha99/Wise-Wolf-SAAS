
-- Enable RLS on whatsapp_instances just in case
ALTER TABLE whatsapp_instances ENABLE ROW LEVEL SECURITY;

-- 1. DROP EXISTING POLICIES (To avoid conflicts/duplication)
DROP POLICY IF EXISTS "Users can view own instances" ON whatsapp_instances;
DROP POLICY IF EXISTS "Users can insert own instances" ON whatsapp_instances;
DROP POLICY IF EXISTS "Users can update own instances" ON whatsapp_instances;
DROP POLICY IF EXISTS "Users can delete own instances" ON whatsapp_instances;

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;

-- 2. CREATE PERMISSIVE POLICIES FOR WHATSAPP_INSTANCES
CREATE POLICY "Users can view own instances"
ON whatsapp_instances FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own instances"
ON whatsapp_instances FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own instances"
ON whatsapp_instances FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own instances"
ON whatsapp_instances FOR DELETE
USING (auth.uid() = user_id);

-- 3. CREATE PERMISSIVE POLICIES FOR PROFILES
CREATE POLICY "Users can view own profile"
ON profiles FOR SELECT
USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
ON profiles FOR UPDATE
USING (auth.uid() = id);
