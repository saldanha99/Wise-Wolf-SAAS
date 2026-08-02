#!/usr/bin/env bash
# Apply only the reviewed Wolfie public-intake migration and its transactional
# SQL test. This script never publishes a frontend or an Edge Function.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$PROJECT_DIR/.env.deploy.local}"
MIGRATION_VERSION="20260802174535"
MIGRATION_FILE="20260802174535_harden_crm_leads_public_intake_authorization.sql"
TEST_FILE="public_intake_rls.sql"
MIGRATION_PATH="$PROJECT_DIR/supabase/migrations/$MIGRATION_FILE"
TEST_PATH="$PROJECT_DIR/supabase/tests/$TEST_FILE"
LOCAL_STAGE=""
REMOTE_INCOMING_OWNED="false"
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

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [[ "$REMOTE_INCOMING_OWNED" = "true" &&
    -n "${DEPLOY_SSH_HOST:-}" && -n "${DEPLOY_RELEASES_DIR:-}" &&
    -n "${remote_incoming:-}" ]]; then
    ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
      "$DEPLOY_RELEASES_DIR" "$remote_incoming" \
      "$MIGRATION_FILE" "$TEST_FILE" <<'REMOTE_CLEANUP' >/dev/null 2>&1 || true
set -Eeuo pipefail
releases_dir=$1
incoming_dir=$2
migration_file=$3
test_file=$4
[[ "$releases_dir" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ &&
  "$releases_dir" != *".."* && "$releases_dir" != *"//"* ]]
[[ "$incoming_dir" == "$releases_dir"/.incoming-wolfie-intake-* &&
  "$incoming_dir" != *".."* && "$incoming_dir" != *"//"* ]]
[[ -d "$releases_dir" && ! -L "$releases_dir" &&
  "$(readlink -f "$releases_dir")" = "$releases_dir" ]]
