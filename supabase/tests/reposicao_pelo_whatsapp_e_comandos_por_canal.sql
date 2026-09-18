-- Etapa 2: o professor remarca reposição pelo WhatsApp (proposta → aplicação
-- agindo como ele, origem whatsapp_professor); grupos por canal são
-- reconhecidos pela autorização de execução e pela inbox; reposição vencida
-- sem lançamento aparece para a cobrança.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.teacher_reschedule_prompt_apply(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.notice_channel_jids(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.reschedule_overdue_rows(text)', 'EXECUTE'),
  'RPCs da etapa 2 executáveis fora do service_role'
);
select pg_temp.assert_true(
  pg_get_functiondef('private.management_group_execution_authorized(text,uuid,text,jsonb,text)'::regprocedure)
    ilike '%management_group_jid_is_authorized%'
  and pg_get_functiondef('private.whatsapp_inbox_remote_jid_is_allowed(text,text)'::regprocedure)
    ilike '%management_group_jid_is_authorized%',
  'autorização de grupo/inbox não reconhece os canais'
);

insert into public.tenants (id, name) values ('reposicao-zap-school', 'Reposicao Zap School') on conflict (id) do nothing;
update public.tenants set saas_status = 'active' where id = 'reposicao-zap-school';

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000d101', 'authenticated', 'authenticated', 'rz-admin@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Diretora RZ"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d111', 'authenticated', 'authenticated', 'rz-prof@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Prof Zap"}', now(), now()),
  ('00000000-0000-4000-8000-00000000d121', 'authenticated', 'authenticated', 'rz-aluno@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Theo Reposto"}', now(), now());

update public.profiles set tenant_id = 'reposicao-zap-school', role = 'SCHOOL_ADMIN', lifecycle_status = 'active', phone = '11988880041' where id = '00000000-0000-4000-8000-00000000d101';
update public.profiles set tenant_id = 'reposicao-zap-school', role = 'TEACHER', lifecycle_status = 'active', hourly_rate = 8, phone = '11988880042' where id = '00000000-0000-4000-8000-00000000d111';
update public.profiles set tenant_id = 'reposicao-zap-school', role = 'STUDENT', lifecycle_status = 'active', status = 'Ativo', phone = '11977770041' where id = '00000000-0000-4000-8000-00000000d121';

insert into public.tenant_memberships (user_id, tenant_id, role, status, is_primary) values
  ('00000000-0000-4000-8000-00000000d101', 'reposicao-zap-school', 'SCHOOL_ADMIN', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d111', 'reposicao-zap-school', 'TEACHER', 'ACTIVE', true),
  ('00000000-0000-4000-8000-00000000d121', 'reposicao-zap-school', 'STUDENT', 'ACTIVE', true)
on conflict (user_id, tenant_id) do update set role = excluded.role, status = excluded.status, is_primary = excluded.is_primary;

-- Duas reposições do aluno com o professor: uma marcada para ontem (vencida,
-- sem lançamento) e uma sem data.
insert into public.reschedules (id, tenant_id, teacher_id, student_id, date, time, fault_type) values
  ('00000000-0000-4000-8000-00000000d1a1', 'reposicao-zap-school', '00000000-0000-4000-8000-00000000d111', '00000000-0000-4000-8000-00000000d121',
   to_char((now() at time zone 'America/Sao_Paulo')::date - 1, 'YYYY-MM-DD'), '10:00', 'STUDENT'),
  ('00000000-0000-4000-8000-00000000d1a2', 'reposicao-zap-school', '00000000-0000-4000-8000-00000000d111', '00000000-0000-4000-8000-00000000d121',
   'Pendente', 'Pendente', 'STUDENT');

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- Vencida: a de ontem, sem lançamento.
select pg_temp.assert_true(
  (select jsonb_array_length(public.reschedule_overdue_rows('reposicao-zap-school'))) = 1
  and (public.reschedule_overdue_rows('reposicao-zap-school') -> 0 ->> 'reschedule_id') = '00000000-0000-4000-8000-00000000d1a1',
  'reschedule_overdue_rows não devolveu a reposição vencida'
);

-- Candidatos pelo nome: "theo" acha o aluno, com a marcada e a sem data.
select pg_temp.assert_true(
  (select jsonb_array_length(c -> 0 -> 'matches' -> 0 -> 'reschedules')
     from public.teacher_reschedule_candidates('reposicao-zap-school', '00000000-0000-4000-8000-00000000d111', '["theo"]'::jsonb) c) = 2,
  'teacher_reschedule_candidates não achou as duas reposições do Theo'
);

-- Proposta pelo WhatsApp: marcar a sem data para daqui a 3 dias; aplicar com motivo.
create temp table prompt as
select public.teacher_reschedule_prompt_open('reposicao-zap-school', '00000000-0000-4000-8000-00000000d111', '5511988880042',
  jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
    'action', 'marcar', 'reschedule_id', '00000000-0000-4000-8000-00000000d1a2',
    'date', to_char((now() at time zone 'America/Sao_Paulo')::date + 3, 'YYYY-MM-DD'), 'time', '15:00', 'student_name', 'Theo Reposto')),
    'reason', null)) as id;
select pg_temp.assert_true(
  (select (public.teacher_reschedule_prompt_pending('reposicao-zap-school', '00000000-0000-4000-8000-00000000d111') ->> 'id')::uuid) = (select id from prompt),
  'proposta pendente não encontrada'
);
select pg_temp.assert_true(
  (select (public.teacher_reschedule_prompt_apply(id, 'sim, aluno pediu') ->> 'ok')::boolean from prompt),
  'aplicação da proposta falhou'
);
reset role;

select pg_temp.assert_true(
  (select date || ' ' || time from public.reschedules where id = '00000000-0000-4000-8000-00000000d1a2')
    = to_char((now() at time zone 'America/Sao_Paulo')::date + 3, 'YYYY-MM-DD') || ' 15:00',
  'a reposição não ficou marcada pela proposta'
);
select pg_temp.assert_true(
  (select action || '/' || source || '/' || coalesce(reason, '') from public.reschedule_events
    where reschedule_id = '00000000-0000-4000-8000-00000000d1a2' order by created_at desc limit 1)
    = 'marcada/whatsapp_professor/sim, aluno pediu',
  'evento da marcação pelo WhatsApp sem origem whatsapp_professor ou sem motivo'
);
select pg_temp.assert_true(
  (select status from public.teacher_reschedule_prompts where id = (select id from prompt)) = 'APPLIED',
  'proposta não ficou APPLIED'
);

-- Grupo por canal: configurado → autorizado para comandos e para a inbox.
select pg_temp.assert_true(
  not private.management_group_jid_is_authorized('reposicao-zap-school', '120363000000000555@g.us'),
  'grupo desconhecido apareceu como autorizado'
);
insert into public.tenant_notice_channels (tenant_id, channel, group_jid) values ('reposicao-zap-school', 'coordenacao', '120363000000000555@g.us');
select pg_temp.assert_true(
  private.management_group_jid_is_authorized('reposicao-zap-school', '120363000000000555@g.us')
  and private.whatsapp_inbox_remote_jid_is_allowed('reposicao-zap-school', '120363000000000555@g.us'),
  'grupo de coordenação configurado não foi autorizado'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select pg_temp.assert_true(
  (public.notice_channel_jids('reposicao-zap-school') ->> 'coordenacao') = '120363000000000555@g.us',
  'notice_channel_jids não devolveu o grupo de coordenação'
);
reset role;

rollback;
