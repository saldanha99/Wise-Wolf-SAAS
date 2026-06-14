-- REGRESSÃO do fix de RLS cross-tenant (20260612220000): PublicContractView
-- (/view-contract?id=, aberto DESLOGADO pelo professor/aluno) lia profiles direto,
-- mas anon perdeu o SELECT em profiles → "professores não conseguem acessar o contrato".
-- Fix: RPC SECURITY DEFINER que devolve SÓ os campos do contrato por id (anon).
-- Estritamente mais restrito que o antigo "Public Read USING(true)" (só esses campos,
-- só por id exato — não enumerável). Frontend: PublicContractView usa este RPC.
CREATE OR REPLACE FUNCTION public.get_contract_public(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'full_name', full_name,
    'rg', rg,
    'cpf', cpf,
    'address', address,
    'birth_date', birth_date,
    'hourly_rate', hourly_rate,
    'contract_accepted', contract_accepted,
    'accepted_at', accepted_at,
    'user_ip', user_ip
  )
  FROM profiles WHERE id = p_id;
$$;
GRANT EXECUTE ON FUNCTION public.get_contract_public(uuid) TO anon, authenticated;
