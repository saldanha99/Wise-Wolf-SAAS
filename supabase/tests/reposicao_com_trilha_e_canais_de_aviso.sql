-- Reposição com trilha: toda marcação/remarcação/desmarcação vira evento com
-- ator, origem e motivo, e enfileira o aviso ao canal de coordenação e à
-- família. Remarcar exige motivo. Reposição de falta do professor dada por
-- outro professor só paga com atestado da direção — e o atestado é do servidor.
--
-- Caso real (18/09/2026): a reposição do Flávio "marcada para hoje" nunca
-- existiu no sistema; 122 das 138 reposições de 60 dias seguem sem data.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
create or replace function pg_temp.expect_error(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'assertion failed: esperava o erro % e não houve erro', p_msg;
exception when others then
  if sqlerrm <> p_msg then raise exception 'assertion failed: esperava % e veio %', p_msg, sqlerrm; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;
grant execute on function pg_temp.expect_error(text, text) to anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.schedule_reschedule(uuid,date,time without time zone,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.attest_teacher_fault_reschedule(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.save_notice_channel(text,text)', 'EXECUTE'),
  'RPCs de reposição/canais executáveis por anon'
);
select pg_temp.assert_true(
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'schedule_reschedule' and p.pronargs = 3),
  'schedule_reschedule de 3 argumentos ainda existe (ambiguidade no PostgREST)'
);
select pg_temp.assert_true(
  pg_get_functiondef('public.coverage_briefing_enqueue(uuid,boolean)'::regprocedure) ilike '%tenant_notice_destination%'
  and pg_get_functiondef('public.care_set_reschedule_slot(text,uuid,uuid,date,text)'::regprocedure) ilike '%whatsapp_aluno%',
  'coverage_briefing_enqueue/care_set_reschedule_slot sem o roteamento por canal / origem'
);

insert into public.tenants (id, name) values ('reposicao-trilha-school', 'Reposicao Trilha School') on conflict (id) do nothing;
update public.tenants set saas_status = 'active' where id = 'reposicao-trilha-school';

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000d001', 'authenticated', 'authenticated', 'rt-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora RT"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d011', 'authenticated', 'authenticated', 'rt-prof@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Titular"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d012', 'authenticated', 'authenticated', 'rt-substituta@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Substituta"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d021', 'authenticated', 'authenticated', 'rt-aluno@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Aluno Reposto"}', now(), now());

update public.profiles set tenant_id = 'reposicao-trilha-school', role = 'SCHOOL_ADMIN', lifecycle_status = 'active', phone = '11988880031' where id = '00000000-0000-4000-8000-00000000d001';
update public.profiles set tenant_id = 'reposicao-trilha-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 8, phone = '11988880032' where id in ('00000000-0000-4000-8000-00000000d011', '00000000-0000-4000-8000-00000000d012');
update public.profiles set tenant_id = 'reposicao-trilha-school', role = 'STUDENT', lifecycle_status = 'active', status = 'Ativo', phone = '11977770031' where id = '00000000-0000-4000-8000-00000000d021';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000d001', 'reposicao-trilha-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d011', 'reposicao-trilha-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d012', 'reposicao-trilha-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d021', 'reposicao-trilha-school', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

-- Reposição de falta do TITULAR, atribuída à SUBSTITUTA, ainda sem data.
insert into public.reschedules (id, tenant_id, teacher_id, student_id, date, time, fault_type)
values ('00000000-0000-4000-8000-00000000d0a1', 'reposicao-trilha-school', '00000000-0000-4000-8000-00000000d012',
        '00000000-0000-4000-8000-00000000d021', 'Pendente', 'Pendente', 'TEACHER');
select pg_temp.assert_true(
  (select action from public.reschedule_events where reschedule_id = '00000000-0000-4000-8000-00000000d0a1') = 'criada',
  'nascimento da reposição não virou evento "criada"'
);

-- Direção configura o grupo de coordenação: é para lá que o aviso vai.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000d001","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.assert_true(
  (public.save_notice_channel('coordenacao', '120363000000000777@g.us') ->> 'effective_jid') = '120363000000000777@g.us',
  'save_notice_channel não gravou o grupo de coordenação'
);
select pg_temp.assert_true(
  (select jsonb_array_length(public.get_notice_channels())) = 4
  and (select c ->> 'fallback' from jsonb_array_elements(public.get_notice_channels()) c where c ->> 'channel' = 'coordenacao') = 'configurado',
  'get_notice_channels não lista os 4 canais com o de coordenação configurado'
);
reset role;

-- A substituta marca (sem motivo: marcar não exige) → evento + aviso ao grupo + família.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000d012","role":"authenticated"}', true);
set local role authenticated;
select public.schedule_reschedule('00000000-0000-4000-8000-00000000d0a1',
  ((now() at time zone 'America/Sao_Paulo')::date + 3), '15:00');
