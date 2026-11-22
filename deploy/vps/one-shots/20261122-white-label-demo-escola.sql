-- One-shot (22/11/2026): escola de demonstração do white label.
-- Aprovado pelo Vinícius: "Escola Demo", tutor "Luna", cor #6D28D9,
-- endereço demo-escola.wisewolflanguage.com.br. Sem Asaas, sem WhatsApp.
-- Desfazer: update public.tenants set saas_status = 'inactive' where id = 'demo-escola';
-- Uso: psql -v diretor=<uuid> -v professor=<uuid> -v aluno=<uuid> (usuários já criados no Auth).

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, slug, tenant_type, saas_status, whatsapp_enabled, branding, school_info)
values (
  'demo-escola', 'Escola Demo', 'demo-escola', 'school', 'active', false,
  jsonb_build_object(
    'primaryColor', '#6D28D9', 'secondaryColor', '#A78BFA',
    'logoUrl', '', 'logoPath', '', 'faviconUrl', '', 'faviconPath', '',
    'tutorName', 'Luna', 'appName', 'Escola Demo'),
  jsonb_build_object('nome', 'Escola Demo', 'demo', true))
on conflict (id) do nothing;

update public.profiles p
   set tenant_id = 'demo-escola',
       role = v.role,
       full_name = v.full_name,
       status = 'Ativo',
       lifecycle_status = 'active',
       professor_id = case when v.role = 'STUDENT' then :'professor'::uuid else null end,
       level = case when v.role = 'STUDENT' then 1 else p.level end
  from (values
    (:'diretor'::uuid, 'SCHOOL_ADMIN', 'Diretora Demo'),
    (:'professor'::uuid, 'TEACHER', 'Professor Demo'),
    (:'aluno'::uuid, 'STUDENT', 'Aluno Demo')) as v(id, role, full_name)
 where p.id = v.id;

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
values (:'diretor'::uuid, 'demo-escola', 'SCHOOL_ADMIN', 'ACTIVE', true),
       (:'professor'::uuid, 'demo-escola', 'TEACHER', 'ACTIVE', true),
       (:'aluno'::uuid, 'demo-escola', 'STUDENT', 'ACTIVE', true)
on conflict do nothing;

select p.full_name, p.role, p.tenant_id, p.status, p.professor_id is not null as tem_professor,
       (select count(*) from public.tenant_memberships m where m.user_id = p.id) as memberships
  from public.profiles p
 where p.id in (:'diretor'::uuid, :'professor'::uuid, :'aluno'::uuid)
 order by 2;
select id, name, slug, saas_status, branding ->> 'tutorName' as tutor from public.tenants where id = 'demo-escola';
