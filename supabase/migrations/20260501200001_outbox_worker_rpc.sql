-- ============================================================================
-- Migration: Outbox Worker RPC (Companion to broadcast_hardening)
-- Idempotent, reversible.
-- ============================================================================

-- RPC: fetch_outbox_batch — Atomic lock + claim with SKIP LOCKED
CREATE OR REPLACE FUNCTION public.fetch_outbox_batch(p_batch_size INTEGER DEFAULT 10)
RETURNS SETOF public.outbox_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ids UUID[];
BEGIN
    -- Select and lock rows atomically
    -- SKIP LOCKED prevents contention if multiple workers run simultaneously
    SELECT ARRAY_AGG(id) INTO v_ids
    FROM (
        SELECT id
        FROM public.outbox_messages
        WHERE status IN ('PENDING', 'FAILED')
          AND next_retry_at <= now()
        ORDER BY created_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    ) sub;

    -- If no messages, return empty
    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
        RETURN;
    END IF;

    -- Mark as PROCESSING to prevent re-selection
    UPDATE public.outbox_messages
    SET status = 'PROCESSING'
    WHERE id = ANY(v_ids);

    -- Return the full rows
    RETURN QUERY
    SELECT *
    FROM public.outbox_messages
    WHERE id = ANY(v_ids);
END;
$$;

COMMENT ON FUNCTION public.fetch_outbox_batch IS
    'Atomically fetches and locks a batch of outbox messages for processing. Uses SKIP LOCKED.';

-- Grant
GRANT EXECUTE ON FUNCTION public.fetch_outbox_batch TO service_role;

-- ============================================================================
-- pg_cron job (run this manually in Supabase SQL Editor if pg_cron is enabled)
-- ============================================================================
-- SELECT cron.schedule(
--     'process-outbox-worker',
--     '30 seconds',
--     $$
--     SELECT net.http_post(
--         url := 'https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1/process-outbox',
--         headers := jsonb_build_object(
--             'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
--             'Content-Type', 'application/json'
--         ),
--         body := '{}'::jsonb
--     );
--     $$
-- );

-- DOWN:
-- SELECT cron.unschedule('process-outbox-worker');
-- DROP FUNCTION IF EXISTS public.fetch_outbox_batch CASCADE;
