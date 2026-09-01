#!/usr/bin/env bash
# Reversibly move one existing pending CREDIT_CARD subscription payment to the
# previous month, then realign the subscription. Never deletes a payment.

set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SQL_DIR="$SCRIPT_DIR/card-schedule-move"

COMMAND=""
MODE=""
STEP_KIND=""
OPERATION_KEY=""
CONFIRM_OPERATION_KEY=""
TENANT_ID=""
STUDENT_ID=""
OFFER_ID=""
CUSTOMER_ID=""
SUBSCRIPTION_ID=""
PAYMENT_ID=""
STUDENT_PAYMENT_ID=""
OLD_DUE_DATE=""
TARGET_DUE_DATE=""
TARGET_END_DATE=""
ORIGINAL_NEXT_DUE_DATE=""
ORIGINAL_END_DATE=""
ACCEPT_EVENTS_UNTIL=""
PROVIDER_ENVIRONMENT=""
ASAAS_BASE_URL="${ASAAS_API_URL:-}"
EXPECTED_MAX_PAYMENTS="12"
EXPECTED_VALUE=""

TMP_DIR=""
ASAAS_HEADERS_FILE=""
ASAAS_TOKEN=""
HTTP_STATUS=""
HTTP_EXIT_CODE=""
OBSERVED_JSON=""
ORIGINAL_SUBSCRIPTION_JSON=""
ORIGINAL_PAYMENT_JSON=""
ORIGINAL_PAYMENTS_JSON=""
INTEGRATION_SNAPSHOT_JSON=""
CURRENT_CONTEXT_JSON=""
STEP_EVIDENCE_JSON='[]'

usage() {
  cat <<'USAGE'
Uso:
  move-pending-card-billing-schedule.sh <comando> [opcoes]

Comandos:
  preflight   GET/read-only; nao altera banco nem Asaas.
  prepare     Congela snapshots, claim deterministico e quatro steps.
  apply       Envia no maximo um PUT (--step obrigatorio).
  reconcile   Somente GET; com --step resolve resultado ambiguo.
  compensate  Abandona UPDATE ainda nao enviado e inicia restauracao.
  abort       Cancela READY nunca enviado apos GET original exato.
  status      Le somente o ledger.

Steps:
  MOVE_PAYMENT_TO_TARGET
  UPDATE_TARGET_SCHEDULE
  RESTORE_ORIGINAL_SCHEDULE
  RESTORE_ORIGINAL_PAYMENT

Opcoes obrigatorias:
  --mode dry-run|execute
  --operation-key CHAVE
  --tenant-id ID
  --student-id UUID
  --offer-id UUID
  --customer-id cus_...
  --subscription-id sub_...
  --payment-id pay_...
  --student-payment-id UUID
  --old-due-date YYYY-MM-DD
  --target-due-date YYYY-MM-DD
  --target-end-date YYYY-MM-DD
  --original-next-due-date YYYY-MM-DD
  --original-end-date YYYY-MM-DD
  --accept-events-until RFC3339
  --provider-environment production|sandbox
  --asaas-base-url URL

Escritas exigem --confirm-operation identico a --operation-key.
O token Asaas e aceito somente em ASAAS_ACCESS_TOKEN/ASAAS_API_KEY.
USAGE
}

