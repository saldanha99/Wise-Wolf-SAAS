-- Extrato de pontualidade do professor (migration 20260928120000), DESLIGADO
-- por escola até o jurídico liberar.
--
-- 1. Desligado (o padrão, sem linha de configuração): a avaliação de presença e
--    a varredura não gravam nada, as RPCs devolvem só {enabled: false} e a
--    tabela não é exposta a ninguém (sem grant, RLS sem policy).
-- 2. Ligado: a avaliação grava os números do professor (FOUND com atraso,
--    minutos na sala e saída antecipada; NOT_FOUND quando a sala teve reunião e
--    a planilha não apareceu; NO_CONFERENCE; UNPARSED), a varredura grava a aula
--    sem sala da escola (NO_ROOM) e a sala cuja importação terminou sem
--    avaliação (NOT_FOUND). Falta do professor não entra; aula de antes de ligar
--    não entra; troca de professor depois da medição refaz com a conta de quem
--    deu a aula. O resumo do mês bate com as aulas, sem nota nem ranking.
-- 3. Professor só vê o dele; direção e coordenação veem um professor por vez;
--    professor não usa a porta da direção; outra escola não entra.
-- 4. Retenção (purga) e desligar apaga o extrato da escola.
-- 5. Superfície: funções internas fechadas, RPCs só para authenticated, porta da
--    edge só service_role, remendo da avaliação no lugar.
--
-- Reprova contra o código anterior (a tabela e as funções não existem; a
-- avaliação não deixava rastro nenhum de "relatório não encontrado"). Não
-- depende de dado real (fixtures próprias), da fila global nem do horário do
-- dia: as aulas são de dois dias atrás, e o extrato é pedido pelo mês delas.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.ponto_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'extrato de pontualidade: %', p_message;
  end if;
end;
$$;
grant execute on function pg_temp.ponto_assert(boolean, text) to public;

select pg_temp.ponto_assert(to_regclass('public.teacher_lesson_presence') is not null
  and to_regprocedure('private.teacher_lesson_presence_record(uuid,integer,boolean)') is not null
  and to_regprocedure('public.get_my_punctuality_extract(date)') is not null
  and to_regprocedure('public.get_teacher_punctuality_extract(uuid,date)') is not null,
  'o extrato não existe (tabela ou RPCs ausentes)');

set local request.jwt.claims = '{"role":"service_role"}';

-- ─── Fixtures ────────────────────────────────────────────────────────────────
create temp table ponto_clock as
select (now() at time zone 'America/Sao_Paulo')::date - 2 as y;
grant select on ponto_clock to public;

create or replace function pg_temp.ponto_y() returns date language sql as $$ select y from ponto_clock $$;
grant execute on function pg_temp.ponto_y() to public;
-- Horário da escola (BRT) no dia das aulas.
create or replace function pg_temp.ponto_at(p_time time)
returns timestamptz language sql as $$
  select (pg_temp.ponto_y() + p_time) at time zone 'America/Sao_Paulo'
$$;
-- ISO como o attendance.ts grava na planilha.
create or replace function pg_temp.ponto_iso(p_at timestamptz)
returns text language sql as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values ('ponto-test', 'Ponto Test', 'ponto-test', 'active', true),
       ('ponto-outra', 'Ponto Outra', 'ponto-outra', 'active', true);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select v.id, 'authenticated', 'authenticated', v.email, '{"provider":"email","providers":["email"]}',
  jsonb_build_object('full_name', v.name), now(), now()
from (values
  ('00000000-0000-4000-8000-0000000e8001'::uuid, 'ponto-admin@example.invalid', 'Diretora Ponto'),
  ('00000000-0000-4000-8000-0000000e8002'::uuid, 'ponto-coord@example.invalid', 'Coordenadora Ponto'),
  ('00000000-0000-4000-8000-0000000e8003'::uuid, 'ponto-ana@example.invalid', 'Ana Professora'),
  ('00000000-0000-4000-8000-0000000e8004'::uuid, 'ponto-bia@example.invalid', 'Bia Professora'),
  ('00000000-0000-4000-8000-0000000e8005'::uuid, 'ponto-caio@example.invalid', 'Caio Professor'),
  ('00000000-0000-4000-8000-0000000e8006'::uuid, 'ponto-aluno@example.invalid', 'Aluno Ponto'),
  ('00000000-0000-4000-8000-0000000e8007'::uuid, 'ponto-fora@example.invalid', 'Professor de Fora')
) as v(id, email, name);

