-- Onda 3 integrada: troca de professor (20260928100000) × sala da troca
-- (20260928110000) × extrato de pontualidade (20260928120000), pelos caminhos
-- reais (cobertura gravada → gatilho da troca → pacote → fila do Meet →
-- avaliação da planilha → varredura).
--
-- 1. Pacote × sala da troca: aula congelada com sala pronta passa à substituta
--    PRONTA — a sala fica retida, o pacote promete "o link da escola chega por
--    aqui" e, quando a conta dela vira a coanfitriã (room_claim → room_cohost_save),
--    o link chega a ela e à família. Substituto NÃO pronto: o pacote manda
--    combinar o link de sempre e a sala nunca sai para ele, nem quando a
--    retenção é solta.
-- 2. Avaliação de presença com a régua de quem DEU a aula: aula atestada para a
--    substituta e ainda não trocada não abre caso contra a titular; depois da
--    troca, a planilha guardada com a titular como "professora" e a substituta
--    como "aluna" não abre caso contra a substituta com os números da titular;
--    o atraso de verdade da substituta abre o caso DELA (a chave leva o
--    professor), com a entrada dela, o caso antigo da titular ganha a anotação da
--    troca, e a tela "Sala e resumo" mostra os mesmos papéis.
-- 3. Extrato de pontualidade: desligado, nada; ligado, a aula que trocou de
--    professor depois da medição sai na hora do extrato da titular e a varredura
--    a refaz para quem deu. O substituto só pela janela não lê sugestões do
--    cartão.
--
-- Reprova contra a integração sem os acertos (medido no clone com dados): o
-- aviso de sala pronta não saía quando a retenção era solta (só em mudança de
-- state/meeting_uri), a avaliação usava os teacher_*/student_* da importação
-- (LATE_START contra a titular, LATE_START e "professor ausente" contra a
-- substituta, o atraso dela preso na chave do caso da titular) e o extrato da
-- titular mostrava a aula até a varredura. Não depende de dado
-- real (fixtures próprias), da fila global nem do horário do dia (a aula futura é
-- amanhã; as passadas, dois dias atrás).
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.integ_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'onda 3 integrada: %', p_message;
  end if;
end;
$$;
grant execute on function pg_temp.integ_assert(boolean, text) to public;

-- Decisão do aluno como a página grava (link + código do WhatsApp).
create or replace function pg_temp.integ_student_accepts(p_student uuid)
returns void language plpgsql as $$
declare
  v_link uuid;
  v_challenge uuid := gen_random_uuid();
begin
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at, revoked_at)
  values ('onda3-integ', p_student, encode(extensions.digest(gen_random_uuid()::text, 'sha256'), 'hex'),
    '00000000-0000-4000-8000-00000003a001', now() + interval '1 day', now())
  returning id into v_link;
  insert into private.lesson_recording_consent_challenges (id, link_id, tenant_id, student_id, relation, destination,
    code_hash, delivery_status, expires_at, consumed_at)
  values (v_challenge, v_link, 'onda3-integ', p_student, 'GUARDIAN', '5511900003777',
    encode(extensions.digest(v_challenge::text, 'sha256'), 'hex'), 'SENT', now() + interval '10 minutes', now());
  insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
    signer_relation, term_audience, term_version, source, link_id, verification, verified_phone,
    verification_challenge_id)
  values ('onda3-integ', p_student, 'STUDENT', 'ACCEPTED', 'Responsavel Integ', 'GUARDIAN', 'STUDENT',
    (private.lesson_recording_current_term('STUDENT')).version,
    'LINK', v_link, 'WHATSAPP_CODE', '(11) •••••-3777', v_challenge);
end;
$$;

-- Conta Google confirmada; com p_accept, o "autorizo" da versão vigente dado
-- dez dias atrás (vale para as aulas de dois dias atrás e de amanhã).
create or replace function pg_temp.integ_teacher(p_teacher uuid, p_email text, p_accept boolean)
returns void language plpgsql as $$
begin
  insert into private.teacher_google_identities (teacher_id, tenant_id, google_sub, google_email, email_verified)
  values (p_teacher, 'onda3-integ', 'sub-' || replace(p_teacher::text, '-', ''), p_email, true)
  on conflict (teacher_id) do update set google_email = excluded.google_email;
  if p_accept then
    insert into private.lesson_recording_consents (tenant_id, subject_id, subject_role, decision, signer_name,
      signer_relation, term_audience, term_version, source, recorded_by, decided_at)
    values ('onda3-integ', p_teacher, 'TEACHER', 'ACCEPTED', 'Professor Integ', 'SELF', 'TEACHER',
      (private.lesson_recording_current_term('TEACHER')).version, 'APP', p_teacher, now() - interval '10 days');
  end if;
end;
$$;

-- Chamada como a pessoa logada (erro vira {"error": ...}).
create or replace function pg_temp.integ_as(p_user uuid, p_sql text)
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

set local request.jwt.claims = '{"role":"service_role"}';
select set_config('app.reschedule_silent', 'on', true);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

-- Banco só com a estrutura (ou lições de antes da v1): uma versão antiga dos
-- termos garante termo vigente dois dias atrás. A versão aceita a cobre.
insert into private.lesson_recording_terms (audience, version, body, published_at) values
  ('STUDENT', 'v0', repeat('Termo antigo de teste do aluno. ', 12), now() - interval '60 days'),
  ('TEACHER', 'v0', repeat('Termo antigo de teste do professor. ', 12), now() - interval '60 days')
