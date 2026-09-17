-- Renovação com novas condições e horário.
--
-- O que este teste segura (caso real de 15/09/2026: 5x por R$ 377 → 3x por
-- R$ 261 em horários novos, aluna suspensa):
-- [1] proposta com condições novas nasce; a proposta "igual ao perfil" continua recusando mudança;
-- [2] oferta superada é cancelada com evento e não assina mais;
-- [3] horário com choque na agenda do professor é recusado;
-- [4] a página pública mostra o horário;
-- [5] aluna suspensa assina: perfil passa a 3x/R$ 261/dia 15, agenda fica guardada, Gestão avisada;
-- [6] reativou: a agenda assinada nasce sozinha, e só uma vez.

\set ON_ERROR_STOP on

begin;

-- No release todos os testes rodam numa transação só, e um teste anterior deixa
-- `request.headers` vazio; `sign_student_course_renewal` faz `::json` dele. Em
-- produção o PostgREST sempre preenche o cabeçalho.
select set_config('request.headers', '{}', true);

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;

insert into public.tenants(id, name, slug, saas_status, whatsapp_enabled)
values ('renewal-change-qa', 'Renewal Change QA', 'renewal-change-qa', 'active', true);
insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('7e180000-0000-4000-8000-000000000021', 'authenticated', 'authenticated', 'renewal-change-student@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluna Renovacao Sintetica"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000022', 'authenticated', 'authenticated', 'renewal-change-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Sintetica Renovacao"}', now(), now()),
  ('7e180000-0000-4000-8000-000000000023', 'authenticated', 'authenticated', 'renewal-change-other@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Vizinho Sintetico"}', now(), now());
set local app.enrollment_claim = '1';
update public.profiles set tenant_id = 'renewal-change-qa', role = 'STUDENT', full_name = 'Aluna Renovacao Sintetica',
  status = 'Inativo', lifecycle_status = 'suspended', monthly_fee = 377, class_frequency = '5x', due_day = 12,
  contract_accepted = true, asaas_customer_id = 'cus_renewal_change_synthetic'
 where id = '7e180000-0000-4000-8000-000000000021';
update public.profiles set tenant_id = 'renewal-change-qa', role = 'TEACHER', full_name = 'Teacher Sintetica Renovacao', lifecycle_status = 'active'
 where id = '7e180000-0000-4000-8000-000000000022';
update public.profiles set tenant_id = 'renewal-change-qa', role = 'STUDENT', full_name = 'Aluno Vizinho Sintetico', status = 'Ativo', lifecycle_status = 'active'
 where id = '7e180000-0000-4000-8000-000000000023';
set local app.enrollment_claim = '';
insert into public.dre_report_settings(tenant_id, destino, is_active) values ('renewal-change-qa', '120363400000000021@g.us', true);
insert into public.bookings(tenant_id, teacher_id, student_id, day_of_week, time_slot, status)
values ('renewal-change-qa', '7e180000-0000-4000-8000-000000000022', '7e180000-0000-4000-8000-000000000023', 'Quinta', '14:30', 'SCHEDULED');

-- [1] O caminho antigo continua recusando mudança; o novo aceita com aprovação.
do $$ begin
  perform private.register_student_course_renewal_proposal('renewal-change-qa', '7e180000-0000-4000-8000-000000000021',
    26100, 3::smallint, 15::smallint, 'Tentativa de mudar condições pelo caminho antigo', repeat('a', 64));
  raise exception 'assertion failed: proposta antiga aceitou condições diferentes do perfil';
exception when raise_exception then
  if sqlerrm not like 'renewal_%_changed' then raise; end if;
end $$;

create temporary table ids(k text primary key, v jsonb);
insert into ids select 'old', private.issue_student_course_renewal_offer(
  private.register_student_course_renewal_proposal('renewal-change-qa', '7e180000-0000-4000-8000-000000000021',
    37700, 5::smallint, 12::smallint, 'Renovação nas condições atuais (será superada)', repeat('b', 64)),
  (now() at time zone 'America/Sao_Paulo')::date + 1, (now() at time zone 'America/Sao_Paulo')::date - 3,
  'CREATE_NEW', 'cus_renewal_change_synthetic', null, 'PIX');
insert into ids select 'new', private.issue_student_course_renewal_offer(
  private.register_student_course_renewal_change_proposal('renewal-change-qa', '7e180000-0000-4000-8000-000000000021',
    26100, 3::smallint, 15::smallint, 'Direção aprovou 3x por R$ 261 em horários novos', repeat('c', 64)),
  (now() at time zone 'America/Sao_Paulo')::date + 1, (now() at time zone 'America/Sao_Paulo')::date - 3,
  'CREATE_NEW', 'cus_renewal_change_synthetic', null, 'PIX');