update public.profiles as p
set tenant_id = v.tenant, role = v.role, lifecycle_status = 'active', full_name = v.name,
    phone = v.phone, is_test_account = false
from (values
  ('00000000-0000-4000-8000-0000000e8001'::uuid, 'ponto-test', 'SCHOOL_ADMIN', 'Diretora Ponto', '5511999998001'),
  ('00000000-0000-4000-8000-0000000e8002'::uuid, 'ponto-test', 'COORDINATOR', 'Coordenadora Ponto', '5511999998002'),
  ('00000000-0000-4000-8000-0000000e8003'::uuid, 'ponto-test', 'TEACHER', 'Ana Professora', '5511999998003'),
  ('00000000-0000-4000-8000-0000000e8004'::uuid, 'ponto-test', 'TEACHER', 'Bia Professora', '5511999998004'),
  ('00000000-0000-4000-8000-0000000e8005'::uuid, 'ponto-test', 'TEACHER', 'Caio Professor', '5511999998005'),
  ('00000000-0000-4000-8000-0000000e8006'::uuid, 'ponto-test', 'STUDENT', 'Aluno Ponto', '5511988888006'),
  ('00000000-0000-4000-8000-0000000e8007'::uuid, 'ponto-outra', 'TEACHER', 'Professor de Fora', '5511999998007')
) as v(id, tenant, role, name, phone)
where p.id = v.id;

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
select p.id, p.tenant_id, p.role, 'ACTIVE', true
from public.profiles as p
where p.id in (
  '00000000-0000-4000-8000-0000000e8001', '00000000-0000-4000-8000-0000000e8002',
  '00000000-0000-4000-8000-0000000e8003', '00000000-0000-4000-8000-0000000e8004',
  '00000000-0000-4000-8000-0000000e8005', '00000000-0000-4000-8000-0000000e8006',
  '00000000-0000-4000-8000-0000000e8007')
on conflict (user_id, tenant_id) do update
set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

-- Contas Google confirmadas (é por elas que a planilha reconhece o professor).
insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
values
  ('00000000-0000-4000-8000-0000000e8003', 'ponto-test', 'sub-ponto-ana', 'ana.google@example.invalid', true),
  ('00000000-0000-4000-8000-0000000e8004', 'ponto-test', 'sub-ponto-bia', 'bia.google@example.invalid', true),
  ('00000000-0000-4000-8000-0000000e8005', 'ponto-test', 'sub-ponto-caio', 'caio.google@example.invalid', true)
on conflict (teacher_id) do update set google_email = excluded.google_email;

-- Aulas de 30 min, dois dias atrás (L0: oito dias atrás, antes de ligar).
--   L1 Ana 10:00 entrou 10:07 (7 min), saiu 10:28 — FOUND
--   L2 Ana 11:00 entrou 10:58, saiu 11:31 — FOUND, pontual
--   L3 Ana 12:00 entrou 12:12 (12 min), saiu 12:20 — FOUND, saída antecipada
--   L4 Ana 13:00 reunião aberta, planilha não apareceu — NOT_FOUND
--   L5 Ana 14:00 sala nem abriu — NO_CONFERENCE
--   L6 Ana 15:00 planilha ilegível — UNPARSED
--   L7 Ana 16:00 sem sala da escola — NO_ROOM (varredura)
--   L8 Ana 17:00 falta do professor lançada — fora do extrato
--   L9 Bia 10:00 entrou 10:01 — FOUND (da Bia)
--   L10 Ana 18:00, a direção atesta depois que o Caio deu a aula — refeita para o Caio
--   L11 Ana 19:00 sala pronta, importação terminou sem avaliação — NOT_FOUND (varredura)
create temp table ponto_lessons as
select v.label, v.id, v.teacher_id, v.start_time, v.room, v.day_offset
from (values
  ('L0', '00000000-0000-4000-8000-0000000e8a00'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '09:00', true, -6),
  ('L1', '00000000-0000-4000-8000-0000000e8a01'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '10:00', true, 0),
  ('L2', '00000000-0000-4000-8000-0000000e8a02'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '11:00', true, 0),
  ('L3', '00000000-0000-4000-8000-0000000e8a03'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '12:00', true, 0),
  ('L4', '00000000-0000-4000-8000-0000000e8a04'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '13:00', true, 0),
  ('L5', '00000000-0000-4000-8000-0000000e8a05'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '14:00', true, 0),
  ('L6', '00000000-0000-4000-8000-0000000e8a06'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '15:00', true, 0),
  ('L7', '00000000-0000-4000-8000-0000000e8a07'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '16:00', false, 0),
  ('L8', '00000000-0000-4000-8000-0000000e8a08'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '17:00', true, 0),
  ('L9', '00000000-0000-4000-8000-0000000e8a09'::uuid, '00000000-0000-4000-8000-0000000e8004'::uuid, time '10:00', true, 0),
  ('L10', '00000000-0000-4000-8000-0000000e8a10'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '18:00', true, 0),
  ('L11', '00000000-0000-4000-8000-0000000e8a11'::uuid, '00000000-0000-4000-8000-0000000e8003'::uuid, time '19:00', true, 0)
) as v(label, id, teacher_id, start_time, room, day_offset);

insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date, scheduled_start_at,
  scheduled_end_at, source_key, status, documentation_consent)
select l.id, 'ponto-test', '00000000-0000-4000-8000-0000000e8006', l.teacher_id, pg_temp.ponto_y() + l.day_offset,
  (pg_temp.ponto_y() + l.day_offset + l.start_time) at time zone 'America/Sao_Paulo',
  (pg_temp.ponto_y() + l.day_offset + l.start_time + interval '30 minutes') at time zone 'America/Sao_Paulo',
  'ponto-' || l.label, 'SCHEDULED', l.room
from ponto_lessons as l;

insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
  cohost_email, state, created_by)
select l.id, 'ponto-test', 'spaces/ponto' || l.label,
  'https://meet.google.com/' || translate(lower(l.label), '0123456789', 'abcdefghij') || 'x-pont-abc', 'ponto-sub-central',
  case l.teacher_id when '00000000-0000-4000-8000-0000000e8004' then 'bia.google@example.invalid'
    else 'ana.google@example.invalid' end,
  'READY', '00000000-0000-4000-8000-0000000e8001'
from ponto_lessons as l
where l.room;

-- L11: a importação terminou (por exemplo, relatório de presença desligado na
-- instalação) sem nenhuma avaliação.
update private.google_meet_rooms set sync_status = 'COMPLETE'
where lesson_session_id = '00000000-0000-4000-8000-0000000e8a11';

-- L8: falta do professor lançada, já ligada à sessão. As sessões de teste não
-- vêm da agenda: sem a religação do lançamento (que remonta as sessões do dia
-- pela agenda), a aula sem sala não é arquivada como "sem fonte".
alter table public.class_logs disable trigger trg_zy_require_finished_lesson_slot;
alter table public.class_logs disable trigger link_class_log_quality_session;
insert into public.class_logs (id, tenant_id, teacher_id, student_id, lesson_session_id, presence, date, class_date,
  start_time, created_at)
values ('00000000-0000-4000-8000-0000000e8c08', 'ponto-test', '00000000-0000-4000-8000-0000000e8003',
  '00000000-0000-4000-8000-0000000e8006', '00000000-0000-4000-8000-0000000e8a08', 'TEACHER_ABSENCE',
  pg_temp.ponto_y(), pg_temp.ponto_y(), '17:00', now());
alter table public.class_logs enable trigger link_class_log_quality_session;
alter table public.class_logs enable trigger trg_zy_require_finished_lesson_slot;
select pg_temp.ponto_assert(
  private.lesson_session_logged_presence('00000000-0000-4000-8000-0000000e8a08') = 'TEACHER_ABSENCE'
  and (select bool_and(s.status = 'SCHEDULED') from public.lesson_sessions as s
       where s.id in (select id from ponto_lessons)),
  'fixture: a falta do professor não ficou ligada à aula L8, ou uma aula de teste foi arquivada');

create or replace function pg_temp.ponto_sid(p_label text)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from ponto_lessons where label = p_label;
  if v_id is null then
    raise exception 'extrato de pontualidade: fixture sem a aula %', p_label;
  end if;
  return v_id;
end;
$$;

-- Planilha como a edge grava (attendance_save): professor pela conta
-- confirmada, aluno com nome e e-mail — que nunca podem sair no extrato.
create or replace function pg_temp.ponto_save(p_label text, p_teacher_email text, p_join time, p_left time)
returns void language plpgsql as $$
declare
  v_join timestamptz := pg_temp.ponto_at(p_join);
  v_left timestamptz := pg_temp.ponto_at(p_left);
  v_seconds integer := extract(epoch from (v_left - v_join))::integer;
