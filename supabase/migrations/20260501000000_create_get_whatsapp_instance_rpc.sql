-- Create a secure function to get the Director's connected WhatsApp instance
-- This allows the unauthenticated/new teacher to fetch the sender instance name without full DB access

CREATE OR REPLACE FUNCTION public.get_tenant_whatsapp_instance(target_tenant_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER -- Run as database owner to bypass RLS
AS $$
DECLARE
    director_id uuid;
    instance_name text;
BEGIN
    -- 1. Find the School Admin (Director) for the given Tenant
    SELECT id INTO director_id
    FROM public.profiles
    WHERE tenant_id = target_tenant_id::text
    AND role = 'SCHOOL_ADMIN'
    LIMIT 1;

    IF director_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- 2. Find a CONNECTED WhatsApp instance for this Director
    SELECT wi.instance_name INTO instance_name
    FROM public.whatsapp_instances wi
    WHERE wi.user_id = director_id
    AND wi.status = 'connected'
    ORDER BY wi.created_at DESC
    LIMIT 1;

    RETURN instance_name;
END;
$$;

-- Allow public access (or authenticated) to this function
GRANT EXECUTE ON FUNCTION public.get_tenant_whatsapp_instance(uuid) TO anon, authenticated, service_role;
