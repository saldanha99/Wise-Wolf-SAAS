#!/usr/bin/env bash
# Build, validate and release Wise Wolf to its production VPS.
# Authentication is intentionally SSH-key-only; passwords and API keys are
# never read from this repository or printed by this script.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"
LOCAL_STAGE=""

cleanup() {
  local exit_code=$?
  trap - EXIT
  unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY
  if [[ -n "$LOCAL_STAGE" && -d "$LOCAL_STAGE" ]]; then
    rm -rf -- "$LOCAL_STAGE"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

die() {
  echo "ERRO: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    die "comando obrigatório ausente: $1"
}

for command_name in git npm npx ssh rsync curl shasum mktemp; do
  require_command "$command_name"
done

[[ -s "$DEPLOY_ENV_FILE" ]] ||
  die "crie $DEPLOY_ENV_FILE a partir de .env.deploy.example"

set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"
set +a

required_vars=(
  DEPLOY_SSH_HOST
  DEPLOY_HOST
  DEPLOY_USER
  DEPLOY_APP_DIR
  DEPLOY_COMPOSE_DIR
  DEPLOY_RELEASES_DIR
  DEPLOY_BACKUPS_DIR
  DEPLOY_FUNCTIONS_DIR
  DEPLOY_SUPABASE_DIR
  DEPLOY_PUBLIC_URL
  DEPLOY_API_URL
)
for required_var in "${required_vars[@]}"; do
  [[ -n "${!required_var:-}" ]] ||
    die "variável obrigatória ausente: $required_var"
done

[[ "$DEPLOY_SSH_HOST" =~ ^[A-Za-z0-9._-]+$ ]] ||
  die "DEPLOY_SSH_HOST inválido"
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9.:_-]+$ ]] ||
  die "DEPLOY_HOST inválido"
[[ "$DEPLOY_USER" =~ ^[A-Za-z0-9._-]+$ ]] ||
  die "DEPLOY_USER inválido"