select pg_temp.assert_true(
  (select action || '/' || source from public.reschedule_events
    where reschedule_id = '00000000-0000-4000-8000-00000000d0a1' order by created_at desc limit 1) = 'marcada/app',
  'marcação pela tela não virou evento marcada/app'
);
-- Remarcar sem motivo é recusado; com motivo, vira "remarcada" com o motivo.
select pg_temp.expect_error(
  $q$select public.schedule_reschedule('00000000-0000-4000-8000-00000000d0a1', ((now() at time zone 'America/Sao_Paulo')::date + 4), '16:00')$q$,
  'motivo_obrigatorio');
select public.schedule_reschedule('00000000-0000-4000-8000-00000000d0a1',
  ((now() at time zone 'America/Sao_Paulo')::date + 4), '16:00', 'aluno pediu');
select pg_temp.assert_true(
  (select action || '/' || coalesce(reason, '') || '/' || from_time || '>' || to_time from public.reschedule_events
    where reschedule_id = '00000000-0000-4000-8000-00000000d0a1' order by created_at desc limit 1) = 'remarcada/aluno pediu/15:00>16:00',
  'remarcação não guardou motivo e de→para'
);
-- Professora não atesta a própria reposição.
select pg_temp.expect_error(
  $q$select public.attest_teacher_fault_reschedule('00000000-0000-4000-8000-00000000d0a1', 'eu mesma')$q$,
  'sem_permissao');
reset role;

-- Avisos: um por evento para o grupo configurado e um para a família.
select pg_temp.assert_true(
  (select count(*) from public.notification_queue q
    where q.tenant_id = 'reposicao-trilha-school' and q.idempotency_key like 'reschedule-event:%:group'
      and q.student_phone = '120363000000000777@g.us') = 2
  and (select count(*) from public.notification_queue q
    where q.tenant_id = 'reposicao-trilha-school' and q.idempotency_key like 'reschedule-event:%:family'
      and q.student_phone = '5511977770031') = 2,
  'avisos de marcação/remarcação não foram para o grupo de coordenação e para a família'
);
select pg_temp.assert_true(
  exists (select 1 from public.notification_queue q
           where q.tenant_id = 'reposicao-trilha-school' and q.idempotency_key like 'reschedule-event:%:group'
             and q.message_body like '%Reposição remarcada%' and q.message_body like '%motivo: aluno pediu%'),
  'linha do grupo sem o motivo da remarcação'
);

-- Sem atestado, a reposição de falta do professor dada pela substituta NÃO paga.
select pg_temp.assert_true(
  not private.teacher_reschedule_financial_origin_is_proven('00000000-0000-4000-8000-00000000d0a1', 'reposicao-trilha-school',
    '00000000-0000-4000-8000-00000000d012', '00000000-0000-4000-8000-00000000d021'),
  'reposição de falta do professor dada por outro apareceu como provada sem atestado'
);
-- Direção não grava o atestado na mão (é do servidor), mas atesta pela RPC.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000d001","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_error(
  $q$update public.reschedules set attested_by = '00000000-0000-4000-8000-00000000d001' where id = '00000000-0000-4000-8000-00000000d0a1'$q$,
  'reschedule_attestation_is_server_only');
select public.attest_teacher_fault_reschedule('00000000-0000-4000-8000-00000000d0a1', 'titular doente; substituta deu a reposição');
reset role;
select pg_temp.assert_true(
  private.teacher_reschedule_financial_origin_is_proven('00000000-0000-4000-8000-00000000d0a1', 'reposicao-trilha-school',
    '00000000-0000-4000-8000-00000000d012', '00000000-0000-4000-8000-00000000d021')
  and (select action from public.reschedule_events where reschedule_id = '00000000-0000-4000-8000-00000000d0a1' order by created_at desc limit 1) = 'atestada',
  'atestado da direção não provou a reposição / não virou evento'
);

-- Desmarcar exige motivo e volta para Pendente.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000d012","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect_error(
  $q$select public.unschedule_reschedule('00000000-0000-4000-8000-00000000d0a1', '')$q$, 'motivo_obrigatorio');
select public.unschedule_reschedule('00000000-0000-4000-8000-00000000d0a1', 'aluno viajou');
reset role;
select pg_temp.assert_true(
  (select date from public.reschedules where id = '00000000-0000-4000-8000-00000000d0a1') = 'Pendente'
  and (select action from public.reschedule_events where reschedule_id = '00000000-0000-4000-8000-00000000d0a1' order by created_at desc limit 1) = 'desmarcada',
  'desmarcar não voltou para Pendente com evento'
);

-- Passivo por professor: a reposição está sem data outra vez.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000d001","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.assert_true(
  (select (x ->> 'sem_data')::int from jsonb_array_elements(public.reschedule_backlog_summary('reposicao-trilha-school')) x
    where x ->> 'teacher_id' = '00000000-0000-4000-8000-00000000d012') = 1,
  'reschedule_backlog_summary não contou a reposição sem data'
);
reset role;

rollback;
