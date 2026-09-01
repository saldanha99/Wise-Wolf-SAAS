select pg_catalog.jsonb_build_object(
  'operationStatus', operation.status,
  'paymentId', operation.payment_id,
  'oldDueDate', operation.old_due_date,
  'targetDueDate', operation.target_due_date,
  'targetNextDueDate', operation.target_next_due_date,
  'targetEndDate', operation.target_end_date,
  'maxPayments', operation.expected_max_payments,
  'targetClaimFingerprint', operation.target_claim_fingerprint,
  'targetClaimReleased', operation.target_billing_claim_id is null,
  'steps', (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'stepKind', step.step_kind,
        'status', step.status,
        'submitAttemptCount', step.submit_attempt_count
      ) order by step.ordinal
    )
      from public.asaas_student_card_schedule_move_steps as step
     where step.operation_id = operation.id
  )
)
from public.asaas_student_card_schedule_moves as operation
left join public.asaas_student_billing_period_claims as claim
  on claim.id = operation.target_billing_claim_id
where operation.operation_key = :'operation_key'
  and operation.tenant_id = :'tenant_id'
  and operation.student_id = :'student_id'::uuid
  and operation.subscription_id = :'subscription_id';
