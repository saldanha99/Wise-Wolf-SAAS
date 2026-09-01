do $contract$
declare
  missing_contract text;
begin
  if pg_catalog.to_regclass(
       'public.asaas_student_billing_schedule_corrections'
     ) is null
     or pg_catalog.to_regclass(
       'public.asaas_student_billing_schedule_correction_steps'
     ) is null
     or pg_catalog.to_regclass(
       'public.asaas_student_billing_period_claims'
     ) is null
     or pg_catalog.to_regclass('public.student_payments') is null
     or pg_catalog.to_regclass('public.financial_transactions') is null
     or pg_catalog.to_regclass('public.asaas_webhook_inbox') is null
     or pg_catalog.to_regclass(
       'private.tenant_integration_connections'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.student_subscription_mutation_scope_valid(text,uuid,text,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.asaas_billing_schedule_compensation_causal(uuid)'
     ) is null
  then
    raise exception 'billing_schedule_operator_schema_missing';
  end if;

  if not pg_catalog.has_function_privilege(
       pg_catalog.current_user,
       'private.student_subscription_mutation_scope_valid(text,uuid,text,text)',
       'EXECUTE'
     )
  then
    raise exception 'billing_schedule_operator_requires_privileged_db_role';
  end if;
  if not pg_catalog.has_function_privilege(
       pg_catalog.current_user,
       'private.asaas_billing_schedule_compensation_causal(uuid)',
       'EXECUTE'
     )
  then
    raise exception 'billing_schedule_operator_requires_compensation_privilege';
  end if;

  with required(table_name, column_name, formatted_type, is_nullable) as (
    values
      ('asaas_student_billing_schedule_corrections', 'id', 'uuid', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'operation_key', 'text', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'tenant_id', 'text', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'student_id', 'uuid', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'offer_id', 'uuid', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'old_student_payment_id', 'uuid', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'target_billing_claim_id', 'uuid', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'customer_id', 'text', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'subscription_id', 'text', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'old_payment_id', 'text', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'target_due_date', 'date', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'target_end_date', 'date', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'original_subscription_snapshot', 'jsonb', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'original_payment_snapshot', 'jsonb', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'target_subscription_snapshot', 'jsonb', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'integration_snapshot', 'jsonb', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'target_conflict_evidence', 'jsonb', 'YES'),
      ('asaas_student_billing_schedule_corrections', 'status', 'text', 'NO'),
      ('asaas_student_billing_schedule_corrections', 'accept_events_until', 'timestamp with time zone', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'id', 'uuid', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'operation_id', 'uuid', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'step_kind', 'text', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'route_kind', 'text', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'ordinal', 'smallint', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'status', 'text', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'request_fingerprint', 'text', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'expected_before', 'jsonb', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'desired_after', 'jsonb', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'provider_request', 'jsonb', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'provider_response', 'jsonb', 'YES'),
      ('asaas_student_billing_schedule_correction_steps', 'observed_state', 'jsonb', 'YES'),
      ('asaas_student_billing_schedule_correction_steps', 'submit_attempt_count', 'integer', 'NO'),
      ('asaas_student_billing_schedule_correction_steps', 'provider_http_status', 'integer', 'YES'),
      ('asaas_student_billing_schedule_correction_steps', 'submitted_at', 'timestamp with time zone', 'YES'),
      ('asaas_student_billing_schedule_correction_steps', 'completed_at', 'timestamp with time zone', 'YES')
  ), actual as (
    select
      table_name,
      column_name,
      data_type,
      is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'asaas_student_billing_schedule_corrections',
        'asaas_student_billing_schedule_correction_steps'
      )
  )
  select pg_catalog.string_agg(
           required.table_name || '.' || required.column_name,
           ', ' order by required.table_name, required.column_name
         )
    into missing_contract
    from required
    left join actual
      on actual.table_name = required.table_name
     and actual.column_name = required.column_name
     and actual.data_type = required.formatted_type
     and actual.is_nullable = required.is_nullable
   where actual.column_name is null;

  if missing_contract is not null then
    raise exception 'billing_schedule_operator_schema_diverged: %',
      missing_contract;
  end if;

  with required(column_name, formatted_type) as (
    values
      ('id', 'uuid'),
      ('tenant_id', 'text'),
      ('student_id', 'uuid'),
      ('asaas_payment_id', 'text'),
      ('asaas_id', 'text'),
      ('provider_customer_id', 'text'),
      ('value', 'numeric'),
      ('amount_cents', 'integer'),
      ('status', 'text'),
      ('provider_status', 'text'),
      ('due_date', 'date'),
      ('billing_type', 'text'),
      ('payment_method', 'text'),
      ('payment_type', 'text'),
      ('payment_date', 'date'),
      ('paid_at', 'timestamp with time zone'),
      ('credited_at', 'timestamp with time zone'),
      ('refunded_amount', 'numeric'),
      ('ledger_entry_created', 'boolean'),
      ('last_provider_event_id', 'text')
  ), actual as (
    select column_name, data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'student_payments'
  )
  select pg_catalog.string_agg(
           'student_payments.' || required.column_name,
           ', ' order by required.column_name
         )
    into missing_contract
    from required
    left join actual
      on actual.column_name = required.column_name
     and actual.data_type = required.formatted_type
   where actual.column_name is null;

  if missing_contract is not null then
    raise exception 'billing_schedule_operator_payment_schema_diverged: %',
      missing_contract;
  end if;

  if (
       select pg_catalog.count(*)
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'financial_transactions'
         and column_name in (
           'student_payment_id', 'refund_student_payment_id'
         )
         and data_type = 'uuid'
     ) <> 2
  then
    raise exception 'billing_schedule_operator_financial_schema_diverged';
  end if;

  if not exists (
       select 1
       from pg_catalog.pg_class
       where oid = 'public.asaas_student_billing_schedule_corrections'::regclass
         and relrowsecurity
         and relforcerowsecurity
     )
     or not exists (
       select 1
       from pg_catalog.pg_class
       where oid = 'public.asaas_student_billing_schedule_correction_steps'::regclass
         and relrowsecurity
         and relforcerowsecurity
     )
  then
    raise exception 'billing_schedule_operator_rls_contract_diverged';
  end if;

  if not exists (
       select 1
       from pg_catalog.pg_constraint
       where conrelid =
         'public.asaas_student_billing_schedule_correction_steps'::regclass
         and contype = 'c'
         and (
           pg_catalog.pg_get_constraintdef(oid) like
             '%submit_attempt_count BETWEEN 0 AND 1%'
           or (
             pg_catalog.pg_get_constraintdef(oid) like
               '%submit_attempt_count >= 0%'
             and pg_catalog.pg_get_constraintdef(oid) like
               '%submit_attempt_count <= 1%'
           )
         )
     )
  then
    raise exception 'billing_schedule_operator_submit_fence_missing';
  end if;
end
$contract$;

select 'ok';
