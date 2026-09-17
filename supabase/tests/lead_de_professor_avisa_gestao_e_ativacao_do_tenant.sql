-- Lead de "Professor Negócio": o insert público enfileira o aviso no grupo da
-- Gestão da escola operadora, e a conversão em tenant (trial) é idempotente e
-- só aceita plano de professor. Tudo sintético, tudo desfeito no rollback.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.convert_teacher_lead_to_tenant(uuid,uuid,text,text,integer,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.convert_teacher_lead_to_tenant(uuid,uuid,text,text,integer,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.convert_teacher_lead_to_tenant(uuid,uuid,text,text,integer,text)', 'EXECUTE'),
  'convert_teacher_lead_to_tenant deve ser exclusiva do service_role'
);

-- Escola operadora sintética, com grupo da Gestão próprio: o teste nunca aponta
-- para o grupo real da Wise Wolf.
insert into public.tenants (id, name) values ('lead-prof-school', 'Lead Prof School') on conflict (id) do nothing;
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-0000000a9d01', 'authenticated', 'authenticated', 'lp-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora LP"}', now(), now());
update public.profiles set tenant_id = 'lead-prof-school', role = 'SCHOOL_ADMIN', lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-0000000a9d01';
insert into public.dre_report_settings (tenant_id, destino, cadencia, dia_semana, is_active)
values ('lead-prof-school', '120363000000000001@g.us', 'semanal', 1, true)
on conflict (tenant_id) do update set destino = excluded.destino, is_active = true;
update public.hub_settings
   set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('salesNoticeTenantId', 'lead-prof-school')
 where settings_key = 'default';

-- Plano sintético de professor e um de escola (para a recusa).
insert into public.saas_plans (id, name, description, price, price_yearly, max_students, max_users, max_storage_gb, active, features, plan_type, max_teachers)
values
  ('00000000-0000-4000-8000-0000000a9d51', 'LP Teacher Plan', 'teste', 97, 970, 15, 1, 2, true, '[]'::jsonb, 'teacher', 1),
  ('00000000-0000-4000-8000-0000000a9d52', 'LP School Plan', 'teste', 197, 1970, 100, 1, 10, true, '[]'::jsonb, 'school', 5);

-- 1) O formulário público (anon) grava o lead e o aviso entra na fila.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
insert into public.saas_leads (name, email, phone, school_name, status, owner_name, owner_email, owner_phone,
  estimated_students, estimated_teachers, source, plan_interest, lead_type, notes)
values ('Teste Professora', 'lp-lead@example.invalid', '11999990000', 'Aulas da Teste', 'new', 'Teste Professora',
  'lp-lead@example.invalid', '11999990000', 12, 1, 'teacher_signup', 'Professor Negócio', 'teacher',
  'Principal gargalo informado: cobrança manual');
reset role;
select set_config('request.jwt.claims', '', true);

select pg_temp.assert_true(
  (select count(*) from public.notification_queue q join public.saas_leads l on q.idempotency_key = 'saas_lead:' || l.id::text
    where l.email = 'lp-lead@example.invalid' and q.tenant_id = 'lead-prof-school'
      and q.student_phone = '120363000000000001@g.us' and q.notification_kind = 'MANAGEMENT_NOTICE'
      and q.teacher_id = '00000000-0000-4000-8000-0000000a9d01' and q.status = 'pending'
      and q.message_body like '%Professor Negócio%' and q.message_body like '%wa.me/5511999990000%'
      and q.message_body like '%Aulas da Teste%' and q.message_body like '%cobrança manual%') = 1,
  'lead de professor não enfileirou o aviso no grupo da Gestão'
);

-- 2) Conversão pelo service_role: tenant em trial, assinatura, lead CONVERTED.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
create temporary table lp_result as
select public.convert_teacher_lead_to_tenant(
  (select id from public.saas_leads where email = 'lp-lead@example.invalid'),
  '00000000-0000-4000-8000-0000000a9d51', 'aulas-da-teste', 'Aulas da Teste', 14, null) as r;
select pg_temp.assert_true(
  (select (r ->> 'ok')::boolean and (r ->> 'tenant_id') = 'aulas-da-teste' and (r ->> 'owner_email') = 'lp-lead@example.invalid'
     and (r ->> 'already_converted')::boolean is false from lp_result),
  'conversão do lead devolveu resultado errado'
);
-- Repetir não duplica: devolve o tenant já criado.
select pg_temp.assert_true(
  (select (r ->> 'already_converted')::boolean and (r ->> 'tenant_id') = 'aulas-da-teste'
     from public.convert_teacher_lead_to_tenant(
       (select id from public.saas_leads where email = 'lp-lead@example.invalid'),
       '00000000-0000-4000-8000-0000000a9d51', 'outro-slug', 'Outro', 14, null) as r),
  'segunda conversão do mesmo lead deveria ser idempotente'
);
-- Recusas: plano de escola, slug reservado, lead inexistente.
insert into public.saas_leads (name, email, phone, school_name, status, owner_name, owner_email, estimated_teachers, source, plan_interest, lead_type)
values ('Outra Prof', 'lp-lead2@example.invalid', '11999990001', 'Outra Marca', 'new', 'Outra Prof', 'lp-lead2@example.invalid', 1, 'teacher_signup', 'Professor Negócio', 'teacher');
select pg_temp.assert_true(
  (select r ->> 'error' from public.convert_teacher_lead_to_tenant(
      (select id from public.saas_leads where email = 'lp-lead2@example.invalid'),
      '00000000-0000-4000-8000-0000000a9d52', 'outra-marca', 'Outra Marca', 14, null) as r) = 'plano_nao_e_de_professor'
  and (select r ->> 'error' from public.convert_teacher_lead_to_tenant(
      (select id from public.saas_leads where email = 'lp-lead2@example.invalid'),
      '00000000-0000-4000-8000-0000000a9d51', 'master', 'Outra Marca', 14, null) as r) = 'slug_reservado'
  and (select r ->> 'error' from public.convert_teacher_lead_to_tenant(
      gen_random_uuid(), '00000000-0000-4000-8000-0000000a9d51', 'x-y', 'X', 14, null) as r) = 'lead_nao_encontrado',
  'recusas da conversão não bateram'
);
reset role;
select set_config('request.jwt.claims', '', true);

select pg_temp.assert_true(
  (select t.tenant_type = 'teacher' and t.saas_status = 'trial' and t.plan_id = '00000000-0000-4000-8000-0000000a9d51'
     and t.owner_email = 'lp-lead@example.invalid' and t.trial_ends_at > now() + interval '13 days'
     from public.tenants t where t.id = 'aulas-da-teste')
  and (select count(*) from public.saas_subscriptions s where s.tenant_id = 'aulas-da-teste' and s.status = 'trial') = 1
  and (select l.status = 'CONVERTED' and l.converted_tenant_id = 'aulas-da-teste' from public.saas_leads l where l.email = 'lp-lead@example.invalid')
  and (select count(*) from public.tenants where id = 'outra-marca') = 0,
  'estado final do tenant/assinatura/lead errado'
);

rollback;
