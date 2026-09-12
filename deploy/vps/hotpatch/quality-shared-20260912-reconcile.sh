#!/usr/bin/env bash
# Complete the post-commit checks of the exact release after its missing-helper
# repair. Earlier checks and all SQL tests succeeded in release.sh; nothing is
# marked active until immutable package, running code, DB journal and the
# remaining authentication checks have been verified again.
set -Eeuo pipefail
umask 077
repair_commit=${1:?Git commit containing publisher fix and recovery evidence}
[[ "$repair_commit" =~ ^[a-f0-9]{40}$ ]]
release_id=20260912T223800Z-6a2a75eb267a
release_dir=/opt/wisewolf/releases/$release_id
backup_dir=/opt/wisewolf/backups/release-$release_id
runtime=/opt/wisewolf/supabase-docker/volumes/functions
frontend=/opt/wisewolf/frontend/src/dist
helper_sha=08520077a2ec6d0de5a0b648ce78f2a10142df925d6ae8034d2acc4efd236d54
exec 9>/opt/wisewolf/releases/.deploy.lock
flock -n 9
exec 8>/opt/wisewolf/frontend/.hub-activation.lock
flock -n 8
grep -Fxq "post_commit_failed:$release_id" "$backup_dir/ACTIVATION_STATE"
grep -Fxq "post_commit_validation_failed:$release_id" "$backup_dir/POST_COMMIT_FAILURE"
grep -Fxq "$release_id" /opt/wisewolf/releases/current
grep -Fxq 'source_git_sha=d4a496e4d1ee91210f1f0fcd3b6d2605e2476d40' "$release_dir/release-provenance.txt"
(cd "$release_dir" && sha256sum --check --status release-inputs.sha256)
verified=0
while read -r expected relative; do
  target=
  case "$relative" in
    functions/_shared/*.test.ts) continue ;;
    functions/*) target="$runtime/${relative#functions/}" ;;
    frontend-dist/*) target="$frontend/${relative#frontend-dist/}" ;;
    nginx.conf) target=/opt/wisewolf/frontend/nginx.conf ;;
    *) continue ;;
  esac
  [[ -f "$target" && ! -L "$target" ]]
  [[ "$(sha256sum "$target" | cut -d' ' -f1)" = "$expected" ]]
  verified=$((verified + 1))
done < "$release_dir/release-inputs.sha256"
[[ "$verified" -gt 100 ]]
[[ "$(sha256sum "$runtime/_shared/lesson-quality-reply.ts" | cut -d' ' -f1)" = "$helper_sha" ]]
[[ "$(sha256sum "$runtime/_shared/authorized-resume-path.ts" | cut -d' ' -f1)" = b953678863e586de8830df75d1e14bcd92556ba6a7d8a4c28eeeaf6dd3044963 ]]
manifest_sha=$(sha256sum "$release_dir/release-inputs.sha256" | cut -d' ' -f1)
[[ "$manifest_sha" =~ ^[a-f0-9]{64}$ ]]
db_status=$(docker exec supabase-db psql -X -U supabase_admin -d postgres -Atc \
  "select release_state from private.release_commit_journal where release_id='$release_id' and release_manifest_checksum='$manifest_sha' and committed_at is not null")
[[ "$db_status" = COMMITTED ]]
docker exec supabase-edge-functions sh -c '
  for gate in GOOGLE_MEET_PEDAGOGY_ENABLED GOOGLE_MEET_SUMMARY_AI_ENABLED; do
    test "$(printenv "$gate" | tr -d "[:space:]")" != true || exit 1
  done'
check_http() {
  local expected=$1 endpoint=$2 method=$3 status=
  for attempt in {1..8}; do
    status=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 \
      -X "$method" "https://api.wisewolflanguage.com.br/functions/v1/$endpoint" \
      -H 'Content-Type: application/json' --data '{}' || true)
    [[ "$status" = "$expected" ]] && break
    sleep 1
  done
  [[ "$status" = "$expected" ]]
  printf 'Verified %s: HTTP %s\n' "$endpoint" "$status"
}
check_http 403 whatsapp-inbound POST
check_http 403 'whatsapp-inbound?worker=sdr' POST
for endpoint in whatsapp-crm-lead-notif school-ai-team school-ai-digest wolfie-eval hr-ai-screening google-meet; do
  check_http 401 "$endpoint" POST
done
check_http 200 google-meet OPTIONS
check_http 426 wolfie-live-proxy GET
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 https://system.wisewolflanguage.com.br/)" = 200 ]]
[[ "$(docker inspect --format '{{.State.Running}}' frontend-frontend-1)" = true ]]
[[ "$(docker inspect --format '{{.State.Health.Status}}' supabase-edge-functions)" = healthy ]]
[[ ! -e "$backup_dir/POST_COMMIT_FAILURE.resolved" && ! -e "$backup_dir/QUALITY_SHARED_RECOVERY" ]]
printf 'release=%s\nrepair_commit=%s\nhelper_sha256=%s\nmanifest_sha256=%s\nverified_files=%s\ndatabase=COMMITTED\nremaining_smokes=PASS\ngoogle_flags=disabled\n' \
  "$release_id" "$repair_commit" "$helper_sha" "$manifest_sha" "$verified" > "$backup_dir/QUALITY_SHARED_RECOVERY"
cp -a -- "$backup_dir/ACTIVATION_STATE" "$backup_dir/ACTIVATION_STATE.before-quality-recovery"
mv -- "$backup_dir/POST_COMMIT_FAILURE" "$backup_dir/POST_COMMIT_FAILURE.resolved"
printf 'active:%s\n' "$release_id" > "$backup_dir/.ACTIVATION_STATE.quality-recovery"
mv -- "$backup_dir/.ACTIVATION_STATE.quality-recovery" "$backup_dir/ACTIVATION_STATE"
printf 'Release reconciled and active: %s (%s files verified)\n' "$release_id" "$verified"
