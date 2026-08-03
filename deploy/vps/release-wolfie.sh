#!/usr/bin/env bash
# Release isolada do Wolfie Tutor para a VPS de produção.
# Publica frontend, quatro funções Wolfie, dependências compartilhadas e as
# migrations de base já aprovadas para memória factual e isolamento de tenant.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"
caller_wolfie_scenario_ui_v2_was_set=false
caller_wolfie_scenario_ui_v2_value=""
if [[ "${VITE_WOLFIE_SCENARIO_UI_V2+x}" = "x" ]]; then
  caller_wolfie_scenario_ui_v2_was_set=true
  caller_wolfie_scenario_ui_v2_value="$VITE_WOLFIE_SCENARIO_UI_V2"
fi

cleanup() {
  local exit_code=$?
  trap - EXIT
  unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY \
    VITE_WOLFIE_SCENARIO_UI_V2 \
    caller_wolfie_scenario_ui_v2_was_set \
    caller_wolfie_scenario_ui_v2_value
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

validate_remote_path() {
  local remote_path=$1
  [[ "$remote_path" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ &&
    "$remote_path" != *".."* &&
    "$remote_path" != *"//"* ]]
}

validate_https_url() {
  local https_url=$1
  local https_url_tail
  [[ "$https_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?$ ]] ||
    return 1
  https_url_tail=${https_url#https://}
  [[ "$https_url_tail" != *".."* && "$https_url_tail" != *"//"* ]]
}

for command_name in \
  git npm npx node ssh rsync curl shasum base64 find; do
  require_command "$command_name"
done

[[ -s "$DEPLOY_ENV_FILE" ]] ||
  die "arquivo de configuração ausente: $DEPLOY_ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"
set +a
if [[ "$caller_wolfie_scenario_ui_v2_was_set" = "true" ]]; then
  VITE_WOLFIE_SCENARIO_UI_V2="$caller_wolfie_scenario_ui_v2_value"
fi

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

[[ "$DEPLOY_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
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
  validate_remote_path "$remote_path" ||
    die "caminho remoto fora de /opt/wisewolf: $remote_path"
done
validate_https_url "$DEPLOY_PUBLIC_URL" ||
  die "DEPLOY_PUBLIC_URL deve ser uma URL HTTPS segura"
validate_https_url "$DEPLOY_API_URL" ||
  die "DEPLOY_API_URL deve ser uma URL HTTPS segura"
[[ "$DEPLOY_API_URL" != *".supabase.co"* ]] ||
  die "DEPLOY_API_URL não pode apontar para o Supabase hospedado"

# shellcheck source=lib/release-preflight.sh
source "$SCRIPT_DIR/lib/release-preflight.sh"
assert_release_tree_is_publishable "$PROJECT_DIR"

cd "$PROJECT_DIR"

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
for required_command in base64 sha256sum stat; do
  command -v "$required_command" >/dev/null
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

  if to_regclass('cron.job') is null then
    raise exception 'pg_cron_job_catalog_is_required';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'supabase_vault_is_required';
  end if;
  perform 1
    from vault.decrypted_secrets as secret
   where secret.name = 'wisewolf_service_role_key'
     and nullif(secret.decrypted_secret, '') is not null;
  if not found then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;
end
$preflight$;
SQL
REMOTE

read_remote_public_env() {
  local key=$1
  [[ "$key" =~ ^VITE_[A-Z0-9_]+$ ]] ||
    die "chave pública remota inválida"
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
export VITE_WOLFIE_SCENARIO_UI_V2="${VITE_WOLFIE_SCENARIO_UI_V2:-true}"
[[ "$VITE_WOLFIE_SCENARIO_UI_V2" = "true" ||
  "$VITE_WOLFIE_SCENARIO_UI_V2" = "false" ]] ||
  die "VITE_WOLFIE_SCENARIO_UI_V2 deve ser true ou false"
VITE_SUPABASE_URL="$(read_remote_public_env VITE_SUPABASE_URL)"
VITE_SUPABASE_ANON_KEY="$(read_remote_public_env VITE_SUPABASE_ANON_KEY)"
validate_https_url "$VITE_SUPABASE_URL" ||
  die "VITE_SUPABASE_URL remota inválida"
[[ "$VITE_SUPABASE_URL" = "$DEPLOY_API_URL" ]] ||
  die "o frontend deve usar exatamente a API da VPS"
[[ "$VITE_SUPABASE_ANON_KEY" =~ ^[A-Za-z0-9._-]{20,}$ ]] ||
  die "VITE_SUPABASE_ANON_KEY remota ausente ou truncada"

echo "== Validação do artefato Wolfie =="
npm ci
npm run typecheck
npm run wolfie:assets:verify
npx vitest run \
  src/components/wolfie/visuals/featureFlags.test.tsx \
  src/components/wolfie/visuals/WolfiePresentationComponents.test.tsx \
  src/components/wolfie/WolfieActivitySummary.test.tsx \
  src/components/wolfie/WolfieMeetingActivity.test.tsx \
  src/services/pwaFreshness.test.tsx \
  src/services/wolfieConversationState.test.tsx \
  src/services/wolfieRealtimeHandoff.test.tsx
npx --yes deno test --no-lock \
  supabase/functions/_shared/request-auth.test.ts \
  supabase/functions/_shared/hub-billing-safety.test.ts \
  supabase/functions/wolfie-activity/answer-key-audit.test.ts \
  supabase/functions/wolfie-activity/meeting-assessment.test.ts \
  supabase/functions/wolfie-activity/personalization.test.ts \
  supabase/functions/wolfie-brain/adaptive-language-policy.test.ts \
  supabase/functions/wolfie-brain/audio-input.test.ts \
  supabase/functions/wolfie-brain/classic-global-meeting.test.ts \
  supabase/functions/wolfie-brain/factual-integrity.test.ts \
  supabase/functions/wolfie-brain/realtime-post-turn.test.ts \
  supabase/functions/wolfie-brain/turn-policy.test.ts \
  supabase/functions/wolfie-realtime-session/protocol.test.ts \
  supabase/functions/wolfie-realtime-session/memory-selection.test.ts \
  supabase/functions/wolfie-realtime-session/session-context.test.ts \
  scripts/tests/wolfie-global-meeting-policy.test.ts \
  scripts/tests/wolfie-voice-safety.test.ts
npx --yes deno check --no-lock \
  supabase/functions/wolfie-activity/index.ts \
  supabase/functions/wolfie-brain/index.ts \
  supabase/functions/wolfie-realtime-session/index.ts \
  supabase/functions/wolfie-tts/index.ts \
  supabase/functions/create-wolfie-topup/index.ts \
  supabase/functions/create-hub-checkout/index.ts \
  supabase/functions/wolfie-eval/index.ts \
  supabase/functions/wolfie-live-proxy/index.ts \
  supabase/functions/asaas-webhook/index.ts
node scripts/provision-wolfie-rag.mjs --validate-only
npm run build
find dist -type d -exec chmod 0755 {} +
find dist -type f -exec chmod 0644 {} +
npm run wolfie:assets:verify:dist
wolfie_asset_count="$(
  node -e \
    'const m=require("./src/components/wolfie/visuals/visualAssetManifest.json"); console.log((m.scenes.length * 2) + m.characters.length + m.legacyAliases.length)'
)"
wolfie_asset_lock_tsv="$(
  node scripts/verify-wolfie-visual-assets.mjs --root dist --format tsv
)"
wolfie_asset_lock_count="$(
  printf '%s\n' "$wolfie_asset_lock_tsv" | wc -l | tr -d ' '
)"
[[ "$wolfie_asset_count" =~ ^[1-9][0-9]*$ &&
  "$wolfie_asset_lock_count" = "$wolfie_asset_count" ]] ||
  die "lock HTTP dos assets Wolfie incompleto"
wolfie_asset_lock_b64="$(
  printf '%s\n' "$wolfie_asset_lock_tsv" | base64 | tr -d '\n'
)"
unset wolfie_asset_lock_tsv wolfie_asset_lock_count
[[ "$wolfie_asset_lock_b64" =~ ^[A-Za-z0-9+/=]+$ ]] ||
  die "lock HTTP dos assets Wolfie inválido"

MIGRATIONS=(
  "supabase/migrations/20260730193415_wolfie_factual_memory_and_rag.sql"
  "supabase/migrations/20260731023000_harden_tenant_membership_roles.sql"
  "supabase/migrations/20260731150000_wolfie_realtime_usage_tracking.sql"
  "supabase/migrations/20260731160000_wolfie_realtime_quota.sql"
  "supabase/migrations/20260731170000_ai_usage_observability.sql"
  "supabase/migrations/20260731180000_student_plan_entitlements.sql"
  "supabase/migrations/20260731190000_wolfie_minute_topups.sql"
  "supabase/migrations/20260801190000_wolfie_realtime_analysis_atomicity.sql"
  "supabase/migrations/20260801200000_wolfie_tenant_quota_usage_hardening.sql"
  "supabase/migrations/20260801210000_wolfie_classic_exchange_atomicity.sql"
  "supabase/migrations/20260801220000_wolfie_meeting_memory_lifecycle.sql"
  "supabase/migrations/20260801230000_repair_wolfie_sql_special_forms.sql"
  "supabase/migrations/20260803163128_wolfie_standalone_subscriptions.sql"
)
DATABASE_TESTS=(
  "supabase/tests/wolfie_factual_memory_and_rag.sql"
  "supabase/tests/tenant_membership_role_hardening.sql"
  "supabase/tests/wolfie_tenant_quota_usage_hardening.sql"
  "supabase/tests/wolfie_classic_exchange_atomicity.sql"
  "supabase/tests/wolfie_meeting_memory_lifecycle.sql"
  "supabase/tests/wolfie_sql_special_forms_repair.sql"
  "supabase/tests/wolfie_standalone_subscriptions.sql"
)
FUNCTIONS=(
  wolfie-activity
  wolfie-brain
  wolfie-realtime-session
  wolfie-tts
  create-wolfie-topup
  create-hub-checkout
  wolfie-eval
  wolfie-live-proxy
  asaas-webhook
)
SHARED_FUNCTION_FILES=(
  request-auth.ts
  ai-usage.ts
  wolfie-global-meeting-policy.ts
  hub-billing-safety.ts
  wolfie-product-access.ts
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
[[ "$git_sha" =~ ^[a-f0-9]{12}$ ]] ||
  die "commit Git inválido"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${git_sha}"
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] ||
  die "identificador de release inválido"
remote_release="$DEPLOY_RELEASES_DIR/$release_id"
validate_remote_path "$remote_release" ||
  die "caminho da release remota inválido"

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
  "$release_dir/functions/create-wolfie-topup" \
  "$release_dir/functions/create-hub-checkout" \
  "$release_dir/functions/wolfie-eval" \
  "$release_dir/functions/wolfie-live-proxy" \
  "$release_dir/functions/asaas-webhook" \
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
  "$VITE_SUPABASE_ANON_KEY" \
  "$wolfie_asset_lock_b64" \
  "$wolfie_asset_count" <<'REMOTE'
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
wolfie_asset_lock_b64=${12}
wolfie_asset_count=${13}

validate_remote_path() {
  local remote_path=$1
  [[ "$remote_path" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ &&
    "$remote_path" != *".."* &&
    "$remote_path" != *"//"* ]]
}

validate_https_url() {
  local https_url=$1
  local https_url_tail
  [[ "$https_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?$ ]] ||
    return 1
  https_url_tail=${https_url#https://}
  [[ "$https_url_tail" != *".."* && "$https_url_tail" != *"//"* ]]
}

for remote_path in \
  "$release_dir" "$app_dir" "$compose_dir" "$releases_dir" \
  "$backups_dir" "$functions_dir" "$supabase_dir"; do
  validate_remote_path "$remote_path"
done
validate_https_url "$public_url"
validate_https_url "$api_url"
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]
[[ "$anon_key" =~ ^[A-Za-z0-9._-]{20,}$ ]]
[[ "$wolfie_asset_lock_b64" =~ ^[A-Za-z0-9+/=]+$ ]]
[[ "$wolfie_asset_count" =~ ^[1-9][0-9]*$ ]]

exec 9>"$releases_dir/.deploy.lock"
flock -n 9 || {
  echo "ERRO: já existe outro deploy em andamento." >&2
  exit 1
}

backup_dir="$backups_dir/release-$release_id"
marker_dir="$releases_dir/.migration-checksums"
current_marker="$releases_dir/current"
current_marker_backup="$backup_dir/current.previous"
current_marker_tmp="$releases_dir/.current-$release_id.tmp"
current_marker_rollback_tmp="$releases_dir/.current-$release_id.rollback.tmp"
current_marker_existed=0
current_marker_swapped=0
frontend_swapped=0
swapped_functions=()
swapped_shared_files=()
rollback_owner_subshell=$BASH_SUBSHELL
rollback_started=0
SHARED_FUNCTION_FILES=(
  request-auth.ts
  ai-usage.ts
  wolfie-global-meeting-policy.ts
  hub-billing-safety.ts
  wolfie-product-access.ts
)

restore_previous_release() {
  local exit_code=$?
  if [[ "$BASH_SUBSHELL" != "$rollback_owner_subshell" ]]; then
    trap - ERR
    exit "$exit_code"
  fi
  if [[ "$rollback_started" = "1" ]]; then
    trap - ERR
    exit "$exit_code"
  fi
  rollback_started=1
  trap - ERR
  set +Ee
  echo "ERRO: release Wolfie falhou; restaurando artefatos anteriores." >&2

  if [[ "$current_marker_swapped" = "1" ]]; then
    if [[ "$current_marker_existed" = "1" && -f "$current_marker_backup" ]]; then
      cp -a -- "$current_marker_backup" "$current_marker_rollback_tmp"
      mv -f -- "$current_marker_rollback_tmp" "$current_marker"
    else
      rm -f -- "$current_marker"
    fi
  fi
  rm -f -- "$current_marker_tmp" "$current_marker_rollback_tmp"

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
  if ((${#swapped_shared_files[@]} > 0)); then
    for shared_file in "${swapped_shared_files[@]}"; do
      if [[ -f "$functions_dir/_shared/$shared_file" ]]; then
        cp -a -- "$functions_dir/_shared/$shared_file" \
          "$backup_dir/failed-$shared_file"
      fi
      if [[ -f "$backup_dir/$shared_file" ]]; then
        cp -a -- "$backup_dir/$shared_file" \
          "$functions_dir/_shared/.$shared_file.rollback"
        mv -f -- "$functions_dir/_shared/.$shared_file.rollback" \
          "$functions_dir/_shared/$shared_file"
      else
        rm -f -- "$functions_dir/_shared/$shared_file"
      fi
    done
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
[[ -d "$backup_dir" && ! -L "$backup_dir" ]]
[[ -d "$marker_dir" && ! -L "$marker_dir" ]]
[[ ! -e "$current_marker_backup" && ! -L "$current_marker_backup" ]]
[[ ! -e "$current_marker_tmp" && ! -L "$current_marker_tmp" ]]
[[ ! -e "$current_marker_rollback_tmp" && ! -L "$current_marker_rollback_tmp" ]]
[[ ! -L "$current_marker" ]]
if [[ -f "$current_marker" ]]; then
  cp -a -- "$current_marker" "$current_marker_backup"
  current_marker_existed=1
elif [[ -e "$current_marker" ]]; then
  echo "ERRO: marcador de release atual não é um arquivo regular." >&2
  false
fi
[[ -d "$release_dir/frontend-dist" ]]
for function_name in \
  wolfie-activity wolfie-brain wolfie-realtime-session wolfie-tts \
  create-wolfie-topup create-hub-checkout wolfie-eval wolfie-live-proxy \
  asaas-webhook; do
  [[ -s "$release_dir/functions/$function_name/index.ts" ]]
done
for shared_file in "${SHARED_FUNCTION_FILES[@]}"; do
  [[ -s "$release_dir/functions/_shared/$shared_file" ]]
done

migration_versions=(
  20260730193415
  20260731023000
  20260731150000
  20260731160000
  20260731170000
  20260731180000
  20260731190000
  20260801190000
  20260801200000
  20260801210000
  20260801220000
  20260801230000
  20260803163128
)
migration_paths=(
  "$release_dir/migrations/20260730193415_wolfie_factual_memory_and_rag.sql"
  "$release_dir/migrations/20260731023000_harden_tenant_membership_roles.sql"
  "$release_dir/migrations/20260731150000_wolfie_realtime_usage_tracking.sql"
  "$release_dir/migrations/20260731160000_wolfie_realtime_quota.sql"
  "$release_dir/migrations/20260731170000_ai_usage_observability.sql"
  "$release_dir/migrations/20260731180000_student_plan_entitlements.sql"
  "$release_dir/migrations/20260731190000_wolfie_minute_topups.sql"
  "$release_dir/migrations/20260801190000_wolfie_realtime_analysis_atomicity.sql"
  "$release_dir/migrations/20260801200000_wolfie_tenant_quota_usage_hardening.sql"
  "$release_dir/migrations/20260801210000_wolfie_classic_exchange_atomicity.sql"
  "$release_dir/migrations/20260801220000_wolfie_meeting_memory_lifecycle.sql"
  "$release_dir/migrations/20260801230000_repair_wolfie_sql_special_forms.sql"
  "$release_dir/migrations/20260803163128_wolfie_standalone_subscriptions.sql"
)
database_tests=(
  "$release_dir/tests/wolfie_factual_memory_and_rag.sql"
  "$release_dir/tests/tenant_membership_role_hardening.sql"
  "$release_dir/tests/wolfie_tenant_quota_usage_hardening.sql"
  "$release_dir/tests/wolfie_classic_exchange_atomicity.sql"
  "$release_dir/tests/wolfie_meeting_memory_lifecycle.sql"
  "$release_dir/tests/wolfie_sql_special_forms_repair.sql"
  "$release_dir/tests/wolfie_standalone_subscriptions.sql"
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

docker exec -i supabase-db \
  psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
do $wolfie_release_verify$
begin
  if to_regprocedure(
    'public.trigger_wolfie_live_grant_cleanup()'
  ) is null then
    raise exception 'wolfie_cleanup_trigger_function_missing';
  end if;
  if not exists (
    select 1
      from vault.decrypted_secrets as secret
     where secret.name = 'wisewolf_service_role_key'
       and nullif(secret.decrypted_secret, '') is not null
  ) then
    raise exception 'wisewolf_service_role_key_is_not_configured';
  end if;
  if not exists (
    select 1
      from cron.job as job
     where job.jobname = 'wisewolf-live-grant-cleanup'
       and job.active
       and job.schedule = '10 seconds'
       and job.command =
         'select public.trigger_wolfie_live_grant_cleanup();'
  ) then
    raise exception 'wolfie_cleanup_job_is_not_active';
  end if;
  if to_regprocedure(
    'public.claim_wolfie_ai_request(uuid,uuid,text)'
  ) is null
     or to_regprocedure(
       'public.finish_wolfie_ai_request(uuid,uuid,uuid,text,jsonb,text)'
     ) is null
     or to_regprocedure(
       'public.create_wolfie_activity_session(uuid,text,text,text,text,text,uuid,uuid,jsonb,jsonb,text[],text[])'
     ) is null then
    raise exception 'wolfie_rollback_compatibility_wrapper_missing';
  end if;
  if to_regprocedure('public.my_wolfie_access()') is null
     or to_regprocedure(
       'public.wolfie_prepare_checkout_account(text,text,jsonb)'
     ) is null
     or to_regprocedure(
       'public.hub_reverse_paid_checkout(uuid,text,text)'
     ) is null
     or to_regprocedure(
       'public.hub_mark_checkout_overdue(uuid,text)'
     ) is null
     or to_regclass('public.hub_payment_event_inbox') is null then
    raise exception 'wolfie_standalone_backend_missing';
  end if;
  if (
    select count(*)
      from public.hub_plans
     where code in (
       'WOLFIE_FOCO',
       'WOLFIE_RITMO',
       'WOLFIE_PERFORMANCE'
     )
       and product_family = 'WOLFIE_STANDALONE'
       and is_active
       and is_public
  ) <> 3 then
    raise exception 'wolfie_standalone_plans_incomplete';
  end if;
end;
$wolfie_release_verify$;
SQL

if [[ -d "$app_dir/dist" ]]; then
  mv -- "$app_dir/dist" "$backup_dir/frontend-dist"
fi
frontend_swapped=1
cp -a -- "$release_dir/frontend-dist" "$app_dir/dist"

for function_name in \
  wolfie-activity wolfie-brain wolfie-realtime-session wolfie-tts \
  create-wolfie-topup create-hub-checkout wolfie-eval wolfie-live-proxy \
  asaas-webhook; do
  if [[ -d "$functions_dir/$function_name" ]]; then
    mv -- "$functions_dir/$function_name" "$backup_dir/$function_name"
  fi
  swapped_functions+=("$function_name")
  cp -a -- "$release_dir/functions/$function_name" \
    "$functions_dir/$function_name"
done

for shared_file in "${SHARED_FUNCTION_FILES[@]}"; do
  if [[ -f "$functions_dir/_shared/$shared_file" ]]; then
    cp -a -- "$functions_dir/_shared/$shared_file" \
      "$backup_dir/$shared_file"
  fi
  cp -a -- "$release_dir/functions/_shared/$shared_file" \
    "$functions_dir/_shared/.$shared_file.release-$release_id"
  mv -f -- "$functions_dir/_shared/.$shared_file.release-$release_id" \
    "$functions_dir/_shared/$shared_file"
  swapped_shared_files+=("$shared_file")
  cmp -s \
    "$release_dir/functions/_shared/$shared_file" \
    "$functions_dir/_shared/$shared_file"
done

if ! (
  cd "$supabase_dir" &&
  docker compose restart functions
); then
  false
fi
if ! (
  cd "$compose_dir" &&
  docker compose up -d --force-recreate frontend
); then
  false
fi

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

asset_smoke_dir="$backup_dir/wolfie-asset-smoke"
asset_lock_file="$asset_smoke_dir/asset-lock.tsv"
[[ ! -e "$asset_smoke_dir" && ! -L "$asset_smoke_dir" ]]
mkdir -- "$asset_smoke_dir"
[[ -d "$asset_smoke_dir" && ! -L "$asset_smoke_dir" ]]
base64 -d > "$asset_lock_file" <<< "$wolfie_asset_lock_b64"
[[ -s "$asset_lock_file" ]]
verified_wolfie_assets=0
while IFS=$'\t' read -r asset_url expected_bytes expected_sha; do
  [[ "$asset_url" =~ ^/assets/wolfie/[A-Za-z0-9._/-]+\.webp$ ]]
  [[ "$asset_url" != *".."* && "$asset_url" != *"//"* ]]
  [[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]]
  [[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]]
  [[ "$verified_wolfie_assets" -lt "$wolfie_asset_count" ]]
  asset_body_file="$asset_smoke_dir/asset-$verified_wolfie_assets.webp"
  asset_metadata_file="$asset_smoke_dir/asset-$verified_wolfie_assets.content-type"
  asset_size_file="$asset_smoke_dir/asset-$verified_wolfie_assets.size"
  asset_sha_file="$asset_smoke_dir/asset-$verified_wolfie_assets.sha256"
  curl -fsS \
    --retry 3 --retry-connrefused --retry-max-time 75 \
    --connect-timeout 5 --max-time 20 \
    -o "$asset_body_file" \
    -w '%{content_type}\n' \
    "$public_url$asset_url" > "$asset_metadata_file"
  IFS= read -r asset_content_type < "$asset_metadata_file"
  [[ "$asset_content_type" = "image/webp" ]]
  stat -c '%s' "$asset_body_file" > "$asset_size_file"
  IFS= read -r downloaded_bytes < "$asset_size_file"
  [[ "$downloaded_bytes" = "$expected_bytes" ]]
  sha256sum "$asset_body_file" > "$asset_sha_file"
  IFS=' ' read -r actual_sha _ < "$asset_sha_file"
  [[ "$actual_sha" = "$expected_sha" ]]
  verified_wolfie_assets=$((verified_wolfie_assets + 1))
done < "$asset_lock_file"
[[ "$verified_wolfie_assets" = "$wolfie_asset_count" ]]
unset wolfie_asset_lock_b64

frontend_html_file="$asset_smoke_dir/frontend.html"
frontend_asset_paths_file="$asset_smoke_dir/frontend-assets.txt"
curl -fsS --connect-timeout 5 --max-time 20 \
  -o "$frontend_html_file" "$public_url/"
sed -n 's/.*src="\([^"]*\/assets\/[^"]*\.js\)".*/\1/p' \
  "$frontend_html_file" > "$frontend_asset_paths_file"
IFS= read -r asset_path < "$frontend_asset_paths_file"
[[ "$asset_path" == /assets/*.js ]]
wait_for_http_status 200 "bundle JavaScript" "$public_url$asset_path"

mascot_body_file="$asset_smoke_dir/wolfie-tutor-mascot.webp"
mascot_metadata_file="$asset_smoke_dir/wolfie-tutor-mascot.content-type"
mascot_size_file="$asset_smoke_dir/wolfie-tutor-mascot.size"
curl -fsS \
  --retry 3 --retry-connrefused --retry-max-time 75 \
  --connect-timeout 5 --max-time 20 \
  -o "$mascot_body_file" \
  -w '%{content_type}\n' \
  "$public_url/assets/wolfie/wolfie-tutor-mascot.webp" \
  > "$mascot_metadata_file"
IFS= read -r mascot_content_type < "$mascot_metadata_file"
[[ "$mascot_content_type" = "image/webp" ]]
stat -c '%s' "$mascot_body_file" > "$mascot_size_file"
IFS= read -r mascot_size < "$mascot_size_file"
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
wait_for_http_status 200 "preflight da recarga Wolfie" \
  -X OPTIONS "$api_url/functions/v1/create-wolfie-topup"
wait_for_http_status 401 "autenticação da recarga Wolfie" \
  -X POST "$api_url/functions/v1/create-wolfie-topup" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight do checkout Wolfie" \
  -X OPTIONS "$api_url/functions/v1/create-hub-checkout"
wait_for_http_status 401 "autenticação do checkout Wolfie" \
  -X POST "$api_url/functions/v1/create-hub-checkout" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 401 "token do webhook Asaas" \
  -X POST "$api_url/functions/v1/asaas-webhook" \
  -H 'Content-Type: application/json' \
  --data '{}'

[[ ! -e "$current_marker_tmp" && ! -L "$current_marker_tmp" ]]
printf '%s\n' "$release_id" > "$current_marker_tmp"
mv -f -- "$current_marker_tmp" "$current_marker"
current_marker_swapped=1
trap - ERR
echo "Release Wolfie ativa: $release_id"
echo "Backup reversível: $backup_dir"
REMOTE

echo "Deploy Wolfie concluído: $release_id"