on conflict (audience, version) do nothing;

create temp table integ_clock as
select (now() at time zone 'America/Sao_Paulo')::date + 1 as d,
       (now() at time zone 'America/Sao_Paulo')::date - 2 as y;
grant select on integ_clock to public;
create temp table integ_day as
select c.d, c.y,
  (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.d)::int + 1] as d_name,
  (array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'])[extract(dow from c.y)::int + 1] as y_name
from integ_clock as c;
create or replace function pg_temp.integ_d() returns date language sql as $$ select d from integ_clock $$;
create or replace function pg_temp.integ_y() returns date language sql as $$ select y from integ_clock $$;
grant execute on function pg_temp.integ_y() to public;
-- Horário da escola (BRT) no dia das aulas passadas.
create or replace function pg_temp.integ_at(p_time time)
returns timestamptz language sql as $$
  select (pg_temp.integ_y() + p_time) at time zone 'America/Sao_Paulo'
$$;
-- ISO como o attendance.ts grava na planilha.
create or replace function pg_temp.integ_iso(p_at timestamptz)
returns text language sql as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

insert into public.tenants (id, name, slug, saas_status, whatsapp_enabled)
values ('onda3-integ', 'Onda 3 Integ', 'onda3-integ', 'active', true);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select v.id, 'authenticated', 'authenticated', v.email, '{"provider":"email","providers":["email"]}',
  jsonb_build_object('full_name', v.name), now(), now()
from (values
  ('00000000-0000-4000-8000-00000003a001'::uuid, 'integ-admin@example.invalid', 'Diretora Integ'),
  ('00000000-0000-4000-8000-00000003a002'::uuid, 'integ-ana@example.invalid', 'Ana Titular'),
  ('00000000-0000-4000-8000-00000003a003'::uuid, 'integ-bia@example.invalid', 'Bia Substituta'),
  ('00000000-0000-4000-8000-00000003a004'::uuid, 'integ-caio@example.invalid', 'Caio Substituto'),
  ('00000000-0000-4000-8000-00000003a005'::uuid, 'integ-um@example.invalid', 'Aluno Um'),
  ('00000000-0000-4000-8000-00000003a006'::uuid, 'integ-dois@example.invalid', 'Aluno Dois'),
  ('00000000-0000-4000-8000-00000003a007'::uuid, 'integ-tres@example.invalid', 'Aluno Tres')
) as v(id, email, name);

update public.profiles as p
set tenant_id = 'onda3-integ', role = v.role, lifecycle_status = 'active', full_name = v.name,
    phone = v.phone, attendance_phone = v.phone, is_test_account = false
from (values
  ('00000000-0000-4000-8000-00000003a001'::uuid, 'SCHOOL_ADMIN', 'Diretora Integ', '5511999993001'),
  ('00000000-0000-4000-8000-00000003a002'::uuid, 'TEACHER', 'Ana Titular', '5511999993002'),
  ('00000000-0000-4000-8000-00000003a003'::uuid, 'TEACHER', 'Bia Substituta', '5511999993003'),
  ('00000000-0000-4000-8000-00000003a004'::uuid, 'TEACHER', 'Caio Substituto', '5511999993004'),
  ('00000000-0000-4000-8000-00000003a005'::uuid, 'STUDENT', 'Aluno Um', '5511988883005'),
  ('00000000-0000-4000-8000-00000003a006'::uuid, 'STUDENT', 'Aluno Dois', '5511988883006'),
  ('00000000-0000-4000-8000-00000003a007'::uuid, 'STUDENT', 'Aluno Tres', '5511988883007')
) as v(id, role, name, phone)
where p.id = v.id;

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary)
select p.id, 'onda3-integ', p.role, 'ACTIVE', true
from public.profiles as p
where p.tenant_id = 'onda3-integ'
on conflict (user_id, tenant_id) do update
set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

insert into public.tenant_user_contexts (user_id, tenant_id)
values ('00000000-0000-4000-8000-00000003a001', 'onda3-integ');

-- Conta central conectada (a previsão de sala do pacote exige). A fila global
-- do Meet não é chamada aqui.
insert into private.google_workspace_connections (tenant_id, organizer_sub, organizer_email, status, connected_by)
values ('onda3-integ', 'integ-sub-central', 'escola-integ@example.invalid', 'CONNECTED',
  '00000000-0000-4000-8000-00000003a001');

-- Agenda com a titular: amanhã (B1 Aluno Um, B2 Aluno Dois) e dois dias atrás
-- (B3, B4, B5 do Aluno Tres).
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select v.id, 'onda3-integ', '00000000-0000-4000-8000-00000003a002', v.student_id,
       case when v.past then t.y_name else t.d_name end, v.slot, null, date '2026-01-05', 'SCHEDULED'
