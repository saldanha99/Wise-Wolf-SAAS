-- O substituto enxerga o aluno cuja aula ele cobre; quem perdeu a disputa, não.
-- Reposição atribuída a um professor também abre o aluno para ele.
--
-- Caso real (18/09/2026): a Bruna tinha três coberturas confirmadas de 16/09 e
-- o Lançar Aula mostrava nada — `profiles` não a deixava ler Victor Hugo nem
-- Vinícius, e o join `student:student_id(...)` voltava nulo.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

-- O predicado da policy conhece cobertura confirmada e reposição atribuída.
select pg_temp.assert_true(
  pg_get_functiondef('public._teacher_can_access_student(uuid,text)'::regprocedure) ilike '%class_coverages%'
  and pg_get_functiondef('public._teacher_can_access_student(uuid,text)'::regprocedure) ilike '%reschedules%',
  '_teacher_can_access_student sem o ramo de cobertura/reposição'
);
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public._teacher_can_access_student(uuid,text)', 'EXECUTE'),
  '_teacher_can_access_student executável por anon'
);

insert into public.tenants (id, name) values ('substituto-ve-school', 'Substituto Ve School') on conflict (id) do nothing;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000ce01', 'authenticated', 'authenticated', 'ce-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora CE"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ce11', 'authenticated', 'authenticated', 'ce-ausente@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Ausente"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ce12', 'authenticated', 'authenticated', 'ce-livre-a@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Livre A"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ce13', 'authenticated', 'authenticated', 'ce-livre-b@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Livre B"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ce21', 'authenticated', 'authenticated', 'ce-aluno@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Coberto"}', now(), now()),
  ('00000000-0000-4000-8000-00000000ce22', 'authenticated', 'authenticated', 'ce-aluno2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Da Reposicao"}', now(), now());

update public.profiles set tenant_id = 'substituto-ve-school', role = 'SCHOOL_ADMIN', lifecycle_status = 'active' where id = '00000000-0000-4000-8000-00000000ce01';
update public.profiles set tenant_id = 'substituto-ve-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880011' where id = '00000000-0000-4000-8000-00000000ce11';
update public.profiles set tenant_id = 'substituto-ve-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880012' where id = '00000000-0000-4000-8000-00000000ce12';
update public.profiles set tenant_id = 'substituto-ve-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 20, phone = '11988880013' where id = '00000000-0000-4000-8000-00000000ce13';
update public.profiles set tenant_id = 'substituto-ve-school', role = 'STUDENT', lifecycle_status = 'active', phone = '11977770011' where id in ('00000000-0000-4000-8000-00000000ce21', '00000000-0000-4000-8000-00000000ce22');

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000ce01', 'substituto-ve-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ce11', 'substituto-ve-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ce12', 'substituto-ve-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ce13', 'substituto-ve-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ce21', 'substituto-ve-school', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000ce22', 'substituto-ve-school', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

create temp table cd as
select ((now() at time zone 'America/Sao_Paulo')::date + 1) as dia,
       extract(dow from (now() at time zone 'America/Sao_Paulo')::date + 1)::int as dow,
       (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from (now() at time zone 'America/Sao_Paulo')::date + 1)::int + 1] as dia_nome;

insert into public.teacher_availability (teacher_id, tenant_id, day_of_week, start_time, end_time)
select t, 'substituto-ve-school', (select dow from cd), '19:00', null
  from unnest(array['00000000-0000-4000-8000-00000000ce12','00000000-0000-4000-8000-00000000ce13']::uuid[]) t;

insert into public.bookings (tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status) values
  ('substituto-ve-school', '00000000-0000-4000-8000-00000000ce11', '00000000-0000-4000-8000-00000000ce21', (select dia_nome from cd), '19:00', null, '2026-01-05', 'SCHEDULED');

-- Reposição de um aluno de OUTRO professor, atribuída ao Livre B, JÁ MARCADA.
-- A data importa: desde 20260922040028 só reposição com data dentro da janela
-- de 7 dias abre o aluno. Reposição parada em "Pendente" há meses é registro
-- histórico e NÃO pode abrir — ver a asserção do fantasma mais abaixo.
insert into public.reschedules (tenant_id, teacher_id, student_id, date, time, fault_type)
values ('substituto-ve-school', '00000000-0000-4000-8000-00000000ce13', '00000000-0000-4000-8000-00000000ce22',
        to_char(current_date, 'YYYY-MM-DD'), '19:00', 'TEACHER');

