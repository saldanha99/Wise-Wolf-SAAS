-- Force PostgREST schema cache reload by toggling RLS
ALTER TABLE public.pedagogical_materials DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedagogical_materials ENABLE ROW LEVEL SECURITY;

-- Also notify just in case
NOTIFY pgrst, 'reload config';
