-- A sala acompanha a troca de professor (migration 20260928110000).
--
-- 1. Cobertura confirmada numa aula com sessão congelada (aceite + sala):
--    * substituto com conta Google confirmada e aceite do termo vigente: a
--      sessão passa a ser dele (trilha da troca + revisão TEACHER_HANDOVER), a
--      sala fica retida (nem app nem lembrete) até a fila pôr a conta dele como
--      coanfitriã (room_claim → room_cohost_save), o lançamento dele se liga à
--      sessão e é ele quem vê a fonte para revisar o resumo;
--    * substituto sem conta confirmada: a sessão passa assim mesmo (o
--      lançamento dele fecha a aula), mas sem aceite efetivo — a fila desliga a
--      transcrição (DISABLE_ARTIFACTS) e a aula segue pelo link de sempre; o
--      aceite dele depois religa a régua; cobertura desfeita devolve ao titular;
--    * troca ainda não feita (a rodada não passou): a régua já barra
--      (TAUGHT_BY_OTHER) e a fila desliga a sala; a rodada de 15 min faz a troca.
-- 2. Sessão congelada remarcada, encerrada pela direção ou cancelada na agenda:
--    SUPERSEDED, sem aceite, sala desligada pela fila, sem link; o novo horário
--    ganha sessão própria. Aula com documentação importada não é arquivada.
-- 3. Presença: o relatório reconhece como professor a conta de quem dá a aula;
--    a de quem passou a aula adiante é "outro professor" — também na troca que
--    chega depois da aula (cobertura atestada), com a sala ainda com o titular.
-- 4. Régua segura para o passado: agendamento transferido depois da aula não
--    muda o dono da aula que já foi dada.
--
-- Reprova contra o código anterior: a sessão congelada não mudava de
-- professor, o lançamento do substituto não se ligava (pendência falsa), a
-- sala do titular seguia com a transcrição ligada, a aula remarcada ficava
-- viva com o link, e taught_by_other acusava a aula passada de agendamento
-- transferido. Não depende de dado real (fixtures próprias), da fila global
-- (conexões reais fora do ar só num savepoint) nem do horário do dia (a aula
-- futura é amanhã; a passada, ontem).
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.troca_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'sala da troca: %', p_message;
  end if;
end;
$$;
grant execute on function pg_temp.troca_assert(boolean, text) to public;

-- Decisão do aluno como a página grava (link + código do WhatsApp).
create or replace function pg_temp.troca_student_accepts(p_tenant text, p_student uuid, p_actor uuid)
returns void language plpgsql as $$
declare
  v_link uuid;
  v_challenge uuid := gen_random_uuid();
begin
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values (p_tenant, p_student, encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'), p_actor,
    now() + interval '1 day', now())
  returning id into v_link;
  insert into private.lesson_recording_consent_challenges (id, link_id, tenant_id, student_id, relation, destination,
    code_hash, delivery_status, expires_at, consumed_at)
  values (v_challenge, v_link, p_tenant, p_student, 'GUARDIAN', '5511900007777',
    encode(extensions.digest(v_challenge::text, 'sha256'), 'hex'), 'SENT', now() + interval '10 minutes', now());
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, link_id, verification, verified_phone,
    verification_challenge_id)
  values (p_tenant, p_student, 'STUDENT', 'ACCEPTED', 'Responsavel Troca', 'GUARDIAN', 'STUDENT',
    (private.lesson_recording_current_term('STUDENT')).version,
    'LINK', v_link, 'WHATSAPP_CODE', '(11) •••••-7777', v_challenge);
end;
$$;

-- Professor confirma a conta Google e autoriza a versão vigente (o cartão).
create or replace function pg_temp.troca_teacher_ready(p_tenant text, p_teacher uuid, p_email text)
returns void language plpgsql as $$
begin
  insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
  values (p_teacher, p_tenant, 'sub-' || replace(p_teacher::text, '-', ''), p_email, true)
  on conflict (teacher_id) do update set google_email = excluded.google_email;
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, recorded_by)
  values (p_tenant, p_teacher, 'TEACHER', 'ACCEPTED', 'Professor Troca', 'SELF', 'TEACHER',
    (private.lesson_recording_current_term('TEACHER')).version, 'APP', p_teacher);
end;
$$;

-- Sala que o app (get_my_lesson_rooms) devolve a p_user para a sessão: o link,
-- '(sem link)' se a sessão volta sem sala pronta, ou null se nem volta.
create or replace function pg_temp.troca_room_of(p_user uuid, p_date date, p_session uuid)
returns text language plpgsql as $$
declare
  v_room jsonb;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select x into v_room
  from jsonb_array_elements(public.get_my_lesson_rooms(p_date, p_date)) as x
  where x ->> 'session_id' = p_session::text;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if v_room is null then
    return null;
  end if;
  return coalesce(v_room ->> 'meeting_uri', '(sem link)');
end;
$$;

-- Operações da fila do Meet para uma sessão, com as conexões reais fora do ar
-- (a fila é global) e a conexão da escola de teste no ar. Quem chama abre e
-- fecha o savepoint.
create or replace function pg_temp.troca_jobs(p_session uuid)
returns text[] language sql as $$
  select coalesce(array_agg(j ->> 'operation' order by j ->> 'operation'), '{}')
  from jsonb_array_elements(public.get_pending_google_meet_sync_sessions()) as j
  where j ->> 'lesson_session_id' = p_session::text;
$$;

set local request.jwt.claims = '{"role":"service_role"}';
-- A trilha de reposição avisaria o grupo e a família: aqui, em silêncio.
select set_config('app.reschedule_silent', 'on', true);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

