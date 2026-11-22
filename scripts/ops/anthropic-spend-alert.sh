#!/usr/bin/env bash
# Wise Wolf: Anthropic API spend this month (UTC), read-only.
# Reads private.ai_provider_monthly_spend (written by supabase/functions/_shared/ai-gateway.ts).
# Above the cap the gateway keeps using Anthropic; this script is the alert.
#
# Usage:  scripts/ops/anthropic-spend-alert.sh [ssh-host]   (default: leiprova-vps)
# Output: one line. Exit 0 = OK, 1 = ALERTA (>= US$ 40 or >= US$ 50), 2 = could not read.
# Thresholds: WARN_USD (default 40) and CAP_USD (default 50).
set -euo pipefail

HOST="${1:-leiprova-vps}"
WARN_USD="${WARN_USD:-40}"
CAP_USD="${CAP_USD:-50}"

SQL="select coalesce(sum(usd), 0)::numeric(14,2) || '|' || coalesce(sum(calls), 0)
       from private.ai_provider_monthly_spend
      where provider = 'anthropic'
        and month = date_trunc('month', now() at time zone 'utc')::date;"

if ! row=$(printf '%s\n' "$SQL" | timeout 60 ssh -o BatchMode=yes "$HOST" \
  'docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" supabase-db psql -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1' 2>/dev/null); then
  echo "ERRO: não consegui ler o gasto da Anthropic (host $HOST)"
  exit 2
fi
row="$(printf '%s' "$row" | tr -d '[:space:]')"
usd="${row%%|*}"
calls="${row##*|}"
if [[ -z "$usd" || ! "$usd" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "ERRO: resposta inesperada do banco"
  exit 2
fi

month="$(date -u +%Y-%m)"
over() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }

if over "$usd" "$CAP_USD"; then
  echo "ALERTA: Wise Wolf passou do teto da Anthropic em $month: US\$ $usd de US\$ $CAP_USD ($calls chamadas). A rota continua na Anthropic."
  exit 1
elif over "$usd" "$WARN_USD"; then
  echo "ALERTA: Wise Wolf passou de US\$ $WARN_USD na Anthropic em $month: US\$ $usd de US\$ $CAP_USD ($calls chamadas)."
  exit 1
fi
echo "OK: Wise Wolf gastou US\$ $usd na Anthropic em $month (teto US\$ $CAP_USD, $calls chamadas)."
