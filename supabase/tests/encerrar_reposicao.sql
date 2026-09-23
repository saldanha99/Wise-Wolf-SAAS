-- close_reschedule: encerrar reposição SEM dar a aula.
--
-- [1] diretor encerra: used_at marcado, motivo gravado, trilha diz 'encerrada'
--     (nunca 'dada' — a aula não aconteceu);
-- [2] professor NÃO pode encerrar;
-- [3] motivo é obrigatório;
-- [4] encerrada some de "em aberto";
-- [5] reposição já consumida por aula não pode ser reescrita como encerrada;
-- [6] ninguém grava closed_by/closed_reason na mão, fora da RPC.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

insert into public.tenants(id, name) values ('encerrar-reposicao-qa', 'Encerrar Reposicao QA');
insert into public.tenant_notice_channels(tenant_id, channel, group_jid)
values ('encerrar-reposicao-qa', 'coordenacao', '120363000000000007@g.us');

insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000ce901','authenticated','authenticated','encerrar-diretor@example.invalid',
   '{"provider":"email","providers":["email"]}','{"test_fixture":true}', now(), now()),
  ('00000000-0000-4000-8000-0000000ce902','authenticated','authenticated','encerrar-prof@example.invalid',
   '{"provider":"email","providers":["email"]}','{"test_fixture":true}', now(), now()),
  ('00000000-0000-4000-8000-0000000ce903','authenticated','authenticated','encerrar-aluno@example.invalid',
   '{"provider":"email","providers":["email"]}','{"test_fixture":true}', now(), now());

update public.profiles set tenant_id='encerrar-reposicao-qa', role='SCHOOL_ADMIN',
       full_name='Diretora Encerrar', status='Ativo'
 where id='00000000-0000-4000-8000-0000000ce901';
update public.profiles set tenant_id='encerrar-reposicao-qa', role='TEACHER',
       full_name='Professor Encerrar', status='Ativo'
 where id='00000000-0000-4000-8000-0000000ce902';
update public.profiles set tenant_id='encerrar-reposicao-qa', role='STUDENT',
       full_name='Aluno Encerrar', status='Ativo',
       professor_id='00000000-0000-4000-8000-0000000ce902'
 where id='00000000-0000-4000-8000-0000000ce903';

insert into public.reschedules(id, tenant_id, teacher_id, student_id, date, time, fault_type)
values ('00000000-0000-4000-8000-0000000ce9a1','encerrar-reposicao-qa',
        '00000000-0000-4000-8000-0000000ce902','00000000-0000-4000-8000-0000000ce903',
        'Pendente','Pendente','STUDENT');

-- [2] professor não encerra
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000ce902","role":"authenticated"}';
do $$
declare bloqueado boolean := false;
begin
  begin
    perform public.close_reschedule('00000000-0000-4000-8000-0000000ce9a1'::uuid, 'quero sumir com isso');
  exception when others then bloqueado := true;
  end;
  perform pg_temp.assert_true(bloqueado, '[2] professor conseguiu encerrar reposição');
end $$;

reset role;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000ce901","role":"authenticated"}';
set local role authenticated;

-- [6] nem a DIREÇÃO grava o encerramento na mão: é campo de servidor, como o
-- atestado. (O professor sequer chega aqui — ele não tem policy de UPDATE em
-- reschedules, então o RLS filtra em silêncio, sem erro.)
do $$
declare bloqueado boolean := false;
begin
  begin
    update public.reschedules set closed_reason = 'na marra'
     where id = '00000000-0000-4000-8000-0000000ce9a1';
  exception when others then bloqueado := true;
  end;
  perform pg_temp.assert_true(bloqueado, '[6] closed_reason foi gravado fora da RPC');
  perform pg_temp.assert_true(
    (select closed_reason is null from public.reschedules
      where id = '00000000-0000-4000-8000-0000000ce9a1'),
    '[6] closed_reason ficou gravado apesar da guarda');
end $$;

-- [3] motivo obrigatório
do $$
declare bloqueado boolean := false;
begin
  begin
    perform public.close_reschedule('00000000-0000-4000-8000-0000000ce9a1'::uuid, '  ');
  exception when others then bloqueado := true;
  end;
  perform pg_temp.assert_true(bloqueado, '[3] encerrou sem motivo');
end $$;

-- [1] diretor encerra
select pg_temp.assert_true(
  (public.close_reschedule('00000000-0000-4000-8000-0000000ce9a1'::uuid,
     'aluno saiu da escola') ->> 'ok')::boolean,
  '[1] diretor não conseguiu encerrar'
);
reset role;

select pg_temp.assert_true(
  (select used_at is not null and closed_reason = 'aluno saiu da escola'
          and closed_by = '00000000-0000-4000-8000-0000000ce901'
     from public.reschedules where id='00000000-0000-4000-8000-0000000ce9a1'),
  '[1] encerramento não gravou used_at/motivo/autor'
);

select pg_temp.assert_true(
  (select count(*) from public.reschedule_events
    where reschedule_id='00000000-0000-4000-8000-0000000ce9a1' and action='encerrada') = 1
  and (select count(*) from public.reschedule_events
    where reschedule_id='00000000-0000-4000-8000-0000000ce9a1' and action='dada') = 0,
  '[1] a trilha registrou a aula como DADA — ela não aconteceu'
);

-- [4] some de "em aberto"
select pg_temp.assert_true(
  (select count(*) from public.reschedules
    where tenant_id='encerrar-reposicao-qa' and used_at is null) = 0,
  '[4] reposição encerrada continua contando como aberta'
);

-- [5] já consumida não vira encerrada
insert into public.reschedules(id, tenant_id, teacher_id, student_id, date, time, fault_type, used_at)
values ('00000000-0000-4000-8000-0000000ce9a2','encerrar-reposicao-qa',
        '00000000-0000-4000-8000-0000000ce902','00000000-0000-4000-8000-0000000ce903',
        'Pendente','Pendente','STUDENT', now());
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000ce901","role":"authenticated"}';
set local role authenticated;
select pg_temp.assert_true(
  (public.close_reschedule('00000000-0000-4000-8000-0000000ce9a2'::uuid,
     'tentando reescrever') ->> 'already')::boolean,
  '[5] reposição já consumida foi reescrita como encerrada'
);
reset role;
select pg_temp.assert_true(
  (select closed_reason is null from public.reschedules
    where id='00000000-0000-4000-8000-0000000ce9a2'),
  '[5] motivo de encerramento entrou numa reposição já dada'
);

rollback;
