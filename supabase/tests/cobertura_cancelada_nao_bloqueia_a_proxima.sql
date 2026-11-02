-- Convite de cobertura recusado não bloqueia convidar outro professor para a
-- mesma aula; e a aula pode ser atestada depois mesmo com convite cancelado.
--
-- Caso real (18/09/2026): o atestado do Theo morria em
-- class_coverages_booking_id_class_date_key por causa do convite cancelado.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

-- A UNIQUE cheia saiu; a unicidade vale só para a cobertura que valeu.
select pg_temp.assert_true(
  not exists (select 1 from pg_constraint
               where conrelid = 'public.class_coverages'::regclass
                 and conname = 'class_coverages_booking_id_class_date_key'),
  'UNIQUE (booking_id, class_date) cheia ainda existe em class_coverages'
);
select pg_temp.assert_true(
  exists (select 1 from pg_indexes
           where schemaname = 'public' and tablename = 'class_coverages'
             and indexname = 'class_coverages_live_booking_date_uidx'
             and indexdef ilike '%WHERE%confirmed%'),
  'índice parcial class_coverages_live_booking_date_uidx ausente ou sem o predicado'
);

insert into public.tenants (id, name) values ('cobertura-recusa-school', 'Cobertura Recusa School') on conflict (id) do nothing;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000cf01', 'authenticated', 'authenticated', 'cf-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora CF"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cf11', 'authenticated', 'authenticated', 'cf-ausente@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Ausente"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cf12', 'authenticated', 'authenticated', 'cf-livre-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Livre A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cf13', 'authenticated', 'authenticated', 'cf-livre-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Livre B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000cf21', 'authenticated', 'authenticated', 'cf-aluno@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Coberto"}', now(), now());

update public.profiles set tenant_id = 'cobertura-recusa-school', role = 'SCHOOL_ADMIN', lifecycle_status = 'active' where id = '00000000-0000-4000-8000-00000000cf01';
update public.profiles set tenant_id = 'cobertura-recusa-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880021' where id = '00000000-0000-4000-8000-00000000cf11';
update public.profiles set tenant_id = 'cobertura-recusa-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880022' where id = '00000000-0000-4000-8000-00000000cf12';
update public.profiles set tenant_id = 'cobertura-recusa-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880023' where id = '00000000-0000-4000-8000-00000000cf13';
update public.profiles set tenant_id = 'cobertura-recusa-school', role = 'STUDENT', lifecycle_status = 'active', phone = '11977770021' where id = '00000000-0000-4000-8000-00000000cf21';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000cf01', 'cobertura-recusa-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cf11', 'cobertura-recusa-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cf12', 'cobertura-recusa-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cf13', 'cobertura-recusa-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000cf21', 'cobertura-recusa-school', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

create temp table cd as
select ((now() at time zone 'America/Sao_Paulo')::date + 1) as dia,
       extract(dow from (now() at time zone 'America/Sao_Paulo')::date + 1)::int as dow,
       (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from (now() at time zone 'America/Sao_Paulo')::date + 1)::int + 1] as dia_nome;

insert into public.teacher_availability (teacher_id, tenant_id, day_of_week, start_time, end_time)
select t, 'cobertura-recusa-school', (select dow from cd), '19:00', null
  from unnest(array['00000000-0000-4000-8000-00000000cf12','00000000-0000-4000-8000-00000000cf13']::uuid[]) t;

insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status) values
  ('00000000-0000-4000-8000-00000000cfb1', 'cobertura-recusa-school', '00000000-0000-4000-8000-00000000cf11', '00000000-0000-4000-8000-00000000cf21', (select dia_nome from cd), '19:00', null, '2026-01-05', 'SCHEDULED');

grant select on cd to service_role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- Convite para o Livre A, que recusa.
create temp table c1 as
select public.gestao_create_coverage_invite('cobertura-recusa-school', '00000000-0000-4000-8000-00000000cf01',
  '00000000-0000-4000-8000-00000000cfb1', '00000000-0000-4000-8000-00000000cf12', (select dia from cd), '19:00',
  'garganta inflamada', 'teste-recusa-convite-01') as j;
select pg_temp.assert_true((select (j->>'ok')::boolean from c1), 'primeiro convite falhou: ' || (select j::text from c1));
select pg_temp.assert_true(
  (select public.resolve_coverage_invite(j->>'token', false)->>'status' from c1) = 'declined',
  'recusa do primeiro convite não ficou declined'
);

-- A mesma aula pode ser oferecida ao Livre B — antes morria na UNIQUE cheia.
create temp table c2 as
select public.gestao_create_coverage_invite('cobertura-recusa-school', '00000000-0000-4000-8000-00000000cf01',
  '00000000-0000-4000-8000-00000000cfb1', '00000000-0000-4000-8000-00000000cf13', (select dia from cd), '19:00',
  'garganta inflamada', 'teste-recusa-convite-02') as j;
select pg_temp.assert_true(
  (select (j->>'ok')::boolean from c2) and (select j->>'status' from c2) = 'pending',
  'segundo convite para a mesma aula falhou depois da recusa: ' || (select j::text from c2)
);
select pg_temp.assert_true(
  (select public.resolve_coverage_invite(j->>'token', true)->>'status' from c2) = 'confirmed',
  'aceite do segundo convite não confirmou'
);
reset role;

-- Continua havendo UMA cobertura confirmada por aula.
select pg_temp.assert_true(
  (select count(*) from public.class_coverages
    where booking_id = '00000000-0000-4000-8000-00000000cfb1' and lower(status) = 'confirmed') = 1
  and (select count(*) from public.class_coverages
        where booking_id = '00000000-0000-4000-8000-00000000cfb1') = 2,
  'esperava 1 confirmada + 1 recusada para a mesma aula'
);

rollback;
