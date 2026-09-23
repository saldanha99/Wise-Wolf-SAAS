-- Fechamento automático da experimental: o bot pergunta à professora, a aula é
-- lançada (pagamento dela), o comentário entra, o aluno escolhe plano e horário
-- e o link de matrícula sai com o preço da tabela.
--
-- [1] experimental terminada vira pergunta à professora;
-- [2] "SIM A2 4 2x" lança a aula, salva o comentário e chama o aluno;
-- [3] aluno escolhe horário livre + 12 meses → oferta com o preço da tabela;
-- [4] a Gestão é avisada do link;
-- [5] responder de novo não gera segunda oferta;
-- [6] professora sem pergunta aberta não é interpretada.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;

-- A oferta de matrícula é um contrato: sem os dados legais da escola ela é
-- recusada (private.contract_school_info). Tudo aqui é sintético.
insert into public.tenants(id, name, slug, saas_status, whatsapp_enabled, school_info)
values ('trial-closing-qa', 'Trial Closing QA', 'trial-closing-qa', 'active', true, jsonb_build_object(
  'name', 'Trial Closing QA Idiomas',
  'cnpj', '11222333000181',
  'address', 'Rua Sintetica, 100',
  'email', 'qa@example.invalid',
  'phone', '11900000051',
  'city', 'Cidade QA',
  'state', 'SP',
  'legalRepresentativeName', 'Diretora Sintetica',
  'legalRepresentativeSignaturePath',
    'trial-closing-qa/legal-representative-signature/7e190000-0000-4000-8000-000000000060.png'
));

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('7e190000-0000-4000-8000-000000000051', 'authenticated', 'authenticated', 'closing-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Sintetica"}', now(), now()),
  ('7e190000-0000-4000-8000-000000000052', 'authenticated', 'authenticated', 'closing-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professora Sintetica"}', now(), now()),
  ('7e190000-0000-4000-8000-000000000053', 'authenticated', 'authenticated', 'closing-teacher2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professora Sem Pergunta"}', now(), now());

set local app.enrollment_claim = '1';
update public.profiles set tenant_id = 'trial-closing-qa', role = 'SCHOOL_ADMIN',
  full_name = 'Diretora Sintetica', lifecycle_status = 'active', phone = '5511900000051'
 where id = '7e190000-0000-4000-8000-000000000051';
update public.profiles set tenant_id = 'trial-closing-qa', role = 'TEACHER',
  full_name = 'Professora Sintetica', lifecycle_status = 'active', phone = '5511900000052'
 where id = '7e190000-0000-4000-8000-000000000052';
update public.profiles set tenant_id = 'trial-closing-qa', role = 'TEACHER',
  full_name = 'Professora Sem Pergunta', lifecycle_status = 'active', phone = '5511900000053'
 where id = '7e190000-0000-4000-8000-000000000053';
set local app.enrollment_claim = '';

