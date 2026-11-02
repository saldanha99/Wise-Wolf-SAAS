-- Onda 3, correções da integração (20260928100000 + 20260928110000):
--
-- 1. Aula de 1 h = dois agendamentos de 30 min, cada um com a SUA cobertura (é
--    assim em produção: 16:30 e 17:00 confirmadas com a mesma substituta em
--    16/09 e 18/09). O pacote e o aviso de sala são decididos pela AULA:
--    a) aula congelada com a titular (aceite + sala): a primeira parte aceita
--       não promete nem nega a sala ("esta parte é sua; o restante ainda não
--       está confirmado"); a segunda sai como UMA atualização da aula inteira
--       (coverage-lesson:<cobertura da 1ª parte>), e a sala chega uma vez só, com
--       o horário da aula (10:00), a substituta e a família;
--    b) primeira parte aceita ANTES de a sessão congelar (a aula vira duas
--       sessões, cada uma com a sua sala) e a segunda DEPOIS: as duas viram UMA
--       sessão, com a sala que a família já tem; a outra é arquivada (sem aceite:
--       a fila desliga a transcrição dela) e o segundo link nunca sai;
--    c) a mesma coisa na ordem inversa (segunda parte primeiro): fica a sala já
--       entregue, e a aula passa a começar na primeira parte;
--    d) a outra parte só congela DEPOIS da troca: a rodada de 15 min junta.
-- 2. Cobertura desfeita volta ao titular também quando a sessão NASCEU com o
--    substituto (confirmada antes do congelamento, sem troca registrada):
--    a) antes da aula: a sessão volta à titular, a sala fica retida até a conta
--       dela ser a coanfitriã e então sai para ela e para o aluno;
--    b) depois da aula, com o lançamento da titular: a aula é dela e o
--       lançamento se liga (nada de pendência de lançamento contra a ex-substituta);
--    c) depois da aula, com o lançamento da ex-substituta: fica com ela.
--
-- Reprova contra a integração sem os acertos (medido no clone com dados): o
-- pacote da 1ª parte mandava "combine direto e mande o link", cada parte tinha
-- o seu pacote e o seu aviso de sala (10:00 e 10:30), a aula dividida ficava
-- com duas salas (a família recebia os dois links) e a sessão nascida com o
-- substituto ficava presa com ele (BOOKING_TRANSFER_NEEDS_REPLAN). Não depende
-- de dado real (fixtures próprias), da fila global (conexões reais fora do ar só
-- num savepoint) nem do horário do dia (as aulas futuras são amanhã; as
-- passadas, dois dias atrás).
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.fix_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'aula de 1 h / cobertura desfeita: %', p_message;
  end if;
end;
$$;
grant execute on function pg_temp.fix_assert(boolean, text) to public;

-- Decisão do aluno como a página grava (link + código do WhatsApp).
create or replace function pg_temp.fix_student_accepts(p_student uuid)
returns void language plpgsql as $$
declare
  v_link uuid;
  v_challenge uuid := gen_random_uuid();
begin
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values ('aula-1h-fix', p_student, encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'),
    '00000000-0000-4000-8000-0000000f0001', now() + interval '1 day', now())
  returning id into v_link;
  insert into private.lesson_recording_consent_challenges (id, link_id, tenant_id, student_id, relation, destination,
    code_hash, delivery_status, expires_at, consumed_at)
  values (v_challenge, v_link, 'aula-1h-fix', p_student, 'GUARDIAN', '5511900008777',
    encode(extensions.digest(v_challenge::text, 'sha256'), 'hex'), 'SENT', now() + interval '10 minutes', now());
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, link_id, verification, verified_phone,
    verification_challenge_id)
  values ('aula-1h-fix', p_student, 'STUDENT', 'ACCEPTED', 'Responsavel Fix', 'GUARDIAN', 'STUDENT',
    (private.lesson_recording_current_term('STUDENT')).version,
    'LINK', v_link, 'WHATSAPP_CODE', '(11) •••••-8777', v_challenge);
end;
$$;

-- Conta Google confirmada + "autorizo" da versão vigente, dez dias atrás.
create or replace function pg_temp.fix_teacher(p_teacher uuid, p_email text)
returns void language plpgsql as $$
begin
  insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
  values (p_teacher, 'aula-1h-fix', 'sub-' || replace(p_teacher::text, '-', ''), p_email, true)
  on conflict (teacher_id) do update set google_email = excluded.google_email;
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, recorded_by, decided_at)
  values ('aula-1h-fix', p_teacher, 'TEACHER', 'ACCEPTED', 'Professor Fix', 'SELF', 'TEACHER',
    (private.lesson_recording_current_term('TEACHER')).version, 'APP', p_teacher, now() - interval '10 days');
end;
$$;

-- Salas do app como a pessoa logada as vê (meeting_uri por sessão).
create or replace function pg_temp.fix_rooms(p_user uuid)
returns text[] language plpgsql as $$
declare
  v_rooms text[];
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select coalesce(array_agg(x ->> 'meeting_uri' order by x ->> 'scheduled_start_at'), '{}') into v_rooms
  from jsonb_array_elements(public.get_my_lesson_rooms(
    (now() at time zone 'America/Sao_Paulo')::date + 1, (now() at time zone 'America/Sao_Paulo')::date + 1)) as x;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  return v_rooms;
