-- White label (22/11/2026): domínio com certificado automático e nome do tutor.
--
-- Aditiva e re-executável.
--   1. resolve_public_tenant passa a devolver também tutorName e appName do
--      branding (mesma assinatura; só chaves públicas novas).
--   2. tenant_domain_allowed(host): o "porteiro" do On-Demand TLS do Caddy.
--      Aprova só <slug>.wisewolflanguage.com.br de escola operacional ou
--      custom_domain verificado. Nomes reservados nunca. Só service_role (a Edge
--      Function tenant-domain-allowed chama; o Caddy só vê 200/404).

create or replace function public.resolve_public_tenant(p_hostname text)
returns table(id text, name text, slug text, custom_domain text, custom_domain_verified boolean, branding jsonb, school_info jsonb)
language sql
stable
security definer
set search_path to ''
as $function$
  with normalized as (
    select lower(trim(trailing '.' from trim(p_hostname))) as hostname
  )
  select
    tenant.id,
    tenant.name,
    tenant.slug,
    tenant.custom_domain,
    tenant.custom_domain_verified,
    jsonb_strip_nulls(jsonb_build_object(
      'primaryColor', tenant.branding -> 'primaryColor',
      'secondaryColor', tenant.branding -> 'secondaryColor',
      'logoUrl', tenant.branding -> 'logoUrl',
      'faviconUrl', tenant.branding -> 'faviconUrl',
      'tutorName', tenant.branding -> 'tutorName',
      'appName', tenant.branding -> 'appName'
    )),
    null::jsonb
  from public.tenants as tenant
  cross join normalized
  where normalized.hostname <> ''
    and private.tenant_is_operational(tenant.id)
    and (
      (
        normalized.hostname like '%.wisewolflanguage.com.br'
        and split_part(normalized.hostname, '.', 2) = 'wisewolflanguage'
        and tenant.slug = split_part(normalized.hostname, '.', 1)
      )
      or (
        tenant.custom_domain_verified is true
        and lower(trim(trailing '.' from tenant.custom_domain)) = normalized.hostname
      )
    )
  order by tenant.custom_domain_verified desc
  limit 1;
$function$;

revoke all on function public.resolve_public_tenant(text) from public;
grant execute on function public.resolve_public_tenant(text) to anon, authenticated, service_role;

create or replace function public.tenant_domain_allowed(p_host text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  with h as (
    select lower(trim(trailing '.' from btrim(coalesce(p_host, '')))) as host
  )
  select coalesce((
    select true
      from h
      join public.tenants t on true
     where h.host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
       and char_length(h.host) <= 253
       and private.tenant_is_operational(t.id)
       and (
         (
           h.host ~ '^[a-z0-9-]+\.wisewolflanguage\.com\.br$'
           and split_part(h.host, '.', 1) not in (
             'www', 'app', 'system', 'api', 'hub', 'blog', 'wolfie', 'admin', 'mail',
             'smtp', 'staging', 'status', 'cdn', 'static', 'auth', 'studio')
           and t.slug = split_part(h.host, '.', 1)
         )
         or (
           t.custom_domain_verified is true
           and lower(trim(trailing '.' from t.custom_domain)) = h.host
           and h.host !~ '(^|\.)(wisewolflanguage\.com\.br|2timeweb\.com\.br|2b\.app\.br|evergladescleaningsolutions\.com|editaleiseca\.com\.br)$'
         )
       )
     limit 1
  ), false);
$function$;

revoke all on function public.tenant_domain_allowed(text) from public, anon, authenticated;
grant execute on function public.tenant_domain_allowed(text) to service_role;
