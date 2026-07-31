#!/usr/bin/env bash
# Release isolada do Wolfie Tutor para a VPS de produção.
# Publica frontend, quatro funções Wolfie, autenticação compartilhada e a
# migration factual.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"

cleanup() {
  local exit_code=$?
  trap - EXIT
  unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY
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

for command_name in \
  git npm npx node ssh rsync curl shasum find; do
  require_command "$command_name"
done

[[ -s "$DEPLOY_ENV_FILE" ]] ||
  die "arquivo de configuração ausente: $DEPLOY_ENV_FILE"

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
[[ "$DEPLOY_API_URL" != *".supabase.co"* ]] ||
  die "DEPLOY_API_URL não pode apontar para o Supabase hospedado"

cd "$PROJECT_DIR"
[[ -z "$(git status --porcelain)" ]] ||
  die "a release Wolfie exige checkout Git limpo"

echo "== Preflight isolado da VPS =="
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
[[ -s "$functions_dir/_shared/request-auth.ts" ]]
docker inspect supabase-db --format '{{.State.Running}}' | grep -qx true
docker inspect supabase-edge-functions --format '{{.State.Running}}' | grep -qx true
docker exec supabase-edge-functions sh -lc \
  'test -n "${OPENAI_API_KEY:-}" && test -n "${OPENROUTER_API_KEY:-}"'
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  supabase-edge-functions |
  grep -Eq '^SUPABASE_URL=http://(kong|api-gw):8000$'
docker exec -i supabase-db \
  psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
do $preflight$
declare
  available_version text;
begin
  select default_version
    into available_version
    from pg_available_extensions
   where name = 'vector';

  if available_version is null
    or string_to_array(available_version, '.')::integer[] <
      array[0, 7]::integer[]
  then
    raise exception 'pgvector_0_7_or_newer_is_required';
  end if;
end
$preflight$;
SQL
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
export VITE_WOLFIE_REALTIME_ENABLED=true
VITE_SUPABASE_URL="$(read_remote_public_env VITE_SUPABASE_URL)"
VITE_SUPABASE_ANON_KEY="$(read_remote_public_env VITE_SUPABASE_ANON_KEY)"
[[ "$VITE_SUPABASE_URL" = "$DEPLOY_API_URL" ]] ||
  die "o frontend deve usar exatamente a API da VPS"
[[ ${#VITE_SUPABASE_ANON_KEY} -ge 20 ]] ||
  die "VITE_SUPABASE_ANON_KEY remota ausente ou truncada"

echo "== Validação do artefato Wolfie =="
npm ci
npm run typecheck
npx --yes deno test --no-lock \
  supabase/functions/_shared/request-auth.test.ts \
  supabase/functions/wolfie-activity/personalization.test.ts \
  supabase/functions/wolfie-brain/adaptive-language-policy.test.ts \
  supabase/functions/wolfie-brain/audio-input.test.ts \
  supabase/functions/wolfie-brain/factual-integrity.test.ts \
  supabase/functions/wolfie-brain/turn-policy.test.ts \
  supabase/functions/wolfie-realtime-session/protocol.test.ts \
  scripts/tests/wolfie-voice-safety.test.ts
npx --yes deno check --no-lock \
  supabase/functions/wolfie-activity/index.ts \
  supabase/functions/wolfie-brain/index.ts \
  supabase/functions/wolfie-realtime-session/index.ts \
  supabase/functions/wolfie-tts/index.ts
node scripts/provision-wolfie-rag.mjs --validate-only
npm run build
find dist -type d -exec chmod 0755 {} +
find dist -type f -exec chmod 0644 {} +

MIGRATIONS=(
  "supabase/migrations/20260730193415_wolfie_factual_memory_and_rag.sql"
  "supabase/migrations/20260731023000_harden_tenant_membership_roles.sql"
)
DATABASE_TESTS=(
  "supabase/tests/wolfie_factual_memory_and_rag.sql"
  "supabase/tests/tenant_membership_role_hardening.sql"
)
FUNCTIONS=(
  wolfie-activity
  wolfie-brain
  wolfie-realtime-session
  wolfie-tts
)
SHARED_FUNCTION_FILES=(
  request-auth.ts
)

for migration_path in "${MIGRATIONS[@]}"; do
  [[ -s "$migration_path" ]] || die "migration ausente: $migration_path"
  migration_file="$(basename -- "$migration_path")"
  migration_checksum="$(
    shasum -a 256 "$migration_path" | awk '{print $1}'
  )"
  [[ "$migration_file" =~ ^[0-9]{14}_[A-Za-z0-9_]+\.sql$ ]] ||
    die "nome de migration inválido: $migration_file"
  [[ "$migration_checksum" =~ ^[a-f0-9]{64}$ ]] ||
    die "checksum de migration inválido: $migration_file"
done
for database_test in "${DATABASE_TESTS[@]}"; do
  [[ -s "$database_test" ]] || die "teste SQL ausente: $database_test"
done
for function_name in "${FUNCTIONS[@]}"; do
  [[ -s "supabase/functions/$function_name/index.ts" ]] ||
    die "função ausente: $function_name"
done
for shared_file in "${SHARED_FUNCTION_FILES[@]}"; do
  [[ -s "supabase/functions/_shared/$shared_file" ]] ||
    die "dependência compartilhada ausente: $shared_file"
done

git_sha="$(git rev-parse --short=12 HEAD)"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${git_sha}"
remote_release="$DEPLOY_RELEASES_DIR/$release_id"

echo "== Preparação da release Wolfie $release_id =="
ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- "$remote_release" <<'REMOTE'
set -Eeuo pipefail
release_dir=$1
[[ "$release_dir" == /opt/wisewolf/releases/* ]]
mkdir -p -- \
  "$release_dir/frontend-dist" \
  "$release_dir/functions/wolfie-activity" \
  "$release_dir/functions/wolfie-brain" \
  "$release_dir/functions/wolfie-realtime-session" \
  "$release_dir/functions/wolfie-tts" \
  "$release_dir/functions/_shared" \
  "$release_dir/migrations" \
  "$release_dir/tests"
REMOTE

rsync -a --delete -- dist/ \
  "$DEPLOY_SSH_HOST:$remote_release/frontend-dist/"
for function_name in "${FUNCTIONS[@]}"; do
  rsync -a --delete -- "supabase/functions/$function_name/" \
    "$DEPLOY_SSH_HOST:$remote_release/functions/$function_name/"
done
for shared_file in "${SHARED_FUNCTION_FILES[@]}"; do
  rsync -a -- "supabase/functions/_shared/$shared_file" \
    "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/$shared_file"
done
for migration_path in "${MIGRATIONS[@]}"; do
  rsync -a -- "$migration_path" \
    "$DEPLOY_SSH_HOST:$remote_release/migrations/$(basename -- "$migration_path")"
done
for database_test in "${DATABASE_TESTS[@]}"; do
  rsync -a -- "$database_test" \
    "$DEPLOY_SSH_HOST:$remote_release/tests/$(basename -- "$database_test")"
done

echo "== Ativação, verificação e rollback automático =="
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
  "$DEPLOY_API_URL" \
  "$VITE_SUPABASE_ANON_KEY" <<'REMOTE'
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
anon_key=${11}

for remote_path in \
  "$release_dir" "$app_dir" "$compose_dir" "$releases_dir" \
  "$backups_dir" "$functions_dir" "$supabase_dir"; do
  [[ "$remote_path" == /opt/wisewolf/* ]]
done
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
[[ ${#anon_key} -ge 20 ]]

exec 9>"$releases_dir/.deploy.lock"
flock -n 9 || {
  echo "ERRO: já existe outro deploy em andamento." >&2
  exit 1
}

backup_dir="$backups_dir/release-$release_id"
marker_dir="$releases_dir/.migration-checksums"
frontend_swapped=0
shared_dependency_swapped=0
swapped_functions=()

restore_previous_release() {
  local exit_code=$?
  trap - ERR
  set +e
  echo "ERRO: release Wolfie falhou; restaurando artefatos anteriores." >&2

  if [[ "$frontend_swapped" = "1" ]]; then
    if [[ -d "$app_dir/dist" ]]; then
      mv -- "$app_dir/dist" "$backup_dir/failed-frontend-dist"
    fi
    if [[ -d "$backup_dir/frontend-dist" ]]; then
      mv -- "$backup_dir/frontend-dist" "$app_dir/dist"
    fi
  fi
  if ((${#swapped_functions[@]} > 0)); then
    for function_name in "${swapped_functions[@]}"; do
      if [[ -d "$functions_dir/$function_name" ]]; then
        mv -- "$functions_dir/$function_name" \
          "$backup_dir/failed-$function_name"
      fi
      if [[ -d "$backup_dir/$function_name" ]]; then
        mv -- "$backup_dir/$function_name" "$functions_dir/$function_name"
      fi
    done
  fi
  if [[ "$shared_dependency_swapped" = "1" ]]; then
    cp -a -- "$functions_dir/_shared/request-auth.ts" \
      "$backup_dir/failed-request-auth.ts"
    cp -a -- "$backup_dir/request-auth.ts" \
      "$functions_dir/_shared/.request-auth.ts.rollback"
    mv -f -- "$functions_dir/_shared/.request-auth.ts.rollback" \
      "$functions_dir/_shared/request-auth.ts"
  fi

  (
    cd "$supabase_dir" &&
      docker compose restart functions
  ) >/dev/null 2>&1 || true
  (
    cd "$compose_dir" &&
      docker compose up -d --force-recreate frontend
  ) >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap restore_previous_release ERR

mkdir -p -- "$backup_dir" "$marker_dir"
[[ -d "$release_dir/frontend-dist" ]]
for function_name in \
  wolfie-activity wolfie-brain wolfie-realtime-session wolfie-tts; do
  [[ -s "$release_dir/functions/$function_name/index.ts" ]]
done
[[ -s "$release_dir/functions/_shared/request-auth.ts" ]]
[[ -s "$functions_dir/_shared/request-auth.ts" ]]

migration_versions=(
  20260730193415
  20260731023000
)
migration_paths=(
  "$release_dir/migrations/20260730193415_wolfie_factual_memory_and_rag.sql"
  "$release_dir/migrations/20260731023000_harden_tenant_membership_roles.sql"
)
database_tests=(
  "$release_dir/tests/wolfie_factual_memory_and_rag.sql"
  "$release_dir/tests/tenant_membership_role_hardening.sql"
)
expected_markers=()
database_migration_pending=0
for index in "${!migration_paths[@]}"; do
  migration_path="${migration_paths[$index]}"
  migration_version="${migration_versions[$index]}"
  [[ -s "$migration_path" ]]
  migration_checksum="$(sha256sum "$migration_path" | awk '{print $1}')"
  existing_marker="$(
    find "$marker_dir" -maxdepth 1 -type f \
      -name "${migration_version}-*.sha256" -print -quit
  )"
  expected_marker="$marker_dir/${migration_version}-${migration_checksum}.sha256"
  if [[ -n "$existing_marker" && "$existing_marker" != "$expected_marker" ]]; then
    echo "ERRO: migration $migration_version já aplicada com checksum diferente." >&2
    exit 1
  fi
  expected_markers+=("$expected_marker")
  if [[ ! -f "$expected_marker" ]]; then
    database_migration_pending=1
  fi
done
for database_test in "${database_tests[@]}"; do
  [[ -s "$database_test" ]]
done

if [[ "$database_migration_pending" = "1" ]]; then
  database_backup_tmp="$backup_dir/postgres-before-wolfie.dump.tmp"
  database_backup="$backup_dir/postgres-before-wolfie.dump"
  echo "== Backup PostgreSQL anterior às migrations da release =="
  docker exec supabase-db pg_dump \
    -U supabase_admin \
    -d postgres \
    --format=custom \
    --no-owner \
    --no-privileges \
    > "$database_backup_tmp"
  [[ -s "$database_backup_tmp" ]]
  docker exec -i supabase-db pg_restore --list \
    < "$database_backup_tmp" >/dev/null
  mv -- "$database_backup_tmp" "$database_backup"

fi

for index in "${!migration_paths[@]}"; do
  expected_marker="${expected_markers[$index]}"
  if [[ ! -f "$expected_marker" ]]; then
    migration_path="${migration_paths[$index]}"
    migration_checksum="$(sha256sum "$migration_path" | awk '{print $1}')"
    docker exec -i supabase-db \
      psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -1 \
      < "$migration_path"
    printf '%s\n' "$migration_checksum" > "$expected_marker"
  fi
done

echo "== Testes SQL transacionais de fatos, RLS, retry e memberships =="
for database_test in "${database_tests[@]}"; do
  docker exec -i supabase-db \
    psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    < "$database_test"
done

if [[ -d "$app_dir/dist" ]]; then
  mv -- "$app_dir/dist" "$backup_dir/frontend-dist"
fi
frontend_swapped=1
cp -a -- "$release_dir/frontend-dist" "$app_dir/dist"

for function_name in \
  wolfie-activity wolfie-brain wolfie-realtime-session wolfie-tts; do
  if [[ -d "$functions_dir/$function_name" ]]; then
    mv -- "$functions_dir/$function_name" "$backup_dir/$function_name"
  fi
  swapped_functions+=("$function_name")
  cp -a -- "$release_dir/functions/$function_name" \
    "$functions_dir/$function_name"
done

cp -a -- "$functions_dir/_shared/request-auth.ts" \
  "$backup_dir/request-auth.ts"
cp -a -- "$release_dir/functions/_shared/request-auth.ts" \
  "$functions_dir/_shared/.request-auth.ts.release-$release_id"
mv -f -- "$functions_dir/_shared/.request-auth.ts.release-$release_id" \
  "$functions_dir/_shared/request-auth.ts"
shared_dependency_swapped=1
cmp -s \
  "$release_dir/functions/_shared/request-auth.ts" \
  "$functions_dir/_shared/request-auth.ts"

(
  cd "$supabase_dir"
  docker compose restart functions
)
(
  cd "$compose_dir"
  docker compose up -d --force-recreate frontend
)

wait_for_http_status() {
  local expected_status=$1
  local check_name=$2
  local actual_status=
  local attempt
  shift 2

  for attempt in {1..20}; do
    actual_status="$(
      curl -s -o /dev/null -w '%{http_code}' \
        --connect-timeout 5 --max-time 15 "$@" || true
    )"
    if [[ "$actual_status" = "$expected_status" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "ERRO: $check_name retornou ${actual_status:-sem resposta}; esperado $expected_status." >&2
  return 1
}

wait_for_http_status 200 "frontend público" "$public_url/"
frontend_html="$(curl -fsS --connect-timeout 5 --max-time 20 "$public_url/")"
asset_path="$(
  printf '%s' "$frontend_html" |
    sed -n 's/.*src="\([^"]*\/assets\/[^"]*\.js\)".*/\1/p' |
    head -n 1
)"
[[ "$asset_path" == /assets/*.js ]]
wait_for_http_status 200 "bundle JavaScript" "$public_url$asset_path"

mascot_headers="$(
  curl -fsSI --connect-timeout 5 --max-time 20 \
    "$public_url/assets/wolfie/wolfie-tutor-mascot.webp"
)"
printf '%s\n' "$mascot_headers" | grep -qi '^content-type: image/webp'
mascot_size="$(
  curl -fsS --connect-timeout 5 --max-time 20 \
    "$public_url/assets/wolfie/wolfie-tutor-mascot.webp" |
    wc -c |
    tr -d ' '
)"
[[ "$mascot_size" =~ ^[0-9]+$ && "$mascot_size" -gt 10000 ]]

wait_for_http_status 200 "saúde do Auth" \
  -H "apikey: $anon_key" "$api_url/auth/v1/health"
wait_for_http_status 200 "preflight de atividades" \
  -X OPTIONS "$api_url/functions/v1/wolfie-activity"
wait_for_http_status 401 "autenticação de atividades" \
  -X POST "$api_url/functions/v1/wolfie-activity" \
  -H 'Content-Type: application/json' \
  --data '{"action":"overview"}'
wait_for_http_status 200 "preflight da conversa" \
  -X OPTIONS "$api_url/functions/v1/wolfie-brain"
wait_for_http_status 401 "autenticação da conversa" \
  -X POST "$api_url/functions/v1/wolfie-brain" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Hello"}'
wait_for_http_status 200 "preflight do Realtime" \
  -X OPTIONS "$api_url/functions/v1/wolfie-realtime-session"
wait_for_http_status 401 "autenticação do Realtime" \
  -X POST "$api_url/functions/v1/wolfie-realtime-session" \
  -H 'Content-Type: application/sdp' \
  --data 'v=0'
wait_for_http_status 200 "preflight da voz" \
  -X OPTIONS "$api_url/functions/v1/wolfie-tts"
wait_for_http_status 401 "autenticação da voz" \
  -X POST "$api_url/functions/v1/wolfie-tts" \
  -H 'Content-Type: application/json' \
  --data '{"text":"Hello"}'

printf '%s\n' "$release_id" > "$releases_dir/current"
trap - ERR
echo "Release Wolfie ativa: $release_id"
echo "Backup reversível: $backup_dir"
REMOTE

echo "Deploy Wolfie concluído: $release_id"
