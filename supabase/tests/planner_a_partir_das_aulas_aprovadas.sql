-- Planner IA: quem pode planejar para qual aluno (migration 20260927130000).
--
-- A edge lesson-planner recusava todo professor sem agendamento próprio com o
-- aluno. Agora aceita também o segundo professor (professor_id2), o substituto
-- com cobertura confirmada e o professor da reposição COM DATA — os dois
-- últimos só do dia anterior ao dia seguinte da aula. Reposição sem data,
-- encerrada pela direção ou fora da janela não abre nada (o acesso fantasma de
-- 20260923130000 não volta por aqui).
--
-- E a última decisão humana sobre o resumo da aula vale: resumo aprovado e
-- depois REJEITADO sai da memória do aluno (e portanto do Planner, que lê só
-- MEET_SESSION VERIFIED) — antes a memória ficava VERIFIED para sempre — e da
-- tela "Sala e resumo" de quem não vê a fonte (segundo professor, suporte).
--
-- Reprova contra o código anterior: sem a migration as funções não existem, a
-- regra de leitura de perfis (_teacher_can_access_student) dá resposta
-- diferente nos casos marcados abaixo, e a rejeição não mexia na memória. Não
-- depende de dado real nem do horário: a data de referência é a de São Paulo no
-- início da transação, a mesma que as funções usam.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Estrutura e privilégios
-- ---------------------------------------------------------------------------
select pg_temp.assert_true(
  to_regprocedure('private.planner_student_access(uuid,text,date)') is not null
  and to_regprocedure('public.planner_teacher_can_access_student(uuid,uuid,text)') is not null
  and to_regprocedure('public.my_planner_students()') is not null,
  'funções do acesso do Planner não existem'
);

select pg_temp.assert_true(
  (select bool_and(p.prosecdef
            and pg_get_userbyid(p.proowner) = 'postgres'
            and p.proconfig @> array['search_path=""'])
     from pg_proc p
    where p.oid in (
      'private.planner_student_access(uuid,text,date)'::regprocedure,
      'public.planner_teacher_can_access_student(uuid,uuid,text)'::regprocedure,
      'public.my_planner_students()'::regprocedure)),
  'acesso do Planner sem SECURITY DEFINER, sem search_path vazio ou sem dono postgres'
);

