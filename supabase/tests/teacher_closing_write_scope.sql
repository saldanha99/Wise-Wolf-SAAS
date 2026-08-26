-- O professor não escreve o próprio fechamento.
--
-- O que importa provar aqui: `auth.uid() = teacher_id` NÃO é autorização
-- suficiente numa tabela de folha. Era o que as policies antigas diziam, e com
-- elas um PATCH direto no PostgREST — sem passar por tela nenhuma — punha
-- R$ 99.999,00 em total_amount e status PAID no próprio fechamento.
--
-- Se alguém recriar policy de INSERT/UPDATE para professor nesta tabela, os
-- casos [1]..[4] voltam a passar e este teste derruba o deploy.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

grant execute on function pg_temp.assert_true(boolean, text) to public;
do $$
begin
  if to_regprocedure('pg_temp.assert_sqlstate(text, text, text)') is not null then
    execute 'grant execute on function pg_temp.assert_sqlstate(text, text, text) to public';
  end if;
end
$$;

insert into public.tenants (id, name)
values ('closing-scope-school', 'Closing Scope School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-000000000941', 'authenticated', 'authenticated',
    'closing-scope-teacher@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Professor Escopo"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-000000000942', 'authenticated', 'authenticated',
    'closing-scope-other@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Professora Vizinha"}', now(), now()
  );

update public.profiles
   set tenant_id = 'closing-scope-school', role = 'TEACHER', full_name = 'Professor Escopo'
 where id = '00000000-0000-4000-8000-000000000941';
update public.profiles
   set tenant_id = 'closing-scope-school', role = 'TEACHER', full_name = 'Professora Vizinha'
 where id = '00000000-0000-4000-8000-000000000942';

-- Fechamento já emitido pela escola: R$ 800,00, aguardando o professor conferir.
insert into public.teacher_closings (
  id, tenant_id, teacher_id, month_year, total_lessons, total_amount, status
)
values
  (
    '00000000-0000-4000-8000-00000000094a', 'closing-scope-school',
    '00000000-0000-4000-8000-000000000941', '2026-07', 100, 800.00, 'PENDENTE'
  ),
  (
    '00000000-0000-4000-8000-00000000094b', 'closing-scope-school',
    '00000000-0000-4000-8000-000000000942', '2026-07', 50, 400.00, 'PENDENTE'
  );

-- ---------------------------------------------------------------------------
-- [A] O que o professor NÃO pode mais fazer
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';

-- [1] inflar o próprio valor
update public.teacher_closings
   set total_amount = 99999.00
 where id = '00000000-0000-4000-8000-00000000094a';

-- [2] se auto-aprovar como pago
update public.teacher_closings
   set status = 'PAGO', paid_at = now()
 where id = '00000000-0000-4000-8000-00000000094a';

-- [3] reescrever o snapshot de aulas
update public.teacher_closings
   set total_lessons = 999, class_log_ids = array[]::uuid[]
 where id = '00000000-0000-4000-8000-00000000094a';

reset role;
select pg_temp.assert_true(
  (select total_amount = 800.00 and total_lessons = 100
          and status = 'PENDENTE' and paid_at is null
     from public.teacher_closings
    where id = '00000000-0000-4000-8000-00000000094a'),
  'UPDATE direto do professor alterou o proprio fechamento'
);

-- [4] fabricar um fechamento inteiro (mês sem linha), já pago
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';
do $$
begin
  insert into public.teacher_closings (
    tenant_id, teacher_id, month_year, total_lessons, total_amount, status
  )
  values (
    'closing-scope-school', '00000000-0000-4000-8000-000000000941',
    '2026-06', 999, 50000.00, 'PAGO'
  );
  raise exception 'assertion failed: professor conseguiu INSERIR fechamento proprio';
exception
  when insufficient_privilege then null;  -- RLS barrou, que é o esperado
end;
$$;

reset role;
select pg_temp.assert_true(
  (select count(*) = 0 from public.teacher_closings
    where teacher_id = '00000000-0000-4000-8000-000000000941' and month_year = '2026-06'),
  'fechamento fabricado pelo professor persistiu'
);

-- ---------------------------------------------------------------------------
-- [B] O que ele CONTINUA precisando fazer
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';

-- Confirma: grava o "confiro" e NÃO encosta no valor emitido pela escola.
select public.teacher_submit_closing('2026-07', 'OK');

