-- Lembrete do WhatsApp leva a sala oficial da escola (migration 20260926190000).
--
-- Reprova contra o código anterior: public.official_lesson_link e
-- public.render_lesson_reminder_message não existiam, e a cerca do envio
-- (begin_notification_delivery_submission) renderizava o lembrete sem link — o
-- lembrete com a sala oficial seria recusado como
-- lesson_authorized_snapshot_changed.
--
-- Também guarda a regressão da Débora (16/09–25/09/2026): o worker achatava o
-- modelo do professor e punha o link pessoal no {class_link}; a cerca recusou
-- 45 lembretes seguidos. O texto aceito é o do renderizador do banco.
--
-- E reprova contra a primeira versão desta migration (revisão de 26/09):
--   • a sala era mandada sem conferir quem dá a aula — em cobertura confirmada,
--     reposição com professor trocado ou agendamento transferido depois do
--     aceite, o aluno ia para a sala do professor ausente;
--   • sala que ficava pronta (ou deixava de valer) entre o worker e a cerca
--     virava REVIEW_REQUIRED, e o lembrete era descartado para sempre;
--   • modelo terminado em {class_link} numa aula sem sala sobrava com "\n\n" no
--     fim; o worker aparava e a cerca recusava o lembrete.
--
-- E reprova contra a integração da onda 1 antes do corretor (26/09): a régua
-- de quem dá a aula valia só para o lembrete — o link do app
-- (get_my_lesson_rooms) mandava o aluno de uma aula coberta ou transferida para
-- a sala do professor que não vem, e a fila continuava preparando essa sala.
--
-- Nada aqui reserva nem espera trabalho real: no release este teste roda no
-- banco de produção, e a fila de notificações e a do Meet são globais.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

-- Sala que o app (get_my_lesson_rooms, como o navegador chama) devolve a
-- p_user para a sessão na data: o link, '(sem link)' se a sessão volta sem
-- sala pronta, ou null se a sessão nem volta (o app usa o link de sempre).
create or replace function pg_temp.walink_room_of(p_user uuid, p_date date, p_session uuid)
returns text
language plpgsql
as $$
declare
  v_rooms jsonb;
  v_room jsonb;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  v_rooms := public.get_my_lesson_rooms(p_date, p_date);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select x into v_room
  from jsonb_array_elements(v_rooms) as x
  where x ->> 'session_id' = p_session::text;
  if v_room is null then
    return null;
  end if;
  return coalesce(v_room ->> 'meeting_uri', '(sem link)');
end;
$$;

-- ─── 1. Superfície: só o servidor chama ─────────────────────────────────────

select pg_temp.assert_true(
  to_regprocedure('public.official_lesson_link(text,text,text,date,uuid,time,uuid)') is not null
  and to_regprocedure('public.render_lesson_reminder_message(text,text,text,text,text,text,text)') is not null,
  'funções da sala oficial no lembrete não existem'
);

-- A consulta da sala sem o professor não pode sobrar (nem ficar ambígua no
-- PostgREST).
select pg_temp.assert_true(
  to_regprocedure('public.official_lesson_link(text,text,text,date,time,uuid)') is null,
  'official_lesson_link sem o professor continua exposta'
);

select pg_temp.assert_true(
  (
    select pg_catalog.bool_and(
      procedure.prosecdef
      and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
      and procedure.proconfig @> array['search_path=""']::text[]
    )
    from pg_catalog.pg_proc as procedure
    where procedure.oid in (
      'public.official_lesson_link(text,text,text,date,uuid,time,uuid)'::regprocedure,
      'public.render_lesson_reminder_message(text,text,text,text,text,text,text)'::regprocedure
    )
  ),
  'funções da sala oficial não são SECURITY DEFINER do postgres com search_path vazio'
);