-- Banco só com a estrutura (ou lições de antes da v1): uma versão antiga dos
-- termos garante que "ontem" tinha termo vigente. A v3 aceita a cobre.
insert into private.lesson_recording_terms (audience, version, body, published_at) values
  ('STUDENT', 'v0', repeat('Termo antigo de teste do aluno. ', 12), now() - interval '60 days'),
  ('TEACHER', 'v0', repeat('Termo antigo de teste do professor. ', 12), now() - interval '60 days')
on conflict (audience, version) do nothing;

create temp table troca_clock as
select (now() at time zone 'America/Sao_Paulo')::date + 1 as d,
       (now() at time zone 'America/Sao_Paulo')::date - 1 as y;
create temp table troca_day as
select c.d, c.y,
  (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.d)::int + 1] as d_name,
  (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.y)::int + 1] as y_name
from troca_clock as c;

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values ('sala-troca-test', 'Sala Troca Test', 'sala-troca-test', 'active', true);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select v.id, 'authenticated', 'authenticated', v.email, '{"provider":"email","providers":["email"]}',
  jsonb_build_object('full_name', v.name), now(), now()
from (values
  ('00000000-0000-4000-8000-0000000e7001'::uuid, 'troca-admin@example.invalid', 'Diretora Troca'),
  ('00000000-0000-4000-8000-0000000e7002'::uuid, 'troca-titular@example.invalid', 'Titular Troca'),
  ('00000000-0000-4000-8000-0000000e7003'::uuid, 'troca-subst@example.invalid', 'Substituta Troca'),
  ('00000000-0000-4000-8000-0000000e7004'::uuid, 'troca-novo@example.invalid', 'Novo Troca'),
  ('00000000-0000-4000-8000-0000000e7005'::uuid, 'troca-aluno1@example.invalid', 'Aluno Um'),
  ('00000000-0000-4000-8000-0000000e7006'::uuid, 'troca-aluno2@example.invalid', 'Aluno Dois'),
  ('00000000-0000-4000-8000-0000000e7007'::uuid, 'troca-aluno3@example.invalid', 'Aluno Tres'),
  ('00000000-0000-4000-8000-0000000e7008'::uuid, 'troca-aluno4@example.invalid', 'Aluno Quatro')
) as v(id, email, name);

update public.profiles as p
set tenant_id = 'sala-troca-test', role = v.role, lifecycle_status = 'active', full_name = v.name,
    phone = v.phone, attendance_phone = v.phone, is_test_account = false
from (values
  ('00000000-0000-4000-8000-0000000e7001'::uuid, 'SCHOOL_ADMIN', 'Diretora Troca', '5511999997001'),
  ('00000000-0000-4000-8000-0000000e7002'::uuid, 'TEACHER', 'Titular Troca', '5511999997002'),
  ('00000000-0000-4000-8000-0000000e7003'::uuid, 'TEACHER', 'Substituta Troca', '5511999997003'),
  ('00000000-0000-4000-8000-0000000e7004'::uuid, 'TEACHER', 'Novo Troca', '5511999997004'),
  ('00000000-0000-4000-8000-0000000e7005'::uuid, 'STUDENT', 'Aluno Um', '5511988887005'),
  ('00000000-0000-4000-8000-0000000e7006'::uuid, 'STUDENT', 'Aluno Dois', '5511988887006'),
  ('00000000-0000-4000-8000-0000000e7007'::uuid, 'STUDENT', 'Aluno Tres', '5511988887007'),
  ('00000000-0000-4000-8000-0000000e7008'::uuid, 'STUDENT', 'Aluno Quatro', '5511988887008')
) as v(id, role, name, phone)
where p.id = v.id;

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
select p.id, 'sala-troca-test', p.role, 'ACTIVE', true
from public.profiles as p
where p.id in (
  '00000000-0000-4000-8000-0000000e7001', '00000000-0000-4000-8000-0000000e7002',
  '00000000-0000-4000-8000-0000000e7003', '00000000-0000-4000-8000-0000000e7004',
  '00000000-0000-4000-8000-0000000e7005', '00000000-0000-4000-8000-0000000e7006',
  '00000000-0000-4000-8000-0000000e7007', '00000000-0000-4000-8000-0000000e7008')
on conflict (user_id, tenant_id) do update
set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values ('00000000-0000-4000-8000-0000000e7001', 'sala-troca-test');

-- Agenda de amanhã (D) com a titular; B5 é o agendamento de ontem que hoje é
-- da substituta (transferido depois da aula); B6, a aula de ontem que a
-- substituta deu e a direção atesta depois.
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select v.id, 'sala-troca-test', v.teacher_id, v.student_id,
       case when v.yesterday then t.y_name else t.d_name end, v.slot, null, date '2026-01-05', 'SCHEDULED'
from troca_day as t
cross join lateral (values
  ('00000000-0000-4000-8000-0000000e7b01'::uuid, '00000000-0000-4000-8000-0000000e7002'::uuid, '00000000-0000-4000-8000-0000000e7005'::uuid, '10:00', false),
  ('00000000-0000-4000-8000-0000000e7b02'::uuid, '00000000-0000-4000-8000-0000000e7002'::uuid, '00000000-0000-4000-8000-0000000e7006'::uuid, '11:00', false),
  ('00000000-0000-4000-8000-0000000e7b03'::uuid, '00000000-0000-4000-8000-0000000e7002'::uuid, '00000000-0000-4000-8000-0000000e7007'::uuid, '12:00', false),
  ('00000000-0000-4000-8000-0000000e7b04'::uuid, '00000000-0000-4000-8000-0000000e7002'::uuid, '00000000-0000-4000-8000-0000000e7005'::uuid, '13:00', false),
  ('00000000-0000-4000-8000-0000000e7b06'::uuid, '00000000-0000-4000-8000-0000000e7002'::uuid, '00000000-0000-4000-8000-0000000e7006'::uuid, '08:00', true)
) as v(id, teacher_id, student_id, slot, yesterday);

