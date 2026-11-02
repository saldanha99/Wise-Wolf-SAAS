-- =============================================================================
-- Professor Essencial ganha 3 gerações de material por mês.
--
-- Decisão da direção (18/09/2026): a Biblioteca é o produto de entrada e o
-- gerador de material é a dor resolvida; o Essencial (R$ 59) com ZERO gerações
-- mostrava o módulo bloqueado. Três por mês são a isca para o Professor Pro (40).
--
-- ⚠️ Tem de ser migration, não UPDATE na mão: o seed de
-- `20260725220714_marketing_hub_foundation` roda a cada release e faz
-- `on conflict ... do update set limit_value` — devolveria o 0 no próximo deploy
-- sem ninguém notar. Esta migration vem DEPOIS na lista e é quem fecha o valor.
-- =============================================================================

update public.hub_plan_entitlements as entitlement
   set limit_value = 3,
       reset_period = 'MONTH'
  from public.hub_plans as plan
 where plan.id = entitlement.plan_id
   and plan.code = 'LIBRARY_SOLO'
   and entitlement.feature_key = 'educator_ai.generate'
   and (entitlement.limit_value is distinct from 3 or entitlement.reset_period <> 'MONTH');

update public.hub_plans
   set description = 'Biblioteca organizada para preparar aulas com mais agilidade — e 3 materiais gerados por IA por mês.',
       features = '["Biblioteca com curadoria", "Filtros por nível e contexto", "3 materiais gerados por IA por mês", "Atualizações do acervo", "Uso individual"]'::jsonb
 where code = 'LIBRARY_SOLO'
   and (
     features <> '["Biblioteca com curadoria", "Filtros por nível e contexto", "3 materiais gerados por IA por mês", "Atualizações do acervo", "Uso individual"]'::jsonb
     or description is distinct from 'Biblioteca organizada para preparar aulas com mais agilidade — e 3 materiais gerados por IA por mês.'
   );
