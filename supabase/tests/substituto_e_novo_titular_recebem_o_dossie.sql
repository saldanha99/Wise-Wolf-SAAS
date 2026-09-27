-- Substituto e novo titular recebem o que precisam (migration 20260928100000).
--
-- Prova:
--   * o substituto de cobertura CONFIRMADA e o professor da reposição COM DATA
--     leem o dossiê, a lista de sessões, a linha de lesson_sessions (RLS) e o
--     resumo aprovado (session_detail) do aluno — do dia anterior ao dia
--     seguinte da aula, e só nessa janela;
--   * reposição parada em 'Pendente', encerrada pela direção ou fora da janela
--     não abre nada; cobertura pendente também não; professor alheio também não;
--   * o substituto não vê a transcrição bruta de aula que não deu, não escreve
--     o cartão do aluno, e nenhuma outra ação do Meet se abre pela janela;
--     quem entra SÓ pela janela recebe "Sala e resumo" sem a sala (link do
--     Meet, conta Google do titular, conta central), sem a importação e sem a
--     contagem de planilhas de presença;
--   * o pacote da cobertura aponta a DATA da ÚLTIMA aula com resumo APROVADO
--     (nem a rejeitada, nem a mais antiga, nem memória de outra origem) e manda
--     ao dossiê — o próximo passo, os erros e a lição NÃO vão em texto e nenhuma
--     linha da fila guarda o resumo depois da exclusão a pedido —, a sala
--     oficial de quem dá a aula e o link com login do dossiê, e nenhum texto
--     pessoal (cartão, objetivo livre do cadastro, nome do responsável).
--     Idempotente. Sem WhatsApp do substituto, a frase ao grupo diz que o pacote
--     NÃO sai;
--   * sem sala pronta no aceite: com sala prevista para o substituto, ele e a
--     família ouvem que o link da escola chega por aqui (nada de "combine e
--     mande o link"); sem sala prevista (sem aceite do termo, ou aula congelada
--     com o titular), o texto de sempre. Quando a sala fica pronta, o link vai
--     a substituto e família uma vez só;
--   * a transferência definitiva (direta pela Gestão, ou com aceite do
--     professor) enfileira UMA mensagem ao novo titular com o link do dossiê,
--     pela instância central; falha no aviso não derruba a transferência.
--
-- Reprova contra o código anterior: as funções novas não existem, o substituto
-- não lia o dossiê, o pacote não tinha memória, sala nem dossiê (e trazia o
-- objetivo do cadastro), e a transferência não avisava ninguém. E contra a
-- primeira versão desta frente: o pacote copiava o próximo passo e os erros do
-- resumo aprovado para a fila (sobreviviam à exclusão a pedido), a janela
-- entregava a sala e a conta Google do titular, e sem sala pronta o substituto
-- era mandado criar outro link numa aula que ganharia sala da escola.
--
-- Não depende de dado real, do horário do dia nem da fila global: a escola é
-- do teste, as datas saem da data de São Paulo no início da transação (a mesma
-- que as funções usam) e a fila é lida pela chave de idempotência da escola.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

-- Executa como p_user (JWT de authenticated) e devolve o resultado ou o erro.
create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

create or replace function pg_temp.as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;

create or replace function pg_temp.can_read(p_user uuid, p_student uuid)
returns boolean language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.as_user(p_user);
  v := private.can_read_student_pedagogy('troca-prof-school', p_student);
  perform pg_temp.as_service();
  return v;
end;
$$;

create or replace function pg_temp.handover(p_user uuid, p_student uuid)
returns text language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  v := public.get_student_handover(p_student, false);
  perform pg_temp.as_service();
  return v::text;
exception when others then
  perform pg_temp.as_service();
  return 'ERRO:' || sqlerrm;
end;
$$;

create or replace function pg_temp.meet(p_action text, p_actor uuid, p_session uuid)
returns text language plpgsql as $$
begin
  return public.google_meet_backend(p_action, 'troca-prof-school', p_actor, p_session, '{}'::jsonb)::text;
exception when others then
  return 'ERRO:' || sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Estrutura e privilégios
-- ---------------------------------------------------------------------------
select pg_temp.assert_true(
  to_regprocedure('private.pedagogy_temporary_access(text,uuid,uuid,date)') is not null
  and to_regprocedure('private.student_pedagogy_access(text,uuid,boolean)') is not null
  and to_regprocedure('private.teacher_transfer_dossier_enqueue(uuid)') is not null
  and to_regprocedure('private.teacher_transfer_dossier_notice()') is not null
  and to_regprocedure('private.briefing_line(text,integer)') is not null
  and to_regprocedure('private.coverage_school_room_expected(uuid)') is not null
  and to_regprocedure('private.coverage_room_notice_enqueue(uuid)') is not null
  and to_regprocedure('private.google_meet_room_ready_coverage_notice()') is not null,
  'funções da troca de professor não existem'
);

select pg_temp.assert_true(
  (select bool_and(p.prosecdef
            and pg_get_userbyid(p.proowner) = 'postgres'
            and p.proconfig @> array['search_path=""'])
     from pg_proc p
    where p.oid in (
      'private.pedagogy_temporary_access(text,uuid,uuid,date)'::regprocedure,
      'private.student_pedagogy_access(text,uuid,boolean)'::regprocedure,
      'private.can_read_student_pedagogy(text,uuid)'::regprocedure,
      'private.student_learning_card_can_edit(text,uuid)'::regprocedure,
      'public.coverage_briefing_enqueue(uuid,boolean)'::regprocedure,
      'private.teacher_transfer_dossier_enqueue(uuid)'::regprocedure,
      'private.teacher_transfer_dossier_notice()'::regprocedure,
      'private.coverage_school_room_expected(uuid)'::regprocedure,
      'private.coverage_room_notice_enqueue(uuid)'::regprocedure,
      'private.google_meet_room_ready_coverage_notice()'::regprocedure)),
  'funções da troca de professor sem SECURITY DEFINER, sem search_path vazio ou sem dono postgres'
);

select pg_temp.assert_true(
  -- A RLS de lesson_sessions roda como authenticated: a porta continua aberta a ele.
  has_function_privilege('authenticated', 'private.can_read_student_pedagogy(text,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.can_read_student_pedagogy(text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.pedagogy_temporary_access(text,uuid,uuid,date)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.pedagogy_temporary_access(text,uuid,uuid,date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.student_pedagogy_access(text,uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.student_pedagogy_access(text,uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.student_learning_card_can_edit(text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.teacher_transfer_dossier_enqueue(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.teacher_transfer_dossier_enqueue(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.teacher_transfer_dossier_enqueue(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.briefing_line(text,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.coverage_briefing_enqueue(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.coverage_briefing_enqueue(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.coverage_briefing_enqueue(uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.coverage_school_room_expected(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.coverage_school_room_expected(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.coverage_room_notice_enqueue(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.coverage_room_notice_enqueue(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.coverage_room_notice_enqueue(uuid)', 'EXECUTE'),
  'privilégios da troca de professor fora do desenho'
);

select pg_temp.assert_true(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.teacher_transfers'::regclass
             and tgname = 'trg_zz_teacher_transfer_dossier_notice' and not tgisinternal)
  and exists (select 1 from pg_trigger
           where tgrelid = 'private.google_meet_rooms'::regclass
             and tgname = 'trg_zz_google_meet_room_ready_coverage_notice' and not tgisinternal),
  'teacher_transfers sem o gatilho que avisa o novo titular, ou salas sem o aviso de sala pronta da cobertura'
);