-- Reposições de amanhã com a titular (Aluno Quatro): R1 é remarcada, R2
-- encerrada pela direção, R3 já tem documento do Meet (a aula aconteceu na
-- sala) e é remarcada.
insert into public.reschedules (id, tenant_id, teacher_id, student_id, date, time, fault_type)
select v.id, 'sala-troca-test', '00000000-0000-4000-8000-0000000e7002', '00000000-0000-4000-8000-0000000e7008',
       pg_catalog.to_char(t.d, 'YYYY-MM-DD'), v.slot, 'STUDENT'
from troca_day as t
cross join lateral (values
  ('00000000-0000-4000-8000-0000000e7c01'::uuid, '15:00'),
  ('00000000-0000-4000-8000-0000000e7c02'::uuid, '16:00'),
  ('00000000-0000-4000-8000-0000000e7c03'::uuid, '17:00')
) as v(id, slot);

-- Aceites: titular e substituta prontas (conta confirmada + termo vigente); o
-- "Novo" ainda não confirmou nada. Alunos autorizaram pelo link com código.
select pg_temp.troca_teacher_ready('sala-troca-test', '00000000-0000-4000-8000-0000000e7002', 'troca-titular@example.invalid');
select pg_temp.troca_teacher_ready('sala-troca-test', '00000000-0000-4000-8000-0000000e7003', 'troca-subst@example.invalid');
select pg_temp.troca_student_accepts('sala-troca-test', s.id, '00000000-0000-4000-8000-0000000e7001')
from (values ('00000000-0000-4000-8000-0000000e7005'::uuid), ('00000000-0000-4000-8000-0000000e7006'::uuid),
  ('00000000-0000-4000-8000-0000000e7007'::uuid), ('00000000-0000-4000-8000-0000000e7008'::uuid)) as s(id);

-- Sessões como a rodada monta.
select private.sync_lesson_quality_sessions('sala-troca-test', t.d, t.d, null) from troca_day as t;
select private.sync_lesson_quality_sessions('sala-troca-test', t.y, t.y, null) from troca_day as t;

create temp table troca_sessions as
select v.label, o.session_id
from troca_day as t
cross join lateral (values
  ('S1', 'booking', '00000000-0000-4000-8000-0000000e7b01', t.d, time '10:00'),
  ('S2', 'booking', '00000000-0000-4000-8000-0000000e7b02', t.d, time '11:00'),
  ('S3', 'booking', '00000000-0000-4000-8000-0000000e7b03', t.d, time '12:00'),
  ('S4', 'reschedule', '00000000-0000-4000-8000-0000000e7c01', t.d, time '15:00'),
  ('S5', 'reschedule', '00000000-0000-4000-8000-0000000e7c02', t.d, time '16:00'),
  ('S6', 'reschedule', '00000000-0000-4000-8000-0000000e7c03', t.d, time '17:00'),
  ('S7', 'booking', '00000000-0000-4000-8000-0000000e7b04', t.d, time '13:00'),
  ('S9', 'booking', '00000000-0000-4000-8000-0000000e7b06', t.y, time '08:00')
) as v(label, source_type, source_id, class_date, start_time)
join public.lesson_occurrences as o
  on o.tenant_id = 'sala-troca-test' and o.source_type = v.source_type and o.source_id = v.source_id
 and o.class_date = v.class_date and o.start_time = v.start_time and o.status <> 'SUPERSEDED';

select pg_temp.troca_assert((select count(*) = 8 from troca_sessions), 'fixture: a rodada não montou as 8 sessões');
select pg_temp.troca_assert(
  (select bool_and(s.teacher_id = '00000000-0000-4000-8000-0000000e7002') from troca_sessions as ts
   join public.lesson_sessions as s on s.id = ts.session_id),
  'fixture: sessões não nasceram com a titular');

-- Congela como o termo marca (evento do termo + aceite) e cria a sala pronta
-- com a titular de coanfitriã.
insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason, created_at)
select ts.session_id, '00000000-0000-4000-8000-0000000e7001', true,
  'Termo de registro das aulas: aluno (ou responsável) e professor aceitaram o registro permanente.',
  clock_timestamp()
from troca_sessions as ts;
update public.lesson_sessions set documentation_consent = true
where id in (select session_id from troca_sessions);
insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
  cohost_email, state, created_by)
select ts.session_id, 'sala-troca-test', 'spaces/troca' || ts.label,
  -- Código só com letras (S1 → sax-abcd-efg): é o formato que o lembrete aceita.
  'https://meet.google.com/' || translate(lower(ts.label), '123456789', 'abcdefghi') || 'x-abcd-efg', 'troca-sub-central',
  'troca-titular@example.invalid', 'READY', '00000000-0000-4000-8000-0000000e7001'
from troca_sessions as ts;

-- Sessão de ontem, LOGGED com a titular, do agendamento B5 que hoje é da
-- substituta (transferido depois da aula).
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select '00000000-0000-4000-8000-0000000e7b05', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7003',
  '00000000-0000-4000-8000-0000000e7007', t.y_name, '09:00', null, date '2026-01-05', 'SCHEDULED'
from troca_day as t;
insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date, scheduled_start_at,
  scheduled_end_at, source_key, status, documentation_consent)
select '00000000-0000-4000-8000-0000000e7a08', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7007',
  '00000000-0000-4000-8000-0000000e7002', t.y, (t.y + time '09:00') at time zone 'America/Sao_Paulo',
  (t.y + time '09:30') at time zone 'America/Sao_Paulo', 'troca-s8', 'LOGGED', false
from troca_day as t;
insert into public.lesson_occurrences (tenant_id, session_id, source_type, source_id, class_date, start_time,
  scheduled_start_at, scheduled_end_at, entitlement_date, status)