die() { printf 'ERRO: %s\n' "$1" >&2; exit 1; }
note() { printf '%s\n' "$1"; }
require_value() { [[ -n "${2:-}" ]] || die "valor ausente para $1"; }
is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -f -- "$TMP_DIR"/* 2>/dev/null || true
    rmdir -- "$TMP_DIR" 2>/dev/null || true
  fi
  unset ASAAS_TOKEN ASAAS_ACCESS_TOKEN ASAAS_API_KEY PGPASSWORD
  exit "$code"
}
trap cleanup EXIT INT TERM

parse_args() {
  (($# > 0)) || { usage; exit 2; }
  COMMAND="$1"; shift
  case "$COMMAND" in
  preflight|prepare|apply|reconcile|compensate|abort|status) ;;
    help|-h|--help) usage; exit 0 ;;
    *) die "comando invalido: $COMMAND" ;;
  esac
  while (($#)); do
    case "$1" in
      --mode) require_value "$1" "${2:-}"; MODE="$2"; shift 2 ;;
      --step) require_value "$1" "${2:-}"; STEP_KIND="$2"; shift 2 ;;
      --operation-key) require_value "$1" "${2:-}"; OPERATION_KEY="$2"; shift 2 ;;
      --confirm-operation) require_value "$1" "${2:-}"; CONFIRM_OPERATION_KEY="$2"; shift 2 ;;
      --tenant-id) require_value "$1" "${2:-}"; TENANT_ID="$2"; shift 2 ;;
      --student-id) require_value "$1" "${2:-}"; STUDENT_ID="$2"; shift 2 ;;
      --offer-id) require_value "$1" "${2:-}"; OFFER_ID="$2"; shift 2 ;;
      --customer-id) require_value "$1" "${2:-}"; CUSTOMER_ID="$2"; shift 2 ;;
      --subscription-id) require_value "$1" "${2:-}"; SUBSCRIPTION_ID="$2"; shift 2 ;;
      --payment-id) require_value "$1" "${2:-}"; PAYMENT_ID="$2"; shift 2 ;;
      --student-payment-id) require_value "$1" "${2:-}"; STUDENT_PAYMENT_ID="$2"; shift 2 ;;
      --old-due-date) require_value "$1" "${2:-}"; OLD_DUE_DATE="$2"; shift 2 ;;
      --target-due-date) require_value "$1" "${2:-}"; TARGET_DUE_DATE="$2"; shift 2 ;;
      --target-end-date) require_value "$1" "${2:-}"; TARGET_END_DATE="$2"; shift 2 ;;
      --original-next-due-date) require_value "$1" "${2:-}"; ORIGINAL_NEXT_DUE_DATE="$2"; shift 2 ;;
      --original-end-date) require_value "$1" "${2:-}"; ORIGINAL_END_DATE="$2"; shift 2 ;;
      --accept-events-until) require_value "$1" "${2:-}"; ACCEPT_EVENTS_UNTIL="$2"; shift 2 ;;
      --provider-environment) require_value "$1" "${2:-}"; PROVIDER_ENVIRONMENT="$2"; shift 2 ;;
      --asaas-base-url) require_value "$1" "${2:-}"; ASAAS_BASE_URL="$2"; shift 2 ;;
      --target-claim-fingerprint)
        die "fingerprint livre foi removido; o banco calcula o claim" ;;
      --asaas-token|--api-key|--password|--database-url)
        die "segredos nao sao aceitos por argumento" ;;
      *) die "opcao desconhecida: $1" ;;
    esac
  done
}

validate_args() {
  local name
  for name in MODE OPERATION_KEY TENANT_ID STUDENT_ID OFFER_ID CUSTOMER_ID \
    SUBSCRIPTION_ID PAYMENT_ID STUDENT_PAYMENT_ID OLD_DUE_DATE TARGET_DUE_DATE \
    TARGET_END_DATE ORIGINAL_NEXT_DUE_DATE ORIGINAL_END_DATE \
    ACCEPT_EVENTS_UNTIL PROVIDER_ENVIRONMENT ASAAS_BASE_URL; do
    [[ -n "${!name}" ]] || die "parametro ausente: $name"
  done
  [[ "$MODE" == dry-run || "$MODE" == execute ]] || die "--mode invalido"
  [[ "$COMMAND" != preflight && "$COMMAND" != status || "$MODE" == dry-run ]] ||
    die "$COMMAND aceita somente dry-run"
  if [[ "$MODE" == execute ]]; then
    [[ "$CONFIRM_OPERATION_KEY" == "$OPERATION_KEY" ]] ||
      die "--confirm-operation deve ser identico a --operation-key"
  fi
  if [[ "$COMMAND" == apply ]]; then [[ -n "$STEP_KIND" ]] || die "apply exige --step"; fi
  if [[ -n "$STEP_KIND" ]]; then
    case "$STEP_KIND" in
      MOVE_PAYMENT_TO_TARGET|UPDATE_TARGET_SCHEDULE|RESTORE_ORIGINAL_SCHEDULE|RESTORE_ORIGINAL_PAYMENT) ;;
      *) die "--step invalido" ;;
    esac
  fi
  [[ "$OPERATION_KEY" =~ ^[a-z0-9][a-z0-9:_-]{7,199}$ ]] || die "operation-key invalida"
  is_uuid "$STUDENT_ID" || die "student-id invalido"
  is_uuid "$OFFER_ID" || die "offer-id invalido"
  is_uuid "$STUDENT_PAYMENT_ID" || die "student-payment-id invalido"
  [[ "$CUSTOMER_ID" =~ ^cus_[A-Za-z0-9_-]{4,196}$ ]] || die "customer-id invalido"
  [[ "$SUBSCRIPTION_ID" =~ ^sub_[A-Za-z0-9_-]{4,196}$ ]] || die "subscription-id invalido"
  [[ "$PAYMENT_ID" =~ ^pay_[A-Za-z0-9_-]{4,196}$ ]] || die "payment-id invalido"
  for name in OLD_DUE_DATE TARGET_DUE_DATE TARGET_END_DATE ORIGINAL_NEXT_DUE_DATE ORIGINAL_END_DATE; do
    [[ "${!name}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "$name invalida"
  done
  [[ "$PROVIDER_ENVIRONMENT" == production || "$PROVIDER_ENVIRONMENT" == sandbox ]] ||
    die "provider-environment invalido"
  ASAAS_BASE_URL="${ASAAS_BASE_URL%/}"
  [[ "$ASAAS_BASE_URL" == */v3 ]] || ASAAS_BASE_URL="$ASAAS_BASE_URL/v3"
  case "$PROVIDER_ENVIRONMENT:$ASAAS_BASE_URL" in
    production:https://api.asaas.com/v3|sandbox:https://api-sandbox.asaas.com/v3) ;;
    *) die "URL Asaas nao corresponde ao ambiente" ;;
  esac
}

