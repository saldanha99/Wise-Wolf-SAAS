begin;

do $test$
declare
  v_rls boolean;
begin
  if to_regclass('public.lesson_advances') is null then
    raise exception 'lesson_advances_table_missing';
  end if;
  if to_regprocedure('public.create_lesson_advances(uuid,jsonb,text)') is null
     or to_regprocedure('public.cancel_lesson_advance(uuid)') is null
     or to_regprocedure('public.log_advanced_teacher_classes(jsonb)') is null then
    raise exception 'lesson_advance_rpc_missing';
  end if;

  select relrowsecurity into v_rls
    from pg_class
   where oid = 'public.lesson_advances'::regclass;
  if not coalesce(v_rls, false) then
    raise exception 'lesson_advances_rls_disabled';
  end if;
  if has_table_privilege('anon', 'public.lesson_advances', 'select')
     or has_table_privilege('anon', 'public.lesson_advances', 'insert')
     or has_table_privilege('authenticated', 'public.lesson_advances', 'insert')
     or not has_table_privilege('authenticated', 'public.lesson_advances', 'select') then
    raise exception 'lesson_advances_table_grants_invalid';
  end if;
  if has_function_privilege('anon', 'public.create_lesson_advances(uuid,jsonb,text)', 'execute')
     or has_function_privilege('anon', 'public.cancel_lesson_advance(uuid)', 'execute')
     or has_function_privilege('anon', 'public.log_advanced_teacher_classes(jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.create_lesson_advances(uuid,jsonb,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.log_advanced_teacher_classes(jsonb)', 'execute') then
    raise exception 'lesson_advance_rpc_grants_invalid';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'lesson_advances'
       and indexname = 'lesson_advances_original_occurrence_uq'
  ) then
    raise exception 'lesson_advance_idempotency_index_missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'class_logs'
       and column_name = 'lesson_advance_id'
  ) then
    raise exception 'class_log_lesson_advance_origin_missing';
  end if;
end
$test$;

rollback;
