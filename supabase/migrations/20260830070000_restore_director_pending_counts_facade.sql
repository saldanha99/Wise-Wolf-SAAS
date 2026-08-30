begin;

-- A historical pending migration can be applied after the authorization
-- hardening marker and recreate this facade with search_path=public. Keep the
-- business implementation unchanged, but converge the public gate last.
do $foundation$
begin
  if to_regprocedure('public.director_pending_counts()') is null
     or to_regprocedure('public.director_pending_counts_unchecked()') is null
  then
    raise exception 'director pending counts facade foundation is missing';
  end if;
end;
$foundation$;

create or replace function public.director_pending_counts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.can_execute_legacy_role_rpc(
    array['SCHOOL_ADMIN', 'SUPER_ADMIN']::text[]
  ) then
    return '{}'::jsonb;
  end if;
  return public.director_pending_counts_unchecked();
end;
$function$;

alter function public.director_pending_counts() owner to postgres;
alter function public.director_pending_counts() set search_path = '';
revoke all on function public.director_pending_counts()
  from public, anon, authenticated, service_role;
grant execute on function public.director_pending_counts()
  to authenticated, service_role;

alter function public.director_pending_counts_unchecked() owner to postgres;
revoke all on function public.director_pending_counts_unchecked()
  from public, anon, authenticated, service_role;
grant execute on function public.director_pending_counts_unchecked()
  to postgres, supabase_admin;

do $postcheck$
declare
  v_facade regprocedure := to_regprocedure(
    'public.director_pending_counts()'
  );
  v_implementation regprocedure := to_regprocedure(
    'public.director_pending_counts_unchecked()'
  );
begin
  if v_facade is null
     or not (
       select p.prosecdef
          and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
          and pg_catalog.strpos(
            p.prosrc, 'private.can_execute_legacy_role_rpc'
          ) > 0
          and pg_catalog.strpos(
            p.prosrc, 'public.director_pending_counts_unchecked'
          ) > 0
          and exists (
            select 1
              from unnest(coalesce(p.proconfig, array[]::text[])) setting
             where setting = 'search_path=""'
          )
         from pg_catalog.pg_proc as p
        where p.oid = v_facade
     )
     or pg_catalog.has_function_privilege('anon', v_facade, 'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated', v_facade, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_facade, 'EXECUTE'
     )
  then
    raise exception 'director pending counts facade is not fail-closed';
  end if;

  if v_implementation is null
     or pg_catalog.pg_get_userbyid(
       (select p.proowner
          from pg_catalog.pg_proc as p
         where p.oid = v_implementation)
     ) <> 'postgres'
     or pg_catalog.has_function_privilege(
       'anon', v_implementation, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', v_implementation, 'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role', v_implementation, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'postgres', v_implementation, 'EXECUTE'
     )
  then
    raise exception 'director pending counts implementation is not owner-only';
  end if;
end;
$postcheck$;

commit;