end;
$$;

create or replace function pg_temp.fix_jobs(p_session uuid)
returns text[] language sql as $$
  select coalesce(array_agg(j ->> 'operation' order by j ->> 'operation'), '{}')
  from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) as j
  where j ->> 'lesson_session_id' = p_session::text;
$$;

set local request.jwt.claims = '{"role":"service_role"}';
select set_config('app.reschedule_silent', 'on', true);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

-- Banco só com a estrutura: uma versão antiga dos termos garante termo vigente
-- dois dias atrás. A versão aceita a cobre.
insert into private.lesson_recording_terms (audience, version, body, published_at) values
  ('STUDENT', 'v0', repeat('Termo antigo de teste do aluno. ', 12), now() - interval '60 days'),
  ('TEACHER', 'v0', repeat('Termo antigo de teste do professor. ', 12), now() - interval '60 days')
on conflict (audience, version) do nothing;

create temp table fix_clock as
select (now() at time zone 'America/Sao_Paulo')::date + 1 as d,
       (now() at time zone 'America/Sao_Paulo')::date - 2 as y;
grant select on fix_clock to public;
create temp table fix_day as
select c.d, c.y,
  (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.d)::int + 1] as d_name,
  (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.y)::int + 1] as y_name
from fix_clock as c;
create or replace function pg_temp.fix_d() returns date language sql as $$ select d from fix_clock $$;
create or replace function pg_temp.fix_y() returns date language sql as $$ select y from fix_clock $$;

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values ('aula-1h-fix', 'Aula 1h Fix', 'aula-1h-fix', 'active', true);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select v.id, 'authenticated', 'authenticated', v.email, '{"provider":"email","providers":["email"]}',
  jsonb_build_object('full_name', v.name), now(), now()
from (values
  ('00000000-0000-4000-8000-0000000f0001'::uuid, 'fix-admin@example.invalid', 'Diretora Fix'),
  ('00000000-0000-4000-8000-0000000f0002'::uuid, 'fix-ana@example.invalid', 'Ana Titular'),
  ('00000000-0000-4000-8000-0000000f0003'::uuid, 'fix-bia@example.invalid', 'Bia Substituta'),
  ('00000000-0000-4000-8000-0000000f0011'::uuid, 'fix-um@example.invalid', 'Aluno Um'),
  ('00000000-0000-4000-8000-0000000f0012'::uuid, 'fix-dois@example.invalid', 'Aluno Dois'),
  ('00000000-0000-4000-8000-0000000f0013'::uuid, 'fix-tres@example.invalid', 'Aluno Tres'),
  ('00000000-0000-4000-8000-0000000f0014'::uuid, 'fix-quatro@example.invalid', 'Aluno Quatro'),
  ('00000000-0000-4000-8000-0000000f0015'::uuid, 'fix-cinco@example.invalid', 'Aluno Cinco'),
  ('00000000-0000-4000-8000-0000000f0016'::uuid, 'fix-seis@example.invalid', 'Aluno Seis'),
  ('00000000-0000-4000-8000-0000000f0017'::uuid, 'fix-sete@example.invalid', 'Aluno Sete')
) as v(id, email, name);

update public.profiles as p
set tenant_id = 'aula-1h-fix', role = v.role, lifecycle_status = 'active', full_name = v.name,
    phone = v.phone, attendance_phone = v.phone, is_test_account = false
from (values
  ('00000000-0000-4000-8000-0000000f0001'::uuid, 'SCHOOL_ADMIN', 'Diretora Fix', '5511999998001'),
  ('00000000-0000-4000-8000-0000000f0002'::uuid, 'TEACHER', 'Ana Titular', '5511999998002'),
  ('00000000-0000-4000-8000-0000000f0003'::uuid, 'TEACHER', 'Bia Substituta', '5511999998003'),
  ('00000000-0000-4000-8000-0000000f0011'::uuid, 'STUDENT', 'Aluno Um', '5511988888011'),
  ('00000000-0000-4000-8000-0000000f0012'::uuid, 'STUDENT', 'Aluno Dois', '5511988888012'),
  ('00000000-0000-4000-8000-0000000f0013'::uuid, 'STUDENT', 'Aluno Tres', '5511988888013'),
  ('00000000-0000-4000-8000-0000000f0014'::uuid, 'STUDENT', 'Aluno Quatro', '5511988888014'),
  ('00000000-0000-4000-8000-0000000f0015'::uuid, 'STUDENT', 'Aluno Cinco', '5511988888015'),
  ('00000000-0000-4000-8000-0000000f0016'::uuid, 'STUDENT', 'Aluno Seis', '5511988888016'),
  ('00000000-0000-4000-8000-0000000f0017'::uuid, 'STUDENT', 'Aluno Sete', '5511988888017')
) as v(id, role, name, phone)
where p.id = v.id;

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
select p.id, 'aula-1h-fix', p.role, 'ACTIVE', true
from public.profiles as p
where p.tenant_id = 'aula-1h-fix'
on conflict (user_id, tenant_id) do update
set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values ('00000000-0000-4000-8000-0000000f0001', 'aula-1h-fix');