select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.official_lesson_link(text,text,text,date,uuid,time,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.render_lesson_reminder_message(text,text,text,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.official_lesson_link(text,text,text,date,uuid,time,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.render_lesson_reminder_message(text,text,text,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.official_lesson_link(text,text,text,date,uuid,time,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.render_lesson_reminder_message(text,text,text,text,text,text,text)', 'EXECUTE'),
  'sala oficial exposta para além do service_role'
);

select pg_temp.assert_true(
  pg_catalog.strpos(definition, 'public.official_lesson_link(') > 0
  and pg_catalog.strpos(definition, 'v_teacher_id,') > 0
  and pg_catalog.strpos(definition, 'official_lesson_room_changed') > 0,
  'cerca do envio não confere o lembrete com a sala oficial de quem dá a aula'
)
from (
  select pg_catalog.pg_get_functiondef(
    'public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure
  ) as definition
) as fence;

-- ─── 2. Texto do lembrete ───────────────────────────────────────────────────

create temp table walink_text as
select
  E'Oi {student_name}, tudo bem? 👋\n\nLembrando que nossa aula começa em 1 hora, às *{class_time}*.\n\n{class_link}\n\nTe espero! 🐺'::text as stale_template,
  'https://meet.google.com/abc-defg-hij'::text as room,
  'https://meet.google.com/pes-soal-xyz'::text as personal;

-- Sem link: o que a cerca rendia antes (decisão de 16/09 mantida).
select pg_temp.assert_true(
  public.render_lesson_reminder_message(null, 'Ana', '19:00', 'Débora', 'Wise Wolf', null, null)
    = private.render_lesson_notification_message(null, 'Ana', '19:00', 'Débora', 'Wise Wolf', null)
  and public.render_lesson_reminder_message(t.stale_template, 'Ana', '19:00', 'Débora', 'Wise Wolf', null, null)
    = private.render_lesson_notification_message(t.stale_template, 'Ana', '19:00', 'Débora', 'Wise Wolf', t.personal),
  'sem sala oficial o lembrete mudou'
)
from walink_text as t;

-- Modelo padrão + sala oficial: linha própria no fim, com a frase da sala.
select pg_temp.assert_true(
  public.render_lesson_reminder_message(null, 'Ana', '19:00', 'Débora', 'Wise Wolf', t.room, null)
    = E'Oi Ana, tudo bem? 👋\n\nLembrando que nossa aula começa em 30 minutos, às *19:00*.\n\nTe espero! 🐺\n\nEsta aula é na sala da escola no Google Meet. Entre por este link:\nhttps://meet.google.com/abc-defg-hij',
  'modelo sem {class_link} não recebeu a sala oficial no fim'
)
from walink_text as t;

-- Modelo com {class_link}: a sala entra no marcador, formatação preservada, sem
-- linha extra; e a sala oficial vence o link pessoal.
select pg_temp.assert_true(
  public.render_lesson_reminder_message(t.stale_template, 'Ana', '19:00', 'Débora', 'Wise Wolf', t.room, t.personal)
    = E'Oi Ana, tudo bem? 👋\n\nLembrando que nossa aula começa em 1 hora, às *19:00*.\n\nhttps://meet.google.com/abc-defg-hij\n\nTe espero! 🐺',
  'sala oficial não entrou no {class_link} do modelo'
)
from walink_text as t;

select pg_temp.assert_true(
  public.render_lesson_reminder_message(E'Aula às {class time}.\n{ Class-Link }', 'Ana', '19:00', 'D', 'W', t.room, null)
    = E'Aula às 19:00.\nhttps://meet.google.com/abc-defg-hij',
  'marcador escrito com espaço/maiúscula não recebeu a sala'
)
from walink_text as t;

-- Botão "Disparar": sem sala, o link pessoal só entra onde o modelo pede.
select pg_temp.assert_true(
  public.render_lesson_reminder_message(t.stale_template, 'Ana', '19:00', 'Débora', 'Wise Wolf', null, t.personal)
    = E'Oi Ana, tudo bem? 👋\n\nLembrando que nossa aula começa em 1 hora, às *19:00*.\n\nhttps://meet.google.com/pes-soal-xyz\n\nTe espero! 🐺'
  and public.render_lesson_reminder_message(null, 'Ana', '19:00', 'Débora', 'Wise Wolf', null, t.personal)
    = private.render_lesson_notification_message(null, 'Ana', '19:00', 'Débora', 'Wise Wolf', null),
  'link pessoal do botão Disparar mudou de comportamento'
)
from walink_text as t;

-- Link "oficial" que não é sala do Meet da escola é ignorado.
select pg_temp.assert_true(
  public.render_lesson_reminder_message(null, 'Ana', '19:00', 'D', 'W', 'https://evil.example/meet', null)
    = private.render_lesson_notification_message(null, 'Ana', '19:00', 'D', 'W', null),
  'link oficial inválido foi aceito'
);

-- O corte de 4096 caracteres cai no corpo, nunca no link.
select pg_temp.assert_true(
  pg_catalog.char_length(m.msg) <= 4096
  and pg_catalog.right(m.msg, pg_catalog.char_length(t.room)) = t.room,
  'mensagem longa cortou o link da sala'
)
from walink_text as t
cross join lateral (
  select public.render_lesson_reminder_message(
    pg_catalog.repeat('x', 4090), 'Ana', '19:00', 'D', 'W', t.room, null
  ) as msg
) as m;

-- Pontas: {class_link} no fim (ou no começo) do modelo, numa aula sem sala, não
-- deixa quebra de linha sobrando — o worker e a cerca recebem o mesmo texto, e
-- o worker não precisa aparar nada. Com sala, a linha própria não vira buraco.
select pg_temp.assert_true(
  public.render_lesson_reminder_message(
    E'Oi {student_name}, aula às *{class_time}*.\n\n{class_link}', 'Ana', '19:00', 'D', 'W', null, null
  ) = 'Oi Ana, aula às *19:00*.'
  and public.render_lesson_reminder_message(
    E'{class_link}\nOi {student_name}, aula às {class_time}.', 'Ana', '19:00', 'D', 'W', null, null
  ) = 'Oi Ana, aula às 19:00.'
  and public.render_lesson_reminder_message(
    E'Oi {student_name}, aula às *{class_time}*.\n\n{class_link}', 'Ana', '19:00', 'D', 'W', t.room, null
  ) = E'Oi Ana, aula às *19:00*.\n\nhttps://meet.google.com/abc-defg-hij'
  and public.render_lesson_reminder_message(
    E'Oi {student_name}.\n\n{tenant_name}', 'Ana', '19:00', 'D', '', t.room, null
  ) = E'Oi Ana.\n\nEsta aula é na sala da escola no Google Meet. Entre por este link:\nhttps://meet.google.com/abc-defg-hij',
  'lembrete saiu com quebra de linha sobrando na ponta'
)
from walink_text as t;

-- ─── 3. Qual sala é a oficial ───────────────────────────────────────────────

set local request.jwt.claims = '{"role":"service_role"}';

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values
  ('sala-oficial-test', 'Sala Oficial Test', 'sala-oficial-test', 'active', true),
  ('sala-oficial-outra', 'Sala Oficial Outra', 'sala-oficial-outra', 'active', true);

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-4000-8000-00000000d501', 'authenticated', 'authenticated', 'walink-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Sala"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d502', 'authenticated', 'authenticated', 'walink-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Sala"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d503', 'authenticated', 'authenticated', 'walink-student@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Theo Sala"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d504', 'authenticated', 'authenticated', 'walink-debora@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Debora Sala"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d505', 'authenticated', 'authenticated', 'walink-student2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Ana Sala"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d506', 'authenticated', 'authenticated', 'walink-student3@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Bia Sala"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d507', 'authenticated', 'authenticated', 'walink-student4@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Caio Sala"}', now(), now());

update public.profiles
set tenant_id = 'sala-oficial-test', role = 'SCHOOL_ADMIN', lifecycle_status = 'active',
    full_name = 'Diretora Sala', phone = '5511999991501'
where id = '00000000-0000-4000-8000-00000000d501';

update public.profiles
set tenant_id = 'sala-oficial-test', role = 'TEACHER', lifecycle_status = 'active',
    full_name = 'Teacher Sala', phone = '5511999991502',
    meeting_link = 'https://meet.google.com/pes-soal-xyz',
    date_automation_enabled = true, lesson_reminder_template = null, is_test_account = false
where id = '00000000-0000-4000-8000-00000000d502';

update public.profiles
set tenant_id = 'sala-oficial-test', role = 'STUDENT', lifecycle_status = 'active',
    full_name = 'Theo Sala', phone = '5511988881503', attendance_phone = '5511988881503',
    meeting_link = 'https://meet.google.com/pes-soal-xyz', is_test_account = false
where id = '00000000-0000-4000-8000-00000000d503';

update public.profiles
set tenant_id = 'sala-oficial-test', role = 'TEACHER', lifecycle_status = 'active',
    full_name = 'Debora Sala', phone = '5511999991504',
    meeting_link = 'https://meet.google.com/deb-ora-xyz',
    date_automation_enabled = true, is_test_account = false,
    lesson_reminder_template = (select stale_template from walink_text)
where id = '00000000-0000-4000-8000-00000000d504';

update public.profiles
set tenant_id = 'sala-oficial-test', role = 'STUDENT', lifecycle_status = 'active',
    full_name = 'Ana Sala', phone = '5511988881505', attendance_phone = '5511988881505',
    meeting_link = 'https://meet.google.com/ana-link-xyz', is_test_account = false
where id = '00000000-0000-4000-8000-00000000d505';

update public.profiles
set tenant_id = 'sala-oficial-test', role = 'STUDENT', lifecycle_status = 'active',
    full_name = 'Bia Sala', phone = '5511988881506', attendance_phone = '5511988881506',
    is_test_account = false
where id = '00000000-0000-4000-8000-00000000d506';

update public.profiles
set tenant_id = 'sala-oficial-test', role = 'STUDENT', lifecycle_status = 'active',
    full_name = 'Caio Sala', phone = '5511988881507', attendance_phone = '5511988881507',
    is_test_account = false
where id = '00000000-0000-4000-8000-00000000d507';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000d501', 'sala-oficial-test', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d502', 'sala-oficial-test', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d503', 'sala-oficial-test', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d504', 'sala-oficial-test', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d505', 'sala-oficial-test', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d506', 'sala-oficial-test', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d507', 'sala-oficial-test', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update
set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values ('00000000-0000-4000-8000-00000000d501', 'sala-oficial-test');

insert into public.whatsapp_instances (user_id, tenant_id, instance_name, instance_id, status)
values ('00000000-0000-4000-8000-00000000d501', 'sala-oficial-test', 'wa-sala-oficial', 'wa-sala-oficial-provider', 'connected');

-- Aula de agora + 30 min (a janela do lembrete é 15–45 min antes).
create temp table walink_clock as
select local_start::date as class_date,
       pg_catalog.to_char(local_start, 'HH24:MI') as class_time,
       (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[
         extract(dow from local_start::date)::int + 1
       ] as day_name
from (
  select pg_catalog.date_trunc('minute', (now() + interval '30 minutes') at time zone 'America/Sao_Paulo') as local_start
) as clock;

-- B1: Teacher Sala × Theo. B2: Débora × Ana (sem sala). B3: Débora × Bia (sem
-- sala). B4: Débora × Caio — agendamento transferido da Teacher Sala para a
-- Débora depois do aceite: a sessão congelada (e a sala) continuam da Teacher.
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select v.id, 'sala-oficial-test', v.teacher_id, v.student_id,
       c.day_name, c.class_time, null, date '2026-01-05', 'SCHEDULED'
from walink_clock as c
cross join lateral (values
  ('00000000-0000-4000-8000-00000000d5b1'::uuid, '00000000-0000-4000-8000-00000000d502'::uuid, '00000000-0000-4000-8000-00000000d503'::uuid),
  ('00000000-0000-4000-8000-00000000d5b2'::uuid, '00000000-0000-4000-8000-00000000d504'::uuid, '00000000-0000-4000-8000-00000000d505'::uuid),
  ('00000000-0000-4000-8000-00000000d5b3'::uuid, '00000000-0000-4000-8000-00000000d504'::uuid, '00000000-0000-4000-8000-00000000d506'::uuid),
  ('00000000-0000-4000-8000-00000000d5b4'::uuid, '00000000-0000-4000-8000-00000000d504'::uuid, '00000000-0000-4000-8000-00000000d507'::uuid)
) as v(id, teacher_id, student_id);

-- Sessões e salas: S1 = aula de agora (booking B1, aceite, sala READY);
-- S2 = reposição R1 amanhã; S3 = antecipação do B1 para depois de amanhã;
-- S6 = aula de agora do B4, ainda com a Teacher Sala (antes da transferência).
insert into public.lesson_sessions (
  id, tenant_id, student_id, teacher_id, class_date, scheduled_start_at, scheduled_end_at, source_key, documentation_consent
)
select s.id, 'sala-oficial-test', s.student_id, '00000000-0000-4000-8000-00000000d502',
       s.class_date,
       (s.class_date + s.start_time) at time zone 'America/Sao_Paulo',
       (s.class_date + s.start_time + interval '30 minutes') at time zone 'America/Sao_Paulo',
       s.source_key, true
from walink_clock as c
cross join lateral (values
  ('00000000-0000-4000-8000-00000000d5a1'::uuid, c.class_date, c.class_time::time, 'walink-s1', '00000000-0000-4000-8000-00000000d503'::uuid),
  ('00000000-0000-4000-8000-00000000d5a2'::uuid, c.class_date + 1, time '15:00', 'walink-s2', '00000000-0000-4000-8000-00000000d503'::uuid),
  ('00000000-0000-4000-8000-00000000d5a3'::uuid, c.class_date + 2, time '08:00', 'walink-s3', '00000000-0000-4000-8000-00000000d503'::uuid),
  ('00000000-0000-4000-8000-00000000d5a6'::uuid, c.class_date, c.class_time::time, 'walink-s6', '00000000-0000-4000-8000-00000000d507'::uuid)
) as s(id, class_date, start_time, source_key, student_id);

insert into public.lesson_occurrences (
  tenant_id, session_id, source_type, source_id, class_date, start_time,
  scheduled_start_at, scheduled_end_at, entitlement_date, status
)
select 'sala-oficial-test', v.session_id, v.source_type, v.source_id, v.class_date, v.start_time,
       (v.class_date + v.start_time) at time zone 'America/Sao_Paulo',
       (v.class_date + v.start_time + interval '30 minutes') at time zone 'America/Sao_Paulo',
       v.class_date, 'SCHEDULED'
from walink_clock as c
cross join lateral (values
  ('00000000-0000-4000-8000-00000000d5a1'::uuid, 'booking', '00000000-0000-4000-8000-00000000d5b1', c.class_date, c.class_time::time),
  ('00000000-0000-4000-8000-00000000d5a2'::uuid, 'reschedule', '00000000-0000-4000-8000-00000000d5c1', c.class_date + 1, time '15:00'),
  ('00000000-0000-4000-8000-00000000d5a3'::uuid, 'booking', '00000000-0000-4000-8000-00000000d5b1', c.class_date + 2, time '08:00'),
  ('00000000-0000-4000-8000-00000000d5a6'::uuid, 'booking', '00000000-0000-4000-8000-00000000d5b4', c.class_date, c.class_time::time)
) as v(session_id, source_type, source_id, class_date, start_time);

insert into private.google_meet_rooms (
  lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub, cohost_email, state, created_by
) values
  ('00000000-0000-4000-8000-00000000d5a1', 'sala-oficial-test', 'spaces/walinkS1', 'https://meet.google.com/abc-defg-hij', 'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502'),
  ('00000000-0000-4000-8000-00000000d5a2', 'sala-oficial-test', 'spaces/walinkS2', 'https://meet.google.com/rep-osic-aoo', 'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502'),
  ('00000000-0000-4000-8000-00000000d5a3', 'sala-oficial-test', 'spaces/walinkS3', 'https://meet.google.com/ant-ecip-ada', 'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502'),
  ('00000000-0000-4000-8000-00000000d5a6', 'sala-oficial-test', 'spaces/walinkS6', 'https://meet.google.com/tra-nsfe-rid', 'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502');

-- Agendamento, reposição e antecipação acham a sala da própria data.
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'BOOKING', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, '00000000-0000-4000-8000-00000000d502', c.class_time::time,
    '00000000-0000-4000-8000-00000000d503') = 'https://meet.google.com/abc-defg-hij'
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, '00000000-0000-4000-8000-00000000d502', null, null) = 'https://meet.google.com/abc-defg-hij'
  and public.official_lesson_link('sala-oficial-test', 'reschedule', '00000000-0000-4000-8000-00000000d5c1',
    c.class_date + 1, '00000000-0000-4000-8000-00000000d502', time '15:00',
    '00000000-0000-4000-8000-00000000d503') = 'https://meet.google.com/rep-osic-aoo'
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00',
    '00000000-0000-4000-8000-00000000d503') = 'https://meet.google.com/ant-ecip-ada',
  'sala oficial de agendamento, reposição ou antecipação não encontrada'
)
from walink_clock as c;

-- Outra data, outro horário, outro aluno, outra escola, outro tipo: nada. O
-- outro horário sai do horário da aula (um horário fixo, como 23:59, é o da
-- própria aula quando o teste roda às 23:29 de Brasília).
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 3, '00000000-0000-4000-8000-00000000d502', null, null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, '00000000-0000-4000-8000-00000000d502', c.class_time::time + interval '1 hour', null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, '00000000-0000-4000-8000-00000000d502', null, '00000000-0000-4000-8000-00000000d505') is null
  and public.official_lesson_link('sala-oficial-outra', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, '00000000-0000-4000-8000-00000000d502', null, null) is null
  and public.official_lesson_link('sala-oficial-test', 'appointment', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, '00000000-0000-4000-8000-00000000d502', null, null) is null,
  'sala oficial vazou para outra aula'
)
from walink_clock as c;