for remote_path in \
  "$DEPLOY_APP_DIR" \
  "$DEPLOY_COMPOSE_DIR" \
  "$DEPLOY_RELEASES_DIR" \
  "$DEPLOY_BACKUPS_DIR" \
  "$DEPLOY_FUNCTIONS_DIR" \
  "$DEPLOY_SUPABASE_DIR"; do
  [[ "$remote_path" == /opt/wisewolf/* && "$remote_path" != *$'\n'* ]] ||
    die "caminho remoto fora de /opt/wisewolf: $remote_path"
done
[[ "$DEPLOY_PUBLIC_URL" =~ ^https://[^[:space:]]+$ ]] ||
  die "DEPLOY_PUBLIC_URL deve usar HTTPS"
[[ "$DEPLOY_API_URL" =~ ^https://[^[:space:]]+$ ]] ||
  die "DEPLOY_API_URL deve usar HTTPS"

cd "$PROJECT_DIR"

echo "== Preflight da VPS =="
ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_HOST" "$DEPLOY_USER" "$DEPLOY_APP_DIR" \
  "$DEPLOY_COMPOSE_DIR" "$DEPLOY_FUNCTIONS_DIR" "$DEPLOY_SUPABASE_DIR" <<'REMOTE'
set -Eeuo pipefail
expected_host=$1
expected_user=$2
app_dir=$3
compose_dir=$4
functions_dir=$5
supabase_dir=$6

[[ "$(id -un)" = "$expected_user" ]]
current_ip="$(hostname -I | awk '{print $1}')"
[[ "$current_ip" = "$expected_host" || "$expected_host" = "187.127.46.251" ]]
for required_dir in "$app_dir" "$compose_dir" "$functions_dir" "$supabase_dir"; do
  [[ -d "$required_dir" ]]
done
docker inspect supabase-db --format '{{.State.Running}}' | grep -qx true
docker inspect supabase-edge-functions --format '{{.State.Running}}' | grep -qx true
REMOTE

read_remote_public_env() {
  local key=$1
  ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- \
    "$DEPLOY_APP_DIR/.env.production" "$key" <<'REMOTE'
set -Eeuo pipefail
env_file=$1
env_key=$2
[[ -r "$env_file" ]]
value="$(
  awk -v key="$env_key" '
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$env_file"
)"
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
[[ "$VITE_SUPABASE_URL" =~ ^https://[^[:space:]]+$ ]] ||
  die "VITE_SUPABASE_URL remota inválida"
[[ ${#VITE_SUPABASE_ANON_KEY} -ge 20 ]] ||
  die "VITE_SUPABASE_ANON_KEY remota ausente ou truncada"

echo "== Validação local =="
npm run typecheck
npx --yes deno check --no-lock \
  supabase/functions/wolfie-activity/index.ts \
  supabase/functions/student-context/index.ts \
  supabase/functions/submit-quiz/index.ts
npm run build

MIGRATION_RELATIVES=(
  "supabase/migrations/20260725022832_wolfie_immersive_ecosystem.sql"
  "supabase/migrations/20260725030016_verified_legacy_xp_awards.sql"
)
FUNCTION_RELATIVE="supabase/functions/wolfie-activity"
PEDAGOGICAL_FUNCTION_RELATIVE="supabase/functions/submit-quiz"
CONTEXT_FUNCTION_RELATIVE="supabase/functions/student-context"
SHARED_AUTH_RELATIVE="supabase/functions/_shared/request-auth.ts"
for migration_relative in "${MIGRATION_RELATIVES[@]}"; do
  [[ -s "$migration_relative" ]] ||
    die "migration ausente: $migration_relative"
done
[[ -s "$FUNCTION_RELATIVE/index.ts" ]] || die "função Wolfie ausente"
[[ -s "$PEDAGOGICAL_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de avaliação pedagógica ausente"
[[ -s "$CONTEXT_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de contexto do aluno ausente"
[[ -s "$SHARED_AUTH_RELATIVE" ]] || die "guard de autenticação ausente"

git_sha="$(git rev-parse --short=12 HEAD)"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${git_sha}"
for migration_relative in "${MIGRATION_RELATIVES[@]}"; do
  migration_file="$(basename -- "$migration_relative")"
  migration_version="${migration_file%%_*}"
  migration_checksum="$(shasum -a 256 "$migration_relative" | awk '{print $1}')"
  [[ "$migration_version" =~ ^[0-9]{14}$ ]] ||
    die "versão de migration inválida: $migration_file"
  [[ "$migration_checksum" =~ ^[a-f0-9]{64}$ ]] ||
    die "checksum de migration inválido: $migration_file"
done

LOCAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/wisewolf-release.XXXXXX")"
remote_release="$DEPLOY_RELEASES_DIR/$release_id"

echo "== Preparação da release $release_id =="
ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- "$remote_release" <<'REMOTE'
set -Eeuo pipefail
release_dir=$1
[[ "$release_dir" == /opt/wisewolf/releases/* ]]
mkdir -p -- \
  "$release_dir/frontend-dist" \
  "$release_dir/functions/wolfie-activity" \
  "$release_dir/functions/submit-quiz" \
  "$release_dir/functions/student-context" \
  "$release_dir/functions/_shared" \
  "$release_dir/migrations"
REMOTE

rsync -a --delete -- dist/ \
  "$DEPLOY_SSH_HOST:$remote_release/frontend-dist/"
rsync -a --delete -- "$FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/wolfie-activity/"
rsync -a --delete -- "$PEDAGOGICAL_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/submit-quiz/"
rsync -a --delete -- "$CONTEXT_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/student-context/"
rsync -a -- "$SHARED_AUTH_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/request-auth.ts"
for migration_relative in "${MIGRATION_RELATIVES[@]}"; do
  migration_file="$(basename -- "$migration_relative")"
  rsync -a -- "$migration_relative" \
    "$DEPLOY_SSH_HOST:$remote_release/migrations/$migration_file"
done

echo "== Ativação transacional e smoke tests =="
ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- \
  "$release_id" \
  "$remote_release" \
  "$DEPLOY_APP_DIR" \
  "$DEPLOY_COMPOSE_DIR" \
  "$DEPLOY_RELEASES_DIR" \
  "$DEPLOY_BACKUPS_DIR" \
  "$DEPLOY_FUNCTIONS_DIR" \
  "$DEPLOY_SUPABASE_DIR" \
  "$DEPLOY_PUBLIC_URL" \
  "$DEPLOY_API_URL" <<'REMOTE'
set -Eeuo pipefail
umask 077

release_id=$1
release_dir=$2
app_dir=$3
compose_dir=$4
releases_dir=$5
backups_dir=$6
functions_dir=$7
supabase_dir=$8
public_url=$9
api_url=${10}

for remote_path in \
  "$release_dir" "$app_dir" "$compose_dir" "$releases_dir" \
  "$backups_dir" "$functions_dir" "$supabase_dir"; do
  [[ "$remote_path" == /opt/wisewolf/* ]]
done
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]

exec 9>"$releases_dir/.deploy.lock"
flock -n 9 || {
  echo "ERRO: já existe outro deploy em andamento." >&2
  exit 1
}

backup_dir="$backups_dir/release-$release_id"
marker_dir="$releases_dir/.migration-checksums"
frontend_swapped=0
function_swapped=0
pedagogical_function_swapped=0
context_function_swapped=0
shared_swapped=0

restore_previous_release() {
  local exit_code=$?
  trap - ERR
  set +e
  echo "ERRO: release falhou; restaurando frontend e função anteriores." >&2

  if [[ "$frontend_swapped" = "1" ]]; then
    if [[ -d "$app_dir/dist" ]]; then
      mv -- "$app_dir/dist" "$backup_dir/failed-frontend-dist"
    fi
    if [[ -d "$backup_dir/frontend-dist" ]]; then
      mv -- "$backup_dir/frontend-dist" "$app_dir/dist"
    fi
  fi
  if [[ "$function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/wolfie-activity" ]]; then
      mv -- "$functions_dir/wolfie-activity" \
        "$backup_dir/failed-wolfie-activity"
    fi
    if [[ -d "$backup_dir/wolfie-activity" ]]; then
      mv -- "$backup_dir/wolfie-activity" "$functions_dir/wolfie-activity"
    fi
  fi
  if [[ "$pedagogical_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/submit-quiz" ]]; then
      mv -- "$functions_dir/submit-quiz" \
        "$backup_dir/failed-submit-quiz"
    fi
    if [[ -d "$backup_dir/submit-quiz" ]]; then
      mv -- "$backup_dir/submit-quiz" "$functions_dir/submit-quiz"
    fi
  fi
  if [[ "$context_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/student-context" ]]; then
      mv -- "$functions_dir/student-context" \
        "$backup_dir/failed-student-context"
    fi
    if [[ -d "$backup_dir/student-context" ]]; then
      mv -- "$backup_dir/student-context" "$functions_dir/student-context"
    fi
  fi
  if [[ "$shared_swapped" = "1" && -f "$backup_dir/request-auth.ts" ]]; then
    cp -a -- "$backup_dir/request-auth.ts" \
      "$functions_dir/_shared/request-auth.ts"
  fi

  (
    cd "$compose_dir" &&
      docker compose up -d --force-recreate frontend
  ) >/dev/null 2>&1 || true
  (
    cd "$supabase_dir" &&
      docker compose restart functions
  ) >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap restore_previous_release ERR

mkdir -p -- "$backup_dir" "$marker_dir"
[[ -d "$release_dir/frontend-dist" ]]
[[ -s "$release_dir/functions/wolfie-activity/index.ts" ]]
[[ -s "$release_dir/functions/submit-quiz/index.ts" ]]
[[ -s "$release_dir/functions/student-context/index.ts" ]]
[[ -s "$release_dir/functions/_shared/request-auth.ts" ]]

shopt -s nullglob
migration_files=("$release_dir"/migrations/*.sql)
shopt -u nullglob
[[ ${#migration_files[@]} -ge 1 ]]
unapplied_migrations=()
unapplied_markers=()
unapplied_checksums=()
for migration_path in "${migration_files[@]}"; do
  migration_file="$(basename -- "$migration_path")"
  [[ "$migration_file" =~ ^([0-9]{14})_[A-Za-z0-9_]+\.sql$ ]]
  migration_version="${BASH_REMATCH[1]}"
  migration_checksum="$(sha256sum "$migration_path" | awk '{print $1}')"
  [[ "$migration_checksum" =~ ^[a-f0-9]{64}$ ]]
  existing_marker="$(
    find "$marker_dir" -maxdepth 1 -type f \
      -name "${migration_version}-*.sha256" -print -quit
  )"
  expected_marker="$marker_dir/${migration_version}-${migration_checksum}.sha256"
  if [[ -n "$existing_marker" && "$existing_marker" != "$expected_marker" ]]; then
    echo "ERRO: a migration $migration_version já foi aplicada com outro checksum; crie uma nova migration." >&2
    exit 1
  fi
  if [[ ! -f "$expected_marker" ]]; then
    unapplied_migrations+=("$migration_path")
    unapplied_markers+=("$expected_marker")
    unapplied_checksums+=("$migration_checksum")
  fi
done

if ((${#unapplied_migrations[@]} > 0)); then
  for migration_path in "${unapplied_migrations[@]}"; do
    sed -n '1,$p' "$migration_path"
    printf '\n'
  done | docker exec -i supabase-db \
    psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -1
  for marker_index in "${!unapplied_markers[@]}"; do
    printf '%s\n' "${unapplied_checksums[$marker_index]}" \
      > "${unapplied_markers[$marker_index]}"
  done
fi

if [[ -d "$app_dir/dist" ]]; then
  mv -- "$app_dir/dist" "$backup_dir/frontend-dist"
fi
frontend_swapped=1
cp -a -- "$release_dir/frontend-dist" "$app_dir/dist"

if [[ -d "$functions_dir/wolfie-activity" ]]; then
  mv -- "$functions_dir/wolfie-activity" "$backup_dir/wolfie-activity"
fi
function_swapped=1
cp -a -- "$release_dir/functions/wolfie-activity" \
  "$functions_dir/wolfie-activity"

if [[ -d "$functions_dir/submit-quiz" ]]; then
  mv -- "$functions_dir/submit-quiz" "$backup_dir/submit-quiz"
fi
pedagogical_function_swapped=1
cp -a -- "$release_dir/functions/submit-quiz" \
  "$functions_dir/submit-quiz"

if [[ -d "$functions_dir/student-context" ]]; then
  mv -- "$functions_dir/student-context" "$backup_dir/student-context"
fi
context_function_swapped=1
cp -a -- "$release_dir/functions/student-context" \
  "$functions_dir/student-context"

if [[ -f "$functions_dir/_shared/request-auth.ts" ]]; then
  cp -a -- "$functions_dir/_shared/request-auth.ts" \
    "$backup_dir/request-auth.ts"
  shared_swapped=1
fi
cp -a -- "$release_dir/functions/_shared/request-auth.ts" \
  "$functions_dir/_shared/request-auth.ts"

(
  cd "$supabase_dir"
  docker compose restart functions
)
(
  cd "$compose_dir"
  docker compose up -d --force-recreate frontend
)

curl -fsS --max-time 30 "$public_url/" >/dev/null
options_status="$(
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X OPTIONS "$api_url/functions/v1/wolfie-activity"
)"
[[ "$options_status" = "200" ]]
unauthenticated_status="$(
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST "$api_url/functions/v1/wolfie-activity" \
    -H 'Content-Type: application/json' \
    --data '{"action":"overview"}'
)"
[[ "$unauthenticated_status" = "401" ]]
quiz_options_status="$(
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X OPTIONS "$api_url/functions/v1/submit-quiz"
)"
[[ "$quiz_options_status" = "200" ]]
quiz_unauthenticated_status="$(
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST "$api_url/functions/v1/submit-quiz" \
    -H 'Content-Type: application/json' \
    --data '{"bookPart":"A1-1","answers":[]}'
)"
[[ "$quiz_unauthenticated_status" = "401" ]]
context_unauthenticated_status="$(
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST "$api_url/functions/v1/student-context" \
    -H 'Content-Type: application/json' \
    --data '{}'
)"
[[ "$context_unauthenticated_status" = "401" ]]

printf '%s\n' "$release_id" > "$releases_dir/current"
trap - ERR
echo "Release ativa: $release_id"
echo "Backup reversível: $backup_dir"
REMOTE

echo "Deploy concluído: $release_id"
