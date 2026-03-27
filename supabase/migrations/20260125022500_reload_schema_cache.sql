-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload config';