from integ_day as t
cross join lateral (values
  ('00000000-0000-4000-8000-00000003ab01'::uuid, '00000000-0000-4000-8000-00000003a005'::uuid, '10:00', false),
  ('00000000-0000-4000-8000-00000003ab02'::uuid, '00000000-0000-4000-8000-00000003a006'::uuid, '11:00', false),
  ('00000000-0000-4000-8000-00000003ab03'::uuid, '00000000-0000-4000-8000-00000003a007'::uuid, '08:00', true),
  ('00000000-0000-4000-8000-00000003ab04'::uuid, '00000000-0000-4000-8000-00000003a007'::uuid, '09:00', true),
  ('00000000-0000-4000-8000-00000003ab05'::uuid, '00000000-0000-4000-8000-00000003a007'::uuid, '10:00', true)
) as v(id, student_id, slot, past);

-- Aceites: titular e Bia prontas; o Caio confirmou a conta mas não autorizou o
-- termo. Alunos de amanhã autorizaram pelo link com código.
select pg_temp.integ_teacher('00000000-0000-4000-8000-00000003a002', 'ana.google@example.invalid', true);
select pg_temp.integ_teacher('00000000-0000-4000-8000-00000003a003', 'bia.google@example.invalid', true);
select pg_temp.integ_teacher('00000000-0000-4000-8000-00000003a004', 'caio.google@example.invalid', false);
select pg_temp.integ_student_accepts('00000000-0000-4000-8000-00000003a005');
select pg_temp.integ_student_accepts('00000000-0000-4000-8000-00000003a006');

-- Sessões como a rodada monta.
select private.sync_lesson_quality_sessions('onda3-integ', t.d, t.d, null) from integ_day as t;
select private.sync_lesson_quality_sessions('onda3-integ', t.y, t.y, null) from integ_day as t;

create temp table integ_sessions as
select v.label, o.session_id
from integ_day as t
cross join lateral (values
  ('S1', '00000000-0000-4000-8000-00000003ab01', t.d, time '10:00'),
  ('S2', '00000000-0000-4000-8000-00000003ab02', t.d, time '11:00'),
  ('S3', '00000000-0000-4000-8000-00000003ab03', t.y, time '08:00'),
  ('S4', '00000000-0000-4000-8000-00000003ab04', t.y, time '09:00'),
  ('S5', '00000000-0000-4000-8000-00000003ab05', t.y, time '10:00')
) as v(label, source_id, class_date, start_time)
join public.lesson_occurrences as o
  on o.tenant_id = 'onda3-integ' and o.source_type = 'booking' and o.source_id = v.source_id
 and o.class_date = v.class_date and o.start_time = v.start_time and o.status <> 'SUPERSEDED';
grant select on integ_sessions to public;

create or replace function pg_temp.integ_sid(p_label text)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  select session_id into v_id from integ_sessions where label = p_label;
  if v_id is null then
    raise exception 'onda 3 integrada: fixture sem a sessão %', p_label;
  end if;
  return v_id;
end;
$$;
grant execute on function pg_temp.integ_sid(text) to public;
create or replace function pg_temp.integ_teacher_of(p_label text)
returns uuid language sql as $$
  select teacher_id from public.lesson_sessions where id = pg_temp.integ_sid(p_label)
$$;

select pg_temp.integ_assert((select count(*) = 5 from integ_sessions), 'fixture: a rodada não montou as 5 sessões');

-- Amanhã: congela como o termo marca. Dois dias atrás: marcada (sem evento — a
-- aula passada não depende da régua do termo) e com sala.
insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason, created_at)
select session_id, '00000000-0000-4000-8000-00000003a001', true,
  'Termo de registro das aulas: aluno (ou responsável) e professor aceitaram o registro permanente.',
  clock_timestamp()
from integ_sessions where label in ('S1', 'S2');
update public.lesson_sessions set documentation_consent = true
where id in (select session_id from integ_sessions);
insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
  cohost_email, state, created_by)
select s.session_id, 'onda3-integ', 'spaces/integ' || s.label,
  'https://meet.google.com/' || translate(lower(s.label), '12345', 'abcde') || 'x-integ-abc', 'integ-sub-central',
  'ana.google@example.invalid', 'READY', '00000000-0000-4000-8000-00000003a001'
from integ_sessions as s;

select pg_temp.integ_assert(
  (select bool_and(s.teacher_id = '00000000-0000-4000-8000-00000003a002'
      and not private.lesson_session_documentation_blocked(s.id)
      and not private.lesson_session_taught_by_other(s.id))
   from integ_sessions as i join public.lesson_sessions as s on s.id = i.session_id),
  'fixture: sessões não nasceram com a titular, ou já barradas');

-- A validação da cobertura (grade, ausência, conflito, atestado) tem suíte
-- própria; aqui só ela fica de fora, e o gatilho da troca segue ligado.
alter table public.class_coverages disable trigger trg_enforce_active_class_coverage_slot;

-- ─── 1. Pacote × sala da troca ───────────────────────────────────────────────

-- 1a. Bia (pronta) cobre a aula de amanhã do Aluno Um: a sessão congelada passa
-- para ela e a sala fica retida até a conta dela ser a coanfitriã.
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at)
values ('00000000-0000-4000-8000-00000003ac01', 'onda3-integ', '00000000-0000-4000-8000-00000003a002',
  '00000000-0000-4000-8000-00000003a003', '00000000-0000-4000-8000-00000003a005',
  '00000000-0000-4000-8000-00000003ab01', pg_temp.integ_d(), '10:00', 'confirmed', now());

select pg_temp.integ_assert(
  pg_temp.integ_teacher_of('S1') = '00000000-0000-4000-8000-00000003a003'
  and (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = pg_temp.integ_sid('S1')),
  'fixture: a cobertura não passou a aula à Bia com a sala retida');

