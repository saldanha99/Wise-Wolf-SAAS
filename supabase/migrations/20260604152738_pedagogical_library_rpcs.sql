-- =====================================================================
-- RPCs da biblioteca pedagógica (todas SECURITY DEFINER, escopo por tenant)
-- =====================================================================

-- Criar / editar um livro (coleção)
CREATE OR REPLACE FUNCTION public.upsert_collection(
  p_id uuid, p_title text, p_niche text, p_level text, p_cover text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text; c_tenant text; v_id uuid;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  IF p_title IS NULL OR length(trim(p_title)) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'titulo_invalido');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO pedagogical_collections (tenant_id, title, niche, level_tag, cover_url, created_by)
    VALUES (v_tenant, trim(p_title), COALESCE(NULLIF(p_niche,''),'GENERAL'), NULLIF(p_level,''), NULLIF(p_cover,''), auth.uid())
    RETURNING id INTO v_id;
  ELSE
    SELECT tenant_id INTO c_tenant FROM pedagogical_collections WHERE id = p_id;
    IF c_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
    IF v_role = 'SCHOOL_ADMIN' AND c_tenant <> v_tenant THEN
      RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
    END IF;
    UPDATE pedagogical_collections SET
      title     = COALESCE(NULLIF(trim(p_title),''), title),
      niche     = COALESCE(NULLIF(p_niche,''), niche),
      level_tag = COALESCE(NULLIF(p_level,''), level_tag),
      cover_url = COALESCE(NULLIF(p_cover,''), cover_url)
    WHERE id = p_id;
    v_id := p_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- Excluir um livro. As partes NÃO são apagadas (FK ON DELETE SET NULL): viram avulsas.
CREATE OR REPLACE FUNCTION public.delete_collection(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text; c_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  SELECT tenant_id INTO c_tenant FROM pedagogical_collections WHERE id = p_id;
  IF c_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
  IF v_role = 'SCHOOL_ADMIN' AND c_tenant <> v_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  DELETE FROM pedagogical_collections WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Vincular/desvincular um material a um livro (define parte). p_collection_id NULL = vira avulso.
CREATE OR REPLACE FUNCTION public.set_material_collection(
  p_material_id uuid, p_collection_id uuid, p_part_number int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text; m_tenant text; c_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  SELECT tenant_id INTO m_tenant FROM pedagogical_materials WHERE id = p_material_id;
  IF m_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'material_nao_encontrado'); END IF;
  IF v_role = 'SCHOOL_ADMIN' AND m_tenant <> v_tenant THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  IF p_collection_id IS NOT NULL THEN
    SELECT tenant_id INTO c_tenant FROM pedagogical_collections WHERE id = p_collection_id;
    IF c_tenant IS NULL OR c_tenant <> m_tenant THEN
      RETURN jsonb_build_object('ok', false, 'error', 'colecao_invalida');
    END IF;
  END IF;
  UPDATE pedagogical_materials
    SET collection_id = p_collection_id, part_number = p_part_number
  WHERE id = p_material_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Renomear o rótulo de um nicho (mantém a key, então os materiais não quebram).
CREATE OR REPLACE FUNCTION public.rename_niche(p_key text, p_label text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  IF p_label IS NULL OR length(trim(p_label)) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'label_invalido');
  END IF;
  UPDATE tenant_niches SET label = trim(p_label)
   WHERE tenant_id = v_tenant AND key = p_key;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
  RETURN jsonb_build_object('ok', true, 'key', p_key, 'label', trim(p_label));
END;
$$;

-- Excluir um nicho. Materiais e livros desse nicho são reatribuídos para GENERAL.
-- GENERAL não pode ser excluído (é o fallback).
CREATE OR REPLACE FUNCTION public.delete_niche(p_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sem_permissao');
  END IF;
  IF p_key = 'GENERAL' THEN RETURN jsonb_build_object('ok', false, 'error', 'general_protegido'); END IF;

  UPDATE pedagogical_materials   SET niche = 'GENERAL' WHERE tenant_id = v_tenant AND niche = p_key;
  UPDATE pedagogical_collections SET niche = 'GENERAL' WHERE tenant_id = v_tenant AND niche = p_key;
  DELETE FROM tenant_niches WHERE tenant_id = v_tenant AND key = p_key;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'nao_encontrado'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_collection(uuid,text,text,text,text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_collection(uuid)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_material_collection(uuid,uuid,int)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.rename_niche(text,text)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_niche(text)                            TO authenticated;