select 'sala-troca-test', '00000000-0000-4000-8000-0000000e7a08', 'booking', '00000000-0000-4000-8000-0000000e7b05',
  t.y, time '09:00', (t.y + time '09:00') at time zone 'America/Sao_Paulo',
  (t.y + time '09:30') at time zone 'America/Sao_Paulo', t.y, 'LOGGED'
from troca_day as t;

-- Toda asserção abaixo é escalar: linha que falta vira NULL e reprova (um
-- "select … from … where" sem linha passaria calado).
create or replace function pg_temp.troca_sid(p_label text)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  select session_id into v_id from troca_sessions where label = p_label;
  if v_id is null then
    raise exception 'sala da troca: fixture sem a sessão %', p_label;
  end if;
  return v_id;
end;
$$;
create or replace function pg_temp.troca_d() returns date language sql as $$ select d from troca_clock $$;
create or replace function pg_temp.troca_y() returns date language sql as $$ select y from troca_clock $$;
create or replace function pg_temp.troca_teacher(p_label text)
returns uuid language sql as $$
  select teacher_id from public.lesson_sessions where id = pg_temp.troca_sid(p_label)
$$;
-- plpgsql: contra o código anterior (sem a trilha) o teste reprova na primeira
-- asserção de comportamento, não na criação do ajudante.
create or replace function pg_temp.troca_last_handover(p_label text)
returns jsonb language plpgsql as $$
begin
  return (select to_jsonb(h) from private.lesson_session_teacher_handovers as h
          where h.session_id = pg_temp.troca_sid(p_label)
          order by h.created_at desc limit 1);
end;
$$;

-- Nada ainda está barrado nem é de outro professor.
select pg_temp.troca_assert(
  (select bool_and(not private.lesson_session_documentation_blocked(ts.session_id)
    and not private.lesson_session_taught_by_other(ts.session_id)) from troca_sessions as ts),
  'fixture: sessão congelada já barrada antes da troca');
select pg_temp.troca_assert(
  pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7005', pg_temp.troca_d(), pg_temp.troca_sid('S1'))
    = 'https://meet.google.com/sax-abcd-efg',
  'fixture: sala da aula de amanhã não chegou ao aluno antes da cobertura');

-- ─── 1a. Cobertura com substituta pronta ─────────────────────────────────────
-- A validação da cobertura (grade, ausência, conflito) tem suíte própria; aqui
-- só ela fica de fora, e o gatilho da troca segue ligado.
alter table public.class_coverages disable trigger trg_enforce_active_class_coverage_slot;
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at)
values ('00000000-0000-4000-8000-0000000e7d01', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7002',
  '00000000-0000-4000-8000-0000000e7003', '00000000-0000-4000-8000-0000000e7005',
  '00000000-0000-4000-8000-0000000e7b01', pg_temp.troca_d(), '10:00', 'confirmed', now());

select pg_temp.troca_assert(pg_temp.troca_teacher('S1') = '00000000-0000-4000-8000-0000000e7003',
  'cobertura confirmada não passou a sessão congelada para a substituta');

select pg_temp.troca_assert(
  (select h ->> 'from_teacher_id' = '00000000-0000-4000-8000-0000000e7002'
     and h ->> 'to_teacher_id' = '00000000-0000-4000-8000-0000000e7003'
     and h ->> 'cause' = 'COVERAGE'
     and h ->> 'coverage_id' = '00000000-0000-4000-8000-0000000e7d01'
     and (h ->> 'documentation_ready')::boolean and not (h ->> 'after_lesson')::boolean
     and (h ->> 'room_withheld')::boolean
     and h ->> 'from_google_email' = 'troca-titular@example.invalid'
     and h ->> 'to_google_email' = 'troca-subst@example.invalid'
   from (select pg_temp.troca_last_handover('S1') as h) as last),
  'trilha da troca incompleta: ' || coalesce(pg_temp.troca_last_handover('S1')::text, 'sem trilha'));

select pg_temp.troca_assert(
  exists (select 1 from private.lesson_session_revisions as r
    where r.session_id = pg_temp.troca_sid('S1') and r.action = 'TEACHER_HANDOVER'
      and r.previous_snapshot ->> 'teacher_id' = '00000000-0000-4000-8000-0000000e7002'
      and r.next_snapshot ->> 'teacher_id' = '00000000-0000-4000-8000-0000000e7003'),
  'troca sem revisão TEACHER_HANDOVER');

-- A documentação segue (aceite dela), mas a sala fica retida até a conta dela
-- ser a coanfitriã: nem o aluno, nem a substituta, nem o lembrete.
select pg_temp.troca_assert(
  not private.lesson_session_documentation_blocked(pg_temp.troca_sid('S1'))
  and (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = pg_temp.troca_sid('S1'))
  and pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7005', pg_temp.troca_d(), pg_temp.troca_sid('S1')) is null
  and pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7003', pg_temp.troca_d(), pg_temp.troca_sid('S1')) is null
  and public.official_lesson_link('sala-troca-test', 'booking', '00000000-0000-4000-8000-0000000e7b01',
    pg_temp.troca_d(), '00000000-0000-4000-8000-0000000e7002', time '10:00', '00000000-0000-4000-8000-0000000e7005') is null,
  'sala da aula coberta entregue antes de a substituta ser a coanfitriã');

savepoint troca_fila_1;
update private.google_workspace_connections set status = 'REAUTH_REQUIRED' where status = 'CONNECTED';
insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('sala-troca-test', 'troca-sub-central', 'escola-troca@example.invalid', 'CONNECTED',
  '00000000-0000-4000-8000-0000000e7001');