-- Quem dá a aula tem de ser o professor da sessão (o coanfitrião da sala).
-- Reposição com professor trocado depois do aceite, agendamento transferido, ou
-- professor desconhecido: nenhuma sala.
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, '00000000-0000-4000-8000-00000000d504', c.class_time::time, null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, null, c.class_time::time, null) is null
  and public.official_lesson_link('sala-oficial-test', 'reschedule', '00000000-0000-4000-8000-00000000d5c1',
    c.class_date + 1, '00000000-0000-4000-8000-00000000d504', time '15:00', null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b4',
    c.class_date, '00000000-0000-4000-8000-00000000d504', c.class_time::time,
    '00000000-0000-4000-8000-00000000d507') is null,
  'sala oficial mandada com outro professor dando a aula'
)
from walink_clock as c;

-- O link do app segue a mesma régua (integração da onda 1): a aula transferida
-- para a Débora não entrega a sala da Teacher Sala a ninguém — o aluno e a
-- Débora usam o link de sempre, como no lembrete. A aula que continua da Teacher
-- Sala (B1) segue com a sala, e reposição cuja fonte não existe mais não decide
-- nada (fica o professor da sessão).
select pg_temp.assert_true(
  pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d507', c.class_date,
    '00000000-0000-4000-8000-00000000d5a6') is null
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d501', c.class_date,
    '00000000-0000-4000-8000-00000000d5a6') is null
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d503', c.class_date,
    '00000000-0000-4000-8000-00000000d5a1') = 'https://meet.google.com/abc-defg-hij'
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d503', c.class_date + 1,
    '00000000-0000-4000-8000-00000000d5a2') = 'https://meet.google.com/rep-osic-aoo',
  'app entregou a sala da professora que não dá mais a aula transferida (ou tirou a de quem dá)'
)
from walink_clock as c;