reset role;
select pg_temp.assert_true(
  (select teacher_confirmation_status = 'OK' and teacher_confirmation_date is not null
          and total_amount = 800.00 and total_lessons = 100 and status = 'PENDENTE'
     from public.teacher_closings
    where id = '00000000-0000-4000-8000-00000000094a'),
  'confirmacao nao gravou, ou mexeu no valor da escola'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';

-- Contestação sem motivo não serve ao diretor: tem de falhar.
do $$
begin
  perform public.teacher_submit_closing('2026-07', 'CONTESTADO');
  raise exception 'assertion failed: contestacao sem motivo foi aceita';
exception
  when invalid_parameter_value then null;
end;
$$;

select public.teacher_submit_closing('2026-07', 'CONTESTADO', 'Faltam as aulas do dia 12');

reset role;
update public.teacher_closings
   set status = 'PAID_WAITING_NF', paid_at = now()
 where id = '00000000-0000-4000-8000-00000000094a';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';

-- Fechamento alheio continua fora de alcance, mesmo pela RPC.
do $$
begin
  perform public.teacher_attach_invoice(
    '00000000-0000-4000-8000-00000000094b',
    'closings/00000000-0000-4000-8000-00000000094b/00000000-0000-4000-8000-000000000951.pdf');
  raise exception 'assertion failed: professor anexou NF em fechamento alheio';
exception
  when insufficient_privilege then null;
end;
$$;

-- Link com esquema executável não entra (o diretor abre isso como href).
do $$
begin
  perform public.teacher_attach_invoice(
    '00000000-0000-4000-8000-00000000094a', 'javascript:alert(1)');
  raise exception 'assertion failed: nf_link com javascript: foi aceito';
exception
  when invalid_parameter_value then null;
end;
$$;

insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'invoices',
  'closings/00000000-0000-4000-8000-00000000094a/00000000-0000-4000-8000-000000000952.pdf',
  '00000000-0000-4000-8000-000000000941',
  '{"mimetype":"application/pdf"}'
);

select public.teacher_attach_invoice(
  '00000000-0000-4000-8000-00000000094a',
  'closings/00000000-0000-4000-8000-00000000094a/00000000-0000-4000-8000-000000000952.pdf');

reset role;
select pg_temp.assert_true(
  (select teacher_confirmation_status = 'CONTESTADO'
          and teacher_notes = 'Faltam as aulas do dia 12'
          and nf_link = 'closings/00000000-0000-4000-8000-00000000094a/00000000-0000-4000-8000-000000000952.pdf'
          and total_amount = 800.00
     from public.teacher_closings
    where id = '00000000-0000-4000-8000-00000000094a'),
  'contestacao/NF nao gravaram, ou o valor da escola foi tocado'
);

select pg_temp.assert_true(
  (select total_amount = 400.00 from public.teacher_closings
    where id = '00000000-0000-4000-8000-00000000094b'),
  'fechamento da outra professora foi alterado'
);

-- ---------------------------------------------------------------------------
-- [B2] Rejeicao da nota: o motivo chega ao professor e nao sobrevive ao reenvio
-- ---------------------------------------------------------------------------

-- O diretor rejeita. Antes da coluna existir, este UPDATE falhava inteiro e
-- NENHUMA rejeicao de NF era registrada.
update public.teacher_closings
   set status = 'REJECTED', rejection_reason = 'Valor da nota nao confere com o pago'
 where id = '00000000-0000-4000-8000-00000000094a';

select pg_temp.assert_true(
  (select rejection_reason = 'Valor da nota nao confere com o pago'
     from public.teacher_closings
    where id = '00000000-0000-4000-8000-00000000094a'),
  'motivo da rejeicao nao foi gravado'
);

-- Professor reenvia a nota corrigida: volta para analise e o motivo antigo sai.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000941","role":"authenticated"}';
insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'invoices',
  'closings/00000000-0000-4000-8000-00000000094a/00000000-0000-4000-8000-000000000953.pdf',
  '00000000-0000-4000-8000-000000000941',
  '{"mimetype":"application/pdf"}'
);
select public.teacher_attach_invoice(
  '00000000-0000-4000-8000-00000000094a',
  'closings/00000000-0000-4000-8000-00000000094a/00000000-0000-4000-8000-000000000953.pdf');
reset role;

select pg_temp.assert_true(
  (select status = 'UNDER_REVIEW' and rejection_reason is null
          and nf_link = 'closings/00000000-0000-4000-8000-00000000094a/00000000-0000-4000-8000-000000000953.pdf'
     from public.teacher_closings
    where id = '00000000-0000-4000-8000-00000000094a'),
  'reenvio nao limpou o motivo da rejeicao anterior'
);

-- ---------------------------------------------------------------------------
-- [C] Nenhum caminho de escrita sem checagem de papel sobrou
-- ---------------------------------------------------------------------------

select pg_temp.assert_true(
  (select count(*) = 0 from pg_policies
    where schemaname = 'public' and tablename = 'teacher_closings'
      and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'ALL')
      and coalesce(qual, '') || ' ' || coalesce(with_check, '') not like '%_my_role%'),
  'voltou policy de escrita em teacher_closings sem checagem de papel'
);

select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'public.teacher_closings', 'TRUNCATE'),
  'TRUNCATE concedido em teacher_closings (nao passa por RLS)'
);

rollback;