-- Antes da cobertura: nenhum dos dois livres enxerga o Aluno Coberto.
create or replace function pg_temp.ve(p_teacher uuid, p_student uuid) returns boolean
language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_teacher, 'role', 'authenticated')::text, true);
  select count(*) into n from public.profiles where id = p_student
     and public._teacher_can_access_student(id, tenant_id);
  perform set_config('request.jwt.claims', '', true);
  return n = 1;
end $$;

select pg_temp.assert_true(
  not pg_temp.ve('00000000-0000-4000-8000-00000000ce12', '00000000-0000-4000-8000-00000000ce21')
  and not pg_temp.ve('00000000-0000-4000-8000-00000000ce13', '00000000-0000-4000-8000-00000000ce21'),
  'sem cobertura, professor sem vínculo já enxergava o aluno'
);
select pg_temp.assert_true(
  pg_temp.ve('00000000-0000-4000-8000-00000000ce13', '00000000-0000-4000-8000-00000000ce22')
  and not pg_temp.ve('00000000-0000-4000-8000-00000000ce12', '00000000-0000-4000-8000-00000000ce22'),
  'reposição atribuída não abriu o aluno para o professor dela (ou abriu para outro)'
);

-- Reposição FANTASMA: a mesma linha, parada sem data. Medido em 23/09/2026, era
-- assim que Beatrís (sem aluno nenhum) enxergava dois alunos de outros
-- professores por reposições de 09/06 — e o Flávio via o Anderson, que hoje é
-- da Lais. Registro velho não dá acesso.
update public.reschedules set date = 'Pendente', time = 'Pendente'
 where tenant_id = 'substituto-ve-school'
   and teacher_id = '00000000-0000-4000-8000-00000000ce13';
select pg_temp.assert_true(
  not pg_temp.ve('00000000-0000-4000-8000-00000000ce13', '00000000-0000-4000-8000-00000000ce22'),
  'reposição parada sem data abriu o aluno — é registro histórico, não pode'
);
update public.reschedules set date = to_char(current_date - 30, 'YYYY-MM-DD'), time = '19:00'
 where tenant_id = 'substituto-ve-school'
   and teacher_id = '00000000-0000-4000-8000-00000000ce13';
select pg_temp.assert_true(
  not pg_temp.ve('00000000-0000-4000-8000-00000000ce13', '00000000-0000-4000-8000-00000000ce22'),
  'reposição de 30 dias atrás abriu o aluno — está fora da janela de 7 dias'
);

grant select on cd to service_role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

create temp table r as
select public.gestao_open_coverage_day('substituto-ve-school', '00000000-0000-4000-8000-00000000ce01', 'teste-substituto-ve-01',
         '00000000-0000-4000-8000-00000000ce11', (select dia from cd), 'garganta inflamada', 'group') as j;
select pg_temp.assert_true((select (j->>'ok')::boolean from r), 'abrir cobertura do dia falhou: ' || (select j::text from r));

create temp table inv as
select (i->>'token') as token, (i->>'teacher_id')::uuid as teacher_id
  from jsonb_array_elements((select j->'opportunities'->0->'invites' from r)) i;

-- Livre A aceita e vence; Livre B perde.
select pg_temp.assert_true(
  (select public.claim_coverage_opportunity(token)->>'status' from inv where teacher_id = '00000000-0000-4000-8000-00000000ce12') = 'ACCEPTED',
  'primeiro aceite deveria vencer'
);
reset role;

select pg_temp.assert_true(
  exists (select 1 from public.class_coverages c
           where c.tenant_id = 'substituto-ve-school' and c.cover_teacher_id = '00000000-0000-4000-8000-00000000ce12'
             and lower(c.status) = 'confirmed'),
  'cobertura confirmada não existe'
);

-- Quem cobre passa a ver o aluno; quem perdeu a disputa continua sem ver.
select pg_temp.assert_true(
  pg_temp.ve('00000000-0000-4000-8000-00000000ce12', '00000000-0000-4000-8000-00000000ce21'),
  'substituto com cobertura confirmada não enxerga o aluno'
);
select pg_temp.assert_true(
  not pg_temp.ve('00000000-0000-4000-8000-00000000ce13', '00000000-0000-4000-8000-00000000ce21'),
  'professor que perdeu a disputa (convite LOST) enxerga o aluno'
);

-- E é o que a policy de leitura aplica de fato, na sessão do substituto.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000ce12","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.assert_true(
  (select count(*) from public.profiles where id = '00000000-0000-4000-8000-00000000ce21') = 1,
  'policy profiles_scoped_read_p1 não deixou o substituto ler o aluno coberto'
);
reset role;

rollback;
