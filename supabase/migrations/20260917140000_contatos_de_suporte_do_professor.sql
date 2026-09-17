-- Central de Ajuda do professor: os contatos que os guias usam nos botões
-- "Avisar a escola" e "Falar com a coordenação".
--
-- O WhatsApp da escola é o número conectado na instância central — o mesmo
-- que recebe "não vou conseguir dar aula hoje" (teacher-absence) e as
-- respostas da experimental. Ele é o telefone do perfil SCHOOL_ADMIN dono da
-- instância (`profiles.whatsapp_instance`); conferido em 17/09/2026 contra o
-- `sender` dos webhooks da instância (5512996405414@s.whatsapp.net).
-- A coordenação vem de `tenants.school_info` (directorName/phone), que a
-- direção edita na tela de configuração da escola.
--
-- Só professor/coordenação/direção ATIVOS do próprio tenant leem; devolve
-- null sem sessão. Nada de PII de outra escola.
create or replace function public.teacher_support_contacts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when me.id is null then null
    else pg_catalog.jsonb_build_object(
      'school_name', coalesce(nullif(pg_catalog.btrim(tenant.school_info ->> 'name'), ''), tenant.name),
      'school_whatsapp', (
        select pg_catalog.regexp_replace(coalesce(admin.phone, ''), '\D', '', 'g')
        from public.profiles as admin
        join public.tenant_memberships as membership
          on membership.user_id = admin.id
         and membership.tenant_id = me.tenant_id
         and membership.role = 'SCHOOL_ADMIN'
         and membership.status = 'ACTIVE'
        where nullif(pg_catalog.btrim(coalesce(admin.whatsapp_instance, '')), '') is not null
          and pg_catalog.length(pg_catalog.regexp_replace(coalesce(admin.phone, ''), '\D', '', 'g')) >= 10
        order by membership.created_at
        limit 1
      ),
      'coordinator_name', nullif(pg_catalog.btrim(tenant.school_info ->> 'directorName'), ''),
      'coordinator_whatsapp', nullif(
        pg_catalog.regexp_replace(coalesce(tenant.school_info ->> 'phone', ''), '\D', '', 'g'), ''
      )
    )
  end
  from (
    select profile.id, profile.tenant_id
    from public.profiles as profile
    where profile.id = auth.uid()
      and upper(coalesce(profile.role, '')) in ('TEACHER', 'COORDINATOR', 'SCHOOL_ADMIN')
      and lower(coalesce(profile.lifecycle_status, 'active')) = 'active'
  ) as me
  left join public.tenants as tenant on tenant.id = me.tenant_id;
$$;

alter function public.teacher_support_contacts() owner to postgres;
revoke all on function public.teacher_support_contacts() from public, anon;
grant execute on function public.teacher_support_contacts() to authenticated;