create temp table integ_brief1 as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-00000003ac01', false) as r;
select pg_temp.integ_assert(
  (select not (r ->> 'official_room')::boolean
     and (r ->> 'school_room_expected')::boolean
     and strpos(r ->> 'briefing', 'o link chega por aqui quando a sala ficar pronta') > 0
     and strpos(r ->> 'briefing', 'combine direto e mande o link da aula') = 0
   from integ_brief1)
  and not exists (select 1 from public.notification_queue
                  where tenant_id = 'onda3-integ' and idempotency_key like 'coverage:%ac01:room%'),
  'pacote da substituta pronta com a sala retida não prometeu a sala da escola: '
    || (select r::text from integ_brief1));

-- O que a fila do Meet faz (room_claim → SYNC_COHOST → ensureCohost → room_cohost_save).
create temp table integ_claim as
select public.google_meet_backend('room_claim', 'onda3-integ', '00000000-0000-4000-8000-00000003a001',
  pg_temp.integ_sid('S1'), '{"organizer_sub":"integ-sub-central","automatic":true}'::jsonb) as r;
select pg_temp.integ_assert(
  (select r -> 'room' ->> 'cohost_email' = 'bia.google@example.invalid'
     and (r -> 'room' ->> 'teacher_handover_pending')::boolean
   from integ_claim)
  and not exists (select 1 from public.notification_queue
                  where tenant_id = 'onda3-integ' and idempotency_key like 'coverage:%ac01:room%'),
  'sala retida anunciada antes da conta da Bia entrar: ' || (select r::text from integ_claim));
select public.google_meet_backend('room_cohost_save', 'onda3-integ', '00000000-0000-4000-8000-00000003a001',
  pg_temp.integ_sid('S1'), '{"result":"SYNCED","cohost_email":"bia.google@example.invalid"}'::jsonb);

select pg_temp.integ_assert(
  not (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = pg_temp.integ_sid('S1'))
  and (select count(*) = 1 from public.notification_queue
        where tenant_id = 'onda3-integ'
          and idempotency_key = 'coverage:00000000-0000-4000-8000-00000003ac01:room'
          and student_phone = '5511999993003'
          and strpos(message_body, 'https://meet.google.com/sax-integ-abc') > 0
          and strpos(message_body, 'não mande outro link') > 0)
  and (select count(*) = 1 from public.notification_queue
        where tenant_id = 'onda3-integ'
          and idempotency_key = 'coverage:00000000-0000-4000-8000-00000003ac01:room-family'
          and student_phone = '5511988883005'
          and strpos(message_body, 'https://meet.google.com/sax-integ-abc') > 0),
  'retenção solta sem avisar: o pacote prometeu o link da escola e ele não chegou à substituta e à família');

-- Gravar a sala de novo não repete o aviso.
update private.google_meet_rooms set state = 'READY', updated_at = now()
where lesson_session_id = pg_temp.integ_sid('S1');
select pg_temp.integ_assert(
  (select count(*) = 2 from public.notification_queue
    where tenant_id = 'onda3-integ' and idempotency_key like 'coverage:00000000-0000-4000-8000-00000003ac01:room%'),
  'aviso de sala pronta repetido');

-- A substituta só pela janela lê o dossiê, não as sugestões do cartão (quem
-- decide sugestão é quem escreve o cartão); a sala da aula dela vem inteira.
select pg_temp.integ_assert(
  (pg_temp.integ_as('00000000-0000-4000-8000-00000003a003',
     'select public.get_student_card_suggestions(''00000000-0000-4000-8000-00000003a005''::uuid)') ->> 'error')
    = 'sem_permissao',
  'substituto só pela janela leu as sugestões do cartão');

-- 1b. Caio (conta confirmada, SEM o termo) cobre a aula do Aluno Dois: a aula
-- passa para ele com a documentação desligada — pacote manda o link de sempre.
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
  class_date, class_time, status, confirmed_at)
values ('00000000-0000-4000-8000-00000003ac02', 'onda3-integ', '00000000-0000-4000-8000-00000003a002',
  '00000000-0000-4000-8000-00000003a004', '00000000-0000-4000-8000-00000003a006',
  '00000000-0000-4000-8000-00000003ab02', pg_temp.integ_d(), '11:00', 'confirmed', now());

select pg_temp.integ_assert(
  pg_temp.integ_teacher_of('S2') = '00000000-0000-4000-8000-00000003a004'
  and private.lesson_session_handover_unconsented(pg_temp.integ_sid('S2'))
  and private.lesson_session_documentation_blocked(pg_temp.integ_sid('S2')),
  'fixture: a aula não passou ao Caio com a documentação desligada');

create temp table integ_brief2 as
select public.coverage_briefing_enqueue('00000000-0000-4000-8000-00000003ac02', false) as r;
select pg_temp.integ_assert(
  (select not (r ->> 'official_room')::boolean
     and not (r ->> 'school_room_expected')::boolean
     and strpos(r ->> 'briefing', 'combine direto e mande o link da aula') > 0
     and strpos(r ->> 'briefing', 'o link chega por aqui') = 0
   from integ_brief2)
  and (select strpos(message_body, 'vai te chamar pelo WhatsApp para combinar o link') > 0
         and strpos(message_body, 'o link chega por aqui') = 0
       from public.notification_queue
      where tenant_id = 'onda3-integ'
        and idempotency_key = 'coverage:00000000-0000-4000-8000-00000003ac02:family'),
  'aula que segue pelo link de sempre prometeu a sala da escola: ' || (select r::text from integ_brief2));