insert into public.tenant_memberships(user_id, tenant_id, role, status, is_primary)
values
  ('7e190000-0000-4000-8000-000000000051', 'trial-closing-qa', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('7e190000-0000-4000-8000-000000000052', 'trial-closing-qa', 'TEACHER', 'ACTIVE', true),
  ('7e190000-0000-4000-8000-000000000053', 'trial-closing-qa', 'TEACHER', 'ACTIVE', true)
on conflict do nothing;

insert into public.dre_report_settings(tenant_id, destino, is_active)
values ('trial-closing-qa', '120363400000000051@g.us', true);

insert into public.student_pricing_plans(tenant_id, name, classes_per_week, fidelity_months, monthly_price, active)
values
  ('trial-closing-qa', '1m-2x', 2, 1, 220.00, true),
  ('trial-closing-qa', '12m-2x', 2, 12, 169.00, true);

-- A professora declarou terça e quinta às 18:00 e às 19:00; a terça 19:00 já tem aula fixa.
insert into public.teacher_availability(teacher_id, tenant_id, day_of_week, start_time)
values
  ('7e190000-0000-4000-8000-000000000052', 'trial-closing-qa', 2, '18:00'),
  ('7e190000-0000-4000-8000-000000000052', 'trial-closing-qa', 2, '19:00'),
  ('7e190000-0000-4000-8000-000000000052', 'trial-closing-qa', 4, '18:00');

create temporary table fx(k text primary key, v uuid);
insert into fx values ('appointment', gen_random_uuid()), ('opportunity', gen_random_uuid());

insert into public.appointments(id, tenant_id, teacher_id, professor_id, student_name, student_phone, start_time, status, type)
select v, 'trial-closing-qa', '7e190000-0000-4000-8000-000000000052',
  '7e190000-0000-4000-8000-000000000052', 'Aluno Sintetico Fechamento',
  '5511900000191', now() - interval '2 hours', 'scheduled', 'experimental'
from fx where k = 'appointment';

-- trial_status nasce 'SCHEDULED' no fluxo real (medido em 23/09/2026: nenhuma
-- experimental CLAIMED dos ultimos 90 dias tem o campo nulo). O retorno de
-- trial_closing_teacher_asks filtra por `trial_status not in (...)` sem
-- coalesce, entao um fixture com nulo some do resultado por NULL-logic.
insert into public.opportunities(id, tenant_id, kind, status, conversion_status, winner_teacher_id,
  trial_appointment_id, student_name, student_phone, feedback_required, slots_proposed, trial_status)
select o.v, 'trial-closing-qa', 'TRIAL', 'CLAIMED', 'OPEN', '7e190000-0000-4000-8000-000000000052',
  a.v, 'Aluno Sintetico Fechamento', '5511900000191', true, '[]'::jsonb, 'SCHEDULED'
from (select v from fx where k = 'opportunity') o, (select v from fx where k = 'appointment') a;

-- [1] a experimental terminada vira pergunta à professora
create temporary table asks as
select * from public.trial_closing_teacher_asks(10);
select pg_temp.assert_true(
  (select count(*) from asks where tenant_id = 'trial-closing-qa') = 1,
  '[1] a experimental terminada deveria gerar uma pergunta'
);
select pg_temp.assert_true(
  (select teacher_phone from asks where tenant_id = 'trial-closing-qa') = '5511900000052',
  '[1] a pergunta vai para o telefone da professora'
);
select public.trial_closing_mark_asked(flow_id, 'teacher') from asks where tenant_id = 'trial-closing-qa';

-- [2] "SIM A2 4 2x" lança a aula, salva o comentário e chama o aluno
create temporary table r1 as
select public.trial_closing_teacher_reply(
  'trial-closing-qa', '7e190000-0000-4000-8000-000000000052', 'DONE', 'A2', 4, '2x_semana'
) as v;
select pg_temp.assert_true((select v ->> 'stage' from r1) = 'ASK_STUDENT', '[2] deveria passar para a conversa com o aluno');
select pg_temp.assert_true(
  (select count(*) from public.class_logs c, fx
    where fx.k = 'appointment' and c.appointment_id = fx.v::text
      and c.presence = 'COMPLETED' and c.subtype = 'AULA EXPERIMENTAL') = 1,
  '[2] a aula experimental deveria estar lançada (é o pagamento da professora)'
);
select pg_temp.assert_true(
  (select o.trial_status from public.opportunities o, fx where fx.k = 'opportunity' and o.id = fx.v) = 'DONE',
  '[2] a oportunidade deveria ficar como aula feita'
);
select pg_temp.assert_true(
  (select count(*) from public.trial_feedback f, fx
    where fx.k = 'opportunity' and f.opportunity_id = fx.v and f.recommended_level = 'A2'
      and f.interest_score = 4 and f.recommended_plan = '2x_semana') = 1,
  '[2] o comentário da professora deveria estar salvo'
);

-- [3] o aluno escolhe dois horários livres e o plano de 12 meses
create temporary table r2 as
select public.trial_closing_student_plan(
  'trial-closing-qa', '5511900000191', null, 12,
  '[{"day":"Terça","time":"18:00"},{"day":"Quinta","time":"18:00"}]'::jsonb,
  'https://exemplo.invalid'
) as v;
select pg_temp.assert_true(
  coalesce(((select v -> 'offer' ->> 'ok' from r2))::boolean, false),
  '[3] a oferta deveria ser criada: ' || coalesce((select v -> 'offer' ->> 'error' from r2), 'sem erro')
);
select pg_temp.assert_true(
  (select (v -> 'offer' ->> 'value')::numeric from r2) = 169.00,
  '[3] o valor deveria ser o da tabela para 2x em 12 meses'
);
select pg_temp.assert_true(
  (select count(*) from public.enrollment_links l, fx
    where fx.k = 'opportunity' and l.opportunity_id = fx.v and l.status = 'PENDING') = 1,
  '[3] deveria existir um link de matrícula pendente'
);

-- [4] a Gestão vê o link que o bot mandou
select pg_temp.assert_true(
  (select count(*) from public.notification_queue q
    where q.tenant_id = 'trial-closing-qa'
      and q.idempotency_key like 'trial-closing-offer:%'
      and q.student_phone = '120363400000000051@g.us'
      and q.message_body like '%R$ 169,00/mês (tabela)%') = 1,
  '[4] a Gestão deveria receber o aviso com o valor da tabela'
);

-- [5] responder de novo não gera uma segunda oferta
select pg_temp.assert_true(
  coalesce(((select public.trial_closing_student_plan(
    'trial-closing-qa', '5511900000191', null, 12,
    '[{"day":"Terça","time":"18:00"},{"day":"Quinta","time":"18:00"}]'::jsonb, 'https://exemplo.invalid'
  ) ->> 'handled')::boolean), true) = false,
  '[5] com a oferta enviada, a escolha não deveria ser processada de novo'
);
select pg_temp.assert_true(
  (select count(*) from public.offers o, fx
    where fx.k = 'opportunity' and o.opportunity_id = fx.v and o.kind = 'ENROLLMENT' and o.revoked_at is null) = 1,
  '[5] deveria existir uma única oferta de matrícula'
);

-- [6] professora sem pergunta aberta não é interpretada
select pg_temp.assert_true(
  coalesce(((select public.trial_closing_teacher_reply(
    'trial-closing-qa', '7e190000-0000-4000-8000-000000000053', 'DONE', 'A2', 4, '2x_semana'
  ) ->> 'handled')::boolean), true) = false,
  '[6] professora sem pergunta aberta deveria seguir para os outros agentes'
);

rollback;
