-- Fichas do acervo pelo agente de conteúdo (23/11/2026, pedido do Chefe de Gabinete c90c9912).
--
-- O agente gera fichas/quizzes pelo `pedagogical-content` (hubMode, action=material) com o
-- mesmo header `x-content-bot-token` do `gamma-book-generator`. A conta técnica da escola
-- (`conteudo-bot`) é `is_test_account` e offboarded — a trava de IA das contas de QA continua
-- valendo para ela. Por isso o token passa a apontar TAMBÉM para uma conta do Hub própria
-- ("Acervo Wise Wolf (técnica)"), ativa, não de teste, banida no Auth (sem login), com plano
-- interno sem preço e sem checkout. A cota sai do `hub_reserve_feature` de sempre.
--
-- Aditiva. Desfazer: delete from private.content_bot_hub_identities; (o token deixa de gerar)
-- e, se preciso, drop function public.content_bot_hub_identity(text);
-- drop table private.content_bot_hub_identities; o plano interno pode ficar (inativo, não público).

insert into public.hub_plans (code, name, description, audience, price_monthly, price_yearly,
                              trial_days, display_order, is_public, is_active, product_family, metadata)
values ('CONTENT_BOT_INTERNAL', 'Acervo interno (agente de conteúdo)',
        'Plano técnico da conta do acervo: só gera fichas pelo agente de conteúdo. Sem venda.',
        'EDUCATOR', 0, 0, 0, 999, false, false, 'HUB_CORE',
        '{"internal": true, "purpose": "content_bot"}'::jsonb)
on conflict (code) do nothing;

-- 280 fichas + ~10% refeitas + folga (pedido do Dev Wise Wolf Hub). Mudar = migration nova.
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period, metadata)
select plan.id, 'educator_ai.generate', 350, 'MONTH', '{"internal": true}'::jsonb
  from public.hub_plans as plan
 where plan.code = 'CONTENT_BOT_INTERNAL'
on conflict (plan_id, feature_key) do nothing;

create table if not exists private.content_bot_hub_identities (
  credential_user_id uuid primary key references public.profiles (id),
  hub_user_id uuid not null unique references public.profiles (id),
  hub_account_id uuid not null unique references public.hub_accounts (id),
  created_at timestamptz not null default now(),
  constraint content_bot_hub_identity_distinct check (credential_user_id <> hub_user_id)
);
revoke all on private.content_bot_hub_identities from public, anon, authenticated;

-- Token → conta do Hub do acervo. Reaproveita a checagem do token de `content_bot_authenticate`
-- (credencial viva, conta técnica da escola sem aluno) e exige a conta do Hub ativa, não de teste,
-- com o dono como OWNER ativo.
create or replace function public.content_bot_hub_identity(p_token_sha256 text)
returns table (hub_user_id uuid, hub_account_id uuid)
language sql
security definer
set search_path = ''
as $$
  select identity.hub_user_id, identity.hub_account_id
    from public.content_bot_authenticate(p_token_sha256) as bot
    join private.content_bot_hub_identities as identity
      on identity.credential_user_id = bot.user_id
    join public.profiles as hub_profile
      on hub_profile.id = identity.hub_user_id
     and hub_profile.role = 'NON_STUDENT'
     and not coalesce(hub_profile.is_test_account, false)
    join public.hub_accounts as account
      on account.id = identity.hub_account_id
     and account.owner_user_id = identity.hub_user_id
     and account.status = 'ACTIVE'
    join public.hub_memberships as membership
      on membership.account_id = account.id
     and membership.user_id = identity.hub_user_id
     and membership.membership_role = 'OWNER'
     and membership.status = 'ACTIVE'
   limit 1;
$$;

revoke all on function public.content_bot_hub_identity(text) from public, anon, authenticated;
grant execute on function public.content_bot_hub_identity(text) to service_role;
