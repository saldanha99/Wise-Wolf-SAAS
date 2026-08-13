-- RATEIO POR ORIGEM DA AULA — quem deu a aula muda como o dinheiro se divide.
--
-- Até aqui existia UMA régua para todo pagamento: dízimo 10%, investimento 10%,
-- escola 10% da parte da direção, e o resto (70%) como pró-labore. O aviso do
-- pagamento do Felipe (R$ 271,00, 17 aulas com a direção) mostrou a régua
-- fazendo o que não devia: quase todo o dinheiro do aluno saindo como
-- pró-labore, e R$ 27,10 ficando na escola.
--
-- Decisão da direção em 13/08/2026 — passam a existir DUAS réguas, escolhidas
-- pela origem da aula:
--
--   Aula com a DIREÇÃO      → dízimo 10% · investimento 10% · pró-labore 80%
--                             (a escola não corta nada: o aluno é dela)
--   Aula com PROFESSOR      → dízimo 10% · investimento 70% · pró-labore 20%
--     contratado              (depois de já descontado o salário do professor)
--
-- ⚠️ As duas réguas incidem sobre o LÍQUIDO (pagamento − salário previsto do
-- professor), como sempre foi. Mudar a base junto mudaria dois eixos de uma vez
-- e ninguém saberia explicar a diferença no fim do mês.
--
-- ⚠️ Aluno dividido entre a direção e um professor contratado (existe hoje:
-- Verônica, com Debora e Mateus) tem o líquido rateado POR NÚMERO DE AULAS, e
-- cada parte segue a sua régua. É o mesmo critério que o balancete usa.

-- 1. Percentuais da régua do professor contratado ----------------------------
ALTER TABLE public.payment_split_settings
  ADD COLUMN IF NOT EXISTS prof_dizimo_pct numeric(5,2) NOT NULL DEFAULT 10.00,
  ADD COLUMN IF NOT EXISTS prof_investimento_pct numeric(5,2) NOT NULL DEFAULT 70.00,
  ADD COLUMN IF NOT EXISTS prof_prolabore_pct numeric(5,2) NOT NULL DEFAULT 20.00;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_payment_split_prof_total') THEN
    ALTER TABLE public.payment_split_settings
      ADD CONSTRAINT ck_payment_split_prof_total
      CHECK (prof_dizimo_pct >= 0 AND prof_investimento_pct >= 0 AND prof_prolabore_pct >= 0
             AND prof_dizimo_pct + prof_investimento_pct + prof_prolabore_pct <= 100);
  END IF;
END $$;

-- 2. Ajuste ÚNICO da régua da direção ----------------------------------------
-- A migration roda a CADA release. Sem a trava abaixo, todo deploy desfaria o
-- que o diretor tivesse mudado na tela depois — o valor voltaria sozinho e
-- ninguém ligaria uma coisa à outra.
CREATE TABLE IF NOT EXISTS public.schema_one_shots (
  key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  nota text
);
COMMENT ON TABLE public.schema_one_shots IS
  'Marca ajustes de DADO que devem acontecer uma única vez, embora a migration seja re-executada a cada release.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_one_shots WHERE key = 'rateio_por_origem_20260813') THEN
    -- Direção fica com o líquido inteiro menos dízimo e investimento.
    UPDATE public.payment_split_settings SET escola_pct = 0.00, updated_at = now();
    INSERT INTO public.schema_one_shots (key, nota)
      VALUES ('rateio_por_origem_20260813',
              'escola_pct=0 na régua da direção; régua do professor contratado nasce 10/70/20');
  END IF;
END $$;

-- 3. O rateio propriamente dito ----------------------------------------------
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

-- 4. Configuração: ler e gravar as duas réguas -------------------------------
CREATE OR REPLACE FUNCTION public.get_payment_split_settings()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text; r record; v_destino text; v_professores jsonb;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;

  SELECT d.destino INTO v_destino FROM dre_report_settings d WHERE d.tenant_id = v_tenant;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', p.id, 'nome', btrim(p.full_name),
           'pro_labore', EXISTS (SELECT 1 FROM payment_split_owner_teachers o
                                  WHERE o.tenant_id = v_tenant AND o.teacher_id = p.id))
         ORDER BY btrim(p.full_name)), '[]'::jsonb)
    INTO v_professores
    FROM profiles p
   WHERE p.tenant_id = v_tenant AND p.role = 'TEACHER'
     AND COALESCE(p.status,'Ativo') NOT IN ('Inativo','INACTIVE','Inactive');

  SELECT * INTO r FROM payment_split_settings WHERE tenant_id = v_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('configurado', false, 'is_active', false,
      'dizimo_pct', 10.00, 'investimento_pct', 10.00, 'escola_pct', 0.00,
      'prof_dizimo_pct', 10.00, 'prof_investimento_pct', 70.00, 'prof_prolabore_pct', 20.00,
      'professores', v_professores,
      'destino', COALESCE(v_destino,''), 'destino_configurado', v_destino IS NOT NULL);
  END IF;
  RETURN jsonb_build_object('configurado', true, 'is_active', r.is_active,
    'dizimo_pct', r.dizimo_pct, 'investimento_pct', r.investimento_pct,
    'escola_pct', r.escola_pct,
    'prof_dizimo_pct', r.prof_dizimo_pct,
    'prof_investimento_pct', r.prof_investimento_pct,
    'prof_prolabore_pct', r.prof_prolabore_pct,
    'professores', v_professores,
    'destino', COALESCE(v_destino,''), 'destino_configurado', v_destino IS NOT NULL,
    'updated_at', r.updated_at);
