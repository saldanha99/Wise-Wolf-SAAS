-- A experimental é uma entidade com histórico, não um agendamento solto.
--
-- [1] pedido de remarcação sem horário vira ESTADO (trial_status RESCHEDULED)
--     e entra no histórico — era o buraco que deixou a aula da Ana Carolina de
--     pé na agenda da professora depois de ela avisar que não vinha;
-- [2] o histórico guarda origem e motivo;
-- [3] experimental já encerrada não reabre por pedido de remarcação;
-- [4] pedir duas vezes não duplica;
-- [5] o desfecho pela RPC existente também entra no histórico (trigger);
-- [6] a sala do professor é carimbada na aula e SOBREVIVE à mudança de horário;
-- [7] professor não mexe no ciclo da experimental.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

insert into public.tenants(id, name) values ('exp-hist-qa', 'Experimental Historico QA');

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000ea01','authenticated','authenticated','exp-diretora@example.invalid',
   '{"provider":"email","providers":["email"]}','{"test_fixture":true}', now(), now()),
  ('00000000-0000-4000-8000-00000000ea02','authenticated','authenticated','exp-teacher@example.invalid',
   '{"provider":"email","providers":["email"]}','{"test_fixture":true}', now(), now());

update public.profiles set tenant_id='exp-hist-qa', role='SCHOOL_ADMIN',
       full_name='Diretora Experimental', status='Ativo'
 where id='00000000-0000-4000-8000-00000000ea01';
update public.profiles set tenant_id='exp-hist-qa', role='TEACHER',
       full_name='Teacher Experimental', status='Ativo',
       meeting_link='https://meet.example.invalid/sala-da-teacher'
 where id='00000000-0000-4000-8000-00000000ea02';

insert into public.appointments(id, tenant_id, teacher_id, professor_id, student_name,
  student_phone, start_time, status, type)
values ('00000000-0000-4000-8000-00000000eaa1','exp-hist-qa',
  '00000000-0000-4000-8000-00000000ea02','00000000-0000-4000-8000-00000000ea02',
  'Lead Sintetico','5511900000777', now() + interval '6 hours', 'scheduled', 'experimental');

insert into public.opportunities(id, tenant_id, kind, status, conversion_status,
  winner_teacher_id, trial_appointment_id, student_name, student_phone, trial_status, slots_proposed)
values ('00000000-0000-4000-8000-00000000eab1','exp-hist-qa','TRIAL','CLAIMED','OPEN',
  '00000000-0000-4000-8000-00000000ea02','00000000-0000-4000-8000-00000000eaa1',
  'Lead Sintetico','5511900000777','SCHEDULED','[]'::jsonb);

-- [6] a sala do professor foi carimbada no insert
select pg_temp.assert_true(
  (select meeting_link = 'https://meet.example.invalid/sala-da-teacher'
     from public.appointments where id='00000000-0000-4000-8000-00000000eaa1'),
  '[6] a aula nasceu sem a sala do professor'
);

-- [1] e [2] pedido de remarcação sem horário
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ea01","role":"authenticated"}';
set local role authenticated;
select pg_temp.assert_true(
  (public.open_trial_reschedule_request('00000000-0000-4000-8000-00000000eab1'::uuid,
     'nao vou conseguir hoje', 'whatsapp_lead') ->> 'ok')::boolean,
  '[1] pedido de remarcação foi recusado'
);
-- [4] pedir de novo não duplica
select pg_temp.assert_true(
  (public.open_trial_reschedule_request('00000000-0000-4000-8000-00000000eab1'::uuid,
     'de novo', 'whatsapp_lead') ->> 'already')::boolean,
  '[4] pedido repetido criou um segundo registro'
);
reset role;

select pg_temp.assert_true(
  (select trial_status = 'RESCHEDULED' from public.opportunities
    where id='00000000-0000-4000-8000-00000000eab1'),
  '[1] a experimental não ficou sinalizada como em remarcação'
);
select pg_temp.assert_true(
  (select count(*) from public.trial_appointment_history
    where opportunity_id='00000000-0000-4000-8000-00000000eab1'
      and action='remarcacao_pedida') = 1,
  '[1] o pedido não entrou no histórico (ou entrou duas vezes)'
);
select pg_temp.assert_true(
  (select source='whatsapp_lead' and reason='nao vou conseguir hoje'
     from public.trial_appointment_history
    where opportunity_id='00000000-0000-4000-8000-00000000eab1'
      and action='remarcacao_pedida'),
  '[2] o histórico perdeu origem ou motivo'
);

-- [6] mudar o horário NÃO derruba a sala
update public.appointments set start_time = now() + interval '30 hours'
 where id='00000000-0000-4000-8000-00000000eaa1';
select pg_temp.assert_true(
  (select meeting_link = 'https://meet.example.invalid/sala-da-teacher'
     from public.appointments where id='00000000-0000-4000-8000-00000000eaa1'),
  '[6] a remarcação apagou a sala da aula'
);

-- [5] o desfecho entra no histórico pelo trigger, venha de onde vier
update public.opportunities set trial_status='DONE'
 where id='00000000-0000-4000-8000-00000000eab1';
select pg_temp.assert_true(
  (select count(*) from public.trial_appointment_history
    where opportunity_id='00000000-0000-4000-8000-00000000eab1'
      and action='realizada') = 1,
  '[5] o desfecho não entrou no histórico'
);

-- [3] encerrada não reabre
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ea01","role":"authenticated"}';
set local role authenticated;
do $$
declare bloqueado boolean := false;
begin
  begin
    perform public.open_trial_reschedule_request('00000000-0000-4000-8000-00000000eab1'::uuid, 'tarde demais', 'app');
  exception when others then bloqueado := true;
  end;
  perform pg_temp.assert_true(bloqueado, '[3] experimental encerrada aceitou pedido de remarcação');
end $$;
reset role;

-- [7] professor não mexe no ciclo
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000ea02","role":"authenticated"}';
set local role authenticated;
do $$
declare bloqueado boolean := false;
begin
  begin
    perform public.open_trial_reschedule_request('00000000-0000-4000-8000-00000000eab1'::uuid, 'quero mudar', 'app');
  exception when others then bloqueado := true;
  end;
  perform pg_temp.assert_true(bloqueado, '[7] professor conseguiu mexer no ciclo da experimental');
end $$;
reset role;

rollback;