-- Quem recriar estas funções mantém o que esta frente pôs nelas.
select pg_temp.assert_true(
  pg_catalog.strpos(g.def, 'private.pedagogy_temporary_access(') > 0
  and pg_catalog.strpos(g.def, 'p_action = ''session_detail''') > 0
  and pg_catalog.strpos(g.def, 'v_temporary_only') > 0
  and pg_catalog.strpos(b.def, 'tenant_notice_destination') > 0
  and pg_catalog.strpos(b.def, 'public.official_lesson_link(') > 0
  and pg_catalog.strpos(b.def, 'private.coverage_school_room_expected(') > 0
  and pg_catalog.strpos(b.def, '''MEET_SESSION''') > 0
  and pg_catalog.strpos(b.def, '/dossie-do-aluno?aluno=') > 0
  and pg_catalog.strpos(b.def, 'learning_objective') = 0
  -- O texto do resumo aprovado não volta para o pacote do WhatsApp.
  and pg_catalog.strpos(b.def, 'recommended_next_step, 300') = 0
  and pg_catalog.strpos(b.def, 'Erros recorrentes: %s') = 0
  and pg_catalog.strpos(t.def, 'student.professor_id in (v_from_teacher, p_to_teacher)') > 0,
  'google_meet_backend/coverage_briefing_enqueue/admin_transfer_student_teacher sem a janela do substituto (ou com a sala dele), a sala, a memória, o dossiê ou o conserto da transferência direta (ou com o objetivo do cadastro ou o texto do resumo aprovado)'
)
from (select pg_get_functiondef('public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure) as def) as g,
     (select pg_get_functiondef('public.coverage_briefing_enqueue(uuid,boolean)'::regprocedure) as def) as b,
     (select pg_get_functiondef('public.admin_transfer_student_teacher(uuid,uuid,text)'::regprocedure) as def) as t;

-- ---------------------------------------------------------------------------
-- 2. Cenário (escola própria do teste)
-- ---------------------------------------------------------------------------
create temp table td as
select (now() at time zone 'America/Sao_Paulo')::date as d;
grant select on td to public;

select pg_temp.as_service();

insert into public.tenants (id, name, custom_domain, custom_domain_verified) values
  ('troca-prof-school', 'Troca Prof School', 'portal-troca.example.invalid', true),
  ('troca-prof-outra', 'Troca Prof Outra', null, false)
on conflict (id) do nothing;
update public.tenants set saas_status = 'active' where id in ('troca-prof-school', 'troca-prof-outra');

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select v.id::uuid, 'authenticated', 'authenticated', v.email,
       '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', v.nome, 'test_fixture', true), now(), now()
from (values
  ('00000000-0000-4000-8000-000000009e01', 'tp-diretora@example.invalid', 'Diretora Troca'),
  ('00000000-0000-4000-8000-000000009e02', 'tp-titular@example.invalid', 'Tita Titular'),
  ('00000000-0000-4000-8000-000000009e03', 'tp-substituta@example.invalid', 'Bruna Substituta'),
  ('00000000-0000-4000-8000-000000009e04', 'tp-reposicao@example.invalid', 'Rita Reposicao'),
  ('00000000-0000-4000-8000-000000009e05', 'tp-novo@example.invalid', 'Nando Novo'),
  ('00000000-0000-4000-8000-000000009e06', 'tp-alheio@example.invalid', 'Xavier Alheio'),
  ('00000000-0000-4000-8000-000000009e07', 'tp-semfone@example.invalid', 'Sonia Semfone'),
  ('00000000-0000-4000-8000-000000009e11', 'tp-ana@example.invalid', 'Ana Coberta'),
  ('00000000-0000-4000-8000-000000009e12', 'tp-beto@example.invalid', 'Beto Futuro'),
  ('00000000-0000-4000-8000-000000009e13', 'tp-caio@example.invalid', 'Caio Pendente'),
  ('00000000-0000-4000-8000-000000009e14', 'tp-eva@example.invalid', 'Eva Reposicao'),
  ('00000000-0000-4000-8000-000000009e15', 'tp-fabio@example.invalid', 'Fabio Parado'),
  ('00000000-0000-4000-8000-000000009e16', 'tp-gil@example.invalid', 'Gil Antigo'),
  ('00000000-0000-4000-8000-000000009e17', 'tp-hugo@example.invalid', 'Hugo Encerrado'),
  ('00000000-0000-4000-8000-000000009e18', 'tp-kiko@example.invalid', 'Kiko Transferido'),
  ('00000000-0000-4000-8000-000000009e19', 'tp-lia@example.invalid', 'Lia Aceite'),
  ('00000000-0000-4000-8000-000000009e1a', 'tp-mia@example.invalid', 'Mia Semfone'),
  ('00000000-0000-4000-8000-000000009e1b', 'tp-paulo@example.invalid', 'Paulo Semaviso'),
  ('00000000-0000-4000-8000-000000009e1c', 'tp-duda@example.invalid', 'Duda Antecipada'),
  ('00000000-0000-4000-8000-000000009e1d', 'tp-enzo@example.invalid', 'Enzo Semtermo')
) as v(id, email, nome);

update public.profiles as p
   set tenant_id = 'troca-prof-school', lifecycle_status = 'active', status = 'Ativo', is_test_account = true,
       full_name = v.nome, role = v.papel, phone = v.fone, attendance_phone = v.fone,
       professor_id = case when v.papel = 'STUDENT' and v.id not in ('e14', 'e15', 'e16', 'e17')
                           then '00000000-0000-4000-8000-000000009e02'::uuid end
  from (values
    ('e01', 'Diretora Troca', 'SCHOOL_ADMIN', null),
    ('e02', 'Tita Titular', 'TEACHER', '5511977770902'),
    ('e03', 'Bruna Substituta', 'TEACHER', '5511977770903'),
    ('e04', 'Rita Reposicao', 'TEACHER', '5511977770904'),
    ('e05', 'Nando Novo', 'TEACHER', '5511977770905'),
    ('e06', 'Xavier Alheio', 'TEACHER', '5511977770906'),
    ('e07', 'Sonia Semfone', 'TEACHER', null),
    ('e11', 'Ana Coberta', 'STUDENT', '5511966660911'),
    ('e12', 'Beto Futuro', 'STUDENT', '5511966660912'),
    ('e13', 'Caio Pendente', 'STUDENT', '5511966660913'),
    ('e14', 'Eva Reposicao', 'STUDENT', '5511966660914'),
    ('e15', 'Fabio Parado', 'STUDENT', '5511966660915'),
    ('e16', 'Gil Antigo', 'STUDENT', '5511966660916'),
    ('e17', 'Hugo Encerrado', 'STUDENT', '5511966660917'),
    ('e18', 'Kiko Transferido', 'STUDENT', '5511966660918'),
    ('e19', 'Lia Aceite', 'STUDENT', '5511966660919'),
    ('e1a', 'Mia Semfone', 'STUDENT', '5511966660920'),
    ('e1b', 'Paulo Semaviso', 'STUDENT', '5511966660921'),
    ('e1c', 'Duda Antecipada', 'STUDENT', '5511966660922'),
    ('e1d', 'Enzo Semtermo', 'STUDENT', '5511966660923')
  ) as v(id, nome, papel, fone)
 where p.id = ('00000000-0000-4000-8000-000000009' || v.id)::uuid;

-- Texto pessoal da Ana: objetivo livre do cadastro e responsável. Nada disso
-- pode ir no WhatsApp do substituto.
update public.profiles
   set learning_objective = 'MARCADOR-OBJETIVO-PERFIL', guardian_name = 'MARCADOR-RESPONSAVEL'
 where id = '00000000-0000-4000-8000-000000009e11';

insert into public.tenant_memberships (tenant_id, user_id, role, status)
select 'troca-prof-school', p.id, p.role, 'ACTIVE'
  from public.profiles p
 where p.id::text like '00000000-0000-4000-8000-000000009e%'
on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

-- Canal de coordenação da escola (o resumo ao grupo vai para ele).
insert into public.tenant_notice_channels (tenant_id, channel, group_jid)
values ('troca-prof-school', 'coordenacao', '120363099990000001@g.us')
on conflict (tenant_id, channel) do update set group_jid = excluded.group_jid, enabled = true;

-- Cartão da Ana escrito pela titular (idade não comprovada: só objetivo e temas).
select pg_temp.as_user('00000000-0000-4000-8000-000000009e02');
select pg_temp.assert_true(
  public.save_student_learning_card('00000000-0000-4000-8000-000000009e11',
    'MARCADOR-OBJETIVO-REAL', array['MARCADOR-TEMA'], null, array[]::text[], '', 0) is not null,
  'fixture: a titular não salvou o cartão da Ana'
);
select pg_temp.as_service();

-- Agenda, cobertura, reposição, sessões, sala e memória: os gatilhos dessas
-- tabelas (choque de horário, trilha e avisos) não são o que se testa aqui.
set local session_replication_role = replica;

insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select b.id, 'troca-prof-school', '00000000-0000-4000-8000-000000009e02', b.student_id, b.dia, b.hora, null, date '2026-01-05', 'SCHEDULED'
from td,
lateral (values
  ('00000000-0000-4000-8000-000000009eb1'::uuid, '00000000-0000-4000-8000-000000009e11'::uuid,
   (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from td.d)::int + 1], '10:00'),
  ('00000000-0000-4000-8000-000000009eb2'::uuid, '00000000-0000-4000-8000-000000009e18'::uuid, 'Quarta', '15:00'),
  -- Duda e Enzo: aulas da titular daqui a 2 dias (cobertas pela substituta).
  ('00000000-0000-4000-8000-000000009eb4'::uuid, '00000000-0000-4000-8000-000000009e1c'::uuid,
   (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from td.d + 2)::int + 1], '10:00'),
  ('00000000-0000-4000-8000-000000009eb5'::uuid, '00000000-0000-4000-8000-000000009e1d'::uuid,
   (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from td.d + 2)::int + 1], '11:00')
) as b(id, student_id, dia, hora);

