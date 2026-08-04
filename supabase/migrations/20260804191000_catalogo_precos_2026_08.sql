-- Tabela de preços vigente da Wise Wolf (definida pela direção em 04/08/2026).
--
-- O catálogo no banco estava DEFASADO e sem linha de 6x — e ele é lido no fluxo
-- de matrícula (`TrialsToContracts`, `StudentAssignmentModal`, `enroll-student`).
-- Na prática, quem fosse matriculado hoje pegava preço antigo: o 12m-3x saía por
-- R$ 187 quando a tabela praticada é R$ 229.
--
-- ⚠️ NÃO apaga nada: os planos de 1 mês continuam ativos (existem alunos nessa
-- faixa) e nenhum aluno tem o preço mexido — plano de aluno só muda por aditivo
-- assinado (`student_plan_changes`). Isto aqui é o CARDÁPIO, não a conta.
--
-- ⚠️ Registrado para a direção: no plano de 6 meses, o degrau 4x -> 5x cobra
-- +R$ 22 por uma aula/semana que custa +R$ 34,67 de professor. O 5x/6m rende
-- R$ 12,67 A MENOS que o 4x/6m com 25% mais hora de aula. Cadastrado como veio,
-- porque preço é decisão comercial — mas fica anotado onde a conta não fecha.

-- Idempotente por (tenant, aulas/semana, carência): rodar de novo atualiza o
-- preço em vez de duplicar a linha do cardápio.
-- PARCIAL (`classes_per_week > 0`) porque o tenant `wolfie-direct` tem 4 planos
-- de assinatura do Wolfie avulso, todos com 0 aula/semana — eles colidiriam
-- entre si num índice total e a criação falharia.
-- ⚠️ SEM `begin;`/`commit;` e RE-EXECUTÁVEL: o release.sh aplica a lista INTEIRA
-- de migrations a cada deploy, dentro da transação dele. Um `commit;` aqui
-- fecharia a transação do release no meio, e um `create policy` sem o `drop`
-- correspondente derruba o deploy no segundo release (foi o que aconteceu).

create unique index if not exists uq_pricing_plan_tenant_freq_fidelity
  on public.student_pricing_plans (tenant_id, classes_per_week, fidelity_months)
  where classes_per_week > 0;

insert into public.student_pricing_plans
  (tenant_id, name, classes_per_week, fidelity_months, monthly_price, active)
values
  -- 6 meses
  ('school-wise-wolf', '6m-2x', 2,  6, 198.00, true),
  ('school-wise-wolf', '6m-3x', 3,  6, 261.00, true),
  ('school-wise-wolf', '6m-4x', 4,  6, 355.00, true),
  ('school-wise-wolf', '6m-5x', 5,  6, 377.00, true),
  ('school-wise-wolf', '6m-6x', 6,  6, 429.00, true),
  -- 12 meses
  ('school-wise-wolf', '12m-2x', 2, 12, 169.00, true),
  ('school-wise-wolf', '12m-3x', 3, 12, 229.00, true),
  ('school-wise-wolf', '12m-4x', 4, 12, 299.00, true),
  ('school-wise-wolf', '12m-5x', 5, 12, 339.00, true),
  ('school-wise-wolf', '12m-6x', 6, 12, 389.00, true)
-- O `where` REPETE o predicado do índice parcial. Sem isso o Postgres responde
-- "no unique or exclusion constraint matching the ON CONFLICT" — a mesma pedra de
-- `uq_bookings_no_dup_active` e do `run_recurring_expenses`.
on conflict (tenant_id, classes_per_week, fidelity_months) where classes_per_week > 0 do update
  set monthly_price = excluded.monthly_price,
      name = excluded.name,
      active = true;

-- 6x mensal não foi definido pela direção. Fica de fora em vez de ser inventado:
-- preço chutado no cardápio vira proposta enviada ao aluno.