select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.planner_teacher_can_access_student(uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.planner_teacher_can_access_student(uuid,uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.planner_teacher_can_access_student(uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.my_planner_students()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.my_planner_students()', 'EXECUTE')
  and not has_function_privilege('anon', 'private.planner_student_access(uuid,text,date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.planner_student_access(uuid,text,date)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.planner_student_access(uuid,text,date)', 'EXECUTE'),
  'privilégios do acesso do Planner fora do desenho (anon/authenticated/service_role)'
);

-- ---------------------------------------------------------------------------
-- Cenário (escola própria do teste)
-- ---------------------------------------------------------------------------
create temp table pd as
select (now() at time zone 'America/Sao_Paulo')::date as d;
grant select on pd to authenticated, service_role;

insert into public.tenants (id, name) values
  ('planner-aulas-school', 'Planner Aulas School'),
  ('planner-aulas-outra', 'Planner Aulas Outra')
on conflict (id) do nothing;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select v.id::uuid, 'authenticated', 'authenticated', v.email,
       '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', v.nome), now(), now()
from (values
  ('00000000-0000-4000-8000-00000000fa01', 'pa-titular@example.invalid', 'Prof Titular'),
  ('00000000-0000-4000-8000-00000000fa02', 'pa-segundo@example.invalid', 'Prof Segundo'),
  ('00000000-0000-4000-8000-00000000fa03', 'pa-substituto@example.invalid', 'Prof Substituto'),
  ('00000000-0000-4000-8000-00000000fa04', 'pa-reposicao@example.invalid', 'Prof Reposicao'),
  ('00000000-0000-4000-8000-00000000fa05', 'pa-inativo@example.invalid', 'Prof Inativo'),
  ('00000000-0000-4000-8000-00000000fb01', 'pa-aluno-a@example.invalid', 'Aluno A'),
  ('00000000-0000-4000-8000-00000000fb02', 'pa-cob-ontem@example.invalid', 'Aluno Cobertura Ontem'),
  ('00000000-0000-4000-8000-00000000fb03', 'pa-cob-amanha@example.invalid', 'Aluno Cobertura Amanha'),
  ('00000000-0000-4000-8000-00000000fb04', 'pa-cob-antiga@example.invalid', 'Aluno Cobertura Antiga'),
  ('00000000-0000-4000-8000-00000000fb05', 'pa-cob-futura@example.invalid', 'Aluno Cobertura Futura'),
  ('00000000-0000-4000-8000-00000000fb06', 'pa-cob-cancelada@example.invalid', 'Aluno Cobertura Cancelada'),
  ('00000000-0000-4000-8000-00000000fb07', 'pa-repo-amanha@example.invalid', 'Aluno Reposicao Amanha'),
  ('00000000-0000-4000-8000-00000000fb08', 'pa-repo-pendente@example.invalid', 'Aluno Reposicao Pendente'),
  ('00000000-0000-4000-8000-00000000fb09', 'pa-repo-antiga@example.invalid', 'Aluno Reposicao Antiga'),
  ('00000000-0000-4000-8000-00000000fb10', 'pa-repo-encerrada@example.invalid', 'Aluno Reposicao Encerrada'),
  ('00000000-0000-4000-8000-00000000fb11', 'pa-repo-dada@example.invalid', 'Aluno Reposicao Dada'),
  ('00000000-0000-4000-8000-00000000fb12', 'pa-inativo-aluno@example.invalid', 'Aluno Inativo'),
  ('00000000-0000-4000-8000-00000000fb13', 'pa-sem-agenda@example.invalid', 'Aluno Sem Agenda'),
  ('00000000-0000-4000-8000-00000000fb14', 'pa-agenda-velha@example.invalid', 'Aluno Agenda Velha'),
  ('00000000-0000-4000-8000-00000000fa06', 'pa-meet@example.invalid', 'Prof Meet'),
  ('00000000-0000-4000-8000-00000000fb15', 'pa-meet-aluno@example.invalid', 'Aluno Meet')
) as v(id, email, nome);

-- Os gatilhos de perfil, agenda, cobertura e reposição (atribuição só pela
-- direção, choque de horário, trilha e avisos de reposição) não são o que se
-- testa aqui; sem eles o cenário fica exato e nada vai para fila nenhuma.
set local session_replication_role = replica;

update public.profiles
   set tenant_id = 'planner-aulas-school', role = 'TEACHER', status = 'Ativo', lifecycle_status = 'active'
 where id in ('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fa02',
              '00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fa04');
update public.profiles
   set tenant_id = 'planner-aulas-school', role = 'TEACHER', status = 'Inativo', lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000fa05';
update public.profiles
   set tenant_id = 'planner-aulas-school', role = 'TEACHER', status = 'Ativo', lifecycle_status = 'active'
 where id = '00000000-0000-4000-8000-00000000fa06';
update public.profiles
   set tenant_id = 'planner-aulas-school', role = 'STUDENT', status = 'Ativo', lifecycle_status = 'active',
       module = 'A2', professor_id = null, professor_id2 = null
 where id::text like '00000000-0000-4000-8000-00000000fb%';
update public.profiles set status = 'Inativo' where id = '00000000-0000-4000-8000-00000000fb12';
-- Aluno A: titular com agenda viva, segundo professor atribuído pela direção.
update public.profiles
   set professor_id = '00000000-0000-4000-8000-00000000fa01',
       professor_id2 = '00000000-0000-4000-8000-00000000fa02'
 where id = '00000000-0000-4000-8000-00000000fb01';
-- Titular sem agenda nenhuma.
update public.profiles set professor_id = '00000000-0000-4000-8000-00000000fa04'
 where id = '00000000-0000-4000-8000-00000000fb13';
-- Aluno da aula no Meet (resumo aprovado e depois rejeitado).
update public.profiles set professor_id = '00000000-0000-4000-8000-00000000fa06'
 where id = '00000000-0000-4000-8000-00000000fb15';
insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
  scheduled_start_at, scheduled_end_at, source_key, documentation_consent)
select '00000000-0000-4000-8000-00000000fc01', 'planner-aulas-school',
       '00000000-0000-4000-8000-00000000fb15', '00000000-0000-4000-8000-00000000fa06',
       pd.d - 1, now() - interval '1 day', now() - interval '1 day' + interval '30 minutes',
       'planner-aulas-meet-fixture', true