-- Antes da cobertura, a antecipação (S3) chega ao aluno e à titular pelo app.
select pg_temp.assert_true(
  pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d503', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') = 'https://meet.google.com/ant-ecip-ada'
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d502', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') = 'https://meet.google.com/ant-ecip-ada',
  'fixture: sala da antecipação não chegou ao app antes da cobertura'
)
from walink_clock as c;

-- Cobertura confirmada depois da sala ("Flávio não dá aula hoje", a Débora
-- aceita): o lembrete continua saindo pelo agendamento do Flávio, mas a sala
-- dele não vale — quem dá a aula é a Débora.
alter table public.class_coverages disable trigger user;
insert into public.class_coverages (
  id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at
)
select '00000000-0000-4000-8000-00000000d5d1', 'sala-oficial-test',
       '00000000-0000-4000-8000-00000000d502', '00000000-0000-4000-8000-00000000d504',
       '00000000-0000-4000-8000-00000000d503', '00000000-0000-4000-8000-00000000d5b1',
       c.class_date + 2, '08:00', 'confirmed', now()
from walink_clock as c;
alter table public.class_coverages enable trigger user;

select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00', null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d504', time '08:00', null) is null,
  'cobertura confirmada depois da sala mandou o aluno para a sala do professor ausente'
)
from walink_clock as c;

