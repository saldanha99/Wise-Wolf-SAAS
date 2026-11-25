-- One-shot (23/11/2026): conta do Hub do acervo para o agente de conteúdo (pedido do Chefe c90c9912).
-- Pré-requisitos: migration 20261123130000 aplicada; usuário técnico criado no Auth pelo admin da API
-- (`POST /auth/v1/admin/users` com email_confirm=true e ban_duration — sem senha guardada, sem login).
-- Uso: psql -v hub_user=<uuid do usuário técnico> -v bot_user=<uuid da conteudo-bot>
-- Desfazer: delete from private.content_bot_hub_identities where hub_user_id = :'hub_user';
--           update public.hub_subscriptions set status = 'CANCELLED', cancelled_at = now()
--            where account_id = (select id from public.hub_accounts where owner_user_id = :'hub_user');

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

update public.profiles
   set role = 'NON_STUDENT', tenant_id = null, full_name = 'Acervo Wise Wolf (técnica)',
       status = 'Ativo', lifecycle_status = 'active', is_test_account = false
 where id = :'hub_user'::uuid;

insert into public.hub_accounts (account_type, audience, name, owner_user_id, status, metadata)
values ('PERSONAL', 'EDUCATOR', 'Acervo Wise Wolf (interno)', :'hub_user'::uuid, 'ACTIVE',
        '{"internal": true, "purpose": "content_bot"}'::jsonb)
on conflict do nothing;

insert into public.hub_memberships (account_id, user_id, membership_role, status, subject_role)
select account.id, :'hub_user'::uuid, 'OWNER', 'ACTIVE', 'EDUCATOR'
  from public.hub_accounts as account
 where account.owner_user_id = :'hub_user'::uuid and account.account_type = 'PERSONAL'
on conflict (account_id, user_id) do nothing;

insert into public.hub_subscriptions (account_id, plan_id, status, billing_cycle,
                                      current_period_starts_at, current_period_ends_at, provider, metadata)
select account.id, plan.id, 'ACTIVE', 'MONTHLY', now(), '2099-12-31'::timestamptz, 'internal',
       '{"internal": true, "purpose": "content_bot"}'::jsonb
  from public.hub_accounts as account, public.hub_plans as plan
 where account.owner_user_id = :'hub_user'::uuid and account.account_type = 'PERSONAL'
   and plan.code = 'CONTENT_BOT_INTERNAL'
   and not exists (select 1 from public.hub_subscriptions s where s.account_id = account.id);

insert into private.content_bot_hub_identities (credential_user_id, hub_user_id, hub_account_id)
select :'bot_user'::uuid, :'hub_user'::uuid, account.id
  from public.hub_accounts as account
 where account.owner_user_id = :'hub_user'::uuid and account.account_type = 'PERSONAL'
on conflict (credential_user_id) do nothing;

select p.role, p.lifecycle_status, p.is_test_account, a.name, a.status, m.membership_role, s.status, pl.code
  from public.profiles p
  join public.hub_accounts a on a.owner_user_id = p.id
  join public.hub_memberships m on m.account_id = a.id and m.user_id = p.id
  join public.hub_subscriptions s on s.account_id = a.id
  join public.hub_plans pl on pl.id = s.plan_id
 where p.id = :'hub_user'::uuid;
commit;