from pd;

insert into public.bookings (tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select 'planner-aulas-school', b.teacher_id::uuid, b.student_id::uuid, 'Segunda', b.hora, b.dia, '2026-01-05', 'SCHEDULED'
from pd,
lateral (values
  ('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb01', '19:00', null::date),
  ('00000000-0000-4000-8000-00000000fa05', '00000000-0000-4000-8000-00000000fb01', '20:00', null::date),
  ('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb12', '19:30', null::date),
  -- Aula avulsa de 10 dias atrás: agenda que já passou não abre o aluno.
  ('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb14', '18:00', pd.d - 10)
) as b(teacher_id, student_id, hora, dia);

insert into public.class_coverages (tenant_id, original_teacher_id, cover_teacher_id, student_id, class_date, class_time, status, confirmed_at)
select 'planner-aulas-school', '00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fa03',
       c.student_id::uuid, pd.d + c.delta, '10:00', c.status, now()
from pd,
lateral (values
  ('00000000-0000-4000-8000-00000000fb02', -1, 'confirmed'),
  ('00000000-0000-4000-8000-00000000fb03', 1, 'confirmed'),
  ('00000000-0000-4000-8000-00000000fb04', -2, 'confirmed'),
  ('00000000-0000-4000-8000-00000000fb05', 2, 'confirmed'),
  ('00000000-0000-4000-8000-00000000fb06', 0, 'cancelled')
) as c(student_id, delta, status);

insert into public.reschedules (tenant_id, teacher_id, student_id, date, time, fault_type, used_at, closed_reason)
select 'planner-aulas-school', '00000000-0000-4000-8000-00000000fa04', r.student_id::uuid,
       r.dia, '15:00', 'STUDENT', r.used_at, r.closed_reason
from pd,
lateral (values
  ('00000000-0000-4000-8000-00000000fb07', to_char(pd.d + 1, 'YYYY-MM-DD'), null::timestamptz, null::text),
  ('00000000-0000-4000-8000-00000000fb08', 'Pendente', null::timestamptz, null::text),
  ('00000000-0000-4000-8000-00000000fb09', to_char(pd.d - 2, 'YYYY-MM-DD'), null::timestamptz, null::text),
  ('00000000-0000-4000-8000-00000000fb10', to_char(pd.d, 'YYYY-MM-DD'), now(), 'aluno saiu da escola'),
  ('00000000-0000-4000-8000-00000000fb11', to_char(pd.d - 1, 'YYYY-MM-DD'), now(), null::text)
) as r(student_id, dia, used_at, closed_reason);

set local session_replication_role = origin;

-- Regra de leitura de perfis, para mostrar onde o Planner é diferente dela.
create or replace function pg_temp.regra_de_perfis(p_teacher uuid, p_student uuid) returns boolean
language plpgsql as $$
declare v boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_teacher, 'role', 'authenticated')::text, true);
  v := public._teacher_can_access_student(p_student, 'planner-aulas-school');
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create or replace function pg_temp.planner(p_teacher text, p_student text, p_tenant text default 'planner-aulas-school')
returns text language sql as $$
  select public.planner_teacher_can_access_student(p_teacher::uuid, p_student::uuid, p_tenant);
