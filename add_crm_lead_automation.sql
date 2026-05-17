-- AUTOMATION: WhatsApp Notification for New CRM Leads
-- Trigger that calls the whatsapp-crm-lead-notif Edge Function via pg_net

-- 1. Ensure pg_net is available
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Create the Trigger Function
CREATE OR REPLACE FUNCTION public.notify_on_new_lead()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  supabase_url TEXT;
  service_key TEXT;
  payload JSONB;
BEGIN
  -- Get project URL (Hardcoded for this workspace as per existing pattern in other triggers)
  supabase_url := 'https://dvalxbtngopxopzcbfdm.supabase.co';
  
  -- Attempt to get service role key from settings, fallback to common token if needed
  -- Based on whatsapp_control_updates.sql pattern
  service_key := current_setting('app.settings.service_role_key', true);
  
  -- If service_key is null, we use the known anon/service key for this project from previous scripts 
  -- or expect it to be set in the environment.
  IF service_key IS NULL OR service_key = '' THEN
    service_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
  END IF;

  -- Build the JSON payload
  payload := jsonb_build_object(
    'name', NEW.name,
    'phone', NEW.phone,
    'email', NEW.email,
    'source', NEW.source,
    'tenant_id', NEW.tenant_id
  );

  -- Dispatch to Edge Function (Async via pg_net)
  PERFORM net.http_post(
    url := supabase_url || '/functions/v1/whatsapp-crm-lead-notif',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := payload
  );

  RETURN NEW;
END;
$$;

-- 3. Create the Trigger
DROP TRIGGER IF EXISTS trigger_crm_lead_notification ON public.crm_leads;

CREATE TRIGGER trigger_crm_lead_notification
  AFTER INSERT ON public.crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_new_lead();

-- Confirmation log
COMMENT ON TRIGGER trigger_crm_lead_notification ON public.crm_leads IS 'Automates WhatsApp notifications for new leads via Edge Functions.';
