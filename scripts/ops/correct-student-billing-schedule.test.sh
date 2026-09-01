#!/usr/bin/env bash
set -Eeuo pipefail

readonly TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly OPERATOR="$TEST_DIR/correct-student-billing-schedule.sh"
readonly SQL_DIR="$TEST_DIR/sql"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

bash -n "$OPERATOR"
"$OPERATOR" --help >/dev/null

[[ "$(rg -c 'asaas_call "\$method" "\$path"' "$OPERATOR")" == "1" ]] ||
  fail "o operador deve ter um unico ponto de submissao mutante"
rg -q -- '--retry 0' "$OPERATOR" || fail "curl precisa permanecer sem retry"
rg -q 'MUTATION_HTTP_STATUS="\$HTTP_STATUS"' "$OPERATOR" ||
  fail "status HTTP da mutacao precisa ser congelado antes do GET"
rg -q 'MUTATION_EXIT_CODE="\$HTTP_EXIT_CODE"' "$OPERATOR" ||
  fail "exit code da mutacao precisa ser congelado antes do GET"
rg -q 'MUTATION_HTTP_STATUS" == "408"' "$OPERATOR" ||
  fail "HTTP 408 precisa ser ambiguo"
rg -q 'MUTATION_HTTP_STATUS" == "429"' "$OPERATOR" ||
  fail "HTTP 429 precisa ser ambiguo"
rg -q 'SUBMITTING\|UNKNOWN' "$OPERATOR" ||
  fail "apply precisa desviar estados ambiguos para GET-only"
rg -q 'payments\?limit=100&offset=0' "$OPERATOR" ||
  fail "listagem de parcelas precisa ser limitada e paginada"
rg -Fq '.hasMore | type == "boolean"' "$OPERATOR" ||
  fail "listagem nao exige hasMore explicito"
rg -Fq '.totalCount == (.data | length)' "$OPERATOR" ||
  fail "listagem truncada ainda pode provar ausencia"
rg -Uq '(?s)\.dueDate.*?\$month or.*?\.originalDueDate.*?\$month' \
  "$OPERATOR" || fail "competencia target nao cobre dueDate e originalDueDate"
rg -q 'externalReference == \$externalReference' "$OPERATOR" ||
  fail "externalReference precisa ser validado"
rg -q 'maxPayments == \$maxPayments' "$OPERATOR" ||
  fail "maxPayments precisa ser validado"
rg -q '\.nextDueDate == \$next' "$OPERATOR" ||
  fail "preflight inicial precisa exigir nextDueDate informado"
rg -q 'subscription_json_matches_exact "\$OBSERVED_JSON" "\$expected"' \
  "$OPERATOR" || fail "expected-before da assinatura precisa incluir nextDueDate"
rg -Uq 'INACTIVATE_SUBSCRIPTION\)\n[[:space:]]+subscription_json_matches_exact "\$actual" "\$desired"' \
  "$OPERATOR" || fail "GET pos-INACTIVATE precisa confirmar nextDueDate exato"
rg -q 'provider_subscription_drift_before_delete' "$OPERATOR" ||
  fail "DELETE precisa bloquear drift de nextDueDate antes da submissao"
rg -q 'provider_subscription_drift_before_payment_restore' "$OPERATOR" ||
  fail "RESTORE precisa bloquear drift de nextDueDate antes da submissao"
rg -q 'INACTIVATE_CONFLICTED_SUBSCRIPTION' "$OPERATOR" ||
  fail "step de containment da assinatura conflitante ausente"
[[ "$(rg -c '^INACTIVATE_CONFLICTED_SUBSCRIPTION\|COMPENSATION\|35$' "$OPERATOR")" == "1" ]] ||
  fail "ordinal 35 do containment divergiu"

[[ "$(rg -c '^ACTIVATE_ORIGINAL_SCHEDULE\|COMPENSATION\|40$' "$OPERATOR")" == "1" ]] ||
  fail "ordinal da compensacao da assinatura divergiu"
[[ "$(rg -c '^RESTORE_OLD_PAYMENT\|COMPENSATION\|50$' "$OPERATOR")" == "1" ]] ||
  fail "ordinal da restauracao da cobranca divergiu"

rg -q 'submit_attempt_count = submit_attempt_count \+ 1' \
  "$SQL_DIR/mark-submitting.sql" || fail "contador at-most-once ausente"
rg -q "step_row.submit_attempt_count <> 0" \
  "$SQL_DIR/mark-submitting.sql" || fail "fence de tentativa consumida ausente"
rg -Uq "(?s)INACTIVATE_CONFLICTED_SUBSCRIPTION.*?CONTAINING_TARGET_CONFLICT" \
  "$SQL_DIR/mark-submitting.sql" || fail "containment nao parte do estado dedicado"