-- Conta central conectada (a previsão de sala do pacote exige). A fila global
-- do Meet só é lida num savepoint, com as conexões reais fora do ar.
insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('aula-1h-fix', 'fix-sub-central', 'escola-fix@example.invalid', 'CONNECTED',
  '00000000-0000-4000-8000-0000000f0001');

-- Agenda com a titular. Amanhã: aula de 1 h do Um (10:00+10:30), do Dois
-- (14:00+14:30), do Tres (16:00+16:30) e do Sete (18:00+18:30); aula de 30 min
-- do Quatro (11:30).
-- Dois dias atrás: Cinco (08:00) e Seis (09:00).
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select v.id, 'aula-1h-fix', '00000000-0000-4000-8000-0000000f0002', v.student_id,
       case when v.past then t.y_name else t.d_name end, v.slot, null, date '2026-01-05', 'SCHEDULED'
from fix_day as t
cross join lateral (values
  ('00000000-0000-4000-8000-0000000fb101'::uuid, '00000000-0000-4000-8000-0000000f0011'::uuid, '10:00', false),
  ('00000000-0000-4000-8000-0000000fb102'::uuid, '00000000-0000-4000-8000-0000000f0011'::uuid, '10:30', false),
  ('00000000-0000-4000-8000-0000000fb201'::uuid, '00000000-0000-4000-8000-0000000f0012'::uuid, '14:00', false),
  ('00000000-0000-4000-8000-0000000fb202'::uuid, '00000000-0000-4000-8000-0000000f0012'::uuid, '14:30', false),
  ('00000000-0000-4000-8000-0000000fb301'::uuid, '00000000-0000-4000-8000-0000000f0013'::uuid, '16:00', false),
  ('00000000-0000-4000-8000-0000000fb302'::uuid, '00000000-0000-4000-8000-0000000f0013'::uuid, '16:30', false),
  ('00000000-0000-4000-8000-0000000fb401'::uuid, '00000000-0000-4000-8000-0000000f0014'::uuid, '11:30', false),
  ('00000000-0000-4000-8000-0000000fb701'::uuid, '00000000-0000-4000-8000-0000000f0017'::uuid, '18:00', false),
  ('00000000-0000-4000-8000-0000000fb702'::uuid, '00000000-0000-4000-8000-0000000f0017'::uuid, '18:30', false),
  ('00000000-0000-4000-8000-0000000fb501'::uuid, '00000000-0000-4000-8000-0000000f0015'::uuid, '08:00', true),
  ('00000000-0000-4000-8000-0000000fb601'::uuid, '00000000-0000-4000-8000-0000000f0016'::uuid, '09:00', true)
) as v(id, student_id, slot, past);

select pg_temp.fix_teacher('00000000-0000-4000-8000-0000000f0002', 'ana.fix@example.invalid');
select pg_temp.fix_teacher('00000000-0000-4000-8000-0000000f0003', 'bia.fix@example.invalid');
select pg_temp.fix_student_accepts(v.id)
from (values ('00000000-0000-4000-8000-0000000f0011'::uuid), ('00000000-0000-4000-8000-0000000f0012'::uuid),
             ('00000000-0000-4000-8000-0000000f0013'::uuid), ('00000000-0000-4000-8000-0000000f0014'::uuid),
             ('00000000-0000-4000-8000-0000000f0017'::uuid)) as v(id);

-- A validação da cobertura (grade, ausência, conflito, atestado) tem suíte
-- própria; aqui só ela fica de fora, e o gatilho da troca segue ligado.
alter table public.class_coverages disable trigger trg_enforce_active_class_coverage_slot;

create or replace function pg_temp.fix_cover(p_id uuid, p_student uuid, p_booking uuid, p_date date, p_time text)
returns void language sql as $$
  insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
    class_date, class_time, status, confirmed_at)
  values (p_id, 'aula-1h-fix', '00000000-0000-4000-8000-0000000f0002', '00000000-0000-4000-8000-0000000f0003',
    p_student, p_booking, p_date, p_time, 'confirmed', now())
$$;
-- Sessão viva de uma ocorrência (agendamento + data).
create or replace function pg_temp.fix_sid(p_booking uuid, p_date date)
returns uuid language sql as $$
  select o.session_id from public.lesson_occurrences as o
  join public.lesson_sessions as s on s.id = o.session_id
  where o.tenant_id = 'aula-1h-fix' and o.source_type = 'booking' and o.source_id = p_booking::text
    and o.class_date = p_date and o.status <> 'SUPERSEDED' and s.status <> 'SUPERSEDED'
$$;
-- Congela como o job do termo marca e a fila cria a sala.
create or replace function pg_temp.fix_freeze(p_session uuid, p_uri text, p_cohost text)
returns void language plpgsql as $$
begin
  insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason, created_at)
  values (p_session, '00000000-0000-4000-8000-0000000f0001', true,
    'Termo de registro das aulas: aluno (ou responsável) e professor aceitaram o registro permanente.',
    clock_timestamp());
  update public.lesson_sessions set documentation_consent = true where id = p_session;
  insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
    cohost_email, state, created_by)
  values (p_session, 'aula-1h-fix', 'spaces/fix' || replace(left(p_session::text, 8), '-', ''), p_uri,
    'fix-sub-central', p_cohost, 'CREATING', '00000000-0000-4000-8000-0000000f0001');
  update private.google_meet_rooms set state = 'READY' where lesson_session_id = p_session;