init_dependencies() {
  command -v jq >/dev/null || die "jq ausente"
  command -v curl >/dev/null || [[ "$COMMAND" == status ]] || die "curl ausente"
  if [[ -n "${DB_CONTAINER:-}" ]]; then
    command -v docker >/dev/null || die "docker ausente"
  else
    command -v psql >/dev/null || die "psql ausente"
    [[ -n "${PGHOST:-}" && -n "${PGDATABASE:-}" && -n "${PGUSER:-}" ]] ||
      die "informe DB_CONTAINER ou variaveis libpq"
  fi
  if [[ "$COMMAND" != status ]]; then
    ASAAS_TOKEN="${ASAAS_ACCESS_TOKEN:-${ASAAS_API_KEY:-}}"
    [[ ${#ASAAS_TOKEN} -ge 16 ]] || die "credencial Asaas ausente"
    TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ww-card-move.XXXXXX")"
    ASAAS_HEADERS_FILE="$TMP_DIR/headers"
    printf 'access_token: %s\nContent-Type: application/json\nAccept: application/json\n' \
      "$ASAAS_TOKEN" > "$ASAAS_HEADERS_FILE"
    chmod 0600 "$ASAAS_HEADERS_FILE"
  fi
}

db_psql() {
  local -a args=(-X -q -v ON_ERROR_STOP=1)
  if [[ -n "${DB_CONTAINER:-}" ]]; then
    docker exec -i "$DB_CONTAINER" psql "${args[@]}" \
      -U "${DB_USER:-postgres}" -d "${DB_NAME:-postgres}" "$@"
  else
    command psql "${args[@]}" "$@"
  fi
}
db_file() { local file="$1"; shift; db_psql -At "$@" < "$file"; }

common_vars() {
  COMMON_VARS=(
    -v "operation_key=$OPERATION_KEY" -v "tenant_id=$TENANT_ID"
    -v "student_id=$STUDENT_ID" -v "offer_id=$OFFER_ID"
    -v "customer_id=$CUSTOMER_ID" -v "subscription_id=$SUBSCRIPTION_ID"
    -v "old_payment_id=$PAYMENT_ID" -v "old_student_payment_id=$STUDENT_PAYMENT_ID"
    -v "old_due_date=$OLD_DUE_DATE" -v "target_due_date=$TARGET_DUE_DATE"
    -v "target_end_date=$TARGET_END_DATE" -v "original_next_due_date=$ORIGINAL_NEXT_DUE_DATE"
    -v "original_end_date=$ORIGINAL_END_DATE" -v "accept_events_until=$ACCEPT_EVENTS_UNTIL"
    -v "provider_environment=$PROVIDER_ENVIRONMENT" -v "asaas_base_url=$ASAAS_BASE_URL"
    -v "expected_max_payments=$EXPECTED_MAX_PAYMENTS"
  )
}

asaas_call() {
  local method="$1" path="$2" output="$3" body="${4:-}"
  local -a args=(--silent --show-error --location --max-redirs 0 --retry 0
    --connect-timeout "${ASAAS_CONNECT_TIMEOUT_SECONDS:-8}"
    --max-time "${ASAAS_TIMEOUT_SECONDS:-25}" --request "$method"
    --url "$ASAAS_BASE_URL$path" --header "@$ASAAS_HEADERS_FILE"
    --output "$output" --write-out '%{http_code}')
  [[ -z "$body" ]] || args+=(--data-binary "@$body")
  set +e; HTTP_STATUS="$(curl "${args[@]}")"; HTTP_EXIT_CODE=$?; set -e
  [[ "$HTTP_STATUS" =~ ^[0-9]{3}$ ]] || HTTP_STATUS=000
}

safe_subscription() {
  jq -ceS '{id:(.id//null),customer:(.customer//null),status:(.status//null),
    nextDueDate:(.nextDueDate//null),endDate:(.endDate//null),
    billingType:(.billingType//null),cycle:(.cycle//null),value:(.value//null),
    externalReference:(.externalReference//null),maxPayments:(.maxPayments//null),
    cardAttached:([
      .creditCard.creditCardNumber?,.creditCard.cardNumber?,
      .creditCard.number?,.creditCard.last4?,.creditCardNumber?,.cardNumber?,.last4?
    ]|map(select(type=="string")|gsub("[^0-9]";""))|any(length>=4))}' "$1"
}
safe_payment() {
  jq -ceS '{id:(.id//null),customer:(.customer//null),subscription:(.subscription//null),
    status:(.status//null),dueDate:(.dueDate//null),
    originalDueDate:(.originalDueDate//null),billingType:(.billingType//null),
    externalReference:((.externalReference//"")|tostring
      |gsub("^[[:space:]]+|[[:space:]]+$";"")
      |if length==0 then null else . end),value:(.value//null),
    deleted:(.deleted//false),paymentDate:(.paymentDate//null),
    clientPaymentDate:(.clientPaymentDate//null),confirmedDate:(.confirmedDate//null),
    creditDate:(.creditDate//null)}' "$1"
}
provider_get() {
  local kind="$1" id="$2"
  local file="$TMP_DIR/get-$kind.json"
  asaas_call GET "/${kind}s/$id" "$file"
  [[ "$HTTP_EXIT_CODE" == 0 && "$HTTP_STATUS" == 200 ]] || return 1
  if [[ "$kind" == subscription ]]; then OBSERVED_JSON="$(safe_subscription "$file")";
  else OBSERVED_JSON="$(safe_payment "$file")"; fi
}

load_payments() {
  local file="$TMP_DIR/payments.json"
  asaas_call GET "/subscriptions/$SUBSCRIPTION_ID/payments?limit=100&offset=0" "$file"
  [[ "$HTTP_EXIT_CODE" == 0 && "$HTTP_STATUS" == 200 ]] || return 1
  jq -ceS --arg customer "$CUSTOMER_ID" --arg subscription "$SUBSCRIPTION_ID" '
    if type != "object" or (.data|type) != "array" or
       (.hasMore != false and .hasMore != null) or
       (.offset|type) != "number" or .offset != 0 or
       (.limit|type) != "number" or (.totalCount|type) != "number" or
       .limit < .totalCount or .totalCount != (.data|length) or
       .totalCount > 100 or
       (all(.data[]; .customer == $customer and .subscription == $subscription) | not)
    then error("invalid_or_truncated_payment_list")
    else [.data[] | {id,customer,subscription,status,dueDate,
      originalDueDate:(.originalDueDate//.dueDate),billingType,value,
      externalReference:((.externalReference//"")|tostring
        |gsub("^[[:space:]]+|[[:space:]]+$";"")
        |if length==0 then null else . end),
      deleted:(.deleted//false),paymentDate:(.paymentDate//null),
      clientPaymentDate:(.clientPaymentDate//null),confirmedDate:(.confirmedDate//null),
      creditDate:(.creditDate//null)}] end
  ' "$file"
}

provider_preflight() {
  provider_get subscription "$SUBSCRIPTION_ID" || die "GET assinatura falhou"
  ORIGINAL_SUBSCRIPTION_JSON="$OBSERVED_JSON"
  jq -e --arg id "$SUBSCRIPTION_ID" --arg customer "$CUSTOMER_ID" \
    --arg next "$ORIGINAL_NEXT_DUE_DATE" --arg end "$ORIGINAL_END_DATE" \
    --arg ref "enrollment:$OFFER_ID:subscription" '
      .id==$id and .customer==$customer and .status=="ACTIVE" and
      .nextDueDate==$next and .endDate==$end and .billingType=="CREDIT_CARD" and
      .cycle=="MONTHLY" and .maxPayments==12 and .externalReference==$ref and
      .cardAttached==true and
      (.value|type)=="number" and .value>0' <<< "$ORIGINAL_SUBSCRIPTION_JSON" >/dev/null ||
    die "assinatura divergiu do snapshot esperado"
  EXPECTED_VALUE="$(jq -er '.value' <<< "$ORIGINAL_SUBSCRIPTION_JSON")"

  provider_get payment "$PAYMENT_ID" || die "GET cobranca falhou"
  ORIGINAL_PAYMENT_JSON="$OBSERVED_JSON"
  jq -e --arg id "$PAYMENT_ID" --arg customer "$CUSTOMER_ID" \
    --arg subscription "$SUBSCRIPTION_ID" --arg due "$OLD_DUE_DATE" \
    --arg ref "enrollment:$OFFER_ID:subscription" \
    --argjson value "$EXPECTED_VALUE" '
      .id==$id and .customer==$customer and .subscription==$subscription and
      .status=="PENDING" and .dueDate==$due and .originalDueDate==$due and
      .billingType=="CREDIT_CARD" and
      (.externalReference==null or .externalReference==$ref) and
      .value==$value and .deleted==false and
      .paymentDate==null and .clientPaymentDate==null and
      .confirmedDate==null and .creditDate==null' <<< "$ORIGINAL_PAYMENT_JSON" >/dev/null ||
    die "cobranca nao esta pendente e intacta"

  local payments target_count duplicate
  payments="$(load_payments)" || die "lista de parcelas invalida ou truncada"
  jq -e --argjson expected "$ORIGINAL_PAYMENT_JSON" '
    length==1 and .[0]==$expected' <<< "$payments" >/dev/null ||
    die "lista nao contem somente a cobranca original exata"
  target_count="$(jq -r --arg month "${TARGET_DUE_DATE:0:7}" '
    [.[]|select(.deleted==false and
      (.dueDate[0:7]==$month or .originalDueDate[0:7]==$month))]|length
    ' <<< "$payments")"
  duplicate="$(jq -r '[.[]|select(.deleted==false)|.dueDate[0:7]]|sort|group_by(.)|any(length>1)' <<< "$payments")"
  [[ "$target_count" == 0 && "$duplicate" == false ]] ||
    die "competencia target ocupada ou lista possui duplicidade"
  ORIGINAL_PAYMENTS_JSON="$payments"
}

run_local_preflight() {
  common_vars
  local result
  result="$(db_file "$SQL_DIR/preflight.sql" "${COMMON_VARS[@]}" \
    -v "expected_value=$EXPECTED_VALUE")" || die "preflight local recusou"
  jq -e '.ok==true and (.integrationSnapshot|type)=="object"' <<< "$result" >/dev/null ||
    die "preflight local invalido"
  INTEGRATION_SNAPSHOT_JSON="$(jq -ceS '.integrationSnapshot' <<< "$result")"
}

load_context() {
  local require_integration="${1:-true}"
  common_vars
  CURRENT_CONTEXT_JSON="$(db_file "$SQL_DIR/load-context.sql" "${COMMON_VARS[@]}")" ||
    die "falha ao carregar ledger"
  [[ -n "$CURRENT_CONTEXT_JSON" ]] || return 1
  jq -e --argjson requireIntegration "$require_integration" '
    .operation!=null and .claim!=null and (.steps|length)==4 and
    (($requireIntegration|not) or .integrationLive==true)' \
    <<< "$CURRENT_CONTEXT_JSON" >/dev/null || die "ledger incompleto ou integracao mudou"
  EXPECTED_VALUE="$(jq -er '.operation.expected_value' <<< "$CURRENT_CONTEXT_JSON")"
}

prepare() {
  if load_context 2>/dev/null; then note "PREPARE ja existe; nada repetido."; return; fi
  provider_preflight
  run_local_preflight
  [[ "$MODE" == execute ]] || { note "Preflight aprovado; nenhuma escrita realizada."; return; }
  common_vars
  local result
  result="$(db_file "$SQL_DIR/prepare.sql" "${COMMON_VARS[@]}" \
    -v "expected_value=$EXPECTED_VALUE" \
    -v "original_subscription_snapshot=$ORIGINAL_SUBSCRIPTION_JSON" \
    -v "original_payment_snapshot=$ORIGINAL_PAYMENT_JSON" \
    -v "original_payments_snapshot=$ORIGINAL_PAYMENTS_JSON" \
    -v "integration_snapshot=$INTEGRATION_SNAPSHOT_JSON")" || die "PREPARE recusado"
  jq -e '.ok==true and .status=="READY" and .stepCount==4 and
    (.targetClaimFingerprint|test("^[a-f0-9]{64}$"))' <<< "$result" >/dev/null ||
    die "PREPARE retornou contrato invalido"
  note "PREPARE concluido com claim calculado pelo banco e quatro steps."
}

step_record() { jq -ce --arg step "$STEP_KIND" '.steps[]|select(.step_kind==$step)' <<< "$CURRENT_CONTEXT_JSON"; }
observe_step() {
  case "$STEP_KIND" in
    MOVE_PAYMENT_TO_TARGET|RESTORE_ORIGINAL_PAYMENT) provider_get payment "$PAYMENT_ID" ;;
    UPDATE_TARGET_SCHEDULE|RESTORE_ORIGINAL_SCHEDULE) provider_get subscription "$SUBSCRIPTION_ID" ;;
  esac
}

finish_step() {
  local status="$1" observed="$2" response="$3" http="$4" error="$5"
  local evidence="${6:-[]}"
  common_vars
  db_file "$SQL_DIR/finish-step.sql" "${COMMON_VARS[@]}" \
    -v "step_kind=$STEP_KIND" -v "step_status=$status" \
    -v "observed_after=$observed" -v "provider_response=$response" \
    -v "subscription_payments=$evidence" \
    -v "provider_http_status=$http" -v "last_error=$error" >/dev/null ||
    die "ledger recusou resultado do provider"
}

observed_matches_step_desired() {
  local record="$1" desired target_count next_count next_exact_count
  local duplicate next_due payment_count
  desired="$(jq -ce '.desired_after' <<< "$record")"
  STEP_EVIDENCE_JSON='[]'
  if [[ "$STEP_KIND" != UPDATE_TARGET_SCHEDULE ]] &&
     jq -e --argjson desired "$desired" '.==$desired' \
       <<< "$OBSERVED_JSON" >/dev/null; then
    STEP_EVIDENCE_JSON="$(load_payments)" || return 1
    case "$STEP_KIND" in
      MOVE_PAYMENT_TO_TARGET|RESTORE_ORIGINAL_SCHEDULE)
        jq -e --argjson payment "$(jq -ce \
          '.operation.target_payment_snapshot' <<< "$CURRENT_CONTEXT_JSON")" \
          '.==[$payment]' <<< "$STEP_EVIDENCE_JSON" >/dev/null ;;
      RESTORE_ORIGINAL_PAYMENT)
        jq -e --argjson expected "$(jq -ce \
          '.operation.original_payments_snapshot' <<< "$CURRENT_CONTEXT_JSON")" \
          '.==$expected' <<< "$STEP_EVIDENCE_JSON" >/dev/null ;;
      *) return 1 ;;
    esac
    return $?
  fi
  [[ "$STEP_KIND" == UPDATE_TARGET_SCHEDULE ]] || return 1
  jq -e --argjson desired "$desired" \
    --arg targetNext "$OLD_DUE_DATE" \
    --arg advancedNext "$ORIGINAL_NEXT_DUE_DATE" '
      (del(.nextDueDate) == ($desired|del(.nextDueDate))) and
      (.nextDueDate == $targetNext or .nextDueDate == $advancedNext)
    ' <<< "$OBSERVED_JSON" >/dev/null || return 1
  STEP_EVIDENCE_JSON="$(load_payments)" || return 1
  target_count="$(jq -r --arg id "$PAYMENT_ID" \
    --arg due "$TARGET_DUE_DATE" --arg original "$OLD_DUE_DATE" \
    --arg ref "enrollment:$OFFER_ID:subscription" \
    --argjson value "$EXPECTED_VALUE" '
      [.[]|select(.id==$id and .dueDate==$due and
        .originalDueDate==$original and .status=="PENDING" and
        .billingType=="CREDIT_CARD" and
        (.externalReference==null or .externalReference==$ref) and
        .value==$value and .deleted==false)]
      |length' <<< "$STEP_EVIDENCE_JSON")"
  next_count="$(jq -r --arg month "${OLD_DUE_DATE:0:7}" '
      [.[]|select(.deleted==false and .dueDate[0:7]==$month)]|length
    ' <<< "$STEP_EVIDENCE_JSON")"
  next_exact_count="$(jq -r --arg due "$OLD_DUE_DATE" \
    --arg ref "enrollment:$OFFER_ID:subscription" \
    --argjson value "$EXPECTED_VALUE" '
      [.[]|select(.dueDate==$due and .originalDueDate==$due and
        .status=="PENDING" and .billingType=="CREDIT_CARD" and
        (.externalReference==null or .externalReference==$ref) and
        .value==$value and .deleted==false)]|length
    ' <<< "$STEP_EVIDENCE_JSON")"
  duplicate="$(jq -r '
      [.[]|select(.deleted==false)|.dueDate[0:7]]
      |sort|group_by(.)|any(length>1)
    ' <<< "$STEP_EVIDENCE_JSON")"
  next_due="$(jq -er '.nextDueDate' <<< "$OBSERVED_JSON")"
  payment_count="$(jq -r 'length' <<< "$STEP_EVIDENCE_JSON")"
  [[ "$target_count" == 1 && "$duplicate" == false ]] || return 1
  [[ ("$next_due" == "$OLD_DUE_DATE" && "$next_count" == 0 &&
       "$payment_count" == 1) ||
     ("$next_due" == "$ORIGINAL_NEXT_DUE_DATE" && "$next_count" == 1 &&
       "$next_exact_count" == 1 && "$payment_count" == 2) ]]
}

record_noop() {
  local subscription_observed="$1" payment_observed="$2" payments_observed="$3"
  common_vars
  db_file "$SQL_DIR/record-noop.sql" "${COMMON_VARS[@]}" \
    -v "step_kind=$STEP_KIND" -v "observed_after=$OBSERVED_JSON" \
    -v "subscription_observed=$subscription_observed" \
    -v "payment_observed=$payment_observed" \
    -v "subscription_payments=$payments_observed" >/dev/null ||
    die "ledger recusou compensacao no-op"
}

safe_response() {
  jq -ceS 'if type=="object" then {id:(.id//null),status:(.status//null),
    dueDate:(.dueDate//null),nextDueDate:(.nextDueDate//null),
    endDate:(.endDate//null),errors:((.errors//[])|map({code,description}))}
    else {unparseable:true} end' "$1" 2>/dev/null || printf '%s' '{"unparseable":true}'
}

apply_step() {
  [[ "$MODE" == execute ]] || die "apply exige execute"
  case "$STEP_KIND" in
    RESTORE_ORIGINAL_SCHEDULE|RESTORE_ORIGINAL_PAYMENT)
      load_context false || die "execute prepare primeiro" ;;
    *) load_context true || die "execute prepare primeiro" ;;
  esac
  local record status expected desired submit descriptor method path body
  local entity_observed payment_observed subscription_observed
  local subscription_payments
  record="$(step_record)" || die "step ausente"
  status="$(jq -er '.status' <<< "$record")"
  case "$status" in
    SUCCEEDED) note "Step ja concluido; nada repetido."; return ;;
    SUBMITTING|UNKNOWN) note "Step ambiguo; convertendo para reconcile GET-only."; reconcile_step; return ;;
    READY) ;;
    *) die "step $status nao pode ser enviado" ;;
  esac
  observe_step || die "GET pre-submit falhou; nenhum PUT enviado"
  entity_observed="$OBSERVED_JSON"
  case "$STEP_KIND" in
    MOVE_PAYMENT_TO_TARGET|RESTORE_ORIGINAL_PAYMENT)
      payment_observed="$entity_observed"
      provider_get subscription "$SUBSCRIPTION_ID" ||
        die "GET assinatura pre-submit falhou; nenhum PUT enviado"
      subscription_observed="$OBSERVED_JSON"
      OBSERVED_JSON="$entity_observed" ;;
    UPDATE_TARGET_SCHEDULE|RESTORE_ORIGINAL_SCHEDULE)
      subscription_observed="$entity_observed"
      provider_get payment "$PAYMENT_ID" ||
        die "GET payment pre-submit falhou; nenhum PUT enviado"
      payment_observed="$OBSERVED_JSON"
      OBSERVED_JSON="$entity_observed" ;;
  esac
  subscription_payments="$(load_payments)" ||
    die "lista pre-submit invalida; nenhum PUT enviado"
  expected="$(jq -ce '.expected_before' <<< "$record")"
  desired="$(jq -ce '.desired_after' <<< "$record")"
  if jq -e --argjson desired "$desired" '.==$desired' <<< "$OBSERVED_JSON" >/dev/null; then
    case "$STEP_KIND" in
      RESTORE_ORIGINAL_SCHEDULE|RESTORE_ORIGINAL_PAYMENT)
        record_noop "$subscription_observed" "$payment_observed" \
          "$subscription_payments"
        note "Estado de compensacao ja estava aplicado; sem PUT."; return ;;
      *) die "provedor mudou antes do submit; revisao obrigatoria" ;;
    esac
  fi
  jq -e --argjson expected "$expected" '.==$expected' <<< "$OBSERVED_JSON" >/dev/null ||
    die "estado provider divergiu; nenhum PUT enviado"

  common_vars
  submit="$(db_file "$SQL_DIR/mark-submitting.sql" "${COMMON_VARS[@]}" \
    -v "step_kind=$STEP_KIND" -v "observed_before=$OBSERVED_JSON" \
    -v "subscription_observed=$subscription_observed" \
    -v "payment_observed=$payment_observed" \
    -v "subscription_payments=$subscription_payments")" ||
    die "fence SUBMITTING recusou"
  descriptor="$(jq -ce '.providerRequest' <<< "$submit")"
  method="$(jq -er '.method' <<< "$descriptor")"
  path="$(jq -er '.path' <<< "$descriptor")"
  body="$(jq -ce '.body' <<< "$descriptor")"
  local body_file="$TMP_DIR/body.json" response_file="$TMP_DIR/response.json"
  printf '%s' "$body" > "$body_file"
  asaas_call "$method" "$path" "$response_file" "$body_file"
  local mutation_http="$HTTP_STATUS" mutation_exit="$HTTP_EXIT_CODE" response
  [[ "$mutation_http" == 000 ]] && mutation_http=""
  response="$(safe_response "$response_file")"
  if observe_step; then :; else OBSERVED_JSON='{"available":false}'; fi

  if observed_matches_step_desired "$record"; then
    finish_step SUCCEEDED "$OBSERVED_JSON" "$response" "$mutation_http" "" \
      "$STEP_EVIDENCE_JSON"
    note "PUT confirmado por GET; step concluido."
  elif [[ "$mutation_exit" != 0 || -z "$mutation_http" ||
          "$mutation_http" == 408 || "$mutation_http" == 429 ||
          ! "$mutation_http" =~ ^4[0-9][0-9]$ ]]; then
    finish_step UNKNOWN "$OBSERVED_JSON" "$response" "$mutation_http" \
      "provider_mutation_outcome_unknown"
    note "Resultado ambiguo; somente reconcile GET sera permitido."
  elif jq -e --argjson expected "$expected" '.==$expected' <<< "$OBSERVED_JSON" >/dev/null; then
    if [[ "$STEP_KIND" == MOVE_PAYMENT_TO_TARGET ||
          "$STEP_KIND" == UPDATE_TARGET_SCHEDULE ]]; then
      local rejected_payments expected_payments
      rejected_payments="$(load_payments)" || {
        finish_step BLOCKED "$OBSERVED_JSON" "$response" "$mutation_http" \
          "provider_failure_payment_list_unavailable"
        die "falha explicita sem lista segura; claim preservado"
      }
      if [[ "$STEP_KIND" == MOVE_PAYMENT_TO_TARGET ]]; then
        expected_payments="$(jq -ce '.operation.original_payments_snapshot' \
          <<< "$CURRENT_CONTEXT_JSON")"
      else
        expected_payments="[$(jq -ce '.operation.target_payment_snapshot' \
          <<< "$CURRENT_CONTEXT_JSON")]"
      fi
      if ! jq -e --argjson expectedList "$expected_payments" \
           '.==$expectedList' <<< "$rejected_payments" >/dev/null; then
        finish_step BLOCKED "$OBSERVED_JSON" "$response" "$mutation_http" \
          "provider_failure_payment_list_diverged" "$rejected_payments"
        die "lista divergiu apos rejeicao; claim preservado"
      fi
      STEP_EVIDENCE_JSON="$rejected_payments"
    fi
    finish_step FAILED "$OBSERVED_JSON" "$response" "$mutation_http" \
      "provider_mutation_rejected" "$STEP_EVIDENCE_JSON"
    [[ "$STEP_KIND" == UPDATE_TARGET_SCHEDULE ]] &&
      note "Agenda recusada; execute as duas etapas de restauracao." ||
      note "PUT recusado sem efeito provider."
  else
    finish_step BLOCKED "$OBSERVED_JSON" "$response" "$mutation_http" \
      "provider_state_diverged_after_rejection"
    die "provider divergiu; operacao BLOCKED"
  fi
}

reconcile_step() {
  case "$STEP_KIND" in
    RESTORE_ORIGINAL_SCHEDULE|RESTORE_ORIGINAL_PAYMENT)
      load_context false || die "operacao ausente" ;;
    *) load_context true || die "operacao ausente" ;;
  esac
  local record status desired
  record="$(step_record)" || die "step ausente"
  status="$(jq -er '.status' <<< "$record")"
  [[ "$status" == SUBMITTING || "$status" == UNKNOWN ]] || die "step nao esta ambiguo"
  observe_step || die "GET indisponivel; ledger preservado"
  desired="$(jq -ce '.desired_after' <<< "$record")"
  if observed_matches_step_desired "$record"; then
    finish_step SUCCEEDED "$OBSERVED_JSON" '{}' "" "reconciled_by_get" \
      "$STEP_EVIDENCE_JSON"
    note "GET confirmou o PUT sem reenvio."
  else
    finish_step UNKNOWN "$OBSERVED_JSON" '{}' "" "provider_mutation_still_ambiguous"
    note "GET ainda nao prova o resultado; UNKNOWN preservado."
  fi
}

reconcile_operation() {
  load_context false || die "operacao ausente"
  local status subscription payment payments result
  status="$(jq -er '.operation.status' <<< "$CURRENT_CONTEXT_JSON")"
  [[ "$status" == TARGET_SCHEDULED || "$status" == AWAITING_LOCAL_RECONCILIATION ||
     "$status" == RESTORING_ORIGINAL_PAYMENT ]] || die "operacao nao pronta para reconcile final"
  provider_get subscription "$SUBSCRIPTION_ID" || die "GET assinatura falhou"
  subscription="$OBSERVED_JSON"
  provider_get payment "$PAYMENT_ID" || die "GET payment falhou"
  payment="$OBSERVED_JSON"
  payments="$(load_payments)" || die "lista de parcelas invalida/truncada"
  common_vars
  result="$(db_file "$SQL_DIR/reconcile-operation.sql" "${COMMON_VARS[@]}" \
    -v "subscription_observed=$subscription" -v "payment_observed=$payment" \
    -v "subscription_payments=$payments")" || die "reconcile local recusou"
  note "status=$(jq -er '.status' <<< "$result")"
}

begin_compensation() {
  [[ "$MODE" == execute ]] || die "compensate exige execute"
  [[ -z "$STEP_KIND" ]] || die "compensate nao aceita --step"
  load_context false || die "operacao ausente"
  [[ "$(jq -er '.operation.status' <<< "$CURRENT_CONTEXT_JSON")" == PAYMENT_MOVED ]] ||
    die "compensate exige operacao PAYMENT_MOVED"
  provider_get subscription "$SUBSCRIPTION_ID" || die "GET assinatura falhou"
  local subscription="$OBSERVED_JSON"
  provider_get payment "$PAYMENT_ID" || die "GET payment falhou"
  local payment="$OBSERVED_JSON" payments result
  payments="$(load_payments)" || die "lista de parcelas invalida/truncada"
  common_vars
  result="$(db_file "$SQL_DIR/begin-compensation.sql" "${COMMON_VARS[@]}" \
    -v "subscription_observed=$subscription" -v "payment_observed=$payment" \
    -v "subscription_payments=$payments")" ||
    die "inicio de compensacao recusado"
  jq -e '.status=="COMPENSATING" and .updateStepStatus=="FAILED"' \
    <<< "$result" >/dev/null || die "compensacao nao foi confirmada"
  note "UPDATE nunca enviado foi abandonado; restauracao liberada."
}

abort_unsubmitted() {
  [[ "$MODE" == execute ]] || die "abort exige execute"
  load_context false || die "operacao ausente"
  [[ "$(jq -er '.operation.status' <<< "$CURRENT_CONTEXT_JSON")" == READY ]] ||
    die "abort aceita somente operacao READY"
  provider_get subscription "$SUBSCRIPTION_ID" || die "GET assinatura falhou"
  local subscription="$OBSERVED_JSON"
  provider_get payment "$PAYMENT_ID" || die "GET payment falhou"
  local payment="$OBSERVED_JSON"
  local payments original_payments result
  payments="$(load_payments)" || die "lista de parcelas invalida/truncada"
  original_payments="$(jq -ce '.operation.original_payments_snapshot' \
    <<< "$CURRENT_CONTEXT_JSON")"
  jq -e --argjson expected "$original_payments" '.==$expected' \
    <<< "$payments" >/dev/null ||
    die "lista provider nao e o snapshot original exato"
  common_vars
  result="$(db_file "$SQL_DIR/abort-unsubmitted.sql" "${COMMON_VARS[@]}" \
    -v "subscription_observed=$subscription" -v "payment_observed=$payment" \
    -v "subscription_payments=$payments")" ||
    die "abort recusado"
  jq -e '.status=="FAILED" and .claimReleased==true' <<< "$result" >/dev/null ||
    die "abort nao confirmou limpeza"
  note "Operacao sem submits abortada; claim target removido."
}

show_status() {
  common_vars
  local result
  result="$(db_file "$SQL_DIR/status.sql" "${COMMON_VARS[@]}")" || die "status falhou"
  [[ -n "$result" ]] || die "operacao ausente"
  jq . <<< "$result"
}

main() {
  parse_args "$@"; validate_args; init_dependencies; common_vars
  case "$COMMAND" in
    preflight) provider_preflight; run_local_preflight; note "Preflight aprovado; zero escrita." ;;
    prepare) prepare ;;
    apply) apply_step ;;
    reconcile)
      [[ "$MODE" == execute ]] || die "reconcile grava ledger e exige execute"
      if [[ -n "$STEP_KIND" ]]; then reconcile_step; else reconcile_operation; fi ;;
    compensate) begin_compensation ;;
    abort) abort_unsubmitted ;;
    status) show_status ;;
  esac
}
main "$@"