rg -q "target_conflict_evidence" "$SQL_DIR/finish-step.sql" ||
  fail "conflito target nao grava evidencia duravel"
rg -q "CONTAINING_TARGET_CONFLICT" "$SQL_DIR/mark-target-conflict.sql" ||
  fail "reconcile final nao consegue abrir containment atomico"
rg -q "target_conflict_evidence is null" "$SQL_DIR/mark-target-conflict.sql" ||
  fail "evidencia de conflito precisa ser write-once"
rg -q "then 'COMPENSATING_SUBSCRIPTION'" \
  "$SQL_DIR/mark-blocked.sql" || fail "divergencia pos-side-effect nao abre compensacao"
rg -q 'provider_target_competence_not_empty_before_activation' \
  "$SQL_DIR/mark-blocked.sql" || fail "conflito pre-target nao preserva bloqueio manual"
rg -q "'BOUND'" "$SQL_DIR/prepare.sql" || fail "claim target nao nasce BOUND"
rg -q "date_trunc\('month', args.target_due_date\)" \
  "$SQL_DIR/prepare.sql" || fail "PREPARE nao protege a competencia target"
rg -q 'private.student_subscription_mutation_scope_valid' \
  "$SQL_DIR/prepare.sql" || fail "PREPARE omite revalidacao atomica do lifecycle"
rg -q 'from public.asaas_subscription_mutation_operations as operation' \
  "$SQL_DIR/prepare.sql" || fail "PREPARE omite mutacao concorrente de assinatura"
rg -q 'accept_events_until >= pg_catalog.clock_timestamp' \
  "$SQL_DIR/mark-submitting.sql" || fail "submissao permitida fora da janela de eventos"
rg -q 'private.tenant_integration_connections as connection' \
  "$SQL_DIR/mark-submitting.sql" || fail "mutacao nao revalida conexao live"
rg -q 'connection.version::text' "$SQL_DIR/mark-submitting.sql" ||
  fail "mutacao nao compara versao live da integracao"
rg -q '\.operation\.integration_snapshot\.environment == \$providerEnvironment' \
  "$OPERATOR" || fail "CLI environment pode divergir do ledger"
rg -q '\.operation\.integration_snapshot\.baseUrl == \$asaasBaseUrl' \
  "$OPERATOR" || fail "CLI baseUrl pode divergir do ledger"
rg -q '\.integrationLive == true' "$OPERATOR" ||
  fail "GET-only nao revalida conexao live"
rg -q "operation.accept_events_until = :'accept_events_until'::timestamptz" \
  "$SQL_DIR/load-context.sql" ||
  fail "reload nao ancora a janela de eventos por igualdade timestamptz"
rg -q '\.operation\.accept_events_until == \.requestedAcceptEventsUntil' \
  "$OPERATOR" || fail "validate_context_scope omite a janela canonica do ledger"
for status_anchor in \
  "original_subscription_snapshot ->> 'nextDueDate'" \
  "original_subscription_snapshot ->> 'endDate'" \
  "operation.accept_events_until = :'accept_events_until'::timestamptz"; do
  rg -Fq "$status_anchor" "$SQL_DIR/status.sql" ||
    fail "status omite anchor contratual: $status_anchor"
done
rg -Uq "(?s)args.step_kind = 'RESTORE_OLD_PAYMENT'.*?args.operation_status = 'RESTORING_OLD_PAYMENT'" \
  "$SQL_DIR/finish-step.sql" || fail "RESTORE nao pode concluir COMPENSATED direto"
rg -Uq "(?s)args.step_kind = 'RESTORE_OLD_PAYMENT'.*?args.operation_status <> 'RESTORING_OLD_PAYMENT'" \
  "$SQL_DIR/record-noop.sql" || fail "no-op de RESTORE nao pode concluir COMPENSATED direto"
rg -q "operation_row.status = 'RESTORING_OLD_PAYMENT'" \
  "$SQL_DIR/reconcile-operation.sql" || fail "reconcile omite espera da restauracao local"
rg -q 'private.asaas_billing_schedule_compensation_causal' \
  "$SQL_DIR/reconcile-operation.sql" ||
  fail "COMPENSATED nao exige causalidade DELETE/RESTORE"
rg -q "deleted_event.event_name = 'PAYMENT_DELETED'" \
  "$SQL_DIR/mark-submitting.sql" ||
  fail "ACTIVATE/RESTORE nao exigem webhook DELETE processado"
rg -q 'deleted_event.received_at >= delete_step.submitted_at' \
  "$SQL_DIR/mark-submitting.sql" ||
  fail "replay PAYMENT_DELETED anterior ao submit nao foi rejeitado"