-- ...e o app também não: nem o aluno (que ia bater na sala do ausente), nem a
-- substituta, nem a direção recebem a sala. Aluno e substituta usam o link de
-- sempre — a aula não se divide em duas salas.
select pg_temp.assert_true(
  pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d503', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') is null
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d504', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') is null
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d501', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') is null,
  'app entregou a sala do professor ausente na aula coberta'
)
from walink_clock as c;

-- A fila também não prepara a sala (nem acerta o coanfitrião) de aula dada por
-- outro professor: coberta (S3) ou transferida (S6). A da própria Teacher Sala
-- (S1) segue. A professora confirmou outra conta Google, então toda sala pronta
-- dela pede acerto do coanfitrião. A fila é global: as conexões reais saem do ar
-- só neste savepoint.
savepoint walink_meet_queue;
update private.google_workspace_connections set status = 'REAUTH_REQUIRED' where status = 'CONNECTED';
insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('sala-oficial-test', 'synthetic-sub', 'escola-sala@example.invalid', 'CONNECTED',
  '00000000-0000-4000-8000-00000000d501');
insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
values ('00000000-0000-4000-8000-00000000d502', 'sala-oficial-test', 'walink-teacher-sub',
  'walink-nova@example.invalid', true);
select pg_temp.assert_true(
  exists (
    select 1 from jsonb_array_elements(q.jobs) as j
    where j ->> 'lesson_session_id' = '00000000-0000-4000-8000-00000000d5a1'
      and j ->> 'operation' = 'PREPARE_ROOM'
  )
  and not exists (
    select 1 from jsonb_array_elements(q.jobs) as j
    where j ->> 'lesson_session_id' in (
      '00000000-0000-4000-8000-00000000d5a3', '00000000-0000-4000-8000-00000000d5a6'
    )
  ),
  'fila preparou a sala de aula dada por outro professor: ' || q.jobs::text
)
from (select public.get_pending_google_meet_sync_sessions() as jobs) as q;
rollback to savepoint walink_meet_queue;
release savepoint walink_meet_queue;

-- Sessão que nasceu DEPOIS da cobertura (o sync já a criou com o substituto):
-- a sala é do substituto, e vale para o lembrete do agendamento do titular —
-- e para o app, do aluno e da substituta.
update public.lesson_sessions set teacher_id = '00000000-0000-4000-8000-00000000d504'
where id = '00000000-0000-4000-8000-00000000d5a3';
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00', null)
    = 'https://meet.google.com/ant-ecip-ada',
  'sala do substituto não foi mandada na aula coberta'
)
from walink_clock as c;
select pg_temp.assert_true(
  pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d503', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') = 'https://meet.google.com/ant-ecip-ada'
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d504', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') = 'https://meet.google.com/ant-ecip-ada',
  'sala do substituto não chegou ao app na aula coberta'
)
from walink_clock as c;
update public.lesson_sessions set teacher_id = '00000000-0000-4000-8000-00000000d502'
where id = '00000000-0000-4000-8000-00000000d5a3';

-- Cobertura cancelada não muda quem dá a aula.
alter table public.class_coverages disable trigger user;
update public.class_coverages set status = 'cancelled'
where id = '00000000-0000-4000-8000-00000000d5d1';
alter table public.class_coverages enable trigger user;
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00', null)
    = 'https://meet.google.com/ant-ecip-ada'
  and pg_temp.walink_room_of('00000000-0000-4000-8000-00000000d503', c.class_date + 2,
    '00000000-0000-4000-8000-00000000d5a3') = 'https://meet.google.com/ant-ecip-ada',
  'cobertura cancelada tirou a sala do titular'
)
from walink_clock as c;
delete from public.class_coverages where id = '00000000-0000-4000-8000-00000000d5d1';

