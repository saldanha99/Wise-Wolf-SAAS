-- O plano interno do acervo precisa estar ATIVO: `hub_user_has_educator_planner_access` (portão do
-- gerador de material) exige `plan.is_active = true`. Continua fora da venda: a vitrine
-- (`hub_plans_public_read`) e o `create-hub-checkout` exigem `is_public = true`, e o teste grátis
-- só usa DISCOVERY. Medido na 1ª chamada real de 23/11: 402 SUBSCRIPTION_REQUIRED.
-- Desfazer: update public.hub_plans set is_active = false where code = 'CONTENT_BOT_INTERNAL';
update public.hub_plans
   set is_active = true
 where code = 'CONTENT_BOT_INTERNAL'
   and is_public = false;
