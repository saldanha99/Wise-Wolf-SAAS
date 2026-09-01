select pg_catalog.jsonb_build_object(
  'operation', to_jsonb(operation) || pg_catalog.jsonb_build_object(
    'old_due_date', operation.original_payment_snapshot ->> 'dueDate'
  ),
  'requestedAcceptEventsUntil',
    pg_catalog.to_jsonb(:'accept_events_until'::timestamptz),
  'claim', to_jsonb(target_claim),
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
    select pg_catalog.jsonb_agg(to_jsonb(step) order by step.ordinal)
    from public.asaas_student_billing_schedule_correction_steps as step
    where step.operation_id = operation.id
  )
)
from public.asaas_student_billing_schedule_corrections as operation
join public.asaas_student_billing_period_claims as target_claim
  on target_claim.id = operation.target_billing_claim_id
where operation.operation_key = :'operation_key'
  and operation.tenant_id = :'tenant_id'
  and operation.student_id = :'student_id'::uuid
  and operation.offer_id = :'offer_id'::uuid
  and operation.customer_id = :'customer_id'
  and operation.subscription_id = :'subscription_id'
  and operation.old_payment_id = :'old_payment_id'
  and operation.old_student_payment_id = :'old_student_payment_id'::uuid
  and operation.original_payment_snapshot ->> 'dueDate' = :'old_due_date'
  and operation.original_subscription_snapshot ->> 'nextDueDate' =
    :'original_next_due_date'
  and operation.original_subscription_snapshot ->> 'endDate' =
    :'original_end_date'
  and operation.target_due_date = :'target_due_date'::date
  and operation.target_end_date = :'target_end_date'::date
  and operation.accept_events_until = :'accept_events_until'::timestamptz
  and target_claim.tenant_id = :'tenant_id'
  and target_claim.student_id = :'student_id'::uuid
  and target_claim.due_date = :'target_due_date'::date
  and target_claim.source = 'SUBSCRIPTION'
  and target_claim.source_key = 'subscription:' || :'offer_id'
  and target_claim.request_fingerprint = :'target_claim_fingerprint'
  and target_claim.status = 'BOUND'
  and target_claim.provider_entity_id = :'subscription_id';