-- Sala que não está pronta não vale.
update private.google_meet_rooms set state = 'COHOST_PENDING'
where lesson_session_id = '00000000-0000-4000-8000-00000000d5a2';
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'reschedule', '00000000-0000-4000-8000-00000000d5c1',
    c.class_date + 1, '00000000-0000-4000-8000-00000000d502', time '15:00', null) is null,
  'sala em COHOST_PENDING foi mandada ao aluno'
)
from walink_clock as c;
update private.google_meet_rooms set state = 'READY'
where lesson_session_id = '00000000-0000-4000-8000-00000000d5a2';

-- Ocorrência substituída não vale.
update public.lesson_occurrences set status = 'SUPERSEDED'
where session_id = '00000000-0000-4000-8000-00000000d5a2';
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'reschedule', '00000000-0000-4000-8000-00000000d5c1',
    c.class_date + 1, '00000000-0000-4000-8000-00000000d502', time '15:00', null) is null,
  'ocorrência substituída ainda aponta para a sala'
)
from walink_clock as c;
update public.lesson_occurrences set status = 'SCHEDULED'
where session_id = '00000000-0000-4000-8000-00000000d5a2';

-- Aceite revogado: a sala transcreve sozinha, então o WhatsApp não manda lá.
update public.lesson_sessions set documentation_consent = false
where id = '00000000-0000-4000-8000-00000000d5a3';
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00', null) is null,
  'sala oficial mandada para aula sem aceite de registro'
)
from walink_clock as c;
update public.lesson_sessions set documentation_consent = true
where id = '00000000-0000-4000-8000-00000000d5a3';

-- Revogação que chegou antes do fim da aula, com a sessão ainda marcada (o job
-- de 15 min não rodou): o aceite efetivo já não vale, como no app
-- (private.lesson_session_documentation_blocked, 20260926180000).
savepoint walink_revoked_before_job;
insert into private.lesson_recording_consents (
  tenant_id, subject_id, subject_role, decision, signer_name, signer_relation, source, reason
) values (
  'sala-oficial-test', '00000000-0000-4000-8000-00000000d503', 'STUDENT', 'REVOKED',
  'Diretora Sala', 'SCHOOL', 'SCHOOL', 'Família pediu para parar (fixture).'
);
select pg_temp.assert_true(
  (select documentation_consent from public.lesson_sessions
    where id = '00000000-0000-4000-8000-00000000d5a3')
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00', null) is null,
  'revogação antes do fim da aula ainda mandou a sala oficial (antes do job desmarcar)'
)
from walink_clock as c;
rollback to savepoint walink_revoked_before_job;
release savepoint walink_revoked_before_job;

-- Sessão substituída não vale.
update public.lesson_sessions set status = 'SUPERSEDED'
where id = '00000000-0000-4000-8000-00000000d5a3';
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00', null) is null,
  'sessão substituída ainda manda a sala'
)
from walink_clock as c;
update public.lesson_sessions set status = 'SCHEDULED'
where id = '00000000-0000-4000-8000-00000000d5a3';

-- Duas salas diferentes para a mesma aula (horário mudou depois de a sala
-- nascer): sem horário é ambíguo e não manda nenhuma; com horário, a certa.
insert into public.lesson_sessions (
  id, tenant_id, student_id, teacher_id, class_date, scheduled_start_at, scheduled_end_at, source_key, documentation_consent
)
select '00000000-0000-4000-8000-00000000d5a4', 'sala-oficial-test', '00000000-0000-4000-8000-00000000d503',
       '00000000-0000-4000-8000-00000000d502', c.class_date + 2,
       (c.class_date + 2 + time '09:00') at time zone 'America/Sao_Paulo',
       (c.class_date + 2 + time '09:30') at time zone 'America/Sao_Paulo',
       'walink-s4', true
from walink_clock as c;
insert into public.lesson_occurrences (
  tenant_id, session_id, source_type, source_id, class_date, start_time,
  scheduled_start_at, scheduled_end_at, entitlement_date, status
)
select 'sala-oficial-test', '00000000-0000-4000-8000-00000000d5a4', 'booking', '00000000-0000-4000-8000-00000000d5b1',
       c.class_date + 2, time '09:00',
       (c.class_date + 2 + time '09:00') at time zone 'America/Sao_Paulo',
       (c.class_date + 2 + time '09:30') at time zone 'America/Sao_Paulo',
       c.class_date + 2, 'SCHEDULED'
from walink_clock as c;
insert into private.google_meet_rooms (
  lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub, cohost_email, state, created_by
) values (
  '00000000-0000-4000-8000-00000000d5a4', 'sala-oficial-test', 'spaces/walinkS4', 'https://meet.google.com/out-rasa-laa',
  'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502'
);
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', null, null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '08:00', null) = 'https://meet.google.com/ant-ecip-ada'
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, '00000000-0000-4000-8000-00000000d502', time '09:00', null) = 'https://meet.google.com/out-rasa-laa',
  'identidade ambígua mandou uma sala qualquer'
)
from walink_clock as c;

-- ─── 4. A cerca do envio aceita o lembrete com a sala — e só ele ────────────

insert into public.notification_queue (
  id, tenant_id, student_phone, message_body, notification_kind,
  source_id, source_type, class_date, scheduled_for, status,
  attempts, next_attempt_at, delivery_status, max_attempts, idempotency_key
)
select v.id, 'sala-oficial-test', v.phone, v.body, 'LESSON_REMINDER',
       v.source_id, 'booking', c.class_date, now(), 'pending',
       0, now(), 'queued', 5, v.idempotency_key
