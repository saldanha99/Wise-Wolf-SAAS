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

-- ─── 1. Superfície: só o servidor chama ─────────────────────────────────────

select pg_temp.assert_true(
  to_regprocedure('public.official_lesson_link(text,text,text,date,time,uuid)') is not null
  and to_regprocedure('public.render_lesson_reminder_message(text,text,text,text,text,text,text)') is not null,
  'funções da sala oficial no lembrete não existem'
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
      'public.official_lesson_link(text,text,text,date,time,uuid)'::regprocedure,
      'public.render_lesson_reminder_message(text,text,text,text,text,text,text)'::regprocedure
    )
  ),
  'funções da sala oficial não são SECURITY DEFINER do postgres com search_path vazio'
);

select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.official_lesson_link(text,text,text,date,time,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.render_lesson_reminder_message(text,text,text,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.official_lesson_link(text,text,text,date,time,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.render_lesson_reminder_message(text,text,text,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.official_lesson_link(text,text,text,date,time,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.render_lesson_reminder_message(text,text,text,text,text,text,text)', 'EXECUTE'),
  'sala oficial exposta para além do service_role'
);

select pg_temp.assert_true(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure
    ),
    'public.official_lesson_link('
  ) > 0,
  'cerca do envio não confere o lembrete com a sala oficial'
);

-- ─── 2. Texto do lembrete ───────────────────────────────────────────────────

create temp table walink_text as
select
  E'Oi {student_name}, tudo bem? 👋\n\nLembrando que nossa aula começa em 1 hora, às *{class_time}*.\n\n{class_link}\n\nTe espero! 🐺'::text as stale_template,
  'https://meet.google.com/abc-defg-hij'::text as room,
  'https://meet.google.com/pes-soal-xyz'::text as personal;

-- Sem link: EXATAMENTE o que a cerca rendia antes (decisão de 16/09 mantida).
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
  ('00000000-0000-4000-8000-00000000d505', 'authenticated', 'authenticated', 'walink-student2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Ana Sala"}', now(), now());

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

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000d501', 'sala-oficial-test', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d502', 'sala-oficial-test', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d503', 'sala-oficial-test', 'STUDENT', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d504', 'sala-oficial-test', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d505', 'sala-oficial-test', 'STUDENT', 'ACTIVE', true)
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

insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select '00000000-0000-4000-8000-00000000d5b1'::uuid, 'sala-oficial-test',
       '00000000-0000-4000-8000-00000000d502'::uuid, '00000000-0000-4000-8000-00000000d503'::uuid,
       c.day_name, c.class_time, null, date '2026-01-05', 'SCHEDULED'
from walink_clock as c;

insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select '00000000-0000-4000-8000-00000000d5b2'::uuid, 'sala-oficial-test',
       '00000000-0000-4000-8000-00000000d504'::uuid, '00000000-0000-4000-8000-00000000d505'::uuid,
       c.day_name, c.class_time, null, date '2026-01-05', 'SCHEDULED'
from walink_clock as c;

-- Sessões e salas: S1 = aula de agora (booking B1, aceite, sala READY);
-- S2 = reposição R1 amanhã; S3 = antecipação do B1 para depois de amanhã.
insert into public.lesson_sessions (
  id, tenant_id, student_id, teacher_id, class_date, scheduled_start_at, scheduled_end_at, source_key, documentation_consent
)
select s.id, 'sala-oficial-test', '00000000-0000-4000-8000-00000000d503', '00000000-0000-4000-8000-00000000d502',
       s.class_date,
       (s.class_date + s.start_time) at time zone 'America/Sao_Paulo',
       (s.class_date + s.start_time + interval '30 minutes') at time zone 'America/Sao_Paulo',
       s.source_key, true
from walink_clock as c
cross join lateral (values
  ('00000000-0000-4000-8000-00000000d5a1'::uuid, c.class_date, c.class_time::time, 'walink-s1'),
  ('00000000-0000-4000-8000-00000000d5a2'::uuid, c.class_date + 1, time '15:00', 'walink-s2'),
  ('00000000-0000-4000-8000-00000000d5a3'::uuid, c.class_date + 2, time '08:00', 'walink-s3')
) as s(id, class_date, start_time, source_key);

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
  ('00000000-0000-4000-8000-00000000d5a3'::uuid, 'booking', '00000000-0000-4000-8000-00000000d5b1', c.class_date + 2, time '08:00')
) as v(session_id, source_type, source_id, class_date, start_time);

insert into private.google_meet_rooms (
  lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub, cohost_email, state, created_by
) values
  ('00000000-0000-4000-8000-00000000d5a1', 'sala-oficial-test', 'spaces/walinkS1', 'https://meet.google.com/abc-defg-hij', 'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502'),
  ('00000000-0000-4000-8000-00000000d5a2', 'sala-oficial-test', 'spaces/walinkS2', 'https://meet.google.com/rep-osic-aoo', 'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502'),
  ('00000000-0000-4000-8000-00000000d5a3', 'sala-oficial-test', 'spaces/walinkS3', 'https://meet.google.com/ant-ecip-ada', 'synthetic-sub', 'walink-teacher@example.invalid', 'READY', '00000000-0000-4000-8000-00000000d502');

-- Agendamento, reposição e antecipação acham a sala da própria data.
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'BOOKING', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, c.class_time::time, '00000000-0000-4000-8000-00000000d503') = 'https://meet.google.com/abc-defg-hij'
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, null, null) = 'https://meet.google.com/abc-defg-hij'
  and public.official_lesson_link('sala-oficial-test', 'reschedule', '00000000-0000-4000-8000-00000000d5c1',
    c.class_date + 1, time '15:00', '00000000-0000-4000-8000-00000000d503') = 'https://meet.google.com/rep-osic-aoo'
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, time '08:00', '00000000-0000-4000-8000-00000000d503') = 'https://meet.google.com/ant-ecip-ada',
  'sala oficial de agendamento, reposição ou antecipação não encontrada'
)
from walink_clock as c;