begin
  perform public.google_meet_attendance_backend('attendance_save', 'ponto-test', pg_temp.ponto_sid(p_label),
    jsonb_build_object(
      'conference_name', 'conferenceRecords/ponto-' || p_label,
      'document_id', 'doc-ponto-' || p_label,
      'document_name', 'Relatório de participação ponto ' || p_label,
      'source_document_ids', jsonb_build_array('doc-ponto-' || p_label),
      'source_csv', 'Nome,E-mail,Entrada,Saída',
      'content_sha256', encode(extensions.digest('ponto-' || p_label, 'sha256'), 'hex'),
      'participants', jsonb_build_array(
        jsonb_build_object('name', 'Professor', 'email', p_teacher_email, 'joinedAt', pg_temp.ponto_iso(v_join),
          'leftAt', pg_temp.ponto_iso(v_left), 'durationSeconds', v_seconds, 'role', 'TEACHER'),
        jsonb_build_object('name', 'Aluno Ponto Sigiloso', 'email', 'aluno.sigiloso@example.invalid',
          'joinedAt', pg_temp.ponto_iso(pg_temp.ponto_at(p_join)), 'leftAt', pg_temp.ponto_iso(v_left),
          'durationSeconds', 1111, 'role', 'STUDENT')),
      'teacher_first_join_at', v_join,
      'teacher_seconds', v_seconds,
      'student_first_join_at', v_join,
      'student_seconds', 1111,
      'retention_days', 90));
end;
$$;

create or replace function pg_temp.ponto_evaluate(p_label text, p_conferences integer, p_open boolean default false)
returns jsonb language sql as $$
  select public.google_meet_attendance_backend('attendance_evaluate', 'ponto-test', pg_temp.ponto_sid(p_label),
    jsonb_build_object('conference_count', p_conferences, 'report_found', p_conferences > 0,
      'conference_open', p_open))
$$;

-- Planilhas e uma rodada de avaliação, como a fila faria.
select pg_temp.ponto_save('L1', 'ana.google@example.invalid', time '10:07', time '10:28');
select pg_temp.ponto_save('L2', 'ana.google@example.invalid', time '10:58', time '11:31');
select pg_temp.ponto_save('L3', 'ana.google@example.invalid', time '12:12', time '12:20');
select pg_temp.ponto_save('L9', 'bia.google@example.invalid', time '10:01', time '10:30');
-- L10: a planilha foi guardada com a Ana como professora; quem entrou foi o Caio.
select pg_temp.ponto_save('L10', 'caio.google@example.invalid', time '18:03', time '18:30');
select public.google_meet_attendance_backend('attendance_save', 'ponto-test', pg_temp.ponto_sid('L6'),
  jsonb_build_object('conference_name', 'conferenceRecords/ponto-L6', 'document_id', 'doc-ponto-L6',
    'document_name', 'Relatório ilegível', 'source_csv', 'lixo', 'content_sha256', encode(extensions.digest('ponto-L6', 'sha256'), 'hex'),
    'parse_error', 'attendance_header_not_found', 'participants', '[]'::jsonb, 'retention_days', 90));

create or replace function pg_temp.ponto_round()
returns void language plpgsql as $$
begin
  perform pg_temp.ponto_evaluate('L1', 1);
  perform pg_temp.ponto_evaluate('L2', 1);
  perform pg_temp.ponto_evaluate('L3', 1);
  perform pg_temp.ponto_evaluate('L4', 1);
  perform pg_temp.ponto_evaluate('L5', 0);
  perform pg_temp.ponto_evaluate('L6', 1);
  perform pg_temp.ponto_evaluate('L8', 1);
  perform pg_temp.ponto_evaluate('L9', 1);
  perform pg_temp.ponto_evaluate('L10', 1);
  perform pg_temp.ponto_evaluate('L0', 0);
end;
$$;

-- RPC como a pessoa logada (role authenticated, JWT dela).
create or replace function pg_temp.ponto_as(p_user uuid, p_sql text)
returns jsonb language plpgsql as $$
declare
  v_result jsonb;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql into v_result;
  exception when others then
    v_result := jsonb_build_object('error', sqlerrm);
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  return v_result;
end;
$$;

