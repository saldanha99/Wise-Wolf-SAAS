\set ON_ERROR_STOP on

begin;

do $test$
declare
  expected_signatures constant text[] := array[
    'public.cas_wolfie_realtime_session_analysis(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,text,text,integer,integer,boolean,timestamptz,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,uuid,uuid,uuid,numeric,jsonb,uuid,jsonb)',
    'public.claim_wolfie_realtime_fact_confirmation(uuid,uuid,uuid,uuid,text)',
    'public.finalize_wolfie_realtime_fact_confirmation(uuid,uuid,uuid,uuid,jsonb)'
  ];
  target_signature text;
  target_oid oid;
  stored_definition text;
begin
  foreach target_signature in array expected_signatures loop
    target_oid := pg_catalog.to_regprocedure(target_signature)::oid;
    if target_oid is null then
      raise exception 'missing repaired Wolfie function: %', target_signature;
    end if;

    stored_definition := pg_catalog.pg_get_functiondef(target_oid);
    if stored_definition ~* 'pg_catalog[.](greatest|least|coalesce|nullif)[[:space:]]*[(]' then
      raise exception 'qualified SQL special form remains in %', target_signature;
    end if;
  end loop;

  if exists (
    select 1
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.prosrc ~* 'pg_catalog[.](greatest|least|coalesce|nullif)[[:space:]]*[(]'
  ) then
    raise exception 'qualified SQL special form remains in a public function';
  end if;
end;
$test$;

rollback;