select pg_temp.troca_assert(
  pg_temp.troca_jobs(pg_temp.troca_sid('S1')) = array['PREPARE_ROOM'],
  'fila não acertou o coanfitrião da aula coberta (ou mexeu na transcrição): '
    || pg_temp.troca_jobs(pg_temp.troca_sid('S1'))::text);
rollback to savepoint troca_fila_1;
release savepoint troca_fila_1;

-- O que a edge faz (room_claim → SYNC_COHOST → ensureCohost → room_cohost_save).
create temp table troca_claim as
select public.google_meet_backend('room_claim', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7001',
  pg_temp.troca_sid('S1'), '{"organizer_sub":"troca-sub-central","automatic":true}'::jsonb) as r;
select pg_temp.troca_assert(
  (select (r ->> 'claimed')::boolean = false
     and r -> 'room' ->> 'cohost_email' = 'troca-subst@example.invalid'
     and (r -> 'room' ->> 'cohost_sync_pending')::boolean
     and (r -> 'room' ->> 'teacher_handover_pending')::boolean
   from troca_claim),
  'room_claim não pôs a conta da substituta como coanfitriã pendente: ' || (select r::text from troca_claim));
create temp table troca_synced as
select public.google_meet_backend('room_cohost_save', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7001',
  pg_temp.troca_sid('S1'), '{"result":"SYNCED","cohost_email":"troca-subst@example.invalid"}'::jsonb) as r;
select pg_temp.troca_assert(
  (select not (r ->> 'cohost_sync_pending')::boolean and not (r ->> 'teacher_handover_pending')::boolean
   from troca_synced),
  'acerto do coanfitrião não soltou a sala: ' || (select r::text from troca_synced));

select pg_temp.troca_assert(
  pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7005', pg_temp.troca_d(), pg_temp.troca_sid('S1'))
    = 'https://meet.google.com/sax-abcd-efg'
  and pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7003', pg_temp.troca_d(), pg_temp.troca_sid('S1'))
    = 'https://meet.google.com/sax-abcd-efg'
  and pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7002', pg_temp.troca_d(), pg_temp.troca_sid('S1')) is null
  and public.official_lesson_link('sala-troca-test', 'booking', '00000000-0000-4000-8000-0000000e7b01',
    pg_temp.troca_d(), '00000000-0000-4000-8000-0000000e7002', time '10:00', '00000000-0000-4000-8000-0000000e7005')
      = 'https://meet.google.com/sax-abcd-efg',
  'depois do acerto, a sala não chegou ao aluno e à substituta (ou ficou com a titular)');

-- Presença: a substituta é a professora; a titular, "outro professor".
create temp table troca_state as
select public.google_meet_backend('session_state', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7001',
  pg_temp.troca_sid('S1'), '{}'::jsonb) as r;
select pg_temp.troca_assert(
  (select r -> 'attendance_identity'
      = '{"teacher_emails":["troca-subst@example.invalid"],"other_teacher_emails":["troca-titular@example.invalid"]}'::jsonb
     and r ->> 'teacher_google_email' = 'troca-subst@example.invalid'
   from troca_state),
  'presença não reconhece a substituta como professora: '
    || coalesce((select (r -> 'attendance_identity')::text from troca_state), 'sem attendance_identity'));

-- É ela quem revisa o resumo: vê a fonte; a titular fica com o aprovado.
create temp table troca_detail as
select public.google_meet_backend('session_detail', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7003',
    pg_temp.troca_sid('S1'), '{}'::jsonb) as sub,
  public.google_meet_backend('session_detail', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7002',
    pg_temp.troca_sid('S1'), '{}'::jsonb) as titular;
select pg_temp.troca_assert(
  (select (sub ->> 'raw_access')::boolean
     and not (titular ->> 'raw_access')::boolean
     and sub -> 'teacher_handover' ->> 'to_teacher_name' = 'Substituta Troca'
     and sub -> 'teacher_handover' ->> 'from_teacher_name' = 'Titular Troca'
     and sub -> 'teacher_handover' ->> 'cause' = 'COVERAGE'
   from troca_detail),
  'a substituta não revisa o resumo da aula que deu (ou a titular ainda vê a fonte)');

-- O lançamento da substituta se liga à sessão: nada de pendência falsa.
alter table public.class_logs disable trigger trg_zy_require_finished_lesson_slot;
insert into public.class_logs (id, tenant_id, teacher_id, student_id, booking_id, presence, date, class_date, start_time, created_at)
values ('00000000-0000-4000-8000-0000000e7f01', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7003',
  '00000000-0000-4000-8000-0000000e7005', '00000000-0000-4000-8000-0000000e7b01', 'COMPLETED',
  pg_temp.troca_d(), pg_temp.troca_d(), '10:00', now());
alter table public.class_logs enable trigger trg_zy_require_finished_lesson_slot;
select pg_temp.troca_assert(
  (select status from public.lesson_sessions where id = pg_temp.troca_sid('S1')) = 'LOGGED'
  and (select o.class_log_id from public.lesson_occurrences as o
       where o.session_id = pg_temp.troca_sid('S1') and o.status <> 'SUPERSEDED')
    = '00000000-0000-4000-8000-0000000e7f01'
  and (select cl.lesson_session_id from public.class_logs as cl where cl.id = '00000000-0000-4000-8000-0000000e7f01')
    = pg_temp.troca_sid('S1'),
  'lançamento da substituta não se ligou à sessão da aula coberta');

-- ─── 1b. Cobertura com substituto sem conta confirmada ──────────────────────
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at)
values ('00000000-0000-4000-8000-0000000e7d02', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7002',
  '00000000-0000-4000-8000-0000000e7004', '00000000-0000-4000-8000-0000000e7006',
  '00000000-0000-4000-8000-0000000e7b02', pg_temp.troca_d(), '11:00', 'confirmed', now());