end;
$$;
-- O que a fila do Meet faz para pôr a conta de quem dá a aula como coanfitriã.
create or replace function pg_temp.fix_cohost(p_session uuid, p_email text)
returns void language sql as $$
  select public.google_meet_backend('room_claim', 'aula-1h-fix', '00000000-0000-4000-8000-0000000f0001',
    p_session, '{"organizer_sub":"fix-sub-central","automatic":true}'::jsonb);
  select public.google_meet_backend('room_cohost_save', 'aula-1h-fix', '00000000-0000-4000-8000-0000000f0001',
    p_session, jsonb_build_object('result', 'SYNCED', 'cohost_email', p_email));
$$;
create or replace function pg_temp.fix_queue(p_phone text)
returns table (idempotency_key text, message_body text) language sql as $$
  select q.idempotency_key, q.message_body from public.notification_queue as q
  where q.tenant_id = 'aula-1h-fix' and q.student_phone = p_phone
  order by q.created_at, q.idempotency_key
$$;

select private.sync_lesson_quality_sessions('aula-1h-fix', t.d, t.d, null) from fix_day as t;

-- ─── 1a. Aula de 1 h congelada com a titular; a Bia aceita as duas partes ────
select pg_temp.fix_assert(
  pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb101', pg_temp.fix_d())
    = pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb102', pg_temp.fix_d()),
  'fixture: a aula de 1 h do Um não nasceu numa sessão só');
select pg_temp.fix_freeze(pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb101', pg_temp.fix_d()),
  'https://meet.google.com/uma-aula-fix', 'ana.fix@example.invalid');
create temp table fix_um as
select pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb101', pg_temp.fix_d()) as sid;

select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc101', '00000000-0000-4000-8000-0000000f0011',
  '00000000-0000-4000-8000-0000000fb101', pg_temp.fix_d(), '10:00');
select pg_temp.fix_assert(
  (select count(*) = 2 and count(part_coverage_id) = 1
   from private.coverage_lesson_parts('00000000-0000-4000-8000-0000000fc101')),
  'a aula do Um não foi reconhecida como duas partes, uma da Bia');

create temp table fix_brief1 as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc101', false) as r;
select pg_temp.fix_assert(
  (select (r ->> 'lesson_parts')::integer = 2
     and not (r ->> 'lesson_complete')::boolean
     and (r ->> 'room_undecided')::boolean
     and not (r ->> 'school_room_expected')::boolean
     and strpos(r ->> 'briefing', 'esta parte é sua') > 0
     and strpos(r ->> 'briefing', 'não dá para saber se ela será na sala da escola') > 0
     and strpos(r ->> 'briefing', 'combine direto e mande o link da aula') = 0
     and strpos(r ->> 'briefing', 'o link chega por aqui quando a sala ficar pronta') = 0
   from fix_brief1)
  and (select strpos(message_body, 'a parte das 10:00') > 0
         and strpos(message_body, 'O link da aula chega por aqui antes do horário') > 0
         and strpos(message_body, 'vai te chamar pelo WhatsApp para combinar o link') = 0
       from public.notification_queue
      where tenant_id = 'aula-1h-fix' and idempotency_key = 'coverage:00000000-0000-4000-8000-0000000fc101:family'),
  'primeira parte da aula de 1 h prometeu ou negou a sala: ' || (select r::text from fix_brief1));

select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc102', '00000000-0000-4000-8000-0000000f0011',
  '00000000-0000-4000-8000-0000000fb102', pg_temp.fix_d(), '10:30');
select pg_temp.fix_assert(
  (select teacher_id from public.lesson_sessions where id = (select sid from fix_um)) = '00000000-0000-4000-8000-0000000f0003'
  and (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = (select sid from fix_um)),
  'fixture: a aula do Um não passou à Bia com a sala retida');

create temp table fix_brief2 as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc102', false) as r;
select pg_temp.fix_assert(
  (select (r ->> 'lesson_complete')::boolean and (r ->> 'lesson_update')::boolean
     and (r ->> 'school_room_expected')::boolean
     and r ->> 'idempotency_prefix' = 'coverage-lesson:00000000-0000-4000-8000-0000000fc101'
     and strpos(r ->> 'briefing', 'agora é toda sua') > 0
     and strpos(r ->> 'briefing', 'o link chega por aqui quando a sala ficar pronta') > 0
     and strpos(r ->> 'briefing', 'wa.me/') = 0
   from fix_brief2)
  and (select strpos(message_body, '(60 min) será com a Teacher Bia') > 0
         and strpos(message_body, 'o link chega por aqui antes do horário') > 0
       from public.notification_queue
      where tenant_id = 'aula-1h-fix' and idempotency_key = 'coverage-lesson:00000000-0000-4000-8000-0000000fc101:family')
  and not exists (select 1 from public.notification_queue
                  where tenant_id = 'aula-1h-fix'
                    and idempotency_key like 'coverage:00000000-0000-4000-8000-0000000fc102:%'),
  'segunda parte da aula de 1 h não saiu como uma atualização da aula inteira: ' || (select r::text from fix_brief2));
