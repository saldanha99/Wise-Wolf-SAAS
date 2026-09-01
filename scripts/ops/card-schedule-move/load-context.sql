select pg_catalog.jsonb_build_object(
  'operation', pg_catalog.to_jsonb(operation),
  'claim', pg_catalog.to_jsonb(claim),
  'integrationLive', exists (
    select 1
      from private.tenant_integration_connections as connection
     where connection.id::text =
           operation.integration_snapshot ->> 'integrationId'
       and connection.tenant_id = operation.tenant_id
       and connection.provider = 'asaas'
       and connection.version::text =
           operation.integration_snapshot ->> 'version'
       and connection.mode = operation.integration_snapshot ->> 'mode'
       and connection.mode <> 'DISABLED'
       and connection.status in ('configured', 'healthy')
  ),
  'steps', (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(step) order by step.ordinal)
      from public.asaas_student_card_schedule_move_steps as step
     where step.operation_id = operation.id
  )
)
from public.asaas_student_card_schedule_moves as operation
join public.asaas_student_billing_period_claims as claim
  on claim.id = operation.target_billing_claim_id
where operation.operation_key = :'operation_key'
  and operation.tenant_id = :'tenant_id'
  and operation.student_id = :'student_id'::uuid
  and operation.offer_id = :'offer_id'::uuid
  and operation.customer_id = :'customer_id'
  and operation.subscription_id = :'subscription_id'
  and operation.payment_id = :'old_payment_id'
  and operation.student_payment_id = :'old_student_payment_id'::uuid
  and operation.old_due_date = :'old_due_date'::date
  and operation.target_due_date = :'target_due_date'::date
  and operation.original_next_due_date = :'original_next_due_date'::date
  and operation.target_end_date = :'target_end_date'::date
  and operation.original_end_date = :'original_end_date'::date
  and operation.expected_max_payments = :'expected_max_payments'::integer
  and operation.accept_events_until = :'accept_events_until'::timestamptz
  and operation.integration_snapshot ->> 'environment' =
    :'provider_environment'
  and operation.integration_snapshot ->> 'baseUrl' = :'asaas_base_url'
  and private.student_card_schedule_profile_exact(
    operation.tenant_id,
    operation.student_id,
    operation.customer_id,
    operation.subscription_id,
    operation.expected_value,
    operation.target_due_date,
    operation.original_end_date,
    operation.integration_snapshot -> 'profileSnapshot'
  )
  and claim.tenant_id = operation.tenant_id
  and claim.student_id = operation.student_id
  and claim.due_date = operation.target_due_date
  and claim.source = 'SUBSCRIPTION'
  and claim.source_key = 'subscription:' || operation.offer_id::text
  and claim.status = 'BOUND'
  and claim.provider_entity_id = operation.subscription_id
  and claim.request_fingerprint = operation.target_claim_fingerprint
  and operation.target_claim_fingerprint =
    private.student_card_schedule_move_fingerprint(
      operation.operation_key,
      operation.tenant_id,
      operation.student_id,
      operation.offer_id,
      operation.customer_id,
      operation.subscription_id,
      operation.payment_id,
      operation.old_due_date,
      operation.target_due_date,
      operation.target_next_due_date,
      operation.original_next_due_date,
      operation.target_end_date,
      operation.original_end_date,
      operation.expected_value,
      operation.expected_max_payments
    );
