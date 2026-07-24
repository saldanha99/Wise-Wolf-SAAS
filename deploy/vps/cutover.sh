#!/usr/bin/env bash
# CUTOVER Wise Wolf: hosted -> VPS.
# Rodar na madrugada somente com as duas confirmacoes explicitas:
# RUN=yes I_UNDERSTAND_DATA_REPLACEMENT=yes.
# Pre-requisitos: DNS api. e app. apontando para a VPS; TLS emitido; testes ok.
set -Eeuo pipefail
umask 077

HOSTED_CRONS_PAUSED=0
RESTORE_STARTED=0
CURL_SECRET_DIR=""
CURL_SECRET_FILES=()

cleanup() {
  local exit_code=$?
  trap - ERR EXIT
  set +e

  if ((${#CURL_SECRET_FILES[@]} > 0)); then
    rm -f -- "${CURL_SECRET_FILES[@]}"
  fi
  if [[ -n "$CURL_SECRET_DIR" && -d "$CURL_SECRET_DIR" ]]; then
    rmdir -- "$CURL_SECRET_DIR" 2>/dev/null || true
  fi

  unset \
    PGPASSWORD ASAAS_API_KEY ASAAS_WEBHOOK_TOKEN EVOLUTION_API_KEY \
    GEMINI_API_KEY RESEND_API_KEY WHATSAPP_INBOUND_TOKEN \
    ASAAS_PAYLOAD PAYLOAD INBOUND_URL
  exit "$exit_code"
}

on_error() {
  local exit_code=$?
  echo "ERRO: cutover interrompido na linha ${BASH_LINENO[0]} (codigo ${exit_code})." >&2
  if [[ "$HOSTED_CRONS_PAUSED" = "1" ]]; then
    echo "ATENCAO: os crons do ambiente hospedado continuam pausados para evitar processamento duplicado." >&2
  fi
  if [[ "$RESTORE_STARTED" = "1" && -s /opt/wisewolf/migration/final-restore.err ]]; then
    echo "Consulte /opt/wisewolf/migration/final-restore.err para o erro do restore." >&2
  fi
  exit "$exit_code"
}
trap on_error ERR
trap cleanup EXIT

if [[ "${RUN:-}" != "yes" ]]; then
  echo "Ensaio encerrado sem alteracoes. Para executar, informe as duas confirmacoes exigidas."
  exit 0
fi
if [[ "${I_UNDERSTAND_DATA_REPLACEMENT:-}" != "yes" ]]; then
  echo "ERRO: cutover bloqueado. Confirme explicitamente a substituicao dos dados com I_UNDERSTAND_DATA_REPLACEMENT=yes." >&2
  exit 1
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    { echo "ERRO: comando obrigatorio ausente: $1" >&2; exit 1; }
}
require_file() {
  [[ -s "$1" ]] ||
    { echo "ERRO: arquivo obrigatorio ausente ou vazio: $1" >&2; exit 1; }
}
die() {
  echo "ERRO: $1" >&2
  if [[ "$HOSTED_CRONS_PAUSED" = "1" ]]; then
    echo "ATENCAO: os crons do ambiente hospedado continuam pausados." >&2
  fi
  exit 1
}
scalar() {
  docker exec supabase-db psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 -Atqc "$1"
}

for command_name in docker psql pg_dump sed jq curl mktemp; do
  require_command "$command_name"
done

MIGRATION_DIR=/opt/wisewolf/migration
cd "$MIGRATION_DIR"
require_file /opt/wisewolf/.pghosted
require_file "$MIGRATION_DIR/post-restore.sh"
require_file "$MIGRATION_DIR/post-restore-hardening.sql"
require_file "$MIGRATION_DIR/sync-storage2.sh"
require_file "$MIGRATION_DIR/cron-jobs.tsv"
require_file "$MIGRATION_DIR/buckets.tsv"

export PGPASSWORD
PGPASSWORD="$(< /opt/wisewolf/.pghosted)"
HCONN="host=db.dvalxbtngopxopzcbfdm.supabase.co port=5432 dbname=postgres user=postgres sslmode=require"

runtime_env() {
  docker inspect supabase-edge-functions \
    --format '{{range .Config.Env}}{{println .}}{{end}}' |
    sed -n "s/^$1=//p" |
    head -n 1
}

ASAAS_API_KEY="$(runtime_env ASAAS_API_KEY)"
ASAAS_API_URL="$(runtime_env ASAAS_API_URL)"
ASAAS_WEBHOOK_TOKEN="$(runtime_env ASAAS_WEBHOOK_TOKEN)"
EVOLUTION_API_KEY="$(runtime_env EVOLUTION_API_KEY)"
EVOLUTION_API_URL="$(runtime_env EVOLUTION_API_URL)"
GEMINI_API_KEY="$(runtime_env GEMINI_API_KEY)"
GEMINI_MODEL="$(runtime_env GEMINI_MODEL)"
GEMINI_LIVE_MODEL="$(runtime_env GEMINI_LIVE_MODEL)"
SYSTEM_URL="$(runtime_env SYSTEM_URL)"
RESEND_API_KEY="$(runtime_env RESEND_API_KEY)"
RESEND_FROM_EMAIL="$(runtime_env RESEND_FROM_EMAIL)"
RESEND_REPLY_TO="$(runtime_env RESEND_REPLY_TO)"
WHATSAPP_INBOUND_TOKEN="$(runtime_env WHATSAPP_INBOUND_TOKEN)"

for required in \
  ASAAS_API_KEY ASAAS_API_URL ASAAS_WEBHOOK_TOKEN \
  EVOLUTION_API_KEY EVOLUTION_API_URL \
  GEMINI_API_KEY GEMINI_MODEL GEMINI_LIVE_MODEL \
  SYSTEM_URL RESEND_API_KEY RESEND_FROM_EMAIL \
  WHATSAPP_INBOUND_TOKEN; do
  [[ -n "${!required}" ]] ||
    { echo "ERRO: variavel $required ausente no runtime" >&2; exit 1; }
done
[[ "$ASAAS_API_URL" =~ ^https:// ]] ||
  die "ASAAS_API_URL deve usar HTTPS"
[[ "$EVOLUTION_API_URL" =~ ^https:// ]] ||
  die "EVOLUTION_API_URL deve usar HTTPS"
[[ "$SYSTEM_URL" =~ ^https://[^[:space:]]+$ ]] ||
  die "SYSTEM_URL deve ser uma URL HTTPS valida"
[[ ${#ASAAS_API_KEY} -ge 20 && ${#ASAAS_WEBHOOK_TOKEN} -ge 16 ]] ||
  die "credenciais Asaas parecem truncadas"
[[ ${#GEMINI_API_KEY} -ge 20 ]] ||
  die "credencial Gemini parece truncada"
[[ ${#RESEND_API_KEY} -ge 20 ]] ||
  die "credencial Resend parece truncada"
[[ "$RESEND_FROM_EMAIL" == *"@"* ]] ||
  die "RESEND_FROM_EMAIL parece invalido"
[[ -z "$RESEND_REPLY_TO" || "$RESEND_REPLY_TO" == *"@"* ]] ||
  die "RESEND_REPLY_TO parece invalido"
[[ "$GEMINI_MODEL" =~ ^[A-Za-z0-9._-]+$ ]] ||
  die "GEMINI_MODEL contem caracteres invalidos"
[[ "$GEMINI_LIVE_MODEL" =~ ^[A-Za-z0-9._-]+$ ]] ||
  die "GEMINI_LIVE_MODEL contem caracteres invalidos"

ASAAS_API_URL="${ASAAS_API_URL%/}"
if [[ "$ASAAS_API_URL" = */v3 ]]; then
  ASAAS_V3_BASE="$ASAAS_API_URL"
else
  ASAAS_V3_BASE="$ASAAS_API_URL/v3"
fi
EVOLUTION_API_URL="${EVOLUTION_API_URL%/}"
SYSTEM_URL="${SYSTEM_URL%/}"

CURL_SECRET_DIR="$(mktemp -d /tmp/wisewolf-cutover-curl.XXXXXX)"
ASAAS_CURL_HEADERS="$CURL_SECRET_DIR/asaas.headers"
EVOLUTION_CURL_HEADERS="$CURL_SECRET_DIR/evolution.headers"
GEMINI_CURL_HEADERS="$CURL_SECRET_DIR/gemini.headers"
RESEND_CURL_HEADERS="$CURL_SECRET_DIR/resend.headers"
ASAAS_WEBHOOK_TOKEN_FILE="$CURL_SECRET_DIR/asaas-webhook-token"
INBOUND_URL_FILE="$CURL_SECRET_DIR/evolution-inbound-url"
CURL_SECRET_FILES=(
  "$ASAAS_CURL_HEADERS"
  "$EVOLUTION_CURL_HEADERS"
  "$GEMINI_CURL_HEADERS"
  "$RESEND_CURL_HEADERS"
  "$ASAAS_WEBHOOK_TOKEN_FILE"
  "$INBOUND_URL_FILE"
)

printf 'access_token: %s\nContent-Type: application/json\n' \
  "$ASAAS_API_KEY" > "$ASAAS_CURL_HEADERS"
printf 'apikey: %s\nContent-Type: application/json\n' \
  "$EVOLUTION_API_KEY" > "$EVOLUTION_CURL_HEADERS"
printf 'x-goog-api-key: %s\n' \
  "$GEMINI_API_KEY" > "$GEMINI_CURL_HEADERS"
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' \
  "$RESEND_API_KEY" > "$RESEND_CURL_HEADERS"
printf '%s' "$ASAAS_WEBHOOK_TOKEN" > "$ASAAS_WEBHOOK_TOKEN_FILE"
: > "$INBOUND_URL_FILE"
chmod 0600 -- "${CURL_SECRET_FILES[@]}"

echo "== PREFLIGHT: conectividade, credenciais e contagens =="
[[ "$(docker inspect supabase-db --format '{{.State.Running}}')" = "true" ]]
[[ "$(docker inspect supabase-edge-functions --format '{{.State.Running}}')" = "true" ]]
docker exec supabase-db pg_isready -U supabase_admin -d postgres >/dev/null
[[ "$(psql "$HCONN" -X -v ON_ERROR_STOP=1 -Atqc 'select 1')" = "1" ]]
curl -fsS --max-time 20 \
  "$ASAAS_V3_BASE/customers?limit=1" \
  --header "@$ASAAS_CURL_HEADERS" >/dev/null
curl -fsS --max-time 20 \
  "$EVOLUTION_API_URL/instance/fetchInstances" \
  --header "@$EVOLUTION_CURL_HEADERS" >/dev/null
curl -fsS --max-time 20 \
  "https://generativelanguage.googleapis.com/v1beta/models/$GEMINI_MODEL" \
  --header "@$GEMINI_CURL_HEADERS" >/dev/null
curl -fsS --max-time 20 \
  "https://generativelanguage.googleapis.com/v1beta/models/$GEMINI_LIVE_MODEL" \
  --header "@$GEMINI_CURL_HEADERS" >/dev/null
curl -fsS --max-time 20 \
  https://api.resend.com/domains \
  --header "@$RESEND_CURL_HEADERS" >/dev/null
curl -fsS --max-time 20 \
  "$SYSTEM_URL/" >/dev/null
echo "  integracoes: Asaas=ok Evolution=ok Gemini=ok Resend=ok SYSTEM_URL=ok"

EXPECTED_COUNTS="$(
  psql "$HCONN" -X -v ON_ERROR_STOP=1 -AtF '|' -c \
    "select (select count(*) from auth.users), (select count(*) from public.profiles);"
)"
IFS='|' read -r EXPECTED_AUTH_USERS EXPECTED_PROFILES <<< "$EXPECTED_COUNTS"
[[ "$EXPECTED_AUTH_USERS" =~ ^[0-9]+$ && "$EXPECTED_PROFILES" =~ ^[0-9]+$ ]]
echo "  hosted: auth.users=$EXPECTED_AUTH_USERS profiles=$EXPECTED_PROFILES"

echo "== PASSO 1: pausar crons no HOSTED =="
HOSTED_ACTIVE_CRONS="$(
  psql "$HCONN" -X -v ON_ERROR_STOP=1 -Atqc \
    "select count(*) from cron.job where active;"
)"
psql "$HCONN" -X -v ON_ERROR_STOP=1 -c \
  "update cron.job set active=false where active;"
HOSTED_CRONS_PAUSED=1
[[ "$(
  psql "$HCONN" -X -v ON_ERROR_STOP=1 -Atqc \
    "select count(*) from cron.job where active;"
)" = "0" ]]
echo "  $HOSTED_ACTIVE_CRONS crons hospedados pausados"

echo "== PASSO 2: dump final e restore estrito =="
pg_dump "$HCONN" \
  -t auth.users -t auth.identities \
  --data-only --column-inserts \
  -f auth-data-final.sql
pg_dump "$HCONN" --schema=public --no-owner -f public-final.sql
require_file auth-data-final.sql
require_file public-final.sql

sed \
  -e "s|https://dvalxbtngopxopzcbfdm.supabase.co/functions/v1|http://kong:8000/functions/v1|g" \
  -e "s|https://dvalxbtngopxopzcbfdm.supabase.co|https://api.wisewolflanguage.com.br|g" \
  public-final.sql > public-final-vps.sql
require_file public-final-vps.sql

echo "  -- limpando public local e restaurando final --"
: > final-restore.err
RESTORE_STARTED=1
docker exec supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -c \
  "drop schema public cascade;
   create schema public;
   grant usage on schema public to postgres, anon, authenticated, service_role;
   grant all on schema public to postgres, service_role;"
docker exec supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -c \
  "truncate auth.identities, auth.users cascade;"
docker exec -i supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -q < auth-data-final.sql
docker exec -i supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -q < public-final-vps.sql 2> final-restore.err

bash "$MIGRATION_DIR/post-restore.sh"
docker exec -i supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 < "$MIGRATION_DIR/post-restore-hardening.sql"

# O trigger vive em auth e não entra no dump do schema public. A função é
# recriada pelo hardening acima; o vínculo precisa ser restaurado explicitamente.
docker exec -i supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 <<'SQL'
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
SQL

"$MIGRATION_DIR/sync-storage2.sh"

echo "  -- recriando crons (ainda desativados) --"
while IFS=$'\t' read -r job schedule command; do
  [[ -z "$job" || "$job" = \#* ]] && continue
  docker exec supabase-db psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 -q \
    -c "select cron.schedule(\$q\$$job\$q\$, \$q\$$schedule\$q\$, \$q\$$command\$q\$);" \
    < /dev/null
done < cron-jobs.tsv
docker exec supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -q -c \
  "update cron.job set active=false where active;" < /dev/null

echo "== POS-VALIDACAO DO RESTORE =="
LOCAL_AUTH_USERS="$(scalar "select count(*) from auth.users;")"
LOCAL_PROFILES="$(scalar "select count(*) from public.profiles;")"
PUBLIC_TABLES="$(scalar "select count(*) from pg_tables where schemaname='public';")"
AUTH_TRIGGER="$(
  scalar "select count(*)
            from pg_trigger
           where tgrelid='auth.users'::regclass
             and tgname='on_auth_user_created'
             and tgenabled <> 'D';"
)"
INVALID_FOREIGN_KEYS="$(
  scalar "select count(*)
            from pg_constraint
           where contype='f'
             and not convalidated
             and conname <> 'profiles_id_fkey'
             and connamespace in (
               'public'::regnamespace,
               'auth'::regnamespace
             );"
)"

[[ "$LOCAL_AUTH_USERS" = "$EXPECTED_AUTH_USERS" ]] ||
  die "contagem auth.users divergiu ($LOCAL_AUTH_USERS != $EXPECTED_AUTH_USERS)"
[[ "$LOCAL_PROFILES" = "$EXPECTED_PROFILES" ]] ||
  die "contagem profiles divergiu ($LOCAL_PROFILES != $EXPECTED_PROFILES)"
[[ "$PUBLIC_TABLES" -gt 0 ]] ||
  die "schema public restaurado sem tabelas"
[[ "$AUTH_TRIGGER" = "1" ]] ||
  die "trigger on_auth_user_created ausente ou desativado"
[[ "$INVALID_FOREIGN_KEYS" = "0" ]] ||
  die "ha foreign keys nao validadas apos restore"
echo "  auth.users=$LOCAL_AUTH_USERS profiles=$LOCAL_PROFILES tabelas=$PUBLIC_TABLES trigger_auth=ok"

echo "== PASSO 3: DNS system.wisewolflanguage.com.br -> 187.127.46.251 =="
echo "   + adicionar Host(system...) no router traefik do frontend e reiniciar frontend"

echo "== PASSO 4: webhook ASAAS =="
WEBHOOKS="$(
  curl -fsS --max-time 30 "$ASAAS_V3_BASE/webhooks" \
    --header "@$ASAAS_CURL_HEADERS"
)"
WEBHOOK_ID="$(
  jq -r \
    '.data[] | select(.name == "SaasWise" or (.url | contains("/asaas-webhook"))) | .id' \
    <<< "$WEBHOOKS" |
    head -n 1
)"
[[ -n "$WEBHOOK_ID" && "$WEBHOOK_ID" != "null" ]] ||
  die "webhook SaasWise nao encontrado"

CURRENT_WEBHOOK="$(
  curl -fsS --max-time 30 "$ASAAS_V3_BASE/webhooks/$WEBHOOK_ID" \
    --header "@$ASAAS_CURL_HEADERS"
)"
ASAAS_PAYLOAD="$(
  jq \
    --arg url "https://api.wisewolflanguage.com.br/functions/v1/asaas-webhook" \
    --rawfile auth "$ASAAS_WEBHOOK_TOKEN_FILE" \
    '{name:(.name // "SaasWise"),url:$url,sendType:(.sendType // "SEQUENTIALLY"),enabled:true,interrupted:false,authToken:$auth,events:.events}' \
    <<< "$CURRENT_WEBHOOK"
)"
UPDATED_WEBHOOK="$(
  curl -fsS --max-time 30 -X PUT \
    "$ASAAS_V3_BASE/webhooks/$WEBHOOK_ID" \
    --header "@$ASAAS_CURL_HEADERS" \
    --data-binary @- <<< "$ASAAS_PAYLOAD"
)"
jq -e \
  --arg url "https://api.wisewolflanguage.com.br/functions/v1/asaas-webhook" \
  '.url == $url and .enabled == true and .interrupted == false' \
  <<< "$UPDATED_WEBHOOK" >/dev/null
jq '{id,name,url,enabled,interrupted,event_count:(.events|length)}' \
  <<< "$UPDATED_WEBHOOK"

echo "== PASSO 5: webhook Evolution (whatsapp-inbound) =="
INBOUND_URL="https://api.wisewolflanguage.com.br/functions/v1/whatsapp-inbound?token=$WHATSAPP_INBOUND_TOKEN"
printf '%s' "$INBOUND_URL" > "$INBOUND_URL_FILE"
PAYLOAD="$(
  jq -nc --rawfile url "$INBOUND_URL_FILE" \
    '{webhook:{enabled:true,url:$url,byEvents:false,base64:false,events:["MESSAGES_UPSERT"]}}'
)"
curl -fsS --max-time 30 -X POST \
  "$EVOLUTION_API_URL/webhook/set/prof-diretorww-d6bg" \
  --header "@$EVOLUTION_CURL_HEADERS" \
  --data-binary @- <<< "$PAYLOAD" >/dev/null

echo "== PASSO 6: ativar crons no VPS =="
docker exec supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -c \
  "update cron.job set active=true;
   select count(*) filter (where active) from cron.job;" < /dev/null
[[ "$(scalar "select count(*) from cron.job where active;")" -gt 0 ]]

echo "== PASSO 7: smoke tests externos =="
curl -fsS --max-time 20 \
  https://api.wisewolflanguage.com.br/auth/v1/health >/dev/null
curl -fsS --max-time 20 \
  "$SYSTEM_URL/" >/dev/null

echo "== CUTOVER CONCLUIDO =="
echo "Hosted permanece congelado; VPS restaurada, validada e com crons ativos."