from walink_clock as c
cross join lateral (values
  ('00000000-0000-4000-8000-00000000d5e1'::uuid, '5511988881503', 'lesson official',
   '00000000-0000-4000-8000-00000000d5b1'::uuid, 'walink-official'),
  ('00000000-0000-4000-8000-00000000d5e2'::uuid, '5511988881505', 'lesson debora',
   '00000000-0000-4000-8000-00000000d5b2'::uuid, 'walink-debora'),
  ('00000000-0000-4000-8000-00000000d5e3'::uuid, '5511988881506', 'lesson edge',
   '00000000-0000-4000-8000-00000000d5b3'::uuid, 'walink-edge'),
  ('00000000-0000-4000-8000-00000000d5e4'::uuid, '5511988881507', 'lesson transferred',
   '00000000-0000-4000-8000-00000000d5b4'::uuid, 'walink-transferred')
) as v(id, phone, body, source_id, idempotency_key);

do $fence$
declare
  v_row public.notification_queue%rowtype;
  v_official public.notification_queue%rowtype;
  v_debora public.notification_queue%rowtype;
  v_edge public.notification_queue%rowtype;
  v_transferred public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_class_time text;
  v_without_room text;
  v_with_room text;
  v_foreign_room text;
  v_flattened text;
  v_canonical text;
  v_worker_text text;
  v_result jsonb;
