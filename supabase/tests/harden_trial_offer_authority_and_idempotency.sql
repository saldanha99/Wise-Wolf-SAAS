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

select pg_temp.assert_true(
  to_regclass('private.enrollment_offer_command_receipts') is not null
  and (select relrowsecurity and relforcerowsecurity
         from pg_catalog.pg_class
        where oid = 'private.enrollment_offer_command_receipts'::regclass)
  and not has_table_privilege(
    'authenticated', 'private.enrollment_offer_command_receipts', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'private.enrollment_offer_command_receipts', 'SELECT'
  ),
  'enrollment offer idempotency receipts are exposed outside postgres'
);

select pg_temp.assert_true(
  not has_function_privilege(
    'authenticated',
    'public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.create_enrollment_offer(jsonb)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.create_enrollment_offer(jsonb)', 'EXECUTE'
  ),
  'enrollment offer authority wrapper has unsafe execute grants'
);

select pg_temp.assert_true(
  (select procedure.prosecdef
          and coalesce(procedure.proconfig @> array['search_path=""']::text[], false)
     from pg_catalog.pg_proc as procedure
    where procedure.oid = 'public.create_enrollment_offer(jsonb)'::regprocedure)
  and (select pg_get_functiondef('public.create_enrollment_offer(jsonb)'::regprocedure)
        ilike '%idempotency_key_reused%'
        and pg_get_functiondef('public.create_enrollment_offer(jsonb)'::regprocedure)
        ilike '%SCHOOL_ADMIN%'
        and pg_get_functiondef('public.create_enrollment_offer(jsonb)'::regprocedure)
          ilike '%SALESPERSON%'
        and pg_get_functiondef('public.create_enrollment_offer(jsonb)'::regprocedure)
          not ilike '%''TEACHER''%'),
  'offer wrapper does not fence teacher authority or idempotency reuse'
);

select pg_temp.assert_true(
  (select procedure.prosecdef
          and coalesce(procedure.proconfig @> array['search_path=""']::text[], false)
     from pg_catalog.pg_proc as procedure
    where procedure.oid = 'public.update_trial_outcome_secure(jsonb)'::regprocedure)
  and (select pg_get_functiondef('public.update_trial_outcome_secure(jsonb)'::regprocedure)
        ilike '%completed_class_log_required%'
        and pg_get_functiondef('public.update_trial_outcome_secure(jsonb)'::regprocedure)
          ilike '%appointment_not_ended%'
        and pg_get_functiondef('public.update_trial_outcome_secure(jsonb)'::regprocedure)
          ilike '%interval ''30 minutes''%'),
  'teacher feedback can still manufacture attendance before the appointment ends'
);

rollback;
