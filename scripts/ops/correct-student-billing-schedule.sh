#!/usr/bin/env bash
# Correct one student's recurring billing calendar without ever resubmitting an
# ambiguous Asaas mutation. This is an operator, not an unattended job: every
# provider mutation is an explicit, separately confirmed step.

set -Eeuo pipefail
umask 077

readonly PROGRAM_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SQL_DIR="$SCRIPT_DIR/sql"

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
OLD_PAYMENT_ID=""
OLD_STUDENT_PAYMENT_ID=""
OLD_DUE_DATE=""
TARGET_DUE_DATE=""
TARGET_END_DATE=""
ORIGINAL_NEXT_DUE_DATE=""
ORIGINAL_END_DATE=""
TARGET_CLAIM_FINGERPRINT=""
ACCEPT_EVENTS_UNTIL=""
EXPECTED_BILLING_TYPE="CREDIT_CARD"
EXPECTED_MAX_PAYMENTS="12"
EXPECTED_VALUE=""
PROVIDER_ENVIRONMENT=""
ASAAS_BASE_URL="${ASAAS_API_URL:-}"

TMP_DIR=""
ASAAS_HEADERS_FILE=""
ASAAS_TOKEN=""
HTTP_STATUS=""
HTTP_EXIT_CODE=""
MUTATION_HTTP_STATUS=""
MUTATION_EXIT_CODE=""
MUTATION_LEDGER_HTTP_STATUS=""
OBSERVED_JSON=""
OBSERVATION_AVAILABLE="false"
OBSERVATION_HTTP_STATUS=""
OBSERVATION_EXIT_CODE=""
ORIGINAL_SUBSCRIPTION_JSON=""
ORIGINAL_PAYMENT_JSON=""
INTEGRATION_SNAPSHOT_JSON=""
CURRENT_CONTEXT_JSON=""
TARGET_EVIDENCE_RESULT=""
TARGET_PAYMENT_EVIDENCE_JSON='[]'
TARGET_CONFLICT_PAYMENT_IDS_JSON='[]'
TARGET_PAYMENT_COUNT="0"
TARGET_COMPETENCE_COUNT="0"
TARGET_PAYMENT_ID=""

usage() {
  cat <<'USAGE'
Uso:
  correct-student-billing-schedule.sh <comando> [opcoes]

Comandos:
  preflight    Valida banco e Asaas sem escrever em nenhum dos dois.
  prepare      Cria atomicamente operacao, seis steps e claim BOUND.
  apply        Executa no maximo uma mutacao Asaas (--step obrigatorio).
  reconcile    Faz somente GET; resolve step ambiguo ou aguarda a nova parcela.
  status       Mostra somente estados seguros do ledger; nao consulta o Asaas.

Steps aceitos por apply/reconcile:
  INACTIVATE_SUBSCRIPTION
  DELETE_OLD_PAYMENT
  ACTIVATE_TARGET_SCHEDULE
  INACTIVATE_CONFLICTED_SUBSCRIPTION
  ACTIVATE_ORIGINAL_SCHEDULE
  RESTORE_OLD_PAYMENT

Opcoes obrigatorias (todos os comandos):
  --mode dry-run|execute
  --operation-key CHAVE
  --tenant-id ID
  --student-id UUID
  --offer-id UUID
  --customer-id cus_...
  --subscription-id sub_...
  --old-payment-id pay_...
  --old-student-payment-id UUID
  --old-due-date YYYY-MM-DD
  --target-due-date YYYY-MM-DD
  --target-end-date YYYY-MM-DD
  --original-next-due-date YYYY-MM-DD
  --original-end-date YYYY-MM-DD
  --target-claim-fingerprint SHA256_HEX
  --accept-events-until RFC3339
  --provider-environment production|sandbox
  --asaas-base-url URL

Opcoes de execucao:
  --step STEP                 Obrigatorio em apply; opcional em reconcile.
  --confirm-operation CHAVE  Obrigatorio para qualquer escrita; deve ser
                             identico a --operation-key.
  --expected-billing-type T  Padrao: CREDIT_CARD.
  --expected-max-payments N  Padrao: 12; validado no snapshot original.

Segredos (somente por variaveis de ambiente; nunca por argumentos):
  ASAAS_ACCESS_TOKEN ou ASAAS_API_KEY

Banco:
  Opcao A: DB_CONTAINER=supabase-db, DB_USER=postgres, DB_NAME=postgres
  Opcao B: variaveis libpq PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD

Regras operacionais:
  * dry-run jamais escreve no banco nem chama PUT/DELETE/POST no Asaas;
  * execute exige --confirm-operation;
  * cada step faz no maximo uma submissao;
  * timeout, 429 ou 5xx deixam o step UNKNOWN;
  * SUBMITTING/UNKNOWN aceitam somente reconcile (GET), nunca nova submissao;
  * outubro e seu claim historico nao sao alterados pelo PREPARE.
USAGE
}

die() {
  printf 'ERRO: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '%s\n' "$1"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -f -- "$TMP_DIR"/* 2>/dev/null || true
    rmdir -- "$TMP_DIR" 2>/dev/null || true
  fi
  unset ASAAS_TOKEN ASAAS_ACCESS_TOKEN ASAAS_API_KEY PGPASSWORD
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "comando obrigatorio ausente: $1"
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "valor ausente para $option"
}

is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
}

parse_args() {
  (($# > 0)) || { usage; exit 2; }
  COMMAND="$1"
  shift
  case "$COMMAND" in
    preflight|prepare|apply|reconcile|status) ;;
    help|-h|--help) usage; exit 0 ;;
    *) die "comando invalido: $COMMAND" ;;
  esac

  while (($# > 0)); do
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
      --old-payment-id) require_value "$1" "${2:-}"; OLD_PAYMENT_ID="$2"; shift 2 ;;
      --old-student-payment-id) require_value "$1" "${2:-}"; OLD_STUDENT_PAYMENT_ID="$2"; shift 2 ;;
      --old-due-date) require_value "$1" "${2:-}"; OLD_DUE_DATE="$2"; shift 2 ;;
      --target-due-date) require_value "$1" "${2:-}"; TARGET_DUE_DATE="$2"; shift 2 ;;
      --target-end-date) require_value "$1" "${2:-}"; TARGET_END_DATE="$2"; shift 2 ;;
      --original-next-due-date) require_value "$1" "${2:-}"; ORIGINAL_NEXT_DUE_DATE="$2"; shift 2 ;;
      --original-end-date) require_value "$1" "${2:-}"; ORIGINAL_END_DATE="$2"; shift 2 ;;
      --target-claim-fingerprint) require_value "$1" "${2:-}"; TARGET_CLAIM_FINGERPRINT="$2"; shift 2 ;;
      --accept-events-until) require_value "$1" "${2:-}"; ACCEPT_EVENTS_UNTIL="$2"; shift 2 ;;
      --provider-environment) require_value "$1" "${2:-}"; PROVIDER_ENVIRONMENT="$2"; shift 2 ;;
      --asaas-base-url) require_value "$1" "${2:-}"; ASAAS_BASE_URL="$2"; shift 2 ;;
      --expected-billing-type) require_value "$1" "${2:-}"; EXPECTED_BILLING_TYPE="$2"; shift 2 ;;
      --expected-max-payments) require_value "$1" "${2:-}"; EXPECTED_MAX_PAYMENTS="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      --asaas-token|--database-url|--password|--api-key)
        die "segredos nao sao aceitos por argumento; use somente variaveis de ambiente"
        ;;
      *) die "opcao desconhecida: $1" ;;
    esac
  done
}