begin
  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'sala-oficial-test' and instance_name = 'wa-sala-oficial';

  select class_time into strict v_class_time from walink_clock;

  -- Reserva SÓ os quatro lembretes de teste, com o efeito do claim da fila
  -- (public.claim_notification_delivery_batch): processing/preparing, uma
  -- tentativa, token e prazo. O claim de verdade é global: no release este
  -- teste roda no banco de produção, e ele reservaria (e travaria) notificações
  -- reais vencidas — que ainda passam na frente das de teste, então com a fila
  -- represada (restrição do WhatsApp, Evolution fora) o teste reprovaria sem
  -- defeito nenhum. A reserva em si é coberta por whatsapp_delivery_pipeline.sql;
  -- aqui se confere que os lembretes estão no ponto em que o claim os pega.
  perform pg_temp.assert_true(
    (
      select pg_catalog.count(*) = 4
      from public.notification_queue as notification
      where notification.id in (
          '00000000-0000-4000-8000-00000000d5e1', '00000000-0000-4000-8000-00000000d5e2',
          '00000000-0000-4000-8000-00000000d5e3', '00000000-0000-4000-8000-00000000d5e4'
        )
        and notification.status = 'pending'
        and notification.delivery_status = 'queued'
        and notification.attempts < notification.max_attempts
        and notification.scheduled_for <= now()
        and notification.next_attempt_at <= now()
    ),
    'lembretes de teste fora do ponto em que a fila os reserva'
  );

  for v_row in
    update public.notification_queue as notification
    set status = 'processing',
        delivery_status = 'preparing',
        attempts = notification.attempts + 1,
        claim_token = gen_random_uuid(),
        lease_expires_at = now() + interval '300 seconds',
        last_error = null,
        updated_at = now()
    where notification.id in (
      '00000000-0000-4000-8000-00000000d5e1', '00000000-0000-4000-8000-00000000d5e2',
      '00000000-0000-4000-8000-00000000d5e3', '00000000-0000-4000-8000-00000000d5e4'
    )
    returning notification.*
  loop
    if v_row.id = '00000000-0000-4000-8000-00000000d5e1' then
      v_official := v_row;
    elsif v_row.id = '00000000-0000-4000-8000-00000000d5e2' then
      v_debora := v_row;
    elsif v_row.id = '00000000-0000-4000-8000-00000000d5e3' then
      v_edge := v_row;
    elsif v_row.id = '00000000-0000-4000-8000-00000000d5e4' then
      v_transferred := v_row;
    end if;
  end loop;
  perform pg_temp.assert_true(
    v_official.id is not null and v_debora.id is not null
      and v_edge.id is not null and v_transferred.id is not null,
    'lembretes de teste não foram reservados pela fila'
  );

  v_without_room := public.render_lesson_reminder_message(
    null, 'Theo', v_class_time, 'Teacher Sala', 'Sala Oficial Test', null, null
  );
  v_with_room := public.render_lesson_reminder_message(
    null, 'Theo', v_class_time, 'Teacher Sala', 'Sala Oficial Test',
    'https://meet.google.com/abc-defg-hij', null
  );

  -- Link que não é sala desta aula não vira "só a sala mudou": REVIEW.
  v_foreign_room := public.render_lesson_reminder_message(
    null, 'Theo', v_class_time, 'Teacher Sala', 'Sala Oficial Test',
    'https://meet.google.com/pes-soal-xyz', null
  );
  v_result := public.begin_notification_delivery_submission(
    v_official.id, v_official.claim_token, 'wa-sala-oficial',
    '5511988881503', '5511988881503', v_foreign_room,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'REVIEW_REQUIRED'
      and v_result ->> 'reason' = 'lesson_authorized_snapshot_changed',
    'cerca aceitou (ou devolveu à fila) lembrete com link que não é da aula: ' || v_result::text
  );

  -- A sala ficou pronta entre o worker (texto sem sala) e a cerca: RETRY, sem
  -- recibo — o worker remonta com a sala. Antes: REVIEW_REQUIRED e 'skipped'.
  v_result := public.begin_notification_delivery_submission(
    v_official.id, v_official.claim_token, 'wa-sala-oficial',
    '5511988881503', '5511988881503', v_without_room,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'RETRY'
      and v_result ->> 'reason' = 'official_lesson_room_changed'
      and not exists (
        select 1 from public.automation_sent where notification_id = v_official.id
      ),
    'sala que ficou pronta na hora descartou o lembrete: ' || v_result::text
  );

  -- A sala deixou de valer entre o worker (texto com sala) e a cerca: RETRY.
  update private.google_meet_rooms set state = 'COHOST_PENDING'
  where lesson_session_id = '00000000-0000-4000-8000-00000000d5a1';
  v_result := public.begin_notification_delivery_submission(
    v_official.id, v_official.claim_token, 'wa-sala-oficial',
    '5511988881503', '5511988881503', v_with_room,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'RETRY'
      and v_result ->> 'reason' = 'official_lesson_room_changed'
      and not exists (
        select 1 from public.automation_sent where notification_id = v_official.id
      ),
    'sala que deixou de valer na hora descartou o lembrete: ' || v_result::text
  );
  update private.google_meet_rooms set state = 'READY'
  where lesson_session_id = '00000000-0000-4000-8000-00000000d5a1';

  -- ...e o lembrete com a sala oficial é o autorizado e selado.
  v_result := public.begin_notification_delivery_submission(
    v_official.id, v_official.claim_token, 'wa-sala-oficial',
    '5511988881503', '5511988881503', v_with_room,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is true
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and pg_catalog.strpos(v_result ->> 'messageBody', 'https://meet.google.com/abc-defg-hij') > 0
      and pg_catalog.strpos(v_result ->> 'messageBody', 'pes-soal-xyz') = 0
      and (
        select count(*) = 1 and bool_and(receipt_state = 'SEALED')
        from public.automation_sent where notification_id = v_official.id
      ),
    'cerca não autorizou o lembrete com a sala oficial: ' || v_result::text
  );

  -- Regressão da Débora (sem sala): o texto que o worker montava — modelo
  -- achatado e link pessoal no {class_link} — é recusado, como foi 45 vezes...
  v_flattened := 'Oi Ana, tudo bem? 👋 Lembrando que nossa aula começa em 1 hora, às '
    || v_class_time || ' . https://meet.google.com/ana-link-xyz Te espero! 🐺';
  v_result := public.begin_notification_delivery_submission(
    v_debora.id, v_debora.claim_token, 'wa-sala-oficial',
    '5511988881505', '5511988881505', v_flattened,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'reason' = 'lesson_authorized_snapshot_changed',
    'cerca aceitou o lembrete achatado com link pessoal: ' || v_result::text
  );

  -- ...e o do renderizador do banco (que o worker usa agora) passa, com a
  -- formatação do modelo e sem o link pessoal.
  v_canonical := public.render_lesson_reminder_message(
    (select lesson_reminder_template from public.profiles
      where id = '00000000-0000-4000-8000-00000000d504'),
    'Ana', v_class_time, 'Debora Sala', 'Sala Oficial Test', null, null
  );
  perform pg_temp.assert_true(
    pg_catalog.strpos(v_canonical, E'\n') > 0
      and pg_catalog.strpos(v_canonical, '*' || v_class_time || '*') > 0
      and pg_catalog.strpos(v_canonical, 'meet.google.com') = 0,
    'texto canônico perdeu a formatação ou levou o link pessoal: ' || v_canonical
  );
  v_result := public.begin_notification_delivery_submission(
    v_debora.id, v_debora.claim_token, 'wa-sala-oficial',
    '5511988881505', '5511988881505', v_canonical,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is true
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED',
    'cerca recusou o lembrete canônico sem sala: ' || v_result::text
  );

  -- Modelo terminado em {class_link} numa aula sem sala (a tela incentiva o
  -- marcador). O worker manda o texto do banco — sem quebra de linha na ponta —
  -- e a cerca tem de aceitar. Antes o SQL deixava "\n\n" no fim, o worker
  -- aparava e a cerca recusava.
  update public.profiles
  set lesson_reminder_template = E'Oi {student_name}, aula às *{class_time}*.\n\n{class_link}'
  where id = '00000000-0000-4000-8000-00000000d504';
  v_worker_text := 'Oi Bia, aula às *' || v_class_time || '*.';
  v_result := public.begin_notification_delivery_submission(
    v_edge.id, v_edge.claim_token, 'wa-sala-oficial',
    '5511988881506', '5511988881506', v_worker_text,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is true
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED'
      and v_result ->> 'messageBody' = v_worker_text,
    'cerca recusou o lembrete de modelo terminado em {class_link}: ' || v_result::text
  );

  -- Agendamento transferido para a Débora depois do aceite: a sessão (e a sala)
  -- continuam da Teacher Sala. A cerca confere com a professora da agenda e
  -- não manda o aluno para a sala da professora que saiu (o texto com a sala
  -- volta à fila, e o worker, que também passa a professora, remonta sem ela)...
  v_result := public.begin_notification_delivery_submission(
    v_transferred.id, v_transferred.claim_token, 'wa-sala-oficial',
    '5511988881507', '5511988881507',
    E'Oi Caio, aula às *' || v_class_time || E'*.\n\nhttps://meet.google.com/tra-nsfe-rid',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    coalesce((v_result ->> 'ok')::boolean, false) is false
      and v_result ->> 'action' = 'RETRY'
      and not exists (
        select 1 from public.automation_sent where notification_id = v_transferred.id
      ),
    'cerca autorizou a sala do professor que não dá mais a aula: ' || v_result::text
  );

  -- ...e autoriza o lembrete de sempre, sem sala.
  v_result := public.begin_notification_delivery_submission(
    v_transferred.id, v_transferred.claim_token, 'wa-sala-oficial',
    '5511988881507', '5511988881507', 'Oi Caio, aula às *' || v_class_time || '*.',
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is true
      and v_result ->> 'action' = 'SUBMIT_AUTHORIZED',
    'cerca recusou o lembrete sem sala do agendamento transferido: ' || v_result::text
  );
end;
$fence$;

rollback;
