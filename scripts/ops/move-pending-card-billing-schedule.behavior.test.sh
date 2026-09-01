#!/usr/bin/env bash
# Behavioral safety harness for move-pending-card-billing-schedule.sh.
# Uses only local HTTP and SQL doubles; it cannot contact Asaas or production.

set -Eeuo pipefail

readonly TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly OPERATOR_UNDER_TEST="${OPERATOR_UNDER_TEST:-$TEST_DIR/move-pending-card-billing-schedule.sh}"
readonly FIXTURE_DIR="$TEST_DIR/test-fixtures/card-schedule-move"
readonly TEST_TOKEN='fixture-token-never-log-7cbd73f1'

[[ -x "$OPERATOR_UNDER_TEST" ]] || {
  printf 'operator is not executable: %s\n' "$OPERATOR_UNDER_TEST" >&2
  exit 1
}
command -v jq >/dev/null
command -v python3 >/dev/null

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ww-card-move-behavior.XXXXXX")"
CASE_DIR=""
RUN_LOG=""
RUN_RC=0
RUN_NUMBER=0

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ "${KEEP_TEST_ROOT:-0}" == 1 ]]; then
    printf 'behavior fixtures kept at %s\n' "$TEST_ROOT" >&2
    exit "$code"
  fi
  if [[ -n "$TEST_ROOT" && -d "$TEST_ROOT" && "$TEST_ROOT" == */ww-card-move-behavior.* ]]; then
    rm -rf -- "$TEST_ROOT"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
assert_eq() {
  local expected="$1" actual="$2" message="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$message (expected=$expected actual=$actual)"
}
assert_jq() {
  local file="$1" expression="$2" message="$3"
  jq -e "$expression" "$file" >/dev/null || fail "$message"
}

setup_case() {
  local name="$1"
  CASE_DIR="$TEST_ROOT/$name"
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/tmp"
  ln -s "$FIXTURE_DIR/mock-curl.py" "$CASE_DIR/bin/curl"
  ln -s "$FIXTURE_DIR/mock-psql.py" "$CASE_DIR/bin/psql"
  : > "$CASE_DIR/http-calls.jsonl"
  : > "$CASE_DIR/db-calls.jsonl"
  printf '[]\n' > "$CASE_DIR/behaviors.json"
  jq -cn \
    --arg offer '20000000-0000-4000-8000-000000000002' \
    '{
      subscription:{
        id:"sub_fixture1234",customer:"cus_fixture1234",status:"ACTIVE",
        nextDueDate:"2026-11-10",endDate:"2027-09-10",
        billingType:"CREDIT_CARD",cycle:"MONTHLY",value:169,
        externalReference:("enrollment:"+$offer+":subscription"),
        maxPayments:12,creditCard:{creditCardBrand:"VISA",creditCardNumber:"**** 4242"}
      },
      payment:{
        id:"pay_fixture1234",customer:"cus_fixture1234",subscription:"sub_fixture1234",
        status:"PENDING",dueDate:"2026-10-10",originalDueDate:"2026-10-10",
        billingType:"CREDIT_CARD",externalReference:("enrollment:"+$offer+":subscription"),
        value:169,deleted:false,paymentDate:null,clientPaymentDate:null,
        confirmedDate:null,creditDate:null
      }
    }
    |.payments=[.payment]' > "$CASE_DIR/provider.json"
  RUN_NUMBER=0
}

set_behaviors() {
  printf '%s\n' "$1" > "$CASE_DIR/behaviors.json"
}

