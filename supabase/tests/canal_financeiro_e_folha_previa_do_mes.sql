-- Canal financeiro (cai na direção, depois na Gestão), o bot o reconhece,
-- as cercas do outbox de pagamento comparam com o canal de dinheiro, e a folha
-- do mês EM ABERTO sai como prévia (aulas lançadas + ajustes; cobertura sem
-- lançamento sinalizada, não "+R$ 0,00").

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

-- Privilégios: prévia só para quem está logado como direção; resumo do grupo só service_role.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.payroll_month_preview(text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.payroll_month_preview(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.gestao_payroll_summary(text,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.gestao_payroll_summary(text,text)', 'EXECUTE'),
  'privilégios das RPCs de folha'
);

-- As cercas do outbox de aviso de pagamento comparam com o canal de dinheiro.
select pg_temp.assert_true(
  pg_get_functiondef('public.begin_management_payment_notification_submission'::regproc)
    ilike '%tenant_notice_destination(v_outbox.tenant_id, ''financeiro'')%'
  and pg_get_functiondef('public.authorize_management_payment_notification_submission'::regproc)
    ilike '%tenant_notice_destination(v_outbox.tenant_id, ''financeiro'')%',
  'cercas do outbox ainda comparam com o grupo da Gestão'
);

insert into public.tenants (id, name) values ('financeiro-school', 'Financeiro School') on conflict (id) do nothing;
update public.tenants set saas_status = 'active' where id = 'financeiro-school';

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000f101', 'authenticated', 'authenticated', 'fin-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora Fin"}', now(), now()),
  ('00000000-0000-4000-8000-00000000f111', 'authenticated', 'authenticated', 'fin-prof@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Substituta"}', now(), now()),
  ('00000000-0000-4000-8000-00000000f112', 'authenticated', 'authenticated', 'fin-prof2@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Titular"}', now(), now()),
  ('00000000-0000-4000-8000-00000000f121', 'authenticated', 'authenticated', 'fin-aluno@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Coberto"}', now(), now());

update public.profiles set tenant_id = 'financeiro-school', role = 'SCHOOL_ADMIN', lifecycle_status = 'active', phone = '11988880051' where id = '00000000-0000-4000-8000-00000000f101';
update public.profiles set tenant_id = 'financeiro-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 8, phone = '11988880052' where id = '00000000-0000-4000-8000-00000000f111';
update public.profiles set tenant_id = 'financeiro-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 8, phone = '11988880053' where id = '00000000-0000-4000-8000-00000000f112';
update public.profiles set tenant_id = 'financeiro-school', role = 'STUDENT', lifecycle_status = 'active', status = 'Ativo', phone = '11977770051' where id = '00000000-0000-4000-8000-00000000f121';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000f101', 'financeiro-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000f111', 'financeiro-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000f112', 'financeiro-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000f121', 'financeiro-school', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

-- Grupo da Gestão (fallback final) e canais.
insert into public.dre_report_settings (tenant_id, destino, is_active)
values ('financeiro-school', '120363000000000901@g.us', true)
on conflict (tenant_id) do update set destino = excluded.destino, is_active = true;

-- 1) financeiro sem grupo: cai na Gestão; com direção configurada, cai na direção.
select pg_temp.assert_true(
  private.tenant_notice_destination('financeiro-school', 'financeiro') = '120363000000000901@g.us',
  'financeiro sem canal deveria cair na Gestão'
);
insert into public.tenant_notice_channels (tenant_id, channel, group_jid) values ('financeiro-school', 'direcao', '120363000000000902@g.us');
select pg_temp.assert_true(
  private.tenant_notice_destination('financeiro-school', 'financeiro') = '120363000000000902@g.us',
  'financeiro sem canal deveria cair na Direção configurada'
);

-- 2) A direção salva o canal financeiro pela RPC.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000f101","role":"authenticated"}';
select pg_temp.assert_true(
  (public.save_notice_channel('financeiro', '120363000000000903@g.us') ->> 'effective_jid') = '120363000000000903@g.us',
  'save_notice_channel não aceitou o canal financeiro'
);
select pg_temp.assert_true(
  (select count(*) from jsonb_array_elements(public.get_notice_channels()) c where c ->> 'channel' = 'financeiro' and c ->> 'fallback' = 'configurado') = 1
  and (select count(*) from jsonb_array_elements(public.get_notice_channels())) = 5,
  'get_notice_channels não lista o canal financeiro configurado'
);
reset role;

-- 3) O bot reconhece o grupo financeiro; o JID sai em notice_channel_jids.
select pg_temp.assert_true(
  private.management_group_jid_is_authorized('financeiro-school', '120363000000000903@g.us')
  and private.whatsapp_inbox_remote_jid_is_allowed('financeiro-school', '120363000000000903@g.us'),
  'grupo financeiro não foi autorizado para o bot'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  (public.notice_channel_jids('financeiro-school') ->> 'financeiro') = '120363000000000903@g.us'
  and (public.notice_channel_destination('financeiro-school', 'financeiro')) = '120363000000000903@g.us',
  'notice_channel_jids/destination não devolveram o grupo financeiro'
);
reset role;

-- 4) Prévia do mês em aberto: a substituta lançou 2 aulas (uma delas cobertura
--    do titular), tem R$ 5 de ajuste e uma cobertura confirmada sem lançamento.
insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, status, start_date)
values
  ('00000000-0000-4000-8000-00000000f1b1', 'financeiro-school', '00000000-0000-4000-8000-00000000f112', '00000000-0000-4000-8000-00000000f121', 'Segunda', '10:00', 'SCHEDULED', '2026-01-05'),
  ('00000000-0000-4000-8000-00000000f1b2', 'financeiro-school', '00000000-0000-4000-8000-00000000f112', '00000000-0000-4000-8000-00000000f121', 'Segunda', '10:30', 'SCHEDULED', '2026-01-05');