validate_args() {
  local required_name
  for required_name in \
    MODE OPERATION_KEY TENANT_ID STUDENT_ID OFFER_ID CUSTOMER_ID \
    SUBSCRIPTION_ID OLD_PAYMENT_ID OLD_STUDENT_PAYMENT_ID OLD_DUE_DATE \
    TARGET_DUE_DATE TARGET_END_DATE ORIGINAL_NEXT_DUE_DATE ORIGINAL_END_DATE \
    TARGET_CLAIM_FINGERPRINT ACCEPT_EVENTS_UNTIL PROVIDER_ENVIRONMENT \
    ASAAS_BASE_URL EXPECTED_BILLING_TYPE EXPECTED_MAX_PAYMENTS; do
    [[ -n "${!required_name}" ]] || die "parametro obrigatorio ausente: $required_name"
  done

  [[ "$MODE" == "dry-run" || "$MODE" == "execute" ]] ||
    die "--mode deve ser dry-run ou execute"
  [[ "$COMMAND" != "preflight" || "$MODE" == "dry-run" ]] ||
    die "preflight aceita somente --mode dry-run"
  [[ "$COMMAND" != "status" || "$MODE" == "dry-run" ]] ||
    die "status aceita somente --mode dry-run"
  if [[ "$MODE" == "execute" ]]; then
    [[ "$CONFIRM_OPERATION_KEY" == "$OPERATION_KEY" ]] ||
      die "--confirm-operation deve ser identico a --operation-key"
  fi

  if [[ "$COMMAND" == "apply" ]]; then
    [[ -n "$STEP_KIND" ]] || die "apply exige --step"
  fi
  if [[ -n "$STEP_KIND" ]]; then
    case "$STEP_KIND" in
      INACTIVATE_SUBSCRIPTION|DELETE_OLD_PAYMENT|ACTIVATE_TARGET_SCHEDULE|INACTIVATE_CONFLICTED_SUBSCRIPTION|ACTIVATE_ORIGINAL_SCHEDULE|RESTORE_OLD_PAYMENT) ;;
      *) die "--step invalido: $STEP_KIND" ;;
    esac
  fi

  [[ "$OPERATION_KEY" =~ ^[a-z0-9][a-z0-9:_-]{7,199}$ ]] ||
    die "--operation-key deve ter 8-200 caracteres seguros em minusculas"
  [[ "$TENANT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$ ]] ||
    die "--tenant-id invalido"
  is_uuid "$STUDENT_ID" || die "--student-id nao e UUID valido"
  is_uuid "$OFFER_ID" || die "--offer-id nao e UUID valido"
  is_uuid "$OLD_STUDENT_PAYMENT_ID" || die "--old-student-payment-id nao e UUID valido"
  [[ "$CUSTOMER_ID" =~ ^cus_[A-Za-z0-9_-]{4,196}$ ]] || die "--customer-id invalido"
  [[ "$SUBSCRIPTION_ID" =~ ^sub_[A-Za-z0-9_-]{4,196}$ ]] || die "--subscription-id invalido"
  [[ "$OLD_PAYMENT_ID" =~ ^pay_[A-Za-z0-9_-]{4,196}$ ]] || die "--old-payment-id invalido"
  [[ "$OLD_DUE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--old-due-date invalida"
  [[ "$TARGET_DUE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--target-due-date invalida"
  [[ "$TARGET_END_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--target-end-date invalida"
  [[ "$ORIGINAL_NEXT_DUE_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
    die "--original-next-due-date invalida"
  [[ "$ORIGINAL_END_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
    die "--original-end-date invalida"
  [[ "$TARGET_CLAIM_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]] ||
    die "--target-claim-fingerprint deve ser SHA-256 hexadecimal minusculo"
  [[ "$EXPECTED_BILLING_TYPE" =~ ^[A-Z_]{2,32}$ ]] ||
    die "--expected-billing-type invalido"
  [[ "$EXPECTED_MAX_PAYMENTS" =~ ^[0-9]+$ ]] &&
    ((EXPECTED_MAX_PAYMENTS >= 1 && EXPECTED_MAX_PAYMENTS <= 120)) ||
    die "--expected-max-payments deve estar entre 1 e 120"
  [[ "$PROVIDER_ENVIRONMENT" == "production" || "$PROVIDER_ENVIRONMENT" == "sandbox" ]] ||
    die "--provider-environment deve ser production ou sandbox"

  ASAAS_BASE_URL="${ASAAS_BASE_URL%/}"
  if [[ "$ASAAS_BASE_URL" != */v3 ]]; then
    ASAAS_BASE_URL="$ASAAS_BASE_URL/v3"
  fi
  case "$PROVIDER_ENVIRONMENT:$ASAAS_BASE_URL" in
    production:https://api.asaas.com/v3|sandbox:https://api-sandbox.asaas.com/v3) ;;
    *) die "URL Asaas nao corresponde ao ambiente declarado" ;;
  esac
}

init_dependencies() {
  require_command jq
  require_command openssl
  if [[ -n "${DB_CONTAINER:-}" ]]; then
    require_command docker
    [[ "$DB_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] ||
      die "DB_CONTAINER invalido"
  else
    require_command psql
    [[ -n "${PGHOST:-}" && -n "${PGDATABASE:-}" && -n "${PGUSER:-}" ]] ||
      die "informe DB_CONTAINER ou PGHOST, PGDATABASE e PGUSER"
  fi

  local sql_file
  for sql_file in \
    schema-contract.sql preflight.sql prepare.sql load-context.sql \
    mark-submitting.sql finish-step.sql record-noop.sql \
    mark-blocked.sql mark-target-conflict.sql reconcile-operation.sql status.sql; do
    [[ -s "$SQL_DIR/$sql_file" ]] || die "arquivo SQL obrigatorio ausente: $sql_file"
  done

  if [[ "$COMMAND" != "status" ]]; then
    require_command curl
    ASAAS_TOKEN="${ASAAS_ACCESS_TOKEN:-${ASAAS_API_KEY:-}}"
    [[ ${#ASAAS_TOKEN} -ge 16 ]] || die "credencial Asaas ausente ou truncada no ambiente"
    TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ww-schedule-correction.XXXXXX")"
    ASAAS_HEADERS_FILE="$TMP_DIR/asaas.headers"
    printf 'access_token: %s\nContent-Type: application/json\nAccept: application/json\n' \
      "$ASAAS_TOKEN" > "$ASAAS_HEADERS_FILE"
    chmod 0600 "$ASAAS_HEADERS_FILE"
  fi
}

db_psql() {
  local -a common=(-X -q -v ON_ERROR_STOP=1)
  if [[ -n "${DB_CONTAINER:-}" ]]; then
    docker exec -i "$DB_CONTAINER" psql \
      "${common[@]}" -U "${DB_USER:-postgres}" -d "${DB_NAME:-postgres}" "$@"
  else
    command psql "${common[@]}" "$@"
  fi
}

db_file_capture() {
  local file="$1"
  shift
  db_psql -At "$@" < "$file"
}

common_psql_vars() {
  COMMON_PSQL_VARS=(
    -v "operation_key=$OPERATION_KEY"
    -v "tenant_id=$TENANT_ID"
    -v "student_id=$STUDENT_ID"
    -v "offer_id=$OFFER_ID"
    -v "customer_id=$CUSTOMER_ID"
    -v "subscription_id=$SUBSCRIPTION_ID"
    -v "old_payment_id=$OLD_PAYMENT_ID"
    -v "old_student_payment_id=$OLD_STUDENT_PAYMENT_ID"
    -v "old_due_date=$OLD_DUE_DATE"
    -v "target_due_date=$TARGET_DUE_DATE"
    -v "target_end_date=$TARGET_END_DATE"
    -v "original_next_due_date=$ORIGINAL_NEXT_DUE_DATE"
    -v "original_end_date=$ORIGINAL_END_DATE"
    -v "target_claim_fingerprint=$TARGET_CLAIM_FINGERPRINT"
    -v "accept_events_until=$ACCEPT_EVENTS_UNTIL"
    -v "expected_billing_type=$EXPECTED_BILLING_TYPE"
    -v "expected_max_payments=$EXPECTED_MAX_PAYMENTS"
    -v "provider_environment=$PROVIDER_ENVIRONMENT"
    -v "asaas_base_url=$ASAAS_BASE_URL"
  )
}

check_schema_contract() {
  local result
  result="$(db_file_capture "$SQL_DIR/schema-contract.sql")" ||
    die "schema do ledger nao corresponde ao contrato do operador"
  [[ "$result" == "ok" ]] || die "schema do ledger nao corresponde ao contrato do operador"
}

asaas_call() {
  local method="$1"
  local path="$2"
  local response_file="$3"
  local body_file="${4:-}"
  local -a args=(
    --silent --show-error --location --max-redirs 0
    --connect-timeout "${ASAAS_CONNECT_TIMEOUT_SECONDS:-8}"
    --max-time "${ASAAS_TIMEOUT_SECONDS:-25}"
    --retry 0
    --request "$method"
    --url "$ASAAS_BASE_URL$path"
    --header "@$ASAAS_HEADERS_FILE"
    --output "$response_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$body_file" ]]; then
    args+=(--data-binary "@$body_file")
  fi

  set +e
  HTTP_STATUS="$(curl "${args[@]}")"
  HTTP_EXIT_CODE=$?
  set -e
  [[ "$HTTP_STATUS" =~ ^[0-9]{3}$ ]] || HTTP_STATUS="000"
}

safe_subscription_json() {
  local source_file="$1"
  jq -ceS '
    if type != "object" then error("not_object") else {
      id: (.id // null),
      customer: (.customer // null),
      status: (.status // null),
      nextDueDate: (.nextDueDate // null),
      endDate: (.endDate // null),
      billingType: (.billingType // null),
      cycle: (.cycle // null),
      value: (.value // null),
      externalReference: (.externalReference // null),
      maxPayments: (.maxPayments // null)
    } end
  ' "$source_file"
}

safe_payment_json() {
  local source_file="$1"
  jq -ceS '
    if type != "object" then error("not_object") else {
      id: (.id // null),
      customer: (.customer // null),
      subscription: (.subscription // null),
      status: (.status // null),
      dueDate: (.dueDate // null),
      originalDueDate: (.originalDueDate // null),
      billingType: (.billingType // null),
      value: (.value // null),
      deleted: (.deleted // false),
      paymentDate: (.paymentDate // null),
      clientPaymentDate: (.clientPaymentDate // null),
      confirmedDate: (.confirmedDate // null),
      creditDate: (.creditDate // null)
    } end
  ' "$source_file"
}

safe_provider_response_json() {
  local source_file="$1"
  if ! jq -e 'type == "object"' "$source_file" >/dev/null 2>&1; then
    printf '%s' '{"unparseable":true}'
    return
  fi
  jq -ceS '{
    id: (.id // null),
    deleted: (.deleted // null),
    status: (.status // null),
    customer: (.customer // null),
    subscription: (.subscription // null),
    dueDate: (.dueDate // null),
    originalDueDate: (.originalDueDate // null),
    nextDueDate: (.nextDueDate // null),
    endDate: (.endDate // null),
    billingType: (.billingType // null),
    cycle: (.cycle // null),
    value: (.value // null),
    externalReference: (.externalReference // null),
    maxPayments: (.maxPayments // null),
    errors: ((.errors // []) | map({code: (.code // null), description: (.description // null)}))
  }' "$source_file"
}

provider_get_object() {
  local path="$1"
  local kind="$2"
  local response_file="$TMP_DIR/get-$(printf '%s' "$kind" | tr '[:upper:]' '[:lower:]').json"
  asaas_call GET "$path" "$response_file"
  OBSERVATION_HTTP_STATUS="$HTTP_STATUS"
  OBSERVATION_EXIT_CODE="$HTTP_EXIT_CODE"
  [[ "$HTTP_EXIT_CODE" == "0" && "$HTTP_STATUS" == "200" ]] || return 1
  if [[ "$kind" == "subscription" ]]; then
    OBSERVED_JSON="$(safe_subscription_json "$response_file")" || return 1
  else
    OBSERVED_JSON="$(safe_payment_json "$response_file")" || return 1
  fi
  OBSERVATION_AVAILABLE="true"
}

initial_provider_preflight() {
  local customer_file="$TMP_DIR/customer.json"
  OBSERVATION_AVAILABLE="false"
  provider_get_object "/subscriptions/$SUBSCRIPTION_ID" subscription ||
    die "nao foi possivel confirmar a assinatura no Asaas"
  ORIGINAL_SUBSCRIPTION_JSON="$OBSERVED_JSON"
  jq -e \
    --arg id "$SUBSCRIPTION_ID" \
    --arg customer "$CUSTOMER_ID" \
    --arg next "$ORIGINAL_NEXT_DUE_DATE" \
    --arg end "$ORIGINAL_END_DATE" \
    --arg billing "$EXPECTED_BILLING_TYPE" \
    --arg externalReference "enrollment:$OFFER_ID:subscription" \
    --argjson maxPayments "$EXPECTED_MAX_PAYMENTS" '
      .id == $id and .customer == $customer and .status == "ACTIVE" and
      .nextDueDate == $next and .endDate == $end and
      .billingType == $billing and .cycle == "MONTHLY" and
      (.value | type == "number") and .value > 0 and
      .externalReference == $externalReference and
      .maxPayments == $maxPayments
    ' <<< "$ORIGINAL_SUBSCRIPTION_JSON" >/dev/null ||
    die "assinatura divergiu do snapshot original informado"
  EXPECTED_VALUE="$(jq -er '.value | select(type == "number" and . > 0)' \
    <<< "$ORIGINAL_SUBSCRIPTION_JSON")" ||
    die "valor da assinatura nao pode ser usado no preflight local"

  OBSERVATION_AVAILABLE="false"
  provider_get_object "/payments/$OLD_PAYMENT_ID" payment ||
    die "nao foi possivel confirmar a cobranca antiga no Asaas"
  ORIGINAL_PAYMENT_JSON="$OBSERVED_JSON"
  jq -e \
    --arg id "$OLD_PAYMENT_ID" \
    --arg customer "$CUSTOMER_ID" \
    --arg subscription "$SUBSCRIPTION_ID" \
    --arg due "$OLD_DUE_DATE" \
    --arg billing "$EXPECTED_BILLING_TYPE" '
      .id == $id and .customer == $customer and
      .subscription == $subscription and .status == "PENDING" and
      .dueDate == $due and .originalDueDate == $due and
      .billingType == $billing and .deleted == false and
      .paymentDate == null and .clientPaymentDate == null and
      .confirmedDate == null and .creditDate == null
    ' <<< "$ORIGINAL_PAYMENT_JSON" >/dev/null ||
    die "cobranca antiga nao esta pendente, intacta e sem liquidacao"

  jq -e --argjson subscription "$ORIGINAL_SUBSCRIPTION_JSON" '
    .value == $subscription.value and .billingType == $subscription.billingType
  ' <<< "$ORIGINAL_PAYMENT_JSON" >/dev/null ||
    die "cobranca antiga diverge do valor ou meio de pagamento da assinatura"

  asaas_call GET "/customers/$CUSTOMER_ID" "$customer_file"
  [[ "$HTTP_EXIT_CODE" == "0" && "$HTTP_STATUS" == "200" ]] ||
    die "nao foi possivel confirmar o cliente no Asaas"
  jq -e --arg id "$CUSTOMER_ID" '
    type == "object" and .id == $id and ((.deleted // false) == false)
  ' "$customer_file" >/dev/null || die "cliente Asaas divergiu ou esta removido"
}

run_db_preflight() {
  common_psql_vars
  local result
  result="$(db_file_capture "$SQL_DIR/preflight.sql" \
    "${COMMON_PSQL_VARS[@]}" -v "expected_value=$EXPECTED_VALUE")" ||
    die "preflight local recusou a operacao"
  jq -e '.ok == true and (.integrationSnapshot | type == "object")' \
    <<< "$result" >/dev/null || die "preflight local retornou contrato invalido"
  INTEGRATION_SNAPSHOT_JSON="$(jq -ceS '.integrationSnapshot' <<< "$result")"
}

sha256_json() {
  local value="$1"
  printf '%s' "$value" | jq -cS . | openssl dgst -sha256 -r | awk '{print $1}'
}

make_request_descriptor() {
  local step_kind="$1"
  local method path body
  case "$step_kind" in
    INACTIVATE_SUBSCRIPTION|INACTIVATE_CONFLICTED_SUBSCRIPTION)
      method="PUT"; path="/subscriptions/$SUBSCRIPTION_ID"; body='{"status":"INACTIVE"}' ;;
    DELETE_OLD_PAYMENT)
      method="DELETE"; path="/payments/$OLD_PAYMENT_ID"; body="null" ;;
    ACTIVATE_TARGET_SCHEDULE)
      method="PUT"; path="/subscriptions/$SUBSCRIPTION_ID"
      body="$(jq -cn --arg due "$TARGET_DUE_DATE" --arg end "$TARGET_END_DATE" \
        '{status:"ACTIVE",nextDueDate:$due,endDate:$end}')" ;;
    ACTIVATE_ORIGINAL_SCHEDULE)
      method="PUT"; path="/subscriptions/$SUBSCRIPTION_ID"
      body="$(jq -cn --arg due "$ORIGINAL_NEXT_DUE_DATE" --arg end "$ORIGINAL_END_DATE" \
        '{status:"ACTIVE",nextDueDate:$due,endDate:$end}')" ;;
    RESTORE_OLD_PAYMENT)
      method="POST"; path="/payments/$OLD_PAYMENT_ID/restore"; body="null" ;;
    *) die "step sem descriptor: $step_kind" ;;
  esac
  jq -cnS --arg method "$method" --arg path "$path" --argjson body "$body" \
    '{method:$method,path:$path,body:$body}'
}

make_step_fingerprint() {
  local step_kind="$1"
  local descriptor="$2"
  local stable
  stable="$(jq -cnS \
    --arg operationKey "$OPERATION_KEY" \
    --arg tenantId "$TENANT_ID" \
    --arg studentId "$STUDENT_ID" \
    --arg customerId "$CUSTOMER_ID" \
    --arg subscriptionId "$SUBSCRIPTION_ID" \
    --arg oldPaymentId "$OLD_PAYMENT_ID" \
    --arg stepKind "$step_kind" \
    --argjson request "$descriptor" \
    --argjson integration "$INTEGRATION_SNAPSHOT_JSON" \
    '{version:1,operationKey:$operationKey,tenantId:$tenantId,
      studentId:$studentId,customerId:$customerId,
      subscriptionId:$subscriptionId,oldPaymentId:$oldPaymentId,
      stepKind:$stepKind,request:$request,integrationSnapshot:$integration}')"
  sha256_json "$stable"
}

build_steps_json() {
  local inactive_snapshot target_snapshot contained_target_snapshot
  local deleted_payment_snapshot
  inactive_snapshot="$(jq -cS '.status = "INACTIVE"' <<< "$ORIGINAL_SUBSCRIPTION_JSON")"
  target_snapshot="$(jq -cS \
    --arg due "$TARGET_DUE_DATE" --arg end "$TARGET_END_DATE" \
    '.status = "ACTIVE" | .nextDueDate = $due | .endDate = $end' \
    <<< "$ORIGINAL_SUBSCRIPTION_JSON")"
  contained_target_snapshot="$(jq -cS '.status = "INACTIVE"' \
    <<< "$target_snapshot")"
  deleted_payment_snapshot="$(jq -cS '.deleted = true' <<< "$ORIGINAL_PAYMENT_JSON")"

  local result='[]' step route ordinal expected desired descriptor fingerprint
  while IFS='|' read -r step route ordinal; do
    descriptor="$(make_request_descriptor "$step")"
    fingerprint="$(make_step_fingerprint "$step" "$descriptor")"
    case "$step" in
      INACTIVATE_SUBSCRIPTION)
        expected="$ORIGINAL_SUBSCRIPTION_JSON"; desired="$inactive_snapshot" ;;
      DELETE_OLD_PAYMENT)
        expected="$ORIGINAL_PAYMENT_JSON"; desired="$deleted_payment_snapshot" ;;
      ACTIVATE_TARGET_SCHEDULE)
        expected="$inactive_snapshot"; desired="$target_snapshot" ;;
      INACTIVATE_CONFLICTED_SUBSCRIPTION)
        expected="$target_snapshot"; desired="$contained_target_snapshot" ;;
      ACTIVATE_ORIGINAL_SCHEDULE)
        expected="$inactive_snapshot"; desired="$ORIGINAL_SUBSCRIPTION_JSON" ;;
      RESTORE_OLD_PAYMENT)
        expected="$deleted_payment_snapshot"; desired="$ORIGINAL_PAYMENT_JSON" ;;
    esac
    result="$(jq -cS \
      --arg stepKind "$step" --arg routeKind "$route" \
      --argjson ordinal "$ordinal" --arg requestFingerprint "$fingerprint" \
      --argjson expectedBefore "$expected" --argjson desiredAfter "$desired" \
      --argjson providerRequest "$descriptor" \
      '. + [{stepKind:$stepKind,routeKind:$routeKind,ordinal:$ordinal,
        status:"READY",requestFingerprint:$requestFingerprint,
        expectedBefore:$expectedBefore,desiredAfter:$desiredAfter,
        providerRequest:$providerRequest}]' <<< "$result")"
  done <<'STEPS'
INACTIVATE_SUBSCRIPTION|TARGET|10
DELETE_OLD_PAYMENT|TARGET|20
ACTIVATE_TARGET_SCHEDULE|TARGET|30
INACTIVATE_CONFLICTED_SUBSCRIPTION|COMPENSATION|35
ACTIVATE_ORIGINAL_SCHEDULE|COMPENSATION|40
RESTORE_OLD_PAYMENT|COMPENSATION|50
STEPS
  printf '%s' "$result"
}

load_context() {
  common_psql_vars
  CURRENT_CONTEXT_JSON="$(db_file_capture "$SQL_DIR/load-context.sql" \
    "${COMMON_PSQL_VARS[@]}")" || die "nao foi possivel carregar o ledger"
  [[ -n "$CURRENT_CONTEXT_JSON" ]] || return 1
  jq -e '
    .operation != null and .claim != null and
    (.steps | type == "array" and length == 6)
  ' <<< "$CURRENT_CONTEXT_JSON" >/dev/null || die "ledger existente esta incompleto"
}

prepare_operation() {
  if load_context; then
    validate_context_scope
    note "PREPARE ja estava concluido; nenhuma escrita foi repetida."
    return
  fi

  initial_provider_preflight
  run_db_preflight
  if [[ "$MODE" == "dry-run" ]]; then
    note "Preflight concluido: PREPARE pode ser criado sem alterar outubro."
    return
  fi

  local steps_json target_snapshot result
  steps_json="$(build_steps_json)"
  target_snapshot="$(jq -cS \
    --arg due "$TARGET_DUE_DATE" --arg end "$TARGET_END_DATE" \
    '.status = "ACTIVE" | .nextDueDate = $due | .endDate = $end' \
    <<< "$ORIGINAL_SUBSCRIPTION_JSON")"
  common_psql_vars
  result="$(db_file_capture "$SQL_DIR/prepare.sql" \
    "${COMMON_PSQL_VARS[@]}" \
    -v "original_subscription_snapshot=$ORIGINAL_SUBSCRIPTION_JSON" \
    -v "original_payment_snapshot=$ORIGINAL_PAYMENT_JSON" \
    -v "target_subscription_snapshot=$target_snapshot" \
    -v "integration_snapshot=$INTEGRATION_SNAPSHOT_JSON" \
    -v "steps_json=$steps_json")" || die "PREPARE foi revertido pelo banco"
  jq -e '.ok == true and .status == "READY" and .stepCount == 6' \
    <<< "$result" >/dev/null || die "PREPARE nao confirmou o contrato completo"
  note "PREPARE concluido: operacao, seis steps e claim BOUND foram gravados atomicamente."
}

validate_context_scope() {
  jq -e \
    --arg operationKey "$OPERATION_KEY" \
    --arg tenantId "$TENANT_ID" \
    --arg studentId "$STUDENT_ID" \
    --arg offerId "$OFFER_ID" \
    --arg customerId "$CUSTOMER_ID" \
    --arg subscriptionId "$SUBSCRIPTION_ID" \
    --arg oldPaymentId "$OLD_PAYMENT_ID" \
    --arg oldStudentPaymentId "$OLD_STUDENT_PAYMENT_ID" \
    --arg oldDueDate "$OLD_DUE_DATE" \
    --arg originalNextDueDate "$ORIGINAL_NEXT_DUE_DATE" \
    --arg originalEndDate "$ORIGINAL_END_DATE" \
    --arg targetDueDate "$TARGET_DUE_DATE" \
    --arg targetEndDate "$TARGET_END_DATE" \
    --arg billingType "$EXPECTED_BILLING_TYPE" \
    --arg providerEnvironment "$PROVIDER_ENVIRONMENT" \
    --arg asaasBaseUrl "$ASAAS_BASE_URL" \
    --arg externalReference "enrollment:$OFFER_ID:subscription" \
    --argjson maxPayments "$EXPECTED_MAX_PAYMENTS" '
      .operation.operation_key == $operationKey and
      .operation.tenant_id == $tenantId and
      .operation.student_id == $studentId and
      .operation.offer_id == $offerId and
      .operation.customer_id == $customerId and
      .operation.subscription_id == $subscriptionId and
      .operation.old_payment_id == $oldPaymentId and
      .operation.old_student_payment_id == $oldStudentPaymentId and
      .operation.old_due_date == $oldDueDate and
      .operation.original_subscription_snapshot.nextDueDate == $originalNextDueDate and
      .operation.original_subscription_snapshot.endDate == $originalEndDate and
      .operation.target_due_date == $targetDueDate and
      .operation.target_end_date == $targetEndDate and
      .operation.accept_events_until == .requestedAcceptEventsUntil and
      .operation.original_subscription_snapshot.billingType == $billingType and
      .operation.original_subscription_snapshot.cycle == "MONTHLY" and
      .operation.original_subscription_snapshot.externalReference == $externalReference and
      .operation.original_subscription_snapshot.maxPayments == $maxPayments and
      .integrationLive == true and
      .operation.integration_snapshot.environment == $providerEnvironment and
      .operation.integration_snapshot.baseUrl == $asaasBaseUrl and
      (.operation.integration_snapshot.integrationId | type == "string") and
      (.operation.integration_snapshot.version | type == "number") and
      (.operation.integration_snapshot.mode | type == "string")
  ' <<< "$CURRENT_CONTEXT_JSON" >/dev/null || die "parametros divergem do ledger existente"
}

step_json() {
  jq -ce --arg step "$STEP_KIND" '.steps[] | select(.step_kind == $step)' \
    <<< "$CURRENT_CONTEXT_JSON"
}

subscription_stable_fields_match() {
  local actual="$1" desired="$2"
  jq -e --argjson desired "$desired" \
    'del(.nextDueDate) == ($desired | del(.nextDueDate))' \
    <<< "$actual" >/dev/null
}

subscription_json_matches_exact() {
  local actual="$1" expected="$2"
  jq -e --argjson expected "$expected" '. == $expected' \
    <<< "$actual" >/dev/null
}

payment_json_matches() {
  local actual="$1" desired="$2"
  jq -e --argjson desired "$desired" '. == $desired' <<< "$actual" >/dev/null
}

monthly_date_is_after_target() {
  local candidate="$1"
  [[ "$candidate" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]] || return 1
  local candidate_year=$((10#${BASH_REMATCH[1]}))
  local candidate_month=$((10#${BASH_REMATCH[2]}))
  local candidate_day=$((10#${BASH_REMATCH[3]}))
  [[ "$TARGET_DUE_DATE" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]] || return 1
  local target_year=$((10#${BASH_REMATCH[1]}))
  local target_month=$((10#${BASH_REMATCH[2]}))
  local target_day=$((10#${BASH_REMATCH[3]}))
  ((candidate_day == target_day)) || return 1
  (((candidate_year * 12 + candidate_month) >
    (target_year * 12 + target_month)))
}

load_subscription_payments_page() {
  local payments_file="$1"
  asaas_call GET "/subscriptions/$SUBSCRIPTION_ID/payments?limit=100&offset=0" \
    "$payments_file"
  [[ "$HTTP_EXIT_CODE" == "0" && "$HTTP_STATUS" == "200" ]] || return 1
  jq -e \
    --arg customer "$CUSTOMER_ID" \
    --arg subscription "$SUBSCRIPTION_ID" '
    type == "object" and (.data | type == "array") and
    (.hasMore | type == "boolean") and .hasMore == false and
    (.totalCount | type == "number") and
    .totalCount >= 0 and .totalCount <= 100 and
    (.totalCount | floor) == .totalCount and
    .totalCount == (.data | length) and
    ((has("limit") | not) or .limit == 100) and
    ((has("offset") | not) or .offset == 0) and
    all(.data[];
      type == "object" and (.id | type == "string") and
      (.id | test("^pay_[A-Za-z0-9_-]{4,196}$")) and
      .customer == $customer and .subscription == $subscription and
      ((.deleted // false) | type == "boolean") and
      (.dueDate | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) and
      ((.originalDueDate // .dueDate) | type == "string" and
        test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")))
  ' "$payments_file" >/dev/null
}

load_target_payment_evidence() {
  local allow_missing="${1:-false}"
  local payments_file="$TMP_DIR/subscription-payments.json"
  TARGET_PAYMENT_EVIDENCE_JSON='[]'
  TARGET_CONFLICT_PAYMENT_IDS_JSON='[]'
  TARGET_PAYMENT_COUNT="0"
  TARGET_COMPETENCE_COUNT="0"
  TARGET_PAYMENT_ID=""
  load_subscription_payments_page "$payments_file" || return 1

  local duplicate_competence expected_value all_target_candidates
  expected_value="$(jq -ce '.operation.original_subscription_snapshot.value' \
    <<< "$CURRENT_CONTEXT_JSON")" || return 1
  all_target_candidates="$(jq -ceS \
    --arg month "${TARGET_DUE_DATE:0:7}" \
    --arg customer "$CUSTOMER_ID" \
    --arg subscription "$SUBSCRIPTION_ID" '
      [(.data // [])[] | select(
        .customer == $customer and .subscription == $subscription and
        ((.deleted // false) == false) and
        (
          ((.dueDate // "")[0:7]) == $month or
          ((.originalDueDate // .dueDate // "")[0:7]) == $month
        )
      )]
    ' "$payments_file")" || return 1
  TARGET_COMPETENCE_COUNT="$(jq -r 'length' <<< "$all_target_candidates")"
  TARGET_CONFLICT_PAYMENT_IDS_JSON="$(jq -ceS \
    '[.[] | .id] | sort' <<< "$all_target_candidates")" || return 1

  duplicate_competence="$(jq -r \
    --arg customer "$CUSTOMER_ID" --arg subscription "$SUBSCRIPTION_ID" '
      [(.data // [])[] | select(
        .customer == $customer and .subscription == $subscription and
        ((.deleted // false) == false)
      )] as $live |
      ([ $live[] | (.dueDate // "")[0:7] ]
        | sort | group_by(.) | any(length > 1)) or
      ([ $live[] | (.originalDueDate // .dueDate // "")[0:7] ]
        | sort | group_by(.) | any(length > 1))
    ' "$payments_file")" || return 1

  TARGET_PAYMENT_EVIDENCE_JSON="$(jq -ceS \
    --arg due "$TARGET_DUE_DATE" \
    --arg customer "$CUSTOMER_ID" \
    --arg subscription "$SUBSCRIPTION_ID" \
    --arg billing "$EXPECTED_BILLING_TYPE" \
    --argjson value "$expected_value" '
      [(.data // [])[] | select(
        .customer == $customer and .subscription == $subscription and
        ((.deleted // false) == false) and
        .dueDate == $due and .originalDueDate == $due and
        .billingType == $billing and .value == $value and
        .status == "PENDING" and
        (.paymentDate // null) == null and
        (.clientPaymentDate // null) == null and
        (.confirmedDate // null) == null and
        (.creditDate // null) == null
      ) | {
        id, customer, subscription, status, dueDate, originalDueDate,
        billingType, value, deleted:(.deleted // false),
        paymentDate:(.paymentDate // null),
        clientPaymentDate:(.clientPaymentDate // null),
        confirmedDate:(.confirmedDate // null),
        creditDate:(.creditDate // null)
      }]
    ' "$payments_file")" || return 1
  TARGET_PAYMENT_COUNT="$(jq -r 'length' <<< "$TARGET_PAYMENT_EVIDENCE_JSON")"

  if [[ "$TARGET_COMPETENCE_COUNT" -gt 1 ]]; then
    return 2
  fi
  if [[ "$TARGET_COMPETENCE_COUNT" != "0" &&
        "$TARGET_PAYMENT_COUNT" != "$TARGET_COMPETENCE_COUNT" ]]; then
    return 3
  fi
  if [[ "$duplicate_competence" != "false" ]]; then
    # A duplicate outside the target month is still unsafe, but it cannot be
    # represented as target-conflict evidence when no target payment exists.
    [[ "$TARGET_COMPETENCE_COUNT" -gt 0 ]] && return 2
    return 4
  fi
  if [[ "$TARGET_PAYMENT_COUNT" == "0" && "$allow_missing" == "true" ]]; then
    return 0
  fi
  [[ "$TARGET_PAYMENT_COUNT" == "1" ]] || return 1
  TARGET_PAYMENT_ID="$(jq -er '.[0].id' <<< "$TARGET_PAYMENT_EVIDENCE_JSON")" ||
    return 1
  [[ "$TARGET_PAYMENT_ID" =~ ^pay_[A-Za-z0-9_-]{4,196}$ ]]
}

target_conflict_evidence_json() {
  [[ "$TARGET_COMPETENCE_COUNT" -gt 0 ]] || return 1
  jq -cnS \
    --arg reason "provider_target_competence_conflict" \
    --arg subscription "$SUBSCRIPTION_ID" \
    --argjson targetPayments "$TARGET_CONFLICT_PAYMENT_IDS_JSON" \
    --argjson targetCompetenceCount "$TARGET_COMPETENCE_COUNT" '
      {
        reason:$reason,
        subscription:$subscription,
        targetPayments:$targetPayments,
        targetCompetenceCount:$targetCompetenceCount
      }
    '
}

delete_mutation_response_is_valid() {
  local http_status="$1" response="$2"
  [[ "$http_status" =~ ^2[0-9]{2}$ ]] || return 0
  jq -e --arg id "$OLD_PAYMENT_ID" \
    '.id == $id and .deleted == true' <<< "$response" >/dev/null
}

delete_mutation_outcome_can_be_reconciled() {
  if [[ "$MUTATION_HTTP_STATUS" =~ ^2[0-9]{2}$ ]]; then
    delete_mutation_response_is_valid \
      "$MUTATION_HTTP_STATUS" "$MUTATION_RESPONSE_JSON"
    return
  fi
  [[ "$MUTATION_EXIT_CODE" != "0" || "$MUTATION_HTTP_STATUS" == "408" ||
     "$MUTATION_HTTP_STATUS" == "429" || "$MUTATION_HTTP_STATUS" =~ ^5 ]]
}

delete_step_ledger_proof_is_exact() {
  local allowed_statuses="$1"
  local delete_step original desired descriptor fingerprint saved_integration
  delete_step="$(jq -ce '
    .steps[] | select(.step_kind == "DELETE_OLD_PAYMENT")
  ' <<< "$CURRENT_CONTEXT_JSON")" || return 1
  original="$(jq -ce '.operation.original_payment_snapshot' \
    <<< "$CURRENT_CONTEXT_JSON")" || return 1
  desired="$(jq -cS '.deleted = true' <<< "$original")" || return 1
  descriptor="$(make_request_descriptor DELETE_OLD_PAYMENT)" || return 1
  saved_integration="$INTEGRATION_SNAPSHOT_JSON"
  INTEGRATION_SNAPSHOT_JSON="$(jq -ceS '.operation.integration_snapshot' \
    <<< "$CURRENT_CONTEXT_JSON")" || return 1
  fingerprint="$(make_step_fingerprint DELETE_OLD_PAYMENT "$descriptor")" || {
    INTEGRATION_SNAPSHOT_JSON="$saved_integration"
    return 1
  }
  INTEGRATION_SNAPSHOT_JSON="$saved_integration"
  jq -e \
    --arg allowed "$allowed_statuses" \
    --arg fingerprint "$fingerprint" \
    --argjson original "$original" \
    --argjson desired "$desired" \
    --argjson descriptor "$descriptor" '
      (.status | test($allowed)) and
      .submit_attempt_count == 1 and .submitted_at != null and
      .expected_before == $original and .desired_after == $desired and
      .provider_request == $descriptor and .request_fingerprint == $fingerprint and
      ((.provider_http_status // 0) as $http |
        (($http < 200 or $http >= 300) or
         (.provider_response.id == $desired.id and
          .provider_response.deleted == true)))
    ' <<< "$delete_step" >/dev/null
}

build_deleted_payment_absence_proof() {
  local allowed_statuses="$1"
  [[ "$OBSERVATION_EXIT_CODE" == "0" && "$OBSERVATION_HTTP_STATUS" == "404" ]] ||
    return 1
  delete_step_ledger_proof_is_exact "$allowed_statuses" || return 1

  local payments_file="$TMP_DIR/subscription-payments-after-delete.json"
  local live_old_count listed_live_ids
  load_subscription_payments_page "$payments_file" || return 1
  jq -e \
    --arg id "$OLD_PAYMENT_ID" \
    --arg customer "$CUSTOMER_ID" \
    --arg subscription "$SUBSCRIPTION_ID" '
      all(.data[] | select(.id == $id);
        .customer == $customer and .subscription == $subscription)
    ' "$payments_file" >/dev/null || return 1
  live_old_count="$(jq -r --arg id "$OLD_PAYMENT_ID" '
    [.data[] | select(.id == $id and ((.deleted // false) == false))]
    | length
  ' "$payments_file")" || return 1
  [[ "$live_old_count" == "0" ]] || return 1
  listed_live_ids="$(jq -ceS '
    [.data[] | select((.deleted // false) == false) | .id] | sort
  ' "$payments_file")" || return 1
  OBSERVED_JSON="$(jq -cnS \
    --arg kind "PAYMENT_NOT_FOUND_WITH_SUBSCRIPTION_LIST" \
    --arg id "$OLD_PAYMENT_ID" \
    --arg subscription "$SUBSCRIPTION_ID" \
    --argjson listedLivePaymentIds "$listed_live_ids" '
      {
        kind:$kind,
        id:$id,
        subscription:$subscription,
        getHttpStatus:404,
        liveOldPaymentCount:0,
        listedLivePaymentIds:$listedLivePaymentIds
      }
    ')" || return 1
  OBSERVATION_AVAILABLE="true"
}

deleted_payment_absence_proof_matches() {
  local value="$1"
  jq -e --arg id "$OLD_PAYMENT_ID" --arg subscription "$SUBSCRIPTION_ID" '
    . == {
      kind:"PAYMENT_NOT_FOUND_WITH_SUBSCRIPTION_LIST",
      id:$id,
      subscription:$subscription,
      getHttpStatus:404,
      liveOldPaymentCount:0,
      listedLivePaymentIds:.listedLivePaymentIds
    } and
    (.listedLivePaymentIds | type == "array" and length <= 100) and
    all(.listedLivePaymentIds[];
      type == "string" and test("^pay_[A-Za-z0-9_-]{4,196}$")) and
    ([.listedLivePaymentIds[] | select(. == $id)] | length) == 0
  ' <<< "$value" >/dev/null
}

subscription_json_matches_for_step() {
  local step="$1" actual="$2" desired="$3"
  TARGET_EVIDENCE_RESULT=""
  case "$step" in
    INACTIVATE_SUBSCRIPTION)
      subscription_json_matches_exact "$actual" "$desired"
      ;;
    ACTIVATE_ORIGINAL_SCHEDULE)
      subscription_json_matches_exact "$actual" "$desired"
      ;;
    ACTIVATE_TARGET_SCHEDULE)
      subscription_stable_fields_match "$actual" "$desired" || return 1
      local actual_next desired_next
      actual_next="$(jq -er '.nextDueDate' <<< "$actual")" || return 1
      desired_next="$(jq -er '.nextDueDate' <<< "$desired")" || return 1
      [[ "$desired_next" == "$TARGET_DUE_DATE" ]] || return 1
      if [[ "$actual_next" != "$TARGET_DUE_DATE" ]]; then
        monthly_date_is_after_target "$actual_next" || return 1
      fi
      set +e
      load_target_payment_evidence true
      TARGET_EVIDENCE_RESULT=$?
      set -e
      if [[ "$actual_next" != "$TARGET_DUE_DATE" &&
            "$TARGET_PAYMENT_COUNT" != "1" ]]; then
        return 1
      fi
      return "$TARGET_EVIDENCE_RESULT"
      ;;
    INACTIVATE_CONFLICTED_SUBSCRIPTION)
      subscription_stable_fields_match "$actual" "$desired" || return 1
      [[ "$(jq -er '.status' <<< "$actual")" == "INACTIVE" ]] || return 1
      local contained_next
      contained_next="$(jq -er '.nextDueDate' <<< "$actual")" || return 1
      if [[ "$contained_next" != "$TARGET_DUE_DATE" ]]; then
        monthly_date_is_after_target "$contained_next" || return 1
      fi
      set +e
      load_target_payment_evidence true
      TARGET_EVIDENCE_RESULT=$?
      set -e
      [[ ("$TARGET_EVIDENCE_RESULT" == "2" ||
          "$TARGET_EVIDENCE_RESULT" == "3") &&
         "$TARGET_COMPETENCE_COUNT" -gt 0 ]]
      ;;
    *) return 1 ;;
  esac
}

observe_for_step() {
  local step="$1"
  OBSERVATION_AVAILABLE="false"
  OBSERVATION_HTTP_STATUS=""
  OBSERVATION_EXIT_CODE=""
  case "$step" in
    INACTIVATE_SUBSCRIPTION|ACTIVATE_TARGET_SCHEDULE|INACTIVATE_CONFLICTED_SUBSCRIPTION|ACTIVATE_ORIGINAL_SCHEDULE)
      provider_get_object "/subscriptions/$SUBSCRIPTION_ID" subscription || true
      ;;
    DELETE_OLD_PAYMENT|RESTORE_OLD_PAYMENT)
      provider_get_object "/payments/$OLD_PAYMENT_ID" payment || true
      ;;
  esac
  if [[ "$OBSERVATION_AVAILABLE" != "true" ]]; then
    OBSERVED_JSON='{"available":false}'
  fi
}

observed_matches_desired() {
  local step="$1" desired="$2"
  [[ "$OBSERVATION_AVAILABLE" == "true" ]] || return 1
  case "$step" in
    INACTIVATE_SUBSCRIPTION|ACTIVATE_TARGET_SCHEDULE|ACTIVATE_ORIGINAL_SCHEDULE)
      subscription_json_matches_for_step "$step" "$OBSERVED_JSON" "$desired"
      ;;
    INACTIVATE_CONFLICTED_SUBSCRIPTION)
      subscription_json_matches_for_step "$step" "$OBSERVED_JSON" "$desired"
      ;;
    DELETE_OLD_PAYMENT)
      payment_json_matches "$OBSERVED_JSON" "$desired" ||
        deleted_payment_absence_proof_matches "$OBSERVED_JSON"
      ;;
    RESTORE_OLD_PAYMENT)
      payment_json_matches "$OBSERVED_JSON" "$desired"
      ;;
  esac
}

observed_matches_expected() {
  local step="$1" expected="$2"
  [[ "$OBSERVATION_AVAILABLE" == "true" ]] || return 1
  case "$step" in
    INACTIVATE_SUBSCRIPTION|ACTIVATE_TARGET_SCHEDULE|ACTIVATE_ORIGINAL_SCHEDULE)
      # Every pre-submit comparison is exact. In particular, nextDueDate must
      # still equal the immutable expected-before snapshot. The stable-fields
      # comparison is reserved for observing provider effects after submission.
      subscription_json_matches_exact "$OBSERVED_JSON" "$expected"
      ;;
    INACTIVATE_CONFLICTED_SUBSCRIPTION)
      subscription_stable_fields_match "$OBSERVED_JSON" "$expected" || return 1
      [[ "$(jq -er '.status' <<< "$OBSERVED_JSON")" == "ACTIVE" ]] || return 1
      local expected_next
      expected_next="$(jq -er '.nextDueDate' <<< "$OBSERVED_JSON")" || return 1
      if [[ "$expected_next" != "$TARGET_DUE_DATE" ]]; then
        monthly_date_is_after_target "$expected_next" || return 1
      fi
      set +e
      load_target_payment_evidence true
      TARGET_EVIDENCE_RESULT=$?
      set -e
      [[ ("$TARGET_EVIDENCE_RESULT" == "2" ||
          "$TARGET_EVIDENCE_RESULT" == "3") &&
         "$TARGET_COMPETENCE_COUNT" -gt 0 ]]
      ;;
    DELETE_OLD_PAYMENT)
      payment_json_matches "$OBSERVED_JSON" "$expected"
      ;;
    RESTORE_OLD_PAYMENT)
      payment_json_matches "$OBSERVED_JSON" "$expected" ||
        deleted_payment_absence_proof_matches "$OBSERVED_JSON"
      ;;
  esac
}

operation_status_after_success() {
  case "$1" in
    INACTIVATE_SUBSCRIPTION) printf '%s' INACTIVE_CONFIRMED ;;
    DELETE_OLD_PAYMENT) printf '%s' OLD_PAYMENT_DELETED ;;
    ACTIVATE_TARGET_SCHEDULE) printf '%s' TARGET_SCHEDULED ;;
    INACTIVATE_CONFLICTED_SUBSCRIPTION) printf '%s' BLOCKED ;;
    ACTIVATE_ORIGINAL_SCHEDULE) printf '%s' ORIGINAL_SUBSCRIPTION_RESTORED ;;
    RESTORE_OLD_PAYMENT) printf '%s' RESTORING_OLD_PAYMENT ;;
  esac
}

operation_status_after_unknown() {
  case "$1" in
    INACTIVATE_CONFLICTED_SUBSCRIPTION)
      printf '%s' CONTAINING_TARGET_CONFLICT
      ;;
    *) printf '%s' UNKNOWN ;;
  esac
}

record_noop_success() {
  local next_status="$1" reason="$2"
  common_psql_vars
  db_file_capture "$SQL_DIR/record-noop.sql" \
    "${COMMON_PSQL_VARS[@]}" -v "step_kind=$STEP_KIND" \
    -v "operation_status=$next_status" -v "observed_state=$OBSERVED_JSON" \
    -v "reason=$reason" >/dev/null || die "nao foi possivel registrar reconciliacao sem mutacao"
}

record_blocked_before_submit() {
  local reason="$1"
  common_psql_vars
  db_file_capture "$SQL_DIR/mark-blocked.sql" \
    "${COMMON_PSQL_VARS[@]}" -v "step_kind=$STEP_KIND" \
    -v "observed_state=$OBSERVED_JSON" -v "reason=$reason" >/dev/null ||
    die "nao foi possivel bloquear o step divergente"
}

pre_submit_guard() {
  local step_record="$1"
  local expected desired
  expected="$(jq -ce '.expected_before' <<< "$step_record")"
  desired="$(jq -ce '.desired_after' <<< "$step_record")"
  observe_for_step "$STEP_KIND"
  if [[ "$STEP_KIND" == "RESTORE_OLD_PAYMENT" &&
        "$OBSERVATION_AVAILABLE" != "true" &&
        "$OBSERVATION_EXIT_CODE" == "0" &&
        "$OBSERVATION_HTTP_STATUS" == "404" ]]; then
    build_deleted_payment_absence_proof '^SUCCEEDED$' || true
  fi
  [[ "$OBSERVATION_AVAILABLE" == "true" ]] || die "GET pre-submit indisponivel; nenhuma mutacao foi liberada"

  # Payment steps still depend on an exact subscription calendar. Check that
  # cross-entity snapshot before both the mutation path and any no-op path.
  case "$STEP_KIND" in
    DELETE_OLD_PAYMENT)
      local payment_observation="$OBSERVED_JSON" inactive_expected
      provider_get_object "/subscriptions/$SUBSCRIPTION_ID" subscription ||
        die "nao foi possivel confirmar a assinatura inativa"
      inactive_expected="$(jq -ce '
        .steps[]
        | select(.step_kind == "ACTIVATE_TARGET_SCHEDULE")
        | .expected_before
      ' <<< "$CURRENT_CONTEXT_JSON")" ||
        die "snapshot inativo esperado esta ausente do ledger"
      if ! subscription_json_matches_exact \
        "$OBSERVED_JSON" "$inactive_expected"; then
        record_blocked_before_submit \
          "provider_subscription_drift_before_delete"
        die "assinatura inativa divergiu, inclusive nextDueDate; compensacao obrigatoria"
      fi
      OBSERVED_JSON="$payment_observation"
      ;;
    RESTORE_OLD_PAYMENT)
      local payment_observation="$OBSERVED_JSON" original_desired
      provider_get_object "/subscriptions/$SUBSCRIPTION_ID" subscription ||
        die "nao foi possivel confirmar a agenda original"
      original_desired="$(jq -ce '.operation.original_subscription_snapshot' \
        <<< "$CURRENT_CONTEXT_JSON")" ||
        die "snapshot original esperado esta ausente do ledger"
      if ! subscription_json_matches_exact \
        "$OBSERVED_JSON" "$original_desired"; then
        record_blocked_before_submit \
          "provider_subscription_drift_before_payment_restore"
        die "agenda original divergiu, inclusive nextDueDate; restauracao recusada"
      fi
      OBSERVED_JSON="$payment_observation"
      ;;
  esac

  if observed_matches_desired "$STEP_KIND" "$desired"; then
    case "$STEP_KIND" in
      ACTIVATE_ORIGINAL_SCHEDULE|RESTORE_OLD_PAYMENT)
        record_noop_success "$(operation_status_after_success "$STEP_KIND")" \
          "provider_already_in_compensation_state"
        note "Compensacao ja estava aplicada; registrada sem nova mutacao."
        return 10
        ;;
      INACTIVATE_CONFLICTED_SUBSCRIPTION)
        record_noop_success BLOCKED \
          "provider_conflicted_subscription_already_inactive"
        note "Assinatura conflitante ja estava inativa; containment registrado sem mutacao."
        return 10
        ;;
      *)
        record_blocked_before_submit "provider_changed_before_submit"
        die "provedor ja esta no estado desejado sem submissao deste step; revisao obrigatoria"
        ;;
    esac
  fi
  if ! observed_matches_expected "$STEP_KIND" "$expected"; then
    record_blocked_before_submit "provider_state_mismatch_before_submit"
    die "estado do provedor divergiu antes da submissao; step bloqueado"
  fi

  # Cross-entity prerequisites that are not represented by this step's own
  # observed_state are checked immediately before the mutation.
  case "$STEP_KIND" in
    ACTIVATE_TARGET_SCHEDULE)
      local subscription_observation="$OBSERVED_JSON"
      OBSERVATION_AVAILABLE="false"
      provider_get_object "/payments/$OLD_PAYMENT_ID" payment || true
      if [[ "$OBSERVATION_AVAILABLE" == "true" ]]; then
        local deleted_desired
        deleted_desired="$(jq -ce '
          .steps[] | select(.step_kind == "DELETE_OLD_PAYMENT")
          | .desired_after
        ' <<< "$CURRENT_CONTEXT_JSON")" ||
          die "snapshot removido esperado esta ausente do ledger"
        payment_json_matches "$OBSERVED_JSON" "$deleted_desired" ||
          die "cobranca antiga continua ativa ou divergiu; ativacao target recusada"
      else
        build_deleted_payment_absence_proof '^SUCCEEDED$' ||
          die "404 da cobranca antiga nao foi confirmado pelo ledger e pela listagem"
      fi

      set +e
      load_target_payment_evidence true
      local before_target_result=$?
      set -e
      if [[ "$before_target_result" == "2" ||
            "$before_target_result" == "3" ||
            "$before_target_result" == "4" ||
            "$TARGET_COMPETENCE_COUNT" != "0" ]]; then
        OBSERVED_JSON="$(jq -cnS \
          --arg reason "provider_target_competence_not_empty_before_activation" \
          --arg subscription "$SUBSCRIPTION_ID" \
          --argjson targetPayments "$TARGET_CONFLICT_PAYMENT_IDS_JSON" \
          --argjson targetCompetenceCount "$TARGET_COMPETENCE_COUNT" '
            {reason:$reason,subscription:$subscription,
             targetPayments:$targetPayments,
             targetCompetenceCount:$targetCompetenceCount}
          ')"
        record_blocked_before_submit \
          "provider_target_competence_not_empty_before_activation"
        die "competencia target ja possui cobranca; assinatura permanecera inativa para revisao"
      fi
      [[ "$before_target_result" == "0" ]] ||
        die "listagem pre-ativacao indisponivel ou invalida; nenhuma mutacao foi liberada"
      OBSERVED_JSON="$subscription_observation"
      ;;
  esac
  return 0
}

mark_submitting() {
  local request_descriptor="$1" request_fingerprint="$2"
  common_psql_vars
  db_file_capture "$SQL_DIR/mark-submitting.sql" \
    "${COMMON_PSQL_VARS[@]}" -v "step_kind=$STEP_KIND" \
    -v "request_fingerprint=$request_fingerprint" \
    -v "provider_request=$request_descriptor" >/dev/null ||
    die "fence SUBMITTING recusou a mutacao"
}

finish_step() {
  local step_status="$1" operation_status="$2" provider_response="$3"
  local observed_state="$4" http_status="$5" last_error="$6"
  local target_conflict_evidence="${7:-}"
  [[ -n "$target_conflict_evidence" ]] || target_conflict_evidence='{}'
  common_psql_vars
  db_file_capture "$SQL_DIR/finish-step.sql" \
    "${COMMON_PSQL_VARS[@]}" -v "step_kind=$STEP_KIND" \
    -v "step_status=$step_status" -v "operation_status=$operation_status" \
    -v "provider_response=$provider_response" -v "observed_state=$observed_state" \
    -v "provider_http_status=$http_status" -v "last_error=$last_error" \
    -v "target_conflict_evidence=$target_conflict_evidence" >/dev/null ||
    die "resultado do provider exige revisao: nao foi possivel persisti-lo"
}

submit_provider_mutation_once() {
  local descriptor="$1"
  local method path body response_file body_file=""
  method="$(jq -er '.method' <<< "$descriptor")"
  path="$(jq -er '.path' <<< "$descriptor")"
  body="$(jq -c '.body' <<< "$descriptor")"
  response_file="$TMP_DIR/mutation-response.json"
  if [[ "$body" != "null" ]]; then
    body_file="$TMP_DIR/mutation-body.json"
    printf '%s' "$body" > "$body_file"
  fi
  asaas_call "$method" "$path" "$response_file" "$body_file"
  MUTATION_HTTP_STATUS="$HTTP_STATUS"
  MUTATION_EXIT_CODE="$HTTP_EXIT_CODE"
  MUTATION_LEDGER_HTTP_STATUS="$MUTATION_HTTP_STATUS"
  [[ "$MUTATION_LEDGER_HTTP_STATUS" =~ ^[1-5][0-9]{2}$ ]] ||
    MUTATION_LEDGER_HTTP_STATUS=""
  MUTATION_RESPONSE_JSON="$(safe_provider_response_json "$response_file")"
}

apply_step() {
  [[ "$MODE" == "execute" ]] || die "apply exige --mode execute"
  load_context || die "execute PREPARE antes de qualquer mutacao"
  validate_context_scope
  local step_record step_status descriptor fingerprint desired
  step_record="$(step_json)" || die "step ausente no ledger"
  step_status="$(jq -er '.status' <<< "$step_record")"
  case "$step_status" in
    SUCCEEDED)
      note "Step ja concluido; nenhuma mutacao foi repetida."
      return
      ;;
    SUBMITTING|UNKNOWN)
      note "Step ambiguo: apply foi convertido em reconciliacao GET-only."
      reconcile_step
      return
      ;;
    FAILED|BLOCKED)
      die "step esta $step_status e nao pode ser reenviado"
      ;;
    READY) ;;
    *) die "estado de step desconhecido: $step_status" ;;
  esac

  set +e
  pre_submit_guard "$step_record"
  local guard_result=$?
  set -e
  [[ "$guard_result" == "10" ]] && return
  [[ "$guard_result" == "0" ]] || exit "$guard_result"

  descriptor="$(make_request_descriptor "$STEP_KIND")"
  INTEGRATION_SNAPSHOT_JSON="$(jq -ceS '.operation.integration_snapshot' <<< "$CURRENT_CONTEXT_JSON")"
  fingerprint="$(make_step_fingerprint "$STEP_KIND" "$descriptor")"
  [[ "$fingerprint" == "$(jq -er '.request_fingerprint' <<< "$step_record")" ]] ||
    die "fingerprint do request divergiu do PREPARE"
  mark_submitting "$descriptor" "$fingerprint"

  # This is the sole mutation call. curl retries are explicitly disabled.
  submit_provider_mutation_once "$descriptor"
  observe_for_step "$STEP_KIND"
  desired="$(jq -ce '.desired_after' <<< "$step_record")"

  local delete_outcome_reconcilable="true"
  if [[ "$STEP_KIND" == "DELETE_OLD_PAYMENT" ]]; then
    set +e
    delete_mutation_outcome_can_be_reconciled
    local delete_outcome_result=$?
    set -e
    [[ "$delete_outcome_result" == "0" ]] ||
      delete_outcome_reconcilable="false"
    if [[ "$OBSERVATION_AVAILABLE" != "true" &&
          "$OBSERVATION_EXIT_CODE" == "0" &&
          "$OBSERVATION_HTTP_STATUS" == "404" &&
          "$delete_outcome_reconcilable" == "true" ]]; then
      load_context || die "ledger desapareceu durante a reconciliacao do DELETE"
      validate_context_scope
      build_deleted_payment_absence_proof '^(SUBMITTING|UNKNOWN)$' || true
    fi
  fi

  if [[ "$delete_outcome_reconcilable" == "true" ]] &&
     observed_matches_desired "$STEP_KIND" "$desired"; then
    finish_step SUCCEEDED "$(operation_status_after_success "$STEP_KIND")" \
      "$MUTATION_RESPONSE_JSON" "$OBSERVED_JSON" \
      "$MUTATION_LEDGER_HTTP_STATUS" ""
    note "Step confirmado por GET e concluido."
    return
  fi

  if [[ "$STEP_KIND" == "ACTIVATE_TARGET_SCHEDULE" &&
        ("$TARGET_EVIDENCE_RESULT" == "2" ||
         "$TARGET_EVIDENCE_RESULT" == "3") ]]; then
    local target_conflict_evidence
    target_conflict_evidence="$(target_conflict_evidence_json)" ||
      die "conflito target sem evidencia persistivel; ledger permanece ambiguo"
    finish_step BLOCKED CONTAINING_TARGET_CONFLICT \
      "$MUTATION_RESPONSE_JSON" "$OBSERVED_JSON" \
      "$MUTATION_LEDGER_HTTP_STATUS" \
      "provider_target_competence_conflict" "$target_conflict_evidence"
    die "conflito target confirmado; aplique somente o step de inativacao de containment"
  fi

  if [[ "$MUTATION_EXIT_CODE" != "0" || "$MUTATION_HTTP_STATUS" == "408" ||
        "$MUTATION_HTTP_STATUS" == "429" || "$MUTATION_HTTP_STATUS" =~ ^5 ]]; then
    finish_step UNKNOWN "$(operation_status_after_unknown "$STEP_KIND")" \
      "$MUTATION_RESPONSE_JSON" "$OBSERVED_JSON" \
      "$MUTATION_LEDGER_HTTP_STATUS" "provider_mutation_outcome_unknown"
    note "Resultado ambiguo: ledger UNKNOWN; somente GET sera permitido daqui em diante."
    return
  fi

  if [[ "$MUTATION_HTTP_STATUS" =~ ^2 ]]; then
    finish_step UNKNOWN "$(operation_status_after_unknown "$STEP_KIND")" \
      "$MUTATION_RESPONSE_JSON" "$OBSERVED_JSON" \
      "$MUTATION_LEDGER_HTTP_STATUS" "provider_success_not_confirmed_by_get"
    note "Resposta aceita, mas GET nao confirmou; ledger UNKNOWN e sem reenvio."
    return
  fi

  local operation_failure_status
  case "$STEP_KIND" in
    INACTIVATE_SUBSCRIPTION)
      if observed_matches_expected "$STEP_KIND" \
        "$(jq -ce '.expected_before' <<< "$step_record")"; then
        operation_failure_status="FAILED"
      else
        operation_failure_status="BLOCKED"
      fi
      ;;
    DELETE_OLD_PAYMENT|ACTIVATE_TARGET_SCHEDULE)
      operation_failure_status="COMPENSATING_SUBSCRIPTION"
      ;;
    INACTIVATE_CONFLICTED_SUBSCRIPTION)
      operation_failure_status="CONTAINING_TARGET_CONFLICT"
      ;;
    ACTIVATE_ORIGINAL_SCHEDULE|RESTORE_OLD_PAYMENT)
      operation_failure_status="BLOCKED"
      ;;
  esac
  finish_step FAILED "$operation_failure_status" "$MUTATION_RESPONSE_JSON" \
    "$OBSERVED_JSON" "$MUTATION_LEDGER_HTTP_STATUS" \
    "provider_mutation_rejected"
  if [[ "$operation_failure_status" == "COMPENSATING_SUBSCRIPTION" ]]; then
    note "Mutacao recusada apos side effect anterior; compensacao explicita e obrigatoria."
  else
    note "Mutacao recusada sem side effect confirmado; operacao encerrada como FAILED."
  fi
}

reconcile_step() {
  load_context || die "operacao nao encontrada"
  validate_context_scope
  local step_record step_status desired next_status
  step_record="$(step_json)" || die "step ausente no ledger"
  step_status="$(jq -er '.status' <<< "$step_record")"
  case "$step_status" in
    SUCCEEDED) note "Step ja confirmado; nenhum GET adicional necessario."; return ;;
    SUBMITTING|UNKNOWN) ;;
    *) die "reconcile de step aceita somente SUBMITTING ou UNKNOWN" ;;
  esac
  [[ "$(jq -er '.submit_attempt_count' <<< "$step_record")" == "1" ]] ||
    die "step ambiguo sem tentativa unica registrada"

  observe_for_step "$STEP_KIND"
  if [[ "$STEP_KIND" == "DELETE_OLD_PAYMENT" &&
        "$OBSERVATION_AVAILABLE" != "true" &&
        "$OBSERVATION_EXIT_CODE" == "0" &&
        "$OBSERVATION_HTTP_STATUS" == "404" ]]; then
    build_deleted_payment_absence_proof '^(SUBMITTING|UNKNOWN)$' || true
  fi
  desired="$(jq -ce '.desired_after' <<< "$step_record")"
  if observed_matches_desired "$STEP_KIND" "$desired"; then
    next_status="$(operation_status_after_success "$STEP_KIND")"
    finish_step SUCCEEDED "$next_status" '{}' "$OBSERVED_JSON" "" \
      "reconciled_by_get"
    note "GET confirmou o efeito; step ambiguo foi reconciliado sem reenvio."
    return
  fi
  if [[ "$STEP_KIND" == "ACTIVATE_TARGET_SCHEDULE" &&
        ("$TARGET_EVIDENCE_RESULT" == "2" ||
         "$TARGET_EVIDENCE_RESULT" == "3") ]]; then
    local target_conflict_evidence
    target_conflict_evidence="$(target_conflict_evidence_json)" ||
      die "GET encontrou conflito target sem evidencia persistivel"
    finish_step BLOCKED CONTAINING_TARGET_CONFLICT '{}' "$OBSERVED_JSON" "" \
      "provider_target_competence_conflict" "$target_conflict_evidence"
    die "GET encontrou conflito target; containment da assinatura e obrigatorio"
  fi
  finish_step UNKNOWN "$(operation_status_after_unknown "$STEP_KIND")" \
    '{}' "$OBSERVED_JSON" "" \
    "provider_mutation_still_ambiguous"
  note "GET ainda nao prova o resultado; UNKNOWN foi preservado e nenhuma mutacao ocorreu."
}

mark_target_conflict_for_containment() {
  local evidence result
  evidence="$(target_conflict_evidence_json)" ||
    die "conflito target sem IDs seguros; ledger nao foi alterado"
  common_psql_vars
  result="$(db_file_capture "$SQL_DIR/mark-target-conflict.sql" \
    "${COMMON_PSQL_VARS[@]}" \
    -v "target_conflict_evidence=$evidence" \
    -v "reason=provider_target_competence_conflict")" ||
    die "ledger recusou a transicao atomica para containment"
  [[ "$(jq -er '.status' <<< "$result")" == \
      "CONTAINING_TARGET_CONFLICT" ]] ||
    die "ledger nao confirmou o estado de containment"
}

reconcile_operation() {
  load_context || die "operacao nao encontrada"
  validate_context_scope
  local status
  status="$(jq -er '.operation.status' <<< "$CURRENT_CONTEXT_JSON")"
  case "$status" in
    TARGET_SCHEDULED|AWAITING_TARGET_PAYMENT|RESTORING_OLD_PAYMENT|COMPLETED|COMPENSATED) ;;
    *) die "operacao ainda nao esta pronta para reconciliacao final" ;;
  esac
  if [[ "$status" == "COMPLETED" || "$status" == "COMPENSATED" ]]; then
    note "Operacao ja concluida."
    return
  fi

  local desired old_desired subscription_observed old_payment_observed
  local result final_status

  if [[ "$status" == "RESTORING_OLD_PAYMENT" ]]; then
    desired="$(jq -ce '.operation.original_subscription_snapshot' \
      <<< "$CURRENT_CONTEXT_JSON")" ||
      die "snapshot original da assinatura esta ausente"
    old_desired="$(jq -ce '.operation.original_payment_snapshot' \
      <<< "$CURRENT_CONTEXT_JSON")" ||
      die "snapshot original da cobranca esta ausente"
    provider_get_object "/subscriptions/$SUBSCRIPTION_ID" subscription ||
      die "GET da assinatura indisponivel; ledger nao foi alterado"
    subscription_observed="$OBSERVED_JSON"
    subscription_json_matches_exact "$subscription_observed" "$desired" ||
      die "assinatura nao permanece na agenda original; revisao obrigatoria"
    provider_get_object "/payments/$OLD_PAYMENT_ID" payment ||
      die "GET da cobranca antiga indisponivel; ledger nao foi alterado"
    old_payment_observed="$OBSERVED_JSON"
    payment_json_matches "$old_payment_observed" "$old_desired" ||
      die "cobranca antiga nao permanece restaurada; revisao obrigatoria"

    common_psql_vars
    result="$(db_file_capture "$SQL_DIR/reconcile-operation.sql" \
      "${COMMON_PSQL_VARS[@]}" -v "target_payment_id=" \
      -v "target_payment_observed={}" \
      -v "subscription_observed=$subscription_observed" \
      -v "old_payment_observed=$old_payment_observed")" ||
      die "reconciliacao local recusou a compensacao"
    final_status="$(jq -er '.status' <<< "$result")"
    case "$final_status" in
      COMPENSATED)
        note "Cobranca antiga restaurada no Asaas e no ledger local; operacao COMPENSATED."
        ;;
      RESTORING_OLD_PAYMENT)
        note "Asaas restaurado; aguardando o webhook restaurar a cobranca local."
        ;;
      *) die "estado inesperado apos reconciliacao: $final_status" ;;
    esac
    return
  fi

  desired="$(jq -ce '.operation.target_subscription_snapshot' <<< "$CURRENT_CONTEXT_JSON")"
  old_desired="$(jq -ce '.steps[] | select(.step_kind == "DELETE_OLD_PAYMENT") | .desired_after' \
    <<< "$CURRENT_CONTEXT_JSON")"
  provider_get_object "/subscriptions/$SUBSCRIPTION_ID" subscription ||
    die "GET da assinatura indisponivel; ledger nao foi alterado"
  subscription_observed="$OBSERVED_JSON"
  local subscription_match_result
  set +e
  subscription_json_matches_for_step ACTIVATE_TARGET_SCHEDULE \
    "$subscription_observed" "$desired"
  subscription_match_result=$?
  set -e
  if [[ "$subscription_match_result" == "2" ||
        "$subscription_match_result" == "3" ]]; then
    mark_target_conflict_for_containment
    die "conflito target confirmado; aplique somente o step de containment"
  fi
  [[ "$subscription_match_result" == "0" ]] ||
    die "assinatura divergiu da agenda target; revisao obrigatoria"
  OBSERVATION_AVAILABLE="false"
  provider_get_object "/payments/$OLD_PAYMENT_ID" payment || true
  if [[ "$OBSERVATION_AVAILABLE" == "true" ]]; then
    old_payment_observed="$OBSERVED_JSON"
    payment_json_matches "$old_payment_observed" "$old_desired" ||
      die "cobranca antiga nao permanece removida; revisao obrigatoria"
  else
    build_deleted_payment_absence_proof '^SUCCEEDED$' ||
      die "404 da cobranca antiga nao foi confirmado pela listagem e pelo ledger"
    old_payment_observed="$OBSERVED_JSON"
  fi

  local evidence_result
  set +e
  load_target_payment_evidence true
  evidence_result=$?
  set -e
  if [[ "$evidence_result" == "2" || "$evidence_result" == "3" ]]; then
    mark_target_conflict_for_containment
    die "conflito target confirmado; aplique somente o step de containment"
  fi
  [[ "$evidence_result" == "0" ]] ||
    die "lista de parcelas indisponivel ou invalida; ledger nao foi alterado"

  common_psql_vars
  local target_payment_observed='{}'
  if [[ -n "$TARGET_PAYMENT_ID" ]]; then
    target_payment_observed="$(jq -ce '.[0]' \
      <<< "$TARGET_PAYMENT_EVIDENCE_JSON")" ||
      die "snapshot da parcela target esta ausente"
  fi
  result="$(db_file_capture "$SQL_DIR/reconcile-operation.sql" \
    "${COMMON_PSQL_VARS[@]}" -v "target_payment_id=$TARGET_PAYMENT_ID" \
    -v "target_payment_observed=$target_payment_observed" \
    -v "subscription_observed=$subscription_observed" \
    -v "old_payment_observed=$old_payment_observed")" ||
    die "reconciliacao local recusou o snapshot do provedor"
  final_status="$(jq -er '.status' <<< "$result")"
  case "$final_status" in
    COMPLETED) note "Calendario e efeitos locais estao reconciliados; operacao COMPLETED." ;;
    AWAITING_TARGET_PAYMENT)
      note "Agenda target confirmada; aguardando materializacao/webhook da nova parcela." ;;
    *) die "estado inesperado apos reconciliacao: $final_status" ;;
  esac
}

show_status() {
  common_psql_vars
  local result
  result="$(db_file_capture "$SQL_DIR/status.sql" "${COMMON_PSQL_VARS[@]}")" ||
    die "nao foi possivel ler o status"
  [[ -n "$result" ]] || die "operacao nao encontrada"
  jq -r '
    "operacao=" + .operationStatus,
    (.steps[] | "step=" + .stepKind + " status=" + .status +
      " tentativas=" + (.submitAttemptCount | tostring)),
    "claim_target=" + .targetClaimStatus,
    "outubro_preservado=" + (.oldClaimPreserved | tostring)
  ' <<< "$result"
}

main() {
  parse_args "$@"
  validate_args
  init_dependencies
  common_psql_vars
  check_schema_contract

  case "$COMMAND" in
    preflight)
      initial_provider_preflight
      run_db_preflight
      note "Preflight aprovado: nenhuma escrita e nenhuma mutacao Asaas foram realizadas."
      ;;
    prepare) prepare_operation ;;
    apply) apply_step ;;
    reconcile)
      [[ "$MODE" == "execute" ]] || die "reconcile grava observacoes no ledger e exige --mode execute"
      if [[ -n "$STEP_KIND" ]]; then reconcile_step; else reconcile_operation; fi
      ;;
    status) show_status ;;
  esac
}

main "$@"
