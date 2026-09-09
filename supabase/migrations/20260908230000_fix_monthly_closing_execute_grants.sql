-- Fechamento mensal do professor voltou a rodar.
--
-- Sintoma: o cron do dia 1º (wisewolf-monthly-closing) e o recalc diário
-- (wisewolf-closing-recalc, que reprocessa M-1 e M-2) falhavam TODA execução com
-- "automation_failed" no log da edge. Por baixo:
--
--   ERROR: permission denied for function teacher_pending_carryover_in_tenant
--
-- Causa: public.run_monthly_teacher_closing é SECURITY DEFINER e pertence a
-- `postgres`, que NESTE Supabase self-hosted NÃO é superusuário (o superuser é
-- `supabase_admin`). SECURITY DEFINER roda com os poderes do dono, e as três
-- funções private que ela chama concediam EXECUTE só ao supabase_admin. A
-- migration 20260828080819_harden_management_agent_actions recriou a função sem
-- repor esses grants.
--
-- Efeito medido em produção: o fechamento de agosto/2026 ficou congelado com os
-- números do dia em que a tela do diretor o criou (a tela usa as RPCs públicas,
-- que pertencem ao supabase_admin e por isso continuavam funcionando) — R$ 3.448
-- contra R$ 3.772 reais, e nenhum professor foi avisado.
--
-- Correção cirúrgica: conceder EXECUTE ao dono da SECURITY DEFINER. NÃO trocamos
-- o dono para supabase_admin — isso faria a função rodar como superusuário, e a
-- convenção do projeto é justamente manter o dono em `postgres` e conceder
-- explicitamente o que ele precisa.

GRANT EXECUTE ON FUNCTION
  private.teacher_pending_carryover_in_tenant(text, uuid) TO postgres;
GRANT EXECUTE ON FUNCTION
  private.refresh_teacher_closing_snapshot(text, uuid, text, boolean) TO postgres;
GRANT EXECUTE ON FUNCTION
  private.lock_teacher_closing_pair(text, text, uuid, uuid) TO postgres;

-- Guarda contra reincidência: se alguém recriar as funções private sem os
-- grants, ou trocar o dono da SECURITY DEFINER para um papel sem EXECUTE, o
-- release para aqui em vez de publicar um fechamento que falha em silêncio todo
-- dia 1º. A checagem é feita contra o dono REAL da função, não contra um papel
-- chumbado, para continuar valendo se o dono mudar.
DO $$
DECLARE
  v_owner text;
  v_missing text[] := '{}';
  v_signature text;
BEGIN
  SELECT pg_get_userbyid(p.proowner)
    INTO v_owner
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'run_monthly_teacher_closing';

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'run_monthly_teacher_closing não encontrada';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'private.teacher_pending_carryover_in_tenant(text, uuid)',
    'private.refresh_teacher_closing_snapshot(text, uuid, text, boolean)',
    'private.lock_teacher_closing_pair(text, text, uuid, uuid)'
  ] LOOP
    IF NOT has_function_privilege(v_owner, v_signature, 'EXECUTE') THEN
      v_missing := v_missing || v_signature;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'run_monthly_teacher_closing roda como % e não pode executar: %',
      v_owner, array_to_string(v_missing, ', ');
  END IF;
END;
$$;