run_operator() {
  local command="$1"
  shift
  RUN_NUMBER=$((RUN_NUMBER + 1))
  RUN_LOG="$CASE_DIR/run-$RUN_NUMBER.log"
  set +e
  PATH="$CASE_DIR/bin:$PATH" \
    MOCK_STATE_DIR="$CASE_DIR" \
    TMPDIR="$CASE_DIR/tmp" \
    PGHOST=fixture PGDATABASE=fixture PGUSER=fixture \
    ASAAS_ACCESS_TOKEN="$TEST_TOKEN" \
    "$OPERATOR_UNDER_TEST" "$command" \
      --mode execute \
      --operation-key "card-schedule-move:behavior:fixture-v1" \
      --confirm-operation "card-schedule-move:behavior:fixture-v1" \
      --tenant-id school-test-fixture \
      --student-id 10000000-0000-4000-8000-000000000001 \
      --offer-id 20000000-0000-4000-8000-000000000002 \
      --customer-id cus_fixture1234 \
      --subscription-id sub_fixture1234 \
      --payment-id pay_fixture1234 \
      --student-payment-id 30000000-0000-4000-8000-000000000003 \
      --old-due-date 2026-10-10 \
      --target-due-date 2026-09-10 \
      --target-end-date 2027-08-10 \
      --original-next-due-date 2026-11-10 \
      --original-end-date 2027-09-10 \
      --accept-events-until 2099-09-08T23:59:59Z \
      --provider-environment production \
      --asaas-base-url https://api.asaas.com/v3 \
      "$@" >"$RUN_LOG" 2>&1
  RUN_RC=$?
  set -e
}

prepare_case() {
  run_operator prepare
  assert_eq 0 "$RUN_RC" "prepare must succeed"
  assert_jq "$CASE_DIR/db.json" '.operation.status=="READY" and .claim_present==true' \
    "prepare must create a READY four-step ledger with a bound claim"
}

apply_step() {
  local name="$1"
  run_operator apply --step "$name"
}

http_put_count() {
  jq -s '[.[]|select(.method=="PUT")]|length' "$CASE_DIR/http-calls.jsonl"
}

http_get_count() {
  jq -s '[.[]|select(.method=="GET")]|length' "$CASE_DIR/http-calls.jsonl"
}

logical_put_count() {
  local name="$1"
  jq -s --arg name "$name" '[.[]|select(.method=="PUT" and .logicalStep==$name)]|length' \
    "$CASE_DIR/http-calls.jsonl"
}

assert_at_most_one_put_per_step() {
  jq -se '
    [.[]|select(.method=="PUT")]
    |sort_by(.logicalStep)|group_by(.logicalStep)|all(length<=1)
  ' "$CASE_DIR/http-calls.jsonl" >/dev/null ||
    fail "a logical step issued more than one PUT"
}

assert_no_delete_or_token_log() {
  if jq -se 'any(.method=="DELETE")' "$CASE_DIR/http-calls.jsonl" >/dev/null; then
    fail "operator issued DELETE"
  fi
  if grep -F "$TEST_TOKEN" "$CASE_DIR"/run-*.log "$CASE_DIR/http-calls.jsonl" \
      "$CASE_DIR/db-calls.jsonl" >/dev/null 2>&1; then
    fail "access token appeared in captured output or call logs"
  fi
}