insert into public.teacher_availability (tenant_id, teacher_id, day_of_week, start_time)
values ('troca-prof-school', '00000000-0000-4000-8000-000000009e05', 3, '15:00');

insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at)
select c.id, 'troca-prof-school', '00000000-0000-4000-8000-000000009e02', c.cover, c.student_id, c.booking_id,
       td.d + c.delta, '10:00', c.status, case when c.status = 'confirmed' then now() end
from td,
lateral (values
  -- Ana: cobertura confirmada HOJE, do agendamento da titular.
  ('00000000-0000-4000-8000-000000009ec1'::uuid, '00000000-0000-4000-8000-000000009e03'::uuid,
   '00000000-0000-4000-8000-000000009e11'::uuid, '00000000-0000-4000-8000-000000009eb1'::uuid, 0, 'confirmed'),
  -- Beto: confirmada, mas daqui a 2 dias (fora da janela hoje).
  ('00000000-0000-4000-8000-000000009ec2'::uuid, '00000000-0000-4000-8000-000000009e03'::uuid,
   '00000000-0000-4000-8000-000000009e12'::uuid, null::uuid, 2, 'confirmed'),
  -- Caio: convite ainda pendente (não é cobertura).
  ('00000000-0000-4000-8000-000000009ec3'::uuid, '00000000-0000-4000-8000-000000009e03'::uuid,
   '00000000-0000-4000-8000-000000009e13'::uuid, null::uuid, 0, 'pending'),
  -- Mia: confirmada amanhã com a substituta sem WhatsApp.
  ('00000000-0000-4000-8000-000000009ec4'::uuid, '00000000-0000-4000-8000-000000009e07'::uuid,
   '00000000-0000-4000-8000-000000009e1a'::uuid, null::uuid, 1, 'confirmed')
) as c(id, cover, student_id, booking_id, delta, status);

-- Duda (10:00) e Enzo (11:00): coberturas confirmadas daqui a 2 dias, de
-- agendamento — aceitas antes de a sala da escola existir.
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at)
select c.id, 'troca-prof-school', '00000000-0000-4000-8000-000000009e02', '00000000-0000-4000-8000-000000009e03',
       c.student_id, c.booking_id, td.d + 2, c.hora, 'confirmed', now()
from td,
lateral (values
  ('00000000-0000-4000-8000-000000009ec5'::uuid, '00000000-0000-4000-8000-000000009e1c'::uuid,
   '00000000-0000-4000-8000-000000009eb4'::uuid, '10:00'),
  ('00000000-0000-4000-8000-000000009ec6'::uuid, '00000000-0000-4000-8000-000000009e1d'::uuid,
   '00000000-0000-4000-8000-000000009eb5'::uuid, '11:00')
) as c(id, student_id, booking_id, hora);

insert into public.reschedules (tenant_id, teacher_id, student_id, date, time, fault_type, closed_reason)
select 'troca-prof-school', '00000000-0000-4000-8000-000000009e04', r.student_id, r.dia, '15:00', 'STUDENT', r.closed
from td,
lateral (values
  ('00000000-0000-4000-8000-000000009e14'::uuid, to_char(td.d + 1, 'YYYY-MM-DD'), null::text),
  ('00000000-0000-4000-8000-000000009e15'::uuid, 'Pendente', null::text),
  ('00000000-0000-4000-8000-000000009e16'::uuid, to_char(td.d - 3, 'YYYY-MM-DD'), null::text),
  ('00000000-0000-4000-8000-000000009e17'::uuid, to_char(td.d, 'YYYY-MM-DD'), 'aluno saiu da escola')
) as r(student_id, dia, closed);

-- Sessões: A0 = aula passada da Ana com a titular (resumo aprovado e transcrição);
-- A1 = a aula coberta de hoje, já nascida com a substituta (sala dela);
-- B0 = aula passada do Beto com a titular.
insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
  scheduled_start_at, scheduled_end_at, source_key, documentation_consent)
select s.id, 'troca-prof-school', s.student_id, s.teacher_id, s.dia,
       (s.dia + time '10:00') at time zone 'America/Sao_Paulo',
       (s.dia + time '10:30') at time zone 'America/Sao_Paulo',
       s.source_key, true
from td,
lateral (values
  ('00000000-0000-4000-8000-000000009ea0'::uuid, '00000000-0000-4000-8000-000000009e11'::uuid,
   '00000000-0000-4000-8000-000000009e02'::uuid, td.d - 3, 'troca-prof-a0'),
  ('00000000-0000-4000-8000-000000009ea1'::uuid, '00000000-0000-4000-8000-000000009e11'::uuid,
   '00000000-0000-4000-8000-000000009e03'::uuid, td.d, 'troca-prof-a1'),
  ('00000000-0000-4000-8000-000000009ea2'::uuid, '00000000-0000-4000-8000-000000009e12'::uuid,
   '00000000-0000-4000-8000-000000009e02'::uuid, td.d - 3, 'troca-prof-b0')
) as s(id, student_id, teacher_id, dia, source_key);

insert into public.lesson_occurrences (tenant_id, session_id, source_type, source_id, class_date, start_time,
  scheduled_start_at, scheduled_end_at, entitlement_date, status)
select 'troca-prof-school', '00000000-0000-4000-8000-000000009ea1', 'booking', '00000000-0000-4000-8000-000000009eb1',
       td.d, time '10:00',
       (td.d + time '10:00') at time zone 'America/Sao_Paulo',
       (td.d + time '10:30') at time zone 'America/Sao_Paulo', td.d, 'SCHEDULED'
from td;

insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub, cohost_email, state, created_by)
values ('00000000-0000-4000-8000-000000009ea1', 'troca-prof-school', 'spaces/trocaA1', 'https://meet.google.com/tro-caso-bru',
        'troca-sub', 'tp-substituta@example.invalid', 'READY', '00000000-0000-4000-8000-000000009e03'),
       -- A sala da aula da TITULAR (A0): link, conta Google dela e conta central.
       -- Pela janela a substituta lê o resumo aprovado dessa aula, não a sala.
       ('00000000-0000-4000-8000-000000009ea0', 'troca-prof-school', 'spaces/trocaA0', 'https://meet.google.com/tit-ular-aaa',
        'MARCADOR-CONTA-CENTRAL', 'marcador-google-titular@example.invalid', 'READY', '00000000-0000-4000-8000-000000009e02');

insert into private.google_meet_artifact_imports (lesson_session_id, tenant_id, provider_name, kind, status)
values ('00000000-0000-4000-8000-000000009ea0', 'troca-prof-school', 'conferenceRecords/trocaA0/transcripts/1', 'TRANSCRIPT', 'IMPORTED');

insert into private.meeting_artifact_revisions (tenant_id, lesson_session_id, provider_name, kind, document_id,
  content_sha256, source_text, expires_at, source)
values ('troca-prof-school', '00000000-0000-4000-8000-000000009ea0', 'conferenceRecords/troca/transcripts/1', 'TRANSCRIPT',
        'docTrocaA0', encode(sha256('MARCADOR-TRANSCRICAO'::bytea), 'hex'), 'MARCADOR-TRANSCRICAO',
        now() + interval '30 days', 'DRIVE_EXPORT');

insert into public.student_learning_memories (tenant_id, student_id, source_type, source_ref, occurred_at,
  lesson_objective, content_practiced, recurring_errors, homework_assigned, recommended_next_step,
  confidence_level, verification_status, metadata)
select 'troca-prof-school', '00000000-0000-4000-8000-000000009e11', m.fonte, m.ref, m.quando,
       'Objetivo pedagógico', array['conteudo'], m.erros, m.licao, m.passo, 'HIGH', m.status, '{}'::jsonb
from td,
lateral (values
  -- A última aula aprovada: é esta que vai no pacote.
  ('MEET_SESSION', '00000000-0000-4000-8000-000000009ea0', (td.d - 3 + time '10:00') at time zone 'America/Sao_Paulo',
   array['MARCADOR-ERRO-1', E'MARCADOR-ERRO-2\ncom quebra'], 'MARCADOR-LICAO', 'MARCADOR-PROXIMO-PASSO', 'VERIFIED'),
  -- Aprovada, mas mais antiga.
  ('MEET_SESSION', 'troca-prof-antiga', (td.d - 10 + time '10:00') at time zone 'America/Sao_Paulo',
   array['MARCADOR-VELHO'], 'MARCADOR-VELHO', 'MARCADOR-VELHO', 'VERIFIED'),
  -- Mais nova, mas rejeitada (a última decisão humana vale).
  ('MEET_SESSION', 'troca-prof-rejeitada', (td.d - 1 + time '10:00') at time zone 'America/Sao_Paulo',
   array['MARCADOR-REJEITADO'], 'MARCADOR-REJEITADO', 'MARCADOR-REJEITADO', 'REJECTED'),
  -- Mais nova e aprovada, mas não é resumo de aula no Meet.
  ('MANUAL', 'troca-prof-manual', (td.d - 1 + time '11:00') at time zone 'America/Sao_Paulo',
   array['MARCADOR-OUTRA-ORIGEM'], 'MARCADOR-OUTRA-ORIGEM', 'MARCADOR-OUTRA-ORIGEM', 'VERIFIED')
) as m(fonte, ref, quando, erros, licao, passo, status);

set local session_replication_role = origin;

-- ---------------------------------------------------------------------------
-- 3. A janela: do dia anterior ao seguinte da aula
-- ---------------------------------------------------------------------------
select pg_temp.assert_true(
  (select count(*) = 1 from private.pedagogy_temporary_access('troca-prof-school',
     '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11', td.d - 1))
  and (select count(*) = 1 from private.pedagogy_temporary_access('troca-prof-school',
     '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11', td.d + 1))
  and (select access_reason = 'COVERAGE' and valid_from = td.d - 1 and valid_until = td.d + 1
         from private.pedagogy_temporary_access('troca-prof-school',
           '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11', td.d))
  and not exists (select 1 from private.pedagogy_temporary_access('troca-prof-school',
     '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11', td.d - 2))
  and not exists (select 1 from private.pedagogy_temporary_access('troca-prof-school',
     '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11', td.d + 2))
  -- Outro professor, outra escola: nada.
  and not exists (select 1 from private.pedagogy_temporary_access('troca-prof-school',
     '00000000-0000-4000-8000-000000009e06', '00000000-0000-4000-8000-000000009e11', td.d))
  and not exists (select 1 from private.pedagogy_temporary_access('troca-prof-outra',
     '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11', td.d))
  -- Reposição com data amanhã: vale até depois de amanhã.
  and (select access_reason = 'RESCHEDULE' and valid_until = td.d + 2
         from private.pedagogy_temporary_access('troca-prof-school',
           '00000000-0000-4000-8000-000000009e04', '00000000-0000-4000-8000-000000009e14', td.d)),
  'janela do dia anterior ao seguinte da aula errada'
)
from td;

-- Quem lê o dossiê hoje.
select pg_temp.assert_true(
  pg_temp.can_read('00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11'),
  'substituto de cobertura confirmada de hoje não lê o aluno'
);
select pg_temp.assert_true(
  not pg_temp.can_read('00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e12'),
  'cobertura de daqui a 2 dias já abriu o aluno'
);
select pg_temp.assert_true(
  not pg_temp.can_read('00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e13'),
  'convite de cobertura ainda pendente abriu o aluno'
);
select pg_temp.assert_true(
  pg_temp.can_read('00000000-0000-4000-8000-000000009e04', '00000000-0000-4000-8000-000000009e14'),
  'professor da reposição com data não lê o aluno'
);
select pg_temp.assert_true(
  not pg_temp.can_read('00000000-0000-4000-8000-000000009e04', '00000000-0000-4000-8000-000000009e15'),
  'reposição parada em Pendente abriu o aluno'
);
select pg_temp.assert_true(
  not pg_temp.can_read('00000000-0000-4000-8000-000000009e04', '00000000-0000-4000-8000-000000009e16'),
  'reposição de 3 dias atrás ainda abre o aluno'
);
select pg_temp.assert_true(
  not pg_temp.can_read('00000000-0000-4000-8000-000000009e04', '00000000-0000-4000-8000-000000009e17'),
  'reposição encerrada pela direção abriu o aluno'
);
select pg_temp.assert_true(
  not pg_temp.can_read('00000000-0000-4000-8000-000000009e06', '00000000-0000-4000-8000-000000009e11')
  and pg_temp.can_read('00000000-0000-4000-8000-000000009e02', '00000000-0000-4000-8000-000000009e11')
  and pg_temp.can_read('00000000-0000-4000-8000-000000009e01', '00000000-0000-4000-8000-000000009e11'),
  'acesso permanente mudou (alheio lê, ou titular/direção deixaram de ler)'
);