select pg_temp.troca_assert(
  pg_temp.troca_teacher('S2') = '00000000-0000-4000-8000-0000000e7004'
  and not (pg_temp.troca_last_handover('S2') ->> 'documentation_ready')::boolean
  and private.lesson_session_documentation_blocked(pg_temp.troca_sid('S2'))
  and private.lesson_session_documentation_blocked_reason(pg_temp.troca_sid('S2')) = 'HANDOVER_UNCONSENTED'
  and (public.google_meet_backend('session_state', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7001',
    pg_temp.troca_sid('S2'), '{}'::jsonb) -> 'session' ->> 'documentation_blocked_reason') = 'HANDOVER_UNCONSENTED',
  'aula passada a quem não aceitou o termo seguiu documentada');

select pg_temp.troca_assert(
  pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7006', pg_temp.troca_d(), pg_temp.troca_sid('S2')) is null
  and pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7004', pg_temp.troca_d(), pg_temp.troca_sid('S2')) is null
  and public.official_lesson_link('sala-troca-test', 'booking', '00000000-0000-4000-8000-0000000e7b02',
    pg_temp.troca_d(), '00000000-0000-4000-8000-0000000e7002', time '11:00', null) is null,
  'sala entregue numa aula dada por quem não aceitou o termo');

savepoint troca_fila_2;
update private.google_workspace_connections set status = 'REAUTH_REQUIRED' where status = 'CONNECTED';
insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('sala-troca-test', 'troca-sub-central', 'escola-troca@example.invalid', 'CONNECTED',
  '00000000-0000-4000-8000-0000000e7001');
select pg_temp.troca_assert(
  pg_temp.troca_jobs(pg_temp.troca_sid('S2')) = array['DISABLE_ARTIFACTS'],
  'fila não desligou a transcrição da aula do substituto sem aceite: '
    || pg_temp.troca_jobs(pg_temp.troca_sid('S2'))::text);
-- Ele confirma a conta e autoriza o termo: a régua volta a valer e a fila acerta
-- o coanfitrião.
select pg_temp.troca_teacher_ready('sala-troca-test', '00000000-0000-4000-8000-0000000e7004', 'troca-novo@example.invalid');
select pg_temp.troca_assert(
  not private.lesson_session_documentation_blocked(pg_temp.troca_sid('S2'))
  and pg_temp.troca_jobs(pg_temp.troca_sid('S2')) = array['PREPARE_ROOM'],
  'aceite do substituto não religou a documentação da aula: ' || pg_temp.troca_jobs(pg_temp.troca_sid('S2'))::text);
rollback to savepoint troca_fila_2;
release savepoint troca_fila_2;

-- Cobertura desfeita: a aula volta à titular, com trilha.
update public.class_coverages set status = 'cancelled' where id = '00000000-0000-4000-8000-0000000e7d02';
select pg_temp.troca_assert(
  pg_temp.troca_teacher('S2') = '00000000-0000-4000-8000-0000000e7002'
  and not private.lesson_session_documentation_blocked(pg_temp.troca_sid('S2'))
  and pg_temp.troca_last_handover('S2') ->> 'cause' = 'COVERAGE_ENDED'
  and pg_temp.troca_last_handover('S2') ->> 'to_teacher_id' = '00000000-0000-4000-8000-0000000e7002',
  'cobertura desfeita não devolveu a aula à titular');

-- ─── 1c. Troca ainda não feita: a régua já barra; a rodada troca ────────────
-- Sem o gatilho da troca: como uma cobertura gravada por um caminho que não
-- dispara a sincronização até a rodada de 15 min.
alter table public.class_coverages disable trigger trg_zz_class_coverage_follow_lesson_session;
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at)
values ('00000000-0000-4000-8000-0000000e7d03', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7002',
  '00000000-0000-4000-8000-0000000e7003', '00000000-0000-4000-8000-0000000e7007',
  '00000000-0000-4000-8000-0000000e7b03', pg_temp.troca_d(), '12:00', 'confirmed', now());
alter table public.class_coverages enable trigger trg_zz_class_coverage_follow_lesson_session;

select pg_temp.troca_assert(
  pg_temp.troca_teacher('S3') = '00000000-0000-4000-8000-0000000e7002'
  and private.lesson_session_documentation_blocked(pg_temp.troca_sid('S3'))
  and private.lesson_session_documentation_blocked_reason(pg_temp.troca_sid('S3')) = 'TAUGHT_BY_OTHER',
  'aula de outro professor seguiu com a documentação da titular');

savepoint troca_fila_3;
update private.google_workspace_connections set status = 'REAUTH_REQUIRED' where status = 'CONNECTED';
insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('sala-troca-test', 'troca-sub-central', 'escola-troca@example.invalid', 'CONNECTED',
  '00000000-0000-4000-8000-0000000e7001');
select pg_temp.troca_assert(
  pg_temp.troca_jobs(pg_temp.troca_sid('S3')) = array['DISABLE_ARTIFACTS'],
  'fila não desligou a sala do ausente: ' || pg_temp.troca_jobs(pg_temp.troca_sid('S3'))::text);
rollback to savepoint troca_fila_3;
release savepoint troca_fila_3;

-- A rodada de 15 min (refresh_lesson_quality_queue → sync) faz a troca.
select private.sync_lesson_quality_sessions('sala-troca-test', pg_temp.troca_d(), pg_temp.troca_d(),
  '00000000-0000-4000-8000-0000000e7007');
select pg_temp.troca_assert(
  pg_temp.troca_teacher('S3') = '00000000-0000-4000-8000-0000000e7003'
  and not private.lesson_session_documentation_blocked(pg_temp.troca_sid('S3')),
  'a rodada não passou a aula coberta para a substituta');

