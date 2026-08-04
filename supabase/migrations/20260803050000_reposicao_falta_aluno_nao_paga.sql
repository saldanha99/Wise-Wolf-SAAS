-- Reposição de falta do ALUNO volta a não ser paga.
--
-- A regra sempre foi: falta do ALUNO já é remunerada na aula original (o
-- professor compareceu), então a reposição dela NÃO paga. Só reposição de falta
-- do PROFESSOR paga, porque a aula de origem não foi paga a ele.
--
-- A view tinha a regra escrita, mas ela NUNCA disparava:
--
--   AND NOT COALESCE(subtype IN ('REPOSIÇÃO','REPOSIÇÃO_PROF')
--                    AND r.fault_type = 'STUDENT', false)
--
-- Ela depende do JOIN `reschedules r ON r.id::text = cl.reschedule_id`, e esse
-- vínculo está quebrado: dos 13 class_logs com reschedule_id, 12 apontam para
-- UUIDs que não existem em tabela nenhuma. Com r nulo, `r.fault_type = 'STUDENT'`
-- é NULL, o COALESCE devolve false, o NOT deixa passar — e a reposição é paga.
--
-- Resultado real em junho/2026: Dâmaris teve 3 faltas dela pagas (R$ 24) MAIS 3
-- reposições pagas (R$ 24); Gabriela, 1 falta (R$ 8) mais 2 reposições (R$ 16).
-- R$ 40,00 pagos em duplicidade. Julho só escapou porque alguém zerou cada
-- reposição na mão com rate_override = 0 — remendo que falha no dia em que
-- esquecerem.
--
-- A CORREÇÃO não tenta consertar o vínculo órfão: usa o dado que já está certo.
-- O LessonLauncher grava o subtype conforme a culpa desde sempre —
-- 'REPOSIÇÃO' para falta do aluno, 'REPOSIÇÃO_PROF' para falta do professor —
-- e a view simplesmente ignorava essa distinção, tratando os dois iguais.
--
-- ⚠️ COALESCE obrigatório em volta da comparação: `subtype = 'REPOSIÇÃO'` é NULL
-- quando o subtype é nulo, e a MAIORIA das aulas tem subtype nulo. Sem o
-- COALESCE o NOT viraria NULL e a aula normal sumiria da folha — é exatamente o
-- erro que já derrubou o pagamento do Mateus duas vezes neste projeto.
--
-- A checagem por fault_type continua, como segunda linha: se um dia o vínculo
-- voltar a funcionar, ela pega o caso em que o subtype ficou errado.

DO $migration$
DECLARE
  v_def text;
  v_antigo text := 'NOT COALESCE((cl.subtype = ANY (ARRAY[''REPOSIÇÃO''::text, ''REPOSIÇÃO_PROF''::text])) AND r.fault_type = ''STUDENT''::text, false)';
  v_novo   text := '(NOT COALESCE(cl.subtype = ''REPOSIÇÃO''::text, false)) AND NOT COALESCE((cl.subtype = ANY (ARRAY[''REPOSIÇÃO''::text, ''REPOSIÇÃO_PROF''::text])) AND r.fault_type = ''STUDENT''::text, false)';
BEGIN
  SELECT pg_get_viewdef('public.v_payable_class_logs'::regclass, true) INTO v_def;
  IF v_def IS NULL THEN RAISE EXCEPTION 'v_payable_class_logs não encontrada'; END IF;

  IF position(v_antigo IN v_def) = 0 THEN
    IF position('NOT COALESCE(cl.subtype = ''REPOSIÇÃO''::text, false)' IN v_def) > 0 THEN
      RAISE NOTICE 'regra já aplicada, nada a fazer';
      RETURN;
    END IF;
    RAISE EXCEPTION 'cláusula de reposição não encontrada na view — revise antes de aplicar';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_payable_class_logs AS ' ||
          replace(v_def, v_antigo, v_novo);

  SELECT pg_get_viewdef('public.v_payable_class_logs'::regclass, true) INTO v_def;
  IF position('NOT COALESCE(cl.subtype = ''REPOSIÇÃO''::text, false)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'a correção da reposição não foi aplicada';
  END IF;
END
$migration$;

COMMENT ON VIEW public.v_payable_class_logs IS
  'Aulas pagáveis ao professor. Reposição de falta do ALUNO (subtype REPOSIÇÃO) não paga — a aula de origem já foi remunerada. Reposição de falta do PROFESSOR (REPOSIÇÃO_PROF) paga.';
