-- Logo do professor (migration 20261123160000). Tudo desfeito.
begin;
create or replace function pg_temp.assert_true(p_ok boolean, p_message text) returns void
language plpgsql as $$ begin if p_ok is not true then raise exception 'assertion failed: %', p_message; end if; end $$;
grant execute on function pg_temp.assert_true(boolean, text) to authenticated;
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('7f000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'logo-dono@exemplo.invalid', '{}', now(), now()),
       ('7f000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'logo-estranho@exemplo.invalid', '{}', now(), now());
update public.profiles set lifecycle_status = 'active', status = 'Ativo', role = 'NON_STUDENT'
 where id in ('7f000000-0000-4000-8000-000000000001', '7f000000-0000-4000-8000-000000000002');
select set_config('request.jwt.claims', '{"sub":"7f000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table c as select private.hub_claim_trial_internal('EDUCATOR', 'Prof Logo') as r;
grant select on c to authenticated;
set local role authenticated;
insert into public.hub_account_branding (account_id, logo_data_url, display_name, updated_by)
select (r ->> 'accountId')::uuid, 'data:image/png;base64,iVBORw0KGgo=', 'Escola da Ana', '7f000000-0000-4000-8000-000000000001' from c;
select pg_temp.assert_true((select count(*) = 1 from public.hub_account_branding), 'dono grava e lê');
reset role;
select set_config('request.jwt.claims', '{"sub":"7f000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.assert_true((select count(*) = 0 from public.hub_account_branding), 'estranho não lê');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$ begin
  begin
    insert into public.hub_account_branding (account_id, logo_data_url, updated_by)
    select (r ->> 'accountId')::uuid, 'javascript:alert(1)', '7f000000-0000-4000-8000-000000000001' from c
    on conflict (account_id) do update set logo_data_url = excluded.logo_data_url;
    raise exception 'devia recusar';
  exception when check_violation then null; end;
end $$;
rollback;