-- A conta do Caio vira a coanfitriã (a retenção é solta): a sala continua sem
-- sair — ele não autorizou o termo.
update private.google_meet_rooms
   set cohost_email = 'caio.google@example.invalid', cohost_sync_pending = false
 where lesson_session_id = pg_temp.integ_sid('S2');
select pg_temp.integ_assert(
  not (select teacher_handover_pending from private.google_meet_rooms where lesson_session_id = pg_temp.integ_sid('S2'))
  and not exists (select 1 from public.notification_queue
                  where tenant_id = 'onda3-integ'
                    and idempotency_key like 'coverage:00000000-0000-4000-8000-00000003ac02:room%')
  and public.official_lesson_link('onda3-integ', 'booking', '00000000-0000-4000-8000-00000003ab02',
        pg_temp.integ_d(), '00000000-0000-4000-8000-00000003a002', time '11:00',
        '00000000-0000-4000-8000-00000003a006') is null,
  'sala mandada ao substituto sem o aceite do termo');

-- ─── 2 e 3. Avaliação de presença e extrato, com a régua de quem deu a aula ──

-- Planilha como a edge grava (attendance_save), com os papéis DA HORA da
-- importação: a titular era "a professora", quem mais entrou era "aluno".
create or replace function pg_temp.integ_save(p_label text, p_rows jsonb, p_teacher_join time, p_teacher_seconds integer,
  p_student_join time, p_student_seconds integer)
returns void language plpgsql as $$
begin
  perform public.google_meet_attendance_backend('attendance_save', 'onda3-integ', pg_temp.integ_sid(p_label),
    jsonb_build_object(
      'conference_name', 'conferenceRecords/integ-' || p_label,
      'document_id', 'doc-integ-' || p_label,
      'document_name', 'Relatório de participação integ ' || p_label,
      'source_document_ids', jsonb_build_array('doc-integ-' || p_label),
      'source_csv', 'Nome,E-mail,Entrada,Saída',
      'content_sha256', encode(extensions.digest('integ-' || p_label, 'sha256'), 'hex'),
      'participants', p_rows,
      'teacher_first_join_at', case when p_teacher_join is not null then pg_temp.integ_at(p_teacher_join) end,
      'teacher_seconds', p_teacher_seconds,
      'student_first_join_at', pg_temp.integ_at(p_student_join),
      'student_seconds', p_student_seconds,
      'retention_days', 90));
end;
$$;
create or replace function pg_temp.integ_row(p_name text, p_email text, p_join time, p_left time, p_role text)
returns jsonb language sql as $$
  select jsonb_build_object('name', p_name, 'email', p_email,
    'joinedAt', pg_temp.integ_iso(pg_temp.integ_at(p_join)), 'leftAt', pg_temp.integ_iso(pg_temp.integ_at(p_left)),
    'durationSeconds', extract(epoch from (p_left - p_join))::integer, 'role', p_role)
$$;
create or replace function pg_temp.integ_evaluate(p_label text, p_conferences integer)
returns jsonb language sql as $$
  select public.google_meet_attendance_backend('attendance_evaluate', 'onda3-integ', pg_temp.integ_sid(p_label),
    jsonb_build_object('conference_count', p_conferences, 'report_found', p_conferences > 0, 'conference_open', false))
$$;
-- A direção atesta depois da aula que a Bia a deu (cobertura confirmada).
create or replace function pg_temp.integ_attest(p_id uuid, p_booking uuid, p_time text)
returns void language sql as $$
  insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id,
    class_date, class_time, status, confirmed_at, confirmed_by)
  values (p_id, 'onda3-integ', '00000000-0000-4000-8000-00000003a002', '00000000-0000-4000-8000-00000003a003',
    '00000000-0000-4000-8000-00000003a007', p_booking, pg_temp.integ_y(), p_time, 'confirmed', now(),
    '00000000-0000-4000-8000-00000003a001')
$$;
-- A Bia lança a aula que cobriu, no agendamento da titular (a cobertura permite).
-- p_link = false: o lançamento não religa as sessões (como se a rodada ainda não
-- tivesse passado).
create or replace function pg_temp.integ_log(p_id uuid, p_booking text, p_time time, p_link boolean)
returns void language plpgsql as $$
begin
  if not p_link then
    alter table public.class_logs disable trigger link_class_log_quality_session;
  end if;
  insert into public.class_logs (id, tenant_id, teacher_id, student_id, booking_id, presence,
    date, class_date, start_time, created_at)
  values (p_id, 'onda3-integ', '00000000-0000-4000-8000-00000003a003', '00000000-0000-4000-8000-00000003a007',
    p_booking, 'COMPLETED', pg_temp.integ_y(), pg_temp.integ_y(), p_time, now());
  if not p_link then
    alter table public.class_logs enable trigger link_class_log_quality_session;
  end if;