test_ambiguous_result() {
  local name="$1" behavior="$2" first_expected_rc="$3"
  setup_case "$name"
  prepare_case
  set_behaviors "[\"$behavior\"]"
  apply_step MOVE_PAYMENT_TO_TARGET
  if [[ "$first_expected_rc" == 0 ]]; then
    assert_eq 0 "$RUN_RC" "$behavior apply should be safely recorded"
    assert_jq "$CASE_DIR/db.json" \
      '.operation.status=="UNKNOWN" and (.steps[]|select(.step_kind=="MOVE_PAYMENT_TO_TARGET")|.status)=="UNKNOWN"' \
      "$behavior must become UNKNOWN"
  else
    [[ "$RUN_RC" != 0 ]] || fail "$behavior must interrupt the operator"
    assert_jq "$CASE_DIR/db.json" \
      '.operation.status=="MOVING_PAYMENT" and (.steps[]|select(.step_kind=="MOVE_PAYMENT_TO_TARGET")|.status)=="SUBMITTING"' \
      "crash must leave a durable SUBMITTING fence"
  fi
  assert_eq 1 "$(http_put_count)" "$behavior must issue exactly one PUT"
  local gets_before
  gets_before="$(http_get_count)"
  set_behaviors '[]'
  apply_step MOVE_PAYMENT_TO_TARGET
  assert_eq 0 "$RUN_RC" "re-executed apply must switch to GET-only reconcile"
  assert_jq "$CASE_DIR/db.json" \
    '.operation.status=="UNKNOWN" and (.steps[]|select(.step_kind=="MOVE_PAYMENT_TO_TARGET")|.status)=="UNKNOWN" and (.steps[]|select(.step_kind=="MOVE_PAYMENT_TO_TARGET")|.submit_attempt_count)==1' \
    "GET-only reconcile must preserve UNKNOWN and the single submit attempt"
  assert_eq 1 "$(http_put_count)" "re-executed apply must not send a second PUT"
  [[ "$(http_get_count)" -gt "$gets_before" ]] || fail "re-executed apply must perform GET"
  apply_step MOVE_PAYMENT_TO_TARGET
  assert_eq 0 "$RUN_RC" "a further apply must remain GET-only"
  assert_eq 1 "$(http_put_count)" "UNKNOWN step must remain permanently no-resubmit"
  assert_at_most_one_put_per_step
  assert_no_delete_or_token_log
  pass "$name: ambiguous outcome is GET-only after one PUT"
}

test_move_rejection_and_claim_cleanup() {
  setup_case move_400_cleanup
  prepare_case
  set_behaviors '["http_400_no_effect"]'
  apply_step MOVE_PAYMENT_TO_TARGET
  assert_eq 0 "$RUN_RC" "explicit MOVE 400 with exact original state must be recorded"
  assert_jq "$CASE_DIR/db.json" \
    '.operation.status=="FAILED" and .claim_present==false and .local_due=="2026-10-10" and (.steps[]|select(.step_kind=="MOVE_PAYMENT_TO_TARGET")|.status)=="FAILED"' \
    "exact no-effect rejection must release only the provisional September claim"
  assert_eq 1 "$(logical_put_count MOVE_PAYMENT_TO_TARGET)" "MOVE rejection must have one PUT"
  assert_at_most_one_put_per_step
  assert_no_delete_or_token_log
  pass "MOVE 4xx no-effect releases the fenced provisional claim"

  setup_case move_400_cleanup_fence
  prepare_case
  set_behaviors '["http_400_causal_event"]'
  apply_step MOVE_PAYMENT_TO_TARGET
  [[ "$RUN_RC" != 0 ]] || fail "causal target evidence must block claim cleanup"
  assert_jq "$CASE_DIR/db.json" \
    '.claim_present==true and .causal_target_event==true and .operation.status=="MOVING_PAYMENT" and (.steps[]|select(.step_kind=="MOVE_PAYMENT_TO_TARGET")|.status)=="SUBMITTING"' \
    "claim cleanup fence must preserve claim and in-flight ledger"
  set_behaviors '[]'
  apply_step MOVE_PAYMENT_TO_TARGET
  assert_eq 0 "$RUN_RC" "fenced in-flight MOVE must reconcile by GET only"
  assert_eq 1 "$(logical_put_count MOVE_PAYMENT_TO_TARGET)" "cleanup fence must not allow resubmit"
  assert_jq "$CASE_DIR/db.json" '.claim_present==true and .operation.status=="UNKNOWN"' \
    "ambiguous cleanup must preserve the claim"
  assert_no_delete_or_token_log
  pass "MOVE claim cleanup is refused when causal September evidence exists"
}

