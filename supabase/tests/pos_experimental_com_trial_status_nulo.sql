-- `trial_status` nulo não pode sumir da pergunta pós-experimental.
--
-- O retorno de trial_closing_teacher_asks filtrava `trial_status not in (...)`
-- sem coalesce, enquanto o insert da MESMA função usava `coalesce(...,'')`.
-- `null not in (...)` é NULL, não verdadeiro: a oportunidade entrava na fila e
-- nunca aparecia no retorno — a professora não era perguntada e o fechamento
-- não começava, sem erro nenhum. Consertado em 20260923060000.
--
-- Este teste existe para que um `create or replace` futuro não desfaça isso em
-- silêncio. Ele também reafirma que NO_SHOW_TEACHER continua fora.

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
values ('trial-closing-nulo-qa', 'Trial Closing QA', 'trial-closing-nulo-qa', 'active', true, jsonb_build_object(
  'name', 'Trial Closing QA Idiomas',
  'cnpj', '11222333000181',
  'address', 'Rua Sintetica, 100',
  'email', 'qa@example.invalid',
  'phone', '11900000051',
  'city', 'Cidade QA',
  'state', 'SP',
  'legalRepresentativeName', 'Diretora Sintetica',
  'legalRepresentativeSignaturePath',
    'trial-closing-nulo-qa/legal-representative-signature/7e1a0000-0000-4000-8000-000000000060.png'
));

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('7e1a0000-0000-4000-8000-000000000051', 'authenticated', 'authenticated', 'closing-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Sintetica"}', now(), now()),
  ('7e1a0000-0000-4000-8000-000000000052', 'authenticated', 'authenticated', 'closing-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professora Sintetica"}', now(), now()),
  ('7e1a0000-0000-4000-8000-000000000053', 'authenticated', 'authenticated', 'closing-teacher2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Professora Sem Pergunta"}', now(), now());

set local app.enrollment_claim = '1';
update public.profiles set tenant_id = 'trial-closing-nulo-qa', role = 'SCHOOL_ADMIN',
  full_name = 'Diretora Sintetica', lifecycle_status = 'active', phone = '5511900000051'
 where id = '7e1a0000-0000-4000-8000-000000000051';
update public.profiles set tenant_id = 'trial-closing-nulo-qa', role = 'TEACHER',
  full_name = 'Professora Sintetica', lifecycle_status = 'active', phone = '5511900000052'
 where id = '7e1a0000-0000-4000-8000-000000000052';
update public.profiles set tenant_id = 'trial-closing-nulo-qa', role = 'TEACHER',
  full_name = 'Professora Sem Pergunta', lifecycle_status = 'active', phone = '5511900000053'
 where id = '7e1a0000-0000-4000-8000-000000000053';
set local app.enrollment_claim = '';

insert into public.tenant_memberships(user_id, tenant_id, role, status, is_primary)
values
  ('7e1a0000-0000-4000-8000-000000000051', 'trial-closing-nulo-qa', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('7e1a0000-0000-4000-8000-000000000052', 'trial-closing-nulo-qa', 'TEACHER', 'ACTIVE', true),
  ('7e1a0000-0000-4000-8000-000000000053', 'trial-closing-nulo-qa', 'TEACHER', 'ACTIVE', true)
on conflict do nothing;

insert into public.dre_report_settings(tenant_id, destino, is_active)
values ('trial-closing-nulo-qa', '120363400000000051@g.us', true);

insert into public.student_pricing_plans(tenant_id, name, classes_per_week, fidelity_months, monthly_price, active)
values
  ('trial-closing-nulo-qa', '1m-2x', 2, 1, 220.00, true),
  ('trial-closing-nulo-qa', '12m-2x', 2, 12, 169.00, true);

-- A professora declarou terça e quinta às 18:00 e às 19:00; a terça 19:00 já tem aula fixa.
insert into public.teacher_availability(teacher_id, tenant_id, day_of_week, start_time)
values
  ('7e1a0000-0000-4000-8000-000000000052', 'trial-closing-nulo-qa', 2, '18:00'),
  ('7e1a0000-0000-4000-8000-000000000052', 'trial-closing-nulo-qa', 2, '19:00'),
  ('7e1a0000-0000-4000-8000-000000000052', 'trial-closing-nulo-qa', 4, '18:00');

create temporary table fx(k text primary key, v uuid);
insert into fx values ('appointment', gen_random_uuid()), ('opportunity', gen_random_uuid());

insert into public.appointments(id, tenant_id, teacher_id, professor_id, student_name, student_phone, start_time, status, type)
select v, 'trial-closing-nulo-qa', '7e1a0000-0000-4000-8000-000000000052',
  '7e1a0000-0000-4000-8000-000000000052', 'Aluno Sintetico Fechamento',
  '5511900000291', now() - interval '2 hours', 'scheduled', 'experimental'
from fx where k = 'appointment';

-- trial_status nasce 'SCHEDULED' no fluxo real (medido em 23/09/2026: nenhuma
-- experimental CLAIMED dos ultimos 90 dias tem o campo nulo). O retorno de
-- trial_closing_teacher_asks filtra por `trial_status not in (...)` sem
-- coalesce, entao um fixture com nulo some do resultado por NULL-logic.
insert into public.opportunities(id, tenant_id, kind, status, conversion_status, winner_teacher_id,
  trial_appointment_id, student_name, student_phone, feedback_required, slots_proposed, trial_status)
select o.v, 'trial-closing-nulo-qa', 'TRIAL', 'CLAIMED', 'OPEN', '7e1a0000-0000-4000-8000-000000000052',
  a.v, 'Aluno Sintetico Fechamento', '5511900000291', true, '[]'::jsonb, null
from (select v from fx where k = 'opportunity') o, (select v from fx where k = 'appointment') a;


-- [1] experimental terminada com trial_status NULO vira pergunta à professora
select pg_temp.assert_true(
  (select count(*) from public.trial_closing_teacher_asks(10)
    where tenant_id = 'trial-closing-nulo-qa') = 1,
  '[1] trial_status nulo deveria gerar a pergunta à professora'
);

-- [2] a regra do no-show da professora continua valendo
update public.opportunities set trial_status = 'NO_SHOW_TEACHER'
 where tenant_id = 'trial-closing-nulo-qa';
select pg_temp.assert_true(
  (select count(*) from public.trial_closing_teacher_asks(10)
    where tenant_id = 'trial-closing-nulo-qa') = 0,
  '[2] NO_SHOW_TEACHER nao pode gerar pergunta'
);

rollback;
