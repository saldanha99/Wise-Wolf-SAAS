#!/usr/bin/env bash
# Proteção de espaço no VPS compartilhado. Nunca remove dados, volumes ou backups.
set -euo pipefail

read_disk() {
  read -r USE_PCT AVAIL_KB < <(df -Pk / | awk 'NR == 2 { gsub(/%/, "", $5); print $5, $4 }')
}

read_disk
if (( USE_PCT < 85 && AVAIL_KB >= 20 * 1024 * 1024 )); then
  exit 0
fi

logger -t wisewolf-disk-guard -p user.warning "Disco em ${USE_PCT}% (${AVAIL_KB} KiB livres); removendo apenas cache de build Docker não utilizado"
docker builder prune -f >/dev/null
read_disk

if (( USE_PCT >= 90 || AVAIL_KB < 10 * 1024 * 1024 )); then
  logger -t wisewolf-disk-guard -p user.crit "CRÍTICO: disco em ${USE_PCT}% (${AVAIL_KB} KiB livres) após limpeza segura; intervenção necessária"
  exit 2
fi

logger -t wisewolf-disk-guard -p user.warning "Disco após limpeza segura: ${USE_PCT}% (${AVAIL_KB} KiB livres)"
