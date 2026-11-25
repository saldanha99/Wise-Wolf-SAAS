-- White label (migration 20261122240000): porteiro do certificado e branding público.
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.tenant_domain_allowed(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.tenant_domain_allowed(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.tenant_domain_allowed(text)', 'EXECUTE'),
  'tenant_domain_allowed exposed to the app');
select pg_temp.assert_true(
  not public.tenant_domain_allowed('api.wisewolflanguage.com.br')
  and not public.tenant_domain_allowed('system.wisewolflanguage.com.br')
  and not public.tenant_domain_allowed('naoexiste-' || md5(random()::text) || '.wisewolflanguage.com.br')
  and not public.tenant_domain_allowed('evil.example.com')
  and not public.tenant_domain_allowed('')
  and not public.tenant_domain_allowed(null),
  'gatekeeper approved a host it should refuse');
-- Escola operacional com slug é aprovada; inativa não.
insert into public.tenants (id, name, slug, saas_status, branding)
values ('wl-test-' || substr(md5(random()::text), 1, 8), 'WL Teste', 'wl-test-slug-zz', 'active', '{"tutorName":"Luna"}');
select pg_temp.assert_true(public.tenant_domain_allowed('wl-test-slug-zz.wisewolflanguage.com.br'), 'active slug refused');
select pg_temp.assert_true(
  (select (r).branding ->> 'tutorName' from (select public.resolve_public_tenant('wl-test-slug-zz.wisewolflanguage.com.br') r) s) = 'Luna',
  'tutorName missing from public branding');
update public.tenants set saas_status = 'inactive' where slug = 'wl-test-slug-zz';
select pg_temp.assert_true(not public.tenant_domain_allowed('wl-test-slug-zz.wisewolflanguage.com.br'), 'inactive slug approved');
rollback;
