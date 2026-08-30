begin;

-- Harden whichever billing compatibility surfaces still exist at this point
-- in the migration chain. The unordered overload is transitional and may
-- already have been removed when pending migrations are replayed a second
-- time; the ordered overload is the only required public boundary.
do $harden_existing_billing_wrappers$
declare
  unordered_oid regprocedure := pg_catalog.to_regprocedure(
    'public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text)'
  );
  ordered_oid regprocedure := pg_catalog.to_regprocedure(
    'public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text)'
  );
begin
  if ordered_oid is null then
    raise exception 'ordered Asaas billing entry point is missing';
  end if;

  if unordered_oid is not null then
    execute 'alter function public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text) owner to postgres';
    execute 'revoke all on function public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text) from public, anon, authenticated, service_role';
    execute 'grant execute on function public.apply_saas_checkout_billing_event(uuid,text,text,numeric,text,text,text,text,timestamptz,date,text,text) to service_role';
  end if;

  execute 'alter function public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text) owner to postgres';
  execute 'revoke all on function public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text) from public, anon, authenticated, service_role';
  execute 'grant execute on function public.apply_saas_checkout_billing_event(uuid,text,text,timestamptz,text,numeric,text,text,text,text,timestamptz,date,text,text) to service_role';

  if exists (
       select 1
       from pg_catalog.pg_proc as procedure
       where procedure.oid = ordered_oid
         and (
           not procedure.prosecdef
           or pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
           or not coalesce(
             procedure.proconfig @> array['search_path=""']::text[],
             false
           )
         )
     )
     or pg_catalog.has_function_privilege(
       'anon', ordered_oid, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', ordered_oid, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', ordered_oid, 'EXECUTE'
     )
     or (
       unordered_oid is not null
       and (
         exists (
           select 1
           from pg_catalog.pg_proc as procedure
           where procedure.oid = unordered_oid
             and (
               not procedure.prosecdef
               or pg_catalog.pg_get_userbyid(procedure.proowner) <> 'postgres'
               or not coalesce(
                 procedure.proconfig @> array['search_path=""']::text[],
                 false
               )
             )
         )
         or pg_catalog.has_function_privilege(
           'anon', unordered_oid, 'EXECUTE'
         )
         or pg_catalog.has_function_privilege(
           'authenticated', unordered_oid, 'EXECUTE'
         )
         or not pg_catalog.has_function_privilege(
           'service_role', unordered_oid, 'EXECUTE'
         )
       )
     )
  then
    raise exception 'Asaas billing entry point is not hardened';
  end if;
end;
$harden_existing_billing_wrappers$;

commit;
