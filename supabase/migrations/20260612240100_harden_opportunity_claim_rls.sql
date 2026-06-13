-- RACE/ROUBO do claim de experimental. opp_update_tenant permitia que QUALQUER
-- professor do tenant desse UPDATE em QUALQUER opportunity (inclusive sobrescrever
-- winner_teacher_id de uma vaga já tomada). Endurece o WITH CHECK: não-admin só pode
-- gravar winner_teacher_id = ele mesmo (ou NULL). O guard atômico de corrida fica no
-- frontend (update com .in('status',['OPEN','open']).select()) + na RPC claim_opportunity.
DROP POLICY IF EXISTS opp_update_tenant ON public.opportunities;
CREATE POLICY opp_update_tenant ON public.opportunities FOR UPDATE TO authenticated
USING (tenant_id = _my_tenant_id())
WITH CHECK (
  tenant_id = _my_tenant_id() AND (
    _my_role() IN ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')
    OR winner_teacher_id IS NULL
    OR winner_teacher_id = (SELECT auth.uid())
  )
);