-- Dossiê: o substituto recebe o cartão e a memória aprovada; fora da janela, não.
select pg_temp.assert_true(
  h like '{%'
  and strpos(h, 'MARCADOR-OBJETIVO-REAL') > 0
  and strpos(h, 'MARCADOR-PROXIMO-PASSO') > 0
  -- A tela do cartão só oferece "editar" a quem pode: o substituto lê.
  and (h::jsonb -> 'learning_card' ->> 'can_edit') = 'false',
  'dossiê do substituto sem o cartão, sem a memória aprovada ou com o cartão editável: ' || left(h, 300)
)
from (select pg_temp.handover('00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e11') as h) as x;
select pg_temp.assert_true(
  (pg_temp.handover('00000000-0000-4000-8000-000000009e02', '00000000-0000-4000-8000-000000009e11')::jsonb
     -> 'learning_card' ->> 'can_edit') = 'true',
  'a titular perdeu a edição do cartão'
);
select pg_temp.assert_true(
  pg_temp.handover('00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009e12') like 'ERRO:%sem_permissao%'
  and pg_temp.handover('00000000-0000-4000-8000-000000009e04', '00000000-0000-4000-8000-000000009e15') like 'ERRO:%sem_permissao%',
  'dossiê aberto fora da janela ou por reposição sem data'
);

-- O cartão o substituto lê, mas não escreve.
select pg_temp.as_user('00000000-0000-4000-8000-000000009e03');
select pg_temp.assert_true(
  not private.student_pedagogy_access('troca-prof-school', '00000000-0000-4000-8000-000000009e11', false)
  and private.student_pedagogy_access('troca-prof-school', '00000000-0000-4000-8000-000000009e11', true),
  'acesso do substituto sem a separação leitura/escrita'
);
do $card$
begin
  perform public.save_student_learning_card('00000000-0000-4000-8000-000000009e11',
    'substituto reescrevendo', array['x'], null, array[]::text[], '', null);
  raise exception 'assertion failed: substituto escreveu o cartão do aluno';
exception when others then
  if sqlerrm not like '%sem_permissao%' then raise; end if;
end
$card$;
select pg_temp.as_service();

-- RLS de lesson_sessions: o substituto enxerga as sessões da Ana na janela e
-- nenhuma do Beto; o professor alheio, nenhuma.
-- A contagem sai por set_config: como authenticated nada é criado.
select pg_temp.as_user('00000000-0000-4000-8000-000000009e03');
set local role authenticated;
select set_config('troca_prof.rls_substituto_ana',
  (select count(*)::text from public.lesson_sessions where student_id = '00000000-0000-4000-8000-000000009e11'), true);
select set_config('troca_prof.rls_substituto_beto',
  (select count(*)::text from public.lesson_sessions where student_id = '00000000-0000-4000-8000-000000009e12'), true);
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-000000009e06');
set local role authenticated;
select set_config('troca_prof.rls_alheio_ana',
  (select count(*)::text from public.lesson_sessions where student_id = '00000000-0000-4000-8000-000000009e11'), true);
reset role;
select pg_temp.as_service();
select pg_temp.assert_true(
  current_setting('troca_prof.rls_substituto_ana') = '2'
  and current_setting('troca_prof.rls_substituto_beto') = '0'
  and current_setting('troca_prof.rls_alheio_ana') = '0',
  format('RLS de lesson_sessions: substituto vê %s da Ana e %s do Beto; alheio vê %s',
    current_setting('troca_prof.rls_substituto_ana'), current_setting('troca_prof.rls_substituto_beto'),
    current_setting('troca_prof.rls_alheio_ana'))
);