-- ─── 1. Desligado (padrão): nada é gravado nem mostrado ─────────────────────────
select pg_temp.ponto_assert(
  not exists (select 1 from private.teacher_punctuality_settings where tenant_id = 'ponto-test'),
  'fixture: escola nova já nasce com configuração do extrato');

select pg_temp.ponto_round();
select private.teacher_lesson_presence_sweep();

select pg_temp.ponto_assert(
  not exists (select 1 from public.teacher_lesson_presence where tenant_id = 'ponto-test'),
  'extrato desligado gravou números do professor');
select pg_temp.ponto_assert(
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8003',
    format('select public.get_my_punctuality_extract(%L::date)', pg_temp.ponto_y()))
    = '{"ok":true,"enabled":false}'::jsonb
  and pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8001',
    format('select public.get_teacher_punctuality_extract(%L::uuid, %L::date)',
      '00000000-0000-4000-8000-0000000e8003', pg_temp.ponto_y()))
    = '{"ok":true,"enabled":false}'::jsonb,
  'extrato desligado mostrou algo além de "desligado"');

-- A tabela não é exposta a ninguém, ligado ou não.
select pg_temp.ponto_assert(
  not has_table_privilege('authenticated', 'public.teacher_lesson_presence', 'SELECT')
  and not has_table_privilege('anon', 'public.teacher_lesson_presence', 'SELECT')
  and not has_table_privilege('service_role', 'public.teacher_lesson_presence', 'SELECT')
  and not has_table_privilege('authenticated', 'private.teacher_punctuality_settings', 'SELECT')
  and (select relrowsecurity from pg_class where oid = 'public.teacher_lesson_presence'::regclass)
  and not exists (select 1 from pg_policy where polrelid = 'public.teacher_lesson_presence'::regclass),
  'tabela do extrato exposta (grant ou policy)');
select pg_temp.ponto_assert(
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8001',
    'select to_jsonb(count(*)) from public.teacher_lesson_presence') ->> 'error' like '%permission denied%',
  'a direção leu a tabela do extrato direto');

-- ─── 2. Ligado ────────────────────────────────────────────────────────────────
-- Motivo curto é recusado; ligar grava a trilha.
do $$
begin
  perform private.set_teacher_punctuality_enabled('ponto-test', true, 'curto');
  raise exception 'extrato de pontualidade: ligou sem motivo';
exception when others then
  if sqlerrm <> 'motivo_obrigatorio' then
    raise;
  end if;
end;
$$;
select private.set_teacher_punctuality_enabled('ponto-test', true,
  'Parecer do jurídico de teste: extrato liberado para a escola.');
select pg_temp.ponto_assert(
  (select enabled and enabled_at is not null from private.teacher_punctuality_settings where tenant_id = 'ponto-test')
  and (select count(*) = 1 from private.teacher_punctuality_setting_events where tenant_id = 'ponto-test' and enabled),
  'ligar o extrato não gravou a configuração e a trilha');
-- As aulas de teste são de dois dias atrás: o extrato "foi ligado" há cinco.
update private.teacher_punctuality_settings set enabled_at = now() - interval '5 days'
where tenant_id = 'ponto-test';

-- Conferência ainda aberta não é medida (nem vira "não encontrado").
select pg_temp.ponto_evaluate('L4', 1, true);
select pg_temp.ponto_assert(
  not exists (select 1 from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid('L4')),
  'conferência aberta virou linha do extrato');

select pg_temp.ponto_round();

create or replace function pg_temp.ponto_row(p_label text)
returns public.teacher_lesson_presence language sql as $$
  select * from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid(p_label)
$$;

select pg_temp.ponto_assert(
  (select status = 'FOUND' and late_minutes = 7 and minutes_in_room = 21 and left_early_minutes = 2
     and first_join_at = pg_temp.ponto_at(time '10:07') and scheduled_minutes = 30
     and teacher_id = '00000000-0000-4000-8000-0000000e8003' and class_date = pg_temp.ponto_y()
   from pg_temp.ponto_row('L1')),
  'L1: atraso de 7 min, 21 min na sala e saída 2 min antes não gravados: '
    || coalesce(to_jsonb(pg_temp.ponto_row('L1'))::text, 'sem linha'));
select pg_temp.ponto_assert(
  (select status = 'FOUND' and late_minutes = 0 and minutes_in_room = 33 and left_early_minutes = 0
   from pg_temp.ponto_row('L2')),
  'L2: entrada antes do horário não virou pontual');
