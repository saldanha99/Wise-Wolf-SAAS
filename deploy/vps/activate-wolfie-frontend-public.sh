#!/usr/bin/env bash
# Performs the one-time DNS/TLS cutover after an internal Wolfie release exists.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"
WOLFIE_ENV_FILE="${WOLFIE_ENV_FILE:-$PROJECT_DIR/.env.deploy.wolfie.local}"
SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
)

for command_name in dig ssh; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "comando obrigatório ausente: $command_name" >&2
    exit 1
  }
done
[[ -s "$DEPLOY_ENV_FILE" ]]
set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"
if [[ -s "$WOLFIE_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$WOLFIE_ENV_FILE"
fi
set +a

: "${DEPLOY_SSH_HOST:?DEPLOY_SSH_HOST ausente}"
: "${DEPLOY_HOST:?DEPLOY_HOST ausente}"
DEPLOY_WOLFIE_APP_DIR="${DEPLOY_WOLFIE_APP_DIR:-/opt/wisewolf/wolfie-frontend}"
DEPLOY_WOLFIE_PUBLIC_URL="${DEPLOY_WOLFIE_PUBLIC_URL:-https://wolfie.wisewolflanguage.com.br}"
DEPLOY_WOLFIE_HOSTNAME="${DEPLOY_WOLFIE_HOSTNAME:-wolfie.wisewolflanguage.com.br}"
[[ "$DEPLOY_HOST" = "187.127.46.251" ]]
[[ "$DEPLOY_WOLFIE_APP_DIR" = "/opt/wisewolf/wolfie-frontend" ]]
[[ "$DEPLOY_WOLFIE_HOSTNAME" = "wolfie.wisewolflanguage.com.br" ]]
[[ "$DEPLOY_WOLFIE_PUBLIC_URL" = "https://$DEPLOY_WOLFIE_HOSTNAME" ]]

echo "== Validação do cutover DNS =="
for resolver in 1.1.1.1 8.8.8.8; do
  cname="$(dig +short "@$resolver" CNAME "$DEPLOY_WOLFIE_HOSTNAME" | tr -d '[:space:]')"
  [[ -z "$cname" ]] || {
    echo "o resolver $resolver ainda encontra CNAME: $cname" >&2
    exit 1
  }
  addresses="$(dig +short "@$resolver" A "$DEPLOY_WOLFIE_HOSTNAME" | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')"
  [[ "$addresses" = "$DEPLOY_HOST" ]] || {
    echo "o resolver $resolver ainda não aponta exclusivamente para $DEPLOY_HOST" >&2
    exit 1
  }
done

echo "== Ativação pública e emissão TLS =="
ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_WOLFIE_APP_DIR" "$DEPLOY_WOLFIE_PUBLIC_URL" <<'REMOTE'
set -Eeuo pipefail
umask 077
base_dir=$1
public_url=$2
[[ "$base_dir" = "/opt/wisewolf/wolfie-frontend" ]]
[[ "$public_url" = "https://wolfie.wisewolflanguage.com.br" ]]
[[ -d "$base_dir" && ! -L "$base_dir" ]]
[[ -L "$base_dir/current" ]]
active_release="$(cat "$base_dir/ACTIVE_RELEASE")"
[[ "$active_release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
current_target="$(readlink -f "$base_dir/current")"
[[ "$current_target" = "$base_dir/releases/$active_release/dist" ]]
[[ "$(cat "$current_target/.well-known/wolfie-release")" = "$active_release" ]]

exec 9>"$base_dir/.deploy.lock"
flock -n 9 || { echo "outro deploy Wolfie está em andamento" >&2; exit 1; }
env_file="$base_dir/.env"
[[ -f "$env_file" && ! -L "$env_file" ]]
old_router_state="$(awk -F= '$1 == "WOLFIE_TRAEFIK_ENABLE" { print $2; exit }' "$env_file")"
[[ "$old_router_state" = "true" || "$old_router_state" = "false" ]]
env_next="$base_dir/.env.next.$active_release.$$"
public_next="$base_dir/PUBLIC_ACTIVE.next.$active_release.$$"
[[ ! -e "$env_next" && ! -L "$env_next" ]]
[[ ! -e "$public_next" && ! -L "$public_next" ]]

disable_router() {
  local exit_code=$?
  trap - ERR INT TERM
  set +e
  rm -f -- "$env_next" "$public_next"
  printf 'WOLFIE_TRAEFIK_ENABLE=%s\n' "$old_router_state" > "$env_next"
  chmod 0600 "$env_next"
  mv -Tf -- "$env_next" "$env_file"
  (cd "$base_dir" && docker compose up -d --force-recreate wolfie-frontend)
  exit "$exit_code"
}
trap disable_router ERR INT TERM

printf 'WOLFIE_TRAEFIK_ENABLE=true\n' > "$env_next"
chmod 0600 "$env_next"
mv -Tf -- "$env_next" "$env_file"
cd "$base_dir"
docker compose config --quiet
docker compose up -d --force-recreate wolfie-frontend

for attempt in $(seq 1 30); do
  health="$(docker inspect wolfie-frontend --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  [[ "$health" = "healthy" ]] && break
  [[ "$health" = "unhealthy" ]] && { docker logs --tail 80 wolfie-frontend >&2; exit 1; }
  sleep 1
done
[[ "$(docker inspect wolfie-frontend --format '{{.State.Health.Status}}')" = "healthy" ]]

public_ready=false
for attempt in $(seq 1 60); do
  marker="$(curl --fail --silent --show-error \
    --connect-timeout 5 --max-time 15 \
    -H 'Cache-Control: no-cache' \
    "$public_url/.well-known/wolfie-release?release=$active_release" 2>/dev/null || true)"
  if [[ "$marker" = "$active_release" ]] &&
    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
      "$public_url/" >/dev/null &&
    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
      "$public_url/quiz" >/dev/null &&
    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
      "$public_url/app" >/dev/null; then
    public_ready=true
    break
  fi
  sleep 5
done
[[ "$public_ready" = "true" ]]
printf '%s\n' "$active_release" > "$public_next"
chmod 0600 "$public_next"
mv -Tf -- "$public_next" "$base_dir/PUBLIC_ACTIVE"
trap - ERR INT TERM
REMOTE

echo "Wolfie está ativo em $DEPLOY_WOLFIE_PUBLIC_URL"