$$;
grant execute on function pg_temp.planner(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Onde a regra do Planner difere da regra de leitura de perfis
-- ---------------------------------------------------------------------------
select pg_temp.assert_true(
  not pg_temp.regra_de_perfis('00000000-0000-4000-8000-00000000fa02', '00000000-0000-4000-8000-00000000fb01'),
  'fixture: segundo professor já passava pela regra de perfis (o aluno tem agenda viva com o titular)'
);
select pg_temp.assert_true(
  pg_temp.regra_de_perfis('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb04')
  and pg_temp.regra_de_perfis('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb05'),
  'fixture: a regra de perfis deveria aceitar cobertura de 2 dias atrás e de daqui a 2 dias'
);

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb01') = 'BOOKING',
  'titular com agenda viva não planeja para o próprio aluno'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa02', '00000000-0000-4000-8000-00000000fb01') = 'SECOND_TEACHER',
  'segundo professor do aluno (professor_id2) não planeja para ele'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb02') = 'COVERAGE'
  and pg_temp.planner('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb03') = 'COVERAGE',
  'substituto com cobertura confirmada (ontem / amanhã) não planeja para o aluno coberto'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb04') is null
  and pg_temp.planner('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb05') is null,
  'cobertura fora da janela (2 dias antes / 2 dias depois) abriu o aluno no Planner'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb06') is null,
  'cobertura cancelada abriu o aluno no Planner'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb02') is null
  and pg_temp.planner('00000000-0000-4000-8000-00000000fa03', '00000000-0000-4000-8000-00000000fb01') is null,
  'quem cedeu a aula ganhou o aluno coberto, ou o substituto ganhou aluno sem cobertura'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa04', '00000000-0000-4000-8000-00000000fb07') = 'RESCHEDULE'
  and pg_temp.planner('00000000-0000-4000-8000-00000000fa04', '00000000-0000-4000-8000-00000000fb11') = 'RESCHEDULE',
  'reposição com data na janela (amanhã / dada ontem) não abriu o aluno para o professor dela'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa04', '00000000-0000-4000-8000-00000000fb08') is null,
  'reposição parada em "Pendente" abriu o aluno — é o acesso fantasma'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa04', '00000000-0000-4000-8000-00000000fb09') is null
  and pg_temp.planner('00000000-0000-4000-8000-00000000fa04', '00000000-0000-4000-8000-00000000fb10') is null,
  'reposição fora da janela ou encerrada pela direção abriu o aluno'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa04', '00000000-0000-4000-8000-00000000fb13') = 'PRIMARY_TEACHER',
  'titular sem agenda nenhuma perdeu o aluno (fallback da regra existente)'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb12') is null
  and pg_temp.planner('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb14') is null,
  'aluno inativo ou agenda avulsa antiga abriu o aluno no Planner'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa05', '00000000-0000-4000-8000-00000000fb01') is null,
  'professor inativo planeja pelo agendamento que ficou'
);
select pg_temp.assert_true(
  pg_temp.planner('00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb01', 'planner-aulas-outra') is null,
  'o acesso atravessou para outra escola'
);

reset role;

-- A janela anda com o dia (a mesma regra, com a data de referência explícita).
select pg_temp.assert_true(
  exists (select 1 from private.planner_student_access('00000000-0000-4000-8000-00000000fa03', 'planner-aulas-school', pd.d + 2) a
           where a.student_id = '00000000-0000-4000-8000-00000000fb03' and a.valid_until = pd.d + 2)
  and not exists (select 1 from private.planner_student_access('00000000-0000-4000-8000-00000000fa03', 'planner-aulas-school', pd.d + 2) a
           where a.student_id = '00000000-0000-4000-8000-00000000fb02')
  and not exists (select 1 from private.planner_student_access('00000000-0000-4000-8000-00000000fa03', 'planner-aulas-school', pd.d + 3) a
           where a.student_id = '00000000-0000-4000-8000-00000000fb03'),
  'a janela da cobertura não vai do dia anterior ao dia seguinte da aula'
)
from pd;
select pg_temp.assert_true(
  exists (select 1 from private.planner_student_access('00000000-0000-4000-8000-00000000fa04', 'planner-aulas-school', pd.d - 3) a
           where a.student_id = '00000000-0000-4000-8000-00000000fb09')
  and not exists (select 1 from private.planner_student_access('00000000-0000-4000-8000-00000000fa04', 'planner-aulas-school', pd.d - 4) a
           where a.student_id = '00000000-0000-4000-8000-00000000fb09'),
  'a janela da reposição não começa no dia anterior à aula'
)
from pd;
select pg_temp.assert_true(
  (select count(*) from private.planner_student_access('00000000-0000-4000-8000-00000000fa03', 'planner-aulas-school', null)) = 0,
  'sem data de referência a regra devolveu aluno'
);