if [[ -e "$incoming_dir" || -L "$incoming_dir" ]]; then
  [[ -d "$incoming_dir" && ! -L "$incoming_dir" &&
    "$(readlink -f "$incoming_dir")" = "$incoming_dir" ]]
  if find "$incoming_dir" -type l -print -quit | grep -q .; then
    exit 1
  fi
  while IFS= read -r entry; do
    [[ -f "$entry" && ! -L "$entry" ]]
    case "$(basename -- "$entry")" in
      "$migration_file"|"$test_file"|SHA256SUMS) ;;
      *) exit 1 ;;
    esac
  done < <(find "$incoming_dir" -mindepth 1 -maxdepth 1 -print)
  [[ "$(find "$incoming_dir" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -le 3 ]]
  rm -rf -- "$incoming_dir"
fi
REMOTE_CLEANUP
  fi
  if [[ -n "$LOCAL_STAGE" && -d "$LOCAL_STAGE" && ! -L "$LOCAL_STAGE" &&
    "$LOCAL_STAGE" == "${TMPDIR:-/tmp}"/wolfie-intake-rollout.* ]]; then
    rm -rf -- "$LOCAL_STAGE"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

for command_name in ssh rsync shasum mktemp awk grep date chmod; do
  require_command "$command_name"
done

[[ -f "$MIGRATION_PATH" && -s "$MIGRATION_PATH" && ! -L "$MIGRATION_PATH" ]] ||
  die "migration revisada ausente ou insegura: $MIGRATION_PATH"
[[ -f "$TEST_PATH" && -s "$TEST_PATH" && ! -L "$TEST_PATH" ]] ||
  die "teste SQL revisado ausente ou inseguro: $TEST_PATH"
[[ "$(grep -c '^begin;$' "$MIGRATION_PATH")" = "1" &&
  "$(grep -c '^commit;$' "$MIGRATION_PATH")" = "1" ]] ||
  die "a migration deve possuir exatamente um wrapper top-level begin/commit"
[[ "$(grep -c '^begin;$' "$TEST_PATH")" = "1" &&
  "$(grep -c '^rollback;$' "$TEST_PATH")" = "1" ]] ||
  die "o teste deve possuir exatamente um wrapper transacional begin/rollback"

[[ -s "$DEPLOY_ENV_FILE" && ! -L "$DEPLOY_ENV_FILE" ]] ||
  die "arquivo de deploy ausente ou inseguro: $DEPLOY_ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$DEPLOY_ENV_FILE"
set +a

required_vars=(
  DEPLOY_SSH_HOST
  DEPLOY_HOST
  DEPLOY_USER
  DEPLOY_RELEASES_DIR
  DEPLOY_BACKUPS_DIR
  DEPLOY_SUPABASE_DIR
)
for required_var in "${required_vars[@]}"; do
  [[ -n "${!required_var:-}" ]] ||
    die "variável obrigatória ausente: $required_var"
done
[[ "$DEPLOY_SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  die "DEPLOY_SSH_HOST inválido"
[[ "$DEPLOY_HOST" = "187.127.46.251" ]] || die "VPS de destino inesperada"
[[ "$DEPLOY_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "DEPLOY_USER inválido"
for remote_path in \
  "$DEPLOY_RELEASES_DIR" "$DEPLOY_BACKUPS_DIR" "$DEPLOY_SUPABASE_DIR"; do
  validate_remote_path "$remote_path" ||
    die "caminho remoto fora de /opt/wisewolf: $remote_path"
done

migration_checksum="$(shasum -a 256 "$MIGRATION_PATH" | awk '{print $1}')"
test_checksum="$(shasum -a 256 "$TEST_PATH" | awk '{print $1}')"
[[ "$migration_checksum" =~ ^[a-f0-9]{64}$ ]] || die "checksum da migration inválido"
[[ "$test_checksum" =~ ^[a-f0-9]{64}$ ]] || die "checksum do teste inválido"

bundle_id="wolfie-intake-${MIGRATION_VERSION}-${migration_checksum:0:12}-${test_checksum:0:12}"
remote_bundle="$DEPLOY_RELEASES_DIR/$bundle_id"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
remote_incoming="$DEPLOY_RELEASES_DIR/.incoming-${bundle_id}-${run_id}"
validate_remote_path "$remote_bundle" || die "bundle remoto inválido"
validate_remote_path "$remote_incoming" || die "staging remoto inválido"

LOCAL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/wolfie-intake-rollout.XXXXXX")"
[[ -d "$LOCAL_STAGE" && ! -L "$LOCAL_STAGE" ]]
checksum_file="$LOCAL_STAGE/SHA256SUMS"
printf '%s  %s\n%s  %s\n' \
  "$migration_checksum" "$MIGRATION_FILE" \
  "$test_checksum" "$TEST_FILE" > "$checksum_file"
chmod 0400 "$checksum_file"

echo "== Preflight seguro da VPS e do banco =="
stage_mode_file="$LOCAL_STAGE/STAGE_MODE"
[[ ! -e "$stage_mode_file" && ! -L "$stage_mode_file" ]]
# Bash 3.2 (macOS) can misparse a quoted heredoc nested inside $(...), then
# expand parts of the remote program locally under `set -u`. Capture SSH output
# in a real file and read it only after the remote shell has completed.
REMOTE_INCOMING_OWNED="true"
ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_HOST" "$DEPLOY_USER" "$DEPLOY_RELEASES_DIR" \
  "$DEPLOY_BACKUPS_DIR" "$DEPLOY_SUPABASE_DIR" "$remote_bundle" \
  "$remote_incoming" "$MIGRATION_FILE" "$TEST_FILE" \
  "$migration_checksum" "$test_checksum" > "$stage_mode_file" <<'REMOTE'
set -Eeuo pipefail
[[ "$#" = "11" ]]
expected_host=$1
expected_user=$2
releases_dir=$3
backups_dir=$4
supabase_dir=$5
bundle_dir=$6
incoming_dir=$7
migration_file=$8
test_file=$9
migration_checksum=${10}
test_checksum=${11}

validate_path() {
  [[ "$1" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ &&
    "$1" != *".."* && "$1" != *"//"* ]]
}
[[ "$expected_host" = "187.127.46.251" ]]
[[ "$(id -un)" = "$expected_user" ]]
case " $(hostname -I) " in
  *" $expected_host "*) ;;
  *) echo "IP público não pertence ao host remoto" >&2; exit 1 ;;
esac
for path in "$releases_dir" "$backups_dir" "$supabase_dir" \
  "$bundle_dir" "$incoming_dir"; do
  validate_path "$path"
done
for path in /opt/wisewolf "$releases_dir" "$backups_dir" "$supabase_dir"; do
  [[ -d "$path" && ! -L "$path" && "$(readlink -f "$path")" = "$path" ]]
done
for command_name in docker sha256sum readlink flock timeout awk grep find; do
  command -v "$command_name" >/dev/null
done
docker inspect supabase-db --format '{{.State.Running}}' | grep -qx true
docker exec supabase-db psql -X -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -Atqc 'select 1' | grep -qx 1

if [[ -e "$bundle_dir" || -L "$bundle_dir" ]]; then
  [[ -d "$bundle_dir" && ! -L "$bundle_dir" &&
    "$(readlink -f "$bundle_dir")" = "$bundle_dir" ]]
  [[ -f "$bundle_dir/SHA256SUMS" && ! -L "$bundle_dir/SHA256SUMS" ]]
  [[ "$(sha256sum "$bundle_dir/$migration_file" | awk '{print $1}')" = "$migration_checksum" ]]
  [[ "$(sha256sum "$bundle_dir/$test_file" | awk '{print $1}')" = "$test_checksum" ]]
  (cd "$bundle_dir" && sha256sum -c SHA256SUMS >/dev/null)
  printf 'reuse'
else
  [[ ! -e "$incoming_dir" && ! -L "$incoming_dir" ]]
  mkdir -- "$incoming_dir"
  chmod 0700 "$incoming_dir"
  [[ "$(readlink -f "$incoming_dir")" = "$incoming_dir" ]]
  printf 'upload'
fi
REMOTE
[[ -f "$stage_mode_file" && -s "$stage_mode_file" && ! -L "$stage_mode_file" ]]
stage_mode="$(< "$stage_mode_file")"
[[ "$stage_mode" = "upload" || "$stage_mode" = "reuse" ]] ||
  die "estado remoto inesperado: $stage_mode"
if [[ "$stage_mode" = "reuse" ]]; then
  REMOTE_INCOMING_OWNED="false"
fi

if [[ "$stage_mode" = "upload" ]]; then
  echo "== Upload imutável e checksums =="
  rsync -e "$RSYNC_RSH" -a -- \
    "$MIGRATION_PATH" "$DEPLOY_SSH_HOST:$remote_incoming/$MIGRATION_FILE"
  rsync -e "$RSYNC_RSH" -a -- \
    "$TEST_PATH" "$DEPLOY_SSH_HOST:$remote_incoming/$TEST_FILE"
  rsync -e "$RSYNC_RSH" -a -- \
    "$checksum_file" "$DEPLOY_SSH_HOST:$remote_incoming/SHA256SUMS"
fi

echo "== Dry-run, backup, aplicação e teste do intake =="
ssh "${SSH_OPTIONS[@]}" "$DEPLOY_SSH_HOST" bash -s -- \
  "$DEPLOY_HOST" "$DEPLOY_USER" "$DEPLOY_RELEASES_DIR" \
  "$DEPLOY_BACKUPS_DIR" "$DEPLOY_SUPABASE_DIR" "$remote_bundle" \
  "$remote_incoming" "$stage_mode" "$MIGRATION_VERSION" \
  "$MIGRATION_FILE" "$TEST_FILE" "$migration_checksum" \
  "$test_checksum" <<'REMOTE'
set -Eeuo pipefail
umask 077
expected_host=$1
expected_user=$2
releases_dir=$3
backups_dir=$4
supabase_dir=$5
bundle_dir=$6
incoming_dir=$7
stage_mode=$8
migration_version=$9
migration_file=${10}
test_file=${11}
migration_checksum=${12}
test_checksum=${13}

validate_path() {
  [[ "$1" =~ ^/opt/wisewolf/[A-Za-z0-9._/-]+$ &&
    "$1" != *".."* && "$1" != *"//"* ]]
}
verify_bundle() {
  local candidate=$1
  [[ -d "$candidate" && ! -L "$candidate" &&
    "$(readlink -f "$candidate")" = "$candidate" ]]
  [[ -f "$candidate/$migration_file" && ! -L "$candidate/$migration_file" ]]
  [[ -f "$candidate/$test_file" && ! -L "$candidate/$test_file" ]]
  [[ -f "$candidate/SHA256SUMS" && ! -L "$candidate/SHA256SUMS" ]]
  [[ "$(find "$candidate" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" = "3" ]]
  if find "$candidate" -type l -print -quit | grep -q .; then
    echo "bundle contém link simbólico" >&2
    return 1
  fi
  [[ "$(sha256sum "$candidate/$migration_file" | awk '{print $1}')" = "$migration_checksum" ]]
  [[ "$(sha256sum "$candidate/$test_file" | awk '{print $1}')" = "$test_checksum" ]]
  [[ "$(sed -n '1p' "$candidate/SHA256SUMS")" = "$migration_checksum  $migration_file" ]]
  [[ "$(sed -n '2p' "$candidate/SHA256SUMS")" = "$test_checksum  $test_file" ]]
  [[ "$(wc -l < "$candidate/SHA256SUMS" | tr -d ' ')" = "2" ]]
  (cd "$candidate" && sha256sum -c SHA256SUMS >/dev/null)
}
verify_schema() {
  docker exec -i supabase-db psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 <<'SQL'
do $verify$
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
$verify$;
SQL
}
migration_body() {
  awk '
    $0 == "begin;" { begin_count++; next }
    $0 == "commit;" { commit_count++; next }
    { print }
    END { if (begin_count != 1 || commit_count != 1) exit 42 }
  ' "$bundle_dir/$migration_file"
}
run_migration() {
  local terminal_statement=$1
  {
    printf '%s\n' \
      'begin;' \
      "set local lock_timeout = '15s';" \
      "set local statement_timeout = '5min';" \
      "set local idle_in_transaction_session_timeout = '90s';" \
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wisewolf:wolfie-intake-hardening', 0));"
    migration_body
    printf '%s;\n' "$terminal_statement"
  } | docker exec -i supabase-db psql -X -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1
}

[[ "$expected_host" = "187.127.46.251" ]]
[[ "$(id -un)" = "$expected_user" ]]
case " $(hostname -I) " in
  *" $expected_host "*) ;;
  *) echo "IP público não pertence ao host remoto" >&2; exit 1 ;;
esac
[[ "$stage_mode" = "upload" || "$stage_mode" = "reuse" ]]
[[ "$migration_version" = "20260802174535" ]]
[[ "$migration_file" = "20260802174535_harden_crm_leads_public_intake_authorization.sql" ]]
[[ "$test_file" = "public_intake_rls.sql" ]]
[[ "$migration_checksum" =~ ^[a-f0-9]{64}$ && "$test_checksum" =~ ^[a-f0-9]{64}$ ]]
for path in "$releases_dir" "$backups_dir" "$supabase_dir" \
  "$bundle_dir" "$incoming_dir"; do
  validate_path "$path"
done
for path in /opt/wisewolf "$releases_dir" "$backups_dir" "$supabase_dir"; do
  [[ -d "$path" && ! -L "$path" && "$(readlink -f "$path")" = "$path" ]]
done
for command_name in docker sha256sum readlink flock timeout awk grep find; do
  command -v "$command_name" >/dev/null
done
docker inspect supabase-db --format '{{.State.Running}}' | grep -qx true

lock_path="$releases_dir/.deploy.lock"
[[ ! -L "$lock_path" ]]
exec 9>"$lock_path"
flock -n 9 || { echo "outro deploy está em andamento" >&2; exit 1; }

if [[ "$stage_mode" = "upload" ]]; then
  verify_bundle "$incoming_dir"
  [[ ! -e "$bundle_dir" && ! -L "$bundle_dir" ]]
  chmod 0444 "$incoming_dir/$migration_file" "$incoming_dir/$test_file" \
    "$incoming_dir/SHA256SUMS"
  chmod 0555 "$incoming_dir"
  mv -T -- "$incoming_dir" "$bundle_dir"
fi
verify_bundle "$bundle_dir"

marker_dir="$releases_dir/.migration-checksums"
if [[ -e "$marker_dir" || -L "$marker_dir" ]]; then
  [[ -d "$marker_dir" && ! -L "$marker_dir" &&
    "$(readlink -f "$marker_dir")" = "$marker_dir" ]]
else
  mkdir -- "$marker_dir"
  chmod 0700 "$marker_dir"
fi
if find "$marker_dir" -maxdepth 1 -type l \
  -name "${migration_version}-*.sha256" -print -quit | grep -q .; then
  echo "marker de migration não pode ser link simbólico" >&2
  exit 1
fi
mapfile -t version_markers < <(
  find "$marker_dir" -maxdepth 1 -type f \
    -name "${migration_version}-*.sha256" -print | LC_ALL=C sort
)
(( ${#version_markers[@]} <= 1 ))
expected_marker="$marker_dir/${migration_version}-${migration_checksum}.sha256"
if (( ${#version_markers[@]} == 1 )); then
  [[ "${version_markers[0]}" = "$expected_marker" ]]
  [[ -f "$expected_marker" && ! -L "$expected_marker" ]]
  [[ "$(tr -d '\r\n' < "$expected_marker")" = "$migration_checksum" ]]
  verify_schema
  timeout 600 docker exec -i supabase-db psql -X -U supabase_admin \
    -d postgres -v ON_ERROR_STOP=1 < "$bundle_dir/$test_file"
  printf 'Migration já aplicada e revalidada: %s\n' "$migration_version"
  exit 0
fi

echo "== Dry-run transacional no banco real (ROLLBACK obrigatório) =="
run_migration rollback

backup_id="wolfie-intake-${migration_version}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_dir="$backups_dir/$backup_id"
validate_path "$backup_dir"
[[ ! -e "$backup_dir" && ! -L "$backup_dir" ]]
mkdir -- "$backup_dir"
chmod 0700 "$backup_dir"
[[ "$(readlink -f "$backup_dir")" = "$backup_dir" ]]
backup_tmp="$backup_dir/postgres-before-intake-hardening.dump.tmp"
backup_file="$backup_dir/postgres-before-intake-hardening.dump"
backup_checksum_tmp="$backup_dir/postgres-before-intake-hardening.dump.sha256.tmp"
backup_checksum_file="$backup_dir/postgres-before-intake-hardening.dump.sha256"
for path in "$backup_tmp" "$backup_file" "$backup_checksum_tmp" \
  "$backup_checksum_file"; do
  [[ ! -e "$path" && ! -L "$path" ]]
done

echo "== Backup PostgreSQL custom anterior à migration =="
timeout 1800 docker exec supabase-db pg_dump \
  -U supabase_admin -d postgres --format=custom --no-owner --no-privileges \
  > "$backup_tmp"
[[ -s "$backup_tmp" && ! -L "$backup_tmp" ]]
timeout 300 docker exec -i supabase-db pg_restore --list \
  < "$backup_tmp" >/dev/null
backup_digest="$(sha256sum "$backup_tmp" | awk '{print $1}')"
[[ "$backup_digest" =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "$backup_digest" "$(basename -- "$backup_file")" \
  > "$backup_checksum_tmp"
chmod 0400 "$backup_tmp" "$backup_checksum_tmp"
mv -T -- "$backup_tmp" "$backup_file"
mv -T -- "$backup_checksum_tmp" "$backup_checksum_file"
(cd "$backup_dir" && sha256sum -c "$(basename -- "$backup_checksum_file")" >/dev/null)

echo "== Aplicação transacional da migration =="
run_migration commit

echo "== Teste SQL transacional pós-aplicação =="
timeout 600 docker exec -i supabase-db psql -X -U supabase_admin \
  -d postgres -v ON_ERROR_STOP=1 < "$bundle_dir/$test_file"
verify_schema

marker_tmp="$marker_dir/.${migration_version}-${migration_checksum}.tmp.$$"
[[ ! -e "$marker_tmp" && ! -L "$marker_tmp" &&
  ! -e "$expected_marker" && ! -L "$expected_marker" ]]
printf '%s\n' "$migration_checksum" > "$marker_tmp"
chmod 0400 "$marker_tmp"
mv -T -- "$marker_tmp" "$expected_marker"

printf 'Migration aplicada: %s\nBackup validado: %s\nMarker: %s\n' \
  "$migration_version" "$backup_file" "$expected_marker"
REMOTE

REMOTE_INCOMING_OWNED="false"

echo "Rollout de hardening do intake concluído com sucesso."