-- "Sala e resumo": o substituto lê a sessão passada da Ana (resumo aprovado),
-- sem a transcrição de uma aula que não deu; a titular vê a transcrição.
select pg_temp.assert_true(
  (pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009ea0')::jsonb
     ->> 'raw_access') = 'false'
  and (pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009ea0')::jsonb
     -> 'artifacts') = '[]'::jsonb
  and strpos(pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009ea0'),
     'MARCADOR-TRANSCRICAO') = 0
  and strpos(pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e02', '00000000-0000-4000-8000-000000009ea0'),
     'MARCADOR-TRANSCRICAO') > 0,
  'session_detail do substituto errado (sem acesso, ou com a transcrição de aula que não deu)'
);
-- Pela janela, "Sala e resumo" da aula da titular sai sem a sala (link do Meet,
-- conta Google dela, conta central), sem a importação e sem a presença.
select pg_temp.assert_true(
  (d::jsonb ->> 'temporary_access') = 'true'
  and (d::jsonb -> 'room') = 'null'::jsonb
  and (d::jsonb -> 'imports') = '[]'::jsonb
  and (d::jsonb ->> 'attendance_saved_reports') = '0'
  and strpos(d, 'tit-ular-aaa') = 0
  and strpos(d, 'marcador-google-titular') = 0
  and strpos(d, 'MARCADOR-CONTA-CENTRAL') = 0
  and strpos(d, 'conferenceRecords/trocaA0') = 0,
  'session_detail pela janela entregou a sala, a conta Google da titular ou a importação: ' || left(d, 400)
)
from (select pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009ea0') as d) as x;
-- Quem dá a aula continua com a sala: a titular na dela, a substituta na aula
-- que ficou com ela (sessão dela, não a janela).
select pg_temp.assert_true(
  (t::jsonb -> 'room' ->> 'meeting_uri') = 'https://meet.google.com/tit-ular-aaa'
  and (t::jsonb ->> 'temporary_access') = 'false'
  and jsonb_array_length(t::jsonb -> 'imports') = 1
  and (s::jsonb -> 'room' ->> 'meeting_uri') = 'https://meet.google.com/tro-caso-bru'
  and (s::jsonb ->> 'temporary_access') = 'false',
  'a professora da aula perdeu a sala em "Sala e resumo"'
)
from (select pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e02', '00000000-0000-4000-8000-000000009ea0') as t,
             pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009ea1') as s) as x;
-- Fora da janela e em qualquer outra ação: continua fechado.
select pg_temp.assert_true(
  pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009ea2')
    like 'ERRO:%google_meet_student_scope_required%'
  and pg_temp.meet('session_state', '00000000-0000-4000-8000-000000009e03', '00000000-0000-4000-8000-000000009ea0')
    like 'ERRO:%google_meet_student_scope_required%'
  and pg_temp.meet('session_detail', '00000000-0000-4000-8000-000000009e06', '00000000-0000-4000-8000-000000009ea0')
    like 'ERRO:%google_meet_student_scope_required%',
  'a janela do substituto abriu outra ação do Meet, outro aluno ou o professor alheio'
);

-- ---------------------------------------------------------------------------
-- 4. Pacote da cobertura
-- ---------------------------------------------------------------------------
create temp table brief1 as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-000000009ec1', true) as r;

select pg_temp.assert_true(
  (r ->> 'ok')::boolean
  and r -> 'queued' @> '["briefing","family","group"]'::jsonb
  and (r ->> 'approved_lesson')::boolean
  and (r ->> 'official_room')::boolean
  and r ->> 'dossier_url' = 'https://portal-troca.example.invalid/dossie-do-aluno?aluno=00000000-0000-4000-8000-000000009e11',
  'pacote da cobertura não saiu completo: ' || r::text
)
from brief1;

create temp table brief_rows as
select q.idempotency_key, q.student_phone, q.message_body, q.notification_kind, q.status, q.teacher_id
  from public.notification_queue q
 where q.tenant_id = 'troca-prof-school'
   and q.idempotency_key like 'coverage:00000000-0000-4000-8000-000000009ec1:%';

select pg_temp.assert_true(
  b.student_phone = '5511977770903'
  and b.notification_kind = 'MANAGEMENT_NOTICE' and b.status = 'pending'
  -- Instância central: a fila sai pela conta da direção.
  and b.teacher_id = '00000000-0000-4000-8000-000000009e01'
  -- A última aula APROVADA (a de 3 dias atrás): a data e o caminho para o
  -- dossiê — nem a rejeitada de ontem nem a aprovada de 10 dias atrás.
  and strpos(b.message_body, format('Última aula com resumo aprovado: %s', to_char(td.d - 3, 'DD/MM'))) > 0
  and strpos(b.message_body, 'estão no dossiê do aluno') > 0
  and strpos(b.message_body, format('Última aula com resumo aprovado: %s', to_char(td.d - 1, 'DD/MM'))) = 0
  and strpos(b.message_body, format('Última aula com resumo aprovado: %s', to_char(td.d - 10, 'DD/MM'))) = 0
  and strpos(b.message_body, 'https://meet.google.com/tro-caso-bru') > 0
  and strpos(b.message_body, 'https://portal-troca.example.invalid/dossie-do-aluno?aluno=00000000-0000-4000-8000-000000009e11') > 0
  and strpos(b.message_body, format('de %s a %s', to_char(td.d - 1, 'DD/MM'), to_char(td.d + 1, 'DD/MM'))) > 0,
  'pacote do substituto sem a última aula aprovada, a sala oficial ou o link do dossiê: ' || b.message_body
)
from brief_rows as b, td
where b.idempotency_key like '%:briefing';

select pg_temp.assert_true(
  -- O texto do resumo aprovado fica no dossiê, atrás do login: nada dele na fila.
  strpos(b.message_body, 'MARCADOR-PROXIMO-PASSO') = 0
  and strpos(b.message_body, 'MARCADOR-ERRO') = 0
  and strpos(b.message_body, 'MARCADOR-LICAO') = 0
  and strpos(b.message_body, 'MARCADOR-OBJETIVO-REAL') = 0
  and strpos(b.message_body, 'MARCADOR-TEMA') = 0
  and strpos(b.message_body, 'MARCADOR-OBJETIVO-PERFIL') = 0
  and strpos(b.message_body, 'MARCADOR-RESPONSAVEL') = 0
  and strpos(b.message_body, 'MARCADOR-REJEITADO') = 0
  and strpos(b.message_body, 'MARCADOR-VELHO') = 0
  and strpos(b.message_body, 'MARCADOR-OUTRA-ORIGEM') = 0
  and strpos(b.message_body, 'MARCADOR-TRANSCRICAO') = 0,
  'pacote do substituto levou texto do resumo aprovado, texto pessoal, resumo rejeitado/antigo ou transcrição: ' || b.message_body
)
from brief_rows as b
where b.idempotency_key like '%:briefing';

-- Pacote sem sala nem previsão de sala (o Beto não tem agendamento): o de
-- sempre — o substituto combina o link com o aluno.
select pg_temp.assert_true(
  (r ->> 'ok')::boolean
  and not (r ->> 'official_room')::boolean
  and not (r ->> 'school_room_expected')::boolean
  and strpos(r ->> 'briefing', 'combine direto e mande o link da aula') > 0
  and strpos(r ->> 'briefing', 'Última aula com resumo aprovado') = 0,
  'pacote sem sala e sem aula aprovada saiu errado: ' || r::text
)
from (select public.coverage_briefing_enqueue('00000000-0000-4000-8000-000000009ec2', false) as r) as x;

select pg_temp.assert_true(
  (select count(*) = 3 from brief_rows)
  and (select strpos(message_body, 'https://meet.google.com/tro-caso-bru') > 0
         and strpos(message_body, 'MARCADOR') = 0
         from brief_rows where idempotency_key like '%:family')
  and (select student_phone = '120363099990000001@g.us'
         and strpos(message_body, 'recebe no WhatsApp o pacote') > 0
         and strpos(message_body, 'NÃO recebe') = 0
         from brief_rows where idempotency_key like '%:group'),
  'família sem a sala oficial, ou grupo com a frase errada'
);

-- Idempotente: aceitar de novo (link e "consigo sim") não duplica nada.
select pg_temp.assert_true(
  (public.coverage_briefing_enqueue('00000000-0000-4000-8000-000000009ec1', true) -> 'queued') = '[]'::jsonb
  and (select count(*) = 3 from public.notification_queue q
        where q.tenant_id = 'troca-prof-school'
          and q.idempotency_key like 'coverage:00000000-0000-4000-8000-000000009ec1:%'),
  'pacote da cobertura duplicou'
);

-- Substituta sem WhatsApp: o pacote não sai e o grupo fica sabendo.
create temp table brief2 as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-000000009ec4', true) as r;
select pg_temp.assert_true(
  (r ->> 'ok')::boolean
  and not (r -> 'queued' @> '["briefing"]'::jsonb)
  and r -> 'queued' @> '["group"]'::jsonb
  and not (r ->> 'official_room')::boolean
  and (select strpos(q.message_body, 'NÃO recebe o pacote') > 0
         from public.notification_queue q
        where q.tenant_id = 'troca-prof-school'
          and q.idempotency_key = 'coverage:00000000-0000-4000-8000-000000009ec4:group'),
  'sem WhatsApp do substituto, o grupo não soube que o pacote não saiu: ' || r::text
)
from brief2;

-- Cobertura que não está confirmada não gera pacote.
select pg_temp.assert_true(
  (public.coverage_briefing_enqueue('00000000-0000-4000-8000-000000009ec3', true) ->> 'error') = 'cobertura_nao_confirmada',
  'convite pendente gerou pacote'
);

-- Exclusão a pedido depois do pacote: não sobra na fila nada do resumo
-- aprovado (a primeira versão copiava o próximo passo e os erros para
-- notification_queue.message_body, que a exclusão e a retenção não alcançam).
select pg_temp.as_user('00000000-0000-4000-8000-000000009e01');
select pg_temp.assert_true(
  (public.erase_student_lesson_records('00000000-0000-4000-8000-000000009e11') ->> 'ok')::boolean,
  'fixture: exclusão a pedido dos registros da Ana falhou'
);
select pg_temp.as_service();
select pg_temp.assert_true(
  not exists (select 1 from public.student_learning_memories m
               where m.student_id = '00000000-0000-4000-8000-000000009e11' and m.source_type = 'MEET_SESSION')
  and not exists (select 1 from public.notification_queue q
                   where q.tenant_id = 'troca-prof-school'
                     and (strpos(q.message_body, 'MARCADOR-PROXIMO-PASSO') > 0
                       or strpos(q.message_body, 'MARCADOR-ERRO') > 0
                       or strpos(q.message_body, 'MARCADOR-LICAO') > 0)),
  'depois da exclusão a pedido a fila ainda guarda texto do resumo aprovado'
);

-- ---------------------------------------------------------------------------
-- 4b. Aceite antes de a sala da escola existir (ela nasce nas 24 h antes)
-- ---------------------------------------------------------------------------
-- Sala prevista para a substituta na aula da Duda: escola conectada, conta
-- Google dela confirmada e aceite do termo da Duda (pelo responsável, com
-- código) e da substituta. O Enzo não respondeu ao termo: sem sala prevista.
do $termos$
begin
  -- O texto do termo é dado de migration: numa cópia só-estrutura ele não
  -- existe, e o teste publica um provisório (desfeito no rollback).
  if (private.lesson_recording_current_term('STUDENT')).version is null then
    insert into private.lesson_recording_terms (audience, version, body)
    values ('STUDENT', 'v1', repeat('Termo provisório do teste da troca de professor. ', 6));
  end if;
  if (private.lesson_recording_current_term('TEACHER')).version is null then
    insert into private.lesson_recording_terms (audience, version, body)
    values ('TEACHER', 'v1', repeat('Termo provisório do teste da troca de professor. ', 6));
  end if;
end
$termos$;

insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('troca-prof-school', 'troca-central-sub', 'escola-troca@example.invalid', 'CONNECTED',
        '00000000-0000-4000-8000-000000009e01');
insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
values ('00000000-0000-4000-8000-000000009e03', 'troca-prof-school', 'troca-bruna-sub', 'bruna-google@example.invalid', true);
insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
  signer_relation, term_audience, term_version, source, verification, verified_phone)
values
  ('troca-prof-school', '00000000-0000-4000-8000-000000009e1c', 'STUDENT', 'ACCEPTED', 'Responsavel Duda',
   'GUARDIAN', 'STUDENT', (private.lesson_recording_current_term('STUDENT')).version, 'APP', 'WHATSAPP_CODE', '(11) •••••-0922'),
  ('troca-prof-school', '00000000-0000-4000-8000-000000009e03', 'TEACHER', 'ACCEPTED', 'Bruna Substituta',
   'SELF', 'TEACHER', (private.lesson_recording_current_term('TEACHER')).version, 'APP', null, null);

-- Aula da Duda congelada com a TITULAR (aceite já marcado antes da cobertura):
-- a sala, se vier, é dela — a substituta não entra nela, então não há sala
-- prevista para a substituta.
set local session_replication_role = replica;
insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
  scheduled_start_at, scheduled_end_at, source_key, documentation_consent)
