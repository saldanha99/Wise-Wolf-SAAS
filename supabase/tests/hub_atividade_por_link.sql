-- Atividade por link/QR (migration 20261123170000). Tudo desfeito.
begin;
create or replace function pg_temp.assert_true(p_ok boolean, p_message text) returns void
language plpgsql as $$ begin if p_ok is not true then raise exception 'assertion failed: %', p_message; end if; end $$;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('7a000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'link-prof@exemplo.invalid', '{}', now(), now()),
       ('7a000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'link-outro@exemplo.invalid', '{}', now(), now());
update public.profiles set lifecycle_status = 'active', status = 'Ativo'
 where id in ('7a000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000002');
select set_config('request.jwt.claims', '{"sub":"7a000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table c as select private.hub_claim_trial_internal('EDUCATOR', 'Prof Link') as r;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.hub_educator_materials (id, account_id, created_by, subscription_id, request_key, request_fingerprint,
  kind, niche, level_tag, topic, item_count, title, material, model_id, prompt_version)
select '7a000000-0000-4000-8000-000000000010', (r ->> 'accountId')::uuid, '7a000000-0000-4000-8000-000000000001',
  (r ->> 'subscriptionId')::uuid, gen_random_uuid(), repeat('0', 64), 'quiz', 'TRAVEL', 'A2', 'airport check-in', 8,
  'Quiz do aeroporto', '{"questions":[{"question":"I ___ my passport.","options":["have","has"],"correct":0,"explanation_pt":"have com I"}]}'::jsonb,
  'm', 'v'
from c;
insert into public.hub_account_branding (account_id, logo_data_url, display_name, updated_by)
select (r ->> 'accountId')::uuid, 'data:image/png;base64,iVBORw0KGgo=', 'Prof Link', '7a000000-0000-4000-8000-000000000001' from c;

-- 1. Autor cria; estranho não.
select pg_temp.assert_true((public.hub_material_share_create('7a000000-0000-4000-8000-000000000001',
  '7a000000-0000-4000-8000-000000000010', repeat('a', 64)) ->> 'ok')::boolean, 'autor cria o link');
select pg_temp.assert_true((public.hub_material_share_create('7a000000-0000-4000-8000-000000000002',
  '7a000000-0000-4000-8000-000000000010', repeat('b', 64)) ->> 'code') in ('SUBSCRIPTION_REQUIRED', 'MATERIAL_ACCESS_DENIED'), 'estranho não cria');

-- 2. O link mostra a versão do aluno, sem gabarito, com o logo; conta a visita.
create temp table v as select public.hub_material_share_view(repeat('a', 64)) as r;
select pg_temp.assert_true((select (r ->> 'ok')::boolean from v), 'link abre');
select pg_temp.assert_true((select r #>> '{material,title}' = 'Quiz do aeroporto' from v), 'título');
select pg_temp.assert_true((select not ((r -> 'material' -> 'material')::text ~ '"(correct|explanation_pt)"') from v), 'sem gabarito');
select pg_temp.assert_true((select r #>> '{branding,display_name}' = 'Prof Link' from v), 'logo/nome');
select pg_temp.assert_true((select view_count = 1 from public.hub_material_share_links where token_sha256 = repeat('a', 64)), 'conta visita');
select pg_temp.assert_true((public.hub_material_share_view(repeat('c', 64)) ->> 'code') = 'LINK_INVALID', 'token errado');

-- 3. Vencido e revogado não abrem.
update public.hub_material_share_links set expires_at = now() - interval '1 minute' where token_sha256 = repeat('a', 64);
select pg_temp.assert_true((public.hub_material_share_view(repeat('a', 64)) ->> 'code') = 'LINK_EXPIRED', 'vencido');
update public.hub_material_share_links set expires_at = now() + interval '1 day' where token_sha256 = repeat('a', 64);
select pg_temp.assert_true((public.hub_material_share_revoke('7a000000-0000-4000-8000-000000000001',
  '7a000000-0000-4000-8000-000000000010') ->> 'revoked')::int = 1, 'revoga');
select pg_temp.assert_true((public.hub_material_share_view(repeat('a', 64)) ->> 'code') = 'LINK_INVALID', 'revogado não abre');

-- 4. Nada exposto a anon/authenticated.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.hub_material_share_view(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.hub_material_share_create(uuid, uuid, text)', 'execute')
  and not has_table_privilege('authenticated', 'public.hub_material_share_links', 'select'),
  'só service_role');
rollback;