-- ---------------------------------------------------------------------------
-- A lista da tela, na sessão de cada um
-- ---------------------------------------------------------------------------
set local role authenticated;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000fa03","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select count(*) from public.my_planner_students()) = 2
  and exists (select 1 from public.my_planner_students() s, pd
               where s.id = '00000000-0000-4000-8000-00000000fb02' and s.access_reason = 'COVERAGE'
                 and s.valid_until = pd.d and s.full_name = 'Aluno Cobertura Ontem' and s.module = 'A2')
  and exists (select 1 from public.my_planner_students() s, pd
               where s.id = '00000000-0000-4000-8000-00000000fb03' and s.access_reason = 'COVERAGE'
                 and s.valid_until = pd.d + 2),
  'a lista do substituto não traz só os dois alunos cobertos na janela, com a validade'
);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000fa02","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select count(*) from public.my_planner_students()) = 1
  and exists (select 1 from public.my_planner_students() s
               where s.id = '00000000-0000-4000-8000-00000000fb01' and s.access_reason = 'SECOND_TEACHER'
                 and s.valid_until is null),
  'a lista do segundo professor não traz o aluno dele'
);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000fa04","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select array_agg(s.id order by s.id) from public.my_planner_students() s)
    = array['00000000-0000-4000-8000-00000000fb07', '00000000-0000-4000-8000-00000000fb11',
            '00000000-0000-4000-8000-00000000fb13']::uuid[],
  'a lista do professor da reposição não bate (amanhã, dada ontem e titular sem agenda)'
);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000fb01","role":"authenticated"}', true);
select pg_temp.assert_true(
  (select count(*) from public.my_planner_students()) = 0,
  'aluno recebeu lista de alunos do Planner'
);

-- Quem está logado não consulta o acesso de outro professor pela porta da edge.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000fa03","role":"authenticated"}', true);
do $$
begin
  perform public.planner_teacher_can_access_student(
    '00000000-0000-4000-8000-00000000fa01', '00000000-0000-4000-8000-00000000fb01', 'planner-aulas-school');
  raise exception 'assertion failed: authenticated executou a porta da edge do Planner';
exception
  when insufficient_privilege then null;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Resumo aprovado e depois REJEITADO sai da memória do aluno (e do Planner)
-- ---------------------------------------------------------------------------
select pg_temp.assert_true(
  to_regprocedure('private.meet_summary_rejection_revokes_memory()') is not null,
  'a rejeição do resumo não tem gatilho: a memória aprovada ficaria VERIFIED para sempre'
);
select pg_temp.assert_true(
  exists (select 1 from pg_trigger t
           where t.tgrelid = 'private.lesson_summary_versions'::regclass
             and t.tgname = 'trg_zz_meet_summary_rejection_revokes_memory'
             and not t.tgisinternal)
  and (select p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
              and p.proconfig @> array['search_path=""']
         from pg_proc p
        where p.oid = 'private.meet_summary_rejection_revokes_memory()'::regprocedure)
  and not has_function_privilege('anon', 'private.meet_summary_rejection_revokes_memory()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.meet_summary_rejection_revokes_memory()', 'EXECUTE'),
  'gatilho da rejeição do resumo ausente, sem SECURITY DEFINER/search_path/dono postgres, ou executável pelo navegador'
);

create temp table meet_versions (step text primary key, id uuid);

-- O mesmo filtro da consulta do Planner (e do dossiê do substituto).
create or replace function pg_temp.planner_ve_a_aula() returns boolean
language sql as $$
  select exists (
    select 1 from public.student_learning_memories m
     where m.tenant_id = 'planner-aulas-school'
       and m.student_id = '00000000-0000-4000-8000-00000000fb15'
       and m.source_type = 'MEET_SESSION'
       and m.source_ref = '00000000-0000-4000-8000-00000000fc01'
       and m.verification_status = 'VERIFIED');
$$;

create or replace function pg_temp.salvar_resumo(p_step text, p_status text, p_parent text, p_origin text)
returns void language plpgsql as $$
declare v jsonb;
begin
  v := public.google_meet_backend('summary_save', 'planner-aulas-school',
    '00000000-0000-4000-8000-00000000fa06', '00000000-0000-4000-8000-00000000fc01',
    jsonb_build_object(
      'status', p_status,
      'origin', p_origin,
      'parent_version_id', (select id from meet_versions where step = p_parent),
      'content', jsonb_build_object(
        'lesson_objective', 'Perguntas no aeroporto',
        'recommended_next_step', 'Pedir informação por telefone',
        'recurring_errors', jsonb_build_array('where is going → where is it going')),
      'source_artifact_ids', '[]'::jsonb));
  insert into meet_versions values (p_step, (v ->> 'id')::uuid);
end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select pg_temp.salvar_resumo('rascunho', 'PROPOSED', null, 'GOOGLE_SMART_NOTES');
select pg_temp.assert_true(not pg_temp.planner_ve_a_aula(),
  'rascunho do Meet virou memória do aluno sem aprovação');