test_update_rejection_rolls_back() {
  setup_case update_400_rollback
  prepare_case
  set_behaviors '["success"]'
  apply_step MOVE_PAYMENT_TO_TARGET
  assert_eq 0 "$RUN_RC" "MOVE success must complete"
  assert_jq "$CASE_DIR/db.json" '.operation.status=="PAYMENT_MOVED" and .local_due=="2026-09-10"' \
    "MOVE must be causally reconciled before UPDATE"

  set_behaviors '["http_400_no_effect"]'
  apply_step UPDATE_TARGET_SCHEDULE
  assert_eq 0 "$RUN_RC" "explicit UPDATE rejection must enter compensation"
  assert_jq "$CASE_DIR/db.json" \
    '.operation.status=="COMPENSATING" and .claim_present==true and (.steps[]|select(.step_kind=="UPDATE_TARGET_SCHEDULE")|.status)=="FAILED"' \
    "UPDATE 4xx must preserve the claim and begin rollback"

  set_behaviors '[]'
  apply_step RESTORE_ORIGINAL_SCHEDULE
  assert_eq 0 "$RUN_RC" "already-original schedule must be recorded as a no-op"
  assert_jq "$CASE_DIR/db.json" \
    '.operation.status=="ORIGINAL_SCHEDULE_RESTORED" and (.steps[]|select(.step_kind=="RESTORE_ORIGINAL_SCHEDULE")|.status)=="SUCCEEDED" and (.steps[]|select(.step_kind=="RESTORE_ORIGINAL_SCHEDULE")|.submit_attempt_count)==0' \
    "schedule rollback no-op must not consume a PUT attempt"
  assert_eq 0 "$(logical_put_count RESTORE_ORIGINAL_SCHEDULE)" "schedule no-op must issue no PUT"

  set_behaviors '["success"]'
  apply_step RESTORE_ORIGINAL_PAYMENT
  assert_eq 0 "$RUN_RC" "payment restore must succeed"
  assert_jq "$CASE_DIR/db.json" '.operation.status=="RESTORING_ORIGINAL_PAYMENT" and .local_due=="2026-10-10"' \
    "restored payment must await final GET/local reconciliation"
  run_operator reconcile
  assert_eq 0 "$RUN_RC" "final compensation reconcile must succeed"
  assert_jq "$CASE_DIR/db.json" '.operation.status=="COMPENSATED" and .claim_present==false' \
    "complete rollback must release the provisional claim"
  assert_jq "$CASE_DIR/provider.json" \
    '.payment.id=="pay_fixture1234" and .payment.dueDate=="2026-10-10" and (.payments|length)==1 and .payments[0].id=="pay_fixture1234"' \
    "rollback must keep the same payment and restore 10 October"
  assert_eq 1 "$(logical_put_count MOVE_PAYMENT_TO_TARGET)" "MOVE must have one PUT"
  assert_eq 1 "$(logical_put_count UPDATE_TARGET_SCHEDULE)" "UPDATE must have one PUT"
  assert_eq 1 "$(logical_put_count RESTORE_ORIGINAL_PAYMENT)" "payment restore must have one PUT"
  assert_at_most_one_put_per_step
  assert_no_delete_or_token_log
  pass "UPDATE 4xx performs a reversible, single-PUT-per-step rollback"
}

