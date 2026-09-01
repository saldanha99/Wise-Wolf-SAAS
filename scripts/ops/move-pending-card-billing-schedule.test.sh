#!/usr/bin/env bash
set -Eeuo pipefail

readonly TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly OPERATOR="$TEST_DIR/move-pending-card-billing-schedule.sh"
readonly SQL_DIR="$TEST_DIR/card-schedule-move"
readonly PROJECT_DIR="$(cd "$TEST_DIR/../.." && pwd)"
readonly MIGRATION="$PROJECT_DIR/supabase/migrations/20260901160000_move_pending_card_billing_schedule.sql"
readonly RELEASE="$PROJECT_DIR/deploy/vps/release.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
contains() {
  local file="$1" value="$2"
  grep -F -- "$value" "$file" >/dev/null || fail "$file lacks: $value"
}
excludes() {
  local file="$1" value="$2"
  if grep -F -- "$value" "$file" >/dev/null; then
    fail "$file unexpectedly contains: $value"
  fi
}

[[ -x "$OPERATOR" ]] || fail "operator is not executable"
bash -n "$OPERATOR"
"$OPERATOR" help | grep -F 'compensate' >/dev/null ||
  fail "help omits compensation recovery"

fingerprint_error="$({ "$OPERATOR" preflight --target-claim-fingerprint \
  "$(printf 'a%.0s' {1..64})"; } 2>&1 || true)"
[[ "$fingerprint_error" == *'fingerprint livre foi removido'* ]] ||
  fail "free claim fingerprint was accepted"

excludes "$OPERATOR" '--request DELETE'
excludes "$MIGRATION" "'method', 'DELETE'"
excludes "$MIGRATION" 'updatePendingPayments'
contains "$OPERATOR" '--retry 0'
contains "$OPERATOR" 'subscription_observed=$subscription_observed'
contains "$OPERATOR" 'payment_observed=$payment_observed'
contains "$OPERATOR" 'subscription_payments=$subscription_payments'
contains "$OPERATOR" 'original_payments_snapshot=$ORIGINAL_PAYMENTS_JSON'
contains "$OPERATOR" 'load_context false'
contains "$SQL_DIR/mark-submitting.sql" "args.step_kind in ('MOVE_PAYMENT_TO_TARGET', 'UPDATE_TARGET_SCHEDULE')"
contains "$SQL_DIR/mark-submitting.sql" 'operation_row.original_payments_snapshot'
contains "$SQL_DIR/finish-step.sql" 'operation_row.original_payments_snapshot'
contains "$SQL_DIR/reconcile-operation.sql" 'awaiting_next_payment_materialization'
contains "$SQL_DIR/begin-compensation.sql" 'target_schedule_submit_abandoned'
contains "$SQL_DIR/abort-unsubmitted.sql" 'student_card_schedule_move_abort_refused'
contains "$SQL_DIR/load-context.sql" "integration_snapshot ->> 'environment'"
contains "$SQL_DIR/load-context.sql" "integration_snapshot ->> 'baseUrl'"

[[ "$(grep -F -c "'method', 'PUT'" "$SQL_DIR/prepare.sql")" == 4 ]] ||
  fail "the four immutable descriptors are not PUT"
[[ "$(grep -F -c "'billingType', 'CREDIT_CARD'" "$SQL_DIR/prepare.sql")" == 2 ]] ||
  fail "payment PUT descriptors do not preserve CREDIT_CARD"
[[ "$(grep -F -c "'value', args.expected_value" "$SQL_DIR/prepare.sql")" == 2 ]] ||
  fail "payment PUT descriptors do not preserve value"
contains "$SQL_DIR/prepare.sql" "'nextDueDate', args.target_next_due_date::text"
contains "$SQL_DIR/prepare.sql" "'endDate', args.target_end_date::text"
contains "$MIGRATION" 'expected_max_payments integer not null check (expected_max_payments = 12)'
contains "$MIGRATION" 'asaas_student_card_schedule_moves_payment_active_uidx'
contains "$RELEASE" 'supabase/migrations/20260901160000_move_pending_card_billing_schedule.sql'
contains "$RELEASE" 'supabase/tests/student_card_schedule_move.sql'

printf 'student card schedule move static contract: ok\n'