-- Pedir o pacote de novo (de qualquer parte) não repete nada.
select pg_temp.fix_assert(
  (public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc101', false) -> 'queued') = '[]'::jsonb
  and (public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc102', false) -> 'queued') = '[]'::jsonb,
  'pacote da aula de 1 h repetido');

-- A fila acerta a coanfitriã: a sala chega UMA vez, com o horário da aula.
select pg_temp.fix_cohost((select sid from fix_um), 'bia.fix@example.invalid');
select pg_temp.fix_assert(
  (select count(*) = 1 from public.notification_queue where tenant_id = 'aula-1h-fix' and idempotency_key like '%:room')
  and (select count(*) = 1 from public.notification_queue where tenant_id = 'aula-1h-fix' and idempotency_key like '%:room-family')
  and (select idempotency_key = 'coverage:00000000-0000-4000-8000-0000000fc101:room'
         and strpos(message_body, 'https://meet.google.com/uma-aula-fix') > 0
         and strpos(message_body, 'às 10:00') > 0 and strpos(message_body, '10:30') = 0
       from public.notification_queue where tenant_id = 'aula-1h-fix' and idempotency_key like '%:room')
  and (select strpos(message_body, 'às 10:00') > 0 and strpos(message_body, 'https://meet.google.com/uma-aula-fix') > 0
       from public.notification_queue where tenant_id = 'aula-1h-fix' and idempotency_key like '%:room-family')
  and (select count(*) = 3 from pg_temp.fix_queue('5511988888011'))
  and (select count(*) = 3 from pg_temp.fix_queue('5511999998003')),
  'aviso de sala da aula de 1 h repetido ou com o horário de uma metade: '
    || (select string_agg(idempotency_key || ' => ' || message_body, ' | ') from public.notification_queue
        where tenant_id = 'aula-1h-fix'));
select pg_temp.fix_assert(
  (private.coverage_room_notice_enqueue('00000000-0000-4000-8000-0000000fc102') -> 'queued') = '[]'::jsonb
  and (private.coverage_room_notice_enqueue('00000000-0000-4000-8000-0000000fc101') -> 'queued') = '[]'::jsonb,
  'aviso de sala pedido de novo pela outra parte repetiu');

-- ─── 1b. Primeira parte aceita antes de congelar; a segunda depois ───────────
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc201', '00000000-0000-4000-8000-0000000f0012',
  '00000000-0000-4000-8000-0000000fb201', pg_temp.fix_d(), '14:00');
select pg_temp.fix_assert(
  pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb201', pg_temp.fix_d())
    <> pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb202', pg_temp.fix_d())
  and (select teacher_id from public.lesson_sessions
       where id = pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb201', pg_temp.fix_d()))
    = '00000000-0000-4000-8000-0000000f0003',
  'fixture: a aula do Dois não ficou em duas sessões (Bia 14:00, Ana 14:30)');
select pg_temp.fix_assert(
  (select (r ->> 'room_undecided')::boolean and not (r ->> 'lesson_complete')::boolean
   from (select public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc201', false) as r) as x),
  'primeira parte aceita antes de congelar decidiu a sala');
create temp table fix_dois as
select pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb201', pg_temp.fix_d()) as bia_sid,
       pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb202', pg_temp.fix_d()) as ana_sid;
-- O job do termo marca as duas e a fila cria uma sala para cada uma: a da Bia
-- chega à família.
select pg_temp.fix_freeze((select bia_sid from fix_dois), 'https://meet.google.com/dois-bia-fix', 'bia.fix@example.invalid');
select pg_temp.fix_freeze((select ana_sid from fix_dois), 'https://meet.google.com/dois-ana-fix', 'ana.fix@example.invalid');
select pg_temp.fix_assert(
  exists (select 1 from public.notification_queue
          where tenant_id = 'aula-1h-fix' and idempotency_key = 'coverage:00000000-0000-4000-8000-0000000fc201:room-family'
            and strpos(message_body, 'https://meet.google.com/dois-bia-fix') > 0),
  'fixture: a sala da Bia (primeira parte) não chegou à família do Dois');

select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc202', '00000000-0000-4000-8000-0000000f0012',
  '00000000-0000-4000-8000-0000000fb202', pg_temp.fix_d(), '14:30');
select pg_temp.fix_assert(
  (select count(*) = 1 from public.lesson_sessions
   where tenant_id = 'aula-1h-fix' and student_id = '00000000-0000-4000-8000-0000000f0012' and status <> 'SUPERSEDED')
  and pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb202', pg_temp.fix_d()) = (select bia_sid from fix_dois)
  and (select s.teacher_id = '00000000-0000-4000-8000-0000000f0003'
         and s.scheduled_start_at = (pg_temp.fix_d() + time '14:00') at time zone 'America/Sao_Paulo'
         and s.scheduled_end_at = (pg_temp.fix_d() + time '15:00') at time zone 'America/Sao_Paulo'
       from public.lesson_sessions as s where s.id = (select bia_sid from fix_dois))
  and (select s.status = 'SUPERSEDED' and not s.documentation_consent and s.source_key like '%:merged:%'
       from public.lesson_sessions as s where s.id = (select ana_sid from fix_dois))
  and exists (select 1 from private.lesson_session_revisions
              where session_id = (select ana_sid from fix_dois) and action = 'MERGE_ADJACENT_ABSORBED')
  and exists (select 1 from private.lesson_session_revisions
              where session_id = (select bia_sid from fix_dois) and action = 'MERGE_ADJACENT')
  and not (select e.allowed from private.lesson_documentation_consent_events as e
           where e.session_id = (select ana_sid from fix_dois) order by e.created_at desc limit 1),
  'aula de 1 h que passou a ser toda da Bia continuou em duas sessões');
select pg_temp.fix_assert(
  public.official_lesson_link('aula-1h-fix', 'booking', '00000000-0000-4000-8000-0000000fb202', pg_temp.fix_d(),
    '00000000-0000-4000-8000-0000000f0002', time '14:30', '00000000-0000-4000-8000-0000000f0012')
    = 'https://meet.google.com/dois-bia-fix'
  and pg_temp.fix_rooms('00000000-0000-4000-8000-0000000f0012') = array['https://meet.google.com/dois-bia-fix'],
  'o aluno Dois ficou com duas salas para a mesma aula: ' || pg_temp.fix_rooms('00000000-0000-4000-8000-0000000f0012')::text);
create temp table fix_brief4 as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc202', false) as r;
select pg_temp.fix_assert(
  (select (r ->> 'lesson_complete')::boolean and (r ->> 'official_room')::boolean
     and strpos(r ->> 'briefing', 'https://meet.google.com/dois-bia-fix') > 0
   from fix_brief4)
  and not exists (select 1 from public.notification_queue
                  where tenant_id = 'aula-1h-fix' and strpos(message_body, 'dois-ana-fix') > 0),
  'a família ou a Bia receberam o segundo link da aula do Dois: ' || (select r::text from fix_brief4));
-- A sala da sessão juntada perde a transcrição (sem aceite: a fila desliga).
savepoint fix_fila;
update private.google_workspace_connections set status = 'REAUTH_REQUIRED'
where status = 'CONNECTED' and tenant_id <> 'aula-1h-fix';
select pg_temp.fix_assert(
  pg_temp.fix_jobs((select ana_sid from fix_dois)) = array['DISABLE_ARTIFACTS'],
  'fila não desligou a sala da sessão juntada: ' || pg_temp.fix_jobs((select ana_sid from fix_dois))::text);
rollback to savepoint fix_fila;
release savepoint fix_fila;

-- ─── 1c. Ordem inversa: a segunda parte primeiro ─────────────────────────────
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc302', '00000000-0000-4000-8000-0000000f0013',
  '00000000-0000-4000-8000-0000000fb302', pg_temp.fix_d(), '16:30');
create temp table fix_tres as
select pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb301', pg_temp.fix_d()) as ana_sid,
       pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb302', pg_temp.fix_d()) as bia_sid;
select pg_temp.fix_assert((select ana_sid <> bia_sid from fix_tres), 'fixture: a aula do Tres não ficou em duas sessões');
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc302', false);
select pg_temp.fix_freeze((select ana_sid from fix_tres), 'https://meet.google.com/tres-ana-fix', 'ana.fix@example.invalid');
select pg_temp.fix_freeze((select bia_sid from fix_tres), 'https://meet.google.com/tres-bia-fix', 'bia.fix@example.invalid');
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc301', '00000000-0000-4000-8000-0000000f0013',
  '00000000-0000-4000-8000-0000000fb301', pg_temp.fix_d(), '16:00');
select pg_temp.fix_assert(
  (select count(*) = 1 from public.lesson_sessions
   where tenant_id = 'aula-1h-fix' and student_id = '00000000-0000-4000-8000-0000000f0013' and status <> 'SUPERSEDED')
  and pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb301', pg_temp.fix_d()) = (select bia_sid from fix_tres)
  and (select s.scheduled_start_at = (pg_temp.fix_d() + time '16:00') at time zone 'America/Sao_Paulo'
         and s.scheduled_end_at = (pg_temp.fix_d() + time '17:00') at time zone 'America/Sao_Paulo'
       from public.lesson_sessions as s where s.id = (select bia_sid from fix_tres))
  and pg_temp.fix_rooms('00000000-0000-4000-8000-0000000f0013') = array['https://meet.google.com/tres-bia-fix']
  and public.official_lesson_link('aula-1h-fix', 'booking', '00000000-0000-4000-8000-0000000fb301', pg_temp.fix_d(),
    '00000000-0000-4000-8000-0000000f0002', time '16:00', '00000000-0000-4000-8000-0000000f0013')
    = 'https://meet.google.com/tres-bia-fix'
  and (select strpos(r ->> 'briefing', 'https://meet.google.com/tres-bia-fix') > 0
       from (select public.coverage_briefing_enqueue('00000000-0000-4000-8000-0000000fc301', false) as r) as x)
  and not exists (select 1 from public.notification_queue
                  where tenant_id = 'aula-1h-fix' and strpos(message_body, 'tres-ana-fix') > 0),
  'ordem inversa: a aula do Tres não ficou na sala já entregue (ou saiu outro link)');

-- ─── 1d. A outra parte só congela DEPOIS da troca: a rodada junta ───────────
-- (a substituta confirmou a conta ou o termo mais tarde, por exemplo). A troca
-- da parte das 18:30 não acha a vizinha (ainda sem evidência, refeita pela
-- rodada); quando ela congela, a rodada de 15 min junta as duas.
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc701', '00000000-0000-4000-8000-0000000f0017',
  '00000000-0000-4000-8000-0000000fb701', pg_temp.fix_d(), '18:00');
