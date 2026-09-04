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
  exists (
    select 1
      from pg_catalog.pg_attribute as attribute
     where attribute.attrelid = 'public.crm_leads'::pg_catalog.regclass
       and attribute.attname = 'opportunity_id'
       and attribute.atttypid = 'uuid'::pg_catalog.regtype
       and not attribute.attisdropped
  )
  and exists (
    select 1
      from pg_catalog.pg_constraint as constraint_row
     where constraint_row.conrelid = 'public.crm_leads'::pg_catalog.regclass
       and constraint_row.conname = 'crm_leads_opportunity_id_fkey'
       and constraint_row.contype = 'f'
       and constraint_row.confdeltype = 'r'
       and constraint_row.convalidated
  )
  and exists (
    select 1
      from pg_catalog.pg_indexes as index_row
     where index_row.schemaname = 'public'
       and index_row.tablename = 'crm_leads'
       and index_row.indexname = 'crm_leads_opportunity_id_unique_idx'
       and index_row.indexdef ilike '%unique%'
       and index_row.indexdef ilike '%opportunity_id is not null%'
  ),
  'crm lead does not have a validated one-to-one trial opportunity binding'
);

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_trigger as trigger_row
     where trigger_row.tgrelid = 'public.crm_leads'::pg_catalog.regclass
       and trigger_row.tgname = 'guard_crm_lead_trial_scope_update'
       and not trigger_row.tgisinternal
       and pg_catalog.pg_get_triggerdef(trigger_row.oid)
         ilike '%before update of tenant_id, opportunity_id%'
  )
  and exists (
    select 1
      from pg_catalog.pg_trigger as trigger_row
     where trigger_row.tgrelid = 'public.crm_leads'::pg_catalog.regclass
       and trigger_row.tgname = 'guard_crm_trial_status_authority'
       and not trigger_row.tgisinternal
  )
  and exists (
    select 1
      from pg_catalog.pg_trigger as trigger_row
     where trigger_row.tgrelid = 'public.crm_leads'::pg_catalog.regclass
       and trigger_row.tgname = 'guard_crm_lead_trial_delete'
       and not trigger_row.tgisinternal
       and pg_catalog.pg_get_triggerdef(trigger_row.oid)
         ilike '%before delete%'
  )
  and (
    select pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%new.opportunity_id is distinct from%old.opportunity_id%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%crm lead trial binding requires the secure command%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'private.guard_crm_lead_trial_scope()'::pg_catalog.regprocedure
  )
  and (
    select pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%app.crm_trial_outcome_opportunity%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%old.opportunity_id is not null%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'private.guard_crm_trial_status_authority()'::pg_catalog.regprocedure
  ),
  'CRM trial binding or status can still be rewritten outside secure commands'
);

select pg_temp.assert_true(
  (
    select procedure.prosecdef
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%private.lock_trial_conversion_graph(v_opportunity_id)%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%lead.opportunity_id = v_opportunity_id%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%for update%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%p_payload - ''leadId''%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.create_enrollment_offer(jsonb)'::pg_catalog.regprocedure
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.create_enrollment_offer(jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.create_enrollment_offer_pre_crm_lead_lock_impl(jsonb)',
    'EXECUTE'
  ),
  'enrollment offer creation does not lock and revalidate the exact CRM lead'
);

select pg_temp.assert_true(
  (
    select procedure.prosecdef
      and coalesce(
        procedure.proconfig @> array['search_path=""']::text[],
        false
      )
      and pg_catalog.pg_get_functiondef(procedure.oid) ilike '%leadId%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%schedule_manual_trial_secure_pre_crm_binding_impl%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%status = ''CONTACTED''%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%v_receipt_fingerprint is distinct from%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%''idempotent'', true%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%v_actor_role not in (''SCHOOL_ADMIN'', ''SUPER_ADMIN'')%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.schedule_manual_trial_secure(jsonb)'::pg_catalog.regprocedure
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.schedule_manual_trial_secure(jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.schedule_manual_trial_secure_pre_crm_binding_impl(jsonb)',
    'EXECUTE'
  ),
  'manual trial command does not bind a CRM lead safely'
);

select pg_temp.assert_true(
  (
    select procedure.prosecdef
      and coalesce(
        procedure.proconfig @> array['search_path=""']::text[],
        false
      )
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%appointment_not_ended%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%forbidden_temporal_override%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%trial_status_override_before_appointment_end%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%appointment_time_missing%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%exception when no_data_found%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%lead.opportunity_id = v_opportunity_id%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.update_trial_outcome_secure(jsonb)'::pg_catalog.regprocedure
  )
  and pg_catalog.has_function_privilege(
    'authenticated',
    'public.update_trial_outcome_secure(jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.update_trial_outcome_secure_pre_crm_temporal_guard_impl(jsonb)',
    'EXECUTE'
  ),
  'trial outcome still permits unaudited early settlement or phone binding'
);

select pg_temp.assert_true(
  (
    select pg_catalog.pg_get_functiondef(procedure.oid)
      ilike '%lead.opportunity_id = p_opportunity_id%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%status = ''SCHEDULED''%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.claim_opportunity_atomic(uuid,uuid,integer)'::
         pg_catalog.regprocedure
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.claim_opportunity_atomic(uuid,uuid,integer)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_opportunity_atomic(uuid,uuid,integer)',
    'EXECUTE'
  ),
  'teacher acceptance does not promote the exact CRM lead atomically'
);

select pg_temp.assert_true(
  (
    select procedure.prosecdef
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%opportunity.conversion_status = ''WON''%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%lead.opportunity_id = v_opportunity_id%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        ilike '%app.crm_trial_outcome_opportunity%'
      from pg_catalog.pg_proc as procedure
     where procedure.oid =
       'public.complete_enrollment_offer(uuid,uuid)'::pg_catalog.regprocedure
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.complete_enrollment_offer(uuid,uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.complete_enrollment_offer(uuid,uuid)',
    'EXECUTE'
  ),
  'successful enrollment completion does not promote only the exact linked lead'
);

rollback;
