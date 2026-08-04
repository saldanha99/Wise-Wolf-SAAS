-- Conta própria para plano de saúde e benefícios.
--
-- O diretor foi cadastrar o plano de saúde e perguntou em que conta encaixa.
-- Nenhuma servia: não é ferramenta (6.2.01), não é infra (6.2.02), e jogar em
-- "Despesas administrativas" (6.3.01) esconde num balde genérico justamente o
-- tipo de gasto que se quer acompanhar separado — benefício é decisão recorrente
-- de gente, e some quando misturado com contador e material de escritório.
--
-- Foi para isso que o plano de contas existe: quando a natureza é nova, a conta
-- é nova. Enfiar em "Outras despesas" para não mexer no plano é o começo do
-- relatório que não explica nada.

INSERT INTO public.dre_accounts (code, label, kind, sort_order, ledger_allowed) VALUES
  ('6.3.03','Plano de saúde e benefícios','DESPESA', 630, true)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label, ledger_allowed = EXCLUDED.ledger_allowed;