select '00000000-0000-4000-8000-000000009ed0', 'troca-prof-school', '00000000-0000-4000-8000-000000009e1c',
       '00000000-0000-4000-8000-000000009e02', td.d + 2,
       (td.d + 2 + time '10:00') at time zone 'America/Sao_Paulo',
       (td.d + 2 + time '10:30') at time zone 'America/Sao_Paulo', 'troca-prof-d-titular', true
from td;
insert into public.lesson_occurrences (tenant_id, session_id, source_type, source_id, class_date, start_time,
  scheduled_start_at, scheduled_end_at, entitlement_date, status)
select 'troca-prof-school', '00000000-0000-4000-8000-000000009ed0', 'booking', '00000000-0000-4000-8000-000000009eb4',
       td.d + 2, time '10:00',
       (td.d + 2 + time '10:00') at time zone 'America/Sao_Paulo',
       (td.d + 2 + time '10:30') at time zone 'America/Sao_Paulo', td.d + 2, 'SCHEDULED'
from td;
set local session_replication_role = origin;
select pg_temp.assert_true(
  not private.coverage_school_room_expected('00000000-0000-4000-8000-000000009ec5'),
  'aula congelada com a titular ainda previu sala da escola para a substituta'
);
-- A sessão da titular sai (sem a marca): a sessão da ocorrência é refeita para
-- quem dá a aula.
set local session_replication_role = replica;
update public.lesson_occurrences set status = 'SUPERSEDED' where session_id = '00000000-0000-4000-8000-000000009ed0';
update public.lesson_sessions set status = 'SUPERSEDED', documentation_consent = false
 where id = '00000000-0000-4000-8000-000000009ed0';
set local session_replication_role = origin;
select pg_temp.assert_true(
  private.coverage_school_room_expected('00000000-0000-4000-8000-000000009ec5')
  and not private.coverage_school_room_expected('00000000-0000-4000-8000-000000009ec6'),
  'previsão de sala errada (Duda com os dois aceites deveria ter; Enzo sem aceite, não)'
);

create temp table brief_duda as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-000000009ec5', false) as r;
create temp table brief_enzo as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-000000009ec6', false) as r;

select pg_temp.assert_true(
  not (d.r ->> 'official_room')::boolean
  and (d.r ->> 'school_room_expected')::boolean
  and strpos(d.r ->> 'briefing', 'o link chega por aqui quando a sala ficar pronta') > 0
  and strpos(d.r ->> 'briefing', 'Não mande outro link') > 0
  and strpos(d.r ->> 'briefing', 'combine direto e mande o link da aula') = 0
  and (select strpos(q.message_body, 'o link chega por aqui antes do horário') > 0
            and strpos(q.message_body, 'vai te chamar pelo WhatsApp para combinar o link') = 0
         from public.notification_queue q
        where q.tenant_id = 'troca-prof-school'
          and q.idempotency_key = 'coverage:00000000-0000-4000-8000-000000009ec5:family'),
  'aceite antes da sala: substituta ou família mandadas combinar outro link numa aula que terá sala da escola: ' || d.r::text
)
from brief_duda as d;

select pg_temp.assert_true(
  not (e.r ->> 'school_room_expected')::boolean
  and strpos(e.r ->> 'briefing', 'combine direto e mande o link da aula') > 0
  and strpos(e.r ->> 'briefing', 'o link chega por aqui') = 0
  and (select strpos(q.message_body, 'vai te chamar pelo WhatsApp para combinar o link') > 0
         from public.notification_queue q
        where q.tenant_id = 'troca-prof-school'
          and q.idempotency_key = 'coverage:00000000-0000-4000-8000-000000009ec6:family'),
  'sem sala prevista, o pacote deixou de mandar combinar o link: ' || e.r::text
)
from brief_enzo as e;

-- A sala da escola fica pronta para a substituta (a sessão da ocorrência é
-- dela): o link vai a ela e à família, uma vez.
set local session_replication_role = replica;
insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
  scheduled_start_at, scheduled_end_at, source_key, documentation_consent)
select '00000000-0000-4000-8000-000000009ed1', 'troca-prof-school', '00000000-0000-4000-8000-000000009e1c',
       '00000000-0000-4000-8000-000000009e03', td.d + 2,
       (td.d + 2 + time '10:00') at time zone 'America/Sao_Paulo',
       (td.d + 2 + time '10:30') at time zone 'America/Sao_Paulo', 'troca-prof-d-substituta', true
from td;
insert into public.lesson_occurrences (tenant_id, session_id, source_type, source_id, class_date, start_time,
  scheduled_start_at, scheduled_end_at, entitlement_date, status)
select 'troca-prof-school', '00000000-0000-4000-8000-000000009ed1', 'booking', '00000000-0000-4000-8000-000000009eb4',
       td.d + 2, time '10:00',
       (td.d + 2 + time '10:00') at time zone 'America/Sao_Paulo',
       (td.d + 2 + time '10:30') at time zone 'America/Sao_Paulo', td.d + 2, 'SCHEDULED'
from td;
set local session_replication_role = origin;
insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub, cohost_email, state, created_by)
values ('00000000-0000-4000-8000-000000009ed1', 'troca-prof-school', 'spaces/trocaD1', 'https://meet.google.com/dud-aant-bru',
        'troca-central-sub', 'bruna-google@example.invalid', 'CREATING', '00000000-0000-4000-8000-000000009e03');
select pg_temp.assert_true(
  not exists (select 1 from public.notification_queue q
               where q.tenant_id = 'troca-prof-school'
                 and q.idempotency_key like 'coverage:00000000-0000-4000-8000-000000009ec5:room%'),
  'sala ainda sendo criada já avisou a substituta'
);
update private.google_meet_rooms set state = 'READY'
 where lesson_session_id = '00000000-0000-4000-8000-000000009ed1';

select pg_temp.assert_true(
  (select count(*) = 1 from public.notification_queue q
    where q.tenant_id = 'troca-prof-school'
      and q.idempotency_key = 'coverage:00000000-0000-4000-8000-000000009ec5:room'
      and q.student_phone = '5511977770903'
      and q.notification_kind = 'MANAGEMENT_NOTICE'
      and q.teacher_id = '00000000-0000-4000-8000-000000009e01'
      and strpos(q.message_body, 'https://meet.google.com/dud-aant-bru') > 0
      and strpos(q.message_body, 'não mande outro link') > 0)
  and (select count(*) = 1 from public.notification_queue q
    where q.tenant_id = 'troca-prof-school'
      and q.idempotency_key = 'coverage:00000000-0000-4000-8000-000000009ec5:room-family'
      and q.student_phone = '5511966660922'
      and strpos(q.message_body, 'https://meet.google.com/dud-aant-bru') > 0),
  'sala pronta depois do aceite não chegou à substituta e à família'
);

