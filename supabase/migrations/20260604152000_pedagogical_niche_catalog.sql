-- =====================================================================
-- Catálogo de nichos por escola (tenant_niches) + RPCs.
-- ATENÇÃO: estes objetos já existiam no banco de produção criados fora do
-- versionamento (drift). Esta migration apenas os documenta no repositório,
-- por isso tudo é idempotente (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tenant_niches (
  tenant_id  text NOT NULL,
  key        text NOT NULL,
  label      text NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT timezone('utc', now()),
  PRIMARY KEY (tenant_id, key)
);
ALTER TABLE public.tenant_niches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tn_read ON public.tenant_niches;
CREATE POLICY tn_read ON public.tenant_niches
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND (p.tenant_id = tenant_niches.tenant_id OR p.role = 'SUPER_ADMIN')
  ));

-- Lista os nichos da escola do usuário logado.
CREATE OR REPLACE FUNCTION public.list_niches()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_tenant text;
BEGIN
  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = auth.uid();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('key', key, 'label', label) ORDER BY label)
    FROM tenant_niches WHERE tenant_id = v_tenant
  ), '[]'::jsonb);
END;
$$;

-- Cria um nicho a partir de um rótulo (gera key em maiúsculas, sem acento).
CREATE OR REPLACE FUNCTION public.upsert_niche(p_label text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text; v_key text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  IF p_label IS NULL OR length(trim(p_label)) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'label_invalido');
  END IF;
  v_key := upper(regexp_replace(translate(trim(p_label),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'),
    '[^a-zA-Z0-9]+', '_', 'g'));
  v_key := trim(both '_' from v_key);
  IF v_key = '' THEN v_key := 'NICHO_' || substr(md5(random()::text), 1, 4); END IF;
  INSERT INTO tenant_niches (tenant_id, key, label, created_by)
  VALUES (v_tenant, v_key, trim(p_label), auth.uid())
  ON CONFLICT (tenant_id, key) DO UPDATE SET label = EXCLUDED.label;
  RETURN jsonb_build_object('ok', true, 'key', v_key, 'label', trim(p_label));
END;
$$;

-- Edita campos de um material (usado pelo formulário de edição do diretor).
CREATE OR REPLACE FUNCTION public.update_material(p_id uuid, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text; m_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  SELECT tenant_id INTO m_tenant FROM pedagogical_materials WHERE id = p_id;
  IF m_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
  IF v_role = 'SCHOOL_ADMIN' AND m_tenant <> v_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  UPDATE pedagogical_materials SET
    title     = COALESCE(NULLIF(p->>'title', ''), title),
    niche     = COALESCE(NULLIF(p->>'niche', ''), niche),
    level_tag = COALESCE(NULLIF(p->>'level_tag', ''), level_tag),
    type      = COALESCE(NULLIF(p->>'type', ''), type),
    category  = COALESCE(NULLIF(p->>'category', ''), category)
  WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_niches()            TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_niche(text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_material(uuid, jsonb) TO authenticated;
