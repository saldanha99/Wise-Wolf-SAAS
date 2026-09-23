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
  (
    select procedure.prosecdef
      and coalesce(
        procedure.proconfig @> array['search_path=""']::text[],
        false
      )
      and pg_catalog.pg_get_functiondef(procedure.oid)
        not ilike '%trial_feedback_required%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        not ilike '%trial_feedback_is_complete%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%trial_status is distinct from ''DONE''%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%enrollment_in_progress%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%create_enrollment_offer_pre_trial_lifecycle_impl%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)'::
         pg_catalog.regprocedure
  ),
  'feedback ainda bloqueia a oferta ou outras travas autoritativas foram removidas'
);

select pg_temp.assert_true(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.create_enrollment_offer(jsonb)',
    'EXECUTE'
  ),
  'a mudança reabriu uma função interna de matrícula'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_attribute as attribute
     where attribute.attrelid = 'public.opportunities'::pg_catalog.regclass
       and attribute.attname = 'feedback_required'
       and not attribute.attisdropped
  )
  and pg_catalog.to_regprocedure(
    'public.get_teacher_pending_trial_feedback_secure()'
  ) is not null,
  'a pendência pedagógica de feedback foi removida junto com a trava comercial'
);

rollback;
