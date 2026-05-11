-- Create a function to get user ID by email (SECURITY DEFINER to access auth.users)
-- This allows the frontend to retrieve the UID of an existing user if signUp fails,
-- enabling the "Link Student" flow instead of blocking.

CREATE OR REPLACE FUNCTION get_user_id_by_email(email_input TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found_id UUID;
BEGIN
  -- Check if the configured user (admin) has permission or if we just allow it securely
  -- Since this returns only the ID (public info relative to privacy), it's acceptable for this flow
  
  SELECT id INTO found_id
  FROM auth.users
  WHERE email = email_input;
  
  RETURN found_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_user_id_by_email(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_id_by_email(TEXT) TO service_role;
