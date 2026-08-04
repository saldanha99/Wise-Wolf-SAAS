-- A ressalva do snapshot ficou contradizendo o próprio número.
--
-- Depois que o balancete passou a ter `lucro_contratado`, o assistente respondeu
-- certo ("Debora, R$ 1.059,86, com R$ 370,86 a cobrar") e fechou com a ressalva
-- antiga: "o lucro por professor usa a receita FATURADA". Aviso que contradiz o
-- número logo acima é pior do que aviso nenhum — é o tipo de detalhe que faz
-- alguém parar de confiar na ferramenta inteira.
--
-- Troca cirúrgica do literal, em vez de reescrever as ~90 linhas de
-- gestao_snapshot só por uma frase: menos superfície, menos chance de quebrar
-- função que está funcionando. A troca é VERIFICADA — se o texto antigo não for
-- encontrado, a migration falha alto em vez de passar sem fazer nada.

DO $migration$
DECLARE
  v_def text;
  v_antigo text := 'O lucro por professor usa a receita que FOI faturada no mês. Se houver alunos em alunos_sem_cobranca, o professor deles aparece com lucro menor do que o real — é falha de faturamento, não desempenho. Sempre cite essa ressalva ao comparar professores.';
  v_novo  text := 'Para comparar professores use lucro_contratado (mensalidade dos alunos que ele atendeu menos o custo dele): isola falha de cobrança e mede o que o professor entregou. O campo lucro é o FATURADO — use para saber quanto entrou, pois é ele que fecha com o DRE. Se o professor tiver nao_faturado > 0, cite o valor: é dinheiro a cobrar, não desempenho ruim.';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'gestao_snapshot'
     AND pg_get_function_identity_arguments(p.oid) = 'p_month text, p_tenant text';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'gestao_snapshot(text,text) não encontrada';
  END IF;

  IF position(v_antigo IN v_def) = 0 THEN
    -- Já atualizada (re-execução da migration) ou texto mudou: não force nada.
    IF position(v_novo IN v_def) > 0 THEN
      RAISE NOTICE 'ressalva já está atualizada, nada a fazer';
      RETURN;
    END IF;
    RAISE EXCEPTION 'texto da ressalva não bate com o esperado — revise antes de aplicar';
  END IF;

  EXECUTE replace(v_def, v_antigo, v_novo);

  -- Confirma que a troca pegou de verdade.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'gestao_snapshot'
     AND pg_get_function_identity_arguments(p.oid) = 'p_month text, p_tenant text';
  IF position(v_novo IN v_def) = 0 THEN
    RAISE EXCEPTION 'a troca da ressalva não foi aplicada';
  END IF;
END
$migration$;
