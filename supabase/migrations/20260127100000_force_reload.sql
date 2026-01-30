-- FORCE RELOAD SCHEMA CACHE via DDL
-- NOTIFY pgrst didn't seem to work.
-- We alter the table to force PostgREST to notice the change.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS _cache_bust int;
ALTER TABLE public.profiles DROP COLUMN _cache_bust;
