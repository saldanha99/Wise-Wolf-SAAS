-- Verificação humana do link de sala.
--
-- O cadastro gerava códigos aleatórios do Meet, e hoje há uma mistura de links
-- reais e inventados. Não dá para separá-los por programa: código real do Meet
-- tem exatamente o mesmo formato do que era gerado, a auditoria de perfil nunca
-- registrou `meeting_link`, e `profiles` não tem `updated_at`. Não há histórico.
--
-- Só quem abre o link descobre se ele existe. Então o sistema para de fingir
-- que sabe e passa a registrar quem confirmou, e quando.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS meeting_link_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS meeting_link_verified_by uuid;

COMMENT ON COLUMN public.profiles.meeting_link_verified_at IS
  'Quando uma pessoa abriu o link e confirmou que a sala existe. NULL = não confirmado.';

-- Trocar o link invalida a confirmação: link novo é link não testado.
CREATE OR REPLACE FUNCTION public.reset_meeting_link_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.meeting_link IS DISTINCT FROM OLD.meeting_link THEN
    NEW.meeting_link_verified_at := NULL;
    NEW.meeting_link_verified_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reset_meeting_link_verification ON public.profiles;
CREATE TRIGGER trg_reset_meeting_link_verification
  BEFORE UPDATE OF meeting_link ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.reset_meeting_link_verification();

-- Registra a confirmação. Só quem tem escopo sobre o aluno.
CREATE OR REPLACE FUNCTION public.verify_meeting_link(
  p_student_id uuid,
  p_works boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role   text;
  v_tenant text;
  v_stud   text;
BEGIN
  SELECT p.role, p.tenant_id INTO v_role, v_tenant
  FROM public.profiles p WHERE p.id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN
     ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;

  SELECT p.tenant_id INTO v_stud
  FROM public.profiles p WHERE p.id = p_student_id AND p.role = 'STUDENT';
  IF v_stud IS NULL OR v_stud <> v_tenant THEN
    RAISE EXCEPTION 'aluno_invalido';
  END IF;

  IF COALESCE(p_works, false) THEN
    UPDATE public.profiles
    SET meeting_link_verified_at = now(), meeting_link_verified_by = auth.uid()
    WHERE id = p_student_id;
    RETURN jsonb_build_object('ok', true, 'verificado', true);
  END IF;

  -- Não funcionou: limpa o link. Deixá-lo ali só faria alguém clicar de novo.
  -- A trigger zera a verificação junto.
  UPDATE public.profiles SET meeting_link = NULL WHERE id = p_student_id;
  RETURN jsonb_build_object('ok', true, 'verificado', false, 'link_removido', true);
END;
$$;

REVOKE ALL ON FUNCTION public.verify_meeting_link(uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_meeting_link(uuid, boolean) TO authenticated;

-- Fila de verificação: quem tem aula marcada e link ainda não confirmado.
-- Ordenada por urgência — aluno com aula e sem sala confirmada vem primeiro.
CREATE OR REPLACE FUNCTION public.meeting_links_to_verify()
RETURNS TABLE (
  student_id   uuid,
  student_name text,
  meeting_link text,
  tem_aula     boolean,
  verificado   boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_role   text;
  v_tenant text;
BEGIN
  SELECT p.role, p.tenant_id INTO v_role, v_tenant
  FROM public.profiles p WHERE p.id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN
     ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') THEN
    RAISE EXCEPTION 'sem_permissao';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(p.full_name, '?')::text,
    p.meeting_link,
    EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.student_id = p.id AND b.status = 'SCHEDULED'
    ),
    p.meeting_link_verified_at IS NOT NULL
  FROM public.profiles p
  WHERE p.role = 'STUDENT'
    AND p.tenant_id = v_tenant
    AND COALESCE(p.status, 'Ativo') NOT IN ('Inativo', 'INACTIVE', 'Arquivado')
    AND p.meeting_link_verified_at IS NULL
  ORDER BY EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.student_id = p.id AND b.status = 'SCHEDULED'
  ) DESC, p.full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.meeting_links_to_verify() FROM public;
GRANT EXECUTE ON FUNCTION public.meeting_links_to_verify() TO authenticated;