-- [2] A oferta superada sai de circulação.
select private.cancel_student_course_renewal_offer((select (v->>'id')::uuid from ids where k = 'old'), 'Superada por novas condições');
select pg_temp.assert_true((select status = 'CANCELLED' and cancelled_at is not null from private.student_course_renewal_offers
  where id = (select (v->>'id')::uuid from ids where k = 'old')), 'oferta superada não foi cancelada');
select pg_temp.assert_true((select public.sign_student_course_renewal(v->>'token', 'Aluna Renovacao Sintetica',
  (now() at time zone 'America/Sao_Paulo')::date + 1)->>'ok' = 'false' from ids where k = 'old'),
  'oferta cancelada ainda aceita assinatura');
select pg_temp.assert_true((select public.get_student_course_renewal_public(v->>'token')->>'ok' = 'false' from ids where k = 'old'),
  'oferta cancelada ainda abre na página pública');

-- [3] Choque: quinta 14:30 já é do aluno vizinho com a mesma teacher.
do $$ begin
  perform private.set_student_course_renewal_offer_schedule((select (v->>'id')::uuid from ids where k = 'new'),
    '7e180000-0000-4000-8000-000000000022', '[{"day":"Segunda","time":"14:00"},{"day":"Terça","time":"14:30"},{"day":"Quinta","time":"14:30"}]');
  raise exception 'assertion failed: horário com choque foi aceito';
exception when raise_exception then
  if sqlerrm not like 'renewal_schedule_conflict%' then raise; end if;
end $$;
select private.set_student_course_renewal_offer_schedule((select (v->>'id')::uuid from ids where k = 'new'),
  '7e180000-0000-4000-8000-000000000022', '[{"day":"segunda","time":"14:00"},{"day":"terca","time":"14:30"},{"day":"Sexta","time":"14:30"}]');

-- [4] A página pública mostra o horário que será assinado.
select pg_temp.assert_true((select jsonb_array_length(public.get_student_course_renewal_public(v->>'token')->'data'->'schedule'->'slots') = 3
  and public.get_student_course_renewal_public(v->>'token')->'data'->'schedule'->>'teacher_first_name' = 'Teacher'
  from ids where k = 'new'), 'página pública não mostra o horário');

-- [5] Assinatura com aluna suspensa.
select pg_temp.assert_true((select public.sign_student_course_renewal(v->>'token', 'Aluna Renovacao Sintetica',
  (now() at time zone 'America/Sao_Paulo')::date + 1)->>'ok' = 'true' from ids where k = 'new'),
  'assinatura da nova oferta falhou');
select pg_temp.assert_true((select monthly_fee = 261 and class_frequency = '3x' and due_day = extract(day from (now() at time zone 'America/Sao_Paulo')::date + 1)
  from public.profiles where id = '7e180000-0000-4000-8000-000000000021') or extract(day from (now() at time zone 'America/Sao_Paulo')::date + 1) > 28,
  'perfil não passou às condições assinadas');
select pg_temp.assert_true(not exists (select 1 from public.bookings where student_id = '7e180000-0000-4000-8000-000000000021'),
  'agenda nasceu para aluna suspensa');
select pg_temp.assert_true(exists (select 1 from private.student_course_renewal_events
  where offer_id = (select (v->>'id')::uuid from ids where k = 'new') and event_type = 'SCHEDULE_PENDING_REACTIVATION'),
  'agenda pendente não ficou registrada');
select pg_temp.assert_true(exists (select 1 from public.notification_queue
  where tenant_id = 'renewal-change-qa' and student_phone = '120363400000000021@g.us'
    and message_body like '%RENOVAÇÃO ASSINADA%' and message_body like '%R$ 261,00%' and message_body like '%reative%'),
  'Gestão não foi avisada da assinatura');

-- [6] Reativação cria a agenda assinada, uma vez só.
set local app.enrollment_claim = '1';
update public.profiles set lifecycle_status = 'active', status = 'Ativo' where id = '7e180000-0000-4000-8000-000000000021';
update public.profiles set status = 'Ativo', lifecycle_status = 'active' where id = '7e180000-0000-4000-8000-000000000021';
set local app.enrollment_claim = '';
select pg_temp.assert_true((select count(*) = 3 from public.bookings
  where student_id = '7e180000-0000-4000-8000-000000000021' and status = 'SCHEDULED'
    and teacher_id = '7e180000-0000-4000-8000-000000000022'
    and start_date >= (now() at time zone 'America/Sao_Paulo')::date + 1),
  'reativação não criou exatamente as 3 aulas assinadas');
select pg_temp.assert_true((select schedule_applied_at is not null from private.student_course_renewal_offers
  where id = (select (v->>'id')::uuid from ids where k = 'new')), 'oferta não marcou a agenda como aplicada');
select pg_temp.assert_true(exists (select 1 from public.notification_queue
  where tenant_id = 'renewal-change-qa' and message_body like '%AGENDA DA RENOVAÇÃO%'), 'Gestão não soube da agenda criada');

rollback;
