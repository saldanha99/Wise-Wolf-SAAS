-- Cobertura do dia: uma oportunidade por aula, oferecida a todos os
-- professores livres; o primeiro aceite vira class_coverages, os outros perdem.

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
  not has_function_privilege('anon', 'public.gestao_open_coverage_day(text,uuid,text,uuid,date,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_coverage_opportunity(text,boolean)', 'EXECUTE'),
  'RPCs da cobertura do dia executáveis fora do service_role'
);

insert into public.tenants (id, name) values ('cobertura-dia-school', 'Cobertura Dia School') on conflict (id) do nothing;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000cd01', 'authenticated', 'authenticated', 'cd-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora CD"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cd11', 'authenticated', 'authenticated', 'cd-ausente@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Ausente"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cd12', 'authenticated', 'authenticated', 'cd-livre-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Livre A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cd13', 'authenticated', 'authenticated', 'cd-livre-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Livre B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cd14', 'authenticated', 'authenticated', 'cd-ocupado@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Ocupado"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cd21', 'authenticated', 'authenticated', 'cd-aluno@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Coberto"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cd22', 'authenticated', 'authenticated', 'cd-aluno2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Do Ocupado"}', now(), now());

update public.profiles set tenant_id = 'cobertura-dia-school', role = 'SCHOOL_ADMIN', lifecycle_status = 'active' where id = '00000000-0000-4000-8000-00000000cd01';
update public.profiles set tenant_id = 'cobertura-dia-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880001'
 where id in ('00000000-0000-4000-8000-00000000cd11');
update public.profiles set tenant_id = 'cobertura-dia-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880002' where id = '00000000-0000-4000-8000-00000000cd12';
update public.profiles set tenant_id = 'cobertura-dia-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880003' where id = '00000000-0000-4000-8000-00000000cd13';
update public.profiles set tenant_id = 'cobertura-dia-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880004' where id = '00000000-0000-4000-8000-00000000cd14';
update public.profiles set tenant_id = 'cobertura-dia-school', role = 'STUDENT', lifecycle_status = 'active', phone = '11977770001' where id in ('00000000-0000-4000-8000-00000000cd21', '00000000-0000-4000-8000-00000000cd22');

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000cd01', 'cobertura-dia-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cd11', 'cobertura-dia-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cd12', 'cobertura-dia-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cd13', 'cobertura-dia-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cd14', 'cobertura-dia-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cd21', 'cobertura-dia-school', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cd22', 'cobertura-dia-school', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

-- Amanhã (no fuso da escola), no dia da semana que for.
create temp table cd as
select ((now() at time zone 'America/Sao_Paulo')::date + 1) as dia,
       extract(dow from (now() at time zone 'America/Sao_Paulo')::date + 1)::int as dow,
       (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from (now() at time zone 'America/Sao_Paulo')::date + 1)::int + 1] as dia_nome;

-- Livres A e B têm 19:00 na grade; Ocupado tem a grade mas já dá aula às 19:00.
insert into public.teacher_availability (teacher_id, tenant_id, day_of_week, start_time, end_time)
select t, 'cobertura-dia-school', (select dow from cd), '19:00', null
  from unnest(array['00000000-0000-4000-8000-00000000cd12','00000000-0000-4000-8000-00000000cd13','00000000-0000-4000-8000-00000000cd14']::uuid[]) t;

insert into public.bookings (tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status) values
  ('cobertura-dia-school', '00000000-0000-4000-8000-00000000cd11', '00000000-0000-4000-8000-00000000cd21', (select dia_nome from cd), '19:00', null, '2026-01-05', 'SCHEDULED'),
  ('cobertura-dia-school', '00000000-0000-4000-8000-00000000cd14', '00000000-0000-4000-8000-00000000cd22', (select dia_nome from cd), '19:00', null, '2026-01-05', 'SCHEDULED');

grant select on cd to service_role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

create temp table r as
select public.gestao_open_coverage_day('cobertura-dia-school', '00000000-0000-4000-8000-00000000cd01', 'teste-cobertura-dia-01',
         '00000000-0000-4000-8000-00000000cd11', (select dia from cd), 'garganta inflamada', 'group') as j;

select pg_temp.assert_true((select (j->>'ok')::boolean from r), 'abrir cobertura do dia falhou: ' || (select j::text from r));
select pg_temp.assert_true((select jsonb_array_length(j->'opportunities') from r) = 1, 'esperava 1 oportunidade');
select pg_temp.assert_true(
  (select jsonb_array_length(j->'opportunities'->0->'invites') from r) = 2,
  'esperava 2 candidatos (os livres); o ocupado não pode entrar'
);
select pg_temp.assert_true(
  not exists (select 1 from jsonb_array_elements((select j->'opportunities'->0->'invites' from r)) i
               where i->>'teacher_id' = '00000000-0000-4000-8000-00000000cd14'),
  'professor com aula no horário foi convidado'
);
select pg_temp.assert_true(
  (select public.gestao_open_coverage_day('cobertura-dia-school', '00000000-0000-4000-8000-00000000cd01', 'teste-cobertura-dia-01',
          '00000000-0000-4000-8000-00000000cd11', (select dia from cd), 'garganta inflamada', 'group')->>'idempotent')::boolean,
  'reprocessar a mesma confirmação deveria ser idempotente'
);

create temp table inv as
select (i->>'token') as token, (i->>'teacher_id')::uuid as teacher_id
  from jsonb_array_elements((select j->'opportunities'->0->'invites' from r)) i;

-- Primeiro aceite leva; o segundo perde; repetir o primeiro é idempotente.
select pg_temp.assert_true(
  (select public.claim_coverage_opportunity(token)->>'status' from inv where teacher_id = '00000000-0000-4000-8000-00000000cd12') = 'ACCEPTED',
  'primeiro aceite deveria vencer'
);
select pg_temp.assert_true(
  (select public.claim_coverage_opportunity(token)->>'error' from inv where teacher_id = '00000000-0000-4000-8000-00000000cd13') in ('convite_encerrado', 'ja_coberta'),
  'segundo aceite deveria perder'
);
select pg_temp.assert_true(
  (select (public.claim_coverage_opportunity(token)->>'already')::boolean from inv where teacher_id = '00000000-0000-4000-8000-00000000cd12'),
  'repetir o aceite vencedor deveria ser idempotente'
);

reset role;
select pg_temp.assert_true(
  exists (select 1 from public.class_coverages c
           where c.tenant_id = 'cobertura-dia-school' and c.cover_teacher_id = '00000000-0000-4000-8000-00000000cd12'
             and lower(c.status) = 'confirmed' and c.confirmed_by is null),
  'class_coverages confirmada para o vencedor, sem confirmed_by (aceite pelo link)'
);
select pg_temp.assert_true(
  (select o.status from public.coverage_opportunities o where o.tenant_id = 'cobertura-dia-school') = 'CLAIMED'
  and (select string_agg(i.status, ',' order by i.status) from public.coverage_opportunity_invites i
         join public.coverage_opportunities o on o.id = i.opportunity_id where o.tenant_id = 'cobertura-dia-school') = 'ACCEPTED,LOST',
  'estado final da oportunidade/convites errado'
);
select pg_temp.assert_true(
  (select lower(status) || '/' || reason from public.teacher_absences where teacher_id = '00000000-0000-4000-8000-00000000cd11') = 'active/SICK',
  'ausência do dia não ficou ACTIVE/SICK'
);

rollback;
