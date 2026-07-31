BEGIN;

-- These database cron wrappers must call the Edge Runtime on the same VPS
-- network. A historical migration pointed them at the retired hosted project.
CREATE OR REPLACE FUNCTION public.trigger_funnel_sweeper()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net, pg_temp
AS $function$
DECLARE
  request_id bigint;
  service_key text;
BEGIN
  SELECT decrypted_secret
    INTO service_key
    FROM vault.decrypted_secrets
   WHERE name = 'wisewolf_service_role_key'
   LIMIT 1;

  IF nullif(service_key, '') IS NULL THEN
    RAISE WARNING 'Vault secret wisewolf_service_role_key not set';
    RETURN -1;
  END IF;

  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/funnel-sweeper',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  INTO request_id;

  RETURN request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_post_trial_pipeline()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net, pg_temp
AS $function$
DECLARE
  request_id bigint;
  service_key text;
BEGIN
  SELECT decrypted_secret
    INTO service_key
    FROM vault.decrypted_secrets
   WHERE name = 'wisewolf_service_role_key'
   LIMIT 1;

  IF nullif(service_key, '') IS NULL THEN
    RAISE WARNING 'Vault secret wisewolf_service_role_key not set';
    RETURN -1;
  END IF;

  SELECT net.http_post(
    url := 'http://kong:8000/functions/v1/post-trial-pipeline',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  INTO request_id;

  RETURN request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_funnel_sweeper()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_post_trial_pipeline()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_funnel_sweeper() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_post_trial_pipeline() TO service_role;

-- Make a cloud endpoint an explicit migration failure instead of silently
-- allowing data or automation to leave the VPS.
DO $assert_vps_only$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE procedure.prokind = 'f'
       AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
       AND (
         procedure.prosrc ILIKE '%.supabase.co%'
         OR procedure.prosrc ILIKE '%dvalxbtngopxopzcbfdm%'
       )
  ) THEN
    RAISE EXCEPTION 'hosted_supabase_function_reference_present';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM cron.job
     WHERE active
       AND (
         command ILIKE '%.supabase.co%'
         OR command ILIKE '%dvalxbtngopxopzcbfdm%'
       )
  ) THEN
    RAISE EXCEPTION 'hosted_supabase_cron_reference_present';
  END IF;
END;
$assert_vps_only$;

COMMIT;