-- Cobertura já dada (atestada) das duas metades da aula de 02/03 (segunda):
-- a substituta lançou a primeira; a segunda ficou sem aula lançada.
alter table public.class_coverages disable trigger user;
insert into public.class_coverages (id, tenant_id, original_teacher_id, cover_teacher_id, student_id, booking_id, class_date, class_time, status, confirmed_at, confirmed_by)
values
  ('00000000-0000-4000-8000-00000000f1d1', 'financeiro-school', '00000000-0000-4000-8000-00000000f112', '00000000-0000-4000-8000-00000000f111', '00000000-0000-4000-8000-00000000f121', '00000000-0000-4000-8000-00000000f1b1', '2026-03-02', '10:00', 'confirmed', now(), '00000000-0000-4000-8000-00000000f101'),
  ('00000000-0000-4000-8000-00000000f1d2', 'financeiro-school', '00000000-0000-4000-8000-00000000f112', '00000000-0000-4000-8000-00000000f111', '00000000-0000-4000-8000-00000000f121', '00000000-0000-4000-8000-00000000f1b2', '2026-03-02', '10:30', 'confirmed', now(), '00000000-0000-4000-8000-00000000f101');
alter table public.class_coverages enable trigger user;

-- A aula coberta (origem = booking do titular, aceita porque a cobertura é dela)
-- e uma aula administrativa sem origem (fora da regra de origem, paga pelo override).
insert into public.class_logs (id, tenant_id, teacher_id, student_id, date, class_date, start_time, presence, booking_id, rate_override)
values
  ('00000000-0000-4000-8000-00000000f1c1', 'financeiro-school', '00000000-0000-4000-8000-00000000f111', '00000000-0000-4000-8000-00000000f121', '2026-03-02', '2026-03-02', '10:00', 'COMPLETED', '00000000-0000-4000-8000-00000000f1b1', 8.00),
  ('00000000-0000-4000-8000-00000000f1c2', 'financeiro-school', '00000000-0000-4000-8000-00000000f111', '00000000-0000-4000-8000-00000000f121', '2026-03-09', '2026-03-09', '10:00', 'COMPLETED', null, 8.00);

alter table public.class_coverages disable trigger user;
update public.class_coverages set class_log_id = '00000000-0000-4000-8000-00000000f1c1' where id = '00000000-0000-4000-8000-00000000f1d1';
alter table public.class_coverages enable trigger user;

insert into public.closing_adjustments (tenant_id, teacher_id, month_year, description, amount, created_by)
values ('financeiro-school', '00000000-0000-4000-8000-00000000f111', '2026-03', 'reposição paga por decisão da direção', 5.00, '00000000-0000-4000-8000-00000000f101');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000f101","role":"authenticated"}';
create temp table previa as select public.payroll_month_preview('2026-03') as j;
reset role;

select pg_temp.assert_true((select (j ->> 'ok')::boolean and (j ->> 'previa')::boolean from previa), 'prévia não marcada como mês em aberto');
select pg_temp.assert_true(
  (select t ->> 'status' = 'PREVIA' and (t ->> 'previa')::boolean
          and (t ->> 'lessons')::int = 2 and (t ->> 'amount')::numeric = 21.00
          and (t ->> 'adjustments')::numeric = 5.00
          and (t -> 'received' ->> 'count')::int = 2
          and (t -> 'received' ->> 'pending')::int = 1
          and (t -> 'received' ->> 'amount')::numeric = 8.00
          and (t -> 'received' -> 'items' -> 1 ->> 'logged')::boolean = false
          and (t ->> 'projected')::numeric = 13.00
     from previa, jsonb_array_elements(j -> 'teachers') t
    where t ->> 'teacher_id' = '00000000-0000-4000-8000-00000000f111'),
  'prévia da substituta: 2 aulas, R$ 16 + R$ 5 de ajuste, 1 cobertura sem lançamento'
);
select pg_temp.assert_true(
  (select t ->> 'status' = 'PREVIA' and (t ->> 'lessons')::int = 0 and (t ->> 'amount')::numeric = 0
          and (t -> 'ceded' ->> 'count')::int = 2
     from previa, jsonb_array_elements(j -> 'teachers') t
    where t ->> 'teacher_id' = '00000000-0000-4000-8000-00000000f112'),
  'prévia do titular: 0 aulas, 2 cedidas'
);

-- 5) Com fechamento gerado, a linha volta a ser a folha oficial (não prévia).
insert into public.teacher_closings (tenant_id, teacher_id, month_year, total_lessons, total_amount, status)
values ('financeiro-school', '00000000-0000-4000-8000-00000000f111', '2026-03', 2, 21.00, 'PENDENTE');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  (select t ->> 'status' = 'PENDENTE' and not (t ->> 'previa')::boolean and (t ->> 'amount')::numeric = 21.00
     from jsonb_array_elements(public.gestao_payroll_summary('financeiro-school', '2026-03') -> 'teachers') t
    where t ->> 'teacher_id' = '00000000-0000-4000-8000-00000000f111'),
  'com fechamento, a folha deveria ler teacher_closings'
);
select pg_temp.assert_true(
  (public.gestao_payroll_summary('financeiro-school', '2026-03') ->> 'previa')::boolean,
  'o titular continua sem fechamento — o mês ainda é prévia'
);
reset role;

-- Um professor logado não abre a prévia da escola.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000f111","role":"authenticated"}';
do $$
begin
  perform public.payroll_month_preview('2026-03');
  raise exception 'professor abriu a prévia da folha';
exception when insufficient_privilege then
  null;
end;
$$;
reset role;

rollback;