select pg_temp.fix_freeze(pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb702', pg_temp.fix_d()),
  'https://meet.google.com/sete-ana-fix', 'ana.fix@example.invalid');
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc702', '00000000-0000-4000-8000-0000000f0017',
  '00000000-0000-4000-8000-0000000fb702', pg_temp.fix_d(), '18:30');
create temp table fix_sete as
select pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb701', pg_temp.fix_d()) as bia_sid,
       pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb702', pg_temp.fix_d()) as handed_sid;
select pg_temp.fix_assert(
  (select bia_sid <> handed_sid from fix_sete)
  and (select bool_and(teacher_id = '00000000-0000-4000-8000-0000000f0003') from public.lesson_sessions
       where id in (select bia_sid from fix_sete union all select handed_sid from fix_sete)),
  'fixture: a aula do Sete não ficou em duas sessões da Bia depois da troca da parte das 18:30');
select pg_temp.fix_freeze((select bia_sid from fix_sete), 'https://meet.google.com/sete-bia-fix', 'bia.fix@example.invalid');
select private.sync_lesson_quality_sessions('aula-1h-fix', pg_temp.fix_d(), pg_temp.fix_d(),
  '00000000-0000-4000-8000-0000000f0017');
select pg_temp.fix_assert(
  (select count(*) = 1 from public.lesson_sessions
   where tenant_id = 'aula-1h-fix' and student_id = '00000000-0000-4000-8000-0000000f0017' and status <> 'SUPERSEDED')
  and pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb702', pg_temp.fix_d()) = (select bia_sid from fix_sete)
  and (select status = 'SUPERSEDED' from public.lesson_sessions where id = (select handed_sid from fix_sete))
  and public.official_lesson_link('aula-1h-fix', 'booking', '00000000-0000-4000-8000-0000000fb702', pg_temp.fix_d(),
    '00000000-0000-4000-8000-0000000f0002', time '18:30', '00000000-0000-4000-8000-0000000f0017')
    = 'https://meet.google.com/sete-bia-fix',
  'a rodada não juntou a aula de 1 h que ficou em duas sessões da Bia');