select pg_temp.ponto_assert(
  (select status = 'FOUND' and late_minutes = 12 and minutes_in_room = 8 and left_early_minutes = 10
   from pg_temp.ponto_row('L3')),
  'L3: atraso de 12 min e saída 10 min antes não gravados');
select pg_temp.ponto_assert(
  (select status = 'NOT_FOUND' and first_join_at is null and minutes_in_room is null from pg_temp.ponto_row('L4')),
  'L4: reunião sem planilha não deixou rastro (NOT_FOUND)');
select pg_temp.ponto_assert((select status = 'NO_CONFERENCE' from pg_temp.ponto_row('L5')),
  'L5: sala que nem abriu não virou NO_CONFERENCE');
select pg_temp.ponto_assert((select status = 'UNPARSED' from pg_temp.ponto_row('L6')),
  'L6: planilha ilegível não virou UNPARSED');
select pg_temp.ponto_assert(
  not exists (select 1 from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid('L8')),
  'L8: falta do professor entrou no extrato');
select pg_temp.ponto_assert(
  not exists (select 1 from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid('L0')),
  'L0: aula de antes de ligar entrou no extrato');
-- L10 com a Ana: a planilha só tem o Caio — a Ana não aparece.
select pg_temp.ponto_assert(
  (select status = 'FOUND' and first_join_at is null and minutes_in_room = 0 and late_minutes is null
     and teacher_id = '00000000-0000-4000-8000-0000000e8003'
   from pg_temp.ponto_row('L10')),
  'L10: professora ausente da planilha não ficou "não aparece na planilha"');

-- Varredura: L7 sem sala (NO_ROOM), L11 importação terminada sem avaliação.
select private.teacher_lesson_presence_sweep();
select pg_temp.ponto_assert((select status = 'NO_ROOM' from pg_temp.ponto_row('L7')),
  'L7: aula sem sala da escola não entrou como NO_ROOM');
select pg_temp.ponto_assert((select status = 'NOT_FOUND' from pg_temp.ponto_row('L11')),
  'L11: sala sem avaliação depois da importação não entrou como NOT_FOUND');
select pg_temp.ponto_assert(
  not exists (select 1 from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid('L8')),
  'varredura pôs a falta do professor no extrato');

-- A direção atesta que o Caio deu a L10 (a aula passa para ele): a varredura
-- refaz com a conta dele — 3 min de atraso, na conta do Caio, não da Ana.
update public.lesson_sessions set teacher_id = '00000000-0000-4000-8000-0000000e8005'
where id = pg_temp.ponto_sid('L10');
select private.teacher_lesson_presence_sweep();
select pg_temp.ponto_assert(
  (select status = 'FOUND' and teacher_id = '00000000-0000-4000-8000-0000000e8005' and late_minutes = 3
     and minutes_in_room = 27 and first_join_at = pg_temp.ponto_at(time '18:03')
   from pg_temp.ponto_row('L10')),
  'L10: troca depois da medição não refez o extrato com quem deu a aula: '
    || coalesce(to_jsonb(pg_temp.ponto_row('L10'))::text, 'sem linha'));

-- Aula arquivada sai do extrato.
update public.lesson_sessions set status = 'SUPERSEDED' where id = pg_temp.ponto_sid('L9');
select private.teacher_lesson_presence_sweep();
select pg_temp.ponto_assert(
  not exists (select 1 from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid('L9')),
  'aula arquivada ficou no extrato');
update public.lesson_sessions set status = 'SCHEDULED' where id = pg_temp.ponto_sid('L9');
select pg_temp.ponto_evaluate('L9', 1);

-- Nada disto tocou lançamento nem pagamento.
select pg_temp.ponto_assert(
  (select count(*) = 1 from public.class_logs where tenant_id = 'ponto-test'),
  'o extrato criou ou apagou lançamento de aula');