END;
$function$;

ALTER FUNCTION public.get_payment_split_settings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_payment_split_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payment_split_settings() TO authenticated;

-- A assinatura de 4 argumentos sai de cena: mantê-la ao lado da nova deixaria
-- duas candidatas para o PostgREST resolver, e ele recusa a chamada ambígua.
DROP FUNCTION IF EXISTS public.save_payment_split_settings(numeric,numeric,boolean,numeric);

CREATE OR REPLACE FUNCTION public.save_payment_split_settings(
  p_dizimo_pct numeric, p_investimento_pct numeric, p_is_active boolean DEFAULT true,
  p_escola_pct numeric DEFAULT 0.00,
  p_prof_dizimo_pct numeric DEFAULT 10.00,
  p_prof_investimento_pct numeric DEFAULT 70.00,
  p_prof_prolabore_pct numeric DEFAULT 20.00)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_role text; v_tenant text;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('SCHOOL_ADMIN','SUPER_ADMIN') THEN
    RETURN jsonb_build_object('error','sem_permissao');
  END IF;
  IF p_dizimo_pct IS NULL OR p_investimento_pct IS NULL OR p_escola_pct IS NULL
     OR p_prof_dizimo_pct IS NULL OR p_prof_investimento_pct IS NULL OR p_prof_prolabore_pct IS NULL
     OR p_dizimo_pct < 0 OR p_investimento_pct < 0 OR p_escola_pct < 0
     OR p_prof_dizimo_pct < 0 OR p_prof_investimento_pct < 0 OR p_prof_prolabore_pct < 0 THEN
    RETURN jsonb_build_object('error','percentual_invalido');
  END IF;
  IF p_dizimo_pct + p_investimento_pct + p_escola_pct > 100 THEN
    RETURN jsonb_build_object('error','percentual_acima_de_100');
  END IF;
  IF p_prof_dizimo_pct + p_prof_investimento_pct + p_prof_prolabore_pct > 100 THEN
    RETURN jsonb_build_object('error','percentual_professor_acima_de_100');
  END IF;
  -- Ligar sem destino deixaria o aviso morrendo em silêncio a cada pagamento.
  IF COALESCE(p_is_active,true)
     AND NOT EXISTS (SELECT 1 FROM dre_report_settings d
                      WHERE d.tenant_id = v_tenant AND COALESCE(d.destino,'') <> '') THEN
    RETURN jsonb_build_object('error','sem_grupo_configurado');
  END IF;

  INSERT INTO payment_split_settings
    (tenant_id, dizimo_pct, investimento_pct, escola_pct, is_active,
     prof_dizimo_pct, prof_investimento_pct, prof_prolabore_pct)
  VALUES (v_tenant, p_dizimo_pct, p_investimento_pct, p_escola_pct, COALESCE(p_is_active,true),
          p_prof_dizimo_pct, p_prof_investimento_pct, p_prof_prolabore_pct)
  ON CONFLICT (tenant_id) DO UPDATE
    SET dizimo_pct = EXCLUDED.dizimo_pct, investimento_pct = EXCLUDED.investimento_pct,
        escola_pct = EXCLUDED.escola_pct, is_active = EXCLUDED.is_active,
        prof_dizimo_pct = EXCLUDED.prof_dizimo_pct,
        prof_investimento_pct = EXCLUDED.prof_investimento_pct,
        prof_prolabore_pct = EXCLUDED.prof_prolabore_pct,
        updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

ALTER FUNCTION public.save_payment_split_settings(numeric,numeric,boolean,numeric,numeric,numeric,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_payment_split_settings(numeric,numeric,boolean,numeric,numeric,numeric,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_payment_split_settings(numeric,numeric,boolean,numeric,numeric,numeric,numeric) TO authenticated;
