-- Cobertura atestada pela direção (aula já dada) e o formato de ausência que o
-- banco aceita. O caminho ponta a ponta com dados reais foi exercitado em
-- BEGIN…ROLLBACK em 16/09/2026 (Theo/Flávio/Débora); aqui ficam as invariantes.

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

select pg_temp.assert_true(
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'class_coverages'
       and column_name = 'confirmed_by'
  ),
  'class_coverages.confirmed_by ausente (marca da cobertura atestada)'
);

-- A RPC do grupo recusa mês fechado e sabe o ramo retroativo.
select pg_temp.assert_true(
  pg_get_functiondef(
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)'::regprocedure
  ) ilike '%mes_fechado%'
  and pg_get_functiondef(
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)'::regprocedure
  ) ilike '%v_retroactive%',
  'gestao_create_coverage_invite sem o ramo de aula já dada'
);

-- Ela grava a ausência no formato que a CHECK aceita (enum + MAIÚSCULA).
select pg_temp.assert_true(
  pg_get_functiondef(
    'public.gestao_create_coverage_invite(text,uuid,uuid,uuid,date,text,text,text)'::regprocedure
  ) not like '%btrim(p_reason), ''active''%',
  'gestao_create_coverage_invite voltou a gravar ausência em minúscula/texto livre'
);

-- O trigger de integridade reconhece a cobertura atestada e mantém as barreiras.
select pg_temp.assert_true(
  pg_get_functiondef('public.enforce_active_class_coverage_slot()'::regprocedure)
    ilike '%retroactive_coverage_window%'
  and pg_get_functiondef('public.enforce_active_class_coverage_slot()'::regprocedure)
    ilike '%active_coverage_slot_conflict%'
  and pg_get_functiondef('public.enforce_active_class_coverage_slot()'::regprocedure)
    ilike '%active_coverage_already_started%',
  'enforce_active_class_coverage_slot sem o ramo atestado ou sem as barreiras originais'
);

-- Ausência no formato dos escritores (grupo, painel): tem de entrar.
insert into public.tenants (id, name)
values ('cobertura-retro-school', 'Cobertura Retro School')
on conflict (id) do nothing;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000921', 'authenticated', 'authenticated',
        'cobertura-retro-prof@example.invalid', '{"provider":"email","providers":["email"]}',
        '{"full_name":"Prof Retro"}', now(), now());

update public.profiles
   set tenant_id = 'cobertura-retro-school', role = 'TEACHER', full_name = 'Prof Retro'
 where id = '00000000-0000-4000-8000-000000000921';

insert into public.teacher_absences (tenant_id, teacher_id, starts_at, ends_at, reason, notes, status)
values ('cobertura-retro-school', '00000000-0000-4000-8000-000000000921',
        current_date, current_date, 'SICK', 'garganta doendo (aula dada às 10:00)', 'ACTIVE');

select pg_temp.assert_true(
  (select count(*) from public.teacher_absences
    where teacher_id = '00000000-0000-4000-8000-000000000921') = 1,
  'ausência no formato SICK/ACTIVE não entrou'
);

rollback;