-- ─── 3. Quem vê o quê ─────────────────────────────────────────────────────────
create temp table ponto_views as
select
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8003',
    format('select public.get_my_punctuality_extract(%L::date)', pg_temp.ponto_y())) as ana,
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8004',
    format('select public.get_my_punctuality_extract(%L::date)', pg_temp.ponto_y())) as bia,
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8001',
    format('select public.get_teacher_punctuality_extract(%L::uuid, %L::date)',
      '00000000-0000-4000-8000-0000000e8003', pg_temp.ponto_y())) as admin_ana,
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8002',
    format('select public.get_teacher_punctuality_extract(%L::uuid, %L::date)',
      '00000000-0000-4000-8000-0000000e8004', pg_temp.ponto_y())) as coord_bia,
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8003',
    format('select public.get_teacher_punctuality_extract(%L::uuid, %L::date)',
      '00000000-0000-4000-8000-0000000e8004', pg_temp.ponto_y())) as ana_on_admin_door,
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8001',
    format('select public.get_teacher_punctuality_extract(%L::uuid, %L::date)',
      '00000000-0000-4000-8000-0000000e8007', pg_temp.ponto_y())) as admin_outsider,
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8006',
    format('select public.get_my_punctuality_extract(%L::date)', pg_temp.ponto_y())) as student,
  pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8001',
    format('select public.get_teacher_punctuality_extract(null, %L::date)', pg_temp.ponto_y())) as admin_list;

-- Resumo da Ana (L1–L7, L11; L8 falta, L10 passou ao Caio): 8 previstas, 7 na
-- sala da escola, 3 medidas, 1 pontual, 2 com atraso 5+, 1 com 10+, 62 de 90
-- minutos, 1 saída antecipada, sem medição: 2 não encontrados, 1 ilegível, 1
-- sem reunião, 1 sem sala.
select pg_temp.ponto_assert(
  (select ana -> 'summary' = jsonb_build_object(
      'planned', 8, 'in_school_room', 7, 'measured', 3, 'on_time', 1, 'late_5', 2, 'late_10', 1,
      'not_in_report', 0, 'joined_after_end', 0, 'minutes_in_room', 62, 'scheduled_minutes', 90,
      'left_early', 1,
      'not_measured', jsonb_build_object('NOT_FOUND', 2, 'UNPARSED', 1, 'NO_CONFERENCE', 1, 'NO_ROOM', 1))
     and (ana ->> 'enabled')::boolean
     and ana ->> 'month' = to_char(pg_temp.ponto_y(), 'YYYY-MM')
     and jsonb_array_length(ana -> 'lessons') = 8
   from ponto_views),
  'resumo do mês da Ana não bate com as aulas: ' || (select ana::text from ponto_views));

-- Linha de aula: só números do professor, nada do aluno nem da sessão.
select pg_temp.ponto_assert(
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(lesson) as k)
      = array['class_date', 'first_join_at', 'late_minutes', 'left_early_minutes', 'minutes_in_room',
              'scheduled_minutes', 'scheduled_start_at', 'status'])
   from ponto_views, jsonb_array_elements(ana -> 'lessons') as lesson)
  and (select strpos(ana::text || admin_ana::text, 'Sigiloso') = 0
        and strpos(ana::text || admin_ana::text, 'aluno.sigiloso') = 0
        and strpos(ana::text || admin_ana::text, '1111') = 0
        and strpos(ana::text || admin_ana::text, '00000000-0000-4000-8000-0000000e8006') = 0
        and strpos(ana::text || admin_ana::text, 'rank') = 0
      from ponto_views),
  'extrato leva dado do aluno, id de sessão ou ranking');

-- A Bia vê só a dela; a direção vê a Ana igual à Ana; a coordenação vê a Bia.
select pg_temp.ponto_assert(
  (select (bia -> 'summary' ->> 'planned')::integer = 1 and (bia -> 'summary' ->> 'on_time')::integer = 1
     and admin_ana -> 'extract' = ana - 'ok' - 'enabled'
     and (coord_bia -> 'extract' -> 'summary' ->> 'planned')::integer = 1
   from ponto_views),
  'professor viu extrato de outro, ou a direção viu números diferentes dos do professor');
select pg_temp.ponto_assert(
  (select ana_on_admin_door ->> 'error' like '%sem_permissao%'
     and admin_outsider ->> 'error' like '%professor_nao_encontrado%'
     and student ->> 'error' like '%somente_o_professor%'
   from ponto_views),
  'professor usou a porta da direção, direção viu professor de outra escola ou aluno viu extrato');
