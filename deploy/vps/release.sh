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
    VITE_WOLFIE_REALTIME_ENABLED VITE_WOLFIE_SCENARIO_UI_V2 \
    VITE_HUB_PUBLIC_VIDEOS \
    caller_wolfie_scenario_ui_v2_was_set \
    caller_wolfie_scenario_ui_v2_value
  if [[ -n "$LOCAL_STAGE" && -d "$LOCAL_STAGE" ]]; then
    rm -rf -- "$LOCAL_STAGE"
  fi
  # Fecha a conexão SSH compartilhada, se ela chegou a ser aberta. Definida mais
  # abaixo, então o teste de existência é obrigatório: o cleanup também roda em
  # falhas precoces, antes de a função existir.
  if declare -F close_release_ssh >/dev/null; then
    close_release_ssh
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

for command_name in awk base64 curl find git head mktemp node npm npx rsync shasum sort ssh uniq; do
  require_command "$command_name"
done

[[ -s "$DEPLOY_ENV_FILE" ]] ||
  die "crie $DEPLOY_ENV_FILE a partir de .env.deploy.example"

set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"
set +a
if [[ "$caller_wolfie_scenario_ui_v2_was_set" = "true" ]]; then
  VITE_WOLFIE_SCENARIO_UI_V2="$caller_wolfie_scenario_ui_v2_value"
fi
DEPLOY_PRESERVE_REMOTE_FUNCTIONS="${DEPLOY_PRESERVE_REMOTE_FUNCTIONS:-0}"
VITE_HUB_PUBLIC_VIDEOS="${VITE_HUB_PUBLIC_VIDEOS:-false}"
[[ "$VITE_HUB_PUBLIC_VIDEOS" = "true" || "$VITE_HUB_PUBLIC_VIDEOS" = "false" ]] ||
  die "VITE_HUB_PUBLIC_VIDEOS deve ser true ou false"
[[ "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" = "0" ||
  "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" = "1" ]] ||
  die "DEPLOY_PRESERVE_REMOTE_FUNCTIONS deve ser 0 ou 1"
if [[ "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" = "1" ]]; then
  die "esta release acopla migrations e Edge Functions de segurança; DEPLOY_PRESERVE_REMOTE_FUNCTIONS deve ser 0"
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

# ── Uma conexão SSH para o release inteiro ───────────────────────────────────
#
# A etapa de preparação dispara ~90 `rsync` sequenciais (um por function, por
# migration, por teste). Sem multiplexação são ~90 handshakes TCP, e o servidor
# corta por volta do 11º: o release morria com «ssh: connect to host ...
# Operation timed out» ANTES de publicar qualquer coisa. Medido em 09/08/2026:
# 1 falha em 60 conexões soltas, 0 em 60 multiplexadas — e o deploy falhou 4×
# seguidas até isto entrar.
#
# Fica AQUI, e não no ~/.ssh/config de quem publica, porque o release tem de
# funcionar em qualquer máquina — inclusive numa que nunca foi configurada.
# `ssh` vira função de shell (o binário real continua acessível via `command
# ssh`); o rsync usa RSYNC_RSH, que o openrsync do macOS também honra.
RELEASE_SSH_SOCKET="${TMPDIR:-/tmp}/wisewolf-release-ssh-$$"
RELEASE_SSH_MUX=(-o ControlMaster=auto -o "ControlPath=$RELEASE_SSH_SOCKET" -o ControlPersist=120)
ssh() { command ssh "${RELEASE_SSH_MUX[@]}" "$@"; }
export RSYNC_RSH="ssh -o ControlMaster=auto -o ControlPath=$RELEASE_SSH_SOCKET -o ControlPersist=120"
close_release_ssh() {
  [[ -S "$RELEASE_SSH_SOCKET" ]] || return 0
  command ssh -O exit -o "ControlPath=$RELEASE_SSH_SOCKET" "$DEPLOY_SSH_HOST" >/dev/null 2>&1 || true
}
# ⚠️ Sem `trap ... EXIT` aqui: já existe um (`cleanup`, no topo) e um segundo
# SUBSTITUI o primeiro em vez de somar — o diretório de stage ficaria para trás e
# as variáveis VITE_* vazariam para o shell de quem publicou. O fechamento do
# socket entra DENTRO do cleanup existente.

# shellcheck source=lib/release-preflight.sh
source "$SCRIPT_DIR/lib/release-preflight.sh"
assert_release_tree_is_publishable "$PROJECT_DIR"
# Guardado para reconferir na hora de empacotar — ver assert_release_tree_unchanged.
RELEASE_HEAD_AT_PREFLIGHT="$(git -C "$PROJECT_DIR" rev-parse HEAD)"

# shellcheck source=lib/function-drift-guard.sh
source "$SCRIPT_DIR/lib/function-drift-guard.sh"

cd "$PROJECT_DIR"

node scripts/verify-hub-public-videos.mjs \
  --root public \
  --enabled "$VITE_HUB_PUBLIC_VIDEOS"
if [[ "$VITE_HUB_PUBLIC_VIDEOS" = "true" ]]; then
  npm run video:validate -- --public
fi

expected_current_release="$(
  ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- \
    "$DEPLOY_RELEASES_DIR" <<'REMOTE_BASE_RELEASE'
set -Eeuo pipefail
releases_dir=$1
[[ "$releases_dir" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ ]]
[[ "$releases_dir" != *".."* && "$releases_dir" != *"//"* ]]
current_marker="$releases_dir/current"
if [[ ! -e "$current_marker" && ! -L "$current_marker" ]]; then
  printf 'none'
  exit 0