-- ─── 2. Aula congelada que sai da agenda ─────────────────────────────────────
-- Remarcada para depois de amanhã.
update public.reschedules set date = pg_catalog.to_char(pg_temp.troca_d() + 1, 'YYYY-MM-DD')
where id = '00000000-0000-4000-8000-0000000e7c01';

select pg_temp.troca_assert(
  (select s.status = 'SUPERSEDED' and not s.documentation_consent and s.source_key like '%:archived:%'
   from public.lesson_sessions as s where s.id = pg_temp.troca_sid('S4'))
  and not exists (select 1 from public.lesson_occurrences as o
    where o.session_id = pg_temp.troca_sid('S4') and o.status <> 'SUPERSEDED')
  and exists (select 1 from private.lesson_session_revisions as r
    where r.session_id = pg_temp.troca_sid('S4') and r.action = 'SUPERSEDE_LEFT_SCHEDULE')
  and (select e.reason from private.lesson_documentation_consent_events as e
       where e.session_id = pg_temp.troca_sid('S4') order by e.created_at desc limit 1)
    like 'Sessão arquivada: a aula saiu da agenda%',
  'reposição remarcada deixou a sessão congelada viva');

select pg_temp.troca_assert(
  exists (select 1 from public.lesson_occurrences as o join public.lesson_sessions as s on s.id = o.session_id
    where o.source_type = 'reschedule' and o.source_id = '00000000-0000-4000-8000-0000000e7c01'
      and o.class_date = pg_temp.troca_d() + 1 and o.start_time = time '15:00' and o.status <> 'SUPERSEDED'
      and s.status = 'SCHEDULED' and s.teacher_id = '00000000-0000-4000-8000-0000000e7002'),
  'o novo horário da reposição não ganhou sessão própria');

select pg_temp.troca_assert(
  pg_temp.troca_room_of('00000000-0000-4000-8000-0000000e7008', pg_temp.troca_d(), pg_temp.troca_sid('S4')) is null
  and public.official_lesson_link('sala-troca-test', 'reschedule', '00000000-0000-4000-8000-0000000e7c01',
    pg_temp.troca_d(), '00000000-0000-4000-8000-0000000e7002', time '15:00', null) is null,
  'aula remarcada continuou com o link da sala antiga');

-- Encerrada pela direção (close_reschedule) e cancelada na agenda (agendamento
-- desfeito; a rodada de 15 min acha).
select public.close_reschedule('00000000-0000-4000-8000-0000000e7c02', 'aluno desistiu da reposição');
update public.bookings set status = 'CANCELLED' where id = '00000000-0000-4000-8000-0000000e7b04';
select private.sync_lesson_quality_sessions('sala-troca-test', pg_temp.troca_d(), pg_temp.troca_d(),
  '00000000-0000-4000-8000-0000000e7005');
select pg_temp.troca_assert(
  (select s.status = 'SUPERSEDED' and not s.documentation_consent
   from public.lesson_sessions as s where s.id = pg_temp.troca_sid('S5'))
  and (select s.status = 'SUPERSEDED' and not s.documentation_consent
   from public.lesson_sessions as s where s.id = pg_temp.troca_sid('S7')),
  'reposição encerrada ou aula cancelada ficou como aula fantasma');

savepoint troca_fila_4;
update private.google_workspace_connections set status = 'REAUTH_REQUIRED' where status = 'CONNECTED';
insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('sala-troca-test', 'troca-sub-central', 'escola-troca@example.invalid', 'CONNECTED',
  '00000000-0000-4000-8000-0000000e7001');
select pg_temp.troca_assert(
  pg_temp.troca_jobs(pg_temp.troca_sid('S4')) = array['DISABLE_ARTIFACTS']
  and pg_temp.troca_jobs(pg_temp.troca_sid('S5')) = array['DISABLE_ARTIFACTS']
  and pg_temp.troca_jobs(pg_temp.troca_sid('S7')) = array['DISABLE_ARTIFACTS'],
  'fila não desligou a sala da aula que saiu da agenda');
rollback to savepoint troca_fila_4;
release savepoint troca_fila_4;

-- Aula que já tem documento do Meet (aconteceu na sala) não é arquivada.
insert into private.google_meet_artifact_imports (lesson_session_id, tenant_id, provider_name, kind, status)
values (pg_temp.troca_sid('S6'), 'sala-troca-test', 'conferenceRecords/troca1/transcripts/t1', 'TRANSCRIPT', 'PENDING');
update public.reschedules set date = pg_catalog.to_char(pg_temp.troca_d() + 1, 'YYYY-MM-DD')
where id = '00000000-0000-4000-8000-0000000e7c03';
select pg_temp.troca_assert(
  (select s.status = 'SCHEDULED' and s.documentation_consent
   from public.lesson_sessions as s where s.id = pg_temp.troca_sid('S6')),
  'aula com documento do Meet foi arquivada como fantasma');

-- ─── 3. Troca depois da aula (cobertura atestada) ────────────────────────────
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at, confirmed_by)
values ('00000000-0000-4000-8000-0000000e7d06', 'sala-troca-test', '00000000-0000-4000-8000-0000000e7002',
  '00000000-0000-4000-8000-0000000e7003', '00000000-0000-4000-8000-0000000e7006',
  '00000000-0000-4000-8000-0000000e7b06', pg_temp.troca_y(), '08:00', 'confirmed', now(),
  '00000000-0000-4000-8000-0000000e7001');
select pg_temp.troca_assert(
  pg_temp.troca_teacher('S9') = '00000000-0000-4000-8000-0000000e7003'
  and (pg_temp.troca_last_handover('S9') ->> 'after_lesson')::boolean
  and not (pg_temp.troca_last_handover('S9') ->> 'room_withheld')::boolean
  and not (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = pg_temp.troca_sid('S9'))
  -- A sala segue com a titular no Google; ela não é "a professora" no relatório.
  and (select cohost_email from private.google_meet_rooms where lesson_session_id = pg_temp.troca_sid('S9'))
    = 'troca-titular@example.invalid'
  and private.lesson_session_attendance_identity(pg_temp.troca_sid('S9'))
    = '{"teacher_emails":["troca-subst@example.invalid"],"other_teacher_emails":["troca-titular@example.invalid"]}'::jsonb,
  'troca depois da aula: presença ainda reconhece a titular');
