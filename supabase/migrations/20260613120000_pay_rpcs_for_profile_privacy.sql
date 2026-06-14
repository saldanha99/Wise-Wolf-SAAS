-- Fase 2 RLS (groundwork): RPCs SECURITY DEFINER que servem hourly_rate/pix/commission
-- aos leitores legítimos (próprio usuário e admin do tenant), para o cliente parar de
-- ler essas colunas direto de profiles. A folha SQL (definer) NÃO muda.
-- Plano completo: claudedocs/FASE2-RLS-PROFILE-PRIVATE.md

CREATE OR REPLACE FUNCTION public.get_my_pay()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object('hourly_rate', hourly_rate, 'pix_key', pix_key,
    'pix_key_type', pix_key_type, 'commission_rate', commission_rate)
  FROM profiles WHERE id = auth.uid();
$$;
GRANT EXECUTE ON FUNCTION public.get_my_pay() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_tenant_teacher_pay()
RETURNS TABLE(id uuid, full_name text, avatar_url text, role text, hourly_rate numeric, pix_key text, pix_key_type text, commission_rate integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p.id, p.full_name, p.avatar_url, p.role, p.hourly_rate, p.pix_key, p.pix_key_type, p.commission_rate
  FROM profiles p
  WHERE (_my_role() = 'SUPER_ADMIN')
     OR (_my_role() IN ('SCHOOL_ADMIN','COORDINATOR') AND p.tenant_id = _my_tenant_id());
$$;
GRANT EXECUTE ON FUNCTION public.get_tenant_teacher_pay() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_vendor_commission_rate(p_vendor uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT commission_rate FROM profiles
  WHERE id = p_vendor AND (_my_role() IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR','TEACHER','SALESPERSON'));
$$;
GRANT EXECUTE ON FUNCTION public.get_vendor_commission_rate(uuid) TO authenticated;
