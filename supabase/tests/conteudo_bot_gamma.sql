-- Conteúdo pelo agente (migration 20261122203000): fronteiras da credencial
-- técnica, das views do schema openbot e das regras de marca/destino.
-- Tudo dentro de transação desfeita.

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

-- Credencial: só service_role executa; ninguém do app lê a tabela.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.content_bot_authenticate(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.content_bot_authenticate(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.content_bot_authenticate(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.content_bot_claim_material_object(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.content_bot_claim_material_object(uuid,text)', 'EXECUTE'),
  'content bot RPC exposed to the app'
);
select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'private.content_bot_credentials', 'SELECT')
  and not has_table_privilege('anon', 'private.content_bot_credentials', 'SELECT'),
  'credential table readable by the app'
);

-- Views do agente: o app não lê; openbot_ro (se existir) lê.
select pg_temp.assert_true(
  not has_table_privilege('authenticated', 'openbot.conteudo_materiais', 'SELECT')
  and not has_table_privilege('anon', 'openbot.conteudo_resumos_temas', 'SELECT')
  and not has_table_privilege('authenticated', 'openbot.conteudo_alunos_perfil', 'SELECT'),
  'openbot views readable by the app'
);
select pg_temp.assert_true(
  not exists (select 1 from pg_roles where rolname = 'openbot_ro')
  or (has_table_privilege('openbot_ro', 'openbot.conteudo_geracoes_gamma', 'SELECT')
      and has_table_privilege('openbot_ro', 'openbot.conteudo_creditos_gamma_mes', 'SELECT')
      and has_table_privilege('openbot_ro', 'openbot.conteudo_resumos_temas', 'SELECT')),
  'openbot_ro cannot read the content views'
);

-- Nenhuma view expõe coluna de identificação de aluno.
select pg_temp.assert_true(
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'openbot' and table_name like 'conteudo\_%'
       and column_name in ('student_id', 'full_name', 'name', 'email', 'phone', 'title', 'created_by')
  ),
  'content view exposes identifying column'
);

-- Token desconhecido não resolve.
select pg_temp.assert_true(
  (select count(*) from public.content_bot_authenticate(repeat('0', 64))) = 0,
  'unknown token authenticated'
);

-- Hub só com marca neutra; rodapé só no neutro; agente só como TEACHER.
do $$
declare
  v_tenant text := (select id from public.tenants order by id limit 1);
  v_user uuid := (select id from auth.users order by created_at limit 1);
begin
  begin
    insert into public.school_book_generations (tenant_id, created_by, creator_role, request_key, title, level_tag,
      audience, book_language, page_count, objective, brand, destination)
    values (v_tenant, v_user, 'TEACHER', gen_random_uuid(), 'Teste', 'B1', 'adults', 'english', 12, 'teste', 'school', 'HUB');
    raise exception 'hub accepted school brand';
  exception when check_violation then null;
  end;
  begin
    insert into public.school_book_generations (tenant_id, created_by, creator_role, request_key, title, level_tag,
      audience, book_language, page_count, objective, footer_text)
    values (v_tenant, v_user, 'TEACHER', gen_random_uuid(), 'Teste', 'B1', 'adults', 'english', 12, 'teste', 'Wise Wolf');
    raise exception 'school brand accepted footer';
  exception when check_violation then null;
  end;
  begin
    insert into public.school_book_generations (tenant_id, created_by, creator_role, request_key, title, level_tag,
      audience, book_language, page_count, objective, created_via)
    values (v_tenant, v_user, 'SCHOOL_ADMIN', gen_random_uuid(), 'Teste', 'B1', 'adults', 'english', 12, 'teste', 'CONTENT_BOT');
    raise exception 'content bot accepted as admin';
  exception when check_violation then null;
  end;
end $$;

rollback;
