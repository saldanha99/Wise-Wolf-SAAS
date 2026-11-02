-- Transaction-safe release checks for the school Gamma book generator.
-- O release exige o envelope begin; … rollback; em todo teste SQL.

\set ON_ERROR_STOP on

begin;

do $test$
declare
  policy_expression text;
  original_search_path text;
begin
  if to_regclass('public.school_book_generations') is null then
    raise exception 'school_book_generations_table_missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class
    where oid = 'public.school_book_generations'::regclass
      and relrowsecurity
      and relforcerowsecurity
  ) then
    raise exception 'school_book_generations_rls_not_forced';
  end if;

  if not has_table_privilege(
    'authenticated', 'public.school_book_generations', 'select'
  ) then
    raise exception 'school_book_generations_select_missing';
  end if;

  if has_table_privilege(
    'authenticated', 'public.school_book_generations', 'insert'
  ) or has_table_privilege(
    'authenticated', 'public.school_book_generations', 'update'
  ) or has_table_privilege(
    'authenticated', 'public.school_book_generations', 'delete'
  ) then
    raise exception 'school_book_generations_browser_write_present';
  end if;

  -- pg_policies devolve a expressão sem o esquema quando ele está no
  -- search_path — o do supabase_admin tem "auth", e auth.uid() viraria uid().
  -- Lê com o caminho mínimo para os nomes saírem qualificados.
  original_search_path := pg_catalog.current_setting('search_path');
  perform pg_catalog.set_config('search_path', 'pg_catalog', true);
  select coalesce(qual, '')
    into policy_expression
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'school_book_generations'
    and policyname = 'school_book_generations_select_scoped';
  perform pg_catalog.set_config('search_path', original_search_path, true);

  if policy_expression is null
    or position('_my_tenant_id' in policy_expression) = 0
    or position('auth.uid' in policy_expression) = 0
  then
    raise exception 'school_book_generations_policy_not_scoped';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'school_book_generations'
      and indexname = 'school_book_generations_tenant_created_idx'
  ) then
    raise exception 'school_book_generations_tenant_index_missing';
  end if;
end
$test$;

rollback;
