#!/usr/bin/env bash
# Entrada de compatibilidade para a publicação da conciliação Asaas.
#
# A verificação deixou de ser duplicada aqui. O release canônico agora valida,
# no mesmo fluxo: migrations e testes SQL em transação, ACLs, invariantes do
# ledger, crons duráveis, isolamento por tenant, autenticação das Edge
# Functions e uma reconciliação Asaas exclusivamente por GET. Manter uma
# segunda lista de asserts neste wrapper já causou falsos positivos quando o
# contrato financeiro evoluiu.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "A conciliação Asaas faz parte do release canônico e será validada de ponta a ponta."
exec bash "$SCRIPT_DIR/release.sh"
