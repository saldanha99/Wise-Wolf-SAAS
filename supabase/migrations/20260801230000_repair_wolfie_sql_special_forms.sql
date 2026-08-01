-- PostgreSQL parses GREATEST, LEAST, COALESCE and NULLIF as SQL special
-- forms, not ordinary pg_catalog functions. Migration 190 accidentally
-- schema-qualified twelve calls inside three PL/pgSQL functions. PL/pgSQL
-- validates those statements lazily, so the migration succeeded and the
-- affected paths failed only when invoked.
--
-- Migrations 190-220 are already recorded remotely. Repair their final state
-- forward-only and preserve every other byte of each stored function body.

do $repair$
declare
  expected_signatures constant text[] := array[
    'public.cas_wolfie_realtime_session_analysis(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,integer,integer,boolean,timestamptz,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,uuid,uuid,uuid,numeric,jsonb,uuid,jsonb)',
    'public.claim_wolfie_realtime_fact_confirmation(uuid,uuid,uuid,uuid,text)',
    'public.finalize_wolfie_realtime_fact_confirmation(uuid,uuid,uuid,uuid,jsonb)'
  ];
  target_signature text;
  target_oid oid;
  target_oids oid[] := '{}'::oid[];
  affected_count integer;
  stored_definition text;
  repaired_definition text;
begin
  foreach target_signature in array expected_signatures loop
    target_oid := pg_catalog.to_regprocedure(target_signature)::oid;
    if target_oid is null then
      raise exception using
        errcode = '42883',
        message = 'wolfie_sql_special_forms_repair_missing_target',
        detail = target_signature;
    end if;

    target_oids := pg_catalog.array_append(target_oids, target_oid);
  end loop;

  select pg_catalog.count(*)::integer
    into affected_count
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.prosrc ~* 'pg_catalog[.](greatest|least|coalesce|nullif)[[:space:]]*[(]';

  if affected_count <> 3 then
    raise exception using
      errcode = '55000',
      message = 'wolfie_sql_special_forms_repair_unexpected_target_count',
      detail = pg_catalog.format('expected 3 affected public functions, found %s', affected_count);
  end if;

  if exists (
    select 1
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.prosrc ~* 'pg_catalog[.](greatest|least|coalesce|nullif)[[:space:]]*[(]'
       and not (procedure.oid = any(target_oids))
  ) then
    raise exception using
      errcode = '55000',
      message = 'wolfie_sql_special_forms_repair_unexpected_target';
  end if;

  foreach target_oid in array target_oids loop
    stored_definition := pg_catalog.pg_get_functiondef(target_oid);
    repaired_definition := stored_definition;
    repaired_definition := pg_catalog.regexp_replace(
      repaired_definition,
      'pg_catalog[.]greatest[[:space:]]*[(]',
      'greatest(',
      'gi'
    );
    repaired_definition := pg_catalog.regexp_replace(
      repaired_definition,
      'pg_catalog[.]least[[:space:]]*[(]',
      'least(',
      'gi'
    );
    repaired_definition := pg_catalog.regexp_replace(
      repaired_definition,
      'pg_catalog[.]coalesce[[:space:]]*[(]',
      'coalesce(',
      'gi'
    );
    repaired_definition := pg_catalog.regexp_replace(
      repaired_definition,
      'pg_catalog[.]nullif[[:space:]]*[(]',
      'nullif(',
      'gi'
    );

    if repaired_definition is not distinct from stored_definition then
      raise exception using
        errcode = '55000',
        message = 'wolfie_sql_special_forms_repair_target_was_not_affected',
        detail = target_oid::regprocedure::text;
    end if;

    execute repaired_definition;
  end loop;

  if exists (
    select 1
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.prosrc ~* 'pg_catalog[.](greatest|least|coalesce|nullif)[[:space:]]*[(]'
  ) then
    raise exception using
      errcode = '55000',
      message = 'wolfie_sql_special_forms_repair_postcondition_failed';
  end if;
end;
$repair$;
