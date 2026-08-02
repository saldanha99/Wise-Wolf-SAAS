#!/usr/bin/env bash
# Release only the standalone Wolfie frontend. Database migrations, Edge
# Functions and the WiseCore frontend are deliberately outside this script.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"
WOLFIE_ENV_FILE="${WOLFIE_ENV_FILE:-$PROJECT_DIR/.env.deploy.wolfie.local}"
INTAKE_MIGRATION_VERSION="20260802174535"
INTAKE_MIGRATION_FILE="20260802174535_harden_crm_leads_public_intake_authorization.sql"
INTAKE_MIGRATION_PATH="$PROJECT_DIR/supabase/migrations/$INTAKE_MIGRATION_FILE"
LOCAL_STAGE=""
SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
)
RSYNC_RSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"

die() {
  echo "ERRO: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "comando obrigatório ausente: $1"
}

validate_remote_path() {
  local remote_path=$1
  [[ "$remote_path" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ &&
    "$remote_path" != *".."* &&
    "$remote_path" != *"//"* ]]
}

validate_https_url() {
  local url=$1
  [[ "$url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?$ ]]
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY
  if [[ -n "$LOCAL_STAGE" && -d "$LOCAL_STAGE" && ! -L "$LOCAL_STAGE" &&
    "$LOCAL_STAGE" == "${TMPDIR:-/tmp}"/wolfie-frontend-release.* ]]; then
    rm -rf -- "$LOCAL_STAGE"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

for command_name in git npm npx node ssh rsync curl shasum find mktemp; do
  require_command "$command_name"
done

[[ -s "$DEPLOY_ENV_FILE" ]] || die "arquivo de deploy ausente: $DEPLOY_ENV_FILE"
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
: "${DEPLOY_USER:?DEPLOY_USER ausente}"
: "${DEPLOY_APP_DIR:?DEPLOY_APP_DIR ausente}"
: "${DEPLOY_RELEASES_DIR:?DEPLOY_RELEASES_DIR ausente}"
: "${DEPLOY_API_URL:?DEPLOY_API_URL ausente}"

DEPLOY_WOLFIE_APP_DIR="${DEPLOY_WOLFIE_APP_DIR:-/opt/wisewolf/wolfie-frontend}"
DEPLOY_WOLFIE_PUBLIC_URL="${DEPLOY_WOLFIE_PUBLIC_URL:-https://wolfie.wisewolflanguage.com.br}"
DEPLOY_WOLFIE_HOSTNAME="${DEPLOY_WOLFIE_HOSTNAME:-wolfie.wisewolflanguage.com.br}"

[[ "$DEPLOY_HOST" = "187.127.46.251" ]] || die "VPS de destino inesperada"
[[ "$DEPLOY_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  die "DEPLOY_SSH_HOST inválido"
[[ "$DEPLOY_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "DEPLOY_USER inválido"
validate_remote_path "$DEPLOY_APP_DIR" || die "DEPLOY_APP_DIR fora de /opt/wisewolf"
validate_remote_path "$DEPLOY_RELEASES_DIR" ||
  die "DEPLOY_RELEASES_DIR fora de /opt/wisewolf"
validate_remote_path "$DEPLOY_WOLFIE_APP_DIR" || die "diretório Wolfie fora de /opt/wisewolf"
[[ "$DEPLOY_WOLFIE_APP_DIR" = "/opt/wisewolf/wolfie-frontend" ]] ||
  die "diretório Wolfie inesperado: $DEPLOY_WOLFIE_APP_DIR"
validate_https_url "$DEPLOY_API_URL" || die "DEPLOY_API_URL inválida"
validate_https_url "$DEPLOY_WOLFIE_PUBLIC_URL" || die "URL pública Wolfie inválida"
[[ "$DEPLOY_WOLFIE_HOSTNAME" = "wolfie.wisewolflanguage.com.br" ]] ||
  die "hostname Wolfie inesperado"
[[ "$DEPLOY_WOLFIE_PUBLIC_URL" = "https://$DEPLOY_WOLFIE_HOSTNAME" ]] ||
  die "URL pública e hostname Wolfie divergem"

[[ -f "$INTAKE_MIGRATION_PATH" && -s "$INTAKE_MIGRATION_PATH" &&
  ! -L "$INTAKE_MIGRATION_PATH" ]] ||
  die "migration obrigatória do intake ausente ou insegura"
intake_migration_checksum="$(shasum -a 256 "$INTAKE_MIGRATION_PATH" | awk '{print $1}')"
[[ "$intake_migration_checksum" =~ ^[a-f0-9]{64}$ ]] ||
  die "checksum da migration do intake inválido"

echo "== Preflight fail-closed do hardening de intake =="
ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_HOST" "$DEPLOY_USER" "$DEPLOY_RELEASES_DIR" \
  "$INTAKE_MIGRATION_VERSION" "$intake_migration_checksum" <<'REMOTE'
set -Eeuo pipefail
expected_host=$1
expected_user=$2
releases_dir=$3
migration_version=$4
migration_checksum=$5
[[ "$expected_host" = "187.127.46.251" ]]
[[ "$(id -un)" = "$expected_user" ]]
[[ "$releases_dir" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ &&
  "$releases_dir" != *".."* && "$releases_dir" != *"//"* ]]
[[ "$migration_version" = "20260802174535" ]]
[[ "$migration_checksum" =~ ^[a-f0-9]{64}$ ]]
case " $(hostname -I) " in
  *" $expected_host "*) ;;
  *) echo "IP público não pertence ao host remoto" >&2; exit 1 ;;
esac
[[ -d /opt/wisewolf && ! -L /opt/wisewolf &&
  "$(readlink -f /opt/wisewolf)" = "/opt/wisewolf" ]]
[[ -d "$releases_dir" && ! -L "$releases_dir" &&
  "$(readlink -f "$releases_dir")" = "$releases_dir" ]]
marker_dir="$releases_dir/.migration-checksums"
[[ -d "$marker_dir" && ! -L "$marker_dir" &&
  "$(readlink -f "$marker_dir")" = "$marker_dir" ]]
if find "$marker_dir" -maxdepth 1 -type l \
  -name "${migration_version}-*.sha256" -print -quit | grep -q .; then
  echo "marker do intake não pode ser link simbólico" >&2
  exit 1
fi
mapfile -t version_markers < <(
  find "$marker_dir" -maxdepth 1 -type f \
    -name "${migration_version}-*.sha256" -print | LC_ALL=C sort
)
[[ ${#version_markers[@]} = 1 ]]
expected_marker="$marker_dir/${migration_version}-${migration_checksum}.sha256"
[[ "${version_markers[0]}" = "$expected_marker" &&
  -f "$expected_marker" && ! -L "$expected_marker" ]]
[[ "$(tr -d '\r\n' < "$expected_marker")" = "$migration_checksum" ]]
docker inspect supabase-db --format '{{.State.Running}}' | grep -qx true
docker exec -i supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 <<'SQL'
do $preflight$
declare
  actual_policies text[];
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.crm_leads'::pg_catalog.regclass
      and attname = 'public_intake_idempotency_key'
      and atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
      and not attisdropped
  ) then
    raise exception 'crm_leads intake idempotency column missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.crm_leads'::pg_catalog.regclass
      and conname = 'crm_leads_public_intake_idempotency_uniq'
      and contype = 'u'
      and pg_catalog.pg_get_constraintdef(oid, true) =
        'UNIQUE (tenant_id, public_intake_idempotency_key)'
  ) then
    raise exception 'crm_leads intake idempotency constraint missing';
  end if;

  select pg_catalog.array_agg(policyname::text order by policyname::text)
  into actual_policies
  from pg_catalog.pg_policies
  where schemaname = 'public' and tablename = 'crm_leads';

  if actual_policies is distinct from array[
    'crm_leads_public_insert',
    'crm_leads_service_role',
    'crm_leads_tenant_staff'
  ]::text[] then
    raise exception 'unexpected crm_leads policies: %', actual_policies;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class
    where oid = 'public.crm_leads'::pg_catalog.regclass and relrowsecurity
  ) then
    raise exception 'crm_leads RLS is disabled';
  end if;
end;
$preflight$;
SQL
REMOTE

read_remote_public_env() {
  local key=$1
  [[ "$key" =~ ^VITE_[A-Z0-9_]+$ ]] || die "chave pública remota inválida"
  ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
    "$DEPLOY_APP_DIR/.env.production" "$key" <<'REMOTE'
set -Eeuo pipefail
env_file=$1
env_key=$2
[[ -r "$env_file" && ! -L "$env_file" ]]
value="$(awk -v key="$env_key" '
  index($0, key "=") == 1 {
    sub(/^[^=]*=/, "")
    print
    exit
  }
' "$env_file")"
value="${value%$'\r'}"
if [[ "$value" == \"*\" && "$value" == *\" ]]; then
  value="${value:1:${#value}-2}"
fi
[[ -n "$value" ]]
printf '%s' "$value"
REMOTE
}

export VITE_SUPABASE_URL
export VITE_SUPABASE_ANON_KEY
VITE_SUPABASE_URL="$(read_remote_public_env VITE_SUPABASE_URL)"
VITE_SUPABASE_ANON_KEY="$(read_remote_public_env VITE_SUPABASE_ANON_KEY)"
[[ "$VITE_SUPABASE_URL" = "$DEPLOY_API_URL" ]] ||
  die "o Wolfie deve usar exatamente a API própria da VPS"
[[ "$VITE_SUPABASE_ANON_KEY" =~ ^[A-Za-z0-9._-]{20,}$ ]] ||
  die "chave pública Supabase ausente ou truncada"

cd "$PROJECT_DIR"
echo "== Validação local do Wolfie standalone =="
npm run typecheck:wolfie-web
npx --no-install vitest run apps/wolfie-web/src
npm run build:wolfie-web
node scripts/verify-wolfie-visual-assets.mjs --root dist-wolfie
find dist-wolfie -type d -exec chmod 0755 {} +
find dist-wolfie -type f -exec chmod 0644 {} +
if find dist-wolfie -type l -print -quit | grep -q .; then
  die "o artefato contém link simbólico"
fi
[[ -s dist-wolfie/index.html && -s dist-wolfie/manifest.webmanifest &&
  -s dist-wolfie/sw.js && -s dist-wolfie/registerSW.js ]] ||
  die "artefato PWA incompleto"

artifact_hash="$({
  find dist-wolfie -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(shasum -a 256 "$file" | awk '{print $1}')" "$file"
  done
} | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
[[ "$artifact_hash" =~ ^[a-f0-9]{12}$ ]] || die "hash do artefato inválido"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${artifact_hash}"
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] ||
  die "identificador da release inválido"

mkdir -p -- dist-wolfie/.well-known
[[ -d dist-wolfie/.well-known && ! -L dist-wolfie/.well-known ]]
chmod 0755 dist-wolfie/.well-known
marker_temp="dist-wolfie/.well-known/wolfie-release.tmp.$$"
[[ ! -e "$marker_temp" && ! -L "$marker_temp" ]]
printf '%s\n' "$release_id" > "$marker_temp"
chmod 0644 "$marker_temp"
mv -f -- "$marker_temp" dist-wolfie/.well-known/wolfie-release

LOCAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/wolfie-frontend-release.XXXXXX")"
[[ -d "$LOCAL_STAGE" && ! -L "$LOCAL_STAGE" ]]
checksum_file="$LOCAL_STAGE/SHA256SUMS"
(
  cd dist-wolfie
  find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done
) > "$checksum_file"
[[ -s "$checksum_file" && ! -L "$checksum_file" ]]

remote_release="$DEPLOY_WOLFIE_APP_DIR/releases/$release_id"
validate_remote_path "$remote_release" || die "caminho remoto da release inválido"

echo "== Preflight e preparação remota: $release_id =="
ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_HOST" "$DEPLOY_WOLFIE_APP_DIR" "$remote_release" <<'REMOTE'
set -Eeuo pipefail
expected_host=$1
base_dir=$2
release_dir=$3
[[ "$expected_host" = "187.127.46.251" ]]
case " $(hostname -I) " in
  *" $expected_host "*) ;;
  *) echo "IP público não pertence ao host remoto" >&2; exit 1 ;;
esac
[[ "$base_dir" = "/opt/wisewolf/wolfie-frontend" ]]
[[ "$release_dir" == "$base_dir"/releases/* ]]
[[ "$release_dir" != *".."* && "$release_dir" != *"//"* ]]
[[ -d /opt/wisewolf && ! -L /opt/wisewolf ]]
[[ "$(readlink -f /opt/wisewolf)" = "/opt/wisewolf" ]]
if [[ -e "$base_dir" || -L "$base_dir" ]]; then
  [[ -d "$base_dir" && ! -L "$base_dir" ]]
else
  mkdir -- "$base_dir"
fi
[[ "$(readlink -f "$base_dir")" = "$base_dir" ]]
if [[ -e "$base_dir/releases" || -L "$base_dir/releases" ]]; then
  [[ -d "$base_dir/releases" && ! -L "$base_dir/releases" ]]
else
  mkdir -- "$base_dir/releases"
fi
[[ "$(readlink -f "$base_dir/releases")" = "$base_dir/releases" ]]
[[ ! -e "$release_dir" && ! -L "$release_dir" ]]
mkdir -- "$release_dir"
mkdir -- "$release_dir/dist"
[[ "$(readlink -f "$release_dir")" = "$release_dir" ]]
[[ "$(readlink -f "$release_dir/dist")" = "$release_dir/dist" ]]
for command_name in docker sha256sum readlink flock curl; do
  command -v "$command_name" >/dev/null
done
docker network inspect wisewolf >/dev/null
REMOTE

rsync -e "$RSYNC_RSH" -a --delete -- \
  dist-wolfie/ "$DEPLOY_SSH_HOST:$remote_release/dist/"
rsync -e "$RSYNC_RSH" -a -- \
  "$checksum_file" "$DEPLOY_SSH_HOST:$remote_release/SHA256SUMS"
rsync -e "$RSYNC_RSH" -a -- \
  deploy/vps/wolfie-frontend/docker-compose.yml \
  "$DEPLOY_SSH_HOST:$remote_release/docker-compose.yml"
rsync -e "$RSYNC_RSH" -a -- \
  deploy/vps/wolfie-frontend/nginx.conf \
  "$DEPLOY_SSH_HOST:$remote_release/nginx.conf"

echo "== Validação remota do artefato e das configurações =="
ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_WOLFIE_APP_DIR" "$release_id" <<'REMOTE'
set -Eeuo pipefail
base_dir=$1
release_id=$2
[[ "$base_dir" = "/opt/wisewolf/wolfie-frontend" ]]
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
release_dir="$base_dir/releases/$release_id"
[[ "$(readlink -f "$release_dir")" = "$release_dir" ]]
[[ "$(readlink -f "$release_dir/dist")" = "$release_dir/dist" ]]
if find "$release_dir" -type l -print -quit | grep -q .; then
  echo "release remota contém link simbólico" >&2
  exit 1
fi
[[ -s "$release_dir/SHA256SUMS" && -s "$release_dir/dist/index.html" ]]
(
  cd "$release_dir/dist"
  sha256sum -c ../SHA256SUMS >/dev/null
)
[[ "$(cat "$release_dir/dist/.well-known/wolfie-release")" = "$release_id" ]]
WOLFIE_TRAEFIK_ENABLE=false docker compose \
  --project-directory "$base_dir" \
  -f "$release_dir/docker-compose.yml" config --quiet
docker run --rm \
  -v "$release_dir/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx@sha256:54f2a904c251d5a34adf545a72d32515a15e08418dae0266e23be2e18c66fefa \
  nginx -t >/dev/null
REMOTE

echo "== Ativação atômica do frontend Wolfie =="
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
release_dir="$base_dir/releases/$release_id"
[[ "$(readlink -f "$release_dir")" = "$release_dir" ]]
[[ -d "$release_dir/dist" && ! -L "$release_dir/dist" ]]
[[ -s "$release_dir/docker-compose.yml" && ! -L "$release_dir/docker-compose.yml" ]]
[[ -s "$release_dir/nginx.conf" && ! -L "$release_dir/nginx.conf" ]]

exec 9>"$base_dir/.deploy.lock"
flock -n 9 || { echo "outro deploy Wolfie está em andamento" >&2; exit 1; }

env_file="$base_dir/.env"
if [[ -e "$env_file" || -L "$env_file" ]]; then
  [[ -f "$env_file" && ! -L "$env_file" ]]
  router_enabled="$(awk -F= '$1 == "WOLFIE_TRAEFIK_ENABLE" { print $2; exit }' "$env_file")"
  [[ "$router_enabled" = "true" || "$router_enabled" = "false" ]]
else
  env_next="$base_dir/.env.next.$$"
  [[ ! -e "$env_next" && ! -L "$env_next" ]]
  printf 'WOLFIE_TRAEFIK_ENABLE=false\n' > "$env_next"
  chmod 0600 "$env_next"
  mv -T -- "$env_next" "$env_file"
  router_enabled=false
fi

previous_target=""
previous_release_dir=""
if [[ -L "$base_dir/current" ]]; then
  previous_target="$(readlink -f "$base_dir/current")"
  [[ "$previous_target" == "$base_dir"/releases/*/dist ]]
  [[ -d "$previous_target" && ! -L "$previous_target" ]]
  previous_release_dir="$(dirname -- "$previous_target")"
  [[ -s "$previous_release_dir/docker-compose.yml" ]]
  [[ -s "$previous_release_dir/nginx.conf" ]]
elif [[ -e "$base_dir/current" ]]; then
  echo "current existe e não é link simbólico" >&2
  exit 1
fi

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

recover_previous() {
  local exit_code=$?
  trap - ERR INT TERM
  set +e
  rm -f -- "$compose_next" "$nginx_next" "$current_next" \
    "$active_next" "$previous_next"
  if [[ -n "$previous_target" && -d "$previous_target" ]]; then
    cp -- "$previous_release_dir/docker-compose.yml" "$compose_next"
    cp -- "$previous_release_dir/nginx.conf" "$nginx_next"
    mv -Tf -- "$compose_next" "$base_dir/docker-compose.yml"
    mv -Tf -- "$nginx_next" "$base_dir/nginx.conf"
    ln -s -- "$previous_target" "$current_next"
    mv -Tf -- "$current_next" "$base_dir/current"
    (cd "$base_dir" && docker compose up -d --force-recreate wolfie-frontend)
  elif [[ -s "$base_dir/docker-compose.yml" ]]; then
    (cd "$base_dir" && docker compose stop wolfie-frontend)
  fi
  exit "$exit_code"
}
trap recover_previous ERR INT TERM

cp -- "$release_dir/docker-compose.yml" "$compose_next"
cp -- "$release_dir/nginx.conf" "$nginx_next"
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

if [[ -n "$previous_target" ]]; then
  ln -s -- "$previous_target" "$previous_next"
  mv -Tf -- "$previous_next" "$base_dir/previous"
fi
printf '%s\n' "$release_id" > "$active_next"
chmod 0600 "$active_next"
mv -Tf -- "$active_next" "$base_dir/ACTIVE_RELEASE"
trap - ERR INT TERM
printf 'release=%s router=%s\n' "$release_id" "$router_enabled"
REMOTE

echo "Release Wolfie preparada: $release_id"
echo "O estado público é controlado pelo cutover DNS seguro."
