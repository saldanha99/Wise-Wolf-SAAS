#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"
WOLFIE_ENV_FILE="${WOLFIE_ENV_FILE:-$PROJECT_DIR/.env.deploy.wolfie.local}"
release_id="${1:-}"
SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
)

[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || {
  echo "Uso: $0 <release-id>" >&2
  exit 1
}
[[ -s "$DEPLOY_ENV_FILE" ]] || { echo "arquivo de deploy ausente" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"
if [[ -s "$WOLFIE_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$WOLFIE_ENV_FILE"
fi
set +a

: "${DEPLOY_SSH_HOST:?DEPLOY_SSH_HOST ausente}"
DEPLOY_WOLFIE_APP_DIR="${DEPLOY_WOLFIE_APP_DIR:-/opt/wisewolf/wolfie-frontend}"
DEPLOY_WOLFIE_PUBLIC_URL="${DEPLOY_WOLFIE_PUBLIC_URL:-https://wolfie.wisewolflanguage.com.br}"
[[ "$DEPLOY_WOLFIE_APP_DIR" = "/opt/wisewolf/wolfie-frontend" ]]
[[ "$DEPLOY_WOLFIE_PUBLIC_URL" = "https://wolfie.wisewolflanguage.com.br" ]]

ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_WOLFIE_APP_DIR" "$release_id" \
  "$DEPLOY_WOLFIE_PUBLIC_URL" <<'REMOTE'
set -Eeuo pipefail
umask 077
base_dir=$1
release_id=$2
public_url=$3
[[ "$base_dir" = "/opt/wisewolf/wolfie-frontend" ]]
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
[[ "$public_url" = "https://wolfie.wisewolflanguage.com.br" ]]
[[ -d "$base_dir" && ! -L "$base_dir" ]]
[[ "$(readlink -f "$base_dir")" = "$base_dir" ]]
target_release="$base_dir/releases/$release_id"
target="$target_release/dist"
[[ "$(readlink -f "$target_release")" = "$target_release" ]]
[[ "$(readlink -f "$target")" = "$target" ]]
[[ -d "$target" && ! -L "$target" ]]
[[ -s "$target/index.html" ]]
[[ "$(cat "$target/.well-known/wolfie-release")" = "$release_id" ]]
[[ -s "$target_release/docker-compose.yml" && ! -L "$target_release/docker-compose.yml" ]]
[[ -s "$target_release/nginx.conf" && ! -L "$target_release/nginx.conf" ]]
(
  cd "$target"
  sha256sum -c ../SHA256SUMS >/dev/null
)

exec 9>"$base_dir/.deploy.lock"
flock -n 9 || { echo "outro deploy Wolfie está em andamento" >&2; exit 1; }

[[ -L "$base_dir/current" ]]
old_target="$(readlink -f "$base_dir/current")"
[[ "$old_target" == "$base_dir"/releases/*/dist ]]
[[ -d "$old_target" && ! -L "$old_target" ]]
old_release="$(dirname -- "$old_target")"
[[ -s "$old_release/docker-compose.yml" && -s "$old_release/nginx.conf" ]]

env_file="$base_dir/.env"
[[ -f "$env_file" && ! -L "$env_file" ]]
router_enabled="$(awk -F= '$1 == "WOLFIE_TRAEFIK_ENABLE" { print $2; exit }' "$env_file")"
[[ "$router_enabled" = "true" || "$router_enabled" = "false" ]]

suffix=".$release_id.$$"
compose_next="$base_dir/docker-compose.yml.next$suffix"
nginx_next="$base_dir/nginx.conf.next$suffix"
current_next="$base_dir/current.next$suffix"
active_next="$base_dir/ACTIVE_RELEASE.next$suffix"
previous_next="$base_dir/previous.next$suffix"
for temp_path in "$compose_next" "$nginx_next" "$current_next" \
  "$active_next" "$previous_next"; do
  [[ ! -e "$temp_path" && ! -L "$temp_path" ]]
done

restore_old() {
  local exit_code=$?
  trap - ERR INT TERM
  set +e
  rm -f -- "$compose_next" "$nginx_next" "$current_next" \
    "$active_next" "$previous_next"
  cp -- "$old_release/docker-compose.yml" "$compose_next"
  cp -- "$old_release/nginx.conf" "$nginx_next"
  mv -Tf -- "$compose_next" "$base_dir/docker-compose.yml"
  mv -Tf -- "$nginx_next" "$base_dir/nginx.conf"
  ln -s -- "$old_target" "$current_next"
  mv -Tf -- "$current_next" "$base_dir/current"
  (cd "$base_dir" && docker compose up -d --force-recreate wolfie-frontend)
  exit "$exit_code"
}
trap restore_old ERR INT TERM

cp -- "$target_release/docker-compose.yml" "$compose_next"
cp -- "$target_release/nginx.conf" "$nginx_next"
ln -s -- "releases/$release_id/dist" "$current_next"
mv -Tf -- "$compose_next" "$base_dir/docker-compose.yml"
mv -Tf -- "$nginx_next" "$base_dir/nginx.conf"
mv -Tf -- "$current_next" "$base_dir/current"

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
[[ "$(docker exec wolfie-frontend wget -q -O - http://127.0.0.1/.well-known/wolfie-release)" = "$release_id" ]]
docker exec wolfie-frontend wget -q -O /dev/null http://127.0.0.1/
docker exec wolfie-frontend wget -q -O /dev/null http://127.0.0.1/quiz
docker exec wolfie-frontend wget -q -O /dev/null http://127.0.0.1/app

if [[ "$router_enabled" = "true" ]]; then
  public_ready=false
  for attempt in $(seq 1 60); do
    marker="$(curl --fail --silent --show-error \
      --connect-timeout 5 --max-time 15 \
      -H 'Cache-Control: no-cache' \
      "$public_url/.well-known/wolfie-release?release=$release_id" 2>/dev/null || true)"
    if [[ "$marker" = "$release_id" ]] &&
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
fi

ln -s -- "$old_target" "$previous_next"
mv -Tf -- "$previous_next" "$base_dir/previous"
printf '%s\n' "$release_id" > "$active_next"
chmod 0600 "$active_next"
mv -Tf -- "$active_next" "$base_dir/ACTIVE_RELEASE"
trap - ERR INT TERM
REMOTE

echo "Rollback Wolfie concluído para: $release_id"
