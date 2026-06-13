-- Drop the redundant trigger that tries to send WhatsApp confirmations on payment updates.
-- This is already handled directly in the asaas-webhook edge function.
-- The trigger also had an incorrect project reference URL (dvalxbtngopxzcbfdm) causing silent pg_net errors.

DROP TRIGGER IF EXISTS trg_payment_whatsapp ON student_payments;
DROP FUNCTION IF EXISTS public.handle_new_payment_whatsapp();