select pg_temp.salvar_resumo('aprovado', 'VERIFIED', 'rascunho', 'HUMAN_REVIEW');
select pg_temp.assert_true(pg_temp.planner_ve_a_aula(),
  'fixture: resumo aprovado não virou memória VERIFIED do aluno');

-- Rascunho novo (IA gerou de novo) NÃO é decisão: a aprovada continua valendo.
select pg_temp.salvar_resumo('rascunho-novo', 'PROPOSED', 'aprovado', 'GEMINI_API');
select pg_temp.assert_true(pg_temp.planner_ve_a_aula(),
  'um rascunho novo (sem decisão humana) derrubou a memória aprovada');

-- O professor percebe um erro (ou um dado pessoal) e registra a rejeição.
select pg_temp.salvar_resumo('rejeitado', 'REJECTED', 'rascunho-novo', 'HUMAN_REVIEW');
select pg_temp.assert_true(not pg_temp.planner_ve_a_aula(),
  'resumo rejeitado depois de aprovado continua entrando no Planner como aula aprovada');
select pg_temp.assert_true(
  exists (select 1 from public.student_learning_memories m
           where m.source_type = 'MEET_SESSION'
             and m.source_ref = '00000000-0000-4000-8000-00000000fc01'
             and m.verification_status = 'REJECTED'
             and m.metadata ->> 'rejected_summary_version_id'
                 = (select id::text from meet_versions where step = 'rejeitado')),
  'a memória rejeitada não guarda qual versão a rejeitou'
);

-- A tela "Sala e resumo" segue a mesma régua (correção da integração): quem
-- não vê a fonte — o segundo professor do aluno, aqui — deixa de receber a
-- versão aprovada e depois rejeitada como resumo aprovado. Quem vê a fonte (o
-- professor da aula) continua com o histórico inteiro, cada versão com o status.
set local session_replication_role = replica;
update public.profiles set professor_id2 = '00000000-0000-4000-8000-00000000fa02'
 where id = '00000000-0000-4000-8000-00000000fb15';
set local session_replication_role = origin;
create or replace function pg_temp.versoes_na_tela(p_actor uuid) returns text[]
language sql as $$
  select coalesce(array_agg(v.step order by v.step collate "C"), '{}'::text[])
  from jsonb_array_elements(public.google_meet_backend('session_detail', 'planner-aulas-school', p_actor,
      '00000000-0000-4000-8000-00000000fc01') -> 'summaries') as summary
  join meet_versions as v on v.id = (summary ->> 'id')::uuid;
$$;
select pg_temp.assert_true(
  pg_temp.versoes_na_tela('00000000-0000-4000-8000-00000000fa02') = '{}'::text[],
  'o segundo professor continua vendo como aprovado o resumo que o professor rejeitou: '
    || pg_temp.versoes_na_tela('00000000-0000-4000-8000-00000000fa02')::text);
select pg_temp.assert_true(
  pg_temp.versoes_na_tela('00000000-0000-4000-8000-00000000fa06')
    = array['aprovado', 'rascunho', 'rascunho-novo', 'rejeitado'],
  'o professor da aula perdeu o histórico das versões: '
    || pg_temp.versoes_na_tela('00000000-0000-4000-8000-00000000fa06')::text);

-- Aprovou de novo: a última decisão volta a valer.
select pg_temp.salvar_resumo('reaprovado', 'VERIFIED', 'rejeitado', 'HUMAN_REVIEW');
select pg_temp.assert_true(pg_temp.planner_ve_a_aula(),
  'resumo aprovado de novo depois da rejeição não voltou para a memória do aluno');
select pg_temp.assert_true(
  pg_temp.versoes_na_tela('00000000-0000-4000-8000-00000000fa02') = array['reaprovado'],
  'o segundo professor não vê a reaprovação, ou vê a versão rejeitada depois: '
    || pg_temp.versoes_na_tela('00000000-0000-4000-8000-00000000fa02')::text);
select pg_temp.assert_true(
  (select count(*) from public.student_learning_memories m
    where m.source_type = 'MEET_SESSION'
      and m.source_ref = '00000000-0000-4000-8000-00000000fc01') = 1,
  'aprovar, rejeitar e aprovar de novo duplicou a memória da aula'
);

select set_config('request.jwt.claims', '', true);

rollback;
