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
  unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY \
    VITE_WOLFIE_REALTIME_ENABLED VITE_WOLFIE_SCENARIO_UI_V2
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

for command_name in git npm npx ssh rsync curl shasum mktemp find; do
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
[[ "$DEPLOY_API_URL" != *".supabase.co"* ]] ||
  die "DEPLOY_API_URL não pode apontar para o Supabase hospedado"

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
docker exec supabase-edge-functions sh -lc \
  'test -n "${OPENAI_API_KEY:-}" && test -n "${OPENROUTER_API_KEY:-}"'
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
export VITE_WOLFIE_REALTIME_ENABLED
export VITE_WOLFIE_SCENARIO_UI_V2
VITE_SUPABASE_URL="$(read_remote_public_env VITE_SUPABASE_URL)"
VITE_SUPABASE_ANON_KEY="$(read_remote_public_env VITE_SUPABASE_ANON_KEY)"
VITE_WOLFIE_REALTIME_ENABLED="${VITE_WOLFIE_REALTIME_ENABLED:-true}"
VITE_WOLFIE_SCENARIO_UI_V2="${VITE_WOLFIE_SCENARIO_UI_V2:-false}"
[[ "$VITE_SUPABASE_URL" =~ ^https://[^[:space:]]+$ ]] ||
  die "VITE_SUPABASE_URL remota inválida"
[[ "$VITE_SUPABASE_URL" = "$DEPLOY_API_URL" ]] ||
  die "o frontend deve usar exatamente a API da VPS"
[[ ${#VITE_SUPABASE_ANON_KEY} -ge 20 ]] ||
  die "VITE_SUPABASE_ANON_KEY remota ausente ou truncada"
[[ "$VITE_WOLFIE_REALTIME_ENABLED" = "true" ||
  "$VITE_WOLFIE_REALTIME_ENABLED" = "false" ]] ||
  die "VITE_WOLFIE_REALTIME_ENABLED deve ser true ou false"
[[ "$VITE_WOLFIE_SCENARIO_UI_V2" = "true" ||
  "$VITE_WOLFIE_SCENARIO_UI_V2" = "false" ]] ||
  die "VITE_WOLFIE_SCENARIO_UI_V2 deve ser true ou false"

echo "== Validação local =="
npm run typecheck
npm test
npx --yes deno test --no-lock \
  supabase/functions/lesson-planner/core.test.ts \
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
node scripts/provision-wolfie-rag.mjs --validate-only
npx --yes deno check --no-lock \
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
  supabase/functions/create-hub-checkout/index.ts \
  supabase/functions/create-saas-checkout/index.ts \
  supabase/functions/sync-student-asaas/index.ts \
  supabase/functions/create-asaas-subscription/index.ts \
  supabase/functions/create-enrollment-pix/index.ts \
  supabase/functions/pedagogical-content/index.ts \
  supabase/functions/wolf-tutor-api/index.ts \
  supabase/functions/asaas-webhook/index.ts \
  supabase/functions/create-student-account/index.ts \
  supabase/functions/create-teacher-account/index.ts \
  supabase/functions/admin-update-subscription/index.ts \
  supabase/functions/create-asaas-subaccount/index.ts \
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
  supabase/functions/dre-categorize/index.ts \
  supabase/functions/dre-report/index.ts
npm run build
find dist -type d -exec chmod 0755 {} +
find dist -type f -exec chmod 0644 {} +

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
)
DATABASE_TEST_RELATIVES=(
  "supabase/tests/wolfie_tenant_quota_usage_hardening.sql"
  "supabase/tests/wolfie_classic_exchange_atomicity.sql"
  "supabase/tests/wolfie_meeting_memory_lifecycle.sql"
  "supabase/tests/wolfie_sql_special_forms_repair.sql"
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
HUB_AI_FUNCTION_RELATIVE="supabase/functions/pedagogical-content"
HUB_TUTOR_FUNCTION_RELATIVE="supabase/functions/wolf-tutor-api"
ASAAS_WEBHOOK_FUNCTION_RELATIVE="supabase/functions/asaas-webhook"
# Cobertura de professor: o aceite move o pagamento (apply_coverage_acceptance).
# Ficava de fora da lista, então a correção não subia pelo deploy.
COVERAGE_ACCEPT_FUNCTION_RELATIVE="supabase/functions/accept-coverage"
COVERAGE_ADMIN_FUNCTION_RELATIVE="supabase/functions/coverage-admin"
SHARED_AUTH_RELATIVE="supabase/functions/_shared/request-auth.ts"
SHARED_ACCOUNT_INVITE_RELATIVE="supabase/functions/_shared/account-invite.ts"
SHARED_COMMERCIAL_POLICY_RELATIVE="supabase/functions/_shared/commercial-contact-policy.ts"
SHARED_AI_USAGE_RELATIVE="supabase/functions/_shared/ai-usage.ts"
SHARED_GLOBAL_MEETING_POLICY_RELATIVE="supabase/functions/_shared/wolfie-global-meeting-policy.ts"
HARDENED_FUNCTIONS=(
  create-wolfie-topup
  lesson-planner
  sync-student-asaas
  create-asaas-subscription
  create-enrollment-pix
  create-saas-checkout
  create-student-account
  create-teacher-account
  admin-update-subscription
  create-asaas-subaccount
  send-whatsapp
  whatsapp-wise-wolf
  send-contract-confirmation
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
[[ -s "$HUB_AI_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função de IA do Hub ausente"
[[ -s "$HUB_TUTOR_FUNCTION_RELATIVE/index.ts" ]] ||
  die "função Wolfie do Hub ausente"
[[ -s "$COVERAGE_ACCEPT_FUNCTION_RELATIVE/index.ts" ]] ||
  die "accept-coverage/index.ts ausente"
[[ -s "$COVERAGE_ADMIN_FUNCTION_RELATIVE/index.ts" ]] ||
  die "coverage-admin/index.ts ausente"
[[ -s "$ASAAS_WEBHOOK_FUNCTION_RELATIVE/index.ts" ]] ||
  die "webhook Asaas ausente"
[[ -s "$SHARED_AUTH_RELATIVE" ]] || die "guard de autenticação ausente"
[[ -s "$SHARED_ACCOUNT_INVITE_RELATIVE" ]] || die "helper de convite seguro ausente"
[[ -s "$SHARED_COMMERCIAL_POLICY_RELATIVE" ]] || die "política de contato comercial ausente"
[[ -s "$SHARED_AI_USAGE_RELATIVE" ]] || die "telemetria compartilhada de IA ausente"
[[ -s "$SHARED_GLOBAL_MEETING_POLICY_RELATIVE" ]] || die "política de reunião global ausente"
for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  [[ -s "supabase/functions/$function_name/index.ts" ]] ||
    die "função endurecida ausente: $function_name"
done

source_git_sha="$(git rev-parse --short=12 HEAD)"
artifact_hash="$(
  {
    find dist -type f -print
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
      "$HUB_AI_FUNCTION_RELATIVE" \
      "$HUB_TUTOR_FUNCTION_RELATIVE" \
      "$COVERAGE_ACCEPT_FUNCTION_RELATIVE" \
      "$COVERAGE_ADMIN_FUNCTION_RELATIVE" \
      "$ASAAS_WEBHOOK_FUNCTION_RELATIVE"; do
      find "$release_input_dir" -type f -print
    done
    for function_name in "${HARDENED_FUNCTIONS[@]}"; do
      find "supabase/functions/$function_name" -type f -print
    done
    printf '%s\n' \
      "$SHARED_AUTH_RELATIVE" \
      "$SHARED_ACCOUNT_INVITE_RELATIVE" \
      "$SHARED_COMMERCIAL_POLICY_RELATIVE" \
      "$SHARED_AI_USAGE_RELATIVE" \
      "$SHARED_GLOBAL_MEETING_POLICY_RELATIVE"
    printf '%s\n' "${MIGRATION_RELATIVES[@]}"
    printf '%s\n' "${DATABASE_TEST_RELATIVES[@]}"
  } |
    LC_ALL=C sort |
    while IFS= read -r release_input; do
      printf '%s  %s\n' \
        "$(shasum -a 256 "$release_input" | awk '{print $1}')" \
        "$release_input"
    done |
    shasum -a 256 |
    awk '{print substr($1, 1, 12)}'
)"
[[ "$artifact_hash" =~ ^[a-f0-9]{12}$ ]] ||
  die "não foi possível calcular a identidade da release"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${artifact_hash}"
echo "Commit de origem: $source_git_sha"
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
  "$release_dir/functions/wolfie-brain" \
  "$release_dir/functions/wolfie-realtime-session" \
  "$release_dir/functions/wolfie-tts" \
  "$release_dir/functions/lesson-planner" \
  "$release_dir/functions/submit-quiz" \
  "$release_dir/functions/student-context" \
  "$release_dir/functions/hub-library-access" \
  "$release_dir/functions/sync-hub-material" \
  "$release_dir/functions/create-hub-checkout" \
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
rsync -a --delete -- "$HUB_AI_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/pedagogical-content/"
rsync -a --delete -- "$HUB_TUTOR_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/wolf-tutor-api/"
rsync -a --delete -- "$ASAAS_WEBHOOK_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/asaas-webhook/"
rsync -a --delete -- "$COVERAGE_ACCEPT_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/accept-coverage/"
rsync -a --delete -- "$COVERAGE_ADMIN_FUNCTION_RELATIVE/" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/coverage-admin/"
rsync -a -- "$SHARED_AUTH_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/request-auth.ts"
rsync -a -- "$SHARED_ACCOUNT_INVITE_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/account-invite.ts"
rsync -a -- "$SHARED_COMMERCIAL_POLICY_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/commercial-contact-policy.ts"
rsync -a -- "$SHARED_AI_USAGE_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/ai-usage.ts"
rsync -a -- "$SHARED_GLOBAL_MEETING_POLICY_RELATIVE" \
  "$DEPLOY_SSH_HOST:$remote_release/functions/_shared/wolfie-global-meeting-policy.ts"
for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  rsync -a --delete -- "supabase/functions/$function_name/" \
    "$DEPLOY_SSH_HOST:$remote_release/functions/$function_name/"
done
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
conversation_function_swapped=0
realtime_function_swapped=0
tts_function_swapped=0
pedagogical_function_swapped=0
context_function_swapped=0
hub_library_function_swapped=0
hub_material_sync_function_swapped=0
hub_checkout_function_swapped=0
hub_ai_function_swapped=0
hub_tutor_function_swapped=0
asaas_webhook_function_swapped=0
shared_swapped=0
account_invite_shared_swapped=0
commercial_policy_shared_swapped=0
ai_usage_shared_swapped=0
global_meeting_policy_shared_swapped=0
hardened_functions_swapped=()
HARDENED_FUNCTIONS=(
  create-wolfie-topup
  lesson-planner
  sync-student-asaas
  create-asaas-subscription
  create-enrollment-pix
  create-saas-checkout
  create-student-account
  create-teacher-account
  admin-update-subscription
  create-asaas-subaccount
  send-whatsapp
  whatsapp-wise-wolf
  send-contract-confirmation
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
)

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
  if [[ "$shared_swapped" = "1" && -f "$backup_dir/request-auth.ts" ]]; then
    cp -a -- "$backup_dir/request-auth.ts" \
      "$functions_dir/_shared/request-auth.ts"
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
[[ -s "$release_dir/functions/wolfie-brain/index.ts" ]]
[[ -s "$release_dir/functions/wolfie-realtime-session/index.ts" ]]
[[ -s "$release_dir/functions/wolfie-tts/index.ts" ]]
[[ -s "$release_dir/functions/submit-quiz/index.ts" ]]
[[ -s "$release_dir/functions/student-context/index.ts" ]]
[[ -s "$release_dir/functions/hub-library-access/index.ts" ]]
[[ -s "$release_dir/functions/sync-hub-material/index.ts" ]]
[[ -s "$release_dir/functions/create-hub-checkout/index.ts" ]]
[[ -s "$release_dir/functions/pedagogical-content/index.ts" ]]
[[ -s "$release_dir/functions/wolf-tutor-api/index.ts" ]]
[[ -s "$release_dir/functions/asaas-webhook/index.ts" ]]
[[ -s "$release_dir/functions/_shared/request-auth.ts" ]]
[[ -s "$release_dir/functions/_shared/account-invite.ts" ]]
[[ -s "$release_dir/functions/_shared/commercial-contact-policy.ts" ]]
[[ -s "$release_dir/functions/_shared/ai-usage.ts" ]]
[[ -s "$release_dir/functions/_shared/wolfie-global-meeting-policy.ts" ]]
for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  [[ -s "$release_dir/functions/$function_name/index.ts" ]]
done
database_tests=(
  "$release_dir/tests/wolfie_tenant_quota_usage_hardening.sql"
  "$release_dir/tests/wolfie_classic_exchange_atomicity.sql"
  "$release_dir/tests/wolfie_meeting_memory_lifecycle.sql"
  "$release_dir/tests/wolfie_sql_special_forms_repair.sql"
)
for database_test in "${database_tests[@]}"; do
  [[ -s "$database_test" ]]
done

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

echo "== Testes SQL transacionais do Wolfie =="
for database_test in "${database_tests[@]}"; do
  docker exec -i supabase-db \
    psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    < "$database_test"
done

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
  shared_swapped=1
fi
cp -a -- "$release_dir/functions/_shared/request-auth.ts" \
  "$functions_dir/_shared/request-auth.ts"

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

for function_name in "${HARDENED_FUNCTIONS[@]}"; do
  if [[ -d "$functions_dir/$function_name" ]]; then
    mv -- "$functions_dir/$function_name" "$backup_dir/$function_name"
  fi
  hardened_functions_swapped+=("$function_name")
  cp -a -- "$release_dir/functions/$function_name" \
    "$functions_dir/$function_name"
done

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
wait_for_http_status 200 "frontend do Wise Wolf Hub" "$public_url/hub"
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
for protected_function in \
  create-wolfie-topup \
  create-student-account \
  create-teacher-account \
  admin-update-subscription \
  create-asaas-subaccount \
  send-whatsapp \
  whatsapp-wise-wolf \
  send-contract-confirmation \
  process-outbox \
  notify-claim \
  whatsapp-lead-notification; do
  wait_for_http_status 401 "autenticação de $protected_function" \
    -X POST "$api_url/functions/v1/$protected_function" \
    -H 'Content-Type: application/json' \
    --data '{}'
done
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
wait_for_http_status 403 "token do WhatsApp inbound" \
  -X POST "$api_url/functions/v1/whatsapp-inbound" \
  -H 'Content-Type: application/json' \
  --data '{}'
for protected_ai in whatsapp-crm-lead-notif school-ai-team school-ai-digest wolfie-eval; do
  wait_for_http_status 401 "autenticação de $protected_ai" \
    -X POST "$api_url/functions/v1/$protected_ai" \
    -H 'Content-Type: application/json' \
    --data '{}'
done
wait_for_http_status 403 "autorização do RH IA" \
  -X POST "$api_url/functions/v1/hr-ai-screening" \
  -H 'Content-Type: application/json' \
  --data '{}'
wait_for_http_status 426 "upgrade WebSocket do Wolfie Live" \
  "$api_url/functions/v1/wolfie-live-proxy"

printf '%s\n' "$release_id" > "$releases_dir/current"
trap - ERR
echo "Release ativa: $release_id"
echo "Backup reversível: $backup_dir"
REMOTE

echo "Deploy concluído: $release_id"