-- A lista da direção é só nome, em ordem alfabética (sem número ao lado).
select pg_temp.ponto_assert(
  (select admin_list -> 'teachers' = jsonb_build_array(
      jsonb_build_object('id', '00000000-0000-4000-8000-0000000e8003', 'name', 'Ana Professora'),
      jsonb_build_object('id', '00000000-0000-4000-8000-0000000e8004', 'name', 'Bia Professora'),
      jsonb_build_object('id', '00000000-0000-4000-8000-0000000e8005', 'name', 'Caio Professor'))
     and admin_list -> 'extract' = 'null'::jsonb
   from ponto_views),
  'lista de professores da direção não é só nome em ordem alfabética: '
    || (select (admin_list -> 'teachers')::text from ponto_views));

-- ─── 4. Retenção e desligar ───────────────────────────────────────────────────
select pg_temp.ponto_assert(
  (select bool_and(expires_at = (select scheduled_end_at from public.lesson_sessions s where s.id = lesson_session_id)
      + interval '90 days')
   from public.teacher_lesson_presence where tenant_id = 'ponto-test'),
  'o extrato não vence 90 dias depois da aula');
update public.teacher_lesson_presence set expires_at = now() - interval '1 minute'
where lesson_session_id = pg_temp.ponto_sid('L2');
-- Grava num statement, confere no seguinte (o SELECT não enxerga o que a função
-- chamada por ele apagou).
create temp table ponto_purge as select private.purge_teacher_lesson_presence() as purged;
select pg_temp.ponto_assert((select purged >= 1 from ponto_purge)
  and not exists (select 1 from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid('L2'))
  and exists (select 1 from public.teacher_lesson_presence where lesson_session_id = pg_temp.ponto_sid('L1')),
  'a purga não apagou a linha vencida (ou apagou a que ainda vale)');

select private.set_teacher_punctuality_enabled('ponto-test', false,
  'Jurídico pediu para desligar o extrato na escola de teste.');
select pg_temp.ponto_assert(
  not exists (select 1 from public.teacher_lesson_presence where tenant_id = 'ponto-test')
  and (select rows_deleted > 0 from private.teacher_punctuality_setting_events
       where tenant_id = 'ponto-test' and not enabled order by created_at desc limit 1)
  and pg_temp.ponto_as('00000000-0000-4000-8000-0000000e8003',
    format('select public.get_my_punctuality_extract(%L::date)', pg_temp.ponto_y()))
    = '{"ok":true,"enabled":false}'::jsonb,
  'desligar não apagou o extrato da escola ou ainda mostra algo');

-- ─── 5. Superfície ────────────────────────────────────────────────────────────
select pg_temp.ponto_assert(
  (select count(*) = 7 and bool_and(p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
      and p.proconfig @> array['search_path=""']::text[]
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('service_role', p.oid, 'EXECUTE'))
   from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname in (
     'teacher_punctuality_enabled_since', 'teacher_punctuality_retention_days', 'teacher_lesson_presence_record',
     'teacher_lesson_presence_from_evaluation', 'teacher_lesson_presence_sweep', 'purge_teacher_lesson_presence',
     'teacher_punctuality_extract')),
  'funções internas do extrato não são SECURITY DEFINER do postgres, com search_path vazio e fechadas');
-- Ligar é fora de qualquer API.
select pg_temp.ponto_assert(
  not has_function_privilege('authenticated', 'private.set_teacher_punctuality_enabled(text,boolean,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.set_teacher_punctuality_enabled(text,boolean,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'private.set_teacher_punctuality_enabled(text,boolean,text)', 'EXECUTE'),
  'ligar o extrato ficou ao alcance de uma API');
select pg_temp.ponto_assert(
  has_function_privilege('authenticated', 'public.get_my_punctuality_extract(date)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_teacher_punctuality_extract(uuid,date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_my_punctuality_extract(date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_teacher_punctuality_extract(uuid,date)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.google_meet_attendance_backend(text,text,uuid,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.google_meet_attendance_backend(text,text,uuid,jsonb)', 'EXECUTE'),
  'permissões das RPCs do extrato ou da porta da edge erradas');
-- Remendo por âncora: quem recriar a porta da presença sem ele perde o extrato.
select pg_temp.ponto_assert(
  strpos(pg_get_functiondef('public.google_meet_attendance_backend(text,text,uuid,jsonb)'::regprocedure),
    'private.teacher_lesson_presence_from_evaluation(v_session.id, p_payload)') > 0
  and strpos(pg_get_functiondef('public.google_meet_attendance_backend(text,text,uuid,jsonb)'::regprocedure),
    'raw_copies_days') > 0,
  'a avaliação de presença não alimenta o extrato (remendo sumiu)');

rollback;
