-- =====================================================================
-- Biblioteca pedagógica: estrutura de pastas (Nicho > Nível > Livro > Partes)
-- + correção do erro de nicho customizado.
-- =====================================================================

-- 1. Remover a constraint rígida que rejeitava qualquer nicho novo.
--    A partir de agora o catálogo tenant_niches é a fonte única de nichos.
ALTER TABLE public.pedagogical_materials DROP CONSTRAINT IF EXISTS check_pedagogical_niche;

-- 2. Garantir a tabela de catálogo de nichos (ver 20260604152000_pedagogical_niche_catalog.sql).
CREATE TABLE IF NOT EXISTS public.tenant_niches (
  tenant_id  text NOT NULL,
  key        text NOT NULL,
  label      text NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT timezone('utc', now()),
  PRIMARY KEY (tenant_id, key)
);
ALTER TABLE public.tenant_niches ENABLE ROW LEVEL SECURITY;

-- 3. Seedar os 5 nichos base como DADOS (não mais código chumbado) para cada
--    escola que já possui materiais.
INSERT INTO public.tenant_niches (tenant_id, key, label)
SELECT t.tenant_id, b.key, b.label
FROM (SELECT DISTINCT tenant_id FROM public.pedagogical_materials WHERE tenant_id IS NOT NULL) t
CROSS JOIN (VALUES
  ('GENERAL',  'Geral'),
  ('MEDICINE', '🏥 Medicina'),
  ('TECH',     '💻 Tech'),
  ('TRAVEL',   '✈️ Viagem'),
  ('BUSINESS', '💼 Business')
) AS b(key, label)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- 4. Tabela de Coleções (os "livros"). Cada livro pertence a um nicho + nível.
CREATE TABLE IF NOT EXISTS public.pedagogical_collections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  title      text NOT NULL,
  niche      text NOT NULL DEFAULT 'GENERAL',
  level_tag  text,
  cover_url  text,
  created_by uuid,
  created_at timestamptz DEFAULT timezone('utc', now())
);
CREATE INDEX IF NOT EXISTS idx_pedag_collections_tenant ON public.pedagogical_collections(tenant_id);
ALTER TABLE public.pedagogical_collections ENABLE ROW LEVEL SECURITY;

-- 5. Ligar materiais (as "partes") a uma coleção, com ordem.
--    collection_id NULL = material avulso (continua funcionando como hoje).
ALTER TABLE public.pedagogical_materials
  ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES public.pedagogical_collections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS part_number   int;
CREATE INDEX IF NOT EXISTS idx_pedag_materials_collection ON public.pedagogical_materials(collection_id);

-- 6. RLS de leitura por tenant (mesmo padrão de tenant_niches.tn_read).
DROP POLICY IF EXISTS tc_read ON public.pedagogical_collections;
CREATE POLICY tc_read ON public.pedagogical_collections
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND (p.tenant_id = pedagogical_collections.tenant_id OR p.role = 'SUPER_ADMIN')
  ));
-- Escrita só via RPC SECURITY DEFINER (sem policy de write direto).