end;
$$;
create or replace function pg_temp.integ_cases(p_label text)
returns text[] language sql as $$
  select coalesce(array_agg(q.category || ':' || q.teacher_id::text order by q.category, q.teacher_id::text), '{}')
  from public.lesson_quality_cases as q
  where q.session_id = pg_temp.integ_sid(p_label) and q.source = 'SYSTEM'
$$;
create or replace function pg_temp.integ_extract(p_teacher uuid)
returns jsonb language sql as $$
  select pg_temp.integ_as(p_teacher,
    format('select public.get_my_punctuality_extract(%L::date)', pg_temp.integ_y()))
$$;

-- 2a. Aula das 11:00 (S6): a planilha foi guardada logo depois da aula, com a
-- Ana como professora (ela passou 2 min na sala às 11:20) e a Bia como aluna.
-- Depois a direção atestou que a Bia deu a aula e a Bia lançou, mas a troca
-- ainda não rodou (o gatilho falhou; a rodada de 15 min refaz). A porta da
-- avaliação recusa a aula barrada, e a avaliação interna não abre caso contra a
-- Ana, que não deu a aula. Extrato desligado (o padrão): nada é gravado.
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, date, start_date, status)
select '00000000-0000-4000-8000-00000003ab06', 'onda3-integ', '00000000-0000-4000-8000-00000003a002',
  '00000000-0000-4000-8000-00000003a007', t.y_name, '11:00', null, date '2026-01-05', 'SCHEDULED'
from integ_day as t;
select private.sync_lesson_quality_sessions('onda3-integ', t.y, t.y, '00000000-0000-4000-8000-00000003a007')
from integ_day as t;
insert into integ_sessions (label, session_id)
select 'S6', o.session_id from public.lesson_occurrences as o
where o.tenant_id = 'onda3-integ' and o.source_type = 'booking' and o.source_id = '00000000-0000-4000-8000-00000003ab06'
  and o.class_date = pg_temp.integ_y() and o.status <> 'SUPERSEDED';
update public.lesson_sessions set documentation_consent = true where id = pg_temp.integ_sid('S6');
insert into private.google_meet_rooms (lesson_session_id, tenant_id, space_name, meeting_uri, organizer_sub,
  cohost_email, state, created_by)
values (pg_temp.integ_sid('S6'), 'onda3-integ', 'spaces/integS6', 'https://meet.google.com/sfx-integ-abc',
  'integ-sub-central', 'ana.google@example.invalid', 'READY', '00000000-0000-4000-8000-00000003a001');
select pg_temp.integ_save('S6', jsonb_build_array(
    pg_temp.integ_row('Ana', 'ana.google@example.invalid', time '11:20', time '11:22', 'TEACHER'),
    pg_temp.integ_row('Bia', 'bia.google@example.invalid', time '11:02', time '11:30', 'STUDENT'),
    pg_temp.integ_row('Aluno Tres', 'tres@example.invalid', time '11:01', time '11:26', 'STUDENT')),
  time '11:20', 120, time '11:01', 3180);
alter table public.class_coverages disable trigger trg_zz_class_coverage_follow_lesson_session;
select pg_temp.integ_attest('00000000-0000-4000-8000-00000003ac06', '00000000-0000-4000-8000-00000003ab06', '11:00');
alter table public.class_coverages enable trigger trg_zz_class_coverage_follow_lesson_session;
select pg_temp.integ_log('00000000-0000-4000-8000-00000003ad06', '00000000-0000-4000-8000-00000003ab06', time '11:00', false);
select pg_temp.integ_assert(
  pg_temp.integ_teacher_of('S6') = '00000000-0000-4000-8000-00000003a002'
  and private.lesson_session_taught_by_other(pg_temp.integ_sid('S6')),
  'fixture: a aula das 11:00 já tinha passado à Bia (ou a régua não viu a cobertura)');
do $s6_porta$
declare
  v_refused boolean := false;
begin
  begin
    perform pg_temp.integ_evaluate('S6', 1);
  exception when insufficient_privilege then
    v_refused := true;
  end;
  perform pg_temp.integ_assert(v_refused, 'a porta da avaliação aceitou aula dada por outro professor ainda não trocada');
end
$s6_porta$;
select private.meet_attendance_evaluate(pg_temp.integ_sid('S6'), 'COMPLETED', 1);
select pg_temp.integ_assert(
  pg_temp.integ_cases('S6') = '{}'::text[],
  'aula dada pela substituta abriu caso contra a titular (números da importação): '
    || pg_temp.integ_cases('S6')::text);
-- A rodada de 15 min faz a troca; a avaliação, agora com a Bia, também não abre
-- nada (a entrada das 11:20 e os 2 min eram da Ana).
select private.sync_lesson_quality_sessions('onda3-integ', t.y, t.y, '00000000-0000-4000-8000-00000003a007')
from integ_day as t;
select pg_temp.integ_evaluate('S6', 1);
select pg_temp.integ_assert(
  pg_temp.integ_teacher_of('S6') = '00000000-0000-4000-8000-00000003a003'
  and pg_temp.integ_cases('S6') = '{}'::text[],
  'depois da troca, a avaliação abriu caso contra a substituta com os números da titular: '
    || pg_temp.integ_cases('S6')::text);
select pg_temp.integ_assert(
  not exists (select 1 from public.teacher_lesson_presence where tenant_id = 'onda3-integ')
  and (pg_temp.integ_extract('00000000-0000-4000-8000-00000003a002') ->> 'enabled') = 'false'
  and (pg_temp.integ_extract('00000000-0000-4000-8000-00000003a003') ->> 'enabled') = 'false',
  'extrato desligado gravou ou mostrou alguma coisa');

