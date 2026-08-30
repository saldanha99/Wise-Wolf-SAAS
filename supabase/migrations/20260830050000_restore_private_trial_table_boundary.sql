begin;

-- Trial orchestration is exposed only through postgres-owned SECURITY DEFINER
-- functions. Direct service-role access to the raw command and dispatch state
-- bypasses tenant, actor, idempotency and transition checks.
revoke all on table private.secure_trial_command_receipts
  from public, anon, authenticated, service_role;
revoke all on table private.vendor_trial_teacher_requests
  from public, anon, authenticated, service_role;

grant select, insert, update on table private.secure_trial_command_receipts
  to postgres;
grant select, insert, update on table private.vendor_trial_teacher_requests
  to postgres;

-- 20260829030000 accidentally changed this internal RPC to SECURITY INVOKER.
-- Keep the raw table closed and restore the narrow, server-only definer gate.
alter function public.reopen_trial_opportunity_for_broadcast(
  text, uuid, jsonb, text, jsonb
) security definer;
alter function public.reopen_trial_opportunity_for_broadcast(
  text, uuid, jsonb, text, jsonb
) owner to postgres;
alter function public.reopen_trial_opportunity_for_broadcast(
  text, uuid, jsonb, text, jsonb
) set search_path = '';

revoke all on function public.reopen_trial_opportunity_for_broadcast(
  text, uuid, jsonb, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.reopen_trial_opportunity_for_broadcast(
  text, uuid, jsonb, text, jsonb
) to service_role;

do $postcheck$
declare
  v_role text;
  v_table text;
  v_privilege text;
  v_reopen regprocedure := to_regprocedure(
    'public.reopen_trial_opportunity_for_broadcast(text,uuid,jsonb,text,jsonb)'
  );
begin
  if not pg_catalog.has_table_privilege(
       'postgres', 'private.secure_trial_command_receipts', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'postgres', 'private.secure_trial_command_receipts', 'INSERT'
     )
     or not pg_catalog.has_table_privilege(
       'postgres', 'private.secure_trial_command_receipts', 'UPDATE'
     )
     or not pg_catalog.has_table_privilege(
       'postgres', 'private.vendor_trial_teacher_requests', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'postgres', 'private.vendor_trial_teacher_requests', 'INSERT'
     )
     or not pg_catalog.has_table_privilege(
       'postgres', 'private.vendor_trial_teacher_requests', 'UPDATE'
     )
  then
    raise exception 'private trial table boundary is incomplete';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    foreach v_table in array array[
      'private.secure_trial_command_receipts',
      'private.vendor_trial_teacher_requests'
    ]
    loop
      foreach v_privilege in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]
      loop
        if pg_catalog.has_table_privilege(v_role, v_table, v_privilege) then
          raise exception 'unsafe % privilege for % on %',
            v_privilege, v_role, v_table;
        end if;
      end loop;
    end loop;
  end loop;

  if v_reopen is null
     or not (
       select procedure.prosecdef
          and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
          and exists (
            select 1
              from unnest(coalesce(procedure.proconfig, array[]::text[])) setting
             where setting = 'search_path=""'
          )
         from pg_catalog.pg_proc as procedure
        where procedure.oid = v_reopen
     )
     or pg_catalog.has_function_privilege('anon', v_reopen, 'EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated', v_reopen, 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role', v_reopen, 'EXECUTE'
     )
  then
    raise exception 'trial reopen function boundary is not fail-closed';
  end if;
end;
$postcheck$;

commit;
