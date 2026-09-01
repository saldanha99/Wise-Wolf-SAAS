select pg_catalog.jsonb_build_object(
  'operationStatus', operation.status,
  'steps', (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'stepKind', step.step_kind,
        'status', step.status,
        'submitAttemptCount', step.submit_attempt_count
      ) order by step.ordinal
    )
    from public.asaas_student_billing_schedule_correction_steps as step
    where step.operation_id = operation.id
  ),
  'targetClaimStatus', target_claim.status,
  'oldClaimPreserved', exists (
    select 1
    from public.asaas_student_billing_period_claims as old_claim
    where old_claim.tenant_id = operation.tenant_id
      and old_claim.student_id = operation.student_id
      and old_claim.due_date =
        (operation.original_payment_snapshot ->> 'dueDate')::date
      and old_claim.source = 'SUBSCRIPTION'
      and old_claim.source_key = 'subscription:' || operation.offer_id::text
      and old_claim.status = 'BOUND'
      and old_claim.provider_entity_id = operation.subscription_id
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
  and target_claim.request_fingerprint = :'target_claim_fingerprint';