-- Liga o extrato (como a direção faria na VPS, com o parecer), valendo para as
-- aulas de dois dias atrás.
select private.set_teacher_punctuality_enabled('onda3-integ', true, 'Teste de integração da onda 3 (sem parecer real).');
update private.teacher_punctuality_settings set enabled_at = now() - interval '5 days' where tenant_id = 'onda3-integ';

-- 3a. Aula das 10:00 (S5) medida ANTES de qualquer sinal de troca — vai para a
-- Ana (que não entrou). A direção atesta e a Bia lança: a aula sai do extrato da
-- Ana NA HORA, sem esperar a varredura, que a refaz para a Bia.
select pg_temp.integ_save('S5', jsonb_build_array(
    pg_temp.integ_row('Bia', 'bia.google@example.invalid', time '10:03', time '10:30', 'STUDENT'),
    pg_temp.integ_row('Aluno Tres', 'tres@example.invalid', time '10:02', time '10:29', 'STUDENT')),
  null, 0, time '10:02', 3240);
select pg_temp.integ_evaluate('S5', 1);
select pg_temp.integ_assert(
  (select status = 'FOUND' and teacher_id = '00000000-0000-4000-8000-00000003a002' and first_join_at is null
   from public.teacher_lesson_presence where lesson_session_id = pg_temp.integ_sid('S5')),
  'fixture: a aula das 10:00 não foi medida com a titular antes da troca');
select pg_temp.integ_attest('00000000-0000-4000-8000-00000003ac05', '00000000-0000-4000-8000-00000003ab05', '10:00');
select pg_temp.integ_log('00000000-0000-4000-8000-00000003ad05', '00000000-0000-4000-8000-00000003ab05', time '10:00', true);
select pg_temp.integ_assert(pg_temp.integ_teacher_of('S5') = '00000000-0000-4000-8000-00000003a003',
  'fixture: o atestado não passou a aula das 10:00 à Bia');
select pg_temp.integ_assert(
  (select (e -> 'summary' ->> 'planned')::integer = 0 and jsonb_array_length(e -> 'lessons') = 0
   from (select pg_temp.integ_extract('00000000-0000-4000-8000-00000003a002') as e) as ana),
  'a aula que a Bia deu continuou no extrato da Ana depois da troca: '
    || pg_temp.integ_extract('00000000-0000-4000-8000-00000003a002')::text);
select private.teacher_lesson_presence_sweep();
select pg_temp.integ_assert(
  (select status = 'FOUND' and teacher_id = '00000000-0000-4000-8000-00000003a003'
     and first_join_at = pg_temp.integ_at(time '10:03') and late_minutes = 3 and minutes_in_room = 27
   from public.teacher_lesson_presence where lesson_session_id = pg_temp.integ_sid('S5')),
  'a varredura não refez a aula das 10:00 para a Bia com os números dela');

-- 2b. Aula das 08:00 (S3): a planilha foi guardada com a Ana como professora
-- (08:20, 2 min) e a Bia como aluna; depois a direção atestou e a Bia (que
-- entrou 08:02) lançou. Nada de "professor 2 min na sala" nem atraso das 08:20
-- contra a Bia.
select pg_temp.integ_save('S3', jsonb_build_array(
    pg_temp.integ_row('Ana', 'ana.google@example.invalid', time '08:20', time '08:22', 'TEACHER'),
    pg_temp.integ_row('Bia', 'bia.google@example.invalid', time '08:02', time '08:30', 'STUDENT'),
    pg_temp.integ_row('Aluno Tres', 'tres@example.invalid', time '08:01', time '08:26', 'STUDENT')),
  time '08:20', 120, time '08:01', 3180);
select pg_temp.integ_attest('00000000-0000-4000-8000-00000003ac03', '00000000-0000-4000-8000-00000003ab03', '08:00');
select pg_temp.integ_log('00000000-0000-4000-8000-00000003ad03', '00000000-0000-4000-8000-00000003ab03', time '08:00', true);
select pg_temp.integ_assert(
  pg_temp.integ_teacher_of('S3') = '00000000-0000-4000-8000-00000003a003'
  and private.lesson_session_logged_presence(pg_temp.integ_sid('S3')) = 'COMPLETED',
  'fixture: a aula das 08:00 não passou à Bia com o lançamento dela ligado');
select pg_temp.integ_evaluate('S3', 1);
select pg_temp.integ_assert(
  pg_temp.integ_cases('S3') = '{}'::text[],
  'a avaliação abriu caso contra a substituta com os números da titular: ' || pg_temp.integ_cases('S3')::text);
select pg_temp.integ_assert(
  (select status = 'FOUND' and teacher_id = '00000000-0000-4000-8000-00000003a003'
     and late_minutes = 2 and minutes_in_room = 28
   from public.teacher_lesson_presence where lesson_session_id = pg_temp.integ_sid('S3')),
  'extrato da aula das 08:00 sem os números da Bia');