-- Outra data, outro horário, outro aluno, outra escola, outro tipo: nada.
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 3, null, null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, time '23:59', null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, null, '00000000-0000-4000-8000-00000000d505') is null
  and public.official_lesson_link('sala-oficial-outra', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, null, null) is null
  and public.official_lesson_link('sala-oficial-test', 'appointment', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date, null, null) is null,
  'sala oficial vazou para outra aula'
)
from walink_clock as c;

-- Sala que não está pronta não vale.
update private.google_meet_rooms set state = 'COHOST_PENDING'
where lesson_session_id = '00000000-0000-4000-8000-00000000d5a2';
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'reschedule', '00000000-0000-4000-8000-00000000d5c1',
    c.class_date + 1, time '15:00', null) is null,
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
    c.class_date + 1, time '15:00', null) is null,
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
    c.class_date + 2, time '08:00', null) is null,
  'sala oficial mandada para aula sem aceite de registro'
)
from walink_clock as c;
update public.lesson_sessions set documentation_consent = true
where id = '00000000-0000-4000-8000-00000000d5a3';

-- Sessão substituída não vale.
update public.lesson_sessions set status = 'SUPERSEDED'
where id = '00000000-0000-4000-8000-00000000d5a3';
select pg_temp.assert_true(
  public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, time '08:00', null) is null,
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
    c.class_date + 2, null, null) is null
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, time '08:00', null) = 'https://meet.google.com/ant-ecip-ada'
  and public.official_lesson_link('sala-oficial-test', 'booking', '00000000-0000-4000-8000-00000000d5b1',
    c.class_date + 2, time '09:00', null) = 'https://meet.google.com/out-rasa-laa',
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
   '00000000-0000-4000-8000-00000000d5b2'::uuid, 'walink-debora')
) as v(id, phone, body, source_id, idempotency_key);

do $fence$
declare
  v_row public.notification_queue%rowtype;
  v_official public.notification_queue%rowtype;
  v_debora public.notification_queue%rowtype;
  v_integration_id uuid;
  v_integration_version bigint;
  v_class_time text;
  v_without_room text;
  v_with_room text;
  v_flattened text;
  v_canonical text;
  v_result jsonb;
begin
  select integration_id, integration_version
  into strict v_integration_id, v_integration_version
  from public.whatsapp_instances
  where tenant_id = 'sala-oficial-test' and instance_name = 'wa-sala-oficial';

  select class_time into strict v_class_time from walink_clock;

  for v_row in select * from public.claim_notification_delivery_batch(200, 300) loop
    if v_row.id = '00000000-0000-4000-8000-00000000d5e1' then
      v_official := v_row;
    elsif v_row.id = '00000000-0000-4000-8000-00000000d5e2' then
      v_debora := v_row;
    end if;
  end loop;
  perform pg_temp.assert_true(
    v_official.id is not null and v_debora.id is not null,
    'lembretes de teste não foram reservados pela fila'
  );

  -- Aula com sala oficial: o lembrete de sempre (sem link) é recusado...
  v_without_room := public.render_lesson_reminder_message(
    null, 'Theo', v_class_time, 'Teacher Sala', 'Sala Oficial Test', null, null
  );
  v_result := public.begin_notification_delivery_submission(
    v_official.id, v_official.claim_token, 'wa-sala-oficial',
    '5511988881503', '5511988881503', v_without_room,
    v_integration_id, v_integration_version
  );
  perform pg_temp.assert_true(
    (v_result ->> 'ok')::boolean is false
      and v_result ->> 'action' = 'REVIEW_REQUIRED'
      and v_result ->> 'reason' = 'lesson_authorized_snapshot_changed'
      and not exists (
        select 1 from public.automation_sent where notification_id = v_official.id
      ),
    'cerca aceitou lembrete sem a sala oficial: ' || v_result::text
  );

  -- ...e o lembrete com a sala oficial é o autorizado e selado.
  v_with_room := public.render_lesson_reminder_message(
    null, 'Theo', v_class_time, 'Teacher Sala', 'Sala Oficial Test',
    'https://meet.google.com/abc-defg-hij', null
  );
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
end;
$fence$;

rollback;