-- Uma vez só: gravar a sala de novo, ou pedir o aviso de novo, não repete. E a
-- cobertura que já levou a sala no pacote (Ana) não recebe aviso nenhum.
update private.google_meet_rooms set state = 'READY', updated_at = now()
 where lesson_session_id = '00000000-0000-4000-8000-000000009ed1';
select pg_temp.assert_true(
  (private.coverage_room_notice_enqueue('00000000-0000-4000-8000-000000009ec5') -> 'queued') = '[]'::jsonb
  and (select count(*) = 2 from public.notification_queue q
        where q.tenant_id = 'troca-prof-school'
          and q.idempotency_key like 'coverage:00000000-0000-4000-8000-000000009ec5:room%')
  and coalesce(private.coverage_room_notice_enqueue('00000000-0000-4000-8000-000000009ec1') -> 'queued', '[]'::jsonb) = '[]'::jsonb
  and not exists (select 1 from public.notification_queue q
                   where q.tenant_id = 'troca-prof-school'
                     and q.idempotency_key like 'coverage:00000000-0000-4000-8000-000000009ec1:room%')
  -- Enzo sem sala: nada.
  and not exists (select 1 from public.notification_queue q
                   where q.tenant_id = 'troca-prof-school'
                     and q.idempotency_key like 'coverage:00000000-0000-4000-8000-000000009ec6:room%'),
  'aviso de sala pronta repetiu, ou foi a quem já tinha a sala, ou a quem não tem sala'
);

-- ---------------------------------------------------------------------------
-- 5. Transferência definitiva: o novo titular recebe o link do dossiê
-- ---------------------------------------------------------------------------
-- (a) Direta pela Gestão (nasce APPLIED).
select pg_temp.as_user('00000000-0000-4000-8000-000000009e01');
create temp table direct_transfer as
select public.admin_transfer_student_teacher('00000000-0000-4000-8000-000000009e18',
  '00000000-0000-4000-8000-000000009e05', 'Motivo do teste de transferência') as r;
select pg_temp.as_service();

-- A transferência direta voltou a funcionar (o gatilho de bookings já grava o
-- professor novo no perfil antes da trava da função).
select pg_temp.assert_true(
  (d.r ->> 'ok')::boolean
  and (select professor_id = '00000000-0000-4000-8000-000000009e05'
         from public.profiles where id = '00000000-0000-4000-8000-000000009e18')
  and (select teacher_id = '00000000-0000-4000-8000-000000009e05'
         from public.bookings where id = '00000000-0000-4000-8000-000000009eb2'),
  'transferência direta da Gestão não trocou o professor: ' || d.r::text
)
from direct_transfer as d;

select pg_temp.assert_true(
  (select count(*) = 1 from public.notification_queue q
    where q.tenant_id = 'troca-prof-school'
      and q.idempotency_key = format('teacher-transfer:%s:dossier', d.r ->> 'transfer_id'))
  and (select q.student_phone = '5511977770905'
          and q.notification_kind = 'MANAGEMENT_NOTICE'
          and q.teacher_id = '00000000-0000-4000-8000-000000009e01'
          and strpos(q.message_body, 'Kiko Transferido') > 0
          and strpos(q.message_body, 'https://portal-troca.example.invalid/dossie-do-aluno?aluno=00000000-0000-4000-8000-000000009e18') > 0
         from public.notification_queue q
        where q.tenant_id = 'troca-prof-school'
          and q.idempotency_key = format('teacher-transfer:%s:dossier', d.r ->> 'transfer_id')),
  'transferência direta não avisou o novo titular com o link do dossiê: ' || d.r::text
)
from direct_transfer as d;

-- (b) Com aceite do professor: PENDENTE não avisa; o aceite avisa uma vez; a
-- aplicação na data de corte não repete.
insert into public.teacher_transfers (id, tenant_id, student_id, from_teacher_id, to_teacher_id, proposed_slots, cutover_date, status)
select '00000000-0000-4000-8000-000000009ef1', 'troca-prof-school', '00000000-0000-4000-8000-000000009e19',
       '00000000-0000-4000-8000-000000009e02', '00000000-0000-4000-8000-000000009e05',
       '[{"day_of_week":"Quinta","time_slot":"16:00"}]'::jsonb, td.d + 5, 'PENDING'
from td;
select pg_temp.assert_true(
  not exists (select 1 from public.notification_queue q
               where q.tenant_id = 'troca-prof-school'
                 and q.idempotency_key = 'teacher-transfer:00000000-0000-4000-8000-000000009ef1:dossier'),
  'transferência ainda não aceita já avisou o novo titular'
);
select pg_temp.assert_true(
  (public.respond_teacher_transfer(t.token, true, null) ->> 'ok')::boolean,
  'fixture: aceite da transferência falhou'
)
from public.teacher_transfers t where t.id = '00000000-0000-4000-8000-000000009ef1';
update public.teacher_transfers set status = 'APPLIED', applied_at = now()
 where id = '00000000-0000-4000-8000-000000009ef1';
select pg_temp.assert_true(
  (select count(*) = 1 from public.notification_queue q
    where q.tenant_id = 'troca-prof-school'
      and q.idempotency_key = 'teacher-transfer:00000000-0000-4000-8000-000000009ef1:dossier')
  and (select strpos(q.message_body, to_char(td.d + 5, 'DD/MM')) > 0
          and strpos(q.message_body, '/dossie-do-aluno?aluno=00000000-0000-4000-8000-000000009e19') > 0
         from public.notification_queue q, td
        where q.tenant_id = 'troca-prof-school'
          and q.idempotency_key = 'teacher-transfer:00000000-0000-4000-8000-000000009ef1:dossier'),
  'transferência com aceite não avisou uma vez só'
);

-- (c) Novo titular sem WhatsApp: a transferência acontece, o aviso não.
insert into public.teacher_transfers (id, tenant_id, student_id, from_teacher_id, to_teacher_id, proposed_slots, cutover_date, status, applied_at)
select '00000000-0000-4000-8000-000000009ef2', 'troca-prof-school', '00000000-0000-4000-8000-000000009e1b',
       '00000000-0000-4000-8000-000000009e02', '00000000-0000-4000-8000-000000009e07',
       '[]'::jsonb, td.d, 'APPLIED', now()
from td;
select pg_temp.assert_true(
  exists (select 1 from public.teacher_transfers where id = '00000000-0000-4000-8000-000000009ef2')
  and not exists (select 1 from public.notification_queue q
                   where q.tenant_id = 'troca-prof-school'
                     and q.idempotency_key = 'teacher-transfer:00000000-0000-4000-8000-000000009ef2:dossier')
  and (private.teacher_transfer_dossier_enqueue('00000000-0000-4000-8000-000000009ef2') ->> 'error') = 'professor_sem_whatsapp',
  'novo titular sem WhatsApp derrubou a transferência ou gerou aviso sem destino'
);

-- ---------------------------------------------------------------------------
-- 6. Lista de sessões pela porta da tela (depois do pacote: a porta
--    materializa a agenda e não é o que se confere acima).
-- ---------------------------------------------------------------------------
select pg_temp.as_user('00000000-0000-4000-8000-000000009e03');
select pg_temp.assert_true(
  (public.get_lesson_sessions('00000000-0000-4000-8000-000000009e11', null, null) ->> 'ok')::boolean,
  'get_lesson_sessions recusou o substituto na janela'
);
do $sessions$
begin
  perform public.get_lesson_sessions('00000000-0000-4000-8000-000000009e12', null, null);
  raise exception 'assertion failed: get_lesson_sessions abriu aluno fora da janela';
exception when others then
  if sqlerrm not like '%sem_permissao%' then raise; end if;
end
$sessions$;
select pg_temp.as_service();

rollback;