-- 2c. Aula das 09:00 (S4, controle positivo): antes do atestado, a Ana (a
-- professora da agenda) entrou às 09:12 e o caso de atraso dela abriu — o
-- sistema não sabia da troca. Depois do atestado, a Bia (que entrou 09:14) tem
-- o caso DELA, com a entrada dela; o da Ana fica com a direção, anotado.
select pg_temp.integ_save('S4', jsonb_build_array(
    pg_temp.integ_row('Ana', 'ana.google@example.invalid', time '09:12', time '09:13', 'TEACHER'),
    pg_temp.integ_row('Bia', 'bia.google@example.invalid', time '09:14', time '09:30', 'STUDENT'),
    pg_temp.integ_row('Aluno Tres', 'tres@example.invalid', time '09:01', time '09:30', 'STUDENT')),
  time '09:12', 60, time '09:01', 2700);
select pg_temp.integ_evaluate('S4', 1);
select pg_temp.integ_assert(
  pg_temp.integ_cases('S4') = array['LATE_START:00000000-0000-4000-8000-00000003a002'],
  'fixture: o atraso da Ana (professora da agenda, antes do atestado) não abriu caso: '
    || pg_temp.integ_cases('S4')::text);
select pg_temp.integ_attest('00000000-0000-4000-8000-00000003ac04', '00000000-0000-4000-8000-00000003ab04', '09:00');
select pg_temp.integ_log('00000000-0000-4000-8000-00000003ad04', '00000000-0000-4000-8000-00000003ab04', time '09:00', true);
select pg_temp.integ_evaluate('S4', 1);
select pg_temp.integ_assert(
  pg_temp.integ_cases('S4') = array['LATE_START:00000000-0000-4000-8000-00000003a002',
                                    'LATE_START:00000000-0000-4000-8000-00000003a003']
  and exists (
    select 1 from public.lesson_quality_case_events as e
    join public.lesson_quality_cases as q on q.id = e.case_id
    where q.session_id = pg_temp.integ_sid('S4') and q.teacher_id = '00000000-0000-4000-8000-00000003a003'
      and e.event_type = 'MEET_ATTENDANCE_REPORT'
      and (e.details ->> 'teacher_first_join_at')::timestamptz = pg_temp.integ_at(time '09:14')
      and (e.details ->> 'teacher_minutes')::numeric = 16
      and (e.details ->> 'student_minutes')::numeric = 29)
  and exists (
    select 1 from public.lesson_quality_case_events as e
    join public.lesson_quality_cases as q on q.id = e.case_id
    where q.session_id = pg_temp.integ_sid('S4') and q.teacher_id = '00000000-0000-4000-8000-00000003a002'
      and e.event_type = 'MEET_TEACHER_HANDOVER'
      and e.details ->> 'teacher_id' = '00000000-0000-4000-8000-00000003a003'),
  'o atraso da substituta não foi medido com a entrada dela (ou o caso antigo não ganhou a anotação da troca): '
    || pg_temp.integ_cases('S4')::text);
-- Avaliar de novo não repete nem o caso nem a anotação.
select pg_temp.integ_evaluate('S4', 1);
select pg_temp.integ_assert(
  (select count(*) = 2 from public.lesson_quality_cases where session_id = pg_temp.integ_sid('S4'))
  and (select count(*) = 1 from public.lesson_quality_case_events as e
       join public.lesson_quality_cases as q on q.id = e.case_id
       where q.session_id = pg_temp.integ_sid('S4') and e.event_type = 'MEET_TEACHER_HANDOVER'),
  'a reavaliação repetiu caso ou anotação');

-- A tela da aula (quem vê a fonte) mostra a Bia como professora, com os números dela.
select pg_temp.integ_assert(
  (select (d -> 'attendance' ->> 'teacher_first_join_at')::timestamptz = pg_temp.integ_at(time '09:14')
     and (d -> 'attendance' ->> 'teacher_seconds')::integer = 960
     and (d -> 'attendance' ->> 'student_seconds')::integer = 1740
     and exists (select 1 from jsonb_array_elements(d -> 'attendance' -> 'participants') as p
                 where p ->> 'email' = 'bia.google@example.invalid' and p ->> 'role' = 'TEACHER')
     and exists (select 1 from jsonb_array_elements(d -> 'attendance' -> 'participants') as p
                 where p ->> 'email' = 'ana.google@example.invalid' and p ->> 'role' = 'OTHER_TEACHER')
   from (select public.google_meet_backend('session_detail', 'onda3-integ', '00000000-0000-4000-8000-00000003a003',
           pg_temp.integ_sid('S4'), '{}'::jsonb) as d) as detail),
  '"Sala e resumo" mostra a substituta como aluna ou os números da titular');

-- Extrato: nada da Ana; as três aulas medidas são da Bia (uma com atraso de 10+).
select pg_temp.integ_assert(
  (select (e -> 'summary' ->> 'planned')::integer = 0
   from (select pg_temp.integ_extract('00000000-0000-4000-8000-00000003a002') as e) as ana)
  and (select (e -> 'summary' ->> 'planned')::integer = 3 and (e -> 'summary' ->> 'late_10')::integer = 1
       from (select pg_temp.integ_extract('00000000-0000-4000-8000-00000003a003') as e) as bia),
  'extrato não conta as aulas para quem as deu: ana='
    || pg_temp.integ_extract('00000000-0000-4000-8000-00000003a002')::text
    || ' bia=' || pg_temp.integ_extract('00000000-0000-4000-8000-00000003a003')::text);

rollback;
