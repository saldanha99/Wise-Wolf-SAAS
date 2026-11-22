-- Camadas do hub do professor (aprovado pelo Chefe de Gabinete por delegação do Vinícius, 22/11/2026).
-- Margem >= 60% no P90 de uso (P90 = franquia cheia, 0 professores pagantes hoje). Conta na mensagem
-- ed30a790 / aprovação 23693487.
--
--   GRATUITO (o DISCOVERY de sempre, renomeado): amostra do banco, 5 gerações/mês, Wolfie por texto
--     para 1 aluno. A "voz de teste" aprovada NÃO entra aqui: o Wolfie do hub não tem franquia de voz.
--   PRO R$ 59/mês ou R$ 590/ano: banco completo, Educador IA (uso justo 100/mês), Wolfie texto 5 alunos.
--   ESCOLA R$ 199/mês ou R$ 1.990/ano: 3 professores + Wolfie texto para 30 alunos (33 assentos),
--     Educador IA 300/mês (100 por professor).
--   Professor extra (R$ 39) e voz do Wolfie por aluno (R$ 19, 15 min) dependem de cobrança por
--     quantidade, que o checkout ainda não faz: ficam como "em breve" no texto, sem plano à venda.
--   LIBRARY_SOLO, EDUCATOR_PRO e HUB_COMPLETE: desativados, NÃO apagados (0 assinaturas vivas e 0
--     cobranças abertas em 22/11/2026; quem tivesse continuaria no plano pelo plan_id).
-- Cota de plano do Hub muda por MIGRATION (CLAUDE.md). Re-executável.

-- Gratuito
update public.hub_plans
   set name = 'Gratuito',
       description = 'Para conhecer o banco de materiais e o Educador IA, sem cartão.',
       features = '["Amostra do banco de materiais", "5 materiais com o Educador IA por mês", "Wolfie por texto para 1 aluno", "Sem cartão"]'::jsonb,
       is_active = true, is_public = true, display_order = 10, updated_at = pg_catalog.now()
 where code = 'DISCOVERY';

-- Pro e Escola
insert into public.hub_plans (code, name, description, audience, price_monthly, price_yearly, currency, trial_days,
                              display_order, is_public, is_active, features, metadata, product_family)
values
  ('PROFESSOR_PRO', 'Pro', 'Banco completo, Educador IA e o Wolfie para os seus alunos praticarem.', 'EDUCATOR',
   59.00, 590.00, 'BRL', 0, 20, true, true,
   '["Banco de materiais completo", "Educador IA: até 100 materiais e planos por mês", "Wolfie por texto para 5 alunos", "Anual: 2 meses grátis"]'::jsonb,
   '{"tier": "PRO", "approved": "2026-11-22"}'::jsonb, 'HUB_CORE'),
  ('PROFESSOR_ESCOLA', 'Escola', 'Para escolas pequenas: 3 professores e o Wolfie para 30 alunos.', 'EDUCATOR',
   199.00, 1990.00, 'BRL', 0, 30, true, true,
   '["Tudo do Pro para 3 professores", "Wolfie por texto para 30 alunos", "Educador IA: até 300 materiais e planos por mês", "Professor extra: em breve"]'::jsonb,
   '{"tier": "ESCOLA", "approved": "2026-11-22", "included_teachers": 3, "included_learners": 30}'::jsonb, 'HUB_CORE')
on conflict (code) do update
  set name = excluded.name, description = excluded.description, audience = excluded.audience,
      price_monthly = excluded.price_monthly, price_yearly = excluded.price_yearly,
      display_order = excluded.display_order, is_public = excluded.is_public, is_active = excluded.is_active,
      features = excluded.features, metadata = excluded.metadata, product_family = excluded.product_family,
      updated_at = pg_catalog.now();

-- Limites (feature_key, limite, período); limite nulo = ilimitado
with wanted(code, feature_key, limit_value, reset_period) as (
  values
    ('DISCOVERY', 'educator_ai.generate', 5, 'MONTH'),
    ('DISCOVERY', 'library.preview', 5, 'SUBSCRIPTION'),
    ('DISCOVERY', 'library.full_access', 0, 'MONTH'),
    ('DISCOVERY', 'team.seats', 1, 'SUBSCRIPTION'),
    ('DISCOVERY', 'wolfie.turn', 100, 'MONTH'),
    ('DISCOVERY', 'academy.access', 0, 'MONTH'),
    ('PROFESSOR_PRO', 'educator_ai.generate', 100, 'MONTH'),
    ('PROFESSOR_PRO', 'library.preview', null, 'MONTH'),
    ('PROFESSOR_PRO', 'library.full_access', null, 'MONTH'),
    ('PROFESSOR_PRO', 'team.seats', 5, 'SUBSCRIPTION'),
    ('PROFESSOR_PRO', 'wolfie.turn', 1000, 'MONTH'),
    ('PROFESSOR_PRO', 'academy.access', 0, 'MONTH'),
    ('PROFESSOR_PRO', 'saas.presentation', null, 'SUBSCRIPTION'),
    ('PROFESSOR_ESCOLA', 'educator_ai.generate', 300, 'MONTH'),
    ('PROFESSOR_ESCOLA', 'library.preview', null, 'MONTH'),
    ('PROFESSOR_ESCOLA', 'library.full_access', null, 'MONTH'),
    ('PROFESSOR_ESCOLA', 'team.seats', 33, 'SUBSCRIPTION'),
    ('PROFESSOR_ESCOLA', 'wolfie.turn', 6000, 'MONTH'),
    ('PROFESSOR_ESCOLA', 'academy.access', null, 'MONTH'),
    ('PROFESSOR_ESCOLA', 'saas.presentation', null, 'SUBSCRIPTION')
)
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period)
select plan.id, wanted.feature_key, wanted.limit_value, wanted.reset_period
  from wanted join public.hub_plans as plan on plan.code = wanted.code
on conflict (plan_id, feature_key) do update
  set limit_value = excluded.limit_value, reset_period = excluded.reset_period;

-- Planos antigos: fora da vitrine e da venda, sem apagar.
update public.hub_plans
   set is_active = false, is_public = false, updated_at = pg_catalog.now()
 where code in ('LIBRARY_SOLO', 'EDUCATOR_PRO', 'HUB_COMPLETE')
   and (is_active or is_public);
