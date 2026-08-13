-- O CENTAVO DO ARREDONDAMENTO NÃO PODE VIRAR SOBRA NEGATIVA.
--
-- As três fatias do rateio são arredondadas de forma independente e juntas
-- estouram a base por um centavo. O total de agosto/2026 exibia
-- "escola: -R$ 0,01" — dinheiro negativo na linha da empresa.
--
-- O centavo passa a sair do PRÓ-LABORE, nunca da escola: é a parcela
-- discricionária, e inflar a parte da empresa com resíduo de arredondamento
-- seria criar dinheiro que não existe.
--
-- ⚠️ Esta migration existe SEPARADA da 20260813140000 porque aquela já foi
-- aplicada: o release recusa migration aplicada que mude de checksum. Função
-- inteira reescrita (CREATE OR REPLACE) por isso — não dá para "remendar" um
-- trecho de corpo de função em SQL.

CREATE OR REPLACE FUNCTION public.payment_split_breakdown(p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text; v_caller_role text; v_caller_tenant text;
  v_pay record; v_tenant text; v_mes text; v_ini date; v_fim date;
  v_dizimo_pct numeric; v_investimento_pct numeric; v_ativo boolean;
  v_prof_dizimo_pct numeric; v_prof_investimento_pct numeric; v_prof_prolabore_pct numeric;
  v_custo numeric; v_aulas int; v_liquido numeric;
  v_professores jsonb; v_aluno text;
  v_na_base boolean; v_dizimo numeric; v_investimento numeric;
  v_pro_labore numeric; v_aulas_pl int; v_sobra numeric;
  v_escola_pct numeric; v_share numeric;
  v_base_pl numeric; v_base_prof numeric;
  v_dz_pl numeric; v_inv_pl numeric; v_esc_pl numeric; v_pl_pl numeric;
  v_dz_pr numeric; v_inv_pr numeric; v_pl_pr numeric; v_esc_pr numeric;
BEGIN
  SELECT COALESCE(current_setting('request.jwt.claims', true)::json->>'role','')
    INTO v_jwt_role;

  SELECT sp.id, sp.student_id, sp.value, sp.tenant_id, sp.description, sp.payment_type,
         COALESCE(sp.paid_at, sp.payment_date, sp.due_date) AS quando,
         sp.created_at
    INTO v_pay
    FROM student_payments sp WHERE sp.id = p_payment_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','pagamento_nao_encontrado'); END IF;

  v_tenant := COALESCE(v_pay.tenant_id,
                       (SELECT p.tenant_id FROM profiles p WHERE p.id = v_pay.student_id));
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('error','escola_nao_identificada'); END IF;

  -- Chamada pelo navegador passa por checagem de papel e de escola; chamada pelo
  -- cron/edge (service_role) não tem auth.uid() e já é confiável.
  IF v_jwt_role IN ('anon','authenticated') THEN
    SELECT role, tenant_id INTO v_caller_role, v_caller_tenant
      FROM profiles WHERE id = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
    IF v_caller_role <> 'SUPER_ADMIN' AND v_caller_tenant IS DISTINCT FROM v_tenant THEN
      RETURN jsonb_build_object('error','sem_permissao');
    END IF;
  END IF;

  SELECT s.dizimo_pct, s.investimento_pct, s.escola_pct, s.is_active,
         s.prof_dizimo_pct, s.prof_investimento_pct, s.prof_prolabore_pct
    INTO v_dizimo_pct, v_investimento_pct, v_escola_pct, v_ativo,
         v_prof_dizimo_pct, v_prof_investimento_pct, v_prof_prolabore_pct
    FROM payment_split_settings s WHERE s.tenant_id = v_tenant;
  IF NOT FOUND THEN
    v_dizimo_pct := 10.00; v_investimento_pct := 10.00;
    v_escola_pct := 0.00; v_ativo := false;
    v_prof_dizimo_pct := 10.00; v_prof_investimento_pct := 70.00; v_prof_prolabore_pct := 20.00;
  END IF;

  -- Mês de referência = mês em que o dinheiro entrou. É ele que define quantas
  -- vezes cada dia da semana cai no calendário.
  v_mes := to_char(COALESCE(v_pay.quando, now()), 'YYYY-MM');
  v_ini := (v_mes || '-01')::date;
  v_fim := (date_trunc('month', v_ini) + INTERVAL '1 month - 1 day')::date;

  SELECT btrim(p.full_name) INTO v_aluno FROM profiles p WHERE p.id = v_pay.student_id;

  -- Custo PREVISTO: a agenda vigente do aluno expandida sobre os dias do mês.
  -- ⚠️ v_custo soma SÓ o que é custo de verdade. Aula da direção é contada e
  -- mostrada (o diretor precisa ver quem atende o aluno), mas não reduz a base:
  -- aquele dinheiro não sai da escola.
  WITH aulas AS (
    SELECT b.teacher_id,
           d::date AS dia,
           teacher_student_rate(b.teacher_id, b.student_id, d::date) AS rate,
           EXISTS (SELECT 1 FROM payment_split_owner_teachers o
                    WHERE o.tenant_id = v_tenant AND o.teacher_id = b.teacher_id) AS pro_labore
      FROM bookings b
      CROSS JOIN generate_series(v_ini, v_fim, '1 day') d
     WHERE b.student_id = v_pay.student_id
       AND COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
       AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
       AND (b.start_date IS NULL OR d >= b.start_date)
  )
  SELECT COALESCE(count(*),0)::int,
         COALESCE(sum(a.rate) FILTER (WHERE NOT a.pro_labore), 0),
         COALESCE(count(*) FILTER (WHERE a.pro_labore),0)::int
    INTO v_aulas, v_custo, v_aulas_pl
    FROM aulas a;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'teacher_id', z.teacher_id,
           'teacher_name', COALESCE(btrim(t.full_name), 'Professor não identificado'),
           'aulas', z.n,
           'custo', CASE WHEN z.pro_labore THEN NULL ELSE round(z.custo,2) END,
           'descontado', NOT z.pro_labore) ORDER BY z.custo DESC), '[]'::jsonb)
    INTO v_professores
    FROM (
      SELECT b.teacher_id, count(*)::int AS n,
             sum(teacher_student_rate(b.teacher_id, b.student_id, d::date)) AS custo,
             EXISTS (SELECT 1 FROM payment_split_owner_teachers o
                      WHERE o.tenant_id = v_tenant AND o.teacher_id = b.teacher_id) AS pro_labore
        FROM bookings b
        CROSS JOIN generate_series(v_ini, v_fim, '1 day') d
       WHERE b.student_id = v_pay.student_id
         AND COALESCE(b.status,'SCHEDULED') = 'SCHEDULED'
         AND dow_name_to_int(b.day_of_week) = EXTRACT(dow FROM d)::int
         AND (b.start_date IS NULL OR d >= b.start_date)
       GROUP BY b.teacher_id) z
    LEFT JOIN profiles t ON t.id = z.teacher_id;

  v_liquido := GREATEST(COALESCE(v_pay.value,0) - COALESCE(v_custo,0), 0);

  -- FORA DA BASE: pagamento sem aluno vinculado não gera dízimo nem investimento
  -- (decisão de 08/08/2026 — boa parte é aporte da dona, e dizimar aporte é
  -- dizimar o mesmo dinheiro duas vezes). Continua aparecendo com o valor cheio.
  v_na_base := (v_pay.student_id IS NOT NULL);

  -- ── AS DUAS RÉGUAS ────────────────────────────────────────────────────────
  -- A base é partida pelo número de aulas de cada origem; cada parte segue a
  -- sua régua. Aluno só da direção → tudo na régua dela; aluno só de professor
  -- contratado → tudo na outra.
  v_share := CASE WHEN v_aulas > 0 THEN v_aulas_pl::numeric / v_aulas ELSE 0 END;

  IF NOT v_na_base THEN
    v_dizimo := 0; v_investimento := 0; v_pro_labore := 0; v_sobra := round(v_liquido, 2);
  ELSE
    v_base_pl   := round(v_liquido * v_share, 2);
    v_base_prof := round(v_liquido - v_base_pl, 2);

    -- Régua da direção: o que sobra depois de dízimo/investimento/escola é dela.
    v_dz_pl  := round(v_base_pl * v_dizimo_pct       / 100.0, 2);
    v_inv_pl := round(v_base_pl * v_investimento_pct / 100.0, 2);
    v_esc_pl := round(v_base_pl * COALESCE(v_escola_pct,0) / 100.0, 2);
    v_pl_pl  := GREATEST(v_base_pl - v_dz_pl - v_inv_pl - v_esc_pl, 0);

    -- Régua do professor contratado: o pró-labore é uma FATIA, e o que sobra
    -- depois das três fatias fica na escola (com 10/70/20 isso dá zero — é o
    -- desenho, não um erro de arredondamento).
    v_dz_pr  := round(v_base_prof * v_prof_dizimo_pct       / 100.0, 2);
    v_inv_pr := round(v_base_prof * v_prof_investimento_pct / 100.0, 2);
    v_pl_pr  := round(v_base_prof * v_prof_prolabore_pct    / 100.0, 2);
    v_esc_pr := GREATEST(v_base_prof - v_dz_pr - v_inv_pr - v_pl_pr, 0);

    v_dizimo       := v_dz_pl  + v_dz_pr;
    v_investimento := v_inv_pl + v_inv_pr;
    v_pro_labore   := v_pl_pl  + v_pl_pr;
    -- A sobra é o RESÍDUO, para os centavos do arredondamento não sumirem nem
    -- serem inventados: as quatro linhas sempre somam a base.
    v_sobra := round(v_liquido - v_dizimo - v_investimento - v_pro_labore, 2);

    -- ⚠️ O resíduo pode ficar NEGATIVO por um centavo: as três fatias são
    -- arredondadas para cima de forma independente e juntas estouram a base.
    -- Medido em agosto/2026 — o total do mês exibia "escola: -R$ 0,01".
    -- O centavo sai do PRÓ-LABORE, nunca da escola: é a parcela discricionária,
    -- e inflar a parte da empresa com centavo de arredondamento seria criar
    -- dinheiro que não existe.
    IF v_sobra < 0 THEN
      v_pro_labore := round(v_pro_labore + v_sobra, 2);
      v_sobra := 0;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'payment_id',   v_pay.id,
    'tenant_id',    v_tenant,
    'is_active',    COALESCE(v_ativo,false),
    'month',        v_mes,
    'paid_at',      v_pay.quando,
    'ref_date',     COALESCE(v_pay.created_at, now())::date,
    'student_id',   v_pay.student_id,
    'student_name', COALESCE(v_aluno, 'sem aluno vinculado'),
    'sem_aluno',    (v_pay.student_id IS NULL),
    'sem_agenda',   (v_aulas = 0),
    'na_base',      v_na_base,
    'description',  v_pay.description,
    'valor',        round(COALESCE(v_pay.value,0),2),
    'aulas_previstas', v_aulas,
    'aulas_pro_labore', v_aulas_pl,
    'custo_professor', round(COALESCE(v_custo,0),2),
    'pro_labore',   round(COALESCE(v_pro_labore,0),2),
    'professores',  v_professores,
    'liquido',      round(v_liquido,2),
    -- Percentuais EFETIVOS: num pagamento partido entre as duas réguas, repetir
    -- o percentual configurado faria a mensagem anunciar "Dízimo (10%)" ao lado
    -- de um valor que não é 10% da base mostrada.
    'dizimo_pct',   CASE WHEN v_liquido > 0 THEN round(v_dizimo * 100.0 / v_liquido, 2) ELSE v_dizimo_pct END,
    'investimento_pct', CASE WHEN v_liquido > 0 THEN round(v_investimento * 100.0 / v_liquido, 2) ELSE v_investimento_pct END,
    'escola_pct',   v_escola_pct,
    'regra',        CASE WHEN v_share >= 1 THEN 'direcao'
                         WHEN v_share <= 0 THEN 'professor'
                         ELSE 'misto' END,
    'dizimo',       v_dizimo,
    'investimento', v_investimento,
    'sobra',        v_sobra);
END;
$function$;

ALTER FUNCTION public.payment_split_breakdown(uuid) OWNER TO postgres;
COMMENT ON FUNCTION public.payment_split_breakdown(uuid) IS
  'Rateio de um pagamento sobre o líquido (valor − salário previsto do professor). Duas réguas: aula da direção (dízimo/investimento/escola, resto é pró-labore) e aula de professor contratado (dízimo/investimento/pró-labore em fatias, resto fica na escola). Pagamento partido é rateado por número de aulas.';

REVOKE ALL ON FUNCTION public.payment_split_breakdown(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_split_breakdown(uuid) TO authenticated, service_role;