rg -q 'payment.last_provider_event_id' "$SQL_DIR/mark-submitting.sql" ||
  fail "gate causal nao ancora no ultimo evento aplicado localmente"
for sql_file in preflight.sql prepare.sql mark-submitting.sql reconcile-operation.sql; do
  rg -q 'public.financial_transactions' "$SQL_DIR/$sql_file" ||
    fail "$sql_file omite evidencia contabil existente"
done
rg -q 'refund_student_payment_id' "$SQL_DIR/mark-submitting.sql" ||
  fail "fence DELETE omite ledger de estorno"
for sql_file in preflight.sql prepare.sql mark-submitting.sql; do
  rg -q 'asaas_id' "$SQL_DIR/$sql_file" ||
    fail "$sql_file omite alias Asaas"
done
rg -q 'target_payment.due_date' "$SQL_DIR/mark-submitting.sql" ||
  fail "ACTIVATE target nao exige competencia local vazia sob lock"
rg -q "payment.status, ''" "$SQL_DIR/reconcile-operation.sql" ||
  fail "reconcile omite status local restaurado"
rg -q "payment.provider_status, ''" "$SQL_DIR/reconcile-operation.sql" ||
  fail "reconcile omite provider_status local restaurado"
rg -q 'payment.payment_date is null' "$SQL_DIR/reconcile-operation.sql" ||
  fail "reconcile omite settlement local"
rg -q 'coalesce\(payment.refunded_amount, 0\) = 0' \
  "$SQL_DIR/reconcile-operation.sql" || fail "reconcile omite estorno local"
rg -q 'coalesce\(payment.ledger_entry_created, false\) is false' \
  "$SQL_DIR/reconcile-operation.sql" || fail "reconcile omite lancamento contabil local"
for financial_field in \
  'payment.value' 'payment.amount_cents' 'payment.billing_type' \
  'payment.payment_method' 'payment.payment_type'; do
  rg -q "$financial_field" "$SQL_DIR/prepare.sql" ||
    fail "PREPARE omite dimensao financeira: $financial_field"
  rg -q "$financial_field" "$SQL_DIR/reconcile-operation.sql" ||
    fail "reconcile omite dimensao financeira: $financial_field"
done
rg -q 'PAYMENT_NOT_FOUND_WITH_SUBSCRIPTION_LIST' "$OPERATOR" ||
  fail "DELETE 404 nao exige prova complementar por listagem"
rg -q '\.id == \$id and \.deleted == true' "$OPERATOR" ||
  fail "resposta DELETE 2xx nao valida id/deleted"
rg -q 'listedLivePaymentIds' "$SQL_DIR/finish-step.sql" ||
  fail "404 isolado ainda pode concluir DELETE"
rg -q 'billing_schedule_restore_get_confirmation_invalid' \
  "$SQL_DIR/finish-step.sql" || fail "RESTORE nao exige GET 200 exato"
rg -Uq '(?s)all\(\.data\[\];.*?\.customer == \$customer and \.subscription == \$subscription' \
  "$OPERATOR" || fail "lista da assinatura ignora binding divergente"
rg -q 'TARGET_COMPETENCE_COUNT.*!=.*"0"' "$OPERATOR" ||
  fail "pre-submit target nao exige competencia provider vazia"
if rg -q 'update public.student_payments' "$OPERATOR" "$SQL_DIR"; then
  fail "operador nao pode reparar student_payments diretamente"
fi
rg -q 'from public.asaas_provider_creation_attempts as operation' \
  "$SQL_DIR/preflight.sql" || fail "preflight omite provider creation ativo"
rg -q 'operation.lifecycle_released_at is null' \
  "$SQL_DIR/preflight.sql" || fail "preflight bloqueia provider creation ja liberado"
rg -q 'from public.student_overdue_card_charge_claims as operation' \
  "$SQL_DIR/preflight.sql" || fail "preflight omite cobranca vencida ativa"
rg -Uq "in \\('RECEIVED', 'RECEIVED_IN_CASH'\\)" \
  "$SQL_DIR/preflight.sql" || fail "preflight bloqueia cobranca vencida ja liquidada"
rg -q 'from public.asaas_outbound_message_attempts as operation' \
  "$SQL_DIR/preflight.sql" || fail "preflight omite mensagem outbound ativa"
rg -q "operation.status in \\('CLAIMED', 'SUBMITTING', 'UNKNOWN'\\)" \
  "$SQL_DIR/preflight.sql" || fail "preflight bloqueia mensagens terminais"

if rg -qi 'gabi|28718884857' "$OPERATOR" "$SQL_DIR"; then
  fail "operador reutilizavel nao pode conter identidade real/de teste"
fi

printf 'OK: operador de correcao passou nas verificacoes estaticas.\n'