-- ─── 2a. Sessão nascida com a Bia; cobertura desfeita antes da aula ──────────
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc401', '00000000-0000-4000-8000-0000000f0014',
  '00000000-0000-4000-8000-0000000fb401', pg_temp.fix_d(), '11:30');
create temp table fix_quatro as
select pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb401', pg_temp.fix_d()) as sid;
select pg_temp.fix_assert(
  (select teacher_id from public.lesson_sessions where id = (select sid from fix_quatro)) = '00000000-0000-4000-8000-0000000f0003',
  'fixture: a sessão do Quatro não nasceu com a Bia');
select pg_temp.fix_freeze((select sid from fix_quatro), 'https://meet.google.com/quatro-bia-fix', 'bia.fix@example.invalid');
update public.class_coverages set status = 'cancelled' where id = '00000000-0000-4000-8000-0000000fc401';
select pg_temp.fix_assert(
  (select teacher_id from public.lesson_sessions where id = (select sid from fix_quatro)) = '00000000-0000-4000-8000-0000000f0002'
  and (select h.cause = 'COVERAGE_ENDED' and h.to_teacher_id = '00000000-0000-4000-8000-0000000f0002'
         and h.from_teacher_id = '00000000-0000-4000-8000-0000000f0003' and h.room_withheld
       from private.lesson_session_teacher_handovers as h
       where h.session_id = (select sid from fix_quatro) order by h.created_at desc limit 1)
  and not private.lesson_session_documentation_blocked((select sid from fix_quatro))
  and (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = (select sid from fix_quatro)),
  'cobertura desfeita não devolveu à titular a sessão que nasceu com a substituta: '
    || coalesce(private.lesson_session_documentation_blocked_reason((select sid from fix_quatro)), '(sem motivo)')
    || ' / ' || coalesce(private.lesson_session_follow_giver((select sid from fix_quatro)), '?'));