test_immediate_october_exact_list() {
  setup_case immediate_october
  prepare_case
  set_behaviors '["success"]'
  apply_step MOVE_PAYMENT_TO_TARGET
  assert_eq 0 "$RUN_RC" "MOVE must succeed"
  set_behaviors '["success_update_immediate_oct"]'
  apply_step UPDATE_TARGET_SCHEDULE
  assert_eq 0 "$RUN_RC" "UPDATE with immediate October generation must succeed"
  assert_jq "$CASE_DIR/db.json" '.operation.status=="TARGET_SCHEDULED"' \
    "exact September+October list must be accepted"
  assert_jq "$CASE_DIR/provider.json" \
    '.subscription.nextDueDate=="2026-11-10" and .subscription.endDate=="2027-08-10" and (.payments|length)==2 and .payments[0].id=="pay_fixture1234" and .payments[0].dueDate=="2026-09-10" and .payments[0].originalDueDate=="2026-10-10" and .payments[1].id=="pay_generated_oct" and .payments[1].dueDate=="2026-10-10" and .payments[1].originalDueDate=="2026-10-10"' \
    "provider must contain exactly moved September plus one generated October payment"
  run_operator reconcile
  assert_eq 0 "$RUN_RC" "exact immediate-generation schedule must reconcile"
  assert_jq "$CASE_DIR/db.json" '.operation.status=="COMPLETED" and .claim_present==true' \
    "target schedule must complete without deleting its bound claim"
  assert_at_most_one_put_per_step
  assert_no_delete_or_token_log
  pass "immediate October generation is accepted only as the exact two-payment list"
}

test_extra_payment_blocks_completion() {
  setup_case unexpected_extra_payment
  prepare_case
  set_behaviors '["success"]'
  apply_step MOVE_PAYMENT_TO_TARGET
  assert_eq 0 "$RUN_RC" "MOVE must succeed before extra-list test"
  set_behaviors '["success_update_extra"]'
  apply_step UPDATE_TARGET_SCHEDULE
  assert_eq 0 "$RUN_RC" "2xx with an unsafe list must be durably marked ambiguous"
  assert_jq "$CASE_DIR/db.json" \
    '.operation.status=="UNKNOWN" and (.steps[]|select(.step_kind=="UPDATE_TARGET_SCHEDULE")|.status)=="UNKNOWN"' \
    "unexpected November payment must block schedule success"
  assert_jq "$CASE_DIR/provider.json" '(.payments|length)==3' \
    "fixture must contain the unexpected extra payment"
  local puts_before
  puts_before="$(http_put_count)"
  apply_step UPDATE_TARGET_SCHEDULE
  assert_eq 0 "$RUN_RC" "unsafe list recheck must remain GET-only"
  assert_eq "$puts_before" "$(http_put_count)" "unsafe list must never trigger a second PUT"
  assert_jq "$CASE_DIR/db.json" '.operation.status=="UNKNOWN"' \
    "extra list must remain blocked for manual reconciliation"
  run_operator reconcile
  [[ "$RUN_RC" != 0 ]] || fail "UNKNOWN operation with extra payments cannot complete"
  assert_eq "$puts_before" "$(http_put_count)" "blocked final reconcile must issue no PUT"
  assert_at_most_one_put_per_step
  assert_no_delete_or_token_log
  pass "unexpected future payment blocks completion and all resubmission"
}

test_static_no_delete_contract() {
  if grep -Eq "asaas_call[[:space:]]+DELETE|--request[[:space:]]+['\"]?DELETE" \
      "$OPERATOR_UNDER_TEST"; then
    fail "operator contains an HTTP DELETE call"
  fi
  local sql_dir
  sql_dir="$(cd "$(dirname "$OPERATOR_UNDER_TEST")/card-schedule-move" && pwd)"
  if grep -R -Eq "'method'[[:space:]]*,[[:space:]]*'DELETE'" "$sql_dir"; then
    fail "provider descriptor contains DELETE"
  fi
  pass "static provider mutation contract contains no DELETE"
}

test_static_no_delete_contract
test_ambiguous_result crash crash_before_response 1
test_ambiguous_result timeout timeout_no_effect 0
test_ambiguous_result http_408 http_408_no_effect 0
test_ambiguous_result http_429 http_429_no_effect 0
test_ambiguous_result http_503 http_503_no_effect 0
test_ambiguous_result unconfirmed_2xx http_200_no_effect 0
test_move_rejection_and_claim_cleanup
test_update_rejection_rolls_back
test_immediate_october_exact_list
test_extra_payment_blocks_completion

printf 'PASS: behavioral card-schedule-move safety harness\n'