fi
[[ -f "$current_marker" && ! -L "$current_marker" ]]
IFS= read -r active_release < "$current_marker"
[[ "$active_release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
printf '%s' "$active_release"
REMOTE_BASE_RELEASE
)"
[[ "$expected_current_release" = "none" ||
  "$expected_current_release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]] ||
  die "não foi possível identificar a release-base da VPS"

echo "== Preflight da VPS =="
ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_HOST" "$DEPLOY_USER" "$DEPLOY_APP_DIR" \
  "$DEPLOY_COMPOSE_DIR" "$DEPLOY_FUNCTIONS_DIR" "$DEPLOY_SUPABASE_DIR" \
  "$DEPLOY_RELEASES_DIR" "$DEPLOY_BACKUPS_DIR" <<'REMOTE'
set -Eeuo pipefail
expected_host=$1
expected_user=$2
app_dir=$3
compose_dir=$4
functions_dir=$5
supabase_dir=$6
releases_dir=$7
backups_dir=$8

((BASH_VERSINFO[0] >= 4))

[[ "$(id -un)" = "$expected_user" ]]
current_ip="$(hostname -I | awk '{print $1}')"
[[ "$current_ip" = "$expected_host" || "$expected_host" = "187.127.46.251" ]]
for required_dir in "$app_dir" "$compose_dir" "$functions_dir" "$supabase_dir"; do
  [[ -d "$required_dir" ]]
done
for control_dir in "$releases_dir" "$backups_dir"; do
  if [[ -e "$control_dir" || -L "$control_dir" ]]; then
    [[ -d "$control_dir" && ! -L "$control_dir" ]]
  fi
done
current_marker="$releases_dir/current"
if [[ -e "$current_marker" || -L "$current_marker" ]]; then
  [[ -f "$current_marker" && ! -L "$current_marker" ]]
fi
if [[ -f "$current_marker" ]]; then
  IFS= read -r active_release < "$current_marker"
  [[ "$active_release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
fi
if [[ -d "$backups_dir" ]]; then
  shopt -s nullglob
  activation_state_files=("$backups_dir"/release-*/ACTIVATION_STATE)
  post_commit_failure_files=("$backups_dir"/release-*/POST_COMMIT_FAILURE)
  shopt -u nullglob
  for activation_state_file in "${activation_state_files[@]}"; do
    [[ -f "$activation_state_file" && ! -L "$activation_state_file" ]]
    activation_release_dir="$(basename -- "$(dirname -- "$activation_state_file")")"
    activation_release_id="${activation_release_dir#release-}"
    [[ "$activation_release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
    IFS= read -r activation_state < "$activation_state_file"
    activation_phase="${activation_state%%:*}"
    activation_state_release_id="${activation_state#*:}"
    [[ "$activation_state_release_id" = "$activation_release_id" ]]
    case "$activation_phase" in
      active | rolled_back) ;;
      prepared | code_staged | database_transaction_started | database_commit_unknown | database_committed | post_commit_failed | rollback_failed)
        echo "ERRO: release $activation_release_id possui estado não reconciliado '$activation_phase'; valide banco, frontend, functions e markers antes de outro deploy." >&2
        exit 1
        ;;
      *)
        echo "ERRO: estado de ativação inválido em $activation_state_file." >&2
        exit 1
        ;;
    esac
  done
  if ((${#post_commit_failure_files[@]} > 0)); then
    echo "ERRO: existe falha pós-commit não reconciliada em ${post_commit_failure_files[0]}; valide banco, frontend, functions e markers antes de outro deploy." >&2
    exit 1
  fi
fi
for required_command in awk base64 curl docker find flock grep sha256sum stat; do
  command -v "$required_command" >/dev/null
done
docker inspect supabase-db --format '{{.State.Running}}' | grep -qx true
docker inspect supabase-edge-functions --format '{{.State.Running}}' | grep -qx true
docker exec supabase-edge-functions sh -lc \
  'test -n "${OPENAI_API_KEY:-}" &&
   test -n "${OPENROUTER_API_KEY:-}" &&
   test -n "${EVOLUTION_API_URL:-}" &&
   test -n "${EVOLUTION_API_KEY:-}" &&
   test -n "${RESEND_API_KEY:-}"'
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  supabase-edge-functions |
  grep -Eq '^SUPABASE_URL=http://(kong|api-gw):8000$'
docker exec -i supabase-db \
  psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
do $preflight$
declare
  installed_schema text;
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

  select namespace.nspname
    into installed_schema
    from pg_extension extension
    join pg_namespace namespace
      on namespace.oid = extension.extnamespace
   where extension.extname = 'vector';

  if installed_schema is not null and installed_schema <> 'extensions' then
    raise exception 'pgvector_must_use_extensions_schema';
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

assert_no_out_of_band_function_changes "$DEPLOY_SSH_HOST" "$DEPLOY_FUNCTIONS_DIR"
if [[ "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" = "1" ]]; then
  echo "Modo de preservação: edge functions remotas não serão enviadas, trocadas, reiniciadas nem registradas no manifesto."
fi

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
export VITE_WOLFIE_REALTIME_ENABLED
export VITE_WOLFIE_SCENARIO_UI_V2
VITE_SUPABASE_URL="$(read_remote_public_env VITE_SUPABASE_URL)"
VITE_SUPABASE_ANON_KEY="$(read_remote_public_env VITE_SUPABASE_ANON_KEY)"
VITE_WOLFIE_REALTIME_ENABLED="${VITE_WOLFIE_REALTIME_ENABLED:-true}"
VITE_WOLFIE_SCENARIO_UI_V2="${VITE_WOLFIE_SCENARIO_UI_V2:-true}"
validate_https_url "$VITE_SUPABASE_URL" ||
  die "VITE_SUPABASE_URL remota inválida"
[[ "$VITE_SUPABASE_URL" = "$DEPLOY_API_URL" ]] ||
  die "o frontend deve usar exatamente a API da VPS"
[[ "$VITE_SUPABASE_ANON_KEY" =~ ^[A-Za-z0-9._-]{20,}$ ]] ||
  die "VITE_SUPABASE_ANON_KEY remota ausente ou truncada"
[[ "$VITE_WOLFIE_REALTIME_ENABLED" = "true" ||
  "$VITE_WOLFIE_REALTIME_ENABLED" = "false" ]] ||
  die "VITE_WOLFIE_REALTIME_ENABLED deve ser true ou false"
[[ "$VITE_WOLFIE_SCENARIO_UI_V2" = "true" ||
  "$VITE_WOLFIE_SCENARIO_UI_V2" = "false" ]] ||
  die "VITE_WOLFIE_SCENARIO_UI_V2 deve ser true ou false"

echo "== Validação local =="
npm audit --audit-level=moderate
npm run typecheck
npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism
node --test scripts/generate-hub-static-html.test.mjs
npm run wolfie:assets:verify
npx --yes deno fmt --check \
  supabase/functions/_shared/automation-auth.ts \
  supabase/functions/_shared/automation-auth.test.ts \
  supabase/functions/_shared/invite-registration.ts \
  supabase/functions/_shared/invite-registration.test.ts \
  supabase/functions/_shared/opportunity-dispatch.ts \
  supabase/functions/_shared/opportunity-dispatch.test.ts \
  supabase/functions/_shared/payment-auth.ts \
  supabase/functions/_shared/payment-auth.test.ts \
  supabase/functions/_shared/evolution-send.ts \
  supabase/functions/_shared/evolution-send.test.ts \
  supabase/functions/_shared/tenant-integration-broker.ts \
  supabase/functions/_shared/tenant-integration-broker.test.ts \
  supabase/functions/_shared/hub-billing-safety.ts \
  supabase/functions/_shared/hub-billing-safety.test.ts \
  supabase/functions/_shared/tenant-communication.ts \
  supabase/functions/_shared/tenant-communication.test.ts \
  supabase/functions/_shared/tenant-legal-assets.ts \
  supabase/functions/_shared/tenant-legal-assets.test.ts \
  supabase/functions/accept-opportunity/core.ts \
  supabase/functions/accept-opportunity/core.test.ts \
  supabase/functions/accept-opportunity/index.ts \
  supabase/functions/broadcast-opportunity/index.ts \
  supabase/functions/confirm-vendor-trial/core.ts \
  supabase/functions/confirm-vendor-trial/core.test.ts \
  supabase/functions/confirm-vendor-trial/index.ts \
  supabase/functions/funnel-sweeper/index.ts \
  supabase/functions/kiwify-webhook/index.ts \
  supabase/functions/notify-claim/index.ts \
  supabase/functions/public-tenant-branding/index.ts \
  supabase/functions/public-tenant-branding/index.test.ts \
  supabase/functions/school-admin/core.ts \
  supabase/functions/school-admin/core.test.ts \
  supabase/functions/tenant-settings-admin/index.ts \
  supabase/functions/tenant-settings-admin/index.test.ts \
  supabase/functions/tenant-legal-assets/index.ts \
  supabase/functions/tenant-legal-assets/index.test.ts \
  supabase/functions/student-context/index.ts \
  supabase/functions/student-context/profile-access.test.ts \
  supabase/functions/create-hub-checkout/customer-idempotency.ts \
  supabase/functions/create-hub-checkout/customer-idempotency.test.ts \
  supabase/functions/create-hub-checkout/legal.ts \
  supabase/functions/create-hub-checkout/legal.test.ts \
  supabase/functions/create-hub-checkout/legal-acceptance.test.ts \
  supabase/functions/create-hub-checkout/index.ts \
  supabase/functions/create-hub-checkout/account-scope.test.ts \
  supabase/functions/cancel-hub-subscription/core.ts \
  supabase/functions/cancel-hub-subscription/core.test.ts \
  supabase/functions/cancel-hub-subscription/index.ts \
  supabase/functions/cancel-hub-subscription/index.test.ts \
  supabase/functions/asaas-webhook/billing-safety.ts \
  supabase/functions/asaas-webhook/index.ts \
  supabase/functions/asaas-webhook/hub-billing-routing.test.ts \
  supabase/functions/hub-library-access/index.ts \
  supabase/functions/sync-hub-material/index.ts \
  supabase/functions/process-hub-fulfillment/core.ts \
  supabase/functions/process-hub-fulfillment/core.test.ts \
  supabase/functions/process-hub-fulfillment/index.ts \
  supabase/functions/process-hub-fulfillment/integration.test.ts \
  supabase/functions/pedagogical-content/index.ts \
  supabase/functions/wolf-tutor-api/index.ts \
  supabase/functions/whatsapp-inbound/index.ts \
  supabase/functions/whatsapp-inbound/trial-reschedule.ts \
  supabase/functions/whatsapp-inbound/trial-reschedule.test.ts
npx --yes deno test --no-lock \
  supabase/functions/_shared/automation-auth.test.ts \
  supabase/functions/_shared/invite-registration.test.ts \
  supabase/functions/_shared/opportunity-dispatch.test.ts \
  supabase/functions/_shared/payment-auth.test.ts \
  supabase/functions/_shared/tenant-communication.test.ts \
  supabase/functions/_shared/tenant-legal-assets.test.ts \
  supabase/functions/_shared/hub-billing-safety.test.ts \
  supabase/functions/create-hub-checkout/legal.test.ts \
  supabase/functions/cancel-hub-subscription/core.test.ts \
  supabase/functions/process-hub-fulfillment/core.test.ts \
  supabase/functions/update-student-billing-method/core.test.ts \
  supabase/functions/generate-student-manual-pix/core.test.ts \
  supabase/functions/generate-student-insights/tenant-scope.test.ts \
  supabase/functions/whatsapp-inbound/triagem.test.ts \
  supabase/functions/whatsapp-inbound/trial-reschedule.test.ts \
  supabase/functions/whatsapp-inbound/conversation-log.test.ts \
  supabase/functions/_shared/lead-contact.test.ts \
  supabase/functions/_shared/commercial-contact-policy.test.ts \
  supabase/functions/_shared/evolution-send.test.ts \
  supabase/functions/_shared/tenant-integration-broker.test.ts \
  supabase/functions/payment-split-notify/message.test.ts \
  supabase/functions/monthly-teacher-closing/tenant-closing.test.ts \
  supabase/functions/school-admin/core.test.ts \
  supabase/functions/tenant-settings-admin/index.test.ts \
  supabase/functions/tenant-legal-assets/index.test.ts \
  supabase/functions/whatsapp-evolution-proxy/index.test.ts \
  supabase/functions/accept-opportunity/core.test.ts \
  supabase/functions/confirm-vendor-trial/core.test.ts \
  supabase/functions/public-tenant-branding/index.test.ts \
  supabase/functions/lesson-planner/core.test.ts \
  supabase/functions/wolfie-activity/answer-key-audit.test.ts \
  supabase/functions/wolfie-activity/meeting-assessment.test.ts \
  supabase/functions/wolfie-activity/personalization.test.ts \
  supabase/functions/wolfie-brain/classic-global-meeting.test.ts \
  supabase/functions/wolfie-brain/realtime-post-turn.test.ts \
  supabase/functions/wolfie-realtime-session/protocol.test.ts \
  supabase/functions/wolfie-realtime-session/memory-selection.test.ts \
  supabase/functions/wolfie-realtime-session/session-context.test.ts \
  scripts/tests/wolfie-voice-safety.test.ts \
  scripts/tests/wolfie-audio.test.ts \
  scripts/tests/contract-dates.test.ts \
  scripts/tests/ai-usage.test.ts \
  scripts/tests/wolfie-quick-start.test.ts \
  scripts/tests/meeting-link.test.ts \
  scripts/tests/wolfie-experience-catalog.test.ts \
  scripts/tests/wolfie-global-meeting-policy.test.ts
npx --yes deno test --allow-read --no-lock \
  scripts/tests/wolfie-voice-profile.test.ts \
  supabase/functions/wolf-tutor-api/conversation-scope.test.ts \
  supabase/functions/create-hub-checkout/account-scope.test.ts \
  supabase/functions/create-hub-checkout/customer-idempotency.test.ts \
  supabase/functions/create-hub-checkout/legal-acceptance.test.ts \
  supabase/functions/cancel-hub-subscription/index.test.ts \
  supabase/functions/asaas-webhook/hub-billing-routing.test.ts \
  supabase/functions/process-hub-fulfillment/integration.test.ts \
  supabase/functions/manage-hub-account-status/index.test.ts \
  supabase/functions/student-context/profile-access.test.ts
node scripts/provision-wolfie-rag.mjs --validate-only
npx --yes deno check --no-lock \
  supabase/functions/_shared/opportunity-dispatch.ts \
  supabase/functions/_shared/tenant-integration-broker.ts \
  supabase/functions/_shared/tenant-legal-assets.ts \
  supabase/functions/wolfie-activity/index.ts \
  supabase/functions/wolfie-brain/index.ts \
  supabase/functions/wolfie-realtime-session/index.ts \
  supabase/functions/wolfie-tts/index.ts \
  supabase/functions/create-wolfie-topup/index.ts \
  supabase/functions/lesson-planner/index.ts \
  supabase/functions/student-context/index.ts \
  supabase/functions/submit-quiz/index.ts \
  supabase/functions/hub-library-access/index.ts \
  supabase/functions/sync-hub-material/index.ts \
  supabase/functions/create-hub-checkout/customer-idempotency.ts \
  supabase/functions/create-hub-checkout/legal.ts \
  supabase/functions/create-hub-checkout/index.ts \
  supabase/functions/cancel-hub-subscription/core.ts \
  supabase/functions/cancel-hub-subscription/index.ts \
  supabase/functions/process-hub-fulfillment/index.ts \
  supabase/functions/manage-hub-account-status/index.ts \
  supabase/functions/create-saas-checkout/index.ts \
  supabase/functions/sync-student-asaas/index.ts \
  supabase/functions/create-asaas-subscription/index.ts \
  supabase/functions/update-student-billing-method/index.ts \
  supabase/functions/generate-student-manual-pix/index.ts \
  supabase/functions/create-enrollment-pix/index.ts \
  supabase/functions/pedagogical-content/index.ts \
  supabase/functions/wolf-tutor-api/index.ts \
  supabase/functions/asaas-webhook/index.ts \
  supabase/functions/create-student-account/index.ts \
  supabase/functions/create-teacher-account/index.ts \
  supabase/functions/admin-update-subscription/index.ts \
  supabase/functions/create-asaas-subaccount/index.ts \
  supabase/functions/transfer-teacher-pay/index.ts \
  supabase/functions/delete-student-account/index.ts \
  supabase/functions/send-whatsapp/index.ts \
  supabase/functions/whatsapp-wise-wolf/index.ts \
  supabase/functions/send-contract-confirmation/index.ts \
  supabase/functions/process-outbox/index.ts \
  supabase/functions/notify-claim/index.ts \
  supabase/functions/whatsapp-lead-notification/index.ts \
  supabase/functions/referral-welcome/index.ts \
  supabase/functions/sdr-followups/index.ts \
  supabase/functions/funnel-sweeper/index.ts \
  supabase/functions/post-trial-pipeline/index.ts \
  supabase/functions/whatsapp-inbound/index.ts \
  supabase/functions/whatsapp-crm-lead-notif/index.ts \
  supabase/functions/school-ai-team/index.ts \
  supabase/functions/school-ai-digest/index.ts \
  supabase/functions/hr-ai-screening/index.ts \
  supabase/functions/wolfie-eval/index.ts \
  supabase/functions/wolfie-live-proxy/index.ts \
  supabase/functions/sync-subscription-status/index.ts \
  supabase/functions/notify-payment-due/index.ts \
  supabase/functions/dre-categorize/index.ts \
  supabase/functions/dre-report/index.ts \
  supabase/functions/payment-split-notify/index.ts \
  supabase/functions/public-tenant-branding/index.ts \
  supabase/functions/sync-plan-change-billing/index.ts \
  supabase/functions/search-slots/index.ts \
  supabase/functions/sync-payments/index.ts \
  supabase/functions/whatsapp-hr-welcome/index.ts \
  supabase/functions/generate-student-insights/index.ts \
  supabase/functions/send-rejection-email/index.ts \
  supabase/functions/send-welcome-contract/index.ts \
  supabase/functions/register-user/index.ts \
  supabase/functions/reconcile-ledger/index.ts \
  supabase/functions/whatsapp-notificacao-wise/index.ts \
  supabase/functions/process-notification-queue/index.ts \
  supabase/functions/daily-automations/index.ts \
  supabase/functions/monthly-teacher-closing/index.ts \
  supabase/functions/register-teacher/index.ts \
  supabase/functions/register-vendor/index.ts \
  supabase/functions/school-admin/index.ts \
  supabase/functions/tenant-settings-admin/index.ts \
  supabase/functions/tenant-legal-assets/index.ts \
  supabase/functions/weekly-director-digest/index.ts \
  supabase/functions/whatsapp-evolution-proxy/index.ts \
  supabase/functions/book-interview/index.ts \
  supabase/functions/accept-coverage/index.ts \
  supabase/functions/accept-opportunity/index.ts \
  supabase/functions/broadcast-opportunity/index.ts \
  supabase/functions/confirm-vendor-trial/index.ts \
  supabase/functions/coverage-admin/index.ts \
  supabase/functions/oral-test-scan/index.ts \
  supabase/functions/prepare-daily-reminders/index.ts \
  supabase/functions/send-attendance-confirmations/index.ts \
  supabase/functions/send-class-notification/index.ts \
  supabase/functions/teacher-daily-agenda/index.ts \
  supabase/functions/kiwify-webhook/index.ts \
  supabase/functions/whatsapp-notificacao-matricula/index.ts
if [[ "$VITE_HUB_PUBLIC_VIDEOS" = "true" ]]; then
  npm run video:validate -- --public
fi
npm run build
node scripts/verify-hub-public-videos.mjs \
  --root dist \
  --enabled "$VITE_HUB_PUBLIC_VIDEOS"
find dist -type d -exec chmod 0755 {} +
find dist -type f -exec chmod 0644 {} +
npm run wolfie:assets:verify:dist
for hub_static_html in \
  dist/hub/index.html \
  dist/hub/professores/index.html \
  dist/hub/escolas/index.html \
  dist/hub/biblioteca/index.html \
  dist/hub/educador-ia/index.html \
  dist/hub/wolfie/index.html \
  dist/hub/saas-escolar/index.html \
  dist/hub/termos/index.html \
  dist/hub/privacidade/index.html \
  dist/hub/404.html \
  dist/__hub_host/index.html \
  dist/__hub_host/professores/index.html \
  dist/__hub_host/escolas/index.html \
  dist/__hub_host/biblioteca/index.html \
  dist/__hub_host/educador-ia/index.html \
  dist/__hub_host/wolfie/index.html \
  dist/__hub_host/saas-escolar/index.html \
  dist/__hub_host/termos/index.html \
  dist/__hub_host/privacidade/index.html \
  dist/__hub_host/404.html \
  dist/seja-professor/index.html \
  dist/new-saas/index.html; do
  [[ -s "$hub_static_html" ]] || die "shell HTML do Hub ausente: $hub_static_html"
done
for hub_seo_file in \
  dist/sitemap.xml \
  dist/robots.txt \
  dist/__hub_host/sitemap.xml \
  dist/__hub_host/robots.txt; do
  [[ -s "$hub_seo_file" ]] || die "arquivo de indexação ausente: $hub_seo_file"
done
grep -Fq 'https://system.wisewolflanguage.com.br/new-saas' dist/sitemap.xml \
  || die "sitemap do sistema sem a landing de diagnóstico"
grep -Fq 'https://hub.wisewolflanguage.com.br/saas-escolar' dist/__hub_host/sitemap.xml \
  || die "sitemap do Hub sem a landing do SaaS Escolar"
grep -Fq 'https://hub.wisewolflanguage.com.br/termos' dist/__hub_host/sitemap.xml \
  || die "sitemap do Hub sem os Termos de Uso"
grep -Fq 'https://hub.wisewolflanguage.com.br/privacidade' dist/__hub_host/sitemap.xml \
  || die "sitemap do Hub sem a Política de Privacidade"
if grep -R -E -i -q '(^|[^A-Za-z])fbq([^A-Za-z]|$)|Meta Pixel|facebook\.com/tr' \
  dist/__hub_host --include='*.html'; then
  die "host dedicado do Hub contém Meta Pixel antes do consentimento"
fi
grep -Fq "fbq('init'" dist/hub/index.html \
  || die "espelho do sistema perdeu o Pixel existente"
grep -Fq 'Sitemap: https://system.wisewolflanguage.com.br/sitemap.xml' dist/robots.txt \
  || die "robots.txt do sistema sem a declaração do sitemap"
grep -Fq 'Sitemap: https://hub.wisewolflanguage.com.br/sitemap.xml' dist/__hub_host/robots.txt \
  || die "robots.txt do Hub sem a declaração do sitemap"
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

MIGRATION_RELATIVES=(
  "supabase/migrations/20260725022832_wolfie_immersive_ecosystem.sql"
  "supabase/migrations/20260725030016_verified_legacy_xp_awards.sql"
  "supabase/migrations/20260725162301_wolfie_pedagogical_conversation_sessions.sql"
  "supabase/migrations/20260725220714_marketing_hub_foundation.sql"
  "supabase/migrations/20260725224021_sync_pedagogical_materials_to_hub.sql"
  "supabase/migrations/20260726000603_harden_multitenant_p0.sql"
  "supabase/migrations/20260726002844_tenant_memberships_foundation.sql"
  "supabase/migrations/20260726005136_saas_multitenant_context_limits_paid_provisioning.sql"
  "supabase/migrations/20260726012229_index_saas_checkout_intent_foreign_keys.sql"
  "supabase/migrations/20260726012800_align_school_plan_capacity.sql"
  "supabase/migrations/20260726015015_wise_wolf_planner_ai_foundation.sql"
  "supabase/migrations/20260726111719_hub_reliable_onboarding_personalization.sql"
  "supabase/migrations/20260726121622_reconcile_contracted_students_with_commercial_ai.sql"
  "supabase/migrations/20260730020238_fix_tenant_membership_upsert_cardinality.sql"
  "supabase/migrations/20260730022012_enforce_vps_only_runtime_endpoints.sql"
  "supabase/migrations/20260730193415_wolfie_factual_memory_and_rag.sql"
  "supabase/migrations/20260731023000_harden_tenant_membership_roles.sql"
  "supabase/migrations/20260731150000_wolfie_realtime_usage_tracking.sql"
  "supabase/migrations/20260731160000_wolfie_realtime_quota.sql"
  "supabase/migrations/20260731170000_ai_usage_observability.sql"
  "supabase/migrations/20260731180000_student_plan_entitlements.sql"
  "supabase/migrations/20260731190000_wolfie_minute_topups.sql"
  "supabase/migrations/20260731230000_settle_unlogged_confirmed_classes.sql"
  "supabase/migrations/20260801190000_wolfie_realtime_analysis_atomicity.sql"
  "supabase/migrations/20260801200000_wolfie_tenant_quota_usage_hardening.sql"
  "supabase/migrations/20260801210000_wolfie_classic_exchange_atomicity.sql"
  "supabase/migrations/20260801220000_wolfie_meeting_memory_lifecycle.sql"
  "supabase/migrations/20260801230000_repair_wolfie_sql_special_forms.sql"
  "supabase/migrations/20260802000000_teacher_financial_simplified.sql"
  "supabase/migrations/20260802010000_payable_rule_and_director_margin.sql"
  "supabase/migrations/20260802020000_flat_rate_and_trainer_bonus.sql"
  "supabase/migrations/20260802030000_turbo_restored_and_carryover.sql"
  "supabase/migrations/20260802040000_turbo_por_mes_fechado.sql"
  "supabase/migrations/20260802050000_nome_das_experimentais.sql"
  "supabase/migrations/20260802060000_experimental_exige_comparecimento.sql"
  "supabase/migrations/20260802070000_cobertura_transfere_aula.sql"
  "supabase/migrations/20260802080000_teste_oral_paga_e_ajustes_fechamento.sql"
  "supabase/migrations/20260802090000_divergencia_agenda_lancamento.sql"
  "supabase/migrations/20260802100000_cobertura_funcional.sql"
  "supabase/migrations/20260802110000_remove_faixa_9_50.sql"
  "supabase/migrations/20260802120000_versiona_get_cashflow.sql"
  "supabase/migrations/20260802130000_dre_gerencial_plano_de_contas.sql"
  "supabase/migrations/20260802140000_despesas_recorrentes.sql"
  "supabase/migrations/20260802150000_dre_categorizador.sql"
  "supabase/migrations/20260802160000_dre_relatorio_grupo.sql"
  "supabase/migrations/20260802170000_balancete_professores.sql"
  "supabase/migrations/20260802180000_gasto_de_anuncio.sql"
  "supabase/migrations/20260802190000_vinculo_pagamento_aluno.sql"
  "supabase/migrations/20260802200000_pagamento_fora_da_receita.sql"
  "supabase/migrations/20260802210000_mei_radar_reentrante.sql"
  "supabase/migrations/20260802220000_gestao_snapshot.sql"
  "supabase/migrations/20260802230000_gestao_snapshot_totais.sql"
  "supabase/migrations/20260802240000_gestao_faltas_e_cobranca.sql"
  "supabase/migrations/20260802250000_gestao_faltas_com_mes.sql"
  "supabase/migrations/20260802260000_aluno_sem_assinatura.sql"
  "supabase/migrations/20260803010000_balancete_lucro_contratado.sql"
  "supabase/migrations/20260803020000_ressalva_lucro_atualizada.sql"
  "supabase/migrations/20260803030000_conta_beneficios.sql"
  "supabase/migrations/20260803040000_custo_ia_por_aluno.sql"
  "supabase/migrations/20260803050000_reposicao_falta_aluno_nao_paga.sql"
  "supabase/migrations/20260803163128_wolfie_standalone_subscriptions.sql"
  "supabase/migrations/20260803235500_wolfie_free_premium_tiers.sql"
  "supabase/migrations/20260804030000_ajuste_entra_na_folha.sql"
  "supabase/migrations/20260804034000_ai_pricing_voice_models.sql"
  "supabase/migrations/20260804040000_ajuste_sincroniza_e_reposicao_rastreavel.sql"
  "supabase/migrations/20260804050000_gestao_acao_pendente.sql"
  "supabase/migrations/20260804120000_teacher_class_logging_rpc.sql"
  "supabase/migrations/20260804180000_scope_agenda_rls_por_professor.sql"
  "supabase/migrations/20260804190000_student_plan_change.sql"
  "supabase/migrations/20260804191000_catalogo_precos_2026_08.sql"
  "supabase/migrations/20260804200000_plan_change_billing_sync.sql"
  "supabase/migrations/20260804210000_scope_bookings_coverages_rls.sql"
  "supabase/migrations/20260807120000_nf_issuance_tour.sql"
  "supabase/migrations/20260807130000_professor_nao_escreve_o_proprio_fechamento.sql"
  "supabase/migrations/20260807140000_motivo_da_rejeicao_da_nota.sql"
  "supabase/migrations/20260807150000_reconciliacao_financeira.sql"
  "supabase/migrations/20260807160000_reconciliacao_respeita_pagamento_anual.sql"
  "supabase/migrations/20260807170000_renovacao_de_contrato.sql"
  "supabase/migrations/20260807180000_ofertas_de_renovacao.sql"
  "supabase/migrations/20260807190000_fim_do_contrato_e_a_ultima_aula_paga.sql"
  "supabase/migrations/20260808120000_rateio_do_pagamento_no_grupo.sql"
  "supabase/migrations/20260813140000_rateio_por_origem_da_aula.sql"
  "supabase/migrations/20260813160000_rateio_centavo_do_arredondamento.sql"
  "supabase/migrations/20260809120000_reposicoes_no_painel_de_pendencias.sql"
  "supabase/migrations/20260809130000_handoff_da_ia_tem_validade.sql"
  "supabase/migrations/20260809140000_mensalidade_tem_uma_coluna_so.sql"
  "supabase/migrations/20260809150000_escopo_de_tenant_na_escrita_de_aluno.sql"
  "supabase/migrations/20260811021018_teacher_change_student_schedule.sql"
  "supabase/migrations/20260811031056_student_manual_pix_claims.sql"
  "supabase/migrations/20260811112940_student_overdue_card_charge_claims.sql"
  "supabase/migrations/20260813120000_uma_conta_so_de_aluno_e_dinheiro_do_professor.sql"
  "supabase/migrations/20260817153648_gestao_contas_pagar_whatsapp.sql"
  "supabase/migrations/20260820091229_teacher_turbo_streak.sql"
  "supabase/migrations/20260820091231_lesson_occurrence_and_schedule_hardening.sql"
  "supabase/migrations/20260821220943_trial_reschedule_requires_teacher_confirmation.sql"
  "supabase/migrations/20260821225112_tenant_admin_security_center.sql"
  "supabase/migrations/20260821225307_tenant_rls_p0.sql"
  "supabase/migrations/20260821225420_invite_registration_security.sql"
  "supabase/migrations/20260822090110_atomic_trial_broadcast_reopen.sql"
  "supabase/migrations/20260822091116_atomic_opportunity_claim.sql"
  "supabase/migrations/20260822093650_secure_trial_management_writes.sql"
  "supabase/migrations/20260822095301_private_tenant_legal_assets.sql"
  "supabase/migrations/20260822121843_harden_trial_reschedule_lifecycle.sql"
  "supabase/migrations/20260822185207_secure_hub_content_isolation.sql"
  "supabase/migrations/20260822185211_harden_hub_account_access.sql"
  "supabase/migrations/20260823011835_hub_fulfillment_outbox.sql"
  "supabase/migrations/20260823033343_clarify_hub_teacher_offers.sql"
  "supabase/migrations/20260823035136_harden_saas_lead_public_intake.sql"
  "supabase/migrations/20260823043537_enforce_active_hub_profile_lifecycle.sql"
  "supabase/migrations/20260823140000_hub_library_collections.sql"
  "supabase/migrations/20260823153000_harden_hub_wolfie_conversation_scope.sql"
  "supabase/migrations/20260823184000_hub_educator_native_planner.sql"
  "supabase/migrations/20260823185000_harden_hub_account_mutations.sql"
  "supabase/migrations/20260823191000_harden_hub_member_profiles_and_learner_crud.sql"
  "supabase/migrations/20260824041712_hub_catalog_collection_read_grants.sql"
  "supabase/migrations/20260824051022_harden_saas_subscription_lifecycle.sql"
  "supabase/migrations/20260824051348_restrict_teacher_profile_pii.sql"
  "supabase/migrations/20260824152421_harden_teacher_finance_tenant_scope.sql"
  "supabase/migrations/20260824165951_tenant_integration_broker_evolution_pilot.sql"
  "supabase/migrations/20260824183059_reconcile_legacy_material_storage_ownership.sql"
  "supabase/migrations/20260824193205_repair_wise_wolf_legacy_branding_reference.sql"
  "supabase/migrations/20260824205624_guard_empty_hub_catalog.sql"
  "supabase/migrations/20260824210239_hub_core_legal_acceptances.sql"
  "supabase/migrations/20260824211112_hub_core_self_service_cancellation.sql"
  "supabase/migrations/20260824230000_conciliacao_do_caixa_asaas.sql"
  "supabase/migrations/20260825040358_harden_teacher_activity_report_scope.sql"
  "supabase/migrations/20260825140000_estorno_reverte_o_caixa.sql"
  "supabase/migrations/20260827000000_reconcile_ledger_refund_reversal.sql"
  "supabase/migrations/20260827120000_compat_apply_saas_checkout_billing_event.sql"
)
DATABASE_TEST_RELATIVES=(
  "supabase/tests/wolfie_tenant_quota_usage_hardening.sql"
  "supabase/tests/wolfie_classic_exchange_atomicity.sql"
  "supabase/tests/wolfie_meeting_memory_lifecycle.sql"
  "supabase/tests/wolfie_sql_special_forms_repair.sql"
  "supabase/tests/wolfie_standalone_subscriptions.sql"
  "supabase/tests/wolfie_free_premium_tiers.sql"
  "supabase/tests/teacher_closing_write_scope.sql"
  "supabase/tests/teacher_invoice_isolation.sql"
  "supabase/tests/teacher_schedule_change_scope.sql"
  "supabase/tests/conciliacao_caixa_asaas.sql"
  "supabase/tests/trial_reschedule_requires_teacher_confirmation.sql"
  "supabase/tests/student_manual_pix_claims.sql"
  "supabase/tests/student_overdue_card_charge_claims.sql"
  "supabase/tests/gestao_contas_pagar_whatsapp.sql"
  "supabase/tests/teacher_turbo_streak.sql"
  "supabase/tests/lesson_occurrence_and_schedule_hardening.sql"
  "supabase/tests/tenant_admin_security_center.sql"
  "supabase/tests/tenant_rls_p0.sql"
  "supabase/tests/invite_registration_security.sql"
  "supabase/tests/trial_broadcast_reopen_security.sql"
  "supabase/tests/atomic_opportunity_claim.sql"
  "supabase/tests/secure_trial_management_writes.sql"
  "supabase/tests/private_tenant_legal_assets.sql"
  "supabase/tests/hub_content_isolation.sql"
  "supabase/tests/hub_account_usage_hardening.sql"
  "supabase/tests/hub_fulfillment_outbox.sql"
  "supabase/tests/saas_leads_public_intake.sql"
  "supabase/tests/hub_wolfie_conversation_scope.sql"
  "supabase/tests/hub_educator_native_planner.sql"
  "supabase/tests/hub_account_mutations.sql"
  "supabase/tests/hub_member_profiles_and_learner_crud.sql"
  "supabase/tests/saas_subscription_lifecycle.sql"
  "supabase/tests/profile_teacher_pii_isolation.sql"
  "supabase/tests/teacher_finance_tenant_scope.sql"
  "supabase/tests/tenant_integration_broker.sql"
  "supabase/tests/material_storage_reconciliation.sql"
  "supabase/tests/tenant_branding_asset_repair.sql"
  "supabase/tests/hub_catalog_readiness.sql"
  "supabase/tests/hub_core_legal_acceptances.sql"
  "supabase/tests/hub_core_self_service_cancellation.sql"
)
FUNCTION_RELATIVE="supabase/functions/wolfie-activity"
CONVERSATION_FUNCTION_RELATIVE="supabase/functions/wolfie-brain"
REALTIME_FUNCTION_RELATIVE="supabase/functions/wolfie-realtime-session"
TTS_FUNCTION_RELATIVE="supabase/functions/wolfie-tts"
PEDAGOGICAL_FUNCTION_RELATIVE="supabase/functions/submit-quiz"
CONTEXT_FUNCTION_RELATIVE="supabase/functions/student-context"
HUB_LIBRARY_FUNCTION_RELATIVE="supabase/functions/hub-library-access"
HUB_MATERIAL_SYNC_FUNCTION_RELATIVE="supabase/functions/sync-hub-material"
HUB_CHECKOUT_FUNCTION_RELATIVE="supabase/functions/create-hub-checkout"
HUB_FULFILLMENT_FUNCTION_RELATIVE="supabase/functions/process-hub-fulfillment"
HUB_AI_FUNCTION_RELATIVE="supabase/functions/pedagogical-content"
HUB_TUTOR_FUNCTION_RELATIVE="supabase/functions/wolf-tutor-api"
ASAAS_WEBHOOK_FUNCTION_RELATIVE="supabase/functions/asaas-webhook"
NGINX_CONFIG_RELATIVE="deploy/vps/proxy/nginx-spa.conf"
# O config.toml atende ao Supabase CLI local. Na VPS, o Edge Runtime monta os
# fontes diretamente e usa VERIFY_JWT=false; funções protegidas autenticam no handler.
# Por isso ele não integra o artefato, e os smokes 401 abaixo validam essa barreira.
SHARED_AUTH_RELATIVE="supabase/functions/_shared/request-auth.ts"
SHARED_AUTOMATION_AUTH_RELATIVE="supabase/functions/_shared/automation-auth.ts"
SHARED_INVITE_REGISTRATION_RELATIVE="supabase/functions/_shared/invite-registration.ts"
SHARED_OPPORTUNITY_DISPATCH_RELATIVE="supabase/functions/_shared/opportunity-dispatch.ts"
SHARED_PAYMENT_AUTH_RELATIVE="supabase/functions/_shared/payment-auth.ts"
SHARED_TENANT_COMMUNICATION_RELATIVE="supabase/functions/_shared/tenant-communication.ts"
SHARED_TENANT_LEGAL_ASSETS_RELATIVE="supabase/functions/_shared/tenant-legal-assets.ts"
SHARED_ACCOUNT_INVITE_RELATIVE="supabase/functions/_shared/account-invite.ts"
SHARED_COMMERCIAL_POLICY_RELATIVE="supabase/functions/_shared/commercial-contact-policy.ts"
SHARED_AI_USAGE_RELATIVE="supabase/functions/_shared/ai-usage.ts"
SHARED_GLOBAL_MEETING_POLICY_RELATIVE="supabase/functions/_shared/wolfie-global-meeting-policy.ts"
SHARED_HUB_BILLING_SAFETY_RELATIVE="supabase/functions/_shared/hub-billing-safety.ts"
SHARED_WOLFIE_PRODUCT_ACCESS_RELATIVE="supabase/functions/_shared/wolfie-product-access.ts"
SHARED_LEAD_CONTACT_RELATIVE="supabase/functions/_shared/lead-contact.ts"
SHARED_EVOLUTION_SEND_RELATIVE="supabase/functions/_shared/evolution-send.ts"
SHARED_TENANT_INTEGRATION_BROKER_RELATIVE="supabase/functions/_shared/tenant-integration-broker.ts"
HARDENED_FUNCTIONS=(
  sync-subscription-status
  notify-payment-due
  create-wolfie-topup
  lesson-planner
  sync-student-asaas
  create-asaas-subscription
  update-student-billing-method
  generate-student-manual-pix
  create-enrollment-pix
  create-saas-checkout
  create-student-account
  create-teacher-account
  admin-update-subscription
  create-asaas-subaccount
  send-whatsapp
  whatsapp-wise-wolf
  send-contract-confirmation
  process-notification-queue
  process-outbox
  notify-claim
  whatsapp-lead-notification
  referral-welcome
  sdr-followups
  funnel-sweeper
  post-trial-pipeline
  whatsapp-inbound
  whatsapp-crm-lead-notif
  school-ai-team
  school-ai-digest
  hr-ai-screening
  wolfie-eval
  wolfie-live-proxy
  dre-categorize
  dre-report
  payment-split-notify
  sync-plan-change-billing
  search-slots
  sync-payments
  accept-coverage
  accept-opportunity
  book-interview
  broadcast-opportunity
  confirm-attendance
  confirm-vendor-trial
  coverage-admin
  create-public-resume-upload
  daily-automations
  delete-student-account
  generate-student-insights
  kiwify-webhook
  manage-hub-account-status
  cancel-hub-subscription
  model-probe
  monthly-teacher-closing
  oral-test-scan
  prepare-daily-reminders
  public-tenant-branding
  reconcile-ledger
  register-teacher
  register-user
  register-vendor
  resolve-offer
  school-admin
  send-attendance-confirmations
  send-class-notification
  send-rejection-email
  send-welcome-contract
  sign-offer
  teacher-daily-agenda
  tenant-settings-admin
  tenant-legal-assets
  transfer-teacher-pay
  weekly-director-digest
  whatsapp-evolution-proxy
  whatsapp-hr-welcome
  whatsapp-notificacao-matricula
  whatsapp-notificacao-wise
  wolfie-healthcheck
)
for migration_relative in "${MIGRATION_RELATIVES[@]}"; do
  [[ -s "$migration_relative" ]] ||
    die "migration ausente: $migration_relative"
done
for database_test_relative in "${DATABASE_TEST_RELATIVES[@]}"; do
  [[ -s "$database_test_relative" ]] ||
    die "teste SQL ausente: $database_test_relative"
done
[[ -s "$FUNCTION_RELATIVE/index.ts" ]] || die "função Wolfie ausente"
[[ -s "$CONVERSATION_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de conversa do Wolfie ausente"
[[ -s "$REALTIME_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função Realtime do Wolfie ausente"
[[ -s "$TTS_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de voz do Wolfie ausente"
[[ -s "$PEDAGOGICAL_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de avaliação pedagógica ausente"
[[ -s "$CONTEXT_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de contexto do aluno ausente"
[[ -s "$HUB_LIBRARY_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de biblioteca do Hub ausente"
[[ -s "$HUB_MATERIAL_SYNC_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de sincronização de materiais do Hub ausente"
[[ -s "$HUB_CHECKOUT_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de checkout do Hub ausente"
[[ -s "$HUB_FULFILLMENT_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de fulfillment do Hub ausente"
[[ -s "$HUB_AI_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de IA do Hub ausente"
[[ -s "$HUB_TUTOR_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função Wolfie do Hub ausente"
[[ -s "$ASAAS_WEBHOOK_FUNCTION_RELATIVE/index.ts" ]] ||
  die "webhook Asaas ausente"
[[ -s "$NGINX_CONFIG_RELATIVE" && ! -L "$NGINX_CONFIG_RELATIVE" ]] ||
  die "configuração Nginx auditada ausente"
[[ -s "$SHARED_AUTH_RELATIVE" ]] || die "guard de autenticação ausente"
[[ -s "$SHARED_AUTOMATION_AUTH_RELATIVE" ]] || die "guard de automações ausente"
[[ -s "$SHARED_INVITE_REGISTRATION_RELATIVE" ]] || die "guard de convites ausente"
[[ -s "$SHARED_OPPORTUNITY_DISPATCH_RELATIVE" ]] || die "guard de disparo de oportunidades ausente"
[[ -s "$SHARED_PAYMENT_AUTH_RELATIVE" ]] || die "guard de pagamentos ausente"
[[ -s "$SHARED_TENANT_COMMUNICATION_RELATIVE" ]] || die "identidade de comunicação tenant-safe ausente"
[[ -s "$SHARED_TENANT_LEGAL_ASSETS_RELATIVE" ]] || die "resolver privado de documentos legais ausente"
[[ -s "$SHARED_ACCOUNT_INVITE_RELATIVE" ]] || die "helper de convite seguro ausente"
[[ -s "$SHARED_COMMERCIAL_POLICY_RELATIVE" ]] || die "política de contato comercial ausente"
[[ -s "$SHARED_AI_USAGE_RELATIVE" ]] || die "telemetria compartilhada de IA ausente"
[[ -s "$SHARED_GLOBAL_MEETING_POLICY_RELATIVE" ]] || die "política de reunião global ausente"
[[ -s "$SHARED_WOLFIE_PRODUCT_ACCESS_RELATIVE" ]] || die "gate comercial do Wolfie ausente"
[[ -s "$SHARED_LEAD_CONTACT_RELATIVE" ]] || die "regras de contato com lead ausentes"
[[ -s "$SHARED_EVOLUTION_SEND_RELATIVE" ]] || die "envio compartilhado da Evolution ausente"
[[ -s "$SHARED_TENANT_INTEGRATION_BROKER_RELATIVE" ]] || die "broker tenant-aware de integrações ausente"
for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  [[ -s "supabase/functions/$function_name/index.ts" ]] ||
    die "função endurecida ausente: $function_name"
done

source_git_sha="$(git rev-parse --short=12 HEAD)"
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
hardened_functions_manifest="$LOCAL_STAGE/hardened-functions.txt"
printf '%s\n' "${HARDENED_FUNCTIONS[@]}" > "$hardened_functions_manifest"
[[ -s "$hardened_functions_manifest" ]]
release_inputs_manifest="$LOCAL_STAGE/release-inputs.sha256"

append_release_input_checksum() {
  local source_path=$1 remote_relative=$2
  [[ -f "$source_path" && ! -L "$source_path" ]]
  [[ "$remote_relative" =~ ^[A-Za-z0-9._/-]+$ &&
    "$remote_relative" != *".."* &&
    "$remote_relative" != *"//"* ]]
  printf '%s  %s\n' \
    "$(shasum -a 256 "$source_path" | awk '{print $1}')" \
    "$remote_relative"
}

{
  append_release_input_checksum \
    "$hardened_functions_manifest" \
    "hardened-functions.txt"
  append_release_input_checksum \
    "$NGINX_CONFIG_RELATIVE" \
    "nginx.conf"
  while IFS= read -r release_input; do
    append_release_input_checksum \
      "$release_input" \
      "frontend-dist/${release_input#dist/}"
  done < <(find dist -type f -print | LC_ALL=C sort)
  for release_input_dir in \
    "$FUNCTION_RELATIVE" \
    "$CONVERSATION_FUNCTION_RELATIVE" \
    "$REALTIME_FUNCTION_RELATIVE" \
    "$TTS_FUNCTION_RELATIVE" \
    "$PEDAGOGICAL_FUNCTION_RELATIVE" \
    "$CONTEXT_FUNCTION_RELATIVE" \
    "$HUB_LIBRARY_FUNCTION_RELATIVE" \
    "$HUB_MATERIAL_SYNC_FUNCTION_RELATIVE" \
    "$HUB_CHECKOUT_FUNCTION_RELATIVE" \
    "$HUB_FULFILLMENT_FUNCTION_RELATIVE" \
    "$HUB_AI_FUNCTION_RELATIVE" \
    "$HUB_TUTOR_FUNCTION_RELATIVE" \
    "$ASAAS_WEBHOOK_FUNCTION_RELATIVE"; do
    while IFS= read -r release_input; do
      append_release_input_checksum \
        "$release_input" \
        "functions/${release_input#supabase/functions/}"
    done < <(find "$release_input_dir" -type f -print | LC_ALL=C sort)
  done
  for function_name in "${HARDENED_FUNCTIONS[@]}"; do
    while IFS= read -r release_input; do
      append_release_input_checksum \
        "$release_input" \
        "functions/${release_input#supabase/functions/}"
    done < <(find "supabase/functions/$function_name" -type f -print | LC_ALL=C sort)
  done
  for shared_relative in \
    "$SHARED_AUTH_RELATIVE" \
    "$SHARED_AUTOMATION_AUTH_RELATIVE" \
    "$SHARED_INVITE_REGISTRATION_RELATIVE" \
    "$SHARED_OPPORTUNITY_DISPATCH_RELATIVE" \
    "$SHARED_PAYMENT_AUTH_RELATIVE" \
    "$SHARED_TENANT_COMMUNICATION_RELATIVE" \
    "$SHARED_TENANT_LEGAL_ASSETS_RELATIVE" \
    "$SHARED_ACCOUNT_INVITE_RELATIVE" \
    "$SHARED_COMMERCIAL_POLICY_RELATIVE" \
    "$SHARED_AI_USAGE_RELATIVE" \
    "$SHARED_GLOBAL_MEETING_POLICY_RELATIVE" \
    "$SHARED_HUB_BILLING_SAFETY_RELATIVE" \
    "$SHARED_WOLFIE_PRODUCT_ACCESS_RELATIVE" \
    "$SHARED_LEAD_CONTACT_RELATIVE" \
    "$SHARED_EVOLUTION_SEND_RELATIVE" \
    "$SHARED_TENANT_INTEGRATION_BROKER_RELATIVE"; do
    append_release_input_checksum \
      "$shared_relative" \
      "functions/${shared_relative#supabase/functions/}"
  done
  for migration_relative in "${MIGRATION_RELATIVES[@]}"; do
    append_release_input_checksum \
      "$migration_relative" \
      "migrations/$(basename -- "$migration_relative")"
  done
  for database_test_relative in "${DATABASE_TEST_RELATIVES[@]}"; do
    append_release_input_checksum \
      "$database_test_relative" \
      "tests/$(basename -- "$database_test_relative")"
  done
} > "$release_inputs_manifest"
[[ -s "$release_inputs_manifest" ]]
duplicate_release_input="$(
  awk '{print $2}' "$release_inputs_manifest" |
    LC_ALL=C sort |
    uniq -d |
    head -n 1
)"
[[ -z "$duplicate_release_input" ]] ||
  die "entrada duplicada no manifesto da release: $duplicate_release_input"
assert_release_tree_unchanged "$PROJECT_DIR" "$RELEASE_HEAD_AT_PREFLIGHT"
artifact_hash="$(
  shasum -a 256 "$release_inputs_manifest" |
    awk '{print substr($1, 1, 12)}'
)"
[[ "$artifact_hash" =~ ^[a-f0-9]{12}$ ]] ||
  die "não foi possível calcular a identidade da release"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${artifact_hash}"
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] ||
  die "identificador de release inválido"
echo "Commit de origem: $source_git_sha"
remote_release="$DEPLOY_RELEASES_DIR/$release_id"
validate_remote_path "$remote_release" ||
  die "caminho da release remota inválido"

echo "== Preparação da release $release_id =="
ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- "$remote_release" <<'REMOTE'
set -Eeuo pipefail
release_dir=$1
[[ "$release_dir" == /opt/wisewolf/releases/* ]]
[[ ! -e "$release_dir" && ! -L "$release_dir" ]]
mkdir -p -- \
  "$release_dir/frontend-dist" \
  "$release_dir/functions/wolfie-activity" \
  "$release_dir/functions/wolfie-brain" \
  "$release_dir/functions/wolfie-realtime-session" \
  "$release_dir/functions/wolfie-tts" \
  "$release_dir/functions/lesson-planner" \
  "$release_dir/functions/submit-quiz" \
  "$release_dir/functions/student-context" \
  "$release_dir/functions/hub-library-access" \
  "$release_dir/functions/sync-hub-material" \
  "$release_dir/functions/create-hub-checkout" \
  "$release_dir/functions/process-hub-fulfillment" \
  "$release_dir/functions/pedagogical-content" \
  "$release_dir/functions/wolf-tutor-api" \
  "$release_dir/functions/asaas-webhook" \
  "$release_dir/functions/create-student-account" \
  "$release_dir/functions/create-teacher-account" \
  "$release_dir/functions/admin-update-subscription" \
  "$release_dir/functions/create-asaas-subaccount" \
  "$release_dir/functions/send-whatsapp" \
  "$release_dir/functions/whatsapp-wise-wolf" \
  "$release_dir/functions/send-contract-confirmation" \
  "$release_dir/functions/process-outbox" \
  "$release_dir/functions/notify-claim" \
  "$release_dir/functions/whatsapp-lead-notification" \
  "$release_dir/functions/referral-welcome" \
  "$release_dir/functions/_shared" \
  "$release_dir/migrations" \
  "$release_dir/tests"
REMOTE

rsync -a --delete -- dist/ \
  "$DEPLOY_SSH_HOST:$remote_release/frontend-dist/"
rsync -a -- "$NGINX_CONFIG_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/nginx.conf"
rsync -a -- "$hardened_functions_manifest" \
  "$DEPLOY_SSH_HOST:$remote_release/hardened-functions.txt"
rsync -a -- "$release_inputs_manifest" \
  "$DEPLOY_SSH_HOST:$remote_release/release-inputs.sha256"
if [[ "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" != "1" ]]; then
rsync -a --delete -- "$FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/wolfie-activity/"
rsync -a --delete -- "$CONVERSATION_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/wolfie-brain/"
rsync -a --delete -- "$REALTIME_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/wolfie-realtime-session/"
rsync -a --delete -- "$TTS_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/wolfie-tts/"
rsync -a --delete -- "$PEDAGOGICAL_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/submit-quiz/"
rsync -a --delete -- "$CONTEXT_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/student-context/"
rsync -a --delete -- "$HUB_LIBRARY_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/hub-library-access/"
rsync -a --delete -- "$HUB_MATERIAL_SYNC_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/sync-hub-material/"
rsync -a --delete -- "$HUB_CHECKOUT_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/create-hub-checkout/"
rsync -a --delete -- "$HUB_FULFILLMENT_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/process-hub-fulfillment/"
rsync -a --delete -- "$HUB_AI_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/pedagogical-content/"
rsync -a --delete -- "$HUB_TUTOR_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/wolf-tutor-api/"
rsync -a --delete -- "$ASAAS_WEBHOOK_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/asaas-webhook/"
rsync -a -- "$SHARED_AUTH_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/request-auth.ts"
rsync -a -- "$SHARED_AUTOMATION_AUTH_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/automation-auth.ts"
rsync -a -- "$SHARED_INVITE_REGISTRATION_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/invite-registration.ts"
rsync -a -- "$SHARED_OPPORTUNITY_DISPATCH_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/opportunity-dispatch.ts"
rsync -a -- "$SHARED_PAYMENT_AUTH_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/payment-auth.ts"
rsync -a -- "$SHARED_TENANT_COMMUNICATION_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/tenant-communication.ts"
rsync -a -- "$SHARED_TENANT_LEGAL_ASSETS_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/tenant-legal-assets.ts"
rsync -a -- "$SHARED_ACCOUNT_INVITE_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/account-invite.ts"
rsync -a -- "$SHARED_COMMERCIAL_POLICY_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/commercial-contact-policy.ts"
rsync -a -- "$SHARED_AI_USAGE_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/ai-usage.ts"
rsync -a -- "$SHARED_GLOBAL_MEETING_POLICY_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/wolfie-global-meeting-policy.ts"
rsync -a -- "$SHARED_HUB_BILLING_SAFETY_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/hub-billing-safety.ts"
rsync -a -- "$SHARED_WOLFIE_PRODUCT_ACCESS_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/wolfie-product-access.ts"
rsync -a -- "$SHARED_LEAD_CONTACT_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/lead-contact.ts"
rsync -a -- "$SHARED_EVOLUTION_SEND_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/evolution-send.ts"
rsync -a -- "$SHARED_TENANT_INTEGRATION_BROKER_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/tenant-integration-broker.ts"
for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  rsync -a --delete -- "supabase/functions/$function_name/" \
    "$DEPLOY_SSH_HOST:$remote_release/functions/$function_name/"
done
fi
for migration_relative in "${MIGRATION_RELATIVES[@]}"; do
  migration_file="$(basename -- "$migration_relative")"
  rsync -a -- "$migration_relative" \
    "$DEPLOY_SSH_HOST:$remote_release/migrations/$migration_file"
done
for database_test_relative in "${DATABASE_TEST_RELATIVES[@]}"; do
  database_test_file="$(basename -- "$database_test_relative")"
  rsync -a -- "$database_test_relative" \
    "$DEPLOY_SSH_HOST:$remote_release/tests/$database_test_file"
done
assert_release_tree_unchanged "$PROJECT_DIR" "$RELEASE_HEAD_AT_PREFLIGHT"

echo "== Ativação transacional e smoke tests =="
activation_status=0
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
  "$wolfie_asset_lock_b64" \
  "$wolfie_asset_count" \
  "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" \
  "$expected_current_release" <<'REMOTE' || activation_status=$?
set -Eeuo pipefail
umask 077

((BASH_VERSINFO[0] >= 4))

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
wolfie_asset_lock_b64=${11}
wolfie_asset_count=${12}
preserve_remote_functions=${13}
expected_current_release=${14}

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
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
[[ "$wolfie_asset_lock_b64" =~ ^[A-Za-z0-9+/=]+$ ]]
[[ "$wolfie_asset_count" =~ ^[1-9][0-9]*$ ]]
[[ "$preserve_remote_functions" = "0" || "$preserve_remote_functions" = "1" ]]
[[ "$expected_current_release" = "none" ||
  "$expected_current_release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]

exec 9>"$releases_dir/.deploy.lock"
flock -n 9 || {
  echo "ERRO: já existe outro deploy em andamento." >&2
  exit 1
}
exec 8>"$compose_dir/.hub-activation.lock"
flock -n 8 || {
  echo "ERRO: a configuração pública do Hub está sendo ativada; rode o deploy novamente depois da conclusão." >&2
  exit 1
}

current_marker="$releases_dir/current"
if [[ "$expected_current_release" = "none" ]]; then
  if [[ -e "$current_marker" || -L "$current_marker" ]]; then
    echo "ERRO: a release-base mudou durante a preparação; rode o deploy novamente sobre o estado atual." >&2
    exit 1
  fi
else
  [[ -f "$current_marker" && ! -L "$current_marker" ]]
  IFS= read -r current_release_under_lock < "$current_marker"
  if [[ "$current_release_under_lock" != "$expected_current_release" ]]; then
    echo "ERRO: a release-base mudou durante a preparação ($expected_current_release -> $current_release_under_lock); rode o deploy novamente." >&2
    exit 1
  fi
fi

if [[ -d "$backups_dir" ]]; then
  shopt -s nullglob
  unresolved_activation_states=("$backups_dir"/release-*/ACTIVATION_STATE)
  unresolved_post_commit_failures=("$backups_dir"/release-*/POST_COMMIT_FAILURE)
  shopt -u nullglob
  for unresolved_activation_state in "${unresolved_activation_states[@]}"; do
    [[ -f "$unresolved_activation_state" && ! -L "$unresolved_activation_state" ]]
    unresolved_release_dir="$(basename -- "$(dirname -- "$unresolved_activation_state")")"
    unresolved_release_id="${unresolved_release_dir#release-}"
    [[ "$unresolved_release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
    IFS= read -r activation_state < "$unresolved_activation_state"
    activation_phase="${activation_state%%:*}"
    activation_state_release_id="${activation_state#*:}"
    [[ "$activation_state_release_id" = "$unresolved_release_id" ]]
    case "$activation_phase" in
      active | rolled_back) ;;
      *)
        echo "ERRO: existe ativação anterior não reconciliada em $unresolved_activation_state." >&2
        exit 1
        ;;
    esac
  done
  if ((${#unresolved_post_commit_failures[@]} > 0)); then
    echo "ERRO: existe falha pós-commit anterior não reconciliada em ${unresolved_post_commit_failures[0]}." >&2
    exit 1
  fi
fi

backup_dir="$backups_dir/release-$release_id"
marker_dir="$releases_dir/.migration-checksums"
current_marker="$releases_dir/current"
current_marker_backup="$backup_dir/current.previous"
current_marker_tmp="$releases_dir/.current-$release_id.tmp"
current_marker_rollback_tmp="$releases_dir/.current-$release_id.rollback.tmp"
activation_state_file="$backup_dir/ACTIVATION_STATE"
activation_state_tmp="$backup_dir/.ACTIVATION_STATE.tmp"
nginx_path="$compose_dir/nginx.conf"
nginx_next="$compose_dir/.nginx-$release_id.tmp"
current_marker_existed=0
current_marker_swapped=0
frontend_swapped=0
nginx_swapped=0
function_swapped=0
conversation_function_swapped=0
realtime_function_swapped=0
tts_function_swapped=0
pedagogical_function_swapped=0
context_function_swapped=0
hub_library_function_swapped=0
hub_material_sync_function_swapped=0
hub_checkout_function_swapped=0
hub_fulfillment_function_swapped=0
hub_ai_function_swapped=0
hub_tutor_function_swapped=0
asaas_webhook_function_swapped=0
shared_swapped=0
security_shared_swapped=()
account_invite_shared_swapped=0
commercial_policy_shared_swapped=0
ai_usage_shared_swapped=0
global_meeting_policy_shared_swapped=0
hub_billing_safety_shared_swapped=0
wolfie_product_access_shared_swapped=0
lead_contact_shared_swapped=0
evolution_send_shared_swapped=0
hardened_functions_swapped=()
rollback_owner_subshell=$BASH_SUBSHELL
rollback_started=0
database_committed=0
database_commit_unknown=0
database_release_manifest_checksum=""
HARDENED_FUNCTIONS=()
declare -A hardened_function_names=()
[[ -f "$release_dir/hardened-functions.txt" &&
  ! -L "$release_dir/hardened-functions.txt" ]]
while IFS= read -r function_name; do
  [[ "$function_name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
  [[ -z "${hardened_function_names[$function_name]+x}" ]]
  hardened_function_names[$function_name]=1
  HARDENED_FUNCTIONS+=("$function_name")
done < "$release_dir/hardened-functions.txt"
[[ ${#HARDENED_FUNCTIONS[@]} -ge 1 ]]

[[ -d "$release_dir" && ! -L "$release_dir" ]]
release_symlink="$(find "$release_dir" -type l -print -quit)"
[[ -z "$release_symlink" ]]
[[ -d "$release_dir/frontend-dist" && ! -L "$release_dir/frontend-dist" ]]
[[ -f "$release_dir/nginx.conf" && ! -L "$release_dir/nginx.conf" ]]
[[ -f "$nginx_path" && ! -L "$nginx_path" ]]
[[ -f "$release_dir/release-inputs.sha256" &&
  ! -L "$release_dir/release-inputs.sha256" ]]
(
  cd "$release_dir" &&
    sha256sum --check --strict --quiet release-inputs.sha256
)
frontend_id="$(cd "$compose_dir" && docker compose ps -q frontend)"
[[ -n "$frontend_id" ]]
frontend_image="$(docker inspect "$frontend_id" --format '{{.Image}}')"
[[ "$frontend_image" =~ ^sha256:[a-f0-9]{64}$ ]]
docker run --rm --entrypoint nginx \
  -v "$release_dir/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  "$frontend_image" -t >/dev/null
(
  set -Eeuo pipefail
  nginx_qa_dir="$(mktemp -d /tmp/wisewolf-nginx-release-qa.XXXXXX)"
  [[ "$nginx_qa_dir" =~ ^/tmp/wisewolf-nginx-release-qa\.[A-Za-z0-9]+$ ]]
  nginx_qa_container=""
  cleanup_nginx_qa() {
    if [[ "$nginx_qa_container" =~ ^[a-f0-9]{64}$ ]]; then
      docker rm -f "$nginx_qa_container" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$nginx_qa_dir"
  }
  trap cleanup_nginx_qa EXIT

  nginx_qa_container="$(docker run -d --rm \
    -v "$release_dir/frontend-dist:/usr/share/nginx/html:ro" \
    -v "$release_dir/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
    "$frontend_image")"
  [[ "$nginx_qa_container" =~ ^[a-f0-9]{64}$ ]]
  nginx_qa_ip="$(docker inspect "$nginx_qa_container" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
  [[ "$nginx_qa_ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]]

  nginx_qa_ready=0
  for attempt in {1..20}; do
    if curl -fsS --connect-timeout 2 --max-time 5 \
      -H 'Host: system.wisewolflanguage.com.br' \
      "http://$nginx_qa_ip/hub" >/dev/null 2>&1; then
      nginx_qa_ready=1
      break
    fi
    sleep 1
  done
  [[ "$nginx_qa_ready" = "1" ]]

  nginx_qa_request() {
    local host=$1 request_path=$2 output_file=$3
    curl -sS --connect-timeout 2 --max-time 10 \
      -o "$output_file" -w '%{http_code}' \
      -H "Host: $host" "http://$nginx_qa_ip$request_path"
  }

  pwa_refresh_asset="$(find "$release_dir/frontend-dist" -maxdepth 1 -type f -name 'pwa-critical-refresh-*.js' -printf '%f\n')"
  workbox_asset="$(find "$release_dir/frontend-dist" -maxdepth 1 -type f -name 'workbox-*.js' -printf '%f\n')"
  [[ "$pwa_refresh_asset" =~ ^pwa-critical-refresh-[A-Za-z0-9._-]+\.js$ ]]
  [[ "$workbox_asset" =~ ^workbox-[A-Za-z0-9._-]+\.js$ ]]
  [[ "$(nginx_qa_request hub.wisewolflanguage.com.br "/$pwa_refresh_asset" "$nginx_qa_dir/pwa-refresh.js")" = "200" ]]
  [[ "$(nginx_qa_request hub.wisewolflanguage.com.br "/$workbox_asset" "$nginx_qa_dir/workbox.js")" = "200" ]]

  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /hub/professores "$nginx_qa_dir/system-professores.html")" = "200" ]]
  grep -Fq '<link rel="canonical" href="https://hub.wisewolflanguage.com.br/professores">' \
    "$nginx_qa_dir/system-professores.html"
  [[ "$(nginx_qa_request hub.wisewolflanguage.com.br /professores "$nginx_qa_dir/hub-professores.html")" = "200" ]]
  grep -Fq '<link rel="canonical" href="https://hub.wisewolflanguage.com.br/professores">' \
    "$nginx_qa_dir/hub-professores.html"
  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /hub/termos "$nginx_qa_dir/system-termos.html")" = "200" ]]
  grep -Fq '<link rel="canonical" href="https://hub.wisewolflanguage.com.br/termos">' \
    "$nginx_qa_dir/system-termos.html"
  grep -Fq "fbq('init'" "$nginx_qa_dir/system-termos.html"
  [[ "$(nginx_qa_request hub.wisewolflanguage.com.br /termos "$nginx_qa_dir/hub-termos.html")" = "200" ]]
  grep -Fq '<link rel="canonical" href="https://hub.wisewolflanguage.com.br/termos">' \
    "$nginx_qa_dir/hub-termos.html"
  ! grep -E -i -q '(^|[^A-Za-z])fbq([^A-Za-z]|$)|Meta Pixel|facebook\.com/tr' \
    "$nginx_qa_dir/hub-termos.html"
  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /seja-professor "$nginx_qa_dir/seja-professor.html")" = "200" ]]
  grep -Fq '<title>Professor Negócio | Gestão para Professores de Inglês</title>' \
    "$nginx_qa_dir/seja-professor.html"
  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /new-saas "$nginx_qa_dir/new-saas.html")" = "200" ]]
  grep -Fq '<title>Diagnóstico para Escolas de Inglês | Wise Wolf School OS</title>' \
    "$nginx_qa_dir/new-saas.html"
  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /hub/rota-inexistente-seo "$nginx_qa_dir/system-404.html")" = "404" ]]
  grep -Fq '<meta name="robots" content="noindex, nofollow">' "$nginx_qa_dir/system-404.html"
  [[ "$(nginx_qa_request hub.wisewolflanguage.com.br /rota-inexistente-seo "$nginx_qa_dir/hub-404.html")" = "404" ]]
  grep -Fq '<meta name="robots" content="noindex, nofollow">' "$nginx_qa_dir/hub-404.html"
  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /__hub_host/professores/index.html "$nginx_qa_dir/internal.html")" = "404" ]]
  # Os dois hosts precisam entregar sitemap e robots: no host dedicado o
  # catch-all devolve 404, então a rota própria é a única coisa que os serve.
  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /sitemap.xml "$nginx_qa_dir/system-sitemap.xml")" = "200" ]]
  grep -Fq '<loc>https://system.wisewolflanguage.com.br/new-saas</loc>' \
    "$nginx_qa_dir/system-sitemap.xml"
  [[ "$(nginx_qa_request system.wisewolflanguage.com.br /robots.txt "$nginx_qa_dir/system-robots.txt")" = "200" ]]
  grep -Fq 'Sitemap: https://system.wisewolflanguage.com.br/sitemap.xml' \
    "$nginx_qa_dir/system-robots.txt"
  [[ "$(nginx_qa_request hub.wisewolflanguage.com.br /sitemap.xml "$nginx_qa_dir/hub-sitemap.xml")" = "200" ]]
  grep -Fq '<loc>https://hub.wisewolflanguage.com.br/saas-escolar</loc>' \
    "$nginx_qa_dir/hub-sitemap.xml"
  grep -Fq '<loc>https://hub.wisewolflanguage.com.br/termos</loc>' \
    "$nginx_qa_dir/hub-sitemap.xml"
  grep -Fq '<loc>https://hub.wisewolflanguage.com.br/privacidade</loc>' \
    "$nginx_qa_dir/hub-sitemap.xml"
  [[ "$(nginx_qa_request hub.wisewolflanguage.com.br /robots.txt "$nginx_qa_dir/hub-robots.txt")" = "200" ]]
  grep -Fq 'Sitemap: https://hub.wisewolflanguage.com.br/sitemap.xml' \
    "$nginx_qa_dir/hub-robots.txt"
)
if [[ "$preserve_remote_functions" != "1" ]]; then
[[ -s "$release_dir/functions/wolfie-activity/index.ts" ]]
[[ -s "$release_dir/functions/wolfie-brain/index.ts" ]]
[[ -s "$release_dir/functions/wolfie-realtime-session/index.ts" ]]
[[ -s "$release_dir/functions/wolfie-tts/index.ts" ]]
[[ -s "$release_dir/functions/submit-quiz/index.ts" ]]
[[ -s "$release_dir/functions/student-context/index.ts" ]]
[[ -s "$release_dir/functions/hub-library-access/index.ts" ]]
[[ -s "$release_dir/functions/sync-hub-material/index.ts" ]]
[[ -s "$release_dir/functions/create-hub-checkout/index.ts" ]]
[[ -s "$release_dir/functions/process-hub-fulfillment/index.ts" ]]
[[ -s "$release_dir/functions/pedagogical-content/index.ts" ]]
[[ -s "$release_dir/functions/wolf-tutor-api/index.ts" ]]
[[ -s "$release_dir/functions/asaas-webhook/index.ts" ]]
[[ -s "$release_dir/functions/_shared/request-auth.ts" ]]
[[ -s "$release_dir/functions/_shared/automation-auth.ts" ]]
[[ -s "$release_dir/functions/_shared/invite-registration.ts" ]]
[[ -s "$release_dir/functions/_shared/opportunity-dispatch.ts" ]]
[[ -s "$release_dir/functions/_shared/payment-auth.ts" ]]
[[ -s "$release_dir/functions/_shared/tenant-communication.ts" ]]
[[ -s "$release_dir/functions/_shared/tenant-legal-assets.ts" ]]
[[ -s "$release_dir/functions/_shared/account-invite.ts" ]]
[[ -s "$release_dir/functions/_shared/commercial-contact-policy.ts" ]]
[[ -s "$release_dir/functions/_shared/ai-usage.ts" ]]
[[ -s "$release_dir/functions/_shared/wolfie-global-meeting-policy.ts" ]]
[[ -s "$release_dir/functions/_shared/hub-billing-safety.ts" ]]
[[ -s "$release_dir/functions/_shared/wolfie-product-access.ts" ]]
[[ -s "$release_dir/functions/_shared/lead-contact.ts" ]]
[[ -s "$release_dir/functions/_shared/evolution-send.ts" ]]
[[ -s "$release_dir/functions/_shared/tenant-integration-broker.ts" ]]
for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  [[ -s "$release_dir/functions/$function_name/index.ts" ]]
done
fi

write_activation_state() {
  local activation_phase=$1
  case "$activation_phase" in
    prepared | code_staged | database_transaction_started | database_commit_unknown | database_committed | post_commit_failed | rollback_failed | active | rolled_back) ;;
    *) return 1 ;;
  esac
  [[ -d "$backup_dir" && ! -L "$backup_dir" ]]
  rm -f -- "$activation_state_tmp"
  printf '%s:%s\n' "$activation_phase" "$release_id" > "$activation_state_tmp"
  mv -f -- "$activation_state_tmp" "$activation_state_file"
}

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
  if [[ "$database_committed" = "1" || "$database_commit_unknown" = "1" ]]; then
    if [[ "$database_committed" = "1" ]]; then
      echo "ERRO: validação pós-commit falhou; mantendo banco, frontend e funções da mesma release." >&2
      write_activation_state post_commit_failed || true
      printf '%s\n' "post_commit_validation_failed:$release_id" \
        > "$backup_dir/POST_COMMIT_FAILURE"
    else
      echo "ERRO CRÍTICO: resultado do commit não pôde ser confirmado; mantendo o código novo para evitar incompatibilidade com um banco possivelmente atualizado." >&2
      write_activation_state database_commit_unknown || true
      printf '%s\n' "database_commit_unknown:$release_id:$database_release_manifest_checksum" \
        > "$backup_dir/DATABASE_COMMIT_UNKNOWN"
    fi
    rm -f -- "$current_marker_tmp" "$current_marker_rollback_tmp"
    printf '%s\n' "$release_id" > "$current_marker_tmp" &&
      mv -f -- "$current_marker_tmp" "$current_marker"
    if [[ "$preserve_remote_functions" != "1" ]]; then
      (
        cd "$supabase_dir" &&
          docker compose restart functions
      ) >/dev/null 2>&1 || true
    fi
    (
      cd "$compose_dir" &&
        docker compose up -d --force-recreate frontend
    ) >/dev/null 2>&1 || true
    exit "$exit_code"
  fi

  echo "ERRO: release falhou antes do commit; restaurando frontend e funções anteriores." >&2
  rollback_operation_failed=0
  trap 'rollback_operation_failed=1' ERR

  if [[ "$current_marker_swapped" = "1" ]]; then
    if [[ "$current_marker_existed" = "1" && -f "$current_marker_backup" ]]; then
      cp -a -- "$current_marker_backup" "$current_marker_rollback_tmp"
      mv -f -- "$current_marker_rollback_tmp" "$current_marker"
    else
      rm -f -- "$current_marker"
    fi
  fi
  rm -f -- "$current_marker_tmp" "$current_marker_rollback_tmp"

  rm -f -- "$nginx_next"
  if [[ "$nginx_swapped" = "1" && -f "$backup_dir/nginx.conf" ]]; then
    cp -a -- "$backup_dir/nginx.conf" "$nginx_next"
    mv -f -- "$nginx_next" "$nginx_path"
  fi

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
  if [[ "$conversation_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/wolfie-brain" ]]; then
      mv -- "$functions_dir/wolfie-brain" \
        "$backup_dir/failed-wolfie-brain"
    fi
    if [[ -d "$backup_dir/wolfie-brain" ]]; then
      mv -- "$backup_dir/wolfie-brain" "$functions_dir/wolfie-brain"
    fi
  fi
  if [[ "$realtime_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/wolfie-realtime-session" ]]; then
      mv -- "$functions_dir/wolfie-realtime-session" \
        "$backup_dir/failed-wolfie-realtime-session"
    fi
    if [[ -d "$backup_dir/wolfie-realtime-session" ]]; then
      mv -- "$backup_dir/wolfie-realtime-session" \
        "$functions_dir/wolfie-realtime-session"
    fi
  fi
  if [[ "$tts_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/wolfie-tts" ]]; then
      mv -- "$functions_dir/wolfie-tts" \
        "$backup_dir/failed-wolfie-tts"
    fi
    if [[ -d "$backup_dir/wolfie-tts" ]]; then
      mv -- "$backup_dir/wolfie-tts" "$functions_dir/wolfie-tts"
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
  if [[ "$hub_library_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/hub-library-access" ]]; then
      mv -- "$functions_dir/hub-library-access" "$backup_dir/failed-hub-library-access"
    fi
    if [[ -d "$backup_dir/hub-library-access" ]]; then
      mv -- "$backup_dir/hub-library-access" "$functions_dir/hub-library-access"
    fi
  fi
  if [[ "$hub_material_sync_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/sync-hub-material" ]]; then
      mv -- "$functions_dir/sync-hub-material" "$backup_dir/failed-sync-hub-material"
    fi
    if [[ -d "$backup_dir/sync-hub-material" ]]; then
      mv -- "$backup_dir/sync-hub-material" "$functions_dir/sync-hub-material"
    fi
  fi
  if [[ "$hub_checkout_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/create-hub-checkout" ]]; then
      mv -- "$functions_dir/create-hub-checkout" "$backup_dir/failed-create-hub-checkout"
    fi
    if [[ -d "$backup_dir/create-hub-checkout" ]]; then
      mv -- "$backup_dir/create-hub-checkout" "$functions_dir/create-hub-checkout"
    fi
  fi
  if [[ "$hub_fulfillment_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/process-hub-fulfillment" ]]; then
      mv -- "$functions_dir/process-hub-fulfillment" \
        "$backup_dir/failed-process-hub-fulfillment"
    fi
    if [[ -d "$backup_dir/process-hub-fulfillment" ]]; then
      mv -- "$backup_dir/process-hub-fulfillment" \
        "$functions_dir/process-hub-fulfillment"
    fi
  fi
  if [[ "$hub_ai_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/pedagogical-content" ]]; then
      mv -- "$functions_dir/pedagogical-content" "$backup_dir/failed-pedagogical-content"
    fi
    if [[ -d "$backup_dir/pedagogical-content" ]]; then
      mv -- "$backup_dir/pedagogical-content" "$functions_dir/pedagogical-content"
    fi
  fi
  if [[ "$hub_tutor_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/wolf-tutor-api" ]]; then
      mv -- "$functions_dir/wolf-tutor-api" "$backup_dir/failed-wolf-tutor-api"
    fi
    if [[ -d "$backup_dir/wolf-tutor-api" ]]; then
      mv -- "$backup_dir/wolf-tutor-api" "$functions_dir/wolf-tutor-api"
    fi
  fi
  if [[ "$asaas_webhook_function_swapped" = "1" ]]; then
    if [[ -d "$functions_dir/asaas-webhook" ]]; then
      mv -- "$functions_dir/asaas-webhook" "$backup_dir/failed-asaas-webhook"
    fi
    if [[ -d "$backup_dir/asaas-webhook" ]]; then
      mv -- "$backup_dir/asaas-webhook" "$functions_dir/asaas-webhook"
    fi
  fi
  if [[ "$shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/request-auth.ts" ]]; then
      cp -a -- "$backup_dir/request-auth.ts" \
        "$functions_dir/_shared/request-auth.ts"
    else
      rm -f -- "$functions_dir/_shared/request-auth.ts"
    fi
  fi
  if ((${#security_shared_swapped[@]} > 0)); then
    for shared_name in "${security_shared_swapped[@]}"; do
      if [[ -f "$backup_dir/$shared_name" ]]; then
        cp -a -- "$backup_dir/$shared_name" \
          "$functions_dir/_shared/$shared_name"
      else
        rm -f -- "$functions_dir/_shared/$shared_name"
      fi
    done
  fi
  if [[ "$account_invite_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/account-invite.ts" ]]; then
      cp -a -- "$backup_dir/account-invite.ts" \
        "$functions_dir/_shared/account-invite.ts"
    else
      rm -f -- "$functions_dir/_shared/account-invite.ts"
    fi
  fi
  if [[ "$commercial_policy_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/commercial-contact-policy.ts" ]]; then
      cp -a -- "$backup_dir/commercial-contact-policy.ts" \
        "$functions_dir/_shared/commercial-contact-policy.ts"
    else
      rm -f -- "$functions_dir/_shared/commercial-contact-policy.ts"
    fi
  fi
  if [[ "$ai_usage_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/ai-usage.ts" ]]; then
      cp -a -- "$backup_dir/ai-usage.ts" \
        "$functions_dir/_shared/ai-usage.ts"
    else
      rm -f -- "$functions_dir/_shared/ai-usage.ts"
    fi
  fi
  if [[ "$global_meeting_policy_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/wolfie-global-meeting-policy.ts" ]]; then
      cp -a -- "$backup_dir/wolfie-global-meeting-policy.ts" \
        "$functions_dir/_shared/wolfie-global-meeting-policy.ts"
    else
      rm -f -- "$functions_dir/_shared/wolfie-global-meeting-policy.ts"
    fi
  fi
  if [[ "$hub_billing_safety_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/hub-billing-safety.ts" ]]; then
      cp -a -- "$backup_dir/hub-billing-safety.ts" \
        "$functions_dir/_shared/hub-billing-safety.ts"
    else
      rm -f -- "$functions_dir/_shared/hub-billing-safety.ts"
    fi
  fi
  if [[ "$wolfie_product_access_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/wolfie-product-access.ts" ]]; then
      cp -a -- "$backup_dir/wolfie-product-access.ts" \
        "$functions_dir/_shared/wolfie-product-access.ts"
    else
      rm -f -- "$functions_dir/_shared/wolfie-product-access.ts"
    fi
  fi
  if [[ "$lead_contact_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/lead-contact.ts" ]]; then
      cp -a -- "$backup_dir/lead-contact.ts" \
        "$functions_dir/_shared/lead-contact.ts"
    else
      rm -f -- "$functions_dir/_shared/lead-contact.ts"
    fi
  fi
  if [[ "$evolution_send_shared_swapped" = "1" ]]; then
    if [[ -f "$backup_dir/evolution-send.ts" ]]; then
      cp -a -- "$backup_dir/evolution-send.ts" \
        "$functions_dir/_shared/evolution-send.ts"
    else
      rm -f -- "$functions_dir/_shared/evolution-send.ts"
    fi
  fi
  if ((${#hardened_functions_swapped[@]} > 0)); then
    for function_name in "${hardened_functions_swapped[@]}"; do
      if [[ -d "$functions_dir/$function_name" ]]; then
        mv -- "$functions_dir/$function_name" \
          "$backup_dir/failed-$function_name"
      fi
      if [[ -d "$backup_dir/$function_name" ]]; then
        mv -- "$backup_dir/$function_name" "$functions_dir/$function_name"
      fi
    done
  fi

  (
    cd "$compose_dir" &&
      docker compose up -d --force-recreate frontend
  ) >/dev/null 2>&1 || rollback_operation_failed=1
  if [[ "$preserve_remote_functions" != "1" ]]; then
    (
      cd "$supabase_dir" &&
        docker compose restart functions
    ) >/dev/null 2>&1 || rollback_operation_failed=1
  fi
  trap - ERR
  if [[ "$rollback_operation_failed" = "0" ]]; then
    write_activation_state rolled_back || true
  else
    write_activation_state rollback_failed || true
  fi
  exit "$exit_code"
}
[[ ! -e "$backup_dir" && ! -L "$backup_dir" ]]
mkdir -- "$backup_dir"
mkdir -p -- "$marker_dir"
[[ -d "$backup_dir" && ! -L "$backup_dir" ]]
[[ -d "$marker_dir" && ! -L "$marker_dir" ]]
write_activation_state prepared
trap restore_previous_release ERR
[[ ! -e "$current_marker_backup" && ! -L "$current_marker_backup" ]]
[[ ! -e "$current_marker_tmp" && ! -L "$current_marker_tmp" ]]
[[ ! -e "$current_marker_rollback_tmp" && ! -L "$current_marker_rollback_tmp" ]]
[[ ! -e "$nginx_next" && ! -L "$nginx_next" ]]
[[ ! -L "$current_marker" ]]
cp -a -- "$nginx_path" "$backup_dir/nginx.conf"
if [[ -f "$current_marker" ]]; then
  cp -a -- "$current_marker" "$current_marker_backup"
  current_marker_existed=1
elif [[ -e "$current_marker" ]]; then
  echo "ERRO: marcador de release atual não é um arquivo regular." >&2
  false
fi

sql_envelope_info() {
  local sql_path=$1
  local envelope_kind=$2
  awk -v envelope_kind="$envelope_kind" '
    function normalize_sql(value) {
      value = tolower(value)
      gsub(/[[:space:]]+/, " ", value)
      gsub(/^ +| +$/, "", value)
      return value
    }
    function append_statement(value) {
      if (statement_start_line == 0 && value !~ /^[[:space:]]*$/) {
        statement_start_line = NR
      }
      statement = statement value
    }
    function statement_label(normalized) {
      if (normalized == "begin") return "begin;"
      if (normalized == "commit") return "commit;"
      if (normalized == "rollback") return "rollback;"
      return "other"
    }
    function boundary_line_is(raw_line, expected, normalized) {
      normalized = tolower(raw_line)
      sub(/[[:space:]]*--.*$/, "", normalized)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", normalized)
      return normalized == expected
    }
    function record_statement(end_line, raw_line, normalized, label, allowed_savepoint, forbidden_transaction) {
      normalized = normalize_sql(statement)
      statement = ""
      if (normalized == "") {
        statement_start_line = 0
        return
      }

      statement_count++
      label = statement_label(normalized)
      if (statement_count == 1) {
        first_sql = label
        first_line = statement_start_line
        first_boundary_safe = statement_start_line == end_line && boundary_line_is(raw_line, label)
      }
      last_sql = label
      last_line = end_line
      last_boundary_safe = statement_start_line == end_line && boundary_line_is(raw_line, label)

      if (label == "begin;" || label == "commit;" || label == "rollback;") {
        transaction_control_count++
      } else {
        allowed_savepoint = envelope_kind == "test" && normalized ~ /^(savepoint|release savepoint|rollback to savepoint) [a-z][a-z0-9_]*$/
        forbidden_transaction = 0
        if (normalized ~ /^(begin|commit|rollback|abort)( .*)?$/) forbidden_transaction = 1
        if (normalized ~ /^(savepoint|release savepoint)( .*)?$/) forbidden_transaction = 1
        if (normalized ~ /^start transaction( .*)?$/) forbidden_transaction = 1
        if (normalized ~ /^end (work|transaction)( .*)?$/) forbidden_transaction = 1
        if (normalized ~ /^prepare transaction( .*)?$/) forbidden_transaction = 1
        if (!allowed_savepoint && forbidden_transaction) {
          forbidden_transaction_count++
        }
      }
      statement_start_line = 0
    }
    function record_meta(raw_meta, prefix, normalized, test_set_allowed, meta_allowed) {
      normalized = tolower(raw_meta)
      gsub(/[[:space:]]+/, " ", normalized)
      gsub(/^ +| +$/, "", normalized)
      recorded_meta = normalized
      meta_allowed = prefix ~ /^[[:space:]]*$/ || normalized == "\\gset"
      test_set_allowed = 0
      if (normalized ~ /^\\set [a-z][a-z0-9_]*_failed (true|false)$/) {
        test_set_allowed = 1
      }
      if (normalized ~ /^\\set [a-z][a-z0-9_]*_sqlstate ('\''\''|:sqlstate)$/) {
        test_set_allowed = 1
      }

      if (envelope_kind == "migration") {
        meta_allowed = meta_allowed && normalized == "\\set on_error_stop on"
      } else if (envelope_kind == "test") {
        test_meta_allowed = normalized ~ /^\\set on_error_stop (on|off)$/
        if (test_set_allowed || normalized == "\\if :error" ||
          normalized == "\\endif" || normalized == "\\gset") {
          test_meta_allowed = 1
        }
        meta_allowed = meta_allowed && test_meta_allowed
      } else {
        meta_allowed = 0
      }

      if (!meta_allowed) {
        forbidden_meta_count++
        return
      }
      if (normalized == "\\if :error") {
        conditional_depth++
      } else if (normalized == "\\endif") {
        if (conditional_depth == 0) {
          forbidden_meta_count++
        } else {
          conditional_depth--
        }
      }
    }
    {
      raw_line = $0
      line = $0 "\n"
      position = 1
      while (position <= length(line)) {
        character = substr(line, position, 1)
        next_character = substr(line, position + 1, 1)

        if (block_comment_depth > 0) {
          if (character == "/" && next_character == "*") {
            block_comment_depth++
            position += 2
          } else if (character == "*" && next_character == "/") {
            block_comment_depth--
            position += 2
          } else {
            position++
          }
          continue
        }
        if (dollar_tag != "") {
          if (substr(line, position, length(dollar_tag)) == dollar_tag) {
            position += length(dollar_tag)
            dollar_tag = ""
            append_statement(" ")
          } else {
            position++
          }
          continue
        }
        if (single_quote) {
          if (single_quote_escape && character == "\\") {
            position += 2
          } else if (character == "'\''" && next_character == "'\''") {
            position += 2
          } else if (character == "'\''") {
            single_quote = 0
            single_quote_escape = 0
            append_statement(" ")
            position++
          } else {
            position++
          }
          continue
        }
        if (double_quote) {
          if (character == "\"" && next_character == "\"") {
            position += 2
          } else if (character == "\"") {
            double_quote = 0
            append_statement(" ")
            position++
          } else {
            position++
          }
          continue
        }

        if (character == "-" && next_character == "-") {
          append_statement(" ")
          break
        }
        if (character == "/" && next_character == "*") {
          append_statement(" ")
          block_comment_depth = 1
          position += 2
          continue
        }
        if (character == "'\''") {
          previous_character = position > 1 ? substr(line, position - 1, 1) : ""
          before_previous_character = position > 2 ? substr(line, position - 2, 1) : ""
          single_quote_escape = tolower(previous_character) == "e" && (position <= 2 || before_previous_character !~ /[[:alnum:]_$]/)
          single_quote = 1
          append_statement(" ")
          position++
          continue
        }
        if (character == "\"") {
          double_quote = 1
          append_statement(" ")
          position++
          continue
        }
        if (character == "$") {
          dollar_candidate = substr(line, position)
          previous_character = position > 1 ? substr(line, position - 1, 1) : ""
          if (previous_character !~ /[[:alnum:]_$]/ && match(dollar_candidate, /^\$([[:alpha:]_][[:alnum:]_]*)?\$/)) {
            dollar_tag = substr(dollar_candidate, 1, RLENGTH)
            append_statement(" ")
            position += length(dollar_tag)
            continue
          }
        }
        if (character == "\\") {
          record_meta(substr(line, position), substr(raw_line, 1, position - 1))
          if (recorded_meta == "\\gset") {
            record_statement(NR, raw_line)
          }
          break
        }
        if (character == ";") {
          record_statement(NR, raw_line)
          position++
          continue
        }
        append_statement(tolower(character))
        position++
      }
    }
    END {
      if (normalize_sql(statement) != "") {
        record_statement(NR, raw_line)
      }
      if (block_comment_depth != 0 || dollar_tag != "" ||
        single_quote || double_quote) {
        lexical_error_count++
      }
      if (conditional_depth != 0) {
        forbidden_meta_count++
      }
      printf "%d\t%d\t%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\n",
        first_line + 0,
        last_line + 0,
        first_sql,
        last_sql,
        transaction_control_count + 0,
        forbidden_transaction_count + 0,
        forbidden_meta_count + 0,
        first_boundary_safe + 0,
        last_boundary_safe + 0,
        lexical_error_count + 0
    }
  ' "$sql_path"
}

emit_sql_payload() {
  local sql_path=$1
  local envelope_kind=$2
  local first_line last_line first_sql last_sql transaction_count forbidden_transaction_count meta_count
  local first_boundary_safe last_boundary_safe lexical_error_count
  IFS=$'\t' read -r \
    first_line last_line first_sql last_sql transaction_count forbidden_transaction_count meta_count \
    first_boundary_safe last_boundary_safe lexical_error_count \
    < <(sql_envelope_info "$sql_path" "$envelope_kind")

  local skip_first_line=0
  local skip_last_line=0
  if [[ "$envelope_kind" = "test" ||
    ("$first_sql" = "begin;" && "$last_sql" = "commit;") ]]; then
    skip_first_line=$first_line
    skip_last_line=$last_line
  fi

  awk -v skip_first_line="$skip_first_line" \
      -v skip_last_line="$skip_last_line" \
      -v envelope_kind="$envelope_kind" '
    NR == skip_first_line || NR == skip_last_line { next }
    {
      normalized = tolower($0)
      sub(/[[:space:]]*--.*$/, "", normalized)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", normalized)
      if (envelope_kind == "migration" &&
        normalized == "\\set on_error_stop on") {
        next
      }
      print
    }
  ' "$sql_path"
}

prepare_database_release_journal() {
  local expected_manifest_checksum=$1

  docker exec -i supabase-db \
    psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -v release_id="$release_id" \
    -v release_manifest_checksum="$expected_manifest_checksum" <<'SQL'
set statement_timeout = '60s';
create schema if not exists private;
revoke all on schema private from public, anon;
create table if not exists private.release_commit_journal (
  release_id text primary key,
  release_manifest_checksum text not null,
  release_state text not null default 'PREPARED',
  prepared_at timestamptz not null default clock_timestamp(),
  committed_at timestamptz,
  constraint release_commit_journal_release_id_format
    check (release_id ~ '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$'),
  constraint release_commit_journal_manifest_checksum_format
    check (release_manifest_checksum ~ '^[a-f0-9]{64}$'),
  constraint release_commit_journal_state_check
    check (release_state in ('PREPARED', 'IN_TRANSACTION', 'COMMITTED'))
);
alter table private.release_commit_journal
  add column if not exists release_state text not null default 'COMMITTED';
alter table private.release_commit_journal
  add column if not exists prepared_at timestamptz not null
    default clock_timestamp();
update private.release_commit_journal
set release_state = 'COMMITTED'
where release_state is null;
alter table private.release_commit_journal
  alter column release_state set default 'PREPARED';
alter table private.release_commit_journal
  alter column release_state set not null;
alter table private.release_commit_journal
  alter column committed_at drop not null;
do $journal_constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'private.release_commit_journal'::regclass
      and conname = 'release_commit_journal_state_check'
  ) then
    alter table private.release_commit_journal
      add constraint release_commit_journal_state_check
      check (release_state in ('PREPARED', 'IN_TRANSACTION', 'COMMITTED'));
  end if;
end;
$journal_constraint$;
alter table private.release_commit_journal enable row level security;
revoke all on table private.release_commit_journal
  from public, anon, authenticated, service_role;
insert into private.release_commit_journal (
  release_id,
  release_manifest_checksum,
  release_state,
  prepared_at,
  committed_at
) values (
  :'release_id',
  :'release_manifest_checksum',
  'PREPARED',
  clock_timestamp(),
  null
)
on conflict (release_id) do nothing;
select 1 / pg_catalog.count(*)
from private.release_commit_journal
where release_id = :'release_id'
  and release_manifest_checksum = :'release_manifest_checksum'
  and release_state = 'PREPARED';
SQL
}

reconcile_database_release_commit() {
  local expected_manifest_checksum=$1
  local commit_outcome

  if ! commit_outcome="$(
    docker exec -i supabase-db \
      psql -X -qAt -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
      -v release_id="$release_id" \
      -v release_manifest_checksum="$expected_manifest_checksum" <<'SQL'
set statement_timeout = '60s';
\o /dev/null
select pg_advisory_lock(982451653, 1431655765);
\o
select to_regclass('private.release_commit_journal') is not null as journal_exists \gset
\if :journal_exists
select case
  when exists (
    select 1
    from private.release_commit_journal
    where release_id = :'release_id'
      and release_manifest_checksum = :'release_manifest_checksum'
      and release_state = 'COMMITTED'
  ) then 'committed'
  when exists (
    select 1
    from private.release_commit_journal
    where release_id = :'release_id'
      and release_manifest_checksum = :'release_manifest_checksum'
      and release_state = 'PREPARED'
  ) then 'rolled_back'
  when exists (
    select 1
    from private.release_commit_journal
    where release_id = :'release_id'
  ) then 'mismatch'
  else 'unknown'
end;
\else
select 'unknown';
\endif
SQL
  )"; then
    printf 'unknown'
    return 0
  fi

  case "$commit_outcome" in
    committed | rolled_back) printf '%s' "$commit_outcome" ;;
    *) printf 'unknown' ;;
  esac
}

run_database_release() {
shopt -s nullglob
database_tests=("$release_dir"/tests/*.sql)
shopt -u nullglob
expected_database_test_count="$(
  awk '$2 ~ /^tests\/[A-Za-z0-9_]+\.sql$/ {count++} END {print count + 0}' \
    "$release_dir/release-inputs.sha256"
)"
[[ "$expected_database_test_count" =~ ^[1-9][0-9]*$ ]]
[[ ${#database_tests[@]} -eq "$expected_database_test_count" ]]
for database_test in "${database_tests[@]}"; do
  [[ -s "$database_test" ]]
  IFS=$'\t' read -r \
    first_line last_line first_sql last_sql transaction_count forbidden_transaction_count meta_count \
    first_boundary_safe last_boundary_safe lexical_error_count \
    < <(sql_envelope_info "$database_test" test)
  if [[ "$first_sql" != "begin;" || "$last_sql" != "rollback;" ||
    "$transaction_count" != "2" || "$forbidden_transaction_count" != "0" ||
    "$meta_count" != "0" || "$first_boundary_safe" != "1" ||
    "$last_boundary_safe" != "1" || "$lexical_error_count" != "0" ]]; then
    echo "ERRO: teste SQL possui envelope, sintaxe lexical ou diretiva psql incompatível: $database_test" >&2
    return 1
  fi
done

shopt -s nullglob
migration_files=("$release_dir"/migrations/*.sql)
shopt -u nullglob
expected_migration_count="$(
  awk '$2 ~ /^migrations\/[0-9]+_[A-Za-z0-9_]+\.sql$/ {count++} END {print count + 0}' \
    "$release_dir/release-inputs.sha256"
)"
[[ "$expected_migration_count" =~ ^[1-9][0-9]*$ ]]
[[ ${#migration_files[@]} -eq "$expected_migration_count" ]]
unapplied_migrations=()
unapplied_markers=()
unapplied_checksums=()
for migration_path in "${migration_files[@]}"; do
  migration_file="$(basename -- "$migration_path")"
  [[ "$migration_file" =~ ^([0-9]{14})_[A-Za-z0-9_]+\.sql$ ]]
  migration_version="${BASH_REMATCH[1]}"
  IFS=$'\t' read -r \
    first_line last_line first_sql last_sql transaction_count forbidden_transaction_count meta_count \
    first_boundary_safe last_boundary_safe lexical_error_count \
    < <(sql_envelope_info "$migration_path" migration)
  migration_is_wrapped=0
  if [[ "$first_sql" = "begin;" && "$last_sql" = "commit;" &&
    "$transaction_count" = "2" && "$first_boundary_safe" = "1" &&
    "$last_boundary_safe" = "1" ]]; then
    migration_is_wrapped=1
  fi
  if [[ "$meta_count" != "0" || "$forbidden_transaction_count" != "0" ||
    "$lexical_error_count" != "0" ||
    ("$migration_is_wrapped" = "0" && "$transaction_count" != "0") ]]; then
    echo "ERRO: migration possui envelope, sintaxe lexical ou diretiva psql incompatível: $migration_file" >&2
    return 1
  fi
  migration_checksum="$(sha256sum "$migration_path" | awk '{print $1}')"
  [[ "$migration_checksum" =~ ^[a-f0-9]{64}$ ]]
  existing_marker="$(
    find "$marker_dir" -maxdepth 1 -type f \
      -name "${migration_version}-*.sha256" -print -quit
  )"
  expected_marker="$marker_dir/${migration_version}-${migration_checksum}.sha256"
  if [[ -n "$existing_marker" && "$existing_marker" != "$expected_marker" ]]; then
    echo "ERRO: a migration $migration_version já foi aplicada com outro checksum; crie uma nova migration." >&2
    return 1
  fi
  if [[ ! -f "$expected_marker" ]]; then
    unapplied_migrations+=("$migration_path")
    unapplied_markers+=("$expected_marker")
    unapplied_checksums+=("$migration_checksum")
  fi
done

if [[ "${1:-}" = "validate-only" ]]; then
  return 0
fi

if ((${#unapplied_migrations[@]} > 0)); then
  database_release_manifest_checksum="$(
    sha256sum "$release_dir/release-inputs.sha256" | awk '{print $1}'
  )"
  [[ "$database_release_manifest_checksum" =~ ^[a-f0-9]{64}$ ]]
  if ! prepare_database_release_journal \
    "$database_release_manifest_checksum"; then
    prepare_database_release_journal "$database_release_manifest_checksum"
  fi
  database_backup_tmp="$backup_dir/postgres-before-migration.dump.tmp"
  database_backup="$backup_dir/postgres-before-migration.dump"
  echo "== Backup do banco antes das migrations =="
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

  echo "== Migrations e testes SQL na mesma transação =="
  database_release_sql="$backup_dir/database-release.sql.tmp"
  rm -f -- "$database_release_sql"
  {
    printf 'begin;\n\n'
    printf 'select pg_advisory_xact_lock(982451653, 1431655765);\n\n'
    cat <<'SQL'
update private.release_commit_journal
set release_state = 'IN_TRANSACTION'
where release_id = :'release_id'
  and release_manifest_checksum = :'release_manifest_checksum'
  and release_state = 'PREPARED';
select 1 / pg_catalog.count(*)
from private.release_commit_journal
where release_id = :'release_id'
  and release_manifest_checksum = :'release_manifest_checksum'
  and release_state = 'IN_TRANSACTION';

SQL
    for migration_path in "${unapplied_migrations[@]}"; do
      emit_sql_payload "$migration_path" migration
      printf '\n'
    done

    database_test_index=0
    for database_test in "${database_tests[@]}"; do
      database_test_savepoint="release_database_test_$database_test_index"
      printf 'savepoint %s;\n' "$database_test_savepoint"
      emit_sql_payload "$database_test" test
      printf '\n\\set ON_ERROR_STOP on\n'
      printf 'rollback to savepoint %s;\n' "$database_test_savepoint"
      printf 'release savepoint %s;\n\n' "$database_test_savepoint"
      database_test_index=$((database_test_index + 1))
    done
    cat <<'SQL'
update private.release_commit_journal
set release_state = 'COMMITTED',
    committed_at = clock_timestamp()
where release_id = :'release_id'
  and release_manifest_checksum = :'release_manifest_checksum'
  and release_state = 'IN_TRANSACTION';
select 1 / pg_catalog.count(*)
from private.release_commit_journal
where release_id = :'release_id'
  and release_manifest_checksum = :'release_manifest_checksum'
  and release_state = 'COMMITTED';

SQL
    printf 'commit;\n'
  } > "$database_release_sql"
  [[ -s "$database_release_sql" ]]
  write_activation_state database_transaction_started
  docker exec -i supabase-db \
    psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -v release_id="$release_id" \
    -v release_manifest_checksum="$database_release_manifest_checksum" \
    < "$database_release_sql" || true
  database_commit_outcome="$(
    reconcile_database_release_commit "$database_release_manifest_checksum"
  )"
  case "$database_commit_outcome" in
    committed)
      database_committed=1
      ;;
    rolled_back)
      return 1
      ;;
    *)
      database_commit_unknown=1
      write_activation_state database_commit_unknown
      return 1
      ;;
  esac
  write_activation_state database_committed

  for marker_index in "${!unapplied_markers[@]}"; do
    marker_tmp="${unapplied_markers[$marker_index]}.tmp"
    rm -f -- "$marker_tmp"
    printf '%s\n' "${unapplied_checksums[$marker_index]}" \
      > "$marker_tmp"
    mv -- "$marker_tmp" "${unapplied_markers[$marker_index]}"
  done
  rm -f -- "$database_release_sql" || true
else
  echo "== Testes SQL transacionais do Wolfie =="
  for database_test in "${database_tests[@]}"; do
    docker exec -i supabase-db \
      psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
      < "$database_test"
  done
fi

docker exec -i supabase-db \
  psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
do $verify$
begin
  if not exists (
    select 1
    from pg_extension
    where extname = 'vector'
  ) then
    raise exception 'planner_verification_vector_missing';
  end if;

  if to_regclass('public.planner_ai_runs') is null
    or to_regclass('public.student_learning_memories') is null
    or to_regclass('public.ai_knowledge_bases') is null
    or to_regclass('public.ai_knowledge_documents') is null
    or to_regclass('public.ai_knowledge_chunks') is null
  then
    raise exception 'planner_verification_table_missing';
  end if;

  if to_regprocedure(
    'public.match_wise_wolf_knowledge(text,uuid,extensions.vector,integer,double precision)'
  ) is null
    or to_regprocedure('public.save_planner_ai_run(uuid,uuid)') is null
  then
    raise exception 'planner_verification_function_missing';
  end if;

  if not exists (
    select 1
    from pg_class
    where oid = 'public.ai_knowledge_chunks'::regclass
      and relrowsecurity
  ) then
    raise exception 'planner_verification_rls_missing';
  end if;

  if has_table_privilege(
    'authenticated',
    'public.ai_knowledge_chunks',
    'select'
  ) then
    raise exception 'planner_verification_browser_privilege_present';
  end if;

  if to_regprocedure('public.set_ai_team_config(jsonb)') is null
     or to_regprocedure('private.commercial_phones_match(text,text)') is null then
    raise exception 'commercial_ai_guard_function_missing';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'reconcile_student_commercial_state'
       and not tgisinternal
  ) then
    raise exception 'commercial_ai_guard_trigger_missing';
  end if;

  if position(
    'tenant_id IS DISTINCT FROM NEW.tenant_id'
    in pg_get_functiondef(
      'private.set_single_primary_tenant_membership()'::regprocedure
    )
  ) = 0 then
    raise exception 'tenant_membership_idempotency_guard_missing';
  end if;

  if exists (
    select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
     where procedure.prokind = 'f'
       and namespace.nspname not in ('pg_catalog', 'information_schema')
       and (
         procedure.prosrc ilike '%.supabase.co%'
         or procedure.prosrc ilike '%dvalxbtngopxopzcbfdm%'
       )
  ) then
    raise exception 'hosted_supabase_function_reference_present';
  end if;
  if exists (
    select 1
      from cron.job
     where active
       and (
         command ilike '%.supabase.co%'
         or command ilike '%dvalxbtngopxopzcbfdm%'
       )
  ) then
    raise exception 'hosted_supabase_cron_reference_present';
  end if;
  if exists (
    select 1
      from net.http_request_queue
     where url ilike '%.supabase.co%'
        or url ilike '%dvalxbtngopxopzcbfdm%'
  ) then
    raise exception 'hosted_supabase_http_request_present';
  end if;
  if exists (select 1 from pg_foreign_server) then
    raise exception 'foreign_database_server_present';
  end if;

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
end
$verify$;
SQL
}

echo "== Validação transacional do pacote SQL =="
run_database_release validate-only

if [[ "$preserve_remote_functions" != "1" ]]; then
  (
    cd "$supabase_dir" &&
      docker compose stop functions
  )
fi
(
  cd "$compose_dir" &&
    docker compose stop frontend
)

if [[ -d "$app_dir/dist" ]]; then
  mv -- "$app_dir/dist" "$backup_dir/frontend-dist"
fi
frontend_swapped=1
cp -a -- "$release_dir/frontend-dist" "$app_dir/dist"
cp -a -- "$release_dir/nginx.conf" "$nginx_next"
chmod 0644 "$nginx_next"
nginx_swapped=1
mv -f -- "$nginx_next" "$nginx_path"

if [[ "$preserve_remote_functions" != "1" ]]; then
if [[ -d "$functions_dir/wolfie-activity" ]]; then
  mv -- "$functions_dir/wolfie-activity" "$backup_dir/wolfie-activity"
fi
function_swapped=1
cp -a -- "$release_dir/functions/wolfie-activity" \
  "$functions_dir/wolfie-activity"

if [[ -d "$functions_dir/wolfie-brain" ]]; then
  mv -- "$functions_dir/wolfie-brain" "$backup_dir/wolfie-brain"
fi
conversation_function_swapped=1
cp -a -- "$release_dir/functions/wolfie-brain" \
  "$functions_dir/wolfie-brain"

if [[ -d "$functions_dir/wolfie-realtime-session" ]]; then
  mv -- "$functions_dir/wolfie-realtime-session" \
    "$backup_dir/wolfie-realtime-session"
fi
realtime_function_swapped=1
cp -a -- "$release_dir/functions/wolfie-realtime-session" \
  "$functions_dir/wolfie-realtime-session"

if [[ -d "$functions_dir/wolfie-tts" ]]; then
  mv -- "$functions_dir/wolfie-tts" "$backup_dir/wolfie-tts"
fi
tts_function_swapped=1
cp -a -- "$release_dir/functions/wolfie-tts" \
  "$functions_dir/wolfie-tts"

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

if [[ -d "$functions_dir/hub-library-access" ]]; then
  mv -- "$functions_dir/hub-library-access" "$backup_dir/hub-library-access"
fi
hub_library_function_swapped=1
cp -a -- "$release_dir/functions/hub-library-access" \
  "$functions_dir/hub-library-access"

if [[ -d "$functions_dir/sync-hub-material" ]]; then
  mv -- "$functions_dir/sync-hub-material" "$backup_dir/sync-hub-material"
fi
hub_material_sync_function_swapped=1
cp -a -- "$release_dir/functions/sync-hub-material" \
  "$functions_dir/sync-hub-material"

if [[ -d "$functions_dir/create-hub-checkout" ]]; then
  mv -- "$functions_dir/create-hub-checkout" "$backup_dir/create-hub-checkout"
fi
hub_checkout_function_swapped=1
cp -a -- "$release_dir/functions/create-hub-checkout" \
  "$functions_dir/create-hub-checkout"

if [[ -d "$functions_dir/process-hub-fulfillment" ]]; then
  mv -- "$functions_dir/process-hub-fulfillment" \
    "$backup_dir/process-hub-fulfillment"
fi
hub_fulfillment_function_swapped=1
cp -a -- "$release_dir/functions/process-hub-fulfillment" \
  "$functions_dir/process-hub-fulfillment"

if [[ -d "$functions_dir/pedagogical-content" ]]; then
  mv -- "$functions_dir/pedagogical-content" "$backup_dir/pedagogical-content"
fi
hub_ai_function_swapped=1
cp -a -- "$release_dir/functions/pedagogical-content" \
  "$functions_dir/pedagogical-content"

if [[ -d "$functions_dir/wolf-tutor-api" ]]; then
  mv -- "$functions_dir/wolf-tutor-api" "$backup_dir/wolf-tutor-api"
fi
hub_tutor_function_swapped=1
cp -a -- "$release_dir/functions/wolf-tutor-api" \
  "$functions_dir/wolf-tutor-api"

if [[ -d "$functions_dir/asaas-webhook" ]]; then
  mv -- "$functions_dir/asaas-webhook" "$backup_dir/asaas-webhook"
fi
asaas_webhook_function_swapped=1
cp -a -- "$release_dir/functions/asaas-webhook" \
  "$functions_dir/asaas-webhook"

if [[ -f "$functions_dir/_shared/request-auth.ts" ]]; then
  cp -a -- "$functions_dir/_shared/request-auth.ts" \
    "$backup_dir/request-auth.ts"
fi
shared_swapped=1
cp -a -- "$release_dir/functions/_shared/request-auth.ts" \
  "$functions_dir/_shared/request-auth.ts"

for shared_name in automation-auth.ts invite-registration.ts opportunity-dispatch.ts payment-auth.ts tenant-communication.ts tenant-legal-assets.ts tenant-integration-broker.ts; do
  if [[ -f "$functions_dir/_shared/$shared_name" ]]; then
    cp -a -- "$functions_dir/_shared/$shared_name" \
      "$backup_dir/$shared_name"
  fi
  security_shared_swapped+=("$shared_name")
  cp -a -- "$release_dir/functions/_shared/$shared_name" \
    "$functions_dir/_shared/$shared_name"
done

if [[ -f "$functions_dir/_shared/account-invite.ts" ]]; then
  cp -a -- "$functions_dir/_shared/account-invite.ts" \
    "$backup_dir/account-invite.ts"
fi
account_invite_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/account-invite.ts" \
  "$functions_dir/_shared/account-invite.ts"

if [[ -f "$functions_dir/_shared/commercial-contact-policy.ts" ]]; then
  cp -a -- "$functions_dir/_shared/commercial-contact-policy.ts" \
    "$backup_dir/commercial-contact-policy.ts"
fi
commercial_policy_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/commercial-contact-policy.ts" \
  "$functions_dir/_shared/commercial-contact-policy.ts"

if [[ -f "$functions_dir/_shared/ai-usage.ts" ]]; then
  cp -a -- "$functions_dir/_shared/ai-usage.ts" \
    "$backup_dir/ai-usage.ts"
fi
ai_usage_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/ai-usage.ts" \
  "$functions_dir/_shared/ai-usage.ts"

if [[ -f "$functions_dir/_shared/wolfie-global-meeting-policy.ts" ]]; then
  cp -a -- "$functions_dir/_shared/wolfie-global-meeting-policy.ts" \
    "$backup_dir/wolfie-global-meeting-policy.ts"
fi
global_meeting_policy_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/wolfie-global-meeting-policy.ts" \
  "$functions_dir/_shared/wolfie-global-meeting-policy.ts"

if [[ -f "$functions_dir/_shared/hub-billing-safety.ts" ]]; then
  cp -a -- "$functions_dir/_shared/hub-billing-safety.ts" \
    "$backup_dir/hub-billing-safety.ts"
fi
hub_billing_safety_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/hub-billing-safety.ts" \
  "$functions_dir/_shared/hub-billing-safety.ts"

if [[ -f "$functions_dir/_shared/wolfie-product-access.ts" ]]; then
  cp -a -- "$functions_dir/_shared/wolfie-product-access.ts" \
    "$backup_dir/wolfie-product-access.ts"
fi
wolfie_product_access_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/wolfie-product-access.ts" \
  "$functions_dir/_shared/wolfie-product-access.ts"

if [[ -f "$functions_dir/_shared/lead-contact.ts" ]]; then
  cp -a -- "$functions_dir/_shared/lead-contact.ts" \
    "$backup_dir/lead-contact.ts"
fi
lead_contact_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/lead-contact.ts" \
  "$functions_dir/_shared/lead-contact.ts"

if [[ -f "$functions_dir/_shared/evolution-send.ts" ]]; then
  cp -a -- "$functions_dir/_shared/evolution-send.ts" \
    "$backup_dir/evolution-send.ts"
fi
evolution_send_shared_swapped=1
cp -a -- "$release_dir/functions/_shared/evolution-send.ts" \
  "$functions_dir/_shared/evolution-send.ts"

for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  if [[ -d "$functions_dir/$function_name" ]]; then
    mv -- "$functions_dir/$function_name" "$backup_dir/$function_name"
  fi
  hardened_functions_swapped+=("$function_name")
  cp -a -- "$release_dir/functions/$function_name" \
    "$functions_dir/$function_name"
done
fi

write_activation_state code_staged
run_database_release

if [[ "$preserve_remote_functions" != "1" ]]; then
  if ! (
    cd "$supabase_dir" &&
    docker compose restart functions
  ); then
    false
  fi
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

wait_for_service_http_status() {
  local expected_status=$1
  local check_name=$2
  local actual_status=
  local attempt
  shift 2

  [[ "$service_role_key" =~ ^[A-Za-z0-9._-]{20,}$ ]]
  for attempt in {1..20}; do
    actual_status="$(
      curl -s -o /dev/null -w '%{http_code}' \
        --connect-timeout 5 --max-time 15 \
        --config <(
          printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' \
            "$service_role_key" "$service_role_key"
        ) \
        "$@" || true
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
wait_for_http_status 200 "landing Professor Negócio" "$public_url/seja-professor"
wait_for_http_status 200 "landing de diagnóstico escolar" "$public_url/new-saas"
wait_for_http_status 200 "frontend do Wise Wolf Hub" "$public_url/hub"
wait_for_http_status 200 "landing para professores do Hub" "$public_url/hub/professores"
wait_for_http_status 200 "landing para escolas do Hub" "$public_url/hub/escolas"
wait_for_http_status 200 "landing da biblioteca do Hub" "$public_url/hub/biblioteca"
wait_for_http_status 200 "landing do Educador IA" "$public_url/hub/educador-ia"
wait_for_http_status 200 "landing do Wolfie no Hub" "$public_url/hub/wolfie"
wait_for_http_status 200 "landing do SaaS Escolar no Hub" "$public_url/hub/saas-escolar"
wait_for_http_status 200 "Termos de Uso do Hub" "$public_url/hub/termos"
wait_for_http_status 200 "Política de Privacidade do Hub" "$public_url/hub/privacidade"
wait_for_http_status 404 "rota desconhecida do Hub" "$public_url/hub/rota-inexistente-seo"
wait_for_http_status 200 "sitemap do Hub" "$public_url/sitemap.xml"
wait_for_http_status 200 "robots do Hub" "$public_url/robots.txt"

hub_seo_smoke_dir="$backup_dir/hub-seo-smoke"
[[ ! -e "$hub_seo_smoke_dir" && ! -L "$hub_seo_smoke_dir" ]]
mkdir -- "$hub_seo_smoke_dir"
curl -fsS --retry 3 --retry-connrefused --retry-max-time 45 \
  --connect-timeout 5 --max-time 20 \
  "$public_url/hub/professores" > "$hub_seo_smoke_dir/professores.html"
grep -Fq '<title>Plataforma para Professores de Inglês | Wise Wolf</title>' \
  "$hub_seo_smoke_dir/professores.html"
grep -Fq '<link rel="canonical" href="https://hub.wisewolflanguage.com.br/professores">' \
  "$hub_seo_smoke_dir/professores.html"
grep -Fq '<meta property="og:image" content="https://hub.wisewolflanguage.com.br/assets/hub/marketing/hub-overview-og.webp">' \
  "$hub_seo_smoke_dir/professores.html"
curl -fsS --retry 3 --retry-connrefused --retry-max-time 45 \
  --connect-timeout 5 --max-time 20 \
  "$public_url/seja-professor" > "$hub_seo_smoke_dir/seja-professor.html"
grep -Fq '<title>Professor Negócio | Gestão para Professores de Inglês</title>' \
  "$hub_seo_smoke_dir/seja-professor.html"
curl -fsS --retry 3 --retry-connrefused --retry-max-time 45 \
  --connect-timeout 5 --max-time 20 \
  "$public_url/new-saas" > "$hub_seo_smoke_dir/new-saas.html"
grep -Fq '<title>Diagnóstico para Escolas de Inglês | Wise Wolf School OS</title>' \
  "$hub_seo_smoke_dir/new-saas.html"
curl -sS --retry 3 --retry-connrefused --retry-max-time 45 \
  --connect-timeout 5 --max-time 20 \
  "$public_url/hub/rota-inexistente-seo" > "$hub_seo_smoke_dir/404.html"
grep -Fq '<meta name="robots" content="noindex, nofollow">' \
  "$hub_seo_smoke_dir/404.html"
grep -Fq 'Esta página saiu da trilha.' "$hub_seo_smoke_dir/404.html"

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

wait_for_http_status 200 "preflight do Wolfie" \
  -X OPTIONS "$api_url/functions/v1/wolfie-activity"
wait_for_http_status 401 "autenticação do Wolfie" \
  -X POST "$api_url/functions/v1/wolfie-activity" \
  -H 'Content-Type: application/json' \
  --data '{"action":"overview"}'
wait_for_http_status 200 "preflight da conversa do Wolfie" \
  -X OPTIONS "$api_url/functions/v1/wolfie-brain"
wait_for_http_status 401 "autenticação da conversa do Wolfie" \
  -X POST "$api_url/functions/v1/wolfie-brain" \
  -H 'Content-Type: application/json' \
  --data '{"message":"Hello"}'
wait_for_http_status 200 "preflight do Wolfie ao vivo" \
  -X OPTIONS "$api_url/functions/v1/wolfie-realtime-session"
wait_for_http_status 401 "autenticação do Wolfie ao vivo" \
  -X POST "$api_url/functions/v1/wolfie-realtime-session" \
  -H 'Content-Type: application/sdp' \
  --data 'v=0'
wait_for_http_status 200 "preflight da voz do Wolfie" \
  -X OPTIONS "$api_url/functions/v1/wolfie-tts"
wait_for_http_status 401 "autenticação da voz do Wolfie" \
  -X POST "$api_url/functions/v1/wolfie-tts" \
  -H 'Content-Type: application/json' \
  --data '{"text":"Hello"}'
wait_for_http_status 200 "preflight do Planner AI" \
  -X OPTIONS "$api_url/functions/v1/lesson-planner"
wait_for_http_status 401 "autenticação do Planner AI" \
  -X POST "$api_url/functions/v1/lesson-planner" \
  -H 'Content-Type: application/json' \
  --data '{"action":"generate","student_id":"00000000-0000-4000-8000-000000000000"}'
wait_for_http_status 200 "preflight do quiz pedagógico" \
  -X OPTIONS "$api_url/functions/v1/submit-quiz"
wait_for_http_status 401 "autenticação do quiz pedagógico" \
  -X POST "$api_url/functions/v1/submit-quiz" \
  -H 'Content-Type: application/json' \
  --data '{"bookPart":"A1-1","answers":[]}'
wait_for_http_status 401 "autenticação do contexto do aluno" \
  -X POST "$api_url/functions/v1/student-context" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight da biblioteca do Hub" \
  -X OPTIONS "$api_url/functions/v1/hub-library-access"
wait_for_http_status 401 "autenticação da biblioteca do Hub" \
  -X POST "$api_url/functions/v1/hub-library-access" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight da sincronização de materiais do Hub" \
  -X OPTIONS "$api_url/functions/v1/sync-hub-material"
wait_for_http_status 401 "autenticação da sincronização de materiais do Hub" \
  -X POST "$api_url/functions/v1/sync-hub-material" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight do checkout do Hub" \
  -X OPTIONS "$api_url/functions/v1/create-hub-checkout"
wait_for_http_status 401 "autenticação do checkout do Hub" \
  -X POST "$api_url/functions/v1/create-hub-checkout" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight do fulfillment do Hub" \
  -X OPTIONS "$api_url/functions/v1/process-hub-fulfillment"
wait_for_http_status 401 "autenticação do fulfillment do Hub" \
  -X POST "$api_url/functions/v1/process-hub-fulfillment" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight da gestão de status do Hub" \
  -X OPTIONS "$api_url/functions/v1/manage-hub-account-status"
wait_for_http_status 401 "autenticação da gestão de status do Hub" \
  -X POST "$api_url/functions/v1/manage-hub-account-status" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight do cancelamento do Hub" \
  -X OPTIONS "$api_url/functions/v1/cancel-hub-subscription"
wait_for_http_status 401 "autenticação do cancelamento do Hub" \
  -X POST "$api_url/functions/v1/cancel-hub-subscription" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight do checkout SaaS" \
  -X OPTIONS "$api_url/functions/v1/create-saas-checkout"
wait_for_http_status 400 "validação do checkout SaaS" \
  -X POST "$api_url/functions/v1/create-saas-checkout" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 200 "preflight da IA do Hub" \
  -X OPTIONS "$api_url/functions/v1/pedagogical-content"
wait_for_http_status 401 "autenticação da IA do Hub" \
  -X POST "$api_url/functions/v1/pedagogical-content" \
  -H 'Content-Type: application/json' \
  --data '{"hubMode":true,"prompt":"teste de autenticação sem credenciais"}'
wait_for_http_status 200 "preflight do Wolfie do Hub" \
  -X OPTIONS "$api_url/functions/v1/wolf-tutor-api"
wait_for_http_status 401 "autenticação do Wolfie do Hub" \
  -X POST "$api_url/functions/v1/wolf-tutor-api" \
  -H 'Content-Type: application/json' \
  --data '{"hubMode":true,"text":"Hello"}'
wait_for_http_status 401 "token do webhook Asaas" \
  -X POST "$api_url/functions/v1/asaas-webhook" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 410 "desativação do webhook legado Kiwify" \
  -X POST "$api_url/functions/v1/kiwify-webhook" \
  -H 'Content-Type: application/json' \
  --data '{}'
for protected_function in \
  accept-opportunity \
  broadcast-opportunity \
  coverage-admin \
  create-wolfie-topup \
  create-student-account \
  create-teacher-account \
  admin-update-subscription \
  create-asaas-subaccount \
  send-whatsapp \
  whatsapp-wise-wolf \
  send-contract-confirmation \
  send-welcome-contract \
  process-outbox \
  notify-claim \
  school-admin \
  tenant-settings-admin \
  whatsapp-evolution-proxy \
  whatsapp-lead-notification \
  whatsapp-hr-welcome; do
  wait_for_http_status 401 "autenticação de $protected_function" \
    -X POST "$api_url/functions/v1/$protected_function" \
    -H 'Content-Type: application/json' \
    --data '{}'
done
wait_for_http_status 401 "autenticação de documentos legais privados" \
  -X POST "$api_url/functions/v1/tenant-legal-assets" \
  -H 'Content-Type: application/json' \
  --data '{"action":"current"}'
wait_for_http_status 404 "consulta pública de branding sem tenant" \
  "$api_url/functions/v1/public-tenant-branding"
service_role_key="$(
  docker exec supabase-edge-functions sh -lc \
    'printf "%s" "${SUPABASE_SERVICE_ROLE_KEY:-}"'
)"
[[ "$service_role_key" =~ ^[A-Za-z0-9._-]{20,}$ ]]
for retired_service_function in \
  send-whatsapp \
  whatsapp-wise-wolf \
  send-contract-confirmation \
  process-outbox; do
  wait_for_service_http_status 410 "desativação de $retired_service_function" \
    -X POST "$api_url/functions/v1/$retired_service_function" \
    -H 'Content-Type: application/json' \
    --data '{}'
done
wait_for_service_http_status 200 "fulfillment autenticado sem fixture existente" \
  -X POST "$api_url/functions/v1/process-hub-fulfillment" \
  -H 'Content-Type: application/json' \
  --data '{"checkoutId":"00000000-0000-4000-8000-000000000000","limit":1}'
wait_for_service_http_status 403 "bloqueio de service role em notify-claim" \
  -X POST "$api_url/functions/v1/notify-claim" \
  -H 'Content-Type: application/json' \
  --data '{}'
unset service_role_key
wait_for_http_status 400 "validação pública de indicação" \
  -X POST "$api_url/functions/v1/referral-welcome" \
  -H 'Content-Type: application/json' \
  --data '{}'
for service_cron in sdr-followups funnel-sweeper post-trial-pipeline; do
  wait_for_http_status 403 "service role de $service_cron" \
    -X POST "$api_url/functions/v1/$service_cron" \
    -H 'Content-Type: application/json' \
    --data '{}'
done
for protected_emitter in dre-report payment-split-notify weekly-director-digest; do
  wait_for_http_status 401 "autenticação de $protected_emitter" \
    -X POST "$api_url/functions/v1/$protected_emitter" \
    -H 'Content-Type: application/json' \
    --data '{}'
done
wait_for_http_status 403 "token do WhatsApp inbound" \
  -X POST "$api_url/functions/v1/whatsapp-inbound" \
  -H 'Content-Type: application/json' \
  --data '{}'
for protected_ai in \
  whatsapp-crm-lead-notif school-ai-team school-ai-digest wolfie-eval \
  hr-ai-screening; do
  wait_for_http_status 401 "autenticação de $protected_ai" \
    -X POST "$api_url/functions/v1/$protected_ai" \
    -H 'Content-Type: application/json' \
    --data '{}'
done
wait_for_http_status 426 "upgrade WebSocket do Wolfie Live" \
  "$api_url/functions/v1/wolfie-live-proxy"

[[ ! -e "$current_marker_tmp" && ! -L "$current_marker_tmp" ]]
printf '%s\n' "$release_id" > "$current_marker_tmp"
mv -f -- "$current_marker_tmp" "$current_marker"
current_marker_swapped=1
write_activation_state active
trap - ERR
echo "Release ativa: $release_id"
echo "Backup reversível: $backup_dir"
REMOTE

if [[ "$activation_status" -ne 0 ]]; then
  activation_failure_state="unknown"
  read_activation_failure_state() {
    ssh -o BatchMode=yes "$DEPLOY_SSH_HOST" bash -s -- \
      "$DEPLOY_RELEASES_DIR" "$DEPLOY_BACKUPS_DIR" "$release_id" \
      "$expected_current_release" <<'REMOTE_STATUS'
set -Eeuo pipefail
releases_dir=$1
backups_dir=$2
release_id=$3
expected_current_release=$4
for remote_path in "$releases_dir" "$backups_dir"; do
  [[ "$remote_path" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ ]]
  [[ "$remote_path" != *".."* && "$remote_path" != *"//"* ]]
done
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
[[ "$expected_current_release" = "none" ||
  "$expected_current_release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
failure_marker="$backups_dir/release-$release_id/POST_COMMIT_FAILURE"
if [[ -f "$failure_marker" && ! -L "$failure_marker" ]] &&
  grep -Fxq -- "post_commit_validation_failed:$release_id" "$failure_marker"; then
  printf 'postcommit'
  exit 0
fi
activation_state_file="$backups_dir/release-$release_id/ACTIVATION_STATE"
if [[ -f "$activation_state_file" && ! -L "$activation_state_file" ]]; then
  IFS= read -r activation_state < "$activation_state_file"
  activation_phase="${activation_state%%:*}"
  activation_state_release_id="${activation_state#*:}"
  [[ "$activation_state_release_id" = "$release_id" ]]
  case "$activation_phase" in
    active | database_committed | post_commit_failed)
      printf 'postcommit'
      exit 0
      ;;
    rolled_back)
      printf 'rolledback'
      exit 0
      ;;
    prepared | code_staged | database_transaction_started | database_commit_unknown | rollback_failed)
      printf 'unresolved:%s' "$activation_phase"
      exit 0
      ;;
    *) exit 1 ;;
  esac
fi
current_marker="$releases_dir/current"
if [[ ! -e "$current_marker" && ! -L "$current_marker" &&
  "$expected_current_release" = "none" ]]; then
  printf 'unchanged'
  exit 0
fi
[[ -f "$current_marker" && ! -L "$current_marker" ]]
IFS= read -r active_release < "$current_marker"
[[ "$active_release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]]
printf 'active:%s' "$active_release"
REMOTE_STATUS
  }
  if activation_failure_state="$(read_activation_failure_state)"; then
    :
  fi

  if [[ "$activation_failure_state" = "postcommit" ||
    "$activation_failure_state" = "active:$release_id" ]]; then
    echo "ERRO: falha após o commit; a nova release permaneceu ativa para manter compatibilidade com o banco." >&2
    if [[ "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" != "1" ]]; then
      update_published_function_manifest "$DEPLOY_SSH_HOST" "$DEPLOY_FUNCTIONS_DIR" ||
        echo "AVISO: não consegui atualizar o manifesto das functions mantidas ativas." >&2
    fi
  elif [[ "$activation_failure_state" = "rolledback" ||
    "$activation_failure_state" = "unchanged" ||
    "$activation_failure_state" = active:* ]]; then
    echo "ERRO: ativação falhou antes do commit; o estado anterior permaneceu ativo ou foi restaurado." >&2
  elif [[ "$activation_failure_state" = unresolved:* ]]; then
    echo "ERRO CRÍTICO: a ativação terminou no estado '${activation_failure_state#unresolved:}'; os serviços e o banco precisam de reconciliação manual antes de outro release." >&2
  else
    echo "ERRO CRÍTICO: não foi possível confirmar o estado remoto; não inicie outro release antes da verificação manual." >&2
  fi
  exit "$activation_status"
fi

echo "Deploy concluído: $release_id"

# Linha de base para o PRÓXIMO release. Vem do que de fato ficou no servidor, não
# do que julgamos ter enviado — é o que transforma hotfix por `scp` em erro
# visível na próxima publicação, em vez de perda silenciosa.
if [[ "$DEPLOY_PRESERVE_REMOTE_FUNCTIONS" != "1" ]]; then
  update_published_function_manifest "$DEPLOY_SSH_HOST" "$DEPLOY_FUNCTIONS_DIR" ||
    echo "AVISO: não consegui gravar o manifesto de functions; o próximo release avisará que não tem linha de base." >&2
fi