-- A substituta autorizou o termo HOJE, depois da aula de ontem: a aula que ela deu
-- sem aceite não passa a ser documentada.
select pg_temp.troca_assert(
  not (pg_temp.troca_last_handover('S9') ->> 'documentation_ready')::boolean
  and private.lesson_session_documentation_blocked_reason(pg_temp.troca_sid('S9')) = 'HANDOVER_UNCONSENTED',
  'aceite dado depois da aula documentou a aula que a substituta deu sem aceite');
alter table public.class_coverages enable trigger trg_enforce_active_class_coverage_slot;

-- ─── 4. Agendamento transferido depois da aula não muda quem deu a aula ─────
select pg_temp.troca_assert(
  not private.lesson_session_taught_by_other('00000000-0000-4000-8000-0000000e7a08')
  and private.lesson_session_giver('00000000-0000-4000-8000-0000000e7a08') = '00000000-0000-4000-8000-0000000e7002',
  'aula já dada foi atribuída ao professor atual do agendamento');
select private.sync_lesson_quality_sessions('sala-troca-test', pg_temp.troca_y(), pg_temp.troca_y(),
  '00000000-0000-4000-8000-0000000e7007');
select pg_temp.troca_assert(
  (select teacher_id from public.lesson_sessions where id = '00000000-0000-4000-8000-0000000e7a08')
    = '00000000-0000-4000-8000-0000000e7002'
  and not exists (select 1 from private.lesson_session_teacher_handovers
    where session_id = '00000000-0000-4000-8000-0000000e7a08'),
  'a rodada passou a aula de ontem para o professor atual do agendamento');

-- ─── 5. Superfície ───────────────────────────────────────────────────────────
select pg_temp.troca_assert(
  (select pg_catalog.count(*) = 15
      and bool_and(procedure.prosecdef
        and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
        and procedure.proconfig @> array['search_path=""']::text[]
        and not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
        and not has_function_privilege('service_role', procedure.oid, 'EXECUTE'))
   from pg_catalog.pg_proc as procedure
   join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'private' and procedure.proname in (
     'lesson_session_giver', 'lesson_session_taught_by_other', 'lesson_teacher_documentation_ready',
     'lesson_session_handover_unconsented', 'lesson_session_documentation_blocked_reason',
     'lesson_session_attendance_identity', 'lesson_session_last_handover', 'lesson_session_follow_giver',
     'google_meet_room_release_handover', 'lesson_session_left_schedule', 'reconcile_frozen_lesson_sessions',
     'lesson_sessions_resync', 'class_coverage_follow_lesson_session', 'reschedule_follow_lesson_session',
     'lesson_advance_follow_lesson_session')),
  'funções da troca não são SECURITY DEFINER do postgres, com search_path vazio e só internas');
select pg_temp.troca_assert(
  not has_table_privilege('authenticated', 'private.lesson_session_teacher_handovers', 'SELECT')
  and not has_table_privilege('service_role', 'private.lesson_session_teacher_handovers', 'SELECT'),
  'trilha da troca exposta');

-- Remendos por âncora: quem recriar estas funções a partir de texto antigo
-- perde a troca (o teste reprova).
select pg_temp.troca_assert(
  strpos(pg_get_functiondef('private.lesson_session_documentation_blocked(uuid)'::regprocedure),
    'private.lesson_session_taught_by_other(session.id)') > 0
  and strpos(pg_get_functiondef('private.lesson_session_documentation_blocked(uuid)'::regprocedure),
    'private.lesson_session_handover_unconsented(session.id)') > 0
  and strpos(pg_get_functiondef('private.sync_lesson_quality_sessions(text,date,date,uuid)'::regprocedure),
    'private.reconcile_frozen_lesson_sessions(') > 0
  and strpos(pg_get_functiondef('private.lesson_quality_sources(text,date,date,uuid)'::regprocedure),
    'private.lesson_occurrence_giver(') > 0
  and strpos(pg_get_functiondef('private.lesson_quality_sources(text,date,date,uuid)'::regprocedure),
    'r.closed_reason is null') > 0
  and strpos(pg_get_functiondef('public.get_my_lesson_rooms(date,date)'::regprocedure),
    'teacher_handover_pending') > 0
  and strpos(pg_get_functiondef('public.official_lesson_link(text,text,text,date,uuid,time,uuid)'::regprocedure),
    'teacher_handover_pending') > 0
  and strpos(pg_get_functiondef('public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure),
    'private.lesson_session_attendance_identity(s.id)') > 0
  and strpos(pg_get_functiondef('public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure),
    'private.lesson_session_documentation_blocked_reason(s.id)') > 0
  and strpos(pg_get_functiondef('public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure),
    'private.lesson_session_last_handover(s.id)') > 0
  and strpos(pg_get_functiondef('private.apply_standing_lesson_recording_consent(text)'::regprocedure),
    'private.lesson_session_handover_unconsented(v_session.id)') > 0
  -- O que outras frentes remendaram antes continua lá.
  and strpos(pg_get_functiondef('private.apply_standing_lesson_recording_consent(text)'::regprocedure),
    'lesson_session_term_lapse_text') > 0
  and strpos(pg_get_functiondef('public.google_meet_backend(text,text,uuid,uuid,jsonb)'::regprocedure),
    'raw_copies_days') > 0,
  'um remendo da sala da troca sumiu de uma função recriada');

rollback;