select pg_temp.fix_cohost((select sid from fix_quatro), 'ana.fix@example.invalid');
select pg_temp.fix_assert(
  not (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = (select sid from fix_quatro))
  and public.official_lesson_link('aula-1h-fix', 'booking', '00000000-0000-4000-8000-0000000fb401', pg_temp.fix_d(),
    '00000000-0000-4000-8000-0000000f0002', time '11:30', '00000000-0000-4000-8000-0000000f0014')
    = 'https://meet.google.com/quatro-bia-fix'
  and pg_temp.fix_rooms('00000000-0000-4000-8000-0000000f0014') = array['https://meet.google.com/quatro-bia-fix']
  and 'https://meet.google.com/quatro-bia-fix' = any(pg_temp.fix_rooms('00000000-0000-4000-8000-0000000f0002'))
  and not ('https://meet.google.com/quatro-bia-fix' = any(pg_temp.fix_rooms('00000000-0000-4000-8000-0000000f0003'))),
  'depois de desfeita a cobertura, a sala não voltou para a titular e o aluno');

-- ─── 2b/2c. Aulas passadas nascidas com a Bia; cobertura desfeita depois ─────
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc501', '00000000-0000-4000-8000-0000000f0015',
  '00000000-0000-4000-8000-0000000fb501', pg_temp.fix_y(), '08:00');
select pg_temp.fix_cover('00000000-0000-4000-8000-0000000fc601', '00000000-0000-4000-8000-0000000f0016',
  '00000000-0000-4000-8000-0000000fb601', pg_temp.fix_y(), '09:00');
select private.sync_lesson_quality_sessions('aula-1h-fix', t.y, t.y, null) from fix_day as t;
create temp table fix_passadas as
select pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb501', pg_temp.fix_y()) as cinco,
       pg_temp.fix_sid('00000000-0000-4000-8000-0000000fb601', pg_temp.fix_y()) as seis;
update public.lesson_sessions set documentation_consent = true
where id in (select cinco from fix_passadas union all select seis from fix_passadas);
select pg_temp.fix_assert(
  (select bool_and(teacher_id = '00000000-0000-4000-8000-0000000f0003') from public.lesson_sessions
   where id in (select cinco from fix_passadas union all select seis from fix_passadas)),
  'fixture: as aulas passadas não nasceram com a Bia');
-- Seis: a Bia deu e lançou a aula.
insert into public.class_logs (id, tenant_id, teacher_id, student_id, booking_id, presence, date, class_date, start_time, created_at)
values ('00000000-0000-4000-8000-0000000fd601', 'aula-1h-fix', '00000000-0000-4000-8000-0000000f0003',
  '00000000-0000-4000-8000-0000000f0016', '00000000-0000-4000-8000-0000000fb601', 'COMPLETED',
  pg_temp.fix_y(), pg_temp.fix_y(), '09:00', now());
update public.class_coverages set status = 'cancelled'
where id in ('00000000-0000-4000-8000-0000000fc501', '00000000-0000-4000-8000-0000000fc601');
-- Cinco: quem deu a aula foi a Ana, que a lança depois de desfeita a cobertura.
insert into public.class_logs (id, tenant_id, teacher_id, student_id, booking_id, presence, date, class_date, start_time, created_at)
values ('00000000-0000-4000-8000-0000000fd501', 'aula-1h-fix', '00000000-0000-4000-8000-0000000f0002',
  '00000000-0000-4000-8000-0000000f0015', '00000000-0000-4000-8000-0000000fb501', 'COMPLETED',
  pg_temp.fix_y(), pg_temp.fix_y(), '08:00', now());
select pg_temp.fix_assert(
  (select s.teacher_id = '00000000-0000-4000-8000-0000000f0002' and s.status = 'LOGGED'
   from public.lesson_sessions as s where s.id = (select cinco from fix_passadas))
  and (select o.class_log_id = '00000000-0000-4000-8000-0000000fd501'
       from public.lesson_occurrences as o where o.session_id = (select cinco from fix_passadas) and o.status <> 'SUPERSEDED')
  and (select h.cause = 'COVERAGE_ENDED' and h.after_lesson
       from private.lesson_session_teacher_handovers as h
       where h.session_id = (select cinco from fix_passadas) order by h.created_at desc limit 1),
  'aula passada com a cobertura desfeita ficou com a ex-substituta (pendência de lançamento contra quem não a deu)');
select pg_temp.fix_assert(
  (select s.teacher_id = '00000000-0000-4000-8000-0000000f0003' and s.status = 'LOGGED'
   from public.lesson_sessions as s where s.id = (select seis from fix_passadas))
  and not exists (select 1 from private.lesson_session_teacher_handovers where session_id = (select seis from fix_passadas))
  and not private.lesson_session_taught_by_other((select seis from fix_passadas)),
  'aula que a ex-substituta deu e lançou mudou de dono quando a cobertura foi desfeita');

-- ─── 3. Superfície ───────────────────────────────────────────────────────────
select pg_temp.fix_assert(
  (select pg_catalog.count(*) = 3
      and bool_and(procedure.prosecdef
        and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
        and procedure.proconfig @> array['search_path=""']::text[]
        and not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
        and not has_function_privilege('service_role', procedure.oid, 'EXECUTE'))
   from pg_catalog.pg_proc as procedure
   join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'private'
     and procedure.proname in ('coverage_lesson_parts', 'lesson_session_happened', 'lesson_session_merge_adjacent')),
  'funções novas da aula de 1 h não são SECURITY DEFINER do postgres, com search_path vazio e só internas');

rollback;
